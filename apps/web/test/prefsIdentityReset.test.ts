import { beforeEach, describe, expect, it, vi } from 'vitest';
import { genIdentity } from '@4am/mental-poker';
import { DEFAULT_POKER_HOTKEYS } from '@4am/shared';

/**
 * Identity-boundary clearing of the account-level `prefs` fields.
 *
 * `prefs` mixes two kinds of field. The account-level ones (`displayName`,
 * `bio`, `hasAvatar`, `avatarVersion`, the appearance picks, `quickPhrases`,
 * `privateMode`, `autoJoinInvites`, `autoReady`, `betRatios`, `pokerHotkeys`)
 * are all the server's per-account copy and are re-fetched by an ASYNCHRONOUS
 * `loadPrefs()`. Without a reset at the boundary, account B reads account A's
 * data for the whole window before that fetch lands - Lobby's `displayName`,
 * ChatPanel's `quickPhrases`, AppShell's name/avatar, ProfileDialog's bio.
 * `stackUnit` is device-level (no server column) and must survive the switch.
 *
 * Both account boundaries - `logout()` and the `?switch=1` `setAuth` path -
 * funnel through the one auth-identity subscription in gameClient, so both are
 * exercised here.
 */

const socket = vi.hoisted(() => ({
  send: vi.fn(),
  on: vi.fn(),
  consumeResync: vi.fn(() => false),
}));
const profile = vi.hoisted(() => vi.fn());
vi.mock('../src/shared/ws.ts', () => ({ wsClient: socket }));
vi.mock('../src/shared/voice.ts', () => ({ voice: { syncPeers: vi.fn(), handleRtc: vi.fn() } }));
vi.mock('../src/shared/sounds.ts', () => ({ play: vi.fn() }));
vi.mock('../src/shared/api.ts', () => ({ api: { profile } }));

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => m.get(k) ?? null,
    setItem: (k: string, v: string): void => void m.set(k, v),
    removeItem: (k: string): void => void m.delete(k),
    key: (i: number): string | null => [...m.keys()][i] ?? null,
    get length(): number {
      return m.size;
    },
    clear: (): void => m.clear(),
  };
}
const local = memoryStorage();
const session = memoryStorage();
vi.stubGlobal('window', { localStorage: local, dispatchEvent: () => {} });
vi.stubGlobal('localStorage', local);
vi.stubGlobal('sessionStorage', session);
vi.stubGlobal('CustomEvent', class { constructor(public type: string) {} });

const { useStore, defaultPrefs } = await import('../src/shared/store.ts');
// Importing gameClient registers the production auth-identity subscription.
await import('../src/shared/gameClient.ts');
const { loadPrefs } = await import('../src/shared/prefs.ts');

const A = 1;
const B = 2;

const A_HOTKEYS = {
  ...DEFAULT_POKER_HOTKEYS,
  enabled: true,
  bindings: { ...DEFAULT_POKER_HOTKEYS.bindings, fold: 'Q' },
};

/** Everything account A has that must NOT reach B. */
const A_PREFS: Partial<typeof defaultPrefs> = {
  displayName: 'Alice',
  bio: 'alice-private-bio',
  hasAvatar: true,
  avatarVersion: 7,
  cardBack: 'indigo',
  cardFace: 'minimal',
  tableSkin: 'sapphire',
  fourColor: false,
  quickPhrases: ['gg wp', 'nice hand'],
  privateMode: true,
  autoJoinInvites: true,
  autoReady: false,
  betRatios: [0.25, 0.5, 0.75, 1, 2],
  pokerHotkeys: A_HOTKEYS,
  stackUnit: 'bb',
};

const ACCOUNT_LEVEL_KEYS = [
  'displayName',
  'bio',
  'hasAvatar',
  'avatarVersion',
  'cardBack',
  'cardFace',
  'tableSkin',
  'fourColor',
  'quickPhrases',
  'privateMode',
  'autoJoinInvites',
  'autoReady',
  'betRatios',
  'pokerHotkeys',
] as const;

function authFor(userId: number, username: string) {
  return { token: `t${userId}`, userId, username, identity: genIdentity() };
}

function signIn(userId: number, username: string): void {
  useStore.getState().setAuth(authFor(userId, username));
}

/** Account A is fully signed in and every one of its account-level prefs is
 *  populated (as if it just finished `loadPrefs()`). */
function signInAlice(): void {
  signIn(A, 'alice');
  useStore.getState().setPrefs({ ...A_PREFS });
}

function expectAccountPrefsAreDefault(prefs: typeof defaultPrefs): void {
  for (const key of ACCOUNT_LEVEL_KEYS) {
    expect(prefs[key], `prefs.${key}`).toEqual(defaultPrefs[key]);
  }
}

beforeEach(() => {
  socket.send.mockClear();
  socket.consumeResync.mockReset();
  socket.consumeResync.mockReturnValue(false);
  profile.mockReset();
  local.clear();
  session.clear();
  useStore.setState({
    auth: { token: null, userId: null, username: null, identity: null },
    prefs: { ...defaultPrefs },
  });
});

describe('?switch=1 path: prefs are back to defaults before loadPrefs lands', () => {
  it("B reads default displayName / bio / quickPhrases, not A's", () => {
    signInAlice();
    // Sanity: A's data really is in the store before the boundary.
    expect(useStore.getState().prefs.displayName).toBe('Alice');
    expect(useStore.getState().prefs.quickPhrases).toEqual(['gg wp', 'nice hand']);

    // LoginPage?switch=1: replaces the identity with no logout() call. No
    // loadPrefs has run yet - this is exactly the async window.
    signIn(B, 'bob');

    const p = useStore.getState().prefs;
    expect(p.displayName).toBe(defaultPrefs.displayName);
    expect(p.bio).toBe(defaultPrefs.bio);
    expect(p.quickPhrases).toEqual(defaultPrefs.quickPhrases);
    expect(p.privateMode).toBe(defaultPrefs.privateMode);
  });

  it('every account-level field is defaulted, not A\'s', () => {
    signInAlice();
    signIn(B, 'bob');
    expectAccountPrefsAreDefault(useStore.getState().prefs);
  });

  it('the device-level stackUnit survives the switch', () => {
    signInAlice();
    expect(useStore.getState().prefs.stackUnit).toBe('bb');

    signIn(B, 'bob');

    expect(useStore.getState().prefs.stackUnit).toBe('bb');
  });

  it('a same-account setAuth (profile refresh) does NOT wipe prefs', () => {
    signInAlice();
    // AccountSecurity / App's `me()` merge: same userId, new object identity.
    useStore.getState().setAuth({ ...authFor(A, 'alice'), isPlatform: false });

    expect(useStore.getState().prefs.displayName).toBe('Alice');
    expect(useStore.getState().prefs.stackUnit).toBe('bb');
  });

  it("a late loadPrefs(A) cannot repopulate B with A's data", async () => {
    signInAlice();
    let finishA!: (value: unknown) => void;
    profile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishA = resolve;
        }),
    );
    const pendingA = loadPrefs();
    signIn(B, 'bob');
    finishA({ userId: A, displayName: 'Alice', bio: 'alice-private-bio' });
    await pendingA;

    expect(useStore.getState().prefs.displayName).toBe(defaultPrefs.displayName);
    expect(useStore.getState().prefs.bio).toBe(defaultPrefs.bio);
  });

  it("loadPrefs(B) fills B's real values and still keeps stackUnit", async () => {
    signInAlice();
    signIn(B, 'bob');
    expectAccountPrefsAreDefault(useStore.getState().prefs);

    profile.mockResolvedValueOnce({
      userId: B,
      displayName: 'Bob',
      bio: 'bob-bio',
      hasAvatar: false,
      avatarVersion: 3,
      cardBack: 'emerald',
      cardFace: 'classic-large',
      tableSkin: 'burgundy',
      fourColor: false,
      quickPhrases: ['hello there'],
      privateMode: false,
      autoJoinInvites: false,
      autoReady: true,
      betRatios: [0.25, 0.5, 0.75, 1, 1.5],
      pokerHotkeys: DEFAULT_POKER_HOTKEYS,
    });
    await loadPrefs();

    const p = useStore.getState().prefs;
    expect(p.displayName).toBe('Bob');
    expect(p.bio).toBe('bob-bio');
    expect(p.quickPhrases).toEqual(['hello there']);
    expect(p.cardBack).toBe('emerald');
    expect(p.cardFace).toBe('classic-large');
    expect(p.tableSkin).toBe('burgundy');
    // The device-level field is not part of the server payload and survives.
    expect(p.stackUnit).toBe('bb');
  });
});

describe('logout() path: prefs are back to defaults before loadPrefs lands', () => {
  it("the logged-out store holds no account-level residual of A's", () => {
    signInAlice();

    useStore.getState().logout();

    expectAccountPrefsAreDefault(useStore.getState().prefs);
  });

  it('the device-level stackUnit survives logout too', () => {
    signInAlice();
    useStore.getState().logout();
    expect(useStore.getState().prefs.stackUnit).toBe('bb');
  });

  it("the account signing in afterwards does not see A's prefs", async () => {
    signInAlice();
    useStore.getState().logout();

    // Fresh account B logs in (null -> identity is not a wipe, so the logged-out
    // defaults from logout() are what B starts from).
    signIn(B, 'bob');
    expectAccountPrefsAreDefault(useStore.getState().prefs);
    expect(useStore.getState().prefs.stackUnit).toBe('bb');
  });
});
