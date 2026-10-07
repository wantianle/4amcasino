import { describe, expect, it } from 'vitest';
import * as hudStreak from '../src/features/stats/hudStreak.ts';
import statsDict from '../src/shared/i18n/dict/stats.ts';

const { hudNetWinLine } = hudStreak;

describe('room HUD shows the true net win', () => {
  // The production case the user reported: the hand netted +1057.3bb over the
  // window, but the retired winsorized score capped it to +32.3. The line must
  // show the true figure, and the winsorized tooltip is gone entirely.
  const streak = { tier: 'hot2' as const, realNetBB: 1057.3, sample: 50 };

  it('uses realNetBB (1057.3) as the primary number', () => {
    const line = hudNetWinLine(streak);
    expect(line).toContain('1057.3');
    expect(line).toContain('50');
  });

  it('labels the primary number as a net win, not a bare bb figure', () => {
    // The old ambiguous key is gone from the dictionary...
    expect(statsDict['Last 50 hands: {net} bb · {sample} hands']).toBeUndefined();
    // ...and the replacement explicitly says "净赢" (net win).
    expect(statsDict['Last 50 hands net: {net} bb · {sample} hands']).toContain('净赢');
  });

  it('drops the winsorized hot/cold tooltip line and key', () => {
    expect('hudStreakScoreLine' in hudStreak).toBe(false);
    expect(statsDict['Hot/cold score (winsorized): {net} bb']).toBeUndefined();
  });

  it('keeps the hot/cold badge i18n keys', () => {
    expect(statsDict['Hot streak']).toBeDefined();
    expect(statsDict['Cold streak']).toBeDefined();
    expect(statsDict['Big hot streak']).toBeDefined();
    expect(statsDict['Big cold streak']).toBeDefined();
  });

  it('renders signs and the unavailable fallback', () => {
    expect(hudNetWinLine({ realNetBB: -12.5, sample: 30 })).toContain('-12.5');
    expect(hudNetWinLine({ realNetBB: 12.5, sample: 30 })).toContain('+12.5');
    expect(hudNetWinLine(null)).toBe(statsDict['Last 50 hands: unavailable']);
  });
});
