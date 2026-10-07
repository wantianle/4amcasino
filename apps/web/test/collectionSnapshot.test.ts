import { describe, expect, it } from 'vitest';
import { collectionSnapshot } from '../src/widgets/table/RoundTable.tsx';

/** Minimal stand-in: the snapshot only stores rects, never touches their API. */
const rect = (left: number): DOMRect => ({ left } as unknown as DOMRect);

/**
 * The settlement flight and the settlement timeline must consume the SAME
 * source set. `collectionSnapshot` is that single source: its keys are the
 * flight's origins and its length is the timeline's `sourceCount`. These tests
 * pin that a shrinking street cannot leave stale rects behind (which would make
 * the timer count fewer sources than the flight actually uses).
 */
describe('collectionSnapshot - one source for timer and flight', () => {
  it('9 piles -> 2 piles leaves exactly the current 2 (no history)', () => {
    const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [i, 100]));
    const first = collectionSnapshot(nine, (seat) => rect(seat * 10));
    expect(Object.keys(first)).toHaveLength(9);

    // Next street: only seats 3 and 7 still have chips committed.
    const two = collectionSnapshot({ 3: 200, 7: 50 }, (seat) => rect(seat * 10));
    expect(Object.keys(two).map(Number).sort((a, b) => a - b)).toEqual([3, 7]);

    // Destructive assertion of the invariant: the count that drives the
    // timeline and the set the flight flies from are the same record.
    const timelineCount = Object.keys(two).length;
    const flightSources = Object.values(two).length;
    expect(timelineCount).toBe(2);
    expect(flightSources).toBe(2);
  });

  it('final street where everyone checked -> empty snapshot (count 0)', () => {
    const cleared = collectionSnapshot({ 0: 0, 1: 0, 2: 0 }, () => rect(0));
    expect(Object.keys(cleared)).toHaveLength(0);
  });

  it('drops a seat from BOTH count and flight when its pile rect is gone', () => {
    // Seat 5 is committed but its element has unmounted; the timeline must not
    // wait for a source the flight cannot use.
    const snap = collectionSnapshot({ 5: 100, 6: 100 }, (seat) => (seat === 5 ? null : rect(1)));
    expect(Object.keys(snap)).toEqual(['6']);
  });

  it('ignores zero and negative commitments', () => {
    const snap = collectionSnapshot({ 1: -5, 2: 0, 3: 40 }, () => rect(1));
    expect(Object.keys(snap)).toEqual(['3']);
  });
});
