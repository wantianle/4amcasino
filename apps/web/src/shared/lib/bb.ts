/** chips ⇄ BB conversion for DISPLAY and BB-denominated input.
 *
 *  The one rule this file exists to enforce: a BB amount is NEVER rounded to
 *  a whole BB on the way out. In a 10/20 room the small blind is 0.5 BB —
 *  Math.round(chips / bb) used to render SB and BB both as "1 BB" (user
 *  report), pot 30 as "2 BB", and every half-BB amount as the wrong integer.
 *  Values are exact to two decimals (chip/bb ratios need no more), and the
 *  string form trims trailing zeros: 0.5, 1, 1.5, 2.25.
 *
 *  The INPUT direction (BB → chips, `fromUnit` in the betting panel) stays
 *  integer-chip rounding on purpose: a bet is a whole number of chips. */

/** chips → BB as a NUMBER (input values, slider bounds, NumberFlow). */
export function bbValue(chips: number, bb: number): number {
  return Math.round((chips / Math.max(1, bb)) * 100) / 100;
}

/** chips → BB as a DISPLAY string, trailing zeros trimmed. */
export function fmtBB(chips: number, bb: number): string {
  return String(bbValue(chips, bb));
}
