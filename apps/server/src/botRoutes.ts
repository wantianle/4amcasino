import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { identityFromSeed } from '@4am/mental-poker';
import {
  BOT_DIFFICULTIES,
  BOT_STATUSES,
  DEFAULT_BOT_DIFFICULTY,
  type BotDifficulty,
  type BotStatus,
} from '@4am/shared';
import { z } from 'zod';
import type { DB } from './db.js';
import { createUser, requireUser } from './auth.js';
import { canBank, getRoom, isMember, roomEvents, type RoomRow } from './rooms.js';
import { LIMITS } from './limits.js';
import { BuyServiceError, approveRoomBuy, requestRoomBuy } from './buyService.js';
import { decryptBotSeed, encryptBotSeed, identityKeyConfigured } from './botIdentity.js';
import { pickFunBotName } from './botNames.js';
import { resolveAgentGrant } from './botAccess.js';

/**
 * Bot lifecycle (Phase 1a: state + claim handoff).
 *
 * A bot is an ordinary, independent user account plus a `bot_accounts` row. All
 * money moves through the shared buy service, so there is no bot-only shortcut
 * around banker approval or the ledger.
 *
 * Phase 1a owns the persisted state machine and the identity checks; the process
 * that actually drives a seat (connect, deal, decide) is Phase 1b. The only
 * handoff is `claimStartingBot()`: a supervisor claims a bot in `starting`,
 * receives a fresh one-time runner grant and the decrypted seed, then reports
 * progress via `markBotError` / `markBotStopped`. A runner never advances a bot
 * to `running` on its own - the conditional claim does it - so `running` always
 * implies a valid, just-issued grant.
 */

/**
 * Bot lifecycle states live in @4am/shared so the web UI can type its display
 * copy against the same list. Re-exported here because this module owns the
 * state machine and is the import site the server/tests use.
 */
export { BOT_STATUSES };
export type { BotStatus };

/**
 * Allowed transitions:
 *   created              -> waiting_buy_approval | ready
 *   waiting_buy_approval -> ready        (buy approved)
 *   ready                -> starting
 *   starting             -> running | error
 *   running              -> stopping
 *   stopping             -> stopped
 *   stopped              -> starting     (restart)
 *   error                -> starting     (explicit retry, after identity check)
 *   any                  -> deleted      (permanent: rows are removed, not flagged)
 */
const STARTABLE: readonly BotStatus[] = ['ready', 'stopped', 'error'];
const STOPPABLE: readonly BotStatus[] = ['ready', 'starting', 'running'];

export interface BotRow {
  id: string;
  room_id: string;
  owner_id: number;
  user_id: number;
  status: BotStatus;
  policy_kind: string;
  policy_json: string | null;
  /** Effective difficulty tier (`low` | `medium`) after rollback; orthogonal
   *  to `policy_kind`. Legacy hubs may still hold the withdrawn `high`, which
   *  is read as `medium` by the resolver. */
  difficulty: string;
  seat: number | null;
  identity_ct: string | null;
  identity_nonce: string | null;
  identity_tag: string | null;
  created_at: number;
  updated_at: number;
  stopped_at: number | null;
  stop_requested_at: number | null;
  /** Set once a hard delete has been requested; see `finalizeBotRemoved`. */
  delete_requested_at: number | null;
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * The bot runner authenticates with its one-time runner grant rather than a
 * session cookie, so identity resolution must read the credential exactly as
 * the runner's HTTP client sends it: `Authorization: Bearer <token>`.
 */
const bearerToken = (req: FastifyRequest) =>
  (req.headers.authorization ?? '').replace(/^Bearer /, '');

/**
 * Difficulty tiers accepted by the API. Only `low` and `medium` are writable;
 * `high` is a withdrawn reserved GTO tier, so a create/update with it is a 400
 * ("legacy persisted `high` rows are still readable and are migrated to
 * `medium` on boot, but no new `high` may be written"). The tier list and
 * default come from @4am/shared so they cannot drift from the runner resolver;
 * the strict-write choice is deliberate and unchanged.
 */
export { BOT_DIFFICULTIES };
export type { BotDifficulty };

const createBotSchema = z.object({
  name: z.string().trim().min(1).max(24).optional(),
  policyKind: z.string().trim().min(1).max(40).default('scripted'),
  policyJson: z.string().max(20_000).optional(),
  // Defaults to `medium` (the rules-v1 engine) so a create with no difficulty
  // runs the strong new bot by default; `low` is an explicit opt-out.
  difficulty: z.enum(BOT_DIFFICULTIES).default(DEFAULT_BOT_DIFFICULTY),
  seat: z.number().int().min(0).max(8),
  // Optional because a bot can also be funded later via POST .../buy; a bot with
  // no chips still has a purchase path, so it is never stranded at stack 0.
  initialBuyIn: z.number().int().positive().max(LIMITS.maxChipAmount).optional(),
});

export function getBot(db: DB, roomId: string, botId: string): BotRow | undefined {
  return db
    .prepare('SELECT * FROM bot_accounts WHERE id = ? AND room_id = ?')
    .get(botId, roomId) as BotRow | undefined;
}

function getBotById(db: DB, botId: string): BotRow | undefined {
  return db.prepare('SELECT * FROM bot_accounts WHERE id = ?').get(botId) as BotRow | undefined;
}

export function listBots(db: DB, roomId: string): BotRow[] {
  // Hard-deleted bots leave no row, but a pre-existing `removed` row (from the
  // old soft-delete era) and a bot whose hard delete is still winding down must
  // not be listed: the host already asked for them to go.
  return db
    .prepare(
      "SELECT * FROM bot_accounts WHERE room_id = ? AND status != 'removed' AND delete_requested_at IS NULL ORDER BY created_at, id",
    )
    .all(roomId) as BotRow[];
}

/**
 * Mint a fresh internal play grant for a bot. The plaintext token is returned
 * once and only its hash is stored, exactly like a user-facing agent grant; any
 * earlier active bot-runner grant for the same bot is revoked so old tokens stop
 * working when a runner is restarted.
 *
 * Private on purpose: a grant may only be issued as one step of the atomic
 * `claimStartingBot` transaction, never handed out on its own (otherwise a bot
 * could be marked `running` without the identity proof the claim performs).
 */
function issueBotRunnerGrant(
  db: DB,
  opts: { botId: string; userId: number; roomId: string },
): { id: string; token: string } {
  const now = Date.now();
  db.prepare(
    "UPDATE agent_grants SET revoked_at = ? WHERE bot_id = ? AND grant_kind = 'bot_runner' AND revoked_at IS NULL",
  ).run(now, opts.botId);
  const id = randomBytes(12).toString('hex');
  const token = `4am_agent_${randomBytes(32).toString('hex')}`;
  const expiresAt = now + 30 * 86400_000;
  db.prepare(
    "INSERT INTO agent_grants(id,user_id,token_hash,label,scope_kind,scope_id,can_play,created_at,expires_at,grant_kind,bot_id) VALUES(?,?,?,?,?,?,?,?,?,'bot_runner',?)",
  ).run(
    id,
    opts.userId,
    tokenHash(token),
    `bot ${opts.botId.slice(0, 8)}`,
    'room',
    opts.roomId,
    1,
    now,
    expiresAt,
    opts.botId,
  );
  return { id, token };
}

/** Revoke every active grant belonging to a bot (claim, stop, remove, error). */
export function revokeBotGrants(db: DB, botId: string): number {
  return db
    .prepare("UPDATE agent_grants SET revoked_at = ? WHERE bot_id = ? AND revoked_at IS NULL")
    .run(Date.now(), botId).changes;
}

/**
 * Actually-seated seat. `bot_accounts.seat` is the *configured* seat; the
 * authoritative runtime seat is the bot's `room_players` row (a supervisor may
 * move a bot), so GET reports the room_players value when one exists.
 */
function actualSeat(db: DB, bot: BotRow): number | null {
  const rp = db
    .prepare('SELECT seat FROM room_players WHERE room_id = ? AND user_id = ?')
    .get(bot.room_id, bot.user_id) as { seat: number | null } | undefined;
  return rp ? rp.seat : bot.seat;
}

function botPublicJson(db: DB, bot: BotRow) {
  const user = db
    .prepare('SELECT username, COALESCE(display_name, username) AS displayName FROM users WHERE id = ?')
    .get(bot.user_id) as { username: string; displayName: string } | undefined;
  const player = db
    .prepare('SELECT stack FROM room_players WHERE room_id = ? AND user_id = ?')
    .get(bot.room_id, bot.user_id) as { stack: number } | undefined;
  return {
    id: bot.id,
    userId: bot.user_id,
    username: user?.username ?? null,
    displayName: user?.displayName ?? null,
    seat: actualSeat(db, bot),
    configuredSeat: bot.seat,
    status: bot.status,
    policyKind: bot.policy_kind,
    difficulty: bot.difficulty,
    createdAt: bot.created_at,
    updatedAt: bot.updated_at,
    stoppedAt: bot.stopped_at,
    stopRequestedAt: bot.stop_requested_at,
    // Whether the runner can ever recover this bot's signing identity.
    identityRecoverable: !!(bot.identity_ct && bot.identity_nonce && bot.identity_tag) && identityKeyConfigured(),
    stack: player?.stack ?? 0,
  };
}

function uniqueBotUsername(db: DB): string {
  for (let i = 0; i < 10; i++) {
    const candidate = `bot_${randomBytes(5).toString('hex')}`;
    if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(candidate)) return candidate;
  }
  throw new Error('could not allocate a unique bot username');
}

/**
 * Display names already live at a table (humans and bots alike). Used to keep a
 * generated bot name from colliding with a seat-mate. Falls back to `username`
 * for rows that have no display name yet, matching how the table renders them.
 */
function roomDisplayNames(db: DB, roomId: string): string[] {
  const rows = db
    .prepare(
      `SELECT COALESCE(u.display_name, u.username) AS name
         FROM room_players rp JOIN users u ON u.id = rp.user_id
        WHERE rp.room_id = ?`,
    )
    .all(roomId) as { name: string }[];
  return rows.map((row) => row.name);
}

/** Only a logged-in human host may manage bots - never an agent token. */
async function hostRoom(
  db: DB,
  req: FastifyRequest,
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
): Promise<{ room: RoomRow; id: string } | null> {
  const { id } = req.params as { id: string };
  const room = getRoom(db, id);
  if (!room) {
    await reply.code(404).send({ error: 'no such room' });
    return null;
  }
  if (room.host_id !== req.userId) {
    await reply.code(403).send({ error: 'host only' });
    return null;
  }
  return { room, id };
}

function sendBuyError(
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  err: unknown,
): boolean {
  if (err instanceof BuyServiceError) {
    void reply.code(err.statusCode).send({ error: err.message });
    return true;
  }
  return false;
}

/**
 * A bot that is gone or on its way out: either a legacy soft-deleted `removed`
 * row, or a hard delete already requested (`status='stopping'` +
 * `delete_requested_at`). Once a delete is requested the row can be removed
 * underneath us at any moment (the supervisor finalizes as soon as the runner
 * winds down), so every money/control route must refuse such a bot rather than
 * mutate state that is about to be deleted.
 *
 * Deliberately NOT consulted by `resolveAgentGrant`: a deleting runner keeps a
 * valid grant for the duration of its wind-down so it can fold and leave its
 * seat; only an already-`removed` legacy row invalidates the grant there.
 */
function isBotGone(bot: BotRow): boolean {
  return bot.status === 'removed' || bot.delete_requested_at !== null;
}

/**
 * Send the 409 for a gone/deleting bot, naming the actual reason. Used by every
 * route that must reject such a bot, so the check and the status code cannot
 * drift apart as new routes are added.
 */
function refuseBotGone(
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  bot: BotRow,
): void {
  reply
    .code(409)
    .send({ error: bot.status === 'removed' ? 'bot has been removed' : 'bot deletion is in progress' });
}

/**
 * Fire a supervisor hook without letting a synchronous throw or an async
 * rejection escape the route. The supervisor finalizes its own persisted state
 * in a `finally`, so swallowing here is safe and avoids an unhandled rejection
 * that could take the process down.
 */
function runHook(fn: () => void | Promise<void>): void {
  void (async () => {
    try {
      await fn();
    } catch {
      // handled by the supervisor's own finally
    }
  })();
}

/**
 * Decrypt a bot's seed and prove it belongs to its account. Returns null for a
 * missing key, a wrong-but-well-formed key, a wrong seed length, or a public-key
 * mismatch - so callers can fail closed without ever starting a bot as the
 * wrong identity.
 */
export function verifyBotIdentity(db: DB, bot: BotRow): { seed: Uint8Array } | null {
  try {
    if (!bot.identity_ct || !bot.identity_nonce || !bot.identity_tag) return null;
    const seedHex = decryptBotSeed({ ct: bot.identity_ct, nonce: bot.identity_nonce, tag: bot.identity_tag });
    const seed = Uint8Array.from(Buffer.from(seedHex, 'hex'));
    if (seed.length !== 32) return null;
    const identity = identityFromSeed(seed);
    const user = db.prepare('SELECT pubkey FROM users WHERE id = ?').get(bot.user_id) as
      | { pubkey: string }
      | undefined;
    if (!user || user.pubkey !== identity.publicKey) return null;
    return { seed };
  } catch {
    return null;
  }
}

// There is deliberately no bare `recoverBotSeed`: handing out a decrypted seed
// on demand would let Phase 1b start a bot without the pubkey proof and the
// atomic claim. `verifyBotIdentity` is the only validated way to unwrap the
// seed, and `claimStartingBot` returns it together with the fresh runner grant.

export interface ClaimedBot {
  bot: BotRow;
  roomId: string;
  userId: number;
  grantToken: string;
  seed: Uint8Array;
  policyKind: string;
  policyJson: string | null;
  /** Difficulty tier persisted at create time; drives the runner's resolver. */
  difficulty: string;
}

/**
 * Phase 1b entry point. Atomically claims a bot in `starting` for one supervisor:
 * only the winner of the conditional `starting -> running` update proceeds, so a
 * bot can never be double-run. The state preemption, revocation of any earlier
 * runner grant and issuance of the fresh grant all happen in ONE transaction, so
 * a failure anywhere rolls the status back to `starting` instead of leaving a
 * `running` bot with no valid token. The plaintext token is returned in memory
 * only. Returns null when the bot is not claimable, marking it `error` (and
 * revoking its grants) when the room or its identity is unusable.
 */
export function claimStartingBot(db: DB, botId: string): ClaimedBot | null {
  const bot = getBotById(db, botId);
  if (!bot || bot.status !== 'starting') return null;

  const room = getRoom(db, bot.room_id);
  if (!room || room.archived || room.deleted) {
    markBotError(db, botId);
    return null;
  }

  const identity = verifyBotIdentity(db, bot);
  if (!identity) {
    markBotError(db, botId);
    return null;
  }

  // One transaction: claim the `starting` row, revoke the old runner grant and
  // insert the new one. The conditional UPDATE is the single-claim lock (a
  // second supervisor sees zero changed rows and backs off); if the grant write
  // throws, the whole thing rolls back and the bot stays claimable.
  const claim = db.transaction((): { id: string; token: string } | null => {
    const claimed = db
      .prepare(
        "UPDATE bot_accounts SET status = 'running', updated_at = ? WHERE id = ? AND status = 'starting'",
      )
      .run(Date.now(), botId);
    if (claimed.changes !== 1) return null;
    return issueBotRunnerGrant(db, { botId, userId: bot.user_id, roomId: bot.room_id });
  });
  const grant = claim();
  if (!grant) return null;

  const fresh = getBotById(db, botId)!;
  return {
    bot: fresh,
    roomId: bot.room_id,
    userId: bot.user_id,
    grantToken: grant.token,
    seed: identity.seed,
    policyKind: bot.policy_kind,
    policyJson: bot.policy_json,
    difficulty: fresh.difficulty,
  };
}

/**
 * Park a failed runner as `error` and revoke every active runner grant, so an
 * old token can never keep playing after the runner is gone. Only a bot the
 * runtime owns (`starting`/`running`) may be errored here: a start-time identity
 * failure on a not-yet-claimed bot goes through `markBotIdentityFailed`, so this
 * helper can never rewrite an arbitrary state.
 */
export function markBotError(db: DB, botId: string): boolean {
  const now = Date.now();
  return db.transaction(() => {
    revokeBotGrants(db, botId);
    return (
      db
        .prepare(
          "UPDATE bot_accounts SET status = 'error', updated_at = ? WHERE id = ? AND status IN ('starting','running')",
        )
        .run(now, botId).changes === 1
    );
  })();
}

/**
 * Start-time identity failure: the bot is in `ready`/`stopped`/`error` and never
 * entered `starting`, so `markBotError`'s runtime-only contract does not apply.
 * Private to this module so Phase 1b cannot use it to slip past the identity
 * proof `claimStartingBot` performs. Revokes grants for the same fail-closed
 * reason.
 */
function markBotIdentityFailed(db: DB, botId: string): boolean {
  const now = Date.now();
  return db.transaction(() => {
    revokeBotGrants(db, botId);
    return (
      db
        .prepare(
          "UPDATE bot_accounts SET status = 'error', updated_at = ? WHERE id = ? AND status IN ('ready','stopped','error')",
        )
        .run(now, botId).changes === 1
    );
  })();
}

/** Confirm a runner has finished stopping. */
export function markBotStopped(db: DB, botId: string): boolean {
  const now = Date.now();
  return (
    db
      .prepare(
        "UPDATE bot_accounts SET status = 'stopped', stopped_at = ?, updated_at = ? WHERE id = ? AND status IN ('stopping','stopped')",
      )
      .run(now, now, botId).changes === 1
  );
}

function cancelPendingBuys(db: DB, roomId: string, userId: number): number {
  return db
    .prepare("UPDATE buy_requests SET status = 'rejected' WHERE room_id = ? AND user_id = ? AND status = 'pending'")
    .run(roomId, userId).changes;
}

/**
 * CAS a bot into `stopping` WITHOUT revoking its grant - the graceful-stop
 * intent. The state is persisted immediately, but the runner keeps a valid
 * token so it can fold and let the current hand finish. The grant is revoked by
 * `completeBotStop` once the runner has actually wound down.
 *
 * Returns false when the bot is not stoppable or a concurrent writer moved it,
 * so callers can re-read rather than clobber a newer state.
 */
export function beginBotStop(db: DB, botId: string): boolean {
  const now = Date.now();
  return (
    db
      .prepare(
        "UPDATE bot_accounts SET status = 'stopping', stop_requested_at = ?, updated_at = ? WHERE id = ? AND status IN ('ready','starting','running')",
      )
      .run(now, now, botId).changes === 1
  );
}

/**
 * Finalize a graceful stop: mark the bot `stopped` and revoke the runner grant
 * in one transaction. Only a bot already parked in `stopping` may finalize
 * (callers go through `beginBotStop` first), so this can never be used to
 * silently turn a live `running` bot into `stopped` without a wind-down.
 *
 * The CAS update is checked BEFORE the revoke: on an illegal source (e.g.
 * `running`) we must not revoke the grant, or the bot would be left `running`
 * with no usable token - a worse state than either endpoint.
 */
export function completeBotStop(db: DB, botId: string): boolean {
  return db.transaction(() => {
    if (!markBotStopped(db, botId)) return false;
    revokeBotGrants(db, botId);
    return true;
  })();
}

/**
 * Hard-delete a bot. This is the real thing the DELETE route promises: the
 * `bot_accounts` row, every `agent_grants` row that belongs to it and its
 * `room_players` seat row all go, in one transaction, after the runner has
 * wound down. Pending buys are rejected first (rather than deleted), so a
 * straggler banker approval is refused while the funding history stays.
 *
 * Deliberately KEPT: the bot's `users` row and its `ledger` entries. Both are
 * needed to keep the room's money history readable - `/api/rooms/:id/ledger`
 * INNER JOINs `users`, so deleting the account would silently drop the bot's
 * entries from the ledger view even though the ledger table itself is intact.
 * `buy_requests` are financial history too, so they are cancelled, not deleted.
 *
 * The `DELETE ... WHERE id = ?` is the single-winner lock: a concurrent delete
 * sees zero changed rows and reports 404. Returns false when the bot is already
 * gone.
 */
export function finalizeBotRemoved(db: DB, botId: string): boolean {
  const bot = getBotById(db, botId);
  if (!bot) return false;
  const changed = db.transaction(() => {
    const deleted = db.prepare('DELETE FROM bot_accounts WHERE id = ?').run(botId).changes === 1;
    if (!deleted) return false;
    // Cancel (do not delete) pending buys: the funding history stays, but a
    // later approval cannot credit a bot that no longer exists.
    cancelPendingBuys(db, bot.room_id, bot.user_id);
    // Remove the runner grants outright. `user_id` is included alongside
    // `bot_id` because a corrupted/legacy grant can carry a NULL bot_id (see
    // botAccess); scoping to grant_kind='bot_runner' leaves any unrelated
    // grant on the same user untouched.
    db.prepare(
      "DELETE FROM agent_grants WHERE bot_id = ? OR (user_id = ? AND grant_kind = 'bot_runner')",
    ).run(botId, bot.user_id);
    // Drop the seat/membership row so the bot cannot linger as a player in the
    // room payload after its account is gone.
    db.prepare('DELETE FROM room_players WHERE room_id = ? AND user_id = ?').run(
      bot.room_id,
      bot.user_id,
    );
    return true;
  })();
  // Broadcast after the transaction commits so every client refreshes the table
  // immediately instead of only via the runner's socket-close side effect.
  if (changed) roomEvents.emit('changed', bot.room_id);
  return changed;
}

/**
 * Fail-safe shutdown finalize: revoke the runner grant and force any runtime
 * state (`running`/`starting`/`stopping`) to `stopped` in one transaction. Used
 * by the supervisor's hard-exit path so a process kill can never persist a bot
 * with a live grant but no runner. Idempotent for an already-`stopped` row.
 */
export function forceStopBot(db: DB, botId: string): boolean {
  const now = Date.now();
  return db.transaction(() => {
    const changed =
      db
        .prepare(
          "UPDATE bot_accounts SET status = 'stopped', stopped_at = ?, updated_at = ? WHERE id = ? AND status IN ('running','starting','stopping','stopped')",
        )
        .run(now, now, botId).changes === 1;
    revokeBotGrants(db, botId);
    return changed;
  })();
}

/**
 * Phase 1b orchestration hook. The routes own the persisted state transitions;
 * the supervisor only drives the async runner (claim, connect, graceful wind
 * down). `null` means "no supervisor attached" - tests and embedders keep the
 * Phase 1a behaviour of advancing `starting`/`stopping` without a live runner.
 */
export interface BotSupervisorHooks {
  /**
   * Whether another runner may be started in this room's pool (and within the
   * server-wide safety valve).
   */
  canStart(roomId: string): boolean;
  /** True during shutdown: starts are refused with 503, not queued. */
  isShuttingDown(): boolean;
  /** Whether a live runner currently exists for this bot. */
  hasRunner(botId: string): boolean;
  startBot(botId: string, roomId?: string): void;
  stopBot(botId: string): void | Promise<void>;
  removeBot(botId: string): void | Promise<void>;
}

/** Mutable holder so `index.ts` can attach a supervisor after `app.listen()`. */
export interface BotControl {
  hooks: BotSupervisorHooks | null;
}

export function registerBotRoutes(app: FastifyInstance, db: DB, control: BotControl): void {
  const authed = { preHandler: requireUser(db) };

  /**
   * Bot-runner identity handshake. `@4am/agent-core`'s `loginWithGrant` calls
   * this with its freshly issued runner grant to learn who it is and which room
   * it may play before it opens the socket. This is the only agent-grant surface
   * kept for the internal runner; the external agent grant-management API is
   * intentionally gone, so it lives with the bot surface that is its sole
   * consumer. Path and response shape are frozen: the runner depends on them.
   */
  app.get('/api/agent/identity', async (req, reply) => {
    const grant = resolveAgentGrant(db, bearerToken(req));
    if (!grant) return reply.code(401).send({ error: 'Agent token is expired or revoked.' });
    const user = db
      .prepare('SELECT id AS userId, username, pubkey AS publicKey FROM users WHERE id = ?')
      .get(grant.user_id) as object;
    return {
      ...user,
      scopeKind: grant.scope_kind,
      scopeId: grant.scope_id,
      canPlay: !!grant.can_play,
      expiresAt: grant.expires_at,
    };
  });

  app.post('/api/rooms/:id/bots', authed, async (req, reply) => {
    const ctx = await hostRoom(db, req, reply);
    if (!ctx) return;
    const { room, id } = ctx;
    if (room.archived || room.deleted)
      return reply.code(409).send({ error: 'room is not active' });
    const parsed = createBotSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input' });
    const b = parsed.data;

    // Fail closed: without the encryption key we cannot protect (or later
    // recover) a signing identity, and minting one we cannot store would leave a
    // bot that can never play again. Refuse before creating any rows.
    if (!identityKeyConfigured())
      return reply
        .code(503)
        .send({ error: 'BOT_IDENTITY_KEY is not configured; refusing to create a bot' });

    const occupant = db
      .prepare('SELECT user_id FROM room_players WHERE room_id = ? AND seat = ?')
      .get(id, b.seat) as { user_id: number } | undefined;
    if (occupant) return reply.code(409).send({ error: 'that seat is taken' });

    const username = uniqueBotUsername(db);
    const seed = randomBytes(32);
    const identity = identityFromSeed(seed);
    const enc = encryptBotSeed(seed.toString('hex'));
    // The username stays the opaque `bot_<hex>` identity; only the presentation
    // name is dressed up. An explicit `name` always wins.
    const displayName = b.name ?? pickFunBotName(roomDisplayNames(db, id));
    const botId = randomBytes(12).toString('hex');
    const now = Date.now();

    let created: { userId: number };
    try {
      created = createUser(db, username, randomBytes(32).toString('hex'), identity.publicKey);
    } catch (e) {
      if (e instanceof Error && e.message.includes('UNIQUE'))
        return reply.code(409).send({ error: 'bot username collision - try again' });
      throw e;
    }
    const userId = created.userId;

    const initialStatus: BotStatus = b.initialBuyIn === undefined ? 'ready' : 'waiting_buy_approval';
    db.transaction(() => {
      db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, userId);
      db.prepare('INSERT INTO room_players (room_id, user_id, seat, stack, sitting_out) VALUES (?, ?, ?, 0, 0)').run(
        id,
        userId,
        b.seat,
      );
      db.prepare(
        `INSERT INTO bot_accounts
           (id, room_id, owner_id, user_id, status, policy_kind, policy_json, difficulty, seat,
            identity_ct, identity_nonce, identity_tag, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        botId,
        id,
        req.userId,
        userId,
        initialStatus,
        b.policyKind,
        b.policyJson ?? null,
        b.difficulty,
        b.seat,
        enc.ct,
        enc.nonce,
        enc.tag,
        now,
        now,
      );
    })();

    let buyRequest: { id: number; status: string } | null = null;
    if (b.initialBuyIn !== undefined) {
      try {
        const buy = requestRoomBuy(db, {
          roomId: id,
          userId,
          amount: b.initialBuyIn,
          note: 'bot initial buy-in',
        });
        buyRequest = { id: buy.id, status: buy.status };
        // The host is often the room's banker; when so, approve the first buy
        // inline. Otherwise it waits in the normal banker approval list.
        if (buy.status === 'pending' && canBank(room, req.userId)) {
          approveRoomBuy(db, { roomId: id, actorId: req.userId, requestId: buy.id, approve: true });
          buyRequest = { id: buy.id, status: 'approved' };
        }
      } catch (e) {
        // The bot account exists but its money failed; mark it errored rather
        // than leaving a half-created bot looking playable.
        db.prepare("UPDATE bot_accounts SET status = 'error', updated_at = ? WHERE id = ?").run(
          Date.now(),
          botId,
        );
        if (sendBuyError(reply, e)) return;
        throw e;
      }
    }

    const row = getBot(db, id, botId)!;
    return {
      bot: botPublicJson(db, row),
      buyRequest,
      // The supervisor mints its own runner grant via claimStartingBot, so no
      // grant token is exposed here.
    };
  });

  app.get('/api/rooms/:id/bots', authed, async (req, reply) => {
    const { id } = req.params as { id: string };
    const room = getRoom(db, id);
    if (!room) return reply.code(404).send({ error: 'no such room' });
    if (room.host_id !== req.userId && !isMember(db, id, req.userId) && !canBank(room, req.userId))
      return reply.code(403).send({ error: 'not a member' });
    return { bots: listBots(db, id).map((bot) => botPublicJson(db, bot)) };
  });

  // Fund the bot through the same banker path as a human. Keeps a chip-less bot
  // from being permanently stranded and never writes stack directly.
  app.post('/api/rooms/:id/bots/:botId/buy', authed, async (req, reply) => {
    const ctx = await hostRoom(db, req, reply);
    if (!ctx) return;
    if (ctx.room.archived || ctx.room.deleted)
      return reply.code(409).send({ error: 'room is not active' });
    const { botId } = req.params as { id: string; botId: string };
    const bot = getBot(db, ctx.id, botId);
    if (!bot) return reply.code(404).send({ error: 'no such bot' });
    // Refuse a bot whose hard delete is pending: approving a buy would credit the
    // ledger and stack, then the supervisor's finalize would delete the seat row,
    // leaving a purchase with no seat behind it.
    if (isBotGone(bot)) {
      refuseBotGone(reply, bot);
      return;
    }
    const parsed = z
      .object({
        amount: z.number().int().positive().max(LIMITS.maxChipAmount),
        note: z.string().max(200).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input' });
    try {
      const buy = requestRoomBuy(db, {
        roomId: ctx.id,
        userId: bot.user_id,
        amount: parsed.data.amount,
        note: parsed.data.note ?? 'bot buy-in',
      });
      if (buy.status === 'pending' && canBank(ctx.room, req.userId)) {
        approveRoomBuy(db, { roomId: ctx.id, actorId: req.userId, requestId: buy.id, approve: true });
        return { buyRequest: { id: buy.id, status: 'approved' } };
      }
      return { buyRequest: { id: buy.id, status: buy.status } };
    } catch (e) {
      if (sendBuyError(reply, e)) return;
      throw e;
    }
  });

  app.post('/api/rooms/:id/bots/:botId/start', authed, async (req, reply) => {
    const ctx = await hostRoom(db, req, reply);
    if (!ctx) return;
    const { botId } = req.params as { id: string; botId: string };
    const bot = getBot(db, ctx.id, botId);
    if (!bot) return reply.code(404).send({ error: 'no such bot' });
    // A delete already in flight (or a legacy `removed` row) must not be started;
    // `stopping` from a plain graceful stop is left to the STARTABLE check below.
    if (isBotGone(bot)) {
      refuseBotGone(reply, bot);
      return;
    }
    if (ctx.room.archived || ctx.room.deleted)
      return reply.code(409).send({ error: 'room is not active' });
    // Shutdown gate: once stopAll has begun, no new runner may start. 503 (not
    // 409) because this is a transient server state, not a bad request.
    if (control.hooks?.isShuttingDown())
      return reply.code(503).send({ error: 'server is shutting down; cannot start bots' });
    // `starting` is idempotent; every other non-startable state is a conflict.
    // `running` deliberately conflicts rather than silently succeeding, so the
    // host must stop before restarting and the runner is never double-spawned.
    if (bot.status === 'starting') {
      // A restart that crashed before the supervisor claimed it leaves a
      // `starting` bot with no runner; let the hook retry the claim.
      if (control.hooks && !control.hooks.hasRunner(botId)) control.hooks.startBot(botId, ctx.id);
      return {
        bot: botPublicJson(db, getBot(db, ctx.id, botId)!),
        runner: control.hooks ? 'supervisor' : 'detached',
        claim: 'supervisor claims this bot via claimStartingBot() to receive the runner grant',
      };
    }
    if (!STARTABLE.includes(bot.status))
      return reply.code(409).send({ error: `bot cannot start from ${bot.status}` });

    // Verify the real identity before advancing any state; a missing key, a
    // wrong-but-well-formed key or a corrupted seed all fail closed. This bot
    // never entered `starting`, so the start-time helper owns the error state.
    if (!verifyBotIdentity(db, bot)) {
      markBotIdentityFailed(db, botId);
      return reply.code(503).send({
        error: 'bot identity is not recoverable; refusing to start',
        status: 'error',
      });
    }
    // Refuse before writing `starting` when this room's runner pool is full (or
    // the server-wide safety valve is tripped), so a refused start never leaves a
    // bot parked in `starting` with no supervisor. A full room does not affect
    // another room: `canStart` is scoped by room id.
    if (control.hooks && !control.hooks.canStart(ctx.id))
      return reply
        .code(409)
        .send({ error: 'bot runner capacity reached for this room; stop one of its running bots first' });
    // Entering `starting` is a restart: clear the previous stop bookkeeping so a
    // claimed bot is never reported as both running and stopped. A conditional
    // update guards against a concurrent stop/remove moving the row first.
    const started = db
      .prepare(
        "UPDATE bot_accounts SET status = 'starting', stopped_at = NULL, stop_requested_at = NULL, updated_at = ? WHERE id = ? AND status IN ('ready','stopped','error')",
      )
      .run(Date.now(), botId);
    if (started.changes !== 1)
      return reply.code(409).send({ error: 'bot state changed; retry the start' });
    control.hooks?.startBot(botId, ctx.id);
    return {
      bot: botPublicJson(db, getBot(db, ctx.id, botId)!),
      runner: control.hooks ? 'supervisor' : 'detached',
      claim: 'supervisor claims this bot via claimStartingBot() to receive the runner grant',
    };
  });

  app.post('/api/rooms/:id/bots/:botId/stop', authed, async (req, reply) => {
    const ctx = await hostRoom(db, req, reply);
    if (!ctx) return;
    const { botId } = req.params as { id: string; botId: string };
    const bot = getBot(db, ctx.id, botId);
    if (!bot) return reply.code(404).send({ error: 'no such bot' });
    // A bot being hard-deleted is not a graceful stop that can be resumed: refuse
    // the control op. A plain `stopping`/`stopped` bot (no delete requested) still
    // gets the idempotent 200 below.
    if (isBotGone(bot)) {
      refuseBotGone(reply, bot);
      return;
    }
    if (bot.status === 'stopping' || bot.status === 'stopped')
      return { bot: botPublicJson(db, bot), runner: control.hooks ? 'supervisor' : 'detached' };
    if (!STOPPABLE.includes(bot.status))
      return reply.code(409).send({ error: `bot cannot stop from ${bot.status}` });
    const hooks = control.hooks;
    if (hooks) {
      // Graceful: mark stopping now but keep the grant alive so the runner can
      // fold and let the current hand finish. The supervisor revokes the grant
      // and marks the bot stopped once its runner has wound down.
      if (!beginBotStop(db, bot.id))
        return reply.code(409).send({ error: 'bot state changed; retry the stop' });
      runHook(() => hooks.stopBot(bot.id));
    } else {
      // No supervisor: Phase 1a semantics - state change and revoke together,
      // so a crash cannot leave `stopping` with the old token still live.
      db.transaction(() => {
        if (beginBotStop(db, bot.id)) revokeBotGrants(db, bot.id);
      })();
    }
    return {
      bot: botPublicJson(db, getBot(db, ctx.id, botId)!),
      runner: hooks ? 'supervisor' : 'detached',
      message: 'bot state advanced to stopping; the supervisor calls markBotStopped() when done',
    };
  });

  app.delete('/api/rooms/:id/bots/:botId', authed, async (req, reply) => {
    const ctx = await hostRoom(db, req, reply);
    if (!ctx) return;
    const { botId } = req.params as { id: string; botId: string };
    const bot = getBot(db, ctx.id, botId);
    if (!bot) return reply.code(404).send({ error: 'no such bot' });

    // A delete already in flight (a live runner is winding down) is idempotent:
    // report the same pending state instead of firing a second wind-down.
    if (bot.delete_requested_at !== null) {
      return reply.code(202).send({
        bot: botPublicJson(db, bot),
        runner: control.hooks ? 'supervisor' : 'detached',
        deletion: 'pending',
      });
    }

    const hooks = control.hooks;
    if (hooks?.hasRunner(bot.id)) {
      // A live runner must fold and leave its seat before the row can go, which
      // does not fit in one request. Park `stopping`, persist the delete intent
      // (so a crash cannot silently cancel it) and let the supervisor hard-delete
      // once the runner has wound down. The grant stays valid for the wind-down.
      const now = Date.now();
      const parked = db
        .prepare(
          `UPDATE bot_accounts
              SET status = 'stopping',
                  stop_requested_at = COALESCE(stop_requested_at, ?),
                  delete_requested_at = COALESCE(delete_requested_at, ?),
                  updated_at = ?
            WHERE id = ? AND delete_requested_at IS NULL`,
        )
        .run(now, now, now, bot.id);
      if (parked.changes !== 1) {
        // Lost a race with a concurrent DELETE; report the same pending state.
        return reply.code(202).send({
          bot: botPublicJson(db, getBot(db, ctx.id, botId)!),
          runner: 'supervisor',
          deletion: 'pending',
        });
      }
      runHook(() => hooks.removeBot(bot.id));
      return reply.code(202).send({
        bot: botPublicJson(db, getBot(db, ctx.id, botId)!),
        runner: 'supervisor',
        deletion: 'pending',
      });
    }

    // No live runner: there is nothing to fold, so the wind-down is trivial and
    // the rows are deleted in this request. `finalizeBotRemoved` is the atomic
    // single winner - a concurrent DELETE sees zero changed rows and gets 404.
    const snapshot = botPublicJson(db, bot);
    if (!finalizeBotRemoved(db, bot.id)) return reply.code(404).send({ error: 'no such bot' });
    return {
      bot: { ...snapshot, status: 'removed' as BotStatus },
      runner: hooks ? 'supervisor' : 'detached',
      deletion: 'done',
    };
  });
}
