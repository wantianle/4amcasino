import { describe, expect, it } from 'vitest';
import { cardFromName, type CardId } from '@4am/shared';
import { estimateEquity } from '../src/equity.js';

const c = (n: string) => cardFromName(n);

describe('estimateEquity (Monte-Carlo)', () => {
  it('rates aces far above a random hand, and 7-2 offsuit below average', () => {
    const aces = estimateEquity({ hole: [c('Ac'), c('Ad')], opponents: 1, samples: 400, seed: 7 });
    const trash = estimateEquity({ hole: [c('7c'), c('2d')], opponents: 1, samples: 400, seed: 7 });
    expect(aces.method).toBe('monte-carlo');
    expect(aces.equity).toBeGreaterThan(0.75);
    expect(aces.equity).toBeLessThan(1);
    expect(trash.equity).toBeLessThan(0.5);
    expect(aces.equity).toBeGreaterThan(trash.equity);
  });

  it('drops equity as random opponents are added', () => {
    const heads = estimateEquity({ hole: [c('Ac'), c('Ad')], opponents: 1, samples: 500, seed: 3 });
    const threeWay = estimateEquity({ hole: [c('Ac'), c('Ad')], opponents: 2, samples: 500, seed: 3 });
    const sixWay = estimateEquity({ hole: [c('Ac'), c('Ad')], opponents: 5, samples: 500, seed: 3 });
    expect(threeWay.equity).toBeLessThan(heads.equity);
    expect(sixWay.equity).toBeLessThan(threeWay.equity);
  });

  it('is deterministic for a fixed seed', () => {
    const a = estimateEquity({ hole: [c('Ah'), c('Kh')], board: [c('Qh'), c('Jh'), c('2c')], opponents: 2, seed: 42 });
    const b = estimateEquity({ hole: [c('Ah'), c('Kh')], board: [c('Qh'), c('Jh'), c('2c')], opponents: 2, seed: 42 });
    expect(a.equity).toBe(b.equity);
    expect(a.samples).toBe(b.samples);
  });

  it('rates unbeatable quads on a river board as a certainty', () => {
    // Board cannot complete a straight flush (no three cards of one suit), so
    // four aces cannot be beaten and ties are impossible.
    const result = estimateEquity({
      hole: [c('Ac'), c('Ad')],
      board: [c('Ah'), c('As'), c('Kd'), c('Qc'), c('2h')],
      opponents: 3,
      samples: 200,
      seed: 1,
    });
    expect(result.equity).toBe(1);
  });

  it('rejects malformed inputs instead of guessing', () => {
    expect(() => estimateEquity({ hole: [c('Ac')] })).toThrow(/hole cards/);
    expect(() => estimateEquity({ hole: [c('Ac'), c('Ac')] })).toThrow(/duplicate/);
    expect(() =>
      estimateEquity({ hole: [c('Ac'), c('Ad')], board: [c('Ah'), c('As'), c('Kd'), c('Qc'), c('2h'), c('3d')] }),
    ).toThrow(/board/);
  });

  it('fails fast on non-finite / non-integer / out-of-range opponents and samples', () => {
    const hole = [c('Ac'), c('Ad')] as [number, number];
    for (const opponents of [9, 100, 0, -1, 1.5, Number.NaN, Infinity, -Infinity]) {
      expect(() => estimateEquity({ hole, opponents })).toThrow(/opponents/);
    }
    for (const samples of [0, -1, 1.5, Number.NaN, Infinity, 100_001]) {
      expect(() => estimateEquity({ hole, samples })).toThrow(/samples/);
    }
  });

  it('accepts the documented sample cap and rejects just above it', () => {
    const result = estimateEquity({
      hole: [c('Ac'), c('Ad')],
      board: [c('2c'), c('3d'), c('4h'), c('5s'), c('7c')],
      opponents: 1,
      samples: 100_000,
      seed: 1,
    });
    expect(result.samples).toBe(100_000);
    expect(result.equity).toBeGreaterThanOrEqual(0);
    expect(result.equity).toBeLessThanOrEqual(1);
    expect(() => estimateEquity({ hole: [c('Ac'), c('Ad')], samples: 100_001 })).toThrow(/samples/);
  });

  it('handles the maximum 8 opponents across every board length (0–5)', () => {
    // Guards the removed `drawsPerSample > deck.length` check: hole + board +
    // 8 opponents draws at most 16 + 5 cards, which always fits the unseen deck.
    const boards: CardId[][] = [
      [],
      [c('2c'), c('3d'), c('4h')],
      [c('2c'), c('3d'), c('4h'), c('5s')],
      [c('2c'), c('3d'), c('4h'), c('5s'), c('7c')],
    ];
    for (const board of boards) {
      const r = estimateEquity({ hole: [c('Ac'), c('Kd')], board, opponents: 8, samples: 50, seed: 11 });
      expect(r.equity).toBeGreaterThanOrEqual(0);
      expect(r.equity).toBeLessThanOrEqual(1);
    }
  });

  it('splits the pot exactly when the board cannot be beaten', () => {
    // Royal flush on the board: no hole cards can improve on it, so every
    // opponent ties and the bot wins exactly its share of the pot.
    const board = [c('As'), c('Ks'), c('Qs'), c('Js'), c('Ts')];
    const headsUp = estimateEquity({ hole: [c('2c'), c('3d')], board, opponents: 1, samples: 40, seed: 1 });
    const fourWay = estimateEquity({ hole: [c('2c'), c('3d')], board, opponents: 3, samples: 40, seed: 1 });
    expect(headsUp.equity).toBe(0.5);
    expect(fourWay.equity).toBe(0.25);
  });
});
