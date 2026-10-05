import { describe, expect, it } from 'vitest';
import { metricValue, statsQuery } from '../src/features/stats/types.ts';

describe('hand statistics presentation', () => {
  it('does not turn missing opportunities or null ratios into zero', () => {
    expect(metricValue()).toBe('—');
    expect(metricValue({ hits: 0, opportunities: 0, pct: null, unit: 'pct' })).toBe('—');
    expect(metricValue({ hits: 3, opportunities: 0, pct: null, unit: 'ratio' })).toBe('—');
    expect(metricValue({ hits: 0, opportunities: 20, pct: 0, unit: 'pct' })).toBe('0%');
  });
  it('respects API units and chip sums', () => {
    expect(metricValue({ hits: 2, opportunities: 4, pct: 0.5, unit: 'ratio' })).toBe('0.5');
    expect(metricValue({ hits: -80, opportunities: 8, pct: null, unit: 'chips' })).toBe('-80');
    expect(metricValue({ hits: 2400, opportunities: 120, pct: 20, unit: 'bb/100' })).toBe('20');
  });
  it('encodes scope and omits undefined filters', () => {
    expect(statsQuery({ roomId: 'a&b', minHands: 20, limit: undefined })).toBe('roomId=a%26b&minHands=20');
  });
});
