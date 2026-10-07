import type { DB } from './db.js';
import { MAX_TABLE_PLAYERS_WITH_BOTS, type BotStatus } from '@4am/shared';

/**
 * Read-side bot data access: fetching bot rows and measuring table occupancy.
 *
 * Deliberately side-effect free (only SELECTs) so the lifecycle service and the
 * route layer can both depend on it without forming a cycle. The bot state
 * machine itself lives in `botLifecycleService.ts`.
 */

export interface BotRow {
  id: string;
  room_id: string;
  owner_id: number;
  user_id: number;
  status: BotStatus;
  policy_kind: string;
  policy_json: string | null;
  /** Effective difficulty tier (`low` | `medium`) after rollback; orthogonal
   *  to `policy_kind`. Legacy hubs may still hold the withdrawn `high`, which
   *  is read as `medium` by the resolver. */
  difficulty: string;
  seat: number | null;
  identity_ct: string | null;
  identity_nonce: string | null;
  identity_tag: string | null;
  created_at: number;
  updated_at: number;
  stopped_at: number | null;
  stop_requested_at: number | null;
  /** Set once a hard delete has been requested; see `finalizeBotRemoved`. */
  delete_requested_at: number | null;
}

export function getBot(db: DB, roomId: string, botId: string): BotRow | undefined {
  return db
    .prepare('SELECT * FROM bot_accounts WHERE id = ? AND room_id = ?')
    .get(botId, roomId) as BotRow | undefined;
}

export function getBotById(db: DB, botId: string): BotRow | undefined {
  return db.prepare('SELECT * FROM bot_accounts WHERE id = ?').get(botId) as BotRow | undefined;
}

export function listBots(db: DB, roomId: string): BotRow[] {
  // Hard-deleted bots leave no row, but a pre-existing `removed` row (from the
  // old soft-delete era) and a bot whose hard delete is still winding down must
  // not be listed: the host already asked for them to go.
  return db
    .prepare(
      "SELECT * FROM bot_accounts WHERE room_id = ? AND status != 'removed' AND delete_requested_at IS NULL ORDER BY created_at, id",
    )
    .all(roomId) as BotRow[];
}

/**
 * The 409 body when adding a bot would push a bot-present table over
 * `MAX_TABLE_PLAYERS_WITH_BOTS`. Single-sourced so the route and its tests
 * cannot drift, and stable (no interpolation) so the web dictionary can key on
 * it exactly.
 *
 * Worded as a BOT limit, not a global 6-max: an all-human table may still hold
 * 7+ players, so "at most 6 may be seated" would be wrong (see
 * `MAX_TABLE_PLAYERS_WITH_BOTS`).
 */
export const TABLE_FULL_MESSAGE =
  'table is full: adding a bot would exceed the 6-player limit for tables with bots';

/**
 * Current occupancy of a table, measured by the seats that ACTUALLY exist.
 *
 * The authority is `room_players` (`seat IS NOT NULL`), joined to the bot rows
 * by user, so this can never count a bot that has no seat - a `bot_accounts`
 * row with `seat IS NULL`, a bot whose `room_players` row is gone, or a legacy
 * row whose configured seat drifted out of sync with the room. Counting bot
 * ROWS instead (the earlier implementation) let such a ghost consume a slot:
 * the server would refuse a new bot while the table was not really full, and
 * `evictOverCapBots` would delete a bot that held no seat and free nothing.
 *
 *   - `seatedHumans`: seated `room_players` whose owner has no *effective* bot
 *     row in this room (an effective row is one with `status != 'removed'`); a
 *     room member who never sat, a spectator, and bots are all excluded.
 *   - `bots`: seated `room_players` whose owner HAS an effective bot row. A bot
 *     parked `stopping` with a pending delete still physically holds its seat,
 *     so it stays counted until `finalizeBotRemoved` drops the seat row - which
 *     is exactly what makes a completed delete free the slot.
 *
 * `full` is the add gate: at `total >= MAX_TABLE_PLAYERS_WITH_BOTS` no further
 * bot may be created, so `total` never exceeds the cap through normal adds.
 */
export interface BotCapacity {
  seatedHumans: number;
  bots: number;
  total: number;
  full: boolean;
}

export function botCapacity(db: DB, roomId: string): BotCapacity {
  // Effective bot = a bot_accounts row for this room+user that is not a legacy
  // `removed` soft-delete. The same predicate drives both counts, so a seated
  // user is classified as a bot or a human and never as both.
  const seatedBots = (
    db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM room_players rp
          WHERE rp.room_id = ? AND rp.seat IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM bot_accounts ba
               WHERE ba.room_id = rp.room_id AND ba.user_id = rp.user_id
                 AND ba.status != 'removed')`,
      )
      .get(roomId) as { n: number }
  ).n;
  const seatedHumans = (
    db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM room_players rp
          WHERE rp.room_id = ? AND rp.seat IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM bot_accounts ba
               WHERE ba.room_id = rp.room_id AND ba.user_id = rp.user_id
                 AND ba.status != 'removed')`,
      )
      .get(roomId) as { n: number }
  ).n;
  const total = seatedHumans + seatedBots;
  return { seatedHumans, bots: seatedBots, total, full: total >= MAX_TABLE_PLAYERS_WITH_BOTS };
}
