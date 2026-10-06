import WebSocket from 'ws';
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
import { activeHands } from '../../src/liveHands.js';

/**
 * A scripted WebSocket test client for the server suite, extracted verbatim
 * from `integration.test.ts` (the `TestClient` class, lines 41-676). It
 * registers over HTTP, opens the game socket, answers every crypto/decision
 * frame the way a real client does, records the frames it receives, and offers
 * `waitFor`/`waitIdle` to synchronise a test against server state.
 *
 * Usage: boot a server (e.g. `bootIntegrationServer`) and construct clients
 * with its `baseUrl`. The test remains responsible for closing them on teardown.
 */

/** How the client answers a betting turn: fold, shove when possible, or call/check. */
export type Strategy = 'passive' | 'fold-first' | 'allin-first' | 'shove-flop';

export class TestClient {
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
  /** The automatic 7-2 bounty frame, or null when it was never delivered (e.g.
   *  a lost-notification fault at `broadcast_before_seven_deuce`). */
  sevenDeuceResult: Extract<ServerMsg, { t: 'seven_deuce' }> | null = null;
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
  /** Target-side terminal receipts (`peek_offer_closed`), with the raw frame so
   *  tests can assert it carries no buyer-only payload. */
  peekClosures: {
    offerId: string;
    handId: string;
    targetSeat: number;
    status: string;
    raw: Record<string, unknown>;
  }[] = [];
  /** Reconnect-safe incoming-offer snapshots. The client reconciles its
   *  pending banners against the latest one: keep listed ids, drop the rest. */
  peekSnapshots: { incomingOfferIds: string[]; raw: Record<string, unknown> }[] = [];
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
  /** Durable `hand_recovery` answers for a hand this client still holds. */
  handRecoveries: { handId: string; status: string }[] = [];
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
        this.send({
          t: 'join_room',
          roomId,
          // Like the real client: tell the server which hand we still hold so a
          // post-restart reconnect can be answered from durable lifecycle data.
          ...(this.handId ? { resumeHandId: this.handId } : {}),
        });
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
      case 'seven_deuce': {
        this.sevenDeuceResult = msg;
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
      case 'peek_offer_closed': {
        this.peekClosures.push({
          offerId: msg.offerId,
          handId: msg.handId,
          targetSeat: msg.targetSeat,
          status: msg.status,
          raw: msg as unknown as Record<string, unknown>,
        });
        break;
      }
      case 'peek_offers_snapshot': {
        this.peekSnapshots.push({
          incomingOfferIds: msg.incomingOfferIds,
          raw: msg as unknown as Record<string, unknown>,
        });
        // Mirror the real client: the snapshot is authoritative for which
        // incoming offers are still open; drop every other pending banner.
        const live = new Set(msg.incomingOfferIds);
        this.peekOffers = this.peekOffers.filter((o) => live.has(o.offerId));
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
      case 'hand_recovery': {
        this.handRecoveries.push({ handId: msg.handId, status: msg.status });
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
