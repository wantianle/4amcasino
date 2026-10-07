import { HAND_CATEGORY, evaluate5, handCategory, rankOf, suitOf, type CardId } from '@4am/shared';
import type { DecisionView } from './decisionView.js';
import type { Policy, PolicyDecision } from './policy.js';

/**
 * A minimal tight-aggressive placeholder policy.
 *
 * It only consumes `DecisionView` and only returns actions that the view says
 * are legal, so it can never send an out-of-turn or out-of-range action. The
 * real strategy work is Phase 2; this exists to exercise the pipeline end to
 * end.
 */

/** Best 5-card score from 5-7 cards (0 when fewer than 5 cards are known). */
function bestScore(cards: CardId[]): number {
  if (cards.length < 5) return 0;
  if (cards.length === 5) return evaluate5(cards);
  let best = 0;
  const n = cards.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++)
          for (let e = d + 1; e < n; e++) {
            const score = evaluate5([cards[a]!, cards[b]!, cards[c]!, cards[d]!, cards[e]!]);
            if (score > best) best = score;
          }
  return best;
}

/** Coarse preflop strength: 3 = premium, 2 = strong, 1 = playable, 0 = trash. */
function preflopStrength(a: CardId, b: CardId): number {
  const ra = rankOf(a);
  const rb = rankOf(b);
  const hi = Math.max(ra, rb);
  const lo = Math.min(ra, rb);
  if (ra === rb) return hi >= 8 ? 3 : 2; // 99+ / small pair
  const suited = suitOf(a) === suitOf(b);
  if (hi >= 10 && lo >= 9) return 3; // AK/AQ/KQ
  if (hi >= 10 && suited) return 2;
  if (hi >= 10 || suited) return 1;
  return 0;
}

function strength(view: DecisionView): number {
  const cards = view.hand?.myCards ?? [];
  const board = view.hand?.board ?? [];
  if (cards.length < 2) return 0;
  if (board.length >= 3) {
    const category = handCategory(bestScore([...cards, ...board]));
    if (category >= HAND_CATEGORY.twoPair) return 3; // two pair or better
    if (category === HAND_CATEGORY.pair) return 2; // one pair
    return 0;
  }
  return preflopStrength(cards[0]!, cards[1]!);
}

export class ScriptedPolicy implements Policy {
  readonly name = 'scripted-tight-aggressive';

  decide(view: DecisionView): PolicyDecision {
    const la = view.legalActions;
    if (!la) throw new Error('scripted policy asked to act out of turn');
    const s = strength(view);

    if (s >= 3) {
      if (la.canRaise)
        return {
          action: { type: la.canBet ? 'bet' : 'raise', amount: la.minRaiseTo },
          reason: `value ${la.canBet ? 'bet' : 'raise'} with a strong hand`,
        };
      if (la.canCall)
        return { action: { type: 'call' }, reason: 'call with a strong hand' };
      return { action: { type: 'check' }, reason: 'check back a strong hand' };
    }

    if (la.canCheck) return { action: { type: 'check' }, reason: 'check a non-premium hand' };
    if (s === 2 && la.canCall && view.potOdds && view.potOdds.potOdds <= 0.4)
      return { action: { type: 'call' }, reason: 'call with a pair at acceptable odds' };
    return { action: { type: 'fold' }, reason: 'fold a weak hand facing a bet' };
  }
}
