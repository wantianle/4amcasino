import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { applyHandSettlement, type GameClock } from '../src/game.js';
import { rechainRoom, verifyLedger } from '../src/ledger.js';
import {
  auditMarkerlessTranscripts,
  firstPendingHandLifecycle,
  reconcileMissingSettlements,
  recoverOrphanedFeatureTriggers,
} from '../src/db.js';
import Database from 'better-sqlite3';

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
  actionApplied: { seat: number; action: PlayerAction; auto: boolean; actionSeq?: number }[] = [];
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
  /** When set, this seat shuffles with this exact permutation instead of a
   *  random one. Combined with identity permutations on the other seats it makes
   *  the whole deal (board + hole cards) deterministic for forced-showdown
   *  tests such as the 7-2 bounty. */
  forcedShufflePerm: number[] | null = null;
  cardsShown: { seat: number; cards: CardId[] }[] = [];
  peekOffers: { offerId: string; fromUserId: number; amount: number }[] = [];
  peekResults: { targetSeat: number; status: string; cards?: CardId[] }[] = [];
  sawShowdown = false;
  /** Wall-clock when the showdown/ hand_end frame arrived, for timing tests. */
  showdownAt: number | null = null;
  handStartAt: number | null = null;
  handEndAt: number | null = null;
  /** Every freshly-dealt hand (id change) with its local arrival time. */
  handStartLog: { handId: string; at: number }[] = [];
  handEnd:
    | (Extract<ServerMsg, { t: 'hand_end' }> & {
        pokerDeltas?: { seat: number; delta: number }[];
        squidDeltas?: { seat: number; delta: number }[];
      })
    | null = null;
  /** How many `hand_end` frames this client has seen for the current hand. */
  handEndCount = 0;
  /** Transcript heads seen on live `transcript_entry` frames (chain-mutation probe). */
  transcriptHeads: string[] = [];
  /** `settlement_failed` frames observed (durable-write failures). */
  settlementFailures: { handId: string; attempt: number; retrying: boolean }[] = [];
  /** Set false to simulate a client that never answers the TV-replay key ask. */
  respondKeys = true;
  handAbort: Extract<ServerMsg, { t: 'hand_abort' }> | null = null;
  lastRespondedActionSeq = -1;
  roomState: Extract<ServerMsg, { t: 'room_state' }> | null = null;
  lookup = cardLookup();
  /** Frames held while the current socket is CONNECTING; flushed on its `open`. */
  private pendingSends: { payload: string; t: string }[] = [];
  /** Every frame that actually left the client, tagged with its connect()
   *  generation - lets a reconnect test prove which socket received what. */
  sentFrames: { socket: number; t: string }[] = [];
  private nextSocketId = 0;
  private activeSocketId = 0;

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
    const ws = new WebSocket(wsUrl);
    const socketId = ++this.nextSocketId;
    this.activeSocketId = socketId;
    this.ws = ws;
    return new Promise((resolve) => {
      ws.on('open', () => {
        // A later connect() superseded this socket before it opened. The queued
        // frames belong to the live connection, so a stale `open` must neither
        // send nor flush: doing so would drain the queue onto this dead socket
        // and starve the one the caller actually kept.
        if (ws !== this.ws) {
          ws.close();
          resolve();
          return;
        }
        this.send({ t: 'join_room', roomId });
        this.flushPending();
        resolve();
      });
      ws.on('message', (raw) => {
        // A socket that has been replaced by a later connect() can still deliver
        // frames it buffered before closing. Ignore them: the server re-sends the
        // state the new socket is waiting on, so replaying a stale action here
        // would be wrong (and used to hit the new socket while it was CONNECTING).
        if (ws !== this.ws) return;
        this.handle(JSON.parse(String(raw)) as ServerMsg);
      });
      ws.on('close', () => {
        // The live socket died without being replaced: drop what was queued for
        // it, so a later connect() cannot replay stale frames onto the new one.
        if (ws === this.ws) this.pendingSends = [];
      });
    });
  }

  send(obj: unknown): void {
    const payload = JSON.stringify(obj);
    const t = (obj as { t?: string } | null)?.t ?? '';
    if (this.ws.readyState === WebSocket.OPEN) {
      this.write(payload, t);
      return;
    }
    if (this.ws.readyState === WebSocket.CONNECTING) {
      // The send raced the connection (e.g. a reconnect's delayed action).
      // Hold it until `open`, then flush in order - dropping it would silently
      // stall the hand.
      this.pendingSends.push({ payload, t });
      return;
    }
    // CLOSING/CLOSED: the socket is intentionally gone (a player who left, or
    // the test torn down while a timer was pending). There is nowhere to
    // deliver to, and that is not a test failure - drop it.
    return;
  }

  /** Write through the live socket, recording which connection it used. */
  private write(payload: string, t: string): void {
    this.ws.send(payload);
    this.sentFrames.push({ socket: this.activeSocketId, t });
  }

  /** Send everything held for the live socket, in order. Only a matching live
   *  `open` reaches this, so another connection's queued frames are unreachable. */
  private flushPending(): void {
    const queued = this.pendingSends;
    this.pendingSends = [];
    for (const item of queued) this.write(item.payload, item.t);
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

  declinePeek(offerId: string): void {
    this.send({ t: 'peek_decline', handId: this.handId, offerId });
  }

  /** Accept with a deliberately broken DLEQ proof (should be rejected). */
  acceptPeekBadProof(offerId: string): void {
    const shares = this.myCardPoints.map(({ deckIndex, point }) => {
      const { out, proof } = proveUnmask(this.handKey!, pointFromHex(point));
      return { deckIndex, out: pointHex(out), proof: { ...proof, z: '00' } };
    });
    this.send({
      t: 'peek_accept',
      handId: this.handId,
      offerId,
      shares,
      sig: this.signed('peek_accept', { offerId, shares }),
    });
  }

  /** Accept with a valid proof but a corrupted signature (should be rejected). */
  acceptPeekBadSig(offerId: string): void {
    const shares = this.myCardPoints.map(({ deckIndex, point }) => {
      const { out, proof } = proveUnmask(this.handKey!, pointFromHex(point));
      return { deckIndex, out: pointHex(out), proof };
    });
    const sig = this.signed('peek_accept', { offerId, shares });
    const bad = (sig[0] === '0' ? '1' : '0') + sig.slice(1);
    this.send({ t: 'peek_accept', handId: this.handId, offerId, shares, sig: bad });
  }

  /** Send the per-hand reveal key on demand (the audit-timeout test). */
  sendRevealKey(): void {
    const key = this.handKey!.toString(16);
    this.send({
      t: 'reveal_key',
      handId: this.handId,
      key,
      sig: this.signed('reveal_key', { key }),
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
          this.showdownAt = null;
          this.handEndAt = null;
          this.handStartAt = Date.now();
          this.handStartLog.push({ handId: msg.handId, at: Date.now() });
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
        const perm = this.forcedShufflePerm ?? randomPerm(52);
        const out = maskAndShuffle(deck, this.handKey!, perm).map(pointHex);
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
        this.actionApplied.push({
          seat: msg.seat,
          action: msg.action,
          auto: !!msg.auto,
          actionSeq: msg.actionSeq,
        });
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
        this.showdownAt = Date.now();
        this.lastShowdown = msg;
        break;
      }
      case 'hand_end': {
        this.handEnd = msg;
        this.handEndAt = Date.now();
        this.handEndCount++;
        break;
      }
      case 'transcript_entry': {
        this.transcriptHeads.push(msg.head);
        break;
      }
      case 'settlement_failed': {
        this.settlementFailures.push({
          handId: msg.handId,
          attempt: msg.attempt,
          retrying: msg.retrying,
        });
        break;
      }
      case 'hand_abort': {
        this.handAbort = msg;
        break;
      }
      case 'need_keys': {
        if (!this.respondKeys) break;
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

/**
 * The clock that drives the showdown settle hold. In `auto` mode it delegates
 * to real timers, so every ordinary WS test behaves exactly as before. A test
 * calls `freeze()` to take manual control: the hold timer is captured instead
 * of scheduled, and `advance(ms)` fires it. That makes the ordering contract
 * (durable write → reveal → hold → hand_end) deterministic instead of racing
 * wall-clock sleeps under load.
 */
class ManualClock implements GameClock {
  private manual = false;
  private base = 1_000_000;
  private offset = 0;
  private seq = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.manual ? this.base + this.offset : Date.now();
  }
  setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    if (!this.manual) return setTimeout(fn, ms);
    const handle = this.seq++;
    this.timers.set(handle, { at: this.now() + ms, fn });
    return handle as unknown as ReturnType<typeof setTimeout>;
  }
  clearTimer(handle: ReturnType<typeof setTimeout>): void {
    if (!this.manual) {
      clearTimeout(handle);
      return;
    }
    this.timers.delete(handle as unknown as number);
  }
  freeze(): void {
    this.manual = true;
    this.offset = 0;
  }
  advance(ms: number): void {
    if (!this.manual) throw new Error('ManualClock.advance requires freeze()');
    this.offset += ms;
    const due = [...this.timers.entries()].filter(([, t]) => t.at <= this.now());
    for (const [handle, t] of due) {
      this.timers.delete(handle);
      t.fn();
    }
  }
}

let ctx: ReturnType<typeof createApp>;
let baseUrl: string;
let clients: TestClient[] = [];
let hub: ReturnType<typeof attachHub>;
let clock: ManualClock;
/** Mutable fault switches consulted by the hub's test-only fault injection. */
let fault: {
  persistFailThrough: number;
  broadcastThrowT: string | null;
  sevenDeuceFailOnce: boolean;
  /** A coded error thrown by the 7-2 bounty hook, to exercise the transient-vs-
   *  programming classification with real SQLite result codes. */
  sevenDeuceError: Error | null;
  /** Injected INSIDE the 7-2 bounty transaction; not special-cased, so it
   *  exercises the internal-error (unhealthy) classification. */
  sevenDeuceInternal: (() => void) | null;
};

beforeEach(async () => {
  clock = new ManualClock();
  fault = {
    persistFailThrough: 0,
    broadcastThrowT: null,
    sevenDeuceFailOnce: false,
    sevenDeuceError: null,
    sevenDeuceInternal: null,
  };
  ctx = createApp(':memory:');
  hub = attachHub(ctx.app, ctx.db, {
    cryptoTimeoutMs: 1500,
    actionTimeoutMs: 1500,
    autoDealMs: 800,
    readyCheckMs: 1500,
    // short holds so the reveal/settle ordering is observable in real time
    showdownHoldMs: 400,
    settleHoldMs: 1500,
    ritVoteMs: 1500,
    runItTwice: true,
    clock,
    faultInjection: {
      persist: (attempt) => {
        if (fault.persistFailThrough >= attempt) throw new Error('injected persist failure');
      },
      broadcast: (msg) => {
        if (fault.broadcastThrowT === msg.t) throw new Error('injected broadcast failure');
      },
      sevenDeuce: () => {
        if (fault.sevenDeuceError) {
          const err = fault.sevenDeuceError;
          fault.sevenDeuceError = null;
          throw err;
        }
        if (fault.sevenDeuceFailOnce) {
          fault.sevenDeuceFailOnce = false;
          throw new Error('injected seven-deuce failure');
        }
      },
      sevenDeuceInternal: () => {
        fault.sevenDeuceInternal?.();
      },
    },
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
  it('a reconnect before the first socket opens never flushes onto the stale socket', async () => {
    const c = new TestClient(baseUrl, 'racey');
    clients.push(c);
    await c.register();
    const room = await c.api('/api/rooms', { name: 'Race', sb: 10, bb: 20 });

    // These calls run in the same tick, so the first socket is guaranteed to
    // still be CONNECTING when the second connect() replaces it. This pins the
    // exact race: a queued frame plus a superseded socket that then opens.
    const first = c.connect(room.id);
    c.send({ t: 'sit', seat: 0 });
    const second = c.connect(room.id);
    await Promise.all([first, second]);
    // Wait for the second socket to complete its handshake, including the
    // server round-trip, so both the socket bookkeeping and room_state are final.
    await c.waitFor(
      () => c.roomState !== null && c.sentFrames.some((f) => f.t === 'sit'),
      5000,
    );

    // Every frame left on the second socket. If the stale first socket had
    // flushed the shared queue, `join_room`/`sit` would show socket 1 (and the
    // second socket would have been starved).
    expect(c.sentFrames.length).toBeGreaterThan(0);
    expect(c.sentFrames.every((f) => f.socket === 2)).toBe(true);
    expect(c.sentFrames.filter((f) => f.t === 'join_room').map((f) => f.socket)).toEqual([2]);
    expect(c.sentFrames.filter((f) => f.t === 'sit').map((f) => f.socket)).toEqual([2]);
    expect(c.roomState).not.toBeNull();
  });

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

    // Server-authoritative action sequence: every accepted transcript action
    // carries its 0-based index, and every observer sees a strictly increasing
    // sequence on action_applied (one entry per applied action, no duplicates).
    const handDetail = await host.api(
      `/api/rooms/${room.id}/hands/${players[0]!.handEnd!.handId}`,
    );
    const actionEntries = (handDetail.entries as { type: string; payload: { actionSeq?: number } }[])
      .filter((e) => e.type === 'action');
    expect(actionEntries.length).toBeGreaterThan(0);
    for (const e of actionEntries) expect(typeof e.payload.actionSeq).toBe('number');
    for (const p of players) {
      const seqs = p.actionApplied.map((a) => a.actionSeq as number);
      for (const s of seqs) expect(Number.isInteger(s)).toBe(true);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(seqs.length);
    }
  }, 20000);

  it('mid-hand reconnect: the reconnected client gets the authoritative actionSeq after missed frames', async () => {
    const { players, room, host } = await setupRoom(['mra', 'mrb', 'mrc']);
    const a = players[0]!;
    const bob = players[1]!;
    // Space actions out so there is a window to drop the socket with actions in
    // flight, then reconnect before the hand settles.
    for (const p of players) p.thinkMs = 250;
    host.send({ t: 'start_hand' });
    await a.waitFor(() => a.actionApplied.length >= 1, 12000);

    const bobSeenBefore = bob.actionApplied.length;
    const serverAppliedBefore = a.actionApplied.length;
    bob.disconnect();
    // At least one action is applied while bob is offline: bob provably missed it.
    await a.waitFor(() => a.actionApplied.length > serverAppliedBefore, 12000);
    await bob.connect(room.id);
    // The hand is still live; bob now receives a later action_applied.
    await bob.waitFor(() => bob.actionApplied.length > bobSeenBefore, 20000);
    const firstAfterReconnect = bob.actionApplied[bobSeenBefore]!;
    expect(typeof firstAfterReconnect.actionSeq).toBe('number');
    // A locally accumulated ordinal would have been exactly bobSeenBefore (it
    // missed a frame), but the server sequence has advanced past the gap.
    expect(firstAfterReconnect.actionSeq!).toBeGreaterThan(bobSeenBefore);

    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 25000)));
    expect(a.handAbort).toBeNull();

    // Direct set comparison: the continuously-connected observer's non-auto
    // actionSeq values must equal the transcript's accepted actionSeq values
    // exactly, and the reconnected observer's post-reconnect frames must be a
    // subset of the same authoritative sequence (never a fabricated ordinal).
    const handDetail = await host.api(`/api/rooms/${room.id}/hands/${a.handEnd!.handId}`);
    const transcriptSeqs = (
      handDetail.entries as { type: string; payload: { actionSeq?: number } }[]
    )
      .filter((e) => e.type === 'action')
      .map((e) => e.payload.actionSeq as number)
      .sort((x, y) => x - y);
    expect(transcriptSeqs.length).toBeGreaterThan(0);
    const observerSeqs = a.actionApplied
      .filter((x) => !x.auto)
      .map((x) => x.actionSeq as number)
      .sort((x, y) => x - y);
    expect(observerSeqs).toEqual(transcriptSeqs);
    const bobAfter = bob.actionApplied.slice(bobSeenBefore).map((x) => x.actionSeq as number);
    for (const s of bobAfter) expect(transcriptSeqs).toContain(s);
  }, 45000);

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

  it('persists the settlement BEFORE the reveal hold, then broadcasts hand_end on expiry', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['passive', 'passive']);
    clock.freeze(); // take manual control of the settle hold
    host.send({ t: 'start_hand' });
    // the reveal is broadcast as soon as the hand settles...
    await host.waitFor(() => host.showdownAt !== null);
    const handId = host.handId!;
    const showdown = host.lastShowdown!;

    // ...but the terminal frame is still held: the durable write is decoupled
    // from the broadcast, so there is no "publicly revealed but unsettled" gap.
    expect(host.handEnd).toBeNull();
    expect(players[1]!.handEnd).toBeNull();

    // DB already holds the whole hand: settlement marker, ledger, transcript,
    // and the moved stacks - all before any `hand_end`.
    const marker = ctx.db
      .prepare('SELECT hand_id FROM hand_settlements WHERE hand_id = ?')
      .get(handId) as { hand_id: string } | undefined;
    expect(marker?.hand_id).toBe(handId);
    const transcript = ctx.db
      .prepare('SELECT head FROM transcripts WHERE hand_id = ?')
      .get(handId) as { head: string } | undefined;
    expect(transcript).toBeDefined();
    const settledStacks = ctx.db
      .prepare('SELECT SUM(stack) AS total FROM room_players WHERE room_id = ?')
      .get(room.id) as { total: number };
    expect(settledStacks.total).toBe(2000);

    // release the hold: `hand_end` lands, carrying the same stacks/head
    clock.advance(400);
    await host.waitFor(() => host.handEnd !== null);
    expect(host.handEnd!.handId).toBe(handId);
    expect(host.handEnd!.head).toBe(transcript!.head);
    expect(host.lastShowdown!.reveals).toEqual(showdown.reveals);
    expect(players[1]!.handEnd).not.toBeNull();

    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    expect(ledger.verified.ok).toBe(true);
  }, 20000);

  it('a showdown frame precedes hand_end over the real socket (smoke)', async () => {
    const { players, host } = await setupRoom(['host', 'bob'], ['passive', 'passive']);
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null)));
    const p0 = players[0]!;
    expect(p0.sawShowdown).toBe(true);
    expect(p0.showdownAt).not.toBeNull();
    expect(p0.handEndAt).not.toBeNull();
    expect(p0.handEndAt!).toBeGreaterThanOrEqual(p0.showdownAt!);
  }, 20000);

  it('a fold-out skips the reveal and has no showdown hold', async () => {
    const { players, host } = await setupRoom(['host', 'bob'], ['fold-first', 'passive']);
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null)));
    const p0 = players[0]!;
    // no reveal frame at all, and settlement is not delayed by a showdown hold
    expect(p0.sawShowdown).toBe(false);
    expect(p0.showdownAt).toBeNull();
    expect(p0.handEnd).not.toBeNull();
  }, 20000);

  it('a shutdown during the hold keeps the durable settlement and drops only hand_end', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['passive', 'passive']);
    clock.freeze();
    host.send({ t: 'start_hand' });
    // wait for the reveal but NOT the settlement broadcast
    await host.waitFor(() => host.showdownAt !== null);
    const handId = host.handId!;
    expect(host.handEnd).toBeNull();

    // The settlement is already durable when the reveal goes out, so a crash /
    // shutdown in the hold can only lose the `hand_end` frame, never the hand.
    expect(
      ctx.db.prepare('SELECT 1 FROM hand_settlements WHERE hand_id = ?').get(handId),
    ).toBeTruthy();

    void hub.rooms.get(room.id)?.shutdown();
    // well past the hold: the timer was cancelled, so no hand_end...
    clock.advance(5000);
    expect(host.handEnd).toBeNull();
    expect(players[1]!.handEnd).toBeNull();
    expect(activeHands.has(room.id)).toBe(false);
    // ...but the hand is fully recoverable from the database.
    expect(
      ctx.db.prepare('SELECT head FROM transcripts WHERE hand_id = ?').get(handId),
    ).toBeTruthy();
    expect(
      (
        ctx.db
          .prepare('SELECT COUNT(*) AS n FROM hand_settlements WHERE hand_id = ?')
          .get(handId) as { n: number }
      ).n,
    ).toBe(1);
  }, 20000);

  it('restarts onto the same DB and recovers the settlement written during the hold', async () => {
    const dir = mkdtempSync(join(tmpdir(), '4am-hold-'));
    const dbPath = join(dir, 'game.db');
    const saved = { ctx, baseUrl, hub };
    const app = createApp(dbPath);
    const appHub = attachHub(app.app, app.db, {
      cryptoTimeoutMs: 1500,
      actionTimeoutMs: 1500,
      autoDealMs: 3_600_000,
      readyCheckMs: 1500,
      showdownHoldMs: 400,
      settleHoldMs: 0,
      clock,
    });
    await app.app.listen({ port: 0 });
    const addr = app.app.server.address() as AddressInfo;
    ctx = app;
    hub = appHub;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    try {
      const { players, room, host } = await setupRoom(['ra', 'rb'], ['passive', 'passive']);
      clock.freeze();
      host.send({ t: 'start_hand' });
      await host.waitFor(() => host.showdownAt !== null);
      const handId = host.handId!;
      expect(host.handEnd).toBeNull();
      // "crash" the box: no graceful hand_end, close the db handle
      for (const c of players) c.close();
      await app.app.close();

      // a fresh process opening the same file sees the settled hand
      const restarted = createApp(dbPath);
      const tr = restarted.db
        .prepare('SELECT head FROM transcripts WHERE hand_id = ?')
        .get(handId) as { head: string } | undefined;
      expect(tr).toBeDefined();
      expect(
        (
          restarted.db
            .prepare('SELECT COUNT(*) AS n FROM hand_settlements WHERE hand_id = ?')
            .get(handId) as { n: number }
        ).n,
      ).toBe(1);
      const total = restarted.db
        .prepare('SELECT SUM(stack) AS total FROM room_players WHERE room_id = ?')
        .get(room.id) as { total: number };
      expect(total.total).toBe(2000);
      await restarted.app.close();
    } finally {
      ctx = saved.ctx;
      baseUrl = saved.baseUrl;
      hub = saved.hub;
    }
  }, 25000);

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

  it('a paid peek costs a fixed 1bb, reveals only to the buyer and is ledger-conserving', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['fold-first', 'passive']);
    const [h, bob] = players as [TestClient, TestClient];
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null)));
    // park the table between hands: this test is about the peek, not auto-deal
    for (const p of players) p.send({ t: 'sit_out', sittingOut: true });

    // heads-up, host folded: bob pays the server-fixed 1bb (=bb=20) to see
    // host's mucked cards. The client's 100 is deliberately ignored.
    bob.send({ t: 'peek_offer', handId: bob.handId, targetSeat: h.seat, amount: 100 });
    await h.waitFor(() => h.peekOffers.length > 0);
    expect(h.peekOffers[0]!.amount).toBe(20);
    h.acceptPeek(h.peekOffers[0]!.offerId);
    await bob.waitFor(() => bob.peekResults.length > 0);

    const result = bob.peekResults[0]!;
    expect(result.status).toBe('accepted');
    expect(result.cards!.slice().sort()).toEqual(h.myCards.slice().sort());
    // the reveal went only to the buyer
    expect(h.peekResults).toHaveLength(0);
    expect(h.cardsShown).toHaveLength(0);

    // chips moved: bob paid host exactly 20 on top of the blind results
    const state = await host.api(`/api/rooms/${room.id}`);
    const stack = (name: string) => state.players.find((p: any) => p.username === name).stack;
    expect(stack('host')).toBe(1010); // folded the sb, then sold a look for 1bb
    expect(stack('bob')).toBe(990); // won the 10 blind, paid 20
    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    expect(ledger.verified.ok).toBe(true);
    const peeks = ledger.entries.filter((e: any) => e.kind === 'peek');
    expect(peeks).toHaveLength(2);
    expect(peeks.reduce((s: number, e: any) => s + e.delta, 0)).toBe(0); // zero-sum
  });

  it('refuses peeks in a ring hand and in a showdown hand', async () => {
    // Ring: three players, still a fold-out, but not heads-up.
    const ring = await setupRoom(['ra', 'rb', 'rc'], ['fold-first', 'fold-first', 'passive']);
    ring.host.send({ t: 'start_hand' });
    await Promise.all(ring.players.map((p) => p.waitFor(() => p.handEnd !== null)));
    for (const p of ring.players) p.send({ t: 'sit_out', sittingOut: true });
    const rc = ring.players[2]!;
    rc.errors = [];
    rc.send({ t: 'peek_offer', handId: rc.handId, targetSeat: ring.host.seat });
    await rc.waitFor(() => rc.errors.length > 0);
    expect(rc.errors[0]).toMatch(/heads-up/i);
    expect(ring.players[0]!.peekOffers).toHaveLength(0);

    // Heads-up but decided at showdown: no private cards left to sell.
    const hu = await setupRoom(['sa', 'sb'], ['passive', 'passive']);
    hu.host.send({ t: 'start_hand' });
    await Promise.all(hu.players.map((p) => p.waitFor(() => p.handEnd !== null)));
    for (const p of hu.players) p.send({ t: 'sit_out', sittingOut: true });
    const sb = hu.players[1]!;
    sb.errors = [];
    sb.send({ t: 'peek_offer', handId: sb.handId, targetSeat: hu.host.seat });
    await sb.waitFor(() => sb.errors.length > 0);
    expect(sb.errors[0]).toMatch(/showdown/i);
    expect(hu.players[0]!.peekOffers).toHaveLength(0);
  });

  it('refuses a peek for a hand that is not the last one', async () => {
    const { players, host } = await setupRoom(['host', 'bob'], ['fold-first', 'passive']);
    const [h, bob] = players as [TestClient, TestClient];
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null)));
    for (const p of players) p.send({ t: 'sit_out', sittingOut: true });
    bob.errors = [];
    bob.send({ t: 'peek_offer', handId: 'deadbeef', targetSeat: h.seat });
    await bob.waitFor(() => bob.errors.length > 0);
    expect(bob.errors[0]).toMatch(/between hands|no such hand|last hand/i);
  });

  it('expires an unanswered peek offer after the 5s contract and tells the requester', async () => {
    const { players, host } = await setupRoom(['host', 'bob'], ['fold-first', 'passive']);
    const [h, bob] = players as [TestClient, TestClient];
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null)));
    for (const p of players) p.send({ t: 'sit_out', sittingOut: true });

    bob.send({ t: 'peek_offer', handId: bob.handId, targetSeat: h.seat });
    await h.waitFor(() => h.peekOffers.length > 0);
    // the target never answers (disconnected/ignoring): the offer must lapse
    await bob.waitFor(() => bob.peekResults.length > 0, 9000);
    expect(bob.peekResults.at(-1)!.status).toBe('expired');
    // answering the lapsed id is rejected, not silently accepted
    h.errors = [];
    h.acceptPeek(h.peekOffers[0]!.offerId);
    await h.waitFor(() => h.errors.length > 0);
    expect(h.errors[0]).toMatch(/gone/i);
  }, 15000);

  it('fails the peek explicitly when the buyer cannot pay at accept time', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['fold-first', 'passive']);
    const [h, bob] = players as [TestClient, TestClient];
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null)));
    for (const p of players) p.send({ t: 'sit_out', sittingOut: true });

    bob.send({ t: 'peek_offer', handId: bob.handId, targetSeat: h.seat });
    await h.waitFor(() => h.peekOffers.length > 0);
    // the buyer spends/loses chips after offering: the accept must not silently
    // hang the requester - it gets an explicit failed result.
    ctx.db
      .prepare('UPDATE room_players SET stack = 0 WHERE room_id = ? AND user_id = ?')
      .run(room.id, bob.userId);
    h.acceptPeek(h.peekOffers[0]!.offerId);
    await bob.waitFor(() => bob.peekResults.length > 0);
    expect(bob.peekResults.at(-1)!.status).toBe('failed');
    // not public: the reveal never reached the buyer
    expect(bob.peekResults.at(-1)!.cards).toBeUndefined();
  }, 20000);

  it('allows a peek with exactly 1bb and rejects one chip short', async () => {
    const first = await setupRoom(['h1a', 'b1a'], ['fold-first', 'passive']);
    first.host.send({ t: 'start_hand' });
    await Promise.all(first.players.map((p) => p.waitFor(() => p.handEnd !== null)));
    for (const p of first.players) p.send({ t: 'sit_out', sittingOut: true });
    const h1 = first.players[0]!;
    const b1 = first.players[1]!;
    ctx.db
      .prepare('UPDATE room_players SET stack = 20 WHERE room_id = ? AND user_id = ?')
      .run(first.room.id, b1.userId);
    b1.send({ t: 'peek_offer', handId: b1.handId, targetSeat: h1.seat });
    await h1.waitFor(() => h1.peekOffers.length > 0);
    expect(h1.peekOffers).toHaveLength(1);
    // exactly 1bb is enough: the offer must be answerable and the payment complete
    h1.acceptPeek(h1.peekOffers[0]!.offerId);
    await b1.waitFor(() => b1.peekResults.length > 0);
    expect(b1.peekResults.at(-1)!.status).toBe('accepted');
    expect(b1.peekResults.at(-1)!.cards!.slice().sort()).toEqual(h1.myCards.slice().sort());
    const stack1 = (u: number) =>
      (
        ctx.db
          .prepare('SELECT stack FROM room_players WHERE room_id = ? AND user_id = ?')
          .get(first.room.id, u) as { stack: number }
      ).stack;
    expect(stack1(b1.userId)).toBe(0);
    expect(stack1(h1.userId)).toBe(1010);
    const peekRows1 = ctx.db
      .prepare("SELECT delta FROM ledger WHERE room_id = ? AND kind = 'peek'")
      .all(first.room.id) as { delta: number }[];
    expect(peekRows1.reduce((s, r) => s + r.delta, 0)).toBe(0);

    const second = await setupRoom(['h2a', 'b2b'], ['fold-first', 'passive']);
    second.host.send({ t: 'start_hand' });
    await Promise.all(second.players.map((p) => p.waitFor(() => p.handEnd !== null)));
    for (const p of second.players) p.send({ t: 'sit_out', sittingOut: true });
    const h2 = second.players[0]!;
    const b2 = second.players[1]!;
    ctx.db
      .prepare('UPDATE room_players SET stack = 19 WHERE room_id = ? AND user_id = ?')
      .run(second.room.id, b2.userId);
    b2.errors = [];
    b2.send({ t: 'peek_offer', handId: b2.handId, targetSeat: h2.seat });
    await b2.waitFor(() => b2.errors.length > 0);
    expect(b2.errors[0]).toMatch(/enough chips/i);
    expect(h2.peekOffers).toHaveLength(0);
  }, 25000);

  it('a declined, badly-signed, badly-proven, or superseded peek sends exactly one result and moves no chips', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['fold-first', 'passive']);
    // disable auto-deal so an offer can be exercised across the between-hands window
    ctx.db.prepare('UPDATE rooms SET auto_deal = 0 WHERE id = ?').run(room.id);
    const [h, bob] = players as [TestClient, TestClient];
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null)));
    for (const p of players) p.send({ t: 'sit_out', sittingOut: true });

    const peekLedger = () =>
      (
        ctx.db
          .prepare("SELECT COUNT(*) AS n FROM ledger WHERE room_id = ? AND kind = 'peek'")
          .get(room.id) as { n: number }
      ).n;
    const stacks = () =>
      (
        ctx.db
          .prepare('SELECT user_id, stack FROM room_players WHERE room_id = ? ORDER BY user_id')
          .all(room.id) as { user_id: number; stack: number }[]
      );
    const before = stacks();

    // decline: one terminal receipt, no money
    bob.send({ t: 'peek_offer', handId: bob.handId, targetSeat: h.seat });
    await h.waitFor(() => h.peekOffers.length > 0);
    h.declinePeek(h.peekOffers.at(-1)!.offerId);
    await bob.waitFor(() => bob.peekResults.length > 0);
    expect(bob.peekResults.at(-1)!.status).toBe('declined');
    // a second answer is rejected and never yields a second receipt
    h.errors = [];
    h.declinePeek(h.peekOffers.at(-1)!.offerId);
    await h.waitFor(() => h.errors.length > 0);
    expect(bob.peekResults).toHaveLength(1);

    // bad signature: explicit failure, no money
    bob.send({ t: 'peek_offer', handId: bob.handId, targetSeat: h.seat });
    await h.waitFor(() => h.peekOffers.length > 1);
    h.acceptPeekBadSig(h.peekOffers.at(-1)!.offerId);
    await bob.waitFor(() => bob.peekResults.length > 1);
    expect(bob.peekResults.at(-1)!.status).toBe('failed');
    expect(bob.peekResults).toHaveLength(2);

    // bad proof: explicit failure, no money
    bob.send({ t: 'peek_offer', handId: bob.handId, targetSeat: h.seat });
    await h.waitFor(() => h.peekOffers.length > 2);
    h.acceptPeekBadProof(h.peekOffers.at(-1)!.offerId);
    await bob.waitFor(() => bob.peekResults.length > 2);
    expect(bob.peekResults.at(-1)!.status).toBe('failed');
    expect(bob.peekResults.at(-1)!.cards).toBeUndefined();

    expect(peekLedger()).toBe(0);
    expect(stacks()).toEqual(before);

    // a new hand supersedes an open offer with exactly one expiry receipt
    bob.send({ t: 'peek_offer', handId: bob.handId, targetSeat: h.seat });
    await h.waitFor(() => h.peekOffers.length > 3);
    for (const p of players) p.send({ t: 'sit_out', sittingOut: false });
    await Promise.all(
      players.map((p) =>
        p.waitFor(
          () =>
            p.roomState?.players.find((x) => x.userId === p.userId)?.sittingOut === false,
          3000,
        ),
      ),
    );
    host.send({ t: 'start_hand' });
    await bob.waitFor(() => bob.peekResults.length > 3, 5000);
    expect(bob.peekResults.at(-1)!.status).toBe('expired');
    expect(bob.peekResults).toHaveLength(4);
    expect(peekLedger()).toBe(0);
  }, 30000);

  it('still refuses a heads-up peek after a player leaves their seat from a 3-way hand', async () => {
    const ring = await setupRoom(
      ['la', 'lb', 'lc'],
      ['fold-first', 'fold-first', 'passive'],
    );
    ring.host.send({ t: 'start_hand' });
    await Promise.all(ring.players.map((p) => p.waitFor(() => p.handEnd !== null)));
    for (const p of ring.players) p.send({ t: 'sit_out', sittingOut: true });
    // one participant walks away from their seat
    const leaver = ring.players[0]!;
    leaver.send({ t: 'leave_seat' });
    await leaver.waitFor(
      () => leaver.roomState?.players.find((p) => p.userId === leaver.userId)?.seat === null,
      5000,
    );
    const rc = ring.players[2]!;
    rc.errors = [];
    rc.send({ t: 'peek_offer', handId: rc.handId, targetSeat: ring.players[1]!.seat! });
    await rc.waitFor(() => rc.errors.length > 0);
    expect(rc.errors[0]).toMatch(/heads-up/i);
  }, 20000);

  it('replays the showdown to a client that reconnects during the hold', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['passive', 'passive']);
    clock.freeze();
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.showdownAt !== null);
    const handId = host.handId!;
    // the reconnected client has no cached reveal: ask the server to replay it
    host.disconnect();
    host.sawShowdown = false;
    host.lastShowdown = null;
    await host.connect(room.id);
    await host.waitFor(() => host.sawShowdown && host.lastShowdown !== null, 5000);
    expect(host.lastShowdown!.handId).toBe(handId);
    expect(host.handEnd).toBeNull(); // still inside the hold
    // release the hold so the room tears down cleanly
    clock.advance(400);
    await host.waitFor(() => host.handEnd !== null, 5000);
    expect(host.handEnd!.handId).toBe(handId);
  }, 20000);

  it('pays the automatic 7-2 showdown bounty durably, before hand_end and across a hold shutdown', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['passive', 'passive']);
    ctx.db.prepare('UPDATE rooms SET seven_deuce_bonus = ? WHERE id = ?').run(25, room.id);
    // Deterministic deal: one seat applies a fixed permutation, the other the
    // identity, so the final deck is exactly `deck[Q]`. Seat 0 gets hole
    // indexes 0/2 -> cards 0 (2s) and 21 (7h): 7-2 offsuit. Board 4..8 is
    // 7s 7d 7c 9c Kc, so the 7-2 holder wins with quads.
    const identity = Array.from({ length: 52 }, (_, i) => i);
    const wanted = [0, 4, 21, 8, 20, 22, 23, 31, 47];
    const seen = new Set(wanted);
    const Q = [...wanted, ...identity.filter((i) => !seen.has(i))];
    host.forcedShufflePerm = identity;
    players[1]!.forcedShufflePerm = Q;

    clock.freeze();
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.showdownAt !== null);
    const handId = host.handId!;

    expect(host.myCards.slice().sort((a, b) => a - b)).toEqual([0, 21]);
    expect(host.board).toEqual([20, 22, 23, 31, 47]);
    expect(host.lastShowdown!.awards.find((a) => a.seat === 0)!.amount).toBeGreaterThan(0);

    // The bounty is part of the durable settlement: paid BEFORE hand_end and
    // while the reveal is still on screen.
    const bountyRows = () =>
      ctx.db
        .prepare("SELECT user_id, delta FROM ledger WHERE room_id = ? AND kind = 'seven-deuce'")
        .all(room.id) as { user_id: number; delta: number }[];
    const rows = bountyRows();
    expect(rows).toHaveLength(2);
    expect(rows.reduce((s, r) => s + r.delta, 0)).toBe(0);
    expect(rows.find((r) => r.delta === 25)).toBeTruthy();
    const hostRow = ctx.db
      .prepare('SELECT user_id FROM room_players WHERE room_id = ? AND seat = 0')
      .get(room.id) as { user_id: number };
    expect(rows.find((r) => r.delta === 25)!.user_id).toBe(hostRow.user_id);
    expect(host.handEnd).toBeNull();

    // A crash/shutdown inside the hold can no longer lose the bounty.
    void hub.rooms.get(room.id)?.shutdown();
    clock.advance(5000);
    expect(host.handEnd).toBeNull();
    expect(bountyRows()).toHaveLength(2);
    expect(
      (
        ctx.db
          .prepare('SELECT COUNT(*) AS n FROM hand_settlements WHERE hand_id = ?')
          .get(handId) as { n: number }
      ).n,
    ).toBe(1);
    const total = ctx.db
      .prepare('SELECT SUM(stack) AS total FROM room_players WHERE room_id = ?')
      .get(room.id) as { total: number };
    // 2000 chips in, 0 rake on this tiny pot, bounty is zero-sum: conserved.
    expect(total.total).toBe(2000);
  }, 20000);

  it('B1: the 7-2 bounty is reflected in every settlement output consistently', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['passive', 'passive']);
    ctx.db.prepare('UPDATE rooms SET seven_deuce_bonus = ? WHERE id = ?').run(25, room.id);
    const identity = Array.from({ length: 52 }, (_, i) => i);
    const wanted = [0, 4, 21, 8, 20, 22, 23, 31, 47];
    const seen = new Set(wanted);
    const Q = [...wanted, ...identity.filter((i) => !seen.has(i))];
    host.forcedShufflePerm = identity;
    players[1]!.forcedShufflePerm = Q;

    clock.freeze();
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.showdownAt !== null);
    const handId = host.handId!;
    expect(host.handEnd).toBeNull();
    clock.advance(400);
    await host.waitFor(() => host.handEnd !== null, 8000);

    const stackRows = ctx.db
      .prepare('SELECT user_id, stack, seat FROM room_players WHERE room_id = ?')
      .all(room.id) as { user_id: number; stack: number; seat: number }[];
    const byUser = new Map(stackRows.map((r) => [r.user_id, r.stack]));
    const seatByUser = new Map(stackRows.map((r) => [r.user_id, r.seat]));

    // room_players.stack === hand_end.stacks
    for (const s of host.handEnd!.stacks) {
      const uid = [...seatByUser.entries()].find(([, seat]) => seat === s.seat)![0];
      expect(s.stack).toBe(byUser.get(uid));
    }
    // room_players.stack === hand_settlements.final_stacks
    const finalStacks = JSON.parse(
      (
        ctx.db
          .prepare('SELECT final_stacks FROM hand_settlements WHERE hand_id = ?')
          .get(handId) as { final_stacks: string }
      ).final_stacks,
    ) as { userId: number; stack: number }[];
    for (const f of finalStacks) expect(f.stack).toBe(byUser.get(f.userId));
    // room_players.stack === projection.ending_stack, and
    // net_delta === ending_stack - starting_stack
    const proj = ctx.db
      .prepare(
        'SELECT user_id, starting_stack, ending_stack, net_delta FROM hand_players WHERE hand_id = ?',
      )
      .all(handId) as {
      user_id: number;
      starting_stack: number;
      ending_stack: number;
      net_delta: number;
    }[];
    expect(proj).toHaveLength(2);
    for (const p of proj) {
      expect(p.ending_stack).toBe(byUser.get(p.user_id));
      expect(p.ending_stack - p.starting_stack).toBe(p.net_delta);
    }
    // hand_end.deltas are zero-sum and carry the bounty transfer
    const end = host.handEnd!;
    expect(end.commission).toBe(0);
    expect(end.deltas.reduce((s, d) => s + d.delta, 0)).toBe(0);
    const deltaBySeat = new Map(end.deltas.map((d) => [d.seat, d.delta]));
    const pokerBySeat = new Map(end.pokerDeltas!.map((d) => [d.seat, d.delta]));
    expect(host.myCards.slice().sort((a, b) => a - b)).toEqual([0, 21]);
    expect(deltaBySeat.get(0)! - pokerBySeat.get(0)!).toBe(25);
    expect(deltaBySeat.get(1)! - pokerBySeat.get(1)!).toBe(-25);
  }, 20000);

  it('B2: a settled showdown bounty is never paid again by a later voluntary show', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['passive', 'passive']);
    ctx.db.prepare('UPDATE rooms SET seven_deuce_bonus = ? WHERE id = ?').run(25, room.id);
    const identity = Array.from({ length: 52 }, (_, i) => i);
    const wanted = [0, 4, 21, 8, 20, 22, 23, 31, 47];
    const seen = new Set(wanted);
    const Q = [...wanted, ...identity.filter((i) => !seen.has(i))];
    host.forcedShufflePerm = identity;
    players[1]!.forcedShufflePerm = Q;
    const bountyRows = () =>
      ctx.db
        .prepare("SELECT COUNT(*) AS n FROM ledger WHERE room_id = ? AND kind = 'seven-deuce'")
        .get(room.id) as { n: number };
    clock.freeze();
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.showdownAt !== null);
    clock.advance(400);
    await host.waitFor(() => host.handEnd !== null, 8000);
    expect(bountyRows().n).toBe(2);
    // the showdown winner voluntarily shows once more: no second bounty
    host.showCards();
    await new Promise((r) => setTimeout(r, 150));
    expect(bountyRows().n).toBe(2);
  }, 20000);

  it('B2: a fold-winner bounty retries after a rolled-back transfer and pays once', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['fold-first', 'passive']);
    ctx.db.prepare('UPDATE rooms SET seven_deuce_bonus = ? WHERE id = ?').run(25, room.id);
    // seat 1 (bob) is dealt 7-2 offsuit; host folds, so bob wins by fold
    const identity = Array.from({ length: 52 }, (_, i) => i);
    const wanted = [9, 0, 10, 21, 11, 12, 13, 14, 15];
    const seen = new Set(wanted);
    const Q = [...wanted, ...identity.filter((i) => !seen.has(i))];
    host.forcedShufflePerm = identity;
    players[1]!.forcedShufflePerm = Q;
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null)));
    const bob = players[1]!;
    expect(bob.myCards.slice().sort((a, b) => a - b)).toEqual([0, 21]);
    const bountyRows = () =>
      ctx.db
        .prepare("SELECT COUNT(*) AS n FROM ledger WHERE room_id = ? AND kind = 'seven-deuce'")
        .get(room.id) as { n: number };
    expect(bountyRows().n).toBe(0);

    // the first voluntary show rolls the transfer back: it must stay unpaid
    fault.sevenDeuceFailOnce = true;
    bob.showCards();
    await new Promise((r) => setTimeout(r, 200));
    expect(bountyRows().n).toBe(0);

    // retry: the show succeeds and pays exactly once
    bob.showCards();
    await host.waitFor(() => bountyRows().n === 2, 3000);
  }, 20000);

  it('a fresh client reconnecting during the hold restores the board and private cards, not just the reveal', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['passive', 'passive']);
    clock.freeze();
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.showdownAt !== null);
    const handId = host.handId!;
    const board = host.board.slice();
    const cards = host.myCards.slice();
    expect(board).toHaveLength(5);
    expect(cards).toHaveLength(2);

    // Simulate a page refresh: no cached hand context at all.
    host.disconnect();
    host.board = [];
    host.board2 = [];
    host.board3 = [];
    host.myCards = [];
    host.myCardPoints = [];
    host.sawShowdown = false;
    host.lastShowdown = null;
    await host.connect(room.id);

    await host.waitFor(
      () => host.myCards.length === 2 && host.board.length === 5 && host.sawShowdown,
      5000,
    );
    expect(host.board).toEqual(board);
    expect(host.myCards.slice().sort((a, b) => a - b)).toEqual(
      cards.slice().sort((a, b) => a - b),
    );
    expect(host.lastShowdown!.handId).toBe(handId);

    // release the hold so the room tears down cleanly
    clock.advance(400);
    await host.waitFor(() => host.handEnd !== null, 5000);
    expect(host.handEnd!.handId).toBe(handId);
  }, 20000);

  it('B3: a spectator connecting during the hold receives the public replay', async () => {
    const { room, host } = await setupRoom(['host', 'bob'], ['passive', 'passive']);
    clock.freeze();
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.showdownAt !== null);
    const handId = host.handId!;
    // a brand-new observer joins while the settlement is committed and held
    const spec = new TestClient(baseUrl, 'watcher');
    clients.push(spec);
    await spec.register();
    await spec.api('/api/rooms/join', { joinCode: room.joinCode });
    await spec.connect(room.id);
    await spec.waitFor(() => spec.board.length === 5 && spec.sawShowdown, 5000);
    expect(spec.handId).toBeNull(); // no seat: no private hand_start
    expect(spec.myCards).toHaveLength(0);
    expect(spec.lastShowdown!.handId).toBe(handId);
    clock.advance(400);
    await host.waitFor(() => host.handEnd !== null, 5000);
  }, 20000);

  it('B4: exhausted settlement retries freeze the table and host retry settles once', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['passive', 'passive']);
    ctx.db.prepare('UPDATE rooms SET seven_deuce_bonus = ? WHERE id = ?').run(25, room.id);
    const identity = Array.from({ length: 52 }, (_, i) => i);
    const wanted = [0, 4, 21, 8, 20, 22, 23, 31, 47];
    const seen = new Set(wanted);
    const Q = [...wanted, ...identity.filter((i) => !seen.has(i))];
    host.forcedShufflePerm = identity;
    players[1]!.forcedShufflePerm = Q;
    fault.persistFailThrough = 1000; // every durable-write attempt fails
    clock.freeze();
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.settlementFailures.length === 1, 5000);
    const handId = host.handId!;
    for (let i = 0; i < 4; i++) {
      clock.advance(250);
      await host.waitFor(() => host.settlementFailures.length === i + 2, 3000);
    }
    expect(host.settlementFailures.at(-1)!.retrying).toBe(false);
    // frozen: nothing committed, and no new hand may be dealt over it
    expect(
      ctx.db.prepare('SELECT 1 FROM hand_settlements WHERE hand_id = ?').get(handId),
    ).toBeUndefined();
    host.errors = [];
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.errors.some((e) => /hand already running/i.test(e)), 3000);

    // host recovery: clear the fault and retry; pays exactly once
    fault.persistFailThrough = 0;
    host.send({ t: 'retry_settlement' });
    await host.waitFor(() => host.sawShowdown, 5000);
    clock.advance(400);
    await host.waitFor(() => host.handEnd !== null, 5000);
    expect(
      (
        ctx.db
          .prepare('SELECT COUNT(*) AS n FROM hand_settlements WHERE hand_id = ?')
          .get(handId) as { n: number }
      ).n,
    ).toBe(1);
    expect(
      (
        ctx.db
          .prepare("SELECT COUNT(*) AS n FROM ledger WHERE ref = ? AND kind = 'seven-deuce'")
          .get(handId) as { n: number }
      ).n,
    ).toBe(2);
  }, 25000);

  it('holds hand_end for exactly the reveal window and broadcasts it only once', async () => {
    const { host } = await setupRoom(['host', 'bob'], ['passive', 'passive']);
    clock.freeze();
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.showdownAt !== null);
    // one tick short of the 400ms reveal hold: still held
    clock.advance(399);
    expect(host.handEnd).toBeNull();
    // the exact due tick releases it
    clock.advance(1);
    await host.waitFor(() => host.handEnd !== null, 5000);
    expect(host.handEndCount).toBe(1);
    // later timers/advances must never emit a second terminal frame
    clock.advance(10000);
    expect(host.handEndCount).toBe(1);
  }, 20000);

  it('a fold-out under a frozen clock ends without any clock advance', async () => {
    const { host } = await setupRoom(['host', 'bob'], ['fold-first', 'passive']);
    clock.freeze();
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.handEnd !== null, 5000);
    expect(host.handEndCount).toBe(1);
    expect(host.sawShowdown).toBe(false);
  }, 20000);

  it('isolates a failed durable settlement, blocks the next hand, and retries to success', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['passive', 'passive']);
    fault.persistFailThrough = 1; // first attempt fails; the retry succeeds
    clock.freeze();
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.settlementFailures.length > 0, 8000);
    const handId = host.handId!;
    expect(host.settlementFailures[0]!.retrying).toBe(true);
    // NOT committed: no marker, no reveal, no terminal frame
    expect(
      ctx.db.prepare('SELECT 1 FROM hand_settlements WHERE hand_id = ?').get(handId),
    ).toBeUndefined();
    expect(host.sawShowdown).toBe(false);
    expect(host.handEnd).toBeNull();

    // the next hand is blocked rather than dealt over an unsettled one
    host.errors = [];
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.errors.some((e) => /hand already running/i.test(e)), 3000);

    // the clock-driven retry commits the same deterministic result
    clock.advance(300);
    await host.waitFor(() => host.sawShowdown, 5000);
    expect(
      ctx.db.prepare('SELECT 1 FROM hand_settlements WHERE hand_id = ?').get(handId),
    ).toBeTruthy();
    expect(host.settlementFailures).toHaveLength(1);
    const total = ctx.db
      .prepare('SELECT SUM(stack) AS total FROM room_players WHERE room_id = ?')
      .get(room.id) as { total: number };
    expect(total.total).toBe(2000);
    clock.advance(400);
    await host.waitFor(() => host.handEnd !== null, 5000);
    expect(host.handEndCount).toBe(1);
  }, 25000);

  it('a lost settlement broadcast still lets the room finish without a refund', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['passive', 'passive']);
    fault.broadcastThrowT = 'showdown';
    host.send({ t: 'start_hand' });
    // The reveal frame is lost, but the terminal frame still arrives...
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 15000)));
    const handId = host.handId!;
    expect(host.handEnd!.handId).toBe(handId);
    // ...and the hand was committed, not refunded/aborted.
    expect(host.handAbort).toBeNull();
    expect(
      ctx.db.prepare('SELECT 1 FROM hand_settlements WHERE hand_id = ?').get(handId),
    ).toBeTruthy();
    const total = ctx.db
      .prepare('SELECT SUM(stack) AS total FROM room_players WHERE room_id = ?')
      .get(room.id) as { total: number };
    expect(total.total).toBe(2000);
  }, 25000);

  it('seals the transcript: a late audit key and a hold-time voluntary show never change the head', async () => {
    const { players, room, host } = await setupRoom(
      ['host', 'bob', 'carol'],
      ['passive', 'passive', 'fold-first'],
    );
    ctx.db.prepare('UPDATE rooms SET tv_replays = 1, auto_deal = 0 WHERE id = ?').run(room.id);
    const [h, , carol] = players as [TestClient, TestClient, TestClient];
    clock.freeze();
    h.respondKeys = false; // force the audit timeout to settle best-effort
    h.send({ t: 'start_hand' });
    await h.waitFor(() => h.sawShowdown, 8000);
    const handId = h.handId!;
    const persisted = ctx.db
      .prepare('SELECT head FROM transcripts WHERE hand_id = ?')
      .get(handId) as { head: string } | undefined;
    expect(persisted).toBeTruthy();
    const entryCount = h.transcriptHeads.length;
    const headBefore = h.transcriptHeads.at(-1);

    // A key that missed the audit deadline and a folded player's voluntary show
    // during the hold are live-only: neither may append to the sealed chain.
    h.sendRevealKey();
    carol.showCards();
    await new Promise((r) => setTimeout(r, 200));

    expect(h.transcriptHeads).toHaveLength(entryCount);
    expect(h.transcriptHeads.at(-1) ?? headBefore).toBe(headBefore);
    expect(
      (ctx.db.prepare('SELECT head FROM transcripts WHERE hand_id = ?').get(handId) as {
        head: string;
      }).head,
    ).toBe(persisted!.head);

    clock.advance(400);
    await h.waitFor(() => h.handEnd !== null, 5000);
    expect(h.handEndCount).toBe(1);
  }, 20000);

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
    // carol never clicks I'm ready: opt her out of the (now default-on)
    // server-side auto-ready, then the deadline passes and the other two play
    players[2]!.autoReady = false;
    ctx.db.prepare('UPDATE users SET auto_ready = 0 WHERE id = ?').run(players[2]!.userId);
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
    // B1: `room_players.stack` (hence `hand_end.stacks`) is authoritative. This
    // room has no platform user, so the rake is credited to the in-room banker
    // and the table total is fully conserved; the players' combined deltas are
    // still net of that commission.
    const end = players[0]!.handEnd!;
    expect(end.stacks.reduce((s, x) => s + x.stack, 0)).toBe(before);
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

  it('idempotency: a duplicate settlement never re-pays the 7-2 bounty', async () => {
    const { players, room } = await setupRoom(['dupa', 'dupb']);
    const a = players[0]!.userId;
    const b = players[1]!.userId;
    const args = {
      handId: 'dup-bounty-1',
      roomId: room.id,
      head: 'dup-head-1',
      entries: [],
      rake: 0,
      commissionBps: 50,
      stackDeltas: [
        { userId: a, delta: -20 },
        { userId: b, delta: 20 },
      ],
      pokerLedger: [],
      squidLedger: [],
      squidNote: 'Squid Game penalty/payout',
      timeBanks: [],
      timeBankEpoch: null,
      triggerIds: [],
      bombRan: false,
      rakeRecipientId: null,
      sevenDeuce: {
        winnerUserId: b,
        winnerSeat: 1,
        winnerAmount: 20,
        payerAmounts: [{ userId: a, amount: 20 }],
      },
      now: Date.now(),
    };
    const bountyRows = () =>
      ctx.db
        .prepare("SELECT COUNT(*) AS n FROM ledger WHERE room_id = ? AND kind = 'seven-deuce'")
        .get(room.id) as { n: number };
    expect(applyHandSettlement(ctx.db, args).status).toBe('applied');
    expect(bountyRows().n).toBe(2);
    expect(applyHandSettlement(ctx.db, args).status).toBe('duplicate');
    expect(bountyRows().n).toBe(2); // the bounty is never paid twice
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
    // B1: the table total is the authoritative `room_players.stack`; with no
    // platform user the rake returns to the in-room banker, so it is conserved.
    expect(end.stacks.reduce((s, x) => s + x.stack, 0)).toBe(before);
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

describe('settlement lifecycle v5', () => {
  it('P0-1: when the banker is in the hand the rake is an explicit per-seat commissionDelta', async () => {
    const { players, room, host } = await setupRoom(['bankera', 'bankerb'], ['passive', 'passive']);
    // No platform account: rake falls back to the in-room banker (the host).
    ctx.db.prepare("DELETE FROM meta WHERE key = 'platform_user_id'").run();
    ctx.db.prepare('UPDATE rooms SET commission_bps = 500 WHERE id = ?').run(room.id);
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 15000)));
    expect(host.handAbort).toBeNull();
    const end = host.handEnd!;
    const rake = end.commission ?? 0;
    expect(rake).toBeGreaterThan(0);

    // Per-seat contract: ending - starting === net_delta + wire commissionDelta.
    const proj = ctx.db
      .prepare(
        'SELECT user_id, seat, starting_stack, ending_stack, net_delta FROM hand_players WHERE hand_id = ?',
      )
      .all(end.handId) as {
      user_id: number;
      seat: number;
      starting_stack: number;
      ending_stack: number;
      net_delta: number;
    }[];
    const comm = ctx.db
      .prepare(
        "SELECT user_id, SUM(delta) AS d FROM ledger WHERE ref = ? AND kind = 'commission' GROUP BY user_id",
      )
      .all(end.head) as { user_id: number; d: number }[];
    const commByUser = new Map(comm.map((c) => [c.user_id, c.d]));
    expect(commByUser.size).toBe(1);
    expect([...commByUser.values()][0]).toBe(rake);
    const bankerId = (
      ctx.db.prepare('SELECT banker_id FROM rooms WHERE id = ?').get(room.id) as {
        banker_id: number;
      }
    ).banker_id;
    const bankerSeat = proj.find((p) => p.user_id === bankerId)!.seat;
    // Direct wire assertion, not an inference from a ledger query.
    const commissionLeg = end.commissionDeltas ?? [];
    expect(commissionLeg).toEqual([{ seat: bankerSeat, delta: rake }]);
    const wireCommissionBySeat = new Map(commissionLeg.map((c) => [c.seat, c.delta]));
    for (const p of proj) {
      expect(p.ending_stack - p.starting_stack).toBe(
        p.net_delta + (wireCommissionBySeat.get(p.seat) ?? 0),
      );
    }
    // The game leg remains -rake zero-sum; the commission leg is +rake, and
    // because the recipient is in hand the aggregate is exactly zero.
    const gameSum = end.deltas.reduce((s, d) => s + d.delta, 0);
    const commissionSum = commissionLeg.reduce((s, d) => s + d.delta, 0);
    expect(gameSum).toBe(-rake);
    expect(commissionSum).toBe(rake);
    expect(gameSum + commissionSum).toBe(0); // recipient in hand
    // The rake never left the table: total hand stacks are conserved.
    expect(end.stacks.reduce((s, x) => s + x.stack, 0)).toBe(2000);
  }, 20000);

  it('P0-1: with an out-of-hand platform recipient every seat still reconciles net_delta', async () => {
    const { players, room, host } = await setupRoom(['plata', 'platb'], ['passive', 'passive']);
    const { userId: platformId } = createUser(ctx.db, 'platformv5', 'c'.repeat(64), 'd'.repeat(64));
    setPlatformUserId(ctx.db, platformId);
    ctx.db.prepare('UPDATE rooms SET commission_bps = 500 WHERE id = ?').run(room.id);
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 15000)));
    const end = host.handEnd!;
    const rake = end.commission ?? 0;
    expect(rake).toBeGreaterThan(0);
    expect(end.commissionDeltas ?? []).toHaveLength(0); // platform has no seat

    const proj = ctx.db
      .prepare(
        'SELECT user_id, starting_stack, ending_stack, net_delta FROM hand_players WHERE hand_id = ?',
      )
      .all(end.handId) as {
      user_id: number;
      starting_stack: number;
      ending_stack: number;
      net_delta: number;
    }[];
    for (const p of proj) expect(p.ending_stack - p.starting_stack).toBe(p.net_delta);
    // Conditional aggregate: sum(deltas) is always -rake, but with the
    // recipient out of hand the in-hand commission leg is empty, so the sum is
    // -rake (NOT 0). The credit lives on the external account's ledger row.
    const gameSum = end.deltas.reduce((s, d) => s + d.delta, 0);
    const commissionSum = (end.commissionDeltas ?? []).reduce((s, d) => s + d.delta, 0);
    expect(gameSum).toBe(-rake);
    expect(gameSum + commissionSum).toBe(-rake);
    const platformStack = ctx.db
      .prepare('SELECT stack FROM room_players WHERE room_id = ? AND user_id = ?')
      .get(room.id, platformId) as { stack: number };
    expect(platformStack.stack).toBe(rake);
  }, 20000);

  it('P0-3: an unresolvable pre-lifecycle transcript is quarantined and freezes the room', async () => {
    const dir = mkdtempSync(join(tmpdir(), '4am-legacy-'));
    const dbPath = join(dir, 'game.db');
    const saved = { ctx, baseUrl, hub };
    const app = createApp(dbPath);
    const appHub = attachHub(app.app, app.db, {
      cryptoTimeoutMs: 1500,
      actionTimeoutMs: 1500,
      autoDealMs: 3_600_000,
      readyCheckMs: 1500,
      clock,
    });
    await app.app.listen({ port: 0 });
    const addr = app.app.server.address() as AddressInfo;
    ctx = app;
    hub = appHub;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    try {
      const { players, room, host } = await setupRoom(['lega', 'legb'], ['passive', 'passive']);
      // Simulate a database written before hand_lifecycle existed: a transcript
      // with no settlement marker and no reconcilable ledger/projection.
      ctx.db
        .prepare(
          "INSERT INTO transcripts (hand_id, room_id, head, entries, ts) VALUES (?, ?, ?, '[]', ?)",
        )
        .run('legacy-hand-1', room.id, 'legacyhead', 1);
      for (const c of players) c.close();
      await app.app.close();

      // Reopen: the strict reconciliation cannot prove this hand settled, so it
      // is QUARANTINED (fail closed) rather than whitelisted as history.
      const restarted = createApp(dbPath);
      const row = restarted.db
        .prepare('SELECT status, last_error FROM hand_lifecycle WHERE hand_id = ?')
        .get('legacy-hand-1') as { status: string; last_error: string | null } | undefined;
      expect(row?.status).toBe('quarantined');
      expect(firstPendingHandLifecycle(restarted.db, room.id)).toBe('legacy-hand-1');

      const nextHub = attachHub(restarted.app, restarted.db, {
        cryptoTimeoutMs: 1500,
        actionTimeoutMs: 1500,
        autoDealMs: 3_600_000,
        readyCheckMs: 1500,
        clock,
      });
      await restarted.app.listen({ port: 0 });
      const addr2 = restarted.app.server.address() as AddressInfo;
      ctx = restarted;
      hub = nextHub;
      baseUrl = `http://127.0.0.1:${addr2.port}`;
      for (const p of players) {
        p.baseUrl = baseUrl;
        await p.connect(room.id);
      }
      host.errors = [];
      host.send({ t: 'start_hand' });
      await host.waitFor(() => host.errors.some((e) => /never settled|frozen/i.test(e)), 4000);
      for (const p of players) p.close();
      await restarted.app.close();
    } finally {
      ctx = saved.ctx;
      baseUrl = saved.baseUrl;
      hub = saved.hub;
    }
  }, 30000);

  it('P0-2: a rolled-back settlement leaves a durable running row that a graceful shutdown resolves', async () => {
    const dir = mkdtempSync(join(tmpdir(), '4am-rollback-'));
    const dbPath = join(dir, 'game.db');
    const saved = { ctx, baseUrl, hub };
    const app = createApp(dbPath);
    const appHub = attachHub(app.app, app.db, {
      cryptoTimeoutMs: 1500,
      actionTimeoutMs: 1500,
      autoDealMs: 3_600_000,
      readyCheckMs: 1500,
      showdownHoldMs: 400,
      settleHoldMs: 0,
      clock,
      faultInjection: {
        persist: (attempt) => {
          if (fault.persistFailThrough >= attempt) throw new Error('injected persist failure');
        },
      },
    });
    await app.app.listen({ port: 0 });
    const addr = app.app.server.address() as AddressInfo;
    ctx = app;
    hub = appHub;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    try {
      const { players, room, host } = await setupRoom(['rba', 'rbb'], ['passive', 'passive']);
      fault.persistFailThrough = 1000;
      clock.freeze();
      host.send({ t: 'start_hand' });
      await host.waitFor(() => host.settlementFailures.length === 1, 8000);
      const handId = host.handId!;
      for (let i = 0; i < 4; i++) {
        clock.advance(250);
        await host.waitFor(() => host.settlementFailures.length === i + 2, 3000);
      }
      expect(host.settlementFailures.at(-1)!.retrying).toBe(false);

      // The rollback left no transcript and no marker - the old detector saw
      // nothing - but the durable lifecycle row survived.
      expect(
        ctx.db.prepare('SELECT 1 FROM hand_settlements WHERE hand_id = ?').get(handId),
      ).toBeUndefined();
      expect(ctx.db.prepare('SELECT 1 FROM transcripts WHERE hand_id = ?').get(handId)).toBeUndefined();
      expect(
        ctx.db.prepare('SELECT status FROM hand_lifecycle WHERE hand_id = ?').get(handId),
      ).toEqual({ status: 'running' });

      for (const c of players) c.close();
      // A graceful shutdown drains the frozen, never-settled hand: it is
      // aborted (no chips moved) so the room is not permanently frozen.
      await app.app.close();

      const restarted = createApp(dbPath);
      expect(
        restarted.db.prepare('SELECT status FROM hand_lifecycle WHERE hand_id = ?').get(handId),
      ).toEqual({ status: 'aborted' });
      expect(firstPendingHandLifecycle(restarted.db, room.id)).toBeNull();
      fault.persistFailThrough = 0;
      const restartHub = attachHub(restarted.app, restarted.db, {
        cryptoTimeoutMs: 1500,
        actionTimeoutMs: 1500,
        autoDealMs: 3_600_000,
        readyCheckMs: 1500,
        showdownHoldMs: 0,
        settleHoldMs: 0,
        clock,
      });
      await restarted.app.listen({ port: 0 });
      const addr2 = restarted.app.server.address() as AddressInfo;
      ctx = restarted;
      hub = restartHub;
      baseUrl = `http://127.0.0.1:${addr2.port}`;
      // The old DB lifecycle protocol resumes: a fresh hand deals and settles.
      for (const p of players) {
        p.baseUrl = baseUrl;
        await p.connect(room.id);
      }
      host.send({ t: 'start_hand' });
      await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 15000)));
      expect(players[0]!.handAbort).toBeNull();
      for (const p of players) p.close();
      await restarted.app.close();
    } finally {
      ctx = saved.ctx;
      baseUrl = saved.baseUrl;
      hub = saved.hub;
    }
  }, 30000);

  it('P1-1/P1-2: a rolled-back 7-2 bounty is retryable, does not lock the room, and does not re-broadcast the show', async () => {
    const { players, room, host } = await setupRoom(['uha', 'uhb'], ['fold-first', 'passive']);
    ctx.db.prepare('UPDATE rooms SET auto_deal = 0, seven_deuce_bonus = 25 WHERE id = ?').run(room.id);
    // Seat 1 (bob) is dealt 7-2 offsuit; the host folds, so bob wins by fold.
    const identity = Array.from({ length: 52 }, (_, i) => i);
    const wanted = [9, 0, 10, 21, 11, 12, 13, 14, 15];
    const seen = new Set(wanted);
    const Q = [...wanted, ...identity.filter((i) => !seen.has(i))];
    host.forcedShufflePerm = identity;
    players[1]!.forcedShufflePerm = Q;
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 15000)));
    const bob = players[1]!;
    const gameRoom = hub.rooms.get(room.id)!;

    fault.sevenDeuceFailOnce = true;
    bob.showCards();
    await new Promise((r) => setTimeout(r, 200));
    // A known, retryable business failure: the room must not go unhealthy...
    expect(gameRoom.isUnhealthy()).toBe(false);
    // ...and the public `cards_shown` frame must not have been sent before the
    // payment committed (so a retry cannot duplicate it).
    expect(host.cardsShown).toHaveLength(0);

    bob.showCards();
    await host.waitFor(() => host.cardsShown.length === 1, 3000);
    expect(host.cardsShown).toHaveLength(1);
    expect(bob.cardsShown).toHaveLength(1);
    expect(gameRoom.isUnhealthy()).toBe(false);
  }, 20000);

  it('P1-1: a recoverable mark clears only on the exact verified reason and then deals again', async () => {
    const { players, room, host } = await setupRoom(['mha', 'mhb'], ['passive', 'passive']);
    ctx.db.prepare('UPDATE rooms SET auto_deal = 0 WHERE id = ?').run(room.id);
    const gameRoom = hub.rooms.get(room.id)!;
    gameRoom.markUnhealthy('settlement failed: busy', { recoverable: true });
    expect(gameRoom.isUnhealthy()).toBe(true);
    expect(gameRoom.clearUnhealthy('some other reason')).toBe(false);
    expect(gameRoom.isUnhealthy()).toBe(true);
    expect(gameRoom.clearUnhealthy('settlement failed: busy')).toBe(true);
    expect(gameRoom.isUnhealthy()).toBe(false);
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 15000)));
    expect(players[0]!.handAbort).toBeNull();
  }, 20000);

  it('P1-1: an unknown (non-recoverable) mark is not clearable and stays fail-closed', async () => {
    const { room, host } = await setupRoom(['nra', 'nrb'], ['passive', 'passive']);
    ctx.db.prepare('UPDATE rooms SET auto_deal = 0 WHERE id = ?').run(room.id);
    const gameRoom = hub.rooms.get(room.id)!;
    gameRoom.markUnhealthy('TypeError: boom');
    expect(gameRoom.clearUnhealthy('TypeError: boom')).toBe(false);
    expect(gameRoom.isUnhealthy()).toBe(true);
    host.errors = [];
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.errors.some((e) => /held for an operator/i.test(e)), 3000);
    expect(host.handEnd).toBeNull();
  }, 20000);
});

describe('settlement lifecycle v6', () => {
  it('P0-1: a fallback banker outside the hand gets no seat leg and the aggregate is conditional', async () => {
    const { players, room, host } = await setupRoom(['fba', 'fbb'], ['passive', 'passive']);
    ctx.db.prepare("DELETE FROM meta WHERE key = 'platform_user_id'").run();
    const { userId: bankerId } = createUser(ctx.db, 'outbanker', 'e'.repeat(64), 'f'.repeat(64));
    ctx.db
      .prepare('UPDATE rooms SET commission_bps = 500, banker_id = ? WHERE id = ?')
      .run(bankerId, room.id);
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 15000)));
    const end = host.handEnd!;
    const rake = end.commission ?? 0;
    expect(rake).toBeGreaterThan(0);
    // The recipient has no seat: the wire commission leg is empty.
    expect(end.commissionDeltas ?? []).toHaveLength(0);
    const gameSum = end.deltas.reduce((s, d) => s + d.delta, 0);
    const commissionSum = (end.commissionDeltas ?? []).reduce((s, d) => s + d.delta, 0);
    expect(gameSum).toBe(-rake); // unconditional
    expect(gameSum + commissionSum).toBe(-rake); // NOT 0: recipient out of hand
    // Every seat still reconciles without a commission delta.
    const proj = ctx.db
      .prepare(
        'SELECT user_id, starting_stack, ending_stack, net_delta FROM hand_players WHERE hand_id = ?',
      )
      .all(end.handId) as {
      user_id: number;
      starting_stack: number;
      ending_stack: number;
      net_delta: number;
    }[];
    for (const p of proj) expect(p.ending_stack - p.starting_stack).toBe(p.net_delta);
    const banker = ctx.db
      .prepare('SELECT stack FROM room_players WHERE room_id = ? AND user_id = ?')
      .get(room.id, bankerId) as { stack: number };
    expect(banker.stack).toBe(rake);
  }, 20000);

  it('P0-2: a post-cutoff transcript without a marker is quarantined and freezes the room', async () => {
    const dir = mkdtempSync(join(tmpdir(), '4am-qtn-'));
    const dbPath = join(dir, 'game.db');
    const saved = { ctx, baseUrl, hub };
    const app = createApp(dbPath);
    const appHub = attachHub(app.app, app.db, {
      cryptoTimeoutMs: 1500,
      actionTimeoutMs: 1500,
      autoDealMs: 3_600_000,
      readyCheckMs: 1500,
      clock,
    });
    await app.app.listen({ port: 0 });
    const addr = app.app.server.address() as AddressInfo;
    ctx = app;
    hub = appHub;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    try {
      const { players, room, host } = await setupRoom(['qta', 'qtb'], ['passive', 'passive']);
      // A transcript created AFTER the lifecycle cutoff with no settlement
      // marker: cannot be assumed settled (half-settled / corrupted), so it
      // must be quarantined rather than whitelisted as legacy.
      ctx.db
        .prepare(
          "INSERT INTO transcripts (hand_id, room_id, head, entries, ts) VALUES (?, ?, ?, '[]', ?)",
        )
        .run('orphan-hand-1', room.id, 'orphanhead', Date.now() + 1000);
      for (const c of players) c.close();
      await app.app.close();

      const restarted = createApp(dbPath);
      const row = restarted.db
        .prepare('SELECT status FROM hand_lifecycle WHERE hand_id = ?')
        .get('orphan-hand-1') as { status: string } | undefined;
      expect(row?.status).toBe('quarantined');
      expect(firstPendingHandLifecycle(restarted.db, room.id)).toBe('orphan-hand-1');

      const nextHub = attachHub(restarted.app, restarted.db, {
        cryptoTimeoutMs: 1500,
        actionTimeoutMs: 1500,
        autoDealMs: 3_600_000,
        readyCheckMs: 1500,
        clock,
      });
      await restarted.app.listen({ port: 0 });
      const addr2 = restarted.app.server.address() as AddressInfo;
      ctx = restarted;
      hub = nextHub;
      baseUrl = `http://127.0.0.1:${addr2.port}`;
      for (const p of players) {
        p.baseUrl = baseUrl;
        await p.connect(room.id);
      }
      host.errors = [];
      host.send({ t: 'start_hand' });
      await host.waitFor(() => host.errors.some((e) => /never settled|frozen/i.test(e)), 4000);
      for (const p of players) p.close();
      await restarted.app.close();
    } finally {
      ctx = saved.ctx;
      baseUrl = saved.baseUrl;
      hub = saved.hub;
    }
  }, 30000);

  it('P0-3: a graceful shutdown drains a live hand to terminal so restart is not frozen', async () => {
    const dir = mkdtempSync(join(tmpdir(), '4am-drain-'));
    const dbPath = join(dir, 'game.db');
    const saved = { ctx, baseUrl, hub };
    const app = createApp(dbPath);
    const appHub = attachHub(app.app, app.db, {
      cryptoTimeoutMs: 1500,
      actionTimeoutMs: 1500,
      autoDealMs: 3_600_000,
      readyCheckMs: 1500,
      shutdownDrainMs: 120,
      clock,
    });
    await app.app.listen({ port: 0 });
    const addr = app.app.server.address() as AddressInfo;
    ctx = app;
    hub = appHub;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    try {
      const { players, room, host } = await setupRoom(['sda', 'sdb'], ['passive', 'passive']);
      // Stall the hand so the drain window must abort it.
      players[1]!.respondShares = false;
      host.send({ t: 'start_hand' });
      await host.waitFor(() => host.handId !== null, 5000);
      const handId = host.handId!;

      // Graceful shutdown drains the live hand: the stalled hand cannot reach a
      // terminal state, so after the bounded window it is aborted and its
      // lifecycle row becomes terminal. This is exactly what the hub's onClose
      // awaits before dropping sockets.
      await hub.rooms.get(room.id)!.shutdown();
      expect(
        ctx.db.prepare('SELECT status FROM hand_lifecycle WHERE hand_id = ?').get(handId),
      ).toEqual({ status: 'aborted' });

      // Tear the first server down, then "restart" on the same file.
      for (const p of players) p.close();
      await app.app.close();

      const restarted = createApp(dbPath);
      const row = restarted.db
        .prepare('SELECT status FROM hand_lifecycle WHERE hand_id = ?')
        .get(handId) as { status: string } | undefined;
      expect(row?.status).toBe('aborted');
      expect(firstPendingHandLifecycle(restarted.db, room.id)).toBeNull();

      const nextHub = attachHub(restarted.app, restarted.db, {
        cryptoTimeoutMs: 1500,
        actionTimeoutMs: 1500,
        autoDealMs: 3_600_000,
        readyCheckMs: 1500,
        shutdownDrainMs: 120,
        clock,
      });
      await restarted.app.listen({ port: 0 });
      const addr2 = restarted.app.server.address() as AddressInfo;
      ctx = restarted;
      hub = nextHub;
      baseUrl = `http://127.0.0.1:${addr2.port}`;
      players[1]!.respondShares = true;
      for (const p of players) {
        p.baseUrl = baseUrl;
        await p.connect(room.id);
      }
      host.send({ t: 'start_hand' });
      await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 15000)));
      expect(players[0]!.handAbort).toBeNull();
      for (const p of players) p.close();
      await restarted.app.close();
    } finally {
      ctx = saved.ctx;
      baseUrl = saved.baseUrl;
      hub = saved.hub;
    }
  }, 40000);

  it('P1-4: an unexpected internal TypeError in the 7-2 bounty is NOT classified retryable', async () => {
    const { players, room, host } = await setupRoom(['i4a', 'i4b'], ['fold-first', 'passive']);
    ctx.db.prepare('UPDATE rooms SET auto_deal = 0, seven_deuce_bonus = 25 WHERE id = ?').run(room.id);
    const identity = Array.from({ length: 52 }, (_, i) => i);
    const wanted = [9, 0, 10, 21, 11, 12, 13, 14, 15];
    const seen = new Set(wanted);
    const Q = [...wanted, ...identity.filter((i) => !seen.has(i))];
    host.forcedShufflePerm = identity;
    players[1]!.forcedShufflePerm = Q;
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 15000)));
    const bob = players[1]!;
    const gameRoom = hub.rooms.get(room.id)!;

    fault.sevenDeuceInternal = () => {
      throw new TypeError('internal boom');
    };
    bob.showCards();
    await host.waitFor(() => gameRoom.isUnhealthy(), 3000);
    fault.sevenDeuceInternal = null;
    // A programming error is a permanent mark: never clearable.
    expect(gameRoom.clearUnhealthy('anything')).toBe(false);
    host.errors = [];
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.errors.some((e) => /held for an operator/i.test(e)), 3000);
  }, 20000);

  it('P1-5: an unknown error after a recoverable mark escalates and survives a settlement success', async () => {
    const { room, host } = await setupRoom(['i5a', 'i5b'], ['passive', 'passive']);
    ctx.db.prepare('UPDATE rooms SET auto_deal = 0 WHERE id = ?').run(room.id);
    const gameRoom = hub.rooms.get(room.id)!;
    gameRoom.markUnhealthy('settlement failed: busy', { recoverable: true });
    // A later, genuinely unknown programming error must escalate the mark.
    gameRoom.markUnhealthy('TypeError: late');
    expect(gameRoom.isUnhealthy()).toBe(true);
    // A settlement success can no longer clear it.
    gameRoom.settlementRecovered();
    expect(gameRoom.isUnhealthy()).toBe(true);
    expect(gameRoom.clearUnhealthy('TypeError: late')).toBe(false);
    expect(gameRoom.clearUnhealthy('settlement failed: busy')).toBe(false);
    host.errors = [];
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.errors.some((e) => /held for an operator/i.test(e)), 3000);
  }, 20000);

  it('P1-5b: an unknown error first is not downgraded by a later recoverable mark', async () => {
    const { room } = await setupRoom(['i5c', 'i5d'], ['passive', 'passive']);
    ctx.db.prepare('UPDATE rooms SET auto_deal = 0 WHERE id = ?').run(room.id);
    const gameRoom = hub.rooms.get(room.id)!;
    gameRoom.markUnhealthy('TypeError: first');
    gameRoom.markUnhealthy('settlement failed: busy', { recoverable: true });
    gameRoom.settlementRecovered();
    expect(gameRoom.isUnhealthy()).toBe(true);
    expect(gameRoom.clearUnhealthy('TypeError: first')).toBe(false);
  }, 20000);

  it('P1-6: mid-hand buy breaks ending-starting === net_delta even with commission', async () => {
    const { players, room, host } = await setupRoom(['m6a', 'm6b'], ['fold-first', 'passive']);
    ctx.db.prepare('UPDATE rooms SET commission_bps = 500 WHERE id = ?').run(room.id);
    host.send({ t: 'start_hand' });
    const req = await host.api(`/api/rooms/${room.id}/buy`, { amount: 500 });
    await host.api(`/api/rooms/${room.id}/approve`, { requestId: req.id, approve: true });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 15000)));
    const end = host.handEnd!;
    const rake = end.commission ?? 0;
    expect(rake).toBeGreaterThan(0);
    const hostUser = ctx.db
      .prepare('SELECT user_id FROM room_players WHERE room_id = ? AND seat = 0')
      .get(room.id) as { user_id: number };
    const p = ctx.db
      .prepare(
        'SELECT starting_stack, ending_stack, net_delta FROM hand_players WHERE hand_id = ? AND user_id = ?',
      )
      .get(end.handId, hostUser.user_id) as {
      starting_stack: number;
      ending_stack: number;
      net_delta: number;
    };
    const comm = ctx.db
      .prepare(
        "SELECT COALESCE(SUM(delta), 0) AS d FROM ledger WHERE ref = ? AND kind = 'commission' AND user_id = ?",
      )
      .get(end.head, hostUser.user_id) as { d: number };
    // The buy is an intervening account delta: the naive identity explicitly
    // does NOT hold, and the exception is the 500 chips bought mid-hand (plus
    // any commission leg this seat happens to receive).
    expect(p.ending_stack - p.starting_stack).not.toBe(p.net_delta);
    expect(p.ending_stack - p.starting_stack).toBe(p.net_delta + 500 + comm.d);
  }, 20000);

  it('P1-7: resolving a pending lifecycle row unblocks dealing without a restart', async () => {
    const { players, room, host } = await setupRoom(['c7a', 'c7b'], ['passive', 'passive']);
    ctx.db.prepare('UPDATE rooms SET auto_deal = 0 WHERE id = ?').run(room.id);
    ctx.db
      .prepare(
        "INSERT INTO hand_lifecycle (hand_id, room_id, status, created_at, updated_at) VALUES ('stale-cache-hand', ?, 'running', 1, 1)",
      )
      .run(room.id);
    host.errors = [];
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.errors.some((e) => /never settled|frozen/i.test(e)), 3000);
    // The operator resolves the row in the same process: the next deal must see
    // it (no stale startup cache).
    ctx.db
      .prepare("UPDATE hand_lifecycle SET status = 'committed', resolved_at = ? WHERE hand_id = 'stale-cache-hand'")
      .run(Date.now());
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 15000)));
    expect(players[0]!.handAbort).toBeNull();
  }, 20000);
});

describe('settlement lifecycle v7', () => {
  const playOneHand = async (names: [string, string]) => {
    const { players, room, host } = await setupRoom(names, ['passive', 'passive']);
    ctx.db.prepare('UPDATE rooms SET auto_deal = 0 WHERE id = ?').run(room.id);
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 15000)));
    expect(players[0]!.handAbort).toBeNull();
    return { players, room, host };
  };
  /** Drop the settlement marker and lifecycle row: exactly the state a database
   *  written by the pre-lifecycle protocol is in. */
  const makePreLifecycle = (handId: string) => {
    ctx.db.prepare('DELETE FROM hand_settlements WHERE hand_id = ?').run(handId);
    ctx.db.prepare('DELETE FROM hand_lifecycle WHERE hand_id = ?').run(handId);
  };
  const lifecycleRow = (handId: string) =>
    ctx.db.prepare('SELECT status, last_error FROM hand_lifecycle WHERE hand_id = ?').get(handId) as
      | { status: string; last_error: string | null }
      | undefined;

  it('P0-2: a fully reconciled historical hand is committed (not frozen) and the dry run is read-only', async () => {
    const { host, room } = await playOneHand(['ra', 'rb']);
    const handId = host.handEnd!.handId;
    makePreLifecycle(handId);

    // Dry run first: it sees one markerless transcript and reconciles it.
    const audit = auditMarkerlessTranscripts(ctx.db);
    expect(audit.transcripts).toBe(1);
    expect(audit.markerless).toBe(1);
    expect(audit.reconciled).toBe(1);
    expect(audit.quarantined).toEqual([]);
    // read-only: the dry run wrote nothing
    expect(lifecycleRow(handId)).toBeUndefined();

    reconcileMissingSettlements(ctx.db);
    expect(lifecycleRow(handId)).toEqual({ status: 'committed', last_error: 'legacy reconciled' });
    expect(firstPendingHandLifecycle(ctx.db, room.id)).toBeNull();

    // The removed `legacy` status is re-reconciled on the next pass (the old
    // "flag already exists -> no-op" hole is gone).
    ctx.db.prepare("UPDATE hand_lifecycle SET status = 'legacy' WHERE hand_id = ?").run(handId);
    reconcileMissingSettlements(ctx.db);
    expect(lifecycleRow(handId)?.status).toBe('committed');
  }, 25000);

  it('P0-2: a missing settlement leg quarantines the hand and freezes the room', async () => {
    const { host, room } = await playOneHand(['qa', 'qb']);
    const handId = host.handEnd!.handId;
    const head = host.handEnd!.head;
    makePreLifecycle(handId);
    // Remove one hand-settlement leg: the per-hand sum no longer matches -rake.
    ctx.db
      .prepare(
        "DELETE FROM ledger WHERE id = (SELECT MIN(id) FROM ledger WHERE room_id = ? AND ref = ? AND kind = 'hand-settlement')",
      )
      .run(room.id, head);

    const audit = auditMarkerlessTranscripts(ctx.db);
    expect(audit.reconciled).toBe(0);
    expect(audit.quarantined).toHaveLength(1);
    expect(audit.quarantined[0]!.reason).toMatch(/hand-settlement legs sum/);

    reconcileMissingSettlements(ctx.db);
    expect(lifecycleRow(handId)?.status).toBe('quarantined');
    expect(firstPendingHandLifecycle(ctx.db, room.id)).toBe(handId);
    // Frozen: the next deal is refused while the quarantined row stands.
    host.errors = [];
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.errors.some((e) => /never settled|frozen/i.test(e)), 3000);
  }, 25000);

  it('P0-2: a head that does not match the transcript chain quarantines the hand', async () => {
    const { host, room } = await playOneHand(['ha', 'hb']);
    const handId = host.handEnd!.handId;
    makePreLifecycle(handId);
    ctx.db.prepare('UPDATE transcripts SET head = ? WHERE hand_id = ?').run('deadbeef', handId);
    const audit = auditMarkerlessTranscripts(ctx.db);
    expect(audit.reconciled).toBe(0);
    expect(audit.quarantined[0]!.reason).toMatch(/head does not match|legs sum/);
    reconcileMissingSettlements(ctx.db);
    expect(firstPendingHandLifecycle(ctx.db, room.id)).toBe(handId);
  }, 25000);

  it('P0-2: a missing stats projection quarantines the hand', async () => {
    const { host, room } = await playOneHand(['pa', 'pb']);
    const handId = host.handEnd!.handId;
    makePreLifecycle(handId);
    ctx.db.prepare('DELETE FROM hand_players WHERE hand_id = ?').run(handId);
    const audit = auditMarkerlessTranscripts(ctx.db);
    expect(audit.reconciled).toBe(0);
    expect(audit.quarantined[0]!.reason).toMatch(/no hand_players projection rows/);
    reconcileMissingSettlements(ctx.db);
    expect(firstPendingHandLifecycle(ctx.db, room.id)).toBe(handId);
  }, 25000);

  // --- v8 hardening: the reconciliation must not trust self-consistent fakes ---

  /** Insert a raw ledger leg; every negative test re-chains afterwards so the
   *  ONLY failing rule is the one under test. */
  const addLeg = (roomId: string, userId: number, delta: number, kind: string, ref: string) =>
    ctx.db
      .prepare(
        "INSERT INTO ledger (room_id,user_id,delta,kind,ref,ts,prev_hash,entry_hash) VALUES (?,?,?,?,?,?,'seed','seed')",
      )
      .run(roomId, userId, delta, kind, ref, Date.now());

  const playerIds = (roomId: string): number[] =>
    (
      ctx.db
        .prepare('SELECT user_id FROM room_players WHERE room_id = ? ORDER BY user_id')
        .all(roomId) as { user_id: number }[]
    ).map((r) => r.user_id);

  const playRakeHand = async (names: [string, string]) => {
    const { players, room, host } = await setupRoom(names, ['passive', 'passive']);
    // No platform account: the rake falls back to the in-room banker and the
    // hand has a real commission leg.
    ctx.db.prepare("DELETE FROM meta WHERE key = 'platform_user_id'").run();
    ctx.db
      .prepare('UPDATE rooms SET auto_deal = 0, commission_bps = 500 WHERE id = ?')
      .run(room.id);
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 15000)));
    expect(players[0]!.handAbort).toBeNull();
    expect(host.handEnd!.commission ?? 0).toBeGreaterThan(0);
    return { players, room, host };
  };

  const corruptCommission = (handId: string, value: unknown) => {
    const row = ctx.db
      .prepare('SELECT entries FROM transcripts WHERE hand_id = ?')
      .get(handId) as { entries: string };
    const entries = JSON.parse(row.entries) as { type?: string; payload?: Record<string, unknown> }[];
    const settlement = entries.find((e) => e.type === 'settlement')!;
    settlement.payload!.commission = value;
    ctx.db
      .prepare('UPDATE transcripts SET entries = ? WHERE hand_id = ?')
      .run(JSON.stringify(entries), handId);
  };

  it('v8/项2: a hand-settlement leg for a user outside hand_players is rejected', async () => {
    const { host, room } = await playOneHand(['e2a', 'e2b']);
    const handId = host.handEnd!.handId;
    const head = host.handEnd!.head;
    makePreLifecycle(handId);
    // A self-consistent pair of external legs: the sum stays -rake and the
    // projection players are untouched, so only the participant rule catches it.
    addLeg(room.id, 90001, 100, 'hand-settlement', head);
    addLeg(room.id, 90002, -100, 'hand-settlement', head);
    rechainRoom(ctx.db, room.id);
    const audit = auditMarkerlessTranscripts(ctx.db);
    expect(audit.quarantined[0]?.reason).toMatch(/is not a seat in this hand/);
    reconcileMissingSettlements(ctx.db);
    expect(lifecycleRow(handId)?.status).toBe('quarantined');
  }, 25000);

  it('v9/项2d: a non-seven-deuce leg on the hand-id ref is rejected', async () => {
    const wrong: [string, string][] = [
      ['commission', 'cc'],
      ['hand-settlement', 'hh'],
      ['squid-game', 'ss'],
    ];
    for (const [kind, tag] of wrong) {
      const { host, room } = await playOneHand([`q9${tag}`, `r9${tag}`]);
      const handId = host.handEnd!.handId;
      makePreLifecycle(handId);
      addLeg(room.id, playerIds(room.id)[0]!, 10, kind, handId);
      rechainRoom(ctx.db, room.id);
      const audit = auditMarkerlessTranscripts(ctx.db);
      expect(audit.quarantined[0]?.reason).toMatch(/unexpected ledger kind .* on the hand-id ref/);
      reconcileMissingSettlements(ctx.db);
      expect(lifecycleRow(handId)?.status).toBe('quarantined');
      ctx.db.prepare('DELETE FROM transcripts WHERE hand_id = ?').run(handId);
    }
  }, 40000);

  it('v9/项2d: a seven-deuce leg on the settlement-head ref is rejected', async () => {
    const { host, room } = await playOneHand(['q9sd', 'r9sd']);
    const handId = host.handEnd!.handId;
    const head = host.handEnd!.head;
    makePreLifecycle(handId);
    addLeg(room.id, playerIds(room.id)[0]!, 10, 'seven-deuce', head);
    rechainRoom(ctx.db, room.id);
    const audit = auditMarkerlessTranscripts(ctx.db);
    expect(audit.quarantined[0]?.reason).toMatch(
      /unexpected ledger kind 'seven-deuce' on the settlement head/,
    );
    reconcileMissingSettlements(ctx.db);
    expect(lifecycleRow(handId)?.status).toBe('quarantined');
  }, 25000);


  it('v8/项3: two commission recipients are rejected (single-rake-recipient contract)', async () => {
    const { host, room } = await playRakeHand(['c3a', 'c3b']);
    const handId = host.handEnd!.handId;
    const head = host.handEnd!.head;
    const legs = ctx.db
      .prepare(
        "SELECT user_id, delta FROM ledger WHERE room_id = ? AND ref = ? AND kind = 'commission'",
      )
      .all(room.id, head) as { user_id: number; delta: number }[];
    expect(legs).toHaveLength(1);
    const total = legs[0]!.delta;
    const others = playerIds(room.id).filter((u) => u !== legs[0]!.user_id);
    makePreLifecycle(handId);
    ctx.db
      .prepare("DELETE FROM ledger WHERE room_id = ? AND ref = ? AND kind = 'commission'")
      .run(room.id, head);
    const half = Math.floor(total / 2);
    addLeg(room.id, legs[0]!.user_id, half, 'commission', head);
    addLeg(room.id, others[0]!, total - half, 'commission', head);
    rechainRoom(ctx.db, room.id);
    const audit = auditMarkerlessTranscripts(ctx.db);
    expect(audit.quarantined[0]?.reason).toMatch(/exactly one commission leg/);
    reconcileMissingSettlements(ctx.db);
    expect(lifecycleRow(handId)?.status).toBe('quarantined');
  }, 25000);

  it('v8/项4a: a duplicate seven-deuce leg on the hand-id ref is rejected', async () => {
    const { host, room } = await playOneHand(['d4a', 'd4b']);
    const handId = host.handEnd!.handId;
    makePreLifecycle(handId);
    const [u1] = playerIds(room.id);
    // Duplicate is only catchable when the hand-id ref is covered too.
    addLeg(room.id, u1!, 25, 'seven-deuce', handId);
    addLeg(room.id, u1!, 25, 'seven-deuce', handId);
    rechainRoom(ctx.db, room.id);
    const audit = auditMarkerlessTranscripts(ctx.db);
    expect(audit.quarantined[0]?.reason).toMatch(/duplicate seven-deuce leg/);
    reconcileMissingSettlements(ctx.db);
    expect(lifecycleRow(handId)?.status).toBe('quarantined');
  }, 25000);

  it('v8/项4b: a seven-deuce winner not funded by its payers is rejected', async () => {
    const { host, room } = await playOneHand(['d4c', 'd4d']);
    const handId = host.handEnd!.handId;
    makePreLifecycle(handId);
    const [u1, u2] = playerIds(room.id);
    addLeg(room.id, u1!, 100, 'seven-deuce', handId); // winner
    addLeg(room.id, u2!, -50, 'seven-deuce', handId); // payer underpays
    rechainRoom(ctx.db, room.id);
    const audit = auditMarkerlessTranscripts(ctx.db);
    expect(audit.quarantined[0]?.reason).toMatch(/seven-deuce payers 50 != winner 100/);
    reconcileMissingSettlements(ctx.db);
    expect(lifecycleRow(handId)?.status).toBe('quarantined');
  }, 25000);

  it('v8/项5: a projection from a different room is rejected', async () => {
    const { host, room } = await playOneHand(['e5a', 'e5b']);
    const handId = host.handEnd!.handId;
    makePreLifecycle(handId);
    ctx.db.prepare('UPDATE hands SET room_id = ? WHERE hand_id = ?').run('other-room', handId);
    const audit = auditMarkerlessTranscripts(ctx.db);
    expect(audit.quarantined[0]?.reason).toMatch(/projection room_id .* != transcript room_id/);
    reconcileMissingSettlements(ctx.db);
    expect(lifecycleRow(handId)?.status).toBe('quarantined');
  }, 25000);

  it('v8/项6: a fractional or negative rake is rejected', async () => {
    for (const bad of [1.5, -5, '5']) {
      const { host, room } = await playOneHand([`r6${String(bad).length}`, `s6${String(bad).length}`]);
      const handId = host.handEnd!.handId;
      makePreLifecycle(handId);
      corruptCommission(handId, bad);
      const audit = auditMarkerlessTranscripts(ctx.db);
      expect(audit.quarantined[0]?.reason).toMatch(/commission is not a non-negative integer/);
      reconcileMissingSettlements(ctx.db);
      expect(lifecycleRow(handId)?.status).toBe('quarantined');
      ctx.db.prepare('DELETE FROM transcripts WHERE hand_id = ?').run(handId);
    }
  }, 40000);

  it('v8/项7: a consistent marker overrides a stale running/quarantined/legacy/aborted row', async () => {
    for (const stale of ['running', 'prepared', 'quarantined', 'legacy', 'aborted'] as const) {
      const { host, room } = await playOneHand([`m7${stale[0]}`, `n7${stale[0]}`]);
      const handId = host.handEnd!.handId;
      // The hand actually settled (marker present); force a stale lifecycle row.
      ctx.db
        .prepare(
          `INSERT INTO hand_lifecycle (hand_id, room_id, status, created_at, updated_at, resolved_at)
           VALUES (?, ?, ?, 1, 1, NULL)
           ON CONFLICT(hand_id) DO UPDATE SET status = excluded.status, resolved_at = NULL`,
        )
        .run(handId, room.id, stale);
      expect(firstPendingHandLifecycle(ctx.db, room.id)).toBe(
        stale === 'legacy' || stale === 'aborted' ? null : handId,
      );
      reconcileMissingSettlements(ctx.db);
      expect(lifecycleRow(handId)?.status).toBe('committed');
      expect(firstPendingHandLifecycle(ctx.db, room.id)).toBeNull();
      ctx.db.prepare('DELETE FROM transcripts WHERE hand_id = ?').run(handId);
    }
  }, 40000);

  it('v8/项7: a marker that disagrees with the transcript is quarantined, not trusted', async () => {
    const { host, room } = await playOneHand(['m7x', 'n7x']);
    const handId = host.handEnd!.handId;
    ctx.db.prepare('UPDATE hand_settlements SET head = ? WHERE hand_id = ?').run('wrong', handId);
    const audit = auditMarkerlessTranscripts(ctx.db);
    expect(audit.markerConflicts).toHaveLength(1);
    expect(audit.markerConflicts[0]!.reason).toMatch(/marker disagrees/);
    reconcileMissingSettlements(ctx.db);
    expect(lifecycleRow(handId)?.status).toBe('quarantined');
    expect(firstPendingHandLifecycle(ctx.db, room.id)).toBe(handId);
  }, 25000);

  it('P0-3: the real app.close() path drains a live hand before it resolves and terminates the sockets', async () => {
    const dir = mkdtempSync(join(tmpdir(), '4am-close-'));
    const dbPath = join(dir, 'game.db');
    const saved = { ctx, baseUrl, hub };
    const app = createApp(dbPath);
    const appHub = attachHub(app.app, app.db, {
      cryptoTimeoutMs: 1500,
      actionTimeoutMs: 1500,
      autoDealMs: 3_600_000,
      readyCheckMs: 1500,
      shutdownDrainMs: 100,
      clock,
    });
    await app.app.listen({ port: 0 });
    const addr = app.app.server.address() as AddressInfo;
    ctx = app;
    hub = appHub;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    try {
      const { players, room, host } = await setupRoom(['dca', 'dcb'], ['passive', 'passive']);
      players[1]!.respondShares = false; // a stuck hand the drain must abort
      host.send({ t: 'start_hand' });
      await host.waitFor(() => host.handId !== null, 5000);
      const handId = host.handId!;

      // The REAL deployment path: close the Fastify app with the websockets
      // still open. Its preClose hook must drain the rooms and only then let
      // the server close.
      await app.app.close();

      const probe = new Database(dbPath, { readonly: true });
      const row = probe
        .prepare('SELECT status FROM hand_lifecycle WHERE hand_id = ?')
        .get(handId) as { status: string } | undefined;
      probe.close();
      expect(row?.status).toBe('aborted');
      // The sockets were terminated as part of the same close.
      await host.waitFor(() => players[0]!.ws.readyState === WebSocket.CLOSED, 3000);
      expect(players[0]!.ws.readyState).toBe(WebSocket.CLOSED);

      // Restart: the room is not frozen and can deal again.
      const restarted = createApp(dbPath);
      expect(firstPendingHandLifecycle(restarted.db, room.id)).toBeNull();
      const nextHub = attachHub(restarted.app, restarted.db, {
        cryptoTimeoutMs: 1500,
        actionTimeoutMs: 1500,
        autoDealMs: 3_600_000,
        readyCheckMs: 1500,
        shutdownDrainMs: 100,
        clock,
      });
      await restarted.app.listen({ port: 0 });
      const addr2 = restarted.app.server.address() as AddressInfo;
      ctx = restarted;
      hub = nextHub;
      baseUrl = `http://127.0.0.1:${addr2.port}`;
      players[1]!.respondShares = true;
      for (const p of players) {
        p.baseUrl = baseUrl;
        await p.connect(room.id);
      }
      host.send({ t: 'start_hand' });
      await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 15000)));
      expect(players[0]!.handAbort).toBeNull();
      for (const p of players) p.close();
      await restarted.app.close();
    } finally {
      ctx = saved.ctx;
      baseUrl = saved.baseUrl;
      hub = saved.hub;
    }
  }, 60000);
});

describe('7-2 bounty transfer error classification', () => {
  const setupSevenDeuceHand = async () => {
    const { players, room, host } = await setupRoom(['tca', 'tcb'], ['fold-first', 'passive']);
    ctx.db
      .prepare('UPDATE rooms SET auto_deal = 0, seven_deuce_bonus = 25 WHERE id = ?')
      .run(room.id);
    // Seat 1 (bob) is dealt 7-2 offsuit; the host folds, so bob wins by fold.
    const identity = Array.from({ length: 52 }, (_, i) => i);
    const wanted = [9, 0, 10, 21, 11, 12, 13, 14, 15];
    const seen = new Set(wanted);
    const Q = [...wanted, ...identity.filter((i) => !seen.has(i))];
    host.forcedShufflePerm = identity;
    players[1]!.forcedShufflePerm = Q;
    host.send({ t: 'start_hand' });
    await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, 15000)));
    return { players, room, host, bob: players[1]!, gameRoom: hub.rooms.get(room.id)! };
  };

  it('P1-4: a real transient SQLITE_BUSY is retryable and never locks the room', async () => {
    const { host, bob, gameRoom } = await setupSevenDeuceHand();
    fault.sevenDeuceError = Object.assign(new Error('database is locked'), {
      code: 'SQLITE_BUSY',
    });
    bob.showCards();
    await new Promise((r) => setTimeout(r, 200));
    expect(gameRoom.isUnhealthy()).toBe(false);
    expect(host.cardsShown).toHaveLength(0);
    bob.showCards();
    await host.waitFor(() => host.cardsShown.length === 1, 3000);
    expect(host.cardsShown).toHaveLength(1);
    expect(gameRoom.isUnhealthy()).toBe(false);
  }, 20000);

  it('P1-4: an extended SQLITE_IOERR_READ is a programming/environmental error, not retryable', async () => {
    const { host, bob, gameRoom } = await setupSevenDeuceHand();
    fault.sevenDeuceError = Object.assign(new Error('disk I/O error'), {
      code: 'SQLITE_IOERR_READ',
    });
    bob.showCards();
    await host.waitFor(() => gameRoom.isUnhealthy(), 3000);
    // Not clearable: it is not a recoverable settlement mark.
    expect(gameRoom.clearUnhealthy('anything')).toBe(false);
  }, 20000);

  it('P1-4: SQLITE_FULL/SQLITE_NOMEM/SQLITE_PROTOCOL are not treated as retryable', async () => {
    const { host, bob, gameRoom } = await setupSevenDeuceHand();
    fault.sevenDeuceError = Object.assign(new Error('database or disk is full'), {
      code: 'SQLITE_FULL',
    });
    bob.showCards();
    await host.waitFor(() => gameRoom.isUnhealthy(), 3000);
  }, 20000);
});
