import type { DecisionView } from './decisionView.js';
import type { RuleParams } from './ruleStyles.js';
import { handClassForCards, mixFor, type ActionMix, type HandClassInfo } from './rangeParser.js';
import {
  derivePreflopContext,
  type PreflopContext,
  type PreflopIntent,
} from './preflopContext.js';
import { buildMix } from './preflopRange.js';
import { effectiveFrequencies } from './preflopFrequency.js';

/**
 * Rules-v1 preflop policy: turn a `DecisionView` into a preflop decision. The
 * work is split across layers — `preflopContext` (spot / headcount),
 * `preflopRange` (compiled range construction) and `preflopFrequency`
 * (style/stack-scaled frequencies) — and this module only orchestrates them.
 *
 * Two invariants the gate review demanded and this module still enforces:
 *   1. A **value** raise is a continuation: style/context discounts may move
 *      probability from raise to call, but never to fold.
 *   2. Missing history is never read as "nobody acted": a public `currentBet`
 *      above the big blind forces a conservative facing-a-raise branch.
 *
 * Every name that used to live in this module is re-exported below, so existing
 * importers (frozen fixtures, other lanes) keep working unchanged.
 */

// Re-exported so existing importers (e.g. the frozen baseline fixtures) keep
// working after the helpers moved to `tableContext.ts`.
export { postflopActionOrder, seatsInDealingOrder } from './tableContext.js';

// Re-exported from the preflop layers so the historical public surface of
// `preflopPolicy.js` is unchanged.
export {
  derivePreflopContext,
  type PreflopContext,
  type PreflopIntent,
  type PreflopSituation,
  type PreflopSpot,
} from './preflopContext.js';
export {
  adaptivePreflopAvailable,
  mergeRustVsOpenRaise,
  preflopMixCacheKey,
} from './preflopRange.js';

export interface PreflopChoice {
  intent: PreflopIntent;
  context: PreflopContext;
  handClass: HandClassInfo;
  /** Effective raise/call frequencies used, for tests and telemetry. */
  frequencies: ActionMix;
}

/**
 * Pick the preflop intent for the bot's hand. Never throws for a valid view;
 * the adapter still re-checks legality before returning an action.
 */
export function choosePreflopIntent(
  view: DecisionView,
  params: RuleParams,
  rand: () => number,
): PreflopChoice {
  const ctx = derivePreflopContext(view);
  const cards = view.hand?.myCards ?? [];
  const handClass = handClassForCards(cards[0] ?? 0, cards[1] ?? 1);
  const mix = mixFor(buildMix(ctx, params), handClass.key);
  const freqs = effectiveFrequencies(mix, handClass.key, ctx, params);

  const roll = rand();
  let intent: PreflopIntent;
  if (roll < freqs.raise) intent = 'raise';
  else if (roll < freqs.raise + freqs.call) intent = 'call';
  else intent = 'fold';

  return { intent, context: ctx, handClass, frequencies: freqs };
}
