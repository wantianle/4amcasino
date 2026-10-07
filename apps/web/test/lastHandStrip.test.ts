import { describe, expect, it } from 'vitest';
import { rakeTakenOf } from '../src/widgets/table/LastHandStrip.tsx';

/**
 * Per-hand rake display (the f03ada3 dead-code follow-up).
 *
 * A normal hand no longer renders a result pill, so the last-hand strip is the
 * one place a player can read what the hand cost in rake. The strip shows the
 * TOTAL taken out of the pot: the protocol invariant is
 * `sum(hand_end.deltas) === -commission` (wsProtocol hand_end), so the seat leg
 * already carries the house's cut even when the rake recipient is not seated
 * (`commissionDeltas` - the recipient projection - is empty then), which is
 * exactly the case the old "Rake received" line missed.
 *
 * These pin the one sign/perspective choice that is easy to get backwards
 * ("bank received X" vs "the hand was raked X"). The end-to-end proof that the
 * value lands on screen is `test/browser/last-hand-rake.mjs` (real Chromium);
 * vitest here is plain Node with no jsdom, and a store-driven SSR render reads
 * the initial zustand snapshot, so the rendered markup cannot be asserted here.
 */

describe('rakeTakenOf', () => {
  it('is the negated seat-leg sum (the house cut, from the players side)', () => {
    // Winner nets +878, eight losers -110 each: sum = -2 => 2 chips raked,
    // with NO commissionDeltas (recipient is the platform / an outside banker).
    const deltas = [
      { delta: 878 },
      ...[0, 0, 0, 0, 0, 0, 0, 0].map(() => ({ delta: -110 })),
    ];
    expect(rakeTakenOf(deltas)).toBe(2);
  });

  it('is zero for an unraked hand', () => {
    expect(rakeTakenOf([{ delta: 110 }, { delta: -110 }])).toBe(0);
  });

  it('is zero when there is no seat leg at all', () => {
    expect(rakeTakenOf([])).toBe(0);
  });
});
