# 人数自适应翻前范围 —— 第一步（RFI / HU）

- 状态：已实现，flag 默认关闭（`adaptivePreflop=false`），不改变现有行为
- 关联代码：`packages/agent-core/src/preflopCharts/**`、`preflopPolicy.ts`、`ruleStyles.ts`
- 数据来源：`~/dev/preflop-trainer/data/external/{frla-gto-nl100,mhl-nl100}`
- 验收测试：`packages/agent-core/test/preflopAdaptive.test.ts`（27 例）

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

`frlaBbDefend.ts` 是为第二步（面对 open 的防守）预落的数据种子，第一步未接入
`buildMix`。

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

- `RuleParams` 新增 `adaptivePreflop: boolean`，四个 preset 均 `false`；
  `parseRuleConfig` 单独按布尔解析（不进数值 `PARAM_RANGES`）。
- `buildMix(ctx, params)`：先试 `buildAdaptiveMix`，返回 `null` 时回退
  `buildLegacyMix`（原 `RFI_RANGES`/`RFI_MARGINAL`/`ISO_RANGES`/`BB_DEFEND`/
  `CALL_VS_OPEN`/`FACING_3BET_*` 全部原样）。
- 自适应可用条件（`adaptivePreflopAvailable`）：flag 开 + `spot==='unopened'` +
  `historyComplete` + `headcountReliable` + `2<=dealtCount<=9` +
  `behindUnacted` 有限 + HU 时 `actorSlot===1`、否则 `1<=actorSlot<=8`。
  第一步只接 unopened（RFI / HU）。
- 缓存键 `preflopMixCacheKey` 含 `spot|position|openerGroup|dealtCount|actorSlot|
  openerSlot|raises|callers|round(stackBB)|route`，其中 `route = adaptivePreflopAvailable(ctx, params) ? 'adaptive' : 'legacy'`。
  **必须编码最终路由而非 flag**：flag 只表示"允许"，实际路由还取决于
  `historyComplete`/`headcountReliable`/`spot`/`dealtCount`/`actorSlot`。若只放
  `A/L`，则"flag 开 + 历史完整（走 adaptive）"与"flag 开 + 历史不完整（应回退
  legacy）"会生成同一 key，先入 `mixCache` 者污染另一个，直接破坏"失败全回退旧表"。
- `<20BB` 仍由 `effectiveFrequencies → shortStackMix` 短路到 `SHORT_JAM_RANGES`，
  与自适应无关。
- `role:'value'` 的值续叫语义不变：value 只会在 raise/call 之间移动，绝不 fold。
- **已知限制（step-2 必修）**：`actedSeats = Set(actionHistory.map(a => a.seat))`
  只记录"某人行动过"，不区分该座在当前下注轮是否仍欠行动。翻前行动轮可被加注
  重开（已 call 者在面对 3-bet 时需再次行动），因此一旦出现 raise，该集合会高估
  "已完成行动"的人数、低估 `behindUnacted`。第一步只把 `behindUnacted` 用于
  `unopened`（此时无人行动），该误差暂不生效；第二步接入面对 open 的防守前，
  **必须**改为基于当前下注轮 / 服务器 `needToAct` 的判据。代码中
  `preflopPolicy.ts` 的 `actedSeats` 处已有对应 NOTE。

## 7. 回退证明

`test/preflopAdaptive.test.ts` 断言：

- `adaptivePreflop=false`、`historyComplete=false`、无 `seatOrder` 时
  `adaptivePreflopAvailable === false`；
- flag 关时 9-max UTG 宽度 == `parseRange(RFI_RANGES.UTG).combos/1326`
  （10.26%），且 flag 开时宽度不同（12.66%）；
- flag 开时 `<20BB` 的 `22` 仍 fold、`AA` 仍 raise（走 `SHORT_JAM_RANGES`）；
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
- 现有 `packages/agent-core` 全部测试不变（含本文件，全绿）。

## 8. 偏离与说明

1. HU 数据来自 MHL **源码** `source/ranges.js` 的 `HU.SB_OPEN`，而非抽取后的
   `ranges.json`（后者未收录 HU spot）。provenance 指向源码文件。
2. `game.openSizeBB` 仅作为元数据记录（HU / 6-max 2.5bb），**未**修改
   `rulePolicy.preflopAction` 的实际加注额（仍沿用既有 sizing）。sizing 自适应
   留到后续步骤，避免破坏现有规则测试。
3. 第一步自适应只覆盖 unopened。`frlaBbDefend.ts` 已落盘但未接入。
4. B8 用公式得 12.66%，规格写 12.60%（0.06pt，在 0.5pt 容差内）。

## 9. 第二步建议

1. 接入 `facingOpen` 的 BB / 非 BB 防守：图表按 `openerSlot`（而非 opener 位置名）
   取 `FRLA_BB_DEFEND` / `COLD_3BET`，并用 `behindUnacted` 调整防守宽度。
2. 处理多人 limped pot / 多个 caller 的 `activeCount` 影响。
3. 让 sizing 随 `game.openSizeBB` 自适应（HU 2.5bb），并补 `raise` vs `allin`
   在短码段的映射。
4. 给 chart 加持久化/自检（schema 校验、169 格和=1），并考虑把抽取脚本纳入
   仓库工具目录以保证数据可复现。
