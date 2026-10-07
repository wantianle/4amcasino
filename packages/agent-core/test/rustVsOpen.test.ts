import { describe, expect, it } from 'vitest';
import {
  RUST_VS_OPEN,
  normalizeRustTriple,
  rustPositionForBehind,
  rustVsOpenRaiseTable,
  rustVsOpenSpotKey,
} from '../src/preflopCharts/index.js';
import { mergeRustVsOpenRaise } from '../src/preflopPolicy.js';
import type { CompiledMix } from '../src/rangeParser.js';

/**
 * Rust (GGPoker, rake-aware) non-BB vs-open cold-3-bet provider.
 *
 * Covers the three things the integration contract turns on:
 *   1. the 6-max -> our-table **position mapping** (exact by action-order
 *      suffix; early 9-max seats unmapped);
 *   2. **normalisation** of the export's non-summing-1 cells, with the raw
 *      residual exposed in provenance;
 *   3. the **three-state** cell semantics: a number (data), `0` (known: do not
 *      raise) and `null` (unknown -> fall back to legacy, never a fold).
 */

describe('rustVsOpen: 6-max -> table position mapping', () => {
  it('maps by action-order suffix, not by seat name', () => {
    expect(rustPositionForBehind(5)).toBe('UTG');
    expect(rustPositionForBehind(4)).toBe('MP');
    expect(rustPositionForBehind(3)).toBe('CO');
    expect(rustPositionForBehind(2)).toBe('BTN');
    expect(rustPositionForBehind(1)).toBe('SB');
    expect(rustPositionForBehind(0)).toBe('BB');
  });

  it('leaves the early 9-max seats (behind 6/7/8) unmapped', () => {
    expect(rustPositionForBehind(6)).toBeNull();
    expect(rustPositionForBehind(7)).toBeNull();
    expect(rustPositionForBehind(8)).toBeNull();
    expect(rustPositionForBehind(Number.NaN)).toBeNull();
    expect(rustPositionForBehind(-1)).toBeNull();
  });

  it('builds the export key for exactly-mappable hero/opener pairs', () => {
    expect(rustVsOpenSpotKey(2, 5)).toBe('BTN-vs-open-UTG');
    expect(rustVsOpenSpotKey(3, 5)).toBe('CO-vs-open-UTG');
    expect(rustVsOpenSpotKey(4, 5)).toBe('MP-vs-open-UTG');
    expect(rustVsOpenSpotKey(1, 4)).toBe('SB-vs-open-MP');
    expect(rustVsOpenSpotKey(1, 2)).toBe('SB-vs-open-BTN');
  });

  it('refuses unmapped hero/opener seats and the BB/SB-open routes', () => {
    // 9-max MP (behind 6) or an early opener (behind 6) has no 6-max equivalent.
    expect(rustVsOpenSpotKey(6, 5)).toBeNull();
    expect(rustVsOpenSpotKey(3, 6)).toBeNull();
    // BB hero and SB opener are not served by this provider.
    expect(rustVsOpenSpotKey(0, 5)).toBeNull();
    expect(rustVsOpenSpotKey(3, 1)).toBeNull();
  });

  it('every mappable key names a real embedded spot', () => {
    for (const spot of Object.keys(RUST_VS_OPEN.spots)) {
      const m = /^(\w+)-vs-open-(\w+)$/.exec(spot);
      expect(m, spot).not.toBeNull();
      expect(rustVsOpenSpotKey(rustBehindFor(m![1]!), rustBehindFor(m![2]!))).toBe(spot);
    }
  });

  function rustBehindFor(name: string): number {
    const entry = Object.entries({ UTG: 5, MP: 4, CO: 3, BTN: 2, SB: 1, BB: 0 }).find(
      ([k]) => k === name,
    );
    if (!entry) throw new Error(`unknown rust seat ${name}`);
    return entry[1];
  }
});

describe('rustVsOpen: three-state normalisation', () => {
  it('treats absent / degenerate cells as null (unknown), never a fold', () => {
    expect(normalizeRustTriple(undefined)).toBeNull();
    expect(normalizeRustTriple(null)).toBeNull();
    expect(normalizeRustTriple([0, 0, 0])).toBeNull();
  });

  it('returns 0 for a pure fold and the raw value for a pure raise', () => {
    expect(normalizeRustTriple([0, 0, 1])).toBe(0);
    expect(normalizeRustTriple([1, 0, 0])).toBe(1);
  });

  it('normalises the raise by the cell total (the export sum can miss 1)', () => {
    expect(normalizeRustTriple([0.25, 0.25, 0.5])).toBeCloseTo(0.25, 12);
    // A cell summing to 0.999: the raise is rescaled, the residual never folds.
    expect(normalizeRustTriple([0.5, 0, 0.499])).toBeCloseTo(0.5 / 0.999, 12);
    // Over 1 is deflated the same way.
    expect(normalizeRustTriple([0.5, 0.25, 0.251])).toBeCloseTo(0.5 / 1.001, 12);
  });

  it('reads malformed rows (wrong length / non-number) as unknown, never fabricates a frequency', () => {
    // Wrong arity. `[0.5, 0.5, 0, 0]` used to read the first three and return
    // 0.333 (a fabricated frequency); a generated export row with extra columns
    // must fall back to legacy instead.
    expect(normalizeRustTriple([0.5, 0.5] as unknown as [number, number, number])).toBeNull();
    expect(normalizeRustTriple([0.5, 0.5, 0, 0] as unknown as [number, number, number])).toBeNull();
    expect(normalizeRustTriple([] as unknown as [number, number, number])).toBeNull();
    // Non-number components. `[0.5, 0.5, '0']` used to inline-add to the string
    // '10' and return 0.05; every component must be a finite number.
    expect(normalizeRustTriple([0.5, 0.5, '0'] as unknown as [number, number, number])).toBeNull();
    expect(normalizeRustTriple(['0.5', 0.5, 0.5] as unknown as [number, number, number])).toBeNull();
    expect(normalizeRustTriple([Number.NaN, 0.5, 0.5])).toBeNull();
    expect(normalizeRustTriple([0.5, Number.POSITIVE_INFINITY, 0.5])).toBeNull();
  });

  it('reads a negative component as unknown, not as a known do-not-raise', () => {
    // A negative frequency cannot occur in a valid distribution, so the row is
    // malformed. `null` (unknown -> legacy fallback) is the conservative read:
    // clamping it to 0 would turn corrupt data into a definite strategy
    // instruction ("never raise this class").
    expect(normalizeRustTriple([-0.5, 1, 0.5])).toBeNull();
    expect(normalizeRustTriple([0.5, -0.1, 0.6])).toBeNull();
  });
});

describe('rustVsOpen: raise table + provenance', () => {
  it('exposes a full 169-class table with the embedded residual provenance', () => {
    const table = rustVsOpenRaiseTable(2, 5); // BTN vs UTG
    expect(table).not.toBeNull();
    expect(table!.spotKey).toBe('BTN-vs-open-UTG');
    expect(table!.raise.size).toBe(169);
    expect(table!.provenance.residualMax).toBe(
      RUST_VS_OPEN.provenance.residualMaxBySpot['BTN-vs-open-UTG'],
    );
    expect(table!.provenance.residualCount).toBeGreaterThan(0);
    expect(table!.provenance.normalisedOnRead).toBe(true);
    for (const [, v] of table!.raise) {
      expect(v === null || (v >= 0 && v <= 1)).toBe(true);
    }
  });

  it('normalises a known cell exactly (AA 0.995 raise / 0.005 call -> 0.995)', () => {
    const table = rustVsOpenRaiseTable(2, 5);
    expect(table!.raise.get('AA')).toBeCloseTo(0.995, 6);
  });

  it('returns null for unmapped seats so the caller falls back to legacy', () => {
    expect(rustVsOpenRaiseTable(6, 5)).toBeNull(); // 9-max MP vs UTG
    expect(rustVsOpenRaiseTable(3, 6)).toBeNull(); // opener behind 6
    expect(rustVsOpenRaiseTable(0, 5)).toBeNull(); // BB hero
  });
});

describe('rustVsOpen: merge keeps the raise exact and never folds legacies', () => {
  const legacy = new Map<string, CompiledMix>([
    // A pure legacy value 3-bet.
    ['QQ', { valueRaise: 1, bluffRaise: 0, marginalRaise: 0, call: 0 }],
    // A legacy cold 3-bet bluff at the 0.55 weight.
    ['KQs', { valueRaise: 0, bluffRaise: 0.55, marginalRaise: 0, call: 0.45 }],
    // A legacy flat call only.
    ['98s', { valueRaise: 0, bluffRaise: 0, marginalRaise: 0, call: 1 }],
  ]);

  it('replaces the raise with the exact Rust frequency, dropping the bluff weight', () => {
    const rust = new Map<string, number | null>([['KQs', 0.4]]);
    const out = mergeRustVsOpenRaise(legacy, rust).get('KQs')!;
    expect(out.valueRaise).toBe(0.4); // NOT 0.4 * 0.55
    expect(out.bluffRaise).toBe(0);
  });

  it('keeps the legacy continuation budget so a premium never folds', () => {
    // Rust raises QQ only 60% of the time; the legacy table never folds QQ, so
    // the missing 40% must become a call, not a fold.
    const rust = new Map<string, number | null>([['QQ', 0.6]]);
    const out = mergeRustVsOpenRaise(legacy, rust).get('QQ')!;
    expect(out.valueRaise).toBe(0.6);
    expect(out.call).toBeCloseTo(0.4, 12);
    expect(out.valueRaise + out.call).toBeCloseTo(1, 12);
  });

  it('never widens a call beyond the legacy continuation', () => {
    const rust = new Map<string, number | null>([['98s', 1]]);
    const out = mergeRustVsOpenRaise(legacy, rust).get('98s')!;
    expect(out.call).toBe(0); // was 1, but the Rust raise consumed it
    expect(out.valueRaise).toBe(1);
  });

  it('falls back to the legacy raise when the export has no data (na -> null)', () => {
    // `KQs` has no Rust data: its legacy bluff raise must survive untouched,
    // and the class must NOT be folded.
    const rust = new Map<string, number | null>([['KQs', null]]);
    const out = mergeRustVsOpenRaise(legacy, rust).get('KQs')!;
    expect(out).toEqual(legacy.get('KQs'));
  });

  it('keeps the exact Rust raise for a class absent from the legacy anchor', () => {
    const rust = new Map<string, number | null>([['A5s', 0.994]]);
    const out = mergeRustVsOpenRaise(legacy, rust).get('A5s')!;
    expect(out.valueRaise).toBe(0.994);
    expect(out.call).toBe(0);
  });

  it('clamps raise + call <= 1 for every class', () => {
    const rust = new Map<string, number | null>([
      ['QQ', 0.6],
      ['KQs', 0.99],
      ['98s', 0.5],
      ['A5s', 0.994],
    ]);
    for (const [, m] of mergeRustVsOpenRaise(legacy, rust)) {
      expect(m.valueRaise + m.bluffRaise + m.marginalRaise + m.call).toBeLessThanOrEqual(1 + 1e-12);
    }
  });

  it('clamps finite out-of-range Rust values, and treats non-finite as unknown', () => {
    // `mergeRustVsOpenRaise` is exported, so a caller can hand it a raw map that
    // bypassed `normalizeRustTriple`. Split by kind: a *finite* out-of-range
    // value is clamped to [0, 1] (the merge never emits an illegal frequency),
    // while a *non-finite* value (`NaN`/`Infinity`) is unknown and leaves the
    // legacy raise untouched — reading it as a known "do not raise" would let a
    // corrupt map silently delete a legacy bluff.
    const rust = new Map<string, number | null>([
      ['QQ', 1.5],
      ['98s', -0.5],
      ['KQs', Number.NaN],
      ['A5s', Number.POSITIVE_INFINITY],
    ]);
    const out = mergeRustVsOpenRaise(legacy, rust);
    expect(out.get('QQ')!.valueRaise).toBe(1); // finite, clamped down
    expect(out.get('QQ')!.call).toBe(0); // legacyContinue == 1, fully consumed
    expect(out.get('98s')!.valueRaise).toBe(0); // finite, clamped up from -0.5
    expect(out.get('98s')!.call).toBeCloseTo(1, 12);
    // Non-finite -> unknown -> the legacy bluff/flat call survives untouched.
    expect(out.get('KQs')).toEqual(legacy.get('KQs'));
    // ...and an absent legacy class with unknown Rust data creates no entry.
    expect(out.get('A5s')).toBeUndefined();
    for (const [, m] of out) {
      expect(m.valueRaise + m.bluffRaise + m.marginalRaise + m.call).toBeLessThanOrEqual(1 + 1e-12);
    }
  });
});
