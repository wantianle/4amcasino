import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ALL_IN_RATIO,
  BET_RATIO_OPTIONS,
  BET_RATIO_SLOTS,
  DEFAULT_BET_RATIOS,
  isBetRatio,
  isBetRatioSlots,
  sanitizeBetRatios,
} from '@4am/shared';

// ── Frozen pre-refactor (batch-3 tail) reference implementation ─────────────
// A verbatim copy of what `apps/server/src/profile.ts` used to define locally,
// plus the old `sanitizeBetRatios` body. It is the oracle: any input must make
// the shared implementation produce byte-identical output / accept-reject.

const refIsBetRatio = (value: unknown): value is number =>
  typeof value === 'number' && (BET_RATIO_OPTIONS as readonly number[]).includes(value);

const refIsBetRatioSlots = (length: number): boolean => length === BET_RATIO_SLOTS;

function refSanitizeBetRatios(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length !== BET_RATIO_SLOTS) return [...DEFAULT_BET_RATIOS];
  const clean = raw.filter(
    (r): r is number =>
      typeof r === 'number' && (BET_RATIO_OPTIONS as readonly number[]).includes(r),
  );
  return clean.length === raw.length ? clean : [...DEFAULT_BET_RATIOS];
}

// The old server schema, verbatim (local predicate + array-length refine).
const refSchema = z
  .array(
    z
      .number()
      .refine((value) => refIsBetRatio(value), 'Invalid bet ratio')
      .describe('a pot fraction or the all-in sentinel'),
  )
  .refine((ratios) => refIsBetRatioSlots(ratios.length), 'expected five bet ratios');

// The new server schema, using the shared guards.
const newSchema = z
  .array(
    z
      .number()
      .refine(isBetRatio, 'Invalid bet ratio')
      .describe('a pot fraction or the all-in sentinel'),
  )
  .refine(isBetRatioSlots, 'expected five bet ratios');

const sparseFive = [1 / 3, 0.5, 0.75, 1];
sparseFive.length = BET_RATIO_SLOTS;

const CORPUS: unknown[] = [
  // valid five-slot shapes (incl. all-in sentinel and 150%)
  [1 / 3, 0.5, 0.75, 1, 1.5],
  [0.25, 1 / 3, 0.5, 0.75, 2],
  [1 / 3, 0.5, 1.5, 2, ALL_IN_RATIO],
  [0.25, 0.5, 0.75, 1, 2],
  // wrong lengths
  [],
  [1 / 3],
  [1 / 3, 0.5],
  [0.5, 1, 1.5, ALL_IN_RATIO], // legacy four-slot
  [1 / 3, 0.5, 0.75, 1],
  [1 / 3, 0.5, 0.75, 1, 1.5, 2], // six
  // foreign / non-number elements
  [1 / 3, 0.5, 0.75, 1, 99],
  [1 / 3, 0.5, 0.75, 1, 0],
  [1 / 3, 0.5, 0.75, 1, 'x'],
  [1 / 3, 0.5, 0.75, 1, null],
  [1 / 3, 0.5, 0.75, 1, NaN],
  [1 / 3, 0.5, 0.75, 1, Infinity],
  [1 / 3, 0.5, 0.75, 1, undefined],
  // non-arrays
  'nope',
  null,
  undefined,
  42,
  {},
  { 0: 1, 1: 2 },
  // sparse array of the right length (JSON never produces this, but a JS caller could)
  sparseFive,
];

describe('shared bet-ratio guards are byte-equivalent to the old local guards', () => {
  it('sanitizeBetRatios matches the frozen reference on every boundary input', () => {
    for (const input of CORPUS) {
      expect(sanitizeBetRatios(input), `input=${JSON.stringify(input)}`).toEqual(
        refSanitizeBetRatios(input),
      );
    }
  });

  it('per-element and slot guards agree with their frozen counterparts', () => {
    expect(isBetRatio(1 / 3)).toBe(refIsBetRatio(1 / 3));
    expect(isBetRatio(ALL_IN_RATIO)).toBe(refIsBetRatio(ALL_IN_RATIO));
    expect(isBetRatio(99)).toBe(refIsBetRatio(99));
    expect(isBetRatio('x')).toBe(refIsBetRatio('x'));
    expect(isBetRatio(NaN)).toBe(refIsBetRatio(NaN));
    for (const input of CORPUS) {
      expect(isBetRatioSlots(input), `slots input=${JSON.stringify(input)}`).toBe(
        Array.isArray(input) && refIsBetRatioSlots(input.length),
      );
    }
  });

  it('the rewritten zod schema accepts/rejects exactly like the old one', () => {
    for (const input of CORPUS) {
      const oldR = refSchema.safeParse(input);
      const newR = newSchema.safeParse(input);
      expect(newR.success, `input=${JSON.stringify(input)}`).toBe(oldR.success);
      if (oldR.success && newR.success) {
        expect(newR.data).toEqual(oldR.data);
      } else if (!oldR.success && !newR.success) {
        // Same shape, same messages: compare the issue list serialized.
        expect(newR.error.issues).toEqual(oldR.error.issues);
      }
    }
  });

  it('returns a fresh array (never aliases the caller input)', () => {
    const valid = [1 / 3, 0.5, 0.75, 1, 1.5];
    const out = sanitizeBetRatios(valid);
    expect(out).toEqual(valid);
    expect(out).not.toBe(valid);
    const invalid = [1 / 3, 0.5, 0.75, 1, 99];
    expect(sanitizeBetRatios(invalid)).not.toBe(DEFAULT_BET_RATIOS);
  });
});
