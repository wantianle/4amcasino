import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAdminAudit, type DB } from './db.js';
import { isPlatform, notPlatformAccountSql, platformUserId, requirePlatform } from './platform.js';
import { authKeySchema, publicKeySchema, requireUser } from './auth.js';
import { archiveRoom, roomEvents } from './rooms.js';
import { mergeAccounts } from './merge.js';
import { rekey, seatedSomewhere } from './account.js';
import { activeHands } from './liveHands.js';
import { abortPendingHandSettlement, applyPreparedHandSettlement } from './game.js';
import { platformDues } from './house.js';
import { registerPlatformControl } from './adminControl.js';
import { derivePlatformCredentials } from './platform-crypto.js';
import { gameNetLedgerDeltaSql, gameNetLedgerKindSql } from './handProjection.js';

/** Net hand-settlement balance and distinct room count for one user - the
 *  manual "does this look right" surface an admin checks before approving a
 *  merge (task-3 brief §7). Mirrors the aggregation leaderboard/social.ts use. */
function balanceSummary(db: DB, userId: number): { balance: number; rooms: number } {
  const { balance } = db
    .prepare(
      `SELECT COALESCE(SUM(${gameNetLedgerDeltaSql('l')}), 0) AS balance FROM ledger l
        WHERE l.user_id = ? AND ${gameNetLedgerKindSql('l')}`,
    )
    .get(userId) as { balance: number };
  const { rooms } = db
    .prepare(`SELECT COUNT(DISTINCT room_id) AS rooms FROM ledger WHERE user_id = ?`)
    .get(userId) as { rooms: number };
  return { balance, rooms };
}

/** The Platform account's console: account merges and direct room / user
 *  administration. Room lifecycle changes are applied here directly by the
 *  platform - there is no self-serve request queue any more. */
export function registerAdminRoutes(app: FastifyInstance, db: DB): void {
  registerPlatformControl(app, db);
  const platformOnly = { preHandler: requirePlatform(db) };

  app.get('/api/admin/house', platformOnly, async () => platformDues(db));

  /** Any authed user can ask that another username be folded into their own
   *  (or vice versa) - filing the request never merges anything by itself,
   *  it only queues the ask for a human at the platform account to review. */
  app.post('/api/me/merge-request', { preHandler: requireUser(db) }, async (req, reply) => {
    const parsed = z
      .object({
        fromUsername: z.string().min(1),
        intoUsername: z.string().min(1),
        note: z.string().max(500).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input' });

    const { fromUsername, intoUsername, note } = parsed.data;
    if (fromUsername === intoUsername) {
      return reply.code(400).send({ error: 'cannot merge an account into itself' });
    }

    const from = db.prepare('SELECT id FROM users WHERE username = ?').get(fromUsername) as
      { id: number } | undefined;
    if (!from) return reply.code(404).send({ error: `no such user: ${fromUsername}` });
    // Filing this request is the front door mergeAccounts guards against too
    // (merge.ts) - refuse here as well so a request naming the platform
    // account as `from` never even reaches the pending queue.
    if (isPlatform(db, from.id)) {
      return reply.code(400).send({ error: 'cannot merge the platform account' });
    }
    const into = db.prepare('SELECT id FROM users WHERE username = ?').get(intoUsername) as
      { id: number } | undefined;
    if (!into) return reply.code(404).send({ error: `no such user: ${intoUsername}` });
    if (from.id === into.id) {
      return reply.code(400).send({ error: 'cannot merge an account into itself' });
    }

    const info = db
      .prepare(
        `INSERT INTO account_merge_requests (from_user, into_user, requested_by, note, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(from.id, into.id, req.userId, note ?? null, Date.now());
    return { requestId: Number(info.lastInsertRowid) };
  });

  interface PendingMergeRow {
    id: number;
    fromUser: number;
    fromUsername: string;
    intoUser: number;
    intoUsername: string;
    note: string | null;
    createdAt: number;
  }

  /** The manual-check surface: every pending merge request alongside a net
   *  hand-settlement balance and room count for BOTH sides, so the platform
   *  operator can eyeball "does folding these two together look right"
   *  before approving (task-3 brief §7) - mergeAccounts itself trusts nothing
   *  here, this is purely for the human decision. */
  app.get('/api/admin/merges', platformOnly, async () => {
    const rows = db
      .prepare(
        `SELECT mr.id AS id, mr.from_user AS fromUser, fu.username AS fromUsername,
                mr.into_user AS intoUser, iu.username AS intoUsername,
                mr.note AS note, mr.created_at AS createdAt
         FROM account_merge_requests mr
         JOIN users fu ON fu.id = mr.from_user
         JOIN users iu ON iu.id = mr.into_user
         WHERE mr.status = 'pending'
         ORDER BY mr.created_at ASC`,
      )
      .all() as PendingMergeRow[];

    const requests = rows.map((r) => {
      const fromSummary = balanceSummary(db, r.fromUser);
      const intoSummary = balanceSummary(db, r.intoUser);
      return {
        id: r.id,
        fromUser: r.fromUser,
        fromUsername: r.fromUsername,
        intoUser: r.intoUser,
        intoUsername: r.intoUsername,
        note: r.note,
        createdAt: r.createdAt,
        fromBalance: fromSummary.balance,
        fromRooms: fromSummary.rooms,
        intoBalance: intoSummary.balance,
        intoRooms: intoSummary.rooms,
      };
    });
    return { requests };
  });

  /** Approve -> actually run mergeAccounts (its own transaction; a failure
   *  there - e.g. someone sat down mid-review - leaves the request pending
   *  and disables nobody, reported as 409 rather than silently swallowed.
   *  Reject -> just records the decision, never touches either account. */
  app.post('/api/admin/merges/:id', platformOnly, async (req, reply) => {
    const parsed = z.object({ approve: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input' });

    const { id } = req.params as { id: string };
    const requestId = Number(id);
    if (!Number.isInteger(requestId)) return reply.code(400).send({ error: 'invalid input' });

    const mergeRequest = db
      .prepare(
        `SELECT id, from_user AS fromUser, into_user AS intoUser, status FROM account_merge_requests WHERE id = ?`,
      )
      .get(requestId) as
      { id: number; fromUser: number; intoUser: number; status: string } | undefined;
    if (!mergeRequest) return reply.code(404).send({ error: 'no such request' });
    if (mergeRequest.status !== 'pending')
      return reply.code(400).send({ error: 'already decided' });

    const approve = parsed.data.approve;
    if (!approve) {
      db.transaction(() => {
        db.prepare(
          `UPDATE account_merge_requests SET status = 'rejected', decided_at = ?, decided_by = ? WHERE id = ?`,
        ).run(Date.now(), req.userId, requestId);
        writeAdminAudit(db, req.userId, 'merge.reject', 'merge', String(requestId), {
          requestId,
          fromUser: mergeRequest.fromUser,
          intoUser: mergeRequest.intoUser,
        });
      })();
      return { ok: true, status: 'rejected' };
    }

    // Second line of defense: the filing route above already blocks this,
    // but a request could predate the platform account being (re)assigned -
    // never let approval reach mergeAccounts with the platform as `from`.
    if (isPlatform(db, mergeRequest.fromUser)) {
      return reply.code(400).send({ error: 'cannot merge the platform account' });
    }

    // mergeAccounts runs inside this outer transaction (a nested savepoint), so
    // the decision row and the audit entry commit or roll back with the merge
    // itself - a failed audit insert cannot leave a merged account behind.
    try {
      db.transaction(() => {
        mergeAccounts(db, mergeRequest.fromUser, mergeRequest.intoUser);
        db.prepare(
          `UPDATE account_merge_requests SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ?`,
        ).run(Date.now(), req.userId, requestId);
        writeAdminAudit(db, req.userId, 'merge.approve', 'merge', String(requestId), {
          requestId,
          fromUser: mergeRequest.fromUser,
          intoUser: mergeRequest.intoUser,
        });
      })();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'merge failed';
      return reply.code(409).send({ error: message });
    }
    return { ok: true, status: 'approved' };
  });

  /** Skip the request queue entirely: merge two accounts right now. Guarded
   *  the same way the approval path above is - mergeAccounts's own checks,
   *  plus the platform-as-`from` guard duplicated here - but still records
   *  an (already-decided) row in account_merge_requests so a direct merge
   *  leaves the same audit trail an approved request would. */
  app.post('/api/admin/merge', platformOnly, async (req, reply) => {
    const parsed = z
      .object({
        fromUsername: z.string().min(1),
        intoUsername: z.string().min(1),
        note: z.string().max(500).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input' });

    const { fromUsername, intoUsername, note } = parsed.data;
    if (fromUsername === intoUsername) {
      return reply.code(400).send({ error: 'cannot merge an account into itself' });
    }

    const from = db.prepare('SELECT id FROM users WHERE username = ?').get(fromUsername) as
      { id: number } | undefined;
    if (!from) return reply.code(404).send({ error: `no such user: ${fromUsername}` });
    const into = db.prepare('SELECT id FROM users WHERE username = ?').get(intoUsername) as
      { id: number } | undefined;
    if (!into) return reply.code(404).send({ error: `no such user: ${intoUsername}` });
    if (from.id === into.id) {
      return reply.code(400).send({ error: 'cannot merge an account into itself' });
    }
    if (isPlatform(db, from.id)) {
      return reply.code(400).send({ error: 'cannot merge the platform account' });
    }

    try {
      db.transaction(() => {
        mergeAccounts(db, from.id, into.id);
        const platformId = platformUserId(db)!;
        const now = Date.now();
        const info = db
          .prepare(
            `INSERT INTO account_merge_requests
               (from_user, into_user, requested_by, note, status, created_at, decided_at, decided_by)
             VALUES (?, ?, ?, ?, 'approved', ?, ?, ?)`,
          )
          .run(from.id, into.id, platformId, note ?? null, now, now, platformId);
        writeAdminAudit(db, req.userId, 'merge.create', 'merge', `${from.id}->${into.id}`, {
          requestId: Number(info.lastInsertRowid),
          fromUser: from.id,
          intoUser: into.id,
        });
      })();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'merge failed';
      return reply.code(409).send({ error: message });
    }

    return { ok: true };
  });

  interface AdminRoomRow {
    id: string;
    name: string;
    archived: number;
    hostName: string;
    playerCount: number;
  }

  /** Every non-deleted room, newest first, for the platform's own room
   *  management - this mutates rooms directly rather than queuing a request.
   *  Player counts exclude the platform account itself, same as the
   *  public/my-rooms listings in rooms.ts, so an idle house seat never
   *  inflates a headcount. */
  app.get('/api/admin/rooms', platformOnly, async (req) => {
    const { q } = req.query as { q?: string };
    const like = q && q.trim() ? `%${q.trim()}%` : '%';
    const rows = db
      .prepare(
        `SELECT r.id AS id, r.name AS name, r.archived AS archived, r.commission_bps AS commissionBps,
                COALESCE(u.display_name, u.username) AS hostName,
                (SELECT COUNT(*) FROM room_players rp WHERE rp.room_id = r.id
                   AND ${notPlatformAccountSql('rp.user_id')}) AS playerCount
         FROM rooms r
         JOIN users u ON u.id = r.host_id
         WHERE r.deleted = 0 AND r.name LIKE ?
         ORDER BY r.created_at DESC
         LIMIT 50`,
      )
      .all(like) as AdminRoomRow[];
    return { rooms: rows };
  });

  /** Archive/unarchive a room directly - the platform's own room control
   *  (only refuse when turning archiving *on*; restoring a room is always
   *  safe). */
  app.post('/api/admin/rooms/:id/archive', platformOnly, async (req, reply) => {
    const parsed = z.object({ archived: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input' });

    const { id } = req.params as { id: string };
    const room = db.prepare('SELECT id FROM rooms WHERE id = ?').get(id);
    if (!room) return reply.code(404).send({ error: 'no such room' });

    const { archived } = parsed.data;
    if (archived && activeHands.has(id)) {
      return reply.code(400).send({ error: 'a hand is in progress - wait for it to finish' });
    }

    if (archived) {
      // Unified with `/close`: idempotent, conditional, clears seats on the
      // 0->1 transition and preserves the original archived_at on a repeat.
      // The audit row commits with the archive (nested savepoint inside the
      // outer transaction).
      const result = db.transaction(() => {
        const r = archiveRoom(db, id);
        writeAdminAudit(db, req.userId, 'room.archive', 'room', id, {
          archived: true,
          changed: r.changed,
          alreadyClosed: r.alreadyClosed,
        });
        return r;
      })();
      if (result.changed) roomEvents.emit('changed', id);
      return {
        ok: true,
        archived: true,
        alreadyClosed: result.alreadyClosed,
        archivedAt: result.archivedAt,
      };
    }
    const info = db.transaction(() => {
      const i = db
        .prepare('UPDATE rooms SET archived = 0, archived_at = NULL WHERE id = ? AND archived = 1')
        .run(id);
      writeAdminAudit(db, req.userId, 'room.unarchive', 'room', id, {
        archived: false,
        changed: i.changes > 0,
      });
      return i;
    })();
    if (info.changes > 0) roomEvents.emit('changed', id);
    return { ok: true, archived: false, changed: info.changes > 0 };
  });

  /** Delete a room directly - always refuses mid-hand (delete has no "undo"
   *  toggle, so unlike archive there's no safe direction to allow while a hand
   *  is live). */
  app.post('/api/admin/rooms/:id/delete', platformOnly, async (req, reply) => {
    const { id } = req.params as { id: string };
    const room = db.prepare('SELECT id FROM rooms WHERE id = ?').get(id);
    if (!room) return reply.code(404).send({ error: 'no such room' });

    if (activeHands.has(id)) {
      return reply.code(400).send({ error: 'a hand is in progress - wait for it to finish' });
    }

    // Idempotent like archive/close: the conditional guards the 0->1
    // transition, so a repeat delete neither overwrites deleted_at nor emits a
    // redundant room change. `changed` mirrors the unarchive response shape.
    const info = db.transaction(() => {
      const i = db
        .prepare('UPDATE rooms SET deleted = 1, deleted_at = ? WHERE id = ? AND deleted = 0')
        .run(Date.now(), id);
      writeAdminAudit(db, req.userId, 'room.delete', 'room', id, { changed: i.changes > 0 });
      return i;
    })();
    if (info.changes > 0) roomEvents.emit('changed', id);
    return { ok: true, changed: info.changes > 0 };
  });

  /**
   * P0-2 operator recovery for hands dealt but never settled. This surface is
   * deliberately DB-only: it never touches a live `GameRoom`, so it still works
   * after a process restart has discarded all in-memory hand state.
   *
   * `hand_lifecycle` rows in `running`/`prepared`/`quarantined` are "money
   * facts unknown" and freeze the room (`firstPendingHandLifecycle`). `running`
   * has no frozen input, so it can only be aborted; `prepared` has a complete
   * frozen input and can be retried; `quarantined` has a proven-bad frozen input
   * that can never be applied, so it can only be aborted (its original
   * `last_error` is preserved in the audit detail).
   */
  app.get('/api/admin/hands/pending', platformOnly, async () => {
    const rows = db
      .prepare(
        `SELECT l.hand_id AS handId, l.room_id AS roomId, l.status,
                l.created_at AS createdAt, l.updated_at AS updatedAt,
                l.last_error AS lastError,
                (SELECT p.prepared_at FROM hand_settlement_prepared p WHERE p.hand_id = l.hand_id) AS preparedAt,
                (SELECT p.input_hash FROM hand_settlement_prepared p WHERE p.hand_id = l.hand_id) AS inputHash,
                (SELECT p.attempts FROM hand_settlement_prepared p WHERE p.hand_id = l.hand_id) AS attempts
           FROM hand_lifecycle l
          WHERE l.status IN ('running','prepared','quarantined')
          ORDER BY l.created_at ASC, l.rowid ASC`,
      )
      .all() as {
      handId: string;
      roomId: string;
      status: string;
      createdAt: number;
      updatedAt: number;
      lastError: string | null;
      preparedAt: number | null;
      inputHash: string | null;
      attempts: number | null;
    }[];
    return {
      hands: rows.map((r) => ({
        handId: r.handId,
        roomId: r.roomId,
        status: r.status,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        lastError: r.lastError,
        hasPreparedInput: r.preparedAt !== null,
        preparedAt: r.preparedAt,
        inputHash: r.inputHash,
        attempts: r.attempts,
      })),
    };
  });

  /** Retry a `prepared` hand from its frozen input. Never available for
   *  `running` (nothing frozen to apply) or `quarantined` (provably bad input:
   *  use `abort`, its only exit). */
  app.post('/api/admin/hands/:handId/retry', platformOnly, async (req, reply) => {
    const { handId } = req.params as { handId: string };
    const row = db
      .prepare('SELECT room_id AS roomId, status FROM hand_lifecycle WHERE hand_id = ?')
      .get(handId) as { roomId: string; status: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'no such hand' });
    if (activeHands.has(row.roomId))
      return reply
        .code(409)
        .send({ error: 'a hand is live in memory; use the in-room recovery' });
    if (row.status === 'committed') return { ok: true, status: 'committed', already: true };
    if (row.status === 'aborted') return reply.code(409).send({ error: 'hand is aborted' });
    if (row.status === 'quarantined')
      return reply.code(409).send({ error: 'hand is quarantined; operator review required' });
    if (row.status !== 'prepared')
      return reply.code(409).send({ error: `hand is ${row.status}; no prepared input to retry` });
    const prepared = db
      .prepare('SELECT 1 FROM hand_settlement_prepared WHERE hand_id = ?')
      .get(handId);
    if (!prepared) return reply.code(409).send({ error: 'no prepared input' });
    try {
      const result = applyPreparedHandSettlement(db, handId, {
        resolvedBy: req.userId,
        resolution: 'operator_retry',
      });
      writeAdminAudit(db, req.userId, 'hand.retry', 'hand', handId, {
        roomId: row.roomId,
        status: result.status,
      });
      return { ok: true, status: result.status };
    } catch (e) {
      const message = e instanceof Error ? e.message : 'retry failed';
      const after = db.prepare('SELECT status FROM hand_lifecycle WHERE hand_id = ?').get(handId) as
        | { status: string }
        | undefined;
      writeAdminAudit(db, req.userId, 'hand.retry', 'hand', handId, {
        roomId: row.roomId,
        error: message,
        status: after?.status ?? 'unknown',
      });
      return reply.code(409).send({ ok: false, status: after?.status ?? 'unknown', error: message });
    }
  });

  /** Abort a `running`/`prepared`/`quarantined` hand explicitly. Requires
   *  `{confirm:true}`: the hand moves no chips, but a mistaken abort permanently
   *  freezes its money facts. Idempotent on an already-aborted hand.
   *
   *  A `quarantined` hand can NEVER be settled from its frozen input, so abort is
   *  its only exit; the route therefore stays reachable even while the room is
   *  live in memory (the in-memory recovery surface cannot resolve it). The
   *  original `last_error` is copied into the audit detail so the failure
   *  evidence survives the resolution. */
  app.post('/api/admin/hands/:handId/abort', platformOnly, async (req, reply) => {
    const parsed = z.object({ confirm: z.boolean() }).safeParse(req.body ?? {});
    if (!parsed.success || parsed.data.confirm !== true)
      return reply.code(400).send({ error: 'explicit confirmation required' });
    const { handId } = req.params as { handId: string };
    const row = db
      .prepare('SELECT room_id AS roomId, status, last_error AS lastError FROM hand_lifecycle WHERE hand_id = ?')
      .get(handId) as { roomId: string; status: string; lastError: string | null } | undefined;
    if (!row) return reply.code(404).send({ error: 'no such hand' });
    // running/prepared keep the in-room path while a hand is live; quarantined
    // is a special case because only the DB-only path can ever resolve it.
    if (row.status !== 'quarantined' && activeHands.has(row.roomId))
      return reply
        .code(409)
        .send({ error: 'a hand is live in memory; use the in-room recovery' });
    if (row.status === 'committed')
      return reply.code(409).send({ error: 'hand already committed; cannot abort' });
    try {
      const result = abortPendingHandSettlement(db, handId, { resolvedBy: req.userId });
      writeAdminAudit(db, req.userId, 'hand.abort', 'hand', handId, {
        roomId: row.roomId,
        status: result.status,
        // Preserve the failure evidence that justified a quarantine (or the
        // last retry error) after the lifecycle row stops carrying it.
        lastError: result.lastError ?? row.lastError ?? null,
      });
      return { ok: true, status: result.status };
    } catch (e) {
      const message = e instanceof Error ? e.message : 'abort failed';
      writeAdminAudit(db, req.userId, 'hand.abort', 'hand', handId, {
        roomId: row.roomId,
        error: message,
      });
      return reply.code(409).send({ ok: false, error: message });
    }
  });

  /** Force-disable an account outright, no merge involved (a spam signup, a
   *  cheater, someone who asked to be removed). Kills every session so the
   *  disable takes effect on their very next request (see auth.ts's
   *  requireUser, which rejects disabled users with 401). Refuses to target
   *  the platform account itself - that would lock the admin console. */
  app.post('/api/admin/users/:id/disable', platformOnly, async (req, reply) => {
    const { id } = req.params as { id: string };
    const targetId = Number(id);
    if (!Number.isInteger(targetId)) return reply.code(400).send({ error: 'invalid input' });

    if (isPlatform(db, targetId)) {
      return reply.code(400).send({ error: 'cannot disable the platform account' });
    }
    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
    if (!target) return reply.code(404).send({ error: 'no such user' });

    // Conditional update so `changed` is trustworthy (a repeat disable of an
    // already-disabled account is a no-op) and so the change + session purge +
    // audit row land in one transaction.
    const changed = db.transaction(() => {
      const info = db
        .prepare('UPDATE users SET disabled = 1 WHERE id = ? AND disabled = 0')
        .run(targetId);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
      writeAdminAudit(db, req.userId, 'user.disable', 'user', String(targetId), {
        changed: info.changes > 0,
      });
      return info.changes > 0;
    })();
    return { ok: true, changed };
  });

  /** Re-enable an account parked by /disable. Idempotent: the conditional
   *  UPDATE only flips a row that is actually disabled, so re-enabling (or
   *  enabling a never-disabled account) is a no-op that reports changed:false.
   *  Sessions are not resurrected - the user logs in again normally. The
   *  platform account is allowed here: enabling it is harmless (unlike
   *  disabling, which would lock the console). */
  app.post('/api/admin/users/:id/enable', platformOnly, async (req, reply) => {
    const { id } = req.params as { id: string };
    const targetId = Number(id);
    if (!Number.isInteger(targetId)) return reply.code(400).send({ error: 'invalid input' });

    const target = db
      .prepare('SELECT id, merged_into AS mergedInto FROM users WHERE id = ?')
      .get(targetId) as { id: number; mergedInto: number | null } | undefined;
    if (!target) return reply.code(404).send({ error: 'no such user' });
    // A merge retires the `from` account by disabling it AND stamping
    // merged_into. Re-enabling must not resurrect it - that would break the
    // "merging is irreversible" guarantee - so merged accounts get an explicit
    // 409 instead of a silent changed:false.
    if (target.mergedInto !== null) {
      return reply
        .code(409)
        .send({ error: 'that account was merged into another one and cannot be re-enabled' });
    }

    const changed = db.transaction(() => {
      const info = db
        .prepare('UPDATE users SET disabled = 0 WHERE id = ? AND disabled = 1 AND merged_into IS NULL')
        .run(targetId);
      // Clear any session that exists (a stale token minted before the disable,
      // or a concurrent one) so the account cannot come back half-signed-in.
      if (info.changes > 0) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
      writeAdminAudit(db, req.userId, 'user.enable', 'user', String(targetId), {
        changed: info.changes > 0,
      });
      return info.changes > 0;
    })();
    return { ok: true, changed };
  });

  /** Reset another user's credentials - the "I lost my recovery code too"
   *  escape hatch, done by a human at the platform account instead of the
   *  self-serve /api/recover flow. Reuses account.ts's rekey() so the atomic
   *  swap + full session purge is identical to every other credential
   *  rotation in this app; refuses while the target is seated for the same
   *  reason account.ts does (a live hand's pubkey must not shift mid-deal). */
  app.post('/api/admin/users/:id/password', platformOnly, async (req, reply) => {
    const { id } = req.params as { id: string };
    const targetId = Number(id);
    if (!Number.isInteger(targetId)) return reply.code(400).send({ error: 'invalid input' });

    const parsed = z.object({ newAuthKey: authKeySchema, newPublicKey: publicKeySchema }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input' });

    const target = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId) as
      | { id: number }
      | undefined;
    if (!target) return reply.code(404).send({ error: 'no such user' });

    if (seatedSomewhere(db, targetId)) {
      return reply
        .code(409)
        .send({ error: 'that user is seated at a table - they must stand up before a reset' });
    }

    const reset = db.transaction(() => {
      // The merged_into check lives here, inside the write transaction, rather
      // than in a separate read a concurrent merge could invalidate: the
      // conditional no-op UPDATE only touches an unmerged row, so a merged
      // target changes 0 rows and the whole reset (rekey + audit) is abandoned
      // instead of resurrecting a retired identity.
      const claimed = db
        .prepare('UPDATE users SET merged_into = NULL WHERE id = ? AND merged_into IS NULL')
        .run(targetId);
      if (claimed.changes !== 1) return false;
      rekey(db, targetId, parsed.data.newAuthKey, parsed.data.newPublicKey, null);
      writeAdminAudit(db, req.userId, 'user.password-reset', 'user', String(targetId), {
        mode: 'custom',
      });
      return true;
    })();
    if (!reset)
      return reply
        .code(409)
        .send({ error: 'that account was merged into another one and cannot be reset' });
    return { ok: true };
  });

  /** One-tap "reset to the initial password 123456". Derives the canonical
   *  credentials server-side from the target's username using the exact same
   *  scrypt domains the browser uses (`4am/auth/<username>` and
   *  `4am/id/<username>`) - reused through platform-crypto.ts rather than
   *  re-implemented - then reuses rekey() for the atomic credential+identity
   *  swap and full session purge. Seated targets are refused for the same
   *  mid-deal pubkey reason as /password. Idempotent: repeating it just re-keys
   *  to the same initial credentials again. No forced password change. */
  app.post('/api/admin/users/:id/reset-initial', platformOnly, async (req, reply) => {
    const { id } = req.params as { id: string };
    const targetId = Number(id);
    if (!Number.isInteger(targetId)) return reply.code(400).send({ error: 'invalid input' });

    const target = db
      .prepare('SELECT id, username FROM users WHERE id = ?')
      .get(targetId) as { id: number; username: string } | undefined;
    if (!target) return reply.code(404).send({ error: 'no such user' });

    if (seatedSomewhere(db, targetId)) {
      return reply
        .code(409)
        .send({ error: 'that user is seated at a table - they must stand up before a reset' });
    }

    // Derive outside the transaction: scrypt is deliberately slow and would
    // hold the write lock for its whole run.
    const { authKey: initialAuthKey, publicKey: initialPublicKey } = derivePlatformCredentials(
      target.username,
      '123456',
    );
    const reset = db.transaction(() => {
      // See /password: the merged_into check lives inside the write transaction
      // so a concurrent merge cannot be undone by a rekey that raced past an
      // outside read.
      const claimed = db
        .prepare('UPDATE users SET merged_into = NULL WHERE id = ? AND merged_into IS NULL')
        .run(targetId);
      if (claimed.changes !== 1) return false;
      rekey(db, targetId, initialAuthKey, initialPublicKey, null);
      writeAdminAudit(db, req.userId, 'user.password-reset', 'user', String(targetId), {
        mode: 'initial',
      });
      return true;
    })();
    if (!reset)
      return reply
        .code(409)
        .send({ error: 'that account was merged into another one and cannot be reset' });
    return { ok: true };
  });

  /** Read-only window onto the admin audit trail, newest first. Optional
   *  `action` (exact) and `targetId` (exact) narrow it; `limit`/`offset` page
   *  it. Operators are joined to a display name for readability. `detail` is
   *  parsed back from JSON where present. */
  app.get('/api/admin/audit', platformOnly, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const parsed = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
        action: z.string().min(1).max(100).optional(),
        targetId: z.string().min(1).max(200).optional(),
      })
      .safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid input' });

    const { limit, offset, action, targetId } = parsed.data;
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (action) {
      where.push('a.action = ?');
      params.push(action);
    }
    if (targetId) {
      where.push('a.target_id = ?');
      params.push(targetId);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = db
      .prepare(
        `SELECT a.id AS id, a.operator_user_id AS operatorUserId,
                COALESCE(u.display_name, u.username) AS operatorName,
                a.action AS action, a.target_type AS targetType, a.target_id AS targetId,
                a.detail AS detail, a.ts AS ts
         FROM admin_audit a
         LEFT JOIN users u ON u.id = a.operator_user_id
         ${clause}
         ORDER BY a.ts DESC, a.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as {
      id: number;
      operatorUserId: number;
      operatorName: string | null;
      action: string;
      targetType: string | null;
      targetId: string | null;
      detail: string | null;
      ts: number;
    }[];
    const { total } = db
      .prepare(`SELECT COUNT(*) AS total FROM admin_audit a ${clause}`)
      .get(...params) as { total: number };

    return {
      entries: rows.map(({ detail, ...row }) => {
        let parsedDetail: unknown = null;
        if (detail) {
          try {
            parsedDetail = JSON.parse(detail);
          } catch {
            parsedDetail = detail;
          }
        }
        return { ...row, detail: parsedDetail };
      }),
      total,
      offset,
      hasMore: offset + rows.length < total,
    };
  });
}
