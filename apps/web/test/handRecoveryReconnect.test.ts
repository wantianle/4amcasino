/**
 * Blocker-2 regression: the durable `unresolved` hand-recovery answer on a REAL
 * reconnect path.
 *
 * Unlike `settlementFailure.test.ts` (which mocks `ws.ts` and calls the frame
 * handler directly), this file drives the REAL `WsClient` + `bindGameClient`:
 * the transport is a fake socket, but the join/reconnect handshake, the
 * `resumeHandId` announcement and the frame dispatch all run through the
 * production code. That is the exact path a client takes after a socket drop
 * while it still holds a hand: it reconnects, the server (restarted) answers
 * `hand_recovery: unresolved` BEFORE `room_state(handActive: false)`, and the
 * client must NOT synthesise a refund abort it never received.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { genIdentity } from '@4am/mental-poker';
import type { ClientMsg, ServerMsg } from '@4am/shared';
import { roomState } from './helpers/fixtures.ts';

vi.mock('../src/shared/voice.ts', () => ({ voice: { syncPeers: vi.fn(), handleRtc: vi.fn() } }));
vi.mock('../src/shared/sounds.ts', () => ({ play: vi.fn() }));

const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
vi.stubGlobal('window', { localStorage: storage, dispatchEvent: () => {} });
vi.stubGlobal('localStorage', storage);
vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:1234' });
vi.stubGlobal(
  'CustomEvent',
  class {
    constructor(public type: string) {}
  },
);
vi.stubGlobal('sessionStorage', {
  length: 0,
  key: () => null,
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
});

/** Minimal WebSocket double: the real client drives it, tests only open it and
 *  push server frames. */
class FakeSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  constructor(
    public url: string,
    public protocols?: string[],
  ) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
  /** Server side: accept the connection. */
  serverOpen(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  /** Server side: deliver a frame. */
  serverSend(msg: ServerMsg): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  sentMsgs(): ClientMsg[] {
    return this.sent.map((s) => JSON.parse(s) as ClientMsg);
  }
}
vi.stubGlobal('WebSocket', FakeSocket);

const { useStore } = await import('../src/shared/store.ts');
const { wsClient } = await import('../src/shared/ws.ts');
const { bindGameClient } = await import('../src/shared/gameClient.ts');
const { HandRecoveryBanner } = await import('../src/features/table/settlementFailure.tsx');
bindGameClient();

const HAND = 'recovery-reconnect-hand';

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances.length = 0;
  useStore.setState({
    auth: { token: 't', userId: 1, username: 'me', identity: genIdentity() },
    wsConnected: false,
  });
  useStore.getState().resetHand();
  // The client is holding a hand dealt before the server restarted.
  useStore.getState().patchHand({ handId: HAND });
});

afterEach(() => {
  vi.clearAllTimers();
  wsClient.leaveRoom();
  vi.useRealTimers();
});

/** Drive one full join + socket drop + reconnect; returns the reconnected
 *  socket with the client's rejoin already sent. */
function dropAndReconnect(): FakeSocket {
  wsClient.joinRoom('r');
  const first = FakeSocket.instances.at(-1)!;
  first.serverOpen();
  first.serverSend(roomState(1, true));
  expect(useStore.getState().wsConnected).toBe(true);

  // the server restarts and the socket drops
  first.close();
  expect(useStore.getState().wsConnected).toBe(false);

  // the client reconnects on its own backoff
  vi.advanceTimersByTime(600);
  const second = FakeSocket.instances.at(-1)!;
  expect(second).not.toBe(first);
  second.serverOpen();
  return second;
}

describe('durable unresolved recovery on a real reconnect', () => {
  it('announces the held hand and refuses a synthetic refund for unresolved', () => {
    const second = dropAndReconnect();

    // The client named the hand it still holds, on both joins.
    const rejoin = second.sentMsgs().find((m) => m.t === 'join_room');
    expect(rejoin).toMatchObject({ roomId: 'r', resumeHandId: HAND });

    // GameRoom.join order: the durable answer FIRST, then room_state.
    second.serverSend({ t: 'hand_recovery', handId: HAND, status: 'unresolved' });
    second.serverSend(roomState(1, false));

    const h = useStore.getState().hand;
    expect(h.handRecovery).toBe('unresolved');
    expect(h.abort).toBeNull(); // no fabricated refund
    expect(h.result).toBeNull(); // not a fake terminal
    expect(h.settlementFailed).toBeNull(); // no failure frame was ever seen
  });

  it('records unresolved even without a local failure, then a committed answer clears it', () => {
    const second = dropAndReconnect();
    second.serverSend({ t: 'hand_recovery', handId: HAND, status: 'unresolved' });
    expect(useStore.getState().hand.handRecovery).toBe('unresolved');

    // Operator resolves it; the next reconnect reports committed, which closes
    // the hand and clears the admin-only state.
    second.serverSend({ t: 'hand_recovery', handId: HAND, status: 'committed' });
    const h = useStore.getState().hand;
    expect(h.handRecovery).toBeNull();
    expect(h.result?.recovered).toBe(true);
  });

  it('an aborted answer clears unresolved and shows the refund terminal', () => {
    const second = dropAndReconnect();
    second.serverSend({ t: 'hand_recovery', handId: HAND, status: 'unresolved' });
    second.serverSend({ t: 'hand_recovery', handId: HAND, status: 'aborted' });
    const h = useStore.getState().hand;
    expect(h.handRecovery).toBeNull();
    expect(h.abort?.handId).toBe(HAND);
    expect(h.result).toBeNull();
  });
});

describe('room switch is a session boundary', () => {
  it('does not carry the old room hand or its recovery banner into the new room', () => {
    // In room A, holding a hand the server left unresolved (admin-only banner).
    wsClient.joinRoom('room-A');
    const a = FakeSocket.instances.at(-1)!;
    a.serverOpen();
    a.serverSend(roomState(1, true));
    a.serverSend({ t: 'hand_recovery', handId: HAND, status: 'unresolved' });
    expect(useStore.getState().hand.handId).toBe(HAND);
    expect(useStore.getState().hand.handRecovery).toBe('unresolved');

    // Exactly what TablePage's room effect cleanup does when switching rooms.
    wsClient.leaveRoom();

    // The held hand - and its admin-only recovery state - is dropped.
    const afterLeave = useStore.getState().hand;
    expect(afterLeave.handId).toBeNull();
    expect(afterLeave.handRecovery).toBeNull();
    expect(afterLeave.settlementFailed).toBeNull();
    expect(afterLeave.result).toBeNull();
    expect(afterLeave.abort).toBeNull();
    expect(renderToStaticMarkup(createElement(HandRecoveryBanner))).not.toContain(
      'hand-recovery-banner',
    );

    // Entering room B: the join MUST NOT resume room A's hand.
    wsClient.joinRoom('room-B');
    const b = FakeSocket.instances.at(-1)!;
    expect(b).not.toBe(a);
    b.serverOpen();
    const joinB = b.sentMsgs().find((m) => m.t === 'join_room');
    expect(joinB).toMatchObject({ roomId: 'room-B' });
    expect(joinB).not.toHaveProperty('resumeHandId');

    // Room B's own (empty) room_state cannot resurrect room A's banner.
    b.serverSend(roomState(1, false));
    expect(useStore.getState().hand.handRecovery).toBeNull();
    expect(renderToStaticMarkup(createElement(HandRecoveryBanner))).not.toContain(
      'hand-recovery-banner',
    );
  });
});
