import type { DB } from '../db.js';
import { ensureColumn } from './util.js';

/**
 * Persist the consecutive-action-timeout streak on the player's room row.
 *
 * The anti-stall rule ("two action timeouts in a row stand the player up") was
 * tracked in an in-memory `Map` on `GameRoom`, so a process restart between the
 * first and second timeout silently forgave the first one and let a player
 * stall forever. The counter now lives on `room_players` and survives a restart.
 *
 * Purely additive: one `INTEGER NOT NULL DEFAULT 0` column, added through
 * `ensureColumn` so boot is idempotent. The value is not money and is reset on
 * every voluntary action, fresh seat and voluntary leave, so no backfill is
 * needed - existing rows start at 0.
 */
export function migrateConsecutiveActionTimeouts(db: DB): void {
  ensureColumn(db, 'room_players', 'consecutive_action_timeouts', 'INTEGER NOT NULL DEFAULT 0');
}
