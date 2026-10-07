import { ALL_IN_RATIO } from '../../shared/store.ts';
import { roundUpToSb } from '../../shared/lib/chips.ts';

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

/** Raise-to for a pot fraction (the pot counted after our call), snapped UP to
 *  the small blind and clamped into the legal [min, max] window. The fraction is
 *  applied to the FULL target before any rounding — a pre-`Math.round` would
 *  drop the remainder and make `ceil` unable to recover it (pot 101, 30%: the
 *  exact 30.3 must become 40, not 30). The all-in sentinel shoves the whole
 *  stack; a super-pot fraction like 150% is capped at `maxRaiseTo` when the
 *  stack cannot cover it (and that cap keeps the shove exact — a ceil to 130
 *  over a 123 all-in clamps back to 123). */
export function presetRaiseTo(i: PresetRaiseInput): number {
  if (i.frac === ALL_IN_RATIO) return i.maxRaiseTo;
  const target = i.currentBet + (i.pot + i.callAmount) * i.frac;
  const snapped = roundUpToSb(target, i.sb);
  return Math.min(Math.max(snapped, i.minRaiseTo), i.maxRaiseTo);
}

/** Round a raw bet input UP to the small blind, then clamp into the legal
 *  [min, max] window. The clamp AFTER the ceil is what keeps an all-in exact:
 *  a 123-chip shove ceils to 130 over sb 10, and the 123 max brings it back.
 *  An empty/NaN edit falls back to the minimum. */
export function snapRaiseTo(
  value: number,
  sb: number,
  minRaiseTo: number,
  maxRaiseTo: number,
): number {
  if (!Number.isFinite(value)) return minRaiseTo;
  return Math.min(Math.max(roundUpToSb(value, sb), minRaiseTo), maxRaiseTo);
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
