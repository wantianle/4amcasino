import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  Transcript,
  cardLookup,
  computeHead,
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
  type TranscriptEntry,
} from '@4am/mental-poker';
import {
  activeNonAllIn,
  applyAction,
  computePots,
  commissionForPot,
  MAX_TIME_BANK_MS,
  MULTI_RUN_HEADS_UP_SEATS,
  nextStreet,
  startBombPot,
  startHand,
  streetClosed,
  type BettingState,
  type CardId,
  type ClientMsg,
  type PlayerAction,
  type RoomGameplaySettings,
  type ServerMsg,
  signedBody,
} from '@4am/shared';
import { firstPendingHandLifecycle, type DB } from './db.js';
import {
  positionAssignments,
  SEVEN_DEUCE_SHOW_KIND,
  voidHandExistsSql,
} from './handProjection.js';
import { appendLedger } from './ledger.js';
import { getRoom, presentablePlayers, roomPlayers } from './rooms.js';
import { evictOverCapBots } from './botRoutes.js';
import { readRoomFeatures } from './gameplaySettings.js';
import { computeHeadsUpEquity, computeMultiwayEquity, EquityError } from './equity.js';
import type { MultiwayEquityResult } from './equity.js';
import { platformUserId } from './platform.js';

// ---------------------------------------------------------------------------
// P1-5 mechanical split. The former monolith is now:
//   gameTypes.ts        - shared domain types / constants / error classes
//   settlementReceipt.ts - pure read-side receipt + recovery helpers
//   settlementWriter.ts  - atomic settlement + durable prepared-input writer
// This file stays the façade and re-exports the EXACT same public surface as
// before the split (verified with the TS compiler API), so `hub.ts`,
// `admin.ts` and every test keep their existing imports.
// ---------------------------------------------------------------------------
import {
  AUTO_DEAL_INTERVAL_MS,
  AUTO_DEAL_READY_CHECK_MS,
  GONE_ABORT_GRACE_MS,
  MAX_TERMINAL_FRAMES,
  RIT_VOTE_MS,
  SETTLE_HOLD_MS,
  SETTLE_MAX_RETRIES,
  SETTLE_RETRY_MS,
  SHOWDOWN_HOLD_MS,
  SHUTDOWN_DRAIN_MS,
  GameError,
  RetryableGameError,
  isTransientTransferError,
  realClock,
  type Chain,
  type GameClock,
  type GameOpts,
  type HandFeatureSnapshot,
  type HandSeatInfo,
  type HandSettlementOutcome,
  type HandSettlementWrite,
  type Identity,
  type SettlementFaultPoint,
  type SettlementPhaseHook,
  type SquidSettlement,
} from './gameTypes.js';
import { recoverHandEnd } from './settlementReceipt.js';
import {
  abortPendingHandSettlement,
  applyHandSettlement,
  applyPreparedHandSettlement,
  persistPreparedInput,
  settlementInputHash,
  PreparedInputError,
  type ApplyPreparedResult,
  type OperatorAbortResult,
} from './settlementWriter.js';

export {
  AUTO_DEAL_INTERVAL_MS,
  AUTO_DEAL_READY_CHECK_MS,
  GONE_ABORT_GRACE_MS,
  RIT_VOTE_MS,
  SETTLE_HOLD_MS,
  SETTLE_MAX_RETRIES,
  SETTLE_RETRY_MS,
  SHOWDOWN_HOLD_MS,
  SHUTDOWN_DRAIN_MS,
  GameError,
  RetryableGameError,
  isTransientTransferError,
  realClock,
  type GameClock,
  type GameOpts,
  type HandSettlementOutcome,
  type HandSettlementWrite,
  type SettlementFaultPoint,
  type SettlementPhaseHook,
} from './gameTypes.js';
export {
  abortPendingHandSettlement,
  applyHandSettlement,
  applyPreparedHandSettlement,
  persistPreparedInput,
  settlementInputHash,
  PreparedInputError,
  type ApplyPreparedResult,
  type OperatorAbortResult,
} from './settlementWriter.js';


/** Rooms with a hand in flight; REST money moves must wait for the settle. */
import { activeHands } from './liveHands.js';

export { activeHands };
import { hdbg } from './handDiagnostics.js';
import {
  isSevenDeuce,
  verifySnapshotShares,
  type ShowSnapshot,
  type SnapshotSeat,
} from './handShow.js';
import {
  STREET_INDEX,
  testHandId,
  type MultiRunResultReason,
} from './handSupport.js';
import { computeShowdown, computeSquidSettlement } from './showdown.js';

export { isSevenDeuce } from './handShow.js';
import { logBroadcastFailure } from './gameBroadcast.js';
import { Hand } from './hand.js';

export class GameRoom {
  private sockets = new Map<number, WebSocket>();
  private hand: Hand | null = null;
  private lastButton: number | null = null;
  // voluntary card shows for the current (or most recently ended) hand
  private shown = new Map<number, CardId[]>();
  private shownHandId: string | null = null;
  private lastHandShow: ShowSnapshot | null = null;
  /** Recent `hand_end` frames, retained ACROSS hand boundaries so a participant
   *  who missed the terminal frame (dropped socket, swallowed broadcast, or was
   *  simply not dealt into the next hand) still receives it on reconnect. A
   *  single slot was cleared the moment the next hand started - exactly when a
   *  player who was not dealt in needs it most - which left their settlement
   *  banner stuck forever. Bounded so a long-lived room cannot leak frames. */
  private terminalFrames: {
    msg: Extract<ServerMsg, { t: 'hand_end' }>;
    participantIds: number[];
  }[] = [];
  private sevenDeucePaid = new Set<string>();
  private autoDeal: NodeJS.Timeout | null = null;
  private autoDealAt: number | null = null;
  private autoDealPaused = false;
  private autoDealEligibility = '';
  private reconcilingAutoDeal = false;
  /** After a showdown, no auto-deal may start before this wall-clock time, so
   *  the client's settle animation is not cut off. Set in broadcastHandEnd. */
  private settleHoldUntil = 0;
  // no hand auto-starts until everyone is ready: a short ready check
  // (AUTO_DEAL_READY_CHECK_MS, 1.5s) runs before each auto-deal, and whoever
  // has not clicked by the deadline is left out of that hand
  // (requested by notpritam, docs/FEATURES.md)
  private readyCheck: {
    deadline: number;
    timer: NodeJS.Timeout;
    eligible: Set<number>;
    ready: Set<number>;
  } | null = null;
  /** Set when an unexpected (non-business) handler error escaped. A room in
   *  this state fails closed: `startHand` refuses. A `recoverable` mark (a
   *  settlement failure whose retry can prove the room is consistent) can be
   *  cleared by `clearUnhealthy()` once the verifying action succeeds; an
   *  unknown programming error cannot, and needs a process restart. */
  private unhealthyReason: string | null = null;
  private unhealthyRecoverable = false;
  /** True once a graceful shutdown has begun: no new hand may be dealt. */
  private draining = false;
  /** Monotonic per-room hand counter used only to mint reproducible test ids. */
  private testHandSeq = 0;
  private lookup = cardLookup();
  /**
   * Consecutive action-timeout auto-folds per user, across hands, persisted on
   * `room_players.consecutive_action_timeouts` so a process restart cannot
   * reset the streak (a restart between two timeouts would otherwise let a
   * player stall forever). A voluntary action clears the streak; two in a row
   * stands the player up at the hand boundary. Keyed by user via the
   * (room_id, user_id) primary key, not seat, so a seat change cannot inherit
   * another player's streak. Read/written by `noteTimeout`,
   * `noteVoluntaryAction` and `clearTimeoutStreak`.
   */
  /**
   * Users to stand up once the current hand ends. `leave_seat` refuses while a
   * hand owns the seat, so a forced removal triggered by the second timeout is
   * deferred to the hand boundary and then runs the exact same seat-release
   * write as a voluntary `leave_seat`.
   */
  private pendingForcedLeaves = new Set<number>();

  constructor(
    private db: DB,
    readonly roomId: string,
    private serverId: Identity,
    private opts: GameOpts,
  ) {
    // Startup recovery scan: a hand dealt but never settled leaves a
    // non-terminal `hand_lifecycle` row even when its settlement transaction
    // rolled back (transcript and marker both absent). This is a log only; the
    // authoritative per-deal guard re-queries `firstUnsettledHand()` every time
    // so an operator resolving the row is never blocked by a stale cache.
    const pending = firstPendingHandLifecycle(db, roomId);
    if (pending) {
      console.error(
        `room ${roomId} has an unsettled hand ${pending}: dealing is frozen until it is resolved`,
      );
    }
  }

  join(userId: number, ws: WebSocket, resumeHandId?: string): void {
    // Deliberately does NOT close the socket it replaces. Closing it made two
    // tabs on the same room fight: the server hangs up on tab A, tab A's client
    // reconnects and displaces tab B, B reconnects and displaces A, forever -
    // and a player stuck in that loop answers no crypto requests, so every hand
    // they are dealt into stalls out. The orphan is cheap; the loop was not.
    this.sockets.set(userId, ws);
    // A player who comes back inside the pre-betting grace must not be aborted
    // out of a hand they are actively rejoining: cancel their pending timer.
    this.hand?.onPlayerReconnected(userId);
    // Durable recovery FIRST, before room_state: a restart discards the
    // in-memory terminal frames, so the only authoritative answer for the hand
    // the client still holds is the persisted lifecycle/settlement data. The
    // client's resync reconciliation reads this before it decides whether the
    // absent live hand means "refunded", "settled", or "needs an operator".
    this.sendDurableRecovery(userId, resumeHandId);
    this.broadcastRoomState();
    // A rejoining participant gets the whole hand context back (hand_start,
    // their private cards, the board, the reveal) BEFORE any courtesy frames,
    // so a freshly-created client never drops a frame that arrived first.
    this.hand?.resendPending(userId);
    // A participant who missed the terminal `hand_end` - disconnected for the
    // exact moment of settlement, a broadcast swallowed by `safeBroadcast`, or
    // simply not dealt into the hand that is running now - has no other way to
    // learn the hand committed. Replay every retained terminal frame they took
    // part in, even while a newer hand is live; only participants are served,
    // so a fresh spectator is never shown a stranger's recap.
    for (const frame of this.terminalFrames) {
      if (frame.participantIds.includes(userId)) this.send(userId, frame.msg);
    }
    // late joiners and reconnects still get to see voluntarily shown cards
    if (this.shownHandId) {
      for (const [seat, cards] of this.shown) {
        this.send(userId, { t: 'cards_shown', handId: this.shownHandId, seat, cards });
      }
    }
  }

  leave(userId: number, ws: WebSocket): void {
    if (this.sockets.get(userId) === ws) {
      this.sockets.delete(userId);
      this.broadcastRoomState();
      // a folded player walking away must never strand the hand
      this.hand?.onPlayerGone(userId);
    }
  }

  isConnected(userId: number): boolean {
    return this.sockets.has(userId);
  }

  /** Retain a broadcast `hand_end` so a participant who missed it (dropped
   *  socket, or a `safeBroadcast` delivery failure) can still be sent the
   *  terminal frame when they reconnect. Retained across hand boundaries and
   *  bounded: a player who is not dealt into the next hand must still get the
   *  hand they actually played. */
  rememberHandEnd(msg: Extract<ServerMsg, { t: 'hand_end' }>, participantIds: number[]): void {
    this.terminalFrames.push({ msg, participantIds });
    const overflow = this.terminalFrames.length - MAX_TERMINAL_FRAMES;
    if (overflow > 0) this.terminalFrames.splice(0, overflow);
  }

  /** Answer, from durable data, the terminal status of the hand the client says
   *  it still holds. A restart discards every in-memory terminal frame, so
   *  without this a committed hand is indistinguishable from one whose
   *  settlement never ran: the client would freeze on a false "admin needed",
   *  or synthesise a refund that never happened. Skipped when a live hand or a
   *  retained exact frame already owns the answer. */
  private sendDurableRecovery(userId: number, resumeHandId: string | undefined): void {
    if (!resumeHandId) return;
    // A live hand owns resendPending: it re-asserts the authoritative context
    // (and any pending settlement failure) for THIS hand. Never second-guess it.
    if (this.hand?.id === resumeHandId) return;
    // The exact original frame is retained and replayed just below; a
    // reconstruction would be a duplicate.
    if (this.terminalFrames.some((f) => f.msg.handId === resumeHandId)) return;
    const row = this.db
      .prepare('SELECT status FROM hand_lifecycle WHERE hand_id = ? AND room_id = ?')
      .get(resumeHandId, this.roomId) as { status: string } | undefined;
    if (!row) return; // unknown hand: nothing durable to assert
    if (row.status === 'committed') {
      const end = recoverHandEnd(this.db, this.roomId, resumeHandId, userId);
      this.send(
        userId,
        end ?? { t: 'hand_recovery', handId: resumeHandId, status: 'committed' as const },
      );
      return;
    }
    if (row.status === 'aborted') {
      this.send(userId, { t: 'hand_recovery', handId: resumeHandId, status: 'aborted' });
      return;
    }
    // running / prepared / quarantined: never reached a terminal transaction.
    this.send(userId, { t: 'hand_recovery', handId: resumeHandId, status: 'unresolved' });
  }

  /** Nobody is connected and nothing is in flight, so the hub can drop this room
   *  instead of holding it (and its per-hand maps) for the life of the process. */
  isIdle(): boolean {
    return this.sockets.size === 0 && this.hand === null && this.readyCheck === null;
  }

  /**
   * Graceful shutdown. Stop dealing, then give an in-flight, not-yet-settled
   * hand a bounded window to reach a terminal lifecycle state; if it does not,
   * abort it so no `running` row survives to freeze the room on restart. A hand
   * whose settlement already committed is never aborted (its chips moved).
   *
   * Async because the hub awaits it on close. Never throws: a shutdown must
   * complete so the process can exit.
   */
  async shutdown(): Promise<void> {
    this.draining = true;
    if (this.autoDeal) clearTimeout(this.autoDeal);
    this.autoDeal = null;
    this.autoDealAt = null;
    this.cancelReadyCheck(false);
    const hand = this.hand;
    let terminated = true;
    if (hand && !hand.isSettlementCommitted()) {
      const deadline = Date.now() + (this.opts.shutdownDrainMs ?? SHUTDOWN_DRAIN_MS);
      while (this.hand === hand && !hand.isTerminal() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (this.hand === hand && !hand.isSettlementCommitted()) {
        // Bounded retries inside `abortForShutdown`; it returns whether the
        // durable lifecycle row is now provably terminal.
        terminated = hand.abortForShutdown();
      }
    }
    if (!terminated) {
      // The abort could not be proven durable (db already closed, SQLITE_BUSY,
      // ...). Do NOT tear the hand down: keep the room fail-closed so the
      // `running` row is left for the restart scan rather than silently
      // pretending the hand is resolved.
      console.error(
        `room ${this.roomId}: shutdown could not confirm a terminal lifecycle; leaving the hand fail-closed`,
      );
      return;
    }
    this.hand?.clearTimer();
    this.hand = null;
    activeHands.delete(this.roomId);
  }

  /**
   * Mark the room unhealthy after an unexpected (programming) error escaped a
   * message handler. It fails closed: no new hand is dealt over an
   * indeterminate state. `recoverable: true` is for a failure whose successful
   * retry proves the room is consistent again (a settlement write); an unknown
   * error is not recoverable and can only be cleared by a process restart.
   *
   * First-wins is NOT safe across severities: a recoverable settlement mark set
   * first must be UPGRADED to non-recoverable if a real programming error then
   * appears, otherwise a later settlement success would clear the room while
   * the unknown error is still unexplained. A non-recoverable mark is sticky.
   */
  markUnhealthy(reason: string, opts: { recoverable?: boolean } = {}): void {
    const recoverable = !!opts.recoverable;
    if (this.unhealthyReason && !this.unhealthyRecoverable) return; // already permanent
    if (this.unhealthyReason && this.unhealthyRecoverable && recoverable) return; // same class
    if (this.unhealthyReason && this.unhealthyRecoverable && !recoverable) {
      this.unhealthyReason = reason;
      this.unhealthyRecoverable = false;
      console.error(`room ${this.roomId} escalated unhealthy (non-recoverable): ${reason}`);
      return;
    }
    this.unhealthyReason = reason;
    this.unhealthyRecoverable = recoverable;
    console.error(`room ${this.roomId} marked unhealthy: ${reason}`);
  }

  /**
   * Controlled clearing path for an unhealthy room. It only clears the state it
   * is asked to clear (`reason` must match the stored one) AND only when that
   * state was marked recoverable: blindly clearing a programming-error mark
   * would let the room deal over an unrepaired invariant violation.
   * Returns whether the room is healthy again.
   */
  clearUnhealthy(reason: string): boolean {
    if (!this.unhealthyReason || !this.unhealthyRecoverable) return false;
    if (this.unhealthyReason !== reason) return false;
    this.unhealthyReason = null;
    this.unhealthyRecoverable = false;
    console.error(`room ${this.roomId} cleared unhealthy state: ${reason}`);
    return true;
  }

  isUnhealthy(): boolean {
    return this.unhealthyReason !== null;
  }

  /**
   * A settlement retry finally committed: the room was only ever unhealthy
   * because the durable write could not be proven, so clear that specific
   * recoverable mark. This is the "retry success" half of the controlled
   * clearing path; an unknown (non-recoverable) mark is left alone.
   */
  settlementRecovered(): void {
    if (this.unhealthyRecoverable && this.unhealthyReason)
      this.clearUnhealthy(this.unhealthyReason);
  }

  /**
   * Reconcile an in-memory hand this process froze (settlement never applied
   * here) against an out-of-band resolution of its durable lifecycle row.
   *
   * The operator recovery API is deliberately DB-only - it must work after a
   * restart where no `GameRoom` exists - so while the process is still running
   * the frozen `this.hand` (and the recoverable settlement-failure health mark)
   * would otherwise keep the table blocked forever even though the durable row
   * is now terminal. This drops that stale hand and clears ONLY the
   * settlement-failure mark, so the table can deal again.
   *
   * A no-op unless the durable row is already `aborted`/`committed`: a
   * `running`/`prepared`/`quarantined` row is still an open money fact and must
   * keep the table frozen. A non-recoverable (programming-error) mark is never
   * cleared - `clearUnhealthy` refuses it by design.
   */
  reconcileOperatorResolvedHand(): void {
    const hand = this.hand;
    if (!hand) return;
    // The money moved HERE and the terminal-frame path owns teardown:
    // never interfere with an applied settlement.
    if (hand.isSettlementCommitted()) return;
    const row = this.db
      .prepare('SELECT status FROM hand_lifecycle WHERE hand_id = ?')
      .get(hand.id) as { status: string } | undefined;
    if (!row || (row.status !== 'aborted' && row.status !== 'committed')) return;
    // Durable row is terminal but this process never applied it: the money
    // either never moved (aborted) or moved via an operator retry elsewhere
    // (committed). Nothing in memory can be completed, and the durable hand is
    // authoritative for reconnecting clients (`sendDurableRecovery`). Drop it.
    hand.clearTimer();
    this.hand = null;
    activeHands.delete(this.roomId);
    const failure = hand.settlementFailureReason();
    if (this.unhealthyRecoverable && failure)
      this.clearUnhealthy(`settlement failed: ${failure}`);
    try {
      this.broadcastRoomState();
    } catch (err) {
      hdbg('reconcileResolvedHandBroadcastFailed', {
        room: this.roomId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * The authoritative fail-closed guard: a durable `hand_lifecycle` row that
   * was written at deal time but never reached `committed`/`aborted`. This
   * catches a settlement transaction that rolled back entirely (no transcript,
   * no marker) - which the old "transcript without marker" query could not.
   * A healthy DB yields null. See DESIGN.md ("Settlement recovery").
   */
  private firstUnsettledHand(): string | null {
    // Re-query every time: an operator may have resolved the lifecycle row in
    // this same process, and a cached value would freeze the room forever.
    return firstPendingHandLifecycle(this.db, this.roomId);
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

  /** Called by the hand as it finalizes: after a showdown the client needs a
   *  beat to animate the settlement, so the next auto-deal waits out a hold.
   *  Fold-outs pass false and are gated only by the normal cadence. */
  setSettlementHold(hadShowdown: boolean): void {
    this.settleHoldUntil = hadShowdown
      ? Date.now() + (this.opts.settleHoldMs ?? SETTLE_HOLD_MS)
      : 0;
  }

  private scheduleAutoDeal(): void {
    if (this.autoDeal || this.hand || this.readyCheck) return;
    let delay = this.opts.autoDealMs ?? AUTO_DEAL_INTERVAL_MS;
    // A showdown's post-settle animation hold (SETTLE_HOLD_MS) can be longer
    // than the configured cadence: never deal before it elapses.
    const hold = this.settleHoldUntil - Date.now();
    if (hold > delay) delay = hold;
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

  /** Auto-deal's short consent window: everyone who is already in is counted
   *  the moment the check opens (and the check then resolves at once), while a
   *  straggler has only the brief window before sitting this hand out. */
  private beginReadyCheck(): void {
    if (this.hand || this.readyCheck) return;
    const eligible = this.eligiblePlayers();
    if (eligible.length < 2 || this.autoDealerId() === null) {
      this.broadcastRoomState();
      return;
    }
    const ms = this.opts.readyCheckMs ?? AUTO_DEAL_READY_CHECK_MS;
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
    const data = JSON.stringify(msg);
    for (const ws of this.sockets.values()) ws.send(data);
  }

  /**
   * Best-effort room publisher - the `GameRoom` counterpart of `Hand.publish`.
   * A broadcast failure is notification-only: it is logged and swallowed, so a
   * money move that already committed (e.g. a voluntary 7-2 show) can never
   * unwind through the caller and bubble to the hub, where an
   * escaping error would mark the whole room unhealthy. Never rethrows; returns
   * whether the frame was handed to the transport.
   */
  publish(msg: ServerMsg, label = 'room broadcast failed'): boolean {
    try {
      this.broadcast(msg);
      return true;
    } catch (err) {
      logBroadcastFailure(this.roomId, label, msg.t, err);
      return false;
    }
  }

  /**
   * Best-effort `broadcastRoomState`, the room-state half of {@link publish}.
   * Routed through the same tiered logger so a committed money move whose
   * follow-up `room_state` fails still cannot mark the room unhealthy.
   */
  publishRoomState(label = 'room_state broadcast failed'): boolean {
    try {
      this.broadcastRoomState();
      return true;
    } catch (err) {
      logBroadcastFailure(this.roomId, label, 'room_state', err);
      return false;
    }
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
        // Fixed 30s base clock: the timer is no longer host-tunable, so the
        // engine default is reported (and `actionSecs` is always null rather
        // than a stale stored value the host used to be able to set).
        actionTimeoutMs: this.opts.actionTimeoutMs,
        actionSecs: null,
        coBankerId: room.co_banker_id,
        minSettleHands: room.min_settle_hands,
        autoApproveBuys: !!room.auto_approve_buys,
        tvReplays: !!room.tv_replays,
        autoDeal: !!room.auto_deal,
        autoDealerId: this.autoDealerId(),
        commissionBps: this.hand?.commissionBps ?? room.commission_bps,
        sevenDeuceBonus: room.seven_deuce_bonus,
        voided: !!room.voided,
        // A closed/archived table is retired: the client should leave for the
        // lobby. History and the ledger stay readable (see /api/me/rooms).
        archived: !!room.archived,
        archivedAt: room.archived_at,
      },
      players,
      handActive: this.hand !== null,
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
    for (const [uid, ws] of this.sockets) ws.send(memberIds.has(uid) ? full : masked);
  }

  /**
   * A voluntary action clears a seat's consecutive-timeout streak. Only real
   * player actions count: the auto-fold and the disconnect-driven folds are
   * deliberately not routed here.
   */
  noteVoluntaryAction(userId: number): void {
    this.clearTimeoutStreak(userId);
  }

  /**
   * A seat's turn timed out (auto-fold). Two timeouts in a row - in the same
   * hand or across two hands - stand the player up at the end of the hand the
   * second one folded them out of. Because a timeout always folds, the second
   * timeout of a single hand is unreachable (the first removes the player from
   * the betting), so in practice the streak runs across hands; the counter
   * covers both readings. Returns true when this timeout triggered the leave.
   *
   * The streak is read from and written back to `room_players` on every call so
   * it survives a process restart, which is the whole point: a restart between
   * the two timeouts must NOT forgive the first one.
   */
  noteTimeout(userId: number): boolean {
    const row = this.db
      .prepare(
        'SELECT consecutive_action_timeouts AS streak FROM room_players WHERE room_id = ? AND user_id = ?',
      )
      .get(this.roomId, userId) as { streak: number } | undefined;
    const streak = (row?.streak ?? 0) + 1;
    if (streak < 2) {
      this.db
        .prepare(
          'UPDATE room_players SET consecutive_action_timeouts = ? WHERE room_id = ? AND user_id = ?',
        )
        .run(streak, this.roomId, userId);
      return false;
    }
    // Second in a row: reset the persisted streak and stand the player up at
    // the hand boundary (the live hand owns the seat until `onDone`).
    this.clearTimeoutStreak(userId);
    this.pendingForcedLeaves.add(userId);
    return true;
  }

  /**
   * Clear a user's persisted consecutive-timeout streak. Called on every
   * voluntary action, a fresh seat and a voluntary leave. The `!= 0` guard
   * keeps the hot action path from writing a no-op row update.
   */
  private clearTimeoutStreak(userId: number): void {
    this.db
      .prepare(
        'UPDATE room_players SET consecutive_action_timeouts = 0 WHERE room_id = ? AND user_id = ? AND consecutive_action_timeouts != 0',
      )
      .run(this.roomId, userId);
  }

  /**
   * Stand up every player who hit the consecutive-timeout limit, now that the
   * hand is over. Uses the same seat-release write as the explicit `leave_seat`
   * message: `seat = NULL`, and the stack deliberately stays on the
   * `room_players` row exactly as it does when a player leaves their seat by
   * hand. A system chat line tells the table why. Must be called BEFORE the
   * `room_state` broadcast so clients see the emptied seat in that frame.
   */
  private applyPendingForcedLeaves(): void {
    if (this.pendingForcedLeaves.size === 0) return;
    const removed: string[] = [];
    for (const userId of this.pendingForcedLeaves) {
      const user = this.db
        .prepare('SELECT COALESCE(display_name, username) AS name FROM users WHERE id = ?')
        .get(userId) as { name: string } | undefined;
      const info = this.db
        .prepare('UPDATE room_players SET seat = NULL WHERE room_id = ? AND user_id = ?')
        .run(this.roomId, userId);
      if (info.changes > 0 && user) removed.push(user.name);
    }
    this.pendingForcedLeaves.clear();
    if (removed.length) {
      this.broadcast({
        t: 'chat',
        from: '4AM',
        userId: 0,
        text: `Removed from seat after two timeouts in a row: ${removed.join(', ')}.`,
        kind: 'text',
        ts: Date.now(),
      });
    }
  }

  /** A closed/archived (or deleted) table is retired: seats are frozen and no
   *  new hand may be dealt. Reads and settlement of an already-running hand are
   *  unaffected. */
  private isRoomClosed(): boolean {
    const room = getRoom(this.db, this.roomId);
    return !room || !!room.archived || !!room.deleted;
  }

  handleMessage(userId: number, msg: ClientMsg): void {
    switch (msg.t) {
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
        if (this.isRoomClosed())
          return this.send(userId, { t: 'error', message: 'this table is closed' });
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
        // a fresh seat starts with a clean streak
        this.clearTimeoutStreak(userId);
        // Table-with-bots cap: a human sitting can push seated humans + bots
        // past MAX_TABLE_PLAYERS_WITH_BOTS, so evict random seated bot(s) to
        // bring the table back to 6. This is the sit-path counterpart of the
        // bot-CREATION cap. A table with no bots left is deliberately NOT
        // refused here: the cap limits bots, and with nothing to evict the seat
        // count is the game's own 9-max concern (see evictOverCapBots).
        evictOverCapBots(this.db, this.roomId);
        this.broadcastRoomState();
        return;
      }
      case 'leave_seat': {
        if (this.isRoomClosed())
          return this.send(userId, { t: 'error', message: 'this table is closed' });
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
        this.clearTimeoutStreak(userId);
        this.broadcastRoomState();
        return;
      }
      case 'start_hand': {
        const room = getRoom(this.db, this.roomId)!;
        if (room.host_id !== userId)
          return this.send(userId, { t: 'error', message: 'only the host starts hands' });
        // an archived table is retired: history stays readable, play does not resume
        if (room.archived || room.deleted)
          return this.send(userId, {
            t: 'error',
            message: 'this table is archived - unarchive it to deal again',
          });
        // A frozen hand resolved out-of-band by an operator (DB-only recovery)
        // must not keep answering "hand already running" forever: adopt the
        // durable resolution before the in-memory guard.
        this.reconcileOperatorResolvedHand();
        if (this.hand) return this.send(userId, { t: 'error', message: 'hand already running' });
        this.cancelAutoDeal();
        this.cancelReadyCheck();
        this.startHand();
        return;
      }
      case 'retry_settlement': {
        const room = getRoom(this.db, this.roomId)!;
        if (room.host_id !== userId)
          return this.send(userId, { t: 'error', message: 'only the host can retry a settlement' });
        if (!this.hand) return this.send(userId, { t: 'error', message: 'no hand to retry' });
        const refusal = this.hand.settlementRetryRefusalReason();
        if (refusal) return this.send(userId, { t: 'error', message: refusal });
        this.hand.retrySettlement();
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
        if (this.isRoomClosed())
          return this.send(userId, { t: 'error', message: 'this table is closed' });
        this.db
          .prepare('UPDATE room_players SET sitting_out = ? WHERE room_id = ? AND user_id = ?')
          .run(msg.sittingOut ? 1 : 0, this.roomId, userId);
        this.broadcastRoomState();
        return;
      }
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
  ): HandFeatureSnapshot | null {
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

    const claim = this.db.transaction((): HandFeatureSnapshot | null => {
      // Authoritative lifecycle gate. The `startHand` guard reads `archived`
      // before this point; re-reading it inside the same IMMEDIATE transaction
      // that claims triggers makes "close" and "new hand" mutually exclusive:
      // whichever write commits first wins, and a close always leaves no
      // claimed trigger and no hand behind. Returns null to abort the deal.
      const current = getRoom(this.db, roomId);
      if (!current || current.archived || current.deleted) return null;
      // Durable hand lifecycle, in the SAME transaction as the feature claim:
      // the hand is registered before a single card is dealt (spec B9b). If any
      // later settlement write rolls back, this `running` row survives and the
      // restart scan can prove a hand was dealt. A hand id collision (only the
      // test seed can mint one) must abort the deal rather than clobber a
      // committed row.
      const lifecycle = this.db
        .prepare(
          `INSERT INTO hand_lifecycle (hand_id, room_id, status, created_at, updated_at)
           VALUES (?, ?, 'running', ?, ?)
           ON CONFLICT(hand_id) DO NOTHING`,
        )
        .run(handId, roomId, now, now);
      if (lifecycle.changes === 0) return null;
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
          // The balance is carried into every hand and becomes a `setTimeout`
          // delay, so clamp it here: a legacy or tampered row (or a balance
          // accumulated before this cap existed) must never exceed the ceiling.
          balances.set(s.seat, Math.min(MAX_TIME_BANK_MS, fresh ? initialMs : row.time_bank_ms));
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
      return snapshot;
    });
    return claim.immediate();
  }

  private startHand(auto = false, onlyIds?: Set<number>): void {
    // An operator may have resolved this room's frozen hand out-of-band (the
    // DB-only recovery API) since the last deal attempt: adopt that resolution
    // before consulting the in-memory guards below.
    this.reconcileOperatorResolvedHand();
    const room = getRoom(this.db, this.roomId)!;
    if (this.hand || room.archived || room.deleted) return;
    // A graceful shutdown has begun: never deal a hand that would be aborted
    // moments later.
    if (this.draining) return;
    // Fail closed on an unexpected handler error: an indeterminate room must
    // not deal another hand over whatever state it is in.
    if (this.unhealthyReason) {
      if (!auto)
        this.broadcast({ t: 'error', message: 'this table is held for an operator (unhealthy)' });
      return;
    }
    // A public hand whose chips never moved must never be dealt over.
    const unsettled = this.firstUnsettledHand();
    if (unsettled) {
      if (!auto)
        this.broadcast({
          t: 'error',
          message: `table is frozen: hand ${unsettled} was never settled (fail-closed)`,
        });
      return;
    }
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
    // the turn clock is fixed at the engine default (30s); the host's stored
    // `action_secs` is deliberately ignored (the timer is no longer tunable)
    const handOpts: GameOpts = {
      ...this.opts,
      tvReplays: !!room.tv_replays,
    };
    this.shown.clear();
    this.shownHandId = null;
    // NOTE: the previous hand's terminal `hand_end` is deliberately NOT cleared
    // here. A player who is not dealt into this hand never receives a
    // `hand_start`, so the previous hand's terminal frame is the only way their
    // client can clear a stuck settlement banner; a later `hand_start` or
    // lifecycle recovery supersedes it for the player who did move on.
    // a hand is starting: any previous showdown's settle hold no longer applies
    this.settleHoldUntil = 0;
    // The hand id is minted before feature claiming so a claimed trigger can be
    // bound to the hand that will actually carry it through to a transcript.
    const testSeed = process.env.BOT_TEST_SHUFFLE_SEED;
    const handId = testSeed
      ? testHandId(testSeed, this.testHandSeq++)
      : randomBytes(8).toString('hex');
    const features = this.claimHandFeatures(room.id, handSeats, handId);
    // The room was closed between the guard read above and the claim
    // transaction: the claim rolled back, nothing was claimed and no hand
    // exists. Leave the table retired.
    if (!features) return;
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
        // A player who hit the consecutive-timeout limit is stood up now that
        // the hand has released the seat, before the room_state frame so the
        // emptied seat is visible in that same broadcast.
        this.applyPendingForcedLeaves();
        // NOTE: the automatic showdown 7-2 bounty is paid inside the durable
        // settlement transaction (see Hand.persistSettlement) - it must not be
        // a late presentation side effect. A fold winner's *voluntary* show is
        // still credited by `recordShow` (independent, post-settlement).
        try {
          this.broadcastRoomState();
        } catch (err) {
          hdbg('onDoneBroadcastFailed', {
            room: this.roomId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
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
    // Pay the fold-winner 7-2 bounty BEFORE announcing the show. If the
    // transfer's transaction rolls back, the seat is un-marked and a retryable
    // error is thrown; the client can send `show_cards` again. Broadcasting
    // first would re-send the same public `cards_shown` on every retry (P1-2).
    try {
      this.trySevenDeuce(handId, seat, cards);
    } catch (err) {
      this.shown.delete(seat);
      throw err;
    }
    this.publish({ t: 'cards_shown', handId, seat, cards }, 'cards_shown broadcast failed');
    return true;
  }

  /**
   * Marks a hand's 7-2 bounty as already paid. Called by the durable settlement
   * for an automatic showdown bounty, so a later voluntary show cannot pay it
   * twice.
   */
  markSevenDeucePaid(handId: string): void {
    this.sevenDeucePaid.add(handId);
  }

  /**
   * True when this hand already has a `void-hand` compensating row. The void
   * writer correlates settlement-family legs on the transcript head and
   * seven-deuce legs on the hand id, so a hand counts as voided when a
   * `void-hand` row references EITHER key. This reuses the canonical
   * `voidHandExistsSql` (the same fragment the stats read models exclude on) so
   * the engine and the read models can never disagree about what "voided"
   * means; the head is resolved from the settlement marker for this hand.
   */
  private isHandVoided(handId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT ${voidHandExistsSql({
          roomExpr: '?',
          handIdExpr: '?',
          headExpr:
            '(SELECT hs.head FROM hand_settlements hs WHERE hs.room_id = ? AND hs.hand_id = ?)',
        })} AS voided`,
      )
      .get(this.roomId, handId, this.roomId, handId) as { voided: number } | undefined;
    return row?.voided === 1;
  }

  /**
   * Pays the 7-2 offsuit bounty to a verified VOLUNTARY show, once per hand.
   *
   * Post-settlement only: this runs from `recordShow` AFTER the hand settled,
   * so the transfer is outside the immutable transcript and the projection's
   * `net_delta`. Its ledger legs therefore use {@link SEVEN_DEUCE_SHOW_KIND}
   * rather than the automatic bounty's `seven-deuce`, keeping every hand-only
   * game-net read model equal to `hand_end.deltas`.
   */
  private trySevenDeuce(handId: string, seat: number, cards: CardId[]): void {
    const snap = this.lastHandShow;
    if (!snap || snap.handId !== handId || this.sevenDeucePaid.has(handId)) return;
    if (!snap.winnerSeats.includes(seat) || !isSevenDeuce(cards)) return;
    const room = getRoom(this.db, this.roomId);
    if (!room || room.seven_deuce_bonus <= 0) return;
    const winner = snap.bySeat.get(seat);
    if (!winner) return;
    const bonus = room.seven_deuce_bonus;
    let total = 0;
    let injectedFault = false;
    try {
      // Test-only: a thrown error simulates a rolled-back transfer (transient).
      if (this.opts.faultInjection?.sevenDeuce) {
        injectedFault = true;
        this.opts.faultInjection.sevenDeuce();
        injectedFault = false;
      }
      const apply = this.db.transaction(() => {
        // A voided hand never happened, so no leg may be added after the
        // banker's compensating refund. Without this, a fold winner's
        // *legitimate* later 7-2 show re-opened the bounty transfer, leaving
        // the hand unbalanced with no way back: a second void is rejected as
        // "already voided". Check inside the money transaction so the read and
        // the transfer can never interleave.
        if (this.isHandVoided(handId)) throw new GameError('that hand was voided');
        // Test-only internal fault: deliberately NOT special-cased, so a
        // TypeError/schema/invariant failure here stays a programming error.
        this.opts.faultInjection?.sevenDeuceInternal?.();
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
            kind: SEVEN_DEUCE_SHOW_KIND,
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
            kind: SEVEN_DEUCE_SHOW_KIND,
            ref: handId,
            note: 'won with 7-2 offsuit',
          });
          this.db
            .prepare('UPDATE room_players SET stack = stack + ? WHERE room_id = ? AND user_id = ?')
            .run(total, this.roomId, winner.userId);
        }
      });
      apply();
    } catch (err) {
      // The injected transient fault (a plain error, no result code) simulates a
      // rolled-back transfer and is retryable. A coded error is classified by
      // its real SQLite code; anything else (TypeError, invariant, schema,
      // SQLITE_IOERR/FULL/NOMEM/PROTOCOL) is a programming/environmental error
      // and must propagate to the hub's unhealthy branch.
      const coded = typeof (err as { code?: unknown })?.code === 'string';
      if (isTransientTransferError(err) || (injectedFault && !coded)) {
        throw new RetryableGameError(
          `7-2 bounty transfer failed, retry the show: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      throw err;
    }
    // Mark the bounty as paid only AFTER the transfer committed: a failed
    // transaction leaves it unpaid and retryable (see `recordShow`/`onShowCards`).
    this.sevenDeucePaid.add(handId);
    if (total > 0) {
      // Notification only: the money already moved above. Both frames go
      // through the shared best-effort publisher, so a TypeError in either the
      // `seven_deuce` frame or the follow-up `room_state` can never escape into
      // the hub and mark the room unhealthy. Order is unchanged.
      this.publish(
        { t: 'seven_deuce', handId, seat, amount: total },
        '7-2 bounty broadcast failed',
      );
      this.publishRoomState('7-2 bounty room_state broadcast failed');
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

}
