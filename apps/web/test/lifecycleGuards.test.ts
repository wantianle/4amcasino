import { beforeEach, describe, expect, it, vi } from 'vitest';
import { genIdentity } from '@4am/mental-poker';
import type { BettingState, ServerMsg } from '@4am/shared';
import { roomState, handStart } from './helpers/fixtures.ts';

/**
 * Lifecycle guardrails (step 3 of the `gameClient.handle()` reducer extraction).
 *
 * The terminal/recovery/reconnect frames (`room_state` replay, `hand_start`,
 * `settlement_failed`, `hand_end`, `hand_abort`, `hand_recovery`,
 * `transcript_entry`, `need_keys`, `action_applied`/`fold_key`) depend on
 * module-level registries and explicit ordering, so they cannot be extracted to
 * a pure reducer without first pinning the observable invariants. Every case
 * below drives the PUBLIC `handle()` and asserts a user-visible outcome; none
 * calls an internal helper.
 *
 * The three module-level sets are reset per case with
 * `__resetHandTrackingForTest()` (production never resets them).
 */

const socket = vi.hoisted(() => ({
  send: vi.fn(),
  on: vi.fn(),
  consumeResync: vi.fn(() => false),
}));
vi.mock('../src/shared/ws.ts', () => ({ wsClient: socket }));
vi.mock('../src/shared/voice.ts', () => ({ voice: { syncPeers: vi.fn(), handleRtc: vi.fn() } }));
vi.mock('../src/shared/sounds.ts', () => ({ play: vi.fn() }));

/** In-memory Web Storage so `handKeyFor`/`createHandKey` behave like a browser
 *  (the shared stub in the other suites is a permanent no-op, so a key can
 *  never be read back). */
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
const { handle, act, __resetHandTrackingForTest } = await import('../src/shared/gameClient.ts');

const KEY_PREFIX = '4am/handkey/';
const HAND = 'guard-hand';
const HOST = 1;

function seedKey(handId: string, hex: string): void {
  local.setItem(KEY_PREFIX + handId, hex);
}

const failed = (handId: string, attempt = 1, retrying = false): ServerMsg => ({
  t: 'settlement_failed',
  handId,
  reason: 'SQLITE_BUSY: database is locked',
  attempt,
  retrying,
});
const handEnd = (handId: string): ServerMsg => ({
  t: 'hand_end',
  handId,
  head: 'head',
  stacks: [],
  deltas: [],
});
const handAbort = (handId: string): ServerMsg => ({
  t: 'hand_abort',
  handId,
  reason: 'server-abort',
  blamedSeat: null,
});
const handRecovery = (
  handId: string,
  status: 'committed' | 'aborted' | 'unresolved',
): ServerMsg => ({ t: 'hand_recovery', handId, status });
const actionApplied = (handId: string, seat: number): ServerMsg => ({
  t: 'action_applied',
  handId,
  seat,
  action: { type: 'fold' },
  auto: false,
});

function sentOf(type: string): Record<string, unknown>[] {
  return socket.send.mock.calls
    .map(([m]) => m as Record<string, unknown>)
    .filter((m) => m.t === type);
}

/** Minimal `BettingState`; only `seats[].folded`/`seat` matter to the fold_key gate. */
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

const mySeats = [{ seat: 0, userId: HOST, username: 'me', publicKey: '', stack: 1000 }];

function signIn(userId = HOST, wsConnected = true): void {
  useStore.setState({
    auth: { token: 't', userId, username: 'me', identity: genIdentity() },
    wsConnected,
  });
}

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
// 1. A late replay must never roll a terminal hand back to a live/failed state.
// ---------------------------------------------------------------------------
describe('invariant 1 - a late replay does not revive a terminal hand', () => {
  it('a late settlement_failed after hand_end is rejected and adds no error toast', () => {
    useStore.getState().patchHand({ handId: HAND });
    handle(handEnd(HAND));
    expect(useStore.getState().hand.result?.handId).toBe(HAND);
    const errorsBefore = useStore.getState().errors.length;

    handle(failed(HAND, 2, false));

    const h = useStore.getState().hand;
    expect(h.settlementFailed).toBeNull();
    expect(h.result?.handId).toBe(HAND); // still the committed terminal
    expect(useStore.getState().errors.length).toBe(errorsBefore); // pushError never reached
  });

  it('a late hand_recovery(committed) after hand_end leaves the committed recap intact', () => {
    useStore.getState().patchHand({ handId: HAND });
    handle(handEnd(HAND));
    const before = useStore.getState().hand.result;

    handle(handRecovery(HAND, 'committed'));

    const h = useStore.getState().hand;
    expect(h.result).toEqual(before);
    expect(h.result?.recovered).toBeUndefined(); // not replaced by the status-only fallback
    expect(h.abort).toBeNull();
  });

  it('a reconnect room_state replay after hand_end fabricates no refund abort', () => {
    useStore.getState().patchHand({ handId: HAND });
    handle(handEnd(HAND));

    socket.consumeResync.mockReturnValue(true);
    handle(roomState(HOST, false)); // server no longer has the hand

    const h = useStore.getState().hand;
    expect(h.result?.handId).toBe(HAND);
    expect(h.abort).toBeNull();
    expect(h.settlementFailed).toBeNull();
  });

  // KNOWN DEFECT (reported, NOT fixed here). `hand_recovery` has no
  // `terminalHands` guard on its aborted/committed branches, so a late durable
  // answer can overwrite a real terminal frame. `it.fails` keeps the suite green
  // while pinning the desired behaviour - it turns RED the day the guard lands,
  // which is the signal to promote it back to `it`.
  it.fails('a late hand_recovery(aborted) after hand_end does not roll the result back', () => {
    useStore.getState().patchHand({ handId: HAND });
    handle(handEnd(HAND));

    handle(handRecovery(HAND, 'aborted'));

    const h = useStore.getState().hand;
    expect(h.result?.handId).toBe(HAND);
    expect(h.abort).toBeNull();
  });

  // KNOWN DEFECT (reported, NOT fixed here). The `committed` branch guards only
  // on `!h.result`, so a real `hand_abort` (result already null) is replaced by
  // a recovered success. A `terminalHands.has` guard would still let a
  // synthesised room_state abort be superseded, but not a real one.
  it.fails('a late hand_recovery(committed) after hand_abort does not overwrite the abort', () => {
    useStore.getState().patchHand({ handId: HAND });
    handle(handAbort(HAND));
    expect(useStore.getState().hand.abort?.handId).toBe(HAND);

    handle(handRecovery(HAND, 'committed'));

    const h = useStore.getState().hand;
    expect(h.abort?.handId).toBe(HAND);
    expect(h.result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Cross-hand isolation: hand A's late frames must not touch hand B.
// ---------------------------------------------------------------------------
describe('invariant 2 - cross-hand isolation', () => {
  it('old-hand terminal/failure frames leave the new hand and its recap untouched', () => {
    useStore.getState().patchHand({ handId: 'A' });
    handle(handEnd('A'));
    handle(handStart('B'));
    // Clear the recap so any stale old-hand terminal would visibly re-freeze one.
    useStore.setState({ lastHand: null });

    handle(handEnd('A'));
    handle(failed('A', 3, false));
    handle(handRecovery('A', 'committed'));
    handle(handRecovery('A', 'aborted'));
    handle(handRecovery('A', 'unresolved'));

    const h = useStore.getState().hand;
    expect(h.handId).toBe('B');
    expect(h.result).toBeNull();
    expect(h.abort).toBeNull();
    expect(h.settlementFailed).toBeNull();
    expect(h.handRecovery).toBeNull();
    // A replayed old hand_end must not freeze/refresh a recap on top of B
    expect(useStore.getState().lastHand).toBeNull();
  });

  it("an old hand's failure does not suppress the new hand's own failure banner", () => {
    useStore.getState().patchHand({ handId: 'A' });
    handle(handEnd('A'));
    handle(handStart('B'));

    handle(failed('B', 1, false));

    expect(useStore.getState().hand.settlementFailed?.handId).toBe('B');
  });
});

// ---------------------------------------------------------------------------
// 3. terminalHands gate: a hand already terminal ignores a replayed failure.
// ---------------------------------------------------------------------------
describe('invariant 3 - terminalHands blocks a replayed settlement_failed', () => {
  it('after hand_end the guard stops the banner reopening (no toast)', () => {
    useStore.getState().patchHand({ handId: HAND });
    handle(handEnd(HAND));
    const errors = useStore.getState().errors.length;

    handle(failed(HAND, 5, true));

    expect(useStore.getState().hand.settlementFailed).toBeNull();
    expect(useStore.getState().errors.length).toBe(errors);
  });

  it('after hand_abort the guard stops the banner reopening', () => {
    useStore.getState().patchHand({ handId: HAND });
    handle(handAbort(HAND));
    const errors = useStore.getState().errors.length;

    handle(failed(HAND, 4, false));

    expect(useStore.getState().hand.settlementFailed).toBeNull();
    expect(useStore.getState().errors.length).toBe(errors);
  });

  it('a durable committed recovery is enough to make the hand terminal', () => {
    useStore.getState().patchHand({ handId: HAND });
    handle(handRecovery(HAND, 'committed'));

    handle(failed(HAND, 1, false));

    expect(useStore.getState().hand.settlementFailed).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. hand_end registers the terminal BEFORE its early returns.
// ---------------------------------------------------------------------------
describe('invariant 4 - a terminal is registered before the stale-hand early return', () => {
  it('a terminal for a stale hand still blocks a later failure for that hand', () => {
    // Current hand is B, so the frame is a stale one for A.
    useStore.getState().patchHand({ handId: 'B' });
    handle(handEnd('A'));
    // Clear the live hand: now ONLY the registry (not the handId guard) can block.
    useStore.getState().resetHand();
    expect(useStore.getState().hand.handId).toBeNull();

    handle(failed('A', 1, false));

    expect(useStore.getState().hand.settlementFailed).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. foldedByMe <-> fold_key escrow.
// ---------------------------------------------------------------------------
describe('invariant 5 - fold_key is escrowed only for a fold this browser made', () => {
  it('a fold this browser made escrows the hand key on action_applied', () => {
    seedKey(HAND, 'a1b2');
    useStore.getState().patchHand({
      handId: HAND,
      seats: mySeats,
      betting: betting([{ seat: 0 }, { seat: 1 }, { seat: 2 }]),
    });
    act({ type: 'fold' });
    socket.send.mockClear();

    handle(actionApplied(HAND, 0));

    const keys = sentOf('fold_key');
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ handId: HAND, key: 'a1b2' });
  });

  it('a fold the server reports but this browser never made does not escrow the key', () => {
    seedKey(HAND, 'a1b2');
    useStore.getState().patchHand({
      handId: HAND,
      seats: mySeats,
      betting: betting([{ seat: 0 }, { seat: 1 }, { seat: 2 }]),
    });
    // deliberately NO act({ type: 'fold' }) -> foldedByMe lacks HAND
    socket.send.mockClear();

    handle(actionApplied(HAND, 0));

    expect(sentOf('fold_key')).toHaveLength(0);
  });

  it('the last fold does not escrow: no hand remains to play without me', () => {
    seedKey(HAND, 'a1b2');
    useStore.getState().patchHand({
      handId: HAND,
      seats: mySeats,
      betting: betting([{ seat: 0 }, { seat: 1 }]), // one opponent left
    });
    act({ type: 'fold' });
    socket.send.mockClear();

    handle(actionApplied(HAND, 0));

    expect(sentOf('fold_key')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. need_keys only gets the audit key once the hand is in `endedHands`.
// ---------------------------------------------------------------------------
describe('invariant 6 - need_keys is answered only for an ended hand', () => {
  it('an in-progress hand does not answer need_keys', () => {
    seedKey(HAND, 'a1b2');
    useStore.getState().patchHand({ handId: HAND, seats: mySeats });
    socket.send.mockClear();

    handle({ t: 'need_keys', handId: HAND });

    expect(sentOf('reveal_key')).toHaveLength(0);
  });

  it('after hand_end the audit key is revealed', () => {
    seedKey(HAND, 'a1b2');
    useStore.getState().patchHand({ handId: HAND });
    handle(handEnd(HAND)); // endedHands.add
    socket.send.mockClear();

    handle({ t: 'need_keys', handId: HAND });

    const keys = sentOf('reveal_key');
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ handId: HAND, key: 'a1b2' });
  });

  it('terminalHands via a committed recovery is NOT the same as endedHands', () => {
    // The safety gate is `endedHands` (showdown/hand_end/abort/settlement
    // transcript), not the terminal registry. A status-only committed answer
    // marks the hand terminal but must not itself authorise handing over keys.
    seedKey(HAND, 'a1b2');
    useStore.getState().patchHand({ handId: HAND });
    handle(handRecovery(HAND, 'committed'));
    socket.send.mockClear();

    handle({ t: 'need_keys', handId: HAND });

    expect(sentOf('reveal_key')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7. resetHand() must not clear the module-level terminal registry.
// ---------------------------------------------------------------------------
describe('invariant 7 - resetHand does not clear the terminal registry', () => {
  it('a replayed failure for a finished hand stays blocked after resetHand', () => {
    useStore.getState().patchHand({ handId: HAND });
    handle(handEnd(HAND));
    useStore.getState().resetHand();
    expect(useStore.getState().hand.handId).toBeNull();

    handle(failed(HAND, 1, false));

    expect(useStore.getState().hand.settlementFailed).toBeNull();
  });

  it('after hand_start for the next hand a late old-hand terminal does not touch it', () => {
    useStore.getState().patchHand({ handId: 'old' });
    handle(handEnd('old'));
    handle(handStart('new'));
    const last = useStore.getState().lastHand;
    useStore.getState().patchHand({ result: null });

    handle(handEnd('old'));

    const h = useStore.getState().hand;
    expect(h.handId).toBe('new');
    expect(h.result).toBeNull();
    expect(useStore.getState().lastHand).toEqual(last);
  });
});
