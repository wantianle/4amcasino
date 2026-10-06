# Bot Evaluation Experiment Design (P2 / strategy A-B)

**Status:** design + minimal implementation landed. The statistics, replicate
runner and opponent pool live in `apps/server/test/helpers/evalDesign.mjs`;
the methodology below is what a scheduled experiment should follow.

**Goal:** turn the existing candidate screen (one deterministic deal seed, one
opponent preset, iid bootstrap) into an experiment whose "switch X is better"
verdict means what it says. The screen stays as-is; this adds the missing
sampling structure on top.

**Prerequisites (already on `main`):** deterministic deal seam, duplicate
(seat-swapped) pairing, per-hand paired delta `((A1-B1)+(A2-B2))/2`, card-level
replay fingerprints, ledger conservation, arm factory (`rules-v1` / `p2:*` /
`adaptive-preflop`), memory-on path. A/A zero-point calibration passes
(`comparePair('rules-v1','default',{memory:true})` → exactly 0, sd 0).

---

## 0. Why the current screen is only a screen

- **Single seed.** One seed = one physical deck. A conclusion on `seed 1234`
  may be a property of that deck, not of the strategy.
- **iid bootstrap.** With `memory: true`, hand `h+1` is decided against an
  opponent model updated by hands `1..h`. The hands are serially dependent, so
  resampling single hands understates the variance and the CI is too narrow.
- **Grid-only opponents.** `sizeGrid` changes how the hero *reads an opponent's
  bet size*. If the opponent only bets `0.33/0.5/0.75/1/1.25/1.5` pot, the
  switch is a no-op and is unobservable.
- **One opponent style.** Only `tight-aggressive` is exercised; a switch that
  helps vs a nit can hurt vs a maniac.

---

## A1. Replica / seed structure

**Unit of an experiment: a replica = one deal seed = one duplicate pair**
(two seatings of the same cards). `runReplicatedComparison(arm, reference, {
seeds, hands })` runs one `comparePair` per seed and keeps each replica's full
per-hand paired-delta sequence.

**Two estimators, both reported:**

| estimator | definition | catches |
|---|---|---|
| pooled | concatenate all hands, take the mean | within-deck precision |
| replica-mean (primary) | mean of the per-replica means; each seed is one observation | between-deck variance |

When every replica has the same hand count the two point estimates are equal;
they differ only if hands/replica vary, which is a signal to keep hands/replica
fixed.

**Variance decomposition.** Let `σ_w²` be the within-replica per-hand variance
and `σ_b²` the between-replica variance of the replica means. Then

```
Var(replica mean) = σ_b² / R + σ_w² / (R · H)          (H hands per replica, R replicas)
```

The `σ_b²` term does **not** shrink with more hands, only with more seeds. This
is the entire reason one long single-seed run cannot substitute for many seeds.
The screen cannot even estimate `σ_b` — so step 1 of any real experiment is a
**pilot**: R ≈ 20–30 seeds × modest H, purely to measure `σ_b` (and `σ_w`).

**`requiredReplicas` input (avoid double-counting the within term).**
`aggregateReplicaSamples` reports `replicaMeanSd` (aliased as `betweenSd`) as
the **observed** SD of the replica means, which estimates
`sqrt(σ_b² + σ_w²/H)`; feed it directly as `requiredReplicas({ replicaMeanSd })`
(or `{ replicaMeanVar }`). Do not also pass `withinSd`/`handsPerReplica` on top
of it, and do not put the observed value into the pure `betweenSd` slot while
also passing `withinSd`/`H` — that adds `σ_w²/H` a second time and over-states
the required R (the previous behaviour). The pure-component mode
`requiredReplicas({ betweenSd, withinSd, handsPerReplica })` expects the
**debiased** `betweenSdPure` from the aggregate, not the observed value.

**Sample size (per arm, paired one-sample, 80% power, two-sided α = 0.05):**

```
n = ceil( ((z_{0.975} + z_{0.8}) · σ_d / Δ)² ),   z-sum = 2.8016
```

where `σ_d` is the SD of the per-hand paired delta (bb/100). The screen's
observed single-seed 60-hand CI width of ≈ 119 bb/100 implies
`σ_d ≈ 119·√60 / (2·1.96) ≈ 235 bb/100` — a plausible raw per-hand paired
swing at bb = 20 (the duplicate cancels card luck, not action-outcome noise).

Hands needed (iid formula):

| σ_d \ Δ (bb/100) | 5 | 3 | 2 | 1 |
|---:|---:|---:|---:|---:|
| 100 | 3 140 | 8 721 | 19 623 | 78 489 |
| 150 | 7 064 | 19 623 | 44 150 | 176 600 |
| **235 (observed)** | **17 339** | **48 162** | **108 364** | **433 455** |

So the reported "±5 bb/100" is the MDE at ≈ 17k hands, and "~200k hands" only
buys ≈ **1.5 bb/100** even under iid. Under a non-trivial `σ_b` the requirement
grows fast — with `σ_w = 150`, `H = 2000`, `Δ = 5`:

| σ_b (bb/100) | replicas R | total hands |
|---:|---:|---:|
| 0 | 4 | 8 000 |
| 10 | 35 | 70 000 |
| 30 | 287 | 574 000 |
| 60 | 1 134 | 2 268 000 |

**Recommendation:** fix `H` per replica (e.g. 1 000–2 000 hands); pick `R` from
the pilot's `σ_b`; never trust a `σ_b`-blind design. If `σ_b` is large, the
honest conclusion may be "these seeds disagree — the strategy's edge is
deck-dependent", which is itself a result.

---

## A2. Block bootstrap

**Block unit.** The dependency boundary is the replica (seed), and *within* a
replica the hands are dependent through session memory. Two complementary
methods:

1. **Cluster (replica) bootstrap — primary.** Resample whole replicas with
   replacement and average the R drawn **replica means**, so every replica is
   weighted equally regardless of its hand count. (Concatenating raw samples
   and dividing by the total hand count would length-weight the replicas and
   can even place the estimate outside the range of the cluster means.) An
   empty / incomplete replica is invalid and is rejected rather than silently
   filtered. Exact for the between-seed structure; requires enough replicas
   (R ≳ 20) for a stable CI.
2. **Moving-block bootstrap (MBB) — secondary.** Resample blocks of `L`
   consecutive hands from the pooled sequence. **This is a pooled diagnostic,
   not the replica-aware interval:** the pooled sequence crosses seed (deck)
   boundaries, so a block can span two decks; report it for shape only, never
   as the verdict CI. Block length:
   - default `L = max(minBlockLength, round(n^(1/3)))` with `minBlockLength = 1`;
   - `method: 'acf'` picks the first lag whose autocorrelation drops below
     `1/e` (the decorrelation time), floored at `minBlockLength`.
   The nth-root rule is process-agnostic (n = 60 → 4), so it does **not**
   encode the 10-hand opponent-model cutoff by itself. Call
   `autoBlockLength(samples, { minBlockLength: 10 })` (or
   `aggregateReplicaSamples(..., { minBlockLength: 10 })`) to impose that
   horizon explicitly.

**Interfaces (both new, `evalDesign.mjs`):**

```js
blockBootstrapCI(samples, { blockLength, iters = 10_000, seed, confidence }) // MBB
clusterBootstrapCI(clusters, { iters, seed, confidence })                    // replica resample
autoBlockLength(samples, { method: 'nth-root' | 'acf', factor, maxLag, minBlockLength })
aggregateReplicaSamples(replicaSamples, { blockLength, minBlockLength, bootstrapIters, seed, confidence })
```

`blockBootstrapCI(samples, { blockLength: 1 })` is exactly the iid bootstrap
with the same seed (proved by test), so it is a strict superset in behaviour.

**Relationship to existing `bootstrapCI`:** **keep both.** `bootstrapCI` is
untouched (existing tests depend on it) and still reported as `iid`; the new
functions are additive. The design doc's standing rule: report `iid`, `block`
and `cluster` side by side. If `cluster.width ≫ iid.width`, the iid CI was
overconfident and must not be quoted as the verdict. `runReplicatedComparison`
returns all three.

---

## A3. Opponent pool

**Styles.** `makeOpponentPolicy(style, opts)` builds a real `RulePolicy` from
one of the four shipped presets: `tight-aggressive`, `loose-aggressive`,
`calling-station`, `constrained-random`. Extra `params` overrides can mint
`maniac` / `nit` variants (e.g. high `bluffScale` / low `preflopScale`) without
touching `agent-core`.

**Non-grid sizing.** `NonGridSizerPolicy` wraps any opponent and replaces the
*amount* of every bet/raise with a deterministic, off-grid pot fraction
(`pickNonGridFraction`, hashed from the decision view). This makes `sizeGrid`
observable: with the switch ON the hero snaps `0.42` to `0.5` before reading
it; with it OFF the raw fraction is used. The wrapper reports an amount as
off-grid only when the **actual emitted fraction** `(amount - currentBet) / pot`
is more than `GRID_TOL` away from every grid point (rounding at small pots can
put an intended non-grid fraction back on the grid), and it nudges the rounded
amount off-grid when the legal window allows it.

**The villain is a DYNAMIC opponent (estimand).** The sizing hash mixes in
`pot` and `actionHistory`, so the villain responds to the arm/reference actions
it actually faces. It is therefore **not** true that the two seatings of a
duplicate pair see identical villain sizings: after the seat swap the pot and
prior actions differ, so the same deck can produce different (still
deterministic-per-view) villain amounts. The duplicate estimand is the
**seat-swap-averaged arm-minus-reference delta**,

```
E[ (A-B | A@seat1, B@seat2) + (A-B | A@seat2, B@seat1) ] / 2
```

over the two seatings of one deal, which cancels the luck of which strategy got
which cards. It does **not** require the villain to be frozen; an opponent that
adapts to the arm's line is the more faithful model of the live table. (An
earlier revision wrongly claimed a fixed-size villain across seatings; that
claim is withdrawn.)

**Pairing.** For each `(replica seed s, opponent style k, sizing)`:

- seat 0 = the villain (same style in both seatings), seats 1/2 = arm/reference
  swapped. Same cards. Per-hand observation = the duplicate paired delta.
- A per-view factory seats a **fresh** opponent each seating, so no policy RNG
  state leaks from run 1 into run 2.

Aggregate **within** `(s,k)` first, then summarise per style, then pool. Report
per-style deltas; an equal-weight pool is a product decision (does the live
mix match the pool?), so `runOpponentPoolComparison` returns per-style results
and leaves weighting to the caller.

**Smoke evidence (real run) — two separate, narrower proofs.** These do **not**
together constitute an end-to-end read trace:

1. **Villain input generation (real-run smoke).** A 15-hand duplicate with a
   `loose-aggressive` `nonGrid` villain at seat 0 runs clean and emits off-grid
   villain sizings on **postflop** streets, counted from the *actual emitted
   amount* against the actual pot; the run log prints the per-street breakdown
   (`byStreet`) and separates `nonGridApplied` from `gridRounded`. This proves
   the villain *produced* off-grid postflop amounts. It does **not** by itself
   prove the hero/arm *read* any particular one of them: `byStreet` counts the
   villain's decision views, which are upstream of the hero's read.
2. **Hero-side read branch (server-free unit test).** Independently,
   `snapBetFraction(0.42) = 0.5`, and `chooseVillainModel` snaps a 0.9 read to
   `value-heavy` with `sizeGrid` on but keeps it `balanced` with it off. This
   proves the read *branch* exists and discriminates on the switch.

**End-to-end read trace is not covered.** Nothing here asserts that the exact
off-grid fraction the villain emitted in a live run entered the hero arm and
changed its villain-model read; that would need an instrumented
production-call-chain trace (record the fraction at the hero's
`facingVillainModel`/`chooseVillainModel` call site and correlate it with the
emitted villain amount). Recorded as a follow-up, not a claim.

---

## A4. Decision standard

Pre-register, before running: `seeds`, `H`, `R`, `mde`, `alpha`, the candidate
set, and the estimator (`cluster`).

A pair qualifies only if `comparePair().clean === true` (no abort / rejection /
bot error / ledger break / legality repair, cards replayed, memory complete).

Then, with the cluster bootstrap CI built at the **adjusted** confidence:

| verdict | rule |
|---|---|
| `invalid` | clean gate failed — no verdict |
| `better` | CI lower bound > 0 **and** `bb100 ≥ mde` |
| `real-but-small` | CI lower bound > 0 but below `mde` |
| `worse` | CI upper bound < 0 **and** `|bb100| ≥ mde` |
| `inconclusive` | otherwise |

`mde` default **5 bb/100** (the empirical signal floor; make it configurable).
The two gates are separate on purpose: `better` needs statistical *and*
practical significance. The MDE gate is **per-direction**: `better` uses
`bb100 ≥ +mde`, `worse` uses `bb100 ≤ −mde` (the `|bb100|` form written out, so
a negative estimate can never read as `better`). `verdictFor` gates on
`clean !== true`: `false` / `0` / any non-`true` value is `invalid` (omitting
the field defaults to `true`, i.e. clean), and it validates its inputs rather
than silently defaulting a missing CI to zero.

**Multiple comparisons.** Testing K switches inflates the family-wise error.
Default **Bonferroni**: build the CI at `confidence = 1 - α/K`
(`adjustAlpha`, `verdictFor({ comparisons: K })`). For a larger, exploratory
grid, use Benjamini–Hochberg FDR over bootstrap p-values instead (not
implemented). Keep the candidate set small and pre-registered — do not test all
2⁴ combinations at full power.

---

## Implemented (this change)

- `apps/server/test/helpers/evalStrategies.mjs` — **baseline isolation**:
  `defaultP2()` always takes the explicit all-off `P2_ALL_OFF` snapshot, never
  the shipped `DEFAULT_P2`. The product `DEFAULT_P2` is also all-off right now,
  but the harness does **not** rely on that coincidental equality (it treats the
  product default as an independent value that may change). `rules-v1` /
  `baseline` / `default` is therefore always the pre-P2 A/B control and every
  `p2:*` arm opens its switches from that all-off base — a product flip of
  `DEFAULT_P2` can no longer silently make the treatment identical to the control.
- `apps/server/test/helpers/evalDesign.mjs` — new, harness-only:
  - `normalQuantile`, `sampleSizeFor`, `mdeFor`
  - `requiredReplicas` (observed `replicaMeanSd`/`replicaMeanVar` mode, or pure
    `betweenSd` + `withinSd`/`H` mode — the two must not be mixed)
  - `autoBlockLength` (with `minBlockLength`), `blockBootstrapCI`,
    `clusterBootstrapCI` (equal-weight replica means; rejects incomplete
    replicas), `aggregateReplicaSamples` (reports `replicaMeanSd`,
    `replicaMeanVar`, `betweenSdPure`), `sampleSd`
  - `adjustAlpha`, `verdictFor` (per-direction MDE, `clean !== true` gate,
    input validation)
  - `OPPONENT_STYLES`, `NON_GRID_FRACTIONS`, `GRID_TOL`, `pickNonGridFraction`,
    `isOffGridFraction`, `NonGridSizerPolicy` (off-grid only when the actual
    emitted fraction is off-grid; per-street stats), `makeOpponentPolicy`
  - `runReplicatedComparison` (multi-seed), `runOpponentPoolComparison` (grid;
    forwards `params`, injectable `runReplica` for server-free tests)
- `apps/server/test/helpers/evalCompare.mjs` — **additive** `includeSamples` option:
  when true, `comparePair` also returns the raw per-hand `duplicate`/`plain`
  bb/100 samples. Default false; existing callers unchanged.
- `apps/server/test/helpers/evalMatch.mjs` — **additive** injection seam:
  `resolveStrategy` accepts a pre-built `Policy` object or a zero-arg factory
  (string names unchanged). Lets the design seat custom villains without
  registering them in the shared strategy registry.
- `apps/server/test/evalDesign.test.mjs` — 30 fast, server-free tests for the
  statistics + constructors (including the sizeGrid snap proof, unequal-length
  cluster weighting, and the observed-variance sample-size path), plus two
  `EVAL_DESIGN_SMOKE=1` real smokes (3 seeds × 20 hands, with an explicit
  treatment-contrast assertion so the A/B cannot silently collapse to the
  control; a 15-hand non-grid opponent asserted to emit off-grid sizings
  POSTFLOP).

## Designed but not implemented (follow-ups)

- Multi-way (6-max) tables and a configurable table size; only 3-handed exists.
- Maniac / nit as first-class named styles (currently `params` overrides).
- BH-FDR p-values for large exploratory grids.
- `σ_b` pilot automation and a report renderer for the pooled/block/cluster
  triple.
- A longer-horizon memory model than the 10-hand cutoff, if `σ_b` turns out to
  be mostly stale-memory drift.

## Suggested changes to the existing rig

- **`evalMatch`:** keep the object/factory `anchor` seam added here. Optionally
  promote it to an explicit `anchorPolicy` / `seatPolicyObjects` option if more
  lanes need it; today the duck-typed seam is enough.
- **`evalArms`:** add an optional `opponent` pass-through and per-seed loop so
  the arm comparison can be run replicated without going through
  `evalDesign`. Not done to avoid touching a shared driver.
- **`botEval.mjs`:** a `--replicas=` / `--mde=` flag that calls
  `runReplicatedComparison` would make the design the default report. Not done.
- **Do not** replace `bootstrapCI`; report it as `iid` alongside the new CIs.

## Not covered

- Rake / top-up / table-size effects beyond the fixed 3-handed config.
- End-to-end `sizeGrid` read trace: the smoke proves the villain *generated*
  off-grid postflop amounts and the unit test proves the hero read *branch*
  exists, but no test correlates a specific emitted villain amount with the
  hero's read of it inside a live run (see A3).
- Opponent adaptation to the arm is **modelled** — the villain is a dynamic
  responder to the pot/action line (see A3), not a fixed-size script. What is
  not covered is *learning across hands*: the villain has no long-run policy
  adaptation, and cross-hand drift enters only through the within-replica
  memory term, not a separate generative opponent model.
- Real-money/rake balance implications; the metric is bb/100 only.
- The ~200k-hand production run itself (resource work, out of scope here).

## Stage list (exact)

1. Land `evalDesign.mjs` + `evalDesign.test.mjs` + the two additive seams
   (this change).
2. **Pilot:** R = 20–30 seeds × H = 1 000, one arm, all opponent styles, to
   estimate `σ_b` / `σ_w` per style. Cheap relative to the verdict run.
3. From the pilot's observed `replicaMeanSd`
   (`requiredReplicas({ replicaMeanSd })`), pick R for the target MDE (table in
   A1); pre-register.
4. **Verdict run:** `runReplicatedComparison` per arm × style, cluster CI at
   Bonferroni-adjusted confidence, `verdictFor` with `mde = 5`.
5. Only if a switch clears `better` across the style pool, schedule the
   long-horizon confirmation (≤ 200k hands/arm for ≈ 1.5 bb/100).
