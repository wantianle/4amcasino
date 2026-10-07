// Single source of truth for the owner's bet-sizing standard (2026-10-07).
//
// EVERYTHING that defines *which sizes exist* lives here: the preflop open /
// 3-bet / 4-bet multipliers and the per-street postflop pot-fraction grids. The
// decision code (`postflopPolicy.ts`, `rulePolicy.ts`) and the frozen baseline
// fixtures in `test/fixtures/` all import from this module, so a sizing edit
// cannot silently diverge between a policy and its differential baseline.
//
// This file is intentionally behaviour-free data + tiny pure helpers; the
// heuristics that *pick* a size stay in `postflopPolicy.chooseBetFraction`.

import type { Street } from '@4am/shared';

// ---------------------------------------------------------------------------
// preflop sizing standard (multiples / bb)
// ---------------------------------------------------------------------------

/** Standard preflop open, in big blinds. */
export const PREFLOP_OPEN_BB = 2.5;
/** Small-blind open, in big blinds (larger because the SB is out of position). */
export const PREFLOP_SB_OPEN_BB = 3;
/** 3-bet multiple of the open, in position. */
export const PREFLOP_3BET_IP_MULT = 3;
/** 3-bet multiple of the open, out of position. */
export const PREFLOP_3BET_OOP_MULT = 4;
/** 4-bet multiple of the 3-bet, in position. */
export const PREFLOP_4BET_IP_MULT = 2.2;
/** 4-bet multiple of the 3-bet, out of position. */
export const PREFLOP_4BET_OOP_MULT = 2.5;
/** Below this effective stack (bb) every preflop raise is a deliberate shove. */
export const PREFLOP_SHORT_STACK_BB = 20;

// ---------------------------------------------------------------------------
// postflop sizing standard (per-street pot fractions)
// ---------------------------------------------------------------------------

/**
 * Postflop street key for the per-street size grids. `preflop` is not a valid
 * grid street (its opens/3-bets are sized in bb, see the constants above).
 */
export type PostflopStreet = Exclude<Street, 'preflop'>;

/**
 * The bot's **own per-street action grids** — the sizes *we* may bet, plus the
 * `'all-in'` sentinel handled by {@link snapBetFraction}.
 *
 * Product standard (owner directive):
 *   - `flop`:  `[0.33, 0.75]`               (no small-half, no overbet tier)
 *   - `turn`:  `[0.5, 0.75, 1.0, 1.5]`      + all-in
 *   - `river`: `[0.33, 0.5, 0.75, 1.0, 1.5]` + all-in
 *
 * Turn and river deliberately differ (turn has no 33%).
 *
 * This is an **action abstraction for our own bets only** — the opponent is not
 * bound by it (see {@link OPPONENT_READ_GRID} for how their bets are read).
 */
export const POSTFLOP_SIZE_GRIDS: Readonly<Record<PostflopStreet, readonly number[]>> = Object.freeze({
  flop: Object.freeze([0.33, 0.75] as const),
  turn: Object.freeze([0.5, 0.75, 1.0, 1.5] as const),
  river: Object.freeze([0.33, 0.5, 0.75, 1.0, 1.5] as const),
});

/**
 * Union of every per-street numeric point, ascending: the "any street" set used
 * by callers that read a size without a street context (the eval harness's
 * off-grid probes and the legacy `PostflopSize` type). It is NOT an action grid
 * — our own decision paths always read a single street's grid from
 * {@link POSTFLOP_SIZE_GRIDS}. Opponent reads are their own abstraction, see
 * {@link OPPONENT_READ_GRID}.
 *
 * Runtime-frozen like its per-street siblings, so an accidental in-place
 * mutation cannot silently change the shared read grid below.
 */
export const POSTFLOP_SIZE_GRID = Object.freeze([0.33, 0.5, 0.75, 1.0, 1.5] as const);

/**
 * The grid used to **interpret an opponent's bet size** (a read) — a *read
 * abstraction*, deliberately independent of {@link POSTFLOP_SIZE_GRIDS}, our own
 * per-street action standard. An opponent may bet any continuous fraction and is
 * not bound by our action abstraction, so the *same* observed size must mean the
 * *same* thing on every street. Reading it on a per-street grid made a 0.9-pot
 * bet `balanced` on the flop (snapped down to 0.75) but `value-heavy` on the
 * turn (snapped up to 1.0) purely because *our own* action grid differed — a
 * behavioural discontinuity in the read.
 *
 * Today this aliases {@link POSTFLOP_SIZE_GRID} (identical values), but the two
 * exist to change for **different reasons**: this one moves only when
 * opponent-read calibration changes, never as a side effect of editing our
 * action grids. When read calibration first needs a different set, give this its
 * own literal instead of editing the action union.
 */
export const OPPONENT_READ_GRID: readonly number[] = POSTFLOP_SIZE_GRID;

/**
 * LEGACY UNION, not a per-street exact type: it is the union across all streets,
 * so it types `0.33` as valid on the turn and `0.5` on the flop even though
 * those sizes do not exist on those streets. Use {@link POSTFLOP_SIZE_GRIDS} for
 * per-street validity; a future `PostflopSizeByStreet` may tighten this.
 */
export type PostflopSize = (typeof POSTFLOP_SIZE_GRID)[number] | 'all-in';

/**
 * Street assumed by the standalone read helpers when the caller has none: the
 * widest grid (river), so a street-less `snapBetFraction`/`chooseBetFraction`
 * keeps the full small→large ladder rather than inventing a narrower size set.
 *
 * NOTE: this default exists for backwards compatibility with callers that do
 * not carry a street (mostly test/eval tools). Business paths must pass an
 * explicit street; a missing argument here silently reads on the river grid.
 */
export const DEFAULT_SIZE_STREET: PostflopStreet = 'river';

/** True when `street` has an overbet tier; the flop standard does not. */
export function streetSupportsOverbet(street: PostflopStreet): boolean {
  return street !== 'flop';
}

/**
 * Resolve a public `Street` to a postflop grid key. `preflop`/missing reads as
 * `flop` (the helpers are only meaningful postflop, and flop is the safe
 * conservative default).
 */
export function postflopStreetOf(street: Street | null | undefined): PostflopStreet {
  return street === 'turn' || street === 'river' ? street : 'flop';
}

/**
 * Nearest grid point to `fraction` on `grid`, measured by absolute distance. On
 * an exact midpoint the strict `<` keeps the **earlier, smaller** point (the
 * documented tie bias); callers that need round-half-up must jitter the input.
 */
export function nearestStreetSize(fraction: number, grid: readonly number[]): number {
  let best = grid[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const point of grid) {
    const distance = Math.abs(point - fraction);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = point;
    }
  }
  return best;
}

/**
 * Snap a pot fraction to the nearest point of a **street's own action grid**
 * (`POSTFLOP_SIZE_GRIDS[street]`) — the "nearest neighbour" translation of a
 * size against the bot's own per-street standard. It is NOT the opponent read:
 * interpreting an opponent's bet uses {@link snapOpponentRead} on the global
 * grid, because an opponent is not bound by our per-street abstraction. On a
 * river read a 0.42-pot bet becomes 0.5, a 0.62-pot bet 0.75, an oversized
 * 3-pot bet the street's top grid point, and a flagged all-in always reads as
 * `'all-in'` regardless of its chip fraction.
 *
 * Ties bias toward the lower size by design (see {@link nearestStreetSize}). A
 * non-finite / non-positive fraction has no meaningful size and reads as the
 * neutral half-pot, **snapped to the street's own grid** (0.33 on the flop, 0.5
 * on turn/river), so the result is always a size the street allows.
 */
export function snapBetFraction(
  fraction: number,
  allIn = false,
  street: PostflopStreet = DEFAULT_SIZE_STREET,
): PostflopSize {
  if (allIn) return 'all-in';
  const grid = POSTFLOP_SIZE_GRIDS[street];
  if (!Number.isFinite(fraction) || fraction <= 0) {
    return nearestStreetSize(0.5, grid) as PostflopSize;
  }
  return nearestStreetSize(fraction, grid) as PostflopSize;
}

/**
 * Snap an **observed opponent bet fraction** to {@link OPPONENT_READ_GRID}, the
 * single global read grid (see its doc for why the read must not be per-street).
 * `allIn` is a sentinel independent of the fraction. A non-finite / non-positive
 * fraction reads as the neutral half-pot on the global grid (0.5).
 */
export function snapOpponentRead(fraction: number, allIn = false): PostflopSize {
  if (allIn) return 'all-in';
  if (!Number.isFinite(fraction) || fraction <= 0) {
    return nearestStreetSize(0.5, OPPONENT_READ_GRID) as PostflopSize;
  }
  return nearestStreetSize(fraction, OPPONENT_READ_GRID) as PostflopSize;
}

/**
 * Numeric pot-fraction a grid size represents; `'all-in'` reports the top grid
 * point (`1.5`) as a stand-in, since its real fraction is stack-dependent.
 */
export function gridFraction(size: PostflopSize): number {
  return size === 'all-in' ? POSTFLOP_SIZE_GRID[POSTFLOP_SIZE_GRID.length - 1]! : size;
}
