import { rankOf, suitOf, type CardId } from '@4am/shared';
import { clamp01 } from './preflopMath.js';

/**
 * Rules-v1: a tiny, dependency-free parser for the 169-class preflop range
 * notation used by the baseline range charts.
 *
 * A "hand class" collapses concrete two-card combos into one of 169 buckets:
 * 13 pairs (`AA`), 78 suited (`AKs`) and 78 offsuit (`AKo`). `comboCounts` are
 * the standard 6 / 4 / 12.
 *
 * Supported token forms (comma- or whitespace-separated, e.g. `AA KK` is two
 * classes):
 *   - `KTs`            a single class
 *   - `77`, `AA`       a single pair
 *   - `22+`            every pair from the named rank up to `AA`
 *   - `AJs+` / `ATo+`  same high card, kicker from the named rank up to the
 *                      rank just below the high card (AJs+ = AJs, AQs, AKs)
 *   - `A5s+`           all suited aces with a 5-or-better kicker (A5s..AKs)
 *   - `A5s-A2s`        same high card + same suit, kicker between the two
 *                      inclusive (A5s, A4s, A3s, A2s)
 *   - `22-77`, `AJs-A9s`
 *
 * Spaces around `-`/`+` are tolerated (`A5s - A2s`, `AJs +`), but a dash range
 * must otherwise be one token: `A5s-A2s` (or `A5s - A2s`), never `A5s -A2s B`.
 *
 * The `+` is always "add every class with a *higher* second rank, keeping the
 * first rank fixed" for non-pairs, and "every higher pair" for pairs. It is
 * NOT the connector/diagonal interpretation: `T9s+` expands to just `T9s`
 * (high `T` fixed, kicker already the best below it), not `T9s, JTs, QJs, ...`.
 * The baseline charts in `preflopRanges.ts` list those connectors explicitly.
 *
 * Tokens that cannot be parsed are returned in `invalid` and otherwise ignored,
 * so a malformed persisted range degrades to the rest of the list rather than
 * throwing at the bot.
 */

export type PreflopActionName = 'raise' | 'call';

export interface HandClassInfo {
  /** Canonical key, e.g. `AA`, `AKs`, `72o`. */
  key: string;
  /** 0..12 for ranks 2..A. */
  high: number;
  low: number;
  suited: boolean;
  pair: boolean;
  /** Concrete combos: 6 (pair), 4 (suited), 12 (offsuit). */
  combos: number;
}

const RANK_CHARS = '23456789TJQKA';
const CHAR_TO_RANK: Record<string, number> = {};
for (let i = 0; i < RANK_CHARS.length; i++) CHAR_TO_RANK[RANK_CHARS[i]!] = i;

function rankChar(r: number): string {
  return RANK_CHARS[r]!;
}

/** Build the canonical key for a class, ordering the ranks high-first. */
export function handClassKey(high: number, low: number, suited: boolean): string {
  if (high < low) {
    const t = high;
    high = low;
    low = t;
  }
  if (high === low) return rankChar(high) + rankChar(low);
  return rankChar(high) + rankChar(low) + (suited ? 's' : 'o');
}

const PAIR_RE = /^([2-9TJQKA])\1$/;
const NONPAIR_RE = /^([2-9TJQKA])([2-9TJQKA])([so])$/;

/** Parse exactly one class token (no `+` / `-`); null when malformed. */
function parsePlain(token: string): HandClassInfo | null {
  const pair = PAIR_RE.exec(token);
  if (pair) {
    const r = CHAR_TO_RANK[pair[1]!];
    if (r === undefined) return null;
    return { key: handClassKey(r, r, false), high: r, low: r, suited: false, pair: true, combos: 6 };
  }
  const np = NONPAIR_RE.exec(token);
  if (np) {
    const r1 = CHAR_TO_RANK[np[1]!];
    const r2 = CHAR_TO_RANK[np[2]!];
    if (r1 === undefined || r2 === undefined || r1 === r2) return null;
    const high = Math.max(r1, r2);
    const low = Math.min(r1, r2);
    const suited = np[3] === 's';
    return { key: handClassKey(high, low, suited), high, low, suited, pair: false, combos: suited ? 4 : 12 };
  }
  return null;
}

function expandPlus(base: HandClassInfo): HandClassInfo[] {
  const out: HandClassInfo[] = [];
  if (base.pair) {
    for (let r = base.high; r < 13; r++) out.push(parsePlain(rankChar(r) + rankChar(r))!);
    return out;
  }
  for (let low = base.low; low < base.high; low++) {
    out.push(parsePlain(rankChar(base.high) + rankChar(low) + (base.suited ? 's' : 'o'))!);
  }
  return out;
}

function expandDash(from: HandClassInfo, to: HandClassInfo): HandClassInfo[] {
  const out: HandClassInfo[] = [];
  if (from.pair && to.pair) {
    const lo = Math.min(from.high, to.high);
    const hi = Math.max(from.high, to.high);
    for (let r = lo; r <= hi; r++) out.push(parsePlain(rankChar(r) + rankChar(r))!);
    return out;
  }
  if (!from.pair && !to.pair && from.high === to.high && from.suited === to.suited) {
    const lo = Math.min(from.low, to.low);
    const hi = Math.max(from.low, to.low);
    for (let low = lo; low <= hi; low++) {
      out.push(parsePlain(rankChar(from.high) + rankChar(low) + (from.suited ? 's' : 'o'))!);
    }
    return out;
  }
  return out;
}

/** Expand one token (`AA`, `22+`, `A5s-A2s`, ...) into its classes. */
export function parseRangeToken(tokenRaw: string): HandClassInfo[] {
  const token = tokenRaw.trim().replace(/\s+/g, '');
  if (!token) return [];
  if (token.endsWith('+')) {
    const base = parsePlain(token.slice(0, -1));
    return base ? expandPlus(base) : [];
  }
  if (token.includes('-')) {
    const parts = token.split('-');
    if (parts.length !== 2) return [];
    const a = parsePlain(parts[0]!);
    const b = parsePlain(parts[1]!);
    return a && b ? expandDash(a, b) : [];
  }
  const one = parsePlain(token);
  return one ? [one] : [];
}

export interface ParsedRange {
  /** Canonical 169-class keys contained in the range. */
  keys: Set<string>;
  /** Concrete combo count: sum of 6/4/12 per class. */
  combos: number;
  /** Tokens that could not be parsed (reported, never thrown). */
  invalid: string[];
}

/** Parse a whole comma-separated range spec. Whitespace/newlines are ignored. */
export function parseRange(spec: string): ParsedRange {
  const keys = new Set<string>();
  const invalid: string[] = [];
  // Tolerate spaces around `-`/`+` (`A5s - A2s`), then split on commas *and*
  // whitespace so both `AA,KK` and `AA KK` work.
  const normalised = spec.replace(/\s*([-+])\s*/g, '$1');
  for (const raw of normalised.split(/[\s,]+/)) {
    const token = raw.trim();
    if (!token) continue;
    const expanded = parseRangeToken(token);
    if (expanded.length === 0) {
      invalid.push(token);
      continue;
    }
    for (const h of expanded) keys.add(h.key);
  }
  return { keys, combos: comboCount(keys), invalid };
}

export function comboCount(keys: Iterable<string>): number {
  let total = 0;
  for (const key of keys) total += handClassInfo(key)?.combos ?? 0;
  return total;
}

/** All 169 classes, in a stable order (pairs, suited, offsuit). */
export function allHandClasses(): HandClassInfo[] {
  const out: HandClassInfo[] = [];
  for (let high = 0; high < 13; high++)
    for (let low = 0; low <= high; low++) {
      if (high === low) {
        out.push(parsePlain(rankChar(high) + rankChar(low))!);
      } else {
        out.push(parsePlain(rankChar(high) + rankChar(low) + 's')!);
        out.push(parsePlain(rankChar(high) + rankChar(low) + 'o')!);
      }
    }
  return out;
}

/** Parse a canonical key back into its class; null when malformed. */
export function handClassInfo(key: string): HandClassInfo | null {
  return parsePlain(key.trim());
}

/** Classify the bot's two hole cards (useful for logging / adversarial checks). */
export function handClassForCards(a: CardId, b: CardId): HandClassInfo {
  const ra = rankOf(a);
  const rb = rankOf(b);
  return parsePlain(handClassKey(ra, rb, suitOf(a) === suitOf(b)))!;
}

/**
 * The role a raise entry plays. Keeping value and bluff raises apart is what
 * lets the policy discount aggression (multiway, missing history, loose styles)
 * without ever turning a value hand into a fold.
 */
export type RangeRole = 'value' | 'bluff' | 'marginal';

export interface RangeEntry {
  /** A range spec as understood by `parseRange`. */
  range: string;
  action: PreflopActionName;
  /**
   * Relative frequency for this entry on the covered classes, in [0, 1].
   * Interpreted per role (see `CompiledMix`); a call entry's weight is the flat
   * call frequency.
   */
  weight?: number;
  /**
   * Raise role. Defaults from the weight: `weight >= 1` is a value raise, a
   * fractional weight is a (blocker) bluff. `marginal` marks edge hands that
   * only loose styles open, scaled by `preflopScale - 1`.
   */
  role?: RangeRole;
}

/** Per-class role mix before any style/context scaling. */
export interface CompiledMix {
  /** Probability of a value raise; always a *continuation* (never folds). */
  valueRaise: number;
  /** Probability of a (weighted) bluff raise; the remainder folds. */
  bluffRaise: number;
  /** Probability of a marginal open, only reached by wider styles. */
  marginalRaise: number;
  /** Probability of a flat call. */
  call: number;
}

/** Final, scaled action probabilities for one decision. `raise + call <= 1`. */
export interface ActionMix {
  /** Probability of raising, in [0, 1]. */
  raise: number;
  /** Probability of calling, in [0, 1]. The remainder folds. */
  call: number;
}

const EMPTY_MIX: CompiledMix = { valueRaise: 0, bluffRaise: 0, marginalRaise: 0, call: 0 };

/**
 * Compile weighted range entries into a per-class role mix.
 *
 * A class covered by a single value-raise entry gets `valueRaise` = its weight
 * and the remainder folds; covering the same class under both `raise` and
 * `call` keeps both components (the policy then splits the continue budget).
 * Classes absent from every entry are an implicit 100% fold. This function does
 * NOT cross-normalise: role separation is preserved so the policy can discount
 * bluffs without touching value.
 */
export function compileRangeMix(entries: RangeEntry[]): Map<string, CompiledMix> {
  const acc = new Map<string, CompiledMix>();
  for (const entry of entries) {
    const weight = clamp01(entry.weight ?? 1);
    if (weight <= 0) continue;
    const role: RangeRole =
      entry.action === 'raise' ? (entry.role ?? (weight >= 1 ? 'value' : 'bluff')) : 'value';
    const parsed = parseRange(entry.range);
    for (const key of parsed.keys) {
      let mix = acc.get(key);
      if (!mix) {
        mix = { ...EMPTY_MIX };
        acc.set(key, mix);
      }
      if (entry.action === 'call') mix.call += weight;
      else if (role === 'value') mix.valueRaise += weight;
      else if (role === 'marginal') mix.marginalRaise += weight;
      else mix.bluffRaise += weight;
    }
  }
  for (const mix of acc.values()) {
    mix.valueRaise = clamp01(mix.valueRaise);
    mix.bluffRaise = clamp01(mix.bluffRaise);
    mix.marginalRaise = clamp01(mix.marginalRaise);
    mix.call = clamp01(mix.call);
  }
  return acc;
}

/** Read-only view of a class's compiled mix (zero when absent). */
export function mixFor(
  compiled: Map<string, CompiledMix>,
  key: string,
): CompiledMix {
  return compiled.get(key) ?? EMPTY_MIX;
}
