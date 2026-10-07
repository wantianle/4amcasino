#!/usr/bin/env node
// @ts-nocheck
/**
 * decision-stats.mjs - rebuild preflop/postflop decision nodes from the hand
 * projection and report frequency metrics WITH their real denominators.
 *
 * Why this exists: `hand_players` has no "opportunity" denominator, so a plain
 * ratio over `hand_players`/`hand_actions` cannot express RFI%, defence% or
 * fold-to-bet%. This script replays each hand's `hand_actions` in order,
 * reconstructs the betting state at every decision node, and counts only the
 * nodes where the metric was actually available.
 *
 * READ-ONLY. The database is opened with `{ readonly: true }`; this script never
 * writes, never vacuously creates tables, and never touches the transcript or
 * ledger tables.
 *
 * ⚠️ BASELINE NUMBERS ARE BOUND TO A DB SNAPSHOT. The production DB is live and
 * grows as hands settle, so `handsScanned` and every ratio drift between runs.
 * Freeze first (`apps/server/scripts/freeze-db.sh`) and quote numbers together
 * with the `snapshot` block this script emits (sha256 + hand count + id range +
 * settled-at range). A non-empty `-wal` next to the DB makes the sha256 cover
 * only the main file; the report flags this as `snapshot.walPresent`.
 *
 * Usage:
 *   node apps/server/scripts/decision-stats.mjs [dbPath] [options]
 *
 *   --json              machine-readable JSON (default: human tables)
 *   --out <path>        also write the JSON report to <path>
 *   --player <id>       restrict to one userId (repeatable)
 *   --bots-only         restrict to user_ids present in bot_accounts
 *   --include-bomb      include bomb-pot hands (default: excluded)
 *   --include-unsourced include hands without a settlement marker (default: excluded)
 *   --limit <n>         newest n hands by settled_at (default: all)
 *   --frozen-name <s>   label recorded in snapshot.frozenName (the freeze id)
 *
 * Default dbPath: apps/server/4amcasino.db relative to the repo root.
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFINITIONS,
  groupBy,
  metricsFrom,
  replayHand,
} from './decision-stats-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    dbPath: null,
    json: false,
    out: null,
    players: [],
    botsOnly: false,
    includeBomb: false,
    includeUnsourced: false,
    limit: null,
    frozenName: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--bots-only') opts.botsOnly = true;
    else if (a === '--include-bomb') opts.includeBomb = true;
    else if (a === '--include-unsourced') opts.includeUnsourced = true;
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--player') opts.players.push(Number(argv[++i]));
    else if (a === '--limit') opts.limit = Number(argv[++i]);
    else if (a === '--frozen-name') opts.frozenName = argv[++i];
    else if (!a.startsWith('--') && opts.dbPath === null) opts.dbPath = a;
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  opts.dbPath = opts.dbPath ?? process.env.DB_PATH ?? resolve(REPO_ROOT, 'apps', 'server', '4amcasino.db');
  return opts;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));
if (!existsSync(opts.dbPath)) {
  console.error(`database not found: ${opts.dbPath}`);
  process.exit(1);
}

const db = new Database(opts.dbPath, { readonly: true, fileMustExist: true });

/**
 * Baseline numbers are BOUND TO A DB SNAPSHOT: the production DB grows as hands
 * settle, so `handsScanned` (and therefore every ratio) drifts between runs.
 * Always compare against a frozen copy (`apps/server/scripts/freeze-db.sh`), and
 * record the `snapshot` block below (sha256 + hand count + id range + settled
 * range) alongside any number quoted from this report.
 *
 * `dbSha256` hashes the MAIN db file. A non-empty `-wal` file means committed
 * rows may still live outside the file being hashed; `walPresent` flags that and
 * the hash is then not a complete-snapshot identity. Freeze first.
 */
function sha256File(path) {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

const walPath = `${opts.dbPath}-wal`;
const walPresent = existsSync(walPath) && statSync(walPath).size > 0;

const botRows = db.prepare('SELECT user_id AS userId, policy_kind AS policyKind FROM bot_accounts').all();
const policyKindByUser = new Map(botRows.map((b) => [b.userId, b.policyKind]));
const botUsers = new Set(botRows.map((b) => b.userId));

const handWhere = ["hands.status = 'settled'"];
if (!opts.includeBomb) handWhere.push("hands.game_kind = 'normal'");
if (!opts.includeUnsourced) {
  handWhere.push('EXISTS (SELECT 1 FROM hand_settlements hs WHERE hs.hand_id = hands.hand_id)');
}
const handSql = `SELECT hands.hand_id AS handId, hands.bb AS bb, hands.game_kind AS gameKind,
                        hands.settled_at AS settledAt
                   FROM hands
                  WHERE ${handWhere.join(' AND ')}
                  ORDER BY hands.settled_at DESC, hands.hand_id DESC
                  ${opts.limit ? 'LIMIT @limit' : ''}`;
const handRows = db.prepare(handSql).all(opts.limit ? { limit: opts.limit } : {});

/** Identity of the exact DB state the numbers came from. */
const dbSnapshot = (() => {
  const ids = handRows.map((h) => h.handId).sort();
  const times = handRows.map((h) => h.settledAt ?? 0);
  return {
    dbPath: opts.dbPath,
    dbSha256: sha256File(opts.dbPath),
    walPresent,
    handsScanned: handRows.length,
    handIdMin: ids[0] ?? null,
    handIdMax: ids[ids.length - 1] ?? null,
    settledAtMin: handRows.length ? Math.min(...times) : null,
    settledAtMax: handRows.length ? Math.max(...times) : null,
    frozenName: opts.frozenName,
  };
})();

const playerStmt = db.prepare(
  'SELECT hand_id AS handId, seat, user_id AS userId, position, preflop_order AS preflopOrder FROM hand_players WHERE hand_id = ?',
);
const actionStmt = db.prepare(
  `SELECT hand_id AS handId, action_no AS actionNo, seat, user_id AS userId, street,
          action_type AS actionType, amount_to AS amountTo, amount_added AS amountAdded,
          pot_before AS potBefore, pot_after AS potAfter, is_forced AS isForced, is_auto AS isAuto
     FROM hand_actions WHERE hand_id = ? ORDER BY action_no`,
);

const allDealt = [];
const allNodes = [];
let degradedHands = 0;

for (const hand of handRows) {
  const players = playerStmt.all(hand.handId);
  const actions = actionStmt.all(hand.handId);
  // Replay the WHOLE hand once: the ordering and state of every seat (folds,
  // calls, raises) is needed to classify each node correctly. The per-player
  // policy kind is stamped onto each record afterwards.
  const { dealtPlayers, nodes, degraded } = replayHand(hand, players, actions, {
    policyKindByUser,
  });
  allDealt.push(...dealtPlayers);
  allNodes.push(...nodes);
  if (degraded) degradedHands++;
}

// --- scope filters (players / bots) ---------------------------------------
let dealt = allDealt;
let nodes = allNodes;
if (opts.players.length) {
  const set = new Set(opts.players);
  dealt = dealt.filter((d) => set.has(d.playerId));
  nodes = nodes.filter((x) => set.has(x.playerId));
} else if (opts.botsOnly) {
  dealt = dealt.filter((d) => botUsers.has(d.playerId));
  nodes = nodes.filter((x) => botUsers.has(x.playerId));
}

// --- aggregate -------------------------------------------------------------
const byPlayer = {};
for (const [userId, ds] of groupBy(dealt, (d) => d.playerId)) {
  byPlayer[userId] = {
    policyKind: policyKindByUser.get(userId) ?? 'human-other',
    ...metricsFrom(ds, nodes.filter((x) => x.playerId === userId)),
  };
}
const positions = ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'MP', 'LJ', 'HJ', 'CO', 'UNKNOWN'];
const byPosition = {};
for (const pos of positions) {
  const ds = dealt.filter((d) => d.position === pos);
  const ns = nodes.filter((x) => x.position === pos);
  if (ds.length || ns.length) byPosition[pos] = metricsFrom(ds, ns);
}
const byPlayerCount = {};
for (let n = 2; n <= 9; n++) {
  const ds = dealt.filter((d) => d.playerCount === n);
  if (ds.length) byPlayerCount[n] = metricsFrom(ds, nodes.filter((x) => x.playerCount === n));
}
const byPolicyKind = {};
for (const [kind, ds] of groupBy(dealt, (d) => d.policyKind)) {
  byPolicyKind[kind] = metricsFrom(ds, nodes.filter((x) => x.policyKind === kind));
}

/** The production bot this baseline is about: `constrained-random` only. */
const crDealt = dealt.filter((d) => d.policyKind === 'constrained-random');
const crNodes = nodes.filter((x) => x.policyKind === 'constrained-random');
const constrainedRandom = metricsFrom(crDealt, crNodes);
const byPositionConstrainedRandom = {};
for (const pos of positions) {
  const ds = crDealt.filter((d) => d.position === pos);
  const ns = crNodes.filter((x) => x.position === pos);
  if (ds.length || ns.length) byPositionConstrainedRandom[pos] = metricsFrom(ds, ns);
}

// Postflop HU vs multiway (active opponents at the node), constrained-random only.
const postflopNodes = crNodes.filter((x) => x.kind === 'facingBet' || x.kind === 'checkedTo');
const byOpponents = {
  hu: metricsFrom([], postflopNodes.filter((x) => x.activeOpponents === 1)),
  multiway: metricsFrom([], postflopNodes.filter((x) => x.activeOpponents >= 2)),
};

const report = {
  generatedAt: new Date().toISOString(),
  dbPath: opts.dbPath,
  /** Identity of the exact DB state these numbers came from (bind to a freeze). */
  snapshot: dbSnapshot,
  scope: {
    handsScanned: handRows.length,
    includeBomb: opts.includeBomb,
    includeUnsourced: opts.includeUnsourced,
    limit: opts.limit,
    players: opts.players,
    botsOnly: opts.botsOnly,
    degradedHands,
  },
  definitions: DEFINITIONS,
  overall: metricsFrom(dealt, nodes),
  bots: metricsFrom(
    dealt.filter((d) => botUsers.has(d.playerId)),
    nodes.filter((x) => botUsers.has(x.playerId)),
  ),
  constrainedRandom,
  byPolicyKind,
  byPlayer,
  byPosition,
  byPositionConstrainedRandom,
  byPlayerCount,
  postflopByOpponents: byOpponents,
};

db.close();

if (opts.out) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(opts.out, `${JSON.stringify(report, null, 2)}\n`);
}

if (opts.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  printHuman(report);
}

// ---------------------------------------------------------------------------
// Human output
// ---------------------------------------------------------------------------

function fmt(m) {
  if (!m) return '-';
  return `${m.pct === null ? '-' : m.pct.toFixed(1)}% (${m.hits}/${m.opportunities})`;
}

function printHuman(rep) {
  const line = (label, m) => console.log(`  ${label.padEnd(20)} ${fmt(m)}`);
  console.log(`decision-stats  db=${rep.dbPath}`);
  const s = rep.snapshot;
  console.log(`snapshot: sha256=${s.dbSha256}`);
  console.log(
    `          hands=${s.handsScanned} idRange=[${s.handIdMin}..${s.handIdMax}] ` +
      `settledAt=[${s.settledAtMin}..${s.settledAtMax}]`,
  );
  if (s.walPresent) {
    console.log(
      '          WARNING: a non-empty -wal file exists; the sha256 covers the main file only.\n' +
        '          Freeze the DB (apps/server/scripts/freeze-db.sh) before quoting these numbers.',
    );
  } else {
    console.log('          (no -wal file: sha256 identifies the complete snapshot)');
  }
  console.log(
    `scope: hands=${rep.scope.handsScanned} bombIncluded=${rep.scope.includeBomb} degradedHands=${rep.scope.degradedHands}`,
  );
  console.log('\n== constrained-random bots (the production baseline) ==');
  line('hands', rep.constrainedRandom.hands);
  line('VPIP', rep.constrainedRandom.vpip);
  line('PFR', rep.constrainedRandom.pfr);
  line('RFI', rep.constrainedRandom.rfi);
  line('3bet', rep.constrainedRandom.threeBet);
  line('facingOpen fold', rep.constrainedRandom.facingOpenFold);
  line('facingOpen call', rep.constrainedRandom.facingOpenCall);
  line('facing3Bet fold', rep.constrainedRandom.facing3BetFold);
  line('facing3Bet call', rep.constrainedRandom.facing3BetCall);
  line('4bet', rep.constrainedRandom.fourBet);
  line('fold-to-bet', rep.constrainedRandom.foldToBet);
  line('call-vs-bet', rep.constrainedRandom.callVsBet);
  line('raise-vs-bet', rep.constrainedRandom.raiseVsBet);
  line('bet-when-checked-to', rep.constrainedRandom.betWhenCheckedTo);

  console.log('\n== constrained-random by position ==');
  const header = ['metric', ...Object.keys(rep.byPositionConstrainedRandom)];
  console.log(`  ${header.join('\t')}`);
  for (const key of [
    ['hands', (m) => m.hands],
    ['VPIP', (m) => m.vpip],
    ['PFR', (m) => m.pfr],
    ['RFI', (m) => m.rfi],
    ['3bet', (m) => m.threeBet],
    ['fOpen fold', (m) => m.facingOpenFold],
    ['fOpen call', (m) => m.facingOpenCall],
    ['f3Bet fold', (m) => m.facing3BetFold],
    ['foldToBet', (m) => m.foldToBet],
    ['betChkTo', (m) => m.betWhenCheckedTo],
  ]) {
    console.log(
      `  ${key[0].padEnd(12)} ${Object.values(rep.byPositionConstrainedRandom).map((m) => fmt(key[1](m))).join('\t')}`,
    );
  }

  console.log('\n== constrained-random postflop by opponents ==');
  line2('HU fold-to-bet', rep.postflopByOpponents.hu.foldToBet);
  line2('HU bet-when-chk', rep.postflopByOpponents.hu.betWhenCheckedTo);
  line2('MW fold-to-bet', rep.postflopByOpponents.multiway.foldToBet);
  line2('MW bet-when-chk', rep.postflopByOpponents.multiway.betWhenCheckedTo);

  function line2(label, m) {
    console.log(`  ${label.padEnd(20)} ${fmt(m)}`);
  }

  console.log('\n== by player ==');
  for (const [userId, m] of Object.entries(rep.byPlayer)) {
    console.log(
      `  user ${userId} [${m.policyKind}] hands=${m.hands.opportunities} VPIP=${fmt(m.vpip)} PFR=${fmt(m.pfr)} RFI=${fmt(m.rfi)} 3bet=${fmt(m.threeBet)}`,
    );
  }
  console.log('\nDefinitions (numerator/denominator): see --json .definitions');
}
