import type { DB } from './db.js';

// Runtime admin-audit trail append helper. Non-migration logic moved verbatim
// out of db.ts; it depends on db.ts only for the `DB` type, and db.ts re-exports
// it so existing callers are unchanged.

/**
 * Appends one row to the admin audit trail. This is a plain synchronous INSERT
 * on whatever connection the caller passes, so a call made from inside a
 * `db.transaction(...)` body commits (or rolls back) with the business change
 * it records - the intended usage. Kept in db.ts rather than admin.ts so the
 * admin and settings routes can all share it without an
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
