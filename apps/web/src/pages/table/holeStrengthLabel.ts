import {
  evaluate5,
  evaluate7,
  handCategory,
  rankOf,
  HAND_CATEGORY_NAMES,
  type CardId,
} from '@4am/shared';
import { tHandCategory } from '../../shared/i18n/pokerLabels.ts';

/** Live hand strength of the two cards in hand (carried over from the old
 *  mobile table when phone and desktop merged into one layout). */
function holeStrengthLabel(myCards: CardId[], board: CardId[]): string | null {
  if (myCards.length < 2) return null;
  const all = [...myCards, ...board];
  if (all.length < 5) {
    return rankOf(myCards[0]!) === rankOf(myCards[1]!) ? 'Pair' : 'High Card';
  }
  let best = 0;
  if (all.length === 7) best = evaluate7(all);
  else if (all.length === 5) best = evaluate5(all);
  else
    for (let skip = 0; skip < all.length; skip++)
      best = Math.max(best, evaluate5(all.filter((_, i) => i !== skip)));
  const cat = HAND_CATEGORY_NAMES[handCategory(best)] ?? null;
  return cat ? tHandCategory(cat) : null;
}

export { holeStrengthLabel };
