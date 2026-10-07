import { hdbg } from './handDiagnostics.js';

/**
 * True for the JS error family that means "a bug in the value we handed over",
 * not a transient transport failure. A dead socket does not throw synchronously
 * out of `room.broadcast`; a `TypeError` / `RangeError` / `ReferenceError` /
 * `SyntaxError` almost always means the frame itself is malformed (e.g. a
 * circular value in `JSON.stringify`). Used only to route the failure log - the
 * publisher never rethrows, so this classification cannot affect isolation.
 */
const PROGRAMMING_ERROR_NAMES = new Set([
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
]);
function isProgrammingError(err: unknown): boolean {
  return err instanceof Error && PROGRAMMING_ERROR_NAMES.has(err.name);
}

/**
 * The ONE tiered logger for a swallowed best-effort broadcast failure. Shared
 * by `Hand.publish` and `GameRoom.publish`/`publishRoomState` so the two
 * publishers can never drift:
 *
 *   * Tier 1 - an unexpected programming error (TypeError and friends). Not a
 *     transport hiccup but almost always a bug in the frame itself (e.g. a
 *     circular value breaking `JSON.stringify`); reported distinctly with its
 *     stack so a real defect is not buried in delivery noise.
 *   * Tier 2 - an expected delivery failure (dead/stalled transport).
 *
 * Neither tier rethrows; the classification only changes how loudly the loss is
 * reported. `id` is the hand id for `Hand.publish`, the room id for the room
 * publisher.
 */
export function logBroadcastFailure(id: string, label: string, t: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (isProgrammingError(err)) {
    const detail = { id, t, kind: 'unexpected', message, stack: (err as Error).stack };
    hdbg('broadcastProgrammingError', detail);
    console.error(`${label} - unexpected programming error, not a delivery failure`, detail);
    return;
  }
  const detail = { id, t, message };
  hdbg('broadcastFailed', detail);
  // hdbg is off by default, so a lost frame would otherwise be completely
  // silent in production. Surface it on the normal error log.
  console.error(label, detail);
}
