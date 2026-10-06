# Bot A/B Evaluation — Real Results (p2:all / p2:shrinkage vs rules-v1)

**Date:** 2026-10-06
**Worktree:** `.slim/worktrees/eval-ab` (branch `omos/eval-ab`, base `88c7bbf`)
**Raw data:** `/tmp/bot-ab/` (per-replica JSON + `.replicas.jsonl`, combined JSONs)
**Scope:** harness/experiment only. **No product code touched**; no commit/add/push.

This is the execution of stage 2–4 of
`docs/plans/2026-10-06-bot-eval-experiment-design.md` (pilot → sample-size →
verdict). It uses the already-landed rig (`evalDesign.mjs`, `evalCompare.mjs`,
`evalMatch.mjs`, `evalStrategies.mjs`) via two new harness-only CLIs in
`apps/server/test/helpers/`:

- `evalAbRun.mjs` — run/report `runReplicatedComparison` for one arm vs a
  reference; index each replica to disk as it finishes.
- `evalAbCombine.mjs` — merge several run files (and/or `.replicas.jsonl`
  partials), dedupe by seed, and produce the replica-level aggregate
  (pooled / iid / block / cluster + variance components + `requiredReplicas` +
  `verdictFor`).

> **退役说明（2026-10-06）：** 上述两个一次性 A/B 工具（`evalAbRun.mjs` /
> `evalAbCombine.mjs`）已于 2026-10-06 退役删除；实验结论已固化在本报告，
> 下文命令仅作历史留档，不再可执行。

---

## 1. Reproduce

All commands run from the worktree root. `node --import tsx`.

```bash
# one arm, R replicas of H=50 (memory on, always-call anchor, duplicate seat-swap)
node --import tsx apps/server/test/helpers/evalAbRun.mjs \
  --arm=p2:all --ref=rules-v1 --seed-start=5000 --replicas=5 --hands=50 \
  --bootstrap-iters=10000 --out=/tmp/bot-ab/run.json

# merge many run files (dedupes by deal seed)
node --import tsx apps/server/test/helpers/evalAbCombine.mjs \
  --inputs=/tmp/bot-ab/run_a.json,/tmp/bot-ab/run_b.json \
  --min-block-length=10 --bootstrap-iters=10000 --out=/tmp/bot-ab/combined.json
```

Arms: `rules-v1` is the **explicit `P2_ALL_OFF`** control; the current product
`DEFAULT_P2` is **also all-off** (reverted after this eval), but the test still
passes the control explicitly so a future change to the product default cannot
silently pollute the contrast; `p2:all` opens all four P2 switches
(`shrinkage+sizeGrid+rangePropagation+buckets`); `p2:shrinkage` opens only the
opponent-shrinkage model. `adaptivePreflop` is off in every arm. Only the P2
config differs, so this is a clean treatment/control contrast.

Per replica = one deal seed = one duplicate pair (A@seat1/B@seat2 then
B@seat1/A@seat2, same cards), 3-handed with `always-call` anchor at seat 0,
`memory: true` (production strategy path), `sb/bb = 10/20`, `buyIn = 4000`.
Primary interval = **equal-weight cluster bootstrap over replica means**
(pre-registered), iid and moving-block reported alongside.

---

## 2. Pilot (σ_b / σ_w) — R = 20, H = 50, 1 000 paired hands

Arm `p2:all` vs `rules-v1`, seeds 5000–5019, all 20 replicas `clean = true`.

| quantity | value (bb/100) |
|---|---|
| pooled / replica mean | **−66.14** |
| iid CI95 | [−173.20, +17.45] |
| block CI95 (L = 10) | [−168.78, +13.41] |
| **cluster CI95 (R = 20)** | **[−165.80, +16.46]** |
| observed SD of replica means (`betweenSd`) | **213.24** |
| debiased pure between-seed SD (`betweenSdPure`) | **0.00** |
| pooled within-seed per-hand SD (`withinSd`) | **1 558.45** |

`verdictFor` → **inconclusive** (cluster CI contains 0).

**Reading.** At H = 50 the observed replica-mean dispersion is indistinguishable
from the within-seed term `σ_w/√H = 1558/√50 ≈ 220`; i.e. no between-seed
component is resolvable — `σ_b ≈ 0`. So the deal seed is *not* the dominant
variance source here; the per-hand action-outcome noise is. `σ_w ≈ 1560 bb/100`
(≈ 312 chips/hand at bb = 20, i.e. ~15.6 bb/hand) is the real constraint, not
deck choice.

Distribution is **heavy-tailed and sparse**: only **11.1 %** of hands have a
non-zero paired delta (89 % the two policies produce an identical result); the
rest are dominated by a few all-in hands. Per-replica means for the full
`p2:all` set range from **−713 to +566 bb/100** (quartiles −61 / −13 / +3).

---

## 3. Sample size for the target MDE (5 bb/100, Bonferroni)

`requiredReplicas({ replicaMeanSd })` (R at H = 50; observed mode, no
double-count) and `sampleSizeFor` (iid hands), 80 % power, two-sided α = 0.05:

| arm | target MDE | **required R @ H=50** | ≈ paired hands | iid-hands estimate |
|---|---:|---:|---:|---:|
| `p2:all` (R=100 pilot) | 5 | **9 534** | ~477 k | ~523 k |
| `p2:all` | 3 | 26 483 | ~1.32 M | ~1.45 M |
| `p2:all` | 1 | 238 345 | ~11.9 M | ~13.1 M |
| `p2:shrinkage` (R=50) | 5 | **6 101** | ~305 k | ~295 k |

Because `σ_b ≈ 0`, total hands ≈ (σ_w/Δ)²·z² and is essentially **independent
of H**: shrinking H buys more replicas per hand, not fewer hands. To hit
MDE = 5 for `p2:all` the run needs **~0.5 M paired hands** (≈ 1 M server hands
across both seatings). At the measured ~1.26 s/server-hand (≈ 334 CPU-hours at
this rig's per-hand cost), that is roughly **13 h wall at ~26-way parallelism**
on the 32-core host used here.

---

## 4. Formal verdict runs

| arm vs `rules-v1` | R | H | paired hands | replica mean | iid CI95 | block CI95 | **cluster CI95** | clean | verdict |
|---|---:|---:|---:|---:|---|---|---|---|---|
| **`p2:all`** | 100 | 50 | 5 000 | **−50.88** | [−86.99, −16.45] | [−86.43, −17.80] (L=17) | **[−85.76, −17.14]** | true | **worse** |
| `p2:shrinkage` | 50 | 50 | 2 500 | **−36.74** | [−74.84, +0.09] | [−75.54, −0.41] | **[−74.54, +0.75]** | true | inconclusive |

Variance / validity per arm:

| arm | `betweenSd` (obs) | `betweenSdPure` | `withinSd` | cluster SE | replica means <0 / =0 / >0 |
|---|---:|---:|---:|---:|---|
| `p2:all` | 174.26 | 0.00 | 1 290.70 | 17.4 | 68 / 4 / 28 |
| `p2:shrinkage` | 139.40 | 25.33 | 969.28 | 10.6 | 33 / 3 / 14 |

**Cost.** `p2:all` 100 replicas = 210 min replica-time (mean 126 s, range
68–272 s); `p2:shrinkage` 50 = 117 min (mean 140 s). The 130-replica verdict
batch ran as 26 parallel workers and finished in **~11 min wall**; the 20-seed
pilot (4 workers) took ~9.5 min wall.

---

## 5. Conclusion

1. **Direction & significance (`p2:all` vs `rules-v1`).** With R = 100
   (5 000 paired hands, all clean), `p2:all` is estimated **~51 bb/100 worse**
   than the all-off baseline. The cluster CI **[−85.8, −17.1]** excludes 0 and
   its upper bound is below −MDE, so under the pre-registered rule the verdict is
   **`worse`** (statistical *and* practical significance in the negative
   direction).
2. **Robustness of that sign.** The replica-mean distribution is skewed and
   heavy-tailed, so the *magnitude* is tail-driven: median replica delta is
   only **−12.8 bb/100** (p25 −61, p75 +3). The **sign** is robust though —
   68/100 replicas are negative (binomial p ≈ 4e-4) — so "all four P2 switches
   on is worse than all off, in this rig" is a defensible directional claim;
   "exactly −51 bb/100" is not precise. `betweenSdPure = 0` for this arm means
   the replica means behave like iid draws with no extra deck-level component.
3. **`p2:shrinkage`** trends the same way (−36.7 bb/100) but at R = 50 the
   **cluster** CI touches zero (`+0.75`); iid/block marginally exclude zero. It
   is **inconclusive**, not a positive result.
4. **The pre-registered MDE of 5 bb/100 is not reachable in this rig's
   budget.** It needs ~9 500 replicas / ~0.5 M paired hands for `p2:all`
   (~334 CPU-hours). The pilot/verdict runs here are therefore *not* powered at
   MDE = 5; they only detected the (much larger) observed effect.
5. **Why the variance is so large.** Only ~11 % of hands differ between the two
   arms; the difference is carried by rare, large all-in pots (per-replica mean
   SD ≈ 174 bb/100). bb/100 is a mean of a sparse, heavy-tailed variable — the
   duplicate seat-swap removes card luck but not action-outcome noise.

---

## 6. Limitations / not covered

- **One opponent context.** Seat 0 is `always-call` and the reference is the
  same `tight-aggressive` engine, so the result is the pre-registered but narrow
  3-handed screen, *not* the live opponent mix. The negative P2 result must not
  be generalised to production without the opponent-pool run (A3 in the design
  doc) and a larger R.
- **No multiple-comparison correction was actually needed for the two arms
  reported** (each was compared to the same reference on its own; the reported
  CIs use `comparisons = 1`). A single-family Bonferroni over K arms would widen
  them by ~√(K) in R terms — `p2:all` still clears zero, `p2:shrinkage` would
  not.
- **Heavy tails + percentile bootstrap.** With ~11 % nonzero and extreme
  outliers, the bootstrap CI is itself noisy; a trimmed/median-based sensitivity
  analysis is not included. The verdict rests on the sign test + cluster CI,
  which agree, but the point magnitude is fragile.
- **No end-to-end `sizeGrid` read trace**, no rake/table-size variation, no
  learning-across-hands villain (same caveats as the design doc).
- **`p2:rangePropagation` / `p2:buckets` individually** were not run; only
  `all` and the single `shrinkage` switch.
- The `requiredReplicas` figure uses the observed replica-mean SD as instructed
  (mode 1); with `betweenSdPure ≈ 0` it is close to the iid hand formula, so the
  two estimates agree in order of magnitude.

## 7. To actually finish the full formal evaluation

1. **Compute:** ~9 500 replicas (≈ 0.5 M paired hands, ≈ 334 CPU-h) for
   `p2:all` alone at MDE = 5; more for a Bonferroni family over several arms.
   At 26–32-way parallelism that is ~11–13 h wall.
2. **Pre-register** the arm set, R, H, MDE and the cluster estimator before
   running (design doc A4), and pick R from this pilot's `replicaMeanSd`.
3. **Opponent pool:** repeat per style (`tight-aggressive`, `loose-aggressive`,
   `calling-station`, `constrained-random`) with `nonGrid` villains so
   `sizeGrid` is observable; the current run uses only the `always-call` anchor.
4. **Robustness:** add a trimmed/median sensitivity and a sign test per arm, and
   report the paired cross-arm comparison (`p2:all` vs `p2:shrinkage`) on shared
   seeds — not just each vs baseline.
5. A report renderer/batching layer for the pooled/block/cluster triple (the
   design doc lists this as an unimplemented follow-up); the two CLIs here are a
   minimal substitute.

## 8. Files

- `apps/server/test/helpers/evalAbRun.mjs` — new, harness-only CLI driver.
  **已于 2026-10-06 退役删除。**
- `apps/server/test/helpers/evalAbCombine.mjs` — new, harness-only aggregator.
  **已于 2026-10-06 退役删除。**
- Raw results: `/tmp/bot-ab/` — `pilot_combined.json`, `formal_all_combined.json`,
  `formal_shrink_combined.json`, plus per-worker `*.json` and `*.replicas.jsonl`.
- No product code (`apps/web/**`, `apps/server/src/**`, `packages/**`) was
  modified; nothing was committed.
