import {
  HeadlessClient,
  SessionTracker,
  buildDecisionView,
  type Policy,
} from '@4am/agent-core';
import type { Street } from '@4am/shared';
import type { DB } from './db.js';
import { activeHands } from './liveHands.js';
import { markBotError, type ClaimedBot } from './botRoutes.js';
import { resolveBotPolicyDetailed, type BotLlmOptions } from './botPolicy.js';

/**
 * Phase 1b: a single bot runner.
 *
 * A runner drives exactly one already-claimed bot. The supervisor hands it the
 * `ClaimedBot` from `claimStartingBot()` (validated seed + fresh one-time
 * runner grant); the runner uses the ordinary `@4am/agent-core` HeadlessClient
 * over the loopback WS, so a bot speaks the same protocol, performs the same
 * mental-poker crypto and carries the same signature/ledger identity as a
 * human. It only ever *decides* from a `DecisionView`, which is built from
 * public frames plus the bot's own hole cards - it cannot see anyone else's.
 *
 * Lifetime (this is what makes start/stop races safe):
 *   - `start()` resolves once startup has settled (connected or cancelled); it
 *     never rejects - a startup failure is reported via `markBotError` and
 *     surfaces through `done`.
 *   - `done` resolves exactly once, after the socket is closed and no further
 *     work exists. The supervisor holds the runner until `done`, then frees its
 *     concurrency slot.
 *   - `stop()` sets the cancellation flag and awaits `done`. If a stop lands
 *     during an await of `start()`, every subsequent checkpoint observes it, the
 *     remaining startup messages are skipped, and the socket is closed by the
 *     single `finish()` path.
 *
 * Invariants kept here:
 *  - single-flight: at most one in-flight decision per `handId+actionSeq`, and
 *    the action is re-checked against the live turn (legalActions !== null)
 *    immediately before it is sent, so a slow policy can never double-send or
 *    act into a state that moved on;
 *  - a policy exception or an illegal action errors the bot
 *    (`markBotError`) and stops this runner instead of wedging the table;
 *  - graceful stop folds on the bot's turn and waits for the current hand to
 *    end before sitting out and disconnecting - it never hard-drops the socket
 *    during the crypto phases.
 */

/**
 * What the runner did with one decision, for attribution. It deliberately
 * carries only the routing (`source`) and the turn key, never the action body -
 * just enough to correlate a sent/dropped decision with the server transcript.
 */
export type RunnerActionEvent =
  | {
      kind: 'sent';
      handId: string;
      actionSeq: number;
      seat: number | null;
      source?: 'model' | 'fallback';
    }
  | {
      kind: 'discarded';
      handId: string;
      actionSeq: number;
      seat: number | null;
      source?: 'model' | 'fallback';
      reason: 'deadline' | 'stale' | 'reconnect';
    };

export interface BotRunnerOptions {
  /** Loopback base URL the server listens on, e.g. `http://127.0.0.1:8787`. */
  baseUrl: string;
  /** Injection seam for tests; production uses the real `HeadlessClient`. */
  clientFactory?: (baseUrl: string, username: string, password: string) => HeadlessClient;
  /** Injection seam for tests; production resolves the persisted bot style. */
  policy?: Policy;
  /**
   * Optional sink for per-decision routing: every action actually sent and every
   * decision dropped because the clock ran out or the turn moved on. Used by the
   * playtest harness to attribute server-accepted actions to model vs fallback.
   */
  onActionEvent?: (event: RunnerActionEvent) => void;
  /**
   * Phase 3 LLM configuration (server env). Required only when the persisted
   * `policyKind` is `llm`; ignored otherwise.
   */
  llm?: BotLlmOptions;
  /**
   * Soft threshold (ms) after which graceful stop logs that a hand is still
   * active. It is NOT a hard cutoff: the runner keeps the socket open while the
   * server reports an active hand.
   */
  graceMs?: number;
  /** Confirmation window (ms) for the "no active hand" case before disconnecting. */
  settleMs?: number;
  /** Decision-loop poll interval. */
  pollMs?: number;
  /**
   * Inject bounded cross-hand session memory into each decision view. Defaults
   * to true; set `false` (harness `LLM_MEMORY=off`) for an on/off comparison.
   * When off, the tracker records nothing and every view gets empty memory.
   */
  memory?: boolean;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Don't send an action when the server's action clock is this close: a late
 * action is rejected server-side while the client has already marked it acted,
 * which can wedge the turn. Yield to the server's timeout auto-action instead.
 * Checked both before and after the policy call (a slow policy can outlast it).
 */
const DEADLINE_GUARD_MS = 200;

export class BotRunner {
  readonly botId: string;
  /** Resolves once the runner has fully exited (socket closed, no more work). */
  readonly done: Promise<void>;

  private readonly client: HeadlessClient;
  private readonly policy: Policy;
  private readonly graceMs: number;
  private readonly settleMs: number;
  private readonly pollMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  private readonly onActionEvent: (event: RunnerActionEvent) => void;

  private task: Promise<void> | null = null;
  private readonly ready: Promise<void>;
  private readyResolve!: () => void;
  private doneResolve!: () => void;

  private stopping = false;
  private fatal = false;
  private started = false;
  private closed = false;
  /** `handId:actionSeq` of the last action actually sent. */
  private decidedKey: string | null = null;
  private lastRecordedHand: string | null = null;
  /** Bounded, public-only cross-hand memory. Held here, read-only for policies. */
  private readonly tracker = new SessionTracker();
  /** Whether session memory is injected (harness `LLM_MEMORY=off` disables it). */
  private readonly memoryEnabled: boolean;

  constructor(
    private readonly db: DB,
    private readonly claim: ClaimedBot,
    opts: BotRunnerOptions,
  ) {
    this.botId = claim.bot.id;
    this.log = opts.log ?? (() => {});
    this.client = (opts.clientFactory ?? ((baseUrl, username, password) => new HeadlessClient(baseUrl, username, password)))(
      opts.baseUrl,
      'bot',
      '',
    );
    if (opts.policy) {
      this.policy = opts.policy;
    } else {
      // Resolve the persisted kind + difficulty through the server resolver: the
      // four styles (aliases/overrides validated), the Phase 3 `llm` kind and the
      // difficulty tier (low = legacy, medium = rules-v1, high = reserved ->
      // medium). Invalid config degrades to the default style with a warning.
      const resolved = resolveBotPolicyDetailed(
        claim.policyKind,
        claim.policyJson,
        opts.llm,
        undefined,
        claim.difficulty,
      );
      this.policy = resolved.policy;
      // Log the concrete policy name (e.g. `rules-v1`) so the difficulty
      // dispatch is observable, not just the normalised kind.
      this.log(
        `policy ${resolved.policy.name} selected (kind ${resolved.kind}, difficulty ${resolved.difficulty})`,
      );
      // Explicit, machine-parseable fallback marker: `high` is reserved and
      // downgraded to `medium`, never silently.
      if (resolved.downgraded) {
        this.log(
          `difficulty ${resolved.requestedDifficulty} -> ${resolved.difficulty} (downgraded=true)`,
        );
      }
      for (const warning of resolved.warnings) this.log(`policy warning: ${warning}`);
    }
    this.memoryEnabled = opts.memory !== false;
    this.graceMs = opts.graceMs ?? 60_000;
    this.settleMs = opts.settleMs ?? 1_000;
    this.pollMs = opts.pollMs ?? 100;
    this.sleep = opts.sleep ?? defaultSleep;
    this.onActionEvent = opts.onActionEvent ?? (() => {});
    this.ready = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
    this.done = new Promise<void>((resolve) => {
      this.doneResolve = resolve;
    });
  }

  /**
   * Connect, seat, ready, then run the decision loop. Resolves once startup has
   * settled (or was cancelled); the loop keeps running in the background until
   * `stop()` or a failure, at which point `done` resolves.
   */
  start(): Promise<void> {
    if (!this.task) {
      if (this.stopping) {
        this.finish();
        this.task = Promise.resolve();
      } else {
        this.task = this.run();
      }
    }
    return this.ready;
  }

  private async run(): Promise<void> {
    try {
      const seedHex = Buffer.from(this.claim.seed).toString('hex');
      await this.client.loginWithGrant(this.claim.grantToken, seedHex);
      // Cancellation checkpoints. A stop can land during any await above; the
      // remaining startup must not send another protocol message. Crucially it
      // must still run the graceful wind-down: the socket may already be in a
      // live hand (the bot joins during login), and closing here would abort it.
      if (this.stopping) {
        await this.gracefulWindDown();
        return;
      }
      await this.ensureSeated();
      if (this.stopping) {
        await this.gracefulWindDown();
        return;
      }
      this.client.send({ t: 'im_ready' });
      this.started = true;
      this.log(`bot ${this.botId} connected (seat ${this.claim.bot.seat ?? '?'})`);
      this.readyResolve();
      await this.loop();
    } catch (err) {
      this.fail(err);
    } finally {
      // The single exit path: startup cancelled, startup failed, fatal, natural
      // end and graceful stop all close the socket here exactly once.
      this.finish();
    }
  }

  /** Idempotent teardown: close the socket exactly once and resolve `done`. */
  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyResolve();
    try {
      this.client.close();
    } catch {
      // already closed
    }
    this.doneResolve();
  }

  private async ensureSeated(): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!this.client.room && Date.now() < deadline) {
      if (this.stopping) return;
      await this.sleep(25);
    }
    if (this.stopping) return;
    // Phase 1a already created the bot's room_players row with its configured
    // seat, so `sit` is only a fallback when that row is somehow seatless.
    if (this.client.mySeat() === null && this.claim.bot.seat !== null) {
      this.client.send({ t: 'sit', seat: this.claim.bot.seat });
      await this.sleep(50);
    }
    if (this.stopping) return;
    // A previous graceful stop sat the bot out; clear that so a restart is dealt
    // back in. Idempotent when the seat is already active.
    this.client.send({ t: 'sit_out', sittingOut: false });
    await this.sleep(50);
  }

  private async loop(): Promise<void> {
    while (true) {
      if (this.stopping) return void (await this.gracefulWindDown());
      if (this.fatal) return;
      if (this.client.result || this.client.abort) {
        this.recordHandEnd();
        await this.sleep(this.pollMs);
        continue;
      }
      await this.client.waitForTurn(this.pollMs);
      if (this.stopping) return void (await this.gracefulWindDown());
      if (this.fatal) return;
      if (!this.client.myTurn()) {
        // Always yield a macrotask so a client whose wait resolves immediately
        // cannot spin the event loop and starve timers.
        await this.sleep(0);
        continue;
      }
      await this.decideOnce();
      await this.sleep(0);
    }
  }

  /**
   * One decision. Private and awaited by the single loop, so at most one runs at
   * a time; the sent-key guards against re-deciding the same turn, and the turn
   * is re-read after the (possibly async) policy call so we never send into a
   * stale snapshot.
   */
  private async decideOnce(): Promise<void> {
    const key = this.turnKey();
    if (key === this.decidedKey) return;
    // The turn this decision belongs to, captured before the (possibly async)
    // policy call so a dropped result can still be attributed to its turn.
    const handId = this.client.handId ?? '';
    const actionSeq = this.client.actionSeq;
    const seat = this.client.mySeat();
    try {
      if (this.stopping) {
        this.foldIfMyTurn();
        return;
      }
      // Never decide from a down socket or before this connection epoch's
      // `room_state` has been applied: `connected` only means the socket is
      // open, and the cached hand/turn may still be the pre-reconnect one. Wait
      // for the resync snapshot.
      if (!this.client.connected || !this.client.isResynced) {
        await this.sleep(25);
        return;
      }
      const view = buildDecisionView(this.client, this.currentMemory());
      if (!view.legalActions) return;
      // Don't race the action clock (see DEADLINE_GUARD_MS). Sleep briefly so a
      // near-deadline skip cannot spin the event loop while the server's own
      // timeout auto-action fires.
      if (this.deadlineTooClose(this.client.deadline)) {
        await this.sleep(25);
        return;
      }
      const epoch = this.client.connectionEpoch;
      const decision = await this.policy.decide(view);
      // A stop may have been requested while the policy was thinking: fold
      // instead of continuing to play the hand out.
      if (this.stopping) {
        this.foldIfMyTurn();
        return;
      }
      // A reconnect (or a drop) during the policy await voids the result: the
      // resynced state may repeat the same hand/actionSeq, so only the epoch
      // proves the result belongs to the live connection.
      if (!this.client.connected || this.client.connectionEpoch !== epoch) {
        this.emitAction({ kind: 'discarded', handId, actionSeq, seat, source: decision.source, reason: 'reconnect' });
        return;
      }
      // The hand may have ended/become a new hand while the policy was
      // thinking. Classify that as stale first: reading `client.deadline` now
      // could belong to the NEXT hand and be misreported as a deadline drop.
      if (this.client.handId !== handId) {
        this.emitAction({ kind: 'discarded', handId, actionSeq, seat, source: decision.source, reason: 'stale' });
        return;
      }
      // Re-read the clock AFTER the policy: a slow decision (Monte Carlo) can
      // consume the remaining time, and sending now would be rejected as late.
      // Read the client clock directly - no need to rebuild a whole DecisionView.
      if (this.deadlineTooClose(this.client.deadline)) {
        this.emitAction({ kind: 'discarded', handId, actionSeq, seat, source: decision.source, reason: 'deadline' });
        await this.sleep(25);
        return;
      }
      if (!this.client.myTurn() || this.turnKey() !== key) {
        // The turn advanced (or the table moved on) while the policy was
        // thinking: the result is stale and must not be sent.
        this.emitAction({ kind: 'discarded', handId, actionSeq, seat, source: decision.source, reason: 'stale' });
        return;
      }
      this.client.act(decision.action);
      this.emitAction({ kind: 'sent', handId, actionSeq, seat, source: decision.source });
      this.decidedKey = key;
      this.log(
        `bot ${this.botId} ${decision.action.type}${decision.action.amount ? ` ${decision.action.amount}` : ''} (${decision.reason})`,
      );
    } catch (err) {
      this.fail(err);
    }
  }

  private turnKey(): string {
    return `${this.client.handId ?? '?'}:${this.client.actionSeq}`;
  }

  /** True when the action clock has no useful time left to send an action. */
  private deadlineTooClose(deadline: number | null): boolean {
    return deadline !== null && deadline !== undefined && deadline - Date.now() < DEADLINE_GUARD_MS;
  }

  /** Report one decision's routing without ever letting a sink break the loop. */
  private emitAction(event: RunnerActionEvent): void {
    try {
      this.onActionEvent(event);
    } catch {
      // An observability sink must never wedge a bot.
    }
  }

  /** Fold if it is currently our turn; a no-op or race error is swallowed. */
  private foldIfMyTurn(): void {
    // The graceful fold must obey the same resync gate as a normal decision:
    // never send from a stale/unsynced connection.
    if (!this.client.connected || !this.client.isResynced) return;
    if (!this.client.myTurn()) return;
    try {
      this.client.act({ type: 'fold' });
    } catch {
      // the hand advanced between the check and the send - nothing to do
    }
  }

  /**
   * Fatal (policy exception / illegal action) handling. This is a deliberate
   * FAIL-CLOSED contract: the bot is marked `error`, which revokes its runner
   * grant immediately (Phase 1a semantics), and the runner then closes its
   * socket without a graceful wind-down. A misbehaving bot must not keep playing
   * or hold the table hostage, so we accept that a fatal mid-hand can abort that
   * hand (the engine's crypto/action timeouts resolve it cleanly). This path is
   * therefore distinct from graceful stop, which does wait for the hand.
   */
  private fail(err: unknown): void {
    if (this.fatal) return;
    this.fatal = true;
    this.log(`bot ${this.botId} failed: ${err instanceof Error ? err.message : String(err)}`);
    try {
      markBotError(this.db, this.botId);
    } catch {
      // best effort: the runner is stopping either way
    }
  }

  /** Bounded, seat-mapped session memory for the policy (read-only). */
  private currentMemory(): ReturnType<SessionTracker['snapshot']> {
    if (!this.memoryEnabled)
      return { handsObserved: 0, netChips: null, recentHands: [], opponents: [] };
    const seats = (this.client.room?.players ?? [])
      .filter((p) => p.seat !== null)
      .map((p) => ({ seat: p.seat as number, userId: p.userId }));
    return this.tracker.snapshot(this.claim.userId, seats);
  }

  private recordHandEnd(): void {
    if (!this.memoryEnabled) return;
    const handId = this.client.handId;
    if (!handId || handId === this.lastRecordedHand) return;
    this.lastRecordedHand = handId;
    const result = this.client.result;
    // An aborted hand moves no chips and has no settled public history; it is
    // not a memory sample for either `recentHands` or the opponent counts.
    if (!result) return;
    const mySeat = this.client.mySeat();
    const myDelta = result.deltas.find((d) => d.seat === mySeat)?.delta ?? null;
    // The furthest street the hand reached, from the public board only.
    const board = this.client.board.length;
    const endedStreet: Street =
      board >= 5 ? 'river' : board === 4 ? 'turn' : board === 3 ? 'flop' : 'preflop';
    this.tracker.observeHand({
      // A gap during the hand makes the observed action list partial, so the
      // tracker excludes it from the VPIP/PFR denominator.
      historyComplete: this.client.historyComplete,
      mySeat,
      myDelta,
      endedStreet,
      showdown: this.client.showdown !== null,
      participants: this.client.seats.map((s) => ({ seat: s.seat, userId: s.userId })),
      actions: this.client.actionHistory.map((a) => ({
        seat: a.seat,
        street: a.street,
        type: a.action.type,
        auto: a.auto,
      })),
    });
  }

  /** Whether the game server still has a hand running in this bot's room. */
  private serverHandActive(): boolean {
    return activeHands.has(this.claim.roomId);
  }

  /**
   * Graceful wind-down, run from inside the loop so the single `finish()` path
   * still owns the socket. Fold on our turn while the hand runs, wait for it to
   * end, then sit out. The supervisor finalizes the persisted `stopped` state and
   * revokes the grant after `done` resolves.
   *
   * The authoritative "is a hand still running?" signal is the engine's own
   * `activeHands` set, which it writes *before* broadcasting `hand_start` and
   * clears when the hand settles. The runner lives in the same process as the
   * engine and talks to it over loopback, so this is exact - unlike
   * `room_state.handActive`, which the engine only broadcasts on other events
   * and is therefore still `false` during the crypto deal (the exact window that
   * used to cause `player left during the deal`). We never sit out or close
   * while the server reports an active hand; `settleMs` only confirms the
   * "no active hand" case, in case a `start_hand` is in flight.
   */
  private async gracefulWindDown(): Promise<void> {
    const startedAt = Date.now();
    let sawHand = this.client.handLive();
    let warned = false;
    let noHandSince: number | null = null;
    this.log(
      `graceful stop requested (localHand=${sawHand} serverHandActive=${this.serverHandActive()} handId=${this.client.handId} result=${!!this.client.result} abort=${!!this.client.abort})`,
    );
    while (true) {
      if (!this.fatal && this.client.myTurn()) this.foldIfMyTurn();
      if (this.client.handLive()) sawHand = true;
      const serverActive = this.serverHandActive();
      const localLive = this.client.handLive();
      // Priority matters. The server's `activeHands` is authoritative and is
      // written BEFORE `hand_start` is broadcast: during the gap between a
      // previous hand settling and the next one's `hand_start` reaching us, the
      // client still holds the OLD `result`/`abort`. If we let that stale
      // terminal frame short-circuit the wait we would sit out and close during
      // the next hand's crypto - the exact `player left during the deal` abort.
      // So: server-active wins outright; only once the server reports no active
      // hand may a local terminal frame justify leaving.
      if (serverActive || localLive) {
        noHandSince = null;
        // Soft threshold: the hand may legitimately run long (slow players,
        // action timeouts). Log the reason but keep participating.
        if (!warned && Date.now() - startedAt > this.graceMs) {
          warned = true;
          this.log(
            `graceful stop: hand still active after ${this.graceMs}ms (serverHandActive=${serverActive} localHand=${localLive}); keeping the socket open until it finishes`,
          );
        }
      } else if (this.client.result || this.client.abort) {
        this.log(
          `graceful stop: hand finished (sawHand=${sawHand} result=${!!this.client.result} abort=${!!this.client.abort})`,
        );
        break;
      } else {
        if (noHandSince === null) noHandSince = Date.now();
        else if (Date.now() - noHandSince >= this.settleMs) {
          this.log(
            `graceful stop: no active hand (confirmed over ${this.settleMs}ms), disconnecting`,
          );
          break;
        }
      }
      await this.sleep(this.pollMs);
    }
    if (this.started) {
      try {
        this.client.send({ t: 'sit_out', sittingOut: true });
      } catch {
        // already disconnected
      }
    }
  }

  /**
   * Graceful shutdown. Sets cancellation and waits for the runner to fully
   * exit (`done`): during startup this waits for the in-flight await to observe
   * the flag, so `stop()` never returns while the socket is still connecting.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    if (!this.task) {
      this.finish();
      return;
    }
    await this.done;
  }
}
