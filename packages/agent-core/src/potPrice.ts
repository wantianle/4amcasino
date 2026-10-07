import type { DecisionPotOdds } from './decisionView.js';
import { clamp01 } from './postflopMath.js';

/**
 * Pot-price layer (phase 1 of the "A plan" strategy refactor).
 *
 * The price arithmetic the postflop engine compares equity against: minimum
 * defence frequency, the equilibrium bluff:value ratio, the MDF defence ramp,
 * and the validated facing-bet price snapshot. Pure: numbers in, numbers out.
 */

/** Minimum defence frequency `P/(P+B)`, in [0, 1]. */
export function mdf(potBeforeBet: number, bet: number): number {
  if (!Number.isFinite(bet) || bet <= 0) return 1;
  const p = Math.max(0, Number.isFinite(potBeforeBet) ? potBeforeBet : 0);
  return p / (p + bet);
}

/** Equilibrium bluffs per value hand for a bet of `fraction` pot: `f/(1+f)`. */
export function bluffToValueRatio(fraction: number): number {
  const f = Math.max(0, Number.isFinite(fraction) ? fraction : 0);
  return f / (1 + f);
}

/**
 * Approximate MDF defence probability for a bet requiring `requiredMdf`.
 *
 * A linear ramp of half-width `band` centred on `1 - requiredMdf`. The band is
 * clamped to the distance to either edge (`min(band, threshold, 1-threshold)`),
 * so integrating over a uniform percentile yields exactly `requiredMdf` even at
 * the boundaries (`requiredMdf = 0` defends nothing, `= 1` defends everything)
 * while remaining a seeded mix rather than a hard cutoff. This models *our*
 * range under a uniform unknown-combo prior, not the opponent's actual betting
 * range — it is an approximation, not an equilibrium solution.
 */
export function defendProbability(percentile: number, requiredMdf: number, band = 0.06): number {
  const required = clamp01(requiredMdf);
  const threshold = 1 - required;
  const effectiveBand = Math.min(band, threshold, 1 - threshold);
  if (effectiveBand <= 0) return percentile >= threshold ? 1 : 0;
  return clamp01((percentile - (threshold - effectiveBand)) / (2 * effectiveBand));
}

const PRICE_EPSILON = 1e-6;

export interface FacingBetPrice {
  /** True only when the snapshot is internally consistent and matches the legal call. */
  trusted: boolean;
  /** Pot before the bet (`pot - call`), or 0 when the pot is unusable. */
  potBefore: number;
  /** Authoritative `call / (pot + call)` recomputed from pot/call (0 when unusable). */
  derivedOdds: number;
  /** Price compared against equity: the mirrored odds when trusted, else derived. */
  requiredEquity: number;
  /** MDF `P/(P+B)` for the real price; a neutral 0.5 when the pot is unusable. */
  requiredMdf: number;
}

/**
 * Validate a facing-bet price snapshot against the legal call amount and the
 * authoritative `call / (pot + call)`, returning everything the decision needs.
 *
 * `trusted` requires ALL of:
 *  - a finite legal `call >= 0`;
 *  - `potOdds.pot` finite, `>= 0`, and `>= call` (a pot smaller than the call is
 *    malformed; it is NOT silently corrected with `max(0, pot - call)`);
 *  - `potOdds.callAmount` finite, `>= 0`, and exactly the legal call amount;
 *  - `potOdds.potOdds` finite in `[0, 1]` and within `1e-6` of the derived odds;
 *  - `potOdds.breakEvenEquity` finite in `[0, 1]` and within `1e-6` of the
 *    derived odds (the `DecisionPotOdds` contract makes it equal to `potOdds`).
 *
 * Any violation marks the snapshot untrusted; the caller then takes a
 * conservative neutral path rather than trusting (or clamping) the bad price.
 */
export function resolveFacingBetPrice(
  potOdds: DecisionPotOdds | null | undefined,
  legalCallAmount: number,
): FacingBetPrice {
  const call = legalCallAmount;
  const callValid = Number.isFinite(call) && call >= 0;
  const potValue = potOdds?.pot;
  const mirrorCall = potOdds?.callAmount;
  const potUsable =
    callValid &&
    typeof potValue === 'number' &&
    Number.isFinite(potValue) &&
    potValue >= 0 &&
    potValue >= call;
  const mirrorCallValid =
    typeof mirrorCall === 'number' &&
    Number.isFinite(mirrorCall) &&
    mirrorCall >= 0 &&
    mirrorCall === call;
  const potBefore = potUsable ? (potValue as number) - call : 0;
  const denominator = potBefore + 2 * call;
  const derivedOdds = potUsable && denominator > 0 ? call / denominator : 0;
  const oddsField = potOdds?.potOdds;
  const breakEvenField = potOdds?.breakEvenEquity;
  const oddsValid =
    typeof oddsField === 'number' &&
    Number.isFinite(oddsField) &&
    oddsField >= 0 &&
    oddsField <= 1 &&
    Math.abs(oddsField - derivedOdds) <= PRICE_EPSILON;
  const breakEvenValid =
    typeof breakEvenField === 'number' &&
    Number.isFinite(breakEvenField) &&
    breakEvenField >= 0 &&
    breakEvenField <= 1 &&
    Math.abs(breakEvenField - derivedOdds) <= PRICE_EPSILON &&
    // `DecisionPotOdds` contract: breakEvenEquity === potOdds (exact).
    typeof oddsField === 'number' &&
    breakEvenField === oddsField;
  const trusted = potUsable && mirrorCallValid && oddsValid && breakEvenValid;
  return {
    trusted,
    potBefore,
    derivedOdds,
    requiredEquity: trusted ? (oddsField as number) : derivedOdds,
    requiredMdf: potUsable ? mdf(potBefore, call) : 0.5,
  };
}
