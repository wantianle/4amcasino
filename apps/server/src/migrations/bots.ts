import type { DB } from '../db.js';
import { ensureColumn } from './util.js';

/**
 * Bot accounts (in-room robot opponents). `bot_accounts` is the single source
 * of truth for a bot - which user row is its independent account, its owner,
 * lifecycle status, policy, seat and encrypted signing identity. We deliberately
 * do not introduce or depend on a `users.is_bot` flag.
 *
 * The encrypted identity columns hold an AEAD-wrapped 32-byte signing seed
 * (AES-256-GCM, key from BOT_IDENTITY_KEY). Losing that key makes a bot's
 * identity unrecoverable, so callers must fail closed rather than mint a new one.
 */
export function migrateBots(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_accounts (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      owner_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL UNIQUE,
      status TEXT NOT NULL,
      policy_kind TEXT NOT NULL,
      policy_json TEXT,
      seat INTEGER,
      identity_ct TEXT,
      identity_nonce TEXT,
      identity_tag TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      stopped_at INTEGER,
      stop_requested_at INTEGER,
      delete_requested_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_bot_accounts_room ON bot_accounts(room_id);
    CREATE INDEX IF NOT EXISTS idx_bot_accounts_owner ON bot_accounts(owner_id);
  `);
  // Effective difficulty tier (`low` | `medium`), orthogonal to `policy_kind`.
  // Added by ensureColumn rather than in the CREATE above so an existing DB gets
  // it without a rewrite. The column default is `medium` (the rules-v1 engine,
  // now the product default); `migrateBotDifficulty` then flips any pre-existing
  // row. The withdrawn `high` is no longer writable (see botRoutes.ts) but a
  // legacy persisted `high` is still readable and is upgraded here too.
  ensureColumn(db, 'bot_accounts', 'difficulty', "TEXT NOT NULL DEFAULT 'medium'");
  // Set the moment a DELETE asks for a bot to be hard-deleted. A live runner
  // must fold and leave its seat first, so the row is parked `stopping`; this
  // marker is what makes the deletion durable across that async wind-down (and
  // across a crash/restart) instead of a deletion that can silently be lost.
  ensureColumn(db, 'bot_accounts', 'delete_requested_at', 'INTEGER');
  // Internal bot-runner grants are ordinary `agent_grants` rows distinguished by
  // grant_kind='bot_runner' and bot_id, so they reuse the whole agent-grant
  // pipeline (token hashing, scope membership, revocation). They are the only
  // grants the server still creates; the external grant-mint API is gone.
  ensureColumn(db, 'agent_grants', 'grant_kind', "TEXT NOT NULL DEFAULT 'user'");
  ensureColumn(db, 'agent_grants', 'bot_id', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_agent_grants_bot ON agent_grants(bot_id)');
  migrateBotDifficulty(db);
}

/**
 * Difficulty default cut-over, made one-shot by a `meta` marker.
 *
 * "Don't stay backward compatible": bots created under the old `low` default
 * are upgraded to `medium`. The DB cannot tell an old default `low` from a
 * `low` a user explicitly picked, so this runs exactly once: after
 * `bot-difficulty-medium-1` is written, a deliberate `low` is left alone across
 * restarts. The marker check, the UPDATE and the marker write share one
 * immediate (write-locked) transaction, mirroring the other one-shot
 * migrations - a crash between the UPDATE and the marker, or two servers
 * starting at once, must not re-run the cut-over and clobber a chosen `low`.
 *
 * The withdrawn `high` tier is handled differently. It is no longer writable
 * (the API rejects it with 400), so it can only be a legacy row - or, briefly,
 * one written by an old server during a mixed-version rolling deploy. It
 * resolves to `medium` anyway, but we normalise any lingering `high` on every
 * boot rather than only once, so no stored `high` survives the marker. That is
 * a bounded update over `bot_accounts` (one row per robot) and matches nothing
 * once the legacy rows are gone. Unknown values are left untouched (the
 * resolver already falls back to `medium`).
 */
export function migrateBotDifficulty(db: DB): void {
  const MARKER = 'bot-difficulty-medium-1';
  // `meta` is installed by `migrate()` on the real boot path; `migrateBots`
  // (and therefore this function) is also exercised standalone by the
  // migration tests, so ensure it exists rather than assuming an ancestor did.
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  db.transaction(() => {
    // Always-on: `high` must never persist, even when the marker already
    // exists (the API cannot produce one any more, but a legacy row or an old
    // server's write during a rolling deploy can).
    db.prepare("UPDATE bot_accounts SET difficulty = 'medium' WHERE difficulty = 'high'").run();
    if (db.prepare('SELECT value FROM meta WHERE key = ?').get(MARKER)) return;
    // One-shot: only the `low` rows that existed before this boot's marker are
    // the old default. After the marker, `low` is a legitimate user choice.
    db.prepare("UPDATE bot_accounts SET difficulty = 'medium' WHERE difficulty = 'low'").run();
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(MARKER, '1');
  }).immediate();
}
