import { createHash, randomBytes } from 'node:crypto';
import { identityFromSeed } from '@4am/mental-poker';
import { MAX_TABLE_PLAYERS_WITH_BOTS } from '@4am/shared';
import type { DB } from './db.js';
import { getRoom, roomEvents } from './rooms.js';
import { decryptBotSeed } from './botIdentity.js';
import { botCapacity, getBotById, type BotRow } from './botQueries.js';

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

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

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
 * Process-wide hook that lets eviction wind a LIVE bot runner down through the
 * ordinary supervisor path (`removeBot`) instead of yanking its rows out from
 * under it. `index.ts` registers the supervisor after `listen()`; tests and
 * embedders leave it null, and eviction then hard-deletes directly (there is no
 * runner to fold). Deliberately a module singleton matching the supervisor
 * itself (one per process), so `GameRoom` - which sits BELOW the route layer -
 * can reach it without taking a new constructor dependency.
 */
export interface BotEvictionRunner {
  hasRunner(botId: string): boolean;
  removeBot(botId: string): void | Promise<void>;
}

let evictionRunner: BotEvictionRunner | null = null;

export function setBotEvictionRunner(runner: BotEvictionRunner | null): void {
  evictionRunner = runner;
}

/**
 * A random still-present bot that ACTUALLY HOLDS A SEAT, or null.
 *
 * The seat join is the whole point: eviction exists to free a seat, and a bot
 * with no `room_players` seat (a ghost/legacy row) frees nothing when deleted.
 * Restricting the pick to seated bots also guarantees each eviction drops
 * `botCapacity().total` by one, so `evictOverCapBots` converges instead of
 * spinning on undeletable ghosts (the 64-iteration guard).
 */
function pickRandomBotForEviction(db: DB, roomId: string): string | null {
  const rows = db
    .prepare(
      `SELECT ba.id AS id
         FROM bot_accounts ba
        WHERE ba.room_id = ? AND ba.status != 'removed' AND ba.delete_requested_at IS NULL
          AND EXISTS (
            SELECT 1 FROM room_players rp
             WHERE rp.room_id = ba.room_id AND rp.user_id = ba.user_id AND rp.seat IS NOT NULL)`,
    )
    .all(roomId) as { id: string }[];
  if (rows.length === 0) return null;
  return rows[Math.floor(Math.random() * rows.length)]!.id;
}

/**
 * Persist a delete intent on a live bot before the supervisor winds it down -
 * the same intent the DELETE route writes - so an interrupted eviction is
 * finished by the supervisor's `recover()` rather than resurrecting the bot.
 */
function parkBotForEviction(db: DB, botId: string): void {
  const now = Date.now();
  db.prepare(
    `UPDATE bot_accounts
        SET status = 'stopping',
            stop_requested_at = COALESCE(stop_requested_at, ?),
            delete_requested_at = COALESCE(delete_requested_at, ?),
            updated_at = ?
      WHERE id = ? AND delete_requested_at IS NULL`,
  ).run(now, now, now, botId);
}

/**
 * Bring a table back to `MAX_TABLE_PLAYERS_WITH_BOTS` by removing random
 * SEATED bots through the ordinary removal path: `finalizeBotRemoved` for a bot
 * with no live runner, or the supervisor's `removeBot` (which folds, then
 * finalizes) when one is running. Used by the sit path when a human sits over
 * the cap, and runnable standalone for one-off cleanup of a pre-existing
 * over-cap room.
 *
 * Stops when the table is back within the cap, when no seated bot is left (an
 * all-human table is over the SEAT count, not the bot count - the CALLER
 * decides whether that is allowed, and eviction never blocks a human), or after
 * handing a live runner off (its row drops asynchronously, so continuing now
 * would over-remove for one overflow).
 *
 * Returns the ids it processed (finalized immediately or handed off).
 */
export function evictOverCapBots(db: DB, roomId: string): string[] {
  const processed: string[] = [];
  for (let guard = 0; guard < 64; guard++) {
    if (botCapacity(db, roomId).total <= MAX_TABLE_PLAYERS_WITH_BOTS) break;
    const botId = pickRandomBotForEviction(db, roomId);
    if (!botId) break;
    const live = evictionRunner?.hasRunner(botId) ?? false;
    if (live) {
      parkBotForEviction(db, botId);
      runHook(() => evictionRunner!.removeBot(botId));
    } else if (!finalizeBotRemoved(db, botId)) {
      break;
    }
    processed.push(botId);
    // A live runner still occupies its seat until it winds down; stop here so
    // one human's arrival removes exactly the one bot it overflowed by.
    if (live) break;
  }
  return processed;
}

/**
 * Fire a supervisor hook without letting a synchronous throw or an async
 * rejection escape the route. The supervisor finalizes its own persisted state
 * in a `finally`, so swallowing here is safe and avoids an unhandled rejection
 * that could take the process down.
 */
export function runHook(fn: () => void | Promise<void>): void {
  void (async () => {
    try {
      await fn();
    } catch {
      // handled by the supervisor's own finally
    }
  })();
}
