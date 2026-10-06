/**
 * Shared polling helpers for the async server tests. Both were duplicated as
 * local one-liners across the suite; `sleep` appears in
 * `botRunnerReconnectE2E.test.ts`, `botE2E.test.ts` and `reconnectGrace.test.ts`,
 * and `waitFor` in eight test files with only the poll interval/default
 * differing.
 */

/** Resolve after `ms` milliseconds. */
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Poll `fn` every 15ms until it returns true, or throw once `timeoutMs`
 * elapses. Copied verbatim from `botRunnerReconnectE2E.test.ts:27-34` (the
 * richest of the duplicated variants: it carries the optional `label` that
 * makes a timeout traceable).
 */
export async function waitFor(fn: () => boolean, timeoutMs = 20000, label = ''): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(15);
  }
  throw new Error(`waitFor timed out: ${label}`);
}
