import Database from 'better-sqlite3';
import {
  NEW_ROOM_COMMISSION_BPS,
  MAX_QUALIFYING_HANDS,
  DEFAULT_BET_RATIOS,
  sanitizeBetRatios,
} from '@4am/shared';
import { computeHead } from '@4am/mental-poker';
import {
  initializePlatformSettings,
  migrateRoomCommissionDefaults,
} from './platformSettings.js';
import { migrateRoomFeatureDefaults } from './gameplaySettings.js';
import { migrateAgentPlatform } from './agentSchema.js';
import { migrateHandStats, SEVEN_DEUCE_SHOW_KIND } from './handProjection.js';
import { verifyLedger } from './ledger.js';

export type DB = Database.Database;

/** How long a login lasts. Long enough that a weekly game never re-authenticates
 *  mid-session, short enough that a leaked token eventually dies. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Rewrite every stored quick-bet-ratio list that is not the current five-slot
 *  shape to the five-slot default. The old format allowed four slots and read
 *  them back untouched forever, so accounts created before the fifth slot
 *  existed would keep a four-button action bar. Runs on every boot and is
 *  idempotent by construction: a valid five-slot save is left byte-for-byte
 *  alone (JSON round-trips unchanged), so re-running never clobbers a player's
 *  real pick. Damaged/foreign JSON also resolves to the default. */
export function migrateBetRatios(db: DB): void {
  const rows = db
    .prepare('SELECT id, bet_ratios FROM users WHERE bet_ratios IS NOT NULL')
    .all() as { id: number; bet_ratios: string }[];
  if (rows.length === 0) return;
  const rewrite = db.prepare('UPDATE users SET bet_ratios = ? WHERE id = ?');
  const defaultJson = JSON.stringify(DEFAULT_BET_RATIOS);
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.bet_ratios);
    } catch {
      parsed = null;
    }
    // `sanitizeBetRatios` returns the input untouched when it is already the
    // five-slot shape, so a string mismatch means this row needs migrating.
    if (JSON.stringify(sanitizeBetRatios(parsed)) !== JSON.stringify(parsed)) {
      rewrite.run(defaultJson, row.id);
    }
  }
}

export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Give a competing writer (another server process opening the same file at
  // the same time) room to finish before SQLITE_BUSY is raised. The one-time
  // migrations below take an immediate write lock; without this wait the loser
  // of a startup race would fail outright instead of waiting its turn.
  db.pragma('busy_timeout = 10000');
  migrate(db);
  migrateAgentPlatform(db);
  // Runs after the agent platform so `agent_grants` already exists when the bot
  // columns are added to it.
  migrateBots(db);
  // Normalized hand-stats projection tables (pure additions - never touches
  // transcripts/ledger/hand_settlements).
  migrateHandStats(db);
  // Reconcile hand_lifecycle for a database that predates the lifecycle table.
  // MUST run after migrateHandStats: the reconciliation reads `hands` /
  // `hand_players`, which the stats migration creates.
  reconcileMissingSettlements(db);
  // Platform-admin audit trail (pure addition - one row per successful admin
  // action; never touches any existing table).
  migrateAdminAudit(db);
  return db;
}

/**
 * The platform admin's own paper trail: one append-only row for every
 * successful administrative action (user disable/enable/password reset, room
 * archive/unarchive/delete, account merges). Nothing here
 * is ever updated or deleted. `detail` is a small JSON blob of the fields that
 * matter for that action (e.g. `{"mode":"initial"}`); `target_type`/`target_id`
 * say what it acted on so the log can be filtered by target. Operator is the
 * platform user id rather than a free-text name.
 */
export function migrateAdminAudit(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operator_user_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      detail TEXT,
      ts INTEGER NOT NULL
    );
    -- Newest-first reads are the default listing; (ts DESC, id DESC) matches
    -- the paging ORDER BY exactly. action and target_id are the two filters the
    -- console exposes, each with an index of its own.
    CREATE INDEX IF NOT EXISTS idx_admin_audit_ts ON admin_audit(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_audit_ts_id ON admin_audit(ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit(action);
    CREATE INDEX IF NOT EXISTS idx_admin_audit_action_ts ON admin_audit(action, ts DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_audit_target_id ON admin_audit(target_id);
    CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit(target_type, target_id);
  `);
}

/**
 * Appends one row to the admin audit trail. This is a plain synchronous INSERT
 * on whatever connection the caller passes, so a call made from inside a
 * `db.transaction(...)` body commits (or rolls back) with the business change
 * it records - the intended usage. Kept in db.ts rather than admin.ts so the
 * admin, settings, sponsor and tournament routes can all share it without an
 * import cycle. `detail` is JSON-encoded only when provided.
 */
export function writeAdminAudit(
  db: DB,
  operatorUserId: number,
  action: string,
  targetType: string | null,
  targetId: string | null,
  detail?: unknown,
): void {
  db.prepare(
    `INSERT INTO admin_audit (operator_user_id, action, target_type, target_id, detail, ts)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    operatorUserId,
    action,
    targetType,
    targetId,
    detail === undefined ? null : JSON.stringify(detail),
    Date.now(),
  );
}

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
      stop_requested_at INTEGER
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
  // Internal bot-runner grants are ordinary `agent_grants` rows distinguished by
  // grant_kind='bot_runner' and bot_id, so they reuse the whole agent-token
  // pipeline (hashing, scope membership, revocation) without ever showing up in
  // a user's own grant list.
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

function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      auth_hash TEXT NOT NULL,
      auth_salt TEXT NOT NULL,
      pubkey TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      join_code TEXT NOT NULL UNIQUE,
      host_id INTEGER NOT NULL,
      banker_id INTEGER NOT NULL,
      sb INTEGER NOT NULL,
      bb INTEGER NOT NULL,
      audit_mode TEXT NOT NULL DEFAULT 'private',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS room_players (
      room_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      seat INTEGER,
      stack INTEGER NOT NULL DEFAULT 0,
      sitting_out INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (room_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      delta INTEGER NOT NULL,
      kind TEXT NOT NULL,
      approved_by INTEGER,
      note TEXT,
      ref TEXT,
      ts INTEGER NOT NULL,
      prev_hash TEXT NOT NULL,
      entry_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS buy_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS transcripts (
      hand_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      head TEXT NOT NULL,
      entries TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
  `);
  ensureColumn(db, 'users', 'display_name', 'TEXT');
  ensureColumn(db, 'users', 'bio', 'TEXT');
  ensureColumn(db, 'users', 'avatar', 'BLOB');
  ensureColumn(db, 'users', 'avatar_mime', 'TEXT');
  ensureColumn(db, 'users', 'avatar_version', 'INTEGER NOT NULL DEFAULT 0');
  // Only the DEFAULT for newly added columns/rows: `ensureColumn` adds a column
  // solely when it is missing, so an existing table with the old default and an
  // existing user's saved value are never rewritten by this migration.
  ensureColumn(db, 'users', 'card_back', "TEXT NOT NULL DEFAULT 'crimson'");
  ensureColumn(db, 'users', 'four_color', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'users', 'card_face', "TEXT NOT NULL DEFAULT 'gg-four-color'");
  ensureColumn(db, 'users', 'table_skin', "TEXT NOT NULL DEFAULT 'gg-green'");
  ensureColumn(db, 'users', 'avatar3d', 'TEXT');
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  // One-time upgrade of the old boolean face preference. New writes use the
  // explicit card_face enum; the marker prevents a later explicit `minimal`
  // (or even `gg-four-color`) choice from being interpreted as an old row.
  db.transaction(() => {
    if (db.prepare("SELECT 1 FROM meta WHERE key = 'card-face-boolean-migration-1'").get()) return;
    // The retired boolean's `false` is the classic two-colour deck, exactly as
    // the pre-enum UI rendered it (`fourColor ? 'gg-four-color' : 'classic-large'`).
    // `gg-solid` is a separate new option a user picks deliberately; it is not a
    // migration target. A concurrent first startup would otherwise race on the
    // write lock, so take the immediate lock like the other one-shot migrations.
    db.prepare("UPDATE users SET card_face = 'classic-large' WHERE four_color = 0 AND card_face = 'gg-four-color'").run();
    db.prepare("INSERT INTO meta (key, value) VALUES ('card-face-boolean-migration-1', '1')").run();
  }).immediate();
  // heal balances damaged by the old absolute-stack settlement write (a buy
  // approved mid-hand was erased at hand end): the hash-chained ledger is the
  // source of truth, so recompute any stack that disagrees with it, once
  const healFlag = db.prepare("SELECT value FROM meta WHERE key = 'stack-ledger-heal-1'").get();
  if (!healFlag) {
    db.prepare(
      `UPDATE room_players SET stack = COALESCE((SELECT SUM(l.delta) FROM ledger l WHERE l.room_id = room_players.room_id AND l.user_id = room_players.user_id), 0)
       WHERE stack != COALESCE((SELECT SUM(l.delta) FROM ledger l WHERE l.room_id = room_players.room_id AND l.user_id = room_players.user_id), 0)`,
    ).run();
    db.prepare("INSERT INTO meta (key, value) VALUES ('stack-ledger-heal-1', '1')").run();
  }
  ensureColumn(db, 'users', 'quick_phrases', 'TEXT');
  ensureColumn(db, 'rooms', 'action_secs', 'INTEGER');
  ensureColumn(db, 'rooms', 'co_banker_id', 'INTEGER');
  ensureColumn(db, 'rooms', 'min_settle_hands', 'INTEGER NOT NULL DEFAULT 0');
  db.prepare('UPDATE rooms SET min_settle_hands = ? WHERE min_settle_hands > ?').run(
    MAX_QUALIFYING_HANDS,
    MAX_QUALIFYING_HANDS,
  );
  // New rooms auto-approve buy-ins by default; the host/banker can still gate
  // them per room (the settings toggle is unchanged). For a room that already
  // exists the column keeps its old default, so the one-shot
  // `room-defaults-on-1` migration flips existing rows.
  ensureColumn(db, 'rooms', 'auto_approve_buys', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'rooms', 'seven_deuce_bonus', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'users', 'private_mode', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'users', 'last_seen', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'users', 'auto_join_invites', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'rooms', 'voided', 'INTEGER NOT NULL DEFAULT 0');
  // Archiving retires a finished table: it leaves the room list, stops dealing,
  // and its results stop counting towards stats. Nothing is deleted - the
  // ledger and every transcript stay readable, and money still owed between
  // players stays owed. Applied by `/api/rooms/:id/close` and the platform's
  // direct admin room controls.
  ensureColumn(db, 'rooms', 'archived', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'rooms', 'archived_at', 'INTEGER');
  // Deletion, like archiving, is soft: rows are never dropped. Applied
  // directly by the platform's admin room controls.
  ensureColumn(db, 'rooms', 'deleted', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'rooms', 'deleted_at', 'INTEGER');
  ensureColumn(db, 'rooms', 'meet_link', 'TEXT');
  ensureColumn(db, 'rooms', 'visibility', "TEXT NOT NULL DEFAULT 'private'");
  ensureColumn(db, 'rooms', 'spectate_token', 'TEXT');
  ensureColumn(db, 'rooms', 'allow_spectators', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'rooms', 'tv_replays', 'INTEGER NOT NULL DEFAULT 1');
  // Existing rooms already continued automatically after hands.
  ensureColumn(db, 'rooms', 'auto_deal', 'INTEGER NOT NULL DEFAULT 1');
  // Install the original per-room schema before the runtime settings migration.
  // Install and backfill atomically so a restart cannot mistake old rooms for new ones.
  // A room entering this path (pre-room-level-commission schema) gets the
  // CURRENT rate from the column default; the old 1% backfill is gone. Rooms on
  // a schema that already has the column are handled once by
  // `migrateRoomCommissionDefaults` below.
  db.transaction(() => {
    const columns = db.pragma('table_info(rooms)') as { name: string }[];
    if (!columns.some((c) => c.name === 'commission_bps')) {
      ensureColumn(
        db,
        'rooms',
        'commission_bps',
        `INTEGER NOT NULL DEFAULT ${NEW_ROOM_COMMISSION_BPS}`,
      );
    }
  })();
  initializePlatformSettings(db);
  // Existing installs already have a platform_settings row, so
  // initializePlatformSettings leaves their rooms at the old 1%; this one-shot
  // marker migration moves them (and only them) to the current rate.
  migrateRoomCommissionDefaults(db);
  ensureColumn(db, 'users', 'show_best_hand', 'INTEGER NOT NULL DEFAULT 1');
  // "deal me in without asking every hand" is the default now: the server
  // auto-marks auto-ready players the moment the ready window opens. A player
  // can still turn it off (PUT /api/profile). `ensureColumn` only installs the
  // column for a fresh DB - an existing DB keeps its old default, so new
  // signups are written explicitly in `createUser` (old rows are never touched).
  ensureColumn(db, 'users', 'auto_ready', 'INTEGER NOT NULL DEFAULT 1');
  // One-time data migration, keyed in `meta` like stack-ledger-heal-1 above.
  // `auto_ready` historically defaulted to 0 and `ensureColumn` only adds a
  // column when it is missing, so flipping the DEFAULT to 1 in the source never
  // reached accounts created before the change: they were still stored as 0 and
  // `beginReadyCheck` therefore left them out of the auto-ready set, forcing a
  // manual tap every hand. Flip those rows exactly once. After the flag is in
  // `meta`, a later explicit opt-out (PUT /api/profile writes 0) is never
  // re-flipped on the next start. The column definition itself is untouched.
  // The check, the UPDATE and the marker write must be ONE immediate
  // (write-locked) transaction. Kept separate they had two holes: a crash after
  // the UPDATE committed but before the marker did would re-run the UPDATE on
  // the next start and could clobber a manual opt-out, and two servers opening
  // the same file at once could double-update or collide on the marker's
  // primary key. BEGIN IMMEDIATE takes the write lock up front - waiting up to
  // busy_timeout (10s, set in openDb) for the other process - so the second
  // starter reads the committed marker and skips. Same `.immediate()` style as
  // the rest of the codebase (auth.ts, tournaments.ts, ...).
  const AUTO_READY_MARKER = 'auto-ready-default-on-1';
  db.transaction(() => {
    const autoReadyFlag = db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get(AUTO_READY_MARKER);
    if (autoReadyFlag) return;
    db.prepare('UPDATE users SET auto_ready = 1 WHERE auto_ready = 0').run();
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(AUTO_READY_MARKER, '1');
  }).immediate();
  ensureColumn(db, 'users', 'poker_hotkeys', 'TEXT');
  // Quick-bet ratios (A10): five table action-bar slots, stored as a JSON
  // array of pot fractions (with -1 as the all-in sentinel).
  ensureColumn(db, 'users', 'bet_ratios', 'TEXT');
  // One-time data migration: accounts that saved the older four-slot list (or
  // any damaged/foreign value) are rewritten to the current five-slot default
  // so the action bar never renders a stale shape. Idempotent, see the
  // function comment.
  migrateBetRatios(db);
  // account recovery: hash of the one-time recovery code, salted like a password
  // (requested by notpritam, docs/FEATURES.md)
  // Signup order, as its own fact rather than something inferred from the
  // primary key. `id` happens to be sequential today, but it is an
  // implementation detail: a restore, a merge, or a deleted row puts gaps in it,
  // and then "member #7" would quietly change meaning. This column never does.
  ensureColumn(db, 'users', 'join_number', 'INTEGER');
  db.exec(`
    UPDATE users SET join_number = (
      SELECT COUNT(*) FROM users u2
      WHERE u2.created_at < users.created_at
         OR (u2.created_at = users.created_at AND u2.id <= users.id)
    ) WHERE join_number IS NULL
  `);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_join_number ON users(join_number)');
  ensureColumn(db, 'users', 'recovery_hash', 'TEXT');
  ensureColumn(db, 'users', 'recovery_salt', 'TEXT');
  ensureColumn(db, 'users', 'recovery_set_at', 'INTEGER');
  ensureColumn(db, 'sessions', 'last_used', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'sessions', 'label', 'TEXT');
  // Sessions used to be immortal: nothing wrote an expiry and nothing swept the
  // table, so a token lifted from a log line or a backup stayed live forever.
  // Existing rows are grandfathered a full window rather than logged out on deploy.
  ensureColumn(db, 'sessions', 'expires_at', 'INTEGER NOT NULL DEFAULT 0');
  db.prepare('UPDATE sessions SET expires_at = ? WHERE expires_at = 0').run(
    Date.now() + SESSION_TTL_MS,
  );
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.exec(`
    CREATE TABLE IF NOT EXISTS settlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL,
      low_user INTEGER NOT NULL,
      high_user INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      debtor INTEGER NOT NULL,
      confirmed_low INTEGER NOT NULL DEFAULT 0,
      confirmed_high INTEGER NOT NULL DEFAULT 0,
      created_ts INTEGER NOT NULL,
      settled_ts INTEGER
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS friends (
      requester_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (requester_id, target_id)
    );
    CREATE TABLE IF NOT EXISTS spectators (
      room_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      PRIMARY KEY (room_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS join_requests (
      id INTEGER PRIMARY KEY,
      room_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invites (
      id INTEGER PRIMARY KEY,
      room_id TEXT NOT NULL,
      from_id INTEGER NOT NULL,
      to_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      ts INTEGER NOT NULL
    );
  `);
  db.exec(`
    -- What each side said when they marked a debt settled: a remark, and
    -- optionally a photo of the transfer. One row per person per settlement, so
    -- both halves of the story are kept separately rather than overwriting.
    CREATE TABLE IF NOT EXISTS settlement_marks (
      settlement_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      note TEXT,
      proof BLOB,
      proof_mime TEXT,
      ts INTEGER NOT NULL,
      PRIMARY KEY (settlement_id, user_id)
    );
    -- Money owed to the house for keeping the servers up. Dues are derived from
    -- the rake the ledger already records; this table is only the paying side.
    CREATE TABLE IF NOT EXISTS house_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      note TEXT,
      proof BLOB,
      proof_mime TEXT,
      ts INTEGER NOT NULL,
      confirmed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_house_payments_user ON house_payments(user_id);
  `);
  db.exec(`
    -- LEGACY: once held host/banker archive/unarchive/delete requests that a
    -- platform admin approved. Self-serve retirement was removed in favour of
    -- the one-click POST /api/rooms/:id/close plus the platform's direct admin
    -- room controls. The table is kept (never dropped) for schema/history
    -- compatibility, but nothing writes or reads it any more.
    CREATE TABLE IF NOT EXISTS room_lifecycle_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL,
      action TEXT NOT NULL,            -- 'archive' | 'unarchive' | 'delete'
      requested_by INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'rejected'
      note TEXT,
      created_at INTEGER NOT NULL,
      decided_at INTEGER,
      decided_by INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_lifecycle_status ON room_lifecycle_requests(status);
  `);
  // The schema had no indexes at all, so every ledger and transcript read was a
  // full table scan - which is what turns "this table has played a lot of hands"
  // into "the settle-up page times out".
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_ledger_room ON ledger(room_id, id);
    CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id, kind);
    CREATE INDEX IF NOT EXISTS idx_ledger_ref ON ledger(ref);
    CREATE INDEX IF NOT EXISTS idx_transcripts_room ON transcripts(room_id, ts);
    CREATE INDEX IF NOT EXISTS idx_transcripts_head ON transcripts(head);
    CREATE INDEX IF NOT EXISTS idx_buyreq_room ON buy_requests(room_id, status);
    CREATE INDEX IF NOT EXISTS idx_roomplayers_user ON room_players(user_id);
    CREATE INDEX IF NOT EXISTS idx_invites_to ON invites(to_id, status);
    CREATE INDEX IF NOT EXISTS idx_joinreq_room ON join_requests(room_id, status);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_settlements_pair ON settlements(room_id, low_user, high_user);
  `);

  // Account merges: a disabled account's identity has been folded into
  // another (merged_into) and can no longer authenticate - see merge.ts.
  ensureColumn(db, 'users', 'disabled', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'users', 'merged_into', 'INTEGER');
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_merge_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_user INTEGER NOT NULL,
      into_user INTEGER NOT NULL,
      requested_by INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      note TEXT,
      created_at INTEGER NOT NULL,
      decided_at INTEGER,
      decided_by INTEGER
    );
  `);

  // ---- new-gameplay room settings (squid / time bank / bomb pot / multi-run) --
  // Each feature is independent: a room can switch one on without the others.
  // All four are ON for a new room (the new-gameplay default); a host can still
  // turn any of them off. The numeric defaults mirror the shared
  // RoomGameplaySettings defaults except where the orchestrator specified
  // otherwise (e.g. 3 min squid players). Rooms created before the default-on
  // policy keep the old `0`s because `ensureColumn` never rewrites an existing
  // column; `migrateRoomFeatureDefaults` flips those rows once.
  ensureColumn(db, 'rooms', 'squid_enabled', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'rooms', 'squid_penalty_bb', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'rooms', 'squid_min_players', 'INTEGER NOT NULL DEFAULT 3');
  ensureColumn(db, 'rooms', 'time_bank_enabled', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'rooms', 'time_bank_initial_secs', 'INTEGER NOT NULL DEFAULT 30');
  ensureColumn(db, 'rooms', 'time_bank_refill_every_hands', 'INTEGER NOT NULL DEFAULT 30');
  ensureColumn(db, 'rooms', 'time_bank_refill_secs', 'INTEGER NOT NULL DEFAULT 30');
  // Bumped on every time-bank config change so in-flight hands and clients can
  // tell a stale snapshot from the current configuration.
  ensureColumn(db, 'rooms', 'time_bank_epoch', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'rooms', 'bomb_pot_enabled', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'rooms', 'bomb_pot_ante_bb', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'rooms', 'bomb_pot_schedule_mode', "TEXT NOT NULL DEFAULT 'hands'");
  ensureColumn(db, 'rooms', 'bomb_pot_schedule_value', 'INTEGER NOT NULL DEFAULT 10');
  ensureColumn(db, 'rooms', 'multi_run_enabled', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'rooms', 'multi_run_max_runs', 'INTEGER NOT NULL DEFAULT 3');
  // Per-player time bank snapshot. The epoch stamps which config the ms/hands
  // belong to; a stale epoch means the row predates the current settings.
  ensureColumn(db, 'room_players', 'time_bank_ms', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'room_players', 'time_bank_hands', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'room_players', 'time_bank_epoch', 'INTEGER NOT NULL DEFAULT 0');
  db.exec(`
    -- Durable finalization marker. The engine inserts this row in the SAME
    -- transaction as every stack/ledger/trigger/transcript/anchor mutation, so
    -- a duplicate or replayed finalize sees the marker and applies nothing.
    -- Its presence is also the authoritative "this hand fully settled" signal
    -- used by startup recovery instead of transcript existence.
    CREATE TABLE IF NOT EXISTS hand_settlements (
      hand_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      head TEXT NOT NULL,
      rake INTEGER NOT NULL DEFAULT 0,
      final_stacks TEXT NOT NULL DEFAULT '[]',
      applied_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hand_settlements_room ON hand_settlements(room_id);
    -- Durable hand lifecycle. A 'running' row is written in the SAME
    -- transaction that claims a hand's feature triggers, i.e. before the first
    -- card is dealt. applyHandSettlement marks it 'committed' in its own
    -- transaction; a normal pre-settlement abort marks it 'aborted'; a graceful
    -- shutdown drains the room and aborts a still-live hand. A row left
    -- running/prepared/quarantined across a restart is the authoritative
    -- "dealt but never settled" signal. It is deliberately stronger than
    -- "transcript without a marker": the settlement transaction writes the
    -- transcript, the marker and this row together, so a rolled-back write
    -- leaves the 'running' row behind and no transcript at all. 'legacy' is a
    -- retired status: pre-lifecycle transcripts are now reconciled against the
    -- ledger/projection and become 'committed' or 'quarantined'.
    CREATE TABLE IF NOT EXISTS hand_lifecycle (
      hand_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running','prepared','committed','aborted','quarantined','legacy')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      resolved_at INTEGER,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_hand_lifecycle_room ON hand_lifecycle(room_id, status);
    -- Progress the game engine keeps for the scheduled features. Kept in its own
    -- row (one per room) so settings writes never race the hand loop.
    CREATE TABLE IF NOT EXISTS room_gameplay_state (
      room_id TEXT PRIMARY KEY,
      completed_hands INTEGER NOT NULL DEFAULT 0,
      last_bomb_completed_hands INTEGER NOT NULL DEFAULT 0,
      last_bomb_at INTEGER,
      schedule_reset_at INTEGER
    );
    -- A request to start squid/bomb, however it was raised. source records who
    -- asked (a host tap, the hand counter, or the clock); status tracks it
    -- through claim -> apply. The partial unique index allows at most one pending
    -- trigger of a kind per room while letting resolved history pile up.
    CREATE TABLE IF NOT EXISTS room_feature_triggers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('squid', 'bomb')),
      source TEXT NOT NULL CHECK (source IN ('manual', 'timed-hands', 'timed-duration')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'applied', 'cancelled')),
      requested_by INTEGER,
      created_at INTEGER NOT NULL,
      claimed_hand_id TEXT,
      resolved_at INTEGER,
      UNIQUE(room_id, request_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_feature_triggers_pending
      ON room_feature_triggers(room_id, kind) WHERE status = 'pending';
    -- Pending lookups (e.g. "what should this hand run?") stay cheap as the
    -- resolved history grows.
    CREATE INDEX IF NOT EXISTS idx_feature_triggers_room
      ON room_feature_triggers(room_id, status);
  `);
  recoverOrphanedFeatureTriggers(db);
  // Existing rooms predate the default-on policy and store the old `0`s (the
  // column DEFAULTs only shape brand-new databases). Flip them once, after
  // every feature/time-bank column exists, so applyRoomFeatures can reset the
  // time banks correctly.
  migrateRoomFeatureDefaults(db);
}

/**
 * Strict, time-independent reconciliation of the transcripts that predate (or
 * otherwise escaped) the atomic lifecycle protocol.
 *
 * A `hand_settlements` marker, when it agrees with the transcript and the room,
 * is proof the hand committed. A transcript WITHOUT a marker cannot be assumed
 * settled - it may be an old non-atomic finalize that wrote the transcript and
 * then crashed before the marker - so every money leg it implies must be present
 * and close exactly against the stats projection and the ledger hash chain. All
 * checks pass -> `committed` (recorded with `last_error = 'legacy reconciled'`
 * for auditability); any check fails -> `quarantined` (gates dealing).
 *
 * This intentionally does NOT use the previous `ts < cutoff -> legacy` rule: a
 * process wall-clock cutoff is not a protocol boundary, so a half-settled hand,
 * a skewed/rewound clock or an unparsable cutoff could all be whitelisted. The
 * reconciliation also re-runs on every open, so a markerless transcript can
 * never slip past the deal-time gate.
 *
 * NOTE (residual gap, out of scope this round): the reconciliation proves the
 * transcript, ledger and stats projection agree with each other. It does NOT
 * anchor to the wallet history - it does not rebuild each account's balance in
 * ledger order nor check `room_players.stack`. A hand that wrote
 * transcript/ledger/projection and then crashed BEFORE the stack update would
 * still reconcile to `committed`. Wallet anchoring is tracked separately.
 */

/** A single transcript's reconciliation verdict. */
export interface TranscriptReconcile {
  ok: boolean;
  reason: string;
}

/** Read-only audit of the reconciliation an upgrade would perform. */
export interface MarkerlessAudit {
  /** Total transcripts examined. */
  transcripts: number;
  /** Transcripts with no `hand_settlements` marker. */
  markerless: number;
  /** Markerless transcripts whose legs close exactly -> would be `committed`. */
  reconciled: number;
  /** Transcripts whose lifecycle row a consistent marker moved to `committed`
   *  (including overriding a stale running/quarantined/legacy/aborted row). */
  committedFromMarker: number;
  /** Markers that disagree with the transcript/room -> would be `quarantined`. */
  markerConflicts: { handId: string; roomId: string; reason: string }[];
  /** Markerless transcripts that fail a check -> would be `quarantined`. */
  quarantined: { handId: string; roomId: string; reason: string }[];
  /** Transcripts that already carry a terminal lifecycle row (skipped). */
  alreadyClassified: number;
}

function tableExists(db: DB, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

function failReconcile(reason: string): TranscriptReconcile {
  return { ok: false, reason };
}

interface ParsedSettlement {
  entries: unknown[];
  rake: number;
}

/** Parse a transcript's single `settlement` entry and its non-negative integer
 *  rake. Returns a string reason when the transcript is not trustworthy enough
 *  to reconcile. Rake is treated as an untrusted data boundary: a present but
 *  non-integer/negative commission rejects the whole transcript. */
function parseSettlementEntry(entriesJson: string): ParsedSettlement | string {
  let entries: unknown;
  try {
    entries = JSON.parse(entriesJson);
  } catch {
    return 'transcript entries are not valid JSON';
  }
  if (!Array.isArray(entries)) return 'transcript entries are not an array';
  const settlements = (entries as { type?: unknown }[]).filter(
    (e) => e !== null && typeof e === 'object' && (e as { type?: unknown }).type === 'settlement',
  );
  if (settlements.length !== 1)
    return `expected exactly one settlement entry, found ${settlements.length}`;
  const payload = (settlements[0] as { payload?: unknown }).payload;
  if (!payload || typeof payload !== 'object') return 'settlement entry has no payload';
  const commission = (payload as { commission?: unknown }).commission;
  if (commission === undefined) return { entries: entries as unknown[], rake: 0 };
  if (typeof commission !== 'number' || !Number.isInteger(commission) || commission < 0)
    return `settlement commission is not a non-negative integer (${String(commission)})`;
  return { entries: entries as unknown[], rake: commission };
}

/**
 * The strict per-transcript check. Read-only. A transcript is trusted only when
 * its transcript chain, its settlement legs, its stats projection and its room
 * all agree.
 *
 * Conditions (all required):
 *  1. one `settlement` entry whose entries' hash chain reproduces the stored
 *     `head`, with a non-negative integer rake;
 *  2. the only ledger kinds are hand-settlement / squid-game / commission on the
 *     head and seven-deuce (automatic bounty) / seven-deuce-show (voluntary
 *     post-settlement show) on the hand id, no duplicate leg on either key. The
 *     voluntary show is NOT reconciled against the transcript/projection: it is
 *     a post-settlement transfer outside `net_delta`, so it is tolerated on the
 *     hand-id ref but excluded from every leg check below;
 *  3. every hand-settlement / squid-game / seven-deuce user is a seat in the
 *     hand's `hand_players` (commission is the sole out-of-hand leg);
 *  4. rake > 0 -> exactly one commission leg, credited to a real room account;
 *     rake === 0 -> no commission leg;
 *  5. seven-deuce is a well-formed zero-sum bounty: one positive winner leg,
 *     >=1 payer, payers exactly fund the winner;
 *  6. a trusted stats projection exists for the SAME room, anchored to the same
 *     head, `projection_status = 'ok'`, non-negative integer rake matching;
 *  7. per player `net_delta` equals the ledger legs, `poker_delta` equals
 *     hand-settlement + seven-deuce, and
 *     `ending_stack - starting_stack === net_delta + commission`;
 *  8. `sum(net_delta) === -rake` and the room ledger hash chain is valid.
 *
 * Mid-hand buys are an intervening account delta: a markerless hand that was
 * bought into mid-hand fails (7) and is quarantined rather than guessed at.
 */
export function reconcileTranscript(
  db: DB,
  t: { hand_id: string; room_id: string; head: string; entries: string },
): TranscriptReconcile {
  if (!tableExists(db, 'hands') || !tableExists(db, 'hand_players'))
    return failReconcile('stats projection tables are missing');

  const parsed = parseSettlementEntry(t.entries);
  if (typeof parsed === 'string') return failReconcile(parsed);
  const { entries, rake } = parsed;
  if (computeHead(entries as never) !== t.head)
    return failReconcile('transcript head does not match its entry chain');

  // (2) ref-domain isolation: the settlement-head ref may carry ONLY the three
  // settlement kinds, and the hand-id ref may carry ONLY the bounty kinds
  // (automatic `seven-deuce` and the voluntary `seven-deuce-show`). Any other
  // kind on either key is an unexplained money leg (or a kind smuggled under the
  // wrong ref, e.g. `commission` with `ref = hand_id`) and quarantines the hand.
  const badKind = db
    .prepare(
      `SELECT kind FROM ledger WHERE room_id = ? AND ref = ?
        AND kind NOT IN ('hand-settlement','squid-game','commission') LIMIT 1`,
    )
    .get(t.room_id, t.head) as { kind: string } | undefined;
  if (badKind) return failReconcile(`unexpected ledger kind '${badKind.kind}' on the settlement head`);
  const badHandRef = db
    .prepare(
      `SELECT kind FROM ledger WHERE room_id = ? AND ref = ? AND kind NOT IN ('seven-deuce', ?) LIMIT 1`,
    )
    .get(t.room_id, t.hand_id, SEVEN_DEUCE_SHOW_KIND) as { kind: string } | undefined;
  if (badHandRef)
    return failReconcile(`unexpected ledger kind '${badHandRef.kind}' on the hand-id ref`);
  const dup = db
    .prepare(
      `SELECT user_id, kind, COUNT(*) AS c FROM ledger
        WHERE room_id = ? AND (ref = ? OR (kind = 'seven-deuce' AND ref = ?))
        GROUP BY user_id, kind HAVING c > 1 LIMIT 1`,
    )
    .get(t.room_id, t.head, t.hand_id) as { user_id: number; kind: string } | undefined;
  if (dup) return failReconcile(`duplicate ${dup.kind} leg for user ${dup.user_id}`);

  const legs = db
    .prepare(
      `SELECT user_id, kind, delta FROM ledger
        WHERE room_id = ? AND (ref = ? OR (kind = 'seven-deuce' AND ref = ?))`,
    )
    .all(t.room_id, t.head, t.hand_id) as { user_id: number; kind: string; delta: number }[];
  const sumKind = (kind: string) => legs.reduce((s, l) => (l.kind === kind ? s + l.delta : s), 0);
  const hs = sumKind('hand-settlement');
  const sq = sumKind('squid-game');
  const comm = sumKind('commission');
  const sd = sumKind('seven-deuce');

  // (6) trusted stats projection, scoped to the SAME room
  const hand = db
    .prepare(
      'SELECT room_id, source_head, rake, projection_status FROM hands WHERE hand_id = ?',
    )
    .get(t.hand_id) as
    | { room_id: string; source_head: string; rake: number; projection_status: string }
    | undefined;
  if (!hand) return failReconcile('no stats projection for the hand');
  if (hand.room_id !== t.room_id)
    return failReconcile(`projection room_id ${hand.room_id} != transcript room_id ${t.room_id}`);
  if (hand.source_head !== t.head) return failReconcile('projection source_head != transcript head');
  if (hand.projection_status !== 'ok')
    return failReconcile(`projection status '${hand.projection_status}' is not trustworthy`);
  if (!Number.isInteger(hand.rake) || hand.rake < 0)
    return failReconcile(`projection rake ${hand.rake} is not a non-negative integer`);
  if (hand.rake !== rake) return failReconcile(`projection rake ${hand.rake} != transcript rake ${rake}`);

  const players = db
    .prepare(
      'SELECT user_id, starting_stack, ending_stack, poker_delta, net_delta FROM hand_players WHERE hand_id = ?',
    )
    .all(t.hand_id) as {
    user_id: number;
    starting_stack: number | null;
    ending_stack: number | null;
    poker_delta: number;
    net_delta: number;
  }[];
  if (players.length === 0) return failReconcile('no hand_players projection rows');
  const playerIds = new Set(players.map((p) => p.user_id));

  // (3) every non-commission leg must belong to a seat in THIS hand.
  for (const l of legs) {
    if (l.kind === 'commission') continue;
    if (!playerIds.has(l.user_id))
      return failReconcile(`${l.kind} leg for user ${l.user_id} is not a seat in this hand`);
  }

  // (4) commission: exactly one real room account, only when a rake was taken.
  const commLegs = legs.filter((l) => l.kind === 'commission');
  if (rake > 0) {
    if (commLegs.length !== 1)
      return failReconcile(`expected exactly one commission leg, found ${commLegs.length}`);
    const recipient = commLegs[0]!.user_id;
    const account = db
      .prepare('SELECT 1 FROM room_players WHERE room_id = ? AND user_id = ?')
      .get(t.room_id, recipient);
    if (!account)
      return failReconcile(`commission recipient ${recipient} is not a room account`);
  } else if (commLegs.length > 0) {
    return failReconcile('no rake but a commission leg is present');
  }

  // (5) seven-deuce: a well-formed zero-sum bounty.
  const sdLegs = legs.filter((l) => l.kind === 'seven-deuce');
  if (sdLegs.length > 0) {
    const winners = sdLegs.filter((l) => l.delta > 0);
    const payers = sdLegs.filter((l) => l.delta < 0);
    if (winners.length !== 1)
      return failReconcile(`seven-deuce must have exactly one winner leg, found ${winners.length}`);
    if (payers.length === 0) return failReconcile('seven-deuce has a winner but no payer leg');
    const paid = payers.reduce((s, l) => s - l.delta, 0);
    if (paid !== winners[0]!.delta)
      return failReconcile(`seven-deuce payers ${paid} != winner ${winners[0]!.delta}`);
  }

  // (4b) leg closure
  if (hs !== -rake) return failReconcile(`hand-settlement legs sum ${hs} != -rake ${-rake}`);
  if (sq !== 0) return failReconcile(`squid-game legs sum ${sq} != 0`);
  if (comm !== rake) return failReconcile(`commission legs sum ${comm} != rake ${rake}`);
  if (sd !== 0) return failReconcile(`seven-deuce legs sum ${sd} != 0`);

  const legFor = (kind: string, userId: number) =>
    legs.reduce((s, l) => (l.kind === kind && l.user_id === userId ? s + l.delta : s), 0);
  let netSum = 0;
  for (const p of players) {
    // (7) per-player ledger closure, poker/bounty split and stack closure
    const netExpected =
      legFor('hand-settlement', p.user_id) +
      legFor('squid-game', p.user_id) +
      legFor('seven-deuce', p.user_id);
    if (p.net_delta !== netExpected)
      return failReconcile(`user ${p.user_id} net_delta ${p.net_delta} != ledger legs ${netExpected}`);
    const pokerExpected =
      legFor('hand-settlement', p.user_id) + legFor('seven-deuce', p.user_id);
    if (p.poker_delta !== pokerExpected)
      return failReconcile(
        `user ${p.user_id} poker_delta ${p.poker_delta} != hand-settlement + seven-deuce ${pokerExpected}`,
      );
    if (p.starting_stack === null || p.ending_stack === null)
      return failReconcile(`user ${p.user_id} projection has no stacks`);
    if (p.ending_stack - p.starting_stack !== p.net_delta + legFor('commission', p.user_id))
      return failReconcile(
        `user ${p.user_id} ending-starting != net_delta + commission (mid-hand buy or corruption)`,
      );
    netSum += p.net_delta;
  }
  // (8) table-level conservation and ledger hash chain
  if (netSum !== -rake) return failReconcile(`sum(net_delta) ${netSum} != -rake ${-rake}`);
  const chain = verifyLedger(db, t.room_id);
  if (!chain.ok) return failReconcile(`ledger hash chain invalid at id ${chain.badId}`);
  return { ok: true, reason: 'legacy reconciled' };
}

/**
 * Bring `hand_lifecycle` in line with the transcripts. Idempotent and safe to
 * run on every open:
 *
 *  - marker present and CONSISTENT with the transcript/room -> `committed`,
 *    overriding a stale `running` / `prepared` / `quarantined` / `legacy` row,
 *    and also an `aborted` row: the marker proves the settlement transaction
 *    committed, so an `aborted` row is a contradiction and the only safe
 *    resolution is `committed` (freeze) - never re-deal over a settled hand.
 *    An inconsistent marker is corruption and is quarantined, not trusted.
 *  - no marker and no lifecycle row, or a stale `legacy` row -> run the strict
 *    reconciliation and record `committed` / `quarantined`;
 *  - a terminal non-committed row with no marker -> leave it alone.
 *
 * `dryRun` performs every check but writes nothing, for the operator diagnostic.
 */
export function reconcileMissingSettlements(db: DB, opts: { dryRun?: boolean } = {}): MarkerlessAudit {
  const dryRun = opts.dryRun ?? false;
  const transcripts = db
    .prepare('SELECT hand_id, room_id, head, entries FROM transcripts')
    .all() as { hand_id: string; room_id: string; head: string; entries: string }[];
  const markers = new Map(
    (
      db
        .prepare('SELECT hand_id, room_id, head, rake FROM hand_settlements')
        .all() as { hand_id: string; room_id: string; head: string; rake: number }[]
    ).map((r) => [r.hand_id, r]),
  );
  const existing = new Map(
    (tableExists(db, 'hand_lifecycle')
      ? (db.prepare('SELECT hand_id, status FROM hand_lifecycle').all() as {
          hand_id: string;
          status: string;
        }[])
      : []
    ).map((r) => [r.hand_id, r.status]),
  );

  const audit: MarkerlessAudit = {
    transcripts: transcripts.length,
    markerless: 0,
    reconciled: 0,
    committedFromMarker: 0,
    markerConflicts: [],
    quarantined: [],
    alreadyClassified: 0,
  };
  const now = Date.now();
  const setCommitted = (handId: string, roomId: string, note: string | null) => {
    if (dryRun) return;
    db.prepare(
      `INSERT INTO hand_lifecycle (hand_id, room_id, status, created_at, updated_at, resolved_at, last_error)
       VALUES (?, ?, 'committed', ?, ?, ?, ?)
       ON CONFLICT(hand_id) DO UPDATE SET status = 'committed',
         updated_at = excluded.updated_at, resolved_at = excluded.resolved_at,
         last_error = excluded.last_error`,
    ).run(handId, roomId, now, now, now, note);
  };
  const setQuarantined = (handId: string, roomId: string, reason: string) => {
    if (dryRun) return;
    db.prepare(
      `INSERT INTO hand_lifecycle (hand_id, room_id, status, created_at, updated_at, resolved_at, last_error)
       VALUES (?, ?, 'quarantined', ?, ?, NULL, ?)
       ON CONFLICT(hand_id) DO UPDATE SET status = 'quarantined',
         updated_at = excluded.updated_at, resolved_at = NULL,
         last_error = excluded.last_error`,
    ).run(handId, roomId, now, now, reason);
  };
  const work = () => {
    for (const t of transcripts) {
      const marker = markers.get(t.hand_id);
      if (marker) {
        // The marker is proof ONLY when it agrees with the transcript and the
        // room; never trust it by hand_id alone.
        const parsed = parseSettlementEntry(t.entries);
        const consistent =
          typeof parsed !== 'string' &&
          marker.room_id === t.room_id &&
          marker.head === t.head &&
          marker.rake === parsed.rake &&
          Number.isInteger(marker.rake) &&
          marker.rake >= 0 &&
          computeHead(parsed.entries as never) === t.head;
        if (!consistent) {
          const reason = 'settlement marker disagrees with transcript/room';
          audit.markerConflicts.push({ handId: t.hand_id, roomId: t.room_id, reason });
          setQuarantined(t.hand_id, t.room_id, reason);
          continue;
        }
        const status = existing.get(t.hand_id);
        if (status === 'committed') {
          audit.alreadyClassified++;
        } else {
          audit.committedFromMarker++;
          setCommitted(t.hand_id, t.room_id, null);
        }
        continue;
      }
      audit.markerless++;
      const status = existing.get(t.hand_id);
      if (status !== undefined && status !== 'legacy') {
        audit.alreadyClassified++;
        continue;
      }
      const verdict = reconcileTranscript(db, t);
      if (verdict.ok) {
        audit.reconciled++;
        setCommitted(t.hand_id, t.room_id, 'legacy reconciled');
      } else {
        audit.quarantined.push({ handId: t.hand_id, roomId: t.room_id, reason: verdict.reason });
        setQuarantined(t.hand_id, t.room_id, verdict.reason);
      }
    }
  };
  if (dryRun) work();
  else db.transaction(work).immediate();
  return audit;
}

/** Read-only operator diagnostic: what the reconciliation would decide, without
 *  changing the database. Used to size an upgrade before running it. */
export function auditMarkerlessTranscripts(db: DB): MarkerlessAudit {
  return reconcileMissingSettlements(db, { dryRun: true });
}

/** The oldest hand in `roomId` dealt but never reaching a terminal lifecycle
 *  state (`running` / `prepared` / `quarantined`). Null when the room is safe
 *  to deal. This is the authoritative startup/deal-time guard. */
export function firstPendingHandLifecycle(db: DB, roomId: string): string | null {
  const row = db
    .prepare(
      `SELECT hand_id AS handId FROM hand_lifecycle
        WHERE room_id = ? AND status IN ('running','prepared','quarantined')
        ORDER BY created_at, rowid LIMIT 1`,
    )
    .get(roomId) as { handId: string } | undefined;
  return row?.handId ?? null;
}

/**
 * A trigger claimed by a hand that never committed its durable finalization
 * marker (the process restarted mid-hand) is stuck: neither pending nor
 * resolved. Put it back so it can be claimed again.
 *
 * The marker is authoritative rather than the transcript: finalization writes
 * the marker, the stack moves, the ledger rows, the trigger status, the
 * transcript and the schedule anchors in ONE transaction, so "no marker" means
 * none of those landed and "marker" means all of them did. There is therefore
 * nothing to reconcile beyond releasing the claim.
 *
 * Only the newest claimed row per kind is restored, and never while a pending
 * row exists - otherwise the partial unique index would reject the update.
 */
export function recoverOrphanedFeatureTriggers(db: DB): number {
  const info = db
    .prepare(
      `UPDATE room_feature_triggers
       SET status = 'pending', claimed_hand_id = NULL, resolved_at = NULL
       WHERE status = 'claimed'
         AND (claimed_hand_id IS NULL
              OR NOT EXISTS (
                SELECT 1 FROM hand_settlements s
                WHERE s.hand_id = room_feature_triggers.claimed_hand_id))
         -- Never release the claim of a hand that is still non-terminal in the
         -- lifecycle table: a hand dealt but not settled owns its feature input
         -- (spec B9b). An operator must resolve it, not silently free the claim.
         AND NOT EXISTS (
           SELECT 1 FROM hand_lifecycle l
           WHERE l.hand_id = room_feature_triggers.claimed_hand_id
             AND l.status IN ('running','prepared','quarantined'))
         AND id = (
           SELECT MAX(x.id) FROM room_feature_triggers x
           WHERE x.room_id = room_feature_triggers.room_id
             AND x.kind = room_feature_triggers.kind
             AND x.status = 'claimed')
         AND NOT EXISTS (
           SELECT 1 FROM room_feature_triggers p
           WHERE p.room_id = room_feature_triggers.room_id
             AND p.kind = room_feature_triggers.kind
             AND p.status = 'pending')`,
    )
    .run();
  return info.changes;
}

function ensureColumn(db: DB, table: string, column: string, decl: string): void {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}
