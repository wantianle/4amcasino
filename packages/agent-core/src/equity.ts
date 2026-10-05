import { ALL_CARDS, evaluate7, type CardId } from '@4am/shared';

/**
 * Phase 2: a pure, seeded Monte-Carlo equity estimator for a policy's own hand.
 *
 * Given the bot's hole cards, the public board and a number of *random*
 * opponents, it samples runouts + opponent hands and returns the bot's average
 * share of the pot in [0, 1] (ties split). It deliberately knows nothing about
 * anyone's actual cards - a policy can only estimate against a random range, so
 * this is not a peeking tool.
 *
 * It lives in agent-core (no server dependency): the server's `equity.ts` is a
 * worker-thread service for the known-hands multi-run feature, whereas a bot
 * decision is lightweight enough to compute inline. Everything it needs
 * (`ALL_CARDS`, `evaluate7`) is already exported by `@4am/shared`.
 *
 * Complexity per sample: one partial Fisher-Yates over the unseen deck (~5 +
 * 2*opponents draws) plus one `evaluate7` per player (21 `evaluate5` calls
 * each). The default sample count keeps a decision in the low milliseconds.
 */

export const DEFAULT_EQUITY_SAMPLES = 160;
/** Default seed: fixed so an unseeded policy is reproducible run to run. */
export const DEFAULT_EQUITY_SEED = 0x4a6d2b79;
/** Nine-handed table = eight opponents; also comfortably within the deck. */
export const MAX_EQUITY_OPPONENTS = 8;
/** Hard cap so a bad config can never turn a decision into a long computation. */
export const MAX_EQUITY_SAMPLES = 100_000;

export interface EquityInput {
  /** The estimator's own two hole cards. */
  hole: readonly CardId[];
  /** Public board, 0..5 cards. */
  board?: readonly CardId[];
  /** Number of random opponents (default 1). */
  opponents?: number;
  /** Monte-Carlo samples (default `DEFAULT_EQUITY_SAMPLES`). */
  samples?: number;
  /** Deterministic seed; the same seed always yields the same estimate. */
  seed?: number;
}

export interface EquityResult {
  /** Win share in [0, 1]; ties split equally among the tied best hands. */
  equity: number;
  samples: number;
  method: 'monte-carlo';
}

/** mulberry32: tiny, fast, fully determined by the seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function validCard(c: number): boolean {
  return Number.isInteger(c) && c >= 0 && c <= 51;
}

/**
 * Validate a numeric option (defaulting when absent) and fail fast on
 * `NaN`/`Infinity`/non-integers/out-of-range values, so a bad config can never
 * silently become an out-of-bounds shuffle or an infinite loop.
 */
function resolveCount(
  name: string,
  value: unknown,
  fallback: number,
  max: number,
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value))
    throw new Error(`estimateEquity: ${name} must be a finite integer`);
  if (value < 1 || value > max)
    throw new Error(`estimateEquity: ${name} must be between 1 and ${max}`);
  return value;
}

/** Estimate the bot's equity against `opponents` random hands. */
export function estimateEquity(input: EquityInput): EquityResult {
  const hole = [...(input.hole ?? [])];
  if (hole.length !== 2 || !hole.every(validCard))
    throw new Error('estimateEquity needs exactly two valid hole cards');
  const board = [...(input.board ?? [])];
  if (board.length > 5 || !board.every(validCard))
    throw new Error('estimateEquity board must be 0..5 valid cards');
  const known = [...hole, ...board];
  if (new Set(known).size !== known.length)
    throw new Error('estimateEquity: duplicate card across hole/board');

  const opponents = resolveCount('opponents', input.opponents, 1, MAX_EQUITY_OPPONENTS);
  const samples = resolveCount('samples', input.samples, DEFAULT_EQUITY_SAMPLES, MAX_EQUITY_SAMPLES);
  const need = 5 - board.length;
  const deck = ALL_CARDS.filter((c) => !known.includes(c));
  // The runout + every opponent's two hole cards always fit the unseen deck:
  // at most 7 known cards (2 hole + 5 board) leave >=45 cards, while we draw
  // need (<=5) + opponents (<=8) * 2 = <=21. The partial shuffle cannot run
  // off the end.
  const drawsPerSample = need + opponents * 2;
  const rand = mulberry32((input.seed ?? DEFAULT_EQUITY_SEED) >>> 0);

  let score = 0;
  for (let s = 0; s < samples; s++) {
    // Partial Fisher-Yates: draw `drawsPerSample` distinct cards uniformly.
    for (let i = 0; i < drawsPerSample; i++) {
      const j = i + Math.floor(rand() * (deck.length - i));
      const tmp = deck[i]!;
      deck[i] = deck[j]!;
      deck[j] = tmp;
    }
    let p = 0;
    const fullBoard = board.length === 5 ? board : [...board, ...deck.slice(p, p + need)];
    p += need;
    const myScore = evaluate7([hole[0]!, hole[1]!, ...fullBoard]);
    let best = myScore;
    let tiedAtBest = 1; // me
    for (let o = 0; o < opponents; o++) {
      const oppScore = evaluate7([deck[p]!, deck[p + 1]!, ...fullBoard]);
      p += 2;
      if (oppScore > best) {
        best = oppScore;
        tiedAtBest = 1;
      } else if (oppScore === best) {
        tiedAtBest++;
      }
    }
    if (myScore === best) score += 1 / tiedAtBest;
  }
  return { equity: score / samples, samples, method: 'monte-carlo' };
}
