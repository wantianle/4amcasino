# Bot A/B Evaluation v2 — Fair Opponent Screen (P2 switches)

> **合并说明（2026-10-08）**：原独立的实验设计文档已并入本文，作为文末附录
>「实验设计方法论」。Round 1 报告 `2026-10-06-bot-ab-eval-results.md` 保留独立
>（`postflopP2.ts` 代码注释引用它）。

**Date:** 2026-10-06
**Worktree:** `.slim/worktrees/eval-ab-v2` (branch `omos/eval-ab-v2`, base `f05ac56` = latest `main`)
**Raw data:** `/tmp/bot-ab-v2/` (per-chunk JSON + `.replicas.jsonl`, per-cell `combined_*.json`, `summary.json`, unions)
**Scope:** harness/experiment only. **No product code touched; `DEFAULT_P2` untouched; nothing committed.**

---

## 0. Why this redo

Round 1 (`docs/plans/2026-10-06-bot-ab-eval-results.md`) ran `p2:all` vs `rules-v1`
with seat 0 = **`always-call`** and concluded `p2:all` was **worse**. But all four
P2 switches are premised on an opponent with a *readable tendency*:

- `shrinkage` — Beta-shrunk VPIP/PFR/aggression posterior;
- `rangePropagation` — tightens/widens the range read along the preflop line;
- `buckets` — 24-bucket strength tilt of the villain range;
- `sizeGrid` — snaps an opponent's bet size to a grid before reading it.

An `always-call` opponent makes no fold/raise decisions, has almost no VPIP/PFR
signal, and never picks a size, so the previous rig evaluated P2 **precisely in
the regime where its inputs are constant**. That experiment therefore cannot say
whether P2 helps; it can only say "all-on is worse against a never-adapting
caller". This v2 screen re-runs the same harness with **opponents that carry real
tendencies**.

---

## 1. Experiment design

### Opponents (seat 0), all shipped `RulePolicy` presets via `makeOpponentPolicy`

| label | preset | character |
|---|---|---|
| `call` | legacy `always-call` anchor | **control** reproducing round-1's context; cannot size/raise |
| `tag` | `tight-aggressive` | tight opening, value-oriented, 3-bets |
| `station` | `calling-station` | loose call, `bluffScale=0.1`, `threeBetScale=0.35`, no overbet |
| `lag` | `loose-aggressive` | wide, bluff-heavy (`bluffScale=1.6`, overbet 0.35) |

The three rule-bot opponents run with **`sizeGrid`'s prerequisite sizing: `nonGrid`**
(`NonGridSizerPolicy`, off-grid pot fractions proved to be emitted postflop by the
harness smoke in `evalDesign.mjs`). Against a grid-sizing rule bot the hero-side
`sizeGrid` is a structural no-op, and against `always-call` there is no size at
all — so `nonGrid` is the *only* cell in which the `sizeGrid` switch can express
itself. All four arms in a given opponent cell face the same villain
configuration, so the switch contrast stays clean.

### Arms (seated at seats 1/2, seat-swapped duplicate pair)

Reference = `rules-v1` = explicit `P2_ALL_OFF` (all four switches off). Treatment
arms each open **one** switch (or all four) from that same all-off base:

`p2:shrinkage` · `p2:sizeGrid` · `p2:rangePropagation` · `p2:buckets` · `p2:all`

`adaptivePreflop` is off in every arm/reference. Only the P2 config differs.

### Sampling

- **H = 50** hands per match; one replica = one deal seed = one duplicate pair
  (A@1/B@2 then B@1/A@2, identical cards), `memory: true` (production path),
  `sb/bb = 10/20`, `buyIn = 4000`.
- **R = 50 replicas per (arm × opponent) cell** → 20 cells, **1 000 replicas**,
  **50 000 paired hands** (100 000 server hands).
- Seeds are **disjoint blocks** per (opponent, arm, chunk) so no deck is reused
  across arms. Consequence: cross-arm additivity checks are *not* paired and are
  not claimed.
- Primary interval = **equal-weight cluster bootstrap over replica means**
  (`clusterBootstrapCI`), built at the **Bonferroni-adjusted** confidence
  `1 − 0.05/5 = 0.99` (K = 5 arms per opponent family). `verdictFor` therefore
  reports stats/practical significance against that 99 % CI.
- `iid` and moving-block (`block`, min length 10) CIs are reported alongside; the
  `cluster` interval is the verdict interval.

### MDE this screen can actually detect

With `cluster SE = betweenSd / √R` and 80 % power at adjusted α = 0.01, the
detectable effect at R = 50 is `3.417 · betweenSd / √50` (≈ **35–110 bb/100**
across cells; per-cell table in §3). **This is a direction screen, not a powered
test.** Every "inconclusive" below means *not measured at this R*, **not**
"ineffective".

### Decision rule (pre-existing, `verdictFor`)

`better`: CI_lo > 0 **and** mean ≥ +5 · `worse`: CI_hi < 0 **and** mean ≤ −5 ·
`real-but-small`: CI_lo > 0 below MDE · `invalid`: clean gate failed ·
`inconclusive`: otherwise.

---

## 2. Reproduce (real commands, real output)

All from the worktree root, `node --import tsx`.

One chunk of 10 replicas (example: TAG, all-on):

```bash
node --import tsx apps/server/test/helpers/evalAbRun.mjs \
  --arm=p2:all --ref=rules-v1 --opponent=tight-aggressive --sizing=nonGrid \
  --seed-start=44000 --replicas=10 --hands=50 \
  --bootstrap-iters=10000 --comparisons=5 \
  --out=/tmp/bot-ab-v2/tag_all_c0.json
```

Seed blocks: opponent base `call=0`, `tag=100000`, `station=200000`,
`lag=300000`; arm base `shrinkage=0`, `sizeGrid=10000`, `rangePropagation=20000`,
`buckets=30000`, `all=40000`; chunk `c ∈ {0..4}` adds `c·1000`, 10 replicas.
The `always-call` cell omits `--opponent` (legacy anchor).

Combine the 5 chunks of a cell (this is the reported estimator):

```bash
node --import tsx apps/server/test/helpers/evalAbCombine.mjs \
  --inputs=/tmp/bot-ab-v2/tag_all_c0.json,/tmp/bot-ab-v2/tag_all_c1.json,/tmp/bot-ab-v2/tag_all_c2.json,/tmp/bot-ab-v2/tag_all_c3.json,/tmp/bot-ab-v2/tag_all_c4.json \
  --comparisons=5 --min-block-length=10 --bootstrap-iters=10000 \
  --out=/tmp/bot-ab-v2/combined_tag_all.json
```

Batch drivers (harness-only, `/tmp`): `run_screen.sh`, `combine_all.sh`,
`summary.mjs`, `filtercombine.mjs`. All 100 chunk jobs exited `rc=0`; all 20
cells combined `rc=0`.

> **退役说明（2026-10-06）：** 上文的一次性 A/B 工具（`evalAbRun.mjs` /
> `evalAbCombine.mjs`）已于 2026-10-06 退役删除；实验结论已固化在本报告，
> 以上复现命令仅作历史留档，不再可执行。

**Harness change (additive, harness-only):** `evalAbRun.mjs` gained
`--opponent=<style>` / `--sizing=grid|nonGrid` pass-through to the already-existing
`runReplicatedComparison(..., { opponent })` path in `evalDesign.mjs`, and echoes
`opponent`/`opponentSizing` into the run JSON. No product file changed.

---

## 3. Results

Cluster CI is the **99 % Bonferroni** interval; verdicts use it. `neg/zero/pos`
counts are strict replica-mean signs (R = 50 each). All cells `allClean = true`
except where noted.

### 3.1 `always-call` (control)

| arm | replica mean bb/100 | cluster CI99 | verdict | neg/zero/pos |
|---|---:|---|---|---|
| shrinkage | −70.9 | [−157.1, +9.1] | inconclusive | 34/4/12 |
| sizeGrid | **0.0** (withinSd 0) | [0.0, 0.0] | inconclusive | 0/50/0 |
| rangePropagation | +6.7 | [−21.8, +32.2] | inconclusive | 10/30/10 |
| buckets | +3.8 | [−35.4, +41.1] | inconclusive | 5/28/17 |
| all | +11.8 | [−34.4, +66.7] | inconclusive | 21/4/25 |

### 3.2 `TAG` (tight-aggressive, nonGrid)

| arm | replica mean bb/100 | cluster CI99 | verdict | neg/zero/pos |
|---|---:|---|---|---|
| shrinkage | −13.3 | [−44.7, +15.0] | inconclusive | 27/19/4 |
| sizeGrid | +3.1 | [−2.8, +11.8] | **invalid** † | 1/46/3 |
| rangePropagation | **−43.7** | **[−88.8, −9.4]** | **worse** | 25/20/5 |
| buckets | +6.6 | [−23.5, +33.3] | inconclusive | 12/14/24 |
| all | +14.7 | [−25.1, +55.3] | inconclusive | 18/5/27 |

† `invalid` because **1 of 50** replicas (seed 113007) failed the harness
memory-completeness gate: seat 2 observed 48 settled hands instead of 49 in both
seatings — a single missed *observation* of an already-recorded hand, with
`aborts=0, rejected=0, botErrors=0, ledgerOk=true, legality repairs=0, cards
replayed=true`. Re-aggregating the **49 clean replicas** gives mean **+3.12**,
cluster CI99 **[−2.82, +12.14]**, verdict **inconclusive** (`filtercombine.mjs`).
The invalidity does not change the reading: `sizeGrid` is indistinguishable
from 0 here (and the gate over-strictly equates "the bot made no decision after
the last settlement" with "a memory record was dropped").

### 3.3 `station` (calling-station, nonGrid)

| arm | replica mean bb/100 | cluster CI99 | verdict | neg/zero/pos |
|---|---:|---|---|---|
| shrinkage | **−32.0** | **[−64.8, −6.8]** | **worse** | 22/21/7 |
| sizeGrid | **0.0** (withinSd 0) | [0.0, 0.0] | inconclusive | 0/50/0 |
| rangePropagation | **−55.3** | **[−119.5, −13.1]** | **worse** | 20/27/3 |
| buckets | +20.1 | [−38.0, +88.5] | inconclusive | 16/15/19 |
| all | +12.4 | [−36.6, +61.4] | inconclusive | 16/9/25 |

### 3.4 `LAG` (loose-aggressive, nonGrid)

| arm | replica mean bb/100 | cluster CI99 | verdict | neg/zero/pos |
|---|---:|---|---|---|
| shrinkage | +2.5 | [−22.5, +35.2] | inconclusive | 14/25/11 |
| sizeGrid | −0.2 | [−0.6, 0.0] | inconclusive | 2/48/0 |
| rangePropagation | −21.5 | [−89.5, +27.5] | inconclusive | 14/27/9 |
| buckets | +4.5 | [−37.6, +47.9] | inconclusive | 22/7/21 |
| all | +19.5 | [−42.8, +84.5] | inconclusive | 21/6/23 |

### 3.5 MDE actually available at R = 50 (adjusted α = 0.01, power 0.8)

| opponent | arm | betweenSd | MDE bb/100 @R=50 | R needed for MDE=5 |
|---|---|---:|---:|---:|
| call | shrinkage | 226.6 | 109.5 | 23 990 |
| call | sizeGrid | 0.0 | — | — |
| call | rangePropagation | 72.6 | 35.1 | 2 463 |
| call | buckets | 108.3 | 52.4 | 5 484 |
| call | all | 141.2 | 68.2 | 9 316 |
| tag | shrinkage | 79.7 | 38.5 | 2 971 |
| tag | sizeGrid | 20.5 | 9.9 | 197 |
| tag | rangePropagation | 110.0 | 53.2 | 5 656 |
| tag | buckets | 76.0 | 36.7 | 2 696 |
| tag | all | 112.4 | 54.3 | 5 907 |
| station | shrinkage | 81.4 | 39.3 | 3 094 |
| station | rangePropagation | 158.9 | 76.8 | 11 801 |
| station | buckets | 178.6 | 86.3 | 14 907 |
| station | all | 136.4 | 65.9 | 8 698 |
| lag | shrinkage | 78.8 | 38.1 | 2 903 |
| lag | rangePropagation | 157.6 | 76.2 | 11 607 |
| lag | buckets | 116.0 | 56.1 | 6 284 |
| lag | all | 171.8 | 83.0 | 13 791 |

`betweenSdPure` was ≈ 0 for several cells (mean replica dispersion ≈ the
within-seed term `σ_w/√50`), so more *replicas*, not more hands per replica, is
the way to buy power — the same economics round 1 reported.

---

## 4. Cross-opponent direction contrast (the round-1 question)

Replica-mean direction, same rig, only the opponent differs:

| arm | always-call | TAG | station | LAG | sign flips vs always-call |
|---|---:|---:|---:|---:|---|
| shrinkage | −70.9 | −13.3 | −32.0 | **+2.5** | LAG |
| sizeGrid | 0.0 | +3.1 | 0.0 | −0.2 | TAG, LAG |
| rangePropagation | **+6.7** | **−43.7** | **−55.3** | **−21.5** | TAG, station, LAG |
| buckets | +3.8 | +6.6 | +20.1 | +4.5 | none |
| all | +11.8 | +14.7 | +12.4 | +19.5 | none |

The clearest scenario dependence is **`rangePropagation`**: slightly *positive*
against a never-folding caller (+6.7, inconclusive) but *negative and
Bonferroni-significant* against both reading opponents (TAG −43.7, station
−55.3). `shrinkage` also flips: strongly negative vs `always-call`, negative vs
TAG/station, positive vs LAG. So **the round-1 conclusion is partly a
consequence of the opponent**, exactly as suspected: a switch can be neutral or
harmful against a tendency-less caller and behave differently once the opponent
has a readable line/size.

---

## 5. Round-1 (`always-call`) vs v2 — and a robustness finding

Round 1 and v2 share the harness and a behaviourally identical P2 engine
(between base `88c7bbf` and `f05ac56` the only `agent-core` deltas are a *comment
update*, the `DEFAULT_P2` flip — which the harness overrides with explicit
`P2_ALL_OFF` — and removal of an **unused** `foldToBet` prior; verified by
`git diff`). Round 1 used always-call, seeds 5000–5099, R = 100, 95 % CIs.

| run | arm | opponent | seeds | R | replica mean | cluster CI | verdict |
|---|---|---|---:|---:|---:|---|---|
| round 1 | p2:all | always-call | 5000–5099 | 100 | −50.88 | [−85.76, −17.14] (95 %) | worse |
| v2 | p2:all | always-call | 0–44999 | 50 | +11.77 | [−24.19, +52.48] (95 %) | inconclusive |
| **union** | p2:all | always-call | 80 recoverable old + 50 new | **130** | **−24.43** | **[−50.85, +2.60]** (95 %) | **inconclusive** |
| round 1 | p2:shrinkage | always-call | 5000–5049 | 50 | −36.74 | [−74.53, +0.74] (95 %) | inconclusive |
| v2 | p2:shrinkage | always-call | 0–4999 | 50 | −70.87 | [−134.64, −11.03] (95 %) | worse |
| **union** | p2:shrinkage | always-call | old 50 + new 50 | **100** | **−53.81** | **[−91.21, −18.27]** (95 %) | **worse** |

**Finding:** the round-1 `p2:all` “worse” verdict is **not reproduced** on a fresh
seed set. Pooling every always-call `p2:all` replica available (R = 130) gives
−24.4 with a 95 % CI that **contains 0**: at this R the effect is *not
measurable*. Round 1's tighter R = 100 interval excluded 0, but 50 fresh seeds
move the point estimate by ~62 bb/100, so that interval was not robust to
resampling the seed set. By contrast `p2:shrinkage` vs always-call **is**
reproduced and robust: worse at R = 100 (union CI [−91.2, −18.3]).

This does not overturn round 1; it bounds it: the all-on/most switches signal
against a tendency-less caller is **small and seed-fragile**, and the only
opponent in which it looked robust (`shrinkage`) is also negative elsewhere.

---

## 6. Conclusions (scoped to this screen)

1. **Positive hints worth a bigger sample.** `buckets` is the only switch with a
   positive replica-mean in **all four** opponent contexts (+3.8 / +6.6 / +20.1 /
   +4.5 bb/100) and no negative cell — but every CI contains 0, so at R = 50 it
   is **directionally favourable and unmeasured**. `p2:all` is likewise positive
   in all four cells (+11.8 / +14.7 / +12.4 / +19.5), again all inconclusive.
   These are the two candidates to power up first; neither is a result yet.
2. **Negative hints.** `rangePropagation` is **worse** at Bonferroni 99 % vs TAG
   and station (and directionally negative vs LAG); `shrinkage` is **worse** vs
   station (99 %) and vs always-call (95 % and union-R100), negative-but-unmeasured
   vs TAG. Under this rig these two have never shown a positive cell.
3. **Not measurable at R = 50.** `sizeGrid` is ≈ 0 vs every opponent that bets
   (TAG +3.1, LAG −0.2) and *exactly* 0 vs the two non-betting/rarely-betting
   opponents (`always-call`, station: `withinSd = 0`, i.e. not one hand differed).
   The one `invalid` cell is a 1/50 memory-gate artifact and clears to
   `inconclusive` on its 49 clean replicas. `buckets` and `p2:all` are positive
   but unmeasured. **All of these are "inconclusive", which means the sample
   cannot resolve them — not that the switch is ineffective.** The MDE table
   (§3.5) shows each would need roughly 3 k–15 k replicas for MDE = 5.
4. **Scenario dependence is real.** `rangePropagation` (+6.7 vs call → −55.3 vs
   station) and `shrinkage` (+2.5 vs LAG → −70.9 vs call) change sign with the
   opponent. This directly answers the round-1 concern: **yes, the opponent
   context materially changes the measured direction**, so the previous
   always-call-only experiment was not a fair test of the switches.
5. **No default should move on this evidence.** Per the standing rule, nothing
   here justifies changing `DEFAULT_P2` (left all-off, untouched) in either
   direction.

---

## 7. Boundaries / limitations

- **Synthetic opponents only.** These are shipped `RulePolicy` presets, not
  humans. Nothing here generalises to live players, to 6-max, to rake, or to
  longer-horizon adaptation. The rule bots do not learn across hands.
- **`nonGrid` rule bots** were used so `sizeGrid` is observable at all; that is
  a slightly stylised villain (off-grid pot fractions). `sizeGrid`'s near-zero
  result is conditional on that construction and on the pre-existing harness
  smoke that the villain really emits off-grid postflop amounts.
- **Unpaired across arms.** Disjoint seed blocks mean cross-arm statements
  ("`all` ≈ sum of switches") are not supported; only each arm vs `rules-v1`
  within a cell is paired.
- **Heavy tails.** `bb/100` is a sparse, heavy-tailed mean; the cluster CI is
  itself noisy at R = 50. Signs are more stable than magnitudes.
- **One `invalid` replica** (memory gate, detailed in §3.2); every other cell
  50/50 clean.
- Round-1 raw data in `/tmp/bot-ab/` retains only 80 of its 100 always-call
  replicas, so the union is R = 130, not R = 150.

---

## 8. Cost record (real)

- 20 cells × R = 50 = **1 000 replicas** = 50 000 paired hands = 100 000 server hands.
- Per-replica wall under contention: **~90–230 s** (mean ≈ 110 s); reported
  replica-time summed to **109 821 s ≈ 30.5 h**.
- Executed as 100 chunk jobs (`R=10` each) at **26-way parallelism** on a
  32-core / 62 GB host, plus 2 single-replica probes and one diagnostic rerun.
- Wall: probes 21:06–21:10; batch **21:10 → 22:25 ≈ 75 min**; combine/summary ~1 min.

## 9. Exact stage list

1. `git worktree add .slim/worktrees/eval-ab-v2 -b omos/eval-ab-v2 main`; symlink
   `node_modules` (root + workspace packages).
2. Add `--opponent` / `--sizing` pass-through + JSON echo to `evalAbRun.mjs`
   (harness-only, additive). Verify with 1-replica probes: TAG, station.
3. 20 cells × 5 chunks × 10 replicas, `H=50`, `memory:true`, `comparisons=5`,
   seeds per §2; 26-way parallel (`run_screen.sh`).
4. `evalAbCombine` per cell over the 5 chunks → `combined_<opp>_<arm>.json`.
5. `summary.mjs` → per-cell table + MDE + direction contrast; diagnose the single
   `invalid` replica (`diag3.mjs`) and re-aggregate its 49 clean replicas
   (`filtercombine.mjs`).
6. Union always-call old+new seeds → robustness check on round 1.
7. This report. **No commit / add / push; no product file changed.**

## 10. Files

- New report: `docs/plans/2026-10-06-bot-ab-eval-v2-fair.md` (this file).
- Harness (uncommitted, in worktree): `apps/server/test/helpers/evalAbRun.mjs`
  (added `--opponent`/`--sizing`). **已于 2026-10-06 退役删除**（结论已固化在本
  报告，不再可执行）。
- Raw: `/tmp/bot-ab-v2/` — `combined_*.json`, `summary.json`,
  `union_*_alwayscall.json`, `v2only_call_*_95.json`, 100 chunk files + logs.
- Round-1 (unchanged): `docs/plans/2026-10-06-bot-ab-eval-results.md`; raw `/tmp/bot-ab/`.
- Experiment design methodology: 现并入本文附录（原独立设计文档已删除）。

---

## 附：实验设计方法论（并入自原独立实验设计文档）

> 原独立设计文档全文并入本节，内容未改，仅标题层级下移一级、原 H1 标题去掉。
> Round 1 引用本方法论见 `docs/plans/2026-10-06-bot-ab-eval-results.md`。


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

### 0. Why the current screen is only a screen

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

### A1. Replica / seed structure

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

### A2. Block bootstrap

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

### A3. Opponent pool

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

### A4. Decision standard

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

### Implemented (this change)

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

### Designed but not implemented (follow-ups)

- Multi-way (6-max) tables and a configurable table size; only 3-handed exists.
- Maniac / nit as first-class named styles (currently `params` overrides).
- BH-FDR p-values for large exploratory grids.
- `σ_b` pilot automation and a report renderer for the pooled/block/cluster
  triple.
- A longer-horizon memory model than the 10-hand cutoff, if `σ_b` turns out to
  be mostly stale-memory drift.

### Suggested changes to the existing rig

- **`evalMatch`:** keep the object/factory `anchor` seam added here. Optionally
  promote it to an explicit `anchorPolicy` / `seatPolicyObjects` option if more
  lanes need it; today the duck-typed seam is enough.
- **`evalArms`:** add an optional `opponent` pass-through and per-seed loop so
  the arm comparison can be run replicated without going through
  `evalDesign`. Not done to avoid touching a shared driver.
- **`botEval.mjs`:** a `--replicas=` / `--mde=` flag that calls
  `runReplicatedComparison` would make the design the default report. Not done.
- **Do not** replace `bootstrapCI`; report it as `iid` alongside the new CIs.

### Not covered

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

### Stage list (exact)

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
