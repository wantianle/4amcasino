import { beforeEach, describe, expect, it, vi } from 'vitest';
import { genIdentity } from '@4am/mental-poker';
import type { BettingState, ServerMsg } from '@4am/shared';
import { roomState } from './helpers/fixtures.ts';

/**
 * Boundedness + session-boundary evidence for the module-level hand state.
 *
 * Part 1 pins that the deal/board motion maps cannot grow without bound: a
 * long-lived tab deals thousands of hands, so the maps are an LRU over handIds
 * with the live hand / recap / folded-but-unsettled hands pinned.
 *
 * Part 2 pins the session-boundary matrix for `resetHandSession` and the
 * `foldedByMe` registry: a fold this browser made must still escrow its key
 * after leaving and rejoining the SAME live hand, but must not survive a
 * logout/account switch or an explicit end of session. Every case drives the
 * PUBLIC `handle()` / `act()` and asserts whether `fold_key` was sent.
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

const { useStore } = await import('../src/shared/store.ts');
const {
  handle,
  act,
  resetHandSession,
  __resetHandTrackingForTest,
  __motionStateForTest,
  dealMotionEpoch,
  claimDealMotion,
  noteDealMotion,
  mergeBoardOpenForMotion,
} = await import('../src/shared/gameClient.ts');

const KEY_PREFIX = '4am/handkey/';
const HAND = 'session-hand';
const HOST = 1;

function seedKey(handId: string, hex: string): void {
  local.setItem(KEY_PREFIX + handId, hex);
}

function sentOf(type: string): Record<string, unknown>[] {
  return socket.send.mock.calls
    .map(([m]) => m as Record<string, unknown>)
    .filter((m) => m.t === type);
}

const mySeats = [{ seat: 0, userId: HOST, username: 'me', publicKey: '', stack: 1000 }];

/** Minimal BettingState; only `seats[].folded`/`seat` matter to the fold_key gate. */
function betting(seats: { seat: number; folded?: boolean }[]): BettingState {
  return {
    street: 'preflop',
    seats: seats.map((s) => ({
      seat: s.seat,
      stack: 1000,
      committed: 0,
      total: 0,
      folded: Boolean(s.folded),
      allIn: false,
      lastActedAt: null,
    })),
    buttonSeat: 0,
    sb: 10,
    bb: 20,
    currentBet: 20,
    lastRaiseSize: 20,
    lastFullRaiseAt: 20,
    toAct: null,
    needToAct: [],
    winnerByFold: null,
  };
}
const THREE_WAY = betting([{ seat: 0 }, { seat: 1 }, { seat: 2 }]);

function signIn(userId = HOST): void {
  useStore.setState({
    auth: { token: 't', userId, username: 'me', identity: genIdentity() },
    wsConnected: true,
  });
}

/** Put the client into a live hand and make it fold, registering `foldedByMe`. */
function armFold(handId: string): void {
  seedKey(handId, 'a1b2');
  useStore.getState().patchHand({ handId, seats: mySeats, betting: THREE_WAY });
  act({ type: 'fold' });
  socket.send.mockClear();
}

/** Re-establish the same hand after a boundary, as a resume/rejoin would. */
function reestablish(handId: string): void {
  useStore.getState().patchHand({ handId, seats: mySeats, betting: THREE_WAY });
}

const actionApplied = (handId: string, seat = 0): ServerMsg => ({
  t: 'action_applied',
  handId,
  seat,
  action: { type: 'fold' },
  auto: false,
});
const failed = (handId: string): ServerMsg => ({
  t: 'settlement_failed',
  handId,
  reason: 'SQLITE_BUSY: database is locked',
  attempt: 1,
  retrying: false,
});
const handEnd = (handId: string): ServerMsg => ({
  t: 'hand_end',
  handId,
  head: 'head',
  stacks: [],
  deltas: [],
});

beforeEach(() => {
  socket.send.mockClear();
  socket.consumeResync.mockReset();
  socket.consumeResync.mockReturnValue(false);
  local.clear();
  session.clear();
  __resetHandTrackingForTest();
  useStore.getState().resetHand();
  useStore.setState({ room: roomState(HOST), lastHand: null, errors: [] });
  signIn();
});

// ---------------------------------------------------------------------------
// 1. Boundedness: the motion maps are an LRU over handIds.
// ---------------------------------------------------------------------------
describe('module motion state is bounded', () => {
  it('1000 hands leave every map at the cap and evict oldest hands whole', () => {
    for (let i = 0; i < 1000; i++) {
      const h = `bulk-${i}`;
      mergeBoardOpenForMotion(h, [], { deckIndex: i, card: i % 52, run: 1 });
      noteDealMotion(h, 'hole:hero:0');
      claimDealMotion(h, 'hole:hero:0', 1);
    }

    const s = __motionStateForTest();
    // Real numbers: 1000 hands in, 64 hands retained, one entry per map/hand.
    expect(s.order).toHaveLength(64);
    expect(s.epochByHand).toBe(64);
    expect(s.dealtByCard).toBe(64);
    expect(s.epochByCard).toBe(64);
    expect(s.boardIndexByCard).toBe(64);
    expect(s.order).not.toContain('bulk-0');
    expect(s.order).toContain('bulk-999');
    // Whole-hand cleanup: an evicted hand leaves no residual card key behind,
    // so a fresh claim for it is a genuine first claim again.
    expect(dealMotionEpoch('bulk-0', 'hole:hero:0')).toBe(0);
    expect(claimDealMotion('bulk-0', 'hole:hero:0', 1)).toBe(true);
  });

  it('the live hand is pinned and never evicted by later hands', () => {
    useStore.getState().patchHand({ handId: 'active' });
    noteDealMotion('active', 'hole:hero:0');

    for (let i = 0; i < 500; i++) noteDealMotion(`filler-${i}`, 'hole:hero:0');

    const s = __motionStateForTest();
    expect(s.order).toContain('active'); // pinned: still present after 500 hands
    expect(s.epochByHand).toBeLessThanOrEqual(65); // cap + the one pinned live hand
    expect(s.epochByHand).toBeGreaterThanOrEqual(64);
    // an evicted filler hand is gone whole
    expect(dealMotionEpoch('filler-0', 'hole:hero:0')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Session boundary matrix for foldedByMe <-> fold_key.
// ---------------------------------------------------------------------------
describe('resetHandSession: foldedByMe across boundaries', () => {
  it('leave-room preserves the fold → re-joining the SAME hand still escrows', () => {
    armFold(HAND);

    // exactly the leave boundary: ws.leaveRoom() resets the store hand, then
    // the session policy is told this is a leave.
    useStore.getState().resetHand();
    resetHandSession('leave-room');

    reestablish(HAND); // the same live hand is resumed on rejoin
    handle(actionApplied(HAND));

    const keys = sentOf('fold_key');
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ handId: HAND, key: 'a1b2' });
  });

  it('logout discards the fold → no escrow even for the same hand id', () => {
    armFold(HAND);
    resetHandSession('logout');
    reestablish(HAND);

    handle(actionApplied(HAND));

    expect(sentOf('fold_key')).toHaveLength(0);
  });

  it('explicit session end discards the fold → no escrow', () => {
    armFold(HAND);
    resetHandSession('session-end');
    reestablish(HAND);

    handle(actionApplied(HAND));

    expect(sentOf('fold_key')).toHaveLength(0);
  });

  it('a terminal frame retires the fold evidence for that hand', () => {
    armFold(HAND);
    handle(handEnd(HAND)); // terminalHands claim -> foldedByMe for HAND dropped
    socket.send.mockClear();

    handle(actionApplied(HAND));

    expect(sentOf('fold_key')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. The same matrix for the terminal registry persistence.
// ---------------------------------------------------------------------------
describe('resetHandSession: terminal registry persistence', () => {
  it('leave-room keeps a finished hand blocked from reviving', () => {
    useStore.getState().patchHand({ handId: HAND });
    handle(handEnd(HAND));
    socket.send.mockClear();

    resetHandSession('leave-room');
    handle(failed(HAND));

    expect(useStore.getState().hand.settlementFailed).toBeNull();
    expect(sentOf('error')).toHaveLength(0);
  });

  it('logout clears the terminal registry (nothing from the old identity lingers)', () => {
    useStore.getState().patchHand({ handId: HAND });
    handle(handEnd(HAND));

    resetHandSession('logout');
    handle(failed(HAND));

    expect(useStore.getState().hand.settlementFailed?.handId).toBe(HAND);
  });
});
