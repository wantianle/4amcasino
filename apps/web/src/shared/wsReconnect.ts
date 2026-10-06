/**
 * Reconnect policy, kept pure and separate from the socket transport.
 *
 * The session layer owns the retry counter and the "closed by us" flag; this
 * module only decides how long to wait and when repeated failures should probe
 * the session (the API's 401 handler then sends the user to login).
 */

/** Consecutive failed reconnects after which we probe the API: if the server
 *  restarted with fresh data, our token is dead. */
export const RECONNECT_PROFILE_AFTER = 4;

/** Exponential backoff, capped: 500ms, 1s, 2s, 4s, then 8s from there on. */
export function reconnectDelay(retry: number): number {
  return Math.min(500 * 2 ** retry, 8000);
}
