import type { DB } from '../db.js';

/**
 * Index for the per-user room-count limit.
 *
 * `POST /api/rooms` lands `LIMITS.roomsPerUser` with
 * `SELECT COUNT(*) FROM rooms WHERE host_id = ? AND deleted = 0`. Without an
 * index that is a full scan of `rooms` on every room creation; `(host_id,
 * deleted)` lets SQLite answer the count by seeking one host's rows and also
 * serves any future read that filters a host's live rooms.
 *
 * Purely additive: nothing is dropped or rewritten, and `IF NOT EXISTS` keeps
 * boot idempotent on databases that already carry the index.
 */
export function migrateRoomsIndex(db: DB): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_rooms_host_not_deleted
      ON rooms(host_id, deleted);
  `);
}
