/**
 * Bot difficulty vocabulary: the single source of truth shared by the HTTP API
 * (apps/server), the bot runner's policy resolver (@4am/agent-core) and the web
 * UI. Keeping the tier list, the default and the retired set here is what stops
 * the server's zod enum and the resolver's fallback logic from drifting.
 *
 * `high` was reserved for a future GTO tier and never implemented; it is
 * withdrawn from the writable set (`BOT_DIFFICULTIES`) but kept in
 * `RETIRED_BOT_DIFFICULTIES` so a legacy persisted value can be recognised and
 * reported rather than mistaken for a typo.
 */
export const BOT_DIFFICULTIES = ['low', 'medium'] as const;
export type BotDifficulty = (typeof BOT_DIFFICULTIES)[number];

export const DEFAULT_BOT_DIFFICULTY: BotDifficulty = 'medium';

/** Tiers that were once accepted but have no implementation. */
export const RETIRED_BOT_DIFFICULTIES = ['high'] as const;

/**
 * Strict, case/space-insensitive difficulty parser: `null` for empty, unknown
 * or retired values (so a caller can report *why* a value was rejected).
 */
export function parseBotDifficulty(raw: string | null | undefined): BotDifficulty | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  return (BOT_DIFFICULTIES as readonly string[]).includes(key) ? (key as BotDifficulty) : null;
}

/**
 * Normalize any input to a currently-writable tier, mapping retired/unknown/
 * empty values to {@link DEFAULT_BOT_DIFFICULTY}. Used by read/display paths
 * that must never surface an unwritable value; write validation stays strict.
 */
export function normalizeBotDifficulty(raw: string | null | undefined): BotDifficulty {
  return parseBotDifficulty(raw) ?? DEFAULT_BOT_DIFFICULTY;
}
