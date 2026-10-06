/**
 * WebSocket boundary: runtime validation of inbound `ServerMsg` frames.
 *
 * Two layers are covered:
 *   1. `parseServerMsg` in @4am/shared - every variant accepted, malformed /
 *      unknown / wrong-shaped frames rejected with a reason.
 *   2. The real `wsClient` over a fake socket - bad frames are logged and
 *      dropped without throwing, the connection stays open, and a following
 *      valid frame is still delivered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { genIdentity } from '@4am/mental-poker';
import { isServerMsg, parseServerMsg, type ServerMsg } from '@4am/shared';
import { WsTransport } from '../src/shared/wsTransport.ts';
import { handStart, roomState } from './helpers/fixtures.ts';

// ---- valid samples: one per ServerMsg variant ------------------------------

const bettingStateSample: Extract<ServerMsg, { t: 'betting_state' }> = {
  t: 'betting_state',
  handId: 'h',
  actionSeq: 1,
  state: {
    street: 'preflop',
    seats: [
      {
        seat: 0,
        stack: 100,
        committed: 0,
        total: 0,
        folded: false,
        allIn: false,
        lastActedAt: null,
      },
    ],
    buttonSeat: 0,
    sb: 10,
    bb: 20,
    currentBet: 20,
    lastRaiseSize: 20,
    lastFullRaiseAt: 20,
    toAct: 0,
    needToAct: [],
    winnerByFold: null,
  },
  board: [],
  deadline: null,
};

const samples = {
  hello: { t: 'hello', serverPublicKey: 'ab' },
  room_state: roomState(1, true),
  error: { t: 'error', message: 'x' },
  chat: { t: 'chat', from: 'a', userId: 1, text: 'hi', kind: 'text', ts: 1 },
  rtc: { t: 'rtc', from: 1, data: { any: true } },
  voice_state: { t: 'voice_state', userId: 1, muted: true },
  auto_deal: { t: 'auto_deal', inMs: 1000 },
  ready_check: { t: 'ready_check', deadlineTs: 1, eligible: [0], ready: [0] },
  ready_end: { t: 'ready_end' },
  seven_deuce: { t: 'seven_deuce', handId: 'h', seat: 0, amount: 5 },
  hand_start: handStart('h'),
  key_commit_applied: { t: 'key_commit_applied', handId: 'h', seat: 0, commit: 'ab' },
  shuffle_turn: { t: 'shuffle_turn', handId: 'h', seat: 0, deck: ['ab'] },
  deck_state: { t: 'deck_state', handId: 'h', seat: 0, deck: ['ab'] },
  need_share: {
    t: 'need_share',
    handId: 'h',
    deckIndex: 0,
    point: 'ab',
    forSeat: null,
    purpose: 'hole',
  },
  share_applied: {
    t: 'share_applied',
    handId: 'h',
    deckIndex: 0,
    seat: 1,
    out: 'ab',
    forSeat: null,
  },
  your_card: { t: 'your_card', handId: 'h', deckIndex: 0, point: 'ab' },
  board_open: { t: 'board_open', handId: 'h', deckIndex: 0, card: 7 },
  rit_offer: { t: 'rit_offer', handId: 'h', deadlineTs: 1, voters: [0, 1] },
  rit_result: { t: 'rit_result', handId: 'h', runTwice: true, sharedBoard: [1, 2, 3] },
  betting_state: bettingStateSample,
  action_applied: {
    t: 'action_applied',
    handId: 'h',
    seat: 0,
    action: { type: 'check' },
    auto: false,
    actionSeq: 1,
  },
  showdown: {
    t: 'showdown',
    handId: 'h',
    reveals: [{ seat: 0, cards: [1, 2], score: 5 }],
    awards: [{ seat: 0, amount: 10 }],
  },
  feature_started: {
    t: 'feature_started',
    handId: 'h',
    squid: { enabled: true, penaltyBb: 1, minPlayers: 3 },
    bombPot: { enabled: true, anteBb: 1, schedule: { mode: 'hands', value: 10 } },
  },
  time_bank_update: { t: 'time_bank_update', handId: 'h', seat: 0, remainingMs: 1000 },
  multi_run_offer: {
    t: 'multi_run_offer',
    handId: 'h',
    decisionId: 'd',
    stage: 'choice',
    aheadSeat: 0,
    behindSeat: 1,
    equities: [{ seat: 0, bps: 5000 }],
    deadlineTs: 1,
  },
  multi_run_result: {
    t: 'multi_run_result',
    handId: 'h',
    runs: 2,
    reason: 'agreed',
    sharedBoard: [1, 2, 3],
  },
  squid_result: {
    t: 'squid_result',
    handId: 'h',
    winners: [0],
    transfers: [{ from: 1, to: 0, amount: 5 }],
    requestedPerLoser: 5,
    paidBySeat: [{ seat: 1, amount: 5 }],
    noClaimant: false,
  },
  hand_end: {
    t: 'hand_end',
    handId: 'h',
    head: 'ab',
    stacks: [{ seat: 0, stack: 100 }],
    deltas: [{ seat: 0, delta: 5 }],
  },
  settlement_failed: {
    t: 'settlement_failed',
    handId: 'h',
    reason: 'x',
    attempt: 1,
    retrying: true,
  },
  hand_recovery: { t: 'hand_recovery', handId: 'h', status: 'unresolved' },
  cards_shown: { t: 'cards_shown', handId: 'h', seat: 0, cards: [1, 2] },
  peek_offer: {
    t: 'peek_offer',
    offerId: 'o',
    handId: 'h',
    fromUserId: 1,
    fromName: 'a',
    targetSeat: 2,
    amount: 5,
  },
  peek_result: {
    t: 'peek_result',
    offerId: 'o',
    handId: 'h',
    targetSeat: 2,
    status: 'accepted',
    amount: 5,
    cards: [1, 2],
  },
  peek_offer_closed: {
    t: 'peek_offer_closed',
    offerId: 'o',
    handId: 'h',
    targetSeat: 2,
    status: 'accepted',
  },
  peek_offers_snapshot: { t: 'peek_offers_snapshot', incomingOfferIds: ['o'] },
  hand_abort: { t: 'hand_abort', handId: 'h', reason: 'x', blamedSeat: null },
  need_keys: { t: 'need_keys', handId: 'h' },
  transcript_entry: {
    t: 'transcript_entry',
    handId: 'h',
    seq: 1,
    type: 'settlement',
    from: 'a',
    head: 'ab',
  },
} satisfies Record<ServerMsg['t'], ServerMsg>;

describe('parseServerMsg', () => {
  it('accepts every ServerMsg variant', () => {
    for (const [t, msg] of Object.entries(samples)) {
      const r = parseServerMsg(msg);
      expect(r.ok, `variant ${t} should validate`).toBe(true);
      if (r.ok) expect(r.msg.t).toBe(t);
    }
  });

  it('rejects non-object frames', () => {
    for (const v of [null, undefined, 42, 'hello', [], true]) {
      const r = parseServerMsg(v);
      expect(r.ok).toBe(false);
      expect(isServerMsg(v)).toBe(false);
    }
  });

  it('rejects an unknown frame type (drop for forward compatibility)', () => {
    expect(parseServerMsg({ t: 'brand_new_frame', whatever: 1 })).toEqual({
      ok: false,
      reason: 'unknown frame type "brand_new_frame"',
    });
  });

  it('rejects inherited Object.prototype keys as frame types, without throwing', () => {
    // `t` is attacker-controlled (comes straight from `JSON.parse`). A plain
    // object lookup would read inherited members: `toString`/`constructor`
    // would resolve to functions (truthy guards), while `__proto__`/`valueOf`
    // would be called as guards and throw. All must be rejected, none may throw.
    for (const t of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expect(() => parseServerMsg({ t }), `t=${t} must not throw`).not.toThrow();
      const r = parseServerMsg({ t });
      expect(r.ok, `t=${t} must be rejected`).toBe(false);
      if (!r.ok) expect(r.reason).toBe(`unknown frame type "${t}"`);
      expect(isServerMsg({ t })).toBe(false);
    }
  });

  it('rejects nested/unknown prototype keys reached through a valid frame type', () => {
    // Sanity: a real frame carrying a prototype key in its payload must still
    // validate/reject structurally, never execute an inherited function.
    expect(() =>
      parseServerMsg({ t: 'chat', from: 'a', userId: 1, text: 'x', kind: 'toString', ts: 1 }),
    ).not.toThrow();
    expect(
      parseServerMsg({ t: 'chat', from: 'a', userId: 1, text: 'x', kind: 'toString', ts: 1 }).ok,
    ).toBe(false);
  });

  it('rejects a missing required field', () => {
    expect(parseServerMsg({ t: 'voice_state', userId: 1 }).ok).toBe(false);
  });

  it('rejects a wrong primitive type', () => {
    expect(parseServerMsg({ t: 'auto_deal', inMs: 'soon' }).ok).toBe(false);
  });

  it('rejects a bad literal / enum value', () => {
    expect(parseServerMsg({ ...samples.chat, kind: 'shout' }).ok).toBe(false);
  });

  it('rejects a bad nested shape', () => {
    const bad = {
      ...bettingStateSample,
      state: { ...bettingStateSample.state, seats: [{ seat: 0 }] },
    };
    expect(parseServerMsg(bad).ok).toBe(false);
  });

  it('does not clone the validated frame (identity is preserved)', () => {
    const r = parseServerMsg(samples.ready_end);
    expect(r.ok && r.msg).toBe(samples.ready_end);
  });
});

// ---- WsTransport lifecycle: close-once semantics ----------------------------

/** Direct transport tests, without the session/store layer in the way. */
function makeTransport() {
  const onOpen = vi.fn();
  const onFrame = vi.fn();
  const onClose = vi.fn();
  return { transport: new WsTransport({ onOpen, onFrame, onClose }), onOpen, onFrame, onClose };
}

describe('WsTransport close-once semantics', () => {
  beforeEach(() => {
    FakeSocket.instances.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a socket closing on its own notifies onClose exactly once', () => {
    const { transport, onClose } = makeTransport();
    transport.open('t');
    FakeSocket.instances.at(-1)!.serverOpen();

    // Server drops the connection: the socket's own close event.
    FakeSocket.instances.at(-1)!.close();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('an explicit close() notifies onClose exactly once', () => {
    const { transport, onClose } = makeTransport();
    transport.open('t');
    FakeSocket.instances.at(-1)!.serverOpen();

    transport.close();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a late close from a replaced socket does not notify onClose or clear the new socket', () => {
    const { transport, onClose } = makeTransport();
    transport.open('t1');
    const oldSock = FakeSocket.instances.at(-1)!;
    oldSock.serverOpen();

    transport.close(); // detaches oldSock; reports onClose once
    expect(onClose).toHaveBeenCalledTimes(1);

    transport.open('t2'); // a replacement session
    const newSock = FakeSocket.instances.at(-1)!;
    newSock.serverOpen();

    // The old socket's close event finally lands while `this.ws` points at
    // `newSock`. The stale event must be ignored: no extra onClose, and the
    // live socket reference survives.
    oldSock.onclose?.();
    expect(onClose).toHaveBeenCalledTimes(1);

    transport.send('ping');
    expect(newSock.sent).toEqual(['ping']);
    expect(oldSock.sent).toEqual([]);
  });

  it('close() called twice still notifies onClose exactly once', () => {
    const { transport, onClose } = makeTransport();
    transport.open('t');
    FakeSocket.instances.at(-1)!.serverOpen();

    transport.close();
    transport.close();

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ---- WsTransport bad-frame logging: fixed window, per-reason cap ------------

describe('WsTransport bad-frame logging rate limit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** First argument of every warn call, as a string. */
  const warnText = (warn: { mock: { calls: unknown[][] } }): string[] =>
    warn.mock.calls.map((c) => String(c[0]));

  function openSock(transport: WsTransport): FakeSocket {
    transport.open('t');
    const sock = FakeSocket.instances.at(-1)!;
    sock.serverOpen();
    return sock;
  }

  it('logs the first 3 frames of a reason verbatim and summarizes the rest at window end', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { transport } = makeTransport();
    const sock = openSock(transport);

    for (let i = 0; i < 10; i++) sock.serverSendRaw('{not json');

    expect(warn).toHaveBeenCalledTimes(3);
    expect(warnText(warn)).toEqual([
      '[ws] dropped frame: malformed JSON',
      '[ws] dropped frame: malformed JSON',
      '[ws] dropped frame: malformed JSON',
    ]);

    // Window closes: one summary carrying the 7 suppressed frames.
    vi.advanceTimersByTime(10_000);
    expect(warn).toHaveBeenCalledTimes(4);
    expect(warnText(warn)[3]).toBe('[ws] dropped 10 frames: malformed JSON (+7 more)');

    transport.close();
  });

  it('gives each reason its own budget and still prints the first of every reason', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { transport } = makeTransport();
    const sock = openSock(transport);

    for (let i = 0; i < 5; i++) sock.serverSendRaw('{not json'); // 3 verbatim, 2 counted
    sock.serverSendRaw('{"t":"x"}'); // unknown frame type "x"
    sock.serverSendRaw('{"t":"x"}');
    (sock.onmessage as unknown as (ev: { data: unknown }) => void)?.({ data: 42 }); // non-text

    expect(warnText(warn)).toEqual([
      '[ws] dropped frame: malformed JSON',
      '[ws] dropped frame: malformed JSON',
      '[ws] dropped frame: malformed JSON',
      '[ws] dropped frame: unknown frame type "x"',
      '[ws] dropped frame: unknown frame type "x"',
      '[ws] dropped frame: non-text payload',
    ]);

    vi.advanceTimersByTime(10_000);
    expect(warnText(warn).at(-1)).toBe('[ws] dropped 5 frames: malformed JSON (+2 more)');

    transport.close();
  });

  it('prints the first frame of a reason again in the next window', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { transport } = makeTransport();
    const sock = openSock(transport);

    for (let i = 0; i < 10; i++) sock.serverSendRaw('{not json');
    vi.advanceTimersByTime(10_000);

    // New window: the first drop of the reason is verbatim again, so a failure
    // that starts later is never lost behind the previous window's cap.
    sock.serverSendRaw('{not json');
    expect(warnText(warn).at(-1)).toBe('[ws] dropped frame: malformed JSON');

    transport.close();
  });

  it('clears the window timer on close() and flushes what it owed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { transport } = makeTransport();
    const sock = openSock(transport);

    for (let i = 0; i < 10; i++) sock.serverSendRaw('{not json');
    expect(vi.getTimerCount()).toBe(1);

    transport.close();

    // Timer gone, and the suppressed frames were reported rather than dropped.
    expect(vi.getTimerCount()).toBe(0);
    expect(warnText(warn).at(-1)).toBe('[ws] dropped 10 frames: malformed JSON (+7 more)');

    // Nothing can fire after the transport is gone.
    const before = warn.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    expect(warn.mock.calls.length).toBe(before);
  });
});

// ---- boundary over the real wsClient ---------------------------------------

/** Minimal WebSocket double: the real client drives it, the test pushes frames. */
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
  serverOpen(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  serverSend(msg: ServerMsg): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  serverSendRaw(data: string): void {
    this.onmessage?.({ data });
  }
}

const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
vi.stubGlobal('window', { localStorage: storage, dispatchEvent: () => {} });
vi.stubGlobal('localStorage', storage);
vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:1234' });
vi.stubGlobal('sessionStorage', {
  length: 0,
  key: () => null,
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
});
vi.stubGlobal(
  'CustomEvent',
  class {
    constructor(public type: string) {}
  },
);
vi.stubGlobal('WebSocket', FakeSocket);

const { useStore } = await import('../src/shared/store.ts');
const { wsClient } = await import('../src/shared/ws.ts');

describe('ws boundary (real wsClient + fake socket)', () => {
  beforeEach(() => {
    FakeSocket.instances.length = 0;
    useStore.setState({
      auth: { token: 't', userId: 1, username: 'me', identity: genIdentity() },
      wsConnected: false,
    });
    useStore.getState().resetHand();
  });

  afterEach(() => {
    wsClient.leaveRoom();
    vi.restoreAllMocks();
  });

  it('drops malformed/unknown/mismatched frames, keeps the connection, then delivers valid ones', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const received: ServerMsg[] = [];
    const off = wsClient.on((m) => received.push(m));

    wsClient.joinRoom('r');
    const sock = FakeSocket.instances.at(-1)!;
    sock.serverOpen();
    expect(sock.readyState).toBe(FakeSocket.OPEN);

    // Every failure class the boundary must survive.
    sock.serverSendRaw('{not json');
    sock.serverSendRaw('{"t":"brand_new_frame"}');
    sock.serverSendRaw('{"t":"voice_state","userId":1}'); // missing `muted`
    sock.serverSendRaw('{"t":"auto_deal","inMs":"soon"}'); // wrong type
    sock.serverSendRaw('{"t":"hello"}'); // missing `serverPublicKey`
    sock.serverSendRaw('{"t":"chat","from":"a","userId":1,"text":"x","kind":"shout","ts":1}'); // bad enum
    // ...then a burst of the same frame. The logger must cap that reason at
    // three verbatim lines per window instead of echoing all five.
    for (let i = 0; i < 4; i++) sock.serverSendRaw('{not json');

    // Nothing reached the listener, nothing threw, the socket is still live.
    expect(received).toHaveLength(0);
    expect(sock.readyState).toBe(FakeSocket.OPEN);
    expect(useStore.getState().wsConnected).toBe(true);
    // 3 verbatim for the repeated reason + 1 first-of-reason line for the other
    // five distinct reasons: the cap does not hide a failure class.
    expect(warn).toHaveBeenCalledTimes(8);
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      '[ws] dropped frame: malformed JSON',
      '[ws] dropped frame: unknown frame type "brand_new_frame"',
      '[ws] dropped frame: frame "voice_state" failed validation',
      '[ws] dropped frame: frame "auto_deal" failed validation',
      '[ws] dropped frame: frame "hello" failed validation',
      '[ws] dropped frame: frame "chat" failed validation',
      '[ws] dropped frame: malformed JSON',
      '[ws] dropped frame: malformed JSON',
    ]);

    // ...and a valid frame still gets through.
    sock.serverSend({ t: 'ready_end' });
    expect(received).toEqual([{ t: 'ready_end' }]);
    off();
  });

  it('does not let a bad frame abort a hand frame that follows it', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const received: ServerMsg[] = [];
    const off = wsClient.on((m) => received.push(m));

    wsClient.joinRoom('r');
    const sock = FakeSocket.instances.at(-1)!;
    sock.serverOpen();

    sock.serverSendRaw('{"t":"hand_end","handId":"x","head":"z"}'); // missing stacks/deltas
    sock.serverSend(samples.hand_start);

    expect(received).toEqual([samples.hand_start]);
    off();
  });
});
