# 开源扑克 bot / 规则型扑克 AI 调研：可借鉴清单与取舍建议

> 调研日期：2026-10-05
> 范围：**只读调研**，不改任何产品代码。对象是我方 `packages/agent-core` 的纯启发式 NLHE 机器人 `rules-v1`（明确不引入 CFR / MCTS / 神经网络求解器）。
> 说明：本文链接与「是否有代码 / 许可证」均以本次真实检索为准；未能核实的一律标注「未核实」，请不要把未核实项当结论。

---

## 0. 结论摘要（可借鉴 Top N 与优先级）

我方现状（已核对源码）：翻前 `preflopRanges.ts` 是手工范围表 + 位置分组（EP/MP/LP/SB/BB）+ 权重混合频率，短筹走 `SHORT_JAM_RANGES`；翻后 `postflopPolicy.ts` 用条件范围 equity vs pot odds 主决策、MDF 边界混合、纹理决定 33/50/75/125% 尺度、手写 `blockerScore` / `rangeAdvantage` 启发式；对手建模在 `sessionMemory.ts` 用原始 VPIP/PFR 计数 + `exploitMultiplier` 阈值限幅；评测 `apps/server/test/botPlaytest.mjs` 已产出 bb/100、分风格 VPIP/PFR、风格区分度。

在「不引入求解器/神经网络」约束下，真正高性价比的可移植思想，按优先级排序：

| 优先级 | 可借鉴项 | 来源思想 | 落地位置（我方） | 预估工作量 |
|---|---|---|---|---|
| **P0** | **Duplicate 对局 + 确定性洗牌** | ACPC duplicate poker / common seeds | `botPlaytest.mjs` + 服务端发牌注入 seed 的能力 | 3–6 人日 |
| **P0** | **Dirichlet/收缩估计对手模型**（取代 `sampleHands<10` 硬阈值） | Bayes' Bluff（Southey 2005） | `sessionMemory.ts` + `postflopPolicy.exploitMultiplier` | 2–4 人日 |
| **P1** | **下注尺寸网格 + 对手怪尺码的最近邻翻译** | Gilpin/Sandholm 下注抽象；Slumbot `nlt5` 配置 | `postflopPolicy.chooseBetFraction`、`rulePolicy.raiseTo` | 3–5 人日 |
| **P1** | **牌力分桶（made-hand × draw，24 桶）用于范围/percentile/诈唬判定** | 期望值/潜在值抽象（Gilpin 08、Johanson AAMAS13） | `postflopPolicy` 的 percentile / villain 模型 | 4–8 人日 |
| **P1** | **用加权 MC 实算 range/nut advantage，替代 flag 启发式** | 范围 vs 范围 equity；DeepStack/Pluribus 的 range 表达 | `equity.ts` 已支持 `villainRange`，可直接复用 | 3–6 人日 |
| **P1** | **评测升级：成对 round-robin + bootstrap CI + 基线 bot** | ACPC / LBR / 常见 baseline（always-call / equity bot） | `botPlaytest.mjs` | 4–8 人日 |
| **P2** | **all-in EV 结算（无后续街时按全跑马均值）** | ACPC all-in equity | `botPlaytest.mjs` 结果聚合 | 2–3 人日 |
| **P2** | **翻前 chart 数据自建与溯源（位置/筹码深度/动作尺寸）** | 用 MIT 许可 solver 离线一次性生成 | `preflopRanges.ts`（数据层） | 5–10 人日 |
| **P2** | **统计口径扩展**（c-bet / fold-to-cbet / WTSD / 位置分桶） | 对手建模文献常见做法 | `sessionMemory.ts` | 3–6 人日 |
| **P3** | **LBR 式可剥削性下界探针（仅 HU 模式）** | Lisy & Bowling 2017（arXiv:1612.07547） | 新 study harness | 10+ 人日 |

一句话取舍：**先抄评测与对手建模的「方法论」，再反思路与尺度的「离散化」，最后才考虑翻前数据。** 求解器/网络类项目只作为「对照与评测靶子」，不引入我们的决策环。

---

## 1. 项目盘点表

> 活跃度以本次检索到的 GitHub 数据为准（stars / 最近活动），会随时间变化；标「未核实」的请二次确认。
> 类别：**Bot** = 完整可玩 NLHE bot；**Env** = 框架/环境/库；**Solver** = 求解器；**Paper** = 只有论文/伪代码；**Legacy** = 过时工程。

| 名称 | 类别 | 链接 | 活跃度（检索值） | 代码可得性 | 许可 | 备注/能否借鉴 |
|---|---|---|---|---|---|---|
| **Slumbot** | Bot | https://slumbot.com/ ；代码 https://github.com/ericgjackson/slumbot2019 | ~171★，MIT | 完整（CFR+ / MCCFR，含抽象与 BR 评估） | **MIT** | 允许借鉴代码思想；slumbot.com 提供公开 HTTP API `/api/new_hand` `/api/act`，可作外部评测靶子 |
| **Slumbot 2017** | Bot | `ericgjackson/slumbot2017`（未核实是否公开独立仓库） | 未核实 | 未核实 | 未核实 | slumbot.com 实际运行版本，仅作参考 |
| **G5** | Bot | https://github.com/Nemandza82/g5-poker-bot | ~24★；ACPC 2018 六人桌 NLHE 冠军、2017 HU 亚军 | 完整（C++ 决策 + C# 客户端） | **MIT** | 强 bot，但工程栈旧（VS2017/.NET Core 1.x），主要借评测与抽象思路 |
| **DeepStack-Leduc** | Bot（缩小版） | https://github.com/lifrordi/DeepStack-Leduc | ~945★ | 完整但**仅 Leduc**，需 Torch7/Lua | 未核实（仓库未见标准 license） | HUNL 版未开源；Leduc 版可作算法学习，环境已死 |
| **DeepHoldem** | Bot（不完整） | https://github.com/happypepper/DeepHoldem | ~221★ | 代码在，**训练好的网络未发布** | 未核实 | 扩展 DeepStack 到 HUNL，但缺网络 → 非开箱可用 |
| **DeepStack** | Paper | https://www.deepstack.ai/ / Science 2016 | — | **无官方 HUNL 代码** | — | 训练/推理思想（re-solving、value net）作背景 |
| **Libratus** | Paper | Science 2017 | — | **无代码**（商业授权 Strategic Machine） | — | 仅论文 |
| **Pluribus** | Paper + 非官方复刻 | 论文 https://www.science.org/doi/10.1126/science.aay2400 ；复刻 `whatsdis/pluribus` ~238★、`keithlee96/pluribus-poker-ai` ~351★（GPL/Other）、`zanussbaum/pluribus`（未完成） | 官方无代码，补充材料给伪代码 | 非官方 | 官方 code 与 pseudocode 明确不发布（商业原因） | 只借「blueprint + 实时搜索」的宏观结构与评测方法；**不要抄复刻代码**（许可/质量均不稳） |
| **OpenSpiel** | Env + 算法 | https://github.com/google-deepmind/open_spiel | ~5.4k★，活跃 | C++/Python，`universal_poker` 基于 ACPC server，2–10 人可配置 NLHE | **Apache-2.0** | 作环境/对照训练用；`universal_poker` 下注抽象偏固定（fold/call/pot/all-in，见 PR #97）|
| **RLCard** | Env + 预训练规则 bot | https://github.com/datamllab/rlcard | ~3.5k★，MIT | 有 `no-limit-holdem` 环境（动作抽象为 fold/check-call/half-pot/pot/all-in）与 `limit-holdem-rule-v1` 规则模型 | **MIT** | NLHE 只有环境，无强 NLHE 规则 bot；可借状态/动作编码与规则 bot 基线 |
| **PokerRL** | Env + 评估 | https://github.com/EricSteinberger/PokerRL | ~（2019 起）未核实 | 多智能体 deep RL 框架，**含 Exact BR / LBR / RL-BR / H2H 评估实现** | 未核实 | 评估方法章节很有参考价值；TF1 时代，工程过时 |
| **PokerKit** | Env/库 | https://github.com/uoftcprg/pokerkit | ~474★，MIT | 纯 Python，游戏模拟 + 牌力评估 + 统计；**无内置 bot 策略** | **MIT** | 可作离线验证/数据生成/规则一致性对照；不是 bot |
| **ACPC project_acpc_server** | Env/协议 | https://github.com/ethansbrown/acpc （`project_acpc_server`） | 老（2016 归档） | 有 dealer + `example_player`（随机） | **Other/自定义**（学术用途，条款未核实） | 只作 ACPC 协议与 duplicate 评测的参考实现 |
| **Open Pure CFR** | Solver（ACPC） | `rggibson/open-pure-cfr`、`moscow25/open-pure-cfr-buckets` | 老 | 完整 | 未核实 | 小游戏 CFR 教学用 |
| **TexasSolver** | Solver | https://github.com/bupticybee/TexasSolver | ~2.5k★ | 完整 | **AGPL-3.0** | **AGPL 传染**：不要贴进产品代码；仅离线生成数据需谨慎并单独评估 |
| **wasm-postflop** | Solver | https://github.com/b-inary/wasm-postflop | 开发已暂停 | 完整（浏览器 WASM） | **AGPL-3.0** | 同上，参考 UI/实现，不复制 |
| **amaster97/poker_solver** | Solver | https://github.com/amaster97/poker_solver | 新（2026-05，3★） | 完整（Python+Rust，含翻前 blueprint，256/128/64 桶） | **MIT** | 许可证最友好，适合离线生成翻前 chart；成熟度低，需自验 |
| **OpenHoldem / WinHoldem** | Legacy | https://github.com/OpenHoldem/openholdembot | ~254★，老（2015） | 完整（屏幕抓取 + 自动点击） | **GPL-3.0** | **不要借鉴**：屏幕抓取、ToS 违规、GPL 传染 |
| **ACPC 历年参赛 bot** | Bot/Paper | ACPC 结果站 http://www.computerpokercompetition.org/ | 近年是否仍办**未核实** | 多数未开源 | — | 历史 bot 论文/结果可作背景 |

**分类小结**
- **完整可用 NLHE bot**：Slumbot、G5（+ Slumbot 2017 未核实）。
- **框架/环境**：OpenSpiel、RLCard、PokerKit、PokerRL、ACPC server。
- **Solver**：TexasSolver、wasm-postflop、amaster97/poker_solver、Open Pure CFR。
- **只有论文/伪代码**：DeepStack（HUNL）、Libratus、Pluribus。
- **Legacy/避坑**：OpenHoldem/WinHoldem、DeepStack-Leduc（Torch7）。

---

## 2. 可移植思想逐条（含落地建议与工作量）

### 2.1 【P0】Duplicate 对局 + 确定性洗牌

**来源**：ACPC 的 duplicate poker + common seeds（AI Magazine / computerpokercompetition.org 规则页）。做法是同一手牌在互换座位后再打一遍（多人桌为所有排列），把两手结果平均，抵消发牌运气；再叠加「所有对阵使用同一组牌」的 common-seed 降低跨对手方差。

**为何适合我们**：`botPlaytest.mjs` 现在明确写着 `SEED seeds the policy RNG only; the deal uses server randomness, so hands are not reproducible run to run`。这意味着小样本 bb/100 几乎不可比（poker 方差极大）。

**落地建议**：
1. 给服务端发牌器加一个**可注入的确定性洗牌**（仅测试/playtest 路径，生产保持 CSPRNG）。参考 ACPC dealer 的 `flow`/`deck` 设计，或最少改法：用 `SEED` 派生一个 Fisher-Yates（与现有 `mulberry32` 一致）。
2. `botPlaytest.mjs` 增加 `DUPLICATE=1` 模式：同一 `(seed, handIndex)` 生成的牌，按 seat 轮换重复 N 次（HU 2 次；N 人桌可只做「镜像一手」而不做全排列，成本可控）。
3. 报告增加 **duplicate 配对差值**（每对平均）而非仅原始 bb/100，并给出**标准误/置信区间**。

**工作量**：3–6 人日（主要成本在服务端洗牌注入 + 报告聚合）。
**风险**：服务端发牌涉及真实货币/账本安全，务必只走测试注入路径，不要在生产开通「可预测洗牌」入口。

---

### 2.2 【P0】Dirichlet / 收缩估计的对手模型

**来源**：Bayes' Bluff（Southey et al., UAI 2005, arXiv:1207.1411）。核心：把对手在每个情境的动作概率视为多项分布，用 Dirichlet 先验 + 观测更新后验；后验均值天然实现「小样本向先验收缩」。

**为何适合我们**：现在 `sessionMemory.ts` 只记原始计数，`postflopPolicy.exploitMultiplier` 用 `stats.sampleHands < 10` 直接忽略、且只按 VPIP/PFR 三档（station/nit）限幅。样本 9 和样本 10 之间是断崖，且小样本噪声被浪费。

**落地建议**：
1. 在 `sessionMemory.ts` 保留原始计数即可，新增一个纯函数把计数映射为**后验均值**：
   `p̂ = (k + α) / (n + α + β)`，`α,β` 由先验均值与「先验强度」`m` 决定（如 VPIP 先验 0.28、`m=20`）。
2. 用后验均值替代原始比值，并给 `exploitMultiplier` 输入一个**置信度权重**（如 `n/(n+m)`），样本少时自动退回中性 1.0，样本多时才放大偏离。这比现在的硬阈值平滑得多。
3. 把「限幅反剥削」写成文档化的上下界（现在 clamp 到 [0.4,1.4] 已是雏形），并加测试钉住「小样本 == 中性」。

**工作量**：2–4 人日。
**收益**：更早利用弱读、避免小样本过拟合，且完全不需要求解器。

---

### 2.3 【P1】下注尺寸网格 + 怪尺码最近邻翻译

**来源**：Gilpin & Sandholm 的 discretized betting model / action translation；Slumbot `nlt5_params` 的 `Target*PotFracs` / `Opp*PotFracs` 配置（见 slumbot2019 issue #43 的讨论）。

**为何适合我们**：我方翻后尺度是 `33/50/75/125%` 规则挑选，翻前 `raiseTo` 是 2.5x/3x/2.2x 的固定倍数。缺的是**明确的尺寸网格**与**对对手非标准尺寸的翻译**（对手开 2.7x 我们该怎么读）。

**落地建议**：
1. 定义两个常量网格：翻前 `open {2.2, 2.5, 3.0}x, 3bet {3.0, 3.5, 4.0}x IP/OOP, 4bet {2.2}x`；翻后 `{0.33, 0.5, 0.75, 1.0, 1.5, all-in}`，并加**几何尺寸**（按 SPR 均分到河牌的 `g` 满足 `pot*(1+2g)^k ≈ stack`）。
2. 增加 `snapToGrid(actualFraction)`：对手下注落在两个网格点之间时，按「比值更接近谁」翻译（Gilpin 的最近邻规则），而不是忽略。
3. 把范围表按「面对的动作尺寸」分桶（例如 vs 小注/大注/all-in），至少给 `chooseVillainModel` 增加尺寸到 range tier 的映射层。

**工作量**：3–5 人日。
**收益**：对抗会调尺寸的强对手时不至于「看不懂」，也为后续 chart 数据留统一坐标。

---

### 2.4 【P1】牌力分桶（made-hand × draw）

**来源**：期望值 / 潜在值抽象（Gilpin & Sandholm AAAI-08；Johanson et al. AAMAS 2013；Ganzfried & Sandholm EMD 版）。结论：**粗抽象时按期望强度分桶即可，中等/细粒度时按「未来强度分布」分桶更好**。社区里已有可直接照搬的粗桶方案，例如 `justinsiek/hhana` 的 `(made_hand 0..5, draw 0..3)` 共 24 桶。

**为何适合我们**：我方 `postflopPolicy` 已有一套 `villainStrengthTier` 的连续打分（0–1）和牌型 `HandEval`，但没有**离散桶**；诈唬候选判断靠 `percentile < 0.6 && (draw || blocker)`，阈值魔数偏多。

**落地建议**：
1. 定义显式桶函数 `bucket(hole, board) -> {made, draw}`（made: air/weak pair/medium/strong pair/two pair/strong made；draw: none/weak/strong/combo）。
2. 用桶替代/补充 percentile 阈值，让「value / semibluff / air」的判定可测试、可解释。
3. 可进一步对每个桶做**离线期望**统计（用现有 `estimateEquity` 跑一次「该桶 vs 随机范围」的均值，缓存成常量表），这就得到「期望值抽象」的精髓——不需要求解器。

**工作量**：4–8 人日（含回归测试）。
**注意**：不要引入 EMD/k-means 训练管线（那是求解器工程），只借「桶」这个离散化思想。

---

### 2.5 【P1】用加权 MC 实算 range / nut advantage

**来源**：范围 vs 范围 equity 是 DeepStack/Pluribus 的核心表达；LBR 也用「对手 range 的贝叶斯更新」定最佳响应（Lisy & Bowling 2017）。

**为何适合我们**：`rangeAdvantage` 现在是 `heroWasAggressor/inPosition/aceHigh/lowConnected` 拍出来的 [-1,1] 分数；`blockerScore` 是按 A/K/同花/顺子手工加分。二者都可用已有工具变成**可计算量**。

**落地建议**：
1. 复用 `equity.ts` 的 `villainRange`（支持 `combos` 或 `weightFn`）：用 2.2 得到的对手后验 / 动作尺寸 -> 构造 villain 范围。
2. **range advantage**：对 hero 范围与 villain 范围分别 MC 出「对随机手的权益分布」，取均值差（或高分位差即 nut advantage）。挂到 `chooseBetFraction` / `chooseVillainModel` 的输入上。
3. **blocker**：对 villain 继续范围里的每个 combo，若包含我方某张牌则减少其权重；用「被挡掉的 combo 强度之和 / 范围总权重」计算，替换手写 `blockerScore`。

**工作量**：3–6 人日（`equity.ts` 已具备大半能力）。
**性能**：注意 MC 采样数（现有 HU 128 / 多路 64）；范围加权抽取已有二分累积权重实现，成本可控。

---

### 2.6 【P1】评测机制升级（见第 4 节详述）

见下。

---

### 2.7 【P2】翻前 chart 数据自建与溯源（见第 3 节详述）

见下。

---

### 2.8 【P2】统计口径扩展

**来源**：对手建模文献（Huang 2012 学位论文；Bayes' Bluff）普遍按情境分别建分布，而不是只用一个总 VPIP。

**落地建议**：在 `sessionMemory.ts` 的 `OppHandObs` 增加：c-bet 频率、fold-to-cbet、WTSD（摊牌率）、按位置/是否 IP 分桶、3bet 频率。全部是公开信息，采样成本低。

**工作量**：3–6 人日。

---

### 2.9 【P3】LBR 式可剥削性下界（仅 HU）

**来源**：Lisy & Bowling, *Equilibrium Approximation Quality of Current No-Limit Poker Bots*, arXiv:1612.07547。LBR 用对手策略的**动作概率**做贝叶斯 range 更新，然后每步取「局部最优」动作，得到可剥削性下界（论文显示多个抽象 CFR bot 可被 LBR 打到比「每把直接弃牌」还差 3+ bb/手）。PokerRL 有 LBR 的工程实现可参考。

**为何难**：需要策略能对任意私牌给出动作分布，且是 HU；我方是 9-max 为主。
**建议**：作为研究 harness，先只在 HU 模式做，用来横向比较 `rules-v1` 各风格版本——**能发现启发式的隐藏漏洞**，但成本高。

**工作量**：10+ 人日，非必须。

---

## 3. 范围表 / preflop chart 数据源

### 3.1 可直接/谨慎可用的公开来源

| 来源 | 内容 | 许可证/条款 | 可用性判断 |
|---|---|---|---|
| **amaster97/poker_solver** | HUNL 翻前 blueprint（169 手类 × 多深度），MIT | **MIT** | 许可最友好；新项目需自验正确性 |
| **社区 chart 仓库**，如 `AHTOOOXA/poker-charts`（MIT 代码）、`mark3543634/preflop-trainer`（MIT，注明数据来源 `pekarstas` community charts）、`notnaone/rangeviewer`（600+ charts，**许可证未核实**）、`JohanPeraldi/poker-range-manager`（MIT，用户自建） | RFI / vs-open / vs-3bet / vs-4bet，多位置多深度 | 代码 MIT；**底层数据来源与版权需逐个核实** | 可用于「标准范围形状」对照；不得默认其等价 GTO |
| **公开论文/教材**（如 The Mathematics of Poker、Morton 定理推/弃表） | 概念与数学结论 | 事实/方法不受版权保护，但**具体表格的整理可能受版权** | 可据方法自己算，不直接复制表格 |
| **自建**：用 MIT 许可 solver（amaster97/poker_solver）离线跑一次，导出 JSON 入库 | 完全自有，可溯源 | 自有数据 | **推荐**：一次性投入，长期可控 |

### 3.2 明确不可用

- **GTO Wizard**：ToS §7.5 明确「不得将服务下载/获取的范围、树、图表用于商业化或第三方应用」；§7.4 限定只能分析本人牌局。其 **Benchmark API ToS** 进一步禁止 scraping / 系统化查询 / 「Model Distillation（用其数据训练第三方 AI 或 solver）」。
- **爬取类仓库**（如 `mtpham99/gtowizard_scrape_public`）：直接违反上述条款且涉及版权，**禁止使用**。
- **其他商业 chart app**（如 Preflop Wizard）ToS 禁止抓取/再分发/训练模型。

> 结论：**不要碰任何爬取/商业来源**。宁可用 MIT solver 自建，或把现有手工基线标注为「标准形状近似」。

### 3.3 我方手工基线相对 GTO Wizard 的差距

| 维度 | 我方现状 | 商业 GTO 数据 | 差距影响 |
|---|---|---|---|
| 位置粒度 | 5 组（EP/MP/LP/SB/BB），6-max 复用满员锚点 | 每个真实位置 | 中：混桌对位略失准 |
| 筹码深度 | >=80BB 基线 + 粗略收紧 | 逐深度、含 ante/ICM | 中：短筹尤其明显 |
| 动作尺寸 | 开放式倍数，非按尺寸分节点 | 每节点每个尺寸 | 中高 |
| 频率 | 手写权重/混合 | solver EV 驱动混合 | 中：EV 损失但可玩 |
| 多人底池 | 手工收紧 + 采样 | 多路专门求解 | 高：多人底池最弱 |

结论：作为**产品内的对手 AI**，手工近似够用；但若定位「教学/GTO 对照」，必须自建数据并明确标注，不可宣称 GTO。

---

## 4. 评测机制建议（引入到 `botPlaytest.mjs`）

### 4.1 值得引入

1. **Duplicate 对局（最高优先）**：见 2.1。ACPC 用 duplicate 抵消发牌运气，是扑克评测的行业惯例。
2. **Common seeds 跨对手**：同一组牌对所有风格各打一遍，才能在同一批牌上比较风格差异（现在 `botPlaytest.mjs` 明确做不到）。
3. **All-in equity 结算**：ACPC 规则页说明，当双方 all-in 无后续决策时，用「所有可能河牌的期望」而非单条河牌结算，可大幅降方差。可在 `botPlaytest.mjs` 的 result 聚合层实现。
4. **成对 round-robin + bootstrap 显著性**：ACPC 用 bootstrap 判断「谁显著强于谁」。我们可输出**成对胜负矩阵** + 每对 bb/100 的 bootstrap 置信区间，替代单一聚合 bb/100。
5. **基线 bot 集**：`always-fold`、`always-call`、纯 equity（pot-odds）bot。社区中 `Gongsta/Poker-AI` 就实现了这类对照（其纯 equity 启发式对 Slumbot 约 -204 BB/100）。有了基线才知道 `rules-v1` 到底强多少。
6. **统计量与样本量纪律**：现有 per-style VPIP/PFR/bb/100 保留；补**标准误**与「需要多少手才能分辨」的提示。现在报告已正确注明「bb/100 descriptive only at this sample size」，可升级为量化 CI。
7. **风格区分度**已有 `vpipSpread/pfrSpread/foldSpread`，建议从「报告」提升为**软门禁**（如低于阈值告警），防止后续调参把风格调没了。

### 4.2 可选（成本高）

- **LBR / exploitability**：只对 HU 有意义，且要求策略可导概率；见我方可解释的 `frequencies`（`PreflopChoice.frequencies` 已导出）。作为研究项，不进 CI。
- **ACPC 协议对接**：让 `rules-v1` 通过 ACPC dealer 与外部 bot 对打。工程量大、协议老；除非要与公开 bot 对战，否则不必。

### 4.3 对 `botPlaytest.mjs` 的具体改造点

- 发牌确定性：新增测试专用洗牌注入（见 2.1）。
- result 聚合：新增 duplicate / all-in-EV 两种模式，报告同时给 raw 与 duplicate 两列。
- 报告：新增 pairwise matrix + bootstrap CI；保留现有 ledger/attribution 完整性门禁（这些是很好的工程实践，勿删）。
- 基线：内置 `always-fold` / `always-call` / `equity-only` 三种 `policyKind`（可复用 `stylePolicy`/`scriptedPolicy` 的骨架）。

---

## 5. 避坑清单（明确「不要借鉴」）

1. **屏幕抓取型 bot（OpenHoldem / WinHoldem）**：靠 OpenScrape 解析像素、Autoplayer 自动点击，**明确违反在线平台 ToS**、易被检测封号，且工程陈旧（MFC/C++，2015）。我方是在自有 app 内跑 agent，与此无关——**既不需要也不应借鉴**。
2. **许可证传染**：
   - **GPL/LGPL/AGPL 代码不可粘贴进产品**。已知：OpenHoldem = GPL-3.0；`keithlee96/pluribus-poker-ai` = GPL/Other；TexasSolver = **AGPL-3.0**；wasm-postflop = **AGPL-3.0**。AGPL 连「通过网络提供服务」都触发开源义务，务必只读代码、抄思想，不抄实现。
   - Slumbot2019 / RLCard / PokerKit / OpenSpiel / G5 / amaster97 = MIT 或 Apache-2.0，可安全参考（仍建议遵守署名）。
   - `DeepStack-Leduc`、`PokerRL` 等**未核实 license**，引用前先确认。
3. **商业 chart 数据版权**：GTO Wizard / Preflop Wizard 等 ToS 明令禁止再分发与训练蒸馏；爬取仓库直接侵权。**下载即风险**。
4. **过时工程**：DeepStack-Leduc（Torch7/Lua，环境基本不可复现）、PokerRL（TF1 时代）、Solver `bupticybee/TexasSolver` 强依赖 C++ 构建。**只借算法思想，不引入依赖**。
5. **「论文即代码」的误判**：DeepStack(HUNL)/Libratus/Pluribus 官方都**没有发布 HUNL 代码**（Pluribus 明确因商业风险不发布）。网上同名复刻多为个人尝试，质量/许可参差，勿当权威。
6. **抽象平衡的陷阱**：LBR 论文证明「抽象博弈的 Nash 均衡」可能比直接弃牌还差，且**增加桶数不一定更安全**（Bowling et al. 的 abstraction pathologies）。我们做启发式分桶时不要幻想「分得越细越接近 GTO」。
7. **多人桌直接套 HU 结论**：CFR/Nash 的 HU 解不直接适用于 6–9 人（Pluribus 用 blueprint + 搜索专为多人设计）。我们的多路 equity 采样路线是对的，别改回「只用 HU 表」。
8. **宣称 GTO**：手工 chart + 启发式 = 近似，**产品文案/内部报告都不要写「GTO」**，避免合规与预期风险。

---

## 6. 来源分级

**官方文档 / 一手仓库 README**
- OpenSpiel：https://github.com/google-deepmind/open_spiel （Apache-2.0，games.md 的 universal_poker）
- PokerKit：https://github.com/uoftcprg/pokerkit （MIT）
- RLCard：https://github.com/datamllab/rlcard （MIT，docs/games.md 动作编码）
- Slumbot：https://slumbot.com/ 与 https://github.com/ericgjackson/slumbot2019 （MIT；API 示例见 Gongsta/Poker-AI `slumbot/slumbot_api.py`）
- G5：https://github.com/Nemandza82/g5-poker-bot （MIT）
- GTO Wizard 条款：https://gtowizard.com/terms/ 与 https://gtowizard.com/benchmark/terms
- ACPC 服务器：https://github.com/ethansbrown/acpc

**论文 / 学术（一手）**
- Lisy & Bowling, *Equilibrium Approximation Quality of Current No-Limit Poker Bots*, arXiv:1612.07547（LBR）。
- Southey et al., *Bayes' Bluff: Opponent Modelling in Poker*, UAI 2005, arXiv:1207.1411。
- Gilpin, Sandholm & Sørensen, *Potential-aware Automated Abstraction of Sequential Games*, AAAI-08；Gilpin & Sandholm, *Expectation-Based vs Potential-Aware Automated Abstraction*, AAAI-08。
- Johanson, Burch, Valenzano & Bowling, *Evaluating State-Space Abstractions in Extensive-Form Games*, AAMAS 2013。
- Bowling et al., *The Annual Computer Poker Competition*, AI Magazine 34(2)（duplicate / common seeds / bootstrap）。
- Brown & Sandholm, *Superhuman AI for multiplayer poker* (Pluribus), Science 2019；DeepStack, Science 2016。
- Bard et al., *Practical Control Variates for Agent Evaluation*（baseline 方差缩减）。

**二手 / 社区（需交叉验证）**
- 各复刻仓库的 README 与 issue（如 `whatsdis/pluribus`、`happypepper/DeepHoldem`）。
- 社区 chart 仓库（`AHTOOOXA/poker-charts`、`notnaone/rangeviewer` 等）——**许可证与数据来源需逐个核实**。
- `justinsiek/hhana` 的桶方案、`mark3543634/preflop-trainer` 的数据溯源说明（作为「社区共识形状」，非权威）。

**未核实项（写进结论前请确认）**
- Slumbot 2017 是否为独立公开仓库及其许可。
- PokerRL 的许可证。
- DeepStack-Leduc 的许可证。
- `notnaone/rangeviewer` 等 chart 仓库的数据来源与再分发许可。
- ACPC 近年（2020 后）是否仍在举办。
- `amaster97/poker_solver` 的正确性与翻前 blueprint 数据是否可商用。

---

## 7. 可执行的下一步建议清单

> 建议顺序即优先级；每项都可独立验收，且全部不需要引入求解器/神经网络。

1. **[P0] 确定性发牌 + duplicate 评测**（3–6 人日）
   - 服务端测试路径可注入 seed 洗牌；`botPlaytest.mjs` 增加 `DUPLICATE=1`。
   - 验收：同 seed 两次运行的手牌序列一致；报告输出 duplicate 配对均值与 CI。

2. **[P0] 对手模型收缩估计**（2–4 人日）
   - `sessionMemory.ts` 增后验均值纯函数；`exploitMultiplier` 改用后验 + 置信度权重。
   - 验收：`n=0` 时行为与中性完全一致；新增单元测试钉住收缩单调性。

3. **[P1] 评测基线 bot + 成对 round-robin**（4–8 人日）
   - 内置 always-fold / always-call / equity-only；输出成对矩阵 + bootstrap CI。
   - 验收：`rules-v1` 各风格显著优于 always-call；风格区分度门禁不退化。

4. **[P1] 下注尺寸网格 + 翻译层**（3–5 人日）
   - 翻前/翻后网格常量 + `snapToGrid`；风格参数映射到网格而非散点。
   - 验收：对 2.7x 等非标准尺寸不再「看不懂」；回归测试覆盖边界。

5. **[P1] 牌力分桶 + 加权 range/nut advantage**（7–12 人日，可拆两阶段）
   - 先落 24 桶与 range advantage 实算，再替换 `blockerScore`。
   - 验收：与旧启发式做 A/B，用第 3 项的评测 harness 证明不弱于现状（最好更强）。

6. **[P2] all-in EV 结算**（2–3 人日）
   - 在 result 聚合层对无后续决策的 all-in 用全跑马期望。
   - 验收：与 raw 结算的 bb/100 收敛到同一期望、方差更低。

7. **[P2] 翻前 chart 数据自建与溯源**（5–10 人日）
   - 用 MIT 许可 solver 离线生成 JSON，写入 `preflopRanges.ts` 数据层并记录来源；绝不使用爬取/商业数据。
   - 验收：每张 chart 有 provenance 字段与生成脚本；可复现。

8. **[P2] 统计口径扩展**（3–6 人日）
   - c-bet / fold-to-cbet / WTSD / 位置分桶，全部公开信息、会话内。
   - 验收：对手模型可区分「紧被动」与「松被动」等更细画像。

9. **[P3] HU 模式 LBR 探针**（10+ 人日，可选）
   - 先用 PokerRL 的 LBR 实现作参考，只用于研究不进门禁。
   - 验收：能给出 `rules-v1` HU 各风格的可剥削性下界排序。

---

### 附：一句话取舍

开源世界在「求解器」上很富、在「干净可商用的 NLHE 启发式 bot」上很贫。我们要的不是别人的代码，而是别人打磨过的**评测纪律（duplicate / 基线 / 显著性）**、**对手建模的贝叶斯口径**、以及**把连续决策离散化的方法（尺寸网格 + 牌力分桶）**。把这三样搬进来，`rules-v1` 会明显更稳、更可测，且依然保持纯启发式、无求解器、无神经网络的约束。
