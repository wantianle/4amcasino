/**
 * Paired arm-comparison driver (P2 A/B rig).
 *
 * Every arm is played against one common `reference` arm (default `rules-v1`)
 * on the SAME deterministic deal - `comparePair` runs each pair twice with the
 * two strategies swapped between seats, so the reference sits opposite the arm
 * in both seatings and the per-hand observation is the luck-free duplicate
 * delta. Because the deal is a pure function of the seed, every arm therefore
 * plays the same hand-id/card sequence, which is what makes cross-arm bb/100
 * comparable.
 *
 * Per arm it aggregates:
 *   - `bb100` delta vs the reference and the seeded bootstrap `ci95`;
 *   - the accepted-action distribution (fold/call/check/bet/raise) over the
 *     arm's seat in both runs;
 *   - `legalityFallbacks` / `legalityIllegalDecisions` from the OUTER legality
 *     guard in `evalMatch.resolveStrategy` (a `RulePolicy` internal
 *     `safeFallback` returning a legal action is not counted);
 *   - `memorySeen`: how often the arm seat actually saw a non-empty opponent
 *     snapshot (proves cross-hand memory reached the policy).
 *
 * The three-handed table is seat 0 = `anchor` + the two compared policies at
 * seats 1/2. The reference's own action distribution / counts are aggregated
 * across every pair as a sanity anchor.
 */
import { comparePair, runDigestIsClean } from './evalCompare.mjs';
import { armConfig } from './evalStrategies.mjs';

const ACTION_TYPES = ['fold', 'call', 'check', 'bet', 'raise'];

/** Fresh zeroed action-count record (same shape as `runEvalMatch.seatActions[*]`). */
export function emptyActionCounts() {
  const counts = { total: 0 };
  for (const type of ACTION_TYPES) counts[type] = 0;
  return counts;
}

/** In-place `into += from` for an action-count record. */
export function addActionCounts(into, from) {
  if (!from) return into;
  into.total += from.total ?? 0;
  for (const type of ACTION_TYPES) into[type] += from[type] ?? 0;
  return into;
}

/** Action counts plus the fold/call/raise/bet/check ratios they imply. */
export function actionDistribution(counts) {
  const total = counts.total ?? 0;
  const out = { total };
  for (const type of ACTION_TYPES) out[type] = counts[type] ?? 0;
  out.ratio = {};
  for (const type of ACTION_TYPES)
    out.ratio[type] = total > 0 ? +(out[type] / total).toFixed(4) : 0;
  // Aggression = bet+raise share, the headline "how aggressive" number.
  out.ratio.aggression = total > 0 ? +((out.bet + out.raise) / total).toFixed(4) : 0;
  return out;
}

/** Seat whose configured policy name is `name` in this run, or `null`. */
function seatOfPolicy(run, name) {
  if (!run?.seatPolicies) return null;
  for (const [seat, policy] of Object.entries(run.seatPolicies))
    if (policy === name) return Number(seat);
  return null;
}

/** Merge one policy's action counts + legality/memory stats over a pair's runs. */
function mergeSeatAcrossRuns(runs, name) {
  const actions = emptyActionCounts();
  const stats = { legalityFallbacks: 0, legalityIllegalDecisions: 0 };
  const memory = {
    decisions: 0,
    nonEmptyOpponents: 0,
    withOpponentStats: 0,
    maxHandsObserved: 0,
  };
  for (const run of runs ?? []) {
    const seat = seatOfPolicy(run, name);
    if (seat === null) continue;
    addActionCounts(actions, run.seatActions?.[seat]);
    const s = run.seatPolicyStats?.[seat];
    if (s) {
      stats.legalityFallbacks += s.legalityFallbacks ?? 0;
      stats.legalityIllegalDecisions += s.legalityIllegalDecisions ?? 0;
    }
    const m = run.seatMemory?.[seat];
    if (m) {
      memory.decisions += m.decisions ?? 0;
      memory.nonEmptyOpponents += m.nonEmptyOpponents ?? 0;
      memory.withOpponentStats += m.withOpponentStats ?? 0;
      if ((m.maxHandsObserved ?? 0) > memory.maxHandsObserved)
        memory.maxHandsObserved = m.maxHandsObserved;
    }
  }
  return { actions, stats, memory };
}

/** True when a run digest reports no abort / rejection / error / ledger / legality issue. */
export function runIsClean(run) {
  return runDigestIsClean(run);
}

/**
 * Compare each arm against `reference`, all on the same seed.
 *
 * @param {object} opts
 * @param {string[]} opts.arms        arm names to include (reference is added if absent)
 * @param {string}   [opts.reference] common reference arm (default `rules-v1`)
 * @param {number}   [opts.seed]      deterministic-shuffle seed
 * @param {number}   [opts.hands]     hands per run (each pair plays 2x)
 * @param {boolean}  [opts.memory]    inject cross-hand session memory (default
 *   `true`; arm mode is meant to measure the full production strategy, and
 *   `shrinkage` needs opponent history to be observable)
 * @param {object}   [opts.match]     extra options forwarded to `comparePair`
 */
export async function runArmComparison(opts = {}) {
  const {
    reference = 'rules-v1',
    seed = 1234,
    hands = 200,
    bootstrapIters = 10_000,
    anchor = 'always-call',
    sb = 10,
    bb = 20,
    buyIn = 4000,
    actionMs = 1_000,
    cryptoMs = 2_000,
    handMs = 30_000,
    memory = true,
  } = opts;

  const requested = [...new Set((opts.arms ?? []).map((a) => String(a).trim()).filter(Boolean))];
  const arms = requested.includes(reference) ? requested : [reference, ...requested];
  const testArms = arms.filter((a) => a !== reference);

  const pairOpts = {
    seed,
    hands,
    anchor,
    sb,
    bb,
    buyIn,
    actionMs,
    cryptoMs,
    handMs,
    bootstrapIters,
    memory,
  };

  const referenceActions = emptyActionCounts();
  const referenceStats = { legalityFallbacks: 0, legalityIllegalDecisions: 0 };
  const referenceMemory = { decisions: 0, nonEmptyOpponents: 0, withOpponentStats: 0 };
  const pairs = [];

  for (const arm of testArms) {
    // Same seed for every pair => same hand ids/cards for every arm.
    const r = await comparePair(arm, reference, pairOpts);
    const armAgg = mergeSeatAcrossRuns(r.runs, arm);
    const refAgg = mergeSeatAcrossRuns(r.runs, reference);
    addActionCounts(referenceActions, refAgg.actions);
    referenceStats.legalityFallbacks += refAgg.stats.legalityFallbacks;
    referenceStats.legalityIllegalDecisions += refAgg.stats.legalityIllegalDecisions;
    referenceMemory.decisions += refAgg.memory.decisions;
    referenceMemory.nonEmptyOpponents += refAgg.memory.nonEmptyOpponents;
    referenceMemory.withOpponentStats += refAgg.memory.withOpponentStats;

    pairs.push({
      arm,
      reference,
      armConfig: armConfig(arm),
      hands: r.hands,
      memory: r.memory,
      clean: r.clean,
      bb100: r.delta.bb100,
      ci95: r.delta.ci95,
      width: r.delta.width,
      sd: r.delta.sd,
      ciExcludesZero: r.delta.ciExcludesZero,
      direction: r.delta.direction,
      nonDuplicate: {
        bb100: r.nonDuplicate.bb100,
        ci95: r.nonDuplicate.ci95,
        width: r.nonDuplicate.width,
        sd: r.nonDuplicate.sd,
        ciExcludesZero: r.nonDuplicate.ciExcludesZero,
      },
      cardsReplayed: r.cardsReplayed,
      cards: r.cards,
      actions: actionDistribution(armAgg.actions),
      // Legality-guard substitutions only (outer `ensureLegal`); a RulePolicy
      // internal safeFallback is not counted here.
      legalityFallbacks: armAgg.stats.legalityFallbacks,
      legalityIllegalDecisions: armAgg.stats.legalityIllegalDecisions,
      /** arm seat's memory visibility: decisions seen vs decisions with opponents. */
      memorySeen: armAgg.memory,
      referenceActionsPerPair: actionDistribution(refAgg.actions),
      runs: r.runs.map((run) => ({ ...run, clean: runDigestIsClean(run) })),
    });
  }

  return {
    kind: 'bot-eval-arms',
    reference,
    arms,
    testArms,
    referenceConfig: armConfig(reference),
    seed,
    hands,
    memory,
    bootstrapIters,
    /**
     * True only when there was at least one pair and every pair passed the full
     * validity gate. An empty comparison (`arms` == only the reference) is NOT
     * all-clean, so "no experiment" can never read as green.
     */
    allClean: pairs.length > 0 && pairs.every((p) => p.clean),
    pairs,
    referenceSummary: {
      actions: actionDistribution(referenceActions),
      legalityFallbacks: referenceStats.legalityFallbacks,
      legalityIllegalDecisions: referenceStats.legalityIllegalDecisions,
      memorySeen: referenceMemory,
    },
  };
}
