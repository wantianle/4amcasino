import { z } from 'zod';
import {
  BOMB_POT_ANTE_BB_MAX,
  BOMB_POT_ANTE_BB_MIN,
  BOMB_POT_DURATION_SECONDS_MAX,
  BOMB_POT_DURATION_SECONDS_MIN,
  BOMB_POT_HANDS_MAX,
  BOMB_POT_HANDS_MIN,
  DEFAULT_GAMEPLAY_SETTINGS,
  MULTI_RUN_MAX_RUNS,
  SQUID_MIN_PLAYERS_MAX,
  SQUID_MIN_PLAYERS_MIN,
  SQUID_PENALTY_BB_MAX,
  SQUID_PENALTY_BB_MIN,
  TIME_BANK_INITIAL_SECONDS,
  TIME_BANK_REFILL_EVERY_HANDS,
  TIME_BANK_REFILL_SECONDS,
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
 * The values a fresh room has before any settings are written. This is the
 * shared `DEFAULT_GAMEPLAY_SETTINGS` object itself (not a copy), so there is a
 * single source of truth for the gameplay defaults; used to validate a
 * `features` payload supplied at room-creation time (there is no stored row to
 * merge against yet).
 *
 * Note: the shared object is deep-frozen (see `roomRules.ts`), so this alias is
 * immutable at runtime as well; read-only spreads such as
 * {@link mergeRoomFeatures} are unaffected.
 *
 * Every feature is ON by default: a new table is meant to have the new gameplay
 * (squid / time bank / bomb pot / multi-run) available out of the box. A host
 * can still switch any of them off through the settings dialog. The DB column
 * defaults in db.ts are kept as a safety fallback only; room creation always
 * writes the full normalized object through {@link applyRoomFeatures}.
 */
export const ROOM_FEATURE_DEFAULTS: RoomGameplaySettings = DEFAULT_GAMEPLAY_SETTINGS;

/**
 * The bomb-pot ante is any whole number of BBs within the shared bounds.
 * `BOMB_POT_ANTE_BB_MIN..MAX` in roomRules.ts is the single source of truth,
 * so the UI cannot offer a value the server rejects.
 */
const bombAnteSchema = z.number().int().min(BOMB_POT_ANTE_BB_MIN).max(BOMB_POT_ANTE_BB_MAX);

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
    // Time bank: FIXED. The product is "at most 5 cards of 30s each, refilled
    // one card every 20 hands" and a host may not change it. Pinning the schema
    // to literals makes a hand-built PUT/POST that carries any other value fail
    // validation (400) instead of silently writing a divergent bank; the only
    // accepted values are the shared constants written by room creation.
    timeBank: z
      .object({
        enabled: z.literal(true),
        initialSeconds: z.literal(TIME_BANK_INITIAL_SECONDS),
        refillEveryHands: z.literal(TIME_BANK_REFILL_EVERY_HANDS),
        refillSeconds: z.literal(TIME_BANK_REFILL_SECONDS),
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
  // The DB column is a plain INTEGER with no CHECK, so a hand-edited or legacy
  // row can hold anything; clamp it into the legal range instead of echoing an
  // ante the validators would reject.
  const rawAnte = Number.isFinite(row.bomb_pot_ante_bb)
    ? Math.round(row.bomb_pot_ante_bb)
    : BOMB_POT_ANTE_BB_MIN;
  const ante = Math.min(BOMB_POT_ANTE_BB_MAX, Math.max(BOMB_POT_ANTE_BB_MIN, rawAnte));
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

/**
 * The one-time upgrade of rooms that predate the default-on policy. New rooms
 * get these values from the column DEFAULTs; rooms that already exist store the
 * old `0`s, and `ensureColumn` never rewrites an existing column's default, so
 * they must be flipped explicitly exactly once.
 *
 * Idempotent through the `meta` marker: once `room-defaults-on-1` is present the
 * whole body is skipped, so a restart cannot re-apply it and a host who turns a
 * feature off afterwards keeps that choice. The feature flip goes through
 * {@link applyRoomFeatures} so enabling the time bank also bumps its epoch and
 * resets every seated player's bank to the new initial balance, exactly like a
 * host edit would.
 *
 * The marker check, the updates and the marker write share one immediate
 * (write-locked) transaction, mirroring the `auto-ready-default-on-1` migration:
 * without the lock, two servers opening the same file could both miss the marker
 * and double-apply (and race on the marker's primary key).
 */
export function migrateRoomFeatureDefaults(db: DB): void {
  const MARKER = 'room-defaults-on-1';
  db.transaction(() => {
    if (db.prepare('SELECT value FROM meta WHERE key = ?').get(MARKER)) return;
    db.prepare(
      `UPDATE rooms SET allow_spectators = 1, tv_replays = 1, auto_approve_buys = 1
       WHERE allow_spectators = 0 OR tv_replays = 0 OR auto_approve_buys = 0`,
    ).run();
    const rooms = db.prepare('SELECT * FROM rooms').all() as (RoomFeatureColumns & { id: string })[];
    for (const room of rooms) {
      const current = readRoomFeatures(room);
      if (
        current.squid.enabled &&
        current.timeBank.enabled &&
        current.bombPot.enabled &&
        current.multiRun.enabled
      )
        continue;
      applyRoomFeatures(
        db,
        room.id,
        {
          squid: { ...current.squid, enabled: true },
          timeBank: { ...current.timeBank, enabled: true },
          bombPot: { ...current.bombPot, enabled: true },
          multiRun: { ...current.multiRun, enabled: true },
        },
        current,
      );
    }
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(MARKER, '1');
  }).immediate();
}

/**
 * One-time normalization of every room's stored time-bank config to the fixed
 * "5 cards of 30s, one card every 20 hands" product values, and of every
 * player's bank to a single starting card on the new epoch.
 *
 * Rooms created before this change can hold any legacy values (a custom refill
 * every 30 hands, a 600s refill, enabled=0). The HTTP surface no longer accepts
 * a divergent value at all, so without this pass those rows would keep running
 * the old numbers forever. Rather than masking the columns at read time, we
 * normalize them once: the DB stays the single canonical source, and the
 * existing epoch machinery (which already resets a seat's bank when the config
 * changes) does the per-player reset for free.
 *
 * Idempotent through the `time-bank-fixed-1` marker, and one write-locked
 * transaction so two servers opening the same file cannot double-apply.
 */
export function migrateTimeBankFixed(db: DB): void {
  const MARKER = 'time-bank-fixed-1';
  db.transaction(() => {
    if (db.prepare('SELECT value FROM meta WHERE key = ?').get(MARKER)) return;
    db.prepare(
      `UPDATE rooms SET
         time_bank_enabled = 1,
         time_bank_initial_secs = ?,
         time_bank_refill_every_hands = ?,
         time_bank_refill_secs = ?,
         time_bank_epoch = time_bank_epoch + 1`,
    ).run(
      TIME_BANK_INITIAL_SECONDS,
      TIME_BANK_REFILL_EVERY_HANDS,
      TIME_BANK_REFILL_SECONDS,
    );
    // Align every player's bank to the room's new epoch and refill it to one
    // starting card, so an old accumulated balance cannot leak into the new cap.
    db.prepare(
      `UPDATE room_players SET
         time_bank_ms = ?,
         time_bank_hands = 0,
         time_bank_epoch = (
           SELECT time_bank_epoch FROM rooms WHERE rooms.id = room_players.room_id
         )`,
    ).run(TIME_BANK_INITIAL_SECONDS * 1000);
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(MARKER, '1');
  }).immediate();
}
