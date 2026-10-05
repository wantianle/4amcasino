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
import { BotRunner, type BotRunnerOptions } from './botRunner.js';

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
 * Capacity contract: the public HTTP `POST .../start` refuses over-budget starts
 * with 409 (`canStart()` gate in the route), while boot `recover()` and internal
 * supervision feed excess `starting` bots through a FIFO `pending` queue that
 * drains as slots free. That asymmetry is deliberate: a host gets an immediate
 * error, recovery never strands a `starting` bot forever.
 *
 * Lifetime / slot accounting:
 *   - a runner is held in `runners` from launch until `runner.done` resolves
 *     (fatal, graceful stop, socket failure, natural exit) - exactly one release
 *     per runner, identity-checked so a restart cannot lose a newer runner;
 *   - a start beyond the budget is queued (FIFO) rather than stranded in
 *     `starting`; `drainPending` retries the queue whenever a slot frees.
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
  /** Max simultaneously running bots. Default 8. */
  maxConcurrent?: number;
  /** Extra options forwarded to every `BotRunner`. */
  runner?: Omit<BotRunnerOptions, 'baseUrl'>;
  /** Injection seam for tests; production constructs a real `BotRunner`. */
  runnerFactory?: (db: DB, claim: ClaimedBot, opts: BotRunnerOptions) => RunnerHandle;
  log?: (line: string) => void;
}

export class BotSupervisor implements BotSupervisorHooks {
  private readonly runners = new Map<string, RunnerHandle>();
  /** Bots waiting for a runner slot (recovery overflow); FIFO, deduped. */
  private readonly pending: string[] = [];
  private readonly maxConcurrent: number;
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
    const budget = opts.maxConcurrent ?? 8;
    this.maxConcurrent = Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : 8;
    this.log = opts.log ?? ((line) => console.log(`[bot-supervisor] ${line}`));
  }

  runningCount(): number {
    return this.runners.size;
  }

  pendingCount(): number {
    return this.pending.length;
  }

  canStart(): boolean {
    return !this.shuttingDown && this.runners.size < this.maxConcurrent;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  hasRunner(botId: string): boolean {
    return this.runners.has(botId);
  }

  /** Claim a `starting` bot and launch a runner (queued when at capacity). */
  startBot(botId: string): void {
    if (this.shuttingDown) {
      this.log(`refused start for ${botId}: shutting down`);
      return;
    }
    if (this.runners.has(botId) || this.pending.includes(botId)) return;
    if (this.runners.size >= this.maxConcurrent) {
      // Explicit overflow policy: queue instead of leaving a `starting` bot with
      // no runner forever. `drainPending` starts it as soon as a slot frees.
      this.pending.push(botId);
      this.log(`queued ${botId} (${this.runners.size}/${this.maxConcurrent} runners active)`);
      return;
    }
    this.launch(botId);
  }

  private launch(botId: string): void {
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
    this.drainPending();
  }

  private drainPending(): void {
    // Never start a queued bot while shutting down: it would escape finalize.
    if (this.shuttingDown) return;
    while (this.pending.length > 0 && this.runners.size < this.maxConcurrent) {
      const next = this.pending.shift()!;
      // Drop entries that were stopped/removed while queued.
      const bot = this.db.prepare('SELECT status FROM bot_accounts WHERE id = ?').get(next) as
        | { status: string }
        | undefined;
      if (!bot || bot.status !== 'starting') continue;
      this.launch(next);
    }
  }

  private forgetPending(botId: string): void {
    const i = this.pending.indexOf(botId);
    if (i >= 0) this.pending.splice(i, 1);
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
      if (runner) await runner.stop();
    } catch (err) {
      this.log(`runner stop failed for ${botId}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.release(botId, runner);
      // The route already parked a graceful stop in `stopping`; beginBotStop is
      // then a no-op. What must never be silent is a bot that fails to reach
      // `stopped`, so record that.
      const began = beginBotStop(this.db, botId);
      if (!completeBotStop(this.db, botId))
        this.log(`stopBot: bot ${botId} did not reach stopped (began=${began})`);
    }
  }

  /** Graceful removal: wind the runner down, then finalize `removed` (always). */
  async removeBot(botId: string): Promise<void> {
    this.forgetPending(botId);
    const runner = this.runners.get(botId);
    try {
      if (runner) await runner.stop();
    } catch (err) {
      this.log(`runner stop failed for ${botId}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.release(botId, runner);
      if (!finalizeBotRemoved(this.db, botId))
        this.log(`removeBot: bot ${botId} did not reach removed`);
    }
  }

  /**
   * Boot recovery:
   *   - `running` : lost its live runner with the old process. Return it to
   *     `starting` and revoke the stale grant in ONE transaction, then re-claim
   *     (which issues a fresh grant);
   *   - `starting`: claim it as-is;
   *   - `stopping`: a graceful stop was interrupted before finalizing. Complete
   *     it, so the process never leaves a live grant with no runner behind.
   */
  recover(): void {
    const rows = this.db
      .prepare(
        "SELECT id, status FROM bot_accounts WHERE status IN ('running','starting','stopping') ORDER BY created_at, id",
      )
      .all() as { id: string; status: string }[];
    for (const row of rows) {
      if (row.status === 'stopping') {
        if (!completeBotStop(this.db, row.id))
          this.log(`recover: bot ${row.id} was stopping but did not reach stopped`);
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
      this.startBot(row.id);
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
    this.pending.length = 0;
    this.log(`shutdown: stopping ${entries.length} runner(s), ${queued.length} queued`);
    this.shutdownPromise = (async () => {
      await Promise.allSettled(entries.map(([, runner]) => runner.stop()));
      for (const botId of [...entries.map(([id]) => id), ...queued]) {
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
        "SELECT id FROM bot_accounts WHERE status IN ('running','starting','stopping')",
      )
      .all() as { id: string }[];
    for (const row of rows) ids.add(row.id);
    let finalized = 0;
    for (const botId of ids) {
      if (forceStopBot(this.db, botId)) finalized++;
    }
    if (finalized > 0) this.log(`fail-safe: finalized ${finalized} bot(s) to stopped`);
    return finalized;
  }
}
