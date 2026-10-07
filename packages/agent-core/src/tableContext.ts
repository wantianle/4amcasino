import type { Street } from '@4am/shared';
import type { DecisionView } from './decisionView.js';
import type { Position } from './preflopRanges.js';

/**
 * Table-context layer (phase 1 of the "A plan" strategy refactor).
 *
 * A single, pure construction point for everything a policy derives from the
 * public table state in a `DecisionView`: dealing order, postflop action order,
 * positions, street, headcount, pot / stacks and SPR, plus the positional /
 * aggression reads that used to live in `postflopPolicy.ts`.
 *
 * Pure and stateless: no caches, no RNG, no policy parameters. Moving these
 * helpers here removes the `postflopPolicy -> preflopPolicy` reverse dependency
 * (`postflopPolicy` used to borrow `seatsInDealingOrder` / `postflopActionOrder`
 * from `preflopPolicy`); both now depend on this neutral module instead.
 * `heroInPosition` uses `postflopActionOrder` (not the preflop dealing order) so
 * heads-up IP/OOP stays correct.
 */

export const POSITIONS_BY_COUNT: Record<number, Position[]> = {
  2: ['SB', 'BB'],
  3: ['SB', 'BB', 'BTN'],
  4: ['SB', 'BB', 'CO', 'BTN'],
  5: ['SB', 'BB', 'UTG', 'CO', 'BTN'],
  6: ['SB', 'BB', 'UTG', 'HJ', 'CO', 'BTN'],
  7: ['SB', 'BB', 'UTG', 'UTG1', 'HJ', 'CO', 'BTN'],
  8: ['SB', 'BB', 'UTG', 'UTG1', 'MP', 'HJ', 'CO', 'BTN'],
  9: ['SB', 'BB', 'UTG', 'UTG1', 'MP', 'LJ', 'HJ', 'CO', 'BTN'],
};

/**
 * Approximate the dealing order when the view does not carry `seatOrder`:
 * sort the known seats ascending and rotate so the first seat after the button
 * comes first. Heads-up is special-cased: the button **is** the small blind and
 * acts first preflop, so the order is `[button, other]`, not `[other, button]`.
 * TODO(rules-v2): drop this once every caller populates `DecisionView.seatOrder`.
 */
function fallbackSeatOrder(view: DecisionView): number[] {
  const seats: number[] = [];
  if (view.me) seats.push(view.me.seat);
  for (const o of view.opponents) seats.push(o.seat);
  seats.sort((a, b) => a - b);
  const button = view.hand?.buttonSeat;
  if (button === undefined) return seats;
  const btnIdx = seats.indexOf(button);
  if (btnIdx < 0) return seats;
  if (seats.length === 2) {
    const other = seats[1 - btnIdx]!;
    return [seats[btnIdx]!, other];
  }
  return [...seats.slice(btnIdx + 1), ...seats.slice(0, btnIdx + 1)];
}

/** Current-street seat order (index 0 = small blind), from the view or inferred. */
export function seatsInDealingOrder(view: DecisionView): number[] {
  const supplied = view.seatOrder;
  if (supplied && supplied.length >= 2) return [...supplied];
  return fallbackSeatOrder(view);
}

/**
 * Seats in **postflop** action order (first to act first, button last).
 *
 * The dealing order and the postflop order coincide for 3+ players (SB first,
 * button last), but **heads-up they are opposites**: preflop the button/SB acts
 * first and the BB last, so `seatsInDealingOrder` returns the *preflop* order
 * `[button/SB, BB]`; postflop the BB acts first and the button/SB last. Never
 * reuse the dealing-order index as a postflop position for heads-up — that
 * silently reverses IP/OOP and mis-sizes the preflop 3-bet/4-bet.
 *
 * Uses `buttonSeat` to place the button last when it is known, and falls back
 * to reversing the two-seat order otherwise: when `buttonSeat` is unknown we
 * rely on the contract that a supplied / short-handed two-seat dealing order is
 * `[SB, BB]`, so reversing it yields the postflop `[BB, SB]`.
 *
 * LIMITATION: `fallbackSeatOrder()` with no supplied order *and* no button
 * returns the seats in ascending order rather than a dealing order, so
 * reversing that ascending pair cannot actually determine position — it is a
 * best-effort assumption, not a determination. Such a view must not be trusted
 * for heads-up IP/OOP until every caller populates `buttonSeat`/`seatOrder`.
 */
export function postflopActionOrder(view: DecisionView): number[] {
  const order = seatsInDealingOrder(view);
  if (order.length !== 2) return order;
  return view.hand?.buttonSeat === order[1] ? order : [order[1]!, order[0]!];
}

/** Position name for `seat` in dealing order, approximating an unknown table size. */
export function positionForSeat(seat: number, seatOrder: number[]): Position {
  const table = POSITIONS_BY_COUNT[seatOrder.length];
  const idx = seatOrder.indexOf(seat);
  if (table && idx >= 0 && idx < table.length) return table[idx]!;
  // Fallback for an unknown table size: approximate by dealing slot.
  return idx === 0 ? 'SB' : idx === 1 ? 'BB' : 'BTN';
}

/** True when hero made the last preflop aggressive action. */
export function heroWasAggressor(view: DecisionView): boolean {
  const mySeat = view.hand?.mySeat ?? view.me?.seat ?? null;
  if (mySeat === null) return false;
  const pre = view.actionHistory.filter((a) => a.street === 'preflop');
  for (let i = pre.length - 1; i >= 0; i--) {
    const a = pre[i]!;
    if (a.action.type === 'bet' || a.action.type === 'raise') return a.seat === mySeat;
  }
  return false;
}

/** True when hero is the last active seat to act postflop (i.e. on the button). */
export function heroInPosition(view: DecisionView): boolean {
  const mySeat = view.hand?.mySeat ?? view.me?.seat ?? null;
  if (mySeat === null) return false;
  const order = postflopActionOrder(view);
  if (order.length === 0) return false;
  const active = order.filter(
    (seat) => seat === mySeat || view.opponents.some((o) => o.seat === seat && !o.folded),
  );
  return active.length > 0 && active[active.length - 1] === mySeat;
}

/**
 * Everything a policy reads off the table for the current decision.
 *
 * `myStack` / `effectiveStack` fall back to `0` (not `bb`) for the hero stack,
 * matching the postflop engine's SPR convention; preflop keeps its own
 * `bb`-based fallback in `derivePreflopContext` until phase 2 splits it out.
 */
export interface TableContext {
  /** Current street, or null when there is no live hand. */
  street: Street | null;
  /** Hero's absolute seat, or null when unknown. */
  mySeat: number | null;
  /** Current-street seats in dealing order (index 0 = small blind). */
  seatOrder: number[];
  /** Number of seats dealt in (dealing-order length). */
  dealtCount: number;
  /** True for a two-handed hand. */
  headsUp: boolean;
  /** Position name of the hero, or null when the seat is unknown. */
  position: Position | null;
  /** Opponents still in the hand, floored at 1 (the pot is always contested). */
  activeOpponentCount: number;
  /** Total chips already in the pot. */
  pot: number;
  /** Big blind in chips, floored at 1 when unset (so ratios stay finite). */
  bb: number;
  /** Hero's own remaining stack, or 0 when unknown. */
  myStack: number;
  /**
   * Effective stack: `min(hero stack, largest live opponent stack)`, or the
   * hero's own stack when no live opponent caps it.
   */
  effectiveStack: number;
  /** Effective stack in big blinds. */
  effectiveStackBB: number;
  /** Effective stack / pot, or 10 when the pot is unusable. */
  spr: number;
  /** True when hero is the last active seat to act postflop. */
  inPosition: boolean;
  /** True when hero made the last preflop aggressive action. */
  wasAggressor: boolean;
}

/** Derive the pure table context for `view` (single construction point). */
export function deriveTableContext(view: DecisionView): TableContext {
  const seatOrder = seatsInDealingOrder(view);
  const mySeat = view.hand?.mySeat ?? view.me?.seat ?? null;
  const activeOpponentCount = Math.max(1, view.opponents.filter((o) => !o.folded).length);
  const pot = view.potOdds?.pot ?? 0;
  const bb = view.room?.bb && view.room.bb > 0 ? view.room.bb : 1;
  const myStack = view.me?.stack ?? 0;
  const activeStacks = view.opponents
    .filter((o) => !o.folded && !o.allIn)
    .map((o) => o.stack);
  const oppMax = activeStacks.length ? Math.max(...activeStacks) : 0;
  const effectiveStack = oppMax > 0 ? Math.min(myStack, oppMax) : myStack;
  return {
    street: view.hand?.street ?? null,
    mySeat,
    seatOrder,
    dealtCount: seatOrder.length,
    headsUp: seatOrder.length === 2,
    position: mySeat === null ? null : positionForSeat(mySeat, seatOrder),
    activeOpponentCount,
    pot,
    bb,
    myStack,
    effectiveStack,
    effectiveStackBB: effectiveStack / bb,
    spr: pot <= 0 ? 10 : effectiveStack / pot,
    inPosition: heroInPosition(view),
    wasAggressor: heroWasAggressor(view),
  };
}
