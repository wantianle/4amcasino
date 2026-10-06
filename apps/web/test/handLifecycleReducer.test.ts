import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { genIdentity } from '@4am/mental-poker';
import type { HandView, LastHandSnap } from '../src/shared/store.ts';
import type {
  LifecycleCtx,
  LifecycleMsg,
  LifecycleOp,
  LifecycleRegistries,
} from '../src/shared/handLifecycleReducer.ts';
import { roomState, handStart } from './helpers/fixtures.ts';

/**
 * Behaviour lock + equivalence evidence for the class-B `handLifecycleReducer`
 * extraction (step 3 of the `handle()` decomposition).
 *
 * Two layers:
 *
 *  1. **Pure-reducer assertions** over `handLifecycleReducer` directly. For each
 *     moved frame they pin the ordered `ops` list, the injected clock reads and
 *     the registry `claims`. These are *representative result assertions* - the
 *     exact `(snapshot, msg) -> claims + ops` contract - NOT a byte-for-byte
 *     old/new diff and NOT a double-execution harness.
 *
 *  2. **Public `handle()` order assertions** that the runner executes the ops in
 *     the order the reducer chose (notably `hand_end`: cue before recap before
 *     hand write). The state outcomes themselves are already covered by
 *     `lifecycleGuards.test.ts` / `settlementFailure.test.ts` and friends.
 */

const socket = vi.hoisted(() => ({
  send: vi.fn(),
  on: vi.fn(),
  consumeResync: vi.fn(() => false),
}));
const sounds = vi.hoisted(() => ({ play: vi.fn() }));
vi.mock('../src/shared/ws.ts', () => ({ wsClient: socket }));
vi.mock('../src/shared/voice.ts', () => ({ voice: { syncPeers: vi.fn(), handleRtc: vi.fn() } }));
vi.mock('../src/shared/sounds.ts', () => ({ play: sounds.play }));

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

const { useStore, emptyHand } = await import('../src/shared/store.ts');
const { handle, act, __resetHandTrackingForTest } = await import('../src/shared/gameClient.ts');
const { handLifecycleReducer } = await import('../src/shared/handLifecycleReducer.ts');

const HAND = 'life-hand';

interface CtxOver {
  hand?: Partial<HandView>;
  lastHand?: LastHandSnap | null;
  room?: LifecycleCtx['room'];
  registries?: LifecycleRegistries;
  userId?: number | null;
  resync?: boolean;
  now?: () => number;
  handKey?: (handId: string) => string | null;
}

function ctx(over: CtxOver = {}): LifecycleCtx {
  return {
    hand: { ...emptyHand, ...over.hand },
    lastHand: over.lastHand ?? null,
    room: over.room ?? null,
    registries:
      over.registries ??
      ({ terminalHands: new Set(), endedHands: new Set(), foldedByMe: new Set() } as LifecycleRegistries),
    userId: over.userId === undefined ? 1 : over.userId,
    resync: over.resync ?? false,
    now: over.now ?? (() => 1000),
    handKey: over.handKey ?? (() => null),
  };
}

const opKey = (op: LifecycleOp): string =>
  'store' in op ? `store:${op.store}` : `effect:${op.effect}`;

const mySeats = [{ seat: 0, userId: 1, username: 'me', publicKey: '', stack: 1000 }];

function signIn(userId = 1): void {
  useStore.setState({
    auth: { token: 't', userId, username: 'me', identity: genIdentity() },
    wsConnected: true,
  });
}

const handEnd = (handId: string, deltas: { seat: number; delta: number }[] = []): LifecycleMsg => ({
  t: 'hand_end',
  handId,
  head: 'head',
  stacks: [],
  deltas,
});
const failed = (handId: string, attempt = 1, retrying = false): LifecycleMsg => ({
  t: 'settlement_failed',
  handId,
  reason: 'busy',
  attempt,
  retrying,
});
const recovery = (
  handId: string,
  status: 'committed' | 'aborted' | 'unresolved',
): LifecycleMsg => ({ t: 'hand_recovery', handId, status });

beforeEach(() => {
  socket.send.mockClear();
  socket.consumeResync.mockReset();
  socket.consumeResync.mockReturnValue(false);
  sounds.play.mockReset();
  local.clear();
  session.clear();
  __resetHandTrackingForTest();
  useStore.setState({ lastHand: null, errors: [] });
  useStore.getState().resetHand();
});

afterAll(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// Pure reducer: hand_end
// ---------------------------------------------------------------------------
describe('handLifecycleReducer: hand_end', () => {
  const live: Partial<HandView> = { handId: HAND, seats: mySeats, boards: [[7, 8, 9]] };

  it('claims both registries and orders ops [cue, recap, hand]', () => {
    const now = vi.fn(() => 4242);
    const r = handLifecycleReducer(
      ctx({ hand: live, room: roomState(1), now }),
      handEnd(HAND, [{ seat: 0, delta: 5 }]),
    );
    expect(r.claims).toEqual({ terminalHands: HAND, endedHands: HAND });
    expect(r.ops.map(opKey)).toEqual(['effect:sound', 'store:lastHand', 'store:hand']);
    expect(r.ops[0]).toMatchObject({ effect: 'sound', name: 'win' });
    const snap = (r.ops[1] as Extract<LifecycleOp, { store: 'lastHand' }>).set;
    expect(snap).toMatchObject({ handId: HAND, ts: 4242, boards: [[7, 8, 9]], deltas: [{ seat: 0, delta: 5 }] });
    // `lost` cue when this seat's delta is not positive
    expect(now).toHaveBeenCalledTimes(1);
  });

  it('plays the loss cue when my delta is zero or negative', () => {
    const r = handLifecycleReducer(ctx({ hand: live }), handEnd(HAND, [{ seat: 0, delta: -3 }]));
    expect(r.ops[0]).toMatchObject({ effect: 'sound', name: 'end' });
  });

  it('a stale hand still claims terminal/ended but writes nothing', () => {
    const r = handLifecycleReducer(
      ctx({ hand: { ...emptyHand, handId: 'B' } }),
      handEnd('A'),
    );
    expect(r.claims).toEqual({ terminalHands: 'A', endedHands: 'A' });
    expect(r.ops).toEqual([]);
  });

  it('a stale terminal clears a settlement failure naming its own hand only', () => {
    const r = handLifecycleReducer(
      ctx({
        hand: {
          ...emptyHand,
          handId: 'B',
          settlementFailed: {
            handId: 'A',
            reason: 'x',
            attempt: 1,
            retrying: false,
            retryRequestedAt: null,
            manualRetry: false,
            since: 1,
            orphaned: false,
          },
        },
      }),
      handEnd('A'),
    );
    expect(r.ops).toEqual([{ store: 'hand', patch: { settlementFailed: null } }]);
  });
});

// ---------------------------------------------------------------------------
// Pure reducer: hand_abort / hand_recovery
// ---------------------------------------------------------------------------
describe('handLifecycleReducer: hand_abort', () => {
  it('claims both registries and patches the live hand terminal', () => {
    const r = handLifecycleReducer(
      ctx({ hand: { ...emptyHand, handId: HAND } }),
      { t: 'hand_abort', handId: HAND, reason: 'x', blamedSeat: null },
    );
    expect(r.claims).toEqual({ terminalHands: HAND, endedHands: HAND });
    expect(r.ops.map(opKey)).toEqual(['store:hand']);
    expect((r.ops[0] as Extract<LifecycleOp, { store: 'hand'; patch: Partial<HandView> }>).patch).toMatchObject({
      handRecovery: null,
      settlementFailed: null,
    });
  });
});

describe('handLifecycleReducer: hand_recovery', () => {
  it('committed on a live hand claims terminal and writes the recovered recap', () => {
    const r = handLifecycleReducer(
      ctx({ hand: { ...emptyHand, handId: HAND } }),
      recovery(HAND, 'committed'),
    );
    expect(r.claims).toEqual({ terminalHands: HAND });
    const patch = (r.ops[0] as Extract<LifecycleOp, { store: 'hand'; patch: Partial<HandView> }>).patch;
    expect(patch.result).toMatchObject({ handId: HAND, recovered: true });
    expect(patch.handRecovery).toBeNull();
  });

  it('a late committed answer for an already-terminal hand claims but writes nothing', () => {
    const r = handLifecycleReducer(
      ctx({
        hand: { ...emptyHand, handId: HAND },
        registries: { terminalHands: new Set([HAND]), endedHands: new Set(), foldedByMe: new Set() },
      }),
      recovery(HAND, 'committed'),
    );
    expect(r.claims).toEqual({ terminalHands: HAND });
    expect(r.ops).toEqual([]);
  });

  it('aborted claims terminal and writes the refund terminal', () => {
    const r = handLifecycleReducer(
      ctx({ hand: { ...emptyHand, handId: HAND } }),
      recovery(HAND, 'aborted'),
    );
    expect(r.claims).toEqual({ terminalHands: HAND });
    expect((r.ops[0] as Extract<LifecycleOp, { store: 'hand'; patch: Partial<HandView> }>).patch).toMatchObject({
      abort: { handId: HAND },
      result: null,
    });
  });

  it('unresolved never claims terminal, even when it writes the admin state', () => {
    const r = handLifecycleReducer(
      ctx({ hand: { ...emptyHand, handId: HAND } }),
      recovery(HAND, 'unresolved'),
    );
    expect(r.claims).toEqual({});
    expect((r.ops[0] as Extract<LifecycleOp, { store: 'hand'; patch: Partial<HandView> }>).patch).toMatchObject({
      handRecovery: 'unresolved',
    });
  });

  it('unresolved does not claim terminal and is inert for an already-terminal hand', () => {
    const r = handLifecycleReducer(
      ctx({
        registries: { terminalHands: new Set([HAND]), endedHands: new Set(), foldedByMe: new Set() },
      }),
      recovery(HAND, 'unresolved'),
    );
    expect(r).toEqual({ claims: {}, ops: [] });
  });
});

// ---------------------------------------------------------------------------
// Pure reducer: settlement_failed
// ---------------------------------------------------------------------------
describe('handLifecycleReducer: settlement_failed', () => {
  it('guards on the terminal registry', () => {
    const r = handLifecycleReducer(
      ctx({
        registries: { terminalHands: new Set([HAND]), endedHands: new Set(), foldedByMe: new Set() },
      }),
      failed(HAND),
    );
    expect(r).toEqual({ claims: {}, ops: [] });
  });

  it('guards on a superseded live hand', () => {
    const r = handLifecycleReducer(
      ctx({ hand: { ...emptyHand, handId: 'newer' } }),
      failed(HAND),
    );
    expect(r).toEqual({ claims: {}, ops: [] });
  });

  it('writes the banner then the toast, reading the clock once', () => {
    const now = vi.fn(() => 777);
    const r = handLifecycleReducer(ctx({ hand: { ...emptyHand, handId: HAND }, now }), failed(HAND, 3));
    expect(r.ops.map(opKey)).toEqual(['store:hand', 'store:errors']);
    expect((r.ops[0] as Extract<LifecycleOp, { store: 'hand'; patch: Partial<HandView> }>).patch.settlementFailed).toMatchObject({
      handId: HAND,
      attempt: 3,
      since: 777,
      orphaned: false,
    });
    expect(typeof (r.ops[1] as Extract<LifecycleOp, { store: 'errors' }>).push).toBe('string');
    expect(now).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Pure reducer: transcript_entry / need_keys
// ---------------------------------------------------------------------------
describe('handLifecycleReducer: transcript_entry + need_keys', () => {
  it('a settlement/abort transcript claims endedHands; other types are inert', () => {
    expect(
      handLifecycleReducer(ctx(), { t: 'transcript_entry', handId: HAND, seq: 1, type: 'settlement', from: '', head: '' }),
    ).toEqual({ claims: { endedHands: HAND }, ops: [] });
    expect(
      handLifecycleReducer(ctx(), { t: 'transcript_entry', handId: HAND, seq: 2, type: 'chat', from: '', head: '' }),
    ).toEqual({ claims: {}, ops: [] });
  });

  it('need_keys emits the reveal only for an endedHands hand', () => {
    const ended = handLifecycleReducer(
      ctx({ registries: { terminalHands: new Set(), endedHands: new Set([HAND]), foldedByMe: new Set() } }),
      { t: 'need_keys', handId: HAND },
    );
    expect(ended.ops).toEqual([{ effect: 'reveal-key', handId: HAND }]);
    expect(handLifecycleReducer(ctx(), { t: 'need_keys', handId: HAND })).toEqual({ claims: {}, ops: [] });
  });
});

// ---------------------------------------------------------------------------
// Pure reducer: action_applied / fold_key
// ---------------------------------------------------------------------------
function betting(seats: { seat: number; folded?: boolean }[]) {
  return {
    street: 'preflop' as const,
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

const foldMsg = (): LifecycleMsg => ({
  t: 'action_applied',
  handId: HAND,
  seat: 0,
  action: { type: 'fold' },
  auto: false,
});

describe('handLifecycleReducer: action_applied fold_key', () => {
  const foldedHand: Partial<HandView> = {
    handId: HAND,
    seats: mySeats,
    betting: betting([{ seat: 0 }, { seat: 1 }, { seat: 2 }]),
  };
  const foldedByMe = { terminalHands: new Set<string>(), endedHands: new Set<string>(), foldedByMe: new Set([HAND]) };

  it('a fold this browser made, with a key, plays then escrows then patches', () => {
    const r = handLifecycleReducer(
      ctx({ hand: foldedHand, registries: foldedByMe, handKey: () => 'a1b2' }),
      foldMsg(),
    );
    expect(r.ops.map(opKey)).toEqual(['effect:sound', 'effect:fold-key', 'store:hand']);
    expect(r.ops[1]).toMatchObject({ effect: 'fold-key', handId: HAND, key: 'a1b2' });
  });

  it('a fold this browser made but with no key plays the cue and stops (no patch)', () => {
    const r = handLifecycleReducer(ctx({ hand: foldedHand, registries: foldedByMe }), foldMsg());
    expect(r.ops.map(opKey)).toEqual(['effect:sound']);
  });

  it('a server-reported fold this browser never made only cues and patches', () => {
    const r = handLifecycleReducer(ctx({ hand: foldedHand, handKey: () => 'a1b2' }), foldMsg());
    expect(r.ops.map(opKey)).toEqual(['effect:sound', 'store:hand']);
  });

  it('the last fold does not escrow', () => {
    const r = handLifecycleReducer(
      ctx({
        hand: { ...foldedHand, betting: betting([{ seat: 0 }, { seat: 1 }]) },
        registries: foldedByMe,
        handKey: () => 'a1b2',
      }),
      foldMsg(),
    );
    expect(r.ops.map(opKey)).toEqual(['effect:sound', 'store:hand']);
  });
});

// ---------------------------------------------------------------------------
// Pure reducer: hand_start
// ---------------------------------------------------------------------------
describe('handLifecycleReducer: hand_start', () => {
  it('fresh + seated: reset, prune, shuffle, key-commit in that order', () => {
    const r = handLifecycleReducer(ctx({ hand: { ...emptyHand, handId: 'old' } }), handStart(HAND));
    expect(r.ops.map(opKey)).toEqual([
      'store:hand',
      'effect:prune-hand-keys',
      'effect:sound',
      'effect:key-commit',
    ]);
    const first = r.ops[0] as Extract<LifecycleOp, { store: 'hand'; reset: Partial<HandView> }>;
    expect(first.reset).toMatchObject({ handId: HAND, buttonSeat: 0 });
  });

  it('carries a settlement failure that names this hand', () => {
    const carry = {
      handId: HAND,
      reason: 'x',
      attempt: 1,
      retrying: false,
      retryRequestedAt: null,
      manualRetry: false,
      since: 1,
      orphaned: false,
    };
    const r = handLifecycleReducer(
      ctx({ hand: { ...emptyHand, handId: null, settlementFailed: carry } }),
      handStart(HAND),
    );
    const first = r.ops[0] as Extract<LifecycleOp, { store: 'hand'; reset: Partial<HandView> }>;
    expect(first.reset.settlementFailed).toBe(carry);
  });

  it('re-sent for the same hand: no reset, no cue, but still commits a key', () => {
    const r = handLifecycleReducer(ctx({ hand: { ...emptyHand, handId: HAND } }), handStart(HAND));
    expect(r.ops.map(opKey)).toEqual(['effect:key-commit']);
  });

  it('a spectator does not commit a key', () => {
    const r = handLifecycleReducer(ctx({ userId: 99 }), handStart(HAND));
    expect(r.ops.map(opKey)).toEqual(['store:hand', 'effect:prune-hand-keys', 'effect:sound']);
  });
});

// ---------------------------------------------------------------------------
// Pure reducer: room_state resync
// ---------------------------------------------------------------------------
describe('handLifecycleReducer: room_state', () => {
  it('sets the room first and syncs peers last', () => {
    const r = handLifecycleReducer(ctx(), roomState(1, true));
    expect(r.ops.map(opKey)).toEqual(['store:room', 'effect:voice-sync']);
  });

  it('restores the countdown when the frame carries autoDealAt', () => {
    const msg = { ...roomState(1, true), autoDealAt: 5000 };
    const r = handLifecycleReducer(ctx(), msg);
    expect(r.ops.map(opKey)).toEqual(['store:room', 'store:hand', 'effect:voice-sync']);
    expect((r.ops[1] as Extract<LifecycleOp, { store: 'hand'; patch: Partial<HandView> }>).patch).toEqual({
      autoDealAt: 5000,
      readyCheck: null,
    });
  });

  it('resync with no live hand synthesises a refund abort and drops the key', () => {
    const r = handLifecycleReducer(
      ctx({ hand: { ...emptyHand, handId: HAND }, resync: true }),
      roomState(1, false),
    );
    expect(r.ops.map(opKey)).toEqual(['store:room', 'store:hand', 'effect:drop-hand-key', 'effect:voice-sync']);
    expect((r.ops[1] as Extract<LifecycleOp, { store: 'hand'; patch: Partial<HandView> }>).patch).toMatchObject({
      abort: { handId: HAND },
      settlementFailed: null,
    });
  });

  it('resync with a pending failure orphans it instead of aborting', () => {
    const r = handLifecycleReducer(
      ctx({
        hand: {
          ...emptyHand,
          handId: HAND,
          settlementFailed: {
            handId: HAND,
            reason: 'x',
            attempt: 1,
            retrying: true,
            retryRequestedAt: null,
            manualRetry: false,
            since: 1,
            orphaned: false,
          },
        },
        resync: true,
      }),
      roomState(1, false),
    );
    expect(r.ops.map(opKey)).toEqual(['store:room', 'store:hand', 'effect:voice-sync']);
    expect((r.ops[1] as Extract<LifecycleOp, { store: 'hand'; patch: Partial<HandView> }>).patch).toMatchObject({
      settlementFailed: { orphaned: true, retrying: false },
    });
  });

  it('resync with a durable unresolved answer keeps the state and only stops the timer', () => {
    const r = handLifecycleReducer(
      ctx({ hand: { ...emptyHand, handId: HAND, handRecovery: 'unresolved' }, resync: true }),
      roomState(1, false),
    );
    expect((r.ops[1] as Extract<LifecycleOp, { store: 'hand'; patch: Partial<HandView> }>).patch).toEqual({
      deadline: null,
      baseDeadline: null,
    });
  });

  it('a non-resync room_state never fabricates an abort', () => {
    const r = handLifecycleReducer(
      ctx({ hand: { ...emptyHand, handId: HAND }, resync: false }),
      roomState(1, false),
    );
    expect(r.ops.map(opKey)).toEqual(['store:room', 'effect:voice-sync']);
  });
});

// ---------------------------------------------------------------------------
// Public handle(): the runner preserves the chosen op order
// ---------------------------------------------------------------------------
function recordOrder(fn: () => void): string[] {
  const order: string[] = [];
  sounds.play.mockImplementation(() => {
    order.push('play');
  });
  const unsub = useStore.subscribe(() => {
    order.push('write');
  });
  try {
    fn();
  } finally {
    unsub();
  }
  return order;
}

describe('handle() op ordering (equivalence evidence)', () => {
  it('hand_end cues before freezing the recap and the hand (play, write, write)', () => {
    useStore.getState().patchHand({ handId: HAND, seats: mySeats });
    const order = recordOrder(() => handle(handEnd(HAND, [{ seat: 0, delta: 1 }])));
    expect(order).toEqual(['play', 'write', 'write']);
    expect(useStore.getState().lastHand?.handId).toBe(HAND);
    expect(useStore.getState().hand.result?.handId).toBe(HAND);
  });

  it('a fresh hand_start applies the reset before the shuffle cue', () => {
    signIn();
    const order = recordOrder(() => handle(handStart(HAND)));
    expect(order).toEqual(['write', 'play']);
    expect(socket.send.mock.calls.map(([m]) => (m as { t: string }).t)).toContain('key_commit');
  });

  it('settlement_failed writes the banner then the toast (two writes)', () => {
    const order = recordOrder(() => handle(failed(HAND)));
    expect(order).toEqual(['write', 'write']);
    expect(useStore.getState().hand.settlementFailed?.handId).toBe(HAND);
    expect(useStore.getState().errors.length).toBeGreaterThan(0);
  });

  it('action_applied fold_key fires after the cue, before the lastActions write', () => {
    local.setItem('4am/handkey/' + HAND, 'a1b2');
    signIn();
    useStore.getState().patchHand({
      handId: HAND,
      seats: mySeats,
      betting: betting([{ seat: 0 }, { seat: 1 }, { seat: 2 }]),
    });
    act({ type: 'fold' });
    socket.send.mockClear();
    const order = recordOrder(() => handle(foldMsg()));
    expect(order).toEqual(['play', 'write']);
    expect(socket.send.mock.calls.map(([m]) => (m as { t: string }).t)).toEqual(['fold_key']);
  });
});
