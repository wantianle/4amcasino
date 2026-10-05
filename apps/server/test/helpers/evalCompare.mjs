/**
 * Duplicate comparison of two policies, shared by `botEval.mjs` and its tests.
 *
 * run1: A@seat1, B@seat2, anchor@seat0
 * run2: B@seat1, A@seat2, anchor@seat0   (same seed => same hand ids => same cards per seat)
 *
 * This is a THREE-HANDED table: the two compared strategies sit opposite each
 * other at seats 1/2 while the seat-0 `anchor` (default `always-call`) fills the
 * table and is never itself part of the comparison.
 *
 * per-hand duplicate delta = avg( A_run1 - B_run1 , A_run2 - B_run2 )
 * per-hand plain     delta = A_run1 - B_run1   (like-for-like, no swap)
 *
 * The duplicate observation averages the strategy delta over both seatings, so
 * the luck of who received the better cards cancels out.
 */
import { runEvalMatch, deltasBySeat } from './evalMatch.mjs';
import { bootstrapCI } from './evalStrategies.mjs';

/**
 * Per-hand paired observation: average the seat-swapped strategy deltas.
 * `pairedDelta(a1, b1, a2, b2) = (a1 - b1 + (a2 - b2)) / 2`, where a1/b1 are
 * A/B's seat deltas in run1 and a2/b2 are A/B's (seat-swapped) deltas in run2.
 * Pure and exported so the estimator is unit-testable without a server run.
 */
export function pairedDelta(a1, b1, a2, b2) {
  return (a1 - b1 + (a2 - b2)) / 2;
}

/**
 * Prove two runs replayed the SAME physical cards, not merely the same hand-id
 * labels. Requires, hand for hand:
 *   - equal hand ids (the deterministic-deal selector);
 *   - complete fingerprints (every dealt seat's two hole cards + a settlement);
 *   - identical seat-ordered hole cards; and
 *   - identical board cards over the common prefix (the board is only opened as
 *     far as the action reached, so a fold-out vs a showdown is not a mismatch).
 * A same-id run with a different permutation (see `shuffleSalt`) therefore fails
 * this check, which is exactly what the bare hand-id comparison could not catch.
 */
export function duplicateCardsReplayed(run1, run2) {
  if (run1.handIds.length !== run2.handIds.length) return false;
  if (!run1.handIds.every((id, i) => id === run2.handIds[i])) return false;
  const f1 = run1.cardFingerprints ?? [];
  const f2 = run2.cardFingerprints ?? [];
  if (f1.length !== f2.length || f1.length !== run1.handIds.length) return false;
  return f1.every((fp, i) => {
    const g = f2[i];
    if (fp?.complete !== true || g?.complete !== true) return false;
    if (fp.holeFingerprint !== g.holeFingerprint) return false;
    const n = Math.min(fp.board.length, g.board.length);
    for (let j = 0; j < n; j++) if (fp.board[j] !== g.board[j]) return false;
    return true;
  });
}

/** First hand whose cards disagree (or whose fingerprint is incomplete), if any. */
function firstCardMismatch(run1, run2) {
  const n = Math.min(run1.cardFingerprints.length, run2.cardFingerprints.length);
  for (let i = 0; i < n; i++) {
    const a = run1.cardFingerprints[i];
    const b = run2.cardFingerprints[i];
    if (!a?.complete || !b?.complete || a.holeFingerprint !== b.holeFingerprint) {
      return { handId: run1.handIds[i], reason: 'hole_cards', run1: a?.fingerprint ?? null, run2: b?.fingerprint ?? null };
    }
    const common = Math.min(a.board.length, b.board.length);
    for (let j = 0; j < common; j++)
      if (a.board[j] !== b.board[j])
        return {
          handId: run1.handIds[i],
          reason: `board[${j}]`,
          run1: a.fingerprint,
          run2: b.fingerprint,
        };
  }
  return null;
}

/**
 * Compact, serializable digest of one run, embedded in `comparePair(...).runs`.
 * The legality fields count ONLY outer `ensureLegal` substitutions (a
 * `RulePolicy` internal `safeFallback` is invisible here); `seatMemory` proves
 * whether the injected cross-hand memory reached each seat.
 */
function runSummary(run) {
  return {
    seatPolicies: run.seatPolicies,
    hands: run.hands,
    requestedHands: run.requestedHands,
    aborts: run.aborts,
    rejected: run.rejected,
    botErrors: run.botErrors,
    ledgerOk: run.ledgerOk,
    policyLegalityFallbacks: run.policyLegalityFallbacks,
    policyLegalityIllegalDecisions: run.policyLegalityIllegalDecisions,
    seatActions: run.seatActions,
    seatPolicyStats: run.seatPolicyStats,
    seatMemory: run.seatMemory,
    memory: run.memory,
    cardsFingerprintComplete: run.cardsFingerprintComplete,
  };
}

/**
 * True when a run digest shows no abort / server rejection / bot error / ledger
 * break / outer legality repair **and** is a complete, card-proven experiment:
 * every requested hand played and every dealt card fingerprinted. Exported so a
 * consumer of `comparePair` can gate on validity itself instead of trusting the
 * totals. A `hands: 0` or incomplete-fingerprint digest is NOT clean.
 */
export function runDigestIsClean(run) {
  return (
    run.aborts === 0 &&
    run.rejected === 0 &&
    (run.botErrors ?? 0) === 0 &&
    run.ledgerOk === true &&
    (run.policyLegalityFallbacks ?? 0) === 0 &&
    (run.policyLegalityIllegalDecisions ?? 0) === 0 &&
    (run.hands ?? 0) > 0 &&
    run.hands === run.requestedHands &&
    run.cardsFingerprintComplete === true
  );
}

/**
 * True when the injected session memory recorded every settled hand for every
 * seat, i.e. no inter-hand record was lost to the next deal. `maxHandsObserved`
 * is the highest `sessionMemory.handsObserved` any decision on that seat saw;
 * with a correct barrier it reaches `hands - 1` (the last hand has no later
 * decision to observe it). Only meaningful on the memory-on path.
 */
export function runMemoryComplete(run) {
  if (run.memory !== true) return true;
  const expected = (run.hands ?? 0) - 1;
  const perSeat = run.seatMemory ?? {};
  // Only the memory-injected bot seats are gated. Seat 0 is the harness-driven
  // anchor whose decision view carries no session memory at all, so it can
  // never observe a count and must not fail the check.
  const policySeats = run.seatPolicies ? Object.keys(run.seatPolicies) : null;
  const seats = policySeats ?? Object.keys(perSeat);
  if (seats.length === 0) return false;
  return seats.every(
    (seat) => perSeat[seat] && (perSeat[seat].maxHandsObserved ?? 0) >= expected,
  );
}

export async function comparePair(a, b, opts = {}) {
  const {
    seed = 1234,
    hands = 200,
    anchor = 'always-call',
    sb = 10,
    bb = 20,
    buyIn = 4000,
    actionMs = 1_000,
    cryptoMs = 2_000,
    handMs = 30_000,
    bootstrapIters = 10_000,
    memory = false,
  } = opts;

  const runOpts = { seed, hands, anchor, sb, bb, buyIn, actionMs, cryptoMs, handMs, memory };
  const run1 = await runEvalMatch({ ...runOpts, seatPolicies: { 1: a, 2: b } });
  const run2 = await runEvalMatch({ ...runOpts, seatPolicies: { 1: b, 2: a } });

  const usable = Math.min(run1.perHand.length, run2.perHand.length);
  const cardsReplayed = duplicateCardsReplayed(run1, run2);
  const fingerprintsComplete =
    run1.cardsFingerprintComplete === true && run2.cardsFingerprintComplete === true;
  const firstMismatch = firstCardMismatch(run1, run2);

  const dupSamples = [];
  const plainSamples = [];
  for (let h = 0; h < usable; h++) {
    const d1 = deltasBySeat(run1.perHand[h]);
    const d2 = deltasBySeat(run2.perHand[h]);
    const a1 = d1.get(1) ?? 0;
    const b1 = d1.get(2) ?? 0;
    const b2 = d2.get(1) ?? 0; // B occupies seat 1 in run2
    const a2 = d2.get(2) ?? 0; // A occupies seat 2 in run2
    plainSamples.push(a1 - b1);
    dupSamples.push(pairedDelta(a1, b1, a2, b2));
  }

  const toBb100 = (x) => (x / bb) * 100;
  const dup = bootstrapCI(dupSamples.map(toBb100), { iters: bootstrapIters, seed });
  const plain = bootstrapCI(plainSamples.map(toBb100), { iters: bootstrapIters, seed });
  const ciExcludesZero = dup.ci95[0] > 0 || dup.ci95[1] < 0;
  const direction = dup.mean > 0 ? `${a} > ${b}` : dup.mean < 0 ? `${b} > ${a}` : 'tie';

  const runs = [runSummary(run1), runSummary(run2)];
  const handIdsMatch =
    run1.handIds.length === run2.handIds.length &&
    run1.handIds.every((id, i) => id === run2.handIds[i]);
  // Full experiment-validity gate: the two runs were error-free AND complete,
  // replayed the same physical cards, produced a non-empty paired comparison,
  // and (memory-on) recorded every settled hand for every seat. A consumer must
  // not read the point estimate unless this is true.
  const clean =
    runs.every(runDigestIsClean) &&
    runs.every(runMemoryComplete) &&
    cardsReplayed === true &&
    fingerprintsComplete === true &&
    handIdsMatch === true &&
    usable > 0 &&
    dup.n > 0;

  return {
    a,
    b,
    hands: usable,
    duplicate: true,
    memory,
    /**
     * True only for a complete, card-proven, non-empty comparison (and, with
     * memory on, one where no settled hand was dropped). `false` means the point
     * estimate must not be trusted.
     */
    clean,
    cardsReplayed,
    cards: {
      handIdsMatch,
      fingerprintsComplete,
      firstMismatch,
    },
    delta: {
      label: `bb/100 (${a} - ${b})`,
      bb100: +dup.mean.toFixed(3),
      ci95: [+dup.ci95[0].toFixed(3), +dup.ci95[1].toFixed(3)],
      width: +dup.width.toFixed(3),
      sd: +dup.sd.toFixed(3),
      ciExcludesZero,
      direction,
      hands: dup.n,
    },
    nonDuplicate: {
      label: `bb/100 (${a} - ${b}) without seat swap`,
      bb100: +plain.mean.toFixed(3),
      ci95: [+plain.ci95[0].toFixed(3), +plain.ci95[1].toFixed(3)],
      width: +plain.width.toFixed(3),
      sd: +plain.sd.toFixed(3),
      ciExcludesZero: plain.ci95[0] > 0 || plain.ci95[1] < 0,
      hands: plain.n,
    },
    runs,
  };
}
