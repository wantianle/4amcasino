import {
  DEFAULT_LLM_MAX_OUTPUT_TOKENS,
  DEFAULT_LLM_MIN_MODEL_BUDGET_MS,
  LlmPolicy,
  P2_ALL_OFF,
  StylePolicy,
  resolveDifficulty,
  resolvePolicyForDifficulty,
  type BotDifficulty,
  type LlmMetric,
  type LlmPolicyOptions,
  type P2Options,
  type Policy,
} from '@4am/agent-core';

/**
 * Phase 3: server-side policy selection.
 *
 * `BotRunner` resolves the persisted `policy_kind` through this module so the
 * `llm` kind can be built here without teaching `@4am/agent-core`'s pure style
 * resolver about server configuration. All four built-in styles, the `scripted`
 * alias and `policy_json` overrides are unchanged and still go through
 * `resolvePolicy()`.
 *
 * The LLM fallback is deliberately a small, cheap `StylePolicy`: when the model
 * is unavailable (missing key, timeout, budget exhausted) the bot keeps playing
 * a legal local game rather than erroring out.
 *
 * Difficulty is a separate, orthogonal axis (`low`/`medium`) resolved by
 * `@4am/agent-core`'s `resolvePolicyForDifficulty`: `low` keeps the legacy style
 * resolution, `medium` forces the `rules-v1` engine; absent/unknown/withdrawn
 * values fall back to `medium`. `policyKind='llm'` outranks all of them - an LLM
 * bot is never swapped for a rules engine by difficulty.
 */

/**
 * The server-side LLM configuration is exactly `LlmPolicyOptions` minus the
 * local `fallback`, which the resolver supplies. Keeping it derived (rather
 * than re-declared) means the two can never drift.
 */
export type BotLlmOptions = Omit<LlmPolicyOptions, 'fallback'>;

export const DEFAULT_LLM_BASE_URL = 'https://sub2api.minieye.tech/v1';
export const DEFAULT_LLM_MODEL = 'deepseek-flash';
// Real deepseek-flash round-trips measure ~3-4s at p50 and ~10-15s at p95; the
// old 2s default timed out on most calls in production and fell back to the
// local policy. 12s keeps headroom for the p95 tail while still bounding one
// request; override with `LLM_TIMEOUT_MS`. The action clock (server/harness)
// further clamps this to `deadline - now - DEADLINE_MARGIN_MS`.
export const DEFAULT_LLM_TIMEOUT_MS = 12_000;
export const DEFAULT_LLM_MAX_CALLS_PER_HAND = 24;
// The 2048 output-token default lives with `LlmPolicy` (agent-core), the one
// place that knows why it is 2048; re-exported here for the server resolver and
// its tests. `LLM_MAX_OUTPUT_TOKENS` overrides it.
export { DEFAULT_LLM_MAX_OUTPUT_TOKENS };
// The minimum-budget default (why 6s) lives with `LlmPolicy`; re-exported here
// for the server resolver and its tests. `LLM_MIN_BUDGET_MS` overrides it, and
// `0` disables proactive degradation.
export { DEFAULT_LLM_MIN_MODEL_BUDGET_MS };

/** Kind check shared by the runner and the resolver. */
export function isLlmPolicyKind(kind: string | null | undefined): boolean {
  return (kind ?? '').trim().toLowerCase() === 'llm';
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Like `positiveInt` but 0 is a meaningful value (here: disable the check). */
function nonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * Read the LLM configuration from server env only. It is never persisted to the
 * DB, exposed over the API, or written to logs; `onMetric` receives only the
 * structured, non-sensitive events described by `LlmMetric`.
 */
export function llmOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  onMetric?: (event: LlmMetric) => void,
): BotLlmOptions {
  return {
    apiKey: env.LLM_API_KEY ?? '',
    baseUrl: env.LLM_BASE_URL ?? DEFAULT_LLM_BASE_URL,
    model: env.LLM_MODEL ?? DEFAULT_LLM_MODEL,
    timeoutMs: positiveInt(env.LLM_TIMEOUT_MS, DEFAULT_LLM_TIMEOUT_MS),
    maxCallsPerHand: positiveInt(env.LLM_MAX_CALLS_PER_HAND, DEFAULT_LLM_MAX_CALLS_PER_HAND),
    maxOutputTokens: positiveInt(env.LLM_MAX_OUTPUT_TOKENS, DEFAULT_LLM_MAX_OUTPUT_TOKENS),
    minModelBudgetMs: nonNegativeInt(env.LLM_MIN_BUDGET_MS, DEFAULT_LLM_MIN_MODEL_BUDGET_MS),
    shadow: env.LLM_SHADOW === '1' || env.LLM_SHADOW === 'true',
    onMetric,
  };
}

export interface BotPolicyResolution {
  /** `llm` or the normalised style kind. */
  kind: string;
  /** Effective difficulty tier after fallback (`high` never survives as `high`). */
  difficulty: BotDifficulty;
  /** Tier as requested, preserved for observability (may be a withdrawn/unknown value). */
  requestedDifficulty: string | null;
  /** Always `false` now that `high` is withdrawn (no silent tier downgrade). */
  downgraded: boolean;
  policy: Policy;
  /**
   * Human-readable notes: difficulty fallback (unknown value, withdrawn `high`),
   * unknown kind and invalid `policy_json`.
   */
  warnings: string[];
}

/**
 * P2 rollback kill-switch, read from server env only (`llmOptionsFromEnv`'s
 * sibling). The four P2 postflop switches are ON by default; this returns an
 * explicit all-off override for the whole engine when either:
 *
 *  - `FOURAM_P2_ALL_OFF` is truthy (`1`/`true`/`on`/`yes`), or
 *  - `FOURAM_P2=off` (also `false`/`0`/`no`).
 *
 * Anything else (including unset/invalid) returns `{}`, which keeps `DEFAULT_P2`
 * (all on) - so production runs P2 unless an operator explicitly rolls it back.
 * Scope: this only reverts the four P2 behaviours; it does NOT undo the
 * always-on `evaluateHand` straight-draw fix, so call it "P2 all-off / P2
 * rollback", never a full historical rollback. Ignored for `policyKind='llm'`
 * (an LLM policy owns its own decision path).
 */
export function p2OptionsFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<P2Options> {
  const allOff = isTruthyFlag(env.FOURAM_P2_ALL_OFF);
  const p2Raw = env.FOURAM_P2?.trim().toLowerCase();
  const p2Off = p2Raw !== undefined && ['off', 'false', '0', 'no'].includes(p2Raw);
  return allOff || p2Off ? { ...P2_ALL_OFF } : {};
}

/** Truthy env flag: `1`/`true`/`on`/`yes` (case-insensitive); everything else false. */
function isTruthyFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return ['1', 'true', 'on', 'yes'].includes(raw.trim().toLowerCase());
}

/**
 * Resolve a persisted bot config, including the `llm` kind and the difficulty
 * tier.
 *
 * Priority: `policyKind='llm'` wins outright - an LLM bot is never downgraded to
 * a rules engine by a difficulty tier, so `difficulty` only affects the local
 * styles/rules path. For every other kind the difficulty dispatches through
 * `resolvePolicyForDifficulty`:
 *   - `low`    -> legacy `ScriptedPolicy`/`StylePolicy`, unchanged;
 *   - `medium` -> force `engine: 'rules-v1'` (`RulePolicy`); this is the default;
 *   - absent/unknown/withdrawn `high` -> `medium` (withdrawn reported in warnings).
 * The effective tier is returned so the runner/API can observe it.
 *
 * `p2` is forwarded to the underlying `RulePolicy`/`PostflopPolicy` (see
 * {@link p2OptionsFromEnv}); it is ignored for the `llm` kind. Omit it for the
 * default all-on behaviour.
 */
export function resolveBotPolicyDetailed(
  kind: string | null | undefined,
  policyJson: string | null | undefined,
  llmOptions?: BotLlmOptions,
  seed?: number,
  difficulty?: string | null,
  p2?: Partial<P2Options>,
): BotPolicyResolution {
  const difficultyResolution = resolveDifficulty(difficulty);
  if (isLlmPolicyKind(kind)) {
    const policy = new LlmPolicy({
      ...(llmOptions ?? llmOptionsFromEnv({})),
      fallback: new StylePolicy('tight-aggressive', { samples: 32 }),
    });
    return {
      kind: 'llm',
      difficulty: difficultyResolution.difficulty,
      requestedDifficulty: difficultyResolution.requested,
      downgraded: difficultyResolution.downgraded,
      policy,
      warnings: difficultyResolution.warnings,
    };
  }
  const resolved = resolvePolicyForDifficulty(
    kind,
    policyJson,
    difficulty,
    seed === undefined && p2 === undefined ? undefined : { seed, p2 },
  );
  return {
    kind: resolved.kind,
    difficulty: resolved.difficulty,
    requestedDifficulty: resolved.requestedDifficulty,
    downgraded: resolved.downgraded,
    policy: resolved.policy,
    warnings: resolved.warnings,
  };
}
