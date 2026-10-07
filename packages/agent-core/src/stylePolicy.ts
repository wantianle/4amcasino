import type { Policy } from './policy.js';
import type { PolicyKind } from './policyStyles.js';
import {
  DEFAULT_POLICY_KIND,
  normalizePolicyKind,
  parseStyleOverrides,
} from './policyStyles.js';
import { RulePolicy, type PreflopDecisionTelemetry } from './rulePolicy.js';
import type { P2Options } from './postflopPolicy.js';
import { RULES_ENGINE, detectRulesEngine, parseRuleConfig } from './ruleStyles.js';
import { ScriptedPolicy } from './scriptedPolicy.js';
import { StylePolicy } from './styleEngine.js';

/**
 * Style policy resolver (phase 2).
 *
 * `stylePolicy.ts` used to mix the `StylePolicy` implementation with the
 * `policy_kind` + `policy_json` resolver. Phase 6 housekeeping moved the
 * implementation verbatim to `./styleEngine.ts`; this module now holds only the
 * resolver and re-exports `StylePolicy` so the historical import path is
 * unchanged. No routing/behaviour change.
 */

// The engine implementation moved to `./styleEngine.ts`; re-exported so existing
// importers (`difficultyPolicy.ts`, tests) keep their `stylePolicy.js` import.
export { StylePolicy, type StylePolicyOptions } from './styleEngine.js';

export interface PolicyResolution {
  kind: PolicyKind;
  policy: Policy;
  /** Human-readable notes: unknown kind, invalid/ignored `policy_json` fields. */
  warnings: string[];
}

/**
 * Resolve a persisted `policy_kind` + `policy_json` to a concrete policy.
 *
 * - unknown/missing kind -> `DEFAULT_POLICY_KIND` (`tight-aggressive`) + warning;
 * - aliases (e.g. the Phase 1b `scripted`) are accepted;
 * - invalid `policy_json` never throws: offending fields keep their defaults and
 *   are reported in `warnings`;
 * - `policy_json.engine === 'rules-v1'` opts into the chart-based `RulePolicy`
 *   (the `policy_kind` still selects the style preset); every other shape keeps
 *   the legacy `ScriptedPolicy`/`StylePolicy` behaviour byte-for-byte;
 * - the reference `tight-aggressive` keeps its dedicated `ScriptedPolicy`
 *   implementation unless a valid override actually changes a parameter.
 *
 * `opts.seed` is an optional seam for experiments/reproducibility: it seeds the
 * `StylePolicy`/`RulePolicy` RNG. `ScriptedPolicy` and the default
 * `tight-aggressive` path ignore it.
 *
 * `opts.p2` is forwarded to the `RulePolicy` built here, so the caller (server
 * resolver / difficulty dispatch) can inject P2 switches. Omitted fields keep
 * `DEFAULT_P2` (`sizeGrid` / `buckets` on since the 2026-10-06 prune; a product
 * default, not a validated one); pass explicit `P2_ALL_OFF` for the pre-P2 path.
 */
export function resolvePolicy(
  kindRaw: string | null | undefined,
  policyJson?: string | null,
  opts?: {
    seed?: number;
    p2?: Partial<P2Options>;
    onPreflopDecision?: (event: PreflopDecisionTelemetry) => void;
  },
): PolicyResolution {
  const warnings: string[] = [];
  const normalized = normalizePolicyKind(kindRaw);
  if (!normalized)
    warnings.push(`unknown policyKind "${kindRaw ?? ''}"; falling back to ${DEFAULT_POLICY_KIND}`);
  const kind = normalized ?? DEFAULT_POLICY_KIND;

  // Explicit rules-v1 opt-in. The engine field is the only trigger; without it
  // the legacy style resolution below is untouched (zero regression).
  if (detectRulesEngine(policyJson) === RULES_ENGINE) {
    const cfg = parseRuleConfig(kind, policyJson);
    warnings.push(...cfg.errors);
    const presetKind = cfg.presetKind ?? kind;
    const policy: Policy = new RulePolicy({
      kind: presetKind,
      params: cfg.params,
      seed: opts?.seed,
      // P2 rollback switches from the caller (server env); omitted = DEFAULT_P2.
      p2: opts?.p2,
      // Optional read-only preflop telemetry sink (server-side diagnostics only).
      onPreflopDecision: opts?.onPreflopDecision,
      // Exception fallback: `RulePolicy` runs its own rules-v1 postflop engine
      // and only uses this (legal, seeded) StylePolicy if that engine throws.
      fallback: new StylePolicy(kind, { seed: opts?.seed }),
    });
    return { kind, policy, warnings };
  }

  const { params, errors, applied } = parseStyleOverrides(kind, policyJson);
  warnings.push(...errors);
  const policy: Policy =
    kind === 'tight-aggressive' && !applied
      ? new ScriptedPolicy()
      : new StylePolicy(kind, { params, seed: opts?.seed });
  return { kind, policy, warnings };
}
