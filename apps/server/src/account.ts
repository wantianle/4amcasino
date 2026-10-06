import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from './db.js';
import {
  authKeySchema,
  createSession,
  endSession,
  hashAuthKey,
  publicKeySchema,
  requireUser,
  usernameSchema,
} from './auth.js';
import { forgive, hitNamed, rateLimit } from './limits.js';

/** Editing your password, your username, and getting back in when you have
 *  forgotten both (requested by notpritam, docs/FEATURES.md).
 *
 *  The whole point of this app is that your password derives your ed25519
 *  card-signing key in the browser, so changing either your password OR your
 *  username re-derives that key: the client must upload a NEW pubkey with the
 *  change, authenticated by the OLD auth key. Old hands stay verifiable because
 *  every transcript entry carries the signer's pubkey inline.
 *
 *  A truly forgotten password is therefore an unrecoverable identity unless a
 *  recovery code was set up in advance - that code is the second door. */

// ── Recovery codes ───────────────────────────────────────────────────────────
// A recovery code is minted by the server once, at signup, and returned in the
// registration response only. Only its salted hash is kept. The client turns
// the readable code into a `recoveryAuthKey` with scrypt domain-separation;
// replicating that derivation here is what lets the server arm the code at
// registration without ever storing a plaintext secret.
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RECOVERY_SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 } as const;

/** 120 bits, grouped 6×4 for legibility. Same alphabet/shape as the web client. */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(24);
  const chars = Array.from(bytes, (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]!);
  return [0, 6, 12, 18].map((i) => chars.slice(i, i + 6).join('')).join('-');
}

/** Mirror of the browser's deriveRecoveryAuthKey (apps/web/src/shared/crypto.ts). */
export function deriveRecoveryAuthKey(code: string): string {
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return scryptSync(normalized, '4am/recover', 32, RECOVERY_SCRYPT).toString('hex');
}

/** Stores the salted hash of a freshly minted code against an existing user. */
export function armRecoveryCode(db: DB, userId: number, code: string): void {
  const salt = randomBytes(16).toString('hex');
  db.prepare(
    'UPDATE users SET recovery_hash = ?, recovery_salt = ?, recovery_set_at = ? WHERE id = ?',
  ).run(hashAuthKey(deriveRecoveryAuthKey(code), salt), salt, Date.now(), userId);
}

interface UserSecrets {
  auth_hash: string;
  auth_salt: string;
  recovery_hash: string | null;
  recovery_salt: string | null;
  recovery_set_at: number | null;
}

function secretsFor(db: DB, userId: number): UserSecrets | undefined {
  return db
    .prepare(
      'SELECT auth_hash, auth_salt, recovery_hash, recovery_salt, recovery_set_at FROM users WHERE id = ?',
    )
    .get(userId) as UserSecrets | undefined;
}

function sameHash(candidateHex: string, storedHex: string): boolean {
  const a = Buffer.from(candidateHex, 'hex');
  const b = Buffer.from(storedHex, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Re-keying while you are sitting in a hand would desync your seat's pubkey
 *  mid-deal, so we refuse rather than corrupt a live game. Shared with admin.ts:
 *  the guard is the same whether the re-key is self-served or admin-initiated. */
export function seatedSomewhere(db: DB, userId: number): boolean {
  return !!db
    .prepare('SELECT 1 FROM room_players WHERE user_id = ? AND seat IS NOT NULL LIMIT 1')
    .get(userId);
}

/** Applies a new credential + identity atomically and cuts every other session
 *  loose: whoever stole the old password does not keep a live token.
 *
 *  Exported so admin.ts can reuse it for a platform-initiated password reset
 *  (Task 4) - same atomic swap + session purge, just triggered by an admin
 *  instead of the user proving their own old password. */
export function rekey(
  db: DB,
  userId: number,
  newAuthKey: string,
  newPublicKey: string,
  keepToken: string | null,
  extra?: { username?: string },
): void {
  const salt = randomBytes(16).toString('hex');
  const apply = db.transaction(() => {
    db.prepare('UPDATE users SET auth_hash = ?, auth_salt = ?, pubkey = ? WHERE id = ?').run(
      hashAuthKey(newAuthKey, salt),
      salt,
      newPublicKey,
      userId,
    );
    if (extra?.username !== undefined) {
      db.prepare('UPDATE users SET username = ? WHERE id = ?').run(extra.username, userId);
    }
    if (keepToken) {
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(userId, keepToken);
    } else {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    }
  });
  apply();
}

/** Outcome of a recovery-code redemption attempt. */
export type RecoveryOutcome =
  | { kind: 'ok'; userId: number }
  | { kind: 'invalid' }
  | { kind: 'seated' }
  | { kind: 'used' };

/** Validates a recovery code, re-keys the account and burns the code in ONE
 *  immediate (write-locked) transaction.
 *
 *  The old flow did SELECT -> compare -> rekey -> NULL as four separate steps,
 *  so two concurrent requests could both read the same stored hash and both
 *  succeed: the same one-use code redeemed twice, the second call also
 *  revoking the session the first had just issued. Here `BEGIN IMMEDIATE`
 *  serializes the whole redemption (waiting up to busy_timeout), the code's
 *  hash is NULLed with a conditional `WHERE recovery_hash = <read value>`, and
 *  the re-key/session purge rides the same transaction. A loser therefore
 *  either sees `recovery_hash IS NULL` (`invalid`) or changes 0 rows (`used`);
 *  only one caller can ever return `ok`. */
export function consumeRecoveryCode(
  db: DB,
  username: string,
  recoveryAuthKey: string,
  newAuthKey: string,
  newPublicKey: string,
): RecoveryOutcome {
  const consume = db.transaction((): RecoveryOutcome => {
    const row = db
      .prepare('SELECT id, recovery_hash, recovery_salt FROM users WHERE username = ?')
      .get(username) as
      | { id: number; recovery_hash: string | null; recovery_salt: string | null }
      | undefined;
    // same shape and roughly the same cost whether the account exists, has no
    // code, or the code is wrong - none of those should be distinguishable
    const salt = row?.recovery_salt ?? 'f'.repeat(32);
    const candidate = hashAuthKey(recoveryAuthKey, salt);
    if (!row?.recovery_hash || !sameHash(candidate, row.recovery_hash)) {
      return { kind: 'invalid' };
    }
    if (seatedSomewhere(db, row.id)) return { kind: 'seated' };
    // Burn conditionally: if another redemption already consumed this exact
    // hash, this changes nothing and the caller is the loser.
    const burned = db
      .prepare(
        `UPDATE users SET recovery_hash = NULL, recovery_salt = NULL, recovery_set_at = NULL
         WHERE id = ? AND recovery_hash = ?`,
      )
      .run(row.id, row.recovery_hash);
    if (burned.changes !== 1) return { kind: 'used' };
    // one use only, and every existing session dies - same transaction
    rekey(db, row.id, newAuthKey, newPublicKey, null);
    return { kind: 'ok', userId: row.id };
  });
  return consume.immediate();
}

function bearer(req: { headers: Record<string, unknown> }): string | null {
  const header = String(req.headers.authorization ?? '');
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

export function registerAccountRoutes(app: FastifyInstance, db: DB): void {
  const authed = { preHandler: requireUser(db) };

  /** Change password: the client re-derives BOTH keys from the new password and
   *  proves it still holds the old one. */
  app.post(
    '/api/me/password',
    {
      preHandler: [
        requireUser(db),
        rateLimit({ name: 'pwchange', limit: 10, windowMs: 15 * 60_000, by: 'user' }),
      ],
    },
    async (req, reply) => {
      const parsed = z
        .object({ currentAuthKey: authKeySchema, newAuthKey: authKeySchema, newPublicKey: publicKeySchema })
        .safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid input' });
      const me = secretsFor(db, req.userId);
      if (!me) return reply.code(404).send({ error: 'no such user' });
      if (!sameHash(hashAuthKey(parsed.data.currentAuthKey, me.auth_salt), me.auth_hash)) {
        return reply.code(403).send({ error: 'that is not your current password' });
      }
      if (parsed.data.newAuthKey === parsed.data.currentAuthKey) {
        return reply.code(400).send({ error: 'that is already your password' });
      }
      if (seatedSomewhere(db, req.userId)) {
        return reply
          .code(409)
          .send({ error: 'stand up from your seat first - changing your password re-keys your cards' });
      }
      rekey(db, req.userId, parsed.data.newAuthKey, parsed.data.newPublicKey, bearer(req));
      return { ok: true, publicKey: parsed.data.newPublicKey };
    },
  );

  /** Change username. Both derivation domains include the name, so this re-keys
   *  exactly like a password change - and the new name must be free. */
  app.post(
    '/api/me/username',
    {
      preHandler: [
        requireUser(db),
        rateLimit({ name: 'namechange', limit: 5, windowMs: 60 * 60_000, by: 'user' }),
      ],
    },
    async (req, reply) => {
      const parsed = z
        .object({
          username: usernameSchema,
          currentAuthKey: authKeySchema,
          newAuthKey: authKeySchema,
          newPublicKey: publicKeySchema,
        })
        .safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: '2-24 characters, letters, numbers and _ only' });
      }
      const me = secretsFor(db, req.userId);
      if (!me) return reply.code(404).send({ error: 'no such user' });
      if (!sameHash(hashAuthKey(parsed.data.currentAuthKey, me.auth_salt), me.auth_hash)) {
        return reply.code(403).send({ error: 'wrong password' });
      }
      if (seatedSomewhere(db, req.userId)) {
        return reply
          .code(409)
          .send({ error: 'stand up from your seat first - renaming re-keys your cards' });
      }
      const taken = db
        .prepare('SELECT 1 FROM users WHERE username = ? AND id != ?')
        .get(parsed.data.username, req.userId);
      if (taken) return reply.code(409).send({ error: 'that name is taken' });
      try {
        rekey(db, req.userId, parsed.data.newAuthKey, parsed.data.newPublicKey, bearer(req), {
          username: parsed.data.username,
        });
      } catch (e) {
        // the uniqueness check above races; the UNIQUE index is the real referee
        if (e instanceof Error && e.message.includes('UNIQUE')) {
          return reply.code(409).send({ error: 'that name is taken' });
        }
        throw e;
      }
      return { ok: true, username: parsed.data.username, publicKey: parsed.data.newPublicKey };
    },
  );

  app.get('/api/me/recovery', authed, async (req) => {
    const me = secretsFor(db, req.userId);
    return { enabled: !!me?.recovery_hash, setAt: me?.recovery_set_at ?? null };
  });

  /** Recovery codes are issued automatically at signup and cannot be re-set
   *  from inside the app: the code is shown exactly once, the server keeps only
   *  its hash, and a self-serve re-arm would either rotate a code the user may
   *  not have saved or hand a borrowed session a fresh back door. Kept as a
   *  route (rather than deleted) so an old client gets a clear 403 instead of a
   *  blind 404. `GET` still answers whether a code is on file. */
  app.put('/api/me/recovery', authed, async (_req, reply) => {
    return reply
      .code(403)
      .send({ error: 'recovery codes are issued automatically at signup and cannot be changed' });
  });

  /** The forgotten-password door. Unauthenticated by nature, so it is throttled
   *  by IP and by the name being targeted, and answers identically whether or not
   *  the account exists. */
  app.post(
    '/api/recover',
    { preHandler: rateLimit({ name: 'recover-ip', limit: 10, windowMs: 15 * 60_000, by: 'ip' }) },
    async (req, reply) => {
      const parsed = z
        .object({
          username: usernameSchema,
          recoveryAuthKey: authKeySchema,
          newAuthKey: authKeySchema,
          newPublicKey: publicKeySchema,
        })
        .safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid input' });
      const perName = hitNamed('recover-name', parsed.data.username, 10, 15 * 60_000);
      if (!perName.ok) {
        return reply
          .code(429)
          .header('retry-after', String(perName.retryAfterSecs))
          .send({ error: `too many attempts - try again in ${perName.retryAfterSecs}s` });
      }

      // Validate + re-key + burn atomically; only one concurrent caller wins.
      const consumed = consumeRecoveryCode(
        db,
        parsed.data.username,
        parsed.data.recoveryAuthKey,
        parsed.data.newAuthKey,
        parsed.data.newPublicKey,
      );
      if (consumed.kind === 'invalid') {
        return reply.code(403).send({ error: 'that recovery code does not match' });
      }
      if (consumed.kind === 'seated') {
        return reply
          .code(409)
          .send({ error: 'you are seated at a table - leave the seat before recovering' });
      }
      if (consumed.kind === 'used') {
        return reply.code(409).send({ error: 'that recovery code was already used' });
      }

      forgive(`recover-name|n:${parsed.data.username.toLowerCase()}`);
      forgive(`recover-ip|ip:${req.ip}`);
      return {
        userId: consumed.userId,
        username: parsed.data.username,
        token: createSession(db, consumed.userId),
      };
    },
  );

  /** Ends this session server-side. Clearing localStorage never did that, so a
   *  token copied off a shared machine outlived the "log out" click. */
  app.post('/api/logout', authed, async (req) => {
    const token = bearer(req);
    if (token) endSession(db, token);
    return { ok: true };
  });

  /** Sign out every other device without changing anything else. */
  app.post('/api/me/sessions/revoke-others', authed, async (req) => {
    const token = bearer(req);
    const info = token
      ? db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.userId, token)
      : db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.userId);
    return { ok: true, revoked: info.changes };
  });

  app.get('/api/me/sessions', authed, async (req) => {
    const rows = db
      .prepare('SELECT token, created_at as createdAt FROM sessions WHERE user_id = ?')
      .all(req.userId) as { token: string; createdAt: number }[];
    const mine = bearer(req);
    // never hand back the raw tokens - a short fingerprint is enough to tell
    // "this one is the browser I am using right now" from the rest
    return {
      sessions: rows.map((r) => ({
        id: r.token.slice(0, 8),
        createdAt: r.createdAt,
        current: r.token === mine,
      })),
    };
  });
}
