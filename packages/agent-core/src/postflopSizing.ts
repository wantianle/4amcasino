import type { RuleParams } from './ruleStyles.js';
import type { BoardTexture } from './postflopTexture.js';
import { clamp, clamp01 } from './postflopMath.js';
import { bluffToValueRatio } from './potPrice.js';
import {
  DEFAULT_SIZE_STREET,
  POSTFLOP_SIZE_GRIDS,
  nearestStreetSize,
  streetSupportsOverbet,
  type PostflopStreet,
} from './betSizing.js';

/**
 * Postflop sizing layer: the value/bluff/blocker probabilities and the bet-size
 * chooser, plus the heuristic range/nut-advantage score they all feed on.
 *
 * Moved verbatim out of `postflopPolicy.ts` (phase 6 housekeeping). The sizing
 * and `rangeAdvantage` are kept together on purpose: `chooseBetFraction` reads
 * `ctx.rangeAdvantage` while `valueBetProbability` / `bluffBetProbability` take
 * the same score as their `advantage` argument, so splitting them apart would
 * create a false boundary. Everything here is re-exported from
 * `postflopPolicy.ts`, so the historical public surface is unchanged.
 */

// ---------------------------------------------------------------------------
// value-bet / bluff / blocker probabilities (sizing)
// ---------------------------------------------------------------------------

/** Probability a value hand fires, from the style's value-bet scale. */
export function valueBetProbability(params: RuleParams, advantage: number): number {
  return clamp01(0.55 + 0.4 * params.valueBetScale + 0.15 * advantage);
}

/** Blocker multiplier in [0.2, 2.2], centred near 1 for a neutral blocker. */
export function blockerFactor(blocker: number): number {
  return clamp(0.4 + 1.6 * clamp01(blocker), 0.2, 2.2);
}

/**
 * Heuristic bluff bet probability for a bet of `fraction` pot: approximates the
 * MDF-consistent bluff:value ratio `f/(1+f)` times the value-bet probability,
 * scaled by style bluff, blocker, multiway and (bounded) exploit multipliers.
 * Not an equilibrium computation.
 */
export function bluffBetProbability(
  params: RuleParams,
  fraction: number,
  advantage: number,
  blocker: number,
  multiwayMultiplier = 1,
  exploit = 1,
): number {
  return clamp01(
    bluffToValueRatio(fraction) *
      valueBetProbability(params, advantage) *
      params.bluffScale *
      blockerFactor(blocker) *
      multiwayMultiplier *
      exploit,
  );
}

export interface SizingContext {
  spr: number;
  inPosition: boolean;
  rangeAdvantage: number;
  /** Seeded roll used only for the overbet gate. */
  overbetRoll?: number;
  maxOverbetFrequency?: number;
}

/**
 * Pick the bot's own bet size from the **street's** grid.
 *
 *  - wet boards: 75% (50% at low SPR, to avoid bloating with marginal equity);
 *  - dry ace-high / range-advantage boards: 33% range bet;
 *  - dry disadvantaged spots: 50%;
 *  - overbet only on dry, high-SPR, clear-advantage boards and within the
 *    style's `maxOverbetFrequency` — mapped to the top of the street's grid
 *    (150% on turn/river).
 *
 * The flop standard has **no overbet tier**, so `maxOverbetFrequency` is
 * ignored on `street === 'flop'` (see {@link streetSupportsOverbet}); the flop
 * top legal size is 75%.
 *
 * The heuristic picks a raw fraction and snaps it to the nearest point the
 * street actually allows (e.g. a 0.5-pot pick on the flop becomes 0.33), so the
 * returned value is always a legal size for `street`. Turn and river differ by
 * design: turn has no 33% tier.
 */
export function chooseBetFraction(
  texture: BoardTexture,
  ctx: SizingContext,
  street: PostflopStreet = DEFAULT_SIZE_STREET,
): number {
  const grid = POSTFLOP_SIZE_GRIDS[street];
  const overbetFreq = ctx.maxOverbetFrequency ?? 0;
  if (
    streetSupportsOverbet(street) &&
    !texture.wet &&
    ctx.rangeAdvantage >= 0.4 &&
    ctx.spr >= 4 &&
    overbetFreq > 0 &&
    (ctx.overbetRoll ?? 1) < overbetFreq
  ) {
    return grid[grid.length - 1]!;
  }
  let raw: number;
  if (texture.wet) raw = ctx.spr < 2.5 ? 0.5 : 0.75;
  else if (ctx.rangeAdvantage >= 0.3) raw = 0.33;
  else if (ctx.rangeAdvantage <= -0.3) raw = 0.5;
  else raw = texture.aceHigh ? 0.33 : 0.5;
  return nearestStreetSize(raw, grid);
}

/** Heuristic range/nut-advantage score in [-1, 1] (positive = hero favours). */
export function rangeAdvantage(input: {
  heroWasAggressor: boolean;
  inPosition: boolean;
  texture: BoardTexture;
}): number {
  let a = 0;
  if (input.heroWasAggressor) a += 0.4;
  if (input.inPosition) a += 0.2;
  if (input.texture.aceHigh) a += 0.25;
  if (input.texture.lowConnected) a -= 0.3;
  if (!input.heroWasAggressor && !input.inPosition) a -= 0.2;
  return clamp(a, -1, 1);
}
