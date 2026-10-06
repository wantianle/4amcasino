import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
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
} from '@4am/shared';
import { firstPendingHandLifecycle, type DB } from './db.js';
import {
  materializeHandProjection,
  positionAssignments,
  SEVEN_DEUCE_SHOW_KIND,
  voidHandExistsSql,
} from './handProjection.js';
import { appendLedger } from './ledger.js';
import { getRoom, presentablePlayers, roomPlayers } from './rooms.js';
import { readRoomFeatures } from './gameplaySettings.js';
import { computeHeadsUpEquity, EquityError } from './equity.js';
import { settleRake } from './rake.js';
import { platformUserId } from './platform.js';

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
  /** Delay before an enabled automatic ready check (default AUTO_DEAL_INTERVAL_MS). */
  autoDealMs?: number;
  /** How long the pre-deal ready check waits before dealing without stragglers
   *  (default AUTO_DEAL_READY_CHECK_MS; it ends immediately once everyone is in). */
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

/** With auto-deal on, the next hand starts this soon after the previous one
 *  settles. Overridable via `GameOpts.autoDealMs` (tests use a shorter one).
 *  Must stay >= SETTLE_HOLD_MS so a showdown's post-settle pause is respected
 *  even when `autoDealMs` overrides the cadence. Kept short (1.5s): a long
 *  cadence makes auto-deal feel manual. */
export const AUTO_DEAL_INTERVAL_MS = 1_500;

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
const MAX_TERMINAL_FRAMES = 8;

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

/**
 * Env-gated structured diagnostics for the hand engine. Off by default; set
 * `BOT_DEBUG=1` (and optionally `BOT_DEBUG_FILE`) to capture the full timer /
 * turn / betting timeline for a hand. Never throws into the game loop.
 */
function hdbg(event: string, data: Record<string, unknown>): void {
  if (!process.env.BOT_DEBUG) return;
  try {
    appendFileSync(
      process.env.BOT_DEBUG_FILE ?? '/tmp/opencode/hand-debug.log',
      `${Date.now()} ${event} ${JSON.stringify(data)}\n`,
    );
  } catch {
    /* diagnostics must never affect the game */
  }
}
/** How long the ready check waits when auto-deal is on. The check resolves the
 *  instant every player is in, so this only bounds a straggler - it must not be
 *  the old 20s or auto-deal would feel manual. Overridable via
 *  `GameOpts.readyCheckMs`. Kept short (1.5s). */
export const AUTO_DEAL_READY_CHECK_MS = 1_500;

/** Street order used by the stats projection's `street` events. */
const STREET_INDEX: Record<string, number> = { preflop: 0, flop: 1, turn: 2, river: 3 };

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
  /** True when no one had to show: the hand was decided by a fold. Kept on the
   *  snapshot for consumers; the peek gate no longer keys off it (a peek is
   *  allowed out of any hand with still-private cards). */
  endedByFold: boolean;
}

/** One outstanding paid-peek offer. `targetUserId` is captured so the target
 *  can be told when the offer resolves even after seats/lastHand change. */
interface PeekOffer {
  handId: string;
  fromUserId: number;
  targetSeat: number;
  targetUserId: number;
  amount: number;
  /** Server-side 5s expiry; cleared when the offer is answered or swept. */
  timer: NodeJS.Timeout;
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

type UserDelta = { userId: number; delta: number };

/** Strictly parse `hand_settlements.final_stacks`. Returns null on any
 *  deviation: malformed entry, non-integer/duplicate user, non-integer or
 *  negative stack. Recovery never substitutes a fabricated 0. */
function parseFinalStacksStrict(raw: unknown): { userId: number; stack: number }[] | null {
  if (!Array.isArray(raw)) return null;
  const out: { userId: number; stack: number }[] = [];
  const seen = new Set<number>();
  for (const f of raw as unknown[]) {
    if (!f || typeof f !== 'object') return null;
    const { userId, stack } = f as { userId?: unknown; stack?: unknown };
    if (typeof userId !== 'number' || !Number.isSafeInteger(userId)) return null;
    if (typeof stack !== 'number' || !Number.isSafeInteger(stack) || stack < 0) return null;
    if (seen.has(userId)) return null;
    seen.add(userId);
    out.push({ userId, stack });
  }
  return out;
}

function sumDeltaMap(rows: readonly UserDelta[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const r of rows) m.set(r.userId, (m.get(r.userId) ?? 0) + r.delta);
  return m;
}

function deltaMapsEqual(a: Map<number, number>, b: Map<number, number>): boolean {
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) if ((a.get(k) ?? 0) !== (b.get(k) ?? 0)) return false;
  return true;
}

/**
 * Sum the committed settlement-family ledger legs into per-user game deltas.
 * The poker/squid legs are keyed by the sealed `head`; the automatic bounty by
 * the hand id (a voluntarily-shown 7-2 after the hand uses a different kind and
 * is deliberately excluded). */
function ledgerGameDeltas(db: DB, roomId: string, head: string, handId: string): UserDelta[] {
  const rows = db
    .prepare(
      `SELECT user_id, SUM(delta) AS delta FROM ledger
        WHERE room_id = ? AND (
          (kind IN ('hand-settlement','squid-game') AND ref = ?)
          OR (kind = 'seven-deuce' AND ref = ?)
        ) GROUP BY user_id`,
    )
    .all(roomId, head, handId) as { user_id: number; delta: number }[];
  return rows.map((r) => ({ userId: r.user_id, delta: r.delta })).filter((d) => d.delta !== 0);
}

function ledgerCommissionDeltas(db: DB, roomId: string, head: string): UserDelta[] {
  const rows = db
    .prepare(
      `SELECT user_id, SUM(delta) AS delta FROM ledger
        WHERE room_id = ? AND kind = 'commission' AND ref = ? GROUP BY user_id`,
    )
    .all(roomId, head) as { user_id: number; delta: number }[];
  return rows.map((r) => ({ userId: r.user_id, delta: r.delta })).filter((d) => d.delta !== 0);
}

function ledgerSevenDeuce(db: DB, roomId: string, handId: string): UserDelta[] {
  const rows = db
    .prepare(
      `SELECT user_id, delta FROM ledger
        WHERE room_id = ? AND kind = 'seven-deuce' AND ref = ?`,
    )
    .all(roomId, handId) as { user_id: number; delta: number }[];
  return rows.map((r) => ({ userId: r.user_id, delta: r.delta }));
}

/**
 * Locate the single payload of `type` in a sealed transcript entry list.
 *
 * A durable transcript carries exactly one `hand_start` and one `settlement`.
 * Zero (missing) or duplicate occurrences are structural corruption: returning
 * the first match would let a corrupt transcript silently pick one of two
 * contradictory records, so this throws instead.
 */
function transcriptPayloadOf(
  entries: unknown[],
  type: string,
  handId: string,
): Record<string, unknown> {
  let found: Record<string, unknown> | null = null;
  for (const e of entries as { type?: unknown; payload?: unknown }[]) {
    if (e && typeof e === 'object' && e.type === type) {
      if (found !== null)
        throw new Error(
          `settlement identity conflict on hand ${handId}: duplicate ${type} entry`,
        );
      if (!e.payload || typeof e.payload !== 'object')
        throw new Error(
          `settlement identity conflict on hand ${handId}: malformed ${type} entry`,
        );
      found = e.payload as Record<string, unknown>;
    }
  }
  if (found === null)
    throw new Error(`settlement identity conflict on hand ${handId}: missing ${type} entry`);
  return found;
}

/**
 * Load and strictly validate the committed receipt for a hand whose marker
 * already exists.
 *
 * Sources: `hand_settlements` (identity + `final_stacks`), the sealed
 * transcript (head + seat map + seat-projected legs) and the ledger (the money
 * legs). It NEVER derives historical final stacks from the CURRENT
 * `room_players` balances: those may have moved on through a mid-hand buy, a
 * peek or the next hand. Any structural deviation or identity conflict throws,
 * so a `same handId, different hand` replay can never masquerade as a harmless
 * duplicate.
 */
function loadSettledReceipt(db: DB, w: HandSettlementWrite): HandSettlementOutcome {
  const marker = db
    .prepare(
      'SELECT hand_id, room_id, head, rake, final_stacks FROM hand_settlements WHERE hand_id = ?',
    )
    .get(w.handId) as
    | { hand_id: string; room_id: string; head: string; rake: number; final_stacks: string }
    | undefined;
  if (!marker) throw new Error(`duplicate settlement has no marker on hand ${w.handId}`);
  if (marker.room_id !== w.roomId)
    throw new Error(
      `settlement identity conflict on hand ${w.handId}: room ${marker.room_id} != ${w.roomId}`,
    );
  if (marker.head !== w.head)
    throw new Error(
      `settlement identity conflict on hand ${w.handId}: head ${marker.head} != ${w.head}`,
    );
  if (!Number.isSafeInteger(marker.rake) || marker.rake < 0 || marker.rake !== w.rake)
    throw new Error(
      `settlement identity conflict on hand ${w.handId}: rake ${marker.rake} != ${w.rake}`,
    );

  let rawFinal: unknown;
  try {
    rawFinal = JSON.parse(marker.final_stacks);
  } catch {
    throw new Error(`duplicate settlement has unreadable final_stacks on hand ${w.handId}`);
  }
  const finalStacks = parseFinalStacksStrict(rawFinal);
  if (!finalStacks)
    throw new Error(`duplicate settlement has malformed final_stacks on hand ${w.handId}`);

  const t = db
    .prepare('SELECT head, entries FROM transcripts WHERE hand_id = ? AND room_id = ?')
    .get(w.handId, w.roomId) as { head: string; entries: string } | undefined;

  // The transcript is the sealed record. A PRODUCTION duplicate (a retry of a
  // marker written by `GameRoom`) must have one: the transcript is inserted in
  // the SAME transaction as the marker, so a marker without a transcript is
  // corruption. Only an explicit aux/test write (`transcriptlessReceipt`, never
  // set by GameRoom) may proceed without one.
  const seatUser = new Map<number, number>();
  let transcriptGame: UserDelta[] | null = null;
  let transcriptCommission: UserDelta[] | null = null;
  if (!w.transcriptlessReceipt) {
    if (!t)
      throw new Error(`duplicate settlement has no transcript on hand ${w.handId}`);
    if (t.head !== w.head)
      throw new Error(
        `settlement identity conflict on hand ${w.handId}: transcript head ${t.head} != ${w.head}`,
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(t.entries);
    } catch {
      throw new Error(`duplicate settlement has unreadable transcript on hand ${w.handId}`);
    }
    if (!Array.isArray(parsed))
      throw new Error(
        `settlement identity conflict on hand ${w.handId}: transcript is not an entry list`,
      );
    // Replay the hash chain: `head` is the commitment. Comparing against the
    // mutable `head` column alone would trust a value a corrupt row could
    // rewrite in place without touching the entries.
    if (computeHead(parsed as TranscriptEntry[]) !== t.head)
      throw new Error(
        `settlement identity conflict on hand ${w.handId}: transcript head does not match its entry chain`,
      );
    // Exactly one hand_start and one settlement (duplicates throw), and the
    // seat list must be present and non-empty: a corrupt/empty one must never
    // shrink the participant set to the candidate write's seats.
    const start = transcriptPayloadOf(parsed, 'hand_start', w.handId);
    const settle = transcriptPayloadOf(parsed, 'settlement', w.handId);
    if (!Array.isArray(start.seats) || start.seats.length === 0)
      throw new Error(
        `settlement identity conflict on hand ${w.handId}: hand_start seats missing or empty`,
      );
    const seats = new Set<number>();
    const users = new Set<number>();
    for (const s of start.seats as unknown[]) {
      if (!s || typeof s !== 'object')
        throw new Error(
          `settlement identity conflict on hand ${w.handId}: malformed hand_start seat`,
        );
      const { seat, userId } = s as { seat?: unknown; userId?: unknown };
      if (typeof seat !== 'number' || !Number.isSafeInteger(seat))
        throw new Error(
          `settlement identity conflict on hand ${w.handId}: malformed hand_start seat`,
        );
      if (typeof userId !== 'number' || !Number.isSafeInteger(userId))
        throw new Error(
          `settlement identity conflict on hand ${w.handId}: malformed hand_start seat user`,
        );
      if (seats.has(seat) || users.has(userId))
        throw new Error(
          `settlement identity conflict on hand ${w.handId}: duplicate hand_start seat or user`,
        );
      seats.add(seat);
      users.add(userId);
      seatUser.set(seat, userId);
    }
    const toUsers = (seatDeltas: { seat: number; delta: number }[]): UserDelta[] =>
      seatDeltas.map((d) => {
        const userId = seatUser.get(d.seat);
        if (userId === undefined)
          throw new Error(
            `settlement identity conflict on hand ${w.handId}: transcript delta for unknown seat ${d.seat}`,
          );
        return { userId, delta: d.delta };
      });
    const td = parseSeatDeltas(settle.deltas);
    if (!td)
      throw new Error(
        `settlement identity conflict on hand ${w.handId}: transcript deltas are malformed`,
      );
    transcriptGame = toUsers(td);
    // The transcript only carries the SEAT-PROJECTED commission leg, so it is
    // absent (or empty) for an out-of-hand rake recipient. Treat a missing
    // field as "not projected" rather than an authoritative empty leg; the
    // ledger holds the account-level truth.
    if (settle.commissionDeltas !== undefined) {
      const tc = parseSeatDeltas(settle.commissionDeltas);
      if (!tc)
        throw new Error(
          `settlement identity conflict on hand ${w.handId}: transcript commission is malformed`,
        );
      transcriptCommission = toUsers(tc);
    }
  } else if (t && t.head !== w.head) {
    // The aux path does not require or project a transcript, but an identity
    // mismatch on one that happens to exist is still a conflict.
    throw new Error(
      `settlement identity conflict on hand ${w.handId}: transcript head ${t.head} != ${w.head}`,
    );
  }

  // Every participant must have a committed final stack. Participants come from
  // the sealed transcript when present, else (aux-only, no transcript) the
  // candidate write's own seats. Extra final_stacks rows beyond the participants
  // are tolerated ONLY as the out-of-hand rake account leg (it has a stack but
  // no seat); they are never treated as participants.
  const participants = seatUser.size
    ? [...new Set(seatUser.values())]
    : [...new Set(w.stackDeltas.map((d) => d.userId))];
  const finalByUser = new Set(finalStacks.map((f) => f.userId));
  for (const uid of participants)
    if (!finalByUser.has(uid))
      throw new Error(
        `duplicate settlement final_stacks missing participant ${uid} on hand ${w.handId}`,
      );

  const ledgerGame = ledgerGameDeltas(db, w.roomId, marker.head, w.handId);
  const gameDeltas = transcriptGame ?? ledgerGame;
  if (!deltaMapsEqual(sumDeltaMap(gameDeltas), sumDeltaMap(w.stackDeltas)))
    throw new Error(
      `settlement identity conflict on hand ${w.handId}: game deltas differ from the committed receipt`,
    );
  if (!deltaMapsEqual(sumDeltaMap(gameDeltas), sumDeltaMap(ledgerGame)))
    throw new Error(
      `settlement identity conflict on hand ${w.handId}: transcript and ledger disagree on game deltas`,
    );
  const gameSum = gameDeltas.reduce((s, d) => s + d.delta, 0);
  if (gameSum !== -marker.rake)
    throw new Error(
      `duplicate settlement game deltas do not net to -rake on hand ${w.handId}`,
    );

  // The ledger is the account-level authority: it credits the recipient even
  // when that account is not a hand seat. The transcript only carries the
  // seat-projected view, so it is cross-checked when present but never used as
  // the receipt's commission leg.
  const ledgerCommission = ledgerCommissionDeltas(db, w.roomId, marker.head);
  const commissionDeltas = ledgerCommission;
  const expectedCommission: UserDelta[] =
    w.rake > 0 && w.rakeRecipientId !== null
      ? [{ userId: w.rakeRecipientId, delta: w.rake }]
      : [];
  if (!deltaMapsEqual(sumDeltaMap(commissionDeltas), sumDeltaMap(expectedCommission)))
    throw new Error(
      `settlement identity conflict on hand ${w.handId}: commission differs from the committed receipt`,
    );
  if (transcriptCommission !== null) {
    const inHandUsers = new Set(seatUser.values());
    const seatFiltered = commissionDeltas.filter((c) => inHandUsers.has(c.userId));
    if (!deltaMapsEqual(sumDeltaMap(transcriptCommission), sumDeltaMap(seatFiltered)))
      throw new Error(
        `settlement identity conflict on hand ${w.handId}: transcript and ledger disagree on commission`,
      );
  }
  const commissionSum = commissionDeltas.reduce((s, d) => s + d.delta, 0);
  if (w.rakeRecipientId !== null && commissionSum !== marker.rake)
    throw new Error(`duplicate settlement commission does not equal rake on hand ${w.handId}`);

  // The automatic 7-2 decision is durable in the ledger. Reconstruct it rather
  // than trusting the candidate Hand's in-memory bounty.
  const sevenRows = ledgerSevenDeuce(db, w.roomId, w.handId);
  let sevenDeuce: { seat: number; amount: number } | null = null;
  if (sevenRows.length) {
    const positives = sevenRows.filter((r) => r.delta > 0);
    if (positives.length !== 1)
      throw new Error(
        `duplicate settlement seven-deuce decision is not a single winner on hand ${w.handId}`,
      );
    if (sevenRows.reduce((s, r) => s + r.delta, 0) !== 0)
      throw new Error(`duplicate settlement seven-deuce is not zero-sum on hand ${w.handId}`);
    const winner = positives[0]!;
    let seat: number | undefined;
    for (const [s, uid] of seatUser) if (uid === winner.userId) seat = s;
    if (seat === undefined && w.sevenDeuce && w.sevenDeuce.winnerUserId === winner.userId)
      seat = w.sevenDeuce.winnerSeat;
    if (seat === undefined)
      throw new Error(
        `duplicate settlement cannot resolve the 7-2 winner seat on hand ${w.handId}`,
      );
    if (
      !w.sevenDeuce ||
      w.sevenDeuce.winnerUserId !== winner.userId ||
      w.sevenDeuce.winnerAmount !== winner.delta
    )
      throw new Error(
        `settlement identity conflict on hand ${w.handId}: seven-deuce decision differs from the committed receipt`,
      );
    sevenDeuce = { seat, amount: winner.delta };
  } else if (w.sevenDeuce) {
    throw new Error(
      `settlement identity conflict on hand ${w.handId}: unexpected seven-deuce decision`,
    );
  }

  return {
    status: 'duplicate',
    roomId: marker.room_id,
    handId: marker.hand_id,
    head: marker.head,
    rake: marker.rake,
    timeBankSkipped: [],
    finalStacks,
    gameDeltas,
    sevenDeuce,
    commissionDeltas,
  };
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
export function applyHandSettlement(
  db: DB,
  w: HandSettlementWrite,
  /** Test-only: called at each transaction boundary; a throw rolls back. */
  phase?: SettlementPhaseHook,
): HandSettlementOutcome {
  if (!Number.isInteger(w.rake) || w.rake < 0)
    throw new Error(`invalid rake ${w.rake} on hand ${w.handId}`);
  const write = db.transaction((): HandSettlementOutcome => {
    const claim = db
      .prepare(
        `INSERT INTO hand_settlements (hand_id, room_id, head, rake, final_stacks, applied_at)
         VALUES (?, ?, ?, ?, '[]', ?)
         ON CONFLICT(hand_id) DO NOTHING`,
      )
      .run(w.handId, w.roomId, w.head, w.rake, w.now);
    if (claim.changes === 0) {
      // already settled by an earlier (committed) call - apply nothing, but
      // load and validate the FIRST submission's full receipt. The marker is
      // proof the whole hand committed, so reconcile the lifecycle to
      // `committed` too (a marker without a committed row can only come from
      // pre-lifecycle history or an operator-copied DB).
      db.prepare(
        `INSERT INTO hand_lifecycle (hand_id, room_id, status, created_at, updated_at, resolved_at)
         VALUES (?, ?, 'committed', ?, ?, ?)
         ON CONFLICT(hand_id) DO UPDATE SET status = 'committed',
           updated_at = excluded.updated_at, resolved_at = excluded.resolved_at`,
      ).run(w.handId, w.roomId, w.now, w.now, w.now);
      return loadSettledReceipt(db, w);
    }

    phase?.('settlement_after_marker');

    // A participant may not appear twice: stack deltas are applied additively,
    // so a duplicate user would silently double-move chips while the
    // conservation check sums only one row.
    const stackUsersSeen = new Set<number>();
    for (const d of w.stackDeltas) {
      if (!Number.isSafeInteger(d.delta))
        throw new Error(`invalid stack delta ${d.delta} on hand ${w.handId}`);
      if (stackUsersSeen.has(d.userId))
        throw new Error(`settlement has duplicate participant user ${d.userId} on hand ${w.handId}`);
      stackUsersSeen.add(d.userId);
    }
    const userIds = [...stackUsersSeen];
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
    // A participant without a room_players row must fail the whole settlement:
    // settling against a fabricated 0 balance would silently corrupt money.
    for (const uid of userIds)
      if (!finalByUser.has(uid))
        throw new Error(
          `settlement missing participant row for user ${uid} on hand ${w.handId}`,
        );
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

    phase?.('settlement_after_stack');

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
    phase?.('settlement_after_poker_ledger');
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
    phase?.('settlement_after_squid_ledger');
    if (w.rake > 0 && w.rakeRecipientId !== null) {
      settleRake(db, {
        roomId: w.roomId,
        recipientId: w.rakeRecipientId,
        rake: w.rake,
        ref: w.head,
        commissionBps: w.commissionBps,
      });
    }

    phase?.('settlement_after_commission');

    // Automatic showdown 7-2 bounty, in the SAME transaction. It is a zero-sum
    // transfer among the hand's seats, so it cannot break conservation; it is
    // applied after the pot/rake (matching the old post-settlement order) and
    // before `finalStacks` is read so `room_players.stack`,
    // `hand_settlements.final_stacks` and the stats projection all agree.
    let sevenDeuce: { seat: number; amount: number } | null = null;
    if (w.sevenDeuce && w.sevenDeuce.winnerAmount > 0) {
      // The stack movement already rode `stackDeltas` (the bounty is folded
      // into the combined deltas), so this only records the ledger legs.
      for (const payer of w.sevenDeuce.payerAmounts) {
        if (payer.amount <= 0) continue;
        appendLedger(db, {
          roomId: w.roomId,
          userId: payer.userId,
          delta: -payer.amount,
          kind: 'seven-deuce',
          ref: w.handId,
          note: 'paid the 7-2 offsuit bounty',
        });
      }
      appendLedger(db, {
        roomId: w.roomId,
        userId: w.sevenDeuce.winnerUserId,
        delta: w.sevenDeuce.winnerAmount,
        kind: 'seven-deuce',
        ref: w.handId,
        note: 'won with 7-2 offsuit',
      });
      sevenDeuce = { seat: w.sevenDeuce.winnerSeat, amount: w.sevenDeuce.winnerAmount };
    }

    phase?.('settlement_after_seven_deuce');

    // `afterRows` above is the pre-rake stack and is only used for the
    // conservation check. settleRake credits the rake recipient, which may be a
    // player in this hand, so re-read the TRUE final stacks after every money
    // move. The projection and hand_settlements.final_stacks must equal
    // room_players.stack (spec: ending_stack = post-settlement actual stack).
    const finalUserIds = [
      ...new Set([...userIds, ...(w.rakeRecipientId !== null ? [w.rakeRecipientId] : [])]),
    ];
    const finalPlaceholders = finalUserIds.map(() => '?').join(',');
    const resultStacks = finalUserIds.length
      ? (
          db
            .prepare(
              `SELECT user_id, stack FROM room_players WHERE room_id = ? AND user_id IN (${finalPlaceholders})`,
            )
            .all(w.roomId, ...finalUserIds) as { user_id: number; stack: number }[]
        ).map((r) => ({ userId: r.user_id, stack: r.stack }))
      : [];

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

    phase?.('settlement_after_transcript');

    // Normalized stats projection, in the SAME transaction as the settlement.
    // A structurally impossible hand throws here and rolls the whole settlement
    // back (spec §2). Invariant: `applyHandSettlement` is only called for a hand
    // that actually started, so a real transcript is always present; the sole
    // tolerated no-op is an empty `entries` (test/aux callers with no
    // transcript) - any non-empty transcript must project or the hand rolls back.
    materializeHandProjection(db, {
      handId: w.handId,
      roomId: w.roomId,
      head: w.head,
      entries: w.entries,
      transcriptTs: w.now,
      now: w.now,
      // Live settlement is strict: malformed/mismatched transcripts roll back.
      strict: true,
      verifyHead: true,
      // The projection compares `net_delta` (= poker + squid) against these
      // poker deltas: the bounty is folded into the projection view so
      // `net_delta === ending_stack - starting_stack`.
      pokerLedger: w.projectionPokerLedger ?? w.pokerLedger,
      squidLedger: w.squidLedger,
      stackDeltas: w.stackDeltas,
      rake: w.rake,
      finalStacks: resultStacks,
    });

    phase?.('settlement_after_projection');

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

    phase?.('settlement_after_gameplay_state');

    const finalStacks = resultStacks;
    db.prepare('UPDATE hand_settlements SET final_stacks = ? WHERE hand_id = ?').run(
      JSON.stringify(finalStacks),
      w.handId,
    );
    phase?.('settlement_after_final_stacks');
    // Mark the durable lifecycle terminal in the SAME transaction. A crash
    // after this commit leaves a `committed` row and the marker; a rollback
    // leaves the `running` row written at deal time, which is exactly what the
    // restart scan needs to see.
    db.prepare(
      `INSERT INTO hand_lifecycle (hand_id, room_id, status, created_at, updated_at, resolved_at)
       VALUES (?, ?, 'committed', ?, ?, ?)
       ON CONFLICT(hand_id) DO UPDATE SET status = 'committed',
         updated_at = excluded.updated_at, resolved_at = excluded.resolved_at`,
    ).run(w.handId, w.roomId, w.now, w.now, w.now);
    phase?.('settlement_after_lifecycle');
    // The explicit commission recipient leg. `stackDeltas` is the game leg
    // (poker + squid + bounty); this leg is the rake credit. Consumers must add
    // the two to reconcile a seat's stack change; neither alone is the whole
    // story when the recipient is in the hand.
    const commissionDeltas =
      w.rake > 0 && w.rakeRecipientId !== null
        ? [{ userId: w.rakeRecipientId, delta: w.rake }]
        : [];
    phase?.('settlement_before_commit');
    return {
      status: 'applied',
      roomId: w.roomId,
      handId: w.handId,
      head: w.head,
      rake: w.rake,
      timeBankSkipped,
      finalStacks,
      gameDeltas: w.stackDeltas.map((d) => ({ userId: d.userId, delta: d.delta })),
      sevenDeuce,
      commissionDeltas,
    };
  });
  return write();
}

// ---------------------------------------------------------------------------
// P0-2 durable prepared settlement input
//
// The `Hand` freezes its whole settlement input (transcript + every money leg)
// into `hand_settlement_prepared` in its OWN committed transaction, then runs
// the money transaction from that DB row. A process crash between the two
// leaves a complete input a restarted server (or an operator) can settle
// without rebuilding anything from mutable room state - the current
// `room_players.stack` may have been moved by a mid-hand buy/peek/next action.
// ---------------------------------------------------------------------------

/** Canonical (key-order-stable) JSON for a frozen settlement input, so equal
 *  inputs hash equally regardless of object construction order.
 *
 *  NOTE the `undefined`-dropping rule below is only ever reached for the
 *  `entries` blob (whose own JSON round-trip also drops `undefined`); every
 *  optional top-level field is materialised to an explicit value by
 *  `normalizePreparedWrite` BEFORE this runs, so `{ sevenDeuce: undefined }` and
 *  `{ sevenDeuce: null }` both canonicalise to `"sevenDeuce":null`. That
 *  equivalence is intentional and safe: under `HandSettlementWrite` an absent
 *  optional means "use the default", which is exactly what explicit `null`/
 *  derived-default means. Normalising first makes the equivalence explicit and
 *  guarantees the frozen row always carries a complete structure. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Materialise every optional field to its explicit value so the frozen JSON is
 *  a complete `HandSettlementWrite` (see the `canonicalJson` note above). The
 *  derived defaults mirror what `applyHandSettlement` already does with an
 *  absent field, so normalisation never changes the settled numbers. */
function normalizePreparedWrite(w: HandSettlementWrite): HandSettlementWrite {
  return {
    ...w,
    projectionPokerLedger: w.projectionPokerLedger ?? w.pokerLedger,
    sevenDeuce: w.sevenDeuce ?? null,
    transcriptlessReceipt: w.transcriptlessReceipt ?? false,
  };
}

/** SHA-256 of a canonical prepared input, stored beside it and re-checked on
 *  every read so a tampered/truncated row fails closed. */
export function settlementInputHash(json: string): string {
  return createHash('sha256').update(json).digest('hex');
}

function isSafeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v);
}

/** Every `{userId,delta}` leg must be a well-formed safe-integer pair. */
function isUserDeltaArray(v: unknown): boolean {
  if (!Array.isArray(v)) return false;
  return v.every((d) => {
    if (!d || typeof d !== 'object') return false;
    const { userId, delta } = d as { userId?: unknown; delta?: unknown };
    return isSafeInt(userId) && isSafeInt(delta);
  });
}

/**
 * Full structural check of a frozen `HandSettlementWrite`. This is the
 * fail-closed boundary: a malformed frozen JSON (right hash, wrong shape) must
 * be classified as a `PreparedInputError` and quarantine the hand, never
 * escape as a plain `TypeError` that `onPersistFailed` would treat as a
 * retryable failure. Returns a quarantine reason, or null when the shape is
 * intact. The optional fields are accepted absent (legacy rows) because
 * `normalizePreparedWrite` supplies their defaults on read.
 */
function validateWriteShape(w: HandSettlementWrite): string | null {
  if (typeof w.handId !== 'string' || typeof w.roomId !== 'string' || typeof w.head !== 'string')
    return 'prepared input has a non-string identity field';
  if (!Array.isArray(w.entries)) return 'prepared input entries is not an array';
  if (!isSafeInt(w.rake) || w.rake < 0) return 'prepared input rake is invalid';
  if (typeof w.commissionBps !== 'number' || !Number.isFinite(w.commissionBps))
    return 'prepared input commissionBps is invalid';
  if (!isUserDeltaArray(w.stackDeltas)) return 'prepared input stackDeltas is malformed';
  if (!isUserDeltaArray(w.pokerLedger)) return 'prepared input pokerLedger is malformed';
  if (w.projectionPokerLedger !== undefined && !isUserDeltaArray(w.projectionPokerLedger))
    return 'prepared input projectionPokerLedger is malformed';
  if (!isUserDeltaArray(w.squidLedger)) return 'prepared input squidLedger is malformed';
  if (typeof w.squidNote !== 'string') return 'prepared input squidNote is invalid';
  if (!Array.isArray(w.timeBanks)) return 'prepared input timeBanks is not an array';
  for (const tb of w.timeBanks) {
    if (!tb || typeof tb !== 'object') return 'prepared input has a malformed time-bank entry';
    const { userId, ms, hands } = tb as { userId?: unknown; ms?: unknown; hands?: unknown };
    if (!isSafeInt(userId) || !isSafeInt(ms) || !isSafeInt(hands))
      return 'prepared input has a malformed time-bank entry';
  }
  if (w.timeBankEpoch !== null && !isSafeInt(w.timeBankEpoch))
    return 'prepared input timeBankEpoch is invalid';
  if (!Array.isArray(w.triggerIds) || !w.triggerIds.every((id) => id === null || isSafeInt(id)))
    return 'prepared input triggerIds is malformed';
  if (typeof w.bombRan !== 'boolean') return 'prepared input bombRan is invalid';
  if (w.rakeRecipientId !== null && !isSafeInt(w.rakeRecipientId))
    return 'prepared input rakeRecipientId is invalid';
  if (w.sevenDeuce !== undefined && w.sevenDeuce !== null) {
    const s = w.sevenDeuce;
    if (!isSafeInt(s.winnerUserId) || !isSafeInt(s.winnerSeat) || !isSafeInt(s.winnerAmount))
      return 'prepared input sevenDeuce is malformed';
    if (!Array.isArray(s.payerAmounts)) return 'prepared input sevenDeuce payerAmounts is missing';
    for (const p of s.payerAmounts) {
      if (!p || typeof p !== 'object') return 'prepared input sevenDeuce payerAmounts is malformed';
      const { userId, amount } = p as { userId?: unknown; amount?: unknown };
      if (!isSafeInt(userId) || !isSafeInt(amount))
        return 'prepared input sevenDeuce payerAmounts is malformed';
    }
  }
  if (w.transcriptlessReceipt !== undefined && typeof w.transcriptlessReceipt !== 'boolean')
    return 'prepared input transcriptlessReceipt is invalid';
  if (!isSafeInt(w.now)) return 'prepared input now is invalid';
  return null;
}

/** A prepared input that must NOT be silently applied (hash/identity/DB
 *  inconsistency). The hand is quarantined and the room stays frozen until an
 *  operator resolves it; callers must not retry it as if it were transient. */
export class PreparedInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreparedInputError';
  }
}

interface PreparedSettlementRow {
  hand_id: string;
  room_id: string;
  head: string;
  input_json: string;
  input_hash: string;
  prepared_at: number;
  attempts: number;
  last_error: string | null;
  resolved_at: number | null;
  resolved_by: number | null;
  resolution: string | null;
}

/** Fail closed: a hand whose frozen input cannot be trusted is quarantined, not
 *  aborted. `running`/`prepared`/`quarantined` all mean "money facts unknown";
 *  only an operator may resolve it. A hand that already committed/aborted is
 *  left alone (its history is settled). */
function quarantineHand(db: DB, handId: string, reason: string, now = Date.now()): void {
  db.transaction(() => {
    db.prepare(
      `UPDATE hand_lifecycle SET status = 'quarantined', updated_at = ?, resolved_at = NULL, last_error = ?
        WHERE hand_id = ? AND status IN ('running','prepared','quarantined')`,
    ).run(now, reason, handId);
    db.prepare('UPDATE hand_settlement_prepared SET last_error = ? WHERE hand_id = ?').run(
      reason,
      handId,
    );
  }).immediate();
}

/** Freeze a hand's whole settlement input in its OWN committed transaction and
 *  move `hand_lifecycle` running -> prepared. Idempotent for the in-process
 *  retry path: a second call must carry the identical input (the sealed write
 *  is frozen in memory), and a differing input is corruption that quarantines
 *  the hand rather than silently settling the wrong numbers. */
export function persistPreparedInput(
  db: DB,
  w: HandSettlementWrite,
): { hash: string; inserted: boolean } {
  const json = canonicalJson(normalizePreparedWrite(w));
  const hash = settlementInputHash(json);
  const now = Date.now();
  const work = db.transaction((): { hash: string; inserted: boolean } | { conflict: string } => {
    const existing = db
      .prepare('SELECT input_hash FROM hand_settlement_prepared WHERE hand_id = ?')
      .get(w.handId) as { input_hash: string } | undefined;
    if (existing) {
      if (existing.input_hash !== hash)
        return { conflict: `prepared settlement input changed for hand ${w.handId}` };
      return { hash, inserted: false };
    }
    const lc = db
      .prepare(
        `UPDATE hand_lifecycle SET status = 'prepared', updated_at = ?, last_error = NULL
          WHERE hand_id = ? AND room_id = ? AND status IN ('running','prepared')`,
      )
      .run(now, w.handId, w.roomId);
    if (lc.changes === 0) {
      const row = db.prepare('SELECT status FROM hand_lifecycle WHERE hand_id = ?').get(w.handId) as
        | { status: string }
        | undefined;
      // Already fully settled: nothing to prepare (the caller will see the
      // marker and report a duplicate).
      if (row?.status === 'committed') return { hash, inserted: false };
      return {
        conflict: `cannot prepare hand ${w.handId}: lifecycle is ${row?.status ?? 'missing'}`,
      };
    }
    db.prepare(
      `INSERT INTO hand_settlement_prepared
         (hand_id, room_id, head, input_json, input_hash, prepared_at, attempts, last_error, resolved_at, resolved_by, resolution)
       VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL)`,
    ).run(w.handId, w.roomId, w.head, json, hash, now);
    return { hash, inserted: true };
  });
  const result = work.immediate();
  if ('conflict' in result) {
    quarantineHand(db, w.handId, result.conflict, now);
    throw new PreparedInputError(result.conflict);
  }
  return result;
}

/** Parse + identity-check + hash-check + full structural-check a prepared row.
 *  Returns a quarantine reason instead of throwing so the caller can persist it.
 *  The check is deliberately exhaustive: a hash-correct but structurally wrong
 *  JSON must quarantine, never throw a bare `TypeError` into the transient
 *  retry path. */
function parsePreparedWrite(
  row: PreparedSettlementRow,
): { write: HandSettlementWrite } | { reason: string } {
  if (settlementInputHash(row.input_json) !== row.input_hash)
    return { reason: `prepared input hash mismatch on hand ${row.hand_id}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.input_json);
  } catch {
    return { reason: `prepared input is not valid JSON on hand ${row.hand_id}` };
  }
  if (!parsed || typeof parsed !== 'object')
    return { reason: `prepared input is not an object on hand ${row.hand_id}` };
  const w = parsed as HandSettlementWrite;
  if (w.handId !== row.hand_id)
    return { reason: `prepared input hand_id ${String(w.handId)} != ${row.hand_id}` };
  if (w.roomId !== row.room_id)
    return { reason: `prepared input room_id ${String(w.roomId)} != ${row.room_id}` };
  if (w.head !== row.head)
    return { reason: `prepared input head ${String(w.head)} != ${row.head}` };
  const shape = validateWriteShape(w);
  if (shape) return { reason: `${shape} on hand ${row.hand_id}` };
  return { write: normalizePreparedWrite(w) };
}

/** Cross-check a frozen input against current durable state. Any mismatch means
 *  the room moved under a hand whose money was already frozen, so a blind
 *  apply would corrupt accounting/counters. Returns a quarantine reason or
 *  null when the input is safe to apply. */
function validatePreparedAgainstDb(db: DB, w: HandSettlementWrite): string | null {
  // A `hand_settlements` marker means this hand already COMMITTED, and the
  // marker is the authority that the money moved exactly once. Every check
  // below validates the live state a *pending* apply needs (participant rows,
  // feature-trigger ownership, transcript head); a room that legitimately moved
  // on after commit must never turn a harmless duplicate retry into a
  // quarantine, so the marker short-circuits them. The one thing still worth
  // checking is that the marker describes the SAME hand/room/head/rake - a
  // marker for a different settlement is corruption and stays fail-closed. A
  // consistent marker returns null and `applyHandSettlement` loads the full
  // validated receipt via `loadSettledReceipt` (identical identity semantics).
  const marker = db
    .prepare('SELECT room_id, head, rake FROM hand_settlements WHERE hand_id = ?')
    .get(w.handId) as { room_id: string; head: string; rake: number } | undefined;
  if (marker) {
    if (marker.room_id !== w.roomId)
      return `settlement identity conflict on hand ${w.handId}: room ${marker.room_id} != ${w.roomId}`;
    if (marker.head !== w.head)
      return `settlement identity conflict on hand ${w.handId}: head ${marker.head} != ${w.head}`;
    if (!Number.isSafeInteger(marker.rake) || marker.rake < 0 || marker.rake !== w.rake)
      return `settlement identity conflict on hand ${w.handId}: rake ${marker.rake} != ${w.rake}`;
    return null;
  }

  // A transcript can only exist for a hand whose settlement already committed;
  // if one exists, it must describe the same sealed head.
  const t = db.prepare('SELECT head FROM transcripts WHERE hand_id = ?').get(w.handId) as
    | { head: string }
    | undefined;
  if (t && t.head !== w.head)
    return `transcript head disagrees with prepared input on hand ${w.handId}`;

  // Every participant the input moves chips for must still hold a room row.
  // A vanished row is a mid-hand change we must not guess about: settling would
  // fabricate a zero balance.
  const seen = new Set<number>();
  for (const d of w.stackDeltas) {
    if (seen.has(d.userId)) return `prepared input has duplicate participant ${d.userId}`;
    seen.add(d.userId);
    const rp = db
      .prepare('SELECT 1 FROM room_players WHERE room_id = ? AND user_id = ?')
      .get(w.roomId, d.userId);
    if (!rp)
      return `prepared participant ${d.userId} has no room_players row on hand ${w.handId}`;
  }

  // A feature trigger the hand claimed must still be owned by it. If another
  // hand has re-claimed it, applying this settlement would mis-account the
  // trigger that other hand now owns.
  for (const id of w.triggerIds) {
    if (!id) continue;
    const tr = db
      .prepare('SELECT status, claimed_hand_id FROM room_feature_triggers WHERE id = ?')
      .get(id) as { status: string; claimed_hand_id: string | null } | undefined;
    if (!tr || tr.status !== 'claimed' || tr.claimed_hand_id !== w.handId)
      return `feature trigger ${id} is not still claimed by hand ${w.handId}`;
  }

  // No marker exists here (a present one returned above), but ledger legs for
  // this hand already do: a partially applied settlement. Never layer a full
  // settlement over it.
  const partial = db
    .prepare(
      `SELECT 1 FROM ledger WHERE room_id = ? AND (ref = ? OR (kind = 'seven-deuce' AND ref = ?)) LIMIT 1`,
    )
    .get(w.roomId, w.head, w.handId);
  if (partial) return `ledger has entries for hand ${w.handId} but no settlement marker`;
  return null;
}

export interface ApplyPreparedResult {
  status: 'applied' | 'duplicate';
  outcome: HandSettlementOutcome;
}

/**
 * Reconstruct and apply a hand's settlement purely from its durable prepared
 * input - never from a live `GameRoom` or current room state.
 *
 * Every identity/hash/DB mismatch quarantines the hand (fail closed) and
 * throws `PreparedInputError`. A transient DB failure (lock/interrupt) is
 * rethrown so the caller may retry it. On success the prepared row is marked
 * resolved IN THE SAME transaction as the money move, so the frozen input and
 * its disposition can never disagree.
 */
export function applyPreparedHandSettlement(
  db: DB,
  handId: string,
  opts: {
    resolvedBy?: number | null;
    resolution?: string;
    /** Test-only fault hook, forwarded to the money transaction. */
    phase?: SettlementPhaseHook;
  } = {},
): ApplyPreparedResult {
  const row = db
    .prepare('SELECT * FROM hand_settlement_prepared WHERE hand_id = ?')
    .get(handId) as PreparedSettlementRow | undefined;
  if (!row) throw new PreparedInputError(`no prepared settlement input for hand ${handId}`);

  const lifecycle = db
    .prepare('SELECT status FROM hand_lifecycle WHERE hand_id = ?')
    .get(handId) as { status: string } | undefined;
  if (lifecycle?.status === 'aborted')
    throw new PreparedInputError(`hand ${handId} is aborted; settlement refused`);
  // A quarantined hand has a proven-bad frozen input: the only way out is an
  // explicit operator abort, never a re-apply. Refuse here (mirroring the HTTP
  // operator-retry route and `retrySettlement`) so a direct caller cannot settle
  // it, and classify as `PreparedInputError` so the transient retry machinery
  // does NOT treat it as auto-retryable.
  if (lifecycle?.status === 'quarantined')
    throw new PreparedInputError(
      `hand ${handId} is quarantined; settlement refused pending operator review`,
    );

  db.prepare('UPDATE hand_settlement_prepared SET attempts = attempts + 1 WHERE hand_id = ?').run(
    handId,
  );

  const parsed = parsePreparedWrite(row);
  if ('reason' in parsed) {
    quarantineHand(db, handId, parsed.reason);
    throw new PreparedInputError(parsed.reason);
  }
  const w = parsed.write;
  // `validatePreparedAgainstDb` iterates the frozen structure, so a shape
  // deviation it did not expect would surface here as a plain TypeError. Wrap
  // it so ANY validation error is still classified fail-closed (quarantine),
  // never a recoverable transient failure.
  let dbReason: string | null;
  try {
    dbReason = validatePreparedAgainstDb(db, w);
  } catch (err) {
    dbReason = `prepared input validation error: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (dbReason) {
    quarantineHand(db, handId, dbReason);
    throw new PreparedInputError(dbReason);
  }

  try {
    opts.phase?.('settlement_before_transaction');
    const outcome = db.transaction((): HandSettlementOutcome => {
      const o = applyHandSettlement(db, w, opts.phase);
      db.prepare(
        `UPDATE hand_settlement_prepared
           SET resolved_at = ?, resolved_by = ?, resolution = ?, last_error = NULL
         WHERE hand_id = ?`,
      ).run(Date.now(), opts.resolvedBy ?? null, opts.resolution ?? 'settlement', handId);
      return o;
    })();
    return { status: outcome.status, outcome };
  } catch (err) {
    if (isTransientTransferError(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (!(err instanceof PreparedInputError)) quarantineHand(db, handId, message);
    throw new PreparedInputError(message);
  }
}

export interface OperatorAbortResult {
  status: 'aborted' | 'already_aborted';
  /** The failure evidence recorded before the abort (`hand_lifecycle.last_error`),
   *  preserved so the HTTP layer can copy it into the admin audit trail after
   *  the lifecycle row has been overwritten. */
  lastError?: string | null;
}

/**
 * Operator abort of a hand that was dealt but never settled, using only durable
 * data. A `running` hand has no frozen input (crash before prepare); a
 * `prepared` hand has one but must not be guessed into a settlement; a
 * `quarantined` hand has a proven-bad frozen input that can NEVER be applied, so
 * abort is its only exit. None moves chips/ledger/transcript, so the operator
 * marks the hand `aborted` explicitly and releases the feature triggers it still
 * claims, letting the room deal again.
 *
 * The original `last_error` is deliberately preserved (COALESCE, not an
 * overwrite) so the failure evidence survives the resolution.
 */
export function abortPendingHandSettlement(
  db: DB,
  handId: string,
  opts: { resolvedBy?: number | null } = {},
): OperatorAbortResult {
  const row = db
    .prepare('SELECT status, last_error FROM hand_lifecycle WHERE hand_id = ?')
    .get(handId) as { status: string; last_error: string | null } | undefined;
  if (!row) throw new PreparedInputError(`unknown hand ${handId}`);
  if (row.status === 'aborted') return { status: 'already_aborted', lastError: row.last_error };
  if (row.status !== 'running' && row.status !== 'prepared' && row.status !== 'quarantined')
    throw new PreparedInputError(
      `hand ${handId} is ${row.status}; only running/prepared/quarantined can be aborted`,
    );
  const now = Date.now();
  return db.transaction((): OperatorAbortResult => {
    db.prepare(
      `UPDATE hand_lifecycle
          SET status = 'aborted', updated_at = ?, resolved_at = ?,
              last_error = COALESCE(last_error, 'operator abort')
        WHERE hand_id = ? AND status IN ('running','prepared','quarantined')`,
    ).run(now, now, handId);
    const triggers = db
      .prepare(
        "SELECT id, source FROM room_feature_triggers WHERE claimed_hand_id = ? AND status = 'claimed'",
      )
      .all(handId) as { id: number; source: string }[];
    for (const t of triggers) {
      if (t.source === 'manual')
        db.prepare(
          "UPDATE room_feature_triggers SET status = 'pending', claimed_hand_id = NULL, resolved_at = NULL WHERE id = ? AND status = 'claimed'",
        ).run(t.id);
      else
        db.prepare(
          "UPDATE room_feature_triggers SET status = 'cancelled', resolved_at = ? WHERE id = ? AND status = 'claimed'",
        ).run(now, t.id);
    }
    db.prepare(
      `UPDATE hand_settlement_prepared SET resolved_at = ?, resolved_by = ?, resolution = ?
        WHERE hand_id = ?`,
    ).run(
      now,
      opts.resolvedBy ?? null,
      row.status === 'quarantined' ? 'aborted_quarantined' : 'aborted',
      handId,
    );
    return { status: 'aborted', lastError: row.last_error };
  }).immediate();
}

/**
 * Strictly parse one persisted seat->delta leg (`settlement.deltas` or
 * `settlement.commissionDeltas`).
 *
 * Returns null on ANY structural deviation: a malformed entry, a non-integer
 * seat, a non-finite delta, or a duplicated seat. Recovery must never paper
 * over a corrupt leg with a partial array - the rebuilt `hand_end` would then
 * disagree with the durable settlement it claims to replay, which is worse than
 * admitting the payload cannot be rebuilt.
 */
function parseSeatDeltas(raw: unknown): { seat: number; delta: number }[] | null {
  if (!Array.isArray(raw)) return null;
  const out: { seat: number; delta: number }[] = [];
  const seen = new Set<number>();
  for (const d of raw as unknown[]) {
    if (!d || typeof d !== 'object') return null;
    const { seat, delta } = d as { seat?: unknown; delta?: unknown };
    if (typeof seat !== 'number' || !Number.isSafeInteger(seat)) return null;
    if (typeof delta !== 'number' || !Number.isFinite(delta)) return null;
    if (seen.has(seat)) return null;
    seen.add(seat);
    out.push({ seat, delta });
  }
  return out;
}

/**
 * Rebuild a `hand_end` frame for an already-committed hand from durable data.
 *
 * After a restart the in-memory terminal frame is gone, but the settlement is
 * fully persisted: the transcript holds the `hand_start` seat map and the
 * `settlement` entry (the exact combined/poker/commission deltas the live
 * `hand_end` carried), and the `hand_settlements` marker holds the sealed head,
 * rake and final stacks. Rebuilding from those gives a reconnecting client the
 * same terminal the live broadcast would have carried.
 *
 * This is STRICT and never falls back. A missing/corrupt field returns null
 * (the caller then emits a status-only `hand_recovery: committed`) rather than
 * fabricating money: the `final_stacks` marker must cover every participant
 * exactly once (no hand-start-stack/0 substitution), the marker's `head` and
 * `rake` must agree with the transcript, `sum(deltas) === -rake`, and the
 * commission legs must be structurally intact. A half-rebuilt terminal that
 * merely claims success would tell the client a different story than the
 * durable settlement. Also returns null when `userId` was not a seat - a recap
 * is never replayed to someone who was not in the hand.
 *
 * Only ever called for a lifecycle row already read as `committed`; a
 * transcript with a `settlement` entry but no marker (the write rolled back)
 * must NOT be projected as a success.
 */
function recoverHandEnd(
  db: DB,
  roomId: string,
  handId: string,
  userId: number,
): Extract<ServerMsg, { t: 'hand_end' }> | null {
  const t = db
    .prepare('SELECT head, entries FROM transcripts WHERE hand_id = ? AND room_id = ?')
    .get(handId, roomId) as { head: string; entries: string } | undefined;
  if (!t) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(t.entries);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  // Replay the hash chain: the `head` column alone is not trustworthy, and the
  // rebuilt terminal must be anchored to the sealed chain, not a rewrite.
  if (computeHead(parsed as TranscriptEntry[]) !== t.head) return null;
  const payloadOf = (type: string): Record<string, unknown> | null => {
    let found: Record<string, unknown> | null = null;
    for (const e of parsed as { type?: unknown; payload?: unknown }[]) {
      if (e && typeof e === 'object' && e.type === type) {
        // A duplicate hand_start/settlement is corruption: never pick the first.
        if (found !== null) return null;
        if (!e.payload || typeof e.payload !== 'object') return null;
        found = e.payload as Record<string, unknown>;
      }
    }
    return found;
  };
  const start = payloadOf('hand_start');
  const settle = payloadOf('settlement');
  if (!start || !settle || !Array.isArray(start.seats)) return null;
  // Parse the seat map strictly. A malformed or duplicated seat means the hand's
  // participant set is unknown, so no terminal can be reconstructed for it.
  const seatRows: { seat: number; userId: number }[] = [];
  const handSeats = new Set<number>();
  const seatUsers = new Set<number>();
  for (const s of start.seats as unknown[]) {
    if (!s || typeof s !== 'object') return null;
    const { seat, userId: uid } = s as { seat?: unknown; userId?: unknown };
    if (typeof seat !== 'number' || !Number.isSafeInteger(seat)) return null;
    if (typeof uid !== 'number' || !Number.isSafeInteger(uid)) return null;
    if (handSeats.has(seat) || seatUsers.has(uid)) return null;
    handSeats.add(seat);
    seatUsers.add(uid);
    seatRows.push({ seat, userId: uid });
  }
  if (seatRows.length === 0) return null;
  if (!seatUsers.has(userId)) return null;
  const marker = db
    .prepare(
      'SELECT head, rake, final_stacks FROM hand_settlements WHERE hand_id = ? AND room_id = ?',
    )
    .get(handId, roomId) as { head: string; rake: number; final_stacks: string } | undefined;
  if (!marker) return null;
  // The marker must vouch for THIS transcript chain, and its rake must be a
  // sane value before it can anchor the money legs.
  if (marker.head !== t.head) return null;
  if (!Number.isSafeInteger(marker.rake) || marker.rake < 0) return null;

  // `final_stacks` is the authoritative post-settlement stack per participant.
  // It must parse and cover EVERY participant exactly once; there is deliberately
  // no fallback to the deal-time stack, which would fabricate a chip movement
  // that may never have happened.
  let rawFinal: unknown;
  try {
    rawFinal = JSON.parse(marker.final_stacks);
  } catch {
    return null;
  }
  if (!Array.isArray(rawFinal)) return null;
  const finalByUser = new Map<number, number>();
  for (const f of rawFinal as unknown[]) {
    if (!f || typeof f !== 'object') return null;
    const { userId: uid, stack } = f as { userId?: unknown; stack?: unknown };
    if (typeof uid !== 'number' || !Number.isSafeInteger(uid)) return null;
    if (typeof stack !== 'number' || !Number.isSafeInteger(stack) || stack < 0) return null;
    if (finalByUser.has(uid)) return null; // duplicate participant row
    finalByUser.set(uid, stack);
  }
  for (const s of seatRows) {
    if (!finalByUser.has(s.userId)) return null; // participant without a final stack
  }

  // The game leg must be structurally intact and cover exactly the hand seats.
  // The documented contract `sum(deltas) === -rake` then pins it to the marker;
  // a mismatch means transcript and marker disagree, so rebuilding would lie.
  const deltas = parseSeatDeltas(settle.deltas);
  if (!deltas) return null;
  if (deltas.length !== seatRows.length) return null;
  for (const d of deltas) if (!handSeats.has(d.seat)) return null;
  if (deltas.reduce((sum, d) => sum + d.delta, 0) !== -marker.rake) return null;

  // The commission leg is seat-filtered: at most one entry, exactly the rake,
  // only for a hand seat, and absent iff the rake is zero. (A rake recipient
  // that is out of hand has no seat entry at all - the credit lives on the
  // external account's ledger row - so an empty leg is valid even when rake > 0.)
  const commissionDeltas = parseSeatDeltas(settle.commissionDeltas);
  if (!commissionDeltas) return null;
  if (commissionDeltas.length > 1) return null;
  for (const c of commissionDeltas) {
    if (c.delta !== marker.rake || !handSeats.has(c.seat)) return null;
  }
  if (marker.rake === 0 && commissionDeltas.length !== 0) return null;
  // The transcript's `commission` is only written when rake > 0; when present it
  // must equal the marker exactly. Never default a missing leg to 0.
  const commission = settle.commission;
  if (marker.rake === 0) {
    if (commission !== undefined && commission !== 0) return null;
  } else if (commission !== marker.rake) {
    return null;
  }

  return {
    t: 'hand_end',
    handId,
    head: marker.head,
    stacks: seatRows.map((s) => ({ seat: s.seat, stack: finalByUser.get(s.userId)! })),
    deltas,
    commissionDeltas,
    commission: marker.rake,
    ...(typeof start.commissionBps === 'number' && Number.isSafeInteger(start.commissionBps)
      ? { commissionBps: start.commissionBps }
      : {}),
  };
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

/**
 * Deterministic hand id for the bot playtest harness only.
 *
 * The deal randomness itself lives client-side (mental-poker `randomPerm`), but
 * the hand id is minted here on the server, so the harness cannot make its
 * sequence reproducible on its own. When `BOT_TEST_SHUFFLE_SEED` is set we
 * derive the id from `(seed, per-room hand ordinal)` instead of CSPRNG bytes;
 * the default path (`randomBytes`) is byte-for-byte unchanged.
 *
 * ISOLATION: because the id is a pure function of `(seed, ordinal)`,
 * `BOT_TEST_SHUFFLE_SEED` must ONLY be used against a throwaway/temp database.
 * `transcripts.hand_id` is a PRIMARY KEY, so pointing the same seed at a
 * non-empty DB (a reused room, or a restart) re-mints ids that already exist and
 * collides on insert. The eval/playtest harnesses boot a fresh `tmpdir()` DB.
 */
function testHandId(seed: string, ordinal: number): string {
  return createHash('sha256')
    .update(`4am-test-hand:${seed}:${ordinal}`)
    .digest('hex')
    .slice(0, 16);
}

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
  private peekOffers = new Map<string, PeekOffer>();
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
  private hostHandover: NodeJS.Timeout | null = null;
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
    // Reconnect-safe peek reconciliation. A target's terminal
    // `peek_offer_closed` is a one-shot unicast: if the target's socket is gone
    // when the offer resolves (TTL / next hand / shutdown), it is dropped and
    // never replayed, so a banner could stick forever. Every (re)connect
    // re-asserts the authoritative set of still-open INCOMING offers; the client
    // keeps those ids and drops any other pending banner. Ids only - no
    // cards/amount/fromUserId/failure reason, so a replay can never leak more
    // than the original `peek_offer`.
    const incomingOfferIds: string[] = [];
    for (const [offerId, offer] of this.peekOffers) {
      if (offer.targetUserId === userId) incomingOfferIds.push(offerId);
    }
    this.send(userId, { t: 'peek_offers_snapshot', incomingOfferIds });
  }

  leave(userId: number, ws: WebSocket): void {
    if (this.sockets.get(userId) === ws) {
      this.sockets.delete(userId);
      this.broadcastRoomState();
      // a folded player walking away must never strand the hand
      this.hand?.onPlayerGone(userId);
      this.scheduleHostHandover(userId);
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

  /** The host is the only person who can deal, so a host who shuts their laptop
   *  freezes the table for everyone still sitting at it. After a grace window the
   *  role passes to someone who is actually here.
   *
   *  Host only, deliberately. The BANKER approves buy-ins and moves chips, and a
   *  money authority must never change hands on a timer - if the banker is gone,
   *  the table waits for them or names a backup by hand. */
  private scheduleHostHandover(goneUserId: number): void {
    if (this.draining) return;
    const room = getRoom(this.db, this.roomId);
    if (!room || room.host_id !== goneUserId || this.hostHandover) return;
    this.hostHandover = setTimeout(() => {
      this.hostHandover = null;
      // The process may have begun shutting down (db closed) after this timer
      // was armed; touching the DB then would be an unhandled crash.
      if (!this.db.open || this.draining) return;
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
    if (this.hostHandover) clearTimeout(this.hostHandover);
    this.hostHandover = null;
    // Safe to tell a still-connected party the offer is over (the process is
    // draining, or the hub reclaims an idle room). A socket that is already
    // gone drops the frame, and its reconnect gets an empty
    // `peek_offers_snapshot`, so nothing is stranded either way.
    this.clearPeekOffers('expired');
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
    // the host's turn-time setting is read at deal time, so edits apply from the next hand
    const handOpts: GameOpts = {
      ...this.opts,
      actionTimeoutMs:
        room.action_secs !== null ? room.action_secs * 1000 : this.opts.actionTimeoutMs,
      tvReplays: !!room.tv_replays,
    };
    this.shown.clear();
    this.shownHandId = null;
    // NOTE: the previous hand's terminal `hand_end` is deliberately NOT cleared
    // here. A player who is not dealt into this hand never receives a
    // `hand_start`, so the previous hand's terminal frame is the only way their
    // client can clear a stuck settlement banner; a later `hand_start` or
    // lifecycle recovery supersedes it for the player who did move on.
    // an offer cannot outlive its hand: end it explicitly rather than silently
    this.clearPeekOffers('expired');
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
    this.broadcast({ t: 'cards_shown', handId, seat, cards });
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
   * seven-deuce / peek legs on the hand id, so a hand counts as voided when a
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
      try {
        this.broadcast({ t: 'seven_deuce', handId, seat, amount: total });
        this.broadcastRoomState();
      } catch (err) {
        // Notification only: the money already moved. A lost frame must never
        // escape into the hub and mark the room unhealthy.
        console.error('7-2 bounty broadcast failed', err);
      }
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

  /**
   * Whether a hand participant's hole cards are already public for `handId`:
   * revealed at showdown, or voluntarily shown. Shared by offer creation AND
   * acceptance so the two gates can never drift - a target may stay private
   * when the offer is made and then `show_cards` before answering, and only an
   * acceptance-time re-check can stop the buyer from paying for cards that are
   * already on screen for everyone.
   */
  private peekTargetIsPublic(handId: string, targetSeat: number): boolean {
    const revealed =
      this.lastHandShow?.handId === handId && this.lastHandShow.revealedSeats.has(targetSeat);
    const shown = this.shownHandId === handId && this.shown.has(targetSeat);
    return revealed || shown;
  }

  /**
   * A paid request to privately see a player's cards from the hand that just
   * ended.
   *
   * House rule (server-authoritative): a peek costs a FIXED 1bb, paid by the
   * requester to the player being looked at. ANY seated player may be the
   * requester - including players who folded this hand and players who did not
   * take part in it at all - so a ring table can have several parallel offers
   * (one per target, tracked separately in `peekOffers`). The target is any
   * participant of the last hand whose hole cards are still private: a folder,
   * or a winner who was never shown. Cards already public - revealed at
   * showdown or voluntarily shown - cannot be bought. The client's `amount` is
   * ignored.
   */
  private onPeekOffer(userId: number, msg: Extract<ClientMsg, { t: 'peek_offer' }>): void {
    const snap = this.lastHandShow;
    if (this.hand || !snap || snap.handId !== msg.handId)
      return this.send(userId, { t: 'error', message: 'peek offers only work between hands' });
    // A voided hand never happened: refuse new offers outright so no stale
    // offer can later be accepted into a transfer the void cannot reverse.
    if (this.isHandVoided(msg.handId))
      return this.send(userId, { t: 'error', message: 'that hand was voided' });
    const target = snap.bySeat.get(msg.targetSeat);
    if (!target)
      return this.send(userId, { t: 'error', message: 'that player was not in the last hand' });
    if (target.userId === userId)
      return this.send(userId, { t: 'error', message: 'those are your own cards' });
    if (this.peekTargetIsPublic(msg.handId, msg.targetSeat))
      return this.send(userId, { t: 'error', message: 'those cards are already public' });
    const room = getRoom(this.db, this.roomId);
    if (!room) return;
    // fixed price, never the client's number
    const amount = room.bb;
    const buyer = this.db
      .prepare(
        `SELECT rp.stack, rp.seat, COALESCE(u.display_name, u.username) as name
         FROM room_players rp JOIN users u ON u.id = rp.user_id
         WHERE rp.room_id = ? AND rp.user_id = ?`,
      )
      .get(this.roomId, userId) as
      | { stack: number; seat: number | null; name: string }
      | undefined;
    // A spectator (no `room_players` row at all) or a player who left their
    // seat (seat null) has no stake and cannot pay the target. Reject
    // explicitly: a silent drop would strand a client that is waiting for a
    // result that will never arrive.
    if (!buyer || buyer.seat === null)
      return this.send(userId, { t: 'error', message: 'only seated players can buy a peek' });
    if (buyer.stack < amount)
      return this.send(userId, { t: 'error', message: 'not enough chips for that offer' });
    const offerId = randomBytes(6).toString('hex');
    // Server-authoritative expiry: a target who disconnects, ignores the frame,
    // or has their grant revoked must never leave the requester waiting forever.
    const timer = setTimeout(() => this.expirePeekOffer(offerId), PEEK_OFFER_TTL_MS);
    timer.unref?.();
    this.peekOffers.set(offerId, {
      handId: msg.handId,
      fromUserId: userId,
      targetSeat: msg.targetSeat,
      targetUserId: target.userId,
      amount,
      timer,
    });
    this.send(target.userId, {
      t: 'peek_offer',
      offerId,
      handId: msg.handId,
      fromUserId: userId,
      fromName: buyer.name,
      targetSeat: msg.targetSeat,
      amount,
    });
  }

  /**
   * Terminally close an offer: the requester gets the full `peek_result` (with
   * the reveal on acceptance); the target gets a narrow `peek_offer_closed` so
   * its pending banner can dismiss in sync without a client-side timeout. The
   * target frame carries no `cards`/`amount`, so it never reveals more than the
   * `peek_offer` the target already saw.
   */
  private closePeekOffer(
    offerId: string,
    offer: PeekOffer,
    status: 'accepted' | 'declined' | 'expired' | 'failed',
    cards?: CardId[],
  ): void {
    this.send(offer.fromUserId, {
      t: 'peek_result',
      offerId,
      handId: offer.handId,
      targetSeat: offer.targetSeat,
      status,
      amount: offer.amount,
      ...(cards ? { cards } : {}),
    });
    this.send(offer.targetUserId, {
      t: 'peek_offer_closed',
      offerId,
      handId: offer.handId,
      targetSeat: offer.targetSeat,
      status,
    });
  }

  /** Terminally end every outstanding offer, optionally telling each requester
   *  why. Used at hand start (an offer cannot outlive its hand) and shutdown. */
  private clearPeekOffers(reason?: 'expired' | 'declined'): void {
    for (const [offerId, offer] of this.peekOffers) {
      clearTimeout(offer.timer);
      if (reason) this.closePeekOffer(offerId, offer, reason);
    }
    this.peekOffers.clear();
  }

  /** A 5s offer lapsed: drop it and tell both sides explicitly. */
  private expirePeekOffer(offerId: string): void {
    const offer = this.peekOffers.get(offerId);
    if (!offer) return;
    this.peekOffers.delete(offerId);
    clearTimeout(offer.timer);
    this.closePeekOffer(offerId, offer, 'expired');
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
    // Validate FIRST, then terminally end the offer. Every failure path reports
    // an explicit result to the requester, so a bad signature/short balance can
    // never strand them with no `peek_result` at all.
    const finish = (status: 'accepted' | 'declined' | 'failed', cards?: CardId[]): void => {
      this.peekOffers.delete(msg.offerId);
      clearTimeout(offer.timer);
      this.closePeekOffer(msg.offerId, offer, status, cards);
    };
    if (msg.t === 'peek_decline') {
      finish('declined');
      return;
    }
    if (this.hand) {
      finish('failed');
      return this.send(userId, { t: 'error', message: 'a new hand already started' });
    }
    // The offer may have been made before the banker voided the hand. Reject
    // the acceptance before any money moves, and terminate the offer so the
    // requester gets an explicit `peek_result` instead of a silent stall.
    if (this.isHandVoided(offer.handId)) {
      finish('failed');
      return this.send(userId, { t: 'error', message: 'that hand was voided' });
    }
    // The target may have been private when the offer was made and then showed
    // its cards before answering. Re-check the CURRENT public state before any
    // money moves, or the buyer would pay for cards already visible table-wide.
    if (this.peekTargetIsPublic(offer.handId, offer.targetSeat)) {
      finish('failed');
      return this.send(userId, { t: 'error', message: 'those cards are already public' });
    }
    if (!verifyContent(target.pubkey, offer.handId, 'peek_accept', signedBody(msg), msg.sig)) {
      finish('failed');
      return this.send(userId, { t: 'error', message: 'bad signature' });
    }
    const cards = verifySnapshotShares(target, msg.shares, this.lookup);
    if (!cards) {
      finish('failed');
      return this.send(userId, { t: 'error', message: 'invalid card reveal' });
    }
    const buyerRow = this.db
      .prepare('SELECT stack, seat FROM room_players WHERE room_id = ? AND user_id = ?')
      .get(this.roomId, offer.fromUserId) as
      | { stack: number; seat: number | null }
      | undefined;
    // Re-check the buyer's CURRENT seat, not just its balance: a requester may
    // leave their seat while the offer is pending, and the client drops a
    // reveal once `seat` is null - charging there would burn the 1bb for cards
    // the buyer never sees. This is the final authorization check; the
    // creation-time seat gate alone cannot see a later `leave_seat`.
    if (!buyerRow || buyerRow.seat === null) {
      finish('failed');
      return this.send(userId, { t: 'error', message: 'the buyer is no longer seated' });
    }
    if (buyerRow.stack < offer.amount) {
      finish('failed');
      return this.send(userId, { t: 'error', message: 'the buyer no longer has enough chips' });
    }
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
    finish('accepted', cards);
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
        if (!ok) rearm();
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
   * Returns whether the frame was handed to the transport.
   */
  private publish(msg: ServerMsg, label = 'hand broadcast failed'): boolean {
    try {
      this.room.broadcast(msg);
      return true;
    } catch (err) {
      this.logBroadcastFailure(label, msg.t, err);
      return false;
    }
  }

  private logBroadcastFailure(label: string, t: string, err: unknown): void {
    const detail = {
      id: this.id,
      t,
      message: err instanceof Error ? err.message : String(err),
    };
    hdbg('broadcastFailed', detail);
    // hdbg is off by default, so a lost frame would otherwise be completely
    // silent in production. Surface it on the normal error log.
    console.error(label, detail);
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
      this.logBroadcastFailure('hand settlement broadcast failed', msg.t, err);
    }
  }

  private safeBroadcastRoomState(): void {
    try {
      this.room.broadcastRoomState();
    } catch (err) {
      const detail = {
        room: this.roomId,
        message: err instanceof Error ? err.message : String(err),
      };
      hdbg('broadcastRoomStateFailed', detail);
      console.error('hand settlement room_state broadcast failed', detail);
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
