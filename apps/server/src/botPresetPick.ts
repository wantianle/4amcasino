import { RULE_PRESETS, normalizePolicyKind, type PolicyKind } from '@4am/agent-core';

/**
 * Randomised bot-style assignment at create time.
 *
 * Background: at the default `medium` difficulty the rules-v1 engine always
 * wins (`resolvePolicyForDifficulty` injects `engine: 'rules-v1'`), so a bot's
 * whole play style is selected by `policy_kind` through `RULE_PRESETS`. Every
 * bot created with the same kind therefore behaves identically up to its RNG
 * seed, which makes a table of bots look uniform. This module assigns each
 * newly created bot a **random** preset so a room ends up visibly mixed.
 *
 * Scope note: this only decides which `policy_kind` is *written at create*.
 * The runner reads `policy_kind` once at claim/start time and holds the
 * resolved policy in memory, so changing an existing row has no effect until
 * its runner is restarted (see `botRunner.ts`).
 */

/**
 * The local presets a new bot may be assigned, in a stable order: derived from
 * `RULE_PRESETS` so it cannot drift from the agent-core table (adding/removing
 * a preset there automatically flows through). All four are local, deterministic
 * and cheap to run.
 *
 * Deliberately EXCLUDES `llm`: it is not a style variety knob but a distinct
 * capability (external model call, per-call cost, multi-second latency, needs a
 * server-side key). Mixing it into random assignment would make some seats
 * slow and cost-bearing for no style benefit. A caller that explicitly asks for
 * `llm` is still honoured by the create route; only the random lottery is local.
 */
export const RANDOM_BOT_PRESETS: readonly PolicyKind[] = Object.freeze(
  Object.keys(RULE_PRESETS) as PolicyKind[],
);

/**
 * Pick the `policy_kind` for a new bot. Pure and deterministic given `rng` and
 * `existingKinds`, so it is unit-testable without a database or a live route.
 *
 * Distribution: **balanced by deficit**, not a flat draw. The presets that are
 * currently least represented in the room are the only candidates, and one is
 * chosen uniformly among them (ties broken by `rng`). This guarantees a visible
 * spread — with four presets, the first four creates in a room are always one
 * of each — instead of a flat draw where "5 bots all the same kind" is possible.
 *
 * `existingKinds` is the room's current `policy_kind` list (any status). Values
 * are normalised so aliases (`scripted`, `lag`, `random`, ...) count towards
 * their canonical preset; unknown values and `llm` are ignored for balance
 * (they cannot be chosen, so counting them would be meaningless).
 *
 * `rng` is expected to return a value in `[0, 1)`; a non-finite or out-of-range
 * value is clamped rather than allowed to index out of bounds.
 */
export function pickBotPolicyKind(
  rng: () => number = Math.random,
  existingKinds: readonly string[] = [],
): PolicyKind {
  const counts = new Map<PolicyKind, number>();
  for (const preset of RANDOM_BOT_PRESETS) counts.set(preset, 0);
  for (const raw of existingKinds) {
    const kind = normalizePolicyKind(raw);
    if (kind === null) continue;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }

  let min = Infinity;
  for (const preset of RANDOM_BOT_PRESETS) min = Math.min(min, counts.get(preset)!);
  // `min` is finite because RANDOM_BOT_PRESETS is non-empty, so the pool below
  // always holds at least one preset.
  const pool = RANDOM_BOT_PRESETS.filter((preset) => counts.get(preset) === min);

  const roll = rng();
  const index = Number.isFinite(roll)
    ? Math.min(pool.length - 1, Math.max(0, Math.floor(roll * pool.length)))
    : 0;
  return pool[index]!;
}

/**
 * The room's persisted `policy_kind` values, oldest first. A plain read used
 * only to balance the next create; it never mutates a row.
 */
export function roomPolicyKinds(
  db: { prepare(sql: string): { all(...params: unknown[]): unknown[] } },
  roomId: string,
): string[] {
  const rows = db
    .prepare('SELECT policy_kind FROM bot_accounts WHERE room_id = ? ORDER BY created_at, id')
    .all(roomId) as { policy_kind: string }[];
  return rows.map((row) => row.policy_kind);
}
