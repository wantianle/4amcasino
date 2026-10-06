import type { DB } from '../db.js';

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
