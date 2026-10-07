import { describe, expect, it } from 'vitest';
import {
  advancePotFreeze,
  centralPotValue,
  readFrozenPot,
} from '../src/pages/table/TablePage.tsx';

/**
 * The central pot pill's value + freeze rule.
 *
 * `hand_end` does NOT clear `hand.betting` (its reducer patch never touches it),
 * so a live total normally survives into the result window. The pill can still
 * be empty-with-a-result on special paths (a committed terminal recovery lands
 * with `betting: null`); the freeze then keeps the pill non-zero and visible so
 * `SettlementFlight` does not measure an invisible box.
 *
 * `centralPotValue` is "live wins, fall back when missing" - NOT "freeze the
 * instant a result lands". vitest runs in plain Node (no jsdom), so the real
 * rect/opacity proof lives in `test/browser/settlement-central-pot.mjs`; here we
 * pin the value rule and the cross-hand scoping of the freeze cache.
 */
describe('centralPotValue', () => {
  it('shows the live total while betting', () => {
    expect(centralPotValue(840, false, 0)).toBe(840);
    expect(centralPotValue(840, false, 500)).toBe(840);
    // A live total outranks a frozen one even inside a result window.
    expect(centralPotValue(840, true, 500)).toBe(840);
  });

  it('falls back to the frozen total once the pot is empty with a result', () => {
    // Destructive: without the fallback this is 0, the pill unmounts, and the
    // settlement target is an invisible (or zero-rect) box.
    expect(centralPotValue(0, true, 840)).toBe(840);
    expect(centralPotValue(0, true, 1)).toBe(1);
  });

  it('hides the pill with no result, even with a stale freeze', () => {
    expect(centralPotValue(0, false, 840)).toBe(0);
  });
});

describe('advancePotFreeze - per-hand scoping', () => {
  it('tracks the live total within one hand', () => {
    let f = advancePotFreeze({ handId: null, pot: 0 }, 'A', 0, false);
    expect(f).toEqual({ handId: 'A', pot: 0 });
    f = advancePotFreeze(f, 'A', 300, false);
    expect(f).toEqual({ handId: 'A', pot: 300 });
    // A result window with an empty snapshot still has A's frozen total.
    expect(centralPotValue(0, true, f.pot)).toBe(300);
  });

  it('DROPS the frozen total when the hand changes (A -> B recovery leak)', () => {
    // A ends with a frozen 300; B starts with no betting, then a committed
    // recovery produces a result with `betting: null`. B must never reuse 300.
    let f = advancePotFreeze({ handId: null, pot: 0 }, 'A', 300, false);
    f = advancePotFreeze(f, 'B', 0, false);
    expect(f).toEqual({ handId: 'B', pot: 0 });
    expect(centralPotValue(0, true, f.pot)).toBe(0);
  });

  it('DROPS the frozen total on abort of the same hand', () => {
    const f = advancePotFreeze({ handId: 'A', pot: 300 }, 'A', 0, true);
    expect(f).toEqual({ handId: 'A', pot: 0 });
  });
});

describe('readFrozenPot - render-time read (no writes)', () => {
  it('returns the cache only for the matching, non-aborting hand', () => {
    expect(readFrozenPot({ handId: 'A', pot: 300 }, 'A', false)).toBe(300);
  });

  it('returns 0 for another hand (an interrupted render changing hands)', () => {
    expect(readFrozenPot({ handId: 'A', pot: 300 }, 'B', false)).toBe(0);
  });

  it('returns 0 while aborting, even if the cache still holds a value', () => {
    // The reducer keeps `result` on abort, so this guard is what stops a dead
    // hand's frozen total from staying on screen.
    expect(readFrozenPot({ handId: 'A', pot: 300 }, 'A', true)).toBe(0);
  });

  it('returns 0 when there is no cache for this hand', () => {
    expect(readFrozenPot({ handId: null, pot: 0 }, 'A', false)).toBe(0);
  });
});
