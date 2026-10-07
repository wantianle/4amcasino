import { normalizePolicyKind, type PolicyKind } from './policyStyles.js';

/**
 * Rules-v1 engine: the style knobs that scale the baseline preflop charts.
 *
 * These are deliberately coarse multipliers on frequencies derived from the
 * range tables, not equity thresholds. `tight-aggressive` is the reference
 * preset and the default when `policy_kind` names one of the four styles.
 *
 *   - `preflopScale`        scales flat-call frequency and, via its fractional
 *                           part (`preflopScale - 1`), opens the marginal RFI
 *                           hands — so >1 is genuinely wider, not just clamped;
 *   - `threeBetScale`       scales 3-bet/4-bet frequencies;
 *   - `bluffScale`          scales weighted "blocker" bluff entries;
 *   - `valueBetScale`       scales the postflop value-bet probability;
 *   - `multiwayBluffScale`  extra discount on aggression in multiway pots;
 *   - `maxOverbetFrequency` cap on the postflop overbet frequency.
 */

export const RULES_ENGINE = 'rules-v1';

/**
 * Default direction of the headcount-adaptive preflop engine: **on**.
 *
 * The adaptive charts (`preflopCharts/`) are now the default engine for every
 * rules-v1 preset; the position-named legacy tables remain as the explicit
 * fallback and are still the regression baseline. The `adaptivePreflop` field
 * on `RuleParams` is the kill-switch:
 *
 *  - default (this constant) = `true` → adaptive whenever the headcount is
 *    trustworthy and the spot has an adaptive anchor;
 *  - per-bot `policy_json.adaptivePreflop = false` → that bot runs the legacy
 *    position tables (explicit opt-out);
 *  - `FOURAM_ADAPTIVE_PREFLOP=0` (also `false`/`off`/`no`) flips the *default*
 *    back to legacy for every preset — the environment-wide kill-switch. An
 *    explicit per-bot boolean still wins over the default.
 *
 * A documented env switch keeps the rollback to the legacy engine a one-liner
 * without a redeploy, while the default direction is adaptive.
 */
export const ADAPTIVE_PREFLOP_DEFAULT: boolean = (() => {
  const raw = typeof process !== 'undefined' ? process.env?.FOURAM_ADAPTIVE_PREFLOP : undefined;
  if (raw === undefined || raw.trim() === '') return true;
  return !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase());
})();

export interface RuleParams {
  preflopScale: number;
  threeBetScale: number;
  bluffScale: number;
  valueBetScale: number;
  multiwayBluffScale: number;
  maxOverbetFrequency: number;
  /**
   * Kill-switch for the headcount-adaptive charts. Defaults to
   * `ADAPTIVE_PREFLOP_DEFAULT` (on): first-in spots resolve from the adaptive
   * charts (`preflopCharts/`) keyed by `behindUnacted` instead of the
   * position-named legacy tables. `false` deliberately routes the bot back to
   * the legacy tables; so does a headcount/spot the adaptive path cannot trust
   * (missing `seatOrder`, incomplete history, HU facing a raise, ...).
   */
  adaptivePreflop: boolean;
}

export const RULE_PRESETS: Record<PolicyKind, RuleParams> = {
  'tight-aggressive': {
    preflopScale: 1,
    threeBetScale: 1,
    bluffScale: 1,
    valueBetScale: 1,
    multiwayBluffScale: 0.5,
    maxOverbetFrequency: 0.15,
    adaptivePreflop: ADAPTIVE_PREFLOP_DEFAULT,
  },
  'loose-aggressive': {
    preflopScale: 1.5,
    threeBetScale: 1.3,
    bluffScale: 1.6,
    valueBetScale: 1.15,
    multiwayBluffScale: 0.8,
    maxOverbetFrequency: 0.35,
    adaptivePreflop: ADAPTIVE_PREFLOP_DEFAULT,
  },
  // A station opens a touch wide (but far less than a LAG) and almost never
  // 3-bets or bluffs.
  'calling-station': {
    preflopScale: 1.15,
    threeBetScale: 0.35,
    bluffScale: 0.1,
    valueBetScale: 1,
    multiwayBluffScale: 0.2,
    maxOverbetFrequency: 0,
    adaptivePreflop: ADAPTIVE_PREFLOP_DEFAULT,
  },
  'constrained-random': {
    preflopScale: 1.1,
    threeBetScale: 1,
    bluffScale: 1.2,
    valueBetScale: 1,
    multiwayBluffScale: 0.7,
    maxOverbetFrequency: 0.25,
    adaptivePreflop: ADAPTIVE_PREFLOP_DEFAULT,
  },
};

/** Numeric knobs (everything except the boolean `adaptivePreflop`). */
type NumericRuleParam = Exclude<keyof RuleParams, 'adaptivePreflop'>;

const PARAM_RANGES: Record<NumericRuleParam, [number, number]> = {
  preflopScale: [0, 2],
  threeBetScale: [0, 2],
  bluffScale: [0, 2],
  valueBetScale: [0, 2],
  multiwayBluffScale: [0, 1],
  maxOverbetFrequency: [0, 1],
};

const PARAM_KEYS = Object.keys(PARAM_RANGES) as NumericRuleParam[];

/**
 * Per-hand randomisation of the `constrained-random` preset.
 *
 * Background: `constrained-random` is only a *fixed* parameter set, so at the
 * default `medium` difficulty every bot with that kind behaves identically (up
 * to its RNG seed). It is named "random" but, unlike the legacy `StylePolicy`
 * path (`mixedDecision`, unreachable at medium because `forceRulesEngine`
 * injects `engine: 'rules-v1'`), the rules engine never varies the style itself.
 *
 * This sampler does exactly that, and only that: it jitters every *numeric*
 * `RuleParams` knob around the preset value, once per hand, and leaves
 * `adaptivePreflop` untouched. The jitter is **symmetric and multiplicative**
 * (`v * (1 +/- SPREAD)`). It is a bounded stylistic perturbation around the
 * existing parameters: it is not expected to produce an obvious systematic
 * directional shift, but the strength mean has **not** been verified (the
 * parameter mean is not the decision-strength mean — clamping and the engines'
 * non-linear use of the knobs can both bias the result either way).
 *
 * `CONSTRAINED_RANDOM_SPREAD = 0.25` is deliberately wide because the product
 * goal is a *visibly* different style across hands; if the goal were instead to
 * hold strength as constant as possible, 10–15% would be the safer band. Draws
 * are clamped to each knob's legal `PARAM_RANGES` range, so a sampled config can
 * never escape what `parseRuleConfig` accepts.
 *
 * Seeded and deterministic: given the same hand identity the same params are
 * produced (see `ConstrainedRandomPolicy`), so a replay of a hand reproduces it.
 */
export const CONSTRAINED_RANDOM_SPREAD = 0.25;

/**
 * Sample one hand's `RuleParams` from `base`, using `rng` (expected in `[0,1)`).
 * Pure: no state, no `Math.random`. A non-finite draw is treated as 0 (the low
 * edge of the band) rather than allowed to poison a parameter.
 */
export function sampleConstrainedRandomParams(base: RuleParams, rng: () => number): RuleParams {
  const out: RuleParams = { ...base };
  for (const name of PARAM_KEYS) {
    const [lo, hi] = PARAM_RANGES[name];
    const v = base[name];
    const bandLo = Math.max(lo, v * (1 - CONSTRAINED_RANDOM_SPREAD));
    const bandHi = Math.min(hi, v * (1 + CONSTRAINED_RANDOM_SPREAD));
    const draw = rng();
    const unit = Number.isFinite(draw) ? Math.min(1, Math.max(0, draw)) : 0;
    out[name] = bandLo + unit * (bandHi - bandLo);
  }
  return out;
}

/** Read the `engine` field without throwing, for the resolver's dispatch. */
export function detectRulesEngine(json: string | null | undefined): string | null {
  if (json === null || json === undefined || json.trim() === '') return null;
  try {
    const raw: unknown = JSON.parse(json);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const engine = (raw as Record<string, unknown>).engine;
    return typeof engine === 'string' ? engine : null;
  } catch {
    return null;
  }
}

export interface RuleConfigResult {
  /** Preset explicitly selected by an optional `rules` field, if valid. */
  presetKind: PolicyKind | null;
  params: RuleParams;
  errors: string[];
  applied: boolean;
}

/**
 * Parse a rules-v1 `policy_json` blob. Invalid JSON / shapes / values never
 * throw: offending fields keep their preset default and are reported. Unknown
 * keys are reported too (`engine` and `rules` are consumed here).
 */
export function parseRuleConfig(kind: PolicyKind, json: string | null | undefined): RuleConfigResult {
  const errors: string[] = [];
  let presetKind: PolicyKind | null = null;
  const params: RuleParams = { ...RULE_PRESETS[kind] };
  if (json === null || json === undefined || json.trim() === '') {
    return { presetKind, params, errors, applied: false };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    errors.push('policy_json is not valid JSON; using rules preset defaults');
    return { presetKind, params, errors, applied: false };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push('policy_json must be a JSON object; using rules preset defaults');
    return { presetKind, params, errors, applied: false };
  }
  const obj = raw as Record<string, unknown>;
  let applied = false;

  // Phase 1: resolve the preset. This must happen before explicit parameters so
  // the result does not depend on JSON key order.
  const rulesValue = obj.rules;
  if (rulesValue !== undefined) {
    if (typeof rulesValue === 'string') {
      const preset = normalizePolicyKind(rulesValue);
      if (preset) {
        presetKind = preset;
        Object.assign(params, RULE_PRESETS[preset]);
        applied = true;
      } else {
        errors.push(`unknown rules preset "${rulesValue}" ignored`);
      }
    } else {
      errors.push('"rules" must be a string preset name; kept default');
    }
  }

  // Phase 2: explicit parameters always win over the preset, whatever order the
  // keys appear in.
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'engine' || key === 'rules') continue;
    if (key === 'adaptivePreflop') {
      if (typeof value !== 'boolean') {
        errors.push(`rules parameter "adaptivePreflop" must be a boolean; kept default`);
        continue;
      }
      params.adaptivePreflop = value;
      applied = true;
      continue;
    }
    if (!(PARAM_KEYS as readonly string[]).includes(key)) {
      errors.push(`unknown rules parameter "${key}" ignored`);
      continue;
    }
    const name = key as NumericRuleParam;
    const [lo, hi] = PARAM_RANGES[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < lo || value > hi) {
      errors.push(`rules parameter "${key}" must be a number in [${lo}, ${hi}]; kept default`);
      continue;
    }
    params[name] = value;
    applied = true;
  }
  return { presetKind, params, errors, applied };
}
