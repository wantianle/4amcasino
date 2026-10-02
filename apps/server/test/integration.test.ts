import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { attachHub } from '../src/hub.js';
import {
  cardLookup,
  genIdentity,
  handKeyCommit,
  invScalar,
  maskAndShuffle,
  mulPoint,
  pointFromHex,
  pointHex,
  proveUnmask,
  randScalar,
  randomPerm,
  recoverCard,
  signContent,
} from '@4am/mental-poker';
import type { BettingState, CardId, PlayerAction, ServerMsg } from '@4am/shared';
import { awardPots, computePots, splitAmountEven, startBombPot } from '@4am/shared';
import { createSession, createUser } from '../src/auth.js';
import { setPlatformUserId } from '../src/platform.js';
import { activeHands } from '../src/liveHands.js';
import { applyHandSettlement } from '../src/game.js';
import { verifyLedger } from '../src/ledger.js';
import { recoverOrphanedFeatureTriggers } from '../src/db.js';

type Strategy = 'passive' | 'fold-first' | 'allin-first' | 'shove-flop';

class TestClient {
  username: string;
  token = '';
  userId = 0;
  autoReady = true;
  sawReadyCheck = false;
  /** Answer to a run-it-twice offer; null = never answer (timeout counts as no). */
  ritAnswer: boolean | null = true;
  /** Escrow the hand key with the server on fold (like the real clients). */
  autoFoldKey = true;
  /** Never answer a betting turn (used to exercise the timeout path). */
  ignoreActions = false;
  /** Delay before acting, in ms, to spend the time bank past the base clock. */
  thinkMs = 0;
  sawRitOffer = false;
  /** Set when this client's own fold has been applied by the server. */
  sawOwnFold = false;
  errors: string[] = [];
  board2: CardId[] = [];
  board3: CardId[] = [];
  /** How the player behind answers the run-count stage; null = never answer. */
  runCountAnswer: 1 | 2 | 3 | null = 1;
  /** How the player ahead answers the agreement stage; null = never answer. */
  runAgreeAnswer: boolean | null = true;
  sawMultiRunOffer = false;
  multiRunOffers: {
    decisionId: string;
    stage: string;
    aheadSeat: number;
    behindSeat: number;
    requestedRuns?: number;
    equities: { seat: number; bps: number }[];
  }[] = [];
  multiRunResult: { runs: number; reason: string } | null = null;
  lastShowdown: Extract<ServerMsg, { t: 'showdown' }> | null = null;
  timeBankUpdates: { seat: number; remainingMs: number }[] = [];
  /** Every street a client-visible betting_state announced, in order. */
  bettingStreets: string[] = [];
  /** Latest betting_state snapshot, for manual action/deadline tests. */
  lastState: BettingState | null = null;
  lastDeadline: number | null = null;
  /** Every action the server actually applied (broadcast action_applied). */
  actionApplied: { seat: number; action: PlayerAction; auto: boolean }[] = [];
  squidResult:
    | (Extract<ServerMsg, { t: 'squid_result' }> & {
        netBySeat?: { seat: number; net: number }[];
      })
    | null = null;
  featureStarted: Extract<ServerMsg, { t: 'feature_started' }>[] = [];
  identity = genIdentity();
  ws!: WebSocket;
  baseUrl: string;
  strategy: Strategy;
  respondShares = true;

  seat: number | null = null;
  handId: string | null = null;
  handKey: bigint | null = null;
  myCards: CardId[] = [];
  myCardPoints: { deckIndex: number; point: string }[] = [];
  board: CardId[] = [];
  cardsShown: { seat: number; cards: CardId[] }[] = [];
  peekOffers: { offerId: string; fromUserId: number; amount: number }[] = [];
  peekResults: { targetSeat: number; status: string; cards?: CardId[] }[] = [];
  sawShowdown = false;
  handEnd:
    | (Extract<ServerMsg, { t: 'hand_end' }> & {
        pokerDeltas?: { seat: number; delta: number }[];
        squidDeltas?: { seat: number; delta: number }[];
      })
    | null = null;
  handAbort: Extract<ServerMsg, { t: 'hand_abort' }> | null = null;
  lastRespondedActionSeq = -1;
  roomState: Extract<ServerMsg, { t: 'room_state' }> | null = null;
  lookup = cardLookup();

  constructor(baseUrl: string, username: string, strategy: Strategy = 'passive') {
    this.baseUrl = baseUrl;
    this.username = username;
    this.strategy = strategy;
  }

  async register(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: this.username,
        authKey: 'a'.repeat(64),
        publicKey: this.identity.publicKey,
      }),
    });
    const json = (await res.json()) as { token: string; userId: number };
    this.token = json.token;
    this.userId = json.userId;
  }

  async api(path: string, body?: unknown, method?: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.json();
  }

  connect(roomId: string): Promise<void> {
    const wsUrl = this.baseUrl.replace('http', 'ws') + `/ws?token=${this.token}`;
    this.ws = new WebSocket(wsUrl);
    return new Promise((resolve) => {
      this.ws.on('open', () => {
        this.send({ t: 'join_room', roomId });
        resolve();
      });
      this.ws.on('message', (raw) => this.handle(JSON.parse(String(raw)) as ServerMsg));
    });
  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  /** Drop the socket like a player closing the tab (no reconnect). */
  disconnect(): void {
    this.ws.close();
  }

  signed(t: string, body: unknown): string {
    return signContent(this.identity.secretKey, this.handId!, t, body);
  }

  private act(action: PlayerAction): void {
    this.send({ t: 'action', handId: this.handId, action, sig: this.signed('action', { action }) });
  }

  showCards(): void {
    const shares = this.myCardPoints.map(({ deckIndex, point }) => {
      const { out, proof } = proveUnmask(this.handKey!, pointFromHex(point));
      return { deckIndex, out: pointHex(out), proof };
    });
    this.send({
      t: 'show_cards',
      handId: this.handId,
      shares,
      sig: this.signed('show_cards', { shares }),
    });
  }

  acceptPeek(offerId: string): void {
    const shares = this.myCardPoints.map(({ deckIndex, point }) => {
      const { out, proof } = proveUnmask(this.handKey!, pointFromHex(point));
      return { deckIndex, out: pointHex(out), proof };
    });
    this.send({
      t: 'peek_accept',
      handId: this.handId,
      offerId,
      shares,
      sig: this.signed('peek_accept', { offerId, shares }),
    });
  }

  handle(msg: ServerMsg): void {
    switch (msg.t) {
      case 'room_state':
        this.roomState = msg;
        break;
      case 'hand_start': {
        const mine = msg.seats.find((s) => s.userId === this.userId);
        if (!mine) break;
        // like the real client: a re-delivered hand_start (reconnect) keeps state and key
        if (this.handId !== msg.handId) {
          this.seat = mine.seat;
          this.handId = msg.handId;
          this.handKey = randScalar();
          this.myCards = [];
          this.myCardPoints = [];
          this.board = [];
          this.board2 = [];
          this.board3 = [];
          this.cardsShown = [];
          this.sawShowdown = false;
          this.handEnd = null;
          this.handAbort = null;
          this.sawOwnFold = false;
          this.lastRespondedActionSeq = -1;
          this.sawMultiRunOffer = false;
          this.multiRunOffers = [];
          this.multiRunResult = null;
          this.lastShowdown = null;
          this.timeBankUpdates = [];
          this.bettingStreets = [];
          this.lastState = null;
          this.lastDeadline = null;
          this.actionApplied = [];
          this.squidResult = null;
          this.featureStarted = [];
        }
        const commit = pointHex(handKeyCommit(this.handKey!));
        this.send({
          t: 'key_commit',
          handId: this.handId,
          commit,
          sig: this.signed('key_commit', { commit }),
        });
        break;
      }
      case 'shuffle_turn': {
        if (msg.seat !== this.seat) break;
        const deck = msg.deck.map(pointFromHex);
        const out = maskAndShuffle(deck, this.handKey!, randomPerm(52)).map(pointHex);
        this.send({
          t: 'shuffle_deck',
          handId: this.handId,
          deck: out,
          sig: this.signed('shuffle_deck', { deck: out }),
        });
        break;
      }
      case 'need_share': {
        if (!this.respondShares) break;
        const { out, proof } = proveUnmask(this.handKey!, pointFromHex(msg.point));
        const body = { deckIndex: msg.deckIndex, out: pointHex(out), proof };
        this.send({
          t: 'unmask_share',
          handId: this.handId,
          ...body,
          sig: this.signed('unmask_share', body),
        });
        break;
      }
      case 'your_card': {
        if (this.myCardPoints.some((c) => c.deckIndex === msg.deckIndex)) break;
        const plain = mulPoint(pointFromHex(msg.point), invScalar(this.handKey!));
        const card = recoverCard(plain, this.lookup);
        if (card !== null) {
          this.myCards.push(card);
          this.myCardPoints.push({ deckIndex: msg.deckIndex, point: msg.point });
        }
        break;
      }
      case 'board_open': {
        if (msg.run === 2) {
          if (!this.board2.includes(msg.card)) this.board2.push(msg.card);
        } else if (msg.run === 3) {
          if (!this.board3.includes(msg.card)) this.board3.push(msg.card);
        } else if (!this.board.includes(msg.card)) {
          this.board.push(msg.card);
        }
        break;
      }
      case 'multi_run_offer': {
        this.sawMultiRunOffer = true;
        this.multiRunOffers.push({
          decisionId: msg.decisionId,
          stage: msg.stage,
          aheadSeat: msg.aheadSeat,
          behindSeat: msg.behindSeat,
          requestedRuns: msg.requestedRuns,
          equities: msg.equities,
        });
        if (
          msg.stage === 'choice' &&
          msg.behindSeat === this.seat &&
          this.runCountAnswer !== null
        ) {
          const count = this.runCountAnswer;
          const body = { decisionId: msg.decisionId, count };
          this.send({
            t: 'run_count_choice',
            handId: this.handId,
            decisionId: msg.decisionId,
            count,
            sig: this.signed('run_count_choice', body),
          });
        } else if (
          msg.stage === 'agreement' &&
          msg.aheadSeat === this.seat &&
          this.runAgreeAnswer !== null
        ) {
          const agree = this.runAgreeAnswer;
          const body = { decisionId: msg.decisionId, agree };
          this.send({
            t: 'run_count_agree',
            handId: this.handId,
            decisionId: msg.decisionId,
            agree,
            sig: this.signed('run_count_agree', body),
          });
        }
        break;
      }
      case 'multi_run_result': {
        this.multiRunResult = { runs: msg.runs, reason: msg.reason };
        break;
      }
      case 'squid_result': {
        this.squidResult = msg;
        break;
      }
      case 'feature_started': {
        this.featureStarted.push(msg);
        break;
      }
      case 'action_applied': {
        this.actionApplied.push({ seat: msg.seat, action: msg.action, auto: !!msg.auto });
        if (msg.action.type === 'fold' && msg.seat === this.seat) this.sawOwnFold = true;
        if (
          this.autoFoldKey &&
          msg.action.type === 'fold' &&
          msg.seat === this.seat &&
          this.handKey !== null
        ) {
          const key = this.handKey.toString(16);
          this.send({
            t: 'fold_key',
            handId: this.handId,
            key,
            sig: this.signed('fold_key', { key }),
          });
        }
        break;
      }
      case 'rit_offer': {
        this.sawRitOffer = true;
        if (this.ritAnswer !== null && this.seat !== null && msg.voters.includes(this.seat)) {
          const yes = this.ritAnswer;
          this.send({
            t: 'rit_vote',
            handId: this.handId,
            yes,
            sig: this.signed('rit_vote', { yes }),
          });
        }
        break;
      }
      case 'cards_shown': {
        this.cardsShown.push({ seat: msg.seat, cards: msg.cards });
        break;
      }
      case 'peek_offer': {
        this.peekOffers.push({
          offerId: msg.offerId,
          fromUserId: msg.fromUserId,
          amount: msg.amount,
        });
        break;
      }
      case 'peek_result': {
        this.peekResults.push({ targetSeat: msg.targetSeat, status: msg.status, cards: msg.cards });
        break;
      }
      case 'betting_state': {
        const st = msg.state;
        this.lastState = st;
        this.lastDeadline = msg.deadline;
        if (!this.bettingStreets.includes(st.street)) this.bettingStreets.push(st.street);
        if (
          this.seat === null ||
          st.toAct !== this.seat ||
          msg.actionSeq === this.lastRespondedActionSeq
        )
          break;
        this.lastRespondedActionSeq = msg.actionSeq;
        if (this.ignoreActions) break;
        const me = st.seats.find((s) => s.seat === this.seat)!;
        const respond = () => {
          const wantsShove =
            (this.strategy === 'allin-first' ||
              (this.strategy === 'shove-flop' && st.street !== 'preflop')) &&
            me.stack + me.committed > st.currentBet;
          if (this.strategy === 'fold-first') this.act({ type: 'fold' });
          else if (wantsShove)
            this.act({
              type: st.currentBet === 0 ? 'bet' : 'raise',
              amount: me.stack + me.committed,
            });
          else if (st.currentBet === me.committed) this.act({ type: 'check' });
          else this.act({ type: 'call' });
        };
        if (this.thinkMs > 0) setTimeout(respond, this.thinkMs);
        else respond();
        break;
      }
      case 'time_bank_update': {
        this.timeBankUpdates.push({ seat: msg.seat, remainingMs: msg.remainingMs });
        break;
      }
      case 'showdown': {
        this.sawShowdown = true;
        this.lastShowdown = msg;
        break;
      }
      case 'hand_end': {
        this.handEnd = msg;
        break;
      }
      case 'hand_abort': {
        this.handAbort = msg;
        break;
      }
      case 'need_keys': {
        const key = this.handKey!.toString(16);
        this.send({
          t: 'reveal_key',
          handId: this.handId,
          key,
          sig: this.signed('reveal_key', { key }),
        });
        break;
      }
      case 'ready_check': {
        this.sawReadyCheck = true;
        if (this.autoReady) this.send({ t: 'im_ready' });
        break;
      }
      case 'error': {
        this.errors.push(msg.message);
        break;
      }
      default:
        break;
    }
  }

  async waitFor(pred: () => boolean, ms = 15000): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > ms) throw new Error(`timeout waiting (${this.username})`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** Wait until the server has fully released the previous hand, so a second
   *  `start_hand` cannot race the room teardown. */
  async waitIdle(roomId: string, ms = 8000): Promise<void> {
    await this.waitFor(() => !activeHands.has(roomId), ms);
  }

  close(): void {
    this.ws?.close();
  }
}

let ctx: ReturnType<typeof createApp>;
let baseUrl: string;
let clients: TestClient[] = [];

beforeEach(async () => {
  ctx = createApp(':memory:');
  attachHub(ctx.app, ctx.db, {
    cryptoTimeoutMs: 1500,
    actionTimeoutMs: 1500,
    autoDealMs: 800,
    readyCheckMs: 1500,
    ritVoteMs: 1500,
    runItTwice: true,
  });
  await ctx.app.listen({ port: 0 });
  const addr = ctx.app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  clients = [];
});

afterEach(async () => {
  for (const c of clients) c.close();
  await ctx.app.close();
});

async function setupRoom(names: string[], strategies: Strategy[] = []) {
  const players = names.map((n, i) => new TestClient(baseUrl, n, strategies[i] ?? 'passive'));
  clients.push(...players);
  for (const p of players) await p.register();
  const host = players[0]!;
  const room = await host.api('/api/rooms', { name: 'Test', sb: 10, bb: 20 });
  for (const p of players.slice(1)) await p.api('/api/rooms/join', { joinCode: room.joinCode });
  for (const p of players) {
    const req = await p.api(`/api/rooms/${room.id}/buy`, { amount: 1000 });
    await host.api(`/api/rooms/${room.id}/approve`, { requestId: req.id, approve: true });
  }
  for (const [i, p] of players.entries()) {
    await p.connect(room.id);
    p.send({ t: 'sit', seat: i });
  }
  await new Promise((r) => setTimeout(r, 100)); // let sits settle
  return { players, room, host };
}

describe('full hand integration', () => {
  it('three players play a complete hand to showdown', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob', 'carol']);
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null)));

    for (const p of players) {
      expect(p.handAbort).toBeNull();
      expect(p.myCards).toHaveLength(2);
      expect(new Set(p.myCards).size).toBe(2);
      expect(p.board).toHaveLength(5);
      expect(p.sawShowdown).toBe(true);
    }
    // all clients agree on the board
    expect(players[1]!.board).toEqual(players[0]!.board);
    expect(players[2]!.board).toEqual(players[0]!.board);
    // no card appears twice across boards + all hole cards
    const all = [...players[0]!.board, ...players.flatMap((p) => p.myCards)];
    expect(new Set(all).size).toBe(all.length);

    // chips conserved: everyone matched the BB (passive play), pot 60
    const stacks = players[0]!.handEnd!.stacks;
    expect(stacks.reduce((s, x) => s + x.stack, 0)).toBe(3000);
    const deltas = players[0]!.handEnd!.deltas;
    expect(deltas.reduce((s, x) => s + x.delta, 0)).toBe(0);

    // DB: stacks persisted, ledger has verifiable settlement entries, transcript stored
    const state = await host.api(`/api/rooms/${room.id}`);
    expect(state.players.reduce((s: number, p: { stack: number }) => s + p.stack, 0)).toBe(3000);
    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    expect(ledger.verified.ok).toBe(true);
    const settlements = ledger.entries.filter(
      (e: { kind: string }) => e.kind === 'hand-settlement',
    );
    expect(settlements.length).toBeGreaterThan(0);
    expect(settlements[0].ref).toBe(players[0]!.handEnd!.head);
    const row = ctx.db
      .prepare('SELECT head FROM transcripts WHERE hand_id = ?')
      .get(players[0]!.handEnd!.handId) as { head: string };
    expect(row.head).toBe(players[0]!.handEnd!.head);

    // the session report reflects the played hand
    const session = await host.api(`/api/rooms/${room.id}/session`);
    expect(session.hands).toBeGreaterThanOrEqual(1);
    expect(session.firstTs).toBeLessThanOrEqual(session.lastTs);
    expect(session.biggestPot).toBeGreaterThan(0);
    const nets = session.players.reduce((s: number, p: { net: number }) => s + p.net, 0);
    expect(nets).toBe(0);

    // the hands list carries YOUR per-hand result (net + outcome)
    const hands = await host.api(`/api/rooms/${room.id}/hands`);
    const mine = hands.hands.find(
      (h: { handId: string }) => h.handId === players[0]!.handEnd!.handId,
    );
    const hostDelta = players[0]!.handEnd!.deltas.find((d: { seat: number }) => d.seat === 0)!;
    expect(mine.myNet).toBe(hostDelta.delta);
    expect(['won at showdown', 'lost at showdown']).toContain(mine.outcome);
    expect(mine.voided).toBe(false);
  }, 20000);

  it('a mid-hand buy survives the hand settlement', async () => {
    const { players, room, host } = await setupRoom(['heala', 'healb', 'healc']);
    host.send({ t: 'start_hand' });
    // the shuffle is still running: this purchase lands while the hand is live
    const req = await host.api(`/api/rooms/${room.id}/buy`, { amount: 500 });
    await host.api(`/api/rooms/${room.id}/approve`, { requestId: req.id, approve: true });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null)));

    const hostDelta = players[0]!.handEnd!.deltas.find(
      (d: { seat: number }) => d.seat === 0,
    )!.delta;
    const state = await host.api(`/api/rooms/${room.id}`);
    const me = state.players.find((p: { username: string }) => p.username === 'heala');
    // 1000 buy-in at setup, plus the hand's result, plus the mid-hand 500
    expect(me.stack).toBe(1000 + hostDelta + 500);
    // and the ledger agrees with the stack exactly
    const sum = ctx.db
      .prepare('SELECT SUM(delta) as s FROM ledger WHERE room_id = ? AND user_id = ?')
      .get(room.id, me.userId) as { s: number };
    expect(sum.s).toBe(me.stack);
  }, 20000);

  it('a mid-hand kick unseats for the next deal without breaking the hand', async () => {
    const { players, room, host } = await setupRoom(['kicka', 'kickb', 'kickc']);
    host.send({ t: 'start_hand' });
    // the hand is live (shuffling): the banker stands carol up anyway
    const carol = players[2]!;
    const res = await host.api(`/api/rooms/${room.id}/stand-up`, { userId: carol.userId });
    expect(res.ok).toBe(true);
    // the running hand keeps its snapshot and finishes normally with carol in it
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null)));
    expect(players[0]!.handAbort).toBeNull();
    const state = await host.api(`/api/rooms/${room.id}`);
    const carolRow = state.players.find((p: { username: string }) => p.username === 'kickc');
    expect(carolRow.seat).toBeNull();
    expect(state.players.reduce((t: number, p: { stack: number }) => t + p.stack, 0)).toBe(3000);
  }, 20000);

  it('fold-out ends the hand without any reveal', async () => {
    const { players, host } = await setupRoom(['host', 'bob'], ['fold-first', 'fold-first']);
    // heads-up: button/SB acts first and folds; BB wins blinds without showdown
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null)));
    for (const p of players) {
      expect(p.sawShowdown).toBe(false);
      expect(p.handAbort).toBeNull();
    }
    const deltas = players[0]!.handEnd!.deltas;
    expect(deltas.reduce((s, x) => s + x.delta, 0)).toBe(0);
    expect(Math.max(...deltas.map((d) => d.delta))).toBe(10); // BB wins the small blind
  });

  it('a stalling player causes an abort that blames them and leaves stacks untouched', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob', 'mallory']);
    players[2]!.respondShares = false; // mallory never answers unmask requests
    host.send({ t: 'start_hand' });
    await Promise.all(players.slice(0, 2).map((p) => p.waitFor(() => p.handAbort !== null, 20000)));
    expect(players[0]!.handAbort!.blamedSeat).toBe(2);
    const state = await host.api(`/api/rooms/${room.id}`);
    for (const p of state.players) expect(p.stack).toBe(1000);
  }, 20000);

  it('a disconnected player can rejoin during the grace window and the hand completes', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob', 'flaky']);
    const flaky = players[2]!;
    flaky.respondShares = false; // simulates a device that missed the requests
    host.send({ t: 'start_hand' });
    await new Promise((r) => setTimeout(r, 2000)); // the deal is now stalled on flaky
    expect(host.handAbort).toBeNull();
    flaky.ws.close();
    flaky.respondShares = true;
    await flaky.connect(room.id); // rejoin: the server re-sends what it is waiting on
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 20000)));
    for (const p of players) expect(p.handAbort).toBeNull();
    expect(flaky.myCards).toHaveLength(2);
  }, 20000);

  it('a folded player can voluntarily show cards while the hand continues', async () => {
    const { players, host } = await setupRoom(
      ['host', 'bob', 'carol'],
      ['fold-first', 'passive', 'passive'],
    );
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.lastRespondedActionSeq >= 0); // host has sent the fold
    await new Promise((r) => setTimeout(r, 200));
    host.showCards();
    await players[2]!.waitFor(() => players[2]!.cardsShown.length > 0);
    expect(players[2]!.cardsShown[0]!.seat).toBe(host.seat);
    expect(players[2]!.cardsShown[0]!.cards.slice().sort()).toEqual(host.myCards.slice().sort());
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null)));
    expect(players[0]!.handAbort).toBeNull();
  });

  it('a paid peek reveals cards only to the buyer and moves the chips', async () => {
    const { players, room, host } = await setupRoom(
      ['host', 'bob', 'carol'],
      ['fold-first', 'fold-first', 'passive'],
    );
    const [h, bob, carol] = players as [TestClient, TestClient, TestClient];
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null)));

    // carol (won by folds) pays 100 to see host's mucked cards
    carol.send({ t: 'peek_offer', handId: carol.handId, targetSeat: h.seat, amount: 100 });
    await h.waitFor(() => h.peekOffers.length > 0);
    expect(h.peekOffers[0]!.amount).toBe(100);
    h.acceptPeek(h.peekOffers[0]!.offerId);
    await carol.waitFor(() => carol.peekResults.length > 0);

    const result = carol.peekResults[0]!;
    expect(result.status).toBe('accepted');
    expect(result.cards!.slice().sort()).toEqual(h.myCards.slice().sort());
    // the reveal went only to the buyer
    expect(bob.peekResults).toHaveLength(0);
    expect(bob.cardsShown).toHaveLength(0);

    // chips moved: carol paid host 100 on top of the blind results
    const state = await host.api(`/api/rooms/${room.id}`);
    const stack = (name: string) => state.players.find((p: any) => p.username === name).stack;
    expect(stack('host')).toBe(1100); // folded for free, then sold a look for 100
    expect(stack('carol')).toBe(910); // won the 10 blind, paid 100
    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    expect(ledger.verified.ok).toBe(true);
    expect(ledger.entries.filter((e: any) => e.kind === 'peek')).toHaveLength(2);
  });

  it('the next hand deals itself while the host stays online', async () => {
    const { players, host } = await setupRoom(['host', 'bob'], ['fold-first', 'passive']);
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null)));
    const firstHandId = players[0]!.handEnd!.handId;
    // the clients answer the ready check, so the server deals again on its own
    await Promise.all(
      players.map((p) =>
        p.waitFor(() => p.handEnd !== null && p.handEnd.handId !== firstHandId, 15000),
      ),
    );
    expect(players[0]!.handEnd!.handId).not.toBe(firstHandId);
  }, 20000);

  it('auto-deals and settles the next hand with a fallback after the host disconnects', async () => {
    const { players, host } = await setupRoom(['fallbacka', 'fallbackb', 'fallbackc'], ['fold-first', 'passive', 'passive']);
    host.send({ t: 'start_hand' });
    await Promise.all(players.map(p => p.waitFor(() => p.handEnd !== null)));
    const firstHandId = players[1]!.handEnd!.handId;
    host.disconnect();
    await Promise.all(players.slice(1).map(p => p.waitFor(() => p.handEnd !== null && p.handEnd.handId !== firstHandId, 15000)));
    expect(players[1]!.roomState!.room.autoDealerId).toBe(players[1]!.userId);
    expect(players[1]!.roomState!.room.hostId).toBe(host.userId);
    expect(players[1]!.handEnd!.stacks.map(s => s.seat).sort()).toEqual([1, 2]);
    const ledger = await players[1]!.api(`/api/rooms/${players[1]!.roomState!.room.id}/ledger`);
    expect(ledger.verified.ok).toBe(true);
  }, 20000);

  it('a player who ignores the ready check is left out of the auto-dealt hand', async () => {
    const { players, host } = await setupRoom(['reada', 'readb', 'readc']);
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null)));
    const firstHandId = players[0]!.handEnd!.handId;
    // carol never clicks I'm ready: the deadline passes and the other two play
    players[2]!.autoReady = false;
    await Promise.all(
      players
        .slice(0, 2)
        .map((p) => p.waitFor(() => p.handEnd !== null && p.handEnd.handId !== firstHandId, 15000)),
    );
    const seats = players[0]!.handEnd!.stacks.map((x) => x.seat).sort();
    expect(seats).toEqual([0, 1]);
  }, 20000);

  it('TV replays save every key and decrypt folded hole cards into the transcript', async () => {
    const { players, room, host } = await setupRoom(
      ['tva', 'tvb', 'tvc'],
      ['passive', 'fold-first', 'passive'],
    );
    await host.api(`/api/rooms/${room.id}/settings`, { tvReplays: true }, 'PUT');
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null)));
    expect(players[0]!.handAbort).toBeNull();

    const hand = await host.api(`/api/rooms/${room.id}/hands/${players[0]!.handEnd!.handId}`);
    const keys = hand.entries.filter((e: { type: string }) => e.type === 'reveal_key');
    expect(keys).toHaveLength(3);
    // bob folded, so he never revealed at showdown - the key reveal decrypts him
    const holes = hand.entries.filter((e: { type: string }) => e.type === 'hole_cards');
    const bobSeatHole = holes.find((e: { payload: { seat: number } }) => e.payload.seat === 1);
    expect(bobSeatHole).toBeDefined();
    expect(new Set(bobSeatHole.payload.cards)).toEqual(new Set(players[1]!.myCards));
    // and the stored transcript still verifies end to end
    const row = ctx.db
      .prepare('SELECT head FROM transcripts WHERE hand_id = ?')
      .get(players[0]!.handEnd!.handId) as { head: string };
    expect(row.head).toBe(hand.head);
  });

  it('multi-run: the player behind chooses 2 runs and the ahead player agrees', async () => {
    const { players, room, host } = await setupRoom(['mra', 'mrb'], ['shove-flop', 'passive']);
    await host.api(
      `/api/rooms/${room.id}/settings`,
      { features: { multiRun: { enabled: true } } },
      'PUT',
    );
    players[0]!.runCountAnswer = 2;
    players[1]!.runCountAnswer = 2;
    players[0]!.runAgreeAnswer = true;
    players[1]!.runAgreeAnswer = true;
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 20000)));
    expect(players[0]!.handAbort).toBeNull();
    expect(players[0]!.multiRunResult).toMatchObject({ runs: 2, reason: 'agreed' });
    expect(players[0]!.sawMultiRunOffer).toBe(true);
    // the all-in happened on the flop, so only turn/river are run twice: the
    // flop is a shared card and the showdown reconstructs both full boards
    expect(players[0]!.board).toHaveLength(5);
    expect(players[0]!.board2).toHaveLength(2);
    expect(players[1]!.board2).toEqual(players[0]!.board2);
    const boards = players[0]!.lastShowdown!.multiRun!.boards;
    expect(boards).toHaveLength(2);
    for (const b of boards) expect(b).toHaveLength(5);
    expect(boards[1]!.slice(0, 3)).toEqual(boards[0]!.slice(0, 3)); // shared flop
    const all = [...boards.flat(), ...players.flatMap((p) => p.myCards)];
    // 5 shared run-1 cards + 2 run-2 turn/river + 4 hole cards, all distinct
    expect(new Set(all).size).toBe(11);
    // both halves settle: 2,000 pot, 0.5% rake, every chip accounted for
    expect(players[0]!.handEnd!.commission).toBe(10);
    expect(players[0]!.handEnd!.deltas.reduce((s, x) => s + x.delta, 0)).toBe(-10);
    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    expect(ledger.verified.ok).toBe(true);
  }, 25000);

  it('multi-run: refusing the run count runs the all-in board once', async () => {
    const { players, room, host } = await setupRoom(['mrc', 'mrd'], ['shove-flop', 'passive']);
    await host.api(
      `/api/rooms/${room.id}/settings`,
      { features: { multiRun: { enabled: true } } },
      'PUT',
    );
    players[0]!.runCountAnswer = 3;
    players[1]!.runCountAnswer = 3;
    players[0]!.runAgreeAnswer = false;
    players[1]!.runAgreeAnswer = false;
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 20000)));
    expect(players[0]!.handAbort).toBeNull();
    expect(players[0]!.multiRunResult).toMatchObject({ runs: 1, reason: 'declined' });
    expect(players[0]!.board).toHaveLength(5);
    expect(players[0]!.board2).toHaveLength(0);
  }, 25000);

  it('new rooms pay 0.5% to the platform, conserving chips on the ledger', async () => {
    const { players, room, host } = await setupRoom(['coma', 'comb'], ['allin-first', 'passive']);
    expect(room.commissionBps).toBe(50);
    expect(host.roomState?.room.commissionBps).toBe(50);
    const { userId: platformId } = createUser(ctx.db, 'platform', 'a'.repeat(64), 'b'.repeat(64));
    setPlatformUserId(ctx.db, platformId);
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 15000)));
    expect(players[0]!.handAbort).toBeNull();
    // 2,000 in the middle -> 10 raked, credited to the platform.
    expect(players[0]!.handEnd!.commission).toBe(10);
    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    const commission = ledger.entries.filter((e: { kind: string }) => e.kind === 'commission');
    expect(commission).toHaveLength(1);
    expect(commission[0].userId).toBe(platformId);
    expect(commission[0].delta).toBe(10);
    expect(commission[0].note).toContain('0.5%');
    expect(ledger.verified.ok).toBe(true);
    // room total unchanged: the rake moved, it did not vanish
    const state = await host.api(`/api/rooms/${room.id}`);
    expect(state.players.reduce((t: number, p: { stack: number }) => t + p.stack, 0)).toBe(1990);
    expect(
      ctx.db.prepare('SELECT SUM(stack) AS total FROM room_players WHERE room_id = ?').get(room.id),
    ).toEqual({ total: 2000 });
    const transcript = await host.api(`/api/rooms/${room.id}/hands/${players[0]!.handEnd!.handId}`);
    expect(
      transcript.entries.find((e: { type: string }) => e.type === 'hand_start').payload
        .commissionBps,
    ).toBe(50);
  }, 20000);

  it('rooms assigned 1% still settle at that rate', async () => {
    const { players, room, host } = await setupRoom(
      ['oldcoma', 'oldcomb'],
      ['allin-first', 'passive'],
    );
    ctx.db.prepare('UPDATE rooms SET commission_bps = 100 WHERE id = ?').run(room.id);
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 15000)));
    expect(players[0]!.handAbort).toBeNull();
    expect(players[0]!.handEnd!.commission).toBe(20);
    const state = await host.api(`/api/rooms/${room.id}`);
    expect(state.commissionBps).toBe(100);
    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    expect(ledger.entries.find((e: { kind: string }) => e.kind === 'commission')).toMatchObject({
      delta: 20,
      note: '1% table commission - keeps the lights on',
    });
    expect(ledger.verified.ok).toBe(true);
  }, 20000);

  it('keeps a running hand at its original rate and applies an admin change to the next deal', async () => {
    const { players, room, host } = await setupRoom(['ratea', 'rateb']);
    const { userId } = createUser(ctx.db, 'ratehouse', 'a'.repeat(64), 'b'.repeat(64));
    setPlatformUserId(ctx.db, userId);
    const token = createSession(ctx.db, userId);
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.handId !== null);
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/admin/settings/commission',
      headers: { authorization: `Bearer ${token}` },
      payload: { commissionBps: 100, scope: 'all_rooms', revision: 1 },
    });
    expect(res.statusCode).toBe(200);
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 15000)));
    expect(host.handAbort).toBeNull();
    expect(host.handEnd!.commissionBps).toBe(50);
    const firstId = host.handEnd!.handId;
    expect(ctx.db.prepare('SELECT commission_bps FROM rooms WHERE id = ?').get(room.id)).toEqual({
      commission_bps: 100,
    });
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.handEnd !== null && host.handEnd.handId !== firstId, 15000);
    expect(host.handEnd!.commissionBps).toBe(100);
    const transcript = await host.api(`/api/rooms/${room.id}/hands/${host.handEnd!.handId}`);
    expect(
      transcript.entries.find((e: { type: string }) => e.type === 'hand_start').payload
        .commissionBps,
    ).toBe(100);
  }, 30000);

  it('small pots won by folding incur no fractional or minimum commission', async () => {
    const { players, room, host } = await setupRoom(
      ['foldcoma', 'foldcomb'],
      ['fold-first', 'passive'],
    );
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 15000)));
    expect(players[0]!.handAbort).toBeNull();
    expect(players[0]!.handEnd!.commission).toBe(0);
    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    expect(ledger.entries.filter((e: { kind: string }) => e.kind === 'commission')).toEqual([]);
    expect(ledger.verified.ok).toBe(true);
    expect(
      ctx.db.prepare('SELECT SUM(stack) AS total FROM room_players WHERE room_id = ?').get(room.id),
    ).toEqual({ total: 2000 });
  }, 20000);

  it('a leaver during the shuffle aborts fast and the redeal skips them', async () => {
    const { players, host } = await setupRoom(['lva', 'lvb', 'lvc']);
    host.send({ t: 'start_hand' });
    // carol vanishes while keys/shuffles are still in flight
    await players[2]!.waitFor(() => players[2]!.handId !== null, 5000);
    const t0 = Date.now();
    players[2]!.disconnect();
    await Promise.all(
      players
        .slice(0, 2)
        .map((p) => p.waitFor(() => p.handAbort !== null || p.handEnd !== null, 12000)),
    );
    // the pre-betting grace is ~4s - nothing like the old multi-retry stall
    expect(Date.now() - t0).toBeLessThan(9000);
    if (players[0]!.handAbort) {
      expect(players[0]!.handAbort!.reason).toBe('player left during the deal');
    }
    // the very next deal excludes the leaver entirely
    const firstId = players[0]!.handId;
    host.send({ t: 'start_hand' });
    await Promise.all(
      players
        .slice(0, 2)
        .map((p) => p.waitFor(() => p.handEnd !== null && p.handId !== firstId, 15000)),
    );
    const seats = players[0]!.handEnd!.stacks.map((x) => x.seat).sort();
    expect(seats).toEqual([0, 1]);
  }, 30000);

  it('the ready check stops waiting for a player who left', async () => {
    const { players, host } = await setupRoom(['rlva', 'rlvb', 'rlvc']);
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null)));
    const firstHandId = players[0]!.handEnd!.handId;
    // carol never clicks ready and then leaves: the other two must not sit
    // through her 1.5s (in prod: 20s) deadline once she is gone
    players[2]!.autoReady = false;
    await players[0]!.waitFor(() => players[0]!.sawReadyCheck, 10000);
    players[2]!.disconnect();
    await Promise.all(
      players
        .slice(0, 2)
        .map((p) => p.waitFor(() => p.handEnd !== null && p.handEnd.handId !== firstHandId, 15000)),
    );
    const seats = players[0]!.handEnd!.stacks.map((x) => x.seat).sort();
    expect(seats).toEqual([0, 1]);
  }, 25000);

  it('profile debts: who owes whom shows up and clears when both sides settle', async () => {
    const { players, room, host } = await setupRoom(['debta', 'debtb'], ['allin-first', 'passive']);
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 15000)));
    expect(players[0]!.handAbort).toBeNull();
    // whoever bust the all-in owes the other their winnings (net of commission)
    const state = await host.api(`/api/rooms/${room.id}`);
    const nets = (state.players as { userId: number; stack: number; totalBought: number }[]).map(
      (p) => ({ userId: p.userId, net: p.stack - 1000 }),
    );
    const loser = players.find((p) => nets.find((n) => n.userId === p.userId)!.net < 0)!;
    const winner = players.find((p) => p !== loser)!;
    const owed = -nets.find((n) => n.userId === loser.userId)!.net;
    expect(owed).toBeGreaterThan(0);

    const mine = await loser.api('/api/me/debts');
    const row = mine.debts.find((d: { otherUserId: number }) => d.otherUserId === winner.userId);
    expect(row.direction).toBe('owe');
    expect(row.amount).toBe(owed);

    // the winner sees the mirror image
    const theirs = await winner.api('/api/me/debts');
    const mirror = theirs.debts.find(
      (d: { otherUserId: number }) => d.otherUserId === loser.userId,
    );
    expect(mirror.direction).toBe('owed');
    expect(mirror.amount).toBe(owed);

    // one side marking is only half the handshake
    const first = await loser.api('/api/settlements', {
      roomId: room.id,
      otherUserId: winner.userId,
    });
    expect(first.settled).toBe(false);
    const waiting = await winner.api('/api/me/debts');
    expect(
      waiting.debts.find((d: { otherUserId: number }) => d.otherUserId === loser.userId)
        .otherConfirmed,
    ).toBe(true);

    // both sides in: resolved on the platform, gone from the open list
    const second = await winner.api('/api/settlements', {
      roomId: room.id,
      otherUserId: loser.userId,
    });
    expect(second.settled).toBe(true);
    const after = await loser.api('/api/me/debts');
    expect(
      after.debts.filter((d: { otherUserId: number }) => d.otherUserId === winner.userId),
    ).toHaveLength(0);
    expect(after.settled.length).toBeGreaterThan(0);
    expect(after.settled[0].amount).toBe(owed);
  }, 20000);

  it('a sitting-out player is skipped when the next hand is dealt', async () => {
    const { players, host } = await setupRoom(['host', 'bob', 'carol']);
    players[2]!.send({ t: 'sit_out', sittingOut: true });
    await new Promise((r) => setTimeout(r, 100));
    host.send({ t: 'start_hand' });
    await Promise.all(players.slice(0, 2).map((p) => p.waitFor(() => p.handEnd !== null)));
    const seats = players[0]!.handEnd!.stacks.map((s) => s.seat).sort();
    expect(seats).toEqual([0, 1]);
  });

  it('the fold winner can voluntarily show cards after the hand ends', async () => {
    const { players, host } = await setupRoom(['host', 'bob'], ['fold-first', 'passive']);
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null)));
    const bob = players[1]!;
    bob.showCards();
    await host.waitFor(() => host.cardsShown.length > 0);
    expect(host.cardsShown[0]!.seat).toBe(bob.seat);
    expect(host.cardsShown[0]!.cards.slice().sort()).toEqual(bob.myCards.slice().sort());
  });
});

describe('player leave resilience', () => {
  it('a folded player leaving mid-hand no longer kills the hand', async () => {
    const { players, room, host } = await setupRoom(
      ['resa', 'resb', 'resc'],
      ['passive', 'fold-first', 'passive'],
    );
    const folder = players[1]!;
    host.send({ t: 'start_hand' });
    // the fold_key escrow is queued before the fold flag flips, so the close
    // frame always lands at the server after the key does
    await folder.waitFor(() => folder.sawOwnFold);
    const folderSeat = folder.seat;
    folder.disconnect();

    const rest = [players[0]!, players[2]!];
    await Promise.all(rest.map((p) => p.waitFor(() => p.handEnd !== null, 15000)));
    for (const p of rest) expect(p.handAbort).toBeNull();
    const end = host.handEnd!;

    // the server stepped over the absent folder with server-signed shares
    const hand = await host.api(`/api/rooms/${room.id}/hands/${end.handId}`);
    const recovered = hand.entries.filter((e: { type: string }) => e.type === 'recovered_share');
    expect(recovered.length).toBeGreaterThan(0);
    for (const e of recovered) expect(e.payload.seat).toBe(folderSeat);

    // chips conserved and the ledger still verifies end to end
    expect(end.deltas.reduce((s: number, x: { delta: number }) => s + x.delta, 0)).toBe(0);
    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    expect(ledger.verified.ok).toBe(true);
  }, 20000);

  it('a live player dropping heads-up ends the hand by fold instead of aborting', async () => {
    const { players, host, room } = await setupRoom(['dropa', 'dropb'], ['passive', 'passive']);
    const leaver = players[1]!;
    const stayer = players[0]!;
    host.send({ t: 'start_hand' });
    // wait until they are genuinely in the hand and have NOT folded, so this is
    // the case that used to be unrecoverable: nobody holds their key
    await leaver.waitFor(() => leaver.myCards.length === 2);
    expect(leaver.sawOwnFold).toBe(false);
    leaver.disconnect();

    // folding them leaves one contestant, so the pot is already decided and no
    // card has to be opened - the hand must finish rather than abort
    await stayer.waitFor(() => stayer.handEnd !== null, 15000);
    expect(stayer.handAbort).toBeNull();

    const end = stayer.handEnd!;
    expect(end.deltas.reduce((s: number, x: { delta: number }) => s + x.delta, 0)).toBe(0);
    // the player who stayed cannot have lost chips on a hand nobody contested
    const mine = end.deltas.find((d: { seat: number }) => d.seat === stayer.seat);
    expect(mine!.delta).toBeGreaterThanOrEqual(0);
    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    expect(ledger.verified.ok).toBe(true);
  }, 20000);

  it('no escrow, no rescue: a folder without a key still aborts the hand', async () => {
    const { players, room, host } = await setupRoom(
      ['noka', 'nokb', 'nokc'],
      ['passive', 'fold-first', 'passive'],
    );
    const folder = players[1]!;
    folder.autoFoldKey = false; // an old client that never escrows
    host.send({ t: 'start_hand' });
    await folder.waitFor(() => folder.sawOwnFold);
    const folderSeat = folder.seat;
    folder.disconnect();

    const rest = [players[0]!, players[2]!];
    await Promise.all(rest.map((p) => p.waitFor(() => p.handAbort !== null, 15000)));
    expect(rest[0]!.handAbort!.reason).toBe('unmask timeout');
    expect(rest[0]!.handAbort!.blamedSeat).toBe(folderSeat);

    // the abort returned every bet: all stacks back to their buy-ins
    const state = await host.api(`/api/rooms/${room.id}`);
    expect(state.players.reduce((s: number, p: { stack: number }) => s + p.stack, 0)).toBe(3000);
  }, 20000);

  it('a non-folded player leaving still aborts with refunds', async () => {
    const { players, room, host } = await setupRoom(['npa', 'npb', 'npc']);
    const leaver = players[2]!;
    host.send({ t: 'start_hand' });
    await leaver.waitFor(() => leaver.myCards.length === 2);
    leaver.disconnect(); // never folded, never escrowed: the hand cannot be saved

    const rest = [players[0]!, players[1]!];
    await Promise.all(rest.map((p) => p.waitFor(() => p.handAbort !== null, 15000)));
    expect(rest[0]!.handAbort!.reason).toBe('unmask timeout');

    const state = await host.api(`/api/rooms/${room.id}`);
    expect(state.players.reduce((s: number, p: { stack: number }) => s + p.stack, 0)).toBe(3000);
  }, 20000);

  it('a wrong escrow key is rejected', async () => {
    const { players, room, host } = await setupRoom(
      ['wka', 'wkb', 'wkc'],
      ['passive', 'fold-first', 'passive'],
    );
    const folder = players[1]!;
    folder.autoFoldKey = false;
    host.send({ t: 'start_hand' });
    await folder.waitFor(() => folder.sawOwnFold);
    // a bogus key, correctly signed: the commitment check must throw it out
    const key = '1234abcd';
    folder.send({
      t: 'fold_key',
      handId: folder.handId,
      key,
      sig: folder.signed('fold_key', { key }),
    });
    folder.disconnect();

    const rest = [players[0]!, players[2]!];
    await Promise.all(rest.map((p) => p.waitFor(() => p.handAbort !== null, 15000)));
    expect(rest[0]!.handAbort!.reason).toBe('unmask timeout');

    const state = await host.api(`/api/rooms/${room.id}`);
    expect(state.players.reduce((s: number, p: { stack: number }) => s + p.stack, 0)).toBe(3000);
  }, 20000);

  it('joining mid-hand spectates, then plays the next hand', async () => {
    const { players, room, host } = await setupRoom(['j2a', 'j2b']);
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.handId !== null);

    // a third player arrives while the hand is live
    const late = new TestClient(baseUrl, 'j2late');
    clients.push(late);
    await late.register();
    await late.api('/api/rooms/join', { joinCode: room.joinCode });
    const req = await late.api(`/api/rooms/${room.id}/buy`, { amount: 1000 });
    await host.api(`/api/rooms/${room.id}/approve`, { requestId: req.id, approve: true });
    await late.connect(room.id);
    late.send({ t: 'sit', seat: 2 });
    await late.waitFor(() => late.errors.length > 0);
    expect(late.errors).toContain('wait for the hand to end');

    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null)));
    const firstHandId = host.handEnd!.handId;
    const firstSeats = host.handEnd!.stacks.map((s) => s.seat).sort();
    expect(firstSeats).toEqual([0, 1]); // hand 1 never included the latecomer

    // now the seat sticks, and the next deal has them in it (the spectator saw
    // hand 1's hand_end broadcast too, so wait for a hand_end with a NEW id)
    late.send({ t: 'sit', seat: 2 });
    await new Promise((r) => setTimeout(r, 150));
    host.send({ t: 'start_hand' });
    await late.waitFor(() => late.handEnd !== null && late.handEnd.handId !== firstHandId, 15000);
    expect(late.handEnd!.stacks.map((s) => s.seat).sort()).toEqual([0, 1, 2]);
    expect(late.myCards).toHaveLength(2);
  }, 20000);

  it("TV replays recover an absent folder's cards", async () => {
    const { players, room, host } = await setupRoom(
      ['tvda', 'tvdb', 'tvdc'],
      ['passive', 'fold-first', 'passive'],
    );
    await host.api(`/api/rooms/${room.id}/settings`, { tvReplays: true }, 'PUT');
    host.send({ t: 'start_hand' });
    const folder = players[1]!;
    await folder.waitFor(() => folder.sawOwnFold);
    const folderSeat = folder.seat;
    const folderCards = [...folder.myCards];
    folder.disconnect();

    const rest = [players[0]!, players[2]!];
    await Promise.all(rest.map((p) => p.waitFor(() => p.handEnd !== null, 15000)));
    expect(rest[0]!.handAbort).toBeNull();
    const end = rest[0]!.handEnd!;

    // the escrowed fold-key filled in the absent folder's replay cards
    const hand = await host.api(`/api/rooms/${room.id}/hands/${end.handId}`);
    const hole = hand.entries.find(
      (e: { type: string; payload: { seat: number } }) =>
        e.type === 'hole_cards' && e.payload.seat === folderSeat,
    );
    expect(hole).toBeDefined();
    expect(new Set(hole.payload.cards)).toEqual(new Set(folderCards));
  }, 20000);
});

describe('P2 gameplay integration', () => {
  async function enable(host: TestClient, roomId: string, features: unknown): Promise<void> {
    const res = await host.api(`/api/rooms/${roomId}/settings`, { features }, 'PUT');
    expect(res.ok).toBe(true);
  }

  it('multi-run: choosing 3 runs with agreement deals three boards', async () => {
    const { players, room, host } = await setupRoom(['m3a', 'm3b'], ['shove-flop', 'passive']);
    await enable(host, room.id, { multiRun: { enabled: true } });
    for (const p of players) {
      p.runCountAnswer = 3;
      p.runAgreeAnswer = true;
    }
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 20000)));
    expect(players[0]!.handAbort).toBeNull();
    expect(players[0]!.multiRunResult).toMatchObject({ runs: 3, reason: 'agreed' });
    expect(players[0]!.board).toHaveLength(5);
    expect(players[0]!.board2).toHaveLength(2);
    expect(players[0]!.board3).toHaveLength(2);
    const boards = players[0]!.lastShowdown!.multiRun!.boards;
    expect(boards).toHaveLength(3);
    for (const b of boards) expect(b).toHaveLength(5);
    expect(boards[1]!.slice(0, 3)).toEqual(boards[0]!.slice(0, 3)); // shared flop
    expect(boards[2]!.slice(0, 3)).toEqual(boards[0]!.slice(0, 3));
    const all = [...boards.flat(), ...players.flatMap((p) => p.myCards)];
    // 5 shared run-1 + 2 + 2 run-specific + 4 hole cards, all distinct
    expect(new Set(all).size).toBe(13);
    expect(players[0]!.handEnd!.deltas.reduce((s, d) => s + d.delta, 0)).toBe(-10);
    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    expect(ledger.verified.ok).toBe(true);
  }, 25000);

  it('multi-run: ignoring the choice stage times out to a single run', async () => {
    const { players, room, host } = await setupRoom(['mta', 'mtb'], ['shove-flop', 'passive']);
    await enable(host, room.id, { multiRun: { enabled: true } });
    for (const p of players) p.runCountAnswer = null;
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 20000)));
    expect(players[0]!.handAbort).toBeNull();
    expect(players[0]!.multiRunResult).toMatchObject({ runs: 1, reason: 'timeout' });
    expect(players[0]!.board).toHaveLength(5);
    expect(players[0]!.board2).toHaveLength(0);
  }, 25000);

  it('multi-run: an unanswered agreement stage also falls back to one run', async () => {
    const { players, room, host } = await setupRoom(['mua', 'mub'], ['shove-flop', 'passive']);
    await enable(host, room.id, { multiRun: { enabled: true } });
    for (const p of players) {
      p.runCountAnswer = 2; // the player behind asks for two runs...
      p.runAgreeAnswer = null; // ...but the player ahead never answers
    }
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 20000)));
    expect(players[0]!.handAbort).toBeNull();
    expect(players[0]!.multiRunResult).toMatchObject({ runs: 1, reason: 'timeout' });
    expect(players[0]!.board2).toHaveLength(0);
  }, 25000);

  it('multi-run: more than two players all-in is forced to a single run', async () => {
    const { players, room, host } = await setupRoom(
      ['mwa', 'mwb', 'mwc'],
      ['shove-flop', 'shove-flop', 'shove-flop'],
    );
    await enable(host, room.id, { multiRun: { enabled: true } });
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 20000)));
    expect(players[0]!.handAbort).toBeNull();
    expect(players.every((p) => !p.sawMultiRunOffer)).toBe(true);
    expect(players[0]!.multiRunResult).toMatchObject({ runs: 1, reason: 'ineligible' });
    expect(players[0]!.board).toHaveLength(5);
    expect(players[0]!.board2).toHaveLength(0);
  }, 25000);

  it('bomb pot: a scheduled bomb antes everyone and opens the flop directly', async () => {
    const { players, room, host } = await setupRoom(['bomba', 'bombb']);
    await enable(host, room.id, {
      bombPot: { enabled: true, anteBb: 1, schedule: { mode: 'hands', value: 1 } },
    });
    // hand 1 is a normal deal: no bomb is due until one hand has completed
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 15000)));
    expect(players[0]!.featureStarted.some((f) => f.bombPot)).toBe(false);
    const firstId = players[0]!.handEnd!.handId;
    await players[0]!.waitIdle(room.id);

    host.send({ t: 'start_hand' });
    await Promise.all(
      players.map((p) =>
        p.waitFor(() => p.handEnd !== null && p.handEnd.handId !== firstId, 15000),
      ),
    );
    expect(players[0]!.handAbort).toBeNull();
    expect(players[0]!.featureStarted.some((f) => f.bombPot)).toBe(true);
    expect(players[0]!.board).toHaveLength(5);
    // the transcript records the bomb and starts betting on the flop
    const hand = await host.api(`/api/rooms/${room.id}/hands/${players[0]!.handEnd!.handId}`);
    expect(hand.entries.some((e: { type: string }) => e.type === 'bomb_pot_start')).toBe(true);
    // a bomb pot has no preflop betting round: no betting_start entry at all
    expect(hand.entries.some((e: { type: string }) => e.type === 'betting_start')).toBe(false);
    const streets = hand.entries.filter((e: { type: string }) => e.type === 'street');
    expect(streets[0].payload.street).toBe('flop');
    // and no client ever saw a legal preflop action
    expect(players[0]!.bettingStreets).not.toContain('preflop');
    expect(players[0]!.bettingStreets).toContain('flop');
    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    expect(ledger.verified.ok).toBe(true);
  }, 30000);

  it('bomb pot: a duration schedule fires once its clock has elapsed', async () => {
    const { players, room, host } = await setupRoom(['bda', 'bdb']);
    await enable(host, room.id, {
      bombPot: { enabled: true, anteBb: 2, schedule: { mode: 'duration', value: 60 } },
    });
    // hand 1 seeds the schedule clock and is a normal deal
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 15000)));
    expect(players[0]!.featureStarted.some((f) => f.bombPot)).toBe(false);
    const firstId = players[0]!.handEnd!.handId;
    await players[0]!.waitIdle(room.id);
    // age the anchor past the 60s interval
    ctx.db
      .prepare('UPDATE room_gameplay_state SET schedule_reset_at = ? WHERE room_id = ?')
      .run(Date.now() - 61_000, room.id);

    host.send({ t: 'start_hand' });
    await Promise.all(
      players.map((p) =>
        p.waitFor(() => p.handEnd !== null && p.handEnd.handId !== firstId, 15000),
      ),
    );
    expect(players[0]!.handAbort).toBeNull();
    expect(players[0]!.featureStarted.some((f) => f.bombPot)).toBe(true);
    expect(players[0]!.board).toHaveLength(5);
  }, 30000);

  it('bomb pot: a short stack antes what it has and goes all-in', async () => {
    const { players, room, host } = await setupRoom(['shorta', 'shortb']);
    await enable(host, room.id, {
      bombPot: { enabled: true, anteBb: 1, schedule: { mode: 'hands', value: 1 } },
    });
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 15000)));
    // stand bob down to a stack smaller than the ante before the bomb hand
    ctx.db
      .prepare('UPDATE room_players SET stack = 5 WHERE room_id = ? AND user_id = ?')
      .run(room.id, players[1]!.userId);
    const before = (
      ctx.db.prepare('SELECT SUM(stack) AS s FROM room_players WHERE room_id = ?').get(room.id) as {
        s: number;
      }
    ).s;

    const firstId = players[0]!.handEnd!.handId;
    await players[0]!.waitIdle(room.id);
    host.send({ t: 'start_hand' });
    await Promise.all(
      players.map((p) =>
        p.waitFor(() => p.handEnd !== null && p.handEnd.handId !== firstId, 20000),
      ),
    );
    expect(players[0]!.handAbort).toBeNull();
    expect(players[1]!.myCards).toHaveLength(2);
    expect(players[0]!.board).toHaveLength(5);
    expect(players[0]!.handEnd!.stacks.reduce((s, x) => s + x.stack, 0)).toBe(before);
    const shortDelta = players[0]!.handEnd!.deltas.find((d) => d.seat === players[1]!.seat)!;
    expect(shortDelta.delta).toBeGreaterThanOrEqual(-5);
  }, 30000);

  it('time bank: a slow-but-legal action spends bank past the base clock', async () => {
    const { players, room, host } = await setupRoom(['tba', 'tbb']);
    await enable(host, room.id, {
      timeBank: { enabled: true, initialSeconds: 10, refillEveryHands: 30, refillSeconds: 30 },
    });
    // the host acts ~200ms past the 1,500ms base clock each turn
    players[0]!.thinkMs = 1700;
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 20000)));
    expect(players[0]!.handAbort).toBeNull();
    const updates = players[0]!.timeBankUpdates.filter((u) => u.seat === players[0]!.seat);
    expect(updates.length).toBeGreaterThan(0);
    const last = updates[updates.length - 1]!;
    expect(last.remainingMs).toBeLessThan(10_000);
    expect(last.remainingMs).toBeGreaterThan(0);
    const row = ctx.db
      .prepare('SELECT time_bank_ms FROM room_players WHERE room_id = ? AND user_id = ?')
      .get(room.id, players[0]!.userId) as { time_bank_ms: number };
    expect(row.time_bank_ms).toBe(last.remainingMs);
  }, 30000);

  it('time bank: a timeout burns what is left and auto-folds', async () => {
    const { players, room, host } = await setupRoom(['tca', 'tcb']);
    await enable(host, room.id, {
      timeBank: { enabled: true, initialSeconds: 1, refillEveryHands: 30, refillSeconds: 30 },
    });
    // the host never acts: base 1.5s + 1s bank = 2.5s, then auto-fold
    players[0]!.ignoreActions = true;
    host.send({ t: 'start_hand' });
    await players[1]!.waitFor(() => players[1]!.handEnd !== null, 20000);
    expect(players[0]!.handAbort).toBeNull();
    const updates = players[0]!.timeBankUpdates.filter((u) => u.seat === players[0]!.seat);
    expect(updates.some((u) => u.remainingMs === 0)).toBe(true);
    const row = ctx.db
      .prepare('SELECT time_bank_ms FROM room_players WHERE room_id = ? AND user_id = ?')
      .get(room.id, players[0]!.userId) as { time_bank_ms: number };
    expect(row.time_bank_ms).toBe(0);
  }, 25000);

  it('squid: the fold loser pays the penalty to the winner', async () => {
    const { players, room, host } = await setupRoom(['sqa', 'sqb'], ['fold-first', 'passive']);
    await enable(host, room.id, { squid: { enabled: true, penaltyBb: 1, minPlayers: 2 } });
    const trig = await host.api(`/api/rooms/${room.id}/feature-triggers`, {
      feature: 'squid',
      requestId: 'sq-1',
    });
    expect(trig.trigger.status).toBe('pending');

    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 15000)));
    expect(players[0]!.handAbort).toBeNull();
    const hostSeat = players[0]!.seat!;
    const bobSeat = players[1]!.seat!;
    const sq = players[1]!.squidResult!;
    expect(sq.noClaimant).toBe(false);
    expect(sq.winners).toEqual([bobSeat]);
    expect(sq.requestedPerLoser).toBe(20); // 1 * bb(20) * (2 - 1)
    expect(sq.transfers).toEqual([{ from: hostSeat, to: bobSeat, amount: 20 }]);

    const hostDelta = players[0]!.handEnd!.deltas.find((d) => d.seat === hostSeat)!.delta;
    const bobDelta = players[1]!.handEnd!.deltas.find((d) => d.seat === bobSeat)!.delta;
    expect(hostDelta).toBe(-30); // SB 10 + squid 20
    expect(bobDelta).toBe(30);
    expect(players[0]!.handEnd!.deltas.reduce((s, d) => s + d.delta, 0)).toBe(0);
    expect(players[0]!.handEnd!.squidDeltas!.reduce((s, d) => s + d.delta, 0)).toBe(0);

    const row = ctx.db
      .prepare("SELECT status FROM room_feature_triggers WHERE room_id = ? AND kind = 'squid'")
      .get(room.id) as { status: string };
    expect(row.status).toBe('applied');
    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    expect(ledger.verified.ok).toBe(true);
    const squidRows = ledger.entries.filter((e: { kind: string }) => e.kind === 'squid-game');
    expect(squidRows.map((e: { delta: number }) => e.delta).sort((a: number, b: number) => a - b)).toEqual(
      [-20, 20],
    );
  }, 25000);

  it('squid: a multi-run hand only pays a common winner and conserves chips', async () => {
    const { players, room, host } = await setupRoom(['smra', 'smrb'], ['shove-flop', 'passive']);
    await enable(host, room.id, {
      multiRun: { enabled: true },
      squid: { enabled: true, penaltyBb: 1, minPlayers: 2 },
    });
    await host.api(`/api/rooms/${room.id}/feature-triggers`, {
      feature: 'squid',
      requestId: 'smr-1',
    });
    for (const p of players) {
      p.runCountAnswer = 2;
      p.runAgreeAnswer = true;
    }
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 20000)));
    expect(players[0]!.handAbort).toBeNull();
    const sq = players[1]!.squidResult!;
    expect(sq).not.toBeNull();
    expect(players[0]!.handEnd!.squidDeltas!.reduce((s, d) => s + d.delta, 0)).toBe(0);
    if (sq.winners.length === 0) {
      expect(sq.noClaimant).toBe(true);
      expect(sq.transfers).toEqual([]);
    } else {
      expect(sq.noClaimant).toBe(false);
      // every transfer moves chips; the broke all-in loser can only pay what
      // it has left, so an empty transfer list is legitimate
      for (const t of sq.transfers) expect(t.amount).toBeGreaterThan(0);
    }
    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    expect(ledger.verified.ok).toBe(true);
  }, 25000);

  it('abort: a claimed manual squid trigger returns to pending and moves no chips', async () => {
    const { players, room, host } = await setupRoom(['aba', 'abb']);
    await enable(host, room.id, { squid: { enabled: true, penaltyBb: 1, minPlayers: 2 } });
    await host.api(`/api/rooms/${room.id}/feature-triggers`, {
      feature: 'squid',
      requestId: 'ab-1',
    });
    host.send({ t: 'start_hand' });
    await players[0]!.waitFor(() => players[0]!.handId !== null, 5000);
    await players[0]!.waitFor(() => {
      const r = ctx.db
        .prepare("SELECT status FROM room_feature_triggers WHERE room_id = ? AND kind = 'squid'")
        .get(room.id) as { status: string } | undefined;
      return r?.status === 'claimed';
    }, 5000);
    players[1]!.disconnect();
    await players[0]!.waitFor(() => players[0]!.handAbort !== null, 15000);
    const row = ctx.db
      .prepare("SELECT status FROM room_feature_triggers WHERE room_id = ? AND kind = 'squid'")
      .get(room.id) as { status: string };
    expect(row.status).toBe('pending');
    const state = await host.api(`/api/rooms/${room.id}`);
    for (const p of state.players) expect(p.stack).toBe(1000);
  }, 25000);

  it('bomb pot x multi-run x squid all settle together in one hand', async () => {
    // hand 1 stays small so both players remain funded for the bomb hand;
    // they shove the flop only once the bomb is live
    const { players, room, host } = await setupRoom(['comba', 'combb'], ['passive', 'passive']);
    await enable(host, room.id, {
      bombPot: { enabled: true, anteBb: 1, schedule: { mode: 'hands', value: 1 } },
      multiRun: { enabled: true },
      squid: { enabled: true, penaltyBb: 1, minPlayers: 2 },
    });
    for (const p of players) {
      p.runCountAnswer = 2;
      p.runAgreeAnswer = true;
    }
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 20000)));
    expect(players[0]!.handAbort).toBeNull();
    const firstId = players[0]!.handEnd!.handId;
    await players[0]!.waitIdle(room.id);
    for (const p of players) p.strategy = 'shove-flop';
    const before = (
      ctx.db
        .prepare('SELECT SUM(stack) AS s FROM room_players WHERE room_id = ?')
        .get(room.id) as { s: number }
    ).s;
    await host.api(`/api/rooms/${room.id}/feature-triggers`, {
      feature: 'squid',
      requestId: 'combo-1',
    });
    host.send({ t: 'start_hand' });
    await Promise.all(
      players.map((p) =>
        p.waitFor(() => p.handEnd !== null && p.handEnd.handId !== firstId, 30000),
      ),
    );
    expect(players[0]!.handAbort).toBeNull();
    expect(players[0]!.featureStarted.some((f) => f.bombPot)).toBe(true);
    expect(players[0]!.multiRunResult).toMatchObject({ runs: 2 });
    expect(players[1]!.squidResult).not.toBeNull();
    // `hand_end.stacks` exclude the rake credited separately, so the room total
    // is conserved once that commission is added back
    const end = players[0]!.handEnd!;
    expect(end.stacks.reduce((s, x) => s + x.stack, 0)).toBe(before - (end.commission ?? 0));
    expect(players[0]!.handEnd!.squidDeltas!.reduce((s, d) => s + d.delta, 0)).toBe(0);
    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    expect(ledger.verified.ok).toBe(true);
  }, 45000);
});

describe('P2 hardening', () => {
  async function enable(host: TestClient, roomId: string, features: unknown): Promise<void> {
    const res = await host.api(`/api/rooms/${roomId}/settings`, { features }, 'PUT');
    expect(res.ok).toBe(true);
  }

  function sendChoice(c: TestClient, decisionId: string, count: 1 | 2 | 3): void {
    const body = { decisionId, count };
    c.send({
      t: 'run_count_choice',
      handId: c.handId,
      decisionId,
      count,
      sig: c.signed('run_count_choice', body),
    });
  }

  function sendAgree(c: TestClient, decisionId: string, agree: boolean): void {
    const body = { decisionId, agree };
    c.send({
      t: 'run_count_agree',
      handId: c.handId,
      decisionId,
      agree,
      sig: c.signed('run_count_agree', body),
    });
  }

  it('idempotency: applyHandSettlement applies once and keeps the ledger chain valid', async () => {
    const { players, room } = await setupRoom(['ida', 'idb']);
    const a = players[0]!.userId;
    const b = players[1]!.userId;
    const args = {
      handId: 'idem-hand-1',
      roomId: room.id,
      head: 'idem-head-1',
      entries: [],
      rake: 5,
      commissionBps: 50,
      stackDeltas: [
        { userId: a, delta: -105 },
        { userId: b, delta: 100 },
      ],
      pokerLedger: [
        { userId: a, delta: -105 },
        { userId: b, delta: 100 },
      ],
      squidLedger: [],
      squidNote: 'Squid Game penalty/payout',
      timeBanks: [],
      timeBankEpoch: null,
      triggerIds: [],
      bombRan: false,
      rakeRecipientId: a,
      now: Date.now(),
    };
    const stackOf = (uid: number) =>
      (
        ctx.db
          .prepare('SELECT stack FROM room_players WHERE room_id = ? AND user_id = ?')
          .get(room.id, uid) as { stack: number }
      ).stack;

    expect(applyHandSettlement(ctx.db, args).status).toBe('applied');
    const a1 = stackOf(a);
    const b1 = stackOf(b);
    const ledgerRows = () =>
      (ctx.db.prepare('SELECT COUNT(*) AS n FROM ledger WHERE room_id = ?').get(room.id) as {
        n: number;
      }).n;
    const before = ledgerRows();

    expect(applyHandSettlement(ctx.db, args).status).toBe('duplicate');
    expect(stackOf(a)).toBe(a1);
    expect(stackOf(b)).toBe(b1);
    expect(ledgerRows()).toBe(before); // duplicate appended nothing
    expect(
      (ctx.db.prepare('SELECT COUNT(*) AS n FROM hand_settlements WHERE hand_id = ?').get(
        args.handId,
      ) as { n: number }).n,
    ).toBe(1);
    expect(verifyLedger(ctx.db, room.id).ok).toBe(true);
  });

  it('recovery: releases a claimed trigger only when its settlement marker is absent', async () => {
    const { room } = await setupRoom(['rca', 'rcb']);
    const now = Date.now();
    ctx.db
      .prepare(
        `INSERT INTO room_feature_triggers
           (room_id, request_id, kind, source, status, requested_by, created_at, claimed_hand_id)
         VALUES (?, ?, 'squid', 'manual', 'claimed', NULL, ?, ?)`,
      )
      .run(room.id, 'rec-1', now, 'orphan-hand');
    expect(recoverOrphanedFeatureTriggers(ctx.db)).toBe(1);
    let row = ctx.db
      .prepare("SELECT id, status FROM room_feature_triggers WHERE room_id = ? AND kind = 'squid'")
      .get(room.id) as { id: number; status: string };
    expect(row.status).toBe('pending');

    // resolve the first so it does not block the partial pending unique index
    ctx.db.prepare("UPDATE room_feature_triggers SET status = 'applied' WHERE id = ?").run(row.id);
    ctx.db
      .prepare(
        `INSERT INTO room_feature_triggers
           (room_id, request_id, kind, source, status, requested_by, created_at, claimed_hand_id)
         VALUES (?, ?, 'squid', 'manual', 'claimed', NULL, ?, ?)`,
      )
      .run(room.id, 'rec-2', now, 'settled-hand');
    ctx.db
      .prepare(
        'INSERT INTO hand_settlements (hand_id, room_id, head, rake, applied_at) VALUES (?, ?, ?, 0, ?)',
      )
      .run('settled-hand', room.id, 'h', now);
    expect(recoverOrphanedFeatureTriggers(ctx.db)).toBe(0);
    row = ctx.db
      .prepare(
        "SELECT status FROM room_feature_triggers WHERE room_id = ? AND kind = 'squid' AND request_id = 'rec-2'",
      )
      .get(room.id) as { id: number; status: string };
    expect(row.status).toBe('claimed');

    // an aborted hand leaves no marker, so the next startup releases it
    ctx.db
      .prepare(
        "UPDATE room_feature_triggers SET status = 'claimed', resolved_at = NULL WHERE request_id = 'rec-2'",
      )
      .run();
    ctx.db.prepare("UPDATE hand_settlements SET hand_id = 'other' WHERE hand_id = 'settled-hand'").run();
    expect(recoverOrphanedFeatureTriggers(ctx.db)).toBe(1);
  });

  it('actions: rejected and duplicate actions never become transcript action entries', async () => {
    const { players, room, host } = await setupRoom(['ata', 'atb'], ['passive', 'passive']);
    const bob = players[1]!;
    host.ignoreActions = true; // drive the host manually
    bob.ignoreActions = true; // keep bob's turn open so the duplicate lands mid-round
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.lastState?.toAct === host.seat, 10000);

    const check = { type: 'check' as const };
    // bob acts out of turn
    bob.send({
      t: 'action',
      handId: bob.handId,
      action: check,
      sig: bob.signed('action', { action: check }),
    });
    await bob.waitFor(() => bob.errors.length > 0, 5000);

    const call = { type: 'call' as const };
    host.send({
      t: 'action',
      handId: host.handId,
      action: call,
      sig: host.signed('action', { action: call }),
    });
    await host.waitFor(() => host.lastState?.toAct === bob.seat, 5000);
    // host's stale duplicate is rejected
    host.send({
      t: 'action',
      handId: host.handId,
      action: call,
      sig: host.signed('action', { action: call }),
    });
    host.ignoreActions = false;
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 15000)));

    const hand = await host.api(`/api/rooms/${room.id}/hands/${host.handEnd!.handId}`);
    const actions = (hand.entries as { type: string; payload: { seat: number } }[]).filter(
      (e) => e.type === 'action',
    );
    const rejected = (hand.entries as { type: string; payload: { seat: number } }[]).filter(
      (e) => e.type === 'action_rejected',
    );
    // every applied action has exactly one transcript entry; a rejected one has none
    for (const p of players) {
      const applied = p.actionApplied.filter((a) => a.seat === p.seat && !a.auto).length;
      expect(actions.filter((e) => e.payload.seat === p.seat)).toHaveLength(applied);
    }
    expect(rejected.some((e) => e.payload.seat === bob.seat)).toBe(true);
    expect(rejected.some((e) => e.payload.seat === host.seat)).toBe(true);
  }, 25000);

  it('deadline: an action before the deadline is honored, the timeout fold is the only later transition', async () => {
    const { players, room, host } = await setupRoom(['dla', 'dlb'], ['passive', 'passive']);
    const bob = players[1]!;
    bob.ignoreActions = true;
    host.thinkMs = 400; // acts ~1.1s before the 1.5s deadline
    host.send({ t: 'start_hand' });
    await bob.waitFor(() => bob.lastState?.toAct === bob.seat, 10000);
    await host.waitFor(() => host.handEnd !== null || host.handAbort !== null, 10000);
    expect(host.handAbort).toBeNull();

    const hand = await host.api(`/api/rooms/${room.id}/hands/${host.handEnd!.handId}`);
    const entries = hand.entries as { type: string; payload: { seat: number } }[];
    expect(entries.some((e) => e.type === 'action' && e.payload.seat === host.seat)).toBe(true);
    expect(entries.some((e) => e.type === 'action' && e.payload.seat === bob.seat)).toBe(false);
    expect(entries.some((e) => e.type === 'timeout_fold' && e.payload.seat === bob.seat)).toBe(true);
  }, 25000);

  it('deadline: an action sent at the final deadline is not honored', async () => {
    const { players, room, host } = await setupRoom(['dea', 'deb'], ['passive', 'passive']);
    const bob = players[1]!;
    host.ignoreActions = true;
    bob.ignoreActions = true;
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.lastState?.toAct === host.seat && host.lastDeadline !== null, 10000);
    const delay = Math.max(0, host.lastDeadline! - Date.now() + 25);
    setTimeout(() => {
      const call = { type: 'call' as const };
      host.send({
        t: 'action',
        handId: host.handId,
        action: call,
        sig: host.signed('action', { action: call }),
      });
    }, delay);
    await host.waitFor(() => host.handEnd !== null || host.handAbort !== null, 10000);
    expect(host.handAbort).toBeNull();
    const hand = await host.api(`/api/rooms/${room.id}/hands/${host.handEnd!.handId}`);
    const entries = hand.entries as { type: string; payload: { seat: number } }[];
    expect(entries.some((e) => e.type === 'action' && e.payload.seat === host.seat)).toBe(false);
    expect(entries.some((e) => e.type === 'timeout_fold' && e.payload.seat === host.seat)).toBe(true);
  }, 25000);

  it('squid: multiple losers pay each other and netBySeat is authoritative', async () => {
    const { players, room, host } = await setupRoom(
      ['sma', 'smb', 'smc'],
      ['fold-first', 'fold-first', 'passive'],
    );
    await enable(host, room.id, { squid: { enabled: true, penaltyBb: 1, minPlayers: 2 } });
    await host.api(`/api/rooms/${room.id}/feature-triggers`, {
      feature: 'squid',
      requestId: 'sq-multi',
    });
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 15000)));
    const sq = players[2]!.squidResult!;
    expect(sq.winners).toHaveLength(1);
    const winnerSeat = sq.winners[0]!;
    const losers = players.map((p) => p.seat!).filter((s) => s !== winnerSeat);
    expect(sq.requestedPerLoser).toBe(40); // 1 * bb(20) * (3 - 1)
    expect(sq.transfers).toHaveLength(4); // each of 2 losers pays 2 recipients
    const net = new Map(sq.netBySeat!.map((n) => [n.seat, n.net]));
    // each loser pays 40 split over the two other seats, so the winner nets 40
    expect(net.get(winnerSeat)).toBe(40);
    for (const l of losers) expect(net.get(l)).toBe(-20); // pays 40, receives 20 from the other loser
    expect([...net.values()].reduce((s, v) => s + v, 0)).toBe(0);
    // losers receive from other losers, not only from the winner
    expect(sq.transfers.some((t) => losers.includes(t.to))).toBe(true);
    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    expect(ledger.verified.ok).toBe(true);
  }, 25000);

  it('time bank: an aborted hand discards in-memory debits', async () => {
    const { players, room, host } = await setupRoom(['tba2', 'tbb2']);
    await enable(host, room.id, {
      timeBank: { enabled: true, initialSeconds: 5, refillEveryHands: 30, refillSeconds: 30 },
    });
    const read = () =>
      (
        ctx.db
          .prepare('SELECT time_bank_ms FROM room_players WHERE room_id = ? AND user_id = ?')
          .get(room.id, host.userId) as { time_bank_ms: number }
      ).time_bank_ms;
    expect(read()).toBe(5000);
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.handId !== null, 5000);
    players[1]!.disconnect();
    await host.waitFor(() => host.handAbort !== null, 15000);
    // hand-atomic: the abort wrote nothing back, so the bank is untouched
    expect(read()).toBe(5000);
  }, 25000);

  it('time bank: a mid-hand epoch change is skipped and audited', async () => {
    const { players, room, host } = await setupRoom(['tce', 'tcf'], ['passive', 'passive']);
    await enable(host, room.id, {
      timeBank: { enabled: true, initialSeconds: 5, refillEveryHands: 30, refillSeconds: 30 },
    });
    for (const p of players) p.thinkMs = 300; // slow the hand so the mid-hand change lands
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.bettingStreets.includes('preflop'), 8000);
    // simulate a config change that resets the bank and bumps the epoch mid-hand
    ctx.db.prepare('UPDATE rooms SET time_bank_epoch = time_bank_epoch + 1 WHERE id = ?').run(room.id);
    const epoch = (
      ctx.db.prepare('SELECT time_bank_epoch AS e FROM rooms WHERE id = ?').get(room.id) as {
        e: number;
      }
    ).e;
    ctx.db
      .prepare(
        'UPDATE room_players SET time_bank_ms = 7000, time_bank_hands = 0, time_bank_epoch = ? WHERE room_id = ?',
      )
      .run(epoch, room.id);
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 20000)));

    const row = ctx.db
      .prepare('SELECT time_bank_ms FROM room_players WHERE room_id = ? AND user_id = ?')
      .get(room.id, host.userId) as { time_bank_ms: number };
    expect(row.time_bank_ms).toBe(7000); // stale snapshot not written over the reset
    const hand = await host.api(`/api/rooms/${room.id}/hands/${host.handEnd!.handId}`);
    expect(
      (hand.entries as { type: string }[]).some((e) => e.type === 'time_bank_epoch_mismatch'),
    ).toBe(true);
  }, 30000);

  it('multi-run: stale and duplicate decision ids are ignored', async () => {
    const { players, room, host } = await setupRoom(['mda', 'mdb'], ['shove-flop', 'passive']);
    await enable(host, room.id, { multiRun: { enabled: true } });
    for (const p of players) {
      p.runCountAnswer = null;
      p.runAgreeAnswer = null;
    }
    host.send({ t: 'start_hand' });
    await players[0]!.waitFor(
      () => players[0]!.multiRunOffers.some((o) => o.stage === 'choice'),
      15000,
    );
    const offer = players[0]!.multiRunOffers.find((o) => o.stage === 'choice')!;
    const behind = players.find((p) => p.seat === offer.behindSeat)!;
    const ahead = players.find((p) => p.seat === offer.aheadSeat)!;

    sendChoice(behind, 'bogus-decision', 2);
    await new Promise((r) => setTimeout(r, 150));
    expect(behind.multiRunOffers.some((o) => o.stage === 'agreement')).toBe(false);

    sendChoice(behind, offer.decisionId, 2);
    await ahead.waitFor(() => ahead.multiRunOffers.some((o) => o.stage === 'agreement'), 8000);
    // duplicate choice from the now-wrong stage is ignored
    sendChoice(behind, offer.decisionId, 3);
    await new Promise((r) => setTimeout(r, 150));

    sendAgree(ahead, 'bogus-decision', true);
    await new Promise((r) => setTimeout(r, 150));
    expect(players[0]!.multiRunResult).toBeNull();

    sendAgree(ahead, offer.decisionId, true);
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 15000)));
    expect(players[0]!.handAbort).toBeNull();
    expect(players[0]!.multiRunResult).toMatchObject({ runs: 2, reason: 'agreed' });

    const hand = await host.api(`/api/rooms/${room.id}/hands/${players[0]!.handEnd!.handId}`);
    const entries = hand.entries as { type: string }[];
    expect(entries.filter((e) => e.type === 'run_count_choice')).toHaveLength(1);
    expect(entries.filter((e) => e.type === 'run_count_agree')).toHaveLength(1);
  }, 30000);

  it('multi-run: a reconnect during a stage resends the current offer', async () => {
    const { players, room, host } = await setupRoom(['rca2', 'rcb2'], ['shove-flop', 'passive']);
    await enable(host, room.id, { multiRun: { enabled: true } });
    for (const p of players) {
      p.runCountAnswer = 2;
      p.runAgreeAnswer = null;
    }
    host.send({ t: 'start_hand' });
    await players[0]!.waitFor(
      () => players[0]!.multiRunOffers.some((o) => o.stage === 'agreement'),
      15000,
    );
    const offer = players[0]!.multiRunOffers.find((o) => o.stage === 'agreement')!;
    const ahead = players.find((p) => p.seat === offer.aheadSeat)!;
    const seen = ahead.multiRunOffers.filter((o) => o.stage === 'agreement').length;

    ahead.disconnect();
    await ahead.connect(room.id);
    await ahead.waitFor(
      () => ahead.multiRunOffers.filter((o) => o.stage === 'agreement').length > seen,
      8000,
    );
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 15000)));
    expect(players[0]!.handAbort).toBeNull();
  }, 30000);

  it('multi-run: a reconnect during the equity window still completes', async () => {
    const { players, room, host } = await setupRoom(['rea', 'reb'], ['allin-first', 'passive']);
    await enable(host, room.id, { multiRun: { enabled: true } });
    for (const p of players) {
      p.runCountAnswer = 1;
      p.runAgreeAnswer = true;
    }
    host.send({ t: 'start_hand' });
    await players[0]!.waitFor(() => players[0]!.handId !== null, 5000);
    const bob = players[1]!;
    bob.disconnect();
    await bob.connect(room.id);
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 15000)));
    expect(players[0]!.handAbort).toBeNull();
    expect(players[0]!.multiRunResult).not.toBeNull();
  }, 25000);

  it('bomb pot: ante caps and pot conservation hold for 2-9 seats', () => {
    for (let n = 2; n <= 9; n++) {
      const stacks = Array.from({ length: n }, (_, i) => (i === 1 ? 5 : i === 2 ? 20 : 100));
      const st = startBombPot(
        stacks.map((stack, i) => ({ seat: i, stack })),
        0,
        20,
        20,
      );
      const total = st.seats.reduce((s, x) => s + x.total, 0);
      expect(total).toBe(stacks.reduce((s, x) => s + Math.min(x, 20), 0));
      for (const [i, x] of st.seats.entries()) {
        expect(x.committed).toBe(0);
        expect(x.total).toBe(Math.min(stacks[i]!, 20));
        if (stacks[i]! <= 20) expect(x.allIn).toBe(true);
      }
      const pots = computePots(st.seats);
      expect(pots.reduce((s, p) => s + p.amount, 0)).toBe(total);
      const scores = new Map(st.seats.map((x) => [x.seat, x.seat === 0 ? 100 : 1]));
      const awards = awardPots(
        pots,
        scores,
        st.seats.map((x) => x.seat),
      );
      expect([...awards.values()].reduce((s, a) => s + a, 0)).toBe(total);
    }
    // odd-chip remainder runs front-loaded
    expect(splitAmountEven(101, 3)).toEqual([34, 34, 33]);
  });

  it('multi-run: a side pot with two live players stays conserved', async () => {
    const { players, room, host } = await setupRoom(
      ['spf', 'spa', 'spb'],
      ['fold-first', 'shove-flop', 'shove-flop'],
    );
    await enable(host, room.id, { multiRun: { enabled: true } });
    // unequal stacks so a side pot forms between the two all-in players
    ctx.db
      .prepare('UPDATE room_players SET stack = ? WHERE room_id = ? AND user_id = ?')
      .run(400, room.id, players[1]!.userId);
    ctx.db
      .prepare('UPDATE room_players SET stack = ? WHERE room_id = ? AND user_id = ?')
      .run(700, room.id, players[2]!.userId);
    for (const p of players) {
      p.runCountAnswer = 2;
      p.runAgreeAnswer = true;
    }
    const before = (
      ctx.db.prepare('SELECT SUM(stack) AS s FROM room_players WHERE room_id = ?').get(room.id) as {
        s: number;
      }
    ).s;
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 20000)));
    expect(players[0]!.handAbort).toBeNull();
    expect(players[0]!.multiRunResult).toMatchObject({ runs: 2 });
    const end = players[0]!.handEnd!;
    expect(end.stacks.reduce((s, x) => s + x.stack, 0)).toBe(before - (end.commission ?? 0));
    expect(end.deltas.reduce((s, d) => s + d.delta, 0)).toBe(-(end.commission ?? 0));
    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    expect(ledger.verified.ok).toBe(true);
  }, 30000);

  it('bomb pot: unequal stacks, an ante-only short stack and a post-flop fold conserve chips', async () => {
    const { players, room, host } = await setupRoom(
      ['b4a', 'b4b', 'b4c', 'b4d'],
      ['passive', 'passive', 'fold-first', 'passive'],
    );
    await enable(host, room.id, {
      bombPot: { enabled: true, anteBb: 1, schedule: { mode: 'hands', value: 1 } },
    });
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 15000)));
    const firstId = players[0]!.handEnd!.handId;
    await players[0]!.waitIdle(room.id);
    // one ante-only stack (15 < 20) and one unequal stack
    ctx.db
      .prepare('UPDATE room_players SET stack = ? WHERE room_id = ? AND user_id = ?')
      .run(15, room.id, players[1]!.userId);
    ctx.db
      .prepare('UPDATE room_players SET stack = ? WHERE room_id = ? AND user_id = ?')
      .run(300, room.id, players[2]!.userId);
    const before = (
      ctx.db.prepare('SELECT SUM(stack) AS s FROM room_players WHERE room_id = ?').get(room.id) as {
        s: number;
      }
    ).s;

    host.send({ t: 'start_hand' });
    await Promise.all(
      players.map((p) =>
        p.waitFor(() => p.handEnd !== null && p.handEnd.handId !== firstId, 20000),
      ),
    );
    expect(players[0]!.handAbort).toBeNull();
    expect(players[0]!.board).toHaveLength(5);
    expect(players[0]!.bettingStreets).not.toContain('preflop');
    const end = players[0]!.handEnd!;
    expect(end.stacks.reduce((s, x) => s + x.stack, 0)).toBe(before - (end.commission ?? 0));
    for (const s of end.stacks) expect(s.stack).toBeGreaterThanOrEqual(0);
    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    expect(ledger.verified.ok).toBe(true);
  }, 40000);
});

describe('auto-deal cadence', () => {
  it('with hub-default options the next hand starts promptly after settlement', async () => {
    // A second app wired exactly like production (hub defaults, no test timing
    // overrides) - the bug was that the hub never passed the short cadence, so
    // prod waited the 15s fallback plus a 20s ready check.
    const ctx2 = createApp(':memory:');
    attachHub(ctx2.app, ctx2.db, { cryptoTimeoutMs: 1500, actionTimeoutMs: 1500 });
    await ctx2.app.listen({ port: 0 });
    const addr = ctx2.app.server.address() as AddressInfo;
    const url = `http://127.0.0.1:${addr.port}`;
    const local: TestClient[] = [];
    try {
      for (const name of ['adp1', 'adp2']) {
        const c = new TestClient(url, name, 'fold-first');
        local.push(c);
        await c.register();
      }
      const host = local[0]!;
      const room = await host.api('/api/rooms', { name: 'AutoDeal', sb: 10, bb: 20 });
      for (const c of local.slice(1)) await c.api('/api/rooms/join', { joinCode: room.joinCode });
      for (const c of local) {
        const req = await c.api(`/api/rooms/${room.id}/buy`, { amount: 1000 });
        await host.api(`/api/rooms/${room.id}/approve`, { requestId: req.id, approve: true });
      }
      for (const [i, c] of local.entries()) {
        await c.connect(room.id);
        c.send({ t: 'sit', seat: i });
      }
      await new Promise((r) => setTimeout(r, 100));
      // everyone opts into server-side auto-ready: the ready check resolves instantly
      ctx2.db
        .prepare(`UPDATE users SET auto_ready = 1 WHERE id IN (${local.map(() => '?').join(',')})`)
        .run(...local.map((c) => c.userId));

      await host.api(`/api/rooms/${room.id}/settings`, { autoDeal: true }, 'PUT');
      // first auto-dealt hand
      await Promise.all(local.map((c) => c.waitFor(() => c.handEnd !== null, 12000)));
      const firstId = host.handEnd!.handId;

      const t0 = Date.now();
      await Promise.all(
        local.map((c) => c.waitFor(() => c.handEnd !== null && c.handEnd.handId !== firstId, 12000)),
      );
      const gap = Date.now() - t0;
      // old behaviour would be >=15s before the ready check even opened
      expect(gap).toBeLessThan(9000);
      expect(host.handAbort).toBeNull();
    } finally {
      for (const c of local) c.close();
      await ctx2.app.close();
    }
  }, 40000);
});
