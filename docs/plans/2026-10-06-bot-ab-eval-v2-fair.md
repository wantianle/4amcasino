# Bot A/B Evaluation v2 — Fair Opponent Screen (P2 switches)

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
  (added `--opponent`/`--sizing`).
- Raw: `/tmp/bot-ab-v2/` — `combined_*.json`, `summary.json`,
  `union_*_alwayscall.json`, `v2only_call_*_95.json`, 100 chunk files + logs.
- Round-1 (unchanged): `docs/plans/2026-10-06-bot-ab-eval-results.md`,
  `docs/plans/2026-10-06-bot-eval-experiment-design.md`; raw `/tmp/bot-ab/`.
