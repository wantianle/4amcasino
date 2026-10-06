import { describe, expect, it } from 'vitest';
import { DEFAULT_GAMEPLAY_SETTINGS } from '../src/roomRules.js';

describe('DEFAULT_GAMEPLAY_SETTINGS', () => {
  it('is frozen in depth so a stray write cannot corrupt the shared defaults', () => {
    expect(Object.isFrozen(DEFAULT_GAMEPLAY_SETTINGS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_GAMEPLAY_SETTINGS.squid)).toBe(true);
    expect(Object.isFrozen(DEFAULT_GAMEPLAY_SETTINGS.timeBank)).toBe(true);
    expect(Object.isFrozen(DEFAULT_GAMEPLAY_SETTINGS.bombPot)).toBe(true);
    expect(Object.isFrozen(DEFAULT_GAMEPLAY_SETTINGS.bombPot.schedule)).toBe(true);
    expect(Object.isFrozen(DEFAULT_GAMEPLAY_SETTINGS.multiRun)).toBe(true);
    expect(() => {
      (DEFAULT_GAMEPLAY_SETTINGS as unknown as { squid: { enabled: boolean } }).squid.enabled =
        false;
    }).toThrow();
  });
});
