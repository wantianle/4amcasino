import { z } from 'zod';
import {
  BOMB_POT_ANTE_BB_VALUES,
  BOMB_POT_DURATION_SECONDS_MAX,
  BOMB_POT_DURATION_SECONDS_MIN,
  BOMB_POT_HANDS_MAX,
  BOMB_POT_HANDS_MIN,
  MULTI_RUN_MAX_RUNS,
  SQUID_MIN_PLAYERS_MAX,
  SQUID_MIN_PLAYERS_MIN,
  SQUID_PENALTY_BB_MAX,
  SQUID_PENALTY_BB_MIN,
  TIME_BANK_REFILL_EVERY_HANDS_MAX,
  TIME_BANK_REFILL_EVERY_HANDS_MIN,
  TIME_BANK_SECONDS_MAX,
  TIME_BANK_SECONDS_MIN,
  type RoomGameplaySettings,
} from '@4am/shared';
import type { DB } from './db.js';

/** The columns the gameplay features live in. `RoomRow` satisfies this. */
export interface RoomFeatureColumns {
  squid_enabled: number;
  squid_penalty_bb: number;
  squid_min_players: number;
  time_bank_enabled: number;
  time_bank_initial_secs: number;
  time_bank_refill_every_hands: number;
  time_bank_refill_secs: number;
  bomb_pot_enabled: number;
  bomb_pot_ante_bb: number;
  bomb_pot_schedule_mode: string;
  bomb_pot_schedule_value: number;
  multi_run_enabled: number;
}

/**
 * The values a freshly migrated room has before any settings are written. Kept
 * in lock-step with the `ensureColumn` defaults in db.ts; used to validate a
 * `features` payload supplied at room-creation time (there is no stored row to
 * merge against yet).
 */
export const ROOM_FEATURE_DEFAULTS: RoomGameplaySettings = {
  squid: { enabled: false, penaltyBb: 1, minPlayers: 3 },
  timeBank: { enabled: false, initialSeconds: 30, refillEveryHands: 30, refillSeconds: 30 },
  bombPot: { enabled: false, anteBb: 1, schedule: { mode: 'hands', value: 10 } },
  multiRun: { enabled: false, maxRuns: MULTI_RUN_MAX_RUNS },
};

const bombAnteSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

/**
 * A deep-partial patch: a client may send just the one knob they changed
 * (`{ squid: { enabled: true } }`) and the server merges it over the stored
 * settings. Bounds come straight from @4am/shared so the two can't drift.
 */
export const gameplayFeaturesSchema = z
  .object({
    squid: z
      .object({
        enabled: z.boolean(),
        penaltyBb: z.number().int().min(SQUID_PENALTY_BB_MIN).max(SQUID_PENALTY_BB_MAX),
        minPlayers: z.number().int().min(SQUID_MIN_PLAYERS_MIN).max(SQUID_MIN_PLAYERS_MAX),
      })
      .partial()
      .optional(),
    timeBank: z
      .object({
        enabled: z.boolean(),
        initialSeconds: z.number().int().min(TIME_BANK_SECONDS_MIN).max(TIME_BANK_SECONDS_MAX),
        refillEveryHands: z
          .number()
          .int()
          .min(TIME_BANK_REFILL_EVERY_HANDS_MIN)
          .max(TIME_BANK_REFILL_EVERY_HANDS_MAX),
        refillSeconds: z.number().int().min(TIME_BANK_SECONDS_MIN).max(TIME_BANK_SECONDS_MAX),
      })
      .partial()
      .optional(),
    bombPot: z
      .object({
        enabled: z.boolean(),
        anteBb: bombAnteSchema,
        schedule: z
          .object({
            mode: z.enum(['hands', 'duration']),
            value: z.number().int().positive(),
          })
          .partial()
          .optional(),
      })
      .partial()
      .optional(),
    multiRun: z
      .object({
        enabled: z.boolean(),
        maxRuns: z.literal(MULTI_RUN_MAX_RUNS),
      })
      .partial()
      .optional(),
  })
  .strict();

export type GameplayFeaturesPatch = z.infer<typeof gameplayFeaturesSchema>;

/** Reads the stored settings out of a rooms row. */
export function readRoomFeatures(row: RoomFeatureColumns): RoomGameplaySettings {
  const ante = (BOMB_POT_ANTE_BB_VALUES as readonly number[]).includes(row.bomb_pot_ante_bb)
    ? (row.bomb_pot_ante_bb as 1 | 2 | 3)
    : 1;
  const mode = row.bomb_pot_schedule_mode === 'duration' ? 'duration' : 'hands';
  return {
    squid: {
      enabled: !!row.squid_enabled,
      penaltyBb: row.squid_penalty_bb,
      minPlayers: row.squid_min_players,
    },
    timeBank: {
      enabled: !!row.time_bank_enabled,
      initialSeconds: row.time_bank_initial_secs,
      refillEveryHands: row.time_bank_refill_every_hands,
      refillSeconds: row.time_bank_refill_secs,
    },
    bombPot: {
      enabled: !!row.bomb_pot_enabled,
      anteBb: ante,
      schedule: { mode, value: row.bomb_pot_schedule_value },
    },
    multiRun: { enabled: !!row.multi_run_enabled, maxRuns: MULTI_RUN_MAX_RUNS },
  };
}

/** Applies a deep-partial patch over the current settings. */
export function mergeRoomFeatures(
  current: RoomGameplaySettings,
  patch: GameplayFeaturesPatch,
): RoomGameplaySettings {
  const schedule = patch.bombPot?.schedule;
  return {
    squid: { ...current.squid, ...(patch.squid ?? {}) },
    timeBank: { ...current.timeBank, ...(patch.timeBank ?? {}) },
    bombPot: {
      ...current.bombPot,
      ...(patch.bombPot ?? {}),
      schedule: { ...current.bombPot.schedule, ...(schedule ?? {}) },
    },
    multiRun: { ...current.multiRun, ...(patch.multiRun ?? {}) },
  };
}

/**
 * The bomb-pot cadence bounds depend on the mode, which a partial patch may not
 * carry, so this runs after the merge rather than inside the zod schema.
 */
export function bombScheduleError(settings: RoomGameplaySettings): string | null {
  const { mode, value } = settings.bombPot.schedule;
  if (mode === 'hands') {
    if (value < BOMB_POT_HANDS_MIN || value > BOMB_POT_HANDS_MAX)
      return `bomb pot interval must be ${BOMB_POT_HANDS_MIN}-${BOMB_POT_HANDS_MAX} hands`;
  } else if (value < BOMB_POT_DURATION_SECONDS_MIN || value > BOMB_POT_DURATION_SECONDS_MAX) {
    return `bomb pot interval must be ${BOMB_POT_DURATION_SECONDS_MIN}-${BOMB_POT_DURATION_SECONDS_MAX} seconds`;
  }
  return null;
}

function writeRoomFeatures(db: DB, roomId: string, f: RoomGameplaySettings): void {
  db.prepare(
    `UPDATE rooms SET
       squid_enabled = ?, squid_penalty_bb = ?, squid_min_players = ?,
       time_bank_enabled = ?, time_bank_initial_secs = ?,
       time_bank_refill_every_hands = ?, time_bank_refill_secs = ?,
       bomb_pot_enabled = ?, bomb_pot_ante_bb = ?,
       bomb_pot_schedule_mode = ?, bomb_pot_schedule_value = ?,
       multi_run_enabled = ?, multi_run_max_runs = ?
     WHERE id = ?`,
  ).run(
    f.squid.enabled ? 1 : 0,
    f.squid.penaltyBb,
    f.squid.minPlayers,
    f.timeBank.enabled ? 1 : 0,
    f.timeBank.initialSeconds,
    f.timeBank.refillEveryHands,
    f.timeBank.refillSeconds,
    f.bombPot.enabled ? 1 : 0,
    f.bombPot.anteBb,
    f.bombPot.schedule.mode,
    f.bombPot.schedule.value,
    f.multiRun.enabled ? 1 : 0,
    MULTI_RUN_MAX_RUNS,
    roomId,
  );
}

/**
 * Persists a fully-normalized settings object.
 *
 * Any time-bank config change bumps the room's epoch. When the bank is (still
 * or newly) enabled every seated player is reset to the new starting balance
 * and their refill counter is zeroed, so nobody carries a bank from the old
 * config. Writes happen in one transaction so a reader never sees a half-applied
 * epoch.
 */
export function applyRoomFeatures(
  db: DB,
  roomId: string,
  next: RoomGameplaySettings,
  prev: RoomGameplaySettings,
): void {
  const timeBankChanged =
    prev.timeBank.enabled !== next.timeBank.enabled ||
    prev.timeBank.initialSeconds !== next.timeBank.initialSeconds ||
    prev.timeBank.refillEveryHands !== next.timeBank.refillEveryHands ||
    prev.timeBank.refillSeconds !== next.timeBank.refillSeconds;
  db.transaction(() => {
    writeRoomFeatures(db, roomId, next);
    if (!timeBankChanged) return;
    const row = db
      .prepare('SELECT time_bank_epoch as epoch FROM rooms WHERE id = ?')
      .get(roomId) as { epoch: number };
    const epoch = row.epoch + 1;
    db.prepare('UPDATE rooms SET time_bank_epoch = ? WHERE id = ?').run(epoch, roomId);
    if (next.timeBank.enabled) {
      db.prepare(
        'UPDATE room_players SET time_bank_ms = ?, time_bank_hands = 0, time_bank_epoch = ? WHERE room_id = ?',
      ).run(next.timeBank.initialSeconds * 1000, epoch, roomId);
    }
  })();
}
