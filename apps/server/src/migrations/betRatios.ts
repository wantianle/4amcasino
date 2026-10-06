import { DEFAULT_BET_RATIOS, sanitizeBetRatios } from '@4am/shared';
import type { DB } from '../db.js';

/** Rewrite every stored quick-bet-ratio list that is not the current five-slot
 *  shape to the five-slot default. The old format allowed four slots and read
 *  them back untouched forever, so accounts created before the fifth slot
 *  existed would keep a four-button action bar. Runs on every boot and is
 *  idempotent by construction: a valid five-slot save is left byte-for-byte
 *  alone (JSON round-trips unchanged), so re-running never clobbers a player's
 *  real pick. Damaged/foreign JSON also resolves to the default. */
export function migrateBetRatios(db: DB): void {
  const rows = db
    .prepare('SELECT id, bet_ratios FROM users WHERE bet_ratios IS NOT NULL')
    .all() as { id: number; bet_ratios: string }[];
  if (rows.length === 0) return;
  const rewrite = db.prepare('UPDATE users SET bet_ratios = ? WHERE id = ?');
  const defaultJson = JSON.stringify(DEFAULT_BET_RATIOS);
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.bet_ratios);
    } catch {
      parsed = null;
    }
    // `sanitizeBetRatios` returns the input untouched when it is already the
    // five-slot shape, so a string mismatch means this row needs migrating.
    if (JSON.stringify(sanitizeBetRatios(parsed)) !== JSON.stringify(parsed)) {
      rewrite.run(defaultJson, row.id);
    }
  }
}
