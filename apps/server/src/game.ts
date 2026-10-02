import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  Transcript,
  cardLookup,
  handKeyCommit,
  initialDeck,
  invScalar,
  mulPoint,
  pointFromHex,
  pointHex,
  proveUnmask,
  recoverCard,
  signContent,
  verifyContent,
  verifyUnmask,
  type Point,
} from '@4am/mental-poker';
import {
  activeNonAllIn,
  applyAction,
  awardPots,
  bestScoreSeats,
  computePots,
  commissionForPot,
  evaluate7,
  intersectSeatSets,
  nextStreet,
  splitAmountEven,
  startBombPot,
  startHand,
  streetClosed,
  type BettingState,
  type CardId,
  type ClientMsg,
  type MultiRunReason,
  type PlayerAction,
  type RoomGameplaySettings,
  type ServerMsg,
  signedBody,
  isLoungeWalkable,
  availableLoungePoint,
  LOUNGE_DESTINATIONS,
  type LoungePosition,
} from '@4am/shared';
import type { DB } from './db.js';
import { appendLedger } from './ledger.js';
import { getRoom, presentablePlayers, roomPlayers } from './rooms.js';
import { readRoomFeatures } from './gameplaySettings.js';
import { computeHeadsUpEquity, EquityError } from './equity.js';
import { settleRake } from './rake.js';
import { publishRoomEvent } from './agentEvents.js';
import { platformUserId } from './platform.js';

export interface GameOpts {
  cryptoTimeoutMs: number;
  actionTimeoutMs: number;
  /** Extra chances a stalled player gets before the hand aborts (default 3). */
  cryptoRetries?: number;
  /** Delay before an enabled automatic ready check (default 15s). */
  autoDealMs?: number;
  /** How long the pre-deal ready check waits before dealing without stragglers (default 20s). */
  readyCheckMs?: number;
  /** How long the run-it-twice vote stays open when everyone is all-in (default 15s). */
  ritVoteMs?: number;
  /** Offer run-it-twice at all. Off by default: the second-board unmask chains
   *  were hanging and aborting hands. */
  runItTwice?: boolean;
  /** TV replays: save every player's hand key post-hand so replays show all cards. */
  tvReplays?: boolean;
}

interface Identity {
  publicKey: string;
  secretKey: string;
}

interface HandSeatInfo {
  seat: number;
  userId: number;
  username: string;
  pubkey: string;
  stack: number;
}

interface Chain {
  deckIndex: number;
  forSeat: number | null;
  purpose: 'hole' | 'board' | 'showdown';
  current: Point;
  remaining: number[]; // seats yet to apply their unmask, in order
}

/** Rooms with a hand in flight; REST money moves must wait for the settle. */
import { activeHands } from './liveHands.js';

/** How long a host may be offline before the table hands the role to someone
 *  still sitting at it. */
const HOST_HANDOVER_MS = 60_000;
export { activeHands };

/** The classic house rule: 7-2 offsuit wins collect a bounty from everyone. */
export function isSevenDeuce(cards: CardId[]): boolean {
  if (cards.length !== 2) return false;
  const ranks = cards.map((c) => Math.floor(c / 4)).sort((a, b) => a - b);
  const suits = cards.map((c) => c % 4);
  return ranks[0] === 0 && ranks[1] === 5 && suits[0] !== suits[1]; // 2 and 7, offsuit
}

interface SnapshotSeat {
  userId: number;
  pubkey: string;
  commit: Point;
  cards: { deckIndex: number; point: Point }[];
}

interface ShowSnapshot {
  handId: string;
  bySeat: Map<number, SnapshotSeat>;
  revealedSeats: Set<number>;
  winnerSeats: number[];
  reveals: Map<number, CardId[]>;
}

type Share = { deckIndex: number; out: string; proof: { A1: string; A2: string; z: string } };

/**
 * `multi_run_result.reason`. The shared `MultiRunReason` union does not yet
 * carry `equity_failed`; the engine emits it as a distinct, auditable reason
 * rather than collapsing an equity failure into `ineligible`. Required shared
 * change: add `'equity_failed'` to `MultiRunReason` in
 * `packages/shared/src/wsProtocol.ts` (web handlers treat unknown reasons
 * passively, so the cast is additive until then).
 */
type MultiRunResultReason = MultiRunReason | 'equity_failed';

/** Which feature trigger a hand claimed, and the settings/balances it must
 *  settle against. Snapshot at claim time so a mid-hand settings write (blocked
 *  anyway) or a later config change can never move the goalposts. */
interface HandFeatureSnapshot {
  squid: {
    /** Null unless a squid trigger was claimed for this hand. */
    settings: RoomGameplaySettings['squid'] | null;
    triggerId: number | null;
  };
  bomb: {
    /** Null unless this hand is a bomb pot. */
    ante: number;
    anteBb: number;
    settings: RoomGameplaySettings['bombPot'] | null;
    triggerId: number | null;
    source: string | null;
  };
  multiRun: RoomGameplaySettings['multiRun'];
  timeBank: {
    enabled: boolean;
    initialMs: number;
    refillEveryHands: number;
    refillMs: number;
    epoch: number;
    /** seat -> remaining ms at deal time. */
    balances: Map<number, number>;
    /** seat -> completed hands since the last refill. */
    hands: Map<number, number>;
  } | null;
}

/** The squid-game outcome computed at settlement and applied atomically. */
interface SquidSettlement {
  winners: number[];
  transfers: { from: number; to: number; amount: number }[];
  requestedPerLoser: number;
  paidBySeat: { seat: number; amount: number }[];
  noClaimant: boolean;
  netBySeat: Map<number, number>;
}

/** Everything the atomic settlement writer needs, all already resolved to
 *  userIds so the writer never touches engine state. */
export interface HandSettlementWrite {
  handId: string;
  roomId: string;
  head: string;
  entries: unknown;
  rake: number;
  commissionBps: number;
  /** Combined poker+squid stack deltas, one per hand seat. */
  stackDeltas: { userId: number; delta: number }[];
  /** Poker-only ledger rows (kind 'hand-settlement'). */
  pokerLedger: { userId: number; delta: number }[];
  /** Squid-only ledger rows (kind 'squid-game'). */
  squidLedger: { userId: number; delta: number }[];
  squidNote: string;
  /** Time-bank writes for this hand's seats. */
  timeBanks: { userId: number; ms: number; hands: number }[];
  /** The epoch the time-bank snapshot belongs to; null disables those writes. */
  timeBankEpoch: number | null;
  triggerIds: (number | null)[];
  bombRan: boolean;
  /** Rake recipient, or null if there is nowhere to credit it. */
  rakeRecipientId: number | null;
  now: number;
}

export interface HandSettlementOutcome {
  status: 'applied' | 'duplicate';
  timeBankSkipped: number[];
  finalStacks: { userId: number; stack: number }[];
}

/**
 * Apply one hand's settlement atomically, exactly once.
 *
 * Idempotency: a durable `hand_settlements` row is inserted first (same
 * transaction); if it already exists the call is a no-op and reports
 * `duplicate`. Conservation: after applying the deltas the writer re-reads the
 * rows, rejects any negative stack, and asserts
 * `sum(finalStacks) + rake === sum(stacksBefore)`. Any violation throws and the
 * whole transaction (including the marker) rolls back, so a corrupted settle
 * can never be half-applied.
 */
export function applyHandSettlement(db: DB, w: HandSettlementWrite): HandSettlementOutcome {
  const write = db.transaction((): HandSettlementOutcome => {
    const claim = db
      .prepare(
        `INSERT INTO hand_settlements (hand_id, room_id, head, rake, final_stacks, applied_at)
         VALUES (?, ?, ?, ?, '[]', ?)
         ON CONFLICT(hand_id) DO NOTHING`,
      )
      .run(w.handId, w.roomId, w.head, w.rake, w.now);
    if (claim.changes === 0) {
      // already settled by an earlier (committed) call - apply nothing
      return { status: 'duplicate', timeBankSkipped: [], finalStacks: [] };
    }

    const userIds = [...new Set(w.stackDeltas.map((d) => d.userId))];
    const placeholders = userIds.map(() => '?').join(',');
    const stackRows = userIds.length
      ? (db
          .prepare(
            `SELECT user_id, stack FROM room_players WHERE room_id = ? AND user_id IN (${placeholders})`,
          )
          .all(w.roomId, ...userIds) as { user_id: number; stack: number }[])
      : [];
    const sumBefore = stackRows.reduce((s, r) => s + r.stack, 0);

    for (const d of w.stackDeltas) {
      if (d.delta === 0) continue;
      db.prepare('UPDATE room_players SET stack = stack + ? WHERE room_id = ? AND user_id = ?').run(
        d.delta,
        w.roomId,
        d.userId,
      );
    }

    const afterRows = userIds.length
      ? (db
          .prepare(
            `SELECT user_id, stack FROM room_players WHERE room_id = ? AND user_id IN (${placeholders})`,
          )
          .all(w.roomId, ...userIds) as { user_id: number; stack: number }[])
      : [];
    const finalByUser = new Map(afterRows.map((r) => [r.user_id, r.stack]));
    for (const d of w.stackDeltas) {
      const finalStack = finalByUser.get(d.userId) ?? 0;
      if (finalStack < 0)
        throw new Error(
          `settlement would drive user ${d.userId} negative (${finalStack}) on hand ${w.handId}`,
        );
    }
    const sumAfter = afterRows.reduce((s, r) => s + r.stack, 0);
    if (sumAfter + w.rake !== sumBefore)
      throw new Error(
        `settlement not conserving on hand ${w.handId}: before=${sumBefore} after=${sumAfter} rake=${w.rake}`,
      );

    for (const l of w.pokerLedger) {
      if (l.delta === 0) continue;
      appendLedger(db, {
        roomId: w.roomId,
        userId: l.userId,
        delta: l.delta,
        kind: 'hand-settlement',
        ref: w.head,
      });
    }
    for (const l of w.squidLedger) {
      if (l.delta === 0) continue;
      appendLedger(db, {
        roomId: w.roomId,
        userId: l.userId,
        delta: l.delta,
        kind: 'squid-game',
        ref: w.head,
        note: w.squidNote,
      });
    }
    if (w.rake > 0 && w.rakeRecipientId !== null) {
      settleRake(db, {
        roomId: w.roomId,
        recipientId: w.rakeRecipientId,
        rake: w.rake,
        ref: w.head,
        commissionBps: w.commissionBps,
      });
    }

    const timeBankSkipped: number[] = [];
    if (w.timeBankEpoch !== null) {
      for (const tb of w.timeBanks) {
        const row = db
          .prepare(
            'SELECT time_bank_epoch FROM room_players WHERE room_id = ? AND user_id = ?',
          )
          .get(w.roomId, tb.userId) as { time_bank_epoch: number } | undefined;
        if (!row || row.time_bank_epoch !== w.timeBankEpoch) {
          // a config change reset the bank mid-hand: do NOT overwrite the reset
          // with a stale snapshot, and report it so the caller can audit it
          timeBankSkipped.push(tb.userId);
          continue;
        }
        db.prepare(
          'UPDATE room_players SET time_bank_ms = ?, time_bank_hands = ?, time_bank_epoch = ? WHERE room_id = ? AND user_id = ? AND time_bank_epoch = ?',
        ).run(tb.ms, tb.hands, w.timeBankEpoch, w.roomId, tb.userId, w.timeBankEpoch);
      }
    }

    for (const id of w.triggerIds) {
      if (!id) continue;
      db.prepare(
        "UPDATE room_feature_triggers SET status = 'applied', resolved_at = ? WHERE id = ? AND status = 'claimed'",
      ).run(w.now, id);
    }

    db.prepare(
      'INSERT INTO transcripts (hand_id, room_id, head, entries, ts) VALUES (?, ?, ?, ?, ?)',
    ).run(w.handId, w.roomId, w.head, JSON.stringify(w.entries), w.now);

    const gs = db
      .prepare(
        `SELECT completed_hands, last_bomb_completed_hands, last_bomb_at, schedule_reset_at
         FROM room_gameplay_state WHERE room_id = ?`,
      )
      .get(w.roomId) as
      | {
          completed_hands: number;
          last_bomb_completed_hands: number;
          last_bomb_at: number | null;
          schedule_reset_at: number | null;
        }
      | undefined;
    const completed = (gs?.completed_hands ?? 0) + 1;
    const lastBombHands = w.bombRan ? completed : (gs?.last_bomb_completed_hands ?? 0);
    const lastBombAt = w.bombRan ? w.now : (gs?.last_bomb_at ?? null);
    db.prepare(
      `INSERT INTO room_gameplay_state
         (room_id, completed_hands, last_bomb_completed_hands, last_bomb_at, schedule_reset_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(room_id) DO UPDATE SET
         completed_hands = excluded.completed_hands,
         last_bomb_completed_hands = excluded.last_bomb_completed_hands,
         last_bomb_at = excluded.last_bomb_at,
         schedule_reset_at = excluded.schedule_reset_at`,
    ).run(w.roomId, completed, lastBombHands, lastBombAt, gs?.schedule_reset_at ?? null);

    const finalStacks = afterRows.map((r) => ({ userId: r.user_id, stack: r.stack }));
    db.prepare('UPDATE hand_settlements SET final_stacks = ? WHERE hand_id = ?').run(
      JSON.stringify(finalStacks),
      w.handId,
    );
    return { status: 'applied', timeBankSkipped, finalStacks };
  });
  return write();
}

/** Verifies a player's DLEQ unmask shares against a finished hand's snapshot. */
function verifySnapshotShares(
  entry: SnapshotSeat,
  shares: Share[],
  lookup: ReturnType<typeof cardLookup>,
): CardId[] | null {
  const points = new Map(entry.cards.map((c) => [c.deckIndex, c.point]));
  const cards: CardId[] = [];
  const seen = new Set<number>();
  for (const sh of shares) {
    const pIn = points.get(sh.deckIndex);
    if (!pIn || seen.has(sh.deckIndex)) return null;
    seen.add(sh.deckIndex);
    let out: Point;
    try {
      out = pointFromHex(sh.out);
    } catch {
      return null;
    }
    if (!verifyUnmask(entry.commit, pIn, out, sh.proof)) return null;
    const card = recoverCard(out, lookup);
    if (card === null) return null;
    cards.push(card);
  }
  return cards;
}

export class GameRoom {
  private sockets = new Map<number, WebSocket>();
  private lounge = new Map<number, LoungePosition>();
  private loungeLastMove = new Map<number, number>();
  private loungeRevision = 0;
  private hand: Hand | null = null;
  private lastButton: number | null = null;
  // voluntary card shows for the current (or most recently ended) hand
  private shown = new Map<number, CardId[]>();
  private shownHandId: string | null = null;
  private lastHandShow: ShowSnapshot | null = null;
  private peekOffers = new Map<
    string,
    { handId: string; fromUserId: number; targetSeat: number; amount: number }
  >();
  private sevenDeucePaid = new Set<string>();
  private autoDeal: NodeJS.Timeout | null = null;
  private autoDealAt: number | null = null;
  private autoDealPaused = false;
  private autoDealEligibility = '';
  private reconcilingAutoDeal = false;
  // no hand auto-starts until everyone is ready: a 20s ready check runs
  // before each auto-deal, and whoever has not clicked by the deadline is
  // left out of that hand (requested by notpritam, docs/FEATURES.md)
  private readyCheck: {
    deadline: number;
    timer: NodeJS.Timeout;
    eligible: Set<number>;
    ready: Set<number>;
  } | null = null;
  private hostHandover: NodeJS.Timeout | null = null;
  private lookup = cardLookup();

  constructor(
    private db: DB,
    readonly roomId: string,
    private serverId: Identity,
    private opts: GameOpts,
  ) {}

  join(userId: number, ws: WebSocket): void {
    // Deliberately does NOT close the socket it replaces. Closing it made two
    // tabs on the same room fight: the server hangs up on tab A, tab A's client
    // reconnects and displaces tab B, B reconnects and displaces A, forever -
    // and a player stuck in that loop answers no crypto requests, so every hand
    // they are dealt into stalls out. The orphan is cheap; the loop was not.
    this.sockets.set(userId, ws);
    const member = this.db
      .prepare('SELECT seat FROM room_players WHERE room_id = ? AND user_id = ?')
      .get(this.roomId, userId) as { seat: number | null } | undefined;
    if (member?.seat === null && !this.lounge.has(userId)) {
      const point = availableLoungePoint(LOUNGE_DESTINATIONS.entry, [...this.lounge.values()]);
      if (point) this.lounge.set(userId, { ...point, revision: ++this.loungeRevision });
    }
    this.broadcastRoomState();
    // late joiners and reconnects still get to see voluntarily shown cards
    if (this.shownHandId) {
      for (const [seat, cards] of this.shown) {
        this.send(userId, { t: 'cards_shown', handId: this.shownHandId, seat, cards });
      }
    }
    // a rejoining participant gets the whole hand context back, plus any
    // request (shuffle turn, unmask share) the table is still waiting on
    this.hand?.resendPending(userId);
  }

  leave(userId: number, ws: WebSocket): void {
    if (this.sockets.get(userId) === ws) {
      this.sockets.delete(userId);
      this.lounge.delete(userId);
      this.loungeLastMove.delete(userId);
      this.broadcastRoomState();
      // a folded player walking away must never strand the hand
      this.hand?.onPlayerGone(userId);
      this.scheduleHostHandover(userId);
    }
  }

  isConnected(userId: number): boolean {
    return this.sockets.has(userId);
  }

  /** The host is the only person who can deal, so a host who shuts their laptop
   *  freezes the table for everyone still sitting at it. After a grace window the
   *  role passes to someone who is actually here.
   *
   *  Host only, deliberately. The BANKER approves buy-ins and moves chips, and a
   *  money authority must never change hands on a timer - if the banker is gone,
   *  the table waits for them or names a backup by hand. */
  private scheduleHostHandover(goneUserId: number): void {
    const room = getRoom(this.db, this.roomId);
    if (!room || room.host_id !== goneUserId || this.hostHandover) return;
    this.hostHandover = setTimeout(() => {
      this.hostHandover = null;
      const current = getRoom(this.db, this.roomId);
      // they came back, or someone already took it: nothing to do
      if (!current || current.host_id !== goneUserId || this.isConnected(goneUserId)) return;
      // presentablePlayers so the house can never be handed host duties
      const here = presentablePlayers(this.db, this.roomId).filter((p) =>
        this.sockets.has(p.userId),
      );
      // the banker if they are here - they already hold the room's trust
      const next = here.find((p) => p.userId === current.banker_id) ?? here[0];
      if (!next) return;
      this.db.prepare('UPDATE rooms SET host_id = ? WHERE id = ?').run(next.userId, this.roomId);
      this.broadcastRoomState();
      this.broadcast({
        t: 'chat',
        from: '4AM',
        userId: 0,
        text: `${next.displayName} is the host now - the previous host went offline.`,
        kind: 'text',
        ts: Date.now(),
      });
    }, HOST_HANDOVER_MS);
  }

  /** Nobody is connected and nothing is in flight, so the hub can drop this room
   *  instead of holding it (and its per-hand maps) for the life of the process. */
  isIdle(): boolean {
    return this.sockets.size === 0 && this.hand === null && this.readyCheck === null;
  }

  shutdown(): void {
    this.lounge.clear();
    this.loungeLastMove.clear();
    if (this.hostHandover) clearTimeout(this.hostHandover);
    this.hostHandover = null;
    this.hand?.clearTimer();
    this.hand = null;
    activeHands.delete(this.roomId);
    if (this.autoDeal) clearTimeout(this.autoDeal);
    this.autoDeal = null;
    this.autoDealAt = null;
    this.cancelReadyCheck(false);
  }

  private cancelAutoDeal(): void {
    if (this.autoDeal) clearTimeout(this.autoDeal);
    const announced = this.autoDealAt !== null;
    this.autoDeal = null;
    this.autoDealAt = null;
    if (announced) this.broadcast({ t: 'auto_deal', inMs: 0 });
  }

  /** A fallback coordinates auto-deal only; it grants no host/banking powers. */
  private autoDealerId(): number | null {
    const room = getRoom(this.db, this.roomId);
    if (!room?.auto_deal || room.archived) return null;
    const eligible = this.eligiblePlayers();
    return (eligible.find((p) => p.userId === room.host_id) ?? eligible[0])?.userId ?? null;
  }

  /** Reconcile settings, presence and seating without restarting an existing timer. */
  private reconcileAutoDeal(): void {
    if (this.reconcilingAutoDeal) return;
    this.reconcilingAutoDeal = true;
    try {
      const room = getRoom(this.db, this.roomId);
      const eligible = this.eligiblePlayers();
      const key = JSON.stringify([room?.auto_deal, room?.archived, eligible.map((p) => p.userId)]);
      if (key !== this.autoDealEligibility) this.autoDealPaused = false;
      this.autoDealEligibility = key;
      if (this.hand || !room?.auto_deal || room.archived || eligible.length < 2) {
        this.cancelAutoDeal();
        this.cancelReadyCheck();
        return;
      }
      const rc = this.readyCheck;
      if (rc) {
        const ids = new Set(eligible.map((p) => p.userId));
        let changed = false;
        for (const id of rc.eligible) {
          if (!ids.has(id)) {
            rc.eligible.delete(id);
            rc.ready.delete(id);
            changed = true;
          }
        }
        if (rc.eligible.size < 2) {
          this.cancelReadyCheck();
          this.autoDealPaused = true;
        } else if (rc.ready.size === rc.eligible.size) this.resolveReadyCheck();
        else if (changed) this.broadcastReadyCheck();
        return;
      }
      if (!this.autoDealPaused) this.scheduleAutoDeal();
    } finally {
      this.reconcilingAutoDeal = false;
    }
  }

  private scheduleAutoDeal(): void {
    if (this.autoDeal || this.hand || this.readyCheck) return;
    const delay = this.opts.autoDealMs ?? 15_000;
    if (this.autoDealerId() === null || this.eligiblePlayers().length < 2) return;
    this.autoDealAt = Date.now() + delay;
    this.autoDeal = setTimeout(() => {
      this.autoDeal = null;
      this.autoDealAt = null;
      if (this.hand || !this.db.open) return;
      this.beginReadyCheck();
    }, delay);
    this.broadcast({ t: 'auto_deal', inMs: delay });
  }

  private eligiblePlayers() {
    return presentablePlayers(this.db, this.roomId)
      .filter((p) => p.seat !== null && !p.sittingOut && p.stack > 0 && this.sockets.has(p.userId))
      .sort((a, b) => a.seat! - b.seat!);
  }

  /** Auto-deal never starts betting on its own: everyone gets 20 seconds to
   *  click "I'm ready"; whoever misses the deadline sits this one out. */
  private beginReadyCheck(): void {
    if (this.hand || this.readyCheck) return;
    const eligible = this.eligiblePlayers();
    if (eligible.length < 2 || this.autoDealerId() === null) {
      this.broadcastRoomState();
      return;
    }
    const ms = this.opts.readyCheckMs ?? 20_000;
    const deadline = Date.now() + ms;
    // Players who asked to be dealt in automatically count as ready the moment
    // the check opens. Held server-side rather than auto-clicking in the client,
    // so it still works with the tab in the background - which is exactly when
    // clicking every hand was annoying enough to ask for this.
    const ids = eligible.map((p) => Number(p.userId));
    const autoReady = new Set(
      (
        this.db
          .prepare(
            `SELECT id FROM users WHERE auto_ready = 1 AND id IN (${ids.map(() => '?').join(',')})`,
          )
          .all(...ids) as { id: number }[]
      ).map((r) => r.id),
    );
    this.readyCheck = {
      deadline,
      timer: setTimeout(() => this.resolveReadyCheck(), ms),
      eligible: new Set(ids),
      ready: autoReady,
    };
    this.broadcastReadyCheck();
    // everyone at the table opted in: skip the wait entirely
    if (autoReady.size === ids.length) this.resolveReadyCheck();
    else this.broadcastRoomState();
  }

  private broadcastReadyCheck(): void {
    const rc = this.readyCheck;
    if (!rc) return;
    this.broadcast({
      t: 'ready_check',
      deadlineTs: rc.deadline,
      eligible: [...rc.eligible],
      ready: [...rc.ready],
    });
  }

  private onReady(userId: number): void {
    const rc = this.readyCheck;
    if (!rc || !rc.eligible.has(userId) || rc.ready.has(userId)) return;
    rc.ready.add(userId);
    this.broadcastReadyCheck();
    if (rc.ready.size === rc.eligible.size) this.resolveReadyCheck();
  }

  private resolveReadyCheck(): void {
    const rc = this.readyCheck;
    if (!rc) return;
    clearTimeout(rc.timer);
    this.readyCheck = null;
    this.broadcast({ t: 'ready_end' });
    // Recheck consent against current seating/presence, including the fallback.
    const ready = new Set(
      this.eligiblePlayers()
        .filter((p) => rc.ready.has(p.userId))
        .map((p) => p.userId),
    );
    if (ready.size >= 2 && this.autoDealerId() !== null) this.startHand(true, ready);
    else this.autoDealPaused = true;
    this.broadcastRoomState();
  }

  private cancelReadyCheck(announce = true): void {
    if (!this.readyCheck) return;
    clearTimeout(this.readyCheck.timer);
    this.readyCheck = null;
    if (announce) this.broadcast({ t: 'ready_end' });
  }

  send(userId: number, msg: ServerMsg): void {
    this.sockets.get(userId)?.send(JSON.stringify(msg));
  }

  broadcast(msg: ServerMsg): void {
    publishRoomEvent(this.db, this.roomId, msg);
    const data = JSON.stringify(msg);
    for (const ws of this.sockets.values()) ws.send(data);
  }

  settingsChanged(restartAutoDeal = false): void {
    if (restartAutoDeal) this.autoDealPaused = false;
    this.broadcastRoomState();
  }

  broadcastRoomState(): void {
    if (!this.db.open) return; // server shutting down
    this.reconcileAutoDeal();
    const room = getRoom(this.db, this.roomId);
    if (!room) return;
    const players = presentablePlayers(this.db, this.roomId).map((p) => ({
      userId: p.userId,
      username: p.username,
      displayName: p.displayName,
      avatarVersion: p.avatarVersion,
      publicKey: p.publicKey,
      seat: p.seat,
      stack: p.stack,
      sittingOut: !!p.sittingOut,
      connected: this.sockets.has(p.userId),
      totalBought: p.privateMode ? 0 : p.totalBought,
      privateStats: !!p.privateMode,
      pendingBuy: p.pendingBuy,
      avatar3d: p.avatar3d,
    }));
    const state: ServerMsg = {
      t: 'room_state',
      room: {
        id: room.id,
        name: room.name,
        joinCode: room.join_code,
        hostId: room.host_id,
        bankerId: room.banker_id,
        sb: room.sb,
        bb: room.bb,
        auditMode: room.audit_mode,
        actionTimeoutMs:
          room.action_secs !== null ? room.action_secs * 1000 : this.opts.actionTimeoutMs,
        actionSecs: room.action_secs,
        coBankerId: room.co_banker_id,
        minSettleHands: room.min_settle_hands,
        autoApproveBuys: !!room.auto_approve_buys,
        tvReplays: !!room.tv_replays,
        autoDeal: !!room.auto_deal,
        autoDealerId: this.autoDealerId(),
        commissionBps: this.hand?.commissionBps ?? room.commission_bps,
        sevenDeuceBonus: room.seven_deuce_bonus,
        voided: !!room.voided,
        meetLink: room.meet_link,
      },
      players,
      handActive: this.hand !== null,
      lounge: Object.fromEntries(this.lounge),
      autoDealAt: this.autoDealAt,
      autoDealPaused: this.autoDealPaused,
      readyCheck: this.readyCheck
        ? {
            deadlineTs: this.readyCheck.deadline,
            eligible: [...this.readyCheck.eligible],
            ready: [...this.readyCheck.ready],
          }
        : null,
    };
    // spectators watch the table but never see the join code
    const memberIds = new Set(players.map((p) => p.userId));
    const masked = JSON.stringify({ ...state, room: { ...state.room, joinCode: '' } });
    const full = JSON.stringify(state);
    publishRoomEvent(this.db, this.roomId, state);
    for (const [uid, ws] of this.sockets) ws.send(memberIds.has(uid) ? full : masked);
  }

  private lastPoke = new Map<number, number>();

  handleMessage(userId: number, msg: ClientMsg): void {
    switch (msg.t) {
      case 'lounge_move': {
        const player = this.db
          .prepare('SELECT seat, sitting_out FROM room_players WHERE room_id = ? AND user_id = ?')
          .get(this.roomId, userId) as { seat: number | null; sitting_out: number } | undefined;
        if (!player || !this.sockets.has(userId))
          return this.send(userId, {
            t: 'error',
            message: 'Join this table as a member to explore the lounge.',
          });
        if (player.seat !== null && !player.sitting_out)
          return this.send(userId, {
            t: 'error',
            message: 'Take a break before leaving your chair.',
          });
        if (this.hand?.isContesting(userId))
          return this.send(userId, {
            t: 'error',
            message: 'Finish this hand before walking away. Your break is saved.',
          });
        if (!isLoungeWalkable(msg))
          return this.send(userId, {
            t: 'error',
            message: 'Choose a clear spot on the lounge floor.',
          });
        const now = Date.now();
        if (now - (this.loungeLastMove.get(userId) ?? -Infinity) < 180) return;
        this.loungeLastMove.set(userId, now);
        const point = availableLoungePoint(
          msg,
          [...this.lounge].filter(([id]) => id !== userId).map(([, position]) => position),
        );
        if (!point)
          return this.send(userId, {
            t: 'error',
            message: 'That part of the lounge is full. Choose another spot.',
          });
        const position = { ...point, revision: ++this.loungeRevision };
        this.lounge.set(userId, position);
        this.broadcast({ t: 'lounge_presence', roomId: this.roomId, userId, position });
        return;
      }
      case 'lounge_return': {
        const player = this.db
          .prepare('SELECT seat FROM room_players WHERE room_id = ? AND user_id = ?')
          .get(this.roomId, userId) as { seat: number | null } | undefined;
        if (!player || player.seat === null)
          return this.send(userId, {
            t: 'error',
            message: 'Choose an open seat to return to the table.',
          });
        this.lounge.delete(userId);
        this.db
          .prepare('UPDATE room_players SET sitting_out = 0 WHERE room_id = ? AND user_id = ?')
          .run(this.roomId, userId);
        this.broadcastRoomState();
        return;
      }
      case 'chat': {
        const user = this.db
          .prepare('SELECT COALESCE(display_name, username) as name FROM users WHERE id = ?')
          .get(userId) as { name: string };
        this.broadcast({
          t: 'chat',
          from: user.name,
          userId,
          text: msg.text,
          kind: msg.kind ?? 'text',
          ts: Date.now(),
        });
        return;
      }
      case 'poke': {
        // a friendly shove in the 3D world; relayed, never gameplay-affecting
        const nowTs = Date.now();
        if (nowTs - (this.lastPoke.get(userId) ?? 0) < 900) return;
        this.lastPoke.set(userId, nowTs);
        const pokeUser = this.db
          .prepare('SELECT COALESCE(display_name, username) as name FROM users WHERE id = ?')
          .get(userId) as { name: string };
        this.broadcast({
          t: 'poke',
          fromUserId: userId,
          fromName: pokeUser.name,
          targetSeat: msg.targetSeat,
        });
        return;
      }
      case 'emote': {
        const nowEmote = Date.now();
        if (nowEmote - (this.lastPoke.get(userId) ?? 0) < 700) return;
        this.lastPoke.set(userId, nowEmote);
        const emoteUser = this.db
          .prepare('SELECT COALESCE(display_name, username) as name FROM users WHERE id = ?')
          .get(userId) as { name: string };
        const emoteSeat = this.db
          .prepare('SELECT seat FROM room_players WHERE room_id = ? AND user_id = ?')
          .get(this.roomId, userId) as { seat: number | null } | undefined;
        this.broadcast({
          t: 'emote',
          fromUserId: userId,
          fromName: emoteUser.name,
          fromSeat: emoteSeat?.seat ?? null,
          kind: msg.kind,
          targetSeat: msg.targetSeat,
        });
        return;
      }
      case 'rtc': {
        // voice-chat signaling: relay verbatim to one room member; server never sees audio
        this.send(msg.to, { t: 'rtc', from: userId, data: msg.data });
        return;
      }
      case 'voice_state': {
        this.broadcast({ t: 'voice_state', userId, muted: msg.muted });
        return;
      }
      case 'sit': {
        if (this.hand)
          return this.send(userId, { t: 'error', message: 'wait for the hand to end' });
        const taken = this.db
          .prepare('SELECT 1 FROM room_players WHERE room_id = ? AND seat = ?')
          .get(this.roomId, msg.seat);
        if (taken) return this.send(userId, { t: 'error', message: 'seat taken' });
        this.db
          .prepare(
            'UPDATE room_players SET seat = ?, sitting_out = 0 WHERE room_id = ? AND user_id = ?',
          )
          .run(msg.seat, this.roomId, userId);
        this.lounge.delete(userId);
        this.broadcastRoomState();
        return;
      }
      case 'leave_seat': {
        if (this.hand)
          return this.send(userId, { t: 'error', message: 'wait for the hand to end' });
        if (
          !this.db
            .prepare('SELECT 1 FROM room_players WHERE room_id = ? AND user_id = ?')
            .get(this.roomId, userId)
        )
          return this.send(userId, {
            t: 'error',
            message: 'Only table members have a seat to leave.',
          });
        this.db
          .prepare('UPDATE room_players SET seat = NULL WHERE room_id = ? AND user_id = ?')
          .run(this.roomId, userId);
        if (!this.lounge.has(userId)) {
          const point = availableLoungePoint(LOUNGE_DESTINATIONS.entry, [...this.lounge.values()]);
          if (point) this.lounge.set(userId, { ...point, revision: ++this.loungeRevision });
        }
        this.broadcastRoomState();
        return;
      }
      case 'start_hand': {
        const room = getRoom(this.db, this.roomId)!;
        if (room.host_id !== userId)
          return this.send(userId, { t: 'error', message: 'only the host starts hands' });
        // an archived table is retired: history stays readable, play does not resume
        if (room.archived)
          return this.send(userId, {
            t: 'error',
            message: 'this table is archived - unarchive it to deal again',
          });
        if (this.hand) return this.send(userId, { t: 'error', message: 'hand already running' });
        this.cancelAutoDeal();
        this.cancelReadyCheck();
        this.startHand();
        return;
      }
      case 'im_ready': {
        this.onReady(userId);
        return;
      }
      case 'key_commit':
      case 'shuffle_deck':
      case 'unmask_share':
      case 'action':
      case 'reveal_key':
      case 'run_count_choice':
      case 'run_count_agree':
      case 'fold_key': {
        if (!this.hand || this.hand.id !== msg.handId)
          return this.send(userId, { t: 'error', message: 'no such hand' });
        this.hand.onMessage(userId, msg);
        return;
      }
      case 'show_cards': {
        if (this.hand && this.hand.id === msg.handId) return this.hand.onMessage(userId, msg);
        return this.onPostHandShow(userId, msg);
      }
      case 'sit_out': {
        if (!msg.sittingOut) this.lounge.delete(userId);
        this.db
          .prepare('UPDATE room_players SET sitting_out = ? WHERE room_id = ? AND user_id = ?')
          .run(msg.sittingOut ? 1 : 0, this.roomId, userId);
        this.broadcastRoomState();
        return;
      }
      case 'peek_offer':
        return this.onPeekOffer(userId, msg);
      case 'peek_accept':
      case 'peek_decline':
        return this.onPeekAnswer(userId, msg);
      default:
        return;
    }
  }

  /**
   * Atomically claim the triggers a new hand should carry and snapshot every
   * setting/balance it settles against. One IMMEDIATE transaction so the manual
   * triggers and the scheduled anchors move together: two concurrent starts can
   * never both claim the same pending row. Startup recovery for a claimed trigger
   * whose hand never produced a transcript lives in the migrations (db.ts).
   */
  private claimHandFeatures(
    roomId: string,
    seats: HandSeatInfo[],
    handId: string,
  ): HandFeatureSnapshot {
    const room = getRoom(this.db, roomId)!;
    const settings = readRoomFeatures(room);
    const now = Date.now();
    const snapshot: HandFeatureSnapshot = {
      squid: { settings: null, triggerId: null },
      bomb: {
        ante: 0,
        anteBb: settings.bombPot.anteBb,
        settings: null,
        triggerId: null,
        source: null,
      },
      multiRun: settings.multiRun,
      timeBank: null,
    };

    const claim = this.db.transaction(() => {
      const pending = this.db
        .prepare(
          "SELECT id, kind, source FROM room_feature_triggers WHERE room_id = ? AND status = 'pending'",
        )
        .all(roomId) as { id: number; kind: string; source: string }[];
      const gs = this.db
        .prepare(
          `SELECT completed_hands, last_bomb_completed_hands, last_bomb_at, schedule_reset_at
           FROM room_gameplay_state WHERE room_id = ?`,
        )
        .get(roomId) as
        | {
            completed_hands: number;
            last_bomb_completed_hands: number;
            last_bomb_at: number | null;
            schedule_reset_at: number | null;
          }
        | undefined;
      const claimTrigger = (id: number): void => {
        this.db
          .prepare(
            "UPDATE room_feature_triggers SET status = 'claimed', claimed_hand_id = ?, resolved_at = NULL WHERE id = ? AND status = 'pending'",
          )
          .run(handId, id);
      };

      // ---- bomb pot: manual trigger OR the hand/time schedule ----
      const manualBomb = pending.find((t) => t.kind === 'bomb');
      let timedDue = false;
      if (settings.bombPot.enabled && settings.bombPot.schedule.mode === 'hands') {
        const completed = gs?.completed_hands ?? 0;
        const last = gs?.last_bomb_completed_hands ?? 0;
        timedDue = completed - last >= settings.bombPot.schedule.value;
      } else if (settings.bombPot.enabled && settings.bombPot.schedule.mode === 'duration') {
        const anchor = gs?.last_bomb_at ?? gs?.schedule_reset_at ?? null;
        if (anchor === null) {
          // seed the clock rather than firing the moment bomb pot is enabled
          this.db
            .prepare(
              `INSERT INTO room_gameplay_state
                 (room_id, completed_hands, last_bomb_completed_hands, last_bomb_at, schedule_reset_at)
               VALUES (?, ?, ?, NULL, ?)
               ON CONFLICT(room_id) DO UPDATE SET schedule_reset_at = excluded.schedule_reset_at`,
            )
            .run(roomId, gs?.completed_hands ?? 0, gs?.last_bomb_completed_hands ?? 0, now);
        } else {
          timedDue = now - anchor >= settings.bombPot.schedule.value * 1000;
        }
      }
      if (settings.bombPot.enabled && (manualBomb || timedDue)) {
        let triggerId: number;
        let source: string;
        if (manualBomb) {
          // manual and timed colliding on one hand still opens a single bomb
          claimTrigger(manualBomb.id);
          triggerId = manualBomb.id;
          source = 'manual';
        } else {
          source = settings.bombPot.schedule.mode === 'duration' ? 'timed-duration' : 'timed-hands';
          const info = this.db
            .prepare(
              `INSERT INTO room_feature_triggers
                 (room_id, request_id, kind, source, status, requested_by, created_at, claimed_hand_id)
               VALUES (?, ?, 'bomb', ?, 'claimed', NULL, ?, ?)`,
            )
            .run(roomId, `auto-${handId}`, source, now, handId);
          triggerId = Number(info.lastInsertRowid);
        }
        snapshot.bomb = {
          ante: settings.bombPot.anteBb * room.bb,
          anteBb: settings.bombPot.anteBb,
          settings: settings.bombPot,
          triggerId,
          source,
        };
      }

      // ---- squid game: manual only, and only with enough participants ----
      const manualSquid = pending.find((t) => t.kind === 'squid');
      if (manualSquid && settings.squid.enabled && seats.length >= settings.squid.minPlayers) {
        claimTrigger(manualSquid.id);
        snapshot.squid = { settings: settings.squid, triggerId: manualSquid.id };
      }
      // too few players: the manual trigger stays pending for a later deal

      // ---- time bank balances (in-memory; persisted atomically at settle) ----
      if (settings.timeBank.enabled) {
        const rows = this.db
          .prepare(
            'SELECT user_id, time_bank_ms, time_bank_hands, time_bank_epoch FROM room_players WHERE room_id = ?',
          )
          .all(roomId) as {
          user_id: number;
          time_bank_ms: number;
          time_bank_hands: number;
          time_bank_epoch: number;
        }[];
        const byUser = new Map(rows.map((r) => [r.user_id, r]));
        const initialMs = settings.timeBank.initialSeconds * 1000;
        const balances = new Map<number, number>();
        const hands = new Map<number, number>();
        for (const s of seats) {
          const row = byUser.get(s.userId);
          const fresh = !row || row.time_bank_epoch !== room.time_bank_epoch;
          balances.set(s.seat, fresh ? initialMs : row.time_bank_ms);
          hands.set(s.seat, fresh ? 0 : row.time_bank_hands);
        }
        snapshot.timeBank = {
          enabled: true,
          initialMs,
          refillEveryHands: settings.timeBank.refillEveryHands,
          refillMs: settings.timeBank.refillSeconds * 1000,
          epoch: room.time_bank_epoch,
          balances,
          hands,
        };
      }
    });
    claim.immediate();
    return snapshot;
  }

  private startHand(auto = false, onlyIds?: Set<number>): void {
    const room = getRoom(this.db, this.roomId)!;
    if (this.hand || room.archived) return;
    const eligible = this.eligiblePlayers().filter((p) => !onlyIds || onlyIds.has(p.userId));
    if (eligible.length < 2) {
      if (!auto)
        this.broadcast({
          t: 'error',
          message: 'need at least 2 seated, funded, connected players',
        });
      return;
    }
    this.cancelAutoDeal();
    this.autoDealPaused = false;
    const seats = eligible.map((p) => p.seat!);
    // rotate the button to the next occupied seat
    let button: number;
    if (this.lastButton === null) button = seats[0]!;
    else button = seats.find((s) => s > this.lastButton!) ?? seats[0]!;
    const btnIdx = seats.indexOf(button);
    // dealing order: heads-up starts with the button (it is the SB); ring starts left of the button
    const startIdx = eligible.length === 2 ? btnIdx : (btnIdx + 1) % seats.length;
    const order = [...eligible.slice(startIdx), ...eligible.slice(0, startIdx)];
    const handSeats: HandSeatInfo[] = order.map((p) => ({
      seat: p.seat!,
      userId: p.userId,
      username: p.username,
      pubkey: p.publicKey,
      stack: p.stack,
    }));
    // the host's turn-time setting is read at deal time, so edits apply from the next hand
    const handOpts: GameOpts = {
      ...this.opts,
      actionTimeoutMs:
        room.action_secs !== null ? room.action_secs * 1000 : this.opts.actionTimeoutMs,
      tvReplays: !!room.tv_replays,
    };
    this.shown.clear();
    this.shownHandId = null;
    this.peekOffers.clear();
    // The hand id is minted before feature claiming so a claimed trigger can be
    // bound to the hand that will actually carry it through to a transcript.
    const handId = randomBytes(8).toString('hex');
    const features = this.claimHandFeatures(room.id, handSeats, handId);
    activeHands.add(this.roomId);
    this.hand = new Hand(
      this,
      this.db,
      room.id,
      handId,
      handSeats,
      features,
      button,
      room.sb,
      room.bb,
      room.audit_mode,
      this.serverId,
      handOpts,
      () => {
        activeHands.delete(this.roomId);
        this.lastButton = button;
        this.lastHandShow = this.hand?.showSnapshot() ?? null;
        this.hand = null;
        this.autoDealPaused = false;
        // showdown winners already revealed their cards: the 7-2 bounty applies now
        const snap = this.lastHandShow;
        if (snap) {
          for (const seat of snap.winnerSeats) {
            const cards = snap.reveals.get(seat);
            if (cards) this.trySevenDeuce(snap.handId, seat, cards);
          }
        }
        this.broadcastRoomState();
      },
    );
    this.hand.begin();
  }

  /** Records a verified voluntary show and tells the table. Returns false when already shown. */
  recordShow(handId: string, seat: number, cards: CardId[]): boolean {
    if (this.shownHandId !== handId) {
      this.shown.clear();
      this.shownHandId = handId;
    }
    if (this.shown.has(seat)) return false;
    this.shown.set(seat, cards);
    this.broadcast({ t: 'cards_shown', handId, seat, cards });
    // a fold-winner proving 7-2 offsuit collects the bounty too
    this.trySevenDeuce(handId, seat, cards);
    return true;
  }

  /** Pays the 7-2 offsuit bounty to a verified winner, once per hand. */
  private trySevenDeuce(handId: string, seat: number, cards: CardId[]): void {
    const snap = this.lastHandShow;
    if (!snap || snap.handId !== handId || this.sevenDeucePaid.has(handId)) return;
    if (!snap.winnerSeats.includes(seat) || !isSevenDeuce(cards)) return;
    const room = getRoom(this.db, this.roomId);
    if (!room || room.seven_deuce_bonus <= 0) return;
    const winner = snap.bySeat.get(seat);
    if (!winner) return;
    this.sevenDeucePaid.add(handId);
    const bonus = room.seven_deuce_bonus;
    let total = 0;
    const apply = this.db.transaction(() => {
      for (const [payerSeat, payer] of snap.bySeat) {
        if (payerSeat === seat) continue;
        const row = this.db
          .prepare('SELECT stack FROM room_players WHERE room_id = ? AND user_id = ?')
          .get(this.roomId, payer.userId) as { stack: number } | undefined;
        const amt = Math.min(bonus, row?.stack ?? 0);
        if (amt <= 0) continue;
        appendLedger(this.db, {
          roomId: this.roomId,
          userId: payer.userId,
          delta: -amt,
          kind: 'seven-deuce',
          ref: handId,
          note: 'paid the 7-2 offsuit bounty',
        });
        this.db
          .prepare('UPDATE room_players SET stack = stack - ? WHERE room_id = ? AND user_id = ?')
          .run(amt, this.roomId, payer.userId);
        total += amt;
      }
      if (total > 0) {
        appendLedger(this.db, {
          roomId: this.roomId,
          userId: winner.userId,
          delta: total,
          kind: 'seven-deuce',
          ref: handId,
          note: 'won with 7-2 offsuit',
        });
        this.db
          .prepare('UPDATE room_players SET stack = stack + ? WHERE room_id = ? AND user_id = ?')
          .run(total, this.roomId, winner.userId);
      }
    });
    apply();
    if (total > 0) {
      this.broadcast({ t: 'seven_deuce', handId, seat, amount: total });
      this.broadcastRoomState();
    }
  }

  /** A show after the hand ended: verified against the finished hand's snapshot. */
  private onPostHandShow(userId: number, msg: Extract<ClientMsg, { t: 'show_cards' }>): void {
    const snap = this.lastHandShow;
    if (!snap || snap.handId !== msg.handId)
      return this.send(userId, { t: 'error', message: 'no such hand' });
    const entry = [...snap.bySeat.entries()].find(([, v]) => v.userId === userId);
    if (!entry) return this.send(userId, { t: 'error', message: 'you were not in that hand' });
    const [seat, v] = entry;
    if (this.shownHandId === msg.handId && this.shown.has(seat)) return;
    if (!verifyContent(v.pubkey, msg.handId, 'show_cards', signedBody(msg), msg.sig))
      return this.send(userId, { t: 'error', message: 'bad signature' });
    const cards = verifySnapshotShares(v, msg.shares, this.lookup);
    if (!cards) return this.send(userId, { t: 'error', message: 'invalid card reveal' });
    this.recordShow(msg.handId, seat, cards);
  }

  /** A paid request to privately see someone's cards from the last hand. */
  private onPeekOffer(userId: number, msg: Extract<ClientMsg, { t: 'peek_offer' }>): void {
    const snap = this.lastHandShow;
    if (this.hand || !snap || snap.handId !== msg.handId)
      return this.send(userId, { t: 'error', message: 'peek offers only work between hands' });
    const target = snap.bySeat.get(msg.targetSeat);
    if (!target)
      return this.send(userId, { t: 'error', message: 'that player was not in the last hand' });
    if (target.userId === userId)
      return this.send(userId, { t: 'error', message: 'those are your own cards' });
    if (
      snap.revealedSeats.has(msg.targetSeat) ||
      (this.shownHandId === msg.handId && this.shown.has(msg.targetSeat))
    )
      return this.send(userId, { t: 'error', message: 'those cards are already public' });
    const buyer = this.db
      .prepare(
        `SELECT rp.stack, COALESCE(u.display_name, u.username) as name
         FROM room_players rp JOIN users u ON u.id = rp.user_id
         WHERE rp.room_id = ? AND rp.user_id = ?`,
      )
      .get(this.roomId, userId) as { stack: number; name: string } | undefined;
    if (!buyer) return;
    if (buyer.stack < msg.amount)
      return this.send(userId, { t: 'error', message: 'not enough chips for that offer' });
    const offerId = randomBytes(6).toString('hex');
    this.peekOffers.set(offerId, {
      handId: msg.handId,
      fromUserId: userId,
      targetSeat: msg.targetSeat,
      amount: msg.amount,
    });
    this.send(target.userId, {
      t: 'peek_offer',
      offerId,
      handId: msg.handId,
      fromUserId: userId,
      fromName: buyer.name,
      targetSeat: msg.targetSeat,
      amount: msg.amount,
    });
  }

  private onPeekAnswer(
    userId: number,
    msg: Extract<ClientMsg, { t: 'peek_accept' } | { t: 'peek_decline' }>,
  ): void {
    const offer = this.peekOffers.get(msg.offerId);
    if (!offer || offer.handId !== msg.handId)
      return this.send(userId, { t: 'error', message: 'that offer is gone' });
    const snap = this.lastHandShow;
    const target = snap?.bySeat.get(offer.targetSeat);
    if (!snap || !target || target.userId !== userId)
      return this.send(userId, { t: 'error', message: 'that offer is not yours to answer' });
    this.peekOffers.delete(msg.offerId);
    if (msg.t === 'peek_decline') {
      this.send(offer.fromUserId, {
        t: 'peek_result',
        offerId: msg.offerId,
        handId: offer.handId,
        targetSeat: offer.targetSeat,
        status: 'declined',
        amount: offer.amount,
      });
      return;
    }
    if (this.hand) return this.send(userId, { t: 'error', message: 'a new hand already started' });
    if (!verifyContent(target.pubkey, offer.handId, 'peek_accept', signedBody(msg), msg.sig))
      return this.send(userId, { t: 'error', message: 'bad signature' });
    const cards = verifySnapshotShares(target, msg.shares, this.lookup);
    if (!cards) return this.send(userId, { t: 'error', message: 'invalid card reveal' });
    const buyerRow = this.db
      .prepare('SELECT stack FROM room_players WHERE room_id = ? AND user_id = ?')
      .get(this.roomId, offer.fromUserId) as { stack: number } | undefined;
    if (!buyerRow || buyerRow.stack < offer.amount)
      return this.send(userId, { t: 'error', message: 'the buyer no longer has enough chips' });
    const apply = this.db.transaction(() => {
      appendLedger(this.db, {
        roomId: this.roomId,
        userId: offer.fromUserId,
        delta: -offer.amount,
        kind: 'peek',
        ref: offer.handId,
        note: `paid to see seat ${offer.targetSeat + 1}'s cards`,
      });
      appendLedger(this.db, {
        roomId: this.roomId,
        userId,
        delta: offer.amount,
        kind: 'peek',
        ref: offer.handId,
        note: `showed cards privately`,
      });
      this.db
        .prepare('UPDATE room_players SET stack = stack - ? WHERE room_id = ? AND user_id = ?')
        .run(offer.amount, this.roomId, offer.fromUserId);
      this.db
        .prepare('UPDATE room_players SET stack = stack + ? WHERE room_id = ? AND user_id = ?')
        .run(offer.amount, this.roomId, userId);
    });
    apply();
    this.send(offer.fromUserId, {
      t: 'peek_result',
      offerId: msg.offerId,
      handId: offer.handId,
      targetSeat: offer.targetSeat,
      status: 'accepted',
      amount: offer.amount,
      cards,
    });
    this.broadcastRoomState();
  }
}

class Hand {
  /** Roaming never stops the crypto client or silently folds a live participant. */
  isContesting(userId: number): boolean {
    const player = this.seatOf(userId);
    return (
      this.phase !== 'done' &&
      !!player &&
      !this.betting?.seats.find((s) => s.seat === player.seat)?.folded
    );
  }
  readonly id: string;
  private phase:
    | 'commit'
    | 'shuffle'
    | 'deal'
    | 'betting'
    | 'multirun'
    | 'reveal'
    | 'audit'
    | 'done' = 'commit';
  private readonly n: number;
  private commits = new Map<number, Point>();
  private transcript = new Transcript();
  private deck: Point[] = initialDeck();
  private shuffleIdx = 0;
  private chains = new Map<number, Chain>();
  private holeFinal = new Map<number, Point>();
  private boardCards = new Map<number, CardId>();
  private pendingBoard = new Set<number>();
  private betting: BettingState | null = null;
  private actionSeq = 0;
  private reveals = new Map<number, CardId[]>();
  private shownSeats = new Set<number>();
  private startMsg: ServerMsg | null = null;
  private lastDeadline: number | null = null;
  private retriesLeft: number;
  private revealedKeys = new Map<number, string>();
  // fold-key escrow: a folding client hands its per-hand key to the SERVER
  // (never the transcript), so if the folder leaves, the server can compute
  // their unmask shares itself - with DLEQ proofs everyone can verify against
  // the folder's public commitment. Hands stop dying because a folder left.
  // Tradeoff, stated plainly: after your fold the server can decrypt YOUR two
  // cards (nobody else's). Requested by notpritam, docs/FEATURES.md.
  private foldedKeys = new Map<number, bigint>();
  private runout = false;
  // Bomb pot: blinds are skipped and everyone antes straight to the flop.
  private bombPot = false;
  // Multi-run: when the all-in runout has undealt cards, the player behind
  // chooses 1-3 runs and the player ahead has to agree. `runMaps` sends each
  // not-yet-open board position to the deck index that replaces it on runs 2..N.
  private runs = 1;
  private runMaps = new Map<number, Map<number, number>>();
  private multiRunResolved = false;
  // Explicit equity-pending state: while the worker computes, no offer is
  // visible yet. A reconnect in this window is safe and the offer is
  // broadcast to every live socket the moment equity resolves.
  private equityPending: { decisionId: string } | null = null;
  private multiRun: {
    decisionId: string;
    stage: 'choice' | 'agreement';
    behindSeat: number;
    aheadSeat: number;
    equities: { seat: number; bps: number }[];
    requestedRuns: 1 | 2 | 3;
    deadline: number;
  } | null = null;
  private squidSettlement: SquidSettlement | null = null;
  // Turn timing: one shared base clock per turn plus each actor's own bank.
  private turnBaseDeadline: number | null = null;
  private goneTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lookup = cardLookup();
  readonly commissionBps: number;
  private settlement: {
    awards: Map<number, number>;
    pokerDeltas: { seat: number; delta: number }[];
    stacks: { seat: number; stack: number }[];
    showdown: ServerMsg | null;
    rake: number;
    squid: SquidSettlement | null;
  } | null = null;

  constructor(
    private room: GameRoom,
    private db: DB,
    private roomId: string,
    private id_: string,
    private seats: HandSeatInfo[],
    private features: HandFeatureSnapshot,
    private buttonSeat: number,
    private sb: number,
    private bb: number,
    private auditMode: string,
    private serverId: Identity,
    private opts: GameOpts,
    private onDone: () => void,
  ) {
    this.id = id_;
    this.n = seats.length;
    this.retriesLeft = opts.cryptoRetries ?? 3;
    this.commissionBps = getRoom(db, roomId)!.commission_bps;
  }

  // ---------- lifecycle ----------

  begin(): void {
    this.appendServer('hand_start', {
      roomId: this.roomId,
      seats: this.seats.map((s) => ({
        seat: s.seat,
        userId: s.userId,
        pubkey: s.pubkey,
        stack: s.stack,
      })),
      buttonSeat: this.buttonSeat,
      sb: this.sb,
      bb: this.bb,
      commissionBps: this.commissionBps,
      ...(this.features.bomb.settings ? { bombPot: this.features.bomb.settings } : {}),
      ...(this.features.squid.settings ? { squid: this.features.squid.settings } : {}),
    });
    this.startMsg = {
      t: 'hand_start',
      handId: this.id,
      seats: this.seats.map((s) => ({
        seat: s.seat,
        userId: s.userId,
        username: s.username,
        publicKey: s.pubkey,
        stack: s.stack,
      })),
      buttonSeat: this.buttonSeat,
      sb: this.sb,
      bb: this.bb,
      auditMode: this.auditMode,
    };
    this.room.broadcast(this.startMsg);
    if (this.features.squid.settings)
      this.room.broadcast({
        t: 'feature_started',
        handId: this.id,
        squid: this.features.squid.settings,
      });
    this.armTimer(this.opts.cryptoTimeoutMs);
  }

  clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private armTimer(ms: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => this.onTimeout(), ms);
  }

  private onTimeout(): void {
    // give a stalled (often just disconnected) player a fixed grace window:
    // re-send whatever we are waiting on a few times before giving up
    if (
      this.phase !== 'betting' &&
      this.phase !== 'audit' &&
      this.phase !== 'multirun' &&
      this.phase !== 'done' &&
      this.retriesLeft > 0
    ) {
      this.retriesLeft--;
      this.renudge();
      this.armTimer(this.opts.cryptoTimeoutMs);
      return;
    }
    switch (this.phase) {
      case 'commit': {
        const missing = this.seats.find((s) => !this.commits.has(s.seat));
        this.abort('key commitment timeout', missing?.seat ?? null);
        return;
      }
      case 'shuffle': {
        this.abort('shuffle timeout', this.seats[this.shuffleIdx]?.seat ?? null);
        return;
      }
      case 'deal':
      case 'reveal': {
        // last stop before aborting: step over folded players via escrowed keys
        if (this.recoverStalledChains(true)) {
          this.armTimer(this.opts.cryptoTimeoutMs);
          return;
        }
        const waiting = [...this.chains.values()].find((c) => c.remaining.length > 0);
        this.abort('unmask timeout', waiting?.remaining[0] ?? null);
        return;
      }
      case 'betting': {
        const seat = this.betting?.toAct;
        if (seat === null || seat === undefined) return;
        this.appendServer('timeout_fold', { seat });
        this.applyEngineAction(seat, { type: 'fold' }, true);
        return;
      }
      case 'audit': {
        // an absent folder's escrowed key still fills in their TV-replay cards
        for (const [seat, k] of this.foldedKeys) {
          if (this.revealedKeys.has(seat) || this.reveals.has(seat)) continue;
          const orderIdx = this.seats.findIndex((x) => x.seat === seat);
          const cards: CardId[] = [];
          const inv = invScalar(k);
          for (const idx of this.holeIndexes(orderIdx)) {
            const pt = this.holeFinal.get(idx);
            if (!pt) continue;
            const card = recoverCard(mulPoint(pt, inv), this.lookup);
            if (card !== null) cards.push(card);
          }
          if (cards.length === 2) this.appendServer('hole_cards', { seat, cards });
        }
        this.finalizeSettlement();
        return;
      }
      case 'multirun': {
        // nobody answered the run-count stage in time: fall back to a single run
        this.finishMultiRun(1, 'timeout');
        return;
      }
      default:
        return;
    }
  }

  private abort(reason: string, blamedSeat: number | null): void {
    if (this.phase === 'done') return;
    this.clearTimer();
    this.phase = 'done';
    this.appendServer('hand_abort', { reason, blamedSeat });
    // an aborted hand moves no chips, no ledger rows and no time bank: put any
    // claimed manual trigger back so the next deal can pick it up again
    this.releaseFeatureClaims();
    // no sitting-out penalty: the next deal already skips disconnected players,
    // and punishing a flaky connection kept locking people out of their seat
    this.room.broadcast({ t: 'hand_abort', handId: this.id, reason, blamedSeat });
    this.onDone();
  }

  /** Abort path: un-claim the features this hand never settled. Scheduled
   *  triggers are cancelled (the schedule anchors themselves are only advanced
   *  at settlement, so the next deal re-triggers); manual triggers go pending. */
  private releaseFeatureClaims(): void {
    const { squid, bomb } = this.features;
    if (!squid.triggerId && !bomb.triggerId) return;
    this.db.transaction(() => {
      if (squid.triggerId) {
        this.db
          .prepare(
            "UPDATE room_feature_triggers SET status = 'pending', claimed_hand_id = NULL, resolved_at = NULL WHERE id = ? AND status = 'claimed'",
          )
          .run(squid.triggerId);
      }
      if (bomb.triggerId) {
        if (bomb.source === 'manual') {
          this.db
            .prepare(
              "UPDATE room_feature_triggers SET status = 'pending', claimed_hand_id = NULL, resolved_at = NULL WHERE id = ? AND status = 'claimed'",
            )
            .run(bomb.triggerId);
        } else {
          this.db
            .prepare(
              "UPDATE room_feature_triggers SET status = 'cancelled', resolved_at = ? WHERE id = ? AND status = 'claimed'",
            )
            .run(Date.now(), bomb.triggerId);
        }
      }
    })();
  }

  /** Re-send whatever request the stalled player(s) may have missed. */
  private renudge(): void {
    switch (this.phase) {
      case 'commit':
        if (this.startMsg)
          for (const s of this.seats)
            if (!this.commits.has(s.seat)) this.room.send(s.userId, this.startMsg);
        return;
      case 'shuffle':
        this.requestShuffle();
        return;
      case 'deal':
      case 'reveal':
        for (const chain of this.chains.values())
          if (chain.remaining.length > 0) this.kickChain(chain);
        return;
      default:
        return;
    }
  }

  /** Bring a (re)connecting participant fully back into the hand. */
  resendPending(userId: number): void {
    const info = this.seatOf(userId);
    if (!info || this.phase === 'done') return;
    if (this.startMsg) this.room.send(userId, this.startMsg);
    const orderIdx = this.seats.findIndex((s) => s.seat === info.seat);
    for (const idx of this.holeIndexes(orderIdx)) {
      const pt = this.holeFinal.get(idx);
      if (pt)
        this.room.send(userId, {
          t: 'your_card',
          handId: this.id,
          deckIndex: idx,
          point: pointHex(pt),
        });
    }
    for (const [deckIndex, card] of this.boardCards) {
      const run = this.runForDeckIndex(deckIndex);
      this.room.send(userId, {
        t: 'board_open',
        handId: this.id,
        deckIndex,
        card,
        ...(run > 1 ? { run: run as 2 | 3 } : {}),
      });
    }
    if (this.phase === 'shuffle' && this.seats[this.shuffleIdx]?.seat === info.seat) {
      this.requestShuffle();
    }
    if (this.phase === 'deal' || this.phase === 'reveal') {
      for (const chain of this.chains.values())
        if (chain.remaining[0] === info.seat) this.kickChain(chain);
    }
    if (this.phase === 'betting' && this.betting) {
      this.room.send(userId, {
        t: 'betting_state',
        handId: this.id,
        actionSeq: this.actionSeq,
        state: this.betting,
        board: this.currentBoard(),
        deadline: this.lastDeadline,
        baseDeadline: this.turnBaseDeadline,
        timeBanks: this.timeBankList(),
      });
    }
    if (this.phase === 'multirun') {
      // Resend the live stage. While `equityPending` (worker still running)
      // there is no visible offer yet; the offer is broadcast to every live
      // socket the moment equity resolves, so a reconnect in that window still
      // receives it.
      if (this.multiRun) this.sendMultiRunOffer(this.multiRun);
    }
    if (this.phase === 'audit' && !this.revealedKeys.has(info.seat)) {
      this.room.send(userId, { t: 'need_keys', handId: this.id });
    }
  }

  // ---------- transcript ----------

  private appendServer(type: string, payload: unknown): void {
    const sig = signContent(this.serverId.secretKey, this.id, type, payload);
    const e = this.transcript.append({ type, from: this.serverId.publicKey, payload, sig });
    this.room.broadcast({
      t: 'transcript_entry',
      handId: this.id,
      seq: e.seq,
      type,
      from: e.from,
      head: this.transcript.head,
    });
  }

  private appendPlayer(type: string, pubkey: string, payload: unknown, sig: string): void {
    const e = this.transcript.append({ type, from: pubkey, payload, sig });
    this.room.broadcast({
      t: 'transcript_entry',
      handId: this.id,
      seq: e.seq,
      type,
      from: e.from,
      head: this.transcript.head,
    });
  }

  // ---------- helpers ----------

  private seatOf(userId: number): HandSeatInfo | undefined {
    return this.seats.find((s) => s.userId === userId);
  }

  private holeIndexes(orderIdx: number): [number, number] {
    return [orderIdx, this.n + orderIdx];
  }

  private boardIndexes(): number[] {
    return [2 * this.n, 2 * this.n + 1, 2 * this.n + 2, 2 * this.n + 3, 2 * this.n + 4];
  }

  private err(userId: number, message: string): void {
    this.room.send(userId, { t: 'error', message });
  }

  // ---------- message entry ----------

  onMessage(userId: number, msg: ClientMsg): void {
    if (this.phase === 'done') return;
    const info = this.seatOf(userId);
    if (!info) return this.err(userId, 'not in this hand');
    if (
      msg.t === 'key_commit' ||
      msg.t === 'shuffle_deck' ||
      msg.t === 'unmask_share' ||
      msg.t === 'action' ||
      msg.t === 'reveal_key' ||
      msg.t === 'show_cards' ||
      msg.t === 'run_count_choice' ||
      msg.t === 'run_count_agree' ||
      msg.t === 'fold_key'
    ) {
      if (!verifyContent(info.pubkey, this.id, msg.t, signedBody(msg), msg.sig)) {
        return this.err(userId, 'bad signature');
      }
    }
    switch (msg.t) {
      case 'key_commit':
        return this.onKeyCommit(info, msg.commit, msg.sig);
      case 'shuffle_deck':
        return this.onShuffle(info, msg.deck, msg.sig);
      case 'unmask_share':
        return this.onUnmaskShare(info, msg.deckIndex, msg.out, msg.proof, msg.sig);
      case 'action':
        return this.onAction(info, msg.action, msg.sig);
      case 'reveal_key':
        return this.onRevealKey(info, msg.key, msg.sig);
      case 'show_cards':
        return this.onShowCards(info, msg.shares, msg.sig);
      case 'run_count_choice':
        return this.onRunCountChoice(info, msg.decisionId, msg.count, msg.sig);
      case 'run_count_agree':
        return this.onRunCountAgree(info, msg.decisionId, msg.agree, msg.sig);
      case 'fold_key':
        return this.onFoldKey(info, msg.key);
      default:
        return;
    }
  }

  // ---------- voluntary shows ----------

  /** Mid-hand a player may show their cards only once they have folded. */
  private onShowCards(
    info: HandSeatInfo,
    shares: { deckIndex: number; out: string; proof: { A1: string; A2: string; z: string } }[],
    sig: string,
  ): void {
    const folded = this.betting?.seats.find((s) => s.seat === info.seat)?.folded;
    if (!folded)
      return this.err(info.userId, 'you can show your cards after folding or once the hand ends');
    if (this.shownSeats.has(info.seat)) return;
    const cards = this.verifyShowShares(info.seat, shares);
    if (!cards) return this.err(info.userId, 'invalid card reveal');
    this.shownSeats.add(info.seat);
    this.appendPlayer('show_cards', info.pubkey, { shares }, sig);
    this.room.recordShow(this.id, info.seat, cards);
  }

  private verifyShowShares(
    seat: number,
    shares: { deckIndex: number; out: string; proof: { A1: string; A2: string; z: string } }[],
  ): CardId[] | null {
    const orderIdx = this.seats.findIndex((s) => s.seat === seat);
    const validIdx = new Set(this.holeIndexes(orderIdx));
    const commit = this.commits.get(seat);
    if (!commit) return null;
    const cards: CardId[] = [];
    const seen = new Set<number>();
    for (const sh of shares) {
      if (!validIdx.has(sh.deckIndex) || seen.has(sh.deckIndex)) return null;
      seen.add(sh.deckIndex);
      const pIn = this.holeFinal.get(sh.deckIndex);
      if (!pIn) return null;
      let out: Point;
      try {
        out = pointFromHex(sh.out);
      } catch {
        return null;
      }
      if (!verifyUnmask(commit, pIn, out, sh.proof)) return null;
      const card = recoverCard(out, this.lookup);
      if (card === null) return null;
      cards.push(card);
    }
    return cards;
  }

  /** What GameRoom needs to keep verifying shows after this hand is gone. */
  showSnapshot(): ShowSnapshot {
    const bySeat = new Map<number, SnapshotSeat>();
    for (let k = 0; k < this.n; k++) {
      const s = this.seats[k]!;
      const commit = this.commits.get(s.seat);
      if (!commit) continue;
      const cards = this.holeIndexes(k)
        .filter((i) => this.holeFinal.has(i))
        .map((i) => ({ deckIndex: i, point: this.holeFinal.get(i)! }));
      if (cards.length) bySeat.set(s.seat, { userId: s.userId, pubkey: s.pubkey, commit, cards });
    }
    const winnerSeats = this.settlement
      ? [...this.settlement.awards.entries()].filter(([, amt]) => amt > 0).map(([seat]) => seat)
      : [];
    return {
      handId: this.id,
      bySeat,
      revealedSeats: new Set(this.reveals.keys()),
      winnerSeats,
      reveals: new Map(this.reveals),
    };
  }

  // ---------- commit + shuffle ----------

  private onKeyCommit(info: HandSeatInfo, commitHex: string, sig: string): void {
    if (this.phase !== 'commit') return this.err(info.userId, 'not in commit phase');
    if (this.commits.has(info.seat)) return;
    let commit: Point;
    try {
      commit = pointFromHex(commitHex);
    } catch {
      return this.err(info.userId, 'bad commit point');
    }
    this.commits.set(info.seat, commit);
    this.retriesLeft = this.opts.cryptoRetries ?? 3;
    this.appendPlayer('key_commit', info.pubkey, { commit: commitHex }, sig);
    this.room.broadcast({
      t: 'key_commit_applied',
      handId: this.id,
      seat: info.seat,
      commit: commitHex,
    });
    if (this.commits.size === this.n) {
      this.phase = 'shuffle';
      this.requestShuffle();
    } else {
      this.armTimer(this.opts.cryptoTimeoutMs);
    }
  }

  private requestShuffle(): void {
    const seat = this.seats[this.shuffleIdx]!;
    this.room.send(seat.userId, {
      t: 'shuffle_turn',
      handId: this.id,
      seat: seat.seat,
      deck: this.deck.map(pointHex),
    });
    this.armTimer(this.opts.cryptoTimeoutMs);
  }

  private onShuffle(info: HandSeatInfo, deckHexes: string[], sig: string): void {
    if (this.phase !== 'shuffle') return this.err(info.userId, 'not in shuffle phase');
    if (this.seats[this.shuffleIdx]!.seat !== info.seat)
      return this.err(info.userId, 'not your shuffle turn');
    let points: Point[];
    try {
      points = deckHexes.map(pointFromHex);
    } catch {
      return this.abort('invalid deck from shuffler', info.seat);
    }
    if (new Set(deckHexes).size !== 52)
      return this.abort('shuffled deck has duplicates', info.seat);
    this.deck = points;
    this.retriesLeft = this.opts.cryptoRetries ?? 3;
    this.appendPlayer('shuffle_deck', info.pubkey, { deck: deckHexes }, sig);
    this.room.broadcast({ t: 'deck_state', handId: this.id, seat: info.seat, deck: deckHexes });
    this.shuffleIdx++;
    if (this.shuffleIdx < this.n) {
      this.requestShuffle();
    } else {
      this.phase = 'deal';
      this.startDealing();
    }
  }

  // ---------- dealing ----------

  private startDealing(): void {
    for (let k = 0; k < this.n; k++) {
      const recipient = this.seats[k]!;
      for (const idx of this.holeIndexes(k)) {
        const remaining = this.seats.filter((s) => s.seat !== recipient.seat).map((s) => s.seat);
        this.chains.set(idx, {
          deckIndex: idx,
          forSeat: recipient.seat,
          purpose: 'hole',
          current: this.deck[idx]!,
          remaining,
        });
      }
    }
    for (const chain of this.chains.values()) this.kickChain(chain);
    this.armTimer(this.opts.cryptoTimeoutMs);
  }

  private kickChain(chain: Chain): void {
    const seat = chain.remaining[0];
    if (seat === undefined) return;
    const info = this.seats.find((s) => s.seat === seat)!;
    // don't even ask a folded player who already left: recover on the spot
    const escrowed = this.foldedKeys.get(seat);
    if (escrowed && !this.room.isConnected(info.userId)) {
      this.applyRecoveredShare(chain, seat, escrowed);
      return;
    }
    this.room.send(info.userId, {
      t: 'need_share',
      handId: this.id,
      deckIndex: chain.deckIndex,
      point: pointHex(chain.current),
      forSeat: chain.forSeat,
      purpose: chain.purpose,
    });
  }

  private onUnmaskShare(
    info: HandSeatInfo,
    deckIndex: number,
    outHex: string,
    proof: { A1: string; A2: string; z: string },
    sig: string,
  ): void {
    const chain = this.chains.get(deckIndex);
    if (!chain || chain.remaining[0] !== info.seat)
      return this.err(info.userId, 'no share expected from you');
    let out: Point;
    try {
      out = pointFromHex(outHex);
    } catch {
      return this.abort('malformed unmask point', info.seat);
    }
    const commit = this.commits.get(info.seat)!;
    if (!verifyUnmask(commit, chain.current, out, proof)) {
      return this.abort('invalid unmask proof', info.seat);
    }
    this.retriesLeft = this.opts.cryptoRetries ?? 3;
    this.appendPlayer('unmask_share', info.pubkey, { deckIndex, out: outHex, proof }, sig);
    this.room.broadcast({
      t: 'share_applied',
      handId: this.id,
      deckIndex,
      seat: info.seat,
      // The last share of a showdown chain IS the plaintext card point.
      // Broadcasting each one as it landed let a player watch the reveals come
      // in, work out they had lost, and only then stall the hand - which is
      // what made aborting profitable. Showdown cards now go out together, in
      // `showdown`, once every chain has completed. See docs/SECURITY.md.
      out: chain.purpose === 'showdown' ? '' : outHex,
      forSeat: chain.forSeat,
    });
    chain.current = out;
    chain.remaining.shift();
    if (chain.remaining.length === 0) {
      this.chains.delete(deckIndex);
      this.chainDone(chain);
    } else {
      this.kickChain(chain);
      this.armTimer(this.opts.cryptoTimeoutMs);
    }
  }

  private chainDone(chain: Chain): void {
    if (this.phase === 'done') return;
    switch (chain.purpose) {
      case 'hole': {
        this.holeFinal.set(chain.deckIndex, chain.current);
        const recipient = this.seats.find((s) => s.seat === chain.forSeat)!;
        this.room.send(recipient.userId, {
          t: 'your_card',
          handId: this.id,
          deckIndex: chain.deckIndex,
          point: pointHex(chain.current),
        });
        if (this.holeFinal.size === 2 * this.n) this.startBetting();
        else this.armTimer(this.opts.cryptoTimeoutMs);
        return;
      }
      case 'board': {
        const card = recoverCard(chain.current, this.lookup);
        if (card === null)
          return this.abort(
            `opened board point at index ${chain.deckIndex} is not a card (mis-shuffle)`,
            null,
          );
        this.boardCards.set(chain.deckIndex, card);
        const run = this.runForDeckIndex(chain.deckIndex);
        this.appendServer('board_open', {
          deckIndex: chain.deckIndex,
          card,
          ...(run > 1 ? { run } : {}),
        });
        this.room.broadcast({
          t: 'board_open',
          handId: this.id,
          deckIndex: chain.deckIndex,
          card,
          ...(run > 1 ? { run: run as 2 | 3 } : {}),
        });
        this.pendingBoard.delete(chain.deckIndex);
        if (this.pendingBoard.size === 0) this.afterBoardOpened();
        else this.armTimer(this.opts.cryptoTimeoutMs);
        return;
      }
      case 'showdown': {
        const card = recoverCard(chain.current, this.lookup);
        if (card === null)
          return this.abort(
            `revealed hole point at index ${chain.deckIndex} is not a card (mis-shuffle)`,
            null,
          );
        const list = this.reveals.get(chain.forSeat!) ?? [];
        list.push(card);
        this.reveals.set(chain.forSeat!, list);
        const needed = this.betting!.seats.filter((s) => !s.folded).length;
        const complete = [...this.reveals.values()].filter((c) => c.length === 2).length;
        if (complete === needed) this.afterRevealsComplete();
        else this.armTimer(this.opts.cryptoTimeoutMs);
        return;
      }
    }
  }

  // ---------- betting ----------

  private startBetting(): void {
    if (this.features.bomb.settings) {
      this.startBombBetting();
      return;
    }
    this.phase = 'betting';
    this.betting = startHand(
      this.seats.map((s) => ({ seat: s.seat, stack: s.stack })),
      this.buttonSeat,
      this.sb,
      this.bb,
    );
    this.appendServer('betting_start', { street: 'preflop' });
    this.coordinateTurn(true);
  }

  /** Bomb pot: everyone antes, blinds and preflop betting are skipped, and the
   *  flop opens straight away. Short stacks ante what they have and are all-in. */
  private startBombBetting(): void {
    const { ante, anteBb, settings } = this.features.bomb;
    this.phase = 'betting';
    this.bombPot = true;
    this.betting = startBombPot(
      this.seats.map((s) => ({ seat: s.seat, stack: s.stack })),
      this.buttonSeat,
      this.bb,
      ante,
    );
    // No preflop betting round exists in a bomb pot: do NOT record a
    // `betting_start {street:'preflop'}` (it would imply legal preflop
    // actions). The ante is the only preflop event; action begins on the flop.
    this.appendServer('bomb_pot_start', {
      ante,
      anteBb,
      seats: this.seats.map((s) => ({ seat: s.seat, stack: s.stack })),
    });
    this.room.broadcast({
      t: 'feature_started',
      handId: this.id,
      ...(settings ? { bombPot: settings } : {}),
    });
    // Open the flop directly. `streetIndexesToOpen` reads `preflop` here, so it
    // returns the three flop positions; afterBoardOpened then switches to flop
    // betting without dealing the turn.
    this.openNextStreetBoards();
  }

  /** actionTimeoutMs of 0 means unlimited thinking time: no timer, no auto-fold. */
  private finishTurnTimer(): void {
    this.clearTimer();
  }

  /**
   * Start the clock for whoever is to act. The shared base clock is the host's
   * turn time; a seat's own time bank extends it. A fresh deadline is minted
   * ONLY here - `broadcastBetting` just re-sends whatever is current.
   */
  private beginTurnTimer(): void {
    this.finishTurnTimer();
    const st = this.betting;
    if (!st || st.toAct === null || this.opts.actionTimeoutMs <= 0) {
      this.turnBaseDeadline = null;
      this.lastDeadline = null;
      return;
    }
    const now = Date.now();
    this.turnBaseDeadline = now + this.opts.actionTimeoutMs;
    const bank = this.timeBanks().get(st.toAct) ?? 0;
    this.lastDeadline = this.turnBaseDeadline + bank;
    this.armTimer(this.lastDeadline - now);
  }

  /** Debit the time this action consumed past the base clock, clamped to the
   *  seat's remaining bank. Called only after an action was successfully applied. */
  private consumeTurnTime(seat: number): void {
    const bank = this.features.timeBank;
    if (!bank || this.turnBaseDeadline === null) return;
    const spent = Math.max(0, Date.now() - this.turnBaseDeadline);
    const current = bank.balances.get(seat) ?? 0;
    const used = Math.min(spent, current);
    if (used <= 0) return;
    bank.balances.set(seat, current - used);
    this.room.broadcast({
      t: 'time_bank_update',
      handId: this.id,
      seat,
      remainingMs: current - used,
    });
  }

  private timeBanks(): Map<number, number> {
    const bank = this.features.timeBank;
    return bank ? bank.balances : new Map<number, number>();
  }

  private timeBankList(): { seat: number; remainingMs: number }[] | undefined {
    const bank = this.features.timeBank;
    if (!bank) return undefined;
    return this.seats.map((s) => ({ seat: s.seat, remainingMs: bank.balances.get(s.seat) ?? 0 }));
  }

  private broadcastBetting(): void {
    this.room.broadcast({
      t: 'betting_state',
      handId: this.id,
      actionSeq: this.actionSeq,
      state: this.betting!,
      board: this.currentBoard(),
      deadline: this.lastDeadline,
      baseDeadline: this.turnBaseDeadline,
      timeBanks: this.timeBankList(),
    });
  }

  private currentBoard(): CardId[] {
    return this.boardIndexes()
      .filter((i) => this.boardCards.has(i))
      .map((i) => this.boardCards.get(i)!);
  }

  private onAction(info: HandSeatInfo, action: PlayerAction, sig: string): void {
    if (this.phase !== 'betting' || !this.betting)
      return this.err(info.userId, 'not in a betting round');
    // Server-side deadline enforcement: at/after the final deadline the ONLY
    // successful transition is the timeout auto-fold. A late action arriving
    // before the timer callback fires is rejected here so a race cannot beat it.
    if (this.lastDeadline !== null && Date.now() >= this.lastDeadline) {
      this.appendServer('action_rejected', { seat: info.seat, reason: 'after deadline' });
      return this.err(info.userId, 'the action clock expired');
    }
    // Apply first; the transcript only records an action that actually applied.
    this.applyEngineAction(info.seat, action, false, info.userId, { pubkey: info.pubkey, sig });
  }

  /** Apply an engine action. Returns true only if it was accepted. When
   *  `record` is supplied the player's signed action is appended to the
   *  transcript after a successful apply (never before, so rejected, stale or
   *  duplicate actions never appear as normal `action` entries). */
  private applyEngineAction(
    seat: number,
    action: PlayerAction,
    auto: boolean,
    userId?: number,
    record?: { pubkey: string; sig: string },
  ): boolean {
    try {
      this.betting = applyAction(this.betting!, seat, action);
    } catch (e) {
      // an illegal, out-of-turn, stale or duplicate action must not consume the
      // actor's time bank and must not be recorded as a normal action
      const reason = e instanceof Error ? e.message : 'illegal action';
      this.appendServer('action_rejected', { seat, reason });
      if (userId !== undefined) this.err(userId, reason);
      return false;
    }
    if (record) this.appendPlayer('action', record.pubkey, { action, seat }, record.sig);
    // the action really applied: charge the clock it used past the base deadline
    this.consumeTurnTime(seat);
    this.actionSeq++;
    this.room.broadcast({
      t: 'action_applied',
      handId: this.id,
      seat,
      action,
      ...(auto ? { auto: true } : {}),
    });
    this.coordinateTurn();
    return true;
  }

  /**
   * The single turn coordinator. Either a new turn begins (fresh deadline +
   * betting broadcast), or the street is closed and the hand advances to the
   * next street / runout / settlement. Every path out of a betting change goes
   * through here so `toAct = null` can never stall the hand.
   */
  private coordinateTurn(initial = false): void {
    const st = this.betting!;
    if (!streetClosed(st)) {
      if (!initial) this.finishTurnTimer();
      this.beginTurnTimer();
      this.broadcastBetting();
      return;
    }
    this.finishTurnTimer();
    if (st.winnerByFold !== null) {
      this.settle();
      return;
    }
    if (activeNonAllIn(st) < 2) {
      // Everyone is all-in: reveal the hole cards BEFORE any runout decision,
      // then decide how many times to run the board.
      this.runout = true;
      this.requestReveals();
      return;
    }
    if (st.street === 'river') {
      this.requestReveals();
      return;
    }
    this.openNextStreetBoards();
  }

  private streetIndexesToOpen(): number[] {
    const base = 2 * this.n;
    switch (this.betting!.street) {
      case 'preflop':
        return [base, base + 1, base + 2];
      case 'flop':
        return [base + 3];
      case 'turn':
        return [base + 4];
      default:
        return [];
    }
  }

  private openNextStreetBoards(): void {
    this.phase = 'deal';
    const idxs = this.streetIndexesToOpen().filter((i) => !this.boardCards.has(i));
    this.pendingBoard = new Set(idxs);
    for (const idx of idxs) {
      const chain: Chain = {
        deckIndex: idx,
        forSeat: null,
        purpose: 'board',
        current: this.deck[idx]!,
        remaining: this.seats.map((s) => s.seat),
      };
      this.chains.set(idx, chain);
      this.kickChain(chain);
    }
    this.armTimer(this.opts.cryptoTimeoutMs);
  }

  private afterBoardOpened(): void {
    if (this.runout) {
      const remaining = this.runoutIndexes().filter((i) => !this.boardCards.has(i));
      if (remaining.length === 0) {
        this.settle();
      } else {
        this.openRemainingRunoutBoards();
      }
      return;
    }
    if (this.bombPot && this.betting!.street === 'preflop') {
      // the flop just opened; bomb pots never see a preflop betting round
      this.bombPot = false;
      this.betting = nextStreet(this.betting!);
      if (activeNonAllIn(this.betting) < 2) {
        this.runout = true;
        this.requestReveals();
        return;
      }
      this.phase = 'betting';
      this.appendServer('street', { street: this.betting.street, board: this.currentBoard() });
      this.coordinateTurn(true);
      return;
    }
    this.betting = nextStreet(this.betting!);
    this.phase = 'betting';
    this.appendServer('street', { street: this.betting.street, board: this.currentBoard() });
    this.coordinateTurn(true);
  }

  private openRemainingRunoutBoards(): void {
    this.phase = 'deal';
    const next = this.runoutIndexes().find((i) => !this.boardCards.has(i));
    if (next === undefined) {
      this.settle();
      return;
    }
    this.pendingBoard = new Set([next]);
    const chain: Chain = {
      deckIndex: next,
      forSeat: null,
      purpose: 'board',
      current: this.deck[next]!,
      remaining: this.seats.map((s) => s.seat),
    };
    this.chains.set(next, chain);
    this.kickChain(chain);
    this.armTimer(this.opts.cryptoTimeoutMs);
  }

  // ---------- fold-key escrow and share recovery ----------

  private onFoldKey(info: HandSeatInfo, keyHex: string): void {
    if (this.phase === 'done' || this.foldedKeys.has(info.seat)) return;
    const folded = this.betting?.seats.find((s) => s.seat === info.seat)?.folded;
    if (!folded) return; // only a folded player may escrow
    try {
      const k = BigInt('0x' + keyHex);
      const commit = this.commits.get(info.seat);
      if (!commit || pointHex(handKeyCommit(k)) !== pointHex(commit)) return;
      this.foldedKeys.set(info.seat, k);
    } catch {
      /* malformed key: ignore */
    }
    // if their chains were already stalled (fold raced a disconnect), move now
    this.recoverStalledChains(false);
  }

  /** A player's socket dropped. Before betting starts nothing is at stake, so
   *  after a short reconnect grace the hand aborts and the auto-redeal simply
   *  skips them - no more minutes-long waits on someone who closed the tab.
   *  Later in the hand, chains stalled on a folded-and-escrowed seat advance
   *  without them (requested by notpritam, docs/FEATURES.md). */
  onPlayerGone(userId: number): void {
    const info = this.seatOf(userId);
    if (!info) return;
    const preBetting = () =>
      this.phase === 'commit' ||
      this.phase === 'shuffle' ||
      (this.phase === 'deal' && !this.betting);
    if (preBetting()) {
      if (this.goneTimer) return;
      this.goneTimer = setTimeout(() => {
        this.goneTimer = null;
        if (preBetting() && !this.room.isConnected(info.userId)) {
          this.abort('player left during the deal', info.seat);
        }
      }, 4000);
      return;
    }
    if (this.phase !== 'deal' && this.phase !== 'reveal') return;
    // a folded player's escrowed key lets us finish without them
    if (this.recoverStalledChains(false)) return;
    this.foldDroppedIfDecisive(info.seat);
  }

  /** A live player who drops mid-unmask cannot send their shares, and nobody
   *  else holds their key, so the hand is otherwise guaranteed to die on an
   *  unmask timeout. Poker's own answer is that they fold - and if folding them
   *  leaves exactly one player contesting the pot, the hand is already decided
   *  and needs no card opened at all. See docs/DROPS.md.
   *
   *  With two or more still live we genuinely need their key, and that is what
   *  deal-time threshold escrow is for; until then this correctly does nothing
   *  and the hand takes the timeout. */
  private foldDroppedIfDecisive(seat: number): void {
    const st = this.betting;
    if (!st || st.winnerByFold !== null) return;
    const mine = st.seats.find((s) => s.seat === seat);
    if (!mine || mine.folded) return;
    const seats = st.seats.map((s) => (s.seat === seat ? { ...s, folded: true } : { ...s }));
    const live = seats.filter((s) => !s.folded);
    if (live.length !== 1) return;

    this.clearTimer();
    this.chains.clear();
    this.pendingBoard.clear();
    this.appendServer('timeout_fold', { seat });
    this.room.broadcast({
      t: 'action_applied',
      handId: this.id,
      seat,
      action: { type: 'fold' },
      auto: true,
    });
    this.betting = { ...st, seats, toAct: null, needToAct: [], winnerByFold: live[0]!.seat };
    this.settle();
  }

  /** Compute the absent folder's share ourselves. The DLEQ proof published in
   *  the transcript verifies against their key commitment, so the recovery is
   *  as auditable as a share they sent themselves. */
  private applyRecoveredShare(chain: Chain, seat: number, k: bigint): void {
    const { out, proof } = proveUnmask(k, chain.current);
    this.appendServer('recovered_share', {
      seat,
      deckIndex: chain.deckIndex,
      out: pointHex(out),
      proof,
    });
    this.room.broadcast({
      t: 'share_applied',
      handId: this.id,
      deckIndex: chain.deckIndex,
      seat,
      out: pointHex(out),
      forSeat: chain.forSeat,
    });
    chain.current = out;
    chain.remaining.shift();
    if (chain.remaining.length === 0) {
      this.chains.delete(chain.deckIndex);
      this.chainDone(chain);
    } else {
      this.kickChain(chain);
    }
  }

  /** Advance every chain whose head seat folded and escrowed a key. With
   *  `force` (timeout, retries spent) connectivity is ignored; otherwise only
   *  disconnected seats are stepped over. Returns true if anything moved. */
  private recoverStalledChains(force: boolean): boolean {
    let recoveredAny = false;
    let progress = true;
    while (progress && this.phase !== 'done') {
      progress = false;
      for (const chain of [...this.chains.values()]) {
        if (this.chains.get(chain.deckIndex) !== chain) continue; // completed meanwhile
        const seat = chain.remaining[0];
        if (seat === undefined) continue;
        const k = this.foldedKeys.get(seat);
        if (!k) continue;
        const info = this.seats.find((s) => s.seat === seat)!;
        if (!force && this.room.isConnected(info.userId)) continue;
        this.applyRecoveredShare(chain, seat, k);
        recoveredAny = true;
        progress = true;
      }
    }
    return recoveredAny;
  }

  // ---------- multi-run negotiation ----------

  /** The deck positions that make up one run's board. Runs 2..N map any card
   *  still hidden at decision time to a fresh deck index; cards already seen are
   *  shared with run 1. */
  private runBoardIndexes(run: number): number[] {
    const base = this.boardIndexes();
    if (run <= 1) return base;
    const map = this.runMaps.get(run);
    return base.map((pos) => map?.get(pos) ?? pos);
  }

  private boardForRun(run: number): CardId[] {
    return this.runBoardIndexes(run).map((i) => this.boardCards.get(i)!);
  }

  private runForDeckIndex(idx: number): number {
    for (const [run, map] of this.runMaps) {
      for (const v of map.values()) if (v === idx) return run;
    }
    return 1;
  }

  /** Every deck index the runout still has to open: run 1 first, then 2, then 3. */
  private runoutIndexes(): number[] {
    const out: number[] = [];
    for (let run = 1; run <= this.runs; run++) {
      for (const idx of this.runBoardIndexes(run)) if (!out.includes(idx)) out.push(idx);
    }
    return out;
  }

  private remainingRunoutCount(): number {
    return this.runoutIndexes().filter((i) => !this.boardCards.has(i)).length;
  }

  /** Wire `stage` values are `choice` (= the contract's "behind-chooses") and
   *  `agreement` (= "ahead-agrees"), matching `MultiRunStage` in
   *  packages/shared/src/wsProtocol.ts. See docs/p2-gameplay-design.md 2.6. */
  private sendMultiRunOffer(state: NonNullable<Hand['multiRun']>): void {
    this.room.broadcast({
      t: 'multi_run_offer',
      handId: this.id,
      decisionId: state.decisionId,
      stage: state.stage,
      aheadSeat: state.aheadSeat,
      behindSeat: state.behindSeat,
      equities: state.equities,
      ...(state.stage === 'agreement' ? { requestedRuns: state.requestedRuns } : {}),
      deadlineTs: state.deadline,
    });
  }

  /** Decide whether the all-in runout can be negotiated, then ask the player
   *  behind how many times to run. Every ineligible path resolves to one run. */
  private beginMultiRunDecision(): void {
    if (this.multiRunResolved) return;
    const st = this.betting!;
    const remaining = this.remainingRunoutCount();
    const live = st.seats.filter((s) => !s.folded);
    if (!this.features.multiRun.enabled) return this.finishMultiRun(1, 'disabled');
    if (live.length !== 2) return this.finishMultiRun(1, 'ineligible');
    if (remaining <= 0) return this.finishMultiRun(1, 'ineligible');
    const a = live[0]!;
    const b = live[1]!;
    const cardsA = this.reveals.get(a.seat);
    const cardsB = this.reveals.get(b.seat);
    if (!cardsA || !cardsB || cardsA.length !== 2 || cardsB.length !== 2)
      return this.finishMultiRun(1, 'ineligible');

    // The reveal/crypto timer is spent; the decision timer starts only once the
    // equity worker has produced an offer to answer.
    this.clearTimer();
    this.phase = 'multirun';
    const decisionId = randomBytes(6).toString('hex');
    this.equityPending = { decisionId };
    computeHeadsUpEquity({
      holeA: [cardsA[0]!, cardsA[1]!],
      holeB: [cardsB[0]!, cardsB[1]!],
      board: this.currentBoard(),
      seed: `${this.id}:${decisionId}`,
    })
      .then((eq) => {
        if (this.phase === 'done' || this.multiRunResolved) return;
        this.equityPending = null;
        if (eq.equitiesBps[0] === eq.equitiesBps[1])
          return this.finishMultiRun(1, 'ineligible');
        const aAhead = eq.equitiesBps[0] > eq.equitiesBps[1];
        const ms = this.opts.ritVoteMs ?? 15_000;
        this.multiRun = {
          decisionId,
          stage: 'choice',
          aheadSeat: aAhead ? a.seat : b.seat,
          behindSeat: aAhead ? b.seat : a.seat,
          equities: [
            { seat: a.seat, bps: eq.equitiesBps[0] },
            { seat: b.seat, bps: eq.equitiesBps[1] },
          ],
          requestedRuns: 1,
          deadline: Date.now() + ms,
        };
        this.appendServer('multi_run_offer', {
          decisionId,
          stage: 'choice',
          aheadSeat: this.multiRun.aheadSeat,
          behindSeat: this.multiRun.behindSeat,
          equities: this.multiRun.equities,
        });
        this.sendMultiRunOffer(this.multiRun);
        this.armTimer(ms);
      })
      .catch((err) => {
        if (this.phase === 'done' || this.multiRunResolved) return;
        this.equityPending = null;
        this.appendServer('equity_failed', {
          decisionId,
          reason: err instanceof EquityError ? err.code : 'equity_failed',
        });
        this.finishMultiRun(1, 'equity_failed');
      });
  }

  private onRunCountChoice(
    info: HandSeatInfo,
    decisionId: string,
    count: 1 | 2 | 3,
    sig: string,
  ): void {
    if (this.phase !== 'multirun' || !this.multiRun) return;
    if (this.multiRun.decisionId !== decisionId) return; // stale decision
    if (this.multiRun.stage !== 'choice') return; // wrong stage / duplicate
    if (info.seat !== this.multiRun.behindSeat) return; // wrong role
    // Engine-side clamp: never trust the wire for the run ceiling. Reject
    // before mutating the stage so a bad count cannot desync both players.
    const maxRuns = Math.max(1, Math.min(3, this.features.multiRun.maxRuns));
    if (!Number.isInteger(count) || count < 1 || count > maxRuns) {
      this.appendServer('run_count_rejected', { seat: info.seat, decisionId, count, maxRuns });
      return this.err(info.userId, `run count must be between 1 and ${maxRuns}`);
    }
    this.appendPlayer('run_count_choice', info.pubkey, { decisionId, count, seat: info.seat }, sig);
    if (count === 1) return this.finishMultiRun(1, 'agreed');
    const ms = this.opts.ritVoteMs ?? 15_000;
    this.multiRun.stage = 'agreement';
    this.multiRun.requestedRuns = count;
    this.multiRun.deadline = Date.now() + ms;
    this.sendMultiRunOffer(this.multiRun);
    this.armTimer(ms);
  }

  private onRunCountAgree(info: HandSeatInfo, decisionId: string, agree: boolean, sig: string): void {
    if (this.phase !== 'multirun' || !this.multiRun) return;
    if (this.multiRun.decisionId !== decisionId) return; // stale decision
    if (this.multiRun.stage !== 'agreement') return; // wrong stage / duplicate
    if (info.seat !== this.multiRun.aheadSeat) return; // wrong role
    this.appendPlayer('run_count_agree', info.pubkey, { decisionId, agree, seat: info.seat }, sig);
    this.finishMultiRun(agree ? this.multiRun.requestedRuns : 1, agree ? 'agreed' : 'declined');
  }

  /** Lock in the run count, seed runs 2..N's board positions from the untouched
   *  tail of the deck, and deal them out. A deck that cannot fit every run falls
   *  back to a single run. */
  private finishMultiRun(runs: number, reason: MultiRunResultReason): void {
    if (this.multiRunResolved) return;
    this.multiRunResolved = true;
    this.clearTimer();
    this.multiRun = null;
    this.equityPending = null;
    let resolved = runs;
    if (resolved > 1) {
      let extra = 2 * this.n + 5;
      const maps = new Map<number, Map<number, number>>();
      let fits = true;
      for (let run = 2; run <= resolved; run++) {
        const map = new Map<number, number>();
        for (const pos of this.boardIndexes()) {
          if (this.boardCards.has(pos)) continue; // shared card from run 1
          if (extra >= 52) {
            fits = false;
            break;
          }
          map.set(pos, extra++);
        }
        if (!fits) break;
        maps.set(run, map);
      }
      if (fits) this.runMaps = maps;
      else resolved = 1;
    }
    this.runs = resolved;
    this.appendServer('multi_run_result', { runs: resolved, reason });
    this.room.broadcast({
      t: 'multi_run_result',
      handId: this.id,
      runs: resolved,
      reason,
      sharedBoard: this.currentBoard(),
    } as ServerMsg);
    if (this.remainingRunoutCount() > 0) this.openRemainingRunoutBoards();
    else this.settle();
  }

  // ---------- showdown ----------

  private requestReveals(): void {
    this.phase = 'reveal';
    const revealing = this.betting!.seats.filter((s) => !s.folded);
    for (const s of revealing) {
      const orderIdx = this.seats.findIndex((x) => x.seat === s.seat);
      for (const idx of this.holeIndexes(orderIdx)) {
        const chain: Chain = {
          deckIndex: idx,
          forSeat: s.seat,
          purpose: 'showdown',
          current: this.holeFinal.get(idx)!,
          remaining: [s.seat],
        };
        this.chains.set(idx, chain);
        this.kickChain(chain);
      }
    }
    this.armTimer(this.opts.cryptoTimeoutMs);
  }

  private afterRevealsComplete(): void {
    if (this.runout && !this.multiRunResolved) {
      // hole cards are now public: decide the run count before dealing on
      this.beginMultiRunDecision();
      return;
    }
    if (this.runout && this.remainingRunoutCount() > 0) {
      this.openRemainingRunoutBoards();
      return;
    }
    this.settle();
  }

  // ---------- settlement ----------

  private settle(): void {
    this.clearTimer();
    const st = this.betting!;
    const board = this.currentBoard();
    const pots = computePots(st.seats);
    // Deduct the room's commission before awards, floored per pot. Snapshot
    // the rate at deal time and record the same rate in the transcript and ledger.
    let rake = 0;
    for (const p of pots) {
      const cut = commissionForPot(p.amount, this.commissionBps);
      p.amount -= cut;
      rake += cut;
    }
    const dealingOrder = this.seats.map((s) => s.seat);
    const runs = this.runs;
    const awards = new Map<number, number>();
    let showdownMsg: ServerMsg | null = null;
    /** Per-run winner sets, used for the squid intersection. */
    let winnerSets: number[][] = [];

    if (st.winnerByFold !== null) {
      awards.set(st.winnerByFold, pots.reduce((s, p) => s + p.amount, 0));
      winnerSets = [[st.winnerByFold]];
    } else {
      const revealList: { seat: number; cards: CardId[]; score: number }[] = [];
      for (const [seat, cards] of this.reveals) revealList.push({ seat, cards, score: 0 });

      if (runs > 1) {
        const boards: CardId[][] = [];
        const perRun: { seat: number; amount: number }[][] = [];
        // every pot splits across the runs; the odd chip rides on the earlier run
        const slicesByPot = pots.map((p) => splitAmountEven(p.amount, runs));
        const runWinnerSets: number[][] = [];
        for (let r = 0; r < runs; r++) {
          const runBoard = this.boardForRun(r + 1);
          boards.push(runBoard);
          const scores = new Map<number, number>();
          for (const [seat, cards] of this.reveals) {
            const score = evaluate7([...cards, ...runBoard]);
            scores.set(seat, score);
            if (r === 0) {
              const entry = revealList.find((x) => x.seat === seat);
              if (entry) entry.score = score;
            }
          }
          const slicePots = pots.map((p, i) => ({
            amount: slicesByPot[i]![r]!,
            eligible: p.eligible,
          }));
          const awardsR = awardPots(slicePots, scores, dealingOrder);
          perRun.push([...awardsR.entries()].map(([seat, amount]) => ({ seat, amount })));
          runWinnerSets.push(bestScoreSeats([...scores.keys()], scores));
          for (const [seat, amount] of awardsR) awards.set(seat, (awards.get(seat) ?? 0) + amount);
        }
        winnerSets = runWinnerSets;
        showdownMsg = {
          t: 'showdown',
          handId: this.id,
          reveals: revealList,
          awards: [...awards.entries()].map(([seat, amount]) => ({ seat, amount })),
          multiRun: { boards, awards: perRun },
        };
      } else {
        const scores = new Map<number, number>();
        for (const [seat, cards] of this.reveals) {
          const score = evaluate7([...cards, ...board]);
          scores.set(seat, score);
          const entry = revealList.find((x) => x.seat === seat);
          if (entry) entry.score = score;
        }
        const awards1 = awardPots(pots, scores, dealingOrder);
        for (const [seat, amount] of awards1) awards.set(seat, amount);
        winnerSets = [bestScoreSeats([...scores.keys()], scores)];
        showdownMsg = {
          t: 'showdown',
          handId: this.id,
          reveals: revealList,
          awards: [...awards.entries()].map(([seat, amount]) => ({ seat, amount })),
        };
      }
    }

    const pokerDeltas = st.seats.map((s) => ({
      seat: s.seat,
      delta: (awards.get(s.seat) ?? 0) - s.total,
    }));
    const pokerStacks = st.seats.map((s) => ({
      seat: s.seat,
      stack: s.stack + (awards.get(s.seat) ?? 0),
    }));
    // Squid is assessed on the stacks as they stand after the poker pot pays out.
    const squid = this.settleSquid(winnerSets, pokerStacks);
    const stacks = pokerStacks.map((s) => ({
      seat: s.seat,
      stack: s.stack + (squid?.netBySeat.get(s.seat) ?? 0),
    }));
    this.settlement = { awards, pokerDeltas, stacks, showdown: showdownMsg, rake, squid };

    // Invariants checked BEFORE anything is persisted. A violation is a
    // programming error and must never reach the ledger.
    const totalPot = pots.reduce((s, p) => s + p.amount, 0);
    const awardTotal = [...awards.values()].reduce((s, a) => s + a, 0);
    if (awardTotal !== totalPot)
      throw new Error(`awards ${awardTotal} != pot ${totalPot} on hand ${this.id}`);
    if (pokerDeltas.reduce((s, d) => s + d.delta, 0) !== -rake)
      throw new Error(`poker deltas are not zero-sum net of rake on hand ${this.id}`);
    if (squid) {
      const squidNet = [...squid.netBySeat.values()].reduce((s, v) => s + v, 0);
      if (squidNet !== 0) throw new Error(`squid net ${squidNet} != 0 on hand ${this.id}`);
      for (const p of squid.paidBySeat) {
        if (p.amount < 0 || p.amount > squid.requestedPerLoser)
          throw new Error(`squid payment ${p.amount} out of range on hand ${this.id}`);
      }
    }
    const combined = pokerDeltas.map((d) => ({
      seat: d.seat,
      delta: d.delta + (squid?.netBySeat.get(d.seat) ?? 0),
    }));
    const netBySeat = [...(squid?.netBySeat.entries() ?? [])].map(([seat, net]) => ({ seat, net }));
    this.appendServer('settlement', {
      board,
      ...(runs > 1
        ? { boards: Array.from({ length: runs }, (_, i) => this.boardForRun(i + 1)) }
        : {}),
      ...(rake > 0 ? { commission: rake } : {}),
      awards: [...awards.entries()].map(([seat, amount]) => ({ seat, amount })),
      deltas: combined,
      ...(squid
        ? {
            squid: {
              winners: squid.winners,
              requestedPerLoser: squid.requestedPerLoser,
              noClaimant: squid.noClaimant,
              netBySeat,
            },
          }
        : {}),
      reveals:
        showdownMsg && showdownMsg.t === 'showdown'
          ? showdownMsg.reveals.map((r) => ({ seat: r.seat, cards: r.cards }))
          : [],
    });
    if (showdownMsg) this.room.broadcast(showdownMsg);
    if (squid)
      // `netBySeat` is the authoritative per-seat outcome: with multiple losers
      // a seat can both pay and receive, so consumers must not assume only
      // `winners` receive chips.
      this.room.broadcast({
        t: 'squid_result',
        handId: this.id,
        winners: squid.winners,
        transfers: squid.transfers,
        requestedPerLoser: squid.requestedPerLoser,
        paidBySeat: squid.paidBySeat,
        noClaimant: squid.noClaimant,
        netBySeat,
      } as ServerMsg);

    if (this.auditMode === 'strict-audit' || this.opts.tvReplays) {
      // TV replays: collect everyone's per-hand key so the stored transcript
      // can show ALL hole cards, WSOP broadcast style. Settlement still
      // happens on timeout if someone vanishes - keys are best-effort.
      // (requested by notpritam, docs/FEATURES.md)
      this.phase = 'audit';
      this.room.broadcast({ t: 'need_keys', handId: this.id });
      this.armTimer(this.opts.cryptoTimeoutMs);
    } else {
      this.finalizeSettlement();
    }
  }

  /**
   * B1 squid game. Only a claimed manual trigger reaches here. Every
   * non-winner pays `penaltyBb x bb x (participants - 1)`, capped by the chips
   * they have left after the pot, split evenly among every other participant.
   * With multiple runs you must win every run to be a winner; if the runs have
   * no common winner nobody collects and no chips move.
   */
  private settleSquid(
    winnerSets: number[][],
    stacks: { seat: number; stack: number }[],
  ): SquidSettlement | null {
    const settings = this.features.squid.settings;
    if (!settings) return null;
    const participants = this.seats.map((s) => s.seat);
    const winners = intersectSeatSets(winnerSets);
    const opponentCount = participants.length - 1;
    const requestedPerLoser = settings.penaltyBb * this.bb * opponentCount;
    const netBySeat = new Map<number, number>();
    const transfers: { from: number; to: number; amount: number }[] = [];
    const paidBySeat: { seat: number; amount: number }[] = [];
    if (winners.length === 0 || opponentCount <= 0) {
      return {
        winners: [],
        transfers: [],
        requestedPerLoser,
        paidBySeat: [],
        noClaimant: true,
        netBySeat,
      };
    }
    const available = new Map(stacks.map((s) => [s.seat, Math.max(0, s.stack)]));
    for (const loser of participants) {
      if (winners.includes(loser)) continue;
      const paid = Math.min(requestedPerLoser, available.get(loser) ?? 0);
      if (paid <= 0) continue;
      paidBySeat.push({ seat: loser, amount: paid });
      const recipients = participants.filter((s) => s !== loser);
      const shares = splitAmountEven(paid, recipients.length);
      recipients.forEach((to, i) => {
        const amount = shares[i]!;
        if (amount <= 0) return;
        transfers.push({ from: loser, to, amount });
        netBySeat.set(loser, (netBySeat.get(loser) ?? 0) - amount);
        netBySeat.set(to, (netBySeat.get(to) ?? 0) + amount);
      });
    }
    return {
      winners,
      transfers,
      requestedPerLoser,
      paidBySeat,
      noClaimant: false,
      netBySeat,
    };
  }

  private onRevealKey(info: HandSeatInfo, keyHex: string, sig: string): void {
    if (this.phase !== 'audit') return;
    let valid = false;
    try {
      const commit = this.commits.get(info.seat)!;
      valid = pointHex(handKeyCommit(BigInt('0x' + keyHex))) === pointHex(commit);
    } catch {
      valid = false;
    }
    this.appendPlayer('reveal_key', info.pubkey, { key: keyHex, valid }, sig);
    this.revealedKeys.set(info.seat, keyHex);
    // with the player's own key in hand, their hole cards decrypt directly:
    // holeFinal already holds each card after every OTHER player unmasked it
    if (valid && !this.reveals.has(info.seat)) {
      const orderIdx = this.seats.findIndex((x) => x.seat === info.seat);
      const cards: CardId[] = [];
      const inv = invScalar(BigInt('0x' + keyHex));
      for (const idx of this.holeIndexes(orderIdx)) {
        const pt = this.holeFinal.get(idx);
        if (!pt) continue;
        const card = recoverCard(mulPoint(pt, inv), this.lookup);
        if (card !== null) cards.push(card);
      }
      if (cards.length === 2) this.appendServer('hole_cards', { seat: info.seat, cards });
    }
    if (this.revealedKeys.size === this.n) this.finalizeSettlement();
  }

  private finalizeSettlement(): void {
    if (this.phase === 'done' || !this.settlement) return;
    this.clearTimer();
    this.phase = 'done';
    const { stacks, rake, squid } = this.settlement;
    const room = getRoom(this.db, this.roomId);
    const now = Date.now();
    const pokerDeltas = this.settlement.pokerDeltas;
    const squidDeltas = this.seats.map((s) => ({
      seat: s.seat,
      delta: squid?.netBySeat.get(s.seat) ?? 0,
    }));
    const combinedDeltas = pokerDeltas.map((d) => ({
      seat: d.seat,
      delta: d.delta + (squid?.netBySeat.get(d.seat) ?? 0),
    }));
    const bySeat = (seat: number) => this.seats.find((x) => x.seat === seat)!;

    // Time bank: debits lived in memory for the hand (hand-atomic - an aborted
    // or crashed hand leaves the stored bank untouched), so persist the final
    // balance + counter/refill here. A config change mid-hand resets the bank
    // and bumps the epoch; detect that explicitly instead of silently no-oping.
    const bank = this.features.timeBank;
    const timeBanks: { userId: number; ms: number; hands: number }[] = [];
    const mismatchedSeats: number[] = [];
    if (bank) {
      for (const s of this.seats) {
        const row = this.db
          .prepare('SELECT time_bank_epoch FROM room_players WHERE room_id = ? AND user_id = ?')
          .get(this.roomId, s.userId) as { time_bank_epoch: number } | undefined;
        if (!row || row.time_bank_epoch !== bank.epoch) {
          mismatchedSeats.push(s.seat);
          continue;
        }
        const remaining = bank.balances.get(s.seat) ?? 0;
        let hands = (bank.hands.get(s.seat) ?? 0) + 1;
        let ms = remaining;
        if (bank.refillEveryHands > 0 && hands >= bank.refillEveryHands) {
          ms += bank.refillMs;
          hands = 0;
        }
        timeBanks.push({ userId: s.userId, ms, hands });
      }
    }
    if (mismatchedSeats.length)
      this.appendServer('time_bank_epoch_mismatch', { seats: mismatchedSeats });

    const head = this.transcript.head;
    const outcome = applyHandSettlement(this.db, {
      handId: this.id,
      roomId: this.roomId,
      head,
      entries: this.transcript.entries,
      rake,
      commissionBps: this.commissionBps,
      stackDeltas: combinedDeltas.map((d) => ({ userId: bySeat(d.seat).userId, delta: d.delta })),
      pokerLedger: pokerDeltas.map((d) => ({ userId: bySeat(d.seat).userId, delta: d.delta })),
      squidLedger: squid
        ? squidDeltas.map((d) => ({ userId: bySeat(d.seat).userId, delta: d.delta }))
        : [],
      squidNote: 'Squid Game penalty/payout',
      timeBanks,
      timeBankEpoch: bank ? bank.epoch : null,
      triggerIds: [this.features.squid.triggerId, this.features.bomb.triggerId],
      bombRan: !!this.features.bomb.settings,
      rakeRecipientId: rake > 0 && room ? (platformUserId(this.db) ?? room.banker_id) : null,
      now,
    });
    if (outcome.status === 'duplicate') {
      // a committed finalize already moved every chip for this hand: replay nothing
      this.onDone();
      return;
    }
    // `hand_end.deltas` are the combined poker+squid nets; the split is kept
    // alongside for clients/stats that want to attribute each source.
    const endMsg = {
      t: 'hand_end' as const,
      handId: this.id,
      head,
      stacks,
      deltas: combinedDeltas,
      pokerDeltas,
      squidDeltas,
      commission: rake,
      commissionBps: this.commissionBps,
    };
    this.room.broadcast(endMsg as ServerMsg);
    this.onDone();
  }
}
