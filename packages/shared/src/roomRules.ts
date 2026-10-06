/** Room hosts can choose a lower requirement, including zero. */
export const MAX_QUALIFYING_HANDS = 30;

/**
 * Per-room gameplay settings for the "new gameplay" features. Every sub-shape
 * is self-contained so a room can enable one feature without the others.
 *
 * Numeric bounds are exported below as named constants and consumed by the
 * server-side validators; keep the two in sync.
 */
export interface RoomGameplaySettings {
  /** Squid Game: losers pay a fixed penalty (in big blinds) to the winners. */
  squid: {
    enabled: boolean;
    /** Penalty per loser, in big blinds. Bounds: SQUID_PENALTY_BB_MIN..MAX. */
    penaltyBb: number;
    /** Minimum number of dealt-in players required to trigger the feature. */
    minPlayers: number;
  };
  /** Per-player time bank that refills every N hands. */
  timeBank: {
    enabled: boolean;
    /** Starting bank, in seconds. */
    initialSeconds: number;
    /** A refill is granted every N hands. */
    refillEveryHands: number;
    /** Seconds added on each refill. */
    refillSeconds: number;
  };
  /** Bomb pot: a preflop ante with no blinds, on a fixed schedule. */
  bombPot: {
    enabled: boolean;
    /** Ante charged to each player, in big blinds. */
    anteBb: 1 | 2 | 3;
    /** When the next bomb pot fires. */
    schedule: { mode: 'hands' | 'duration'; value: number };
  };
  /** Multi-run: run the board 2 or 3 times when all-in before the river. */
  multiRun: {
    enabled: boolean;
    /** Always exactly 3: the cap allowed by the rules. */
    maxRuns: 3;
  };
}

// ---- validation limits ---------------------------------------------------

export const SQUID_PENALTY_BB_MIN = 1;
export const SQUID_PENALTY_BB_MAX = 100;
export const SQUID_MIN_PLAYERS_MIN = 2;
export const SQUID_MIN_PLAYERS_MAX = 9;

export const TIME_BANK_SECONDS_MIN = 1;
export const TIME_BANK_SECONDS_MAX = 600;
export const TIME_BANK_REFILL_EVERY_HANDS_MIN = 1;
export const TIME_BANK_REFILL_EVERY_HANDS_MAX = 1000;

/** Ante options are an enum, not a range: 1, 2 or 3 big blinds. */
export const BOMB_POT_ANTE_BB_VALUES = [1, 2, 3] as const;
export const BOMB_POT_HANDS_MIN = 1;
export const BOMB_POT_HANDS_MAX = 1000;
export const BOMB_POT_DURATION_SECONDS_MIN = 60;
export const BOMB_POT_DURATION_SECONDS_MAX = 604800;

export const MULTI_RUN_MAX_RUNS = 3;

/**
 * Recursively `Object.freeze` a plain-data object. Used once at module load to
 * make {@link DEFAULT_GAMEPLAY_SETTINGS} immutable in depth: a stray write
 * (directly or through the server's `ROOM_FEATURE_DEFAULTS` alias, which is the
 * same object) throws in strict-mode ESM instead of silently corrupting the
 * defaults for every room. Only plain nested objects exist here, so a simple
 * value walk is enough.
 */
function deepFreeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object') deepFreeze(child);
  }
  return Object.freeze(value);
}

/** The default gameplay settings for a room: every new-gameplay feature is ON
 *  out of the box, and a host can switch any of them off.
 *
 *  This is the single TypeScript source of truth: the server's
 *  `ROOM_FEATURE_DEFAULTS` re-exports this exact object (no copy), and the DB
 *  column defaults are a safety fallback that room creation never relies on.
 *  The web UI also derives its fresh-form seed and field fallbacks from here.
 *
 *  Frozen in depth on purpose: the object is shared by every caller and is
 *  never meant to be written, so mutation is blocked at runtime rather than
 *  silently corrupting the global defaults. The server's only consumer,
 *  `mergeRoomFeatures`, only spreads these values into a fresh object (it never
 *  writes the source), and the web clones before editing, so nothing legitimate
 *  is affected. */
export const DEFAULT_GAMEPLAY_SETTINGS: RoomGameplaySettings = deepFreeze<RoomGameplaySettings>({
  squid: { enabled: true, penaltyBb: 1, minPlayers: 3 },
  timeBank: { enabled: true, initialSeconds: 30, refillEveryHands: 30, refillSeconds: 30 },
  bombPot: { enabled: true, anteBb: 1, schedule: { mode: 'hands', value: 10 } },
  multiRun: { enabled: true, maxRuns: MULTI_RUN_MAX_RUNS },
});
