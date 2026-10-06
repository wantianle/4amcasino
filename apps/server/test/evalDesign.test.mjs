/**
 * Unit tests for the experiment-design layer (`helpers/evalDesign.mjs`).
 *
 * These are deliberately SERVER-FREE: they prove the statistics (block/cluster
 * bootstrap, aggregation, sample-size arithmetic, verdict rule) and the
 * opponent-policy constructors on synthetic data, so they are fast and never
 * boot a table. The one end-to-end replicated run is gated behind
 * `EVAL_DESIGN_SMOKE=1` (it boots the real server several times).
 *
 *   npx vitest run apps/server/test/evalDesign.test.mjs
 *   EVAL_DESIGN_SMOKE=1 npx vitest run apps/server/test/evalDesign.test.mjs
 */
import { describe, it, expect } from 'vitest';
import {
  mulberry32,
  POSTFLOP_SIZE_GRID,
  snapBetFraction,
  gridFraction,
  chooseVillainModel,
} from '@4am/agent-core';
import { bootstrapCI } from './helpers/evalStrategies.mjs';
import { comparePair } from './helpers/evalCompare.mjs';
import {
  normalQuantile,
  sampleSizeFor,
  mdeFor,
  requiredReplicas,
  autoBlockLength,
  blockBootstrapCI,
  clusterBootstrapCI,
  aggregateReplicaSamples,
  adjustAlpha,
  verdictFor,
  OPPONENT_STYLES,
  NON_GRID_FRACTIONS,
  GRID_TOL,
  pickNonGridFraction,
  isOffGridFraction,
  NonGridSizerPolicy,
  makeOpponentPolicy,
  runReplicatedComparison,
  runOpponentPoolComparison,
} from './helpers/evalDesign.mjs';

/** AR(1) series with a given lag-1 autocorrelation, from a seeded RNG. */
function ar1(n, rho, seed) {
  const rand = mulberry32(seed);
  const out = new Array(n);
  let x = 0;
  for (let i = 0; i < n; i++) {
    x = rho * x + (rand() - 0.5);
    out[i] = x;
  }
  return out;
}

describe('normal quantile + sample size', () => {
  it('normalQuantile matches known values', () => {
    expect(normalQuantile(0.5)).toBeCloseTo(0, 6);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 4);
    expect(normalQuantile(0.8)).toBeCloseTo(0.841621, 4);
    expect(() => normalQuantile(0)).toThrow(/in \(0, 1\)/);
    expect(() => normalQuantile(1)).toThrow(/in \(0, 1\)/);
  });

  it('sampleSizeFor uses (z_alpha/2 + z_power)^2 sd^2 / mde^2', () => {
    const z = normalQuantile(0.975) + normalQuantile(0.8);
    const expected = Math.ceil(((z * 235) / 5) ** 2);
    const n = sampleSizeFor({ sd: 235, mde: 5 });
    expect(n).toBe(expected);
    // Sanity vs the empirical rig: ~17k hands for a 5bb/100 effect at sd 235.
    expect(n).toBeGreaterThan(16_000);
    expect(n).toBeLessThan(19_000);
    expect(() => sampleSizeFor({ sd: 0, mde: 5 })).toThrow(/sd/);
    expect(() => sampleSizeFor({ sd: 10, mde: 0 })).toThrow(/mde/);
  });

  it('mdeFor inverts sampleSizeFor (round trip within one hand)', () => {
    const n = sampleSizeFor({ sd: 120, mde: 4 });
    const back = mdeFor({ sd: 120, n });
    expect(back).toBeLessThanOrEqual(4);
    expect(back).toBeGreaterThan(3.5);
    expect(() => mdeFor({ sd: 5, n: 0 })).toThrow(/n/);
  });

  it('requiredReplicas grows with the between-seed SD', () => {
    const base = { withinSd: 235, handsPerReplica: 1000, mde: 5 };
    const noBetween = requiredReplicas({ ...base, betweenSd: 0 });
    const withBetween = requiredReplicas({ ...base, betweenSd: 30 });
    expect(noBetween).toBeGreaterThan(10);
    expect(noBetween).toBeLessThan(30);
    // Between-seed variance does not shrink with more hands per replica.
    expect(withBetween).toBeGreaterThan(noBetween);
    expect(() => requiredReplicas({ ...base, withinSd: 0 })).toThrow(/withinSd/);
  });

  it('requiredReplicas accepts the OBSERVED replica-mean variance directly (no double count)', () => {
    // The observed replica-mean SD s estimates sqrt(σ_b² + σ_w²/H). Feeding it
    // as `replicaMeanSd` (mode 1) must return the same R as mode 2 with the
    // DEBIASED pure σ_b - not the old σ_b² + 2·σ_w²/H over-count.
    const withinSd = 235;
    const H = 1000;
    const observedReplicaMeanSd = 30; // = sqrt(σ_b² + 235²/1000)
    const pureBetweenSd = Math.sqrt(observedReplicaMeanSd ** 2 - withinSd ** 2 / H);
    const byObserved = requiredReplicas({ replicaMeanSd: observedReplicaMeanSd, mde: 5 });
    const byComponents = requiredReplicas({
      betweenSd: pureBetweenSd,
      withinSd,
      handsPerReplica: H,
      mde: 5,
    });
    expect(Math.abs(byObserved - byComponents)).toBeLessThanOrEqual(1);
    expect(byObserved).toBeGreaterThan(0);
    // The old bug: the observed (within-inclusive) value in the pure `betweenSd`
    // slot plus withinSd²/H again -> strictly larger, over-conservative R.
    const doubleCounted = requiredReplicas({
      betweenSd: observedReplicaMeanSd,
      withinSd,
      handsPerReplica: H,
      mde: 5,
    });
    expect(doubleCounted).toBeGreaterThan(byObserved);
    expect(() => requiredReplicas({ replicaMeanVar: -1, mde: 5 })).toThrow(/replicaMeanVar/);
    expect(() => requiredReplicas({ replicaMeanSd: 0, mde: 5 })).toThrow(/must be > 0/);
  });
});

describe('autoBlockLength', () => {
  it('nth-root rule is ceil-ish round of factor * n^(1/3), min 1', () => {
    expect(autoBlockLength([1, 2], {})).toBe(1);
    expect(autoBlockLength(new Array(1000).fill(0))).toBe(Math.round(Math.cbrt(1000)));
    expect(autoBlockLength(new Array(27).fill(0), { factor: 2 })).toBe(6);
    // The 10-hand opponent-model cutoff is an explicit opt-in floor: the raw
    // nth-root rule at n=60 only gives 4, which is why `minBlockLength` exists.
    expect(autoBlockLength(new Array(60).fill(0))).toBe(4);
    expect(autoBlockLength(new Array(60).fill(0), { minBlockLength: 10 })).toBe(10);
    expect(autoBlockLength(new Array(6).fill(0), { minBlockLength: 10 })).toBe(6); // clamped to n
    expect(() => autoBlockLength([1, 2, 3], { minBlockLength: 0 })).toThrow(/minBlockLength/);
  });

  it('acf method returns 1 for white noise and >1 for a strongly autocorrelated series', () => {
    const rand = mulberry32(11);
    const noise = Array.from({ length: 400 }, () => rand() - 0.5);
    expect(autoBlockLength(noise, { method: 'acf' })).toBe(1);
    const correlated = ar1(600, 0.95, 7);
    expect(autoBlockLength(correlated, { method: 'acf' })).toBeGreaterThan(1);
    expect(() => autoBlockLength(noise, { method: 'nope' })).toThrow(/method/);
  });
});

describe('blockBootstrapCI', () => {
  it('is deterministic, brackets the mean, and handles the empty sample', () => {
    const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const a = blockBootstrapCI(s, { blockLength: 3, iters: 2000, seed: 42 });
    const b = blockBootstrapCI(s, { blockLength: 3, iters: 2000, seed: 42 });
    expect(a).toEqual(b);
    expect(a.mean).toBeCloseTo(5.5, 10);
    expect(a.ci95[0]).toBeLessThanOrEqual(a.mean);
    expect(a.ci95[1]).toBeGreaterThanOrEqual(a.mean);
    expect(a.blockLength).toBe(3);
    expect(a.method).toBe('moving-block');
    expect(blockBootstrapCI([]).n).toBe(0);
  });

  it('L = 1 is exactly the iid bootstrap with the same seed (no dependence assumed)', () => {
    const s = [3, -1, 4, 1, -5, 9, 2, 6, -5, 3, 5, 8];
    const iid = bootstrapCI(s, { iters: 1500, seed: 7 });
    const block = blockBootstrapCI(s, { blockLength: 1, iters: 1500, seed: 7 });
    expect(block.ci95).toEqual(iid.ci95);
    expect(block.mean).toBeCloseTo(iid.mean, 12);
  });

  it('a constant series has zero width; invalid args throw', () => {
    const c = blockBootstrapCI([5, 5, 5, 5], { blockLength: 2 });
    expect(c.width).toBe(0);
    expect(() => blockBootstrapCI([1, 2, 3], { blockLength: 0 })).toThrow(/blockLength/);
    expect(() => blockBootstrapCI([1, 2, 3], { blockLength: 4 })).toThrow(/blockLength/);
    expect(() => blockBootstrapCI([1, 2, 3], { iters: 0 })).toThrow(/iters/);
    expect(() => blockBootstrapCI([1, 2, 3], { confidence: 1 })).toThrow(/confidence/);
  });

  it('CORRECTNESS: on autocorrelated data the block CI is wider than the iid CI', () => {
    // With dependence, resampling single hands understates the uncertainty.
    // The whole point of the block bootstrap is to recover the missing width.
    const correlated = ar1(600, 0.95, 123);
    const iid = bootstrapCI(correlated, { iters: 4000, seed: 7 });
    const block = blockBootstrapCI(correlated, {
      blockLength: autoBlockLength(correlated, { method: 'acf' }),
      iters: 4000,
      seed: 7,
    });
    expect(block.width).toBeGreaterThan(iid.width);
    expect(block.ci95[0]).toBeLessThanOrEqual(block.mean);
    expect(block.ci95[1]).toBeGreaterThanOrEqual(block.mean);
  });
});

describe('clusterBootstrapCI', () => {
  it('is deterministic and resamples whole clusters', () => {
    const clusters = [
      [0, 0, 0],
      [0, 0, 0],
      [100, 100, 100],
      [100, 100, 100],
    ];
    const a = clusterBootstrapCI(clusters, { iters: 3000, seed: 3 });
    const b = clusterBootstrapCI(clusters, { iters: 3000, seed: 3 });
    expect(a).toEqual(b);
    expect(a.mean).toBeCloseTo(50, 10);
    expect(a.clusters).toBe(4);
    expect(a.n).toBe(12);
    // Cluster means 0,0,100,100 => between-cluster SD ~57.7.
    expect(a.sd).toBeGreaterThan(50);
  });

  it('CORRECTNESS: between-cluster spread makes the cluster CI wider than the pooled iid CI', () => {
    // 6 independent replicas; 3 pure 0, 3 pure 100. The pooled iid bootstrap
    // sees 60 iid values and is overconfident; the seed is the real unit.
    const clusters = Array.from({ length: 6 }, (_, k) =>
      new Array(10).fill(k < 3 ? 0 : 100),
    );
    const flat = clusters.flat();
    const iid = bootstrapCI(flat, { iters: 4000, seed: 9 });
    const cluster = clusterBootstrapCI(clusters, { iters: 4000, seed: 9 });
    expect(cluster.mean).toBeCloseTo(iid.mean, 10);
    expect(cluster.width).toBeGreaterThan(iid.width);
    expect(cluster.ci95[0]).toBeLessThanOrEqual(cluster.mean);
    expect(cluster.ci95[1]).toBeGreaterThanOrEqual(cluster.mean);
  });

  it('CORRECTNESS: unequal-length replicas are equi-weighted, never length-weighted', () => {
    // [[0], [100,100]]: cluster means 0 and 100. The correct resample draws 2
    // replica means and averages -> every draw is in {0, 50, 100}, so the CI can
    // never exceed 100. The old concatenate-and-divide-by-total-n resample
    // could draw [100,100] twice and report 400/3 = 133.3 (above every cluster
    // mean). The point estimate is the unweighted mean of {0,100} = 50, NOT the
    // pooled 200/3 = 66.67.
    const r = clusterBootstrapCI([[0], [100, 100]], { iters: 5000, seed: 1 });
    expect(r.mean).toBeCloseTo(50, 10);
    expect(r.mean).not.toBeCloseTo(200 / 3, 6);
    expect(r.ci95[0]).toBeGreaterThanOrEqual(0);
    expect(r.ci95[1]).toBeLessThanOrEqual(100);
    expect(r.clusters).toBe(2);
    expect(r.n).toBe(3);
  });

  it('rejects an empty / malformed replica instead of silently filtering it', () => {
    expect(() => clusterBootstrapCI([[1, 2], []])).toThrow(/incomplete replica/);
    expect(() => clusterBootstrapCI([[1, 2], 'x'])).toThrow(/empty or not an array/);
    expect(() => clusterBootstrapCI([[1, 2], [3, Number.NaN]])).toThrow(/non-finite/);
    // An empty overall input is the legitimate no-data case, not an error.
    expect(clusterBootstrapCI([]).clusters).toBe(0);
  });

  it('handles empty input and validates args', () => {
    expect(clusterBootstrapCI([]).n).toBe(0);
    expect(() => clusterBootstrapCI([[1]], { iters: -1 })).toThrow(/iters/);
  });
});

describe('aggregateReplicaSamples', () => {
  it('pooled and replica means agree for equal-length replicas, and reports the decomposition', () => {
    const replicas = [
      [10, 10, 10],
      [20, 20, 20],
      [-10, -10, -10],
    ];
    const agg = aggregateReplicaSamples(replicas, { bootstrapIters: 2000, seed: 5 });
    expect(agg.n).toBe(9);
    expect(agg.replicas).toBe(3);
    expect(agg.pooledMean).toBeCloseTo(agg.replicaMean, 12);
    expect(agg.replicaMean).toBeCloseTo(20 / 3, 10);
    // Within each replica the values are identical => no within variance;
    // all the spread is between seeds.
    expect(agg.withinSd).toBe(0);
    expect(agg.betweenSd).toBeGreaterThan(0);
    expect(agg.iid.method).toBeUndefined(); // legacy bootstrapCI shape
    expect(agg.block.blockLength).toBeGreaterThanOrEqual(1);
    expect(agg.cluster.clusters).toBe(3);
  });

  it('empty input is safe', () => {
    const agg = aggregateReplicaSamples([]);
    expect(agg.n).toBe(0);
    expect(agg.replicas).toBe(0);
    expect(agg.replicaMean).toBe(0);
  });

  it('reports the observed replica-mean SD and rejects an empty replica', () => {
    const agg = aggregateReplicaSamples(
      [
        [10, 20, 30],
        [12, 18, 24],
        [-10, 0, 10],
      ],
      { bootstrapIters: 500, seed: 2 },
    );
    // `betweenSd` is the observed replica-mean SD (== replicaMeanSd), and the
    // debiased pure between SD cannot exceed it.
    expect(agg.replicaMeanSd).toBeCloseTo(agg.betweenSd, 12);
    expect(agg.replicaMeanVar).toBeCloseTo(agg.replicaMeanSd ** 2, 12);
    expect(agg.betweenSdPure).toBeLessThanOrEqual(agg.replicaMeanSd);
    expect(() => aggregateReplicaSamples([[1, 2], []])).toThrow(/replica 1/);
    expect(() => aggregateReplicaSamples([[1, 2], [3, Number.NaN]])).toThrow(/non-finite/);
  });

  it('betweenSdPure debiases unequal-length replicas with E[1/H], not 1/mean(H)', () => {
    const replicas = [
      [1, 2, 3, 4],
      [10, 12],
      [-5, -3, -1, 1, 3, 5],
    ];
    const agg = aggregateReplicaSamples(replicas, { bootstrapIters: 200, seed: 1 });
    const meanInvH = replicas.reduce((s, g) => s + 1 / g.length, 0) / replicas.length;
    const expectedPure = Math.sqrt(
      Math.max(0, agg.replicaMeanSd ** 2 - agg.withinSd ** 2 * meanInvH),
    );
    expect(agg.betweenSdPure).toBeCloseTo(expectedPure, 10);
    // The old 1/mean(H) form subtracted less, so it overstated the pure
    // between-seed SD whenever the replicas are unequal length.
    const meanH = replicas.flat().length / replicas.length;
    const oldForm = Math.sqrt(
      Math.max(0, agg.replicaMeanSd ** 2 - agg.withinSd ** 2 / meanH),
    );
    expect(agg.betweenSdPure).toBeLessThan(oldForm);
  });
});

describe('multiple comparisons + verdict rule', () => {
  it('adjustAlpha is Bonferroni', () => {
    expect(adjustAlpha(0.05, 4)).toBeCloseTo(0.0125, 12);
    expect(adjustAlpha(0.05, 1)).toBe(0.05);
    expect(() => adjustAlpha(0.05, 0)).toThrow(/comparisons/);
  });

  it('classifies better / real-but-small / worse / inconclusive / invalid', () => {
    expect(verdictFor({ bb100: 8, ci95: [2, 14], mde: 5 }).status).toBe('better');
    expect(verdictFor({ bb100: 2, ci95: [0.5, 3.5], mde: 5 }).status).toBe('real-but-small');
    expect(verdictFor({ bb100: -9, ci95: [-15, -3], mde: 5 }).status).toBe('worse');
    expect(verdictFor({ bb100: 1, ci95: [-4, 6], mde: 5 }).status).toBe('inconclusive');
    expect(verdictFor({ bb100: 100, ci95: [50, 150], mde: 5, clean: false }).status).toBe(
      'invalid',
    );
    // Bonferroni reports the alpha the CI should have used.
    expect(verdictFor({ bb100: 8, ci95: [2, 14], mde: 5, comparisons: 4 }).adjustedAlpha).toBeCloseTo(
      0.0125,
      12,
    );
  });

  it('verdictFor uses the per-direction MDE, treats non-true clean as invalid, and validates input', () => {
    // Negative direction: `worse` needs bb100 <= -mde; below that it is
    // inconclusive, never "real-but-small" (which is a positive-only label).
    expect(verdictFor({ bb100: -6, ci95: [-12, -1], mde: 5 }).status).toBe('worse');
    expect(verdictFor({ bb100: -4, ci95: [-9, -1], mde: 5 }).status).toBe('inconclusive');
    // clean !== true: any value other than boolean true gates to invalid
    // (omitting it defaults to true, i.e. the experiment is clean).
    expect(verdictFor({ bb100: 8, ci95: [2, 14], mde: 5, clean: 'yes' }).status).toBe('invalid');
    expect(verdictFor({ bb100: 8, ci95: [2, 14], mde: 5, clean: 0 }).status).toBe('invalid');
    expect(verdictFor({ bb100: 8, ci95: [2, 14], mde: 5 }).status).toBe('better');
    expect(verdictFor({ bb100: 8, ci95: [2, 14], mde: 5 }).practicallySignificant).toBe(true);
    expect(() => verdictFor({ bb100: Number.NaN, ci95: [0, 1] })).toThrow(/bb100/);
    expect(() => verdictFor({ bb100: 1, ci95: [Array(1)] })).toThrow(/ci95/);
    expect(() => verdictFor({ bb100: 1, ci95: [2, 1] })).toThrow(/lower bound/);
    expect(() => verdictFor({ bb100: 1, ci95: [0, 1], mde: 0 })).toThrow(/mde/);
    expect(() => verdictFor({ bb100: 1, ci95: [0, 1], comparisons: 0 })).toThrow(/comparisons/);
  });
});

describe('opponent pool', () => {
  it('exposes the four shipped presets and builds a real RulePolicy', () => {
    expect(OPPONENT_STYLES).toEqual([
      'tight-aggressive',
      'loose-aggressive',
      'calling-station',
      'constrained-random',
    ]);
    for (const style of OPPONENT_STYLES) {
      const p = makeOpponentPolicy(style);
      expect(typeof p.decide).toBe('function');
    }
    expect(() => makeOpponentPolicy('maniac')).toThrow(/unknown opponent style/);
    expect(() => makeOpponentPolicy('tight-aggressive', { sizing: 'weird' })).toThrow(
      /unknown opponent sizing/,
    );
  });

  it('nonGrid sizing wraps the base and produces legal, off-grid bet amounts', () => {
    const fakeBase = {
      name: 'fake',
      decide: () => ({ action: { type: 'bet', amount: 20 }, reason: 'value' }),
    };
    const p = new NonGridSizerPolicy(fakeBase);
    const view = {
      hand: { handId: 'h1', street: 'flop', myCards: [2, 14], board: [9, 13, 22], pot: 100, currentBet: 0 },
      legalActions: { canBet: true, minRaiseTo: 20, maxRaiseTo: 4000 },
      actionHistory: [],
    };
    const d1 = p.decide(view);
    const d2 = p.decide(view);
    expect(d1).toEqual(d2); // stateless / deterministic per view
    expect(d1.action.type).toBe('bet');
    expect(d1.action.amount).toBeGreaterThanOrEqual(20);
    expect(d1.action.amount).toBeLessThanOrEqual(4000);
    const frac = d1.action.amount / 100;
    for (const g of POSTFLOP_SIZE_GRID) expect(Math.abs(frac - g)).toBeGreaterThan(0.02);
  });

  it('nonGrid sizing keeps a raise legal and above the min raise-to', () => {
    const fakeBase = {
      name: 'fake',
      decide: () => ({ action: { type: 'raise', amount: 40 }, reason: 'value' }),
    };
    const p = new NonGridSizerPolicy(fakeBase);
    const view = {
      hand: { handId: 'h2', street: 'turn', myCards: [2, 14], board: [9, 13, 22, 30], pot: 100, currentBet: 20 },
      legalActions: { canRaise: true, minRaiseTo: 40, maxRaiseTo: 4000 },
      actionHistory: [{ type: 'bet' }],
    };
    const d = p.decide(view);
    expect(d.action.type).toBe('raise');
    expect(d.action.amount).toBeGreaterThanOrEqual(40);
    expect(d.action.amount).toBeLessThanOrEqual(4000);
  });

  it('pickNonGridFraction never lands on a grid point and is deterministic', () => {
    for (let h = 0; h < 500; h++) {
      const f = pickNonGridFraction(h);
      expect(f).toBeGreaterThanOrEqual(0.25);
      expect(f).toBeLessThanOrEqual(1.9);
      for (const g of POSTFLOP_SIZE_GRID) expect(Math.abs(f - g)).toBeGreaterThan(0.02);
      expect(pickNonGridFraction(h)).toBe(f);
    }
    expect(NON_GRID_FRACTIONS.length).toBeGreaterThan(2);
  });

  it('sizeGrid really reads the emitted non-grid size (direct decision-view proof)', () => {
    // Every declared non-grid fraction is off the grid, and the sizeGrid read
    // SNAPS it to a grid point while the continuous read keeps the raw value.
    for (const f of NON_GRID_FRACTIONS) {
      expect(isOffGridFraction(f)).toBe(true);
      expect(snapBetFraction(f)).not.toBe(f);
      expect(gridFraction(snapBetFraction(f))).not.toBe(f);
    }
    // 0.9 is a discriminating decision-view point: snapped to 1.0 it reads as
    // value-heavy, while the raw 0.9 (< 1) stays balanced. This exercises the
    // exact hero-side read path (`chooseVillainModel(..., sizeGrid)`).
    const base = { allIn: false, heroWasAggressor: false, wet: false };
    expect(chooseVillainModel({ ...base, betFraction: 0.9 }, true)).toBe('value-heavy');
    expect(chooseVillainModel({ ...base, betFraction: 0.9 }, false)).toBe('balanced');
    // The canonical 0.42 the design cites: snaps to 0.5, raw stays 0.42.
    expect(snapBetFraction(0.42)).toBe(0.5);
    expect(isOffGridFraction(0.42)).toBe(true);
    expect(GRID_TOL).toBeGreaterThan(0);
  });

  it('nonGridApplied counts only amounts whose ACTUAL emitted fraction is off-grid', () => {
    const base = {
      name: 'fake',
      decide: () => ({ action: { type: 'bet', amount: 20 }, reason: 'value' }),
    };
    // --- off-grid bet: pot 100, controlled fraction 0.42 -> 42 = 0.42 pot. ---
    const okStats = { decisions: 0, applied: 0, nonGridApplied: 0, gridRounded: 0 };
    const ok = new NonGridSizerPolicy(base, { min: 0.42, max: 0.42, stats: okStats });
    const okView = {
      hand: { handId: 'ok', street: 'flop', myCards: [2, 14], board: [9, 13, 22], pot: 100, currentBet: 0 },
      legalActions: { canBet: true, minRaiseTo: 1, maxRaiseTo: 4000 },
      actionHistory: [],
    };
    const okDec = ok.decide(okView);
    expect(okDec.action.amount).toBe(42);
    expect(isOffGridFraction(okDec.action.amount / 100)).toBe(true);
    expect(okStats.nonGridApplied).toBe(1);
    expect(okStats.gridRounded).toBe(0);
    expect(okStats.byStreet.flop).toEqual({ decisions: 1, nonGridApplied: 1 });
    // Preflop is tracked separately so a smoke can prove POSTFLOP coverage.
    const preflopView = {
      hand: { handId: 'pf', street: 'preflop', myCards: [2, 14], board: [], pot: 100, currentBet: 0 },
      legalActions: { canBet: true, minRaiseTo: 1, maxRaiseTo: 4000 },
      actionHistory: [],
    };
    ok.decide(preflopView);
    expect(okStats.byStreet.preflop.decisions).toBe(1);

    // --- rounding floor: pot 2, legal window fixed to 1 chip -> 1/2 = 0.5 pot
    // (a grid point). The wrapper cannot nudge inside [1, 1], so the emitted
    // amount is honestly counted as grid-rounded, not non-grid. ---
    const floorStats = { decisions: 0, applied: 0, nonGridApplied: 0, gridRounded: 0 };
    const floor = new NonGridSizerPolicy(base, { min: 0.4, max: 0.4, stats: floorStats });
    const floorView = {
      hand: { handId: 'floor', street: 'turn', myCards: [2, 14], board: [9, 13, 22, 30], pot: 2, currentBet: 0 },
      legalActions: { canBet: true, minRaiseTo: 1, maxRaiseTo: 1 },
      actionHistory: [],
    };
    const floorDec = floor.decide(floorView);
    expect(floorDec.action.amount).toBe(1);
    expect(isOffGridFraction(1 / 2)).toBe(false);
    expect(floorStats.nonGridApplied).toBe(0);
    expect(floorStats.gridRounded).toBe(1);

    // --- raise-to boundary: the emitted increment - not the to-amount - is what
    // the fraction is measured on. currentBet 20, pot 40, fixed to 40 -> the
    // increment 20 is 0.5 pot (grid), and [40, 40] gives no room to nudge. ---
    const raiseBase = {
      name: 'raiseFake',
      decide: () => ({ action: { type: 'raise', amount: 40 }, reason: 'value' }),
    };
    const raiseStats = { decisions: 0, applied: 0, nonGridApplied: 0, gridRounded: 0 };
    const raisePolicy = new NonGridSizerPolicy(raiseBase, { min: 0.4, max: 0.4, stats: raiseStats });
    const raiseView = {
      hand: { handId: 'raise', street: 'river', myCards: [2, 14], board: [9, 13, 22, 30, 44], pot: 40, currentBet: 20 },
      legalActions: { canRaise: true, minRaiseTo: 40, maxRaiseTo: 40 },
      actionHistory: [{ type: 'bet' }],
    };
    const raiseDec = raisePolicy.decide(raiseView);
    expect(raiseDec.action.amount).toBe(40);
    expect((raiseDec.action.amount - 20) / 40).toBe(0.5);
    expect(raiseStats.nonGridApplied).toBe(0);
    expect(raiseStats.gridRounded).toBe(1);

    // --- an off-grid raise: pot 100, currentBet 20, fixed 0.42 -> increment 42,
    // to-amount 62 = (62-20)/100 = 0.42 pot, counted. ---
    const rOkStats = { decisions: 0, applied: 0, nonGridApplied: 0, gridRounded: 0 };
    const rOk = new NonGridSizerPolicy(raiseBase, { min: 0.42, max: 0.42, stats: rOkStats });
    const rOkDec = rOk.decide({
      hand: { handId: 'rok', street: 'turn', myCards: [2, 14], board: [9, 13, 22, 30], pot: 100, currentBet: 20 },
      legalActions: { canRaise: true, minRaiseTo: 40, maxRaiseTo: 4000 },
      actionHistory: [{ type: 'bet' }],
    });
    expect(rOkDec.action.amount).toBe(62);
    expect((rOkDec.action.amount - 20) / 100).toBe(0.42);
    expect(rOkStats.nonGridApplied).toBe(1);
  });

  it('runOpponentPoolComparison forwards params/sizing and is testable without a server', async () => {
    const calls = [];
    const runReplica = async (arm, reference, o) => {
      calls.push({ arm, reference, opponent: o.opponent, comparisons: o.comparisons });
      return { allClean: true, opponent: o.opponent };
    };
    const pool = await runOpponentPoolComparison('armX', 'refY', {
      styles: ['tight-aggressive', 'calling-station'],
      params: { bluffScale: 2 },
      sizing: 'nonGrid',
      sizingOpts: { salt: 'x' },
      runReplica,
    });
    expect(pool.kind).toBe('bot-eval-opponent-pool');
    expect(pool.styles).toEqual(['tight-aggressive', 'calling-station']);
    expect(pool.comparisons).toBe(2);
    expect(pool.allClean).toBe(true);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.arm).toBe('armX');
      expect(c.reference).toBe('refY');
      // `params` used to be dropped here; it must reach every style.
      expect(c.opponent.params).toEqual({ bluffScale: 2 });
      expect(c.opponent.sizing).toBe('nonGrid');
      expect(c.opponent.sizingOpts).toEqual({ salt: 'x' });
    }
    expect(calls.map((c) => c.opponent.style)).toEqual(['tight-aggressive', 'calling-station']);
  });
});

// ---------------------------------------------------------------------------
// End-to-end replicated run (boots the real server; opt-in only).
// ---------------------------------------------------------------------------

const SMOKE = process.env.EVAL_DESIGN_SMOKE === '1';
describe.skipIf(!SMOKE)('replicated run (EVAL_DESIGN_SMOKE=1)', () => {
  it(
    '3 seeds x 20 hands aggregate into pooled + block + cluster estimates, all clean, with a real treatment contrast',
    async () => {
      const startedAt = Date.now();
      // 20 hands/replica (not 3): a 3-hand deck barely populates the opponent
      // model, so the arm and the all-off baseline could produce the same
      // decisions and the A/B would "pass" without ever measuring a contrast -
      // the exact false positive the explicit all-off baseline fixed. The
      // assertions below pin the contrast, not just a zero point estimate.
      const r = await runReplicatedComparison('p2:all', 'rules-v1', {
        seeds: [1234, 1235, 1236],
        hands: 20,
        memory: true,
        bootstrapIters: 1000,
        actionMs: 800,
        cryptoMs: 2000,
        handMs: 20000,
      });
      const elapsed = Date.now() - startedAt;
      // eslint-disable-next-line no-console
      console.log(
        `[evalDesign smoke] ${r.replicas.length} replicas x ${r.hands} hands in ${elapsed}ms ` +
          `pooled=${r.pooledMean?.toFixed?.(3)} replicaMean=${r.replicaMean.toFixed(3)} ` +
          `iid95=[${r.iid.ci95.map((x) => x.toFixed(2))}] ` +
          `block95(L=${r.blockLength})=[${r.block.ci95.map((x) => x.toFixed(2))}] ` +
          `cluster95=[${r.cluster.ci95.map((x) => x.toFixed(2))}] verdict=${r.verdict.status}`,
      );
      expect(r.allClean).toBe(true);
      expect(r.replicas).toHaveLength(3);
      expect(r.iid.n).toBe(60);
      // The A/B must NOT collapse to the control: the `p2:all` (sizeGrid +
      // buckets) arm has to change at least some decisions vs the all-off
      // baseline, otherwise the config is not actually wired through.
      expect(r.replicas.some((x) => x.samples.some((v) => v !== 0))).toBe(true);
      expect(r.pooledMean).not.toBe(0);
      expect(r.verdict.status).toBeDefined();
    },
    300000,
  );

  it(
    'a non-grid loose-aggressive opponent really emits off-grid sizes POSTFLOP across a short run',
    async () => {
      // Direct comparePair so one shared stats sink spans both seatings. This
      // proves VILLAIN INPUT GENERATION: the villain actually bet/raised a
      // non-grid amount at least once ON A POSTFLOP street, where the
      // hero-side `sizeGrid` read would apply - a preflop-only count would
      // prove nothing. It does NOT prove the hero/arm read that emitted amount
      // (the `byStreet` counter is on the villain's decision views, upstream of
      // the hero read); the read branch is proved separately by the
      // decision-view unit test below. End-to-end read trace is not covered.
      // `memory: false`: this smoke isolates the villain's off-grid sizing, so
      // it deliberately does not depend on the cross-hand memory barrier (whose
      // seat-1 record can lag by one hand on a longer run and make a memory-run
      // `clean` flaky). The arm's `sizeGrid` read does not need session memory.
      const sizingStats = {
        decisions: 0,
        applied: 0,
        nonGridApplied: 0,
        gridRounded: 0,
      };
      const startedAt = Date.now();
      const r = await comparePair('p2:sizeGrid', 'rules-v1', {
        seed: 3333,
        hands: 15,
        memory: false,
        bootstrapIters: 1000,
        actionMs: 800,
        cryptoMs: 2000,
        handMs: 20000,
        anchor: () =>
          makeOpponentPolicy('loose-aggressive', {
            sizing: 'nonGrid',
            sizingOpts: { stats: sizingStats },
          }),
      });
      const elapsed = Date.now() - startedAt;
      const byStreet = sizingStats.byStreet ?? {};
      const postflop = Object.entries(byStreet)
        .filter(([street]) => street !== 'preflop')
        .reduce(
          (a, [, v]) => ({
            decisions: a.decisions + v.decisions,
            nonGridApplied: a.nonGridApplied + v.nonGridApplied,
          }),
          { decisions: 0, nonGridApplied: 0 },
        );
      // eslint-disable-next-line no-console
      console.log(
        `[evalDesign opponent smoke] nonGrid loose-aggressive 15 hands in ${elapsed}ms ` +
          `clean=${r.clean} byStreet=${JSON.stringify(byStreet)} ` +
          `postflop decisions=${postflop.decisions} nonGridApplied=${postflop.nonGridApplied} ` +
          `gridRounded=${sizingStats.gridRounded} ` +
          `cards=${JSON.stringify(r.cards)} ` +
          `runs=${JSON.stringify(
            (r.runs ?? []).map((x) => ({
              hands: x.hands,
              requested: x.requestedHands,
              aborts: x.aborts,
              rejected: x.rejected,
              botErrors: x.botErrors,
              ledgerOk: x.ledgerOk,
              memory: x.memory,
              cardsFingerprintComplete: x.cardsFingerprintComplete,
              seatMemory: x.seatMemory,
            })),
          )}`,
      );
      expect(r.clean).toBe(true);
      expect(sizingStats.decisions).toBeGreaterThan(0);
      expect(sizingStats.nonGridApplied).toBeGreaterThan(0);
      // Must be a POSTFLOP villain bet/raise, and off-grid, not just preflop.
      expect(postflop.decisions).toBeGreaterThan(0);
      expect(postflop.nonGridApplied).toBeGreaterThan(0);
    },
    300000,
  );
});
