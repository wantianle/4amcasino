/**
 * Headcount helpers for the adaptive preflop model.
 *
 * The whole model keys off `behindUnacted`: how many players still to act after
 * the hero have not completed their preflop action yet. That number, not the
 * position name, determines how wide the hero can profitably open.
 *
 * Preflop action order is dealing order, except the blinds act last:
 *   multiway: [seatOrder[2..], seatOrder[0] (SB), seatOrder[1] (BB)]
 *   heads-up: [seatOrder[0] (SB = button), seatOrder[1] (BB)]
 * The heads-up exception is intentional: the button posts the small blind and
 * acts first preflop.
 */

/** Highest canonical behind-unacted slot (B8). */
export const MAX_SLOT = 8;

/** Clamp a behind-unacted count into the canonical slot range B0..B8. */
export function canonicalSlot(behindUnacted: number): number {
  if (!Number.isFinite(behindUnacted)) return 0;
  return Math.min(MAX_SLOT, Math.max(0, Math.trunc(behindUnacted)));
}

/**
 * Seats in preflop action order. `seatOrder` is the dealing order (index 0 =
 * small blind), so the blinds are rotated to the back except heads-up.
 */
export function preflopActionOrder(seatOrder: readonly number[]): number[] {
  if (seatOrder.length <= 2) return [...seatOrder];
  return [...seatOrder.slice(2), seatOrder[0]!, seatOrder[1]!];
}

export interface HeadcountInput {
  /** Preflop action order (see `preflopActionOrder`). */
  order: readonly number[];
  heroSeat: number;
  /** Seats still able to act: not folded, not all-in, not sitting out. */
  activeSeats: ReadonlySet<number>;
  /** Seats that have already completed a preflop action (including a fold). */
  actedSeats: ReadonlySet<number>;
}

/**
 * Count active players after the hero who have not yet acted. Returns 0 when the
 * hero is absent from the order (the caller treats a non-positive/undefined
 * hero as the last actor).
 */
export function computeBehindUnacted(input: HeadcountInput): number {
  const idx = input.order.indexOf(input.heroSeat);
  if (idx < 0) return 0;
  let behind = 0;
  for (let i = idx + 1; i < input.order.length; i++) {
    const seat = input.order[i]!;
    if (input.activeSeats.has(seat) && !input.actedSeats.has(seat)) behind++;
  }
  return behind;
}

/**
 * The distinct actor slots for a full n-handed table where nobody has acted yet:
 * the first actor has `n-1` players behind, the big blind `0`. Always exactly
 * `n` values and always contains B0 and B1.
 */
export function slotsForDealtCount(dealtCount: number): number[] {
  const n = Math.trunc(dealtCount);
  if (n < 2) return [];
  return preflopActionOrder(Array.from({ length: n }, (_, i) => i)).map((_, i) => n - 1 - i);
}
