# P2 arm factory + 配对对照（v3 返修版）

对应任务「实现 `p2:` arm factory + 配对对照」的第三轮返修。**本报告只作候选筛选，不是正式 A/B。**

修复的核心是一条被复审实测抓到的**手间 memory 更新时序竞争**：收手后 harness 未等两名 bot 写完 memory 记录就发下一手，而下一手 `hand_start` 会清空上一手的 `client.result`，导致 stderr 地漏记。A/A（两名字同为全关配置）此前会给出非零差异（复审实测 +8.042 bb/100）；修复后 A/A 逐手差异为 0。

## 1. 时序竞争修复（本轮阻断项）

**根因**：`BotRunner` 轮询 `client.result` 后才 `recordHandEnd()`（`botRunner.ts`）；harness 见 seat-0 anchor 结算即收数据并开下一手，可能赶在 bot 记录前；`client.ts` 的 `hand_start` 会 `this.result = null` 清掉上一手。

**修法（纯 harness 层，未动 `apps/server/src/**`）**：`evalMatch.mjs` 在 memory-on 路径给每个 bot client 的 `result` 属性装访问器。只有**调用栈含 `recordHandEnd`** 的那次读取才被认作"记录即将发生"——其它读取（`myTurn` / `waitForTurn`）栈里没有 `recordHandEnd`，因此不会被误判。`recordHandEnd` 与其后的 `observeHand` 是同一同步段，故访问器里 `queueMicrotask` 的标记必然发生在记录完成之后。harness 在每手数据收集完、发下一手之前 `await` **所有 bot 均已观察到该 handId 的结算记录**（微任务级确认，非 sleep；超时则显式抛错，不会静默）。该屏障**仅 memory-on**：memory-off 不包装 client、不等待，legacy 时序完全不变。

**A/A 回归实测**（`comparePair('rules-v1','default',{hands:60,seed:1234,memory:true})`，两名字解析为同一全关配置）：

```
duplicate bb/100 0   sd 0   CI95 [0,0]
clean true  cardsReplayed true  handIdsMatch true  fpComplete true
run0: seat1 maxHandsObserved=59 withStats=135/136 | seat2 maxHandsObserved=59 withStats=153/157
run1: seat1 maxHandsObserved=59 withStats=135/136 | seat2 maxHandsObserved=59 withStats=153/157
seatActions run0 vs run1 equal: true
```

即：duplicate delta **逐手为 0**、两次 seating 的 seat 动作流完全一致、每个 bot seat 的 `maxHandsObserved` 达到 `hands-1`（**无中间手漏记**）。`memComplete=true`。（seat 0 是 harness 驱动的 anchor，其决策视图不带 session memory，故门禁只覆盖 memory 注入的 bot seat。）

## 2. 实验有效性门禁（helper 层）

原先 `clean` 只查运行错误：空实验 `runArmComparison({arms:['rules-v1']})` 会 `pairs:[]` 且 `allClean:true`，`runDigestIsClean({hands:0,...,cardsFingerprintComplete:false})` 也返回 true。现改为：

- `runDigestIsClean(run)`：除运行状态（abort/rejected/botErrors/ledger/legality）外，还要求 `hands > 0`、`hands === requestedHands`、`cardsFingerprintComplete === true`；
- `runMemoryComplete(run)`：memory-on 时，每个 memory 注入的 bot seat 的 `maxHandsObserved >= hands-1`（memory-off 恒真）；
- `comparePair(...).clean`：两 run 均过 `runDigestIsClean` + `runMemoryComplete`，且 `cardsReplayed`、`handIdsMatch`、`fingerprintsComplete`、`usable>0`、`dup.n>0`；
- `runArmComparison(...).allClean`：`pairs.length > 0 && every(p.clean)`；
- CLI 增加 `experiment non-empty` 与 `all pairs valid` 两条聚合检查。

负向测试覆盖：空 pairs、`hands:0`、指纹不完整、请求手数未达成、memory 漏记中间手，全部 not clean。

## 3. 摘要归因与措辞修正

- **可保留**：memory 数据路径已接通；`shrinkage` 的统计估计分支具备输入。
- **已撤回**："这些动作差异由 shrinkage 引起、因此已证明行为可观测"的归因——在时序竞争下 A/A 已出现同类差异，动作差异不能归因于开关。修复时序后重新取得的证据见下。
- **措辞**：从"CI 跨 0，属噪声级"改为**"证据不足，无法判定方向"**（跨零不证明效果只是噪声）。

修复时序后补充的确定性证据：

1. **A/A 零差异**：见 §1（60 手，duplicate delta 0 / sd 0）。
2. **同一完整 `DecisionView`、同 seed 下 shrinkage 开关翻转动作**（单测，非端到端）：LAG 对手 20 手样本（vpip 14 / pfr 10 / postflopBetsRaises 18 / calls 6），flop `[9,13,22]`、hero `[2,14]`、pot 40 / call 20 的 AGG 节点：
   - `rules-v1` → `call`；`p2:shrinkage` → `fold`；`p2:all` → `fold`。
   仅 `shrinkage` 不同、同一 view、同一策略 seed。
3. **可重复的端到端结果**：见 §4（同 seed/手数重跑同序）。

## 4. 短冒烟（memory 开、含屏障）

```bash
ARMS=rules-v1,p2:shrinkage,p2:all HANDS=60 SEED=1234 \
  node --import tsx apps/server/test/botEval.mjs
```

60 手 × 每对 2 局 × 2 对，seed=1234，memory=true，anchor=always-call，耗时 295.7s。

| arm | p2 config | hands | bb/100 vs ref | CI95 | CI width | 方向 | clean | fold | call | bet+raise | legalityFall/ill | memSeen(withStats) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| p2:shrinkage | shrinkage | 60 | 43.958 | [-10.125, 108.958] | 119.083 | p2:shrinkage > rules-v1 | true | 22.0% | 2.1% | 27.2% | 0/0 | 285/290 |
| p2:all | 四开关全开 | 60 | -5.458 | [-44.375, 28] | 72.375 | rules-v1 > p2:all | true | 22.2% | 1.7% | 27.7% | 0/0 | 288/293 |

参考臂 `rules-v1` 汇总：fold 22.41% / call 1.90% / check 49.83% / bet 16.38% / raise 9.48% / bet+raise 25.86%；legalityFall/ill 0/0；memSeen 570/580；每 seat `maxHandsObserved=59`。

- **全部检查 PASS**，`allClean=true`。
- `p2:shrinkage` 与同对参考的动作分布已不同（fold 64 vs 65、check 142 vs 143、bet 50 vs 47、raise 29 vs 28），memory 已完整注入（withStats 285/290）。但 bb/100 的 **CI95 跨 0（[-10.125,108.958]，width 119）→ 证据不足，无法判定方向**，不是收益结论。
- `p2:all` 同样 CI 跨 0（[-44.375,28]）→ 证据不足。
- 60 手尺度 CI 极宽，此 rig 只作候选筛选。

## 5. 回归测试

`apps/server/test/evalInfra.test.mjs`（共 **34** 项，全部通过）：

- arm factory 解析（含顺序无关/多段/幂等、未知 arm 报错）、默认臂与出厂 `RulePolicy` 逐输入等价、全臂合法；
- shrinkage 数据路径纯函数、**同 view 动作翻转样本**、memory 端到端可见性；
- 配对估计器 `pairedDelta` 与 bootstrap 均值；
- **实验门禁负向测试**（空 pairs、hands:0、指纹缺失、请求手数不足、memory 漏记）；
- **memory-on A/A 等价**（30 手：duplicate delta 0 / sd 0、两 seating 动作流一致、bot seat `maxHandsObserved >= hands-1`）。

## 6. 已知限制与后续（本轮未做）

1. **统计限制**：memory 开启后手与手有状态依赖，iid percentile bootstrap 不足；正式结论需多 seed / 独立 replica / block bootstrap、预先规定样本量与停止规则。
2. **rig 规模**：三人桌（seat0 `always-call` anchor + 两臂），非完整对手池；`sizeGrid` 在当前 rig 基本不可观测（规则策略尺寸多在既有网格上、anchor 只 call/check，可供重分档的非网格 villain 尺寸很少）。
3. **arm 注入面**：只能注入 P2 postflop 开关 + `adaptivePreflop`，参数固定 `tight-aggressive`。
4. `legalityFallbacks` / `legalityIllegalDecisions` 只统计外层 `ensureLegal` 替换，不含 `RulePolicy` 内部 `safeFallback`；`evalStrategies.mjs` 的 equity baseline 缺 hole cards 路径也进同一 fallback sink，文案未细分（后续独立计数）。
5. 未做正式 A/B（≥20 万手/臂）。

## 7. 复现

见 `apps/server/test/botEval.mjs` arm 模式；报告由脚本自动渲染，原始 JSON 未随本摘要提交，可用 §4 命令复现。
