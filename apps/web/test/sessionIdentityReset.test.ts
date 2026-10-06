import { beforeEach, describe, expect, it, vi } from 'vitest';
import { genIdentity } from '@4am/mental-poker';
import type { ServerMsg } from '@4am/shared';
import { roomState } from './helpers/fixtures.ts';

/**
 * Identity-boundary clearing of the VIEW state (`lastHand` / `hand` / `errors`
 * / `voice`).
 *
 * The module-level registries (`foldedByMe` / `endedHands` / `terminalHands`)
 * are covered by `handSessionBoundary.test.ts`. This suite is the companion for
 * the store's own view fields: both account boundaries - an explicit
 * `logout()` and a `?switch=1` re-login that only calls `setAuth` - must leave
 * the next account with nothing the previous one saw.
 *
 * The reachability claim under test is concrete: account A plays a hand to
 * `hand_end` (which freezes the recap), then the account changes. Before the
 * fix, B still sees A's `lastHand` (names / board / reveals) on the table until
 * the next hand overwrites it. Both cases below assert that after the boundary
 * the recap is gone.
 */

const socket = vi.hoisted(() => ({
  send: vi.fn(),
  on: vi.fn(),
  consumeResync: vi.fn(() => false),
}));
vi.mock('../src/shared/ws.ts', () => ({ wsClient: socket }));
vi.mock('../src/shared/voice.ts', () => ({ voice: { syncPeers: vi.fn(), handleRtc: vi.fn() } }));
vi.mock('../src/shared/sounds.ts', () => ({ play: vi.fn() }));

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

const { useStore, emptyHand, emptyVoice } = await import('../src/shared/store.ts');
// Importing gameClient registers the production auth-identity subscription.
const { handle } = await import('../src/shared/gameClient.ts');

const A = 1;
const B = 2;
const HAND = 'identity-hand';

function authFor(userId: number, username: string) {
  return { token: `t${userId}`, userId, username, identity: genIdentity() };
}

/** Sign in a real account via the public store action (fires the subscription
 *  exactly as LoginPage does). */
function signIn(userId: number, username: string): void {
  useStore.getState().setAuth(authFor(userId, username));
}

/** Account A plays a hand to `hand_end`, freezing a recap that names A. */
function playHandAsAlice(): void {
  signIn(A, 'alice');
  const base = roomState(A);
  useStore.setState({
    room: {
      ...base,
      players: [
        {
          userId: A,
          username: 'alice',
          displayName: 'Alice',
          avatarVersion: 0,
          publicKey: '',
          seat: 0,
          stack: 1000,
          sittingOut: false,
          connected: true,
          totalBought: 0,
          privateStats: false,
          pendingBuy: 0,
        },
      ],
    },
    wsConnected: true,
  });
  useStore.getState().patchHand({
    handId: HAND,
    seats: [{ seat: 0, userId: A, username: 'alice', publicKey: '', stack: 1000 }],
  });
  const end: ServerMsg = {
    t: 'hand_end',
    handId: HAND,
    head: 'head',
    stacks: [],
    deltas: [{ seat: 0, delta: 200 }],
  };
  handle(end);
  // Sanity: the recap really exists and names Alice before any boundary.
  expect(useStore.getState().lastHand?.handId).toBe(HAND);
  expect(useStore.getState().lastHand?.names[0]).toBe('Alice');
}

beforeEach(() => {
  socket.send.mockClear();
  socket.consumeResync.mockReset();
  socket.consumeResync.mockReturnValue(false);
  local.clear();
  session.clear();
  // Reset the whole store to a known logged-out state; setting userId -> null
  // also exercises the subscription's logout branch between cases.
  useStore.setState({
    auth: { token: null, userId: null, username: null, identity: null },
    room: null,
    chat: [],
    hand: { ...emptyHand },
    lastHand: null,
    errors: [],
    voice: { ...emptyVoice },
  });
});

describe('the recap is truly reachable before the boundary', () => {
  it('hand_end freezes a recap naming the current account', () => {
    playHandAsAlice();
    expect(useStore.getState().lastHand?.names[0]).toBe('Alice');
  });
});

describe('account switch through setAuth (?switch=1)', () => {
  it("B does not see A's lastHand recap", () => {
    playHandAsAlice();

    // LoginPage?switch=1: replaces the identity with no logout() call.
    signIn(B, 'bob');

    expect(useStore.getState().lastHand).toBeNull();
  });

  it("B does not see A's live hand view", () => {
    playHandAsAlice();

    signIn(B, 'bob');

    expect(useStore.getState().hand.handId).toBeNull();
    expect(useStore.getState().hand.seats).toHaveLength(0);
  });

  it("B does not see A's room chat", () => {
    playHandAsAlice();
    useStore.getState().pushChat({ from: 'alice', userId: A, text: 'all-in?', kind: 'text', ts: 1 });

    signIn(B, 'bob');

    expect(useStore.getState().chat).toHaveLength(0);
  });

  it('B does not see A-left error toasts', () => {
    playHandAsAlice();
    useStore.getState().pushError('A-only failure');

    signIn(B, 'bob');

    expect(useStore.getState().errors).toHaveLength(0);
  });

  it("B does not inherit A's voice state", () => {
    playHandAsAlice();
    useStore.getState().patchVoice({ joined: true, muted: true, mutedByUser: { [A]: true } });

    signIn(B, 'bob');

    expect(useStore.getState().voice.joined).toBe(false);
    expect(useStore.getState().voice.muted).toBe(false);
    expect(useStore.getState().voice.mutedByUser).toEqual({});
  });

  it('a same-account setAuth (profile refresh) keeps the recap', () => {
    playHandAsAlice();

    // AccountSecurity / App's `me()` merge: same userId, new object identity.
    useStore.getState().setAuth({ ...authFor(A, 'alice'), isPlatform: false });

    expect(useStore.getState().lastHand?.handId).toBe(HAND);
  });
});

describe('account switch through logout()', () => {
  it("the next account does not see A's lastHand recap", () => {
    playHandAsAlice();

    useStore.getState().logout();

    expect(useStore.getState().lastHand).toBeNull();
  });

  it('logout clears A-left error toasts and voice state', () => {
    playHandAsAlice();
    useStore.getState().pushError('A-only failure');
    useStore.getState().patchVoice({ joined: true, mutedByUser: { [A]: true } });

    useStore.getState().logout();

    expect(useStore.getState().errors).toHaveLength(0);
    expect(useStore.getState().voice.joined).toBe(false);
    expect(useStore.getState().voice.mutedByUser).toEqual({});
  });
});
