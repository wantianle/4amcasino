# 人数自适应翻前范围 —— 第一、二、三步（RFI / HU / 面对 open / 剩余 spot）

- 状态：三步均已实现，flag **默认开启**（`ADAPTIVE_PREFLOP_DEFAULT=true`，可用
  `FOURAM_ADAPTIVE_PREFLOP` 或显式 `adaptivePreflop:false` 关闭）；不可信人数/历史
  （`headcountReliable`/`historyComplete` 不满足）或显式 `adaptivePreflop:false` 时回退 legacy
- 关联代码：`packages/agent-core/src/preflopCharts/**`、`preflopPolicy.ts`、`decisionView.ts`、`ruleStyles.ts`
- 数据来源：`~/dev/preflop-trainer/data/external/{frla-gto-nl100,mhl-nl100}`
- 验收测试：`packages/agent-core/test/preflopAdaptive.test.ts`（67 例）；
  P2 债务清理见 `docs/plans/postflop-p2-report.md` §1.5

## 1. 核心模型：用 `behindUnacted`，不用位置名

翻前范围宽度的真正自变量是"英雄之后还有几个能行动、且**尚未完成翻前动作**的人"，
而不是位置标签。为此在 `PreflopContext` 上新增：

| 字段 | 含义 |
|---|---|
| `dealtCount` | 本手发牌人数（= `seatOrder` 长度） |
| `activeCount` | 未 fold / 未 all-in / 未 sit-out 的人数 |
| `behindUnacted` | 英雄之后、仍可行动且尚未行动的席位数 |
| `actorSlot` | `clamp(behindUnacted, 0, 8)`，即 canonical slot `B0..B8` |
| `headsUp` | 本手是否 2 人 |
| `headcountReliable` | 服务器提供了 `seatOrder` 且覆盖所有已知席位 |
| `openerSlot` | 首个加注者的 canonical slot（缓存键用） |

行动顺序（`preflopActionOrder`）：

- 多人：`[seatOrder[2..], seatOrder[0] (SB), seatOrder[1] (BB)]`
- HU：`[seatOrder[0] (SB/BTN), seatOrder[1] (BB)]`（**保留**现有 HU 特判）

`headcountReliable` 要求服务器下发 `seatOrder`，且该座次表**恰好**是已知席位的
一个无重复排列：长度 2..9、无重复值（`new Set(order).size === order.length`）、
`order` 的集合大小等于 `knownSeats` 大小、且每个已知席位都出现。仅做"子集"校验
不够——`seatOrder=[0,1]` 而 `{0,1,2}` 在座时会被误判为可靠并把三人桌当二人桌；
必须同时满足不重复 + 等长 + 全覆盖，宁回退。推断出来的座次不用于自适应。
`historyComplete` 单独把关——**缺历史绝不会被当成"没人行动"**。

## 2. Canonical slot 映射

| behind | 6-max | 9-max | 3–5 人 | 自适应图表 |
|---:|---|---|---|---|
| 5 | UTG | LJ | 5 人首位 | FRLA UTG-RFI |
| 4 | MP/HJ | HJ | 4 人首位 | FRLA MP-RFI |
| 3 | CO | CO | — | FRLA CO-RFI |
| 2 | BTN | BTN | 3 人首位 | FRLA BTN-RFI |
| 1 | SB | SB | SB | FRLA SB-RFI / HU chart |
| 0 | BB | BB | BB | 空（BB 从不 RFI） |
| 6 | — | MP | — | UTG 外推到 15.74% |
| 7 | — | UTG1 | — | UTG 外推到 14.12% |
| 8 | — | UTG | — | UTG 外推到 12.66% |

注意：现有 5 人桌把第三个位置显示为 `UTG`（展示层保留），但自适应按
`behindUnacted=4 → B4` 取 MP 图表，不会误用 6-max UTG。

每个 n 的 slot 集合恒为 `{B0..B(n-1)}`，天然含 `B0`/`B1`，无映射空洞。

## 3. 数据子集与 provenance

数据以 TypeScript 模块落盘到 `packages/agent-core/src/preflopCharts/data/`（本地自用，
上游许可各自标注；FRLA 为 MIT，MHL 上游无 LICENSE 文件）：

| 文件 | 内容 | 上游 | commit |
|---|---|---|---|
| `frlaRfi.ts` | UTG/MP/CO/BTN/SB 五个 RFI spot | `frla-gto-nl100`（frla18cz/poker-solver） | `f2af7831b971d6e91416c36d747e54cf90e85bdd` |
| `frlaBbDefend.ts` | BB-vs-open-{UTG,MP,CO,BTN,SB} | 同上 | 同上 |
| `mhlHu.ts` | HU `SB_OPEN`（raise/limp） | `mhl-nl100`（michaellhan/preflop）`js/ranges.js` | `538f4d298d0cdfdc251b3724c78ae3e2d84585c2` |

只保留参与（`fold < 1`）的手牌，未列出的手牌默认纯 fold。每个文件带
`provenance{provider,url,commit,ref,license,capturedAt,sourceFile,note}`。

关键发现：抽取器 `ranges.json` **没有** HU spot，但上游 `source/ranges.js` 的
`HU.SB_OPEN` 有完整的 raise/limp 频率；`mhlHu.ts` 直接从该源码解析。实测 HU
参与率 87.06%、limp 占比 36.54%，与规格给的 87% / ~32% 一致。

`frlaBbDefend.ts` 是为第二步（面对 open 的防守）预落的数据种子。第二步已通过
`bbDefendChartFor()` 接入 `buildAdaptiveMix()` 的 BB 分支（见 §10.3），不再是
「未接入」状态。

## 4. 中间格式 `preflop-chart/v1`

`preflopCharts/types.ts` 定义：

```ts
interface PreflopChart {
  schema: 'preflop-chart/v1';
  id: string;
  game: { seats; format; depthBB; openSizeBB };
  spot: { situation; actor; actorSlot; opener; openerSlot; activeCount; behindUnacted };
  source: { provider; url; commit; capturedAt; usage };
  mix: Record<string, { raise; allin; call; fold; raiseRole: 'value'|'bluff'|null }>;
}
```

每个图含全部 169 类，逐格 `raise+allin+call+fold = 1`（实测偏差 0）。
`raiseRole` 显式写：`fold<=1e-6 && raise+allin>0 → 'value'`；否则 raise/fold 混合
→ `'bluff'`；不 raise → `null`。转 `RangeEntry[]` 时逐手显式带 role，不依赖
`compileRangeMix` 的默认推断。

## 5. 缩放：逐手牌类变换（不是整体乘系数）

- 输入 `p = raise+allin+call`；
- 缩窄：`p' = clamp((p-t)/(1-t))`，二分求 `t`；放宽：`p' = clamp(p+a(1-p))`，二分求 `a`；
- 两种变换下 `p=1` 恒为 1（强牌不缩）；
- 拆回动作：`ratioRaise=(raise+allin)/total`、`ratioCall=call/total`，各自乘 `p'`。

**放宽（widening）契约**：放宽只调频、不造牌——`p=0` 的手牌（anchor 从未
play，或显式 `[0,0,0]`）在 `a→1` 时仍保持 fold，因此可达宽度有硬上限：

```
maxReachableWidth(spot) = Σ_{p>0} combos(class) / 1326
```

`buildChartMix(raw, target)` 在 `target > maxReachableWidth + 1e-9` 时**显式
`throw`**（错误信息含 `reachable ceiling`），不再像旧实现那样把 `a` 推到 ~1 后
静默返回偏窄宽度。生产路径不受影响：B6–B8 是缩窄、HU 为恒等（`NaN`），没有任何
调用会放宽到上限之上。契约由测试固定：`p=0` 保持 0、上限处放宽成功、超限抛错。
（缩窄侧另有对称下限：`p=1` 的强牌不可缩，`target` 低于其 combo 占比同样不可达；
生产 target 远高于该下限，暂未加守卫。）

B1–B5 直接用实测锚点宽度（恒等变换）；B6–B8 把 UTG 图缩窄到
`W(B)=0.1755*exp(-0.1089*(B-5))`。

### 实测宽度表（neutral style、100BB）

| 人数 n | 首位 slot | 宽度 | 备注 |
|---:|---:|---:|---|
| 2（HU） | B1(BTN/SB) | **87.06%** | HU chart，limp 36.54%，open 2.5bb |
| 3 | B2 | 42.04% | |
| 4 | B3 | 28.30% | |
| 5 | B4 | 21.78% | |
| 6 | B5 | 17.55% | |
| 7 | B6 | 15.74% | UTG 外推 |
| 8 | B7 | 14.12% | UTG 外推 |
| 9 | B8 | 12.66% | UTG 外推（规格 12.60%，差 0.06pt） |

B1 46.34% > B2 42.04% > B3 28.30% > B4 21.78% > B5 17.55% > B6 15.74% >
B7 14.12% > B8 12.66%，单调。

## 6. 落地接缝

- `RuleParams` 新增 `adaptivePreflop: boolean`，四个 preset 均取 `ADAPTIVE_PREFLOP_DEFAULT`
  （默认开；`FOURAM_ADAPTIVE_PREFLOP` 可显式关闭）；`parseRuleConfig` 单独按布尔解析（不进数值 `PARAM_RANGES`）。
- `buildMix(ctx, params)`：先试 `buildAdaptiveMix`，返回 `null` 时回退
  `buildLegacyMix`（原 `RFI_RANGES`/`RFI_MARGINAL`/`ISO_RANGES`/`BB_DEFEND`/
  `CALL_VS_OPEN`/`FACING_3BET_*` 全部原样）。
- 自适应可用条件（`adaptivePreflopAvailable`）按 spot 分支，未覆盖的 spot 一律回退 legacy：
  - 统一前置门禁（所有分支）：flag 开 + `historyComplete` + `headcountReliable` +
    `2<=dealtCount<=9` + `behindUnacted` 有限 + `heroActive` + `heroToAct`。
  - `spot==='unopened'`：HU 时要求 `actorSlot===1`，否则 `1<=actorSlot<=8`（RFI / HU）。
  - `spot==='facingOpen'`：见 §10.3（额外要求 `needToActTracked` 且服务器
    pending 列表**非空并包含 hero**）。
  - `spot ∈ {limped, facingOpenMultiway, facing3Bet, facing3BetCold, facing4BetPlus}`：
    见 §11（派生图；带加注的四类额外要求 `needToActTracked` 且 pending 非空含 hero）。
  第一步接 unopened，第二步接 facingOpen，第三步（§11）接其余五类 spot。
- 缓存键 `preflopMixCacheKey` 含 `spot|position|openerGroup|dealtCount|actorSlot|
  openerSlot|raises|callers|round(stackBB)|route`，其中 `route = adaptivePreflopAvailable(ctx, params) ? 'adaptive' : 'legacy'`。
  **必须编码最终路由而非 flag**：flag 只表示"允许"，实际路由还取决于
  `historyComplete`/`headcountReliable`/`spot`/`dealtCount`/`actorSlot`。若只放
  `A/L`，则"flag 开 + 历史完整（走 adaptive）"与"flag 开 + 历史不完整（应回退
  legacy）"会生成同一 key，先入 `mixCache` 者污染另一个，直接破坏"失败全回退旧表"。
- `<20BB` 仍由 `effectiveFrequencies → shortStackMix` 短路到 `SHORT_JAM_RANGES`，
  与自适应无关。
- `role:'value'` 的值续叫语义不变：value 只会在 raise/call 之间移动，绝不 fold。
- **已知限制（step-2 必修，已在第二步修复）**：`actedSeats = Set(actionHistory.map(a => a.seat))`
  只记录"某人行动过"，不区分该座在当前下注轮是否仍欠行动。翻前行动轮可被加注
  重开（已 call 者在面对 3-bet 时需再次行动），因此一旦出现 raise，该集合会高估
  "已完成行动"的人数、低估 `behindUnacted`。第二步已改为基于服务器公开字段
  `needToAct` 的当前下注轮判据，见 §10.1。

## 7. 回退证明

`test/preflopAdaptive.test.ts` 断言（下列 flag on/off 均为**显式传入**的开关值，用于隔离
自适应与 legacy 两条路径；默认配置是 flag 开，不该把这里的对照读成"默认关闭"）：

- `adaptivePreflop=false`、`historyComplete=false`、无 `seatOrder` 时
  `adaptivePreflopAvailable === false`；
- **显式** off 时 9-max UTG 宽度 == `parseRange(RFI_RANGES.UTG).combos/1326`
  （10.26%），**显式** on 时宽度不同（12.66%）；
- **显式** on 时 `<20BB` 的 `22` 仍 fold、`AA` 仍 raise（走 `SHORT_JAM_RANGES`）；
- value 牌在 `preflopScale=0.5` 下 raise+call=1，不 fold；
- 路由正确性（新增）：同一 `position/dealtCount/slot` 下 `historyComplete=true`
  与 `false` 两个 view，`preflopMixCacheKey` 不同；`vi.resetModules()` 取全新
  `mixCache` 后按 `adaptive-first` 与 `legacy-first` 两种顺序各测一遍，adaptive
  始终等于 `chartWidth(rfiChartForSlot(8))`（12.66%）、legacy 始终等于旧
  `RFI_RANGES.UTG` 宽度（10.26%），证明无顺序相关污染；
- `headcountReliable`（新增）：重复座次、缺座（`[0,1]` vs `{0,1,2}`）、多座均
  判不可靠；重排（`[1,2,0]`）仍可靠；
- 人数行为（新增）：2/3/6/9 人 + hero 首位/中间/盲位 slot 映射；hero 之后
  folded/all-in/sit-out 席位的剔除；带 `actionHistory` 阶段下 `behindUnacted` 与
  `openerSlot` 的判据；HU SB 走 HU chart、HU BB 面对 raise/limp/fold 全走 legacy
  （不退化成 HU RFI）；
- widening 契约（新增）：`maxReachableWidth` 上限、`p=0` 保持 fold、超限抛错；
- flag 关最终决策差分（第三步新增）：`test/fixtures/rulePolicyBaseline.ts` 把
  `choosePreflopIntent` 指向 `preflopPolicyBaseline`，构造真正的 5f9b12a
  `RulePolicy`；对 unopened / HU / limped / facing-open / 3-bet / 冷 3-bet / 4-bet+ /
  `<20BB` 的多底牌 × 多 seed 逐输入比较**完整 `PolicyDecision`（action + amount +
  reason，`toEqual`）**。`RulePolicy` 本体在 `5f9b12a..HEAD` 逐字节未变，故差分隔离出
  的正是 `preflopPolicy.ts`。另保留一条更细的 `choosePreflopIntent`
  intent/frequencies/context 差分，但其声明已如实收窄，不再等同最终决策。
  反向验证：把差分里的 flag 打开、或对 baseline fixture 做一次刻意扰动，测试均按预期报红；
- 现有 `packages/agent-core` 全部测试不变（含本文件，全绿）。

## 8. 偏离与说明

1. HU 数据来自 MHL **源码** `source/ranges.js` 的 `HU.SB_OPEN`，而非抽取后的
   `ranges.json`（后者未收录 HU spot）。provenance 指向源码文件。
2. `game.openSizeBB` 仅作为元数据记录（HU / 6-max 2.5bb），**未**修改
   `rulePolicy.preflopAction` 的实际加注额（仍沿用既有 sizing）。sizing 自适应
   留到后续步骤，避免破坏现有规则测试。
3. 第一步自适应只覆盖 unopened；第二步（§10）已把 `frlaBbDefend.ts` 接入
   `facingOpen` 的 BB 防守，故「已落盘但未接入」已不再成立。本文档保留此条
   仅为记录第一步的边界。
4. B8 用公式得 12.66%，规格写 12.60%（0.06pt，在 0.5pt 容差内）。

## 9. 第二步建议（落地状态）

这里原本是第一步收尾时提出的第二步计划。第二步（§10）落地了其中第 1 条，第三步
（§11）落地了第 2 条；其余仍未做，保留以便对照（避免与 §10 / §11 的「已实现」互相矛盾）：

1. **已实现**（§10.1–10.6）：接入 `facingOpen` 的 BB / 非 BB 防守，图表按
   `openerSlot` 取 `FRLA_BB_DEFEND` / `COLD_3BET`，并用 `behindUnacted` 调整
   防守宽度。
2. **已在第三步实现**（§11）：多人 limped pot 的 `behindUnacted` taper 与
   `facingOpenMultiway` 的 caller squeeze。
3. **未实现**：sizing 随 `game.openSizeBB` 自适应（HU 2.5bb），短码段
   `raise` vs `allin` 映射，见 §10.7。
4. **未实现**：chart 持久化/自检（schema 校验、169 格和=1）与抽取脚本入库。

## 10. 第二步：面对 open 的防守

### 10.1 acted 语义：当前下注轮，而非「本手行动过」

- `DecisionView` 新增公开字段 `needToActSeats?: number[]`，镜像服务器公开的
  `betting_state.needToAct`（当前下注轮仍欠行动的绝对席位）。空数组是合法的
  「无人欠行动」快照，`undefined` 才表示服务器未提供。
- `derivePreflopContext` 改用 `computeBehindPending`：pending 集合优先取
  `needToActSeats`；缺失时回退第一步的「active 且未 actionHistory 行动过」推断。
- 加注重开时服务端会以 raiser 为起点重建 `needToAct`，把此前的 caller 重新纳入，
  因此 `behindUnacted` 正确回升。回归测试直接用 `@4am/shared` 的
  `startHand()`/`applyAction()` 构造真实状态机：6-max `UTG open → HJ call →
  CO call → BTN 3bet` 后 hero=UTG，`st.needToAct=[0,1,2,3,4]`（raiser 不在其
  中），tracked `behindUnacted=4`（HJ/CO/SB/BB），旧推断仅 2（双盲）。
- `PreflopContext.needToActTracked` 暴露本次是否用了服务端字段。facing-open 自适应
  **必须** `needToActTracked`，否则重开不可见、会低估 `behindUnacted`，故回退 legacy。

### 10.2 openerSlot：6-max 参照槽位

第二步用 `openerSlot` 选 BB 防守锚点，其定义改为按 **opener 位置名** 映射到 6-max
参照槽位：`UTG/UTG1 → B5`、`MP/LJ/HJ → B4`、`CO → B3`、`BTN → B2`、`SB → B1`、
`BB → B0`。不能用原始 behind-unacted 槽位——9-max 的 BTN 身后 0 人会被算成 B0，
错选到最紧的 UTG 锚点。缓存键含 `openerSlot`，不同 opener 位置不串。

这是**有意的位置名映射**，而非按桌内实际 behind 数取槽位：数据是 6-max 的，位置名
才是跨桌人数稳定的键。其可观察结果是短桌会自然跳过没有对应位置的参照槽位——例如
5 人桌的位置表是 `SB/BB/UTG/CO/BTN`（没有 HJ/MP），因此永远不会命中 `B4`，只会用
`UTG→B5 / CO→B3 / BTN→B2 / SB→B1`。B4 在 5 人桌「缺失」是映射的结果，不是空洞
或回退。

### 10.3 路由与数据

`facingOpen` 自适应可用条件：flag 开 + `historyComplete` + `headcountReliable` +
`2 ≤ dealtCount ≤ 9` + **hero 是当前决策者且仍可行动**（`heroActive` 且
`heroToAct`）+ `needToActTracked` + **pending 列表非空且包含 hero** + 非 HU +
`openerSlot ∈ 1..5`。

这条 hero 门禁是通用的（unopened 分支同样要求），理由是两份门禁缺一不可：

- `heroActive`：stale/malformed 快照可能在 hero 已 folded / all-in / sit-out 时
  仍把 hero 列进 `needToAct`；一个不能行动的 hero 没有决策可言。
- `heroToAct`：`needToAct` 是「本轮还欠行动」的集合，首元素才是当前行动者；
  快照里 hero 在集合中但 `hand.toAct` 是别人时，同样不是 hero 的活决策。
- pending 非空且含 hero：`needToActTracked` 只说明服务器下发了字段，空列表
  （快照已关闭/时机不对）或不含 hero 的列表都不是 hero 本人的下注轮决策，
  此时 `behindUnacted` 不再度量 hero 身后的待行动者。

以上任一不满足都必须回退 legacy（有契约测试覆盖 `hero inactive` / `hero≠toAct` /
`pending 不含 hero` / 字段缺失 / 空数组五种情形）。

- **hero = BB**：消费 `FRLA_BB_DEFEND`，按 `openerSlot` 选 spot（B5→`BB-vs-open-UTG`、
  B4→MP、B3→CO、B2→BTN、B1→SB，B6+ 钳到 UTG），经 `buildChartMix` 构建。
- **hero 非 BB**：无 solver 子集，锚点 = `COLD_3BET_VALUE/BLUFF[openerGroup]` +
  `CALL_VS_OPEN[heroGroup]`，call 频率乘 `continueWidthScale(behindUnacted) =
  1 / (1 + 0.08·B)`（B=0 为恒等 1，B=8 ≈ 0.61）。**`0.08` 是启发式系数，未由
  solver 数据拟合**：现有 FRLA/MHL 子集没有 multiway / squeeze 防守锚点，该斜率
  只保证单调、保守。第三步（§11）复用了同一启发式系数，仍未重校准；后续步骤必须用真实
  的 multiway/squeeze 数据重校准它，不得当作已求解的值。
- **HU 面对 open 仍回退 legacy**：FRLA 子集是 6-max，第一步契约也把 HU
  BB-facing-raise 固定为 legacy。limped / `facingOpenMultiway` / `facing3Bet` /
  `facing3BetCold` / `facing4BetPlus` 已在第三步（§11）改走派生图，均为非 HU。

### 10.4 宽度表（neutral style、100BB）

BB（hero slot = B0）按 openerSlot 的实测宽度（= 锚点宽度，behindUnacted=0）：

| openerSlot | 6-max opener | 宽度 |
|---:|---|---:|
| 5 | UTG | **22.07%** |
| 4 | MP/HJ | **25.46%** |
| 3 | CO | **30.44%** |
| 2 | BTN | **39.32%** |
| 1 | SB | **42.73%** |

越早 open 越紧，单调。9-max 位置经 §10.2 映射到同一组锚点（UTG→22.07%，
MP/LJ/HJ→25.46%，CO→30.44%，BTN→39.32%，SB→42.73%）。

非 BB 冷跟（锚点 openerGroup=EP、heroGroup=LP；随 hero 身后未行动人数 B 收紧）：

| hero / behind | 6-max | 宽度 |
|---|---|---:|
| HJ / B4 | vs UTG | **12.61%** |
| CO / B3 | vs UTG | **13.20%** |
| BTN / B2 | vs UTG | **13.87%** |

### 10.5 回退证明

- **显式** flag 关（`adaptivePreflop:false`）：`adaptivePreflopAvailable === false`，facingOpen 宽度 = 旧
  `BB_DEFEND[openerGroup]` 表（测试用 `legacyRangeWidth(BB_DEFEND.EP)` 对照）。
- hero 不是当前决策者或已不能行动：`heroActive` / `heroToAct` 为 false 时
  unopened 与 facingOpen 两条自适应分支都关闭；契约测试覆盖 hero
  folded/all-in/sitting-out（pending 仍含 hero）与 hero 在 pending 但 `toAct` 为
  他人两种 stale 快照。
- 缺 `needToActSeats`（legacy server）：`needToActTracked=false`，facingOpen 自适应
  关闭，flag 开 == flag 关；`buildDecisionView` 用 `Array.isArray` 守卫，旧
  `betting_state.state` 没有该字段时不会 `[...undefined]` 抛错，而是返回
  `needToActSeats === undefined`（有真实状态机回归测试）。
- `needToActSeats` 存在但为空、或非空却不含 hero：`needToActTracked` 仍为 true，
  但 facingOpen 自适应同样关闭且等于 legacy（有回归测试）。
- `continueWidthScale` 的 B=0/1/8 单元断言：`1`、`1/1.08`、`1/1.64` 且严格单调
  递减。
- cache 键编码最终路由（`route`）+ `openerSlot` + `actorSlot`：openerSlot 不同、
  flag 关/开、历史完整/缺失均不串。
- `role:'value'` 不 fold：冷跟缩放只乘 call，3-bet value 频率原样保留；`<20BB` 仍
  短路到 `SHORT_JAM_RANGES`；169 格逐格 `raise+allin+call+fold=1`。

### 10.6 偏离与说明

1. **冷跟缩放用频率乘法，而非 `buildChartMix` 阈值缩窄**。冷跟表几乎全是
   `call = 1`，而 `buildChartMix` 的缩窄 `p'=(p-t)/(1-t)` 对 `p=1` 恒为 1，
   anchor 的宽度就是它的 `p=1` 下限，阈值缩窄无空间（实测目标 0.75× 仍返回原宽度）。
   改为只对 call 频率乘 `continueWidthScale`、保留 value/bluff raise：无下限问题，
   value raise 仍不 fold。BB 与 RFI 仍走既有缩窄/放宽二分与 `maxReachableWidth` 契约。
2. **HU 面对 open 保留 legacy**：FRLA 子集是 6-max，第一步测试也把 HU BB 面对
   raise 固定为 legacy。
3. **BB 面对单 open 时 `behindUnacted` 恒 0**，缩放为恒等；缩放机制保留，用于
   BB 身后仍有未行动者的非常规顺序。

### 10.7 第三步及后续的顺序（落地状态）

这里原本是复审给出的第三步建议顺序。第三步（§11）已落地第 1–3 条，第 4–6 条仍未做：

1. **已落地**：`betting-state → DecisionView` 契约测试（`needToAct` 镜像语义、raise
   重开、fold/all-in 排除、hero 是否在 pending），见 §10.1 与 §11.2。
2. **已落地**：接入 limped / 多人 pot（`facingOpenMultiway`）的派生图，见 §11。
3. **已落地**：`facing3Bet` / `facing3BetCold` / `facing4BetPlus` 三类带加注 spot 的
   派生图（要求 `needToActTracked` 且 pending 非空含 hero），见 §11。
4. **未落地**：用 multiway/squeeze 防守数据重校准 `continueWidthScale` 的 0.08。第三步
   的派生图复用了同一启发式斜率，仍未由 solver 数据拟合，见 §11.4。
5. **未落地**：sizing 随 `game.openSizeBB` 自适应（HU 2.5bb）与短码段 `raise` vs
   `allin` 映射。`<20BB` 仍短路到 `SHORT_JAM_RANGES`，第三步未适配。
6. **未落地**：抽取脚本纳入仓库工具目录；chart schema 自检目前由测试承担（169 格和=1、
   role、单调性），尚未成为独立工具。

## 11. 第三步：剩余 spot 的派生图

### 11.1 动机与做法

`limped`、`facingOpenMultiway`、`facing3Bet`、`facing3BetCold`、`facing4BetPlus`
没有 solver 子集。第三步不再外推 FRLA 图，而是把既有 rules-v1 锚点**显式转换**成真正的
`preflop-chart/v1`：

- `buildDerivedChart`：用 `rangeEntriesToRawSpot` 把带显式 role 的 `RangeEntry[]` 锚点
  转成 RawSpot，再经 `buildChartMix` 归一，产出含全部 169 类、逐格
  `raise+allin+call+fold=1`、role 显式保留的图。
- `taperRawSpot` / `continueWidthScale(behind) = 1/(1+0.08·B)`：逐手缩放**非 premium**
  的参与率，宽度对 `behindUnacted` 严格单调；`AA`/`KK` 保频不 fold
  （`DERIVED_ANCHOR_PREMIUM`）。阈值缩窄对二元旧表无空间，故用频率缩放。
- `multiwayWidthScale(callers) = 1/(1+0.15·callers)`：`facingOpenMultiway` 在
  `behind` taper 之外再乘的 caller squeeze；对非负有限 caller 严格单调、不塌 0。
- role 从锚点显式保留（tapered 的 value 仍是 value，不会因缩窄被误标为 bluff）。

锚点对应关系：`limped → ISO_RANGES[positionGroup]`；`facingOpenMultiway`（非 BB）→
`COLD_3BET_*[openerGroup] + CALL_VS_OPEN[positionGroup]`、（BB）→ `BB_DEFEND[openerGroup]`；
`facing3Bet → FACING_3BET_4BET + FACING_3BET_CALL`；`facing3BetCold → COLD_3BET_COLD`；
`facing4BetPlus → FACING_4BET_PLUS`。

### 11.2 路由与门控

- 统一前置门禁（见 §6）：flag 开 + `historyComplete` + `headcountReliable` +
  `2..9` + `behindUnacted` 有限 + `heroActive` + `heroToAct`。统一门禁在所有 spot
  分派**之前**，任何 spot 都绕不过 hero 当前行动门控。
- 非 HU（`headsUp` 一律回退，见 11.3）。
- `limped`：无加注、本轮不可能重开，故用历史推断的 pending，不强制
  `needToActTracked`。
- `facingOpenMultiway` / `facing3Bet` / `facing3BetCold` / `facing4BetPlus`：桌上有加注，
  必须 `needToActTracked` 且 pending 列表非空并含 hero，与 `facingOpen` 一致。
- `<20BB` 仍短路到 `SHORT_JAM_RANGES`（位置组 shove），与自适应无关；派生图不改变
  短码语义。

### 11.3 HU limped 有意保持 legacy

`adaptivePreflopAvailable` 的 `limped` 分支对 `headsUp` 返回 `false`，这是**有意的设计
决定，不是功能缺口**：HU BB 面对 SB limp 与多人 ISO 不是同一语义；`ISO_RANGES` 是位置组
（非 HU）表，FRLA/HU 子集也没有 HU limp-iso 锚点，把多人锚点搬进 2 人桌没有依据。第一步
契约已把 HU BB-facing-raise 固定为 legacy，HU limped 同理。若判定应改，需要新增
HU limp-iso 锚点而非改 gate。测试断言 HU limped 在 flag on/off 下宽度一致。

### 11.4 偏离与未决

- 派生图的宽度缩放（`continueWidthScale` 的 0.08、`multiwayWidthScale` 的 0.15）仍是
  **启发式系数，未由 solver 数据拟合**；只保证单调、保守，不得当作已求解值。
- `<20BB` 的 sizing / 短码适配未做；`limped` 的短码仍走 `SHORT_JAM_RANGES`。
- 第三步不改变 sizing（`raiseTo` 仍按既有规则），`sizing 随 openSizeBB 自适应` 仍属后续。
- 多人 limped 的 callback：`facingOpenMultiway` 的 caller squeeze 用 `ctx.callers`，未区分
  caller 位置质量，属粗粒度近似。
