import { createHash } from 'node:crypto';
import type { MultiRunReason } from '@4am/shared';

/** Street order used by the stats projection's `street` events. */
export const STREET_INDEX: Record<string, number> = { preflop: 0, flop: 1, turn: 2, river: 3 };

/**
 * `multi_run_result.reason`. The shared `MultiRunReason` union does not yet
 * carry `equity_failed`; the engine emits it as a distinct, auditable reason
 * rather than collapsing an equity failure into `ineligible`. Required shared
 * change: add `'equity_failed'` to `MultiRunReason` in
 * `packages/shared/src/wsProtocol.ts` (web handlers treat unknown reasons
 * passively, so the cast is additive until then).
 */
export type MultiRunResultReason = MultiRunReason | 'equity_failed';

/**
 * Deterministic hand id for the bot playtest harness only.
 *
 * The deal randomness itself lives client-side (mental-poker `randomPerm`), but
 * the hand id is minted here on the server, so the harness cannot make its
 * sequence reproducible on its own. When `BOT_TEST_SHUFFLE_SEED` is set we
 * derive the id from `(seed, per-room hand ordinal)` instead of CSPRNG bytes;
 * the default path (`randomBytes`) is byte-for-byte unchanged.
 *
 * ISOLATION: because the id is a pure function of `(seed, ordinal)`,
 * `BOT_TEST_SHUFFLE_SEED` must ONLY be used against a throwaway/temp database.
 * `transcripts.hand_id` is a PRIMARY KEY, so pointing the same seed at a
 * non-empty DB (a reused room, or a restart) re-mints ids that already exist and
 * collides on insert. The eval/playtest harnesses boot a fresh `tmpdir()` DB.
 */
export function testHandId(seed: string, ordinal: number): string {
  return createHash('sha256')
    .update(`4am-test-hand:${seed}:${ordinal}`)
    .digest('hex')
    .slice(0, 16);
}
