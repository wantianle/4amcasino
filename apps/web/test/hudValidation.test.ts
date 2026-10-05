import { describe, expect, it } from 'vitest';
import { isValidHudPlayer } from '../src/widgets/table/SeatBadges.tsx';

describe('RoomHud player validation', () => {
  it.each([NaN, Infinity, -1, 0, 1.5])('rejects invalid userId %s', (userId) => {
    expect(isValidHudPlayer({ userId })).toBe(false);
  });

  it('accepts a positive integer userId', () => {
    expect(isValidHudPlayer({ userId: 1 })).toBe(true);
    expect(isValidHudPlayer({ userId: 42 })).toBe(true);
  });

  it('rejects malformed player elements', () => {
    expect(isValidHudPlayer(null)).toBe(false);
    expect(isValidHudPlayer({})).toBe(false);
    expect(isValidHudPlayer('player')).toBe(false);
  });
});
