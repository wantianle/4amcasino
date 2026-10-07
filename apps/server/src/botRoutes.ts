import { randomBytes } from 'node:crypto';
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
import { canBank, getRoom, isMember, type RoomRow } from './rooms.js';
import { LIMITS } from './limits.js';
import { BuyServiceError, approveRoomBuy, requestRoomBuy } from './buyService.js';
import { encryptBotSeed, identityKeyConfigured } from './botIdentity.js';
import { pickFunBotName } from './botNames.js';
import { resolveAgentGrant } from './botAccess.js';
import { botGoneMessage, isBotGone } from './botLifecycle.js';
import { resolveCreatePolicyKind, roomPolicyKinds } from './botPresetPick.js';
import { TABLE_FULL_MESSAGE, botCapacity, getBot, listBots, type BotRow } from './botQueries.js';
import {
  beginBotStop,
  finalizeBotRemoved,
  revokeBotGrants,
  runHook,
  verifyBotIdentity,
} from './botLifecycleService.js';

/**
 * HTTP layer for the bot surface: route registration and request validation.
 * The persisted state machine lives in `botLifecycleService.ts` and the read
 * queries in `botQueries.ts`; both are re-exported below so importers of this
 * module keep their existing path.
 */

/**
 * Bot lifecycle states live in @4am/shared so the web UI can type its display
 * copy against the same list. Re-exported here because this module owns the
 * state machine and is the import site the server/tests use.
 */
export { BOT_STATUSES };
export type { BotStatus };

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

// Re-exported so existing importers of `./botRoutes.js` keep resolving the
// query surface unchanged.
export { TABLE_FULL_MESSAGE, botCapacity, getBot, listBots };
export type { BotCapacity, BotRow } from './botQueries.js';

// Re-exported so existing importers of `./botRoutes.js` keep resolving the
// lifecycle surface unchanged. `runHook` is imported for local use only and was
// never part of this module's public surface.
export { beginBotStop, finalizeBotRemoved, revokeBotGrants, verifyBotIdentity };
export {
  claimStartingBot,
  completeBotStop,
  evictOverCapBots,
  forceStopBot,
  markBotError,
  markBotStopped,
  setBotEvictionRunner,
} from './botLifecycleService.js';
export type { BotEvictionRunner, ClaimedBot } from './botLifecycleService.js';

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

const createBotSchema = z.object({
  name: z.string().trim().min(1).max(24).optional(),
  // Explicit local preset is honoured as-is; `llm` is honoured verbatim. Omit it
  // (or send an empty/unknown value) to get the create-time balanced-random local
  // preset - the product default. See `resolveCreatePolicyKind`. It stays
  // `.optional()` with no default precisely so "unset" is distinguishable from a
  // deliberate choice; an empty string is allowed through for the same reason.
  policyKind: z.string().trim().max(40).optional(),
  policyJson: z.string().max(20_000).optional(),
  // Defaults to `medium` (the rules-v1 engine) so a create with no difficulty
  // runs the strong new bot by default; `low` is an explicit opt-out.
  difficulty: z.enum(BOT_DIFFICULTIES).default(DEFAULT_BOT_DIFFICULTY),
  seat: z.number().int().min(0).max(8),
  // Optional because a bot can also be funded later via POST .../buy; a bot with
  // no chips still has a purchase path, so it is never stranded at stack 0.
  initialBuyIn: z.number().int().positive().max(LIMITS.maxChipAmount).optional(),
});

/**
 * The bot runner authenticates with its one-time runner grant rather than a
 * session cookie, so identity resolution must read the credential exactly as
 * the runner's HTTP client sends it: `Authorization: Bearer <token>`.
 */
const bearerToken = (req: FastifyRequest) =>
  (req.headers.authorization ?? '').replace(/^Bearer /, '');

/**
 * The bot's seat as the room sees it, plus whether that seat is REAL.
 *
 * `bot_accounts.seat` is the *configured* seat; the authoritative runtime seat
 * is the bot's `room_players` row (a supervisor may move a bot), so GET reports
 * the room_players value when one exists. `seated` is true only when such a row
 * exists AND carries a non-null seat: a configured seat with no `room_players`
 * row (or a null-seat ghost) is reported as `seat` for diagnostics but is NOT
 * `seated`, and the client must not count it toward table capacity. This is the
 * per-bot counterpart of `botCapacity`'s `room_players.seat IS NOT NULL` rule.
 */
function botSeatState(db: DB, bot: BotRow): { seat: number | null; seated: boolean } {
  const rp = db
    .prepare('SELECT seat FROM room_players WHERE room_id = ? AND user_id = ?')
    .get(bot.room_id, bot.user_id) as { seat: number | null } | undefined;
  if (!rp) return { seat: bot.seat, seated: false };
  return { seat: rp.seat, seated: rp.seat !== null };
}

function botPublicJson(db: DB, bot: BotRow) {
  const user = db
    .prepare('SELECT username, COALESCE(display_name, username) AS displayName FROM users WHERE id = ?')
    .get(bot.user_id) as { username: string; displayName: string } | undefined;
  const player = db
    .prepare('SELECT stack FROM room_players WHERE room_id = ? AND user_id = ?')
    .get(bot.room_id, bot.user_id) as { stack: number } | undefined;
  const seatState = botSeatState(db, bot);
  return {
    id: bot.id,
    userId: bot.user_id,
    username: user?.username ?? null,
    displayName: user?.displayName ?? null,
    seat: seatState.seat,
    /** True only when the bot really holds a `room_players` seat, so the client
     *  counts a ghost row as free capacity exactly like the server does. */
    seated: seatState.seated,
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

// `isBotGone` is defined in `botLifecycle.ts` so the money path in buyService
// can share it without importing this route layer (which would be a cycle).
// Every money/control route must refuse a gone/deleting bot rather than mutate
// state that is about to be deleted.

/**
 * Send the 409 for a gone/deleting bot, naming the actual reason. Used by every
 * route that must reject such a bot, so the check and the status code cannot
 * drift apart as new routes are added.
 */
function refuseBotGone(
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  bot: BotRow,
): void {
  reply.code(409).send({ error: botGoneMessage(bot) });
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

    // Assign the bot's play style here, at create time.
    //
    // A hand-picked style wins: an explicit local preset is written as-is (and
    // `llm` verbatim). Only when the client sends nothing - or an empty/unknown
    // value - do we draw a **balanced-by-deficit** local preset, so a table the
    // host fills without choosing ends up visibly varied. At the default `medium`
    // difficulty the rules-v1 engine always wins and `policy_kind` alone selects
    // the preset (`RULE_PRESETS`), so every bot created with the same kind plays
    // identically up to its RNG seed - the draw is what makes the default mixed.
    //
    // `llm` is deliberately not part of the random pool (external call, per-call
    // cost, multi-second latency), but an explicit request for it is honoured.
    const policyKind = resolveCreatePolicyKind(
      b.policyKind,
      Math.random,
      roomPolicyKinds(db, id),
    );

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

    // Keep a bot-present table at 6 (see MAX_TABLE_PLAYERS_WITH_BOTS): seated
    // humans + seated bots may not exceed the cap. This is the authoritative
    // gate - the host dialog hides its create form at capacity, but a DS/Mem
    // client must not be able to bypass it. The whole route body after
    // `await hostRoom()` is synchronous, so two racing creates cannot both read
    // the same stale count and slip a 7th seat in (see botTableCap.test.ts).
    if (botCapacity(db, id).full)
      return reply.code(409).send({ error: TABLE_FULL_MESSAGE });

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
        policyKind,
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
