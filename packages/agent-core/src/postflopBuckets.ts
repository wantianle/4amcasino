import { HAND_CATEGORY, rankOf, type CardId } from '@4am/shared';
import { evaluateHand, type HandEval } from './postflopStrength.js';
import type { VillainCombo } from './equity.js';
import { clamp, clamp01 } from './postflopMath.js';

/**
 * P2: 24 hand-strength buckets (6 made × 4 draw) (pure feature layer).
 *
 * Moved verbatim out of `postflopPolicy.ts`. The classifier is a documented
 * heuristic abstraction, not a solved range - it enriches range/nut-advantage
 * reads and never compares hands (the shared evaluator does that).
 */

/**
 * Made-hand bucket (the "how strong is it now" axis). Six coarse tiers, chosen
 * so the common postflop states are separable without a solver:
 * `air < weak-pair < mid-pair < top-pair < two-pair-plus < strong-made`.
 * `strong-made` is set/trips or better (any category >= 3).
 */
export type MadeBucket =
  | 'air'
  | 'weak-pair'
  | 'mid-pair'
  | 'top-pair'
  | 'two-pair-plus'
  | 'strong-made';

/**
 * Draw bucket (the "how much can it improve" axis). Four tiers. A flush draw
 * that also has any straight draw is the `combo-draw`; a plain flush draw or an
 * open-ended straight draw is a `strong-draw`; a lone gutshot is `gutshot`.
 */
export type DrawBucket = 'none' | 'gutshot' | 'strong-draw' | 'combo-draw';

export const MADE_BUCKETS: readonly MadeBucket[] = [
  'air',
  'weak-pair',
  'mid-pair',
  'top-pair',
  'two-pair-plus',
  'strong-made',
];

export const DRAW_BUCKETS: readonly DrawBucket[] = [
  'none',
  'gutshot',
  'strong-draw',
  'combo-draw',
];

/** The 24-bucket classification of one hand on one board. */
export interface HandBucket {
  made: MadeBucket;
  draw: DrawBucket;
  /** `madeIndex * 4 + drawIndex`, in [0, 23]. */
  index: number;
  /** Stable label, e.g. `top-pair/strong-draw`. */
  id: string;
}

function madeBucketOf(ev: HandEval, hole: readonly CardId[], board: readonly CardId[]): MadeBucket {
  if (ev.category >= HAND_CATEGORY.trips) return 'strong-made'; // set/trips, straight, flush, boat, quads, SF
  if (ev.category === HAND_CATEGORY.twoPair) return 'two-pair-plus';
  if (ev.category !== HAND_CATEGORY.pair) return 'air';
  const boardRanks = [...new Set(board.map(rankOf))].sort((a, b) => b - a);
  const maxBoard = boardRanks[0] ?? -1;
  const secondBoard = boardRanks[1] ?? -1;
  const pocket = hole.length === 2 && rankOf(hole[0]!) === rankOf(hole[1]!);
  if (pocket) {
    const pairRank = rankOf(hole[0]!);
    if (pairRank > maxBoard) return 'top-pair'; // overpair
    if (pairRank >= secondBoard) return 'mid-pair';
    return 'weak-pair'; // underpair
  }
  const pairedWithBoard = hole.find((card) => boardRanks.includes(rankOf(card)));
  if (pairedWithBoard === undefined) return 'weak-pair'; // playing the board's pair
  const pairRank = rankOf(pairedWithBoard);
  if (pairRank >= maxBoard) return 'top-pair';
  if (pairRank === secondBoard) return 'mid-pair';
  return 'weak-pair';
}

function drawBucketOf(ev: HandEval): DrawBucket {
  const flush = ev.flushDraw;
  const straight = ev.straightDraw;
  if (flush && straight >= 1) return 'combo-draw';
  if (flush || straight >= 2) return 'strong-draw';
  if (straight === 1) return 'gutshot';
  return 'none';
}

/**
 * Classify a postflop hand into one of 24 (made × draw) buckets. Pure and total:
 * every hand on a 3..5 card board maps to exactly one bucket (mutually
 * exclusive and jointly exhaustive). The classifier is a documented heuristic
 * abstraction, not a solved range - it is used to enrich range/nut-advantage
 * reads, never to compare hands (the shared evaluator does that).
 */
export function handBucket(hole: readonly CardId[], board: readonly CardId[]): HandBucket {
  if (hole.length < 2 || board.length < 3) {
    return { made: 'air', draw: 'none', index: 0, id: 'air/none' };
  }
  const ev = evaluateHand(hole, board);
  const made = madeBucketOf(ev, hole, board);
  const draw = drawBucketOf(ev);
  const madeIndex = MADE_BUCKETS.indexOf(made);
  const drawIndex = DRAW_BUCKETS.indexOf(draw);
  return {
    made,
    draw,
    index: madeIndex * DRAW_BUCKETS.length + drawIndex,
    id: `${made}/${draw}`,
  };
}

/** Heuristic strength in [0, 1] of a bucket, for range-advantage weighting. */
export function bucketStrength(bucket: HandBucket): number {
  const made = ['air', 'weak-pair', 'mid-pair', 'top-pair', 'two-pair-plus', 'strong-made'].indexOf(
    bucket.made,
  );
  const draw = ['none', 'gutshot', 'strong-draw', 'combo-draw'].indexOf(bucket.draw);
  const base = [0.05, 0.25, 0.4, 0.62, 0.8, 0.92][made] ?? 0.05;
  const bonus = [0, 0.05, 0.12, 0.18][draw] ?? 0;
  return clamp01(base + bonus);
}

/**
 * Bucket-based range advantage in [-1, 1]: hero's own bucket strength minus the
 * weight-averaged bucket strength of the supplied villain range, doubled so a
 * bucket-tier gap is a meaningful signal. Purely a ranking aid built from the
 * 24-bucket abstraction; it does not compare hands and never replaces the
 * shared evaluator.
 *
 * **Experimental API, not wired into any decision.** (The `buckets` switch,
 * on by default since 2026-10-06, reweights the *villain range* fed to the
 * decision, not this helper.) It exists so an eval can measure the bucket
 * abstraction; it must not be advertised as an active part of the policy.
 */
export function bucketAdvantage(
  hole: readonly CardId[],
  board: readonly CardId[],
  range: readonly VillainCombo[],
): number {
  let weighted = 0;
  let total = 0;
  for (const combo of range) {
    const weight = Number.isFinite(combo.weight) ? Math.max(0, combo.weight) : 0;
    if (weight === 0) continue;
    weighted += weight * bucketStrength(handBucket(combo.cards, board));
    total += weight;
  }
  if (total <= 0) return 0;
  const heroStrength = bucketStrength(handBucket(hole, board));
  return clamp((heroStrength - weighted / total) * 2, -1, 1);
}
