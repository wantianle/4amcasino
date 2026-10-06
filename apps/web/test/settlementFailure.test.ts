import { beforeEach, describe, expect, it, vi } from 'vitest';
import { genIdentity } from '@4am/mental-poker';
import type { ServerMsg } from '@4am/shared';
import { roomState, handStart } from './helpers/fixtures.ts';

const socket = vi.hoisted(() => ({
  send: vi.fn(),
  on: vi.fn(),
  consumeResync: vi.fn(() => false),
}));
vi.mock('../src/shared/ws.ts', () => ({ wsClient: socket }));
vi.mock('../src/shared/voice.ts', () => ({ voice: { syncPeers: vi.fn(), handleRtc: vi.fn() } }));
vi.mock('../src/shared/sounds.ts', () => ({ play: vi.fn() }));
const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
vi.stubGlobal('window', { localStorage: storage, dispatchEvent: () => {} });
vi.stubGlobal('localStorage', storage);
vi.stubGlobal('CustomEvent', class { constructor(public type: string) {} });
/** `hand_start` prunes per-hand session keys; the real client always has this. */
const session = {
  length: 0,
  key: () => null,
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
vi.stubGlobal('sessionStorage', session);

const { useStore } = await import('../src/shared/store.ts');
const { handle, retrySettlement, __resetHandTrackingForTest } = await import(
  '../src/shared/gameClient.ts'
);
const {
  settlementFailureCopy,
  settlementFailurePhase,
  SETTLE_RETRY_STALL_MS,
  SERVER_RETRY_STALL_MS,
} = await import('../src/features/table/settlementFailure.tsx');

/** Capture the single frame handler gameClient registers with the socket. */
socket.on.mockClear();
const { bindGameClient } = await import('../src/shared/gameClient.ts');
bindGameClient();
const receive = socket.on.mock.calls[0]![0] as (message: ServerMsg) => void;

const HAND = 'settle-hand';
const HOST = 1;
const GUEST = 2;

const failed = (attempt = 1, retrying = false): ServerMsg => ({
  t: 'settlement_failed',
  handId: HAND,
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

/** A `hand_recovery` answer, as the server sends it on reconnect. */
const handRecovery = (
  handId: string,
  status: 'committed' | 'aborted' | 'unresolved',
): ServerMsg => ({ t: 'hand_recovery', handId, status });

function signIn(userId: number, hostId: number, wsConnected = true) {
  useStore.setState({
    auth: { token: 't', userId, username: 'me', identity: genIdentity() },
    room: roomState(hostId),
    wsConnected,
  });
}

beforeEach(() => {
  socket.send.mockClear();
  socket.consumeResync.mockReset();
  socket.consumeResync.mockReturnValue(false);
  __resetHandTrackingForTest();
  useStore.getState().resetHand();
  signIn(HOST, HOST);
  useStore.getState().patchHand({ handId: HAND });
});

describe('gameClient settlement_failed', () => {
  it('stores the failure state from the frame and never stays silent', () => {
    receive(failed(3, false));
    const f = useStore.getState().hand.settlementFailed;
    expect(f).toMatchObject({
      handId: HAND,
      reason: 'SQLITE_BUSY: database is locked',
      attempt: 3,
      retrying: false,
      retryRequestedAt: null,
      manualRetry: false,
      orphaned: false,
    });
    expect(typeof f!.since).toBe('number');
    expect(useStore.getState().errors.length).toBeGreaterThan(0);
  });

  it('keeps the auto-retry phase while the server still owns the retry', () => {
    receive(failed(2, true));
    const f = useStore.getState().hand.settlementFailed!;
    expect(settlementFailurePhase(f, f.since)).toBe('server-retrying');
    // the server is retrying on its own: no manual button yet
    expect(settlementFailureCopy('server-retrying', true, f.attempt).canRetry).toBe(false);
  });

  it('ignores a frame for a hand that already moved on', () => {
    useStore.getState().patchHand({ handId: 'newer-hand' });
    receive(failed(1, false));
    expect(useStore.getState().hand.settlementFailed).toBeNull();
  });

  it('a server retry that never reports again becomes host-recoverable', () => {
    receive(failed(2, true));
    const f = useStore.getState().hand.settlementFailed!;
    // within the server's retry window it is still "leave it alone"
    expect(settlementFailurePhase(f, f.since)).toBe('server-retrying');
    // no further frame arrives: the server-owned retry is presumed lost
    expect(settlementFailurePhase(f, f.since + SERVER_RETRY_STALL_MS + 1)).toBe(
      'server-retry-stalled',
    );
    const host = settlementFailureCopy('server-retry-stalled', true, f.attempt);
    expect(host.canRetry).toBe(true);
    expect(host.pending).toBe(false);
    const guest = settlementFailureCopy('server-retry-stalled', false, f.attempt);
    expect(guest.canRetry).toBe(false);
    expect(guest.waitingForHost).toBe(true);
  });

  it('clears the banner when hand_end arrives while the server was retrying', () => {
    receive(failed(2, true));
    expect(useStore.getState().hand.settlementFailed).not.toBeNull();
    receive(handEnd(HAND));
    expect(useStore.getState().hand.settlementFailed).toBeNull();
    expect(useStore.getState().hand.result).not.toBeNull();
  });
});

describe('host vs non-host recovery branches', () => {
  it('offers the retry control to the host only, and tells others to wait', () => {
    receive(failed(5, false));
    const f = useStore.getState().hand.settlementFailed!;
    const phase = settlementFailurePhase(f, Date.now());
    expect(phase).toBe('frozen');

    const host = settlementFailureCopy(phase!, true, f.attempt);
    const guest = settlementFailureCopy(phase!, false, f.attempt);
    expect(host.canRetry).toBe(true);
    expect(host.waitingForHost).toBe(false);
    expect(guest.canRetry).toBe(false);
    expect(guest.waitingForHost).toBe(true);
    expect(host.detail).not.toBe(guest.detail);
  });

  it('a non-host calling retrySettlement sends no frame and changes no state', () => {
    signIn(GUEST, HOST);
    receive(failed(5, false));
    const before = useStore.getState().hand.settlementFailed!;
    retrySettlement();
    expect(socket.send).not.toHaveBeenCalled();
    const after = useStore.getState().hand.settlementFailed!;
    expect(after.retryRequestedAt).toBeNull();
    expect(after.manualRetry).toBe(false);
    expect(after).toEqual(before);
  });

  it('the host cannot retry while the socket is not connected', () => {
    signIn(HOST, HOST, false);
    receive(failed(5, false));
    retrySettlement();
    expect(socket.send).not.toHaveBeenCalled();
    expect(useStore.getState().hand.settlementFailed!.retryRequestedAt).toBeNull();
  });

  it('does not offer a retry once the failure is orphaned', () => {
    receive(failed(5, false));
    const f = useStore.getState().hand.settlementFailed!;
    useStore.getState().patchHand({ settlementFailed: { ...f, orphaned: true } });
    expect(settlementFailurePhase(useStore.getState().hand.settlementFailed, Date.now())).toBe(
      'orphaned',
    );
    expect(settlementFailureCopy('orphaned', true, 5).canRetry).toBe(false);
    retrySettlement();
    expect(socket.send).not.toHaveBeenCalled();
  });
});

describe('retry lifecycle', () => {
  it('marks the request in flight and clears everything once hand_end lands', () => {
    receive(failed(5, false));
    retrySettlement();
    expect(socket.send.mock.calls.map(([m]) => m.t)).toEqual(['retry_settlement']);
    const pending = useStore.getState().hand.settlementFailed!;
    expect(pending.manualRetry).toBe(true);
    expect(pending.retryRequestedAt).not.toBeNull();
    expect(settlementFailurePhase(pending, Date.now())).toBe('retrying');
    expect(settlementFailureCopy('retrying', true, pending.attempt).pending).toBe(true);

    receive(handEnd(HAND));
    expect(useStore.getState().hand.settlementFailed).toBeNull();
    expect(settlementFailurePhase(null, Date.now())).toBeNull();
  });

  it('surfaces "retry still failed" and keeps the button after another failure', () => {
    receive(failed(5, false));
    retrySettlement();
    receive(failed(1, false));
    const f = useStore.getState().hand.settlementFailed!;
    expect(f.manualRetry).toBe(true);
    expect(f.retryRequestedAt).toBeNull();
    const phase = settlementFailurePhase(f, Date.now());
    expect(phase).toBe('retry-failed');
    const host = settlementFailureCopy(phase!, true, f.attempt);
    expect(host.canRetry).toBe(true);
    expect(host.pending).toBe(false);
  });

  it('flips an unanswered request to stalled so the button is never dead', () => {
    const stalled = {
      handId: HAND,
      reason: 'x',
      attempt: 1,
      retrying: false,
      retryRequestedAt: 1_000,
      manualRetry: true,
      since: 1_000,
      orphaned: false,
    };
    expect(settlementFailurePhase(stalled, 1_000 + 10)).toBe('retrying');
    expect(settlementFailurePhase(stalled, 1_000 + SETTLE_RETRY_STALL_MS + 1)).toBe(
      'retry-stalled',
    );
    expect(settlementFailureCopy('retry-stalled', true, 1).canRetry).toBe(true);
  });
});

describe('stale terminal frames', () => {
  it('an old hand_end does not clear the current hand settlement failure', () => {
    receive(failed(5, false));
    receive(handEnd('some-older-hand'));
    expect(useStore.getState().hand.settlementFailed).not.toBeNull();
  });

  it('an old hand_abort does not clear the current hand settlement failure', () => {
    receive(failed(5, false));
    receive({ t: 'hand_abort', handId: 'some-older-hand', reason: 'x', blamedSeat: null });
    expect(useStore.getState().hand.settlementFailed).not.toBeNull();
  });
});

describe('reconnect / resync', () => {
  it('keeps a pending failure when the hand disappears (orphaned, not cleared)', () => {
    receive(failed(5, false));
    socket.consumeResync.mockReturnValue(true);
    receive(roomState(HOST, false));
    const f = useStore.getState().hand.settlementFailed;
    expect(f).not.toBeNull();
    expect(f!.orphaned).toBe(true);
    // handActive === false is NOT proof the settlement succeeded
    expect(settlementFailurePhase(f, Date.now())).toBe('orphaned');
  });

  it('a replayed hand_end after a committed-but-lost terminal frame clears it', () => {
    receive(failed(5, false));
    socket.consumeResync.mockReturnValue(true);
    receive(roomState(HOST, false));
    expect(useStore.getState().hand.settlementFailed!.orphaned).toBe(true);
    // the server retains the terminal frame and replays it on reconnect
    receive(handEnd(HAND));
    expect(useStore.getState().hand.settlementFailed).toBeNull();
    expect(useStore.getState().hand.result).not.toBeNull();
  });

  it('still synthesises a refund abort for a plain restart with no failure', () => {
    socket.consumeResync.mockReturnValue(true);
    receive(roomState(HOST, false));
    const abort = useStore.getState().hand.abort;
    expect(abort).not.toBeNull();
    expect(abort!.handId).toBe(HAND);
    expect(useStore.getState().hand.result).toBeNull();
  });

  it('a replayed terminal hand_end supersedes the synthesised restart abort', () => {
    socket.consumeResync.mockReturnValue(true);
    receive(roomState(HOST, false));
    expect(useStore.getState().hand.abort).not.toBeNull();
    // the hand actually committed before the restart-race abort was guessed
    receive(handEnd(HAND));
    expect(useStore.getState().hand.abort).toBeNull();
    expect(useStore.getState().hand.result).not.toBeNull();
  });
});

describe('refresh frame ordering (settlement_failed before hand_start)', () => {
  it('a refreshed client keeps the failure when its hand_start arrives afterwards', () => {
    // A page refresh has NO hand in memory. The server re-asserts the frozen
    // settlement BEFORE sending hand_start, so this is the real ordering - and
    // it is exactly what the old `resetHand()` wiped, hiding the host button.
    useStore.getState().resetHand();
    expect(useStore.getState().hand.handId).toBeNull();
    receive(failed(1, false));
    expect(useStore.getState().hand.settlementFailed?.handId).toBe(HAND);

    receive(handStart(HAND));

    const f = useStore.getState().hand.settlementFailed;
    expect(useStore.getState().hand.handId).toBe(HAND);
    expect(f).not.toBeNull();
    expect(f!.handId).toBe(HAND);
    // the host's recovery control is actually reachable
    expect(settlementFailurePhase(f, Date.now())).toBe('frozen');
    expect(settlementFailureCopy('frozen', true, f!.attempt).canRetry).toBe(true);
  });

  it('does not leak an older hand failure into a genuinely new hand', () => {
    receive(failed(1, false)); // failure for HAND
    useStore.getState().resetHand();
    receive(handStart('a-new-hand'));
    expect(useStore.getState().hand.settlementFailed).toBeNull();
  });
});

describe('terminal-state guards', () => {
  it('a late settlement_failed after hand_end does not revive the banner', () => {
    receive(failed(1, false));
    receive(handEnd(HAND));
    expect(useStore.getState().hand.settlementFailed).toBeNull();
    // a frame from a replaced connection arrives late, after the terminal frame
    receive(failed(2, false));
    expect(useStore.getState().hand.settlementFailed).toBeNull();
  });

  it('a late settlement_failed after hand_abort does not revive the banner', () => {
    receive(failed(1, false));
    receive({ t: 'hand_abort', handId: HAND, reason: 'x', blamedSeat: null });
    expect(useStore.getState().hand.settlementFailed).toBeNull();
    receive(failed(2, false));
    expect(useStore.getState().hand.settlementFailed).toBeNull();
  });

  it('a settlement failure after a showdown (not yet terminal) is still accepted', () => {
    // The reveal is NOT the settlement: the durable write can still fail after
    // it, so a showdown must not be mistaken for a terminal guard.
    receive({ t: 'showdown', handId: HAND, reveals: [], awards: [] } as ServerMsg);
    receive(failed(1, false));
    expect(useStore.getState().hand.settlementFailed?.handId).toBe(HAND);
  });

  it("a replayed terminal for an older hand clears that hand's stuck failure", () => {
    receive(failed(1, false));
    useStore.getState().patchHand({
      handId: 'newer-hand',
      settlementFailed: { ...useStore.getState().hand.settlementFailed!, handId: 'old-hand' },
    });
    receive(handEnd('old-hand'));
    expect(useStore.getState().hand.settlementFailed).toBeNull();
    // the newer hand's own state is untouched
    expect(useStore.getState().hand.handId).toBe('newer-hand');
  });

  it('a replayed terminal for an older hand leaves the current failure intact', () => {
    receive(failed(1, false));
    receive(handEnd('old-hand'));
    expect(useStore.getState().hand.settlementFailed?.handId).toBe(HAND);
  });
});

describe('durable hand recovery', () => {
  it('committed recovery closes the hand and suppresses a false refund abort', () => {
    receive(failed(1, false));
    socket.consumeResync.mockReturnValue(true);
    // arrives before room_state, exactly as GameRoom.join sends it
    receive(handRecovery(HAND, 'committed'));
    const h = useStore.getState().hand;
    expect(h.settlementFailed).toBeNull();
    expect(h.result?.recovered).toBe(true);

    receive(roomState(HOST, false));
    // the resync must trust the durable answer, not guess "refund"
    expect(useStore.getState().hand.abort).toBeNull();
    expect(useStore.getState().hand.result?.recovered).toBe(true);
  });

  it('unresolved lifecycle marks the failure admin-only', () => {
    receive(failed(1, false));
    receive(handRecovery(HAND, 'unresolved'));
    const f = useStore.getState().hand.settlementFailed!;
    expect(f.orphaned).toBe(true);
    expect(settlementFailurePhase(f, Date.now())).toBe('orphaned');
    expect(settlementFailureCopy('orphaned', true, f.attempt).canRetry).toBe(false);
  });

  it('aborted recovery shows the refund terminal and clears the failure', () => {
    receive(failed(1, false));
    receive(handRecovery(HAND, 'aborted'));
    expect(useStore.getState().hand.settlementFailed).toBeNull();
    expect(useStore.getState().hand.abort?.handId).toBe(HAND);
  });
});
