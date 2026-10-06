import WebSocket from 'ws';
import { scrypt } from '@noble/hashes/scrypt';
import { bytesToHex } from '@noble/hashes/utils';
import {
  cardLookup,
  handKeyCommit,
  identityFromSeed,
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
import {
  HAND_CATEGORY_NAMES,
  cardName,
  describeScore,
  evaluate7,
  handCategory,
  legalActions,
  type BettingState,
  type CardId,
  type PlayerAction,
  type ServerMsg,
} from '@4am/shared';
import type { PublicAction } from './decisionView.js';

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, dkLen: 32 } as const;
const lookup = cardLookup();

/** A `connect()` awaiting its socket, tracked so it can always be settled. */
interface PendingConnect {
  ws: WebSocket;
  resolve: () => void;
  reject: (err: unknown) => void;
  settled: boolean;
}

export interface RoomView {
  id: string;
  name: string;
  joinCode: string;
  hostId: number;
  bankerId: number;
  coBankerId: number | null;
  sb: number;
  bb: number;
  minSettleHands: number;
  sevenDeuceBonus: number;
}

interface RoomPlayer {
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

/**
 * A full headless 4AM Casino player: it performs every mental-poker duty
 * (key commits, shuffles, DLEQ unmask shares, reveals) automatically, and
 * leaves only the poker decisions to the caller.
 */
export class HeadlessClient {
  token = '';
  userId = 0;
  private identity!: { publicKey: string; secretKey: string };
  private ws: WebSocket | null = null;
  private roomId: string | null = null;
  private closedByUs = false;
  /** Handle for the automatic reconnect after a dropped socket, so it can be cancelled. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Every `connect()` awaiting an open, so close/supersede can settle it. */
  private readonly pendingConnects = new Set<PendingConnect>();
  /**
   * The hand id whose context this connection epoch is syncing. Reset on a
   * resync/close and set only by the replayed `hand_start`; every other context
   * frame must match it, so a stale previous-hand frame cannot open the gate.
   * Setting it is NOT itself a sync signal: `hand_start` only establishes the
   * identity, and the gate opens on a later phase/terminal frame.
   */
  private resyncHandId: string | null = null;

  room: { room: RoomView; players: RoomPlayer[]; handActive: boolean } | null = null;
  handId: string | null = null;
  seats: { seat: number; userId: number; username: string }[] = [];
  myCards: CardId[] = [];
  myCardPoints: { deckIndex: number; point: string }[] = [];
  /**
   * The hand `myCardPoints` belong to. A peek is answered against the ended
   * hand's key, so the points must be bound to that same hand id - a stale
   * offer for an older hand must never be answered with a newer hand's points.
   */
  myCardPointsHandId: string | null = null;
  board: CardId[] = [];
  betting: BettingState | null = null;
  actionSeq = -1;
  private lastActedSeq = -2;
  deadline: number | null = null;
  /**
   * True when this client observed the CURRENT hand from its first frame with no
   * gap. It is cleared when the socket drops mid-hand (the reconnect misses the
   * frames sent while down) or when the client joins a hand already in progress,
   * and restored for the next hand it observes from the start. A policy must not
   * read a gap as "the opponent did not enter the pot".
   */
  historyComplete = true;
  /** False while the socket is down; a decision must not be sent then. */
  connected = false;
  /**
   * Increments on every socket (re)open. A decision that was computed before a
   * reconnect can be told apart from the resynced state even when the hand and
   * action sequence happen to repeat.
   */
  connectionEpoch = 0;
  /**
   * The connection epoch whose `room_state` snapshot has been applied. It is
   * advanced to `connectionEpoch` when that epoch's `room_state` lands and reset
   * to 0 on socket close, so `isResynced` is false in the window between a
   * (re)open (`connected = true`) and the resync snapshot actually arriving.
   */
  roomStateEpoch = 0;
  /**
   * The connection epoch whose live-hand context has been authoritatively
   * synced. When the resync `room_state` reports a live hand the gate is closed
   * (`= 0`) until the server replays a frame that proves the hand's current
   * phase/result. The replayed `hand_start` only establishes the hand IDENTITY,
   * not completeness, so it must not open the gate on its own - in a settlement
   * hold the board, the private cards and the `showdown` still follow. The gate
   * opens on a phase/terminal frame: a crypto request frame, a `betting_state`,
   * a `showdown`, or a `hand_end`/`hand_abort`. Pure content replay
   * (`your_card`/`board_open`) refreshes visible state but does not open it
   * either. The room snapshot alone never proves the cached turn.
   */
  handContextEpoch = 0;
  result: Extract<ServerMsg, { t: 'hand_end' }> | null = null;
  showdown: Extract<ServerMsg, { t: 'showdown' }> | null = null;
  abort: Extract<ServerMsg, { t: 'hand_abort' }> | null = null;
  peekOffers: { offerId: string; handId: string; fromName: string; amount: number }[] = [];
  events: string[] = [];
  /**
   * Public actions observed since this hand was dealt, accumulated from
   * `action_applied` frames. Not a complete history across a reconnect: the
   * server does not replay past frames, so a client that reconnects mid-hand
   * only sees actions from that point on.
   */
  actionHistory: PublicAction[] = [];
  /**
   * Fallback ordinal for `action_applied` frames from a server that does not yet
   * send the authoritative `actionSeq`. It is a purely local count and can drift
   * after a reconnect/missed frame; `PublicAction.actionSeq` uses the server's
   * value whenever present.
   */
  private localActionOrdinal = 0;
  private handKeys = new Map<string, bigint>();
  private waiters = new Set<() => void>();
  private endedHands = new Set<string>();
  /** A gap occurred since the last hand boundary (drop or mid-hand join). */
  private missedFrames = false;
  /** True between a socket open and the first `room_state` of that session. */
  private reconnected = false;

  constructor(
    private baseUrl: string,
    private username: string,
    private password: string,
  ) {}

  /** Load a room-scoped credential without sharing the account password. */
  async loginWithGrant(token: string, signingSeed?: string): Promise<void> {
    this.token = token;
    const info = (await this.api('/api/agent/identity')) as {
      userId: number;
      username: string;
      publicKey: string;
      scopeKind: string;
      scopeId: string;
      canPlay: boolean;
    };
    this.userId = info.userId;
    this.username = info.username;
    if (info.scopeKind !== 'room') throw new Error('This token is not scoped to a room.');
    if (!info.canPlay)
      throw new Error('This token is read-only. Use room_details and subscribe_events instead.');
    if (!signingSeed || !/^[a-f0-9]{64}$/.test(signingSeed))
      throw new Error(
        'A room player needs FOURAM_SIGNING_KEY from the owner’s local agent configuration.',
      );
    this.identity = identityFromSeed(
      Uint8Array.from(signingSeed.match(/../g)!, (byte) => parseInt(byte, 16)),
    );
    if (this.identity.publicKey !== info.publicKey)
      throw new Error('Signing key does not match this account. Export a fresh configuration.');
    await this.connect(info.scopeId);
  }

  // ---------- auth ----------

  private derive(): { authKey: string; identity: { publicKey: string; secretKey: string } } {
    const authKey = bytesToHex(scrypt(this.password, `4am/auth/${this.username}`, SCRYPT));
    const identity = identityFromSeed(scrypt(this.password, `4am/id/${this.username}`, SCRYPT));
    return { authKey, identity };
  }

  async login(registerIfMissing = true): Promise<void> {
    const { authKey, identity } = this.derive();
    this.identity = identity;
    let res = await fetch(`${this.baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: this.username, authKey }),
    });
    if (res.status === 401 && registerIfMissing) {
      res = await fetch(`${this.baseUrl}/api/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: this.username, authKey, publicKey: identity.publicKey }),
      });
    }
    if (!res.ok)
      throw new Error(
        `login failed: ${((await res.json()) as { error?: string }).error ?? res.status}`,
      );
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
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(json.error ?? `HTTP ${res.status}`));
    return json;
  }

  // ---------- room lifecycle ----------

  async joinByCode(joinCode: string): Promise<string> {
    const room = await this.api('/api/rooms/join', { joinCode });
    await this.connect(room.id as string);
    return room.id as string;
  }

  async connect(roomId: string): Promise<void> {
    // An explicit connect wins over any auto-reconnect that a previous drop
    // already scheduled: cancel it so it cannot open a second, redundant socket.
    this.cancelReconnect();
    this.roomId = roomId;
    this.closedByUs = false;
    await this.openSocket();
  }

  /** Cancel a pending automatic reconnect (explicit close/connect, or a fresh open). */
  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Resolve every `connect()` still awaiting a socket (or just the ones bound to
   * `ws` when superseding a specific socket), so a cancelled/superseded connect
   * can never hang forever.
   */
  private settlePendingConnects(ws: WebSocket | null): void {
    for (const pending of [...this.pendingConnects]) {
      if (pending.settled) continue;
      if (ws !== null && pending.ws !== ws) continue;
      pending.settled = true;
      this.pendingConnects.delete(pending);
      pending.resolve();
    }
  }

  private openSocket(): Promise<void> {
    // Opening a socket supersedes any pending auto-reconnect...
    this.cancelReconnect();
    // ...and any previous socket, which must be closed rather than orphaned.
    const previous = this.ws;
    if (previous) {
      this.ws = null;
      try {
        previous.close();
      } catch {
        // already gone
      }
      // A `connect()` still waiting on the superseded socket must settle.
      this.settlePendingConnects(previous);
      this.connected = false;
      this.roomStateEpoch = 0;
      this.handContextEpoch = 0;
      this.resyncHandId = null;
    }
    return new Promise((resolve, reject) => {
      const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/ws';
      const ws = new WebSocket(wsUrl, ['bearer', this.token]);
      this.ws = ws;
      const pending: PendingConnect = { ws, resolve, reject, settled: false };
      this.pendingConnects.add(pending);
      const settle = (fn: () => void): void => {
        if (pending.settled) return;
        pending.settled = true;
        this.pendingConnects.delete(pending);
        fn();
      };
      ws.on('open', () => {
        // A socket superseded before it opened (a rapid close->connect handoff)
        // must not bump the epoch or join with the old connection. Drop it, but
        // settle this caller so a pending `connect()` never hangs.
        if (this.ws !== ws) {
          try {
            ws.close();
          } catch {
            // already gone
          }
          settle(resolve);
          return;
        }
        this.onSocketOpened();
        this.send({ t: 'join_room', roomId: this.roomId });
        settle(resolve);
      });
      ws.on('message', (raw) => {
        // A superseded socket can still deliver buffered frames. They belong to
        // the previous generation and must not pollute the new epoch's state.
        if (this.ws !== ws) return;
        try {
          this.handle(JSON.parse(String(raw)) as ServerMsg);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`[${this.username}] handler error on ${String(raw).slice(0, 60)}:`, err);
        }
      });
      ws.on('error', (err) => {
        if (this.ws !== ws) {
          // A stale socket's error must not fail the live connect.
          settle(resolve);
          return;
        }
        settle(() => reject(err));
      });
      ws.on('close', (code) => {
        // Only the CURRENT socket may clear connection state or arm a reconnect.
        // A stale close firing after the new socket opened would otherwise tear
        // down the live connection (`connected=false`, epochs reset, re-connect).
        if (this.ws !== ws) {
          settle(resolve);
          return;
        }
        this.ws = null;
        this.connected = false;
        // No snapshot is current while down: force `isResynced` false until the
        // next open's `room_state` (and, for a live hand, its `betting_state`)
        // advances both epochs again.
        this.roomStateEpoch = 0;
        this.handContextEpoch = 0;
        this.resyncHandId = null;
        if (code === 1008) this.closedByUs = true;
        if (!this.closedByUs) this.markDisconnected();
        // Never leave a `connect()` pending on a socket that has closed.
        settle(resolve);
        if (!this.closedByUs && this.roomId) {
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.closedByUs) void this.openSocket().catch(() => {});
          }, 1500);
        }
      });
    });
  }

  close(): void {
    this.closedByUs = true;
    this.cancelReconnect();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        // already gone
      }
    }
    // Invalidate the connection immediately: the old socket's `close` event is
    // ignored (its identity no longer matches), so without this a runner could
    // still see `connected && isResynced` and consult/send into a dead socket
    // in the window before the next socket opens.
    this.connected = false;
    this.roomStateEpoch = 0;
    this.handContextEpoch = 0;
    this.resyncHandId = null;
    // Settle any `connect()` still awaiting a socket we just abandoned.
    this.settlePendingConnects(null);
  }

  /** A gap began: every frame sent while down is lost for the current hand. */
  private markDisconnected(): void {
    this.missedFrames = true;
    if (this.handLive()) this.historyComplete = false;
  }

  /**
   * Drop the cached in-progress hand snapshot. Used when a resync `room_state`
   * reports no live hand: without it a missed `hand_end` would leave the old
   * `handId`/`betting`/`actionSeq` in place and `myTurn()` could license an
   * action into a hand the server has already settled. `result`/`abort` are
   * deliberately left alone (they are terminal and may still need recording).
   */
  private clearStaleHand(): void {
    this.handId = null;
    this.seats = [];
    this.myCards = [];
    this.myCardPoints = [];
    this.myCardPointsHandId = null;
    this.board = [];
    this.betting = null;
    this.actionSeq = -1;
    this.lastActedSeq = -2;
    this.deadline = null;
    this.peekOffers = [];
    this.actionHistory = [];
    this.localActionOrdinal = 0;
    this.resyncHandId = null;
  }

  /**
   * Mark this connection epoch's hand context as synced, but only from a frame
   * that proves the hand's CURRENT phase/result: a phase marker (a crypto
   * shuffle/share request or a `betting_state`), a settlement reveal
   * (`showdown`), or a terminal `hand_end`/`hand_abort`. Callers MUST NOT invoke
   * this for the bare `hand_start` (it only establishes the hand identity) nor
   * for pure content replay (`your_card`/`board_open`): receiving part of a
   * reconnect replay is not proof that the hand's authoritative state is
   * complete, so it must never open the decision gate early. In the server's
   * `Hand.resendPending` ordering the content (private cards, board) is replayed
   * BEFORE the phase/terminal frame, so opening on the latter still guarantees
   * the former was applied.
   *
   * It deliberately does NOT rebuild `betting`: a non-betting phase frame proves
   * the context is fresh but leaves the table undecidable, so only a real
   * `betting_state` restores `betting`.
   */
  /**
   * Whether a hand-specific frame belongs to the hand this epoch is resyncing.
   * Callers MUST check this BEFORE mutating any hand state: a stale frame from a
   * previous hand (or one arriving before the resync `hand_start`) must be
   * ignored whole - it may neither open the gate nor poison `betting`/`board`/
   * `result`/`abort`. `hand_start` is the sole exception (it establishes the id).
   */
  private isCurrentHandFrame(handId: string): boolean {
    return this.resyncHandId !== null && handId === this.resyncHandId;
  }

  /**
   * Whether a frame refers to the hand the client most recently finished (the
   * target of `peek_offer`/`peek_result`/`cards_shown`/`seven_deuce`). Peeks are
   * always about a just-ended hand, so this is deliberately NOT the live
   * `resyncHandId`: it accepts the hand id the client still holds (kept after
   * `hand_end`) or one it has already seen settle (`endedHands`).
   */
  private isRecentEndedHand(handId: string): boolean {
    return handId === this.handId || this.endedHands.has(handId);
  }

  private markHandContextSynced(handId?: string): void {
    // Ignore a frame that predates this epoch's resync `room_state` (for
    // example one still buffered on a superseded socket): it must not open the
    // gate before the new connection's snapshot has been applied.
    if (this.roomStateEpoch !== this.connectionEpoch) return;
    // Every context frame except a `hand_start` (which establishes the hand) must
    // belong to the hand this epoch is resyncing, so a stale previous-hand frame
    // cannot open the gate.
    if (handId !== undefined && handId !== this.resyncHandId) return;
    this.handContextEpoch = this.connectionEpoch;
  }

  /** A socket (re)opened: a new connection epoch, awaiting a fresh room_state. */
  private onSocketOpened(): void {
    this.connected = true;
    this.connectionEpoch++;
    // The first room_state after an open tells us whether we rejoined a live
    // hand (gap) or a fresh table.
    this.reconnected = true;
  }

  send(obj: unknown): void {
    this.ws?.send(JSON.stringify(obj));
  }

  private signed(handId: string, t: string, body: unknown): string {
    return signContent(this.identity.secretKey, handId, t, body);
  }

  private keyFor(handId: string): bigint {
    let k = this.handKeys.get(handId);
    if (!k) {
      k = randScalar();
      this.handKeys.set(handId, k);
    }
    return k;
  }

  // ---------- game protocol (all crypto automatic) ----------

  private handle(msg: ServerMsg): void {
    if (process.env.FOURAM_DEBUG) {
      // eslint-disable-next-line no-console
      console.error(
        `${Date.now() % 100000} [${this.username}] <- ${msg.t}${'deckIndex' in msg ? ` idx=${(msg as { deckIndex?: number }).deckIndex}` : ''}`,
      );
    }
    switch (msg.t) {
      case 'room_state':
        this.room = {
          room: msg.room as RoomView,
          players: msg.players,
          handActive: msg.handActive,
        };
        if (!msg.handActive) {
          // No live hand on the server: there is no current hand identity, and
          // any stale in-progress hand snapshot must be dropped. This runs for
          // EVERY such snapshot - including a routine broadcast after settlement
          // (not only the first one after a reconnect) - so the state self-heals
          // without needing a reconnect. A terminal `result`/`abort` already
          // observed is kept so the runner can still record session memory.
          if (this.handLive()) this.clearStaleHand();
          this.resyncHandId = null;
          this.handContextEpoch = this.connectionEpoch;
        } else if (this.reconnected) {
          // A live hand is only fully resynced once the server's `resendPending`
          // replays a phase/terminal frame for this hand (a `shuffle_turn`/`need_share`
          // during crypto, a `betting_state` while betting, or a terminal
          // `showdown`/`hand_end`/`hand_abort`). The replayed `hand_start` only
          // (re)establishes the hand identity, and replayed private/board content
          // alone does not open the gate.
          // Clear the cached turn snapshot NOW so the stale `betting` can never
          // render `myTurn()` true while the gate is closed.
          this.betting = null;
          this.deadline = null;
          this.handContextEpoch = 0;
          // The replayed `hand_start` must (re)establish the hand context;
          // until then no other hand's frame may open the gate.
          this.resyncHandId = null;
        }
        if (this.reconnected) {
          // Only the first room_state after a socket open decides whether this
          // session began on a live hand (gap) or between hands (fresh start).
          // Later room_state frames (a mid-hand join/leave, buy, sit) are routine
          // broadcasts and must NOT re-close the decision gate.
          this.reconnected = false;
          this.missedFrames = msg.handActive;
          if (msg.handActive) this.historyComplete = false;
        }
        // This connection epoch's room snapshot has arrived.
        this.roomStateEpoch = this.connectionEpoch;
        break;
      case 'hand_start': {
        // The hand's opening context. This is the ONE frame allowed to establish
        // the hand identity, but it deliberately does NOT open the resync gate:
        // it carries no proof that the server has finished replaying this hand's
        // authoritative state (in a settlement hold the board, the private cards
        // and the `showdown` still follow). The gate opens on the next
        // phase/terminal frame this hand replays.
        this.resyncHandId = msg.handId;
        if (this.handId !== msg.handId) {
          this.handId = msg.handId;
          this.seats = msg.seats;
          this.myCards = [];
          this.myCardPoints = [];
          this.myCardPointsHandId = null;
          this.board = [];
          this.betting = null;
          this.actionSeq = -1;
          this.lastActedSeq = -2;
          this.result = null;
          this.showdown = null;
          this.abort = null;
          this.peekOffers = [];
          this.actionHistory = [];
          this.localActionOrdinal = 0;
          // A hand we see start for the first time is complete only when we did
          // not just miss frames (a live rejoin would have arrived here with the
          // same handId, guarded above, and room_state already flagged it).
          this.historyComplete = !this.missedFrames;
          this.endedHands.clear();
          for (const key of this.handKeys.keys()) if (key !== msg.handId) this.handKeys.delete(key);
          this.log(`hand ${msg.handId.slice(0, 6)} dealt (blinds ${msg.sb}/${msg.bb})`);
        }
        if (!this.identity || !msg.seats.some((s) => s.userId === this.userId)) break;
        const commit = pointHex(handKeyCommit(this.keyFor(msg.handId)));
        this.send({
          t: 'key_commit',
          handId: msg.handId,
          commit,
          sig: this.signed(msg.handId, 'key_commit', { commit }),
        });
        break;
      }
      case 'shuffle_turn': {
        if (!this.isCurrentHandFrame(msg.handId)) break;
        this.markHandContextSynced(msg.handId);
        if (!this.identity || this.handId !== msg.handId || this.mySeat() !== msg.seat) break;
        const deck = maskAndShuffle(
          msg.deck.map(pointFromHex),
          this.keyFor(msg.handId),
          randomPerm(52),
        ).map(pointHex);
        this.send({
          t: 'shuffle_deck',
          handId: msg.handId,
          deck,
          sig: this.signed(msg.handId, 'shuffle_deck', { deck }),
        });
        break;
      }
      case 'need_share': {
        if (!this.isCurrentHandFrame(msg.handId)) break;
        this.markHandContextSynced(msg.handId);
        if (!this.identity || msg.handId !== this.handId || !this.handKeys.has(msg.handId)) break;
        const mine = this.mySeat();
        if (
          msg.purpose !== 'showdown' &&
          (msg.forSeat === mine || this.myCardPoints.some((c) => c.deckIndex === msg.deckIndex))
        ) {
          this.log('Refused an unmask request for my private card.');
          break;
        }
        const { out, proof } = proveUnmask(this.keyFor(msg.handId), pointFromHex(msg.point));
        const body = { deckIndex: msg.deckIndex, out: pointHex(out), proof };
        this.send({
          t: 'unmask_share',
          handId: msg.handId,
          ...body,
          sig: this.signed(msg.handId, 'unmask_share', body),
        });
        break;
      }
      case 'your_card': {
        if (!this.isCurrentHandFrame(msg.handId)) break;
        // Content replay, not a phase marker: it refreshes my private card but
        // does not prove the hand's replay is complete, so it must NOT open the
        // resync gate.
        if (!this.identity || msg.handId !== this.handId || !this.handKeys.has(msg.handId)) break;
        if (this.myCardPoints.some((c) => c.deckIndex === msg.deckIndex)) break;
        const plain = mulPoint(pointFromHex(msg.point), invScalar(this.keyFor(msg.handId)));
        const card = recoverCard(plain, lookup);
        if (card !== null) {
          this.myCards.push(card);
          this.myCardPoints.push({ deckIndex: msg.deckIndex, point: msg.point });
          this.myCardPointsHandId = msg.handId;
        }
        break;
      }
      case 'board_open':
        if (!this.isCurrentHandFrame(msg.handId)) break;
        // Content replay, not a phase marker: it refreshes the board but does
        // not prove the hand's replay is complete, so it must NOT open the
        // resync gate. (The phase/terminal frame that follows it does.)
        // run-2 cards belong to the second runout, never to the main board
        if (msg.run !== 2 && !this.board.includes(msg.card)) this.board.push(msg.card);
        break;
      case 'betting_state':
        // Validate identity BEFORE writing any cached state, else a stale
        // previous-hand snapshot would poison `betting`/`actionSeq`/`board`.
        if (!this.isCurrentHandFrame(msg.handId)) break;
        this.betting = msg.state;
        // `betting_state.actionSeq` is a required protocol field (not an
        // optional add-on): every server release sends it, so `actionSeq` is
        // always a number and `lastActedSeq = actionSeq` in `act()` can never
        // become `undefined` against an older server.
        this.actionSeq = msg.actionSeq;
        this.board = msg.board;
        this.deadline = msg.deadline;
        // The only frame that rebuilds a decidable `betting`: the reconnect
        // barrier is satisfied AND the turn snapshot is authoritative.
        this.markHandContextSynced(msg.handId);
        break;
      case 'action_applied': {
        if (!this.isCurrentHandFrame(msg.handId)) break;
        this.actionHistory.push({
          // Prefer the server's authoritative index; fall back to a local
          // ordinal only for a server that predates it (rolling deploy). The
          // local fallback drifts across a reconnect/missed frame, which is
          // exactly why the authoritative field exists. Protocol boundary: this
          // is the ONLY optional `actionSeq`; `betting_state.actionSeq` is
          // required and always sent, so a new client stays safe with an old
          // server (the turn gate never depends on this fallback).
          actionSeq: msg.actionSeq ?? this.localActionOrdinal++,
          street: this.betting?.street ?? 'preflop',
          seat: msg.seat,
          action: msg.action,
          auto: msg.auto === true,
          ts: Date.now(),
        });
        this.log(
          `${this.nameOf(msg.seat)} ${msg.action.type}${msg.action.amount ? ` ${msg.action.amount}` : ''}${msg.auto ? ' (timed out)' : ''}`,
        );
        // escrow my key on fold so my exit never strands the hand
        if (
          msg.action.type === 'fold' &&
          this.handId === msg.handId &&
          msg.seat === this.mySeat()
        ) {
          const key = this.keyFor(msg.handId).toString(16);
          this.send({
            t: 'fold_key',
            handId: msg.handId,
            key,
            sig: this.signed(msg.handId, 'fold_key', { key }),
          });
        }
        break;
      }
      case 'showdown':
        if (!this.isCurrentHandFrame(msg.handId)) break;
        this.markHandContextSynced(msg.handId);
        this.showdown = msg;
        for (const r of msg.reveals) {
          this.log(
            `${this.nameOf(r.seat)} shows ${r.cards.map(cardName).join(' ')} (${HAND_CATEGORY_NAMES[handCategory(r.score)]})`,
          );
        }
        break;
      case 'hand_end': {
        if (!this.isCurrentHandFrame(msg.handId)) break;
        this.result = msg;
        // The hand is over: the betting snapshot is invalid (a reconnect that
        // only ever sees the terminal frame must not stay frozen), but the hand
        // id/result are kept so the runner can still record session memory.
        this.betting = null;
        this.deadline = null;
        this.markHandContextSynced(msg.handId);
        // We observed the hand boundary while connected: the next hand starts
        // fresh, so a gap from earlier in THIS hand no longer applies.
        this.missedFrames = false;
        const winners = msg.deltas
          .filter((d) => d.delta > 0)
          .map((d) => `${this.nameOf(d.seat)} +${d.delta}`);
        this.log(`hand over: ${winners.join(', ') || 'no chips moved'}`);
        break;
      }
      case 'hand_abort':
        if (!this.isCurrentHandFrame(msg.handId)) break;
        this.abort = msg;
        // Terminal frame: clear the invalid betting context but keep the hand id
        // so the runner's `recordHandEnd` can still fold it into memory.
        this.betting = null;
        this.deadline = null;
        this.markHandContextSynced(msg.handId);
        this.missedFrames = false;
        this.endedHands.add(msg.handId);
        this.log(`hand aborted: ${msg.reason}`);
        break;
      case 'multi_run_offer': {
        // A non-betting context frame: proves the multirun stage is synced but
        // leaves the table undecidable (only `betting_state` rebuilds betting).
        if (!this.isCurrentHandFrame(msg.handId)) break;
        this.markHandContextSynced(msg.handId);
        // Only the seat the server is actually waiting on may answer, and only
        // while the hand is still live (a terminal frame must never be answered).
        const seat = this.mySeat();
        if (!this.identity || seat === null || !this.handLive()) break;
        if (msg.stage === 'choice' && msg.behindSeat === seat) {
          // The behind player is the equity underdog: running the board more
          // than once is the variance-reducing choice. We ask for 2, not 3 - one
          // extra runout already halves the all-in variance, while 3 needs
          // 2*3+5 undealt cards (closer to the engine's deck-capacity fallback)
          // and the offer does not expose the server's maxRuns, so 2 is the safe
          // multi-run that a default `maxRuns >= 2` always accepts.
          this.send({
            t: 'run_count_choice',
            handId: msg.handId,
            decisionId: msg.decisionId,
            count: 2,
            sig: this.signed(msg.handId, 'run_count_choice', {
              decisionId: msg.decisionId,
              count: 2,
            }),
          });
        } else if (msg.stage === 'agreement' && msg.aheadSeat === seat) {
          // The ahead player confirms whatever count the behind player asked for.
          this.send({
            t: 'run_count_agree',
            handId: msg.handId,
            decisionId: msg.decisionId,
            agree: true,
            sig: this.signed(msg.handId, 'run_count_agree', {
              decisionId: msg.decisionId,
              agree: true,
            }),
          });
        }
        break;
      }
      case 'need_keys': {
        if (!this.isCurrentHandFrame(msg.handId)) break;
        this.markHandContextSynced(msg.handId);
        // `need_keys` IS the server-authorised audit signal: a reconnecting client
        // is not replayed the settlement transcript, so `endedHands` may be empty
        // even though we still hold this hand's key. Trust the signal and reply
        // whenever we have a key for the current hand.
        if (!this.identity || !this.handKeys.has(msg.handId)) break;
        const key = this.keyFor(msg.handId).toString(16);
        this.send({
          t: 'reveal_key',
          handId: msg.handId,
          key,
          sig: this.signed(msg.handId, 'reveal_key', { key }),
        });
        break;
      }
      case 'transcript_entry':
        if (
          (msg.type === 'settlement' || msg.type === 'hand_abort') &&
          this.isRecentEndedHand(msg.handId)
        )
          this.endedHands.add(msg.handId);
        break;
      case 'cards_shown':
        if (!this.isRecentEndedHand(msg.handId)) break;
        this.log(`${this.nameOf(msg.seat)} showed ${msg.cards.map(cardName).join(' ')}`);
        break;
      case 'seven_deuce':
        if (!this.isRecentEndedHand(msg.handId)) break;
        this.log(`7-2 offsuit bounty: ${this.nameOf(msg.seat)} collects ${msg.amount}`);
        break;
      case 'peek_offer':
        // A peek is about the just-ended hand, not the live one: drop a stale
        // offer so it can never be answered against a newer hand id.
        if (!this.isRecentEndedHand(msg.handId)) break;
        this.peekOffers.push({
          offerId: msg.offerId,
          handId: msg.handId,
          fromName: msg.fromName,
          amount: msg.amount,
        });
        this.log(
          `${msg.fromName} offers ${msg.amount} chips to privately see your last hand (offerId ${msg.offerId})`,
        );
        // A robot has nothing to hide and the peek is a fixed, trivial 1bb, so
        // it always agrees. It travels the same offer/accept path a human does.
        this.answerPeek(msg.offerId, true);
        break;
      case 'peek_result':
        if (!this.isRecentEndedHand(msg.handId)) break;
        if (msg.status === 'accepted' && msg.cards) {
          this.log(
            `peek accepted: seat ${msg.targetSeat + 1} had ${msg.cards.map(cardName).join(' ')} (only you can see this)`,
          );
        } else {
          this.log('your peek offer was declined');
        }
        break;
      case 'chat':
        this.log(`${msg.from}: ${msg.text}`);
        break;
      case 'error':
        this.log(`server: ${msg.message}`);
        break;
      case 'auto_deal':
        this.log(`next hand deals itself in ${Math.round(msg.inMs / 1000)}s`);
        break;
      case 'ready_check':
        // a robot is always ready for the next hand
        if (this.identity) this.send({ t: 'im_ready' });
        break;
      case 'rit_offer': {
        if (!this.isCurrentHandFrame(msg.handId)) break;
        this.markHandContextSynced(msg.handId);
        // robots always run it twice - more cards, more fun
        const seat = this.mySeat();
        if (seat !== null && msg.voters.includes(seat)) {
          this.send({
            t: 'rit_vote',
            handId: msg.handId,
            yes: true,
            sig: this.signed(msg.handId, 'rit_vote', { yes: true }),
          });
        }
        break;
      }
      default:
        break;
    }
    for (const w of this.waiters) w();
  }

  private log(line: string): void {
    this.events.push(line);
    if (this.events.length > 60) this.events.splice(0, this.events.length - 60);
  }

  // ---------- reads ----------

  mySeat(): number | null {
    return (
      this.seats.find((s) => s.userId === this.userId)?.seat ??
      this.room?.players.find((p) => p.userId === this.userId)?.seat ??
      null
    );
  }

  private nameOf(seat: number): string {
    const userId = this.seats.find((s) => s.seat === seat)?.userId;
    const p = this.room?.players.find((x) => x.userId === userId);
    return (
      p?.displayName ?? this.seats.find((s) => s.seat === seat)?.username ?? `seat ${seat + 1}`
    );
  }

  handLive(): boolean {
    return this.handId !== null && !this.result && !this.abort;
  }

  myTurn(): boolean {
    // The turn gate must not open on a stale snapshot: require a resynced,
    // connected epoch before the cached `betting` is trusted.
    if (!this.connected || !this.isResynced) return false;
    if (!this.handLive() || !this.betting) return false;
    // after acting, wait for the table to advance before acting again -
    // prevents double-sends from a snapshot that has not caught up yet
    if (this.actionSeq === this.lastActedSeq) return false;
    const la = legalActions(this.betting);
    return la !== null && la.seat === this.mySeat();
  }

  /**
   * True only once this connection epoch's resync is complete. An open socket
   * (`connected = true`) does not imply the state is fresh: between a (re)open
   * and the authoritative hand state arriving the cached hand/turn may be stale.
   *
   * A bare `room_state` is not enough when it reports a live hand: the server
   * replays the hand's context (`Hand.resendPending`), and the replayed
   * `hand_start` merely establishes the hand identity - it is NOT proof the
   * replay is complete. The gate opens only on a frame that proves the hand's
   * current phase/result: a crypto/phase request frame, a `betting_state`, a
   * `showdown`, or a terminal `hand_end`/`hand_abort`. Content-only replay
   * (`your_card`/`board_open`) does not open it. This is why the gate cannot be
   * opened by "any frame at all" during a reconnect. When there is no live hand
   * the room snapshot is complete on its own.
   */
  get isResynced(): boolean {
    // `connected` is false before the first open and immediately after close(),
    // so this is also false while there is no usable socket - even though all
    // epochs start (and can briefly stay) at 0.
    return (
      this.connected &&
      this.roomStateEpoch === this.connectionEpoch &&
      this.handContextEpoch === this.connectionEpoch
    );
  }

  /** A compact, human/agent-readable snapshot of everything visible. */
  stateSummary(): string {
    const lines: string[] = [];
    if (!this.room)
      return 'Not in a room yet. Use join_room with a 6-letter code, or my_rooms to list rooms.';
    const r = this.room.room;
    lines.push(
      `Room "${r.name}" (code ${r.joinCode}), blinds ${r.sb}/${r.bb}${r.sevenDeuceBonus ? `, 7-2 bounty ${r.sevenDeuceBonus}` : ''}`,
    );
    const me = this.room.players.find((p) => p.userId === this.userId);
    lines.push(
      `You are ${me?.displayName ?? this.username}${me?.seat !== null && me?.seat !== undefined ? ` in seat ${me.seat + 1}` : ' (no seat yet - use take_seat)'} with ${me?.stack ?? 0} chips.`,
    );
    if (this.userId === r.hostId) lines.push('You are the host (you can start_hand).');
    if (this.userId === r.bankerId || this.userId === r.coBankerId)
      lines.push('You are a banker (bank_requests / approve_purchase work).');
    lines.push('Players:');
    for (const p of this.room.players) {
      lines.push(
        `  ${p.seat !== null ? `seat ${p.seat + 1}` : 'no seat'}: ${p.displayName} - ${p.stack} chips${p.sittingOut ? ', sitting out' : ''}${p.connected ? '' : ', disconnected'}`,
      );
    }
    if (this.handLive() && this.betting) {
      const st = this.betting;
      const pot = st.seats.reduce((s, x) => s + x.total, 0);
      lines.push(
        `Hand in progress (${st.street}). Board: ${this.board.map(cardName).join(' ') || 'not dealt yet'}. Pot ${pot}.`,
      );
      if (this.myCards.length) {
        lines.push(`Your cards: ${this.myCards.map(cardName).join(' ')}`);
        if (this.board.length === 5)
          lines.push(
            `Your best hand: ${describeScore(evaluate7([...this.myCards, ...this.board]))}`,
          );
      }
      const la = legalActions(st);
      if (la && la.seat === this.mySeat()) {
        const opts = [
          'fold',
          la.canCheck ? 'check' : `call ${la.callAmount}`,
          la.canRaise
            ? `${st.currentBet === 0 ? 'bet' : 'raise'} between ${la.minRaiseTo} and ${la.maxRaiseTo}`
            : null,
        ].filter(Boolean);
        const secs = this.deadline
          ? Math.max(0, Math.round((this.deadline - Date.now()) / 1000))
          : null;
        lines.push(
          `IT IS YOUR TURN. Options: ${opts.join(' | ')}${secs !== null ? `. ${secs}s left before auto-fold` : ''}`,
        );
      } else if (la) {
        lines.push(`Waiting for ${this.nameOf(la.seat)} to act.`);
      } else {
        lines.push('Cards are being dealt/revealed (the crypto runs automatically).');
      }
    } else if (this.result) {
      lines.push('The last hand is over.');
      if (this.myCards.length) lines.push(`You held: ${this.myCards.map(cardName).join(' ')}`);
    } else {
      lines.push('No hand in progress.');
    }
    if (this.peekOffers.length) {
      for (const o of this.peekOffers)
        lines.push(
          `PENDING PEEK OFFER: ${o.fromName} pays ${o.amount} to see your cards (answer_peek offerId=${o.offerId}).`,
        );
    }
    if (this.events.length) {
      lines.push('Recent events:');
      for (const e of this.events.slice(-12)) lines.push(`  - ${e}`);
    }
    return lines.join('\n');
  }

  // ---------- writes ----------

  act(action: PlayerAction): string {
    // Hard gate: never send from a stale/unsynced connection, even if a caller
    // skipped the `myTurn()` check (e.g. the runner's graceful fold).
    if (!this.connected || !this.isResynced)
      throw new Error('connection is not resynced; refusing to act');
    if (!this.handId) throw new Error('no hand in progress');
    if (!this.betting) throw new Error('betting has not started');
    const la = legalActions(this.betting);
    if (!la || la.seat !== this.mySeat()) throw new Error('it is not your turn');
    if (action.type === 'check' && !la.canCheck)
      throw new Error(`cannot check: call ${la.callAmount} or fold`);
    if ((action.type === 'bet' || action.type === 'raise') && action.amount !== undefined) {
      if (action.amount < la.minRaiseTo || action.amount > la.maxRaiseTo)
        throw new Error(`amount must be between ${la.minRaiseTo} and ${la.maxRaiseTo}`);
    }
    this.send({
      t: 'action',
      handId: this.handId,
      action,
      sig: this.signed(this.handId, 'action', { action }),
    });
    // `actionSeq` came from a required `betting_state` field, so this is always
    // a number even against a server that predates `action_applied.actionSeq`.
    this.lastActedSeq = this.actionSeq;
    return `sent ${action.type}${action.amount ? ` ${action.amount}` : ''}`;
  }

  showCards(): void {
    if (!this.handId || this.myCardPoints.length === 0)
      throw new Error('no cards to show for the last hand');
    const k = this.keyFor(this.handId);
    const shares = this.myCardPoints.map(({ deckIndex, point }) => {
      const { out, proof } = proveUnmask(k, pointFromHex(point));
      return { deckIndex, out: pointHex(out), proof };
    });
    this.send({
      t: 'show_cards',
      handId: this.handId,
      shares,
      sig: this.signed(this.handId, 'show_cards', { shares }),
    });
  }

  answerPeek(offerId: string, accept: boolean): void {
    // Only answer an offer we actually hold: a stale/unknown id (e.g. a filtered
    // previous-hand offer) must never trigger an outbound frame.
    const offer = this.peekOffers.find((o) => o.offerId === offerId);
    if (!offer) return;
    this.peekOffers = this.peekOffers.filter((o) => o.offerId !== offerId);
    // Answer against the offer's own hand id: the offer can outlive a newer
    // hand's context, and the server verifies the signature against that hand.
    const handId = offer.handId;
    // Never mint a key for a hand we did not play: `keyFor` would implicitly
    // create one, then the shares would unmask against the wrong key and the
    // server would reject an "accept" while the requester got no result. A
    // missing key (or points from a different hand) is a decline, not a gamble.
    const k = this.handKeys.get(handId);
    const points = this.myCardPointsHandId === handId ? this.myCardPoints : [];
    if (!accept || !k || points.length === 0) {
      this.send({ t: 'peek_decline', handId, offerId });
      return;
    }
    const shares = points.map(({ deckIndex, point }) => {
      const { out, proof } = proveUnmask(k, pointFromHex(point));
      return { deckIndex, out: pointHex(out), proof };
    });
    this.send({
      t: 'peek_accept',
      handId,
      offerId,
      shares,
      sig: this.signed(handId, 'peek_accept', { offerId, shares }),
    });
  }

  /** Waits until it is my turn, the hand ends, or the timeout passes. */
  async waitForTurn(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    await new Promise((r) => setTimeout(r, 25)); // let queued frames drain first
    while (Date.now() < deadline) {
      if (this.myTurn() || this.result || this.abort) return;
      await new Promise<void>((res) => {
        const w = () => {
          this.waiters.delete(w);
          res();
        };
        this.waiters.add(w);
        setTimeout(w, Math.min(500, Math.max(50, deadline - Date.now())));
      });
    }
  }
}
