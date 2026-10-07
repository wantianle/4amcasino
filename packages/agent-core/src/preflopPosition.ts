import type { DecisionView } from './decisionView.js';
import { postflopActionOrder } from './tableContext.js';

/**
 * Preflop relative-position helpers used by the preflop raise sizing standard
 * (3-bet / 4-bet multipliers by in/out of position).
 *
 * Moved verbatim out of `postflopPolicy.ts` (phase 6 housekeeping): these read
 * the **preflop** history and only decide a preflop sizing, so they belong to
 * the preflop layer, not the postflop engine. Re-exported from
 * `postflopPolicy.ts` so existing importers (the policy, frozen fixtures) keep
 * their import path.
 */

/**
 * Seat of the aggressor hero is responding to: the **last** preflop bet/raise in
 * the observed history, or `null` when none is visible. For an opening decision
 * that is the opener; for a 4-bet it is the 3-bettor — i.e. the reference
 * opponent for preflop IP/OOP sizing.
 */
export function lastPreflopRaiserSeat(view: DecisionView): number | null {
  const pre = view.actionHistory.filter((a) => a.street === 'preflop');
  for (let i = pre.length - 1; i >= 0; i--) {
    const a = pre[i]!;
    if (a.action.type === 'bet' || a.action.type === 'raise') return a.seat;
  }
  return null;
}

/**
 * True when hero acts **after** the given opponent in **postflop** order, i.e.
 * hero is in position relative to that opponent. This is the position that
 * matters for the preflop 3-bet / 4-bet sizing standard (smaller in position,
 * larger out of position, to compensate for playing later streets OOP). Unlike
 * {@link heroInPosition} (which asks whether hero is last to act among *all*
 * active players), this compares hero to one specific opponent, so a third
 * active player behind hero does not flip the answer, and an all-in third party
 * is irrelevant.
 *
 * Uses {@link postflopActionOrder}, **not** the preflop dealing order: heads-up
 * they are opposites (button/SB first preflop, last postflop), so reusing the
 * dealing-order index would mark the BB as in position. Unknown hero /
 * opponent, or an opponent not present in the order, falls back to `false`
 * (treated as out of position, the larger sizing) rather than guessing — a
 * conservative, risk-averse default, not a claim that hero *is* OOP.
 */
export function heroIsIPToOpener(view: DecisionView, opponentSeat: number | null): boolean {
  const mySeat = view.hand?.mySeat ?? view.me?.seat ?? null;
  if (mySeat === null || opponentSeat === null || opponentSeat === mySeat) return false;
  const order = postflopActionOrder(view);
  const myIdx = order.indexOf(mySeat);
  const oppIdx = order.indexOf(opponentSeat);
  if (myIdx < 0 || oppIdx < 0) return false;
  return myIdx > oppIdx;
}
