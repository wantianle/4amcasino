import { afterEach, describe, expect, it, vi } from 'vitest';
import { cardFromName, type CardId } from '@4am/shared';
import { PREFLOP_SAMPLES, runEquityJob } from '../src/equityWorker.js';
import { computeHeadsUpEquity, EQUITY_FAILED, EquityError } from '../src/equity.js';

const C = (name: string): CardId => cardFromName(name);

const AA: [CardId, CardId] = [C('As'), C('Ad')];
const KK: [CardId, CardId] = [C('Ks'), C('Kd')];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('computeHeadsUpEquity — exact streets', () => {
  it('river is exact: aces beat kings on a dry board, one outcome', () => {
    const r = runEquityJob({
      holeA: AA,
      holeB: KK,
      board: [C('2c'), C('7d'), C('9h'), C('Jh'), C('Qs')],
      seed: 'river-1',
    });
    expect(r).toEqual({ equitiesBps: [10000, 0], method: 'exact', samples: 1 });
  });

  it('river splits the pot when both play the board straight', () => {
    const r = runEquityJob({
      holeA: [C('Ah'), C('Ad')],
      holeB: [C('Kh'), C('Kd')],
      board: [C('2c'), C('3d'), C('4h'), C('5s'), C('6c')],
      seed: 'river-tie',
    });
    expect(r).toEqual({ equitiesBps: [5000, 5000], method: 'exact', samples: 1 });
  });

  it('turn enumerates all 44 rivers exactly', () => {
    const r = runEquityJob({
      holeA: AA,
      holeB: KK,
      board: [C('2c'), C('7d'), C('9h'), C('Jh')],
      seed: 'turn-1',
    });
    // aces hold everywhere except the two remaining kings (trips kings).
    expect(r).toEqual({ equitiesBps: [9545, 455], method: 'exact', samples: 44 });
  });

  it('flop enumerates all 990 turn/river combos: made flush vs overpair', () => {
    const r = runEquityJob({
      holeA: [C('Ah'), C('2h')],
      holeB: [C('Qs'), C('Qd')],
      board: [C('Kh'), C('9h'), C('4h')],
      seed: 'flop-flush',
    });
    expect(r.method).toBe('exact');
    expect(r.samples).toBe(990);
    expect(r.equitiesBps).toEqual([9717, 283]);
    expect(r.equitiesBps[0]).toBeGreaterThan(9000); // the flush is the huge favourite
  });
});

describe('computeHeadsUpEquity — preflop monte carlo', () => {
  it('is deterministic for a given audit seed', () => {
    const first = runEquityJob({ holeA: AA, holeB: KK, board: [], seed: 'audit-seed', samples: 2000 });
    const second = runEquityJob({ holeA: AA, holeB: KK, board: [], seed: 'audit-seed', samples: 2000 });
    expect(first).toEqual(second);
    expect(first.method).toBe('monte-carlo');
    expect(first.samples).toBe(2000);
  });

  it('AA vs KK lands near the ~80/20 expectation at the default sample count', () => {
    const r = runEquityJob({ holeA: AA, holeB: KK, board: [], seed: 'aa-vs-kk' });
    expect(r.method).toBe('monte-carlo');
    expect(r.samples).toBe(PREFLOP_SAMPLES);
    expect(r.samples).toBe(25000);
    expect(r.equitiesBps[0] + r.equitiesBps[1]).toBe(10000);
    expect(r.equitiesBps[0]).toBeGreaterThan(7600);
    expect(r.equitiesBps[0]).toBeLessThan(8400);
  }, 30000);

  it('rejects malformed boards instead of guessing', () => {
    expect(() =>
      runEquityJob({ holeA: AA, holeB: KK, board: [C('2c'), C('7d')], seed: 'bad' }),
    ).toThrow(/unsupported board length/);
    expect(() =>
      runEquityJob({ holeA: [C('As'), C('As')], holeB: KK, board: [], seed: 'dup' }),
    ).toThrow(/duplicate card/);
  });
});

describe('computeHeadsUpEquity — worker thread', () => {
  it('settles a preflop all-in on a worker and matches the direct computation', async () => {
    // Correctness check, not a latency check: give the 25k-sample run room so
    // the assertion cannot race the production 2s cap on a slow machine.
    vi.stubEnv('EQUITY_TIMEOUT_MS', '15000');
    const direct = runEquityJob({ holeA: AA, holeB: KK, board: [], seed: 'worker-seed' });
    const viaWorker = await computeHeadsUpEquity({
      holeA: AA,
      holeB: KK,
      board: [],
      seed: 'worker-seed',
    });
    expect(viaWorker).toEqual(direct);
    expect(viaWorker.equitiesBps[0] + viaWorker.equitiesBps[1]).toBe(10000);
  }, 30000);

  it('turns a bad request into a rejectable equity_failed error', async () => {
    await expect(
      computeHeadsUpEquity({ holeA: AA, holeB: KK, board: [C('2c'), C('7d')], seed: 'bad' }),
    ).rejects.toMatchObject({ code: EQUITY_FAILED });
    await expect(
      computeHeadsUpEquity({ holeA: AA, holeB: KK, board: [C('2c'), C('7d')], seed: 'bad' }),
    ).rejects.toBeInstanceOf(EquityError);
  }, 30000);

  it('enforces the hard timeout and rejects with equity_failed', async () => {
    vi.stubEnv('EQUITY_TIMEOUT_MS', '1');
    await expect(
      computeHeadsUpEquity({ holeA: AA, holeB: KK, board: [], seed: 'too-slow' }),
    ).rejects.toMatchObject({ code: EQUITY_FAILED, message: expect.stringContaining('timed out') });
  }, 30000);
});
