# 翻前范围表 / Preflop Chart 数据来源与获取方案

> 调研日期：2026-10-05
> 前置：`docs/plans/poker-bot-oss-survey.md`
> 目标：为 `packages/agent-core` 的 `preflopRanges.ts` / `preflopPolicy.ts` 手工基线取得 **9-max 100BB**（及其他深度/人数）翻前范围数据。
> 授权前提（用户明确）：**仅本地自用研究**，可抓取商业站点 chart，**不对外发布、不进 git 跟踪、不二次分发**。
> 约束：**只读调研 + 本报告落盘，不改任何产品代码，不 commit/push**。
> 说明：所有链接/许可/数据存在性以本次真实检索为准；未能核实的一律标「未核实」。

---

## 0. 结论与推荐路径

**一句话**：9-max 100BB 结构化、带 per-combo 频率的数据，**最干净且最省事的来源是付费购买 RangeConverter 的 Pio 格式 sim（$99–398）**；免费社区数据只有 8-max MTT / 6-max，可作形状校验但不可当 9-max cash 用；GTO Wizard 是覆盖率最高的权威来源，但 **ToS §7.7 明确禁止任何自动化脚本/请求**，抓取会有封号与（历史上）DMCA 风险，只应作为「授权下的最后手段」。

推荐路径排序（详见 §3）：

| 排序 | 路径 | 覆盖度 | 精度 | 工作量 | 成本 | 风险 | 结论 |
|---|---|---|---|---|---|---|---|
| **1** | **购买 RangeConverter 9-max 100bb Pio ranges**（或自持 PioSolver 脚本求解） | 9-max 100bb 全（含 vs RFI / vs 3bet） | solver 原始频率 | 极低（解析即可） | $99–398/ sim | **无 ToS 风险** | **首选** |
| **2** | 免费社区数据（matthiola0 8-max MTT JSON + Sharkling 免费 chart 抄录 + AHTOOOXA 6-max） | 8-max MTT / 6-max 为主，缺 9-max cash | 中（含混合频率） | 中（清洗） | 0 | 低 | 作形状校验/兜底 |
| **3** | **GTOWizard 本地抓取**（本人订阅 + 客户端 userscript 或 token 抓包） | 9-max cash 100bb+ 全覆盖 | 最高 | 中 | 订阅费 | **ToS §7.7 + 封号 + DMCA 先例** | 授权下最后手段 |
| **4** | MIT 开源 solver 自算（amaster97/poker_solver） | 多人桌翻前弱/无 | 低 | 高 | 0 | 低 | 不推荐用于 9-max |

**关键发现（必读）**
- **GTO Wizard 9-max cash 100bb 确实存在**：官方blog 明确「9Max Cash General; 100BB (ALL SPOTS)」「9max cash 100bb」，rake 5% cap 4BB，并有 Simple/General/2.5x/大小 3bet 多个版本（来源：blog.gtowizard.com，见 §6）。
- **GTO Wizard 无官方范围数据导出 API**。官方支持的是在 Ranges 标签页「Copy ranges in Pio/GTO+ format」**手动逐节点复制**；Benchmark/Research API **只允许打牌拿结果，明确不提供 solver/范围能力**。
- **GTO Wizard ToS §7.7**：「User shall not use any automated requests or any scripts within Service」——**任何脚本化/自动化抓取都违反 ToS**，与是否本地自用无关；§7.5 另禁商用。
- **已有法律先例**：GitHub 仓库 `mtpham99/gtowizard_scrape_public`（公开 GTOW 抓取范围）的 GitHub API 返回 **HTTP 451（Unavailable For Legal Reasons）**，即已被下架处理 → 抓取并再分发 GTOW 数据有明确法律风险。
- **最合规的技术替代**：RangeConverter 付费下载 Pio/Monker 格式（合法购买、结构化、可离线）；或自持 PioSolver/GTO+ 用官方 UPI 文本接口自己求解导出（自有工具，无 ToS 问题）。

---

## 1. 社区 / 开源 chart 数据盘点表

> 判定列：**✅可用** / **△局限** / **❌不可用**（许可或已消失）。

| 来源 | 覆盖范围 | 格式 | 许可 | per-combo 频率？ | 是否有数据 | 判定 |
|---|---|---|---|---|---|---|
| **matthiola0/poker-hand-review** <br>https://github.com/matthiola0/poker-hand-review | **8-max MTT**：16 个深度（3–100bb+）× 7 位置 RFI；6 深度 vs-open / vs-3bet / cold / SB limp | **JSON**（每手 4 动作 raise/allin/call/fold + `freqs`），单文件 ~700 行 | 代码 **MIT** | **是**，含混合频率 | 是（`gto-preflop/mtt/8max/charts/`，仅 JSON 入库） | **△ 最有价值的免费结构化数据**，但为 8-max **MTT**，非 9-max cash；数据来源是 13×13 **截图** 提取（工具 `tools/extract_preflop_charts.py`，误差 ~4pp）→ provenance 疑为 GTOW，**未核实** |
| **AHTOOOXA/poker-charts** <br>https://github.com/AHTOOOXA/poker-charts | 6-max 位置，RFI / vs-open / vs-3bet / vs-4bet；多 provider | TypeScript 模块（`src/data/ranges/*.ts`：`pekarstas.ts` 33KB、`greenline.ts` 38KB），单元格支持权重与多动作拆分 | 代码 **MIT** | 是（加权） | 是，但 `gtowizard-gg-rc.ts` 是**空 stub**（TODO，无数据） | **△ 6-max 社区 chart**；数据 provider 是社区（pekarstas/greenline），非官方 GTO |
| **Sharkling 免费 preflop charts** <br>https://sharkling.io/preflop-poker-charts | 「every published cash, tournament, push-fold, ICM format」，169 手，部分填色表达 mix，可复制 `:0.32` 权重文本 | 网页文本（可复制为 range 字符串） | 站点内容归 Heap Labs；**ToS 禁 scrape / 禁 redistribute** | 是（文本含混合权重） | 是（免费浏览） | **△ 可人工抄录**；自动化抓取违反 ToS |
| **RangeConverter 免费 9-max 100bb charts** <br>https://rangeconverter.com/downloads/9-max-100bb-Poker-Charts-No-Limit-Texas-Holdem-Cash | **9-max 100bb Live Cash**：RFI / vs RFI / vs 3bet，全位置 | 网页图表 + PDF | 站点自有；免费页是**简化版**（频率四舍五入到最近 50%） | 部分（量化到 50%） | 是（免费浏览） | **△ 形状参考**；要精确频率需付费 sim，或自行抓取同样受限 |
| **RangeConverter 付费 sim（推荐）** <br>https://rangeconverter.com/gto-preflop-ranges-for-piosolver-and-monkersolver | 9-max 100bb Live Cash、9max 100bb GG 5% 0.55cap/0.42cap、9max 150/200bb、6max 各深度等 | **PioSolver ranges / Pio charts / MonkerViewer ranges** | 购买即合法离线使用 | **是（solver 原始频率）** | 是（付费下载） | **✅ 首选**（详见 §3） |
| **pokerai.bet API** <br>https://pokerai.bet/docs | **6-max only**：preflop range 端点一次返回 169 类 fold/call/raise；版本含 `6max_RC_100bb_200NL`（疑为 RangeConverter 数据转售） | **JSON API**（`POST /v1/gto/preflop/range`） | 商业 API，有 ToS；Free 1,000 lookups/月，Builder $29 / Pro $99 | 是 | 是（需 API key） | **△ 6-max，非 9-max**；合法结构化，适合 6-max 对照 |
| **DEEPFOLD-SOLVER** <br>https://github.com/a9876543245/DEEPFOLD-SOLVER | 声称 **2,550+ preflop 场景** | 私有 `gto_output/` JSON schema（~31MB，**不在 repo**，只在安装包） | **无 license**；付费订阅 | 是（内部） | 仓库内**无图表数据** | **❌ 不可直接取**；无许可 + 数据未公开 + 逆向安装包有风险 |
| **brianfordcode / fordbjay poker-preflop-charts** <br>https://github.com/brianfordcode/poker-preflop-charts | 6-max，RFI / vs 3bet / vs 4bet，按动作给手牌列表 | Vue 源码内嵌字符串（如 `"HJ vs LJ RFI": { raise: "AA AKs..." }`） | **无 license（404）** | **否**，只有动作手牌列表、无频率 | 是 | **❌ 无许可 + 无频率**；不可再分发 |
| **notnaone/rangeviewer** | 曾是「600+ charts，`Ranges/` JSON，含频率」 | JSON | — | — | **仓库已 404（现不可得）** | **❌ 已消失**（检索到但 API/页面 404） |
| **michaellhan/preflop** <br>https://github.com/michaellhan/preflop | 声称「GTO preflop trainer and range charts for **100bb cash (6-max and 9-max)**」 | HTML/JS | **无 license（404）** | 未核实 | 存在但未核实内容 | **△ 覆盖度最对口**（9-max 100bb），但无许可、格式未知，需人工核实 |
| **ImRonalddd/preflop-viewer** | 「Interactive 9-Max NLH preflop range viewer with **hand-painted** charts」 | 网页 | **无 license（404）** | 未核实 | 是 | **△ 手绘 chart，非 solver**，精度存疑 |
| **jbwheatley/preflop-ranger** | 桌面 chart 编辑/查看工具 | 桌面 app | **GPL-3.0** | 用户自建 | 工具非数据 | **❌ GPL 传染**（代码不可入产品） |
| **jcgray2/PokerNow-Preflop-Ranger** | PokerNow 用 GTO chart | 浏览器扩展 | MIT | 未核实 | 是（未核实） | △ 规模小，需核实数据源 |
| **pokermath-research/preflop-equity-matrix** | 1,326 组合的 MC equity + 部分 GTO 指标 | **CSV** | 未核实（检索于镜像站） | 非范围频率（是 equity 矩阵） | 是 | △ 可用于 equity 校验，非 chart |
| **brianfordcode / BrenoCPimenta 抓取** | 169 手排名 CSV | CSV | 未核实 | 否（仅排名） | 是 | △ 仅手牌排序，非范围 |
| **Pio 格式预解 ranges（社区流传）** | 视来源 | Pio text | 多为个人分享 | 是 | — | 质量/许可不可控，**不建议** |

**点评**
- 免费阵营里，唯一「结构化 + MIT + 含混合频率 + 有 100bb」的是 **matthiola0/poker-hand-review**，但它是 **8-max MTT**，与 9-max cash 在 ante / rake / ICM / 位置命名上有差异，只能作**形状与频率的先验校验**。
- 6-max 社区数据（AHTOOOXA）可帮我们复核 6-max 品牌位基线，但覆盖不到 9-max。
- 声称 9-max 的免费仓库（michaellhan、ImRonalddd）都**无 license 且内容未核实**，不能作为可再分发的数据基础。

---

## 2. 商业站点抓取可行性（本地自用）

> 用户已确认「本地自用、不发布、不进 git」。下表如实标注 ToS 风险，并给出降低风险做法。

| 站点 | 官方导出 / API | 认证 | 反爬 | 抓取粒度 | 数据量估计 | 成本 / 时间 | ToS / 法律风险 | 结论 |
|---|---|---|---|---|---|---|---|---|
| **GTO Wizard（Web 应用）** | 官方**无批量导出**；Ranges 标签页支持**逐节点 Copy 为 Pio/GTO+ text** | 账号登录（邮箱/OAuth）；抓包需 access_token + refresh_token | **Cloudflare / AWS CloudFront + WAF**（官方基础设施文章）；有限流 | 每 spot 一张 13×13（含 per-combo 频率） | 9-max 100bb 核心 spot ≈ **120–150 个**（RFI 8 + vs RFI ~30 + vs 3bet ~30 + vs 4bet ~20 + BvB/limp ~8 + squeeze/cold ~15）；完整「ALL SPOTS」树可达数百至上千节点（**估算/未核实**） | 手动复制 2.5–5 小时；客户端 userscript 1–2 人日开发；token 抓包 ~1 人日 | **§7.7 明确禁自动化脚本/请求**；§7.5 禁商用；§7.4 限本人牌局；**已有 451 下架先例** | 授权下的**最后手段**，优先「官方手动 Copy」而非自动脚本 |
| **GTO Wizard Benchmark / Research API** | 有官方 REST API + 官方 client | API key（申请审核） | 静态 key | **仅允许打牌并读取输赢结果**；官方明说「不提供任何 solver 能力」「请求此类功能将被拒绝」 | — | 免费（100k hands/月上限） | Benchmark ToS 明确禁「scrape/systematically query API 提取策略」「Model Distillation」 | **❌ 不是范围数据来源** |
| **GTO Wizard 客户端 userscript**（greasyfork "GTO Wizard Chart Scraper"） | 在**用户已登录的浏览器会话内**读取 study 区图表，按 `c` 输出 `{hand_text:[call%,raise%]}` | 复用浏览器 session | 无额外（在同源页面内） | per-spot | 同上 | 装脚本即用，分钟级 | 仍属 §7.7「script within Service」，但**不触碰服务端批量**，检测面小 | △ 比服务端抓包风险低，但仍违 ToS |
| **PioSOLVER** | **官方 UPI 文本接口**：`add_preflop_line` / `build_preflop_tree` / `show_range` / 保存 range 文件；Range 存 `Ranges/` 目录；有 Preflop-Chart 编辑器 | 本地 license | 无（本地软件） | 1326 floats / per-combo | 可任意多 spot | license 费（未核实具体价）+ 求解 CPU/时间 | **无 ToS 风险**（自己的工具） | **✅ 推荐：自持 license 自己求解导出** |
| **GTO+** | 本地软件；preflop ranges 存 `/config/newdefs3.txt`；支持**导入 Pio ranges**（放 `/pio`，Settings→Import）；可导出节点策略 | 本地 license（$75） | 无 | per-combo / 文本 | 可任意多 spot | $75 一次性 + 求解时间 | **无 ToS 风险** | **✅ 推荐**（尤其作为 Pio ranges 的查看/二次导出工具） |
| **RangeConverter** | 付费**直接下载** Pio / Monker 格式 sim | 账号 + 购买 | 无需抓取 | per-combo 原始频率 | 单个 sim 即完整 9-max 100bb 全位置 | 单 sim **$198/$398**，订阅者半价 **$99/$199** | 购买即合法离线使用 | **✅ 最省事** |
| **Sharkling** | 免费浏览 + 可复制文本 | 无需账号 | 有（CloudFront 等） | per-spot 文本 | 9-max cash/tournament 公开集 | 人工抄录 | **ToS 明确禁 scrape / 禁 redistribute** | △ 人工抄录；自动抓违反 ToS |
| **Pokerai API** | 官方 **JSON API** | API key | 有配额 | 6-max per-spot 169 类 | 6-max | Free 1,000/月；$29/$99 | 商业 API，有 ToS | ✅ 合法，但**仅 6-max** |

### 2.1 9-max 100BB 数据量与成本估算

- **核心 spot 集合**（用于校准我们 9-max baseline，够用）：RFI 8 + vs RFI ~30 + vs 3bet ~30 + vs 4bet ~20 + BvB/limp ~8 + squeeze/cold ~15 ≈ **120–150 个 spot**。
- **完整 GTOW「ALL SPOTS」树**：包含多路、多尺寸、all-in 分支，决策节点数显著更多（数百至上千，**未核实**）。
- **数据体积**：150 spot × 169 类 ≈ 25,350 cells；按每 spot ~7KB JSON（参考 hhana 估计）≈ **1–2 MB**，即使 1000 spot 也只有 ~7MB —— **存储成本可忽略**。
- **时间**：官方面板手动复制 ~2.5–5h；客户端 userscript 开发 1–2 人日 + 抓取 10–30 分钟；服务端 token 抓包 1 人日 + 数分钟（但最易触发风控）。

### 2.2 抓取 GTOW 的具体技术路径（如实说明，授权下最后手段）

**A. 官方合规优先：手动 Copy（推荐先用这个）**
1. 登录 GTOWizard → 选中 9-max Cash 100bb 解决方案。
2. 在 Ranges 标签页选择节点（如 BTN RFI）。
3. 点 「Copy ranges in Pio/GTO+ format」，粘贴进本地文件。
4. 逐个 spot 重复；记录来源与日期。全程无自动化，不触 §7.7。

**B. 客户端 userscript（低检测面）**
- 已有社区脚本 "GTO Wizard Chart Scraper"（greasyfork），在用户自己已登录页面读取图表 DOM，按键输出 `{hand_text:[call%,raise%]}`。
- 自行实现思路：在 study 页注入脚本，遍历节点或用 DOM 抓 13×13 单元格颜色/填充比例 → 输出 JSON。**仍在同源 session 内，不批量请求服务端**，风险低于 token 抓包，但**仍属 ToS §7.7 禁止的 script**。

**C. 服务端 API 抓包（风险最高）**
- 社区项目 `ashewang/gtowizard_parser`（无 license）给出了现成思路：浏览器登录后 F12 → Network → 找 login/token 响应 → 取 `access_token` / `refresh_token` → 写入文件 → 用 token 调用 GTOW API 拉 `solution.json`。
- 现实中会被 **CloudFront/WAF** 与限流拦截；账号存在封禁风险；**不建议**。

### 2.3 降低风险的做法（无论走哪条）
- **本地隔离**：把数据放在 **git 之外**，例如仓库外 `/home/mini/dev/4amcasino-chartdata/`，或仓库内但加入 `.gitignore` 的 `data/local-charts/`（当前 `.gitignore` 未含此路径，需自行添加；**本报告不改**）。
- **不二次分发**：不写入发行包、不公开、不粘贴到任何公开仓库/issue。
- **优先自有工具产出**：PioSolver / GTO+ / RangeConverter 购买产出的数据，版权链条最干净。
- **保留 provenance**：每个 spot 记录 provider / 版本 / 抓取日期 / 用途，便于日后替换。
- **ToS 现实**：GTOW §7.7 禁止自动化，与「本地自用」无关；用户已知悉并授权，本报告仅如实标注，不构成合规背书。

---

## 3. 技术路径与工作量

### 路径 1（首选）：付费/自有 solver 产出
- **1a. 直接买 RangeConverter 9-max 100bb sim**：选 `9max 100bb Live Cash`（或对应 GG 版本）→ 下载 **PioSolver ranges** 格式 → 写解析器转我们的中间格式。
  - 工具：RangeConverter 账号 + 购买；一个 Python/TS 解析脚本。
  - 工作量：**解析 0.5–1 人日**；覆盖 9-max 100bb 全位置；精度 = solver 原始；风险 0。
  - 成本：单 sim $198/$398，订阅者 $99/$199。
- **1b. 自持 PioSolver（preflop）脚本求解**：
  - 工具：PioSolver license（含 preflop）+ `add_preflop_line`/`build_preflop_tree`/`show_range` UPI 脚本；参考 `kuba97531/PioSolverConnection`（许可未核实）。
  - 工作量：**脚本 1–2 人日 + 求解机时**；覆盖可自定深度/人数/尺寸；精度最高；风险 0。
  - 成本：license + 算力。

### 路径 2（免费兜底）：社区数据清洗
- 取 **matthiola0 8-max MTT JSON（MIT）** + **AHTOOOXA 6-max TS（MIT）** + **Sharkling 免费 chart 人工抄录**。
- 工具：`git clone` / 下载 JSON；清洗脚本。
- 工作量：**2–3 人日**（格式归一 + 8max→9max 的位置映射 + 缺口标注）。
- 覆盖：8-max MTT 100bb + 6-max；**缺 9-max cash**。精度中（混合频率，但格式/来源有损）。
- 风险：低（注意 matthiola0 数据 provenance 疑为 GTOW 截图，本地自用尚可，勿分发）。

### 路径 3（授权下最后手段）：GTOWizard 本地抓取
- 工具：本人订阅 + 手动 Copy，或客户端 userscript；token 抓包不推荐。
- 工作量：手动 2.5–5h；userscript 1–2 人日。
- 覆盖：9-max cash 100bb+ 全覆盖；精度最高。
- 风险：**ToS §7.7 违反 + 封号 + 曾有 451 下架先例**；仅本地、不分发。

### 路径 4（不推荐）：MIT solver 自算
- `amaster97/poker_solver`（MIT）可离线跑，但翻前多人（9-max）树极大，开源实现成熟度低（3★、2026-05 新建），**多人 preflop CFR 成本与正确性都不划算**。仅适合小规模 HU/短桌验证。

**推荐组合**：**先走路径 1a**（若预算允许，几小时即可拿到权威 9-max 数据）；用**路径 2** 做交叉校验与缺口的临时占位；**路径 3 仅在 1/2 无法满足且用户接受风险时**使用。

---

## 4. 中间格式建议 + 样例

### 4.1 设计原则
- 与现有 `rangeParser.ts` 对齐：输出最终可经 `compileRangeMix(entries: RangeEntry[])` 编译。
- 现有类型（源码核对）：
  ```ts
  type PreflopActionName = 'raise' | 'call';
  type RangeRole = 'value' | 'bluff' | 'marginal';
  interface RangeEntry { range: string; action: PreflopActionName; weight?: number; role?: RangeRole; }
  interface CompiledMix { valueRaise: number; bluffRaise: number; marginalRaise: number; call: number; }
  ```
- **关键坑**：`compileRangeMix` 中，`raise` 的 role 默认按 `weight >= 1 ? 'value' : 'bluff'`。因此**混合频率的价值加注（如 AA raise 0.9）必须显式写 `role:'value'`**，否则会被当诈唬。转换器要负责这一点。
- `raise + call <= 1`，余数即 fold（隐式）。

### 4.2 统一中间格式（source-agnostic，先存后转）

建议落盘为每 spot 一个 JSON（或一个大数组），字段：

```jsonc
{
  "schema": "preflop-chart/v1",
  "id": "9max_cash_100bb_r50_cap4__RFI__BTN",
  "game": {
    "seats": 9, "format": "cash", "depthBB": 100,
    "rake": { "pct": 5, "capBB": 4 }, "anteBB": 0,
    "defaultOpenSizeBB": 2.5
  },
  "situation": "RFI",            // RFI | vs_open | vs_3bet | vs_4bet | vs_5bet_jam | squeeze | cold_call | sb_limp | push_fold
  "actor": "BTN",                // 决策位置
  "context": {                   // 决策前的行动线
    "opener": null,              // vs_open/vs_3bet 时的加注者
    "threeBettor": null,
    "prior": []                  // [{ "pos": "UTG", "action": "raise", "sizeBB": 2.5 }]
  },
  "source": {
    "provider": "RangeConverter", "product": "9max 100bb Live Cash",
    "version": "2026.xx", "capturedAt": "2026-10-05",
    "usage": "local-only", "license": "purchased", "provenance": "MonkerSolver 5% 4bb cap"
  },
  // 原始 per-combo 频率（169 类；raise 可再拆 allin）
  "mix": {
    "AA":  { "raise": 1.0,  "allin": 0.0, "call": 0.0,  "fold": 0.0 },
    "A5s": { "raise": 0.38, "allin": 0.0, "call": 0.55, "fold": 0.07 },
    "AJo": { "raise": 0.0,  "allin": 0.0, "call": 0.0,  "fold": 1.0 }
  }
}
```

### 4.3 转换到我们原生格式（目标）

由上 → `RangeEntry[]`：

```jsonc
[
  // 价值加注：强牌/高频加注，显式 role=value
  { "range": "AA,KK,QQ,AKs,AKo", "action": "raise", "weight": 1.0, "role": "value" },
  { "range": "JJ,TT,AQs",        "action": "raise", "weight": 0.9, "role": "value" },
  // 诈唬/半诈唬加注：低权重的弱牌
  { "range": "A5s,A4s,K9s",      "action": "raise", "weight": 0.38, "role": "bluff" },
  // 边缘（仅宽风格才开）
  { "range": "KJo,QJo",          "action": "raise", "weight": 0.25, "role": "marginal" },
  // 平跟
  { "range": "AQs,AJs,KQs,99,88", "action": "call", "weight": 0.6 }
]
```

**拆分规则建议**（写进转换器，可配置）：
- `raise` 频率 ≥ 0.7 或手牌属于「强档 → value」；0 < raise < 0.7 且手牌弱 → `bluff`；边界手牌 → `marginal`。
- `allin`（若有）在浅筹/短筹归入 `value`；在深筹对强牌也可拆为 `value`。
- `call` 直接映射为 `action:'call'`，weight = call 频率。
- 手牌类用我们的 `handClassKey` 规范（如 `A5s`、`AKo`、`22`），range 串可保留 `22+`/`AJs+`/`A5s-A2s` 形式交给 `parseRange`。

### 4.4 期望数据样例（**示意/占位，非实测数值；须以实际抓取为准**）

> 下列频率为「合理的期望形状」，用于说明 schema；**不要**当作已核实数据。

**样例 1 — 9-max 100bb cash，BTN RFI**
```jsonc
{ "schema":"preflop-chart/v1","id":"9max_cash_100bb__RFI__BTN",
  "situation":"RFI","actor":"BTN",
  "source":{"provider":"<RangeConverter/GTOW>","capturedAt":"2026-xx","usage":"local-only"},
  "mix":{ "AA":{"raise":1.0,"call":0,"fold":0},
          "A5s":{"raise":1.0,"call":0,"fold":0},     // 期望：BTN 开牌率约 40–45%
          "K9s":{"raise":0.5,"call":0,"fold":0.5},   // 期望：边缘混合
          "72o":{"raise":0,"call":0,"fold":1.0} } }
```

**样例 2 — 9-max 100bb cash，BB vs BTN open（single raised）**
```jsonc
{ "id":"9max_cash_100bb__vs_open__BB_vs_BTN","situation":"vs_open","actor":"BB",
  "context":{"opener":"BTN","prior":[{"pos":"BTN","action":"raise","sizeBB":2.5}]},
  "mix":{ "AA":{"raise":1.0,"call":0,"fold":0},      // 期望：BB 防守 ~40–55%，3bet 与 call 混合
          "A5s":{"raise":0.6,"call":0.4,"fold":0},   // 期望：同花 A 轮转 3bet
          "K8s":{"raise":0,"call":0.7,"fold":0.3},
          "J4o":{"raise":0,"call":0,"fold":1.0} } }
```

**样例 3 — 9-max 100bb cash，BTN vs BB 3bet（opener 决策）**
```jsonc
{ "id":"9max_cash_100bb__vs_3bet__BTN_vs_BB","situation":"vs_3bet","actor":"BTN",
  "context":{"opener":"BTN","threeBettor":"BB","prior":[{"pos":"BTN","action":"raise","sizeBB":2.5},{"pos":"BB","action":"raise","sizeBB":11}]},
  "mix":{ "AA":{"raise":1.0,"call":0,"fold":0},      // 期望：继续率 ~35–45%，4bet 与 call 混合
          "AQs":{"raise":0.45,"call":0.55,"fold":0},
          "A5s":{"raise":0.5,"call":0,"fold":0.5},   // 期望：A5s 作 4bet 诈唬
          "KQo":{"raise":0,"call":0.4,"fold":0.6} } }
```

**样例 4 — 9-max 100bb cash，BB vs BTN 4bet（3bettor 决策）**
```jsonc
{ "id":"9max_cash_100bb__vs_4bet__BB_vs_BTN","situation":"vs_4bet","actor":"BB",
  "context":{"opener":"BTN","threeBettor":"BB","prior":[{"pos":"BTN","action":"raise","sizeBB":2.5},{"pos":"BB","action":"raise","sizeBB":11},{"pos":"BTN","action":"raise","sizeBB":24}]},
  "mix":{ "AA":{"raise":1.0,"call":0,"fold":0},      // 期望：继续率 ~15–22%，5bet jam 或 call
          "AKs":{"raise":0.7,"call":0.3,"fold":0},
          "A5s":{"raise":0.55,"call":0,"fold":0.45}, // 期望：A5s 部分 5bet 诈唬
          "QQ":{"raise":0.2,"call":0.5,"fold":0.3} } }
```

**样例 5 — 9-max 100bb cash，SB RFI / BvB**（期望：SB 有 limp 或 3x 开牌两套；取决于 solution 版本）
```jsonc
{ "id":"9max_cash_100bb__RFI__SB","situation":"RFI","actor":"SB",
  "mix":{ "AA":{"raise":1.0,"call":0,"fold":0},
          "A2s":{"raise":0.3,"call":0.4,"fold":0.3},  // 期望：BvB 大量混合
          "T9o":{"raise":0.25,"call":0,"fold":0.75} } }
```

> 取数时优先参考 **RangeConverter 免费 9-max 100bb 页**（形状）与 **matthiola0 的 8-max MTT JSON**（结构/频率量级），用它们检验上述期望是否合理；精确值以付费 sim / 自有求解 / 授权抓取为准。

---

## 5. 风险与合规说明

1. **GTO Wizard ToS §7.7 是硬约束**：任何「automated requests or any scripts within Service」都被禁止，**与是否本地自用无关**。授权抓取意味着接受账号风险；技术上以「官方手动 Copy」最安全，客户端 userscript 次之，服务端 token 抓包最危险。
2. **已有下架先例**：`mtpham99/gtowizard_scrape_public` 在 GitHub 返回 **HTTP 451**，说明 GTOW 会就抓取数据采取法律行动。**绝不把抓取数据放进公开仓库或发行物。**
3. **GTOW Benchmark/Research API 不是范围来源**：其 ToS 明确禁「scrape/systematically query API 提取策略」与「Model Distillation」，且官方声明 API 不含 solver 能力。不要试图用它取范围。
4. **免费数据许可要分清**：
   - `matthiola0/poker-hand-review`、`AHTOOOXA/poker-charts` 代码是 **MIT**，但**图表数据的底层来源**（尤其 matthiola0 是截图提取）**provenance 未核实**，本地自用可以，**再分发有版权风险**。
   - `brianfordcode/*`、`michaellhan/preflop`、`ImRonalddd/preflop-viewer`、`ashewang/gtowizard_parser`、`DEEPFOLD-SOLVER` **无 license** → 默认「保留所有权利」，**不可复制进产品/发行物**。
   - `jbwheatley/preflop-ranger` 是 **GPL-3.0** → 代码不可入产品。
5. **git 隔离**：抓取/购买数据放仓库外，或加 `.gitignore`（现有 `.gitignore` 无 `data/local-charts/`）。本报告不改 `.gitignore`，执行时自行添加。
6. **不在产品中宣称 GTO**：无论数据来自何处，手工/第三方范围进入产品后仍是近似；避免「GTO」措辞（承接上一份报告的合规建议）。
7. **RTA 红线**：GTOW §7.1 禁止在牌局中实时使用；我们只用于**离线校准自研 bot**，不涉及真人牌局 RTA。产品定位需确保 AI 只在自己 app 内对战。

---

## 6. 来源分级

**一手官方 / 原始页面（高可信）**
- GTO Wizard ToS：https://gtowizard.com/terms/ （§7.1–7.11；§7.5 商用、§7.7 自动化）
- GTO Wizard Benchmark API ToS：https://gtowizard.com/benchmark/terms
- GTO Wizard 官方 solutions 状态博客（9max cash 100bb 存在与参数）：
  https://blog.gtowizard.com/status-and-info-about-our-solutions/
  https://blog.gtowizard.com/icm-mtt-9max-cash-solutions-great-improvements/
  https://blog.gtowizard.com/thousands-of-new-solutions-and-interface-updates/
  https://blog.gtowizard.com/simplified-solutions-and-a-new-interface/
- GTO Wizard Ranges 标签页（官方 Copy 为 Pio/GTO+ 格式）：https://help.gtowizard.com/ranges-tab/
- GTO Wizard Research API 官方 client：https://github.com/gtowizard-ai/researcher-api-client
- PioSOLVER UPI 文档（preflop tree / show_range / 脚本）：
  https://piosolver.com/docs/upi/ ，https://piosolver.com/docs/upi/commands/
  https://piosolver.com/docs/feature_overview/
- GTO+ 官方：https://www.gtoplus.com/ ，购买 https://www.gtoplus.com/purchase/ ，https://www.gtoplus.com/download/ （`newdefs3.txt`、import Pio）
- RangeConverter 官方：https://rangeconverter.com/gto-preflop-ranges-for-piosolver-and-monkersolver ，9-max 100bb 免费页 https://rangeconverter.com/downloads/9-max-100bb-Poker-Charts-No-Limit-Texas-Holdem-Cash
- Sharkling ToS：https://sharkling.io/terms ；免费 charts：https://sharkling.io/preflop-poker-charts
- Pokerai API 文档/定价：https://pokerai.bet/docs ，https://pokerai.bet/pricing ，https://pokerai.bet/terms
- GTOW 基础设施文章（CloudFront/WAF）：https://gostack.eu/case-studies/gto-wizard-migrates-from-on-premises-to-aws

**社区仓库（需交叉验证）**
- https://github.com/matthiola0/poker-hand-review （MIT 代码；8-max MTT JSON；截屏提取工具）
- https://github.com/AHTOOOXA/poker-charts （MIT 代码；6-max 社区 chart，TS）
- https://github.com/brianfordcode/poker-preflop-charts （无 license）
- https://github.com/michaellhan/preflop （无 license，声称 6/9-max 100bb）
- https://github.com/ImRonalddd/preflop-viewer （无 license，9-max 手绘）
- https://github.com/ashewang/gtowizard_parser （无 license；GTOW token 抓取思路）
- https://github.com/a9876543245/DEEPFOLD-SOLVER （无 license；图表不在 repo）
- https://github.com/jbwheatley/preflop-ranger （GPL-3.0）
- greasyfork "GTO Wizard Chart Scraper"：https://greasyfork.org/scripts/503803-gto-wizard-chart-scraper

**已消失 / 不可得**
- `notnaone/rangeviewer`：检索到「600+ charts JSON」，但仓库现已 **404**。
- `mtpham99/gtowizard_scrape_public`：GitHub API 返回 **HTTP 451（法律原因下架）**。

**未核实项（执行前请确认）**
- matthiola0 图表的**原始截图来源**是否 GTOW、是否可本地自用（代码 MIT 不代表数据 MIT）。
- `michaellhan/preflop`、`ImRonalddd/preflop-viewer` 的实际内容、格式与精度。
- PioSolver 各版本价格、preflop 求解所需时间/内存。
- `kuba97531/PioSolverConnection` 的 license。
- matthiola0 的 8-max MTT 数据能否可靠映射到 9-max cash。
- GTOW 「ALL SPOTS」9-max 100bb 的精确节点/图表总数。

---

## 7. 可执行的下一步清单

> 全部只涉及本地数据获取与离线脚本；**不改产品代码、不 commit**。

1. **[P0] 确定预算与首选路径**：若可付费 → 走路径 1a（RangeConverter 9-max 100bb sim）。
   - 动作：注册 RangeConverter → 选 `9max 100bb Live Cash` → 买 **PioSolver ranges** → 下载。
   - 验收：拿到完整 Pio 文本 ranges，含 RFI / vs RFI / vs 3bet 全位置。

2. **[P0] 若走免费路径**：抓取 MIT 社区数据并清洗。
   - 命令级思路（GitHub API 在本环境被限流，建议本机执行）：
     ```bash
     git clone --depth 1 https://github.com/matthiola0/poker-hand-review
     git clone --depth 1 https://github.com/AHTOOOXA/poker-charts
     # 数据位置：
     #   poker-hand-review/gto-preflop/mtt/8max/charts/**.json
     #   poker-charts/src/data/ranges/{pekarstas,greenline}.ts
     ```
   - 验收：能解析出 8-max 100bb RFI/vs-open 的 per-combo 频率并做形状对照。

3. **[P1] 落地中间格式转换脚本**（离线工具，放仓库外或 `tools/` 且不提交）：
   - 输入：Pio text / matthiola0 JSON / GTOW copy 文本。
   - 输出：`PreflopChartFile` §4.2 schema → `RangeEntry[]`（§4.3，注意显式 `role:'value'`）→ 与现有 `preflopRanges.ts` 对照。
   - 验收：对 1–2 个已知 spot（如 BTN RFI）产出可 `compileRangeMix` 的 entries，并与手工基线差异列表。

4. **[P1] 建立形状校验报告**：把新数据与我们 `preflopRanges.ts` 的 EP/MP/LP/SB/BB 分组做逐手对比。
   - 输出：差异热力（哪些手我们过紧/过松/缺混合）。

5. **[P2] 若必须抓 GTOW**（仅在 1/2 不足且接受风险时）：
   - 先用手动 Copy 抓 3–5 个核心 spot 验证流程；再考虑 userscript。
   - 数据存仓库外；记录 provenance；**绝不 commit / 分发**。

6. **[P2] 考虑 6-max/baseline 顺带收益**：用 Pokerai API 免费额度拉 6-max 100bb range JSON，作为 6-max 品牌基线对照（合法结构化）。
   - 命令级思路：
     ```bash
     curl -s https://pokerai.bet/v1/gto/preflop/range \
       -H "Authorization: Bearer $POKERAI_API_KEY" \
       -H "Content-Type: application/json" \
       -d '{"preflop_version":"6max_RC_100bb_200NL","positions":{"hero":"BTN"},"preflop_actions":[]}'
     ```

---

### 附：一句话取舍

免费数据能覆盖 8-max MTT 与 6-max，**唯一缺的就是 9-max cash 100bb**；而这块恰好是 RangeConverter 几十到几百美元就能合法买断、Pio/GTO+ 原生读取的结构化数据。**用钱买断法律与工程上的确定性，比抓 GTOWizard 划算得多**；GTOW 抓取只保留为「授权下、本地、绝不分发」的最后手段。
