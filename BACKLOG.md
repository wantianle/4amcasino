# BACKLOG

> **规则（短）**
> 1. 不在本文件里的事项不做（P0 事故除外）。
> 2. 每条必须有「完成定义」（可证伪的验收标准）。
> 3. 每条必须有「指标」（用什么数字判断它变好了）；没有指标的条目不得进入「进行中」。
> 4. 重构与改进分开：重构条目必须带「行为不变」硬约束。
>
> **本文件与 `docs/plans/repo-refactor-plan.md` 的关系**：后者是**结构重构的「方案」**
> （怎么拆、按什么批次、验证什么）；本文件是**全量需求的「台账」**（有哪些事、每条用什么
> 指标验收、排不排得上）。二者不冲突：重构类条目在此登记指标与完成定义，具体拆分设计引用
> 方案文件；方案里的 ❌/⬜ 项已收入本文件的「待排」。基线：`main@7eab153`。

## 进行中

| # | 事项 | 类型 | 来源 | 指标 | 完成定义 | 状态 |
|---|---|---|---|---|---|---|
| A1 | 画像改造（ev-baseline lane）：blocker bluff 混合 + RFI 梯度 + 注释改准 | 改进 | 评测 | human-lag 画像 VPIP/PFR 落回实测区间（VPIP≈54 / PFR≈50）；同 seed 复现一致 | `ev-harness.mjs` 输出的画像 VPIP/PFR 与注释标注的实测值一致；注释与代码逐项对齐；同 seed 两跑数字一致 | 进行中：`.slim/worktrees/ev-baseline`（omos/ev-baseline），`ev-harness.mjs` 未提交 |
| A2 | C 类拆分第一批：`SeatView` 归位 / `botRoutes` / `handStats` / `game.ts` G1+G2 | 重构 | 技术债 | 目标文件行数下降；`npm run typecheck` + 三包 vitest 绿；export surface 不变 | `SeatView` 移出 `TablePage`；`botRoutes`/`handStats` 拆出子模块；`game.ts` G1/G2 抽独立文件且根 `game.ts` 仍 re-export 原公共符号；无行为 diff | 进行中：`.slim/worktrees/small-cleanups`（当前与 main 同点、尚无改动） |

## 待排（按优先级）

| # | 事项 | 类型 | 来源 | 指标 | 完成定义 | 依赖 |
|---|---|---|---|---|---|---|
| B1 | EV 重跑 | 改进 | 评测 | 各画像 `bb/100` 及其 95% 置信区间；seed 可复现 | 画像改造冻结后固定 seed 重跑 N 手，输出各画像 `bb/100`+CI；0 abort / 0 rejected / 0 illegal / ledger 守恒 | A1 |
| B2 | C 类后续：`game.ts` G3–G7（crypto/betting/multirun/settlement） | 重构 | 技术债 | `game.ts` 行数；各 `hand/*` 模块行数；export surface 不变 | `game.ts` 仅 façade；领域按 dealing/betting/multirun/audit/showdown/settlement 分层；事务边界/时序/异常文本不变 | A2（G1/G2） |
| B3 | 测试 helper 收敛（30 auth / 15 waitFor / 15 register 重复） | 清理 | 审查 | 净减行数；全量测试绿 | 重叠辅助合并为单一 helper；`test:server` / `test:fast` 全绿 | 无 |
| B4 | agent-core `export *` 改显式白名单 | 重构 | 技术债 | 公共面导出符号数（261 暴露 → 实际使用集） | `index.ts` 全部显式具名导出；typecheck + core 测试绿；无 consumer 破坏 | 无 |
| B5 | C 类其它：`client.ts` / `handProjection.ts` / `RoundTable.tsx` / `TablePage.tsx` / `rooms.ts` | 重构 | 技术债 | 各文件行数；单测绿；浏览器探针通过 | 按 `repo-refactor-plan` §3/§4 边界拆分；旧入口 re-export；协议/布局/时序不变 | 功能 lane 全部合并 |
| B6 | 同名文件消歧：`equity` / `house` / `pokerHotkeys` | 重构 | 审查 | 同名不同职责文件数（3→0） | 按 plan §2.3 改名 + façade re-export；算法/协议不变 | 暂缓（oracle：收益不够）；功能 lane |
| B7 | `settlement-refactor.md` S0–B9c 分批迁移 | 重构 | 审查 | reject 数；duplicate settle / 事务不变量测试通过数 | 按 §6.2 批次独立提交回滚；invariants I1–I10 全绿；M/S/B 不混提 | 功能 lane 合并 + 基线冻结 |
| B8a | **abort 埋点**（掉线恢复的基线上游） | 清理 | 编排者 | **live in-process `Hand.abort()` 率（按 reason 分类）**；埋点行数 = abort 次数；**不含**任何日志刷屏（只在 abort 打 1 行） | 在 `game.ts Hand.abort()` 单一漏斗加一行 `{event:'hand_abort', scope:'live', reason, detail, handId, roomId, phase, seatsLive, boardComplete, blamedSeat, force}`，整体 fail-open；`reason` 为显式分类 `player_disconnected` / `timeout_disconnected` / `timeout` / `shutdown` / `mis_shuffle` / `crypto_protocol` / `unknown`。**注**：**不含** operator / reconciler durable abort（`settlementWriter.abortPendingHandSettlement`、`transcriptReconcile`）—— 它们不经过 `abort()`，需另补埋点或在 `hand_lifecycle` 加 `abort_reason` 列（schema 变更，**另报批**） | 无（可与 A2 并行） |
| B8b | DROPS 掉线恢复（deal-time escrow / 阈值恢复） | 改进 | 事故 | **live in-process `Hand.abort()` 率（按 reason 分类，见 B8a）**（**基线由 B8a 提供**；无基线不开工） | 设计落地；2+ live 且 board 未完成时不再必然 abort；fold-key 与隐秘边界不变 | **B8a 跑出基线** 后 + 设计评审 |
| B9 | `tools/visual` 预览归位（`table-skins` / `table-faces` 移出 `docs/qa`） | 清理 | 编排者 | `docs/qa` 中 preview app 数（2→0）；`tools/` 存在 | 迁移并更新 README + Vite root/import；`check:links` 通过 | 无 |
| B10 | gates 手机三跑 3 FAIL | 改进 | 审查 | gate 矩阵 PASS 数（当前 3 FAIL） | 3 个 FAIL 各自修复或明确豁免并注释；矩阵全 PASS 或全部有理由 | 无 |
| B11 | 平台费率歧义 | 改进 | 审查 | 检查脚本 violations（→0） | `check-commission-rate-invariant.mjs` 在真实 DB 上 0 violation；决定是否改 SQL/加 MIN/MAX 并记录 | 无 |
| B12 | HUD 两个补强测试（PlayerHud 结算重拉 / RoundTable closeHud） | 改进 | 审查 | 回归用例数（0→2） | 两测试落地并覆盖对应行为；非阻断 | 无 |
| B13 | 防御性编程收尾（agent-core 2 处 fallback） | 清理 | 审查 | fallback 处数（2→0） | 2 处删除或标注为有意；A 级审计维持 0 项 | 无 |
| B14 | 短筹码路径无场景 | 改进 | 审查 | 覆盖短筹码/破产线的端到端场景数（0→≥1） | 至少 1 个短筹码路径场景落地 | 无 |
| B15 | `docs/qa` 素材引用完整性 | 清理 | 技术债 | **被引用的素材路径缺失数（active）= 0**；新增缺口立刻可见 | ✅ 已建 `scripts/check-doc-assets.mjs`（selftest 28 例，JSON 只认 value、剔除 md 围栏，已串入 `check:all`，`0df13f0`）。现状 **94 refs / 12 missing** 全在显式 allowlist（每条带 reason+source，`--strict` 可暴露）；**不 gitignore、不做有损压缩**。⚠️ 残留：`table-skins` 6 + `table-hero-clear` 4 需用户裁「补图 or 订正 README 宣称」 | 无 |
| B17 | agent-core 生产侧 `clamp01` 三副本 | 清理 | 技术债 | 生产侧定义处数（3→1） | ✅ 已收敛到 `postflopMath.ts`（`ef54357`）；快照 sha 不变；fixture 副本保留 | 无 |
| B18 | `TODO(rules-v2)`：`seatOrder` 迁移 | 清理 | 技术债 | 该 TODO 处数（2→0） | 所有 caller 填充 `DecisionView.seatOrder`；删 TODO + baseline fallback | rules-v2 |
| B19 | `RoundTable` settlement-bubble TODO | 清理 | 技术债 | 该 TODO 处数（1→0） | equity bubble 有显式退场时机；删 TODO | 无 |
| B20 | `.slim/worktrees.json` 陈旧 + 空 worktree | 清理 | 技术债 | 活动 worktree 数与 json 一致 | ✅ json 已对齐实际（仅 `ev-baseline`）；已合并的空树全部删除（`c2dc6fa`） | 无 |

## 已关闭

| # | 事项 | 结论 | 日期 |
|---|---|---|---|
| C1 | peek 彻底移除 | `01b46db` | 2026-10-08 |
| C2 | 3 个死导出删除（preActionOptions / policyForDifficulty / POSITION_GROUPS） | `21ef2a6` | 2026-10-08 |
| C3 | docs/plans 22→11 + 重构计划重写 | `9a1a4e7` | 2026-10-08 |
| C4 | 去重 `betRatios` / `clamp01` | `df00d12` | 2026-10-08 |
| C5 | 删 `sendSafe` | `7eab153` | 2026-10-08 |
| C6 | worktree / git 卫生清理 | 本轮清理完成 | 2026-10-08 |

## 明确不做

| 事项 | 理由 |
|---|---|
| `rustVsOpen.ts` 拆分 | 纯数据文件，拆了不降复杂度 |
| `postflopPolicyBaseline.ts` 拆分 | 有意冻结的回归基线 |
| agent-core fixture `clamp01` 合并 | 刻意 oracle，独立副本是测试意图 |
| `positiveInt` 两台合并（B16） | 两份**输入域不同**：`botPolicy` 收 env **字符串**（`Number(raw)` 解析），`botSupervisor` 收**数字**。合并需放宽签名并让后者开始解析字符串 = 为去重而削弱契约，不值（本轮 `fix-14` 逐分支核实后判不等价、未合并） |
| `escapeRegExp` 跨 node/browser 合并 | 运行时不同（node 脚本 vs 浏览器 bundle），收益不足抵风险 |
| `docs/qa` 二次有损压缩 | 用户已否决；已有默认 JPEG q85 + `shots:shrink` |
| 一次性有损压图 | 有损不可逆；现行脚本已默认小图，无需一次性重压 |
| 时间显示相关 | 用户明确「暂不动，等整体重构」（暂缓，非永久放弃） |
