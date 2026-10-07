/**
 * Shared chip-denomination model for the felt (docs/table-redesign-spec.md P1
 * A5 + user feedback on chip visuals). Pure math + palette data only - no JSX -
 * so the felt widgets render the SAME denominations and colors:
 *
 *   white = 1 SB · red = 5 SB · green = 25 SB · blue = 100 SB · purple = 500 SB
 *
 * The unit is the SMALL BLIND. Rooms whose structure deviates from the usual
 * sb = bb/2 should pass their real sb; `sbFromBb` encodes the standard.
 */

export type ChipColor = 'white' | 'red' | 'green' | 'blue' | 'purple';

/** A denomination: a color plus its value in small blinds. High to low. */
export interface ChipTier {
  color: ChipColor;
  /** Multiple of the small blind this chip is worth. */
  sb: number;
}

export const CHIP_TIERS: readonly ChipTier[] = [
  { color: 'purple', sb: 500 },
  { color: 'blue', sb: 100 },
  { color: 'green', sb: 25 },
  { color: 'red', sb: 5 },
  { color: 'white', sb: 1 },
] as const;

/** Standard structure assumption: the small blind is half the big blind. */
export function sbFromBb(bb: number): number {
  return Math.max(1, Math.round(Math.max(1, bb) / 2));
}

/** Bet-input rule (user 2026-10-07): a bet/raise amount is rounded UP to the
 *  next whole multiple of the small blind — the table's smallest wager unit.
 *  sb 10 + an input of 123 → 130. Callers still clamp into the legal
 *  [minRaiseTo, maxRaiseTo] window afterwards, which is what keeps an all-in
 *  exact: the shove is `maxRaiseTo` (e.g. 123), the ceil would be 130, and the
 *  max clamp brings it back to 123. Never rounds down. */
export function roundUpToSb(chips: number, sb: number): number {
  const unit = Math.max(1, Math.round(sb));
  return Math.ceil(Math.max(0, chips) / unit) * unit;
}

/**
 * Greedy break-down of `amount` into chip stacks, largest denomination first.
 * The leftover below one small blind is folded into white chips (never shows
 * an empty stack for a positive amount), so the piles always account for the
 * full value.
 */
export function chipBreakdown(
  amount: number,
  sbUnit = 1,
): Array<{ color: ChipColor; count: number }> {
  const unit = Math.max(1, sbUnit);
  let rest = Math.max(0, Math.floor(amount));
  if (rest === 0) return [];
  const out: Array<{ color: ChipColor; count: number }> = [];
  for (const tier of CHIP_TIERS) {
    const d = tier.sb * unit;
    const count = Math.floor(rest / d);
    if (count > 0) {
      out.push({ color: tier.color, count });
      rest -= count * d;
    }
  }
  // A leftover under one small blind (or an amount below a single chip) still
  // rides on one white chip - the pile never under-represents the value.
  if (rest > 0 || out.length === 0) {
    const white = out.find((c) => c.color === 'white');
    if (white) {
      white.count += 1;
    } else {
      out.push({ color: 'white', count: 1 });
    }
  }
  return out;
}

/** Physical chip palette: flat colors + the gradients each renderer builds its
 *  dimensional look from. Keep this the only place these hues are defined. */
export interface ChipPalette {
  /** body */
  base: string;
  /** top / highlight edge */
  light: string;
  /** bottom / shadow edge */
  dark: string;
  /** edge dashes + face stripes */
  edge: string;
}

export const CHIP_PALETTES: Record<ChipColor, ChipPalette> = {
  white: { base: '#f1f5f9', light: '#ffffff', dark: '#aeb8c6', edge: '#e11d48' },
  red: { base: '#dc2643', light: '#f8718d', dark: '#7f1027', edge: '#fff1f2' },
  green: { base: '#0d9f6e', light: '#4ade9d', dark: '#04513a', edge: '#ecfdf5' },
  blue: { base: '#2f6fed', light: '#74a5fb', dark: '#12357e', edge: '#eff6ff' },
  purple: { base: '#7c3aed', light: '#ab8bfa', dark: '#3e1a86', edge: '#f5f3ff' },
};
