import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateProfile = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
vi.mock('../src/shared/api.ts', () => ({ api: { updateProfile, profile: vi.fn() } }));
vi.mock('../src/shared/sounds.ts', () => ({}));
const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
vi.stubGlobal('window', { localStorage: storage });
vi.stubGlobal('localStorage', storage);
vi.stubGlobal('document', { documentElement: { classList: { add: vi.fn(), remove: vi.fn() } } });

const {
  ALL_IN_RATIO,
  BET_RATIO_OPTIONS,
  BET_RATIO_SLOTS,
  DEFAULT_BET_RATIOS,
  defaultPrefs,
  sanitizeBetRatios,
  useStore,
} = await import('../src/shared/store.ts');
const { presetLabel, presetRaiseTo } = await import('../src/features/table/betPresets.ts');
const { saveBetRatios } = await import('../src/shared/prefs.ts');

beforeEach(() => {
  useStore.getState().setPrefs({ betRatios: [...DEFAULT_BET_RATIOS] });
  updateProfile.mockClear();
});

describe('default quick-bet ratios', () => {
  it('is five slots: 33% / 50% / 75% / 100% / 150%', () => {
    expect(BET_RATIO_SLOTS).toBe(5);
    expect(DEFAULT_BET_RATIOS).toEqual([1 / 3, 0.5, 0.75, 1, 1.5]);
    expect(defaultPrefs.betRatios).toEqual([1 / 3, 0.5, 0.75, 1, 1.5]);
  });

  it('offers 150% in the settings options and keeps all-in selectable', () => {
    expect(BET_RATIO_OPTIONS).toContain(1.5);
    expect(BET_RATIO_OPTIONS).toContain(ALL_IN_RATIO);
    // all-in is no longer part of the defaults
    expect(DEFAULT_BET_RATIOS).not.toContain(ALL_IN_RATIO);
  });

  it('labels each default with its configured percentage', () => {
    expect(DEFAULT_BET_RATIOS.map(presetLabel)).toEqual(['33%', '50%', '75%', '100%', '150%']);
    expect(presetLabel(ALL_IN_RATIO)).toBeNull();
  });
});

describe('sanitizeBetRatios', () => {
  it('keeps a valid five-slot list as-is', () => {
    const five = [0.25, 1 / 3, 0.5, 0.75, 2];
    expect(sanitizeBetRatios(five)).toEqual(five);
  });

  it('keeps a legacy four-slot list as-is for backward compatibility', () => {
    const four = [0.5, 1, 1.5, ALL_IN_RATIO];
    expect(sanitizeBetRatios(four)).toEqual(four);
  });

  it('falls back to the five-slot defaults on an invalid list', () => {
    expect(sanitizeBetRatios([1, 2, 3])).toEqual(DEFAULT_BET_RATIOS); // 3 slots
    expect(sanitizeBetRatios([1 / 3, 0.5, 0.75, 1, 1.5, 2])).toEqual(DEFAULT_BET_RATIOS); // 6
    expect(sanitizeBetRatios([1 / 3, 0.5, 0.75, 1, 99])).toEqual(DEFAULT_BET_RATIOS); // foreign
    expect(sanitizeBetRatios('nope')).toEqual(DEFAULT_BET_RATIOS);
    expect(sanitizeBetRatios(null)).toEqual(DEFAULT_BET_RATIOS);
  });
});

describe('presetRaiseTo', () => {
  const base = {
    pot: 1000,
    callAmount: 100,
    currentBet: 100,
    sb: 10,
    minRaiseTo: 200,
    maxRaiseTo: 100_000,
  };

  it('shoves the whole stack for the all-in slot', () => {
    expect(presetRaiseTo({ ...base, frac: ALL_IN_RATIO })).toBe(base.maxRaiseTo);
  });

  it('sizes a pot fraction after the call and snaps it to the blind', () => {
    // 100 + round((1000 + 100) * 0.5) = 650, already on the 10-grid
    expect(presetRaiseTo({ ...base, frac: 0.5 })).toBe(650);
  });

  it('clamps a super-pot 150% down to the all-in max on a short stack', () => {
    expect(presetRaiseTo({ ...base, frac: 1.5, maxRaiseTo: 900 })).toBe(900);
  });

  it('clamps a sub-minimum fraction back up to minRaiseTo', () => {
    // 100 + round(1100 * 0.25) = 375 → 380, below minRaiseTo
    expect(presetRaiseTo({ ...base, frac: 0.25, minRaiseTo: 500 })).toBe(500);
  });
});

describe('saveBetRatios', () => {
  it('persists a valid five-slot list locally and to the profile', async () => {
    const five = [1 / 3, 0.5, 0.75, 1, 1.5];
    saveBetRatios(five);
    expect(useStore.getState().prefs.betRatios).toEqual(five);
    expect(updateProfile).toHaveBeenCalledWith({ betRatios: five });
  });

  it('sanitizes a damaged list before saving', () => {
    saveBetRatios([1, 2, 3]);
    expect(useStore.getState().prefs.betRatios).toEqual(DEFAULT_BET_RATIOS);
    expect(updateProfile).toHaveBeenCalledWith({ betRatios: DEFAULT_BET_RATIOS });
  });
});
