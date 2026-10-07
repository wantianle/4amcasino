import { describe, expect, it } from 'vitest';
import { cardFromName, type CardId } from '../src/cards.js';
import { HAND_CATEGORY, HAND_CATEGORY_NAMES, evaluate7, handCategory } from '../src/evaluate.js';

/**
 * Pins the named `HAND_CATEGORY` numbers to the real evaluator output, so the
 * names cannot silently drift from the packed-score contract (bits 20-31,
 * `handCategory(score) = score >> 20`) or from `HAND_CATEGORY_NAMES`. Breaking
 * any one of these three (e.g. `twoPair: 3`) turns this file red.
 */
const h = (s: string): CardId[] => s.split(' ').map(cardFromName);

const SAMPLES: readonly [keyof typeof HAND_CATEGORY, string, string][] = [
  ['highCard', 'High Card', 'Ah Kd Qc Js 9h 7d 4c'],
  ['pair', 'Pair', 'Ah Ad Qc Js 9h 7d 4c'],
  ['twoPair', 'Two Pair', 'Ah Ad Kh Kd Qc Js 9h'],
  ['trips', 'Three of a Kind', 'Ah Ad Ac Js 9h 7d 4c'],
  ['straight', 'Straight', 'Ah Kd Qc Js Th 7d 4c'],
  ['flush', 'Flush', 'Ah Kh Qh Jh 9h 7d 4c'],
  ['fullHouse', 'Full House', 'Ah Ad Ac Kh Kd 7d 4c'],
  ['quads', 'Four of a Kind', 'Ah Ad Ac As Kd 7d 4c'],
  ['straightFlush', 'Straight Flush', 'Ah Kh Qh Jh Th 7d 4c'],
];

describe('HAND_CATEGORY named constants', () => {
  it('covers every category with the unique values 0..8', () => {
    expect(Object.values(HAND_CATEGORY)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(Object.keys(HAND_CATEGORY)).toHaveLength(HAND_CATEGORY_NAMES.length);
  });

  it('aligns with HAND_CATEGORY_NAMES', () => {
    for (const [key, name] of SAMPLES) {
      expect(HAND_CATEGORY_NAMES[HAND_CATEGORY[key]], key).toBe(name);
    }
  });

  it('matches the real evaluator output for each category', () => {
    for (const [key, , hand] of SAMPLES) {
      expect(handCategory(evaluate7(h(hand))), `${key}: ${hand}`).toBe(HAND_CATEGORY[key]);
    }
  });
});
