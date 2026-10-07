import type { PlayerAction } from '@4am/shared';
import type { DecisionLegalActions } from './decisionView.js';

/**
 * Action-adapter layer (phase 1 of the "A plan" strategy refactor).
 *
 * The strategy output (a chosen intent / frequency) still lives in each policy;
 * this module owns the last generic step: turning that choice into a concrete,
 * legal `PlayerAction`. It centralises the guaranteed-legal fallback and the
 * pot-fraction raise/bet sizing formulas duplicated between `postflopPolicy.ts`
 * and `stylePolicy.ts`.
 *
 * The per-style branch structure (when to bet vs raise vs fold) stays with the
 * policy that owns it — only the mechanical conversion lives here.
 */

/** The guaranteed-legal action: check if free, else call, else fold. */
export function guaranteedLegalAction(la: DecisionLegalActions): PlayerAction {
  if (la.canCheck) return { type: 'check' };
  if (la.canCall) return { type: 'call' };
  return { type: 'fold' };
}

/** Finite clamp identical to the postflop engine's local `clamp`. */
function clampFinite(x: number, lo: number, hi: number): number {
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo;
}

export interface RaiseToInput {
  /** Total chips already in the pot, as the caller reads them. */
  pot: number;
  /** The bet hero must raise over. */
  currentBet: number;
  /** Pot fraction to size to. */
  fraction: number;
  minRaiseTo: number;
  maxRaiseTo: number;
}

/**
 * A legal raise-to target: `currentBet + max(minDelta, round(pot * fraction))`,
 * clamped to `[minRaiseTo, maxRaiseTo]`. `minDelta` uses the raise-to delta so
 * `currentBet` is never double-counted.
 *
 * Non-finite input (`NaN` / `±Infinity` in any of `pot`, `currentBet`,
 * `fraction`) makes `raw` non-finite; `clampFinite` then yields `minRaiseTo`,
 * matching the pre-move `postflopPolicy` `clamp(target, min, max)` exactly.
 * (`stylePolicy`'s old inline `Math.max(min, Math.min(max, raw))` did NOT guard
 * this and could return `NaN`/`maxRaiseTo`; the extraction deliberately adopts
 * the postflop behaviour, which is the only one that always yields a legal
 * value.)
 */
export function raiseToAmount(input: RaiseToInput): number {
  const { pot, currentBet, fraction, minRaiseTo, maxRaiseTo } = input;
  const minDelta = Math.max(1, minRaiseTo - currentBet);
  const raw = currentBet + Math.max(minDelta, Math.round(pot * fraction));
  return clampFinite(raw, minRaiseTo, maxRaiseTo);
}

export interface BetAmountInput {
  /** Total chips already in the pot, as the caller reads them. */
  pot: number;
  /** Pot fraction to size to. */
  fraction: number;
  minRaiseTo: number;
  maxRaiseTo: number;
}

/** A legal unopened bet: `round(pot * fraction)` clamped, floored at 1 chip. */
export function betAmount(input: BetAmountInput): number {
  const { pot, fraction, minRaiseTo, maxRaiseTo } = input;
  const raw = Math.round(pot * fraction);
  return Math.max(1, clampFinite(raw, minRaiseTo, maxRaiseTo));
}
