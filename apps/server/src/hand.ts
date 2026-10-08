// `Hand` - the per-hand authority: crypto dealing, betting, multi-run,
// showdown and settlement. Moved verbatim out of `game.ts` (G2); it does NOT
// split the class into handCrypto/handBetting/handMultiRun/handSettlement.
//
// Dependency direction notes: GameRoom is referenced here only as a TYPE, so
// `hand.ts -> game.ts` is erased at runtime while `game.ts -> hand.ts` imports
// the Hand value - there is no runtime import cycle.
import { randomBytes } from 'node:crypto';
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
  MAX_TIME_BANK_MS,
  MULTI_RUN_HEADS_UP_SEATS,
  activeNonAllIn,
  applyAction,
  commissionForPot,
  computePots,
  nextStreet,
  signedBody,
  startBombPot,
  startHand,
  streetClosed,
  type BettingState,
  type CardId,
  type ClientMsg,
  type PlayerAction,
  type ServerMsg,
} from '@4am/shared';
import type { DB } from './db.js';
import { EquityError, computeHeadsUpEquity, computeMultiwayEquity } from './equity.js';
import type { MultiwayEquityResult } from './equity.js';
import { logBroadcastFailure } from './gameBroadcast.js';
import {
  GONE_ABORT_GRACE_MS,
  RIT_VOTE_MS,
  SETTLE_MAX_RETRIES,
  SETTLE_RETRY_MS,
  SHOWDOWN_HOLD_MS,
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
  type SquidSettlement,
} from './gameTypes.js';
import { hdbg } from './handDiagnostics.js';
import { positionAssignments } from './handProjection.js';
import { isSevenDeuce, type ShowSnapshot, type SnapshotSeat } from './handShow.js';
import { STREET_INDEX, type MultiRunResultReason } from './handSupport.js';
import { platformUserId } from './platform.js';
import { getRoom } from './rooms.js';
import {
  PreparedInputError,
  applyPreparedHandSettlement,
  persistPreparedInput,
} from './settlementWriter.js';
import { computeShowdown, computeSquidSettlement } from './showdown.js';
import type { GameRoom } from './game.js';

/** Hard ceiling on a hand's live-equity tail. A runout deals in well under a
 *  second; if the bubble worker is stuck (or reset repeatedly), queued jobs
 *  past this point are dropped rather than publishing stale numbers for a hand
 *  that has already dealt on. */
const EQUITY_HAND_DEADLINE_MS = 30_000;

export class Hand {
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
  // Live all-in bubble: one worker job at a time, in issue order, so the
  // per-street frames reach clients in street order even when one enumeration
  // finishes ahead of the next board card. Jobs are appended per street; the
  // chain is per-Hand, so a lingering job from a past hand publishes only while
  // that hand is live (`phase !== 'done'`).
  private equityChain: Promise<void> = Promise.resolve();
  // Wall-clock ceiling for this hand's equity tail, set once the runout is
  // committed (finishMultiRun). A chained job that starts past it is dropped;
  // see EQUITY_HAND_DEADLINE_MS.
  private equityHandDeadline = 0;
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
  /** One pre-betting disconnect grace timer per absent player, keyed by userId.
   *  A reconnect deletes only that player's entry (`onPlayerReconnected`), so
   *  two players dropping at once are still each guarded on their own. */
  private goneTimers = new Map<number, NodeJS.Timeout>();
  private timer: NodeJS.Timeout | null = null;
  /** Holds the `hand_end` broadcast until the showdown reveal has been on screen
   *  for SHOWDOWN_HOLD_MS. Never gates the durable write. Cleared by
   *  `clearTimer` (abort/shutdown). */
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private showdownHoldUntil = 0;
  /** True once `applyHandSettlement` has committed this hand. */
  private settlementApplied = false;
  /** True once `hand_end` has been broadcast (no further replay is owed). */
  private handEndBroadcast = false;
  /** Number of failed durable-write attempts for this hand (retry bookkeeping). */
  private settlementAttempts = 0;
  /** Last durable-write error, kept for the manual-intervention frame. */
  private settlementError: string | null = null;
  /** The sealed write input, frozen on the first writer attempt and reused
   *  verbatim by every retry (see `buildSealedWrite`). */
  private sealedWrite: HandSettlementWrite | null = null;
  /** The committed receipt (applied or duplicate) once the write has landed. */
  private committedOutcome: HandSettlementOutcome | null = null;
  /** The 7-2 bounty the durable settlement already paid (for the live frame). */
  private settlementSevenDeuce: { seat: number; amount: number } | null = null;
  /** The committed commission recipient leg, per seat (empty when the recipient
   *  is not in the hand or rake is 0). `hand_end.deltas` is the game leg; a
   *  consumer adds this to reconcile the true per-seat stack change:
   *  `ending - starting === net_delta + commissionDelta`. */
  private settlementCommissionDeltas: { seat: number; delta: number }[] = [];
  private clock: GameClock;
  private lookup = cardLookup();
  readonly commissionBps: number;
  private settlement: {
    awards: Map<number, number>;
    pokerDeltas: { seat: number; delta: number }[];
    stacks: { seat: number; stack: number }[];
    showdown: ServerMsg | null;
    rake: number;
    squid: SquidSettlement | null;
    /** Automatic showdown 7-2 bounty, resolved against the post-pot stacks. */
    bounty: { seat: number; amount: number; payout: { seat: number; delta: number }[] } | null;
    /** The rake recipient resolved ONCE at settle time (platform account if
     *  configured, else the in-room banker). The transcript payload, the
     *  durable write and `hand_end` all read this same value, so a historical
     *  replay can never disagree with the ledger about who was paid. */
    rakeRecipientId: number | null;
    /** The rake recipient's seat when it is a hand participant, else empty.
     *  Mirrors `hand_end.commissionDeltas` (seat-filtered) exactly. */
    commissionDeltas: { seat: number; delta: number }[];
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
    this.clock = opts.clock ?? realClock;
  }

  // ---------- lifecycle ----------

  begin(): void {
    const positions = positionAssignments(this.seats, this.buttonSeat);
    this.appendServer('hand_start', {
      schemaVersion: 2,
      startedAt: Date.now(),
      gameKind: this.features.bomb.settings ? 'bomb_pot' : 'normal',
      roomId: this.roomId,
      seats: this.seats.map((s) => {
        const pos = positions.get(s.seat);
        return {
          seat: s.seat,
          userId: s.userId,
          pubkey: s.pubkey,
          stack: s.stack,
          position: pos?.position,
          positionIndex: pos?.positionIndex,
          dealingIndex: pos?.dealingIndex,
          preflopOrder: pos?.preflopOrder,
          postflopOrder: pos?.postflopOrder,
        };
      }),
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
    this.publish(this.startMsg);
    if (this.features.squid.settings)
      this.publish({
        t: 'feature_started',
        handId: this.id,
        squid: this.features.squid.settings,
      });
    this.armTimer(this.opts.cryptoTimeoutMs);
  }

  clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      hdbg('clearTimer', { id: this.id, phase: this.phase, toAct: this.betting?.toAct });
    }
    this.timer = null;
    this.clearSettleTimer();
  }

  /** Cancel a pending post-showdown `hand_end` broadcast. The durable write has
   *  already committed by the time this timer exists, so cancelling it can only
   *  lose the broadcast, never the settlement. */
  private clearSettleTimer(): void {
    if (this.settleTimer) this.clock.clearTimer(this.settleTimer);
    this.settleTimer = null;
  }

  private armTimer(ms: number): void {
    // Only the crypto/action clock is re-armed here. A pending showdown-hold
    // settlement is NOT a turn timer and must survive (a re-arm happens while
    // the audit phase is waiting for keys, for instance).
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      // A timer-driven failure (settle invariants, a broadcast) must never take
      // down the process. Hand-level settlement failures are isolated further
      // inside `publishSettlement`; this is the timer backstop.
      try {
        this.onTimeout();
      } catch (err) {
        hdbg('onTimeoutFailed', {
          id: this.id,
          phase: this.phase,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }, ms);
    hdbg('armTimer', {
      id: this.id,
      phase: this.phase,
      toAct: this.betting?.toAct,
      ms,
      lastDeadline: this.lastDeadline,
      actionSeq: this.actionSeq,
    });
  }

  private onTimeout(): void {
    hdbg('onTimeout', {
      id: this.id,
      phase: this.phase,
      toAct: this.betting?.toAct,
      retriesLeft: this.retriesLeft,
      lastDeadline: this.lastDeadline,
      actionSeq: this.actionSeq,
    });
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
        // Never leave a live betting round without a pending timer: if there is
        // no actor to fold (should be impossible) or the auto-fold is rejected,
        // re-arm instead of stalling the hand forever.
        const rearm = () => this.armTimer(Math.max(250, this.opts.actionTimeoutMs || 1000));
        if (seat === null || seat === undefined) {
          hdbg('timeoutBranch', { id: this.id, branch: 'seat-null' });
          rearm();
          return;
        }
        const potAtFold = this.potTotal();
        this.appendServer('timeout_fold', {
          seat,
          actionSeq: this.actionSeq,
          street: this.betting?.street ?? 'preflop',
          amountAdded: 0,
          potBefore: potAtFold,
          potAfter: potAtFold,
          ts: Date.now(),
        });
        const ok = this.applyEngineAction(seat, { type: 'fold' }, true);
        hdbg('timeoutBranch', { id: this.id, branch: ok ? 'ok' : 'apply-false', seat });
        if (ok) {
          // count the auto-fold; a second in a row stands the player up at the
          // hand boundary (the removal is deferred: the hand owns the seat)
          const uid = this.seats.find((s) => s.seat === seat)?.userId;
          if (uid !== undefined) this.room.noteTimeout(uid);
        } else rearm();
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
        this.publishSettlement();
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

  private abort(reason: string, blamedSeat: number | null, force = false): void {
    // `force` lets a graceful shutdown abort a hand whose phase is already
    // 'done' because its settlement retries were exhausted: no chips moved, so
    // marking the lifecycle `aborted` is what keeps a restart from freezing the
    // room. It must never touch a hand whose settlement committed.
    if (this.settlementApplied) return;
    if (this.phase === 'done' && !force) return;
    this.clearTimer();
    // A pending pre-betting grace timer has no hand left to act on: drop it.
    for (const t of this.goneTimers.values()) clearTimeout(t);
    this.goneTimers.clear();
    // Durable intent FIRST: a forced abort must not tear the hand down (or
    // broadcast an abort) unless the `aborted` row is confirmed, otherwise a
    // failed durable update would leave a `running` row behind while the room
    // was silently cleared.
    const confirmed = this.markLifecycleAborted();
    if (force && !confirmed) throw new Error('lifecycle abort could not be confirmed');
    // Structured, always-on telemetry: exactly ONE line per real abort (after
    // the early returns and the durable intent). Fail-open, pure reads only -
    // it must never perturb the fail-closed semantics below.
    this.logHandAbort(reason, blamedSeat, force);
    this.phase = 'done';
    this.appendServer('hand_abort', { reason, blamedSeat });
    // an aborted hand moves no chips, no ledger rows and no time bank: put any
    // claimed manual trigger back so the next deal can pick it up again
    this.releaseFeatureClaims();
    // no sitting-out penalty: the next deal already skips disconnected players,
    // and punishing a flaky connection kept locking people out of their seat
    this.safeBroadcast({ t: 'hand_abort', handId: this.id, reason, blamedSeat });
    this.onDone();
  }

  /**
   * Label an abort for the B8a metric: the **live in-process `Hand.abort()`
   * rate, by reason category**. SCOPE: this ONLY covers aborts raised inside
   * this class. It deliberately does NOT cover the durable operator/reconciler
   * abort (`settlementWriter.abortPendingHandSettlement`, `transcriptReconcile`)
   * - those never call `abort()` and need their own telemetry.
   *
   * Pure and side-effect free: it only reads the existing free-form `reason`
   * plus the blamed seat's live socket, and never gates the abort.
   *
   * `timeout_disconnected` is a CORRELATION, not a cause: the abort was a
   * timeout AND the blamed seat had no live socket at that moment. Do not read
   * it as proof the dropout caused the abort.
   */
  private abortCategory(reason: string, blamedSeat: number | null): string {
    if (reason === 'player left during the deal') return 'player_disconnected';
    if (reason.startsWith('server shutdown')) return 'shutdown';
    if (reason.endsWith('timeout')) {
      const info =
        blamedSeat === null ? undefined : this.seats.find((s) => s.seat === blamedSeat);
      return info && !this.room.isConnected(info.userId) ? 'timeout_disconnected' : 'timeout';
    }
    // Explicit per-reason map: a future non-crypto reason must fall through to
    // `unknown`, never be silently mislabelled `crypto_protocol`.
    if (
      reason === 'invalid deck from shuffler' ||
      reason === 'shuffled deck has duplicates' ||
      reason === 'malformed unmask point' ||
      reason === 'invalid unmask proof'
    )
      return 'crypto_protocol';
    if (reason.includes('not a card') || reason.includes('mis-shuffle')) return 'mis_shuffle';
    return 'unknown';
  }

  /**
   * Emit ONE structured, always-on abort telemetry line (reusing the server's
   * `[tag] {json}` convention, cf. `[llm-metric]`/`[preflop-telemetry]`).
   *
   * SCOPE: `"scope":"live"` marks a live in-process `Hand.abort()` event. It
   * does NOT stand for operator/reconciler durable aborts
   * (`settlementWriter.abortPendingHandSettlement`, `transcriptReconcile`) -
   * they never call `abort()` and need their own telemetry. Grep/aggregate on
   * `scope` before counting aborted hands.
   *
   * Fail-open by construction: a logging failure must never affect the abort.
   */
  private logHandAbort(reason: string, blamedSeat: number | null, force: boolean): void {
    try {
      const seatsLive = this.betting
        ? this.betting.seats.filter((s) => !s.folded).length
        : this.n;
      console.log(
        `[hand_abort] ${JSON.stringify({
          event: 'hand_abort',
          scope: 'live',
          reason: this.abortCategory(reason, blamedSeat),
          detail: reason,
          handId: this.id,
          roomId: this.roomId,
          phase: this.phase,
          seatsLive,
          boardComplete: this.boardCards.size >= 5,
          blamedSeat,
          force,
        })}`,
      );
    } catch {
      /* telemetry must never affect the abort flow */
    }
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

  /** Mark this hand's durable lifecycle aborted. Only ever clears a
   *  non-terminal row: a hand that already committed its settlement is left
   *  `committed` (a late abort must not rewrite history). Returns whether the
   *  durable row is now provably terminal (`aborted` or `committed`) - a caller
   *  that needs the guarantee (shutdown) must not tear the hand down otherwise. */
  private markLifecycleAborted(): boolean {
    try {
      this.db
        .prepare(
          `UPDATE hand_lifecycle SET status = 'aborted', updated_at = ?, resolved_at = ?
            WHERE hand_id = ? AND status IN ('running','prepared','quarantined')`,
        )
        .run(Date.now(), Date.now(), this.id);
    } catch {
      // fall through to the read-back below: a failed write is only fatal if the
      // row is not already terminal.
    }
    return this.lifecycleTerminal();
  }

  /** Read back whether this hand's durable lifecycle row is terminal. */
  private lifecycleTerminal(): boolean {
    try {
      const row = this.db
        .prepare('SELECT status FROM hand_lifecycle WHERE hand_id = ?')
        .get(this.id) as { status?: string } | undefined;
      return row?.status === 'committed' || row?.status === 'aborted';
    } catch {
      return false;
    }
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
    // A hand whose terminal `hand_end` already went out is fully over: `onDone`
    // clears `GameRoom.hand` in the same tick, so nothing is owed here.
    if (this.handEndBroadcast) return;
    // During the post-showdown hold the settlement is already durable and the
    // reveal was broadcast exactly once. A participant who reconnects in that
    // window must get the FULL terminal context back - not just the reveal - so
    // a freshly-created client (page refresh) can rebuild the board and its own
    // private cards. Never replay a betting snapshot here: the hand is over.
    if (this.settlementApplied) {
      // A seated participant gets their own `hand_start` + private cards; a
      // spectator (no seat) still gets the public replay: the board, the
      // showdown reveal and the squid result. Private frames never go to a
      // non-seat, so a late spectator neither sees cards nor opens a turn.
      if (info && this.startMsg) this.room.send(userId, this.startMsg);
      this.replayPublicState(userId, info);
      if (this.settlement?.showdown) this.room.send(userId, this.settlement.showdown);
      const squid = this.settlement?.squid;
      if (squid)
        this.room.send(userId, {
          t: 'squid_result',
          handId: this.id,
          winners: squid.winners,
          transfers: squid.transfers,
          requestedPerLoser: squid.requestedPerLoser,
          paidBySeat: squid.paidBySeat,
          noClaimant: squid.noClaimant,
          netBySeat: [...squid.netBySeat.entries()].map(([seat, net]) => ({ seat, net })),
        } as ServerMsg);
      return;
    }
    // A durable settlement failure is broadcast once and can be missed; a
    // freshly-created client (page refresh) has no other signal that the table
    // is frozen or auto-retrying. Re-assert the current failure on every
    // (re)connect so the host recovery control can never be unreachable.
    // Deliberately before the `!info` return: the frame carries no private
    // information, and a rejoining spectator should also see the table frozen.
    if (!this.settlementApplied && this.settlementError !== null) {
      this.room.send(userId, {
        t: 'settlement_failed',
        handId: this.id,
        reason: this.settlementError,
        attempt: this.settlementAttempts,
        retrying: this.settlementAttempts <= SETTLE_MAX_RETRIES,
      } as ServerMsg);
    }
    if (!info) return;
    if (this.startMsg) this.room.send(userId, this.startMsg);
    this.replayPublicState(userId, info);
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

  /**
   * Replay the frames that reconstruct the public board and this seat's own
   * private cards. These frames are idempotent context (not a betting snapshot),
   * so replaying them mid-hand or after settlement is always safe.
   */
  private replayPublicState(userId: number, info: HandSeatInfo | undefined): void {
    if (info) {
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
  }

  // ---------- transcript ----------

  private appendServer(type: string, payload: unknown): void {
    const sig = signContent(this.serverId.secretKey, this.id, type, payload);
    const e = this.transcript.append({ type, from: this.serverId.publicKey, payload, sig });
    this.publish({
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
    this.publish({
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
    // Record the show first: if the fold-winner 7-2 bounty transfer throws, it
    // un-marks the table's shown seat, so a retry can still pay it. Only mark
    // this hand as shown once that succeeded.
    if (!this.room.recordShow(this.id, info.seat, cards)) return;
    this.shownSeats.add(info.seat);
    // After settlement the transcript is sealed (its head is already committed
    // to `hand_settlements`/`transcripts`), so a show during the reveal hold is
    // a live-only courtesy: broadcast it, but never append to the sealed chain.
    if (!this.settlementApplied) this.appendPlayer('show_cards', info.pubkey, { shares }, sig);
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
      endedByFold: this.betting?.winnerByFold !== null && this.betting?.winnerByFold !== undefined,
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
    this.publish({
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
    this.publish({ t: 'deck_state', handId: this.id, seat: info.seat, deck: deckHexes });
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
    this.publish({
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
        this.publish({
          t: 'board_open',
          handId: this.id,
          deckIndex: chain.deckIndex,
          card,
          ...(run > 1 ? { run: run as 2 | 3 } : {}),
        });
        this.pendingBoard.delete(chain.deckIndex);
        // live all-in bubble: refresh once this run's board completes a street
        this.maybePushStreetEquity(run);
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
    // Forced posts, before any voluntary action. `startHand` commits index 0 as
    // the small blind and index 1 as the big blind (heads-up: the button is the
    // small blind). Recorded so the stats layer can separate forced chips from
    // VPIP/PFR decisions. potBefore/potAfter accumulate per post (SB then BB).
    let blindPot = 0;
    const blindPosts = this.betting.seats.slice(0, 2).map((s, i) => {
      const amount = s.committed;
      const potBefore = blindPot;
      blindPot += amount;
      return {
        seat: s.seat,
        userId: this.seats.find((x) => x.seat === s.seat)!.userId,
        kind: i === 0 ? 'sb' : 'bb',
        nominal: i === 0 ? this.sb : this.bb,
        amount,
        stackAfter: s.stack,
        potBefore,
        potAfter: blindPot,
        allIn: s.allIn,
      };
    });
    this.appendServer('blind_post', { posts: blindPosts, ts: Date.now() });
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
    // The ante is the only preflop event in a bomb pot (never a VPIP action).
    // potBefore/potAfter accumulate in seat order.
    let antePot = 0;
    const antePosts = this.betting.seats.map((s) => {
      const amount = s.total;
      const potBefore = antePot;
      antePot += amount;
      return {
        seat: s.seat,
        userId: this.seats.find((x) => x.seat === s.seat)!.userId,
        kind: 'ante',
        nominal: ante,
        amount,
        stackAfter: s.stack,
        potBefore,
        potAfter: antePot,
        allIn: s.allIn,
      };
    });
    this.appendServer('ante_post', { posts: antePosts, ts: Date.now() });
    this.publish({
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
      hdbg('beginTurnTimer:noArm', {
        id: this.id,
        hasBetting: !!st,
        toAct: st?.toAct ?? null,
        actionTimeoutMs: this.opts.actionTimeoutMs,
      });
      this.turnBaseDeadline = null;
      this.lastDeadline = null;
      return;
    }
    const now = Date.now();
    this.turnBaseDeadline = now + this.opts.actionTimeoutMs;
    const bank = this.timeBanks().get(st.toAct) ?? 0;
    this.lastDeadline = this.turnBaseDeadline + bank;
    hdbg('beginTurnTimer', {
      id: this.id,
      toAct: st.toAct,
      actionTimeoutMs: this.opts.actionTimeoutMs,
      lastDeadline: this.lastDeadline,
    });
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
    this.publish({
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
    hdbg('broadcastBetting', {
      id: this.id,
      actionSeq: this.actionSeq,
      toAct: this.betting?.toAct,
      currentBet: this.betting?.currentBet,
      deadline: this.lastDeadline,
      seats: this.betting?.seats.map((s) => ({
        seat: s.seat,
        stack: s.stack,
        folded: s.folded,
        allIn: s.allIn,
        committed: s.committed,
        lastActedAt: s.lastActedAt,
      })),
    });
    this.publish({
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

  /** Chips already committed to the pot this hand (side-pot basis). */
  private potTotal(st: BettingState | null = this.betting): number {
    return st ? st.seats.reduce((s, x) => s + x.total, 0) : 0;
  }

  private onAction(info: HandSeatInfo, action: PlayerAction, sig: string): void {
    if (this.phase !== 'betting' || !this.betting)
      return this.err(info.userId, 'not in a betting round');
    hdbg('onAction', {
      id: this.id,
      seat: info.seat,
      action,
      toAct: this.betting.toAct,
      deadline: this.lastDeadline,
      now: Date.now(),
      actionSeq: this.actionSeq,
    });
    // Server-side deadline enforcement: at/after the final deadline the ONLY
    // successful transition is the timeout auto-fold. A late action arriving
    // before the timer callback fires is rejected here so a race cannot beat it.
    if (this.lastDeadline !== null && Date.now() >= this.lastDeadline) {
      hdbg('onActionRejected', { id: this.id, seat: info.seat, reason: 'after deadline' });
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
    hdbg('applyEngineAction', {
      id: this.id,
      seat,
      action,
      auto,
      phase: this.phase,
      toAct: this.betting?.toAct,
      actionSeq: this.actionSeq,
    });
    const beforeState = this.betting!;
    const beforeSeat = beforeState.seats.find((x) => x.seat === seat);
    const potBefore = this.potTotal(beforeState);
    try {
      this.betting = applyAction(this.betting!, seat, action);
    } catch (e) {
      // an illegal, out-of-turn, stale or duplicate action must not consume the
      // actor's time bank and must not be recorded as a normal action
      const reason = e instanceof Error ? e.message : 'illegal action';
      hdbg('applyRejected', {
        id: this.id,
        seat,
        action,
        reason,
        phase: this.phase,
        toAct: this.betting?.toAct,
      });
      this.appendServer('action_rejected', { seat, reason });
      if (userId !== undefined) this.err(userId, reason);
      return false;
    }
    // This action's authoritative, 0-based index in the hand: the count of
    // actions already applied. It equals the `actionSeq` the betting_state for
    // the current turn advertised, so a client that sent the action can match
    // it back exactly even after a reconnect/missed frame. Captured before the
    // counter is incremented below.
    const seq = this.actionSeq;
    if (record) {
      // The player's signature only covers `{action}` (see signedBodyOf); the
      // stats fields below are server-supplied and never alter what was signed.
      const afterSeat = this.betting!.seats.find((x) => x.seat === seat);
      this.appendPlayer(
        'action',
        record.pubkey,
        {
          action,
          seat,
          actionSeq: seq,
          street: beforeState.street,
          amountAdded: (afterSeat?.total ?? 0) - (beforeSeat?.total ?? 0),
          potBefore,
          potAfter: this.potTotal(),
          ts: Date.now(),
        },
        record.sig,
      );
    }
    // the action really applied: charge the clock it used past the base deadline
    this.consumeTurnTime(seat);
    // a real (non-timeout) action clears the consecutive-timeout streak
    if (!auto) {
      const uid = this.seats.find((s) => s.seat === seat)?.userId;
      if (uid !== undefined) this.room.noteVoluntaryAction(uid);
    }
    this.actionSeq++;
    this.publish({
      t: 'action_applied',
      handId: this.id,
      seat,
      action,
      actionSeq: seq,
      ...(auto ? { auto: true } : {}),
    });
    this.coordinateTurn();
    hdbg('applyOk', {
      id: this.id,
      seat,
      action,
      auto,
      newToAct: this.betting?.toAct,
      actionSeq: this.actionSeq,
      phase: this.phase,
    });
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
    hdbg('coordinateTurn', {
      id: this.id,
      street: st.street,
      toAct: st.toAct,
      closed: streetClosed(st),
      initial,
      actionSeq: this.actionSeq,
    });
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
      this.appendServer('street', {
        street: this.betting.street,
        board: this.currentBoard(),
        streetIndex: STREET_INDEX[this.betting.street] ?? 0,
        potAfter: this.potTotal(),
        ts: Date.now(),
      });
      this.coordinateTurn(true);
      return;
    }
    this.betting = nextStreet(this.betting!);
    this.phase = 'betting';
    this.appendServer('street', {
      street: this.betting.street,
      board: this.currentBoard(),
      streetIndex: STREET_INDEX[this.betting.street] ?? 0,
      potAfter: this.potTotal(),
      ts: Date.now(),
    });
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
      if (this.goneTimers.has(userId)) return;
      const graceMs = this.opts.goneGraceMs ?? GONE_ABORT_GRACE_MS;
      this.goneTimers.set(
        userId,
        setTimeout(() => {
          this.goneTimers.delete(userId);
          if (preBetting() && !this.room.isConnected(userId)) {
            this.abort('player left during the deal', info.seat);
          }
        }, graceMs),
      );
      return;
    }
    if (this.phase !== 'deal' && this.phase !== 'reveal') return;
    // a folded player's escrowed key lets us finish without them
    if (this.recoverStalledChains(false)) return;
    this.foldDroppedIfDecisive(info.seat);
  }

  /**
   * A participant's socket came back. A pre-betting grace timer exists only to
   * give a *blip* time to recover, so the moment they are reachable again it has
   * no reason to fire - cancel it. This is what keeps the grace about a
   * persistent absence rather than about beating the reconnect clock: without
   * it, a reconnect racing the deadline could still lose the hand.
   *
   * Deliberately per-user: another player dropping in the same window keeps
   * their own guard untouched.
   */
  onPlayerReconnected(userId: number): void {
    const pending = this.goneTimers.get(userId);
    if (!pending) return;
    clearTimeout(pending);
    this.goneTimers.delete(userId);
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
    // A showdown settlement already computed (holding for its reveal) must not
    // be re-settled by a disconnect racing the hold.
    if (this.settlement) return;
    const mine = st.seats.find((s) => s.seat === seat);
    if (!mine || mine.folded) return;
    const seats = st.seats.map((s) => (s.seat === seat ? { ...s, folded: true } : { ...s }));
    const live = seats.filter((s) => !s.folded);
    if (live.length !== 1) return;

    this.clearTimer();
    this.chains.clear();
    this.pendingBoard.clear();
    const droppedPot = this.potTotal(st);
    this.appendServer('timeout_fold', {
      seat,
      actionSeq: this.actionSeq,
      street: st.street,
      amountAdded: 0,
      potBefore: droppedPot,
      potAfter: droppedPot,
      ts: Date.now(),
    });
    // Terminal off-book fold (settles the hand immediately, so the counter is
    // never consumed further): stamp it with the index it would occupy so the
    // frame still carries an authoritative, collision-free `actionSeq`.
    this.publish({
      t: 'action_applied',
      handId: this.id,
      seat,
      action: { type: 'fold' },
      auto: true,
      actionSeq: this.actionSeq,
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
    this.publish({
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

  /** Only the cards of `run` that have actually been opened so far (unlike
   *  `boardForRun`, which pads unopened positions with `undefined`). */
  private openedBoardForRun(run: number): CardId[] {
    return this.runBoardIndexes(run)
      .filter((i) => this.boardCards.has(i))
      .map((i) => this.boardCards.get(i)!);
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

  /** After an all-in runout card opens, publish the live bubble equity once the
   *  run's board reaches a complete street (flop=3, turn=4, river=5). Partial
   *  streets cannot be measured exactly and are skipped. */
  private maybePushStreetEquity(run: number): void {
    const cards = this.openedBoardForRun(run);
    if (cards.length !== 3 && cards.length !== 4 && cards.length !== 5) return;
    this.pushRunoutEquity(run, cards);
  }

  /** Whether this hand can still publish live bubble equity (not settled). */
  private runoutAlive(): boolean {
    return this.phase !== 'done';
  }

  /** Compute — on the equity worker, never the main thread — and publish the
   *  pot equity of every live all-in player for one run's board. `dead` carries
   *  the cards already opened in the other runs, so a later run's percentage
   *  reflects the cards the earlier run burnt. A failed compute just skips the
   *  update: the bubble is advisory. */
  private pushRunoutEquity(run: number, cards: CardId[]): void {
    // Bubbles are a multi-run-adjacent feature: rooms that never enabled it
    // must see their all-ins exactly as before.
    if (!this.features.multiRun.enabled) return;
    if (!this.runout || this.phase === 'done') return;
    // A preflop all-in shows the preflop number (Monte Carlo) the moment the
    // reveal goes public; a completed flop/turn/river shows the exact number.
    // A partial street (1-2 cards) has no meaningful measure and is skipped.
    if (cards.length === 1 || cards.length === 2) return;
    const live = this.betting?.seats.filter((s) => !s.folded) ?? [];
    if (live.length < MULTI_RUN_HEADS_UP_SEATS) return;
    const holes: [CardId, CardId][] = [];
    const seats: number[] = [];
    for (const s of live) {
      const revealed = this.reveals.get(s.seat);
      if (!revealed || revealed.length !== 2) return; // only once every hand is public
      holes.push([revealed[0]!, revealed[1]!]);
      seats.push(s.seat);
    }
    const mine = this.runBoardIndexes(run);
    const dead: CardId[] = [];
    for (const [idx, card] of this.boardCards) if (!mine.includes(idx)) dead.push(card);
    const handId = this.id;
    const runs = this.runs;
    this.equityChain = this.equityChain.then(async () => {
      if (!this.runoutAlive()) return;
      // A stuck worker (or a burst of resets) must not let a preflop job trail
      // into the flop/turn of a hand that has already dealt on: drop anything
      // that starts after the hand's equity deadline.
      if (Date.now() > this.equityHandDeadline) return;
      let res: MultiwayEquityResult;
      try {
        res = await computeMultiwayEquity({
          holes,
          board: cards,
          seed: `${handId}:bubble:${run}:${cards.length}`,
          dead,
        });
      } catch {
        return; // advisory only: a failed bubble update is not a hand error
      }
      // A worker that lands just after the runout finished still carries the
      // last street's number; clients ignore any frame past the hand's result.
      this.publish({
        t: 'equity_update',
        handId,
        run,
        runs,
        board: cards,
        equities: seats.map((seat, i) => ({ seat, bps: res.equitiesBps[i] ?? 0 })),
      });
    });
  }

  /** Wire `stage` values are `choice` (= the contract's "behind-chooses") and
   *  `agreement` (= "ahead-agrees"), matching `MultiRunStage` in
   *  packages/shared/src/wsProtocol.ts. See docs/p2-gameplay-design.md 2.6. */
  private sendMultiRunOffer(state: NonNullable<Hand['multiRun']>): void {
    this.publish({
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
    // Fixed product rule: multi-run exists only for a heads-up all-in. A pot
    // with three or more live players always runs the board exactly once.
    if (live.length !== MULTI_RUN_HEADS_UP_SEATS)
      return this.finishMultiRun(1, 'ineligible');
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
        const ms = this.opts.ritVoteMs ?? RIT_VOTE_MS;
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
    const ms = this.opts.ritVoteMs ?? RIT_VOTE_MS;
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
    this.publish({
      t: 'multi_run_result',
      handId: this.id,
      runs: resolved,
      reason,
      sharedBoard: this.currentBoard(),
    } as ServerMsg);
    // The reveal is public now: put the first live equity bubble on the table
    // for run 1's starting board (preflop when nothing is open yet). Arm the
    // hand's equity deadline first so the chained jobs can bound their tail.
    this.equityHandDeadline = Date.now() + EQUITY_HAND_DEADLINE_MS;
    this.pushRunoutEquity(1, this.openedBoardForRun(1));
    // Deal the runout only after that first bubble is on the wire, so the client
    // always sees the reveal + a win rate before the first board card. When no
    // bubble was scheduled (feature off, partial board) the chain is already
    // resolved and dealing starts on the next microtask.
    //
    // Accepted UX cost, deliberately KEPT (not a bug): chaining the deal behind
    // the first preflop equity makes the first community card wait for one
    // 25,000-trial Monte Carlo enumeration - measured ~2040 ms cold / ~1220 ms
    // warm on the dev box, i.e. roughly a 1-2 s gap between the reveal and the
    // first board card on a preflop all-in. The product decision is the strict
    // "bubble first, then deal" order; racing the board ahead of the bubble is
    // the alternative that was rejected. See docs/qa/run-equity/README.md.
    this.equityChain = this.equityChain.then(() => {
      if (this.remainingRunoutCount() > 0) this.openRemainingRunoutBoards();
      else this.settle();
    });
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
    // All-in runout: the hole cards are public now. Announce the reveal on its
    // own BEFORE the run-count decision and any equity bubble, so the client
    // flips the cards first and only then shows a win rate — the requested
    // order "reveal, then equity". A normal showdown needs no separate frame:
    // `settle()` below broadcasts `showdown` (with the same reveals) at once.
    if (this.runout) this.broadcastRunoutReveal();
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

  /** Broadcast every live all-in seat's now-public hole cards as its own
   *  non-durable frame. Only called on the all-in runout path, where the cards
   *  are public by rule; it never precedes the reveal crypto. */
  private broadcastRunoutReveal(): void {
    const reveals: { seat: number; cards: CardId[] }[] = [];
    for (const s of this.betting?.seats.filter((x) => !x.folded) ?? []) {
      const cards = this.reveals.get(s.seat);
      if (cards && cards.length === 2) reveals.push({ seat: s.seat, cards: [...cards] });
    }
    if (reveals.length === 0) return;
    this.publish({ t: 'runout_reveal', handId: this.id, reveals });
  }

  // ---------- settlement ----------

  private settle(): void {
    // `settle` computes the outcome exactly once per hand. A disconnect racing
    // the showdown hold can call foldDroppedIfDecisive, but a settlement already
    // in flight must never be recomputed or double-broadcast.
    if (this.settlement || this.phase === 'done') return;
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
    const runBoards =
      runs > 1 ? Array.from({ length: runs }, (_, i) => this.boardForRun(i + 1)) : [];
    const {
      awards,
      showdown: showdownMsg,
      winnerSets,
    } = computeShowdown({
      handId: this.id,
      winnerByFold: st.winnerByFold,
      reveals: this.reveals,
      runs,
      runBoards,
      board,
      pots,
      dealingOrder,
    });

    const pokerDeltas = st.seats.map((s) => ({
      seat: s.seat,
      delta: (awards.get(s.seat) ?? 0) - s.total,
    }));
    const pokerStacks = st.seats.map((s) => ({
      seat: s.seat,
      stack: s.stack + (awards.get(s.seat) ?? 0),
    }));
    // Squid is assessed on the stacks as they stand after the poker pot pays out.
    const squid = computeSquidSettlement(
      this.features.squid.settings,
      this.seats.map((s) => s.seat),
      this.bb,
      winnerSets,
      pokerStacks,
    );
    const stacks = pokerStacks.map((s) => ({
      seat: s.seat,
      stack: s.stack + (squid?.netBySeat.get(s.seat) ?? 0),
    }));
    // Resolve the rake recipient (and its seat when it is in the hand) ONCE, so
    // the transcript payload, the durable write and `hand_end` all name the
    // same account. The configured platform account wins; else the in-room
    // banker. A recipient with no seat has no commission leg on the wire.
    const settleRoom = getRoom(this.db, this.roomId);
    const rakeRecipientId =
      rake > 0 && settleRoom ? (platformUserId(this.db) ?? settleRoom.banker_id) : null;
    const commissionSeat =
      rakeRecipientId !== null
        ? this.seats.find((s) => s.userId === rakeRecipientId)?.seat
        : undefined;
    const commissionDeltas =
      commissionSeat !== undefined ? [{ seat: commissionSeat, delta: rake }] : [];
    this.settlement = {
      awards,
      pokerDeltas,
      stacks,
      showdown: showdownMsg,
      rake,
      squid,
      bounty: null,
      rakeRecipientId,
      commissionDeltas,
    };
    // Resolve the automatic showdown 7-2 bounty now, against the post-pot
    // stacks, so it is part of the hand's deltas and `ending_stack` from the
    // start. The durable writer moves the chips exactly once via `stackDeltas`
    // (the bounty is folded in) and only records the `seven-deuce` ledger legs.
    const bountyInfo = this.sevenDeuceBounty();
    if (bountyInfo) {
      const available = new Map(stacks.map((s) => [s.seat, Math.max(0, s.stack)]));
      const payout: { seat: number; delta: number }[] = [];
      let total = 0;
      for (const info of this.seats) {
        if (info.seat === bountyInfo.winnerSeat) continue;
        const amt = Math.min(bountyInfo.bonus, available.get(info.seat) ?? 0);
        if (amt <= 0) continue;
        payout.push({ seat: info.seat, delta: -amt });
        total += amt;
      }
      if (total > 0) {
        payout.push({ seat: bountyInfo.winnerSeat, delta: total });
        this.settlement.bounty = { seat: bountyInfo.winnerSeat, amount: total, payout };
      }
    }

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
    const bountyBySeat = new Map(
      (this.settlement.bounty?.payout ?? []).map((d) => [d.seat, d.delta]),
    );
    // Combined poker+squid+bounty nets: the `settlement` transcript entry's
    // deltas and the hand_end deltas, and the exact per-seat stack movement.
    const combined = pokerDeltas.map((d) => ({
      seat: d.seat,
      delta: d.delta + (squid?.netBySeat.get(d.seat) ?? 0) + (bountyBySeat.get(d.seat) ?? 0),
    }));
    // Poker view as the stats projection must see it, so its
    // `net_delta === ending_stack - starting_stack` (the bounty is zero-sum).
    const pokerDeltasForProjection = pokerDeltas.map((d) => ({
      seat: d.seat,
      delta: d.delta + (bountyBySeat.get(d.seat) ?? 0),
    }));
    const netBySeat = [...(squid?.netBySeat.entries() ?? [])].map(([seat, net]) => ({ seat, net }));
    this.appendServer('settlement', {
      board,
      ...(runs > 1
        ? { boards: Array.from({ length: runs }, (_, i) => this.boardForRun(i + 1)) }
        : {}),
      ...(rake > 0 ? { commission: rake } : {}),
      // The commission leg as a SEAT projection, exactly as `hand_end` emits
      // it (empty when the recipient - platform or fallback banker - is out of
      // hand). Persisted so a historical replay can recover the recipient seat
      // without reverse-engineering it from the final stacks.
      commissionDeltas,
      awards: [...awards.entries()].map(([seat, amount]) => ({ seat, amount })),
      deltas: combined,
      // Poker split so stats never have to reverse-engineer squid out of the
      // combined deltas (old transcripts have no such field). Carries the
      // bounty too, so `net_delta === poker + squid` holds in the projection.
      pokerDeltas: pokerDeltasForProjection,
      runCount: runs,
      grossPot: totalPot + rake,
      showdown: showdownMsg !== null,
      ts: Date.now(),
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
    if (this.auditMode === 'strict-audit' || this.opts.tvReplays) {
      // TV replays: collect everyone's per-hand key so the stored transcript
      // can show ALL hole cards, WSOP broadcast style. The audit entries are
      // part of the persisted transcript, so the durable write (and the reveal)
      // wait for the keys - or the timeout, which settles best-effort.
      // (requested by notpritam, docs/FEATURES.md)
      this.phase = 'audit';
      // Only the players dealt into THIS hand hold a per-hand key; a spectator
      // or a seated-but-sitting-out member has none, so asking them is noise at
      // best (and a client that never received cards has no key to answer with).
      // The settlement still waits for exactly `this.n` keys.
      for (const s of this.seats) this.room.send(s.userId, { t: 'need_keys', handId: this.id });
      this.armTimer(this.opts.cryptoTimeoutMs);
      if (this.revealedKeys.size === this.n) this.publishSettlement();
      return;
    }
    // No audit: settle + reveal immediately. `publishSettlement` writes the
    // durable settlement BEFORE broadcasting the reveal, then holds `hand_end`.
    this.publishSettlement();
  }

  private onRevealKey(info: HandSeatInfo, keyHex: string, sig: string): void {
    // The transcript was sealed by `persistSettlement`; once we are past the
    // audit phase a key is DISCARDED, not a live frame: no `hole_cards` are
    // broadcast (unlike `show_cards`, which is live-only) and the committed
    // head cannot change. It is simply lost.
    if (this.phase !== 'audit' || this.settlementApplied) return;
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
    if (this.revealedKeys.size === this.n) this.publishSettlement();
  }

  /**
   * Publish a computed settlement. This is the ordering contract:
   *
   *   1. `persistSettlement()` writes the whole hand (chips, ledger, transcript,
   *      stats projection, `hand_settlements` marker) in ONE synchronous
   *      transaction - the durability point. A crash any time after this can
   *      never lose a hand whose cards were already made public.
   *   2. Only then is the `showdown` reveal broadcast.
   *   3. `hand_end` is delayed by the reveal hold (and, for audit hands, waits
   *      for the replay keys - which are part of the persisted transcript).
   *
   * Any early/repeated call (an audit key arriving after the timeout, a
   * disconnect racing the hold) is a no-op.
   */
  private publishSettlement(): void {
    if (!this.settlement || this.settlementApplied) return;
    let outcome: HandSettlementOutcome;
    try {
      outcome = this.persistSettlement();
    } catch (err) {
      // NOT committed: isolate, keep the deterministic result for a retry, and
      // never let the failure escape into a WS/timer callback.
      this.onPersistFailed(err);
      return;
    }
    // The durable write is proven (applied or an idempotent duplicate): a
    // recoverable settlement-failure mark can never be true any more.
    this.room.settlementRecovered();
    if (outcome.status === 'duplicate') {
      // A committed finalize already moved every chip for this hand. The full
      // receipt was loaded from durable state and adopted by `persistSettlement`
      // (final stacks, commission leg, bounty decision), so deliver the
      // historical terminal instead of dropping the hand silently. Re-mark the
      // bounty (idempotent) so a later voluntary show can never pay it twice.
      if (this.settlement.bounty && this.settlement.bounty.amount > 0)
        this.room.markSevenDeucePaid(this.id);
      this.broadcastHandEnd();
      return;
    }
    const { showdown, squid } = this.settlement;
    // 2. the reveal frame, now that the chips are guaranteed to have moved.
    //    A failed notification must never undo a committed settlement.
    if (showdown) {
      this.safeBroadcast(showdown, {
        before: 'broadcast_before_showdown',
        after: 'broadcast_after_showdown',
      });
      this.showdownHoldUntil =
        this.clock.now() + (this.opts.showdownHoldMs ?? SHOWDOWN_HOLD_MS);
    }
    if (squid)
      // `netBySeat` is the authoritative per-seat outcome: with multiple losers
      // a seat can both pay and receive, so consumers must not assume only
      // `winners` receive chips.
      this.safeBroadcast(
        {
          t: 'squid_result',
          handId: this.id,
          winners: squid.winners,
          transfers: squid.transfers,
          requestedPerLoser: squid.requestedPerLoser,
          paidBySeat: squid.paidBySeat,
          noClaimant: squid.noClaimant,
          netBySeat: [...squid.netBySeat.entries()].map(([seat, net]) => ({ seat, net })),
        } as ServerMsg,
        { before: 'broadcast_before_squid' },
      );
    // The automatic 7-2 bounty already moved inside the durable transaction;
    // only its live frame is presentation and may be lost without harm.
    if (this.settlementSevenDeuce && this.settlementSevenDeuce.amount > 0) {
      this.safeBroadcast(
        {
          t: 'seven_deuce',
          handId: this.id,
          seat: this.settlementSevenDeuce.seat,
          amount: this.settlementSevenDeuce.amount,
        },
        { before: 'broadcast_before_seven_deuce' },
      );
      this.safeBroadcastRoomState();
    }
    // 3. terminal frame only after the reveal hold elapses
    this.scheduleHandEnd();
  }

  /**
   * Best-effort publisher for every Hand WS frame. A delivery failure is
   * notification-only: it is logged and swallowed, so it can never unwind the
   * caller, mutate lifecycle/phase, undo a committed settlement, or bubble up
   * to the hub where an escaping error would mark the whole room unhealthy.
   * Settlement-path frames that carry test fault hooks go through
   * `safeBroadcast`, which brackets this publisher with its fault points.
   * Never rethrows: the shared tiered logger only changes how loudly a failure
   * is reported. Returns whether the frame was handed to the transport.
   */
  private publish(msg: ServerMsg, label = 'hand broadcast failed'): boolean {
    try {
      this.room.broadcast(msg);
      return true;
    } catch (err) {
      logBroadcastFailure(this.id, label, msg.t, err);
      return false;
    }
  }

  /** A settlement-path broadcast is notification only: swallow transport/DB
   *  failures so a committed hand always finishes and never triggers a refund.
   *  The optional fault points bracket the frame and are swallowed with it: a
   *  lost notification is never allowed to undo a committed settlement. */
  private safeBroadcast(
    msg: ServerMsg,
    phases?: { before?: SettlementFaultPoint; after?: SettlementFaultPoint },
  ): void {
    try {
      if (phases?.before) this.opts.faultInjection?.phase?.(phases.before);
      this.opts.faultInjection?.broadcast?.(msg);
      const delivered = this.publish(msg, 'hand settlement broadcast failed');
      if (delivered && phases?.after) this.opts.faultInjection?.phase?.(phases.after);
    } catch (err) {
      logBroadcastFailure(this.id, 'hand settlement broadcast failed', msg.t, err);
    }
  }

  private safeBroadcastRoomState(): void {
    try {
      this.room.broadcastRoomState();
    } catch (err) {
      // Route through the SAME shared tiered logger as every other best-effort
      // broadcast (`Hand.publish`, `GameRoom.publish`/`publishRoomState`). The
      // try/catch swallow is unchanged - this stays the hand settlement path's
      // notification-only room_state - only the reporting is unified, so a
      // TypeError here is classified as an unexpected programming error instead
      // of an anonymous line.
      logBroadcastFailure(
        this.id,
        'hand settlement room_state broadcast failed',
        'room_state',
        err,
      );
    }
  }

  /**
   * A durable-write attempt failed (SQLITE_BUSY, projection rejection, ...).
   * The settlement is NOT committed, so the hand must not be torn down and no
   * next hand may be dealt over it. The already-computed settlement is kept
   * (retryable and deterministic); the failure is surfaced explicitly and
   * retried a bounded number of times before the table is held for a human.
   */
  private onPersistFailed(err: unknown): void {
    const reason = err instanceof Error ? err.message : String(err);
    this.settlementError = reason;
    this.settlementAttempts++;
    hdbg('settlementPersistFailed', {
      id: this.id,
      attempt: this.settlementAttempts,
      reason,
    });
    // A quarantined hand has a durable `quarantined` lifecycle row: re-running
    // the same frozen input cannot help, so freeze immediately and do not offer
    // a recoverable retry. Only an operator may resolve it.
    const quarantined = err instanceof PreparedInputError;
    const canRetry = !quarantined && this.settlementAttempts <= SETTLE_MAX_RETRIES;
    this.safeBroadcast({
      t: 'settlement_failed',
      handId: this.id,
      reason,
      attempt: this.settlementAttempts,
      retrying: canRetry,
    } as ServerMsg);
    if (!canRetry) {
      // Terminal: freeze the hand in place so the table cannot deal again until
      // an operator intervenes. `this.hand` stays set on the GameRoom and the
      // durable lifecycle row keeps `startHand`'s `firstUnsettledHand` guard
      // closed. The health mark is RECOVERABLE for BOTH classes: a quarantine
      // is a durable, operator-resolvable "money facts unknown" state (not an
      // unexplained programming error), so the DB-only operator abort/retry must
      // be able to release the room. A recoverable mark is only ever cleared by
      // `reconcileOperatorResolvedHand()` once the durable row is provably
      // terminal; a real programming error still escalates to the sticky,
      // non-recoverable mark in `markUnhealthy`.
      this.phase = 'done';
      this.room.markUnhealthy(`settlement failed: ${reason}`, { recoverable: true });
      return;
    }
    if (!this.settleTimer) {
      this.settleTimer = this.clock.setTimer(() => {
        this.settleTimer = null;
        this.publishSettlement();
      }, SETTLE_RETRY_MS);
    }
  }

  /**
   * Why an in-room settlement retry must be refused, or null when it may run.
   * Mirrors the HTTP operator-retry gate (`/api/admin/hands/:id/retry`): a
   * `quarantined` hand has a proven-bad frozen input whose only exit is the
   * operator abort, and an `aborted` hand is terminal. Never treat a quarantined
   * hand as auto-retryable - even if the underlying DB state were repaired
   * externally, the host retry must still be refused explicitly.
   */
  settlementRetryRefusalReason(): string | null {
    const lc = this.db
      .prepare('SELECT status FROM hand_lifecycle WHERE hand_id = ?')
      .get(this.id) as { status: string } | undefined;
    if (lc?.status === 'quarantined')
      return `hand ${this.id} is quarantined; settlement retry refused pending operator review`;
    if (lc?.status === 'aborted') return `hand ${this.id} is aborted; settlement retry refused`;
    return null;
  }

  /**
   * Host/operator recovery from a frozen settlement (retries exhausted). The
   * already-computed settlement is deterministic, and the write is idempotent
   * on the `hand_settlements` marker, so clearing the retry budget and writing
   * again is safe and can never double-pay. The retry re-reads the FROZEN input
   * from `hand_settlement_prepared` via `applyPreparedHandSettlement` (through
   * `persistSettlement`); it never rebuilds money inputs from the current room
   * state. Returns whether the hand is now settled. See DESIGN.md ("Settlement
   * recovery").
   */
  retrySettlement(): boolean {
    if (this.settlementApplied || !this.settlement) return false;
    // Refuse exactly the states the HTTP operator retry refuses.
    if (this.settlementRetryRefusalReason()) return false;
    this.settlementAttempts = 0;
    this.settlementError = null;
    this.clearTimer();
    this.publishSettlement();
    return this.settlementApplied;
  }

  /** True once the durable write has exhausted its retries (table frozen). */
  isSettlementFrozen(): boolean {
    return !this.settlementApplied && this.settlementAttempts > SETTLE_MAX_RETRIES;
  }

  /** The last recorded settlement failure, or null. Used by the room to clear
   *  exactly the settlement-failure health mark once the durable hand has been
   *  resolved out-of-band (operator abort/retry). */
  settlementFailureReason(): string | null {
    return this.settlementError;
  }

  /** True once this hand's settlement transaction has committed. */
  isSettlementCommitted(): boolean {
    return this.settlementApplied;
  }

  /** True once the hand has reached a lifecycle-terminal point: settled, its
   *  terminal frame broadcast, or aborted. A hand whose settlement retries were
   *  exhausted reports terminal (phase 'done') but is not committed. */
  isTerminal(): boolean {
    return this.settlementApplied || this.handEndBroadcast || this.phase === 'done';
  }

  /** Graceful-shutdown abort: force past the `phase === 'done'` early return so
   *  a frozen, never-settled hand still records `aborted` and cannot freeze the
   *  restart. Refuses a committed settlement (guard inside `abort`).
   *
   *  The abort is a SINGLE durable attempt, and its busy budget is temporarily
   *  shortened so a stuck writer cannot stretch shutdown far past
   *  `shutdownDrainMs` (the connection default is 10s; retries could have taken
   *  ~30s). The shortened budget covers EVERY DB touch here - including the
   *  initial terminal read-back - not just the UPDATE. Returns whether the
   *  lifecycle row is provably terminal; `false` means the caller must keep the
   *  hand fail-closed rather than pretend it was resolved (spec P0-3). */
  abortForShutdown(): boolean {
    let previous: number | null = null;
    try {
      const row = this.db.pragma('busy_timeout', { simple: true }) as number | undefined;
      if (typeof row === 'number') previous = row;
    } catch {
      // DB already closed: nothing can be persisted, stay fail-closed.
      return false;
    }
    // Shorten BEFORE the first read-back: that SELECT can itself hit a lock and
    // would otherwise wait out the full default (spec P0-3a).
    try {
      this.db.pragma('busy_timeout = 250');
    } catch {
      return false;
    }
    try {
      if (this.lifecycleTerminal()) return true;
      try {
        this.abort('server shutdown (drain timeout)', null, true);
      } catch {
        // The durable update was not confirmed; fall through to the read-back.
      }
      return this.lifecycleTerminal();
    } finally {
      try {
        if (previous !== null) this.db.pragma(`busy_timeout = ${previous}`);
      } catch {
        // connection gone; the process is shutting down anyway
      }
    }
  }

  /**
   * Durably write the settlement exactly once. Throws when the transaction
   * fails (the caller isolates and retries). A `duplicate` outcome means a
   * committed earlier call already moved the chips; it carries the FIRST
   * submission's full receipt, never an empty result.
   *
   * The sealed transcript, identity and every computed money input are frozen
   * on the FIRST attempt (see `buildSealedWrite`) and reused verbatim by every
   * retry: a retry can never append a second diagnostic event, recompute the
   * bounty, move the head or change the committed timestamp.
   */
  private persistSettlement(): HandSettlementOutcome {
    if (this.settlementApplied) {
      if (this.committedOutcome) return this.committedOutcome;
      throw new Error(`hand ${this.id} reported applied without a committed receipt`);
    }
    if (!this.settlement) throw new Error('settlement not computed');
    this.clearTimer();
    const write = (this.sealedWrite ??= this.buildSealedWrite());
    // Test-only commit fault injection (never wired in production).
    this.opts.faultInjection?.persist?.(this.settlementAttempts + 1);
    const phase = this.opts.faultInjection?.phase;

    // 1. Freeze the complete input durably in its OWN committed transaction.
    //    A crash after this point can settle from the DB alone - nothing is
    //    rebuilt from the current room state on retry.
    phase?.('prepare_before');
    persistPreparedInput(this.db, write);
    phase?.('prepare_after');
    // 2. Apply the money transaction FROM THE DB INPUT and mark the prepared
    //    row resolved in that same transaction.
    const outcome = applyPreparedHandSettlement(this.db, this.id, { phase }).outcome;
    // B1 single authority: the committed receipt is the only source for this
    // hand's final stacks, commission leg and bounty decision. Adopt it before
    // marking the hand applied so a mapping failure is still retryable.
    this.applyFinalStacks(outcome);
    const seatByUser = new Map(this.seats.map((s) => [s.userId, s.seat]));
    this.settlementCommissionDeltas = outcome.commissionDeltas
      .map((c) => ({ seat: seatByUser.get(c.userId), delta: c.delta }))
      .filter((c): c is { seat: number; delta: number } => c.seat !== undefined);
    this.settlementSevenDeuce = outcome.sevenDeuce;
    // A showdown winner who held 7-2 has now been paid (once per hand): mark it
    // so a later voluntary show can never pay the bounty a second time.
    if (outcome.sevenDeuce) this.room.markSevenDeucePaid(this.id);
    this.settlementApplied = true;
    this.committedOutcome = outcome;
    return outcome;
  }

  /**
   * Freeze the sealed write input BEFORE the first writer attempt. Captures the
   * sealed transcript (head + a snapshot of the entries), the resolved identity
   * and every computed money input. The `time_bank_epoch_mismatch` diagnostic
   * is appended to the live transcript here, exactly once, so a retry reuses
   * the same sealed entries/head instead of appending another.
   */
  private buildSealedWrite(): HandSettlementWrite {
    if (!this.settlement) throw new Error('settlement not computed');
    const { rake, squid, bounty } = this.settlement;
    const now = Date.now();
    const pokerDeltas = this.settlement.pokerDeltas;
    const bountyBySeat = new Map((bounty?.payout ?? []).map((d) => [d.seat, d.delta]));
    const squidDeltas = this.seats.map((s) => ({
      seat: s.seat,
      delta: squid?.netBySeat.get(s.seat) ?? 0,
    }));
    // The per-seat stack movement: poker + squid + bounty.
    const combinedDeltas = pokerDeltas.map((d) => ({
      seat: d.seat,
      delta: d.delta + (squid?.netBySeat.get(d.seat) ?? 0) + (bountyBySeat.get(d.seat) ?? 0),
    }));
    // The stats projection must see the bounty inside the poker view so its
    // `net_delta === ending_stack - starting_stack`; the ledger keeps the bounty
    // in its own `seven-deuce` kind (see `sevenDeuce` below).
    const projectionPokerDeltas = pokerDeltas.map((d) => ({
      seat: d.seat,
      delta: d.delta + (bountyBySeat.get(d.seat) ?? 0),
    }));
    const bySeat = (seat: number) => this.seats.find((x) => x.seat === seat)!;

    // Time bank: debits lived in memory for the hand (hand-atomic - an aborted
    // or crashed hand leaves the stored bank untouched), so persist the final
    // balance + counter/refill here. A config change mid-hand resets the bank
    // and bumps the epoch; detect it once, here, and record it in the sealed
    // transcript - a retry must never append a second diagnostic.
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
        // The fixed product cap applies at the WRITE too, not only on the next
        // read: a refill landing on a full bank must be discarded, so the row
        // itself never carries more than five 30s cards. (The read-time clamp is
        // still needed for legacy/tampered rows - see `startHand`.)
        ms = Math.min(MAX_TIME_BANK_MS, ms);
        timeBanks.push({ userId: s.userId, ms, hands });
      }
    }
    if (mismatchedSeats.length)
      this.appendServer('time_bank_epoch_mismatch', { seats: mismatchedSeats });

    // Freeze AFTER the diagnostic append so the sealed head/entries include it.
    const head = this.transcript.head;
    const entries = [...this.transcript.entries];

    // The auto 7-2 bounty was already resolved against the post-pot stacks in
    // `settle()`; here we only hand the writer its exact amounts.
    const sevenDeuceWrite =
      bounty && bounty.amount > 0
        ? {
            winnerUserId: bySeat(bounty.seat).userId,
            winnerSeat: bounty.seat,
            winnerAmount: bounty.amount,
            payerAmounts: bounty.payout
              .filter((d) => d.delta < 0)
              .map((d) => ({ userId: bySeat(d.seat).userId, amount: -d.delta })),
          }
        : null;
    return {
      handId: this.id,
      roomId: this.roomId,
      head,
      entries,
      rake,
      commissionBps: this.commissionBps,
      stackDeltas: combinedDeltas.map((d) => ({ userId: bySeat(d.seat).userId, delta: d.delta })),
      pokerLedger: pokerDeltas.map((d) => ({ userId: bySeat(d.seat).userId, delta: d.delta })),
      projectionPokerLedger: projectionPokerDeltas.map((d) => ({
        userId: bySeat(d.seat).userId,
        delta: d.delta,
      })),
      squidLedger: squid
        ? squidDeltas.map((d) => ({ userId: bySeat(d.seat).userId, delta: d.delta }))
        : [],
      squidNote: 'Squid Game penalty/payout',
      timeBanks,
      timeBankEpoch: bank ? bank.epoch : null,
      triggerIds: [this.features.squid.triggerId, this.features.bomb.triggerId],
      bombRan: !!this.features.bomb.settings,
      // Resolved once in `settle()`; the transcript payload names the same
      // account, so the historical replay and the ledger always agree.
      rakeRecipientId: this.settlement.rakeRecipientId,
      sevenDeuce: sevenDeuceWrite,
      now,
    };
  }

  /**
   * Adopt the committed receipt's `finalStacks` as the hand's final stacks.
   * Called after the transaction has committed, for BOTH `applied` and
   * `duplicate`. Seats only (a platform rake recipient has no seat and is
   * ignored). A receipt that does not map every participant to a valid stack is
   * an explicit consistency error - never a silent fallback to stale stacks.
   */
  private applyFinalStacks(outcome: HandSettlementOutcome): void {
    if (!this.settlement) throw new Error(`hand ${this.id} has no settlement to adopt`);
    const seatByUser = new Map(this.seats.map((s) => [s.userId, s.seat]));
    const finalBySeat = new Map<number, number>();
    const seenUsers = new Set<number>();
    for (const f of outcome.finalStacks) {
      if (!Number.isSafeInteger(f.userId) || seenUsers.has(f.userId))
        throw new Error(
          `settlement receipt has an invalid/duplicate final-stack user on hand ${this.id}`,
        );
      seenUsers.add(f.userId);
      if (!Number.isSafeInteger(f.stack) || f.stack < 0)
        throw new Error(
          `settlement receipt has an invalid final stack for user ${f.userId} on hand ${this.id}`,
        );
      const seat = seatByUser.get(f.userId);
      if (seat === undefined) continue;
      finalBySeat.set(seat, f.stack);
    }
    if (finalBySeat.size !== this.seats.length)
      throw new Error(
        `settlement receipt does not map every participant to a final stack on hand ${this.id} (${finalBySeat.size}/${this.seats.length})`,
      );
    this.settlement.stacks = this.seats.map((s) => ({
      seat: s.seat,
      stack: finalBySeat.get(s.seat)!,
    }));
  }

  /**
   * The automatic 7-2 offsuit bounty for a hand decided at SHOWDOWN, or null.
   * Fold winners are deliberately excluded here: their cards only become public
   * through a voluntary show, which pays via `GameRoom.recordShow` after the
   * fact. Only the first qualifying winner is paid, matching the old behavior.
   */
  private sevenDeuceBounty(): {
    winnerUserId: number;
    winnerSeat: number;
    payerUserIds: number[];
    bonus: number;
  } | null {
    if (!this.settlement) return null;
    if (this.betting?.winnerByFold !== null && this.betting?.winnerByFold !== undefined)
      return null;
    const room = getRoom(this.db, this.roomId);
    if (!room || room.seven_deuce_bonus <= 0) return null;
    for (const [seat, amount] of this.settlement.awards) {
      if (amount <= 0) continue;
      const cards = this.reveals.get(seat);
      if (!cards || !isSevenDeuce(cards)) continue;
      const info = this.seats.find((s) => s.seat === seat);
      if (!info) continue;
      return {
        winnerUserId: info.userId,
        winnerSeat: seat,
        payerUserIds: this.seats.filter((s) => s.seat !== seat).map((s) => s.userId),
        bonus: room.seven_deuce_bonus,
      };
    }
    return null;
  }

  /** `hand_end` after the reveal hold. The chips already moved in
   *  `persistSettlement`, so this only controls the broadcast + auto-deal pause. */
  private scheduleHandEnd(): void {
    const wait = this.showdownHoldUntil - this.clock.now();
    if (wait <= 0) {
      this.broadcastHandEnd();
      return;
    }
    if (this.settleTimer) return;
    this.settleTimer = this.clock.setTimer(() => {
      this.settleTimer = null;
      this.broadcastHandEnd();
    }, wait);
  }

  private broadcastHandEnd(): void {
    if (this.handEndBroadcast || !this.settlement) return;
    this.handEndBroadcast = true;
    // The hand is now fully over: reject any late crypto/betting frame. The
    // reveal hold deliberately keeps the phase open, so a folded player can
    // still volunteer a show while the frame is on screen (as before).
    this.phase = 'done';
    const { stacks, rake, squid } = this.settlement;
    const pokerDeltas = this.settlement.pokerDeltas;
    const squidDeltas = this.seats.map((s) => ({
      seat: s.seat,
      delta: squid?.netBySeat.get(s.seat) ?? 0,
    }));
    const bountyBySeat = new Map(
      (this.settlement.bounty?.payout ?? []).map((d) => [d.seat, d.delta]),
    );
    const combinedDeltas = pokerDeltas.map((d) => ({
      seat: d.seat,
      delta: d.delta + (squid?.netBySeat.get(d.seat) ?? 0) + (bountyBySeat.get(d.seat) ?? 0),
    }));
    // `hand_end.deltas` are the combined poker+squid+bounty game nets - the
    // exact numbers the durable writer applied for the game leg.
    // `commissionDeltas` is the SEAT-filtered commission leg: only a rake
    // recipient who is also in this hand appears. Aggregate contract:
    //   sum(deltas) === -commission                        ALWAYS
    //   sum(deltas) + sum(commissionDeltas) === 0          ONLY IF the recipient
    //                                                      is in this hand
    // When the recipient is out of hand the credit is expressed by its own
    // `commission` ledger row on that external account, not by a hand seat.
    // Per seat `ending - starting === delta + commissionDelta` (plus any
    // mid-hand buy). Keeping the legs apart preserves `net_delta = poker+squid`.
    const endMsg = {
      t: 'hand_end' as const,
      handId: this.id,
      // The committed receipt's head, not the live transcript's: a late key
      // arriving during a retry gap may have appended to the live transcript,
      // but the sealed head is the one the marker and projection vouch for.
      head: this.committedOutcome?.head ?? this.transcript.head,
      stacks,
      deltas: combinedDeltas,
      pokerDeltas,
      squidDeltas,
      commissionDeltas: this.settlementCommissionDeltas,
      commission: rake,
      commissionBps: this.commissionBps,
    };
    this.safeBroadcast(endMsg as ServerMsg, {
      before: 'broadcast_before_hand_end',
      after: 'broadcast_after_hand_end',
    });
    // Retain the terminal frame before teardown so a participant who missed it
    // (dropped socket, or a swallowed delivery failure) still gets it on
    // reconnect instead of being stuck on a settlement banner forever.
    this.room.rememberHandEnd(
      endMsg as Extract<ServerMsg, { t: 'hand_end' }>,
      this.seats.map((s) => s.userId),
    );
    // A showdown must not roll straight into the next auto-deal: hold the table
    // for SETTLE_HOLD_MS so the client's settlement animation can finish. A
    // fold-out carries no reveal and passes false (normal cadence only).
    this.room.setSettlementHold(this.settlement.showdown !== null);
    // Room teardown must run even if the notification above failed: a lost
    // `hand_end` frame can never keep the room from advancing.
    this.onDone();
  }
}
