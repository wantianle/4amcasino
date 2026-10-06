import { describe, expect, it } from 'vitest';
import { cardFromName } from '../src/cards.js';
import { HAND_CATEGORY_NAMES, evaluate5, evaluate7, handCategory } from '../src/evaluate.js';

const h = (s: string) => s.split(' ').map(cardFromName);

/**
 * Frozen contract guard.
 *
 * `apps/web/src/shared/i18n/pokerLabels.ts` renders Chinese showdown labels by
 * re-deriving them from the packed score - `handCategory(score)` for the
 * category and `(score >> (16 - 4 * i)) & 0xf` for the tiebreaks - without
 * importing anything but `handCategory`. The layout is therefore a silent
 * contract: renumbering a category or moving a nibble still compiles, and every
 * label quietly becomes wrong. These assertions use literal values so a layout
 * change fails here instead of in production.
 */
describe('packed score layout (pokerLabels contract)', () => {
  it('freezes the category number of every hand class', () => {
    expect(HAND_CATEGORY_NAMES).toEqual([
      'High Card',
      'Pair',
      'Two Pair',
      'Three of a Kind',
      'Straight',
      'Flush',
      'Full House',
      'Four of a Kind',
      'Straight Flush',
    ]);
    const cases: [string, number][] = [
      ['As Ks Qs Js Ts', 8], // straight flush
      ['9c 9d 9h 9s 2c', 7], // four of a kind
      ['9c 9d 9h 2s 2c', 6], // full house
      ['As Ks 9s 5s 3s', 5], // flush
      ['9c 8d 7h 6s 5c', 4], // straight
      ['9c 9d 9h Ks 2c', 3], // three of a kind
      ['9c 9d Kh Ks 2c', 2], // two pair
      ['9c 9d Kh Qs 2c', 1], // pair
      ['Ac Kd 9h 5s 3c', 0], // high card
    ];
    for (const [hand, category] of cases) {
      expect(handCategory(evaluate5(h(hand))), hand).toBe(category);
    }
  });

  it('freezes the exact packed score of every hand class', () => {
    // category << 20 | tiebreak0 << 16 | tiebreak1 << 12 | ... | tiebreak4
    expect(evaluate5(h('As Ks Qs Js Ts'))).toBe(9_175_040); // 8<<20 | 12<<16
    expect(evaluate5(h('9c 9d 9h 9s 2c'))).toBe(7_798_784); // 7<<20 | 7<<16 | 0<<12
    expect(evaluate5(h('9c 9d 9h 2s 2c'))).toBe(6_750_208); // 6<<20 | 7<<16 | 0<<12
    expect(evaluate5(h('As Ks 9s 5s 3s'))).toBe(6_076_209); // 5<<20 | 12<<16 | 11<<12 | 7<<8 | 3<<4 | 1
    expect(evaluate5(h('9c 8d 7h 6s 5c'))).toBe(4_653_056); // 4<<20 | 7<<16
    expect(evaluate5(h('9c 9d 9h Ks 2c'))).toBe(3_649_536); // 3<<20 | 7<<16 | 11<<12 | 0
    expect(evaluate5(h('9c 9d Kh Ks 2c'))).toBe(2_846_720); // 2<<20 | 11<<16 | 7<<12 | 0
    expect(evaluate5(h('9c 9d Kh Qs 2c'))).toBe(1_554_944); // 1<<20 | 7<<16 | 11<<12 | 10<<8
    expect(evaluate5(h('Ac Kd 9h 5s 3c'))).toBe(833_329); // 0 | ranks 12,11,7,3,1
  });

  it('documents the bit positions the web decoder reads', () => {
    const score = evaluate5(h('9c 9d 9h 2s 2c')); // full house, nines full of deuces
    expect(score >>> 20).toBe(6); // category
    expect((score >> 16) & 0xf).toBe(7); // tiebreak 0 = rank of the trips (Nine)
    expect((score >> 12) & 0xf).toBe(0); // tiebreak 1 = rank of the pair (Two)
    expect((score >> 8) & 0xf).toBe(0);
    expect((score >> 4) & 0xf).toBe(0);
    expect(score & 0xf).toBe(0);

    const flush = evaluate5(h('As Ks 9s 5s 3s'));
    expect([0, 1, 2, 3, 4].map((i) => (flush >> (16 - 4 * i)) & 0xf)).toEqual([12, 11, 7, 3, 1]);
  });

  it('keeps evaluate7 on the same layout', () => {
    // two hearts in hand + five hearts on board => best five is the heart flush
    expect(handCategory(evaluate7(h('2c 2d Ah Kh Qh Jh 9h')))).toBe(5);
    // straight beats trips across seven cards
    expect(handCategory(evaluate7(h('9c 9d 9h 8s 7c 6d 5h')))).toBe(4);
    expect(evaluate7(h('2c 2d Ah Kh Qh Jh 9h'))).toBe(evaluate5(h('Ah Kh Qh Jh 9h')));
  });
});
