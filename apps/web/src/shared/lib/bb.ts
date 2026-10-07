/** chips ⇄ BB conversion for DISPLAY and BB-denominated input.
 *
 *  Display rule (user 2026-10-07): a visible BB amount is ALWAYS rounded UP to
 *  the next 0.5 BB — the small blind is the table's smallest unit (0.5 BB in a
 *  standard room), so a half-BB grid is the finest honest display. 123 chips at
 *  a 20 BB used to show 6.15 BB (two decimals); it now shows 6.5 BB. The
 *  direction is UP on purpose, matching the bet-input rule: never show less
 *  than the player actually holds/owes.
 *
 *  The LEDGER stays in raw chips everywhere — nothing here is ever persisted or
 *  settled. This conversion is display/input only; `fromUnit` in the betting
 *  panel converts a BB edit back to raw chips (the full product), and the
 *  downstream `snapRaiseTo` rounds that UP to the small-blind grid. */

/** chips → BB as a NUMBER, rounded UP to the next 0.5 BB (display). */
export function bbValue(chips: number, bb: number): number {
  const halves = (Math.max(0, chips) / Math.max(1, bb)) * 2;
  return Math.ceil(halves) / 2;
}

/** chips → BB as a DISPLAY string, trailing zeros trimmed. */
export function fmtBB(chips: number, bb: number): string {
  return String(bbValue(chips, bb));
}
