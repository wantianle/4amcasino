import type { Policy } from './policy.js';
import { RULES_ENGINE } from './ruleStyles.js';
import { resolvePolicy, type PolicyResolution } from './stylePolicy.js';

/**
 * Bot difficulty: an orthogonal strength tier on top of `policy_kind` (play
 * style). The mapping is:
 *
 *   - `low`    -> the legacy resolution: a style without `engine: 'rules-v1'`
 *                 gets `ScriptedPolicy`/`StylePolicy` exactly as before (the
 *                 default, so existing bots are unchanged);
 *   - `medium` -> forces the chart-based `rules-v1` engine (`RulePolicy`),
 *                 regardless of whether `policy_json` opted in; preflop is
 *                 implemented, postflop still uses the documented placeholder
 *                 fallback (same as an explicit `engine: 'rules-v1'` today);
 *   - `high`   -> RESERVED for a future GTO tier. It is not implemented, so the
 *                 backend accepts the value but explicitly falls back to
 *                 `medium` and reports a warning - never silently.
 *
 * Difficulty never dies silently: the effective tier and any fallback are
 * returned so the server can log/surface them.
 */

export type BotDifficulty = 'low' | 'medium' | 'high';

export const BOT_DIFFICULTIES = ['low', 'medium', 'high'] as const;

export const DEFAULT_BOT_DIFFICULTY: BotDifficulty = 'low';

/** Case/space-insensitive difficulty parser; null for unknown/empty values. */
export function normalizeBotDifficulty(raw: string | null | undefined): BotDifficulty | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  return (BOT_DIFFICULTIES as readonly string[]).includes(key) ? (key as BotDifficulty) : null;
}

export interface DifficultyResolution {
  /** Effective tier after fallback: `high` never survives as `high`. */
  difficulty: BotDifficulty;
  /** The tier as requested, preserved for observability; null when absent. */
  requested: string | null;
  /** True when an explicit `high` was downgraded to `medium`. */
  downgraded: boolean;
  /** True when an unrecognised value was ignored and `low` used. */
  ignored: boolean;
  warnings: string[];
}

/**
 * Resolve a requested difficulty to its effective tier:
 *   - absent/empty        -> `low` (silent default);
 *   - unknown value       -> `low` + warning (server validation 400s first);
 *   - `high` (GTO)        -> `medium` + warning (reserved, not implemented);
 *   - `low`/`medium`      -> itself.
 */
export function resolveDifficulty(raw: string | null | undefined): DifficultyResolution {
  const warnings: string[] = [];
  const requested = raw === null || raw === undefined || raw.trim() === '' ? null : raw;
  if (requested === null) {
    return { difficulty: DEFAULT_BOT_DIFFICULTY, requested: null, downgraded: false, ignored: false, warnings };
  }
  const normalized = normalizeBotDifficulty(requested);
  if (!normalized) {
    warnings.push(`unknown difficulty "${requested}"; falling back to ${DEFAULT_BOT_DIFFICULTY}`);
    return { difficulty: DEFAULT_BOT_DIFFICULTY, requested, downgraded: false, ignored: true, warnings };
  }
  if (normalized === 'high') {
    // GTO reserved: no implementation exists, so fall back to the strongest
    // available tier rather than failing or behaving illegally.
    warnings.push(
      'difficulty "high" (GTO, reserved) is not implemented; falling back to medium (rules-v1)',
    );
    return { difficulty: 'medium', requested, downgraded: true, ignored: false, warnings };
  }
  return { difficulty: normalized, requested, downgraded: false, ignored: false, warnings };
}

export interface DifficultyPolicyResolution extends PolicyResolution {
  /** Effective tier actually used to pick the policy. */
  difficulty: BotDifficulty;
  /** Tier as requested, preserved for observability (may be `high`/unknown). */
  requestedDifficulty: string | null;
  /** True when a requested `high` was downgraded to `medium`. */
  downgraded: boolean;
  /** Warnings produced by difficulty resolution alone (observability). */
  difficultyWarnings: string[];
}

/**
 * Force `engine: 'rules-v1'` into a `policy_json` blob so `resolvePolicy` takes
 * its rules branch.
 *
 * At medium difficulty the persisted `policy_kind` is the single source of the
 * rule preset, so an explicit `policy_json.rules` override is DROPPED (with a
 * warning): `parseRuleConfig` lets `rules` win otherwise, which would let the
 * blob silently disagree with the declared kind. Every other field is preserved.
 * An unparseable/non-object blob is dropped (with a warning) so medium still
 * resolves deterministically instead of degrading to a style policy.
 */
function forceRulesEngine(policyJson: string | null | undefined): {
  json: string;
  warnings: string[];
} {
  const warnings: string[] = [];
  let obj: Record<string, unknown> = {};
  if (policyJson !== null && policyJson !== undefined && policyJson.trim() !== '') {
    try {
      const raw: unknown = JSON.parse(policyJson);
      if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
        obj = { ...(raw as Record<string, unknown>) };
      } else {
        warnings.push('policy_json must be a JSON object; medium difficulty using rules-v1 defaults');
      }
    } catch {
      warnings.push('policy_json is not valid JSON; medium difficulty using rules-v1 defaults');
    }
  }
  if (obj.rules !== undefined) {
    delete obj.rules;
    warnings.push(
      'policy_json "rules" ignored at medium difficulty; the preset comes from policyKind',
    );
  }
  obj.engine = RULES_ENGINE;
  return { json: JSON.stringify(obj), warnings };
}

/**
 * Resolve a persisted `(policy_kind, policy_json)` under a difficulty tier.
 *
 * This is the difficulty dispatch layered on top of {@link resolvePolicy}, which
 * is left completely untouched: `low` calls it verbatim (zero regression), while
 * `medium` injects `engine: 'rules-v1'` before calling it. The returned
 * `warnings` merge difficulty warnings first, then the rules/style warnings.
 */
export function resolvePolicyForDifficulty(
  kindRaw: string | null | undefined,
  policyJson: string | null | undefined,
  difficultyRaw?: string | null,
  opts?: { seed?: number },
): DifficultyPolicyResolution {
  const d = resolveDifficulty(difficultyRaw);

  if (d.difficulty === 'low') {
    const resolved = resolvePolicy(kindRaw, policyJson, opts);
    return {
      ...resolved,
      difficulty: 'low',
      requestedDifficulty: d.requested,
      downgraded: false,
      difficultyWarnings: d.warnings,
      warnings: [...d.warnings, ...resolved.warnings],
    };
  }

  // `medium` (including a `high` downgraded to `medium`): the rules engine wins
  // over a plain style, but the persisted `policy_kind` still selects the rule
  // preset (the rules branch inside `resolvePolicy` handles that).
  const forced = forceRulesEngine(policyJson);
  const resolved = resolvePolicy(kindRaw, forced.json, opts);
  return {
    kind: resolved.kind,
    policy: resolved.policy,
    difficulty: d.difficulty,
    requestedDifficulty: d.requested,
    downgraded: d.downgraded,
    difficultyWarnings: d.warnings,
    warnings: [...d.warnings, ...forced.warnings, ...resolved.warnings],
  };
}

/** Convenience alias for callers that only want the `Policy`. */
export function policyForDifficulty(
  kindRaw: string | null | undefined,
  policyJson: string | null | undefined,
  difficultyRaw: string | null | undefined,
  opts?: { seed?: number },
): Policy {
  return resolvePolicyForDifficulty(kindRaw, policyJson, difficultyRaw, opts).policy;
}
