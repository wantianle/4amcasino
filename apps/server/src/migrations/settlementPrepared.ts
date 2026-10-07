import type { DB } from '../db.js';

/**
 * Durable frozen settlement input.
 *
 * A `Hand` computes a whole settlement (transcript head + entries, per-seat
 * stack/ledger deltas, squid, 7-2 bounty, time bank, trigger ids, rake
 * recipient) and freezes it here BEFORE the money transaction, in its OWN
 * committed transaction. A crash between the two therefore leaves a complete,
 * replayable input rather than a `running` row nobody can settle safely:
 * rebuilding from the current `room_players.stack` would be wrong because a
 * mid-hand buy/next action may have moved it.
 *
 * `input_json` is the canonical JSON of the full `HandSettlementWrite`;
 * `input_hash` is its SHA-256, verified on every read so a tampered or
 * truncated row fails closed into `quarantined` instead of being applied.
 * `resolved_at`/`resolved_by`/`resolution` record how the row was finally
 * disposed of (a committed retry, or an operator abort), for the audit trail.
 */
export function migrateSettlementPrepared(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hand_settlement_prepared (
      hand_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      head TEXT NOT NULL,
      input_json TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      prepared_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      resolved_at INTEGER,
      resolved_by INTEGER,
      resolution TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_hand_settlement_prepared_room
      ON hand_settlement_prepared(room_id, resolved_at);
  `);
}
