import { SHORT_JAM_RANGES, type PositionGroup } from './preflopRanges.js';
import { parseRange, type ActionMix, type CompiledMix } from './rangeParser.js';
import type { PreflopContext } from './preflopContext.js';
import type { RuleParams } from './ruleStyles.js';
import { clamp01 } from './preflopMath.js';

/**
 * Preflop frequency layer: turn a compiled mix into the final, style- and
 * stack-scaled raise/call probabilities. Kept separate from range construction
 * so the frequency/signals work (phase 5) has a single home.
 */

/**
 * Stack-depth tightening (§2.1): the >=80BB charts are the baseline; 40–79BB
 * trims the flat-call range slightly and 20–39BB more so. Below 20BB there is no
 * flatting at all (see `shortStackMix`).
 */
function callDiscount(stackBB: number): number {
  if (stackBB < 40) return 0.5;
  if (stackBB < 80) return 0.85;
  return 1;
}

/** Premium flat-range hands that keep jamming when flatting is impossible. */
const SHOVE_HANDS = new Set(['AA', 'KK', 'QQ', 'JJ', 'TT', 'AKs', 'AKo', 'AQs']);

/** Short-stack open-jam sets, parsed once per position group. */
const shortJamCache = new Map<PositionGroup, Set<string>>();

function shortJamSet(group: PositionGroup): Set<string> {
  let set = shortJamCache.get(group);
  if (!set) {
    set = parseRange(SHORT_JAM_RANGES[group]).keys;
    shortJamCache.set(group, set);
  }
  return set;
}

/**
 * <20BB: there is no flatting.
 *
 * For an *opening* spot we consult the dedicated `SHORT_JAM_RANGES`, not the
 * deep-stack chart: `99`/`A2s`/`22` open at 100BB but are NOT auto-jams at
 * 19BB, so they fold here. The deep-stack 3-bet/4-bet value ranges, by
 * contrast, are already premium, so facing a raise a value hand jams; a premium
 * flat-range hand (e.g. QQ vs a 3-bet) also jams rather than folding.
 */
function shortStackMix(c: CompiledMix, key: string, ctx: PreflopContext): ActionMix {
  if (ctx.spot === 'unopened' || ctx.spot === 'limped') {
    return shortJamSet(ctx.positionGroup).has(key)
      ? { raise: 1, call: 0 }
      : { raise: 0, call: 0 };
  }
  if (c.valueRaise > 0) return { raise: clamp01(c.valueRaise), call: 0 };
  if (SHOVE_HANDS.has(key) && c.call > 0) return { raise: 1, call: 0 };
  return { raise: 0, call: 0 };
}

/**
 * Final, scaled probabilities. Invariants:
 *   - total `raise + call <= 1`;
 *   - value continuation is absolute (a discounted value raise becomes a call,
 *     never a fold);
 *   - `multiwayBluffScale` / the missing-history discount touch only the bluff
 *     component, never value or call;
 *   - marginal opens are `preflopScale - 1`.
 */
export function effectiveFrequencies(
  c: CompiledMix,
  key: string,
  ctx: PreflopContext,
  params: RuleParams,
): ActionMix {
  if (ctx.stackBB < 20) return shortStackMix(c, key, ctx);

  const unopenedLike = ctx.spot === 'unopened' || ctx.spot === 'limped';
  const raiseScale = unopenedLike ? params.preflopScale : params.threeBetScale;

  // `valueContinue` is the absolute continuation floor the extras budget off.
  // It must cover the *scaled* value raise, not the raw one: when
  // `raiseScale > 1` the amplified raise exceeds `c.valueRaise`, so budgeting
  // from the raw value would hand the extras (bluff/marginal/flat call) a slice
  // that does not exist and push `raise + call > 1`. The scaled raise is
  // authoritative and the extras absorb the cap; for `raiseScale <= 1` the raw
  // value is already the floor (a discounted raise becomes a call, never a
  // fold), so this is unchanged.
  const vRaise = clamp01(c.valueRaise * raiseScale);
  const valueContinue = Math.max(clamp01(c.valueRaise), vRaise);
  const valueCall = clamp01(valueContinue - vRaise); // never a fold

  let rawBluff = clamp01(
    c.bluffRaise * params.bluffScale * (unopenedLike ? 1 : params.threeBetScale),
  );
  if (ctx.spot === 'facingOpenMultiway') rawBluff = clamp01(rawBluff * params.multiwayBluffScale);
  if (!ctx.historyComplete && !unopenedLike) rawBluff = clamp01(rawBluff * 0.5);

  const marginalScale = ctx.spot === 'unopened' ? clamp01(params.preflopScale - 1) : 0;
  const rawMarginal = clamp01(c.marginalRaise * marginalScale);
  const rawCall = clamp01(c.call * params.preflopScale * callDiscount(ctx.stackBB));

  // Extras share the budget left after the absolute value continuation; scaling
  // them proportionally keeps raise + call <= 1 without starving one of them.
  const budget = clamp01(1 - valueContinue);
  const rawExtra = rawBluff + rawMarginal + rawCall;
  const k = rawExtra > 0 ? (rawExtra <= budget ? 1 : budget / rawExtra) : 0;

  return {
    raise: clamp01(vRaise + (rawBluff + rawMarginal) * k),
    call: clamp01(valueCall + rawCall * k),
  };
}
