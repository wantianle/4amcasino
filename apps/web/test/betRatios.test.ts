import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateProfile = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
const profile = vi.hoisted(() => vi.fn());
vi.mock('../src/shared/api.ts', () => ({ api: { updateProfile, profile } }));
vi.mock('../src/shared/sounds.ts', () => ({}));
let persistedAuth: string | null = null;
const storage = { getItem: () => persistedAuth, setItem: () => {}, removeItem: () => {} };
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
const { loadPrefs, saveBetRatios } = await import('../src/shared/prefs.ts');

beforeEach(() => {
  useStore.getState().setPrefs({ betRatios: [...DEFAULT_BET_RATIOS] });
  useStore.getState().setAuth({ token: null, userId: null, username: null, identity: null });
  updateProfile.mockClear();
  profile.mockReset();
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

  it('migrates a legacy four-slot list to the five-slot default', () => {
    const four = [0.5, 1, 1.5, ALL_IN_RATIO];
    expect(sanitizeBetRatios(four)).toEqual(DEFAULT_BET_RATIOS);
    expect(sanitizeBetRatios(four)).toHaveLength(BET_RATIO_SLOTS);
  });

  it('rehydrating an old persisted four-slot state yields the five-slot default', async () => {
    persistedAuth = JSON.stringify({
      state: {
        prefs: { ...defaultPrefs, betRatios: [0.5, 1, 1.5, ALL_IN_RATIO] },
      },
      version: 0,
    });
    try {
      await useStore.persist.rehydrate();
      expect(useStore.getState().prefs.betRatios).toEqual(DEFAULT_BET_RATIOS);
      expect(useStore.getState().prefs.betRatios).toHaveLength(BET_RATIO_SLOTS);
    } finally {
      persistedAuth = null;
    }
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

describe('loadPrefs betRatios authority', () => {
  const profileWithout = (extra: Record<string, unknown> = {}) => ({
    userId: 7,
    displayName: 'u',
    bio: '',
    hasAvatar: false,
    avatarVersion: 0,
    cardBack: 'indigo',
    fourColor: true,
    quickPhrases: [],
    privateMode: false,
    autoJoinInvites: false,
    autoReady: true,
    ...extra,
  });
  const signIn = () =>
    useStore.getState().setAuth({ token: 't', userId: 7, username: 'u', identity: null });

  it('keeps a valid local five-slot list when the server omits betRatios', async () => {
    const local = [1 / 3, 0.5, 0.75, 1, 2];
    useStore.getState().setPrefs({ betRatios: local });
    signIn();
    // The server never stored the list (a failed/late PUT), so GET omits it.
    profile.mockResolvedValueOnce(profileWithout());
    await loadPrefs();
    expect(useStore.getState().prefs.betRatios).toEqual(local);
  });

  it('lets the server list win when the server returns one', async () => {
    const local = [1 / 3, 0.5, 0.75, 1, 2];
    const server = [0.25, 0.5, 0.75, 1, 1.5];
    useStore.getState().setPrefs({ betRatios: local });
    signIn();
    profile.mockResolvedValueOnce(profileWithout({ betRatios: server }));
    await loadPrefs();
    expect(useStore.getState().prefs.betRatios).toEqual(server);
  });

  it('migrates an old local four-slot list when the server omits betRatios', async () => {
    useStore.getState().setPrefs({ betRatios: [0.5, 1, 1.5, ALL_IN_RATIO] });
    signIn();
    profile.mockResolvedValueOnce(profileWithout());
    await loadPrefs();
    expect(useStore.getState().prefs.betRatios).toEqual(DEFAULT_BET_RATIOS);
  });
});
