import type { DB } from './db.js';
import {
  beginBotStop,
  claimStartingBot,
  completeBotStop,
  finalizeBotRemoved,
  forceStopBot,
  markBotError,
  revokeBotGrants,
  type BotSupervisorHooks,
  type ClaimedBot,
} from './botRoutes.js';
import { BotRunner, botHardStopMsFromEnv, type BotRunnerOptions } from './botRunner.js';
import { roomEvents } from './rooms.js';
import { MAX_TIMER_MS } from './tunables.js';

/**
 * Phase 1b: the bot supervisor.
 *
 * It owns the runner lifecycle. The HTTP routes remain the single source of the
 * persisted state machine (Phase 1a); the supervisor only reacts to them:
 *
 *   - `startBot`  : claim the `starting` bot (the one and only `starting ->
 *                   running` + grant-issuing entry point) and launch a runner;
 *   - `stopBot`   : let the runner wind down gracefully, then revoke + mark
 *                   `stopped`;
 *   - `removeBot` : the same wind-down, then `removed` + revoke + cancel buys;
 *   - `recover`   : on boot, re-claim bots left `running`/`starting`, and finish
 *                   a `stopping` bot that never got to finalize;
 *   - `stopAll`   : on shutdown, stop every runner and persist `stopped`, so no
 *                   `running` bot with a live grant survives the process.
 *
 * Process/placement contract (important): the supervisor MUST run in the same
 * process as the game engine. Its runners connect over the loopback WS, and the
 * graceful-stop decision reads the engine's in-process `activeHands` singleton
 * (see `BotRunner.serverHandActive`). Running the supervisor out of process
 * would need a protocol signal instead.
 *
 * Capacity contract: slots are pooled PER ROOM, not shared server-wide. Each
 * room may run up to `maxPerRoom` simultaneous runners (default 8); a wide
 * server-wide `maxConcurrent` (default 64) is kept only as a safety valve
 * against runaway resource use across many rooms. A runner in one room can no
 * longer crowd out another room. The public HTTP `POST .../start` refuses a
 * start that would exceed EITHER bound with 409 (`canStart(roomId)` gate in the
 * route), while boot `recover()` and internal supervision feed excess
 * `starting` bots through a `pending` queue that drains as that room's slots
 * free. That asymmetry is deliberate: a host gets an immediate error, recovery
 * never strands a `starting` bot forever.
 *
 * Lifetime / slot accounting:
 *   - a runner is held in `runners` from launch until `runner.done` resolves
 *     (fatal, graceful stop, socket failure, natural exit) - exactly one release
 *     per runner, identity-checked so a restart cannot lose a newer runner;
 *   - `runnerRoom` maps each live runner to its room so a per-room count is a
 *     cheap in-memory scan, never a DB query on the start path;
 *   - a start beyond a bound is queued (ordered) rather than stranded in
 *     `starting`; `drainPending` retries the queue whenever a slot frees,
 *     starting only queued bots whose own room has room (a full room never
 *     blocks another room's drained bots).
 *
 * Room retirement contract: the supervisor subscribes to `roomEvents`
 * (`subscribeRoomEvents()`). Whenever a room is archived or deleted - through
 * any entry point (`/close`, admin direct archive/delete) -
 * every runner AND every queued bot belonging to that room is wound down to
 * `stopped` (+ revoke). The room's runner slot is genuinely freed; clearing the
 * seat rows alone is not enough.
 */

/** The slice of `BotRunner` the supervisor needs (injectable in tests). */
export interface RunnerHandle {
  /** Resolves once startup has settled (connected or cancelled). */
  start(): Promise<void>;
  /** Cancels and waits for the runner to fully exit (socket closed). */
  stop(): Promise<void>;
  /** Resolves when the runner has fully exited; the supervisor frees the slot. */
  readonly done: Promise<void>;
}

export interface BotSupervisorOptions {
  /** Loopback base URL for the runners' WS connections. */
  baseUrl: string;
  /**
   * Max simultaneously running bots PER ROOM. Default 8. This is the primary
   * capacity bound: rooms no longer share one pool.
   */
  maxPerRoom?: number;
  /**
   * Whole-server safety valve across every room. Default 64 (deliberately wide:
   * the per-room bound is what limits normal play; this only stops runaway
   * resource use when very many rooms run bots at once).
   */
  maxConcurrent?: number;
  /** Extra options forwarded to every `BotRunner`. */
  runner?: Omit<BotRunnerOptions, 'baseUrl'>;
  /**
   * Second safety net around `runner.stop()` in `stopBot`/`removeBot`. The
   * runner already caps itself (`runner.hardStopMs`), but a runner whose `stop()`
   * is itself wedged must not stall the supervisor's finalize (which is what
   * actually removes the row the DELETE route parked in `202`). Defaults to the
   * runner's own hard stop plus `STOP_TIMEOUT_MARGIN_MS`.
   */
  stopTimeoutMs?: number;
  /** Injection seam for tests; production constructs a real `BotRunner`. */
  runnerFactory?: (db: DB, claim: ClaimedBot, opts: BotRunnerOptions) => RunnerHandle;
  log?: (line: string) => void;
}

/** Default per-room runner bound (the old server-wide default). */
const DEFAULT_MAX_PER_ROOM = 8;
/** Default server-wide safety valve; wide enough never to crowd out a room. */
const DEFAULT_MAX_CONCURRENT = 64;
/**
 * Slack the supervisor's own stop bound keeps beyond the runner's hard stop, so
 * the runner's normal forced-finish path wins the race and this net only catches
 * a `stop()` that is itself wedged.
 */
const STOP_TIMEOUT_MARGIN_MS = 15_000;

/** Coerce an env/option value to a positive integer, or fall back. */
function positiveInt(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * Resolve the supervisor's own stop bound from an explicit option (or the
 * runner's hard stop + `STOP_TIMEOUT_MARGIN_MS`) and keep the result inside what
 * a real `setTimeout` can represent.
 *
 * This is the ONLY place that knows the margin is added on top of the runner's
 * hard stop, so it is the only place that can see the final delay may exceed the
 * timer ceiling. Handing a larger delay to `setTimeout` makes Node fire it
 * almost immediately (1ms) and emit `TimeoutOverflowWarning` - the exact
 * opposite of "wait this long before finalizing". Clamping HERE (rather than
 * lowering the table's max) keeps `tunables.ts`, which knows nothing about this
 * consumer's margin, from silently coupling the operator-facing hard-stop limit
 * to a supervisor implementation detail. The explicit `opts.stopTimeoutMs` path
 * goes through the same function, so it is bounded too.
 */
export function resolveStopTimeoutMs(
  explicit: number | undefined,
  runnerHardStop: number,
): { ms: number; requested: number; clamped: boolean } {
  const requested = positiveInt(explicit, runnerHardStop + STOP_TIMEOUT_MARGIN_MS);
  return requested > MAX_TIMER_MS
    ? { ms: MAX_TIMER_MS, requested, clamped: true }
    : { ms: requested, requested, clamped: false };
}

export class BotSupervisor implements BotSupervisorHooks {
  private readonly runners = new Map<string, RunnerHandle>();
  /** Live runner -> room, so per-room counts need no DB round-trip. */
  private readonly runnerRoom = new Map<string, string>();
  /** Bots waiting for a runner slot; ordered, deduped, per-room filtered. */
  private readonly pending: string[] = [];
  private readonly maxPerRoom: number;
  private readonly maxConcurrent: number;
  private readonly stopTimeoutMs: number;
  private readonly log: (line: string) => void;
  /**
   * Set at the start of `stopAll()`. Once set, no new runner may be claimed or
   * launched (`canStart`/`startBot`/`drainPending` all refuse), so a start that
   * races shutdown can never escape the finalize snapshot.
   */
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    private readonly db: DB,
    private readonly opts: BotSupervisorOptions,
  ) {
    this.maxPerRoom = positiveInt(opts.maxPerRoom, DEFAULT_MAX_PER_ROOM);
    this.maxConcurrent = positiveInt(opts.maxConcurrent, DEFAULT_MAX_CONCURRENT);
    this.log = opts.log ?? ((line) => console.log(`[bot-supervisor] ${line}`));
    // Keep the net just beyond the runner's own hard stop so the runner normally
    // finalizes itself and this only fires for a `stop()` that is itself wedged.
    // The derived value is clamped to the timer ceiling because this layer is
    // the one adding the margin (see `resolveStopTimeoutMs`).
    const runnerHardStop = opts.runner?.hardStopMs ?? botHardStopMsFromEnv();
    const stopTimeout = resolveStopTimeoutMs(opts.stopTimeoutMs, runnerHardStop);
    this.stopTimeoutMs = stopTimeout.ms;
    if (stopTimeout.clamped) {
      this.log(
        `stopTimeoutMs ${stopTimeout.requested}ms exceeds the setTimeout ceiling; clamped to ${MAX_TIMER_MS}ms`,
      );
    }
  }

  /** Live runners, server-wide or scoped to one room. */
  runningCount(roomId?: string): number {
    if (roomId === undefined) return this.runners.size;
    let n = 0;
    for (const rid of this.runnerRoom.values()) if (rid === roomId) n++;
    return n;
  }

  pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Whether a runner may start. With a `roomId`, the room's own pool must have a
   * free slot AND the server-wide valve must not be tripped; without one, only
   * the server-wide valve is checked (back-compat for callers with no room
   * context).
   */
  canStart(roomId?: string): boolean {
    if (this.shuttingDown) return false;
    if (this.runners.size >= this.maxConcurrent) return false;
    if (roomId !== undefined && this.runningCount(roomId) >= this.maxPerRoom) return false;
    return true;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  hasRunner(botId: string): boolean {
    return this.runners.has(botId);
  }

  /**
   * Claim a `starting` bot and launch a runner (queued when its room, or the
   * server valve, is at capacity). `roomId` is optional: when omitted it is read
   * from the bot row, so a recovery/embedder call cannot misfile the bot.
   */
  startBot(botId: string, roomId?: string): void {
    if (this.shuttingDown) {
      this.log(`refused start for ${botId}: shutting down`);
      return;
    }
    if (this.runners.has(botId) || this.pending.includes(botId)) return;
    const room = this.resolveRoom(botId, roomId);
    if (room === undefined) {
      this.log(`refused start for ${botId}: no such bot row`);
      return;
    }
    if (!this.canStart(room)) {
      // Explicit overflow policy: queue instead of leaving a `starting` bot with
      // no runner forever. `drainPending` starts it as soon as ITS room has a
      // free slot - a full room never blocks another room's queued bots.
      this.pending.push(botId);
      this.log(
        `queued ${botId} (room ${room}: ${this.runningCount(room)}/${this.maxPerRoom}; server ${this.runners.size}/${this.maxConcurrent})`,
      );
      return;
    }
    this.launch(botId, room);
  }

  /** The room a bot belongs to: the caller's room when trusted, else the row. */
  private resolveRoom(botId: string, roomId?: string): string | undefined {
    if (roomId !== undefined) return roomId;
    return (
      this.db.prepare('SELECT room_id FROM bot_accounts WHERE id = ?').get(botId) as
        | { room_id: string }
        | undefined
    )?.room_id;
  }

  private launch(botId: string, roomId: string): void {
    if (this.shuttingDown) {
      this.log(`refused launch for ${botId}: shutting down`);
      return;
    }
    const claim = claimStartingBot(this.db, botId);
    if (!claim) {
      this.log(`claim refused for ${botId} (not starting, room or identity invalid)`);
      return;
    }
    const runnerOpts: BotRunnerOptions = { baseUrl: this.opts.baseUrl, ...this.opts.runner };
    let runner: RunnerHandle;
    try {
      runner = this.opts.runnerFactory
        ? this.opts.runnerFactory(this.db, claim, runnerOpts)
        : new BotRunner(this.db, claim, runnerOpts);
    } catch (err) {
      // The bot was already claimed into `running`; a construction failure must
      // not leave a `running` bot with no runner.
      this.log(
        `runner construction failed for ${botId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      try {
        markBotError(this.db, botId);
      } catch {
        // best effort
      }
      return;
    }
    this.runners.set(botId, runner);
    // Trust the claim's room (authoritative), not the caller's hint.
    this.runnerRoom.set(botId, claim.roomId ?? roomId);
    // `start()` resolves after startup (it never rejects: a startup failure is
    // reported as a bot error internally). `done` resolves only when the runner
    // has fully exited, so holding until then accounts for fatals and races.
    void runner.start().catch((err) => {
      this.log(`runner start failed for ${botId}: ${err instanceof Error ? err.message : String(err)}`);
      try {
        markBotError(this.db, botId);
      } catch {
        // best effort
      }
    });
    void runner.done.then(
      () => this.release(botId, runner),
      () => this.release(botId, runner),
    );
  }

  /** Free a runner slot exactly once, and only if it still belongs to `runner`. */
  private release(botId: string, runner?: RunnerHandle): void {
    const current = this.runners.get(botId);
    if (current !== undefined && current !== runner) return;
    this.runners.delete(botId);
    this.runnerRoom.delete(botId);
    this.drainPending();
  }

  /**
   * Drain queued starts, starting only those whose OWN room has a free slot and
   * while the server valve allows it. Entries that cannot start now are kept in
   * order, so one full room never blocks another room's queued bots.
   */
  private drainPending(): void {
    // Never start a queued bot while shutting down: it would escape finalize.
    if (this.shuttingDown || this.pending.length === 0) return;
    const deferred: string[] = [];
    for (const botId of this.pending) {
      const bot = this.db
        .prepare('SELECT status, room_id FROM bot_accounts WHERE id = ?')
        .get(botId) as { status: string; room_id: string } | undefined;
      // Drop entries that were stopped/removed while queued.
      if (!bot || bot.status !== 'starting') continue;
      if (!this.canStart(bot.room_id)) {
        deferred.push(botId);
        continue;
      }
      this.launch(botId, bot.room_id);
    }
    this.pending.length = 0;
    this.pending.push(...deferred);
  }

  private forgetPending(botId: string): void {
    const i = this.pending.indexOf(botId);
    if (i >= 0) this.pending.splice(i, 1);
  }

  /**
   * Bound `runner.stop()` by `stopTimeoutMs`. The runner caps itself, but this is
   * the layer that owns the persisted finalize, so it must never be stalled by a
   * runner that cannot stop. On timeout it logs and returns, letting the caller's
   * `finally` run `finalizeBotRemoved`/`completeBotStop` as normal. A late `done`
   * is harmless: it only reaches the idempotent `release`, and the finalize it
   * would have raced is the atomic single-winner DELETE/CAS.
   *
   * A rejection from `runner.stop()` propagates (the caller logs it), exactly as
   * it did before; only a hang is converted into a bounded return.
   */
  private async stopRunner(botId: string, runner: RunnerHandle): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        runner.stop().then(() => 'settled' as const),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), this.stopTimeoutMs);
        }),
      ]);
      if (outcome === 'timeout') {
        this.log(
          `runner stop for ${botId} exceeded ${this.stopTimeoutMs}ms; finalizing without waiting`,
        );
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Graceful stop: wind the runner down, then revoke + mark stopped. The
   * finalize runs in `finally`, so even a throwing `runner.stop()` cannot leave
   * the bot `stopping` with a live grant and no runner.
   */
  async stopBot(botId: string): Promise<void> {
    this.forgetPending(botId);
    const runner = this.runners.get(botId);
    try {
      if (runner) await this.stopRunner(botId, runner);
    } catch (err) {
      this.log(`runner stop failed for ${botId}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.release(botId, runner);
      if (this.deleteRequested(botId)) {
        // A delete was requested while this bot was winding down for a stop;
        // finish the deletion rather than parking it stopped.
        if (!finalizeBotRemoved(this.db, botId))
          this.log(`stopBot: delete-requested bot ${botId} did not delete`);
      } else {
        // The route already parked a graceful stop in `stopping`; beginBotStop
        // is then a no-op. What must never be silent is a bot that fails to
        // reach `stopped`, so record that.
        const began = beginBotStop(this.db, botId);
        if (!completeBotStop(this.db, botId))
          this.log(`stopBot: bot ${botId} did not reach stopped (began=${began})`);
      }
    }
  }

  /** Graceful removal: wind the runner down, then hard-delete the bot's rows
   *  (always). The route persists `delete_requested_at` before calling this, so
   *  an interrupted wind-down is finished by `recover()`. */
  async removeBot(botId: string): Promise<void> {
    this.forgetPending(botId);
    const runner = this.runners.get(botId);
    try {
      if (runner) await this.stopRunner(botId, runner);
    } catch (err) {
      this.log(`runner stop failed for ${botId}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.release(botId, runner);
      if (!finalizeBotRemoved(this.db, botId))
        this.log(`removeBot: bot ${botId} did not delete`);
    }
  }

  /** Whether a hard delete has been requested for this bot. */
  private deleteRequested(botId: string): boolean {
    const row = this.db
      .prepare('SELECT delete_requested_at AS at FROM bot_accounts WHERE id = ?')
      .get(botId) as { at: number | null } | undefined;
    return !!row && row.at !== null;
  }

  /**
   * Wind down every runner AND every queued bot that belongs to `roomId`, so a
   * retired room does not keep occupying its runner slots. Each bot goes through
   * the ordinary graceful `stopBot`: the runner folds, the grant is revoked and
   * the persisted status reaches `stopped` (a queued `starting` bot is dequeued
   * and finalized too). Returns once every wind-down has settled.
   */
  async releaseRoom(roomId: string): Promise<void> {
    const botIds = this.roomBotIds(roomId);
    if (botIds.length === 0) return;
    this.log(`releasing ${botIds.length} bot runner(s) for retired room ${roomId}`);
    await Promise.allSettled(botIds.map((botId) => this.stopBot(botId)));
  }

  /** Every bot of `roomId` the supervisor still tracks: live runners + queued. */
  private roomBotIds(roomId: string): string[] {
    const ids = new Set<string>();
    for (const [botId, rid] of this.runnerRoom) if (rid === roomId) ids.add(botId);
    for (const botId of this.pending) {
      const row = this.db.prepare('SELECT room_id FROM bot_accounts WHERE id = ?').get(botId) as
        | { room_id: string }
        | undefined;
      if (row?.room_id === roomId) ids.add(botId);
    }
    return [...ids];
  }

  /**
   * React to a room lifecycle change: if the room is now archived or deleted,
   * release its runners. Bound as an arrow property so `subscriptions` can be
   * removed exactly. A plain settings/seat change leaves it untouched.
   */
  private readonly onRoomChanged = (roomId: string): void => {
    if (this.shuttingDown) return;
    const room = this.db.prepare('SELECT archived, deleted FROM rooms WHERE id = ?').get(roomId) as
      | { archived: number; deleted: number }
      | undefined;
    if (!room || (!room.archived && !room.deleted)) return;
    void this.releaseRoom(roomId);
  };

  /**
   * Start releasing runners when a room is archived or deleted. Safe to call
   * once per supervisor; `detachRoomEvents()` removes the listener (tests).
   */
  subscribeRoomEvents(): void {
    roomEvents.on('changed', this.onRoomChanged);
  }

  detachRoomEvents(): void {
    roomEvents.off('changed', this.onRoomChanged);
  }

  /**
   * Boot recovery:
   *   - `running` : lost its live runner with the old process. Return it to
   *     `starting` and revoke the stale grant in ONE transaction, then re-claim
   *     (which issues a fresh grant);
   *   - `starting`: claim it as-is;
   *   - `stopping`: a graceful stop was interrupted before finalizing. Complete
   *     it, so the process never leaves a live grant with no runner behind.
   *
   * A bot whose room is already archived/deleted is NEVER re-claimed: it is
   * forced straight to `stopped` + revoke, so a retired table cannot come back to
   * life as a ghost runner occupying a slot.
   */
  recover(): void {
    // A hard delete requested before the process died is finished first, in
    // whatever state the interrupted wind-down left the row: the host asked for
    // the bot to be gone, so recovery must not quietly turn it back into a live
    // `stopped` bot.
    const pendingDeletes = this.db
      .prepare('SELECT id FROM bot_accounts WHERE delete_requested_at IS NOT NULL')
      .all() as { id: string }[];
    for (const { id } of pendingDeletes) {
      if (!finalizeBotRemoved(this.db, id))
        this.log(`recover: delete-requested bot ${id} did not delete`);
    }
    const rows = this.db
      .prepare(
        `SELECT b.id AS id, b.status AS status, b.room_id AS room_id,
                r.archived AS archived, r.deleted AS deleted
           FROM bot_accounts b
           JOIN rooms r ON r.id = b.room_id
          WHERE b.status IN ('running','starting','stopping')
          ORDER BY b.created_at, b.id`,
      )
      .all() as {
      id: string;
      status: string;
      room_id: string;
      archived: number;
      deleted: number;
    }[];
    for (const row of rows) {
      if (row.status === 'stopping') {
        if (!completeBotStop(this.db, row.id))
          this.log(`recover: bot ${row.id} was stopping but did not reach stopped`);
        continue;
      }
      if (row.archived || row.deleted) {
        // No live game to join: never issue a grant or a runner for it.
        if (!forceStopBot(this.db, row.id))
          this.log(`recover: retired-room bot ${row.id} did not reach stopped`);
        continue;
      }
      if (row.status === 'running') {
        const now = Date.now();
        const dropped = this.db.transaction(() => {
          const changed = this.db
            .prepare("UPDATE bot_accounts SET status = 'starting', updated_at = ? WHERE id = ? AND status = 'running'")
            .run(now, row.id).changes;
          revokeBotGrants(this.db, row.id);
          return changed;
        })();
        if (dropped !== 1)
          this.log(`recover: bot ${row.id} changed state before it could be re-claimed`);
      }
      this.startBot(row.id, row.room_id);
    }
  }

  /**
   * Shutdown: stop every runner, then persist `stopped` (+ revoke) for every bot
   * in `runners` and `pending`, so a clean shutdown leaves no `running`/
   * `starting` bot with a live grant behind. Idempotent: concurrent callers all
   * await the same run, and the shutdown gate is set before any snapshot.
   */
  async stopAll(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    const entries = [...this.runners.entries()];
    const queued = [...this.pending];
    this.runners.clear();
    this.runnerRoom.clear();
    this.pending.length = 0;
    this.log(`shutdown: stopping ${entries.length} runner(s), ${queued.length} queued`);
    this.shutdownPromise = (async () => {
      await Promise.allSettled(entries.map(([, runner]) => runner.stop()));
      for (const botId of [...entries.map(([id]) => id), ...queued]) {
        if (this.deleteRequested(botId)) {
          // Honour an in-flight hard delete across shutdown instead of parking it
          // `stopped` and losing the deletion.
          if (!finalizeBotRemoved(this.db, botId))
            this.log(`stopAll: delete-requested bot ${botId} did not delete`);
          continue;
        }
        const began = beginBotStop(this.db, botId);
        if (!completeBotStop(this.db, botId))
          this.log(`stopAll: bot ${botId} did not reach stopped (began=${began})`);
      }
    })();
    return this.shutdownPromise;
  }

  /**
   * Synchronous fail-safe for a hard exit (SIGTERM timeout): force every runtime
   * bot - those with a live runner, those queued, and any row still
   * `running`/`starting`/`stopping` - to `stopped` + revoke its grant, without
   * needing the runner to wind down. Guarantees no exit path persists a bot with
   * a live grant but no runner. Returns how many rows it moved.
   */
  finalizeAllRuntimeBots(): number {
    const ids = new Set<string>([...this.runners.keys(), ...this.pending]);
    const rows = this.db
      .prepare(
        "SELECT id FROM bot_accounts WHERE status IN ('running','starting','stopping') OR delete_requested_at IS NOT NULL",
      )
      .all() as { id: string }[];
    for (const row of rows) ids.add(row.id);
    let finalized = 0;
    for (const botId of ids) {
      // A pending hard delete must complete, not be parked `stopped`.
      if (this.deleteRequested(botId)) {
        if (finalizeBotRemoved(this.db, botId)) finalized++;
        continue;
      }
      if (forceStopBot(this.db, botId)) finalized++;
    }
    if (finalized > 0) this.log(`fail-safe: finalized ${finalized} bot(s) to stopped`);
    return finalized;
  }
}
