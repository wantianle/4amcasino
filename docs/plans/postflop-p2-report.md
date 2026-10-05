# 策略 P2 实现报告（范围传播 / 收缩估计 / 尺寸网格 / 24 桶）— 三轮返修版

状态：已实现、已自测、**已 commit**（P2 主体 `6828fb3`，翻前第三步同批的 P2 债务清理 `c4fb6d2` / `2b3e2e7`）。基线 HEAD `c1dcf0d`（P2 基线为 `f4a5904`）。
改动文件（stage 清单，5 文件：4 个代码/测试 + 本报告）：

1. `packages/agent-core/src/sessionMemory.ts`（收缩估计；一轮已交付，后续轮未再改）
2. `packages/agent-core/src/postflopPolicy.ts`（P2 引擎 + 二轮 P0-1/P0-2 + 三轮 P0 rank-source / made-straight 修复）
3. `packages/agent-core/test/postflopPolicyP2.test.ts`（P2 用例 + P0/P1/P2 修复用例）
4. `packages/agent-core/test/fixtures/postflopPolicyBaseline.ts`（差分基线；二轮新增，后续轮未再改）
5. 本报告 `docs/plans/postflop-p2-report.md`（文档）

> 核心决策：**P2 的四个行为开关默认全部关闭**（`shrinkage` / `sizeGrid` /
> `rangePropagation` / `buckets` 均 `false`）。实现与测试保留、可注入可开启；默认
> `Configuration` 与基线 `f4a5904` 的 P0/P1 决策**在差分网格覆盖的输入上逐输入一致**（见 §3）。
> 唯一的 P0 差异是 `evaluateHand` 的 `straightDraw` 有意修复（rank 来源判定 + made-straight
> 语义，见 §1.1 的 scope 说明）。理由：oracle 判定默认开启会改变所有 bot 决策但无 A/B 证据，
> 本项目偏好最小可逆增量。

---

## 0. 总览

四项能力共用一组开关 `P2Options`（`postflopPolicy.ts`），每项独立可注入/可关闭：

| 能力 | 关键 API | 默认 | 状态 |
| --- | --- | --- | --- |
| #2 收缩估计 | `sessionMemory.shrinkRate / shrinkConfidence / estimateOpponent / OPPONENT_PRIORS` | **关** | 输入契约补全 + 测试 |
| #3 尺寸网格 + 最近邻 | `POSTFLOP_SIZE_GRID / snapBetFraction / gridFraction` | **关** | 中点语义断言 + 说明 |
| #4 24 牌力桶 | `MADE_BUCKETS × DRAW_BUCKETS / handBucket / bucketStrength / bucketAdvantage` | **关** | 语义断言补全；`bucketAdvantage` 标实验 API |
| #1 范围传播 | `preflopRaiseCount / propagateVillainModel` | **关** | `historyComplete` 契约修复 |

`Policy.decide(view)` 契约不变；`RulePolicy` 仍经 `PostflopPolicy`，无需改 `rulePolicy.ts`。

```ts
export const DEFAULT_P2: Readonly<P2Options> = Object.freeze({
  shrinkage: false, sizeGrid: false, rangePropagation: false, buckets: false,
});
```

默认关闭时，`facingVillainModel` 不调用传播、`opponentModelStats` 走旧 `sampleHands < 10`
路径、`buildVillainRange` 跳过桶加权、`chooseVillainModel` 用原始连续尺寸分档——即
基线的 P0/P1 行为。`Object.freeze` 使"默认全关"成为**运行时不可变**的保证（§1.2）。

---

## 1. 二轮 / 三轮复审必修项

### 1.1 P0（三轮）`straightOuts()` 的 rank 来源判定 + made-straight 语义

**问题 1（rank 来源）**：二轮把「顺子窗口含 hero rank」当作 hero 贡献，但没判断该 rank 是否
**已由公面提供**。`hole = As 2d`、`board = Ah Qc Jd Tc`，补 `K` 成 `A-K-Q-J-T`：`A` 已在
公面（`Ah`），hero 的 `As` 不是独有贡献，却仍报 `straightDraw: 1`。`hole = As Kd` 同板则
**已成顺**（hero `K` + 公面 `A Q J T`）。

**问题 2（语义）**：`straightOuts` 在已成型顺子时仍可能返回 outs（如 `hero Th Jd`、
`board 9h 8c 7d` → `straightDraw = 2`）。

**修法**（`postflopPolicy.ts`）：

- `straightOuts(rankCount, boardLength, heroRanks, boardRanks)` 改为**按 rank 来源判定**：
  窗口内至少存在一个 rank 满足 `heroRankSet.has(rank) && !boardRankSet.has(rank)`。由于循环
  跳过已持有 rank，补牌 rank 不可能是 hero rank，故该条件即「只有 hero 提供此 rank」。这同时
  覆盖 hero 两张同 rank（集合去重）、board 与 hero 同 rank（board 提供 → 不计）与 wheel。
- `evaluateHand` 传入 `board.map(rankOf)`，并明确**语义决定 ①**：`category >= 4`（已成顺或更强）
  时 `straightDraw = 0`——draw 表示「尚未成牌、可继续改善」，与 `flushDraw` 只在四张同花
  （未成牌）时为 true 一致。该语义写进 `HandEval.straightDraw` 与 `evaluateHand` 源码文档。

**测试**：

- `a hero rank already on the board is not a unique contribution (P0, rank source)`：
  `As 2d` on `Ah Qc Jd Tc` → `straightDraw 0` / `draw 'none'`；`As Kd` 同板 → `category 4` /
  `straightDraw 0`；wheel 共享 A：board `Ac 2d 3h 4s` + hero `As Kd`，补 `5` → `0`。
- `counts only draws hero uniquely supplies...`：hero `Th 2d` on `9h 8c 6d` → `1`（单张 gutshot）；
  hero `Th 9d` on `8c 7d 2s` → `2`（两张 OESD）；hero `As Kd` on `2c 3d 4s` → `1`（wheel 经 hero A）。
- 保留二轮 board-only 反例 `As Kd` on `9h 8c 7d 6s` → `0`（含同牌面 `Qd Jh` → `1` 对照）。

**实测 before / after**（before 值由临时 probe 测试在修改前打印确认）：

| 输入 | before | after |
| --- | --- | --- |
| `As 2d` on `Ah Qc Jd Tc`（补 K 成顺） | `straightDraw 1` | `0` |
| `As Kd` on `Ah Qc Jd Tc`（已成顺） | `straightDraw 1` | `0`（category 4） |
| `As Kd` on `9h 8c 7d 6s`（board-only） | `2` | `0` |
| `Qd Jh` on `9h 8c 7d 6s` | `2` | `1` |
| `Th 9d` on `8c 7d 2s`（hero 两卡） | `2` | `2` |
| `As Kd` on `2c 3d 4s`（wheel） | `1` | `1` |

**scope 说明**：这是对基线 `f4a5904` 中 **draw 归因 bug** 的有意修正 + 一项语义明确。因此
「默认全关 = 基线」在**触发这些差异的输入**（公面四张连续、hero 与公面同 rank、已成顺子）上
不再逐字节相同——这正是修复意图。§3 的差分网格不含这些输入，故在其覆盖输入集上仍逐输入一致。

### 1.2 P0-2（二轮）`DEFAULT_P2` 可被运行时修改

**问题**：`export const DEFAULT_P2: P2Options = {...}` 的属性仍可写
（`DEFAULT_P2.sizeGrid = true`），而多个默认参数直接引用它 → "默认全关"不是不可变保证。

**修法**：

- `DEFAULT_P2: Readonly<P2Options> = Object.freeze({...})`。
- 引用它的默认参数改为只读类型：`facingVillainModel` / `facingVillainRange` 的 `opts` 参数为
  `Readonly<P2Options>`；`buildVillainRange` 的 `opts` 为 `Readonly<Pick<P2Options, 'buckets'>>`。
  `chooseVillainModel` / `opponentModelStats` 读取的是布尔字段，值类型即 `boolean`。

**不可变证据**（`postflopPolicyP2.test.ts > DEFAULT_P2 is frozen... (P0-2)`）：

- `Object.isFrozen(DEFAULT_P2) === true`。
- 对四个键各做 `Reflect.set(DEFAULT_P2, key, true) === false`，写后 `DEFAULT_P2[key] === false`。
- `{ ...DEFAULT_P2 }` 仍为全 `false`。
- 默认参数读取仍走全关路径：`chooseVillainModel({ betFraction: 0.9 })`（不传第二参）→ `balanced`。
- 编译期另由 `Readonly<P2Options>` 阻止 `DEFAULT_P2.sizeGrid = true`。

### 1.3 P1-3（二轮）默认差分网格缺 `sizeGrid` 真正敏感输入

**问题**：`baselineGrid()` 原有四个尺寸的 fraction 分别为 `0.5 / 0.5 / 2.0 / 1.0`，**不含
`0.875 ≤ fraction < 1.0`**。而 `0.9 pot` 恰是 `sizeGrid` 开时唯一会改档的输入
（`balanced` → `value-heavy`）；若默认值意外变 `true`，原网格未必抓得住。

**修法**：`baselineGrid()` 增加 `[190, 90]`——`potBefore = 190 - 90 = 100`，
`call / potBefore = 90 / 100 = 0.9`。保留原有 4 个尺寸，以及 3-bet 线、10 手 maniac 统计
（shrinkage 输入）、`historyComplete=false` 断线视图、30 手 station 样本、all-in 视图、
每组合 4 个 unopened 视图。视图数由 580 增至约 700（4 牌面 × 5 底牌 × [5 尺寸 × 6 + 1 all-in]
+ 20 × 4 unopened）。

### 1.4 P1-4（二轮）报告的精确 action rate 与性能数字缺支撑

- **action rate**：原报告 §1.4 写了精确计数（如 `off {call:30,fold:30} → on {fold:59,call:1}`），
  但测试只断言 `onCounts !== offCounts` 且 `fold` 增加，数字无支撑。**处理（选②）**：删除精确
  计数表，只保留测试真正证明的方向性结论——每个开关的 on/off `actionCounts`（240 个固定 seed
  视图）必须 `not.toEqual`，且 `fold` 计数相对 off 上升。报告不再出现无测试支撑的精确计数。
- **性能**：原报告写 `12.31/10.89/21.75/42.02ms` 并标"实测"，但缺批次/条件。**处理**：改为
  本次同批次测量值，明确命令与条件（§5），并注明不同批次不可直接比较。

### 1.5 P2 债务清理（翻前第三步同批，`c4fb6d2` / `2b3e2e7`）

复审指出的 P2 遗留问题，默认行为仍全关，仅收紧契约与补测试：

1. **`isOverpair` 签名收紧：`ev` 必填**。旧签名 `ev?: HandEval` 在省略 `ev` 时直接
   按角子对判定，会把 `AA` on `QQx`（两对）误报为超对。现在 `ev` 为必需参数，
   `ev.category !== 1` 是契约的一部分（不是调用方可选优化）；传入为别的 hole/board
   计算的 `ev` 属编程错误。`AA on QQx` 因此被 `category !== 1` 拒绝。
2. **新增 `isExposedOverpair(hole, board, ev) = isOverpair(...) && heroFlushExposed(...)`**，
   价值下注与价值加注两处调用点统一用它，使「哪些手牌被降频」只有一个显式定义，
   不会漂移或悄悄扩到所有无同花保护成手。
3. **`heroFlushExposed` 语义拆分**：源码文档明确它只是「公面成花且 hero 无该花色」的
   **花色暴露谓词**，不代表手牌强度（暗三 / 顺子 / 空气同样"暴露"）；降频决策只作用于
   **暴露的超对**，即上面的显式组合。调用方不得把该谓词直接当作 exposed-overpair 判定。
4. **flush 单调容差 0.15 → 0.05**：river 四花面对 all-in 的「强同花继续率不弱于弱同花」
   是启发式排序而非定理证明，容差不可避免；本次收紧到 5% 并在注释里显式标注为近似，
   三次复跑稳定通过。
5. **`blockerFactor` 补测试**：文档化仿射式 `clamp(0.4 + 1.6·clamp01(blocker), 0.2, 2.2)`
   （有效输入域 [0.4, 2.0]，中性点 blocker=0.375 → 1），断言边界、严格单调、
   非有限输入不产生 NaN。exposed range tilt 增加有限正值与 flush 份额边界测试。
   四开关默认仍全关，`postflopPolicyBaseline` 差分保持通过。

---

## 2. 一轮返修项（已确认正确，保留）

### 2.1 `historyComplete` 契约

- `preflopRaiseCount(view)`：`!view.historyComplete` 时返回 0（不把"缺失的加注"读成"没加注"）。
- `facingVillainModel`：即使 `rangePropagation` 开，`historyComplete === false` 时直接返回
  size/texture/opponent-type 基础读，不做行动线平移。
- `heroWasAggressor` 未加门禁：它同时是 P0 基础读的输入，改它会改变基线；P2 传播已单独门禁。

测试：`refuses to propagate a 3-bet line from an incomplete history`、
`ignores the action line for a mid-hand join even when the snapshot looks multiway`。

### 2.2 shrinkage 输入契约

`shrinkRate(hits, n, prior)`：`k+n=0` → `prior.mean`；`hits>n` clamp 到 n；负数/非有限读作 0；
`hits` 允许小数；结果恒在 `[0,1]`、永不为 NaN。`shrinkConfidence` 同契约；
`estimateOpponent` 的 aggression 分母为 `bet/raise + call`，两者为 0 时回退先验。

### 2.3 24 桶边界语义测试

made 语义（set/trips/two pair/straight/flush/boat/SF；`category>=3` 统一 `strong-made`）、
draw 语义（OESD / gutshot / 纯同花听牌 / combo / none）、board-only vs hole-card 同花与顺子
（含四张公面顺听、hero 与公面同 rank、wheel）、24 桶互斥完备。`straightDraw` 明确为
「仅统计 hero 独有提供的 rank 补牌」且「已成顺（category>=4）时为 0」，是启发式
rank-completion 计数而非精确 outs（`HandEval.straightDraw` / `evaluateHand` 源码文档）。

### 2.4 决策级 on/off

固定 seed + 固定 view，验证四个开关 on/off 的 model / weights / equity / actionCounts 变化。
每个开关断言 `onCounts !== offCounts` 且 `fold` 增加（方向性，无精确计数断言）。

### 2.5 尺寸网格中点

`snapBetFraction` 用严格 `<`，恰好中点偏小档（`0.415→0.33`、`0.625→0.5`、`0.875→0.75`），
略偏上才翻档。`0.9-pot → 1.0 → value-heavy` 是 `sizeGrid` 开关下的有意行为变化；默认关时
`chooseVillainModel({betFraction:0.9})` 为 `balanced`。

### 2.6 `bucketAdvantage` 未接入

如实标注为实验 API、未接入任何决策：policy 无调用点，且仅 `buckets` 开启时其相关权重生效，
而 `buckets` 默认关。

---

## 3. 默认全关基线一致性差分证据

`test/fixtures/postflopPolicyBaseline.ts` 由
`git show f4a5904:packages/agent-core/src/postflopPolicy.ts` **生成**；仅做了三处归一化：
（a）相对 import 重定向到 `../../src`；（b）导出/类名改为 `BaselinePostflopPolicy`；
（c）顶部增加 fixture 说明注释（`DO NOT EDIT BY HAND`）。**决策逻辑体与 `f4a5904` 逐字节一致**，
不是"整文件逐字节副本"。文件头注释已同步此措辞。

差分测试 `default Configuration is the HEAD baseline`：

- `baselineGrid()` 生成约 700 个视图（见 §1.3），覆盖四牌面、五底牌、五种尺寸、
  3 个 actionSeq、3-bet 线 + maniac、断线视图、station 样本、all-in、unopened。
- 每个视图用 `toEqual` 比较 `new PostflopPolicy({params, seed})`（默认全关）与
  `new BaselinePostflopPolicy({params, seed})` 的完整 `PolicyDecision`（action + reason）。
- 另有测试证明"显式全关配置 == 默认配置"。

> 结论：在上述输入集上默认全关与基线逐输入一致；二者共享 `decisionView` / `equity` /
> `preflopPolicy`，差分隔离出的正是 `postflopPolicy.ts` + `sessionMemory.ts` 的 P2 改动。
>
> **准确 scope**：默认关闭的是四项 P2 功能；本次另包含**始终生效**的 `evaluateHand` 修正——
> 排除没有 hero 独有 rank 贡献的顺子补牌，并对 `category>=4` 清除顺听标记。该修正同时作用于
> **hero 评估与 villain combo 评估**，因此即使 hero 自己的 draw 标记未变，range 权重与最终
> equity 仍可能改变（已知差异不止「三类输入」：如 `Ks Qd / 2c 3d 5h 6s` 这类有缺口公面顺听、
> 以及 `Ah Kh / Qh Jh 2h` 这类无顺子的同花成手，旧值 1、新值 0）。差分测试仅证明所列视图的
> **完整决策相等**，不穷尽所有行为差异；上述有意差异由 §1.1 的专门单测锁定。

---

## 4. 测试清单与复跑结果

| 命令 | 结果 |
| --- | --- |
| `npx vitest run packages/agent-core` | **404 passed / 16 files**（P2 文件 43 用例；P2 报告初版为 386，其后翻前第三步及其复审 v2 追加了用例） |
| `npx vitest run packages/agent-core/test/postflopPolicyP2.test.ts` | **43 passed** |
| `npm run typecheck -w @4am/agent-core` | 通过（退出 0） |
| `git diff --check -- packages/agent-core` | 通过（退出 0，无空白错误） |

关键断言：shrinkage 契约；尺寸网格最近邻与中点；`0.9→1.0→value-heavy`；24 桶语义与完备性；
**P0 rank 来源判定（board 同 rank 不计、wheel、hero 两卡）**；**made straight → `straightDraw 0`**；
**P0-1 四张公面顺听不归 hero**；**P0-2 `Object.isFrozen` + `Reflect.set` 拒绝写入**；
`historyComplete` 门禁；四开关决策级 on/off；>200 视图基线差分。

---

## 5. 性能（同批次实测）

命令：`npx vitest run packages/agent-core/test/postflopPolicy.test.ts -t 'postflop: performance'`
（单文件、该测试内部 warm 后 120 次取 p95；本次返修工作区、同一机器、同一批次）。

| 场景 | 本次同批次 p95 |
| --- | --- |
| heads-up | **7.54ms** |
| 2-way | **7.06ms** |
| 4-way | **13.09ms** |
| 8-way | **25.70ms** |

上一轮报告中的 `12.31 / 10.89 / 21.75 / 42.02ms` 属**另一批次**的历史测量值，与上表不可直接
比较；机器负载、并发与 cache 状态都会影响 p95。开关检查分布在模型、range 与 exploit 路径中，
且始终生效的 `evaluateHand` draw 修正也会执行，因此不宜作「默认关即不在热路径」的绝对声明；
本表不作为收益或回归证据。

---

## 6. A/B 评测方案（后续独立任务）

目标：判定 P2 是否值得默认开启、以及各开关的边际收益。**当前结论：P2 胜率收益未证明。**

- **臂（arms）**：`baseline`（`DEFAULT_P2` 全关）、`shrinkage only`、`size grid only`、
  `range propagation only`、`buckets only`、组合候选 `shrinkage+sizeGrid+rangePropagation`
  与 `+buckets`。
- **arm factory（设计已记录，尚未实现，属后续独立任务）**：现状
  `apps/server/test/helpers/evalStrategies.mjs` 的 `makeStrategy(name, opts)` **只有**
  `always-fold` / `always-call` / `equity-threshold` 三个基线，**没有** `PostflopPolicy`
  import、没有 `p2:` 解析、没有 arm 配置。设计的接入方式为：新增 `p2` 前缀解析
  （如 `p2:shrinkage+sizeGrid` / `p2:shrinkage+sizeGrid+rangePropagation+buckets`），把开关集合
  解析为 `Partial<P2Options>` 并构造
  `new PostflopPolicy({ params: RULE_PRESETS['tight-aggressive'], seed, p2 })`，`name` 保留原始
  arm 串；`isBaselineStrategy` / `isSupportedStrategy` 同步识别 `p2:` 前缀。**这些均未落地**，
  本次不修改 server 代码。
- **配置记录与结果标识（同属后续任务的设计）**：届时结果 JSON 记录每臂的 `name` 与解析后的
  `p2` 配置（如 `arms: [{ seat, name: 'p2:shrinkage', p2: { shrinkage: true } }]`）以及
  `baseline` 的 `DEFAULT_P2` 快照；结果按 arm 名 + p2 config 作键，避免同名不同配置混淆。
- **控制变量**：同 seed 序列、同一 bot pool（各风格 × 位置轮转）、同一手数预算。
- **规模**：先 ≥ 20 万手/臂（复用 duplicate round-robin + bootstrap），报告 95% bootstrap CI。
- **指标**：bb/100（主）；fold / call / raise（及 bet / check）分布；按位置、底池大小、街、
  人数分组；必要时加 VPIP/PFR/aggression 与摊牌胜率。
- **判定**：bb/100 的 CI 下界 > 0 视为候选提升；单开关无显著收益则保持默认关；组合需相对
  baseline 显著且不劣化风险指标。
- 复用 `apps/server/test/helpers/evalMatch.mjs` 的确定性洗牌 / Duplicate 对局 / 成对 round-robin
  / bootstrap CI。

---

## 7. 偏离与未决

- `heroWasAggressor` 未加 `historyComplete` 门禁：为保持默认全关时与基线逐输入一致；P2 传播
  路径已单独门禁。
- P0 改变了 `evaluateHand` 的 `straightDraw`（rank 来源判定 + made-straight 语义）：默认全关下
  仅在（a）公面四张连续且 hero 不参与、（b）hero 与公面同 rank 构成顺子、（c）hero 已成顺这三类
  输入上与基线不同（有意修复）。**差分仅覆盖 `baselineGrid()` 的输入**，该网格不含上述三类，故
  §3 仍逐输入一致；差异由 §1.1 的专门单测锁定。
- A/B 的 `p2:` arm factory 仅为**设计记录、尚未实现**（server 代码本次未改）。
- `foldToBet` 先验已定义但**未接线**（`OpponentStats` 无字段，`decisionView.ts` 属其它 lane）。
- `bucketAdvantage` 为**实验 API、未接入决策**。
- 尺寸网格会改变多个尺寸的 model 分档，不只限于某个区间；已实测：`0.41` 关闭时 `balanced`、
  开启时 snap 到 `0.33` → `bluff-heavy`；`0.9` 关闭时 `balanced`、开启时 snap 到 `1.0` →
  `value-heavy`。`0.875` 是恰好中点、取较小档 `0.75`（仍为 `balanced`）。系设计使然。
- HEAD 检出上已复跑整套测试（§4：404 passed / 16 files）；基线一致性由 §3 差分测试直接证明。
