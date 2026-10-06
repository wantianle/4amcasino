import type { DB } from './db.js';
export function migrateAgentPlatform(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_grants (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), token_hash TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL, scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL,
      can_play INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS agent_grants_owner ON agent_grants(user_id, created_at);
    CREATE TRIGGER IF NOT EXISTS agent_room_membership_ended AFTER DELETE ON room_players BEGIN
      UPDATE agent_grants SET revoked_at = COALESCE(revoked_at, CAST(strftime('%s','now') AS INTEGER)*1000) WHERE scope_kind = 'room' AND scope_id = OLD.room_id AND user_id = OLD.user_id;
    END;
    CREATE TRIGGER IF NOT EXISTS agent_identity_changed AFTER UPDATE OF pubkey, disabled ON users WHEN OLD.pubkey != NEW.pubkey OR NEW.disabled != 0 BEGIN
      UPDATE agent_grants SET revoked_at = COALESCE(revoked_at, CAST(strftime('%s','now') AS INTEGER)*1000) WHERE user_id = NEW.id;
    END;
  `);
}
