import { describe, expect, it } from 'vitest';
import { cardFromName, rankOf, type CardId } from '@4am/shared';
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

describe('estimateEquity (weighted villain range)', () => {
  const hero = [c('7c'), c('2d')];

  it('explicit combos narrow the prior and change the estimate vs uniform', () => {
    const uniform = estimateEquity({ hole: hero, opponents: 1, samples: 600, seed: 7 });
    const premium = estimateEquity({
      hole: hero,
      opponents: 1,
      samples: 600,
      seed: 7,
      villainRange: {
        combos: [
          { cards: [c('Ac'), c('Ad')], weight: 1 },
          { cards: [c('Ah'), c('As')], weight: 1 },
          { cards: [c('Kc'), c('Kd')], weight: 1 },
          { cards: [c('Kh'), c('Ks')], weight: 1 },
        ],
      },
    });
    // 7-2 offsuit is badly dominated by AA/KK, and must sit below the uniform
    // random-hand prior it would otherwise be measured against.
    expect(premium.equity).toBeLessThan(uniform.equity - 0.05);
    expect(premium.equity).toBeGreaterThanOrEqual(0);
    expect(premium.samples).toBe(600);
  });

  it('a weightFn produces a non-uniform estimate and is deterministic', () => {
    const aceHeavy = (cards: readonly [CardId, CardId]) =>
      cards.some((card) => rankOf(card) === 12) ? 1 : 0;
    const uniform = estimateEquity({ hole: hero, opponents: 1, samples: 800, seed: 11 });
    const range = estimateEquity({
      hole: hero,
      opponents: 1,
      samples: 800,
      seed: 11,
      villainRange: { weightFn: aceHeavy },
    });
    expect(range.equity).toBeLessThan(uniform.equity);
    const again = estimateEquity({
      hole: hero,
      opponents: 1,
      samples: 800,
      seed: 11,
      villainRange: { weightFn: aceHeavy },
    });
    expect(again.equity).toBe(range.equity);
  });

  it('drops impossible combos (board/hero collisions) and rejects an empty range', () => {
    const board = [c('Ac'), c('Kd'), c('7h')];
    const hole = [c('Qc'), c('Jd')];
    const r = estimateEquity({
      hole,
      board,
      opponents: 1,
      samples: 50,
      seed: 1,
      villainRange: {
        combos: [
          { cards: [c('Ac'), c('Ad')], weight: 1 }, // uses a board card → dropped
          { cards: [c('2c'), c('3d')], weight: 1 },
        ],
      },
    });
    expect(r.equity).toBeGreaterThanOrEqual(0);
    expect(() =>
      estimateEquity({
        hole,
        board,
        samples: 50,
        villainRange: { combos: [{ cards: [c('Ac'), c('Ad')], weight: 1 }] },
      }),
    ).toThrow(/no legal combos/);
  });

  it('fails fast on malformed ranges', () => {
    expect(() =>
      estimateEquity({
        hole: hero,
        villainRange: { combos: [{ cards: [c('2c'), c('3d')], weight: Number.NaN }] },
      }),
    ).toThrow(/weight/);
    expect(() =>
      estimateEquity({
        hole: hero,
        villainRange: { combos: [{ cards: [c('2c'), c('2c')], weight: 1 }] },
      }),
    ).toThrow(/distinct/);
    expect(() =>
      estimateEquity({ hole: hero, villainRange: { weightFn: () => -1 } }),
    ).toThrow(/weightFn/);
    expect(() => estimateEquity({ hole: hero, villainRange: {} })).toThrow(/combos or weightFn/);
  });

  it('rejects supplying both combos and weightFn instead of silently preferring combos', () => {
    expect(() =>
      estimateEquity({
        hole: hero,
        villainRange: {
          combos: [{ cards: [c('2c'), c('3d')], weight: 1 }],
          weightFn: () => 1,
        },
      }),
    ).toThrow(/exactly one/);
  });

  it('fails fast when the accumulated range weight overflows to Infinity', () => {
    // Two individually-finite MAX_VALUE weights sum to Infinity; without the
    // check the binary-search draw would silently degenerate to combo 0.
    const max = Number.MAX_VALUE;
    expect(() =>
      estimateEquity({
        hole: hero,
        samples: 50,
        villainRange: {
          combos: [
            { cards: [c('Ac'), c('Ad')], weight: max },
            { cards: [c('Ah'), c('As')], weight: max },
          ],
        },
      }),
    ).toThrow(/overflow|finite/i);
    // Same via a weightFn that overflows.
    expect(() =>
      estimateEquity({
        hole: hero,
        samples: 50,
        villainRange: {
          weightFn: (cards) => (rankOf(cards[0]) === 12 && rankOf(cards[1]) === 12 ? max : 0),
        },
      }),
    ).toThrow(/overflow|finite/i);
  });

  it('merges duplicate combos by summing weights, order-independently', () => {
    const one = estimateEquity({
      hole: hero,
      samples: 300,
      seed: 5,
      villainRange: { combos: [{ cards: [c('Ac'), c('Ad')], weight: 2 }] },
    });
    const duplicated = estimateEquity({
      hole: hero,
      samples: 300,
      seed: 5,
      villainRange: {
        combos: [
          { cards: [c('Ac'), c('Ad')], weight: 1 },
          { cards: [c('Ad'), c('Ac')], weight: 1 }, // same unordered pair
        ],
      },
    });
    expect(duplicated.equity).toBe(one.equity);
    expect(duplicated.uniformFallbacks).toBe(0);
  });

  it('weights multiway opponents by the supplied range (conditioning is not vacuous)', () => {
    const hero = [c('7c'), c('2d')];
    const board = [c('Qh'), c('Jh'), c('2c')];
    const pairHeavy = (cards: readonly [CardId, CardId]) =>
      rankOf(cards[0]) === rankOf(cards[1]) ? 1 : 0.002;
    const airHeavy = (cards: readonly [CardId, CardId]) =>
      rankOf(cards[0]) === rankOf(cards[1]) ? 0.002 : 1;
    const versusAces = estimateEquity({
      hole: hero,
      board,
      opponents: 2,
      samples: 600,
      seed: 9,
      villainRange: { weightFn: pairHeavy },
    });
    const versusAir = estimateEquity({
      hole: hero,
      board,
      opponents: 2,
      samples: 600,
      seed: 9,
      villainRange: { weightFn: airHeavy },
    });
    // Both ranges are full-size, so no opponent ever falls back.
    expect(versusAces.uniformFallbacks).toBe(0);
    expect(versusAir.uniformFallbacks).toBe(0);
    // Two opponents from an ace-heavy range leave the weak hero worse off.
    expect(versusAces.equity).toBeLessThan(versusAir.equity);
  });

  it('reports the documented uniform fallback and never reuses a combo card across opponents', () => {
    // A single-combo range can fill at most one of two opponents; the second is
    // a documented uniform fallback on every sample.
    const single = estimateEquity({
      hole: [c('Ac'), c('Ad')],
      board: [c('Kh'), c('7d'), c('2c')],
      opponents: 2,
      samples: 120,
      seed: 3,
      villainRange: { combos: [{ cards: [c('Kc'), c('Kd')], weight: 1 }] },
    });
    expect(single.uniformFallbacks).toBe(120); // exactly (opponents - 1) * samples
    expect(Number.isFinite(single.equity)).toBe(true);
    expect(single.equity).toBeGreaterThanOrEqual(0);
    expect(single.equity).toBeLessThanOrEqual(1);

    // Heads-up the same range is never exhausted, so there is no fallback.
    const headsUp = estimateEquity({
      hole: [c('Ac'), c('Ad')],
      board: [c('Kh'), c('7d'), c('2c')],
      opponents: 1,
      samples: 120,
      seed: 3,
      villainRange: { combos: [{ cards: [c('Kc'), c('Kd')], weight: 1 }] },
    });
    expect(headsUp.uniformFallbacks).toBe(0);

    // Two disjoint combos for two opponents never exhaust the range.
    const disjoint = estimateEquity({
      hole: [c('7c'), c('2d')],
      opponents: 2,
      samples: 120,
      seed: 3,
      villainRange: {
        combos: [
          { cards: [c('Ac'), c('Ad')], weight: 1 },
          { cards: [c('Kh'), c('Ks')], weight: 1 },
        ],
      },
    });
    expect(disjoint.uniformFallbacks).toBe(0);
  });

  it('does not report a fallback for the uniform (no-range) path', () => {
    const r = estimateEquity({ hole: hero, opponents: 2, samples: 50, seed: 1 });
    expect(r.uniformFallbacks).toBeUndefined();
  });
});
