/**
 * P2 / strategy A-B **experiment design** layer for the bot evaluation rig.
 *
 * The existing rig (`evalStrategies` / `evalMatch` / `evalCompare` / `evalArms`)
 * is a *candidate screen*: one deterministic deal seed, one opponent preset
 * (`tight-aggressive` reference, `always-call` anchor), and an **iid** bootstrap
 * over per-hand deltas. With `memory: true` the hands are state-dependent (each
 * settled hand updates the opponent model), so the iid CI is too narrow and a
 * single seed may simply be a lucky/unlucky deck. This module adds the missing
 * methodology without touching the existing rig's behaviour:
 *
 *   1. MULTI-SEED REPLICAS + aggregation. A replica = one deal seed = one
 *      duplicate pair. Per replica we get a per-hand paired-delta sequence; we
 *      report both the pooled mean and the *replica-mean* (each replica one
 *      observation) so the between-seed variance is visible rather than hidden.
 *   2. BLOCK / CLUSTER bootstrap. `blockBootstrapCI` is a moving-block bootstrap
 *      over the hand sequence; `clusterBootstrapCI` resamples whole replicas.
 *      The original iid `bootstrapCI` is left untouched and reported alongside.
 *   3. OPPONENT POOL. `makeOpponentPolicy` builds real `RulePolicy` opponents
 *      from the four shipped style presets, optionally wrapping them in a
 *      stateless non-grid bet sizer so the hero-side `sizeGrid` P2 switch has
 *      non-grid sizes to actually read.
 *   4. DECISION RULE + sample size. `verdictFor`, `sampleSizeFor`,
 *      `requiredReplicas` encode "CI lower bound > 0 AND point estimate >= MDE",
 *      with Bonferroni adjustment for several simultaneous switches.
 *
 * Everything here is harness-only and side-effect free; the server-touching
 * runner is `runReplicatedComparison` (and the design-only
 * `runOpponentPoolComparison`).
 *
 * Statistics are deterministic (seeded mulberry32) so a report is reproducible.
 */
import {
  mulberry32,
  RulePolicy,
  RULE_PRESETS,
  POSTFLOP_SIZE_GRID,
} from '@4am/agent-core';
import { bootstrapCI } from './evalStrategies.mjs';
import { comparePair } from './evalCompare.mjs';

// ---------------------------------------------------------------------------
// small numeric helpers
// ---------------------------------------------------------------------------

function mean(xs) {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample standard deviation (n-1 denominator); 0 for n < 2. */
export function sampleSd(xs) {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / (n - 1));
}

function assertPositiveNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw new Error(`${name} must be a positive finite number, got ${value}`);
}

/**
 * Acklam's inverse normal CDF (quantile) approximation, |error| < 1.15e-9 over
 * the full range. Used for sample-size / power arithmetic only.
 */
export function normalQuantile(p) {
  if (typeof p !== 'number' || !(p > 0 && p < 1))
    throw new Error(`normalQuantile: p must be in (0, 1), got ${p}`);
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ];
  const low = 0.02425;
  let q;
  let r;
  if (p < low) {
    q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p <= 1 - low) {
    q = p - 0.5;
    r = q * q;
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return (
    -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  );
}

// ---------------------------------------------------------------------------
// sample-size / power arithmetic
// ---------------------------------------------------------------------------

/**
 * Paired one-sample sample size to detect a mean difference `mde` with the given
 * two-sided `alpha` and `power`, given the per-observation SD `sd`:
 *
 *   n = ceil( ((z_{1-alpha/2} + z_power) * sd / mde)^2 )
 *
 * `sd` is the SD of the per-hand PAIRED delta (bb/100), i.e. the quantity the
 * duplicate match estimates. With a between-seed component the effective SD is
 * larger - use `requiredReplicas` for the replica-level design.
 */
export function sampleSizeFor({ sd, mde, alpha = 0.05, power = 0.8 }) {
  assertPositiveNumber(sd, 'sampleSizeFor: sd');
  assertPositiveNumber(mde, 'sampleSizeFor: mde');
  const z = normalQuantile(1 - alpha / 2) + normalQuantile(power);
  return Math.ceil(((z * sd) / mde) ** 2);
}

/**
 * The smallest mean difference a sample of `n` hands can detect at the given
 * alpha/power (inverse of `sampleSizeFor`):
 *
 *   mde = (z_{1-alpha/2} + z_power) * sd / sqrt(n)
 */
export function mdeFor({ sd, n, alpha = 0.05, power = 0.8 }) {
  assertPositiveNumber(sd, 'mdeFor: sd');
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(`mdeFor: n must be a positive integer, got ${n}`);
  const z = normalQuantile(1 - alpha / 2) + normalQuantile(power);
  return (z * sd) / Math.sqrt(n);
}

/**
 * Replica-level design: how many replicas R are needed so the mean of the
 * per-replica estimates has SE = mde / (z_{1-alpha/2} + z_power).
 *
 * There are two input modes and they must NOT be mixed. Neglecting this is how
 * the previous version double-counted the within-seed term and returned an
 * over-conservative R:
 *
 *   1. OBSERVED replica-mean dispersion (preferred after a pilot). Pass
 *      `replicaMeanVar` (or `replicaMeanSd`) exactly as
 *      `aggregateReplicaSamples` reports it. That sample dispersion is already
 *      an unbiased estimate of `Var(one replica estimate) = σ_b² + σ_w²/H`, so
 *      it is used **directly**:
 *
 *          R = ceil( replicaMeanVar * (z / mde)^2 )
 *
 *      The within-seed term is already inside the observed dispersion and must
 *      not be added again.
 *
 *   2. PURE variance components (`betweenSd` + `withinSd` + `handsPerReplica`).
 *      Here `betweenSd` is the pure between-replica SD `σ_b` (NOT the observed
 *      replica-mean SD `sqrt(σ_b² + σ_w²/H)` that `betweenSd` used to hold).
 *      Then:
 *
 *          R = ceil( (σ_b² + σ_w² / H) * (z / mde)^2 )
 *
 * Prefer mode 1 whenever a pilot exists; mode 2 is for planning before any data.
 */
export function requiredReplicas({
  betweenSd = 0,
  withinSd,
  handsPerReplica,
  mde,
  alpha = 0.05,
  power = 0.8,
  replicaMeanVar = null,
  replicaMeanSd = null,
}) {
  assertPositiveNumber(mde, 'requiredReplicas: mde');
  let varPerReplica;
  if (replicaMeanVar !== null || replicaMeanSd !== null) {
    if (replicaMeanVar !== null) {
      if (
        typeof replicaMeanVar !== 'number' ||
        !Number.isFinite(replicaMeanVar) ||
        replicaMeanVar < 0
      )
        throw new Error(
          `requiredReplicas: replicaMeanVar must be a non-negative finite number, got ${replicaMeanVar}`,
        );
      varPerReplica = replicaMeanVar;
    } else {
      if (
        typeof replicaMeanSd !== 'number' ||
        !Number.isFinite(replicaMeanSd) ||
        replicaMeanSd < 0
      )
        throw new Error(
          `requiredReplicas: replicaMeanSd must be a non-negative finite number, got ${replicaMeanSd}`,
        );
      varPerReplica = replicaMeanSd ** 2;
    }
    if (!(varPerReplica > 0))
      throw new Error('requiredReplicas: observed replica-mean variance must be > 0');
  } else {
    assertPositiveNumber(withinSd, 'requiredReplicas: withinSd');
    if (!Number.isInteger(handsPerReplica) || handsPerReplica <= 0)
      throw new Error(`requiredReplicas: handsPerReplica must be a positive integer`);
    if (typeof betweenSd !== 'number' || !Number.isFinite(betweenSd) || betweenSd < 0)
      throw new Error(
        `requiredReplicas: betweenSd must be a non-negative finite number, got ${betweenSd}`,
      );
    varPerReplica = betweenSd ** 2 + withinSd ** 2 / handsPerReplica;
  }
  const z = normalQuantile(1 - alpha / 2) + normalQuantile(power);
  return Math.ceil(varPerReplica * (z / mde) ** 2);
}

// ---------------------------------------------------------------------------
// block / cluster bootstrap
// ---------------------------------------------------------------------------

/**
 * Automatic moving-block length.
 *
 *   - `method: 'nth-root'` (default): the standard rule of thumb
 *     `max(minBlockLength, round(factor * n^(1/3)))`.
 *   - `method: 'acf'`: the first lag `L` at which the lag-L autocorrelation
 *     falls below `1/e` (the decorrelation time), clamped to
 *     `[minBlockLength, n-1]`. Falls back to the nth-root rule when the series
 *     is too short or all-constant.
 *
 * **Caller-set floor:** the nth-root rule is agnostic to the process, so at
 * `n = 60` it returns 4 - shorter than the 10-hand opponent-model cutoff that
 * the design doc calls out as the natural block floor. Pass
 * `minBlockLength: 10` when the series comes from the memory-carrying match;
 * the default stays `1` so the raw rule is available to callers that want it.
 * The result is always clamped to `n` (a block cannot exceed the sample).
 */
export function autoBlockLength(
  samples,
  { method = 'nth-root', factor = 1, maxLag = 50, minBlockLength = 1 } = {},
) {
  const n = samples?.length ?? 0;
  if (n < 2) return 1;
  if (!Number.isInteger(minBlockLength) || minBlockLength < 1)
    throw new Error(`autoBlockLength: minBlockLength must be a positive integer`);
  const floor = Math.min(minBlockLength, n);
  if (method === 'nth-root')
    return Math.min(n, Math.max(floor, Math.round(factor * Math.cbrt(n))));
  if (method !== 'acf') throw new Error(`autoBlockLength: unknown method "${method}"`);
  const m = mean(samples);
  let variance = 0;
  for (const x of samples) variance += (x - m) ** 2;
  variance /= n;
  if (variance === 0) return floor;
  const cap = Math.min(maxLag, n - 1);
  const threshold = 1 / Math.E;
  for (let lag = 1; lag <= cap; lag++) {
    let cov = 0;
    for (let i = 0; i + lag < n; i++) cov += (samples[i] - m) * (samples[i + lag] - m);
    cov /= n;
    if (Math.abs(cov / variance) < threshold) return Math.max(floor, lag);
  }
  return Math.max(floor, cap);
}

/**
 * Moving-block bootstrap (MBB) percentile CI of the mean.
 *
 * Samples `ceil(n / L)` blocks of length L (uniform random start, with
 * replacement), concatenates and truncates to n, and takes the mean. This
 * preserves within-block serial dependence, unlike the iid `bootstrapCI`.
 * `L = 1` reduces to the iid resample in distribution.
 *
 * NOTE: cost is O(iters * n), so choose `iters` with n in mind; for very large n
 * prefer the replica-level cluster bootstrap.
 *
 * Returns `{ mean, ci95, width, sd, n, iters, seed, confidence, blockLength,
 * blocks, method: 'moving-block' }`.
 */
export function blockBootstrapCI(
  samples,
  { blockLength, iters = 10_000, seed = 0x5eed, confidence = 0.95 } = {},
) {
  if (!Number.isInteger(iters) || iters <= 0)
    throw new Error(`blockBootstrapCI: iters must be a positive integer, got ${iters}`);
  if (typeof confidence !== 'number' || !(confidence > 0 && confidence < 1))
    throw new Error(`blockBootstrapCI: confidence must be in (0, 1), got ${confidence}`);
  const n = samples?.length ?? 0;
  if (n === 0)
    return {
      mean: 0, ci95: [0, 0], width: 0, sd: 0, n: 0, iters,
      seed, confidence, blockLength: 0, blocks: 0, method: 'moving-block',
    };
  const L = blockLength ?? autoBlockLength(samples);
  if (!Number.isInteger(L) || L <= 0 || L > n)
    throw new Error(`blockBootstrapCI: blockLength must be an integer in [1, ${n}], got ${L}`);
  const blocks = Math.ceil(n / L);
  const starts = n - L + 1;
  const rand = mulberry32(seed);
  const meansOut = new Array(iters);
  for (let it = 0; it < iters; it++) {
    let sum = 0;
    for (let b = 0; b < blocks; b++) {
      const start = Math.floor(rand() * starts);
      for (let i = 0; i < L && b * L + i < n; i++) sum += samples[start + i];
    }
    meansOut[it] = sum / n;
  }
  meansOut.sort((a, b) => a - b);
  const alpha = (1 - confidence) / 2;
  const lo = meansOut[Math.min(iters - 1, Math.max(0, Math.floor(alpha * iters)))];
  const hi = meansOut[Math.min(iters - 1, Math.max(0, Math.ceil((1 - alpha) * iters) - 1))];
  return {
    mean: mean(samples),
    ci95: [lo, hi],
    width: hi - lo,
    sd: sampleSd(samples),
    n,
    iters,
    seed,
    confidence,
    blockLength: L,
    blocks,
    method: 'moving-block',
  };
}

/**
 * Cluster (replica) bootstrap. Resamples whole clusters - each replica's full
 * per-hand sequence - with replacement, then takes the mean of the R drawn
 * replica means. This is the correct resampling unit when the deal seed (not
 * the hand) is the independent repetition, and it exposes between-seed variance
 * that the pooled iid CI cannot.
 *
 * **Equal weight per replica (fixes the unequal-length bug).** The resample is
 * done over the `R` *cluster means*, not over concatenated raw samples, so a
 * replica with 10 hands counts exactly as much as one with 1000. The old
 * concatenate-then-divide-by-total-n resampled produced length-weighted means
 * and could even land outside `[min cluster mean, max cluster mean]` (e.g.
 * `[[0], [100,100]]` could resample `100,100` twice and average to 133.3). The
 * point estimate is likewise the unweighted mean of the cluster means.
 *
 * `clusters` is an array of per-replica sample arrays. Every entry must be a
 * NON-EMPTY array: an empty / incomplete replica is an experiment-validity
 * failure and is rejected loudly here rather than silently filtered (a filter
 * would quietly change R and the estimand). An empty `clusters` array itself is
 * the legitimate "no data" case and returns a zeroed result.
 *
 * The reported `sd` is the SD of the per-cluster means (the between-cluster
 * uncertainty); `repSd` is the pooled within-cluster SD over the non-empty
 * clusters.
 *
 * Returns `{ mean, ci95, width, sd, repSd, n, clusters, iters, seed,
 * confidence, method: 'cluster' }`.
 */
export function clusterBootstrapCI(
  clusters,
  { iters = 10_000, seed = 0x5eed, confidence = 0.95 } = {},
) {
  if (!Number.isInteger(iters) || iters <= 0)
    throw new Error(`clusterBootstrapCI: iters must be a positive integer, got ${iters}`);
  if (typeof confidence !== 'number' || !(confidence > 0 && confidence < 1))
    throw new Error(`clusterBootstrapCI: confidence must be in (0, 1), got ${confidence}`);
  const raw = clusters ?? [];
  if (!Array.isArray(raw)) throw new Error('clusterBootstrapCI: clusters must be an array');
  // Empty overall input is the legitimate no-data case.
  if (raw.length === 0)
    return {
      mean: 0, ci95: [0, 0], width: 0, sd: 0, repSd: 0, n: 0, clusters: 0,
      iters, seed, confidence, method: 'cluster',
    };
  // No silent filtering: an empty / malformed replica invalidates the run.
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (!Array.isArray(c) || c.length === 0)
      throw new Error(
        `clusterBootstrapCI: cluster ${i} is empty or not an array - an incomplete ` +
          `replica must be reported as invalid, not silently dropped`,
      );
    for (const x of c)
      if (typeof x !== 'number' || !Number.isFinite(x))
        throw new Error(`clusterBootstrapCI: cluster ${i} contains a non-finite sample`);
  }
  const groups = raw;
  const R = groups.length;
  const flat = groups.flat();
  const n = flat.length;
  const clusterMeans = groups.map((g) => mean(g));
  const pointEstimate = mean(clusterMeans);
  const rand = mulberry32(seed);
  const meansOut = new Array(iters);
  for (let it = 0; it < iters; it++) {
    let sum = 0;
    for (let r = 0; r < R; r++) sum += clusterMeans[Math.floor(rand() * R)];
    meansOut[it] = sum / R;
  }
  meansOut.sort((a, b) => a - b);
  const alpha = (1 - confidence) / 2;
  const lo = meansOut[Math.min(iters - 1, Math.max(0, Math.floor(alpha * iters)))];
  const hi = meansOut[Math.min(iters - 1, Math.max(0, Math.ceil((1 - alpha) * iters) - 1))];
  // Pooled within-cluster SD.
  let num = 0;
  let den = 0;
  for (const g of groups) {
    if (g.length < 2) continue;
    const gm = mean(g);
    let v = 0;
    for (const x of g) v += (x - gm) ** 2;
    num += v;
    den += g.length - 1;
  }
  return {
    mean: pointEstimate,
    ci95: [lo, hi],
    width: hi - lo,
    sd: sampleSd(clusterMeans),
    repSd: den > 0 ? Math.sqrt(num / den) : 0,
    n,
    clusters: R,
    iters,
    seed,
    confidence,
    method: 'cluster',
  };
}

/**
 * Aggregate per-replica paired-delta sequences into one experiment summary.
 *
 * `replicaSamples` is an array of arrays (one inner array per deal seed, in hand
 * order, bb/100). Every replica must be non-empty; an empty / incomplete
 * replica is rejected (not silently dropped) because a filter would change R
 * and the estimand. Returns four estimators side by side:
 *   - `iid`     : the legacy pooled iid bootstrap (kept for continuity);
 *   - `block`   : moving-block bootstrap over the pooled hand sequence. **This
 *                 is a pooled SECONDARY DIAGNOSTIC, not a replica-aware CI**:
 *                 the pooled sequence crosses seed boundaries, so a block can
 *                 span two decks and the MBB treats them as one stationary
 *                 chain. It is reported for shape comparison only; the
 *                 replica-aware interval is `cluster`.
 *   - `cluster` : replica-resampled bootstrap (RECOMMENDED when R is large
 *                 enough, i.e. the deal seed is the independent unit). Each
 *                 replica is weighted equally regardless of hand count.
 *   - `pooledMean` / `replicaMean` point estimates.
 * Plus the variance decomposition. `replicaMeanSd` (== `betweenSd`) is the
 * **observed** SD of the replica means, i.e. `sqrt(σ_b² + σ_w²·E[1/H])` (for
 * equal-length replicas, `sqrt(σ_b² + σ_w²/H)`); feed it to
 * `requiredReplicas({ replicaMeanSd })`. `betweenSdPure` debiases it back to the
 * pure `σ_b` for reporting using `E[1/H_i]` (not `1/mean(H)`, which would
 * under-subtract on unequal replicas), and `withinSd` is the pooled per-hand SD.
 */
export function aggregateReplicaSamples(replicaSamples, opts = {}) {
  const {
    bootstrapIters = 10_000,
    confidence = 0.95,
    seed = 0x5eed,
    blockLength = null,
    minBlockLength = 1,
  } = opts;
  const raw = replicaSamples ?? [];
  if (!Array.isArray(raw))
    throw new Error('aggregateReplicaSamples: replicaSamples must be an array of arrays');
  if (raw.length === 0) {
    return {
      n: 0,
      replicas: 0,
      pooledMean: 0,
      replicaMean: 0,
      replicaMeans: [],
      iid: bootstrapCI([], { iters: bootstrapIters, seed, confidence }),
      block: blockBootstrapCI([], { iters: bootstrapIters, seed, confidence }),
      cluster: clusterBootstrapCI([], { iters: bootstrapIters, seed, confidence }),
      betweenSd: 0,
      replicaMeanSd: 0,
      replicaMeanVar: 0,
      betweenSdPure: 0,
      withinSd: 0,
    };
  }
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (!Array.isArray(c) || c.length === 0)
      throw new Error(
        `aggregateReplicaSamples: replica ${i} is empty or not an array - an ` +
          `incomplete replica must be reported as invalid, not silently dropped`,
      );
  }
  const groups = raw;
  const flat = groups.flat();
  const replicaMeans = groups.map((g) => mean(g));
  const iid = bootstrapCI(flat, { iters: bootstrapIters, seed, confidence });
  const L = blockLength ?? autoBlockLength(flat, { minBlockLength });
  const block = blockBootstrapCI(flat, { blockLength: L, iters: bootstrapIters, seed, confidence });
  const cluster = clusterBootstrapCI(groups, { iters: bootstrapIters, seed, confidence });
  let num = 0;
  let den = 0;
  for (const g of groups) {
    if (g.length < 2) continue;
    const gm = mean(g);
    let v = 0;
    for (const x of g) v += (x - gm) ** 2;
    num += v;
    den += g.length - 1;
  }
  const withinSd = den > 0 ? Math.sqrt(num / den) : 0;
  const replicaMeanSd = sampleSd(replicaMeans);
  // Var(replica-mean) = σ_b² + σ_w² · E[1/H_i]: the within-seed term carries
  // 1/H_i PER REPLICA, so the unbiased debias uses the mean of 1/H_i, not
  // 1/mean(H) (Jensen: 1/mean(H) ≤ mean(1/H), so the old form under-subtracted
  // and overstated the pure between-seed SD on unequal replicas). Equal-length
  // replicas make the two identical.
  const meanInvH =
    groups.length > 0 ? mean(groups.map((g) => 1 / g.length)) : 0;
  const pureBetweenVar =
    meanInvH > 0
      ? Math.max(0, replicaMeanSd ** 2 - withinSd ** 2 * meanInvH)
      : replicaMeanSd ** 2;
  return {
    n: flat.length,
    replicas: groups.length,
    pooledMean: iid.mean,
    replicaMean: mean(replicaMeans),
    replicaMeans,
    iid,
    block,
    cluster,
    // Observed SD of the replica means = sqrt(σ_b² + σ_w²/H). This is the value
    // `requiredReplicas` wants (as `replicaMeanSd`/`replicaMeanVar`); it is NOT
    // the pure σ_b. Adding withinSd²/H on top of it would double-count.
    betweenSd: replicaMeanSd,
    replicaMeanSd,
    replicaMeanVar: replicaMeanSd ** 2,
    // Debiased pure between-replica SD, for reporting / pure-component planning.
    betweenSdPure: Math.sqrt(pureBetweenVar),
    withinSd,
  };
}

// ---------------------------------------------------------------------------
// decision rule / multiple comparisons
// ---------------------------------------------------------------------------

/** Bonferroni family-wise alpha for `comparisons` simultaneous tests. */
export function adjustAlpha(alpha, comparisons) {
  if (!(comparisons >= 1)) throw new Error('adjustAlpha: comparisons must be >= 1');
  return alpha / comparisons;
}

/**
 * Turn a point estimate + CI into a verdict.
 *
 * Rules (pre-registered, see docs). The two gates are deliberately asymmetric:
 * `better` needs `bb100 >= +mde`, `worse` needs `bb100 <= -mde` (the doc's
 * `|bb100| >= mde` written out per direction, so a positive estimate can never
 * be read as "worse"):
 *   - `invalid`        : the experiment failed its clean/card/memory gate
 *                        (`clean !== true`, including a missing value).
 *   - `better`         : CI lower bound > 0 AND `bb100 >= mde`.
 *   - `real-but-small` : CI lower bound > 0 but below the MDE.
 *   - `worse`          : CI upper bound < 0 AND `bb100 <= -mde`.
 *   - `inconclusive`   : otherwise.
 *
 * `comparisons > 1` reports the Bonferroni-adjusted alpha that the CI should
 * have been built at (call the bootstrap with `confidence = 1 - adjustedAlpha`).
 */
export function verdictFor({
  bb100,
  ci95,
  mde = 5,
  alpha = 0.05,
  comparisons = 1,
  clean = true,
}) {
  if (typeof bb100 !== 'number' || !Number.isFinite(bb100))
    throw new Error(`verdictFor: bb100 must be a finite number, got ${bb100}`);
  if (!Array.isArray(ci95) || ci95.length !== 2 || !ci95.every((x) => typeof x === 'number' && Number.isFinite(x)))
    throw new Error(`verdictFor: ci95 must be a pair of finite numbers, got ${JSON.stringify(ci95)}`);
  if (ci95[0] > ci95[1])
    throw new Error(`verdictFor: ci95 lower bound ${ci95[0]} exceeds upper bound ${ci95[1]}`);
  assertPositiveNumber(mde, 'verdictFor: mde');
  if (typeof alpha !== 'number' || !(alpha > 0 && alpha < 1))
    throw new Error(`verdictFor: alpha must be in (0, 1), got ${alpha}`);
  if (!(comparisons >= 1)) throw new Error('verdictFor: comparisons must be >= 1');
  const adjustedAlpha = adjustAlpha(alpha, comparisons);
  const [lo, hi] = ci95;
  if (clean !== true)
    return { status: 'invalid', bb100, ci95, mde, alpha, comparisons, adjustedAlpha };
  const statisticallyPositive = lo > 0;
  const statisticallyNegative = hi < 0;
  const positiveSignificant = bb100 >= mde;
  const negativeSignificant = bb100 <= -mde;
  let status;
  if (statisticallyPositive && positiveSignificant) status = 'better';
  else if (statisticallyPositive) status = 'real-but-small';
  else if (statisticallyNegative && negativeSignificant) status = 'worse';
  else status = 'inconclusive';
  return {
    status,
    bb100,
    ci95,
    mde,
    alpha,
    comparisons,
    adjustedAlpha,
    statisticallyPositive,
    statisticallyNegative,
    practicallySignificant: positiveSignificant || negativeSignificant,
  };
}

// ---------------------------------------------------------------------------
// opponent pool (styles + non-grid sizers)
// ---------------------------------------------------------------------------

/** The four shipped `PolicyKind` presets, usable as opponent styles. */
export const OPPONENT_STYLES = [
  'tight-aggressive',
  'loose-aggressive',
  'calling-station',
  'constrained-random',
];

/** A handful of deliberately non-grid pot fractions (grid = 0.33/0.5/0.75/1/1.25/1.5). */
export const NON_GRID_FRACTIONS = [0.28, 0.42, 0.62, 0.85, 1.1, 1.4, 1.62, 0.4, 0.68, 1.05];

/** FNV-1a 32-bit hash of a string, for a stateless per-view draw. */
function hashString(str) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Stable key for one decision view.
 *
 * The key intentionally mixes in state that a seat swap changes (`pot`,
 * `actionHistory` length). That is the POINT of this villain: it is a dynamic
 * opponent that responds to the arm's own bets and to the pot it is facing, not
 * a fixed-size script. Consequently the two seatings of a duplicate pair are
 * ALLOWED to see different villain sizings - the duplicate estimand is the
 * seat-swap average of the arm-vs-reference deltas (see `comparePair`), not
 * "identical villain actions in both seatings". The `handId` keeps the draw
 * reproducible per deal, so a rerun of the same seed is still deterministic.
 */
function viewKey(view, salt) {
  const h = view?.hand ?? {};
  return [
    salt,
    h.handId ?? '',
    h.street ?? '',
    (h.myCards ?? []).join(','),
    (h.board ?? []).join(','),
    h.pot ?? 0,
    (view?.actionHistory ?? []).length,
  ].join('|');
}

/** Tolerance (in pot fractions) within which a size is considered "on grid". */
export const GRID_TOL = 0.02;

/** True when `fraction` is more than `tol` away from every postflop grid point. */
export function isOffGridFraction(fraction, tol = GRID_TOL) {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return false;
  for (const g of POSTFLOP_SIZE_GRID) if (Math.abs(fraction - g) <= tol) return false;
  return true;
}

/**
 * Pick a deterministic non-grid pot fraction from a view key. Pure and
 * stateless: given the same key it always returns the same fraction, and it
 * nudges away from any exact grid point.
 *
 * Note this only controls the *fraction*. Two different views (e.g. the two
 * seatings of a duplicate pair) can share the fraction yet emit different
 * chip amounts because the pot differs, and the emitted amount is checked
 * against the grid independently (see `NonGridSizerPolicy`).
 */
export function pickNonGridFraction(hash, min = 0.25, max = 1.9) {
  const inRange = NON_GRID_FRACTIONS.filter((f) => f >= min && f <= max);
  const list = inRange.length > 0 ? inRange : NON_GRID_FRACTIONS;
  const base = list[hash % list.length];
  const jitter = (((hash >>> 8) % 1000) / 1000) * 0.02 - 0.01;
  let f = base + jitter;
  for (const g of POSTFLOP_SIZE_GRID) if (Math.abs(f - g) < 0.02) f = g + (f >= g ? 0.03 : -0.03);
  return Math.min(max, Math.max(min, f));
}

/**
 * Given the intended chip amount and the pot it is measured against, return an
 * amount as close as possible to `ideal` whose emitted pot fraction is off the
 * grid (within `radius` chips and `[min, max]`), else `ideal`. This keeps the
 * `nonGridApplied` claim honest at small pots, where `Math.round(pot * f)` can
 * land back on a grid point (e.g. `round(2 * 0.4) = 1` = 0.5 pot).
 */
function nudgeOffGrid(ideal, { pot, currentBet = 0, min, max, radius = 3, tol = GRID_TOL }) {
  if (!(pot > 0)) return ideal;
  const fracOf = (x) => (x - currentBet) / pot;
  if (isOffGridFraction(fracOf(ideal), tol)) return ideal;
  for (let d = 1; d <= radius; d++) {
    for (const cand of [ideal - d, ideal + d]) {
      if (cand < min || cand > max) continue;
      if (isOffGridFraction(fracOf(cand), tol)) return cand;
    }
  }
  return ideal;
}

/**
 * Wrap a policy so any bet/raise keeps its action type but takes a non-grid
 * amount. Stateless and legality-clamped; anything it cannot size legally falls
 * through to the base policy's action (which `guardPolicy` double-checks).
 *
 * An optional `stats` sink records:
 *   - `decisions`      : bet/raise decisions the base produced;
 *   - `applied`        : decisions where this wrapper emitted its own amount;
 *   - `nonGridApplied` : of those, the emitted amount's **actual** fraction
 *                        `(amount - currentBet) / pot` is off-grid. Computed
 *                        from the emitted chips and the actual pot, so a rounded
 *                        amount that lands back on a grid point is NOT counted;
 *   - `gridRounded`    : emitted amounts that rounded back onto a grid point;
 *   - `byStreet`       : per-street `{ decisions, nonGridApplied }`, so a run
 *                        can prove the coverage held POSTFLOP (the only street
 *                        the P2 `sizeGrid` read applies to), not just preflop.
 */
export class NonGridSizerPolicy {
  constructor(base, opts = {}) {
    this.base = base;
    this.name = `${base?.name ?? 'opponent'}#nonGrid`;
    this.salt = opts.salt ?? 'nongrid';
    this.min = opts.min ?? 0.25;
    this.max = opts.max ?? 1.9;
    this.stats = opts.stats ?? null;
  }

  decide(view) {
    const decision = this.base ? this.base.decide(view) : null;
    const action = decision?.action;
    const la = view?.legalActions;
    if (!la || !action || (action.type !== 'bet' && action.type !== 'raise')) return decision;
    const street = view?.hand?.street ?? 'other';
    const stats = this.stats;
    const streetRec = () => {
      if (!stats.byStreet) stats.byStreet = {};
      if (!stats.byStreet[street]) stats.byStreet[street] = { decisions: 0, nonGridApplied: 0 };
      return stats.byStreet[street];
    };
    if (stats) {
      stats.decisions++;
      streetRec().decisions++;
    }
    const pot = view?.hand?.pot ?? view?.potOdds?.pot ?? 0;
    const currentBet = view?.hand?.currentBet ?? 0;
    const f = pickNonGridFraction(hashString(viewKey(view, this.salt)), this.min, this.max);
    // A raise's `amount` is a TO-amount; keep it above the min raise-to while
    // still using a non-grid pot fraction for the increment.
    const isRaise = action.type === 'raise';
    const raiseIncrement = Math.max((la.minRaiseTo ?? 0) - currentBet, 1);
    let target = isRaise
      ? Math.round(currentBet + Math.max(raiseIncrement, pot * f))
      : Math.round(pot * f);
    if (!Number.isFinite(target) || !(target >= la.minRaiseTo && target <= la.maxRaiseTo))
      return decision;
    if (pot > 0)
      target = nudgeOffGrid(target, {
        pot,
        currentBet,
        min: la.minRaiseTo,
        max: la.maxRaiseTo,
      });
    // Verify against the ACTUAL emitted chips and pot, not the intended fraction:
    // rounding can put the emitted amount back on a grid point.
    const emittedFrac = pot > 0 ? (target - currentBet) / pot : Number.NaN;
    const offGrid = isOffGridFraction(emittedFrac);
    if (stats) {
      stats.applied++;
      if (offGrid) {
        stats.nonGridApplied++;
        streetRec().nonGridApplied++;
      } else {
        stats.gridRounded++;
      }
    }
    return {
      action: { type: action.type, amount: target },
      reason: `${decision?.reason ?? ''} nonGrid=${offGrid ? 'off' : 'grid'}(f=${
        Number.isFinite(emittedFrac) ? emittedFrac.toFixed(3) : 'n/a'
      })`,
    };
  }
}

/**
 * Build a real `RulePolicy` opponent by shipped style preset.
 *
 * @param {string} style one of `OPPONENT_STYLES`
 * @param {object} [opts]
 * @param {'grid'|'nonGrid'} [opts.sizing] `nonGrid` wraps it in a non-grid sizer
 * @param {object} [opts.params] extra `RuleParams` overrides (e.g. a maniac/nit)
 * @param {number} [opts.seed] policy seed
 * @param {object} [opts.sizingOpts] forwarded to `NonGridSizerPolicy`
 */
export function makeOpponentPolicy(style = 'tight-aggressive', opts = {}) {
  const kind = String(style);
  if (!OPPONENT_STYLES.includes(kind))
    throw new Error(
      `unknown opponent style "${style}" (supported: ${OPPONENT_STYLES.join(', ')})`,
    );
  if (opts.sizing !== undefined && opts.sizing !== 'grid' && opts.sizing !== 'nonGrid')
    throw new Error(`unknown opponent sizing "${opts.sizing}" (grid | nonGrid)`);
  const params = { ...RULE_PRESETS[kind], ...(opts.params ?? {}) };
  const base = new RulePolicy({ kind, params, seed: opts.seed ?? 0x9e3779b9 });
  if (opts.sizing === 'nonGrid') return new NonGridSizerPolicy(base, opts.sizingOpts ?? {});
  return base;
}

// ---------------------------------------------------------------------------
// replicated runner
// ---------------------------------------------------------------------------

/** Cheap 32-bit mix of a deal seed, so each replica's opponent differs. */
function mixSeed(seed) {
  return Math.imul(((seed >>> 0) ^ 0x9e3779b9) >>> 0, 2654435761) >>> 0;
}

/**
 * Run a duplicated arm-vs-reference comparison across several independent deal
 * seeds (replicas) and aggregate the per-replica paired deltas.
 *
 * Each replica is one `comparePair` (two seatings of the same deal), and each
 * replica contributes its FULL per-hand paired-delta sequence, so both pooled
 * and replica-level statistics are available. All matching options are
 * forwarded; `memory` defaults on (the production strategy).
 *
 * @param {string} arm @param {string} reference
 * @param {object} [opts]
 * @param {number[]} [opts.seeds] deal seeds, one replica each
 * @param {number}   [opts.hands] hands per replica
 * @param {{style?:string,sizing?:'grid'|'nonGrid',params?:object,sizingOpts?:object}|null} [opts.opponent]
 *   when set, the seat-0 anchor is this opponent style (instead of `anchor`)
 * @param {string}   [opts.anchor] seat-0 name when no opponent is given
 * @param {number}   [opts.mde] minimum practically-relevant effect (bb/100)
 * @param {number}   [opts.alpha] family-wise alpha (default 0.05)
 * @param {number}   [opts.comparisons] simultaneous tests for the Bonferroni CI
 * @param {object}   [opts.match] extra `comparePair` options
 */
export async function runReplicatedComparison(arm, reference, opts = {}) {
  const {
    seeds = [1234, 1235, 1236],
    hands = 200,
    opponent = null,
    anchor = 'always-call',
    memory = true,
    bootstrapIters = 10_000,
    confidence = 0.95,
    blockLength = null,
    mde = 5,
    alpha = 0.05,
    comparisons = 1,
    match = {},
    onReplica = null,
  } = opts;
  if (!Array.isArray(seeds) || seeds.length === 0)
    throw new Error('runReplicatedComparison: seeds must be a non-empty array');

  const replicas = [];
  for (const seed of seeds) {
    // A factory (not an object) so each of the two seatings gets a FRESH
    // opponent policy: a stateful base must not leak RNG state across the pair.
    const anchorArg = opponent
      ? () =>
          makeOpponentPolicy(opponent.style ?? 'tight-aggressive', {
            sizing: opponent.sizing,
            params: opponent.params,
            sizingOpts: opponent.sizingOpts,
            seed: mixSeed(seed),
          })
      : anchor;
    const r = await comparePair(arm, reference, {
      seed,
      hands,
      anchor: anchorArg,
      memory,
      bootstrapIters,
      ...match,
      // Harness-forced AFTER `...match`: the aggregation below needs the raw
      // per-hand samples, so a caller must not be able to switch them off.
      includeSamples: true,
    });
    const replica = {
      seed,
      clean: r.clean,
      hands: r.hands,
      bb100: r.delta.bb100,
      iidCi95: r.delta.ci95,
      samples: r.samples?.duplicate ?? [],
      opponentStyle: opponent ? (opponent.style ?? 'tight-aggressive') : null,
      opponentSizing: opponent ? (opponent.sizing ?? 'grid') : null,
    };
    replicas.push(replica);
    if (onReplica) onReplica(replica);
  }

  const allClean = replicas.length > 0 && replicas.every((r) => r.clean);
  const confidenceAdjusted = 1 - adjustAlpha(alpha, comparisons);
  const agg = aggregateReplicaSamples(
    replicas.map((r) => r.samples),
    { bootstrapIters, confidence: confidenceAdjusted, blockLength },
  );
  return {
    kind: 'bot-eval-replicated',
    arm,
    reference,
    seeds,
    hands,
    memory,
    opponent,
    mde,
    alpha,
    comparisons,
    confidence: confidenceAdjusted,
    blockLength: agg.block.blockLength,
    allClean,
    replicas,
    iid: agg.iid,
    block: agg.block,
    cluster: agg.cluster,
    pooledMean: agg.pooledMean,
    replicaMean: agg.replicaMean,
    betweenSd: agg.betweenSd,
    withinSd: agg.withinSd,
    verdict: verdictFor({
      bb100: agg.replicaMean,
      ci95: agg.cluster.ci95,
      mde,
      alpha,
      comparisons,
      clean: allClean,
    }),
  };
}

/**
 * DESIGN-ONLY grid driver: run the replicated comparison once per opponent
 * style. Expensive (styles x seeds x 2 server runs), so it is not exercised by
 * a real run in the unit tests - instead `opts.runReplica` can be injected so a
 * test can assert the per-style forwarding (params / sizing / comparisons)
 * without booting a server. Equal-weight aggregation across styles is left to
 * the caller (per-style results are returned; a pooled verdict would need
 * style-frequency weighting, a product decision).
 */
export async function runOpponentPoolComparison(arm, reference, opts = {}) {
  const styles = opts.styles ?? OPPONENT_STYLES;
  const results = [];
  const comparisons = opts.comparisons ?? styles.length;
  const runReplica = opts.runReplica ?? runReplicatedComparison;
  for (const style of styles) {
    results.push(
      await runReplica(arm, reference, {
        ...opts,
        comparisons,
        opponent: {
          style,
          sizing: opts.sizing ?? 'grid',
          params: opts.params,
          sizingOpts: opts.sizingOpts,
        },
      }),
    );
  }
  return {
    kind: 'bot-eval-opponent-pool',
    arm,
    reference,
    styles,
    sizing: opts.sizing ?? 'grid',
    comparisons,
    results,
    allClean: results.length > 0 && results.every((r) => r.allClean),
  };
}
