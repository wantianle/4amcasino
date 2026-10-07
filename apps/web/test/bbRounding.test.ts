import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Pure modules: no store / browser dependency.
import { bbValue, fmtBB } from '../src/shared/lib/bb.ts';
import { roundUpToSb } from '../src/shared/lib/chips.ts';

// betPresets transitively imports the shared zustand store, whose persist
// middleware touches localStorage at module init — stub the browser globals
// before the dynamic import (same pattern as betRatios.test.ts).
vi.stubGlobal('window', {
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
});
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
vi.stubGlobal('document', { documentElement: { classList: { add: vi.fn(), remove: vi.fn() } } });

const { ALL_IN_RATIO, legalActions, applyAction } = await import('@4am/shared');
const { presetRaiseTo, snapRaiseTo } = await import('../src/features/table/betPresets.ts');

// User ruling 2026-10-07: visible display + input round UP; the ledger stays raw chips.
describe('bet input rounds UP to the next small blind', () => {
  it('turns an input of 123 at sb 10 into 130', () => {
    expect(roundUpToSb(123, 10)).toBe(130);
    expect(snapRaiseTo(123, 10, 20, 100_000)).toBe(130);
  });

  it('leaves an amount already on the small-blind grid untouched', () => {
    expect(roundUpToSb(120, 10)).toBe(120);
    expect(snapRaiseTo(120, 10, 20, 100_000)).toBe(120);
  });

  it('never rounds down: any positive remainder gains a full small blind', () => {
    expect(roundUpToSb(1, 10)).toBe(10);
    expect(roundUpToSb(11, 10)).toBe(20);
    expect(snapRaiseTo(121, 10, 20, 100_000)).toBe(130);
  });

  it('keeps an all-in exact — a 123 shove stays 123, not the ceiled 130', () => {
    // maxRaiseTo is the all-in raise-to; the clamp AFTER the ceil preserves it.
    expect(snapRaiseTo(123, 10, 20, 123)).toBe(123);
    expect(snapRaiseTo(125, 10, 20, 123)).toBe(123);
    expect(presetRaiseTo({
      frac: ALL_IN_RATIO,
      pot: 0,
      callAmount: 0,
      currentBet: 0,
      sb: 10,
      minRaiseTo: 20,
      maxRaiseTo: 123,
    })).toBe(123);
  });

  it('falls back to the minimum on an empty/NaN edit and floors below the minimum', () => {
    expect(snapRaiseTo(Number.NaN, 10, 20, 100)).toBe(20);
    expect(snapRaiseTo(5, 10, 20, 100)).toBe(20);
  });
});

describe('quick-size pills round UP too', () => {
  it('ceils a pot-fraction target that lands off the grid', () => {
    // target = round(100 * 1/3) = 33 → ceil to 40 (the old Math.round gave 30)
    expect(
      presetRaiseTo({
        frac: 1 / 3,
        pot: 100,
        callAmount: 0,
        currentBet: 0,
        sb: 10,
        minRaiseTo: 0,
        maxRaiseTo: 100_000,
      }),
    ).toBe(40);
  });
});

describe('BB display rounds UP to 0.5 BB', () => {
  it('shows 123 chips at bb 20 as 6.5 BB (6.15 rounded up)', () => {
    expect(bbValue(123, 20)).toBe(6.5);
    expect(fmtBB(123, 20)).toBe('6.5');
  });

  it('lands every value on a half-BB boundary', () => {
    expect(bbValue(120, 20)).toBe(6);
    expect(bbValue(10, 20)).toBe(0.5);
    expect(bbValue(11, 20)).toBe(1);
    expect(bbValue(31, 20)).toBe(2);
    expect(bbValue(0, 20)).toBe(0);
  });

  it('never displays less than the raw chip value across a sweep', () => {
    for (let chips = 0; chips <= 400; chips += 1) {
      expect(bbValue(chips, 20) * 20).toBeGreaterThanOrEqual(chips - 1e-9);
    }
  });
});

describe('wiring guards', () => {
  it('routes the betting panel amount through snapRaiseTo on blur and submit', () => {
    const src = readFileSync(
      resolve(import.meta.dirname, '../src/widgets/table/BettingPanel.tsx'),
      'utf8',
    );
    expect(src).toContain('snapRaiseTo(raiseTo)');
    expect(src).toContain('setRaiseTo(snapRaiseTo(value))');
  });

  it('keeps the ledger chip-denominated: the store never persists a BB amount', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../src/shared/store.ts'), 'utf8');
    // No bbValue/fmtBB conversion is applied to persisted stacks or pots.
    expect(src).not.toMatch(/config\.[A-Za-z0-9_]*stack\s*=\s*bbValue/);
    expect(src).not.toContain('fmtBB(');
  });

  it('removed the felt watermark and every table brand string', () => {
    const round = readFileSync(
      resolve(import.meta.dirname, '../src/widgets/table/RoundTable.tsx'),
      'utf8',
    );
    expect(round).not.toContain('table-felt-watermark');
    expect(round).not.toContain('4AM · CASINO');
    const surface = readFileSync(resolve(import.meta.dirname, '../src/app/table-surface.css'), 'utf8');
    expect(surface).not.toContain('watermark');
  });
});

describe('no pre-round before the small-blind ceil (review issue 2)', () => {
  it('turns pot 101 at 30% into 40, not 30', () => {
    // Exact target = 101 * 0.3 = 30.3 → ceil to 40. The old Math.round(target)
    // dropped the fraction to 30 first, so the ceil could not recover it.
    expect(
      presetRaiseTo({
        frac: 0.3,
        pot: 101,
        callAmount: 0,
        currentBet: 0,
        sb: 10,
        minRaiseTo: 0,
        maxRaiseTo: 100_000,
      }),
    ).toBe(40);
    expect(Math.round(101 * 0.3)).toBe(30); // the discarded pre-round
  });
});

describe('displayed BB max → exact all-in (review issue 1)', () => {
  it('maps a typed 6.5 BB over a 123-chip all-in back to 123, same as the pill', () => {
    const bb = 20;
    const sb = 10;
    const minRaiseTo = 40;
    const maxRaiseTo = 123;
    const converted = 6.5 * bb; // what fromUnit yields (full product, no pre-round)
    expect(converted).toBe(130);
    const typed = snapRaiseTo(converted, sb, minRaiseTo, maxRaiseTo);
    const pill = presetRaiseTo({
      frac: ALL_IN_RATIO,
      pot: 0,
      callAmount: 0,
      currentBet: 0,
      sb,
      minRaiseTo,
      maxRaiseTo,
    });
    expect(typed).toBe(123);
    expect(typed).toBe(pill);
  });

  it('keeps a non-all-in typed max at the ceiled small-blind multiple', () => {
    // When the stack covers it, 6.5 BB really is 130 chips — no clamp.
    expect(snapRaiseTo(6.5 * 20, 10, 40, 500)).toBe(130);
  });
});

describe('BB → chips keeps the full product, no pre-round (review round 2)', () => {
  it('snaps a typed 6.01 BB at bb 20 to 130 chips, not 120', () => {
    const exact = 6.01 * 20; // what fromUnit must yield, unrounded
    expect(exact).toBeCloseTo(120.2, 10);
    // Correct: snap the full product → ceil(120.2 / 10) * 10 = 130.
    expect(snapRaiseTo(exact, 10, 40, 500)).toBe(130);
    // The OLD pre-round collapsed the fraction to 120 first, and snap could
    // no longer recover it — this assertion is what fails on the old code.
    expect(snapRaiseTo(Math.round(exact), 10, 40, 500)).toBe(120);
  });

  it('the betting panel fromUnit no longer pre-rounds the BB product', () => {
    const src = readFileSync(
      resolve(import.meta.dirname, '../src/widgets/table/BettingPanel.tsx'),
      'utf8',
    );
    expect(src).not.toContain('Math.round(value * Math.max(1, bb))');
    expect(src).toContain('value * Math.max(1, bb)');
  });
});

describe('real engine: an all-in raise-to never adds more than the stack', () => {
  const st = {
    street: 'preflop' as const,
    seats: [
      { seat: 0, stack: 1000, committed: 0, total: 0, folded: false, allIn: false, lastActedAt: null },
      { seat: 1, stack: 128, committed: 2, total: 2, folded: false, allIn: false, lastActedAt: null },
      { seat: 2, stack: 1000, committed: 20, total: 20, folded: false, allIn: false, lastActedAt: null },
    ],
    buttonSeat: 0,
    sb: 10,
    bb: 20,
    currentBet: 20,
    lastRaiseSize: 20,
    lastFullRaiseAt: 20,
    toAct: 1,
    needToAct: [1, 2],
    winnerByFold: null,
  };

  it('maxRaiseTo is committed + stack, and raising to it invests only the stack', () => {
    const la = legalActions(st);
    expect(la).not.toBeNull();
    expect(la!.maxRaiseTo).toBe(130); // 2 already in + 128 behind
    const after = applyAction(st, 1, { type: 'raise', amount: la!.maxRaiseTo });
    const me = after.seats.find((s) => s.seat === 1)!;
    expect(me.stack).toBe(0);
    expect(me.total).toBe(130);
    expect(me.total - 2).toBe(128); // actual NEW chips invested, not 130
  });
});
