import type { BettingState, CardId } from '@4am/shared';
import type { PublicAction } from '@4am/agent-core';

/**
 * A structurally-compatible stand-in for `HeadlessClient`, injected through
 * `BotRunnerOptions.clientFactory` in unit tests. It exposes the fields the
 * decision loop and `buildDecisionView` read, plus test knobs for turn/liveness,
 * a gate to hold `loginWithGrant` open (start/stop race tests) and a record of
 * every protocol frame sent.
 */

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const BETTING: BettingState = {
  street: 'preflop',
  seats: [
    { seat: 0, stack: 990, committed: 10, total: 10, folded: false, allIn: false, lastActedAt: null },
    { seat: 1, stack: 980, committed: 20, total: 20, folded: false, allIn: false, lastActedAt: null },
  ],
  buttonSeat: 0,
  sb: 10,
  bb: 20,
  currentBet: 20,
  lastRaiseSize: 20,
  lastFullRaiseAt: 20,
  toAct: 0,
  needToAct: [0],
  winnerByFold: null,
};

export class FakeClient {
  room = {
    room: {
      id: 'room1',
      name: 'R',
      joinCode: 'ABCDEF',
      hostId: 1,
      bankerId: 1,
      coBankerId: null,
      sb: 10,
      bb: 20,
      minSettleHands: 0,
      sevenDeuceBonus: 0,
    },
    players: [],
    handActive: true,
  };
  handId: string | null = 'h1';
  actionSeq = 1;
  result: { deltas: { seat: number; delta: number }[] } | null = null;
  abort: unknown = null;
  betting: BettingState | null = BETTING;
  seats = [{ seat: 0, userId: 1, username: 'bot' }];
  board: CardId[] = [];
  deadline: number | null = null;
  myCards: CardId[] = [51, 50];
  actionHistory: PublicAction[] = [];
  userId = 1;
  connected = true;
  connectionEpoch = 0;
  /**
   * Mirrors `HeadlessClient.isResynced`: true once this epoch's `room_state`
   * has been applied. A test sets it false to model the open->snapshot window.
   */
  isResynced = true;
  historyComplete = true;
  showdown: unknown = null;

  /** Test knobs: `turn` stays true so only the decided-key guard stops a resend. */
  turn = true;
  live = true;
  throwOnAct = false;
  actCount = 0;
  lastAction: unknown = null;
  sent: unknown[] = [];
  /** When set, `loginWithGrant` blocks until it resolves (start/stop races). */
  loginBlock: Promise<void> | null = null;
  loginCalls = 0;
  closed = false;

  async loginWithGrant(_token: string, _seed: string): Promise<void> {
    this.loginCalls++;
    if (this.loginBlock) await this.loginBlock;
  }

  mySeat(): number | null {
    return 0;
  }
  myTurn(): boolean {
    return this.turn;
  }
  handLive(): boolean {
    return this.live;
  }
  send(obj: unknown): void {
    this.sent.push(obj);
  }
  act(action: unknown): string {
    if (this.throwOnAct) throw new Error('illegal action rejected by the table');
    this.actCount++;
    this.lastAction = action;
    return 'sent';
  }
  close(): void {
    this.closed = true;
    this.live = false;
    // Mirror HeadlessClient.close(): it immediately invalidates the connection.
    this.connected = false;
    this.isResynced = false;
  }
  // Yield a real macrotask like the real client does, so the decision loop
  // cannot starve timers (a microtask-only loop would hang vitest).
  async waitForTurn(_ms: number): Promise<void> {
    await sleep(1);
  }
}
