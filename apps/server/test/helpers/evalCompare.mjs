/**
 * Duplicate comparison of two policies, shared by `botEval.mjs` and its tests.
 *
 * run1: A@seat1, B@seat2
 * run2: B@seat1, A@seat2   (same seed => same hand ids => same cards per seat)
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
  } = opts;

  const runOpts = { seed, hands, anchor, sb, bb, buyIn, actionMs, cryptoMs, handMs };
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
    dupSamples.push((a1 - b1 + (a2 - b2)) / 2);
  }

  const toBb100 = (x) => (x / bb) * 100;
  const dup = bootstrapCI(dupSamples.map(toBb100), { iters: bootstrapIters, seed });
  const plain = bootstrapCI(plainSamples.map(toBb100), { iters: bootstrapIters, seed });
  const ciExcludesZero = dup.ci95[0] > 0 || dup.ci95[1] < 0;
  const direction = dup.mean > 0 ? `${a} > ${b}` : dup.mean < 0 ? `${b} > ${a}` : 'tie';

  return {
    a,
    b,
    hands: usable,
    duplicate: true,
    cardsReplayed,
    cards: {
      handIdsMatch: run1.handIds.length === run2.handIds.length &&
        run1.handIds.every((id, i) => id === run2.handIds[i]),
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
    runs: [
      {
        seatPolicies: run1.seatPolicies,
        hands: run1.hands,
        aborts: run1.aborts,
        rejected: run1.rejected,
        botErrors: run1.botErrors,
        ledgerOk: run1.ledgerOk,
        policyFallbacks: run1.policyFallbacks,
        policyIllegalDecisions: run1.policyIllegalDecisions,
        cardsFingerprintComplete: run1.cardsFingerprintComplete,
      },
      {
        seatPolicies: run2.seatPolicies,
        hands: run2.hands,
        aborts: run2.aborts,
        rejected: run2.rejected,
        botErrors: run2.botErrors,
        ledgerOk: run2.ledgerOk,
        policyFallbacks: run2.policyFallbacks,
        policyIllegalDecisions: run2.policyIllegalDecisions,
        cardsFingerprintComplete: run2.cardsFingerprintComplete,
      },
    ],
  };
}
