/**
 * Web-side fallback for a room's action clock. Rooms carry their own
 * `actionTimeoutMs`; this is the default the UI falls back to when the server
 * value is absent. The turn clock is a FIXED product setting (30s, host cannot
 * tune it - see hub.ts `defaultGameOpts`), so this must match the engine
 * default; `actionSecs` is a dead legacy field the server now reports as null.
 * Single source so the seconds and millisecond views of the same clock can
 * never drift apart.
 */
export const ACTION_TIMEOUT_SECS = 30;

/** The same default clock in milliseconds. */
export const ACTION_TIMEOUT_MS = ACTION_TIMEOUT_SECS * 1000;

/** Parse a CSS time custom property into MILLISECONDS.
 *
 *  The felt has two producers with DIFFERENT units and the reader must
 *  handle BOTH: `app/table-tokens.css` declares seconds (`0.82s`), while the
 *  runtime config injection (`app/main.tsx` ← `/api/config`, whose tunables
 *  are all `*Ms`) writes `820ms` onto the root element. getComputedStyle
 *  hands custom properties back verbatim — the browser does NOT normalize a
 *  custom property's unit — so every JS consumer parses by suffix: `…ms` →
 *  as-is, `…s` → ×1000, bare number → ms (the config contract). A parsed `0`
 *  is a REAL value ("no animation") and is preserved; only missing/garbage/
 *  negative input falls back. (The old `parseFloat(v) * 1000 || fallback`
 *  read the injected `620ms` as 620000ms — a ten-minute deal animation.) */
export function parseDurMs(value: string | null | undefined, fallbackMs: number): number {
  const v = (value ?? '').trim();
  if (!v) return fallbackMs;
  const n = parseFloat(v);
  if (!Number.isFinite(n) || n < 0) return fallbackMs;
  return /ms$/i.test(v) ? n : /s$/i.test(v) ? n * 1000 : n;
}
