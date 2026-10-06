import { describe, expect, it } from 'vitest';
import { cardFromName } from '@4am/shared';
import { collectorSeats } from '../src/widgets/table/RoundTable.tsx';
import { goldFive } from '../src/widgets/table/goldFive.ts';

const cards = (...names: string[]) => names.map((n) => cardFromName(n));

describe('collectorSeats — pot flight targets', () => {
  it('falls back to the net winners when the payout frame is empty (fold win)', () => {
    // A hand won by fold broadcasts NO showdown, so the page supplies
    // collectSeats = [] while the sole winner is still net positive. The old
    // raw intersection produced [] and the table went silent; the fallback must
    // keep the pots flying to the actual winner.
    expect(collectorSeats([3], [])).toEqual([3]);
    // undefined is the replay / no-payout-frame form of the same thing.
    expect(collectorSeats([3], undefined)).toEqual([3]);
  });

  it('falls back to the net winners when the two sets are disjoint', () => {
    // collectSeats is per-payout data and is NOT proven to contain every net
    // winner; a disagreement must never silence the celebration.
    const netWinners = [3, 7];
    const collectSeats = [5, 9];
    expect(netWinners.filter((s) => collectSeats.includes(s))).toEqual([]); // constructive
    expect(collectorSeats(netWinners, collectSeats)).toEqual([3, 7]);
  });

  it('keeps the intersection when it is non-empty — no "two-sided fly" regression', () => {
    // Seat 4 collected a run (in collectSeats) but LOST the hand overall, so it
    // is NOT a net winner. Seat 3 won the hand. The regressed behavior flew the
    // pot to both (跑马一输一赢、筹码两边飞); the fix must fly only to seat 3.
    expect(collectorSeats([3], [3, 4])).toEqual([3]);
    expect(collectorSeats([3], [4])).not.toContain(4);
  });

  it('keeps the per-payout split for a true tie / early showdown window', () => {
    // No net winners yet (nobody net positive, or hand_end has not landed):
    // the pot still flies to the per-payout seats.
    expect(collectorSeats([], [3, 4])).toEqual([3, 4]);
    expect(collectorSeats([], undefined)).toEqual([]);
  });
});

describe('goldFive — two pair and above', () => {
  const board = cards('2c', '7h', '9s', 'Jd', '3c');

  it('returns null below the two-pair threshold', () => {
    expect(goldFive(cards('As', 'Kd'), board)).toBeNull(); // high card
    expect(goldFive(cards('As', 'Ad'), board)).toBeNull(); // one pair
  });

  it('returns the best five cards at two pair', () => {
    const five = goldFive(cards('As', 'Ad'), cards('2c', '2h', '9s', 'Jd', '3c'));
    expect(five).not.toBeNull();
    expect(five!.size).toBe(5);
  });

  it('returns the best five cards for a flush and up', () => {
    const flush = goldFive(cards('As', 'Ks'), cards('Qs', '9s', '7s', '2h', '3d'));
    expect(flush).not.toBeNull();
    expect(flush!.size).toBe(5);
  });

  it('needs a final five-card board and two hole cards', () => {
    expect(goldFive(cards('As', 'Ad'), cards('2c', '2h'))).toBeNull();
    expect(goldFive(undefined, board)).toBeNull();
  });
});
