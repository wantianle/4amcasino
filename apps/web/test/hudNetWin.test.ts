import { describe, expect, it } from 'vitest';
import { hudNetWinLine, hudStreakScoreLine } from '../src/features/stats/hudStreak.ts';
import statsDict from '../src/shared/i18n/dict/stats.ts';

describe('room HUD shows the real net win, never the winsorized score', () => {
  // The production case the user reported: the hand netted +1057.3bb over the
  // window, but the hot/cold score was capped down to +32.3.
  const streak = { tier: 'hot1' as const, netBB: 32.3, realNetBB: 1057.3, sample: 50 };

  it('uses realNetBB (1057.3) as the primary number and not netBB (32.3)', () => {
    const line = hudNetWinLine(streak);
    expect(line).toContain('1057.3');
    expect(line).not.toContain('32.3');
    expect(line).toContain('50');
  });

  it('labels the primary number as a net win, not a bare bb figure', () => {
    // The old ambiguous key is gone from the dictionary...
    expect(statsDict['Last 50 hands: {net} bb · {sample} hands']).toBeUndefined();
    // ...and the replacement explicitly says "净赢" (net win).
    expect(statsDict['Last 50 hands net: {net} bb · {sample} hands']).toContain('净赢');
  });

  it('keeps the hot/cold score visible and labelled as winsorized', () => {
    const score = hudStreakScoreLine(streak);
    expect(score).toContain('32.3');
    expect(statsDict['Hot/cold score (winsorized): {net} bb']).toContain('冷热分');
  });

  it('renders signs and the unavailable fallback', () => {
    expect(hudNetWinLine({ realNetBB: -12.5, sample: 30 })).toContain('-12.5');
    expect(hudNetWinLine({ realNetBB: 12.5, sample: 30 })).toContain('+12.5');
    expect(hudNetWinLine(null)).toBe(statsDict['Last 50 hands: unavailable']);
    expect(hudStreakScoreLine(null)).toBeNull();
  });
});
