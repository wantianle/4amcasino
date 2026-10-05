import { describe, expect, it } from 'vitest';
import {
  cardFromName,
  legalActions,
  type BettingState,
  type SeatInHand,
  type ServerMsg,
} from '@4am/shared';
import { HeadlessClient } from '../src/client.js';
import { buildDecisionView } from '../src/decisionView.js';

interface RoomPlayerLike {
  userId: number;
  username: string;
  displayName: string;
  seat: number | null;
  stack: number;
  sittingOut: boolean;
  connected: boolean;
  totalBought: number;
  privateStats: boolean;
}

function player(userId: number, seat: number, name: string): RoomPlayerLike {
  return {
    userId,
    username: name.toLowerCase(),
    displayName: name,
    seat,
    stack: 1000,
    sittingOut: false,
    connected: true,
    totalBought: 0,
    privateStats: false,
  };
}

function makeClient(): HeadlessClient {
  const client = new HeadlessClient('http://127.0.0.1:1', 'bot', 'pw');
  client.userId = 1;
  // A connected, fully resynced epoch: `myTurn()` now enforces the resync
  // barrier, so the view's legal actions require it.
  client.connected = true;
  client.connectionEpoch = 1;
  client.roomStateEpoch = 1;
  client.handContextEpoch = 1;
  // The fixture is a resynced client in hand `h1`: hand-specific frames for that
  // hand are accepted (hand identity is validated before any cache write).
  (client as unknown as { resyncHandId: string | null }).resyncHandId = 'h1';
  client.seats = [
    { seat: 0, userId: 1, username: 'bot' },
    { seat: 1, userId: 2, username: 'villain' },
  ];
  client.room = {
    room: {
      id: 'r1',
      name: 'Test Room',
      joinCode: 'ABC123',
      hostId: 1,
      bankerId: 1,
      coBankerId: null,
      sb: 10,
      bb: 20,
      minSettleHands: 0,
      sevenDeuceBonus: 0,
    },
    players: [player(1, 0, 'Bot'), player(2, 1, 'Villain')],
    handActive: true,
  };
  return client;
}

function seat(seatNo: number, over: Partial<SeatInHand> = {}): SeatInHand {
  return {
    seat: seatNo,
    stack: 1000,
    committed: 0,
    total: 0,
    folded: false,
    allIn: false,
    lastActedAt: null,
    ...over,
  };
}

function state(over: Partial<BettingState> = {}): BettingState {
  return {
    street: 'flop',
    seats: [seat(0), seat(1)],
    buttonSeat: 0,
    sb: 10,
    bb: 20,
    currentBet: 0,
    lastRaiseSize: 20,
    lastFullRaiseAt: 0,
    toAct: 0,
    needToAct: [0],
    winnerByFold: null,
    ...over,
  };
}

describe('buildDecisionView', () => {
  it('returns empty sections with no room', () => {
    const client = new HeadlessClient('http://127.0.0.1:1', 'bot', 'pw');
    const view = buildDecisionView(client);
    expect(view.room).toBeNull();
    expect(view.hand).toBeNull();
    expect(view.me).toBeNull();
    expect(view.legalActions).toBeNull();
    expect(view.potOdds).toBeNull();
    expect(view.opponents).toEqual([]);
    expect(view.actionHistory).toEqual([]);
  });

  it('keeps hand/legal/potOdds null while crypto runs (no betting state)', () => {
    const client = makeClient();
    client.handId = 'h1'; // live, but no betting snapshot yet
    const view = buildDecisionView(client);
    expect(view.room).not.toBeNull();
    expect(view.me?.seat).toBe(0);
    expect(view.hand).toBeNull();
    expect(view.legalActions).toBeNull();
    expect(view.potOdds).toBeNull();
  });

  it('withholds legal actions when it is not my turn', () => {
    const client = makeClient();
    client.handId = 'h1';
    client.betting = state({ toAct: 1, needToAct: [1] });
    const view = buildDecisionView(client);
    expect(view.hand).not.toBeNull();
    expect(view.hand!.toAct).toBe(1);
    expect(view.legalActions).toBeNull();
    expect(view.potOdds).toBeNull();
  });

  it('exposes my legal actions on my turn', () => {
    const client = makeClient();
    client.handId = 'h1';
    client.betting = state({ toAct: 0, needToAct: [0] });
    const view = buildDecisionView(client);
    expect(view.legalActions).not.toBeNull();
    expect(view.legalActions!.canCheck).toBe(true);
    expect(view.legalActions!.canCall).toBe(false);
    expect(view.legalActions!.canBet).toBe(true);
    expect(view.legalActions!.canRaise).toBe(false);
  });

  it('returns hand/legal/potOdds null after a hand abort', () => {
    const client = makeClient();
    client.handId = 'h1';
    client.betting = state({ toAct: 0, needToAct: [0] });
    client.abort = { t: 'hand_abort', handId: 'h1', reason: 'timeout', blamedSeat: null };
    const view = buildDecisionView(client);
    expect(view.hand).toBeNull();
    expect(view.legalActions).toBeNull();
    expect(view.potOdds).toBeNull();
  });

  it('returns hand/legal/potOdds null after hand end', () => {
    const client = makeClient();
    client.handId = 'h1';
    client.betting = state({ toAct: 0, needToAct: [0] });
    client.result = {
      t: 'hand_end',
      handId: 'h1',
      head: 'head',
      stacks: [
        { seat: 0, stack: 1000 },
        { seat: 1, stack: 1000 },
      ],
      deltas: [
        { seat: 0, delta: 0 },
        { seat: 1, delta: 0 },
      ],
    };
    const view = buildDecisionView(client);
    expect(view.hand).toBeNull();
    expect(view.legalActions).toBeNull();
    expect(view.potOdds).toBeNull();
  });

  it('only exposes my own hole cards and no private crypto state', () => {
    const client = makeClient();
    client.handId = 'h1';
    client.myCards = [cardFromName('Ah'), cardFromName('Kd')];
    client.board = [cardFromName('2c'), cardFromName('7d'), cardFromName('Js')];
    client.betting = state({ street: 'flop', toAct: 0, needToAct: [0] });
    const view = buildDecisionView(client);

    expect(view.hand!.myCards).toEqual([cardFromName('Ah'), cardFromName('Kd')]);
    expect(view.hand!.board).toEqual([
      cardFromName('2c'),
      cardFromName('7d'),
      cardFromName('Js'),
    ]);
    // only the fields a bot may see - no key material / points / shares
    expect(Object.keys(view.hand!).sort()).toEqual(
      [
        'board',
        'buttonSeat',
        'currentBet',
        'deadline',
        'handId',
        'myCards',
        'mySeat',
        'pot',
        'street',
        'toAct',
      ].sort(),
    );
    const json = JSON.stringify(view);
    for (const forbidden of ['myCardPoints', 'secretKey', 'handKeys', 'deckIndex', 'unmask', 'proof']) {
      expect(json).not.toContain(forbidden);
    }
  });

  it('mirrors shared legalActions, including a short all-in boundary', () => {
    const client = makeClient();
    client.handId = 'h1';
    // seat 0 (me) has only 15 behind after committing 10; current bet 20.
    // legalActions caps minRaiseTo at maxRaiseTo = committed + stack = 25.
    client.betting = state({
      currentBet: 20,
      lastRaiseSize: 20,
      lastFullRaiseAt: 20,
      toAct: 0,
      needToAct: [0],
      seats: [
        seat(0, { committed: 10, stack: 15, total: 25 }),
        seat(1, { committed: 20, stack: 1000, total: 30 }),
      ],
    });
    const expected = legalActions(client.betting)!;
    const view = buildDecisionView(client);
    expect(view.legalActions).toEqual({
      canCheck: expected.canCheck,
      canCall: !expected.canCheck && expected.callAmount > 0,
      callAmount: expected.callAmount,
      canBet: expected.canRaise && client.betting.currentBet === 0,
      canRaise: expected.canRaise && client.betting.currentBet > 0,
      minRaiseTo: expected.minRaiseTo,
      maxRaiseTo: expected.maxRaiseTo,
    });
    expect(view.legalActions!.minRaiseTo).toBe(25);
    expect(view.legalActions!.maxRaiseTo).toBe(25);
    expect(view.legalActions!.canRaise).toBe(true);
  });

  it('computes pot odds as callAmount / (pot + callAmount)', () => {
    const client = makeClient();
    client.handId = 'h1';
    client.betting = state({
      currentBet: 20,
      toAct: 0,
      needToAct: [0],
      seats: [
        seat(0, { committed: 0, stack: 1000, total: 30 }),
        seat(1, { committed: 20, stack: 1000, total: 50 }),
      ],
    });
    const view = buildDecisionView(client);
    expect(view.hand!.pot).toBe(80);
    expect(view.legalActions!.callAmount).toBe(20);
    expect(view.potOdds).toEqual({
      callAmount: 20,
      pot: 80,
      potOdds: 20 / 100,
      breakEvenEquity: 20 / 100,
    });
  });

  it('copies action history so mutating the view never touches the client', () => {
    const client = makeClient();
    client.actionHistory = [
      { actionSeq: 0, street: 'flop', seat: 1, action: { type: 'call' }, auto: false, ts: 1 },
      { actionSeq: 1, street: 'flop', seat: 0, action: { type: 'check' }, auto: false, ts: 2 },
    ];
    const view = buildDecisionView(client);
    expect(view.actionHistory).toEqual(client.actionHistory);
    view.actionHistory[0]!.action.type = 'fold';
    expect(client.actionHistory[0]!.action.type).toBe('call');
  });

  it('withholds legal actions right after I already acted on this actionSeq', () => {
    const client = makeClient();
    client.handId = 'h1';
    client.betting = state({ toAct: 0, needToAct: [0] });
    // simulate act(): the sent action stamped the current betting snapshot
    client.actionSeq = 5;
    (client as unknown as { lastActedSeq: number }).lastActedSeq = 5;

    expect(client.myTurn()).toBe(false);
    const view = buildDecisionView(client);
    expect(view.hand).not.toBeNull();
    expect(view.legalActions).toBeNull();
    expect(view.potOdds).toBeNull();
  });

  it('accumulates public action history from action_applied frames', () => {
    const client = makeClient();
    client.handId = 'h1';
    client.betting = state({ street: 'flop' });
    const handle = (client as unknown as { handle(msg: ServerMsg): void }).handle.bind(client);
    handle({ t: 'action_applied', handId: 'h1', seat: 1, action: { type: 'call' } });
    handle({
      t: 'action_applied',
      handId: 'h1',
      seat: 0,
      action: { type: 'raise', amount: 60 },
      auto: true,
    });

    expect(
      client.actionHistory.map((a) => ({
        actionSeq: a.actionSeq,
        street: a.street,
        seat: a.seat,
        action: a.action,
        auto: a.auto,
      })),
    ).toEqual([
      { actionSeq: 0, street: 'flop', seat: 1, action: { type: 'call' }, auto: false },
      { actionSeq: 1, street: 'flop', seat: 0, action: { type: 'raise', amount: 60 }, auto: true },
    ]);
    expect(typeof client.actionHistory[0]!.ts).toBe('number');
  });

  it('uses the server-authoritative actionSeq, not a local ordinal', () => {
    const client = makeClient();
    client.handId = 'h1';
    client.betting = state({ street: 'flop' });
    const handle = (client as unknown as { handle(msg: ServerMsg): void }).handle.bind(client);
    // Deliberately out of order: a reconnect/missed frame can drop earlier
    // frames, but the server-stamped seq must be preserved verbatim.
    handle({ t: 'action_applied', handId: 'h1', seat: 1, action: { type: 'call' }, actionSeq: 7 });
    handle({ t: 'action_applied', handId: 'h1', seat: 0, action: { type: 'call' }, actionSeq: 3 });
    expect(client.actionHistory.map((a) => a.actionSeq)).toEqual([7, 3]);
  });
});

describe('history completeness', () => {
  type Internal = {
    handle(msg: ServerMsg): void;
    onSocketOpened(): void;
    markDisconnected(): void;
  };
  const internal = (c: HeadlessClient) => c as unknown as Internal;
  const roomState = (c: HeadlessClient, handActive: boolean): ServerMsg =>
    ({
      t: 'room_state',
      room: c.room!.room,
      players: c.room!.players,
      handActive,
    }) as unknown as ServerMsg;
  const handStart = (c: HeadlessClient, handId: string): ServerMsg =>
    ({
      t: 'hand_start',
      handId,
      seats: c.seats,
      buttonSeat: 0,
      sb: 10,
      bb: 20,
      auditMode: 'open',
    }) as unknown as ServerMsg;
  const handEnd = (handId: string): ServerMsg =>
    ({
      t: 'hand_end',
      handId,
      deltas: [],
      stacks: [],
      commission: 0,
      head: 'x',
    }) as unknown as ServerMsg;

  it('is true from the start, false after a mid-hand disconnect, true next hand', () => {
    const c = makeClient();
    internal(c).onSocketOpened();
    internal(c).handle(roomState(c, false));
    internal(c).handle(handStart(c, 'h1'));
    expect(c.historyComplete).toBe(true);

    internal(c).markDisconnected();
    expect(c.historyComplete).toBe(false);

    // Reconnect while h1 is still live: the gap stands for this hand.
    internal(c).onSocketOpened();
    internal(c).handle(roomState(c, true));
    // The server replays the live hand's `hand_start` on resync; only then may
    // its `hand_end` be accepted.
    internal(c).handle(handStart(c, 'h1'));
    expect(c.historyComplete).toBe(false);

    // h1 settles while connected, then h2 starts: complete again.
    internal(c).handle(handEnd('h1'));
    internal(c).handle(handStart(c, 'h2'));
    expect(c.historyComplete).toBe(true);
  });

  it('is false for a client that joins a hand already in progress', () => {
    const c = makeClient();
    internal(c).onSocketOpened();
    internal(c).handle(roomState(c, true)); // a hand is already running
    internal(c).handle(handStart(c, 'h1'));
    expect(c.historyComplete).toBe(false);
  });

  it('a later room_state while connected does not flip completeness', () => {
    const c = makeClient();
    internal(c).onSocketOpened();
    internal(c).handle(roomState(c, false));
    internal(c).handle(handStart(c, 'h1'));
    expect(c.historyComplete).toBe(true);
    internal(c).handle(roomState(c, true)); // e.g. a player joins mid-hand
    expect(c.historyComplete).toBe(true);
  });

  it('is surfaced on the DecisionView', () => {
    const c = makeClient();
    c.historyComplete = false;
    expect(buildDecisionView(c).historyComplete).toBe(false);
  });
});
