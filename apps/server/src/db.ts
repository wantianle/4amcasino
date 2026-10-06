import Database from 'better-sqlite3';
import { runMigrations } from './migrations/index.js';

export type DB = Database.Database;

// The standalone migrations now live under ./migrations/*, and the remaining
// runtime logic lives in ./transcriptReconcile.js and ./adminAuditTrail.js.
// Everything is re-exported here so the long-standing `from './db.js'` import
// surface stays unchanged for every existing caller.
export { migrate, recoverOrphanedFeatureTriggers, SESSION_TTL_MS } from './migrations/base.js';
export { migrateBetRatios } from './migrations/betRatios.js';
export { migrateBots } from './migrations/bots.js';
export { migrateSettlementPrepared } from './migrations/settlementPrepared.js';
export { migrateAdminAudit } from './migrations/adminAudit.js';
export { writeAdminAudit } from './adminAuditTrail.js';
export {
  reconcileTranscript,
  reconcileMissingSettlements,
  auditMarkerlessTranscripts,
  firstPendingHandLifecycle,
} from './transcriptReconcile.js';
export type { TranscriptReconcile, MarkerlessAudit } from './transcriptReconcile.js';

export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Give a competing writer (another server process opening the same file at
  // the same time) room to finish before SQLITE_BUSY is raised. The one-time
  // migrations below take an immediate write lock; without this wait the loser
  // of a startup race would fail outright instead of waiting its turn.
  db.pragma('busy_timeout = 10000');
  try {
    runMigrations(db);
  } catch (err) {
    // A step that throws may have committed earlier steps, so the file can be
    // left half-migrated; the process is about to abort, but the SQLite handle
    // must not leak. Close it before rethrowing the original error. The chain
    // is deliberately NOT wrapped in one transaction: the per-step DDL and the
    // `:memory:` path both rely on the current commit semantics.
    db.close();
    throw err;
  }
  return db;
}
