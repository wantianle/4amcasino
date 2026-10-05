import { ALL_CARDS, evaluate7, type CardId } from '@4am/shared';

/**
 * Phase 2: a pure, seeded Monte-Carlo equity estimator for a policy's own hand.
 *
 * Given the bot's hole cards, the public board and a number of *random*
 * opponents, it samples runouts + opponent hands and returns the bot's average
 * share of the pot in [0, 1] (ties split). It deliberately knows nothing about
 * anyone's actual cards - a policy can only estimate against a range it
 * constructs from public information, so this is not a peeking tool.
 *
 * By default the opponent prior is uniform over every board-remaining two-card
 * combo. An optional `villainRange` (explicit weighted `combos`, or a
 * `weightFn`) replaces that prior with a narrower, weighted range - e.g. the
 * heuristic continuing range a betting opponent is assigned by the P0 postflop
 * policy. Both paths are seeded and deterministic.
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

/** One weighted opponent combo for a non-uniform (range) estimate. */
export interface VillainCombo {
  /** The opponent's two hole cards. */
  cards: readonly [CardId, CardId];
  /** Relative sampling weight; must be finite and `>= 0` (0 drops the combo). */
  weight: number;
}

/**
 * A non-uniform opponent prior for `estimateEquity`.
 *
 * Supply **exactly one** of:
 *  - `combos`: an explicit weighted combo list (the P0 policy path — weights are
 *    precomputed from a cached board strength tier, so no per-decision
 *    evaluation happens inside the estimator);
 *  - `weightFn`: a function over every board-remaining combo, evaluated once per
 *    call and then sampled by weight.
 *
 * Supplying both — or neither — throws, rather than silently preferring one
 * branch. Duplicate combos in `combos` (the same unordered card pair listed more
 * than once) are **merged by summing their weights**, so a caller that
 * concatenates range fragments never double-counts a hand as two independent
 * draws.
 *
 * Combos that collide with the hero's hole cards or the board are impossible and
 * silently dropped. The same prior is applied to every requested opponent; when
 * it cannot fill them all without replacement, the overflow is drawn uniformly
 * from the unseen deck (the documented multiway fallback approximation, counted
 * by `EquityResult.uniformFallbacks`).
 */
export interface VillainRange {
  combos?: ReadonlyArray<VillainCombo>;
  weightFn?: (cards: readonly [CardId, CardId]) => number;
}

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
  /**
   * Optional non-uniform opponent prior. Omitted/undefined keeps the original
   * behaviour: uniform over every board-remaining two-card combo. When present,
   * opponents are drawn from the weighted range instead.
   */
  villainRange?: VillainRange;
}

export interface EquityResult {
  /** Win share in [0, 1]; ties split equally among the tied best hands. */
  equity: number;
  samples: number;
  method: 'monte-carlo';
  /**
   * Weighted-range path only: how many opponent draws across all samples could
   * not be filled without replacement and fell back to a uniform draw from the
   * remaining unseen deck (because the supplied range was exhausted). Zero for
   * a sufficient range; `undefined` for the uniform path with no `villainRange`.
   * Exposed so the documented multiway fallback is observable rather than
   * silently blending into the estimate.
   */
  uniformFallbacks?: number;
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

interface PoolCombo {
  a: CardId;
  b: CardId;
  weight: number;
}

/**
 * Materialise a `VillainRange` into sampled combos, excluding impossible combos
 * that share a card with the hero/board. Fails fast on malformed shapes, card
 * ids and weights so a bad range can never silently bias the estimate. The two
 * sources are mutually exclusive (exactly one), and duplicate explicit combos
 * are merged by summing their weights.
 */
function buildVillainPool(
  range: VillainRange,
  known: readonly CardId[],
): PoolCombo[] {
  const hasCombos = range.combos !== undefined;
  const hasFn = range.weightFn !== undefined;
  if (hasCombos === hasFn)
    throw new Error(
      'estimateEquity: villainRange must supply exactly one of combos or weightFn',
    );
  const knownSet = new Set(known);
  const pool: PoolCombo[] = [];
  if (hasCombos) {
    // Merge duplicates on the unordered card pair, normalising the stored order
    // so `[Ac,Ad]` and `[Ad,Ac]` are the same combo.
    const merged = new Map<string, PoolCombo>();
    for (const combo of range.combos!) {
      const [a, b] = combo.cards ?? [];
      if (!validCard(a) || !validCard(b) || a === b)
        throw new Error('estimateEquity: villain combo needs two distinct valid cards');
      const weight = combo.weight;
      if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0)
        throw new Error('estimateEquity: villain combo weight must be a finite number >= 0');
      if (weight === 0 || knownSet.has(a) || knownSet.has(b)) continue;
      const lo = a < b ? a : b;
      const hi = a < b ? b : a;
      const key = `${lo},${hi}`;
      const existing = merged.get(key);
      if (existing) existing.weight += weight;
      else merged.set(key, { a: lo, b: hi, weight });
    }
    for (const entry of merged.values()) pool.push(entry);
  } else {
    const fn = range.weightFn!;
    for (let i = 0; i < ALL_CARDS.length; i++) {
      for (let j = i + 1; j < ALL_CARDS.length; j++) {
        const a = ALL_CARDS[i]!;
        const b = ALL_CARDS[j]!;
        if (knownSet.has(a) || knownSet.has(b)) continue;
        const weight = fn([a, b] as const);
        if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0)
          throw new Error('estimateEquity: villainRange.weightFn must return a finite number >= 0');
        if (weight === 0) continue;
        pool.push({ a, b, weight });
      }
    }
  }
  if (pool.length === 0) throw new Error('estimateEquity: villain range has no legal combos');
  return pool;
}

/**
 * Weighted range branch of `estimateEquity`. Draws every opponent from the
 * prior (without replacement) before the runout, so a sampled opponent can never
 * duplicate the board or another opponent.
 *
 * **Multiway fallback approximation:** when the range has fewer legal combos
 * than `opponents` (or its remaining combos all collide with cards already
 * drawn this sample), the extra opponents are filled *uniformly* from the
 * remaining unseen deck. The first opponents still come from the weighted
 * range; only the overflow is uniform. `EquityResult.uniformFallbacks` counts
 * those draws. This keeps the estimate finite and collision-free instead of
 * looping or dropping opponents, at the cost of under-weighting the tail.
 */
function estimateEquityVsRange(
  input: EquityInput,
  range: VillainRange,
  hole: readonly CardId[],
  board: readonly CardId[],
  known: readonly CardId[],
  opponents: number,
  samples: number,
): EquityResult {
  const rand = mulberry32((input.seed ?? DEFAULT_EQUITY_SEED) >>> 0);
  const pool = buildVillainPool(range, known);
  // Cumulative weights make the common heads-up draw O(log n) instead of O(n)
  // per sample. A single `rand()` is drawn per opponent either way, so the
  // seeded stream is unchanged by the fast path.
  const cumulative = new Float64Array(pool.length);
  let poolTotal = 0;
  for (let i = 0; i < pool.length; i++) {
    poolTotal += pool[i]!.weight;
    cumulative[i] = poolTotal;
  }
  // Fail fast rather than let two huge (but individually finite) weights sum to
  // `Infinity`: a non-finite total makes `rand() * poolTotal` NaN and silently
  // collapses the weighted draw to the first combo, returning a biased equity.
  if (!Number.isFinite(poolTotal) || poolTotal <= 0)
    throw new Error(
      'estimateEquity: villain range weight total is not a finite positive number (weights overflow)',
    );
  const need = 5 - board.length;
  const deck = ALL_CARDS.filter((c) => !known.includes(c));

  let score = 0;
  let uniformFallbacks = 0;
  for (let s = 0; s < samples; s++) {
    const used = new Set<CardId>();
    const oppHands: [CardId, CardId][] = [];
    for (let o = 0; o < opponents; o++) {
      let chosen: PoolCombo | null = null;
      if (used.size === 0) {
        // No cards drawn yet: binary-search the precomputed cumulative weights.
        const r = rand() * poolTotal;
        let lo = 0;
        let hi = pool.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (cumulative[mid]! <= r) lo = mid + 1;
          else hi = mid;
        }
        chosen = pool[lo]!;
      } else {
        // Renormalise over combos that avoid cards already drawn this sample.
        let total = 0;
        for (const combo of pool) {
          if (!used.has(combo.a) && !used.has(combo.b)) total += combo.weight;
        }
        if (total > 0) {
          let r = rand() * total;
          for (const combo of pool) {
            if (used.has(combo.a) || used.has(combo.b)) continue;
            r -= combo.weight;
            if (r <= 0) {
              chosen = combo;
              break;
            }
          }
          if (!chosen) {
            // Floating-point tail: take the last still-legal combo.
            for (const combo of pool) {
              if (!used.has(combo.a) && !used.has(combo.b)) chosen = combo;
            }
          }
        }
      }
      if (chosen) {
        used.add(chosen.a);
        used.add(chosen.b);
        oppHands.push([chosen.a, chosen.b]);
      } else {
        // Range exhausted for this opponent: documented multiway fallback to a
        // uniform draw from the unseen deck (counted for observability).
        uniformFallbacks++;
        const remaining = deck.filter((c) => !used.has(c));
        const a = remaining[Math.floor(rand() * remaining.length)]!;
        used.add(a);
        const remaining2 = deck.filter((c) => !used.has(c));
        const b = remaining2[Math.floor(rand() * remaining2.length)]!;
        used.add(b);
        oppHands.push([a, b]);
      }
    }

    const runoutDeck = deck.filter((c) => !used.has(c));
    for (let i = 0; i < need; i++) {
      const j = i + Math.floor(rand() * (runoutDeck.length - i));
      const tmp = runoutDeck[i]!;
      runoutDeck[i] = runoutDeck[j]!;
      runoutDeck[j] = tmp;
    }
    const fullBoard = board.length === 5 ? board : [...board, ...runoutDeck.slice(0, need)];
    const myScore = evaluate7([hole[0]!, hole[1]!, ...fullBoard]);
    let best = myScore;
    let tiedAtBest = 1;
    for (let o = 0; o < opponents; o++) {
      const [oa, ob] = oppHands[o]!;
      const oppScore = evaluate7([oa, ob, ...fullBoard]);
      if (oppScore > best) {
        best = oppScore;
        tiedAtBest = 1;
      } else if (oppScore === best) {
        tiedAtBest++;
      }
    }
    if (myScore === best) score += 1 / tiedAtBest;
  }
  return { equity: score / samples, samples, method: 'monte-carlo', uniformFallbacks };
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
  if (input.villainRange)
    return estimateEquityVsRange(input, input.villainRange, hole, board, known, opponents, samples);
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
