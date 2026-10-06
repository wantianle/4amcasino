import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from './db.js';
import { createUser, requireUser } from './auth.js';

const KEY = 'platform_user_id';

/** The Platform (house/admin) account id, or null if not configured yet. */
export function platformUserId(db: DB): number | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(KEY) as
    | { value: string }
    | undefined;
  if (!row) return null;
  const n = Number(row.value);
  return Number.isInteger(n) ? n : null;
}

/** Upsert the Platform account id into the meta table. */
export function setPlatformUserId(db: DB, id: number): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(KEY, String(id));
}

/** True iff userId is the configured Platform account. */
export function isPlatform(db: DB, userId: number): boolean {
  return platformUserId(db) === userId;
}

/**
 * SQL predicate: `expr` is NOT the configured Platform ("house") account.
 *
 * The platform id lives in `meta.platform_user_id`, so it is unknown when a
 * query string is written: an uncorrelated subquery is how a read model counts
 * or lists "real" users while leaving the house seat out. Every headcount /
 * leaderboard read uses this one form - a room's player counts (public, my-rooms,
 * history, admin) and the global leaderboard - so a future edit cannot drop the
 * exclusion at just one site. Before it was extracted the copies differed only
 * in whitespace; the semantics were already identical. When no platform account
 * is configured the subquery is empty, `NOT IN ()` excludes nobody, and the
 * house seat is simply absent.
 */
export function notPlatformAccountSql(expr: string): string {
  return `${expr} NOT IN (SELECT CAST(value AS INTEGER) FROM meta WHERE key = '${KEY}')`;
}

/** requireUser, then require the caller to be the Platform account - 403 otherwise. */
export function requirePlatform(db: DB) {
  const base = requireUser(db);
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const r = await base(req, reply);
    if (r) return r;
    if (!isPlatform(db, req.userId)) return reply.code(403).send({ error: 'platform only' });
  };
}

/** Idempotent: use the configured platform id if set; else adopt an existing
 *  same-named user (the prod case); else create one (the local case). */
export function ensurePlatformAccount(
  db: DB,
  opts: { username: string; createCreds: () => { authKey: string; publicKey: string } },
): { userId: number; created: boolean; adopted: boolean } {
  const existing = platformUserId(db);
  if (existing !== null) return { userId: existing, created: false, adopted: false };

  const row = db.prepare('SELECT id FROM users WHERE username = ?').get(opts.username) as
    | { id: number }
    | undefined;
  if (row) {
    setPlatformUserId(db, row.id);
    return { userId: row.id, created: false, adopted: true };
  }

  const { authKey, publicKey } = opts.createCreds();
  const { userId } = createUser(db, opts.username, authKey, publicKey);
  setPlatformUserId(db, userId);
  return { userId, created: true, adopted: false };
}
