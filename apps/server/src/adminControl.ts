import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AdminOverview } from '@4am/shared';
import { writeAdminAudit, type DB } from './db.js';
import { platformUserId, requirePlatform } from './platform.js';
import {
  adminCommissionSettings,
  changeCommission,
  commissionSettings,
} from './platformSettings.js';
import { platformDues } from './house.js';
import { roomEvents } from './rooms.js';
import { settlementNotVoidedSql, voidHandExclusionSql } from './handProjection.js';

export function registerPlatformControl(app: FastifyInstance, db: DB): void {
  const platformOnly = { preHandler: requirePlatform(db) };
  app.get('/api/platform/settings', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    const { commissionBps, revision, updatedAt } = commissionSettings(db);
    return { commissionBps, revision, updatedAt };
  });
  app.get('/api/admin/settings', platformOnly, async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return adminCommissionSettings(db);
  });
  app.put('/api/admin/settings/commission', platformOnly, async (req, reply) => {
    const parsed = z
      .object({
        commissionBps: z.number().int().min(0).max(10000),
        scope: z.enum(['new_rooms', 'all_rooms']),
        revision: z.number().int().min(0),
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({
          error:
            'Enter a rate from 0% to 100% with at most two decimal places, and choose where to apply it.',
        });
    // changeCommission opens its own transaction; wrapping both it and the audit
    // insert in one outer transaction makes them a single unit (the inner one
    // becomes a savepoint), so a failed audit write rolls the rate change back.
    const result = db.transaction(() => {
      const r = changeCommission(db, parsed.data, req.userId);
      if (!r) return null;
      writeAdminAudit(db, req.userId, 'settings.commission', 'settings', 'commission', {
        commissionBps: parsed.data.commissionBps,
        scope: parsed.data.scope,
        affectedRooms: r.affectedRooms,
      });
      return r;
    })();
    if (!result)
      return reply
        .code(409)
        .send({
          error:
            'The house cut changed in another session. Reload the settings before saving again.',
        });
    const { roomIds, ...settings } = result;
    for (const roomId of roomIds) roomEvents.emit('changed', roomId);
    return settings;
  });

  app.get('/api/admin/overview', platformOnly, async (): Promise<AdminOverview> => {
    const platformId = platformUserId(db);
    const count = (sql: string, ...args: (string | number | null)[]) =>
      (db.prepare(sql).get(...args) as { n: number }).n;
    const days = Array.from({ length: 14 }, (_, i) =>
      new Date(Date.now() - (13 - i) * 86400000).toISOString().slice(0, 10),
    );
    const revenueRows = db
      .prepare(
        `SELECT strftime('%Y-%m-%d', l.ts / 1000, 'unixepoch') AS date, SUM(l.delta) AS commission
      FROM ledger l JOIN rooms r ON r.id = l.room_id
      WHERE l.kind = 'commission' AND l.ts >= ? AND r.voided = 0 AND r.archived = 0 AND r.deleted = 0
      AND ${settlementNotVoidedSql('l')}
      GROUP BY date`,
      )
      .all(Date.parse(days[0]! + 'T00:00:00Z')) as { date: string; commission: number }[];
    const byDay = new Map(revenueRows.map((r) => [r.date, r.commission]));
    return {
      users: count('SELECT COUNT(*) AS n FROM users WHERE id != ?', platformId ?? -1),
      rooms: count('SELECT COUNT(*) AS n FROM rooms WHERE deleted = 0'),
      activeRooms: count(
        'SELECT COUNT(*) AS n FROM rooms WHERE deleted = 0 AND archived = 0 AND voided = 0',
      ),
      hands: count(`SELECT COUNT(*) AS n FROM transcripts t JOIN rooms r ON r.id = t.room_id
        WHERE r.deleted = 0 AND r.archived = 0 AND r.voided = 0
        AND ${voidHandExclusionSql({ roomExpr: 't.room_id', handIdExpr: 't.hand_id', headExpr: 't.head' })}`),
      pendingRequests: count("SELECT COUNT(*) AS n FROM account_merge_requests WHERE status = 'pending'"),
      commissionBps: commissionSettings(db).commissionBps,
      dues: platformDues(db).totals,
      revenue: days.map((date) => ({ date, commission: byDay.get(date) ?? 0 })),
    };
  });

  app.get('/api/admin/users', platformOnly, async (req, reply) => {
    const parsed = z
      .object({
        q: z.string().max(100).default(''),
        offset: z.coerce.number().int().min(0).max(1000000).default(0),
        id: z.coerce.number().int().positive().optional(),
      })
      .safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid user search.' });
    const { q, offset, id } = parsed.data;

    // Exact single-user lookup for the admin console's ID box: unlike the
    // player-facing profile endpoint this returns `disabled` and `mergedInto`,
    // so the UI can render Disable / Enable / merged correctly without a
    // second round trip.
    if (id !== undefined) {
      const user = db
        .prepare(
          `SELECT u.id AS userId, u.username, COALESCE(u.display_name, u.username) AS displayName,
                  u.disabled, u.merged_into AS mergedInto, u.created_at AS createdAt,
                  u.last_seen AS lastSeen, u.avatar_version AS avatarVersion,
                  (SELECT COUNT(*) FROM room_players rp JOIN rooms r ON r.id = rp.room_id WHERE rp.user_id = u.id AND r.deleted = 0) AS rooms
           FROM users u WHERE u.id = ?`,
        )
        .get(id) as { userId: number } | undefined;
      return { user: user ? { ...user, isPlatform: user.userId === platformUserId(db) } : null };
    }

    const params = { q: `%${q.trim().replace(/^@/, '')}%`, offset };
    const where =
      "u.username LIKE @q OR COALESCE(u.display_name, '') LIKE @q OR CAST(u.id AS TEXT) LIKE @q";
    const users = db
      .prepare(
        `SELECT u.id AS userId, u.username, COALESCE(u.display_name, u.username) AS displayName,
      u.disabled, u.merged_into AS mergedInto, u.created_at AS createdAt, u.last_seen AS lastSeen, u.avatar_version AS avatarVersion,
      (SELECT COUNT(*) FROM room_players rp JOIN rooms r ON r.id = rp.room_id WHERE rp.user_id = u.id AND r.deleted = 0) AS rooms
      FROM users u WHERE ${where} ORDER BY u.id DESC LIMIT 50 OFFSET @offset`,
      )
      .all(params) as { userId: number }[];
    const { total } = db
      .prepare(`SELECT COUNT(*) AS total FROM users u WHERE ${where}`)
      .get({ q: params.q }) as { total: number };
    return {
      users: users.map((u) => ({ ...u, isPlatform: u.userId === platformUserId(db) })),
      total,
      offset,
      hasMore: offset + users.length < total,
    };
  });
}
