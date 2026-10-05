/**
 * Phase 2: the four built-in bot styles and their tuning parameters.
 *
 * All style magic numbers live here, in one readable table, so behaviour is easy
 * to compare and `policy_json` overrides have a single schema to validate
 * against. A `StylePolicy` consumes a `StyleParams`; `tight-aggressive` is the
 * reference style (and the default).
 */

export type PolicyKind =
  | 'tight-aggressive'
  | 'loose-aggressive'
  | 'calling-station'
  | 'constrained-random';

export const DEFAULT_POLICY_KIND: PolicyKind = 'tight-aggressive';

/**
 * Tuning knobs, all equity in [0, 1] (Monte-Carlo win share vs random hands):
 *  - `preflopEntryEquity`: minimum equity to voluntarily put money in preflop;
 *  - `callEquity`        : equity that always justifies a call, whatever the price;
 *  - `valueRaiseEquity`  : equity at/above which we bet or raise for value;
 *  - `callMargin`        : equity edge required over raw pot odds to call
 *                          (negative = a station that calls even when slightly behind);
 *  - `bluffFrequency`    : probability of firing a bet/raise with a non-value hand;
 *  - `valueRaiseFraction`: fraction of the pot used to size a value raise;
 *  - `bluffRaiseFraction`: fraction of the pot used to size a bluff raise;
 *  - `randomness`        : how strongly a constrained-random mix ignores equity
 *                          (0 = pure heuristic, 1 = heavily mixed).
 */
export interface StyleParams {
  preflopEntryEquity: number;
  callEquity: number;
  valueRaiseEquity: number;
  callMargin: number;
  bluffFrequency: number;
  valueRaiseFraction: number;
  bluffRaiseFraction: number;
  randomness: number;
}

export const POLICY_STYLES: Record<PolicyKind, StyleParams> = {
  // Tight and aggressive: enters few pots, bets/raises its strong hands, gives
  // up weak hands facing pressure.
  'tight-aggressive': {
    preflopEntryEquity: 0.5,
    callEquity: 0.38,
    valueRaiseEquity: 0.6,
    callMargin: 0.02,
    bluffFrequency: 0.12,
    valueRaiseFraction: 0.6,
    bluffRaiseFraction: 0.5,
    randomness: 0,
  },
  // Loose and aggressive: plays many hands and applies frequent pressure.
  'loose-aggressive': {
    preflopEntryEquity: 0.4,
    callEquity: 0.3,
    valueRaiseEquity: 0.54,
    callMargin: 0,
    bluffFrequency: 0.26,
    valueRaiseFraction: 0.85,
    bluffRaiseFraction: 0.75,
    randomness: 0,
  },
  // Calling station: calls far too wide and rarely raises or bluffs.
  'calling-station': {
    preflopEntryEquity: 0.36,
    callEquity: 0.22,
    valueRaiseEquity: 0.74,
    callMargin: -0.1,
    bluffFrequency: 0.02,
    valueRaiseFraction: 0.25,
    bluffRaiseFraction: 0.2,
    randomness: 0,
  },
  // Constrained random: legal, seeded, lightly equity-biased mixing.
  'constrained-random': {
    preflopEntryEquity: 0.45,
    callEquity: 0.32,
    valueRaiseEquity: 0.58,
    callMargin: 0,
    bluffFrequency: 0.33,
    valueRaiseFraction: 0.7,
    bluffRaiseFraction: 0.6,
    randomness: 1,
  },
};

/** Case/space/underscore-insensitive aliases, including the Phase 1b name. */
const KIND_ALIASES: Record<string, PolicyKind> = {
  'tight-aggressive': 'tight-aggressive',
  scripted: 'tight-aggressive',
  tag: 'tight-aggressive',
  tight: 'tight-aggressive',
  'loose-aggressive': 'loose-aggressive',
  lag: 'loose-aggressive',
  loose: 'loose-aggressive',
  'calling-station': 'calling-station',
  station: 'calling-station',
  caller: 'calling-station',
  'constrained-random': 'constrained-random',
  random: 'constrained-random',
  rand: 'constrained-random',
};

/**
 * Map an arbitrary persisted `policy_kind` to a known style, or null when it is
 * unknown (the caller then falls back to the default and records a warning).
 */
export function normalizePolicyKind(raw: string | null | undefined): PolicyKind | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return KIND_ALIASES[key] ?? null;
}

const PARAM_RANGES: Record<keyof StyleParams, [number, number]> = {
  preflopEntryEquity: [0, 1],
  callEquity: [0, 1],
  valueRaiseEquity: [0, 1],
  callMargin: [-0.5, 1],
  bluffFrequency: [0, 1],
  valueRaiseFraction: [0, 1],
  bluffRaiseFraction: [0, 1],
  randomness: [0, 1],
};

const PARAM_KEYS = Object.keys(PARAM_RANGES) as (keyof StyleParams)[];

export interface StyleOverrideResult {
  params: StyleParams;
  errors: string[];
  /** True when at least one valid override was applied. */
  applied: boolean;
}

/**
 * Validate a `policy_json` override blob against the style schema. Invalid JSON,
 * non-objects, unknown keys and out-of-range values are reported (never thrown);
 * the offending fields keep their style default, so a bad config degrades to the
 * built-in style instead of crashing the bot.
 */
export function parseStyleOverrides(
  kind: PolicyKind,
  json: string | null | undefined,
): StyleOverrideResult {
  const params: StyleParams = { ...POLICY_STYLES[kind] };
  const errors: string[] = [];
  if (json === null || json === undefined || json.trim() === '') {
    return { params, errors, applied: false };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    errors.push('policy_json is not valid JSON; using style defaults');
    return { params, errors, applied: false };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push('policy_json must be a JSON object; using style defaults');
    return { params, errors, applied: false };
  }
  let applied = false;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(PARAM_KEYS as readonly string[]).includes(key)) {
      errors.push(`unknown policy parameter "${key}" ignored`);
      continue;
    }
    const name = key as keyof StyleParams;
    const [lo, hi] = PARAM_RANGES[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < lo || value > hi) {
      errors.push(`policy parameter "${key}" must be a number in [${lo}, ${hi}]; kept default`);
      continue;
    }
    params[name] = value;
    applied = true;
  }
  return { params, errors, applied };
}
