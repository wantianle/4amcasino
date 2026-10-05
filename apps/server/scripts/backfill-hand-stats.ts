import { openDb } from '../src/db.js';
import { backfillHandStats } from '../src/handProjection.js';

// Usage: npx tsx apps/server/scripts/backfill-hand-stats.ts [dbPath] [--force]
// Projects historical transcripts into hands/hand_players/hand_actions.
// Idempotent and additive: the original transcript, ledger and stacks are never
// touched; a hand already projected by the current parser version is skipped
// unless --force is passed. Only finished, confirmed hands (a hand_settlements
// row) that have not been voided are projected.
const args = process.argv.slice(2);
const force = args.includes('--force');
const dbPath = args.find((a) => !a.startsWith('--')) ?? process.env.DB_PATH ?? '4amcasino.db';

const db = openDb(dbPath);
const report = backfillHandStats(db, { force });
db.close();

console.log(
  `hand-stats backfill: scanned=${report.scanned} projected=${report.projected} ` +
    `skipped=${report.skipped} voided=${report.voided} errors=${report.errors}`,
);
if (report.errors > 0) {
  console.log('  failed hands are recorded in hand_projection_errors (transcripts untouched)');
}
