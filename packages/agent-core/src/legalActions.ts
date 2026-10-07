import type { PlayerAction } from '@4am/shared';
import type { DecisionLegalActions } from './decisionView.js';

/**
 * Legal-action layer (phase 1 of the "A plan" strategy refactor).
 *
 * One home for the defensive normalisation and legality checks that used to be
 * re-implemented in `postflopPolicy.ts`, `stylePolicy.ts` and `rulePolicy.ts`.
 * Pure: no view, no RNG, no params.
 */

/**
 * Defensive normalisation of supplied legal actions, so a malformed view (e.g.
 * `canCall` with `callAmount: 0`, or an inverted raise range) can never make a
 * policy return an action the real table would reject. The governing rule is
 * the shared `legalActions()`: nothing to call means checking is free.
 */
export function normalizeLegalActions(la: DecisionLegalActions): DecisionLegalActions {
  const canCall = la.canCall && la.callAmount > 0;
  const canCheck = la.canCheck || !canCall;
  const canRaise =
    (la.canBet || la.canRaise) &&
    la.minRaiseTo >= 1 &&
    la.maxRaiseTo >= la.minRaiseTo &&
    la.maxRaiseTo > 0;
  return { ...la, canCheck, canCall, canRaise, canBet: canRaise && la.canBet };
}

/** Is `action` legal against the already-normalised legal actions? */
export function isLegalAction(action: PlayerAction, la: DecisionLegalActions): boolean {
  switch (action.type) {
    case 'check':
      return la.canCheck;
    case 'call':
      return la.canCall;
    case 'bet':
      return (
        la.canBet &&
        typeof action.amount === 'number' &&
        action.amount >= la.minRaiseTo &&
        action.amount <= la.maxRaiseTo
      );
    case 'raise':
      return (
        la.canRaise &&
        typeof action.amount === 'number' &&
        action.amount >= la.minRaiseTo &&
        action.amount <= la.maxRaiseTo
      );
    case 'fold':
      return true;
  }
}
