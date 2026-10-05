import Database from 'better-sqlite3';
import {
  LEGACY_ROOM_COMMISSION_BPS,
  NEW_ROOM_COMMISSION_BPS,
  MAX_QUALIFYING_HANDS,
} from '@4am/shared';
import { initializePlatformSettings } from './platformSettings.js';
import { migrateAgentPlatform } from './agentSchema.js';
import { migrateHandStats } from './handProjection.js';

export type DB = Database.Database;

/** How long a login lasts. Long enough that a weekly game never re-authenticates
 *  mid-session, short enough that a leaked token eventually dies. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
  return db;
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
  // Difficulty tier (`low` | `medium` | `high`), orthogonal to `policy_kind`.
  // Added by ensureColumn rather than in the CREATE above so an existing DB gets
  // it without a rewrite and every pre-existing bot keeps `low` (today's
  // behaviour). `high` is a reserved, not-yet-implemented GTO tier.
  ensureColumn(db, 'bot_accounts', 'difficulty', "TEXT NOT NULL DEFAULT 'low'");
  // Internal bot-runner grants are ordinary `agent_grants` rows distinguished by
  // grant_kind='bot_runner' and bot_id, so they reuse the whole agent-token
  // pipeline (hashing, scope membership, revocation) without ever showing up in
  // a user's own grant list.
  ensureColumn(db, 'agent_grants', 'grant_kind', "TEXT NOT NULL DEFAULT 'user'");
  ensureColumn(db, 'agent_grants', 'bot_id', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_agent_grants_bot ON agent_grants(bot_id)');
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
  ensureColumn(db, 'users', 'avatar3d', 'TEXT');
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
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
  ensureColumn(db, 'rooms', 'auto_approve_buys', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'rooms', 'seven_deuce_bonus', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'users', 'private_mode', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'users', 'last_seen', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'users', 'auto_join_invites', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'rooms', 'voided', 'INTEGER NOT NULL DEFAULT 0');
  // Archiving retires a finished table: it leaves the room list, stops dealing,
  // and its results stop counting towards stats. Nothing is deleted - the
  // ledger and every transcript stay readable, and money still owed between
  // players stays owed. See the comment on /api/rooms/:id/archive.
  ensureColumn(db, 'rooms', 'archived', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'rooms', 'archived_at', 'INTEGER');
  // Deletion, like archiving, is soft: rows are never dropped. Archive/unarchive
  // and delete both go through room_lifecycle_requests below and only take
  // effect once a platform admin approves them.
  ensureColumn(db, 'rooms', 'deleted', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'rooms', 'deleted_at', 'INTEGER');
  ensureColumn(db, 'rooms', 'meet_link', 'TEXT');
  ensureColumn(db, 'rooms', 'visibility', "TEXT NOT NULL DEFAULT 'private'");
  ensureColumn(db, 'rooms', 'spectate_token', 'TEXT');
  ensureColumn(db, 'rooms', 'allow_spectators', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'rooms', 'tv_replays', 'INTEGER NOT NULL DEFAULT 0');
  // Existing rooms already continued automatically after hands.
  ensureColumn(db, 'rooms', 'auto_deal', 'INTEGER NOT NULL DEFAULT 1');
  // Install the original per-room schema before the runtime settings migration.
  // Install and backfill atomically so a restart cannot mistake old rooms for new ones.
  db.transaction(() => {
    const columns = db.pragma('table_info(rooms)') as { name: string }[];
    if (!columns.some((c) => c.name === 'commission_bps')) {
      ensureColumn(
        db,
        'rooms',
        'commission_bps',
        `INTEGER NOT NULL DEFAULT ${NEW_ROOM_COMMISSION_BPS}`,
      );
      db.prepare('UPDATE rooms SET commission_bps = ?').run(LEGACY_ROOM_COMMISSION_BPS);
    }
  })();
  initializePlatformSettings(db);
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
  // Quick-bet ratios (A10): the four table action-bar slots, stored as a JSON
  // array of pot fractions (with -1 as the all-in sentinel).
  ensureColumn(db, 'users', 'bet_ratios', 'TEXT');
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
    -- Archive/unarchive/delete are requested by a host or banker but only take
    -- effect once a platform admin approves them (see requirePlatform).
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
  // The numeric defaults mirror the shared RoomGameplaySettings defaults except
  // where the orchestrator specified otherwise (e.g. 3 min squid players).
  ensureColumn(db, 'rooms', 'squid_enabled', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'rooms', 'squid_penalty_bb', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'rooms', 'squid_min_players', 'INTEGER NOT NULL DEFAULT 3');
  ensureColumn(db, 'rooms', 'time_bank_enabled', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'rooms', 'time_bank_initial_secs', 'INTEGER NOT NULL DEFAULT 30');
  ensureColumn(db, 'rooms', 'time_bank_refill_every_hands', 'INTEGER NOT NULL DEFAULT 30');
  ensureColumn(db, 'rooms', 'time_bank_refill_secs', 'INTEGER NOT NULL DEFAULT 30');
  // Bumped on every time-bank config change so in-flight hands and clients can
  // tell a stale snapshot from the current configuration.
  ensureColumn(db, 'rooms', 'time_bank_epoch', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'rooms', 'bomb_pot_enabled', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'rooms', 'bomb_pot_ante_bb', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'rooms', 'bomb_pot_schedule_mode', "TEXT NOT NULL DEFAULT 'hands'");
  ensureColumn(db, 'rooms', 'bomb_pot_schedule_value', 'INTEGER NOT NULL DEFAULT 10');
  ensureColumn(db, 'rooms', 'multi_run_enabled', 'INTEGER NOT NULL DEFAULT 0');
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
