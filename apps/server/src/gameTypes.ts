/**
 * Shared domain types, tuning constants and expected-failure error classes for
 * the hand engine. Extracted mechanically from `game.ts` (P1-5) - no semantic
 * change. Depends only on the shared protocol/domain packages; it never depends
 * on `GameRoom` or `Hand`, so the dependency direction stays one-way.
 */
import type { Point } from '@4am/mental-poker';
import type { RoomGameplaySettings, ServerMsg } from '@4am/shared';

/**
 * Durability boundaries of the settlement path, for test-only fault injection
 * (see `GameOpts.faultInjection.phase`). Every point is a real boundary in the
 * production flow: the `prepare_*` points bracket the frozen-input commit, the
 * `settlement_*` points are inside the money transaction, and the `broadcast_*`
 * points sit around the notification frames AFTER the money is durable.
 *
 * A throw at a `settlement_*` point rolls the whole transaction back (the
 * prepare row stays, no marker/ledger/transcript/projection); a throw at a
 * `broadcast_*` point is a lost notification and must never undo the committed
 * settlement. Never wired in production.
 */
export type SettlementFaultPoint =
  | 'prepare_before'
  | 'prepare_after'
  | 'settlement_before_transaction'
  | 'settlement_after_marker'
  | 'settlement_after_stack'
  | 'settlement_after_poker_ledger'
  | 'settlement_after_squid_ledger'
  | 'settlement_after_commission'
  | 'settlement_after_seven_deuce'
  | 'settlement_after_transcript'
  | 'settlement_after_projection'
  | 'settlement_after_gameplay_state'
  | 'settlement_after_final_stacks'
  | 'settlement_after_lifecycle'
  | 'settlement_before_commit'
  | 'broadcast_before_showdown'
  | 'broadcast_after_showdown'
  | 'broadcast_before_squid'
  | 'broadcast_before_seven_deuce'
  | 'broadcast_before_hand_end'
  | 'broadcast_after_hand_end';

/** Called at a named `SettlementFaultPoint`. A throw is the injected fault. */
export type SettlementPhaseHook = (phase: SettlementFaultPoint) => void;

export interface GameOpts {
  cryptoTimeoutMs: number;
  actionTimeoutMs: number;
  /** Extra chances a stalled player gets before the hand aborts (default 3). */
  cryptoRetries?: number;
  /** Delay before an enabled automatic ready check (default AUTO_DEAL_INTERVAL_MS;
   *  env override `FOURAM_AUTO_DEAL_INTERVAL_MS`). */
  autoDealMs?: number;
  /** How long the pre-deal ready check waits before dealing without stragglers
   *  (default AUTO_DEAL_READY_CHECK_MS; it ends immediately once everyone is in;
   *  env override `FOURAM_AUTO_DEAL_READY_CHECK_MS`). */
  readyCheckMs?: number;
  /** How long the showdown reveal frame is held on screen before `hand_end` is
   *  broadcast. The durable settlement is already written by then (default
   *  SHOWDOWN_HOLD_MS). */
  showdownHoldMs?: number;
  /** After a showdown hand settles, how long before the next auto-deal may start
   *  (default SETTLE_HOLD_MS). Fold-outs carry no reveal animation and skip it. */
  settleHoldMs?: number;
  /** How long the run-it-twice vote stays open when everyone is all-in. Each
   *  stage (the behind player's run-count choice, then the ahead player's
   *  agreement) gets this full budget, so a slow-but-valid negotiation can take
   *  up to 2x. Default `RIT_VOTE_MS` (7.5s per stage). */
  ritVoteMs?: number;
  /** Pre-betting reconnect grace before a dropped player's hand is aborted
   *  (default `GONE_ABORT_GRACE_MS`). The timer is cancelled on reconnect, so
   *  this only bounds a *persistent* absence. Tests use a short value to drive
   *  the abort without waiting the production 4s. */
  goneGraceMs?: number;
  /** TV replays: save every player's hand key post-hand so replays show all cards. */
  tvReplays?: boolean;
  /** Grace period a graceful shutdown gives a live, not-yet-settled hand to
   *  reach a terminal lifecycle state before it is aborted. Defaults to
   *  `SHUTDOWN_DRAIN_MS`. Tests use a short value. */
  shutdownDrainMs?: number;
  /** Injectable clock for the showdown settle hold, so tests can drive the
   *  reveal/settlement/`hand_end` ordering deterministically instead of racing
   *  wall-clock timers. Defaults to the real clock (`Date.now`/`setTimeout`). */
  clock?: GameClock;
  /**
   * Test-only fault injection for the settlement durability boundary. Never set
   * in production. `persist(attempt)` is called before each durable-write
   * attempt (1-based) and throwing simulates a failed commit; `broadcast(msg)`
   * is called before each settlement-path broadcast and throwing simulates a
   * lost notification after a committed write.
   */
  faultInjection?: {
    persist?: (attempt: number) => void;
    broadcast?: (msg: ServerMsg) => void;
    /** Called before the fold-winner 7-2 bounty transaction; throwing
     *  simulates a rolled-back transfer (the bounty must stay retryable). */
    sevenDeuce?: () => void;
    /** Called INSIDE the fold-winner 7-2 bounty transaction. Not special-cased:
     *  throwing exercises the internal-error classification (a TypeError here
     *  must stay a programming error, not become a retryable one). */
    sevenDeuceInternal?: () => void;
    /** Called at every named `SettlementFaultPoint`. Throwing injects a fault
     *  at exactly that boundary: inside the money transaction the throw is a
     *  rollback (a transient-coded error stays retryable; a plain error is
     *  fail-closed); after commit it is a lost notification that must not undo
     *  the durable settlement. */
    phase?: SettlementPhaseHook;
  };
}

/**
 * The only clock the settlement hold needs. Injected through `GameOpts.clock`
 * so a test can freeze/advance time and prove the ordering contract (durable
 * write → showdown → hold → hand_end) without wall-clock sleeps.
 */
export interface GameClock {
  now(): number;
  setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer(handle: ReturnType<typeof setTimeout>): void;
}

export const realClock: GameClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle),
};

export interface Identity {
  publicKey: string;
  secretKey: string;
}

export interface HandSeatInfo {
  seat: number;
  userId: number;
  username: string;
  pubkey: string;
  stack: number;
}

export interface Chain {
  deckIndex: number;
  forSeat: number | null;
  purpose: 'hole' | 'board' | 'showdown';
  current: Point;
  remaining: number[]; // seats yet to apply their unmask, in order
}

/** With auto-deal on, the next hand starts this soon after the previous one
 *  settles. Overridable via `GameOpts.autoDealMs` (tests use a shorter one) or
 *  the `FOURAM_AUTO_DEAL_INTERVAL_MS` env var. Must stay >= SETTLE_HOLD_MS so a
 *  showdown's post-settle pause is respected even when `autoDealMs` overrides
 *  the cadence.
 *
 *  3.5s: a showdown hand's reveal is held on screen for SHOWDOWN_HOLD_MS (1.5s)
 *  before `hand_end` and the next cadence begins, so the result-to-next-deal
 *  beat a player actually perceives is 1.5 + 3.5 = 5s (the product's ask; the
 *  old 1.5s here made a showdown feel like it dealt before the result was read).
 *  A fold-out carries no reveal hold and waits this cadence alone. */
export const AUTO_DEAL_INTERVAL_MS = 3_500;

/**
 * How long the showdown reveal frame is held before `hand_end` is broadcast, so
 * clients can run the win/lose animation before the stacks jump. The durable
 * settlement (`applyHandSettlement`) is written BEFORE the reveal is broadcast -
 * the hold only delays the `hand_end` broadcast and auto-deal cadence, never the
 * database write. Overridable via `GameOpts.showdownHoldMs`. Kept short (1.5s);
 * the web win animation (`apps/web` `WIN_FX_MS`) must match this or it is cut.
 */
export const SHOWDOWN_HOLD_MS = 1_500;

/**
 * Product contract: a paid peek offer stays open for five seconds. After that
 * the server expires it and tells the requester, so a target who disconnects or
 * ignores the offer can never leave the requester waiting forever.
 */
export const PEEK_OFFER_TTL_MS = 5_000;

/**
 * After a showdown hand has settled, how long the table waits before the next
 * auto-deal. Gives the client's settlement animation room to finish. Fold-outs
 * (no reveal) skip it and rely on the normal AUTO_DEAL_INTERVAL_MS cadence.
 * Overridable via `GameOpts.settleHoldMs`. Kept short (1.5s), matching the
 * auto-deal cadence so a showdown does not add a second full pause.
 */
export const SETTLE_HOLD_MS = 1_500;

/** How long to wait before retrying a failed durable settlement write. */
export const SETTLE_RETRY_MS = 250;

/** Failed durable-write attempts before the table is frozen for a human. */
export const SETTLE_MAX_RETRIES = 4;

/** How many recent terminal `hand_end` frames a room retains for reconnect
 *  replay. Bounded so an idle-but-long-lived room cannot leak frames; eight
 *  covers far more than the "missed the hand that just ended" case that
 *  matters. */
export const MAX_TERMINAL_FRAMES = 8;

/** How long a graceful shutdown waits for a live, not-yet-settled hand to
 *  reach a terminal lifecycle state before it aborts the hand. Must be short:
 *  a deploy cannot block on a full action timeout. */
export const SHUTDOWN_DRAIN_MS = 3_000;

/**
 * BEFORE betting, a player's socket dropping is given this reconnect grace
 * before the hand aborts and the auto-redeal skips them (see `onPlayerGone`).
 *
 * This is NOT a fixed penalty for a blip: the timer is cancelled the moment the
 * player reconnects (`Hand.onPlayerReconnected`), so it only ever elapses for a
 * *persistent* absence. 4s is deliberately generous enough to absorb a real
 * network blip - the web client reconnects with a 500ms->8s backoff and a
 * backgrounded tab throttles timers - while still freeing a closed tab's seat
 * in bounded time. A 2s window was too tight: a reconnect that landed after it
 * aborted a hand the returning client could never recover.
 *
 * Overridable via `GameOpts.goneGraceMs` (tests use a short value).
 */
export const GONE_ABORT_GRACE_MS = 4_000;

/**
 * How long an all-in run-it-twice offer/vote stays open. Run-it-twice is off by
 * default; when enabled this only bounds the negotiation - it resolves the
 * instant both players respond. Kept short (7.5s) so an ignored offer cannot
 * stall the hand. Overridable via `GameOpts.ritVoteMs`.
 */
export const RIT_VOTE_MS = 7_500;

/**
 * A known, expected game-level failure (a business rule or a bad client
 * request), as opposed to a programming error. The hub answers the client with
 * the message and leaves the room healthy; anything else marks the room
 * unhealthy and fails closed.
 */
export class GameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GameError';
  }
}

/**
 * A known, expected failure that is safe (and worthwhile) for the client to
 * retry: a rolled-back post-hand bounty transfer, a transient write the caller
 * can repeat. It is still a `GameError` - the hub must answer the client and
 * leave the room healthy - but it is explicitly NOT a programming error, so it
 * must never mark the room unhealthy. (Before this, a rolled-back 7-2 bounty
 * escaped `trySevenDeuce` as a raw sqlite error, hit the hub's unknown branch
 * and permanently locked the room.)
 */
export class RetryableGameError extends GameError {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableGameError';
  }
}

/** SQLite result codes for a failure that means "the write did not land but
 *  retrying the SAME statement can win": lock contention and an explicit
 *  interrupt. An EXACT allow-list of the base codes and their real extended
 *  forms - not a prefix match, which would wrongly accept look-alikes such as
 *  `SQLITE_BUSYNESS`, `SQLITE_LOCKED_BROKEN` or `SQLITE_INTERRUPT_FOO`.
 *
 *  `SQLITE_INTERRUPT` is retryable because it means the statement was aborted
 *  before commit - a rolled-back transaction, so re-running it is safe and the
 *  caller bounds the number of retries.
 *
 *  Deliberately NOT included (policy): `SQLITE_IOERR*`, `SQLITE_FULL`,
 *  `SQLITE_NOMEM`, `SQLITE_PROTOCOL`, and every unknown error. Those are
 *  environmental or programming failures where a blind retry is wrong (a full
 *  disk or a closed/broken database does not heal by repeating the statement);
 *  they must propagate so the room goes fail-closed instead of being told a
 *  retry will fix it. `SQLITE_LOCKED_VTAB` is deliberately excluded too: it is
 *  not generic lock contention but a virtual-table locking failure. */
const TRANSIENT_SQLITE_CODES = new Set([
  'SQLITE_BUSY',
  'SQLITE_BUSY_RECOVERY',
  'SQLITE_BUSY_SNAPSHOT',
  'SQLITE_BUSY_TIMEOUT',
  'SQLITE_LOCKED',
  'SQLITE_LOCKED_SHAREDCACHE',
  'SQLITE_INTERRUPT',
]);

/** True for a recognisably transient DB/transfer failure (contention/interrupt),
 *  false for anything that should propagate to the hub's unexpected-error
 *  (unhealthy) branch. */
export function isTransientTransferError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: unknown }).code;
  return typeof code === 'string' && TRANSIENT_SQLITE_CODES.has(code);
}
/** How long the ready check waits when auto-deal is on. The check resolves the
 *  instant every player is in, so this only bounds a straggler - it must not be
 *  the old 20s or auto-deal would feel manual. Overridable via
 *  `GameOpts.readyCheckMs`. Kept short (1.5s). */
export const AUTO_DEAL_READY_CHECK_MS = 1_500;
/** Which feature trigger a hand claimed, and the settings/balances it must
 *  settle against. Snapshot at claim time so a mid-hand settings write (blocked
 *  anyway) or a later config change can never move the goalposts. */
export interface HandFeatureSnapshot {
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
export interface SquidSettlement {
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
  /** Poker-only ledger rows (kind 'hand-settlement'). Excludes the 7-2 bounty. */
  pokerLedger: { userId: number; delta: number }[];
  /**
   * Poker deltas as they appear in the transcript/stats projection: the
   * poker-only deltas PLUS the automatic 7-2 bounty transfer. The bounty is a
   * zero-sum transfer, so `sum(projectionPokerLedger) === sum(pokerLedger)`;
   * it is kept separate only so the ledger can record it under its own
   * `seven-deuce` kind while the projection's `net_delta` still reconciles with
   * `ending_stack - starting_stack`. Defaults to `pokerLedger`.
   */
  projectionPokerLedger?: { userId: number; delta: number }[];
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
  /**
   * Automatic showdown 7-2 offsuit bounty, applied INSIDE this same
   * transaction so a crash can never commit a settled hand without paying it.
   * The exact amounts are computed by `GameRoom` against the post-pot stacks
   * (`this.settlement.stacks`) and folded into `stackDeltas`; the writer only
   * records the matching `seven-deuce` ledger rows. The transfer is zero-sum
   * and therefore does not disturb the conservation check. Null when no
   * showdown winner held 7-2, or when the bounty is disabled. A fold winner's
   * *voluntary* show stays a separate, post-settlement transaction
   * (`GameRoom.trySevenDeuce`).
   */
  sevenDeuce?: {
    winnerUserId: number;
    winnerSeat: number;
    /** The exact total the winner receives (already clamped to payer stacks). */
    winnerAmount: number;
    /** Per-payer debits for the ledger. */
    payerAmounts: { userId: number; amount: number }[];
  } | null;
  /**
   * AUX/TEST ONLY. When true, a duplicate settlement is allowed to validate
   * against the ledger + candidate write alone, without a sealed transcript
   * (used by the synthetic idempotency fixtures that commit `entries: []`).
   *
   * A PRODUCTION duplicate - any retry of a marker written by `GameRoom` - must
   * NEVER set this: the transcript is sealed in the same transaction as the
   * marker, so its absence or inconsistency is corruption that must throw, not
   * a silent downgrade to the candidate write's own seats.
   */
  transcriptlessReceipt?: boolean;
  now: number;
}

export interface HandSettlementOutcome {
  status: 'applied' | 'duplicate';
  /** Identity of the committed hand. A duplicate returns the FIRST submission's
   *  identity, loaded from durable state, never the candidate write's. */
  roomId: string;
  handId: string;
  /** The sealed transcript head the marker vouches for. */
  head: string;
  /** The rake recorded in the committed marker. */
  rake: number;
  timeBankSkipped: number[];
  finalStacks: { userId: number; stack: number }[];
  /** Combined poker+squid+automatic-bounty game deltas, per user. */
  gameDeltas: { userId: number; delta: number }[];
  /** What the embedded 7-2 bounty actually moved (seat + total), or null. */
  sevenDeuce: { seat: number; amount: number } | null;
  /**
   * The explicit commission (rake) recipient leg credited in the SAME
   * transaction. This is the ACCOUNT-level leg: exactly one entry
   * `{ rakeRecipientId, +rake }` when rake > 0 and a recipient exists, empty
   * when rake is 0 or there is no recipient. The recipient may have no seat.
   *
   * Contract (see `hand_end.commissionDeltas` and DESIGN):
   *   gameDelta(u)        = poker + squid + 7-2 bounty   // = projection net_delta
   *   transactionDelta(u) = gameDelta(u) + commissionDelta(u)
   *   ending_stack(u) - starting_stack(u) = gameDelta(u) + commissionDelta(u)
   *                                         (+ any mid-hand buy)
   *
   * Aggregate: `sum(gameDeltas) = -rake` ALWAYS; `sum(gameDeltas) +
   * sum(commissionDeltas) = 0` ONLY when the recipient is in the hand. When the
   * recipient is out of hand the credited account is expressed by its own
   * commission ledger leg, not by a hand seat.
   */
  commissionDeltas: { userId: number; delta: number }[];
}

export type UserDelta = { userId: number; delta: number };
