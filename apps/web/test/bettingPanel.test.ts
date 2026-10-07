import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { adjustRaiseByStep, clampRaiseAmount, isRaiseAmountValid } from '../src/widgets/table/BettingPanel.tsx';

describe('betting panel raise input guard', () => {
  it.each([
    ['below min', -3, 10],
    ['above max', 999, 100],
    ['fractional', 10.6, 11],
    ['NaN', Number.NaN, 10],
    ['infinity', Number.POSITIVE_INFINITY, 10],
  ])('clamps %s to a legal whole-chip value', (_name, value, expected) => {
    expect(clampRaiseAmount(value, 10, 100)).toBe(expected);
  });

  it('uses the legal fallback when the edited value is empty/NaN', () => {
    expect(clampRaiseAmount(Number.NaN, 10, 100, 42)).toBe(42);
    expect(clampRaiseAmount(Number.NaN, 10, 100, Number.NaN)).toBe(10);
  });

  it('rejects fractional amounts, even when they are inside the legal range', () => {
    expect(isRaiseAmountValid(10.6, 10, 100)).toBe(false);
    expect(isRaiseAmountValid(10, 10, 100)).toBe(true);
    expect(isRaiseAmountValid(Number.NaN, 10, 100)).toBe(false);
  });

  it('repairs an invalid edit on the first submit attempt without submitting it', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../src/widgets/table/BettingPanel.tsx'),
      'utf8',
    );
    expect(source).toContain('An invalid edit is repaired on the first click');
    expect(source).toContain('if (!Number.isFinite(raiseTo) || !amountValid) return;');
  });

  it('keeps an off-grid All-in value exact when arrow adjustment would overshoot', () => {
    // This mirrors the controlled range DOM: min=25/max=107 and step=1 can
    // represent 107 exactly. Arrow-right from All-in clamps back to 107.
    expect(adjustRaiseByStep(107, 1, 10, 25, 107)).toBe(107);
    expect(adjustRaiseByStep(107, -1, 10, 25, 107)).toBe(97);
  });

  it('uses step=1 for the range DOM while keyboard and wheel use sb', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../src/widgets/table/BettingPanel.tsx'),
      'utf8',
    );
    expect(source).toContain('const raiseRangeStep = 1;');
    expect(source).toContain('adjustRaiseByStep(');
    expect(source).toContain('e.preventDefault();');
  });

  it('uses one legal fallback for the CTA and its BB sublabel', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../src/widgets/table/BettingPanel.tsx'),
      'utf8',
    );
    // The CTA/label now reads the SNAPPED amount, so a typed BB max (6.5 BB →
    // 130 chips) resolves to the exact clamped all-in (123) everywhere.
    expect(source).toMatch(/const legalRaiseTo = la && Number\.isFinite\(raiseTo\) \? snapRaiseTo\(raiseTo\)/);
    expect(source).not.toMatch(/fmt\(raiseTo\)/);
    expect(source).not.toMatch(/bbOf\(raiseTo, bb\)/);
  });

  it('keeps quick pills as non-submit buttons', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../src/widgets/table/BettingPanel.tsx'),
      'utf8',
    );
    const pill = source.slice(source.indexOf('{quicks.map'));
    expect(pill).toContain('type="button"');
    expect(pill.slice(0, pill.indexOf('</button>'))).not.toContain('send(');
  });
});
