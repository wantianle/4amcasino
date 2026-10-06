import { appendFileSync } from 'node:fs';

/**
 * Env-gated structured diagnostics for the hand engine. Off by default; set
 * `BOT_DEBUG=1` (and optionally `BOT_DEBUG_FILE`) to capture the full timer /
 * turn / betting timeline for a hand. Never throws into the game loop.
 */
export function hdbg(event: string, data: Record<string, unknown>): void {
  if (!process.env.BOT_DEBUG) return;
  try {
    appendFileSync(
      process.env.BOT_DEBUG_FILE ?? '/tmp/opencode/hand-debug.log',
      `${Date.now()} ${event} ${JSON.stringify(data)}\n`,
    );
  } catch {
    /* diagnostics must never affect the game */
  }
}
