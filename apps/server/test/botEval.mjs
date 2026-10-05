#!/usr/bin/env node
/**
 * Low-variance bot strategy evaluation rig (Node script, NOT vitest).
 *
 * The problem: `botPlaytest.mjs` deals crypto-random cards every run, so at any
 * realistic sample size the bb/100 difference between two policies is buried in
 * single-hand variance (~8bb/hand). This rig fixes that with three ideas:
 *
 *   1. DETERMINISTIC DEAL  - `BOT_TEST_SHUFFLE_SEED` makes the mental-poker deal
 *      a pure function of the seed (see helpers/deterministicShuffle.mjs), so
 *      two runs with the same seed replay the exact same cards and hand ids.
 *   2. DUPLICATE MATCH     - the two strategies under test are seated opposite
 *      each other, then swapped and replayed on the SAME cards. Each hand's
 *      observation is the averaged strategy delta over both seatings, which
 *      cancels the luck of who got the better cards.
 *   3. BOOTSTRAP CI        - a seeded percentile bootstrap gives a 95% CI on the
 *      bb/100 delta, so "is this change real?" becomes a number, not a vibe.
 *
 * An `always-call` anchor fills seat 0 in every match (never itself compared).
 *
 * Run:
 *   node --import tsx apps/server/test/botEval.mjs
 *   HANDS=200 SEED=1234 node --import tsx apps/server/test/botEval.mjs
 *   node --import tsx apps/server/test/botEval.mjs --hands=200 --pair=always-fold,equity-threshold
 *
 * Writes JSON + Markdown into docs/qa/bot-playtest/ (same folder as the
 * single-run playtest). Exits non-zero if any invariant fails.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runEvalMatch } from './helpers/evalMatch.mjs';
import { comparePair as comparePairImpl } from './helpers/evalCompare.mjs';
import { isSupportedStrategy } from './helpers/evalStrategies.mjs';

function cliValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}
function cfg(name, fallback) {
  const raw = cliValue(name) ?? process.env[name.toUpperCase()];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
function cfgStr(name, fallback) {
  return cliValue(name) ?? process.env[name.toUpperCase()] ?? fallback;
}

const HANDS = Math.max(1, Math.floor(cfg('hands', 200)));
const SEED = Math.floor(cfg('seed', 1234));
const SB = Math.floor(cfg('sb', 10));
const BB = Math.floor(cfg('bb', 20));
const BUYIN = Math.floor(cfg('buyin', 4000));
const ACTION_MS = Math.floor(cfg('action_ms', 1_000));
const CRYPTO_MS = Math.floor(cfg('crypto_ms', 2_000));
const HAND_MS = Math.floor(cfg('hand_ms', 30_000));
const ANCHOR = cfgStr('anchor', 'always-call');
const OUT_DIR = cfgStr('out', 'docs/qa/bot-playtest');
const BOOTSTRAP_ITERS = Math.floor(cfg('bootstrap_iters', 10_000));
const STRATEGIES = cfgStr('strategies', 'always-fold,always-call,equity-threshold')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// Optional: only run this pair (e.g. `--pair=always-fold,equity-threshold`).
const PAIR_FILTER = cfgStr('pair', '');

if (STRATEGIES.length < 2) throw new Error('need at least 2 strategies to compare');
for (const s of [...STRATEGIES, ANCHOR]) {
  if (!isSupportedStrategy(s))
    throw new Error(
      `unknown strategy "${s}" (baselines: always-fold, always-call, equity-threshold[:threshold])`,
    );
}

/** All unordered pairs (or just the requested one). */
function pairsToRun(names) {
  const pairs = [];
  for (let i = 0; i < names.length; i++)
    for (let j = i + 1; j < names.length; j++) pairs.push([names[i], names[j]]);
  if (!PAIR_FILTER) return pairs;
  const want = PAIR_FILTER.split(',').map((s) => s.trim());
  return pairs.filter(
    ([a, b]) => (a === want[0] && b === want[1]) || (a === want[1] && b === want[0]),
  );
}

function comparePair(a, b) {
  return comparePairImpl(a, b, {
    seed: SEED,
    hands: HANDS,
    anchor: ANCHOR,
    sb: SB,
    bb: BB,
    buyIn: BUYIN,
    actionMs: ACTION_MS,
    cryptoMs: CRYPTO_MS,
    handMs: HAND_MS,
    bootstrapIters: BOOTSTRAP_ITERS,
  });
}

function check(name, ok, detail) {
  return { name, ok, detail };
}

async function main() {
  const startedAt = Date.now();
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-eval-seed${SEED}-hands${HANDS}`;
  const pairs = pairsToRun(STRATEGIES);
  const results = [];
  for (const [a, b] of pairs) {
    console.log(`\n[eval] ${a} vs ${b} (duplicate, ${HANDS} hands x2 runs) ...`);
    const r = await comparePair(a, b);
    results.push(r);
    console.log(
      `[eval]   delta=${r.delta.bb100} bb/100 ci95=[${r.delta.ci95.join(', ')}] ` +
        `width=${r.delta.width} | no-swap width=${r.nonDuplicate.width} | ${r.delta.direction}`,
    );
  }

  const checks = [];
  for (const r of results) {
    const tag = `${r.a}/${r.b}`;
    for (const run of r.runs) {
      checks.push(
        check(`${tag}: run no aborts`, run.aborts === 0, `aborts=${run.aborts}`),
        check(`${tag}: run no action_rejected`, run.rejected === 0, `rejected=${run.rejected}`),
        check(`${tag}: run no bot errors`, (run.botErrors ?? 0) === 0, `errors=${run.botErrors}`),
        check(`${tag}: run ledger conserved`, run.ledgerOk === true, `ledgerOk=${run.ledgerOk}`),
        check(`${tag}: completed hands`, run.hands === HANDS, `${run.hands}/${HANDS}`),
        check(
          `${tag}: run no policy fallbacks`,
          (run.policyFallbacks ?? 0) === 0,
          `policyFallbacks=${run.policyFallbacks}`,
        ),
        check(
          `${tag}: run no illegal policy decisions`,
          (run.policyIllegalDecisions ?? 0) === 0,
          `policyIllegalDecisions=${run.policyIllegalDecisions}`,
        ),
      );
    }
    checks.push(
      check(
        `${tag}: duplicate replayed the same cards`,
        r.cardsReplayed === true,
        `cardsReplayed=${r.cardsReplayed} handIdsMatch=${r.cards?.handIdsMatch} ` +
          `fingerprintsComplete=${r.cards?.fingerprintsComplete}`,
      ),
      check(
        `${tag}: duplicate card fingerprints complete`,
        r.cards?.fingerprintsComplete === true,
        `fingerprintsComplete=${r.cards?.fingerprintsComplete}`,
      ),
      check(
        `${tag}: duplicate CI95 excludes 0`,
        r.delta.ciExcludesZero,
        `ci95=[${r.delta.ci95.join(', ')}]`,
      ),
      check(
        `${tag}: duplicate CI at least as narrow as no-swap`,
        r.delta.width <= r.nonDuplicate.width,
        `duplicate=${r.delta.width} vs no-swap=${r.nonDuplicate.width}`,
      ),
    );
  }

  const failures = checks.filter((c) => !c.ok);
  const report = {
    runId,
    kind: 'bot-eval-round-robin',
    config: {
      seed: SEED,
      shuffleSeed: SEED,
      duplicate: true,
      tvReplaysProbe: true,
      hands: HANDS,
      strategies: STRATEGIES,
      anchor: ANCHOR,
      sb: SB,
      bb: BB,
      buyIn: BUYIN,
      bootstrapIters: BOOTSTRAP_ITERS,
    },
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    pairs: results,
    notes: [
      'Deterministic deal: BOT_TEST_SHUFFLE_SEED makes the mental-poker deal a pure function of the seed, so every run replays the same hand ids and cards.',
      'Card-level replay proof: each run enables the room TV-replay/audit probe (harness-only DB flag) so the transcript carries every seat hole_cards plus the settlement board; cardsReplayed requires equal hand ids AND equal, complete per-hand card fingerprints (seat-ordered hole cards + board order), not just equal labels.',
      'Duplicate: each pair is played twice with the two strategies swapped between seat 1 and seat 2; the per-hand observation is the average strategy delta over both seatings, cancelling card luck.',
      'Policy accounting: policyFallbacks / policyIllegalDecisions count any decision a baseline had to repair or that was illegal before substitution, so a silent fallback can no longer hide behind 0 server action_rejected; baselines must stay at 0.',
      'nonDuplicate uses only the first seating (A@seat1, B@seat2) at the same hand count, for a like-for-like CI-width comparison.',
      'CI95 is a seeded percentile bootstrap over per-hand bb/100 deltas (reproducible). CI width shrinks ~1/sqrt(n); doubling hands narrows it by ~1.41x.',
      'The seat-0 anchor plays a fixed always-call policy in every match and is never itself compared.',
      'ISOLATION: BOT_TEST_SHUFFLE_SEED (and the derived hand ids) are only safe on a throwaway DB; transcripts.hand_id is a PRIMARY KEY, so a reused seed on a non-empty DB collides.',
    ],
    checks,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, `${runId}.json`), JSON.stringify(report, null, 2));
  writeFileSync(join(OUT_DIR, `${runId}.md`), renderMarkdown(report));

  console.log(`\n=== bot eval ${runId} ===`);
  for (const r of results)
    console.log(
      `  ${r.a} vs ${r.b}: delta=${r.delta.bb100} bb/100 (95% CI ${r.delta.ci95[0]}..${r.delta.ci95[1]}, ` +
        `width ${r.delta.width}; no-swap width ${r.nonDuplicate.width}) -> ${r.delta.direction}`,
    );
  console.log(`report: ${join(OUT_DIR, `${runId}.md`)} + .json`);
  if (failures.length) {
    console.error('\nFAILED checks:');
    for (const c of failures) console.error(`  - ${c.name}: ${c.detail}`);
  } else {
    console.log('all checks passed');
  }
  return failures.length === 0 ? 0 : 1;
}

function renderMarkdown(r) {
  const L = [];
  L.push(`# Bot eval (round-robin, duplicate) — ${r.runId}`);
  L.push('');
  L.push(`Config: \`${JSON.stringify(r.config)}\``);
  L.push('');
  L.push('## Method');
  L.push('');
  L.push(
    'Each pair is played twice on the **same deterministic deal**: A@seat1/B@seat2, then B@seat1/A@seat2. The per-hand observation is the average strategy delta across both seatings, which cancels the luck of who was dealt the better cards. `CI95` is a seeded bootstrap over per-hand deltas.',
  );
  L.push('');
  L.push('## Reproduce');
  L.push('');
  L.push('```bash');
  L.push('# 2 strategies x 200 hands (duplicate), the run behind this report');
  L.push(
    'STRATEGIES=always-fold,equity-threshold HANDS=200 node --import tsx apps/server/test/botEval.mjs',
  );
  L.push('');
  L.push('# one pair, explicit seed / hand count');
  L.push(
    'node --import tsx apps/server/test/botEval.mjs --hands=200 --seed=1234 --pair=always-fold,equity-threshold',
  );
  L.push('```');
  L.push('');
  L.push(
    'Knobs: `HANDS/--hands`, `SEED/--seed` (also the deterministic deal seed), `STRATEGIES/--strategies`, `ANCHOR/--anchor`, `BOOTSTRAP_ITERS/--bootstrap_iters`, `OUT/--out`. Same seed => same hand ids and cards; the seam is covered by `npx vitest run apps/server/test/evalInfra.test.mjs`.',
  );
  L.push('');
  L.push('## Results');
  L.push('');
  L.push('| A | B | hands | delta bb/100 | CI95 | CI width | no-swap CI width | direction | CI excludes 0 |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const p of r.pairs)
    L.push(
      `| ${p.a} | ${p.b} | ${p.hands} | ${p.delta.bb100} | [${p.delta.ci95.join(', ')}] | ${p.delta.width} | ${p.nonDuplicate.width} | ${p.delta.direction} | ${p.delta.ciExcludesZero} |`,
    );
  L.push('');
  L.push('## Replay proof & policy accounting');
  L.push('');
  L.push(
    '`cardsReplayed` requires equal hand ids **and** equal complete card fingerprints (every seat hole cards + board order) read from the transcript, not just equal labels. `policyFallbacks` / `policyIllegalDecisions` count baseline decisions that had to be repaired / were illegal before repair; both must be 0.',
  );
  L.push('');
  L.push(
    '| pair | cardsReplayed | handIds match | fingerprints complete | run1 fallbacks / illegal | run2 fallbacks / illegal |',
  );
  L.push('| --- | --- | --- | --- | --- | --- |');
  for (const p of r.pairs) {
    const r1 = p.runs[0];
    const r2 = p.runs[1];
    L.push(
      `| ${p.a} vs ${p.b} | ${p.cardsReplayed} | ${p.cards?.handIdsMatch} | ${p.cards?.fingerprintsComplete} | ${r1.policyFallbacks}/${r1.policyIllegalDecisions} | ${r2.policyFallbacks}/${r2.policyIllegalDecisions} |`,
    );
  }
  L.push('');
  L.push('## Sample size & CI');
  L.push('');
  L.push(
    'Bootstrap CI width scales with `1/sqrt(n)`: to halve the CI, quadruple the hands. The table below reports the duplicate CI width at the configured hand count.',
  );
  L.push('');
  L.push('| pair | hands | CI95 width (bb/100) | implied hands for +/-5 bb/100 |');
  L.push('| --- | --- | --- | --- |');
  for (const p of r.pairs) {
    const halfWidth = p.delta.width / 2;
    const implied = halfWidth > 0 ? Math.ceil(p.hands * (halfWidth / 5) ** 2) : p.hands;
    L.push(`| ${p.a} vs ${p.b} | ${p.hands} | ${p.delta.width} | ${implied} |`);
  }
  L.push('');
  L.push('## Checks');
  L.push('');
  for (const c of r.checks) L.push(`- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} (${c.detail})`);
  L.push('');
  L.push('## Notes');
  L.push('');
  for (const n of r.notes) L.push(`- ${n}`);
  L.push('');
  return L.join('\n');
}

const exitCode = await main().catch((err) => {
  console.error('bot eval crashed:', err);
  return 1;
});
process.exit(exitCode);
