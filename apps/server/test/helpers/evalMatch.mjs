/**
 * One isolated heads-up-vs-anchor match for the bot evaluation rig.
 *
 * Boots the real server in-process (temp DB, dynamic port, real WS), seats one
 * scripted anchor at seat 0 and one bot per entry of `seatPolicies` on the
 * following seats, plays `hands` hands, and returns the per-hand per-seat deltas.
 *
 * Everything is driven by `BOT_TEST_SHUFFLE_SEED`'s deterministic deal, so two
 * matches with the same seed (and the same seat layout) replay the exact same
 * cards. `botEval.mjs` uses that to build duplicate matches (swap the two
 * strategies between seats, replay the same cards) and to bootstrap a CI on the
 * per-hand strategy delta.
 *
 * This is a harness module: it never changes product behaviour, it only injects
 * policies through `BotSupervisor.runnerFactory` and drives the human via the
 * shipped `HeadlessClient`.
 */
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app';
import { attachHub } from '../../src/hub';
import { BotSupervisor } from '../../src/botSupervisor';
import { BotRunner } from '../../src/botRunner';
import { HeadlessClient, buildDecisionView } from '@4am/agent-core';
import {
  createPolicyStats,
  fallbackDecision,
  isLegalDecision,
  makeStrategy,
} from './evalStrategies.mjs';
import { installDeterministicShuffle, uninstallDeterministicShuffle } from './deterministicShuffle.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Env keys `runEvalMatch` mutates; saved before and restored in `finally`. */
const MANAGED_ENV = ['BOT_TEST_SHUFFLE_SEED', 'BOT_IDENTITY_KEY', 'BOT_THINK_ENABLED'];

function snapshotEnv(keys) {
  const snap = {};
  for (const key of keys) snap[key] = process.env[key];
  return snap;
}

function restoreEnv(snap) {
  for (const [key, value] of Object.entries(snap)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(10);
  }
  throw new Error(`waitFor timed out: ${label ?? ''}`);
}

/**
 * Server-authoritative card-level fingerprint of one hand, read back from the
 * persisted transcript after settlement:
 *   - each participant's two hole cards (`hole_cards`, written during the audit
 *     probe - see `tvReplays` below), ordered by seat number. These are ALWAYS
 *     present (live players reveal their key, folders reveal via escrowed key),
 *     so they are the load-bearing part of the replay proof;
 *   - the board in deal order (`settlement.board`). The board is only opened as
 *     far as the ACTION reached, so its length legitimately differs between two
 *     seatings of the same deal (a fold-out vs a showdown); comparison therefore
 *     checks the common prefix rather than the length.
 * The hole fingerprint is stable across runs for the same physical deal and
 * differs when the permutation (not the hand id) changes.
 */
function extractCardFingerprint(tRow, participantSeats) {
  const entries = tRow ? JSON.parse(tRow.entries) : [];
  const holes = new Map();
  let board = null;
  for (const e of entries) {
    const p = e?.payload;
    if (!p) continue;
    if (e.type === 'hole_cards' && typeof p.seat === 'number' && Array.isArray(p.cards)) {
      holes.set(p.seat, p.cards.slice());
    } else if (e.type === 'settlement') {
      if (Array.isArray(p.board)) board = p.board.slice();
      if (Array.isArray(p.reveals))
        for (const r of p.reveals)
          if (!holes.has(r.seat) && Array.isArray(r.cards)) holes.set(r.seat, r.cards.slice());
    }
  }
  const seats = [...participantSeats].sort((a, b) => a - b);
  const missing = seats.filter((s) => !holes.has(s));
  const holeFingerprint = seats
    .map((s) => `s${s}:${(holes.get(s) ?? ['?', '?']).join('+')}`)
    .join('|');
  const boardCards = board ?? [];
  return {
    fingerprint: `${holeFingerprint}|board:${boardCards.join('+')}`,
    holeFingerprint,
    board: boardCards,
    complete: missing.length === 0 && board !== null,
    missing,
  };
}

/** Resolve a policy name through the harness registry, falling back to shipped styles. */
function resolveStrategy(name, stats) {
  const baseline = makeStrategy(name, { stats });
  if (baseline) return baseline;
  // Shipped styles (e.g. `tight-aggressive`) are not reimplemented here; the
  // eval rig is for the baselines. A missing policy is a hard error.
  throw new Error(`unknown eval strategy "${name}" (baselines: always-fold, always-call, equity-threshold[:t])`);
}

/**
 * @param {object} opts
 * @param {number|null} [opts.seed]   deterministic-shuffle seed; `null`/omitted
 *                                    keeps the production crypto shuffle (the
 *                                    default path, used by the env-restore smoke)
 * @param {string} [opts.shuffleSalt] harness-only perm label prefix (negative
 *                                    test: same hand ids, different cards)
 * @param {number} opts.hands
 * @param {Record<number,string>} opts.seatPolicies  seat -> policy name (seats >= 1)
 * @param {string} [opts.anchor]      seat-0 policy name
 * @param {number} [opts.sb] @param {number} [opts.bb] @param {number} [opts.buyIn]
 */
export async function runEvalMatch({
  seed,
  shuffleSalt = '',
  hands,
  seatPolicies,
  anchor = 'always-call',
  sb = 10,
  bb = 20,
  buyIn = 4000,
  actionMs = 1_000,
  cryptoMs = 2_000,
  readyMs = 300,
  handMs = 30_000,
  maxHandActions = 600,
} = {}) {
  const deterministic = seed !== undefined && seed !== null;
  const envBefore = snapshotEnv(MANAGED_ENV);
  if (deterministic) process.env.BOT_TEST_SHUFFLE_SEED = String(seed);
  process.env.BOT_IDENTITY_KEY = process.env.BOT_IDENTITY_KEY ?? 'ab'.repeat(32);
  if (!process.env.BOT_THINK_ENABLED) process.env.BOT_THINK_ENABLED = '0';
  try {
    if (deterministic) installDeterministicShuffle(Number(seed) >>> 0, { salt: shuffleSalt });
  } catch (err) {
    // A concurrent different-seed install is a harness programming error; still
    // put the env back so the throw cannot pollute the rest of the worker.
    restoreEnv(envBefore);
    throw err;
  }

  const policyStats = createPolicyStats();
  const botSeats = Object.keys(seatPolicies).map(Number).sort((a, b) => a - b);
  const policyForSeat = (seat) => resolveStrategy(seatPolicies[seat], policyStats);
  const dbPath = join(tmpdir(), `4am-eval-${randomBytes(5).toString('hex')}.db`);
  const ctx = createApp(dbPath);
  const hub = attachHub(ctx.app, ctx.db, {
    cryptoTimeoutMs: cryptoMs,
    actionTimeoutMs: actionMs,
    autoDealMs: 3_600_000,
    readyCheckMs: readyMs,
    // Eval matches drive every hand explicitly and measure poker strength, not
    // animation: skip the web-facing holds so throughput is unchanged.
    showdownHoldMs: 0,
    settleHoldMs: 0,
  });
  const baseUrl = await ctx.app.listen({ host: '127.0.0.1', port: 0 });

  const supervisor = new BotSupervisor(ctx.db, {
    baseUrl,
    maxConcurrent: botSeats.length,
    runner: {
      graceMs: 8_000,
      pollMs: 15,
      settleMs: 100,
      memory: false,
    },
    log: () => {},
    runnerFactory: (db, claim, opts) =>
      new BotRunner(db, claim, { ...opts, policy: policyForSeat(claim.bot.seat) }),
  });
  ctx.botControl.hooks = supervisor;

  const human = new HeadlessClient(baseUrl, `host_${randomBytes(3).toString('hex')}`, 'eval');
  const humanPolicy = resolveStrategy(anchor, policyStats);

  const out = {
    seed,
    shuffleSalt: deterministic ? shuffleSalt : null,
    deterministic,
    hands: 0,
    requestedHands: hands,
    aborts: 0,
    rejected: 0,
    botActions: 0,
    ledgerOk: true,
    handIds: [],
    perHand: [],
    cardFingerprints: [],
    cardsFingerprintComplete: true,
    policyFallbacks: 0,
    policyIllegalDecisions: 0,
    seatPolicies: { ...seatPolicies },
    anchor,
  };

  const botStatus = (id) =>
    ctx.db.prepare('SELECT status FROM bot_accounts WHERE id = ?').get(id)?.status ?? null;

  try {
    await human.login();
    const room = await human.api('/api/rooms', { name: 'Eval', sb, bb }, 'POST');
    await human.connect(room.id);
    human.send({ t: 'sit', seat: 0 });
    const buy = await human.api(`/api/rooms/${room.id}/buy`, { amount: buyIn });
    await human.api(`/api/rooms/${room.id}/approve`, { requestId: buy.id, approve: true });
    // CARD-VISIBILITY PROBE (harness-only): enable TV replays so the post-hand
    // audit reveals EVERY participant's hole cards into the transcript (folded
    // players via escrowed keys, live players via reveal_key). This changes only
    // the post-settlement key collection - never the deal, betting or deltas -
    // and gives the duplicate comparison a real card-level fingerprint instead
    // of the bare hand-id. `startHand` reads the room fresh, so the UPDATE
    // applies from the first hand on.
    ctx.db.prepare('UPDATE rooms SET tv_replays = 1 WHERE id = ?').run(room.id);

    const bots = [];
    for (const seat of botSeats) {
      const created = await human.api(`/api/rooms/${room.id}/bots`, {
        seat,
        initialBuyIn: buyIn,
        policyKind: 'scripted',
        name: `Eval${seat}`,
      });
      bots.push({ id: created.bot.id, userId: created.bot.userId, seat: created.bot.seat });
    }
    for (const b of bots) await human.api(`/api/rooms/${room.id}/bots/${b.id}/start`, {});
    await waitFor(
      () =>
        bots.every(
          (b) =>
            botStatus(b.id) === 'running' &&
            !!human.room?.players.find((p) => p.userId === b.userId && p.connected),
        ),
      20_000,
      'eval bots running',
    );

    const stackOf = (userId) =>
      ctx.db
        .prepare('SELECT stack FROM room_players WHERE room_id = ? AND user_id = ?')
        .get(room.id, userId)?.stack ?? 0;
    let topUpSeq = 1;
    const nextTopUp = () => buyIn + topUpSeq++;
    const ensureFunded = async () => {
      if (stackOf(human.userId) <= 0) {
        const req = await human.api(`/api/rooms/${room.id}/buy`, { amount: nextTopUp() });
        await human.api(`/api/rooms/${room.id}/approve`, { requestId: req.id, approve: true });
      }
      for (const b of bots) {
        if (stackOf(b.userId) <= 0)
          await human.api(`/api/rooms/${room.id}/bots/${b.id}/buy`, { amount: nextTopUp() });
      }
    };

    const driveHuman = async (handId, deadline) => {
      while (Date.now() < deadline) {
        if (human.handId !== handId || human.abort) break;
        if (human.result && human.result.handId === handId) break;
        await human.waitForTurn(50);
        if (human.handId !== handId || human.abort) break;
        if (human.result && human.result.handId === handId) break;
        if (!human.myTurn()) continue;
        const view = buildDecisionView(human);
        if (!view.legalActions) continue;
        if (view.hand?.deadline && view.hand.deadline - Date.now() < 100) continue;
        let decision;
        try {
          decision = await humanPolicy.decide(view);
        } catch {
          decision = null;
        }
        const legal = !!decision && isLegalDecision(decision.action, view.legalActions);
        if (!legal) {
          // The human anchor is a baseline policy too: an illegal decision that
          // reached here is a policy bug, not something to hide behind the
          // harness fallback. Policies that use `ensureLegal` count themselves,
          // so only a raw illegal/absent decision is tallied here.
          policyStats.fallbacks++;
          if (decision && decision.action) policyStats.illegalDecisions++;
        }
        const action = legal ? decision.action : fallbackDecision(view.legalActions).action;
        try {
          human.act(action);
        } catch {
          // table advanced between check and send
        }
      }
    };

    for (let h = 0; h < hands; h++) {
      await ensureFunded();
      const prevHandId = human.handId;
      const handStart = Date.now();
      human.send({ t: 'start_hand' });
      await waitFor(
        () => !!human.abort || (human.handId && human.handId !== prevHandId),
        15_000,
        `eval hand ${h + 1} dealt`,
      );
      if (human.abort) {
        out.aborts++;
        break;
      }
      const handId = human.handId;
      const driver = driveHuman(handId, Date.now() + handMs);
      const settleDeadline = Date.now() + handMs;
      for (;;) {
        const settled =
          (human.result && human.result.handId === handId) ||
          (human.abort && human.abort.handId === handId);
        if (settled) break;
        const actionSeq = hub.rooms.get(room.id)?.hand?.actionSeq ?? 0;
        if (actionSeq > maxHandActions)
          throw new Error(`pathological hand ${handId}: actionSeq=${actionSeq}`);
        if (Date.now() > settleDeadline) throw new Error(`eval hand ${h + 1} did not settle`);
        await sleep(15);
      }
      await driver;
      if (human.abort || !human.result || human.result.handId !== handId) {
        out.aborts++;
        break;
      }

      const result = human.result;
      const deltas = result.deltas.map((d) => ({ seat: d.seat, delta: d.delta }));
      const tRow = ctx.db
        .prepare('SELECT entries FROM transcripts WHERE hand_id = ?')
        .get(handId);
      let handRejected = 0;
      if (tRow) {
        for (const e of JSON.parse(tRow.entries))
          if (e.type === 'action_rejected') handRejected++;
      }
      out.rejected += handRejected;
      out.botActions += (human.actionHistory ?? []).filter((a) =>
        bots.some((b) => b.seat === a.seat),
      ).length;

      // Real card-level fingerprint (see extractCardFingerprint): every dealt
      // seat must have its two hole cards and the settlement board present, or
      // the duplicate comparison below cannot prove the physical deal replayed.
      const cardFingerprint = extractCardFingerprint(
        tRow,
        result.deltas.map((d) => d.seat),
      );
      if (!cardFingerprint.complete) out.cardsFingerprintComplete = false;

      out.hands++;
      out.handIds.push(handId);
      out.cardFingerprints.push(cardFingerprint);
      out.perHand.push({
        handId,
        deltas,
        rejected: handRejected,
        durationMs: Date.now() - handStart,
      });
    }

    // Ledger conservation + no bot error.
    const roster = ctx.db
      .prepare('SELECT user_id, stack FROM room_players WHERE room_id = ?')
      .all(room.id);
    for (const p of roster) {
      const sum = ctx.db
        .prepare('SELECT COALESCE(SUM(delta),0) AS s FROM ledger WHERE room_id=? AND user_id=?')
        .get(room.id, p.user_id).s;
      if (p.stack !== sum || p.stack < 0) out.ledgerOk = false;
    }
    out.botErrors = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM bot_accounts WHERE room_id=? AND status='error'")
      .get(room.id).n;
    out.policyFallbacks = policyStats.fallbacks;
    out.policyIllegalDecisions = policyStats.illegalDecisions;
    return out;
  } finally {
    await supervisor.stopAll().catch(() => {});
    human.close();
    await ctx.app.close().catch(() => {});
    uninstallDeterministicShuffle();
    // Restore the env the harness mutated, so a later server test in the same
    // worker is not silently forced onto the deterministic-shuffle path.
    restoreEnv(envBefore);
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

/** Map a per-hand delta list to a seat->delta lookup. */
export function deltasBySeat(perHand) {
  const map = new Map();
  for (const d of perHand.deltas) map.set(d.seat, d.delta);
  return map;
}
