/**
 * Web-side fallback for a room's action clock. Rooms normally carry their own
 * `actionSecs` / `actionTimeoutMs`; these are the defaults the UI falls back to
 * when the server value is absent. Single source so the seconds and millisecond
 * views of the same clock can never drift apart.
 */
export const ACTION_TIMEOUT_SECS = 45;

/** The same default clock in milliseconds. */
export const ACTION_TIMEOUT_MS = ACTION_TIMEOUT_SECS * 1000;
