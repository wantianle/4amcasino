import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALL_CARDS, cardFromName, evaluate7, type CardId } from '@4am/shared';
import { PREFLOP_SAMPLES, runEquityJob, runMultiwayEquityJob } from '../src/equityWorker.js';
import {
  computeHeadsUpEquity,
  computeMultiwayEquity,
  EQUITY_FAILED,
  EquityError,
} from '../src/equity.js';

const C = (name: string): CardId => cardFromName(name);

const AA: [CardId, CardId] = [C('As'), C('Ad')];
const KK: [CardId, CardId] = [C('Ks'), C('Kd')];
/** Frozen expected bps for the audit scenario at the bottom of this file
 *  (run-2 flop, run-1's five cards dead): AsAd vs KsKd, board 3c4d5h, dead
 *  2c7d9hJhQs. Recomputed independently; see the test. */
const AUDIT_RUN2_FLOP: number[] = [8949, 1051];

/** A deliberately separate reimplementation of the N-way exact enumeration and
 *  largest-remainder split, written against the public `evaluate7` only. It
 *  exists to audit the worker from outside: same inputs in, same bps out. */
function independentEquity(
  holes: [CardId, CardId][],
  board: CardId[],
  dead: CardId[] = [],
): number[] {
  const known = new Set<CardId>([...holes.flat(), ...board, ...dead]);
  const unseen = ALL_CARDS.filter((c) => !known.has(c));
  const wins = new Array<number>(holes.length).fill(0) as number[];
  let n = 0;
  const tally = (full: CardId[]): void => {
    const scores = holes.map((h) => evaluate7([h[0], h[1], ...full]));
    const bestScore = Math.max(...scores);
    const winners = scores.map((s, i) => (s === bestScore ? i : -1)).filter((i) => i >= 0);
    for (const i of winners) wins[i]! += 1 / winners.length;
    n++;
  };
  const need = 5 - board.length;
  if (need === 0) tally(board);
  else if (need === 1) for (const c of unseen) tally([...board, c]);
  else
    for (let i = 0; i < unseen.length; i++)
      for (let j = i + 1; j < unseen.length; j++) tally([...board, unseen[i]!, unseen[j]!]);
  const raw = wins.map((w) => (w * 10000) / n);
  const out = raw.map(Math.floor);
  const rem = 10000 - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < rem; k++) out[order[k % order.length]!.i]!++;
  return out;
}

/** Assert the wire contract of every bps vector: integers, in range, summing
 *  to exactly 10000. */
function expectSaneBps(bps: number[]): void {
  for (const b of bps) {
    expect(Number.isInteger(b)).toBe(true);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThanOrEqual(10000);
  }
  expect(bps.reduce((a, b) => a + b, 0)).toBe(10000);
}

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

describe('runMultiwayEquityJob — N-way known hands', () => {
  const RIVER: CardId[] = [C('2c'), C('7d'), C('9h'), C('Jh'), C('Qs')];

  it('river: a 3-way lock awards the winner everything, summing to 10000', () => {
    const r = runMultiwayEquityJob({
      holes: [AA, KK, [C('3c'), C('4c')]],
      board: RIVER,
      seed: '3way-lock',
    });
    expect(r).toEqual({ equitiesBps: [10000, 0, 0], method: 'exact', samples: 1 });
  });

  it('river: a 3-way tie splits as evenly as basis points allow, summing to 10000', () => {
    const board = [C('2c'), C('3d'), C('4h'), C('5s'), C('6c')]; // board straight, all play it
    const r = runMultiwayEquityJob({
      holes: [AA, KK, [C('Qh'), C('Jd')]],
      board,
      seed: '3way-tie',
    });
    expect(r.method).toBe('exact');
    expect(r.equitiesBps.reduce((a, b) => a + b, 0)).toBe(10000);
    expect(Math.max(...r.equitiesBps) - Math.min(...r.equitiesBps)).toBeLessThanOrEqual(1);
  });

  it('excludes explicitly dead cards and rejects a dead/board collision', () => {
    // 2h is dead: the runout must never contain it, so a 3-way river lock still
    // resolves exactly. A dead card that collides with the board is malformed.
    expect(() =>
      runMultiwayEquityJob({
        holes: [AA, KK],
        board: RIVER,
        seed: 'dead-dup',
        dead: [C('2c')], // already on the board
      }),
    ).toThrow(/duplicate card/);
    const ok = runMultiwayEquityJob({
      holes: [AA, KK],
      board: RIVER.slice(0, 4),
      seed: 'dead-ok',
      dead: [C('8c')],
    });
    expect(ok.equitiesBps.reduce((a, b) => a + b, 0)).toBe(10000);
  });

  it('the persistent worker returns N-way equity that sums to 10000', async () => {
    const r = await computeMultiwayEquity({
      holes: [AA, KK, [C('3c'), C('4c')]],
      board: RIVER,
      seed: '3way-worker',
    });
    expect(r.equitiesBps).toHaveLength(3);
    expect(r.equitiesBps.reduce((a, b) => a + b, 0)).toBe(10000);
  }, 15000);
});

describe('computeMultiwayEquity — off the main thread', () => {
  it('a heavy preflop run keeps the event loop ticking (never blocks the server)', async () => {
    vi.stubEnv('EQUITY_TIMEOUT_MS', '15000');
    // Warm the persistent worker so the measurement covers the compute, not
    // thread start-up; then a 25k-sample 3-way preflop must not stall the loop.
    await computeMultiwayEquity({
      holes: [AA, KK, [C('3c'), C('4c')]],
      board: [C('2c'), C('7d'), C('9h'), C('Jh'), C('Qs')],
      seed: 'warm',
    });
    let ticks = 0;
    const heartbeat = setInterval(() => {
      ticks++;
    }, 5);
    await computeMultiwayEquity({
      holes: [AA, KK, [C('3c'), C('4c')]],
      board: [],
      seed: 'heavy-preflop',
    });
    clearInterval(heartbeat);
    // eslint-disable-next-line no-console
    console.log('HEARTBEAT_TICKS', ticks);
    // A blocking compute would freeze this to 0 (one tick at best).
    expect(ticks).toBeGreaterThan(3);
  }, 30000);
});

describe('computeMultiwayEquity — timeout recovery', () => {
  it('tears the stuck worker down on timeout and rebuilds one for the next job', async () => {
    // 1ms times out during worker start-up itself. The timeout must kill the
    // worker (not just reject), and a later call must transparently rebuild.
    vi.stubEnv('EQUITY_TIMEOUT_MS', '1');
    await expect(
      computeMultiwayEquity({ holes: [AA, KK], board: [], seed: 'timeout-warm' }),
    ).rejects.toMatchObject({ code: EQUITY_FAILED, message: expect.stringContaining('timed out') });

    vi.stubEnv('EQUITY_TIMEOUT_MS', '15000');
    const r = await computeMultiwayEquity({
      holes: [AA, KK, [C('3c'), C('4c')]],
      board: [C('2c'), C('7d'), C('9h'), C('Jh'), C('Qs')],
      seed: 'recovered',
    });
    expect(r.equitiesBps).toHaveLength(3);
    expectSaneBps(r.equitiesBps);
  }, 30000);

  it('a burst of timeouts does not leave later jobs queued behind a dead worker', async () => {
    vi.stubEnv('EQUITY_TIMEOUT_MS', '1');
    const results = await Promise.allSettled([
      computeMultiwayEquity({ holes: [AA, KK], board: [], seed: 'burst-1' }),
      computeMultiwayEquity({ holes: [AA, KK], board: [], seed: 'burst-2' }),
      computeMultiwayEquity({ holes: [AA, KK], board: [], seed: 'burst-3' }),
    ]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);

    vi.stubEnv('EQUITY_TIMEOUT_MS', '15000');
    const r = await computeMultiwayEquity({ holes: [AA, KK], board: [], seed: 'burst-recover' });
    expect(r.equitiesBps).toHaveLength(2);
    expectSaneBps(r.equitiesBps);
  }, 30000);
});

describe('runMultiwayEquityJob — four seats', () => {
  // A dry river: the aces are the best pair, no straight or flush on board.
  const DRY_RIVER: CardId[] = [C('2c'), C('7d'), C('9h'), C('3s'), C('4c')];
  const FOUR: [CardId, CardId][] = [AA, KK, [C('Qh'), C('Qd')], [C('Jc'), C('Jd')]];
  // A river board straight every hand must play: a four-way tie.
  const TIE_BOARD: CardId[] = [C('2c'), C('3d'), C('4h'), C('5s'), C('6c')];

  it('river: an exact lock gives the winner 10000 and every other seat 0', () => {
    const r = runMultiwayEquityJob({ holes: FOUR, board: DRY_RIVER, seed: '4-lock' });
    expect(r).toEqual({ equitiesBps: [10000, 0, 0, 0], method: 'exact', samples: 1 });
  });

  it('river: a four-way board-straight tie splits 2500 each', () => {
    const r = runMultiwayEquityJob({
      holes: [AA, KK, [C('Qh'), C('Jd')], [C('Ts'), C('9s')]],
      board: TIE_BOARD,
      seed: '4-tie',
    });
    expect(r.method).toBe('exact');
    expect(r.equitiesBps).toEqual([2500, 2500, 2500, 2500]);
  });

  it('flop: four-way enumeration is exact and every bps is sane', () => {
    const r = runMultiwayEquityJob({
      holes: [AA, KK, [C('Qh'), C('Jd')], [C('Ts'), C('9s')]],
      board: [C('2c'), C('7d'), C('9h')],
      seed: '4-flop',
    });
    expect(r.method).toBe('exact');
    expect(r.samples).toBe(820); // C(41, 2): 52 - 8 hole cards - 3 board
    expect(r.equitiesBps).toHaveLength(4);
    expectSaneBps(r.equitiesBps);
  });
});

describe('runMultiwayEquityJob — largest-remainder rounding', () => {
  const TIE_BOARD: CardId[] = [C('2c'), C('3d'), C('4h'), C('5s'), C('6c')];

  it('a three-way exact tie distributes the one leftover bps and still sums to 10000', () => {
    const r = runMultiwayEquityJob({
      holes: [AA, KK, [C('Qh'), C('Jd')]],
      board: TIE_BOARD,
      seed: 'rem-3',
    });
    expectSaneBps(r.equitiesBps);
    expect([...r.equitiesBps].sort((a, b) => a - b)).toEqual([3333, 3333, 3334]);
  });

  it('a seven-way exact tie spreads multiple leftover bps without breaking the sum', () => {
    // No hole may extend the 2-3-4-5-6 board straight (a 7 would make 3-4-5-6-7
    // and win outright), so every hand plays the board and the seven shares are
    // 10000/7.
    const holes: [CardId, CardId][] = [
      AA,
      KK,
      [C('Qh'), C('Qd')],
      [C('Jh'), C('Jd')],
      [C('Th'), C('Td')],
      [C('8h'), C('8d')],
      [C('3h'), C('3c')],
    ];
    const r = runMultiwayEquityJob({ holes, board: TIE_BOARD, seed: 'rem-7' });
    expectSaneBps(r.equitiesBps);
    expect([...r.equitiesBps].sort((a, b) => a - b)).toEqual([
      1428, 1428, 1428, 1429, 1429, 1429, 1429,
    ]);
  });
});

describe('runMultiwayEquityJob — dead cards of an earlier run', () => {
  it("a later run's flop sees exactly the earlier run's five cards as dead", () => {
    const holes: [CardId, CardId][] = [AA, KK];
    const run1: CardId[] = [C('2c'), C('7d'), C('9h'), C('Jh'), C('Qs')];
    const run2Flop: CardId[] = [C('3c'), C('4d'), C('5h')];

    const withDead = runMultiwayEquityJob({ holes, board: run2Flop, seed: 'run2', dead: run1 });
    // Independent enumeration over 52 - holes - flop - run1 board.
    const expected = independentEquity(holes, run2Flop, run1);
    expect(withDead.equitiesBps).toEqual(expected);
    expectSaneBps(withDead.equitiesBps);

    // Ignoring `dead` would deal run1's five cards again and change the answer -
    // proof the exclusion is not a no-op.
    const withoutDead = runMultiwayEquityJob({ holes, board: run2Flop, seed: 'run2' });
    expect(withoutDead.equitiesBps).not.toEqual(withDead.equitiesBps);
  });
});

describe('audit: a fully specified run-2 flop can be recomputed by hand', () => {
  it('matches an independent enumeration for known holes, dead and board', () => {
    // Every input is on the line so a reviewer can redo the 780-combination
    // enumeration without the server: two known hands, run 1's finished board
    // (the dead cards) and run 2's flop. Board length 3 makes the seed
    // irrelevant (exact enumeration), so the value is fully determined.
    const holes: [CardId, CardId][] = [[C('As'), C('Ad')], [C('Ks'), C('Kd')]];
    const run1: CardId[] = [C('2c'), C('7d'), C('9h'), C('Jh'), C('Qs')];
    const run2Flop: CardId[] = [C('3c'), C('4d'), C('5h')];
    const expected = independentEquity(holes, run2Flop, run1);

    const r = runMultiwayEquityJob({ holes, board: run2Flop, seed: 'audit-run2', dead: run1 });
    expect(r.method).toBe('exact');
    expect(r.samples).toBe(780); // C(40, 2): 52 - 2 - 2 - 3 - 5
    expect(r.equitiesBps).toEqual(expected);
    expect(r.equitiesBps).toEqual(AUDIT_RUN2_FLOP);
  });
});
