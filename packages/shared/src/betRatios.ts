/** Quick-bet ratios (A10, docs/table-redesign-spec.md). Shared by the web
 *  action bar / Settings card and the server profile schema so the two can
 *  never drift. A slot is either a fraction of the pot (0.25 … 2) or the
 *  ALL_IN_RATIO sentinel meaning "shove the whole stack".
 *
 *  The list is always exactly BET_RATIO_SLOTS long now: an account that saved
 *  the older four-slot shape is migrated up to the current default rather than
 *  read back untouched. */
export const ALL_IN_RATIO = -1;
export const BET_RATIO_OPTIONS = [0.25, 1 / 3, 0.5, 0.75, 1, 1.5, 2, ALL_IN_RATIO] as const;
/** How many quick-bet slots every account has and the Settings card shows. */
export const BET_RATIO_SLOTS = 5;
/** 33% / 50% / 75% / 100% / 150% of the pot. All-in stays selectable in the
 *  settings options but is not one of the defaults. */
export const DEFAULT_BET_RATIOS: number[] = [1 / 3, 0.5, 0.75, 1, 1.5];

/** Guards every payload (server, persisted, foreign): a value that is not the
 *  current five-slot shape - including the legacy four-slot pick - falls back
 *  to the defaults, so a stale list can never reach the action bar. */
export function sanitizeBetRatios(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length !== BET_RATIO_SLOTS) return [...DEFAULT_BET_RATIOS];
  const clean = raw.filter(
    (r): r is number =>
      typeof r === 'number' && (BET_RATIO_OPTIONS as readonly number[]).includes(r),
  );
  return clean.length === raw.length ? clean : [...DEFAULT_BET_RATIOS];
}
