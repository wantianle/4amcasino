# 仓库结构与精简审计（2026-10-05）

只读审计结论，供后续分阶段整理。低风险项已在同批处理（见文末）。

仓库为 npm workspaces monorepo（`packages/*` + `apps/*`）。结构总体健康：workspace 边界清楚，`apps/web` 基本遵循 FSD，无真正死源码。主要问题是**体积与证据堆积**、**少量同名跨包模块**、**IDE hook 写死 macOS 路径**、**几个巨型文件**。

## 1. 顶层条目

| 条目 | 作用 | 判定 |
|---|---|---|
| `apps/` `packages/` | 真实源码 | 保留 |
| `docs/` | 设计/计划/QA 证据 | 需分层（`docs/qa` 约 44M） |
| `node_modules/` `apps/*/dist/` `*.db*` | 生成物 | 已忽略 |
| `.slim/` | slim worktree 脚手架 | 本地，已清理 |
| `.botenv` `.ignore` `.cortexkit/` | 本地密钥/工具状态 | 应忽略（已补 `.gitignore`） |
| `.codex/ .cursor/ .grok/` | IDE hooks（写死 `/Users/notpritamm/...`） | 建议忽略或移除 |
| `.impeccable/` + `apps/web/.impeccable/` | 设计系统导出（同源生成） | 建议只留一处 |

## 2. 跨包同名模块（易混淆）

- `pokerHotkeys.ts`：`packages/shared`（设置校验）vs `apps/web/src/features/table`（运行期按键意图）——同责不同层，建议前者保留、后者改 `hotkeyIntent.ts`。
- `equity.ts`：`apps/server`（worker 已知牌多跑）vs `packages/agent-core`（机器人 MC）——建议 `equityWorker.ts` / `botEquity.ts`。
- `house.ts`：`apps/server`（业务）vs `packages/shared`（类型/常量）。
- `platform-crypto.ts`：`apps/server/scripts`（已删薄包装）vs `apps/server/src`（真实实现，逐字节镜像 `apps/web/src/shared/crypto.ts`，**加密关键，不得随意统一**）。
- `DESIGN.md`：根（设计系统）vs `apps/server/DESIGN.md`（部署边界笔记）。

## 3. FSD 反向依赖

- `widgets/table/TableDock.tsx` 引用 `pages/leaderboard/LeaderboardPage.tsx` 的 `LeaderboardRow` 类型（widget→page）。建议把该类型下沉到 `entities`/`shared`。

## 4. 巨型文件（行数 + 建议拆分边界）

| 文件 | 行数 | 拆分边界 |
|---|---|---|
| `apps/server/src/game.ts` | 3161 | `game/{dealing,betting,multirun,settlement}.ts`（按既有 section 注释） |
| `apps/web/src/pages/table/TablePage.tsx` | 2431 | 抽 `CountdownChip/RunTwicePrompt/MultiRunPrompt/DesktopIconButton/useViewportSize/holeStrengthLabel` |
| `apps/web/src/pages/tournaments/*` | ~1162/1146 | 列表/详情/表单 |
| `apps/web/src/pages/player/PlayerPage.tsx` | 1105 | |
| `apps/web/src/pages/admin/*` | ~1072/788 | |
| `packages/agent-core/src/client.ts` | 1081 | 按 socket/hand/state 拆 |
| `apps/web/src/widgets/table/RoundTable.tsx` | 895 | 抽 `actionLabel/useStageBox/HoleCards/useStackUnit` |
| `apps/server/src/{rooms,tournaments,botRoutes,social,profile}.ts` | 733–1038 | 路由/helper 分离 |

## 5. 文档与脚本

- `docs/superpowers/{plans,specs}`：历史 plan/spec，归档保留。
- `docs/plans/*.md`：3 对 design+plan，可合并。
- `docs/qa/**`：约 44M、105 张已 track 截图 + 时间戳 JSON/MD。建议移出仓库或改 LFS，仅留 `README` 与关键基线图。
- `docs/qa/table-skins/preview.*`：一个可运行的独立 Vite 预览应用放在 `docs/` 下（引用生产源码），应移到 `tools/` 或 `apps/web/test/browser/`。
- `apps/server/scripts/`：start / seed / rake 迁移 / crypto，保留（crypto 已删）。

## 6. 明确不要动

- 协议 schema：`packages/shared/src/{wsProtocol,betting,cards}.ts`、`apps/server/src/agentSchema.ts`。
- 几何 authority：`apps/web/src/widgets/table/geometry.ts`（拆 `RoundTable` 时不得移动常数）。
- 加密核心：`packages/mental-poker/src/*`；`apps/web/src/shared/crypto.ts` 与 `apps/server/src/platform-crypto.ts` 的逐字节镜像关系（golden 向量）。
- 迁移/结算历史：`apps/server/src/{merge,ledger,persist,settle}.ts`、`scripts/rewrite-rake-to-platform.ts`（账本不可逆）。
- 游戏权威时序：`game.ts` 的计时/betting、`rooms.ts` 的 CAS/单实例约束（只拆文件、不改时序）。
- QA 证据必要项：各特性目录的 `README.md` / 结果 JSON / 基线对照图。

## 7. 本批已处理的低风险项

- `.gitignore` 增加 `.botenv`、`.cortexkit/`、`.ignore`、`.codex/`、`.cursor/`、`.grok/`。
- 删除 `apps/server/scripts/platform-crypto.ts` 薄包装，`apps/server/test/platform.test.ts` 改指 `../src/platform-crypto.js`。
- 清理本地 git worktree：`.slim/worktrees/remove-3d`、`/tmp/4am-head`、`/tmp/4amcasino-before`。

## 8. 待后续（用户按需选择）

- 中风险：拆 `TablePage`/`RoundTable`/`game.ts`/`rooms`/`profile`；修 `TableDock` 反向依赖；`features/table/pokerHotkeys` 改名；`docs/qa/table-skins` 预览归位。
- 低风险补充：`docs/qa/**` 瘦身；`.impeccable` 去重；`.codex/.cursor/.grok` 处理；`docs/plans` 成对合并。
- 高成本：`apps/server/src` 引入 `game/`、`bots/` 子目录；跨包同名模块重命名。
