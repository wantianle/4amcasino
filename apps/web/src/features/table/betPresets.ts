import { ALL_IN_RATIO } from '../../shared/store.ts';

/** The pot-fraction quick-bet sizing math, pulled out of the betting panel so
 *  the rounding and clamping rules are directly testable. */

export interface PresetRaiseInput {
  /** Configured slot: a pot fraction, or the ALL_IN_RATIO sentinel. */
  frac: number;
  /** Pot before our call, summed across every seat's committed total. */
  pot: number;
  /** Chips needed to call, from `legalActions`. */
  callAmount: number;
  /** The current street's leading wager (legalActions does not carry it). */
  currentBet: number;
  /** Small blind, the snapping grid. */
  sb: number;
  /** Legal raise-to window from `legalActions`. */
  minRaiseTo: number;
  maxRaiseTo: number;
}

/** Raise-to for a pot fraction (the pot counted after our call), snapped to
 *  the small blind and clamped into the legal [min, max] window. The all-in
 *  sentinel shoves the whole stack; a super-pot fraction like 150% is capped
 *  at `maxRaiseTo` when the stack cannot cover it. */
export function presetRaiseTo(i: PresetRaiseInput): number {
  if (i.frac === ALL_IN_RATIO) return i.maxRaiseTo;
  const target = i.currentBet + Math.round((i.pot + i.callAmount) * i.frac);
  const snapped = Math.round(target / i.sb) * i.sb;
  return Math.min(Math.max(snapped, i.minRaiseTo), i.maxRaiseTo);
}

/** The preset's percentage label, or null for the all-in slot (the caller
 *  shows its translated "All-in" copy). It shows the CONFIGURED ratio, not the
 *  amount rounded back to a real fraction: blind snapping and the stack cap
 *  would otherwise turn a chosen 150% into 160% on a big pot or a much smaller
 *  number on a short stack, so the button would stop matching the setting. The
 *  actual amount stays visible on the amount field and the raise button. */
export function presetLabel(frac: number): string | null {
  if (frac === ALL_IN_RATIO) return null;
  return `${Math.round(frac * 100)}%`;
}
