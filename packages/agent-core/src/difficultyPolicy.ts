import type { Policy } from './policy.js';
import type { P2Options } from './postflopPolicy.js';
import { RULES_ENGINE } from './ruleStyles.js';
import { resolvePolicy, type PolicyResolution } from './stylePolicy.js';

/**
 * Bot difficulty: an orthogonal strength tier on top of `policy_kind` (play
 * style). The mapping is:
 *
 *   - `low`    -> the legacy resolution: a style without `engine: 'rules-v1'`
 *                 gets `ScriptedPolicy`/`StylePolicy` exactly as before;
 *   - `medium` -> forces the chart-based `rules-v1` engine (`RulePolicy`),
 *                 regardless of whether `policy_json` opted in; preflop and
 *                 postflop both run the real `rules-v1` engines (the postflop
 *                 engine is `PostflopPolicy`, not the old placeholder). This is
 *                 now the DEFAULT tier;
 *   - `high`   -> was RESERVED for a future GTO tier and never implemented. It
 *                 has been **withdrawn** from the tier list so the product no
 *                 longer offers a choice that silently ran as `medium`. A
 *                 persisted/legacy `high` request is still parsed and reported
 *                 as withdrawn (never silently), then resolves to the default.
 *
 * Difficulty never dies silently: the effective tier and any fallback are
 * returned so the server can log/surface them.
 */

export type BotDifficulty = 'low' | 'medium';

export const BOT_DIFFICULTIES = ['low', 'medium'] as const;

/**
 * Tiers that were once accepted but have no implementation. Kept as an explicit
 * list so a legacy value is reported as "withdrawn" (with a precise warning)
 * rather than as a generic parse error.
 */
export const RETIRED_BOT_DIFFICULTIES = ['high'] as const;

export const DEFAULT_BOT_DIFFICULTY: BotDifficulty = 'medium';

/** Case/space-insensitive difficulty parser; null for unknown/empty values. */
export function normalizeBotDifficulty(raw: string | null | undefined): BotDifficulty | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  return (BOT_DIFFICULTIES as readonly string[]).includes(key) ? (key as BotDifficulty) : null;
}

export interface DifficultyResolution {
  /** Effective tier after fallback (always one of `BOT_DIFFICULTIES`). */
  difficulty: BotDifficulty;
  /** The tier as requested, preserved for observability; null when absent. */
  requested: string | null;
  /**
   * Always `false` now that `high` is withdrawn (no tier silently downgrades);
   * kept on the shape so the server's observability contract is unchanged.
   */
  downgraded: boolean;
  /** True when a withdrawn/unrecognised value was ignored and the default used. */
  ignored: boolean;
  warnings: string[];
}

/**
 * Resolve a requested difficulty to its effective tier:
 *   - absent/empty        -> `medium` (the default, no warning);
 *   - unknown value       -> `medium` + warning (server validation 400s first);
 *   - `high` (withdrawn)  -> `medium` + "withdrawn" warning (never silent);
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
    const key = requested.trim().toLowerCase();
    const retired = (RETIRED_BOT_DIFFICULTIES as readonly string[]).includes(key);
    warnings.push(
      retired
        ? `difficulty "${requested}" (reserved GTO tier) is withdrawn; falling back to ${DEFAULT_BOT_DIFFICULTY}`
        : `unknown difficulty "${requested}"; falling back to ${DEFAULT_BOT_DIFFICULTY}`,
    );
    return { difficulty: DEFAULT_BOT_DIFFICULTY, requested, downgraded: false, ignored: true, warnings };
  }
  return { difficulty: normalized, requested, downgraded: false, ignored: false, warnings };
}

export interface DifficultyPolicyResolution extends PolicyResolution {
  /** Effective tier actually used to pick the policy. */
  difficulty: BotDifficulty;
  /** Tier as requested, preserved for observability (may be a withdrawn/unknown value). */
  requestedDifficulty: string | null;
  /** Always `false` now that `high` is withdrawn. */
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
 *
 * `opts.p2` is forwarded verbatim to {@link resolvePolicy}, so the server's P2
 * rollback switches reach the `RulePolicy`/`PostflopPolicy` built underneath the
 * rules branch. It applies to `low` too (a `policy_json` that opts into
 * `rules-v1` runs a `RulePolicy` there as well).
 */
export function resolvePolicyForDifficulty(
  kindRaw: string | null | undefined,
  policyJson: string | null | undefined,
  difficultyRaw?: string | null,
  opts?: { seed?: number; p2?: Partial<P2Options> },
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

  // `medium` (the default tier): the rules engine wins over a plain style, but
  // the persisted `policy_kind` still selects the rule preset (the rules branch
  // inside `resolvePolicy` handles that).
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
  opts?: { seed?: number; p2?: Partial<P2Options> },
): Policy {
  return resolvePolicyForDifficulty(kindRaw, policyJson, difficultyRaw, opts).policy;
}
