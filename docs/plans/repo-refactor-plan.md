# 4amcasino 精简重构方案

> **基线：`21ef2a6`**（2026-10-08 重写）。
> 上一版基线 `f4a5904`；本轮任务给的参考 HEAD 是 `2c58f6c`，其后 `21ef2a6`
> 又删掉 3 个无引用导出，故以 `21ef2a6` 为准。
> 来源：oracle 设计审查（只读）+ 2026-10-08 现状复核。
> 范围：目录层级调整、模块重组、重复命名消歧、依赖方向改善、死代码/空壳清理。
> 非范围：新增功能、协议变更、数据库语义变更、游戏规则调整、UI 改版。
>
> 历史说明：tournament / Agent Arena / MCP 路径（`apps/mcp`、`tournaments.ts`、
> tournaments 页面）已随相关功能移除；旧版本文对这些路径的设计已失效，本版不再引用。

---

## 0. 本版重写要点（相对 `f4a5904` 旧版）

本版把「计划」改写成「计划 + 真实进度」。已完成批次保留其当时的决策记录（不抹掉），
未完成批次的行数/文件更新到 `21ef2a6`，并新增 §6「当前可精简点（A/B/C）」。

| 批次 | 计划内容 | 真实状态（`21ef2a6`） |
|---|---|---|
| 0 | 冻结基线 | ✅ 已完成（历史） |
| 1 | 删 tracked IDE hook / preview 归位 | 🟡 部分：`.codex`/`.cursor`/`.grok` hooks 已删；preview 迁 `tools/visual/` **未做** |
| 2 | 同名消歧（hotkey/equity/house） | ❌ 未做 |
| 3 | shared 偏好常量归并 | ✅ 已完成，实现为 `packages/shared/src/betRatios.ts`；`profile.ts` 的守卫**未归并**（见 §6 B） |
| 4 | web table 低风险组件拆分 | ✅ 已完成（`useViewportSize`/`DesktopIconButton`/`holeStrengthLabel`/`RunTwicePrompt`/`MultiRunPrompt` 已抽出；`TablePage.tsx` 仍 2567 行） |
| 5 | table session / seat / overlay 解耦 | ❌ 未做（`TablePage.tsx` 仍 2567 行） |
| 6 | `RoundTable` 拆分 | ❌ 未做（`RoundTable.tsx` 1377 行） |
| 7 | 统计层拆分 | ❌ 未做（`handProjection.ts` 1795、`handStats.ts` 1163） |
| 8/9 | `game.ts` 拆分 | ❌ 未做，且**恶化**：3382 → **4624 行** |
| 10 | QA 中间产物清理 | ✅ 基本完成（`docs/qa` 92M → 8.5M，154 文件） |

**额外已完成（旧版未列）**：

- **postflop 引擎 6 阶段拆分**：`postflopPolicy.ts` 1912 → **842 行**（同文件内分阶段重组，未拆成多文件）。
- **删 3 个无引用导出**（`21ef2a6`）：`preActionOptions` / `policyForDifficulty` / `POSITION_GROUPS`。
- **`apps/mcp` 空壳**：已不存在（从未被 git 跟踪，无引用）。

---

## 1. 总体结论

仓库当前不是「目录完全失控」，而是存在四类可量化问题：

1. **少数核心文件承担过多职责**
   - `apps/server/src/game.ts` 同时包含房间生命周期、加密发牌、下注、超时、多跑、摊牌、结算、审计和数据库写入。
   - `apps/web/src/pages/table/TablePage.tsx` 同时包含 websocket 生命周期、页面状态、响应式布局、座位模型、弹窗、提示条、快捷操作和完整 JSX。
   - `handProjection.ts`、`handStats.ts` 把统计投影、解析、查询和 HTTP 路由混在一起。

2. **同名文件实际职责不同**
   - `equity.ts` 有两个完全不同的算法边界（server 已知牌面 worker vs agent-core 对手范围采样）。
   - `pokerHotkeys.ts` 一个是配置协议校验，一个是浏览器运行期动作解析。
   - `house.ts` 一个是 shared 类型，一个是 server 数据库业务。
   - 这些文件不应简单合并实现，应先改名、再通过稳定 façade 保持兼容。

3. **部分跨层依赖反向**
   - web 的 `widgets/table/TableDock.tsx` 依赖 `pages/leaderboard/LeaderboardPage.tsx` 导出的 `LeaderboardRow` 类型。
   - server 的路由文件直接承担大量 SQL、聚合和业务状态变换。
   - `game.ts` 直接依赖房间查询、统计投影、账本、平台账户和权益 worker。

4. **仓库体积主要由证据和本地工具状态造成**
   - `docs/qa` 经批次 10 清理后已从 92M 降到 **8.5M / 154 文件**；剩余的 untracked 中间证据可继续按需精确删。
   - `node_modules`、`.slim` 是忽略的本地生成物，不应进入重构范围。
   - tracked 的 `.codex/.cursor/.grok` hooks 已在批次 1 删除。

**核心原则（仍然有效）：**

- **先移动和改名，后拆行为。**
- **先保留 façade，再删除旧入口。**
- **每个提交只解决一个结构问题。**
- **不修改 websocket 协议、结算时序、账本语义、加密算法和几何常量。**
- **所有功能 lane 合并完成后，才开始执行高风险拆分。**

---

## 2. 现状评估（行数已更新到 `21ef2a6`）

### 2.1 顶层结构

workspace 定义仍在根 `package.json`：

```json
"workspaces": ["packages/*", "apps/*"]
```

当前实际 workspace：

```text
apps/
  web/
  server/

packages/
  shared/
  agent-core/
  mental-poker/
```

边界总体合理：`packages/shared`（协议/牌/下注/偏好类型）、`packages/mental-poker`
（心理扑克加密）、`packages/agent-core`（机器人策略、客户端、equity、preflop charts）、
`apps/server`（Fastify + SQLite + 游戏权威逻辑）、`apps/web`（React/FSD 前端）。
不建议机械地把文件搬进更深的目录；目录调整只针对高耦合边界。

### 2.2 应该拆分的巨型模块

以 `21ef2a6` HEAD 行数为准（括号内为旧版 `f4a5904` 数字）：

| 文件 | `21ef2a6` | `f4a5904` | 趋势 |
|---|---:|---:|---|
| `apps/server/src/game.ts` | **4624** | 3382 | ⬆ 恶化 |
| `apps/web/src/pages/table/TablePage.tsx` | **2567** | 2506 | → |
| `apps/server/src/handProjection.ts` | **1795** | 1509 | ⬆ |
| `apps/web/src/widgets/table/RoundTable.tsx` | **1377** | 1036 | ⬆ |
| `apps/server/src/botRoutes.ts` | **1174** | 826 | ⬆ |
| `apps/server/src/handStats.ts` | **1163** | 997 | ⬆ |
| `packages/agent-core/src/client.ts` | **1135** | 1081 | → |
| `apps/server/src/rooms.ts` | **1105** | 947 | ⬆ |
| `apps/web/src/pages/player/PlayerPage.tsx` | **1212** | 1105 | ⬆ |
| `apps/server/src/social.ts` | **873** | 858 | → |
| `packages/agent-core/src/postflopPolicy.ts` | **842** | 1469 | ⬇ 已拆（6 阶段） |
| `apps/server/src/profile.ts` | **831** | 799 | → |
| `apps/server/src/admin.ts` | **756** | 715 | → |

#### A. `apps/server/src/game.ts`（4624 行，最高优先）

主要边界（行号会漂移，**必须以函数名重新定位**）：

| 区域 | 职责 |
|---|---|
| `applyHandSettlement()` | 原子数据库结算写入（一轮 SQLite transaction） |
| `GameRoom` | socket、房间状态、自动发牌、ready check、房间级展示 |
| `Hand` | 一手牌的全部生命周期：lifecycle / transcript / message entry / voluntary shows / commit+shuffle / dealing / betting / fold-key recovery / multi-run / showdown / settlement |
| 顶部依赖 | `handProjection.ts`、`rooms.ts`、`gameplaySettings.ts`、`equity.ts`、`rake.ts`、`agentEvents.ts`、`platform.ts`、`ledger.ts` |

**判断：该拆，不该重写。** 保留 `GameRoom` 与 `Hand` 的时序，先按现有 section 移动，
再把纯逻辑变成显式输入/输出函数。不能一次性改成全新状态机。

#### B. `apps/web/src/pages/table/TablePage.tsx`（2567 行）

批次 4 已抽出 `useViewportSize`、`DesktopIconButton`、`holeStrengthLabel`、
`RunTwicePrompt`、`MultiRunPrompt`；页面主体仍承担 room websocket join/leave、
feature trigger 与 gameplay settings、chat/result/reaction/voice 状态、bot polling、
`SeatView[]` 组装、feature overlays、host controls 与大量 JSX。

**判断：该拆，不应改布局语义。** 第二阶段抽 table session、seat view model 和
overlay 状态；不要在拆文件的同时重新设计牌桌布局。

#### C. `apps/server/src/handProjection.ts`（1795 行）

职责混合：void-hand SQL helper、projection 类型与位置计算、DDL/migration、
transcript parser、writer、backfill。

**判断：该拆，属中风险统计层重组。** 不要与 `handStats.ts` 合并——二者是上下游
（`handProjection = transcript -> normalized tables`，`handStats = normalized tables -> metrics/API`）。

#### D. `apps/server/src/handStats.ts`（1163 行）

职责：stats contract/metric 类型、SQL scope、hand facts、metric aggregation、
trend/streak、redaction/privacy、HUD shaping、HTTP routes。

**判断：该拆。** 建议拆成：

```text
stats/metrics.ts       # Metric、handFacts、metricsFor、aggregate
stats/query.ts         # SQL scope、loadContext、computeHandStats
stats/hud.ts           # redactedStats、HUD confidence、HUD shaping
stats/routes.ts        # Fastify route registration
stats/types.ts         # server-side contract
```

行为保持不变。

#### E. 其它需要拆、但不应在首批处理的巨型文件

`apps/server/src/rooms.ts`(1105)、`social.ts`(873)、`botRoutes.ts`(1174)、
`profile.ts`(831)、`admin.ts`(756)；`apps/web/src/pages/player/PlayerPage.tsx`(1212)；
`packages/agent-core/src/client.ts`(1135)。先完成 `game.ts`、`TablePage.tsx`、
stats 层和命名消歧，再根据实际依赖图决定是否继续拆。

### 2.3 应该合并或消歧的重复模块（批次 2，未做）

#### A. `pokerHotkeys`

```text
packages/shared/src/pokerHotkeys.ts         # 配置协议：PokerHotkeyAction、默认绑定、配置校验、event->binding 解析
apps/web/src/features/table/pokerHotkeys.ts # 运行期：下注状态可用性、hotkeyIntent()、action latch、overlay/typing 判断
```

**结论：不合并实现，只改名消歧。**

```text
packages/shared/src/pokerHotkeyPrefs.ts
apps/web/src/features/table/hotkeyIntent.ts
```

旧路径短期保留 re-export façade，等调用方和测试迁移后再单独删除。

#### B. `equity`

```text
apps/server/src/equity.ts         # 已知双方 hole cards + 公共牌，exact/MC，worker，服务 all-in multi-run
apps/server/src/equityWorker.ts
packages/agent-core/src/equity.ts # bot 自己 hole cards，对未知对手范围采样，多对手 MC，内联于决策
```

**结论：绝不能合并算法。** 建议改名：

```text
apps/server/src/multirun/equityWorkerService.ts
apps/server/src/multirun/equityWorker.ts
packages/agent-core/src/equityEstimator.ts
```

旧入口保留 re-export。worker 的 URL 探测和 `tsx` 启动参数必须保持原样；只改文件名和 import，
不改 timeout、seed、samples、error code。

#### C. `house`

```text
packages/shared/src/house.ts # 类型和协议形状
apps/server/src/house.ts     # SQLite 业务查询和 dues 分配
```

**结论：类型可以归并命名，业务实现不能搬入 shared。**

```text
packages/shared/src/houseTypes.ts
apps/server/src/finance/houseDues.ts
```

shared 只保留 `HouseBalance`/`HouseRoom`/`HouseDues`/`PlatformDuesReport`/`CommissionSettings`/`AdminOverview`；
server 继续负责 SQL、commission 分配、odd chip 分配、void-hand 排除、platform account 解析、`houseDues()`/`platformDues()`。

#### D. `platform-crypto`

`apps/server/src/platform-crypto.ts` 与 `apps/web/src/shared/crypto.ts` 存在逐字节镜像关系。

**结论：本轮不抽成 shared 包。** ① `packages/shared` 不应依赖 `packages/mental-poker`；
② 浏览器与 server 的 crypto runtime 不同；③ 金融账户登录依赖 golden vector，统一收益不足抵风险。
保留双份实现并保持参数 `N/r/p/dkLen`、salt/domain string、`identityFromSeed`、golden-vector 测试。

### 2.4 应该删除的内容

- **tracked IDE hook 配置**：`.codex/hooks.json`、`.cursor/hooks.json`、
  `.grok/hooks/impeccable.json` — **已在批次 1 删除**（当前 `git ls-files` 为空，目录不存在）。
- **`apps/mcp` 空壳** — **已不存在**。
- **`docs/qa` 一次性中间证据** — 见批次 10，已基本清理。

---

## 3. 目标目录结构

目标不是把每个文件都再包一层，而是建立少量清晰的 bounded context。

### 3.1 server 目标结构

```text
apps/server/src/
  app.ts
  index.ts
  db.ts

  game.ts                         # 兼容 façade，最终仅 re-export
  game/
    index.ts                       # GameRoom、Hand、结算 API 的稳定出口
    room.ts                        # 房间 socket、ready、auto-deal、host handover
    roomFeatures.ts                # feature claim/release
    hand/
      index.ts                     # Hand orchestrator
      types.ts                     # Hand 内部类型和 ports
      lifecycle.ts                 # begin、abort、timeout、disconnect recovery
      transcript.ts                # appendServer、appendPlayer、head
      audit.ts                     # show、peek、key commit、reveal key
      dealing.ts                   # commit、shuffle、unmask、board opening
      betting.ts                   # action、street、timer、time bank
      multirun.ts                  # equity、run count、run maps
      showdown.ts                  # reveals、score、winner sets
      settlement.ts                # settlement outcome assembly
    settlementWriter.ts            # DB 原子结算写入

  rooms/
    routes.ts
    repository.ts
    presentation.ts
    lifecycle.ts
    permissions.ts

  stats/
    projection/
      ddl.ts
      parser.ts
      writer.ts
      backfill.ts
      voidSql.ts
    metrics.ts
    query.ts
    hud.ts
    routes.ts
    types.ts

  finance/
    ledger.ts
    rake.ts
    houseDues.ts
    settlementQueries.ts

  admin/
    routes.ts
    controlRoutes.ts
    auditQueries.ts

  bots/
    routes.ts
    runner.ts
    supervisor.ts
    identity.ts

  scripts/
```

职责规则：

- `game/hand/*` 不直接注册 HTTP route。
- `stats/*` 不修改实时游戏状态。
- `finance/*` 不依赖 React/web。
- `rooms/repository.ts` 只做查询和基础写入，不拥有游戏状态机。
- `game.ts` 在迁移期间作为稳定入口，避免一次性修改测试和其他 server 调用点。

**纯移动**：按原 section 移动、调整 import/export、保持方法体/调用顺序/异常文本/计时值不变、
`game.ts` 继续导出原有公共符号。

**非纯移动**：`Hand` 私有状态拆成 `HandContext`/`HandPorts`；settlement writer 抽出；
SQL 查询从路由注册函数抽出。均属中/高风险，需单独提交和更强测试。

### 3.2 web 目标结构

```text
apps/web/src/
  pages/
    table/
      TablePage.tsx               # 只保留页面组合和 route-level wiring
      tableUi.ts                  # 现有 utility group contract

  features/
    table/
      model/
        useTableSession.ts        # join/leave、REST room features
        useTableOverlays.ts       # chat/result/menu/dialog state
        useTableSeatViews.ts      # Room + Hand -> SeatView[]
        tableTypes.ts
      ui/
        TablePrompts.tsx
        TableOverlays.tsx
        TableDialogs.tsx
      hotkeyIntent.ts
      pokerHotkeys.ts             # 过渡 re-export

  widgets/
    table/
      canvas/
        RoundTable.tsx
        SeatPod.tsx               # 后续拆
        HoleCards.tsx
        tableMotion.ts
      controls/
        BettingPanel.tsx
        BankControls.tsx
        TableQuickControls.tsx
      overlays/
        TableDock.tsx
        ChatPanel.tsx
        ResultFlash.tsx
        LastHandStrip.tsx
      model/
        seatView.ts
        tableGeometry.ts          # geometry authority 仍在原处
```

职责规则：`TablePage.tsx` 只负责组合；`features/table/model` 负责页面状态与 view model；
`widgets/table/canvas` 负责牌桌视觉与座位呈现；`widgets/table/controls` 负责可操作控件；
`widgets/table/overlays` 负责覆盖层。禁止 widget 依赖 page（`LeaderboardRow` 迁到
`entities/leaderboard/model.ts`）。

**保持不动的前端 authority**：`apps/web/src/widgets/table/geometry.ts`（拆 `RoundTable`
时不得复制或移动其中的桌面尺寸、座位锚点和 ribbon 计算常量）。

### 3.3 packages 目标结构

`packages/shared` 不做大规模目录重写，只做命名整理（`houseTypes.ts`、`pokerHotkeyPrefs.ts` 等），
核心协议文件 `cards.ts`/`betting.ts`/`wsProtocol.ts` 保持顶层。
`packages/shared/src/betRatios.ts` 已是偏好常量的单一来源（批次 3）。

`packages/agent-core`：

```text
packages/agent-core/src/
  client/
    index.ts
    socket.ts
    handState.ts
    action.ts
    reconnect.ts

  equityEstimator.ts
  equity.ts                       # 兼容 re-export

  preflop/
    ranges.ts
    policy.ts
    charts/
      build.ts
      headcount.ts
      types.ts
      data/
```

`preflopCharts/data/*.ts` 是自动生成/导入数据，体积是内容本身，保持自动生成边界，
不手工重写。

---

## 4. 重点拆分设计

### 4.1 `game.ts` 拆分边界

**第一层：保持两个状态机**（`GameRoom` 房间连接与桌级状态；`Hand` 一手牌权威时序），
不要先合成一个 reducer，也不要引入通用 event bus。

`GameRoom` 抽出到 `game/room.ts`，保留 `join`/`leave`/`send`/`broadcast`/
`broadcastRoomState`/`settingsChanged`/host handover/auto-deal/ready check/`startHand`
调用/post-hand show 与 peek 房间入口。纯操作抽到 `game/roomFeatures.ts`
（`claimHandFeatures`/`releaseFeatureClaims`/feature snapshot normalization）。

`Hand` 拆分：

1. `hand/lifecycle.ts`：`begin`/`clearTimer`/`armTimer`/`onTimeout`/`abort`/
   `onPlayerGone`/`foldDroppedIfDecisive`/`renudge`/retry 与 deadline。
   约束：不改 timer 创建与清除顺序，不改 timeout 后 abort/fold/recover 逻辑，不改全局 scheduler。
2. `hand/transcript.ts`：`appendServer`/`appendPlayer`/head 计算/事件 payload。
   约束：不改事件 type、不改签名覆盖 payload、不改 head 计算顺序。
3. `hand/audit.ts`：`onShowCards`/`verifyShowShares`/`onKeyCommit`/`onRevealKey`/
   voluntary show/peek/key recovery 审计事件。加密核心仍调用 `@4am/mental-poker`。
4. `hand/dealing.ts`：`requestShuffle`/`onShuffle`/`startDealing`/`kickChain`/
   `onUnmaskShare`/`chainDone`/board opening/fold-key recovery；`Chain`/`Point`/deck index
   映射集中到 `hand/types.ts`。
5. `hand/betting.ts`：`startBetting`/`startBombBetting`/`onAction`/`applyEngineAction`/
   turn timer/`timeBanks`/`broadcastBetting`/`coordinateTurn`/street transitions。只拆文件，不简化算法。
6. `hand/multirun.ts`：`runBoardIndexes`/`boardForRun`/`runoutIndexes`/
   `beginMultiRunDecision`/`onRunCountChoice`/`onRunCountAgree`/`finishMultiRun`/equity error
   handling。worker service 通过明确接口注入（`MultiRunPorts`）。
7. `hand/showdown.ts`：`requestReveals`/`afterRevealsComplete`/reveal snapshot/board reveal
   sequencing/winner score 前的 reveal assembly。
8. `hand/settlement.ts`：pot 与 commission 计算/单跑与多跑 award/squid/settlement deltas/
   `hand_end` 组装。纯计算优先变成 `computeSettlement(input): SettlementResult`（不访问 DB、不 broadcast）。
9. `game/settlementWriter.ts`：`applyHandSettlement`/ledger/rake/hand projection/final stack/
   time bank epoch/feature trigger 标记/settlement idempotency。**必须保持「一次 SQLite transaction」。**

### 4.2 `TablePage.tsx` 拆分边界

- **第一批（低风险纯组件）**：`useViewportSize`、`DesktopIconButton`、`holeStrengthLabel`、
  `RunTwicePrompt`、`MultiRunPrompt` — **已完成**。
- **第二批（table session hook）**：join/leave 抽为 `useTableSession(roomId)`
  （`bindGameClient`/`wsClient.joinRoom`/`api.getRoom`/room feature fetch/cleanup/voice leave/
  ws leave/store room reset），不负责渲染、dialog 状态、layout。
- **第三批（seat view model）**：`SeatView[]` 组装抽为 `useTableSeatViews.ts`
  （输入 room/hand/auth/voiceState/botByUserId，输出 `SeatView[]`）。
- **第四批（overlay 与 dialog 状态）**：`useTableOverlays.ts` + `TableOverlays.tsx` +
  `TableDialogs.tsx`，覆盖 chat/result/reaction/feature ribbon/peek/share/standings/invite/
  watch/auto-deal/gameplay settings/bots/broke buy-in。

**最终 `TablePage.tsx`** 目标约 300–600 行：读 route 参数、调用 hooks、少量 page-level flags、
组合 canvas/controls/overlays/dialogs。

---

## 5. 分批实施计划（状态化）

每批单独提交，保留父提交作为回滚点，不把功能修改混入重构提交。

### 批次 0：冻结基线（不改代码）— ✅ 已完成（历史）

等待功能 lane 合并；从最新主线建重构分支；记录实际 commit 与基线（`npm run typecheck` +
三包 `vitest`）。任何 baseline 失败先修功能 lane，不开始重构。

### 批次 1：仓库卫生与独立工具归位 — ✅ 已完成

- ✅ 删除 tracked 的 `.codex/hooks.json`、`.cursor/hooks.json`、`.grok/hooks/impeccable.json`。
- ✅ 把独立预览应用 `docs/qa/table-skins/`、`docs/qa/table-faces/` 移到 `tools/visual/`；
  更新 README 与 Vite root/import。**当前 `tools/visual/table-skins/` 与
  `tools/visual/table-faces/` 已就位，`docs/qa` 只留证据截图 + README，`check:links` 通过。**

### 批次 2：重复命名消歧（不改算法与 API）— ❌ 未做

新增 `pokerHotkeyPrefs.ts`/`hotkeyIntent.ts`/`multirun/equityWorkerService.ts`/
`equityEstimator.ts`/`houseTypes.ts`/`finance/houseDues.ts`；旧入口保留 re-export。
验证重点：server equity（exact board、MC seed 复现、worker timeout、equity_failed）、
agent equity（uniform/weighted/multiway fallback/seed 复现）、hotkeys（config 校验、event 解析、
action latch、legal mapping）、house（platform dues、odd chip、void 排除）。回滚只恢复旧 import；
**本提交不能删除 façade**。

### 批次 3：shared 偏好与类型归并 — ✅ 已完成（有残留）

- 已完成：`ALL_IN_RATIO`/`BET_RATIO_OPTIONS`/`BET_RATIO_SLOTS`/`DEFAULT_BET_RATIOS` 及
  `sanitizeBetRatios` 已提取到 `packages/shared/src/betRatios.ts`（**不是旧版计划的
  `preferences.ts`**），server 与 web 共用。
- 残留：`apps/server/src/profile.ts` 仍有本地 `isBetRatio`/`isBetRatioSlots` 守卫（约 77–96 行），
  与 shared 校验语义重叠 → 见 §6 B。
- 决策记录（保留）：约束「四槽历史仍可读、五槽不变、损坏 JSON 回退默认、server 不依赖 web、
  shared 不依赖 mental-poker」仍成立。

### 批次 4：web table 低风险组件拆分 — ✅ 已完成

已抽出 `apps/web/src/pages/table/hooks/useViewportSize.ts`、
`apps/web/src/pages/table/holeStrengthLabel.ts`、
`apps/web/src/pages/table/ui/DesktopIconButton.tsx`、`ui/RunTwicePrompt.tsx`、
`ui/MultiRunPrompt.tsx`。`TablePage` 仍是唯一组装入口（2567 行）。

### 批次 5：web table session / seat model / overlay 解耦 — ❌ 未做

拆 `useTableSession`/`useTableSeatViews`/`useTableOverlays`/`TableDialogs`/`TableOverlays`。
验证重点：join 失败与 retry、slow message、watcher/spectator、feature claim/cancel、auto-ready、
chat unread、result dismiss/Escape、fullscreen、bots polling、standings reload、voice cleanup、
unmount 后不再发送。先迁移一类状态，确认后再删 page 内逻辑。

### 批次 6：`RoundTable` 拆分 — ❌ 未做

目标 `canvas/RoundTable.tsx`、`canvas/HoleCards.tsx`、`canvas/SeatPod.tsx`、
`canvas/tableMotion.ts`、`model/seatView.ts`、`feedback/CheckFeedback.tsx`；
`geometry.ts` 不移动不复制。验证：browser baseline 全视口 + overlap probe + post-hand deal +
hotkey probe + bots probe + stats HUD probe + reduced-motion，对比座位位置、table scale、
揭示、winner FX、turn progress、bot badge、mobile canvas。`RoundTable` 保留兼容导出。

### 批次 7：统计层拆分 — ❌ 未做

拆 `handProjection.ts`(1795) 为 `stats/projection/{ddl,voidSql,parser,writer,backfill}.ts`；
拆 `handStats.ts`(1163) 为 `stats/{types,metrics,query,hud,routes}.ts`；旧入口只 re-export。
**严禁改变**：`HAND_PARSER_VERSION`、DDL、migration 顺序、void-hand 语义、`strict`/`verifyHead`、
projection 与 settlement 同事务关系、HUD 样本门槛、private mode redaction、metricVersion、
统计结果字段名。

### 批次 8：`game.ts` 机械目录拆分 — ❌ 未做

按 section 移动为 `game/{index,room,settlementWriter}.ts` + `game/hand/{types,lifecycle,transcript,
audit,dealing,betting,multirun,showdown,settlement}.ts`；根 `game.ts` 暂为
`export * from './game/index.js'`。规则：方法体原样移动；私有访问用 `HandContext`/callback 解决、
不用 `any`；不改 timer/broadcast/append 顺序、异常文案、事务边界、`activeHands` 生命周期。
验证：server 全量（重点 autoDeal/botE2E/botRunnerReconnectE2E/integration/lifecycle/roomClose/
equity/pokerHotkeys/persist/ledger/merge/history/voidHand*）+ `node --import tsx
apps/server/test/botEval.mjs`（200 hands、deterministic seed、0 abort、0 rejected、0 bot error、
ledger conserved、duplicate replay same cards、0 fallback、0 illegal）。

### 批次 9：`GameRoom`/`Hand` 高风险解耦 — ❌ 未做

仅在批次 8 稳定后进行：`Hand` 依赖改显式 `HandPorts`；settlement 纯计算改 snapshot 输入；
DB settlement writer 只接收已解析的 `HandSettlementWrite`；multi-run equity 经端口注入；
audit/transcript 只经事件 writer；room lifecycle 不再直读 Hand 私有字段。目标依赖方向：
`game/room -> game/hand facade`；`game/hand/* -> shared protocol / mental-poker / injected ports`；
`game/settlementWriter -> db / ledger / projection`；`stats -> db projection only`。
不做：全局 event bus、reducer 化、协议变更、DB writer 异步队列、时钟模型变更、最终一致性结算。
验证除全部单测外，必须运行 server 全量 + browser baseline + post-hand deal + poker hotkeys +
bot live + `evalInfra.test.mjs` + `botEval.mjs` duplicate + 至少一次真实多跑/strict-audit/断线恢复与 timeout。
**高风险批次必须在独立分支提交，失败整体回滚，不做局部热修复。**

### 批次 10：中间产物与临时文件清理 — ✅ 基本完成

- `docs/qa`：92M / 429 文件 → **8.5M / 154 文件**；`apps/mcp` 空壳已清。
- 决策记录（保留）：**不归档、直接删**；保留各 feature README、最终 sign-off、关键基线图与
  probe fixture；不做 `rm -rf docs/qa` 式整目录删除。
- 剩余：仍可按需精确清理剩余 untracked 中间证据；`/tmp` 本项目产物（`/tmp/4am-*` 等）
  不在仓库内、不属于任何提交，可随时清理。

---

## 6. 当前可精简点（A / B / C）

> 三级清单来自 2026-10-08 现状复核。执行前请按函数名/符号重新定位行号。

### A 类 — 纯删（低风险）

- ✅ **3 个无引用导出** — **已完成**（`21ef2a6`）：`preActionOptions`
  （`apps/web/src/features/table/preActions.ts`）、`policyForDifficulty`
  （`packages/agent-core/src/difficultyPolicy.ts`）、`POSITION_GROUPS`
  （`packages/agent-core/src/preflopRanges.ts`）。
- ⬜ **已合并 worktree + 分支**：前一轮盘点为 7 棵；`21ef2a6` 实测剩 **3 棵**——
  `.slim/worktrees/dedup`（omos/dedup @ `2c58f6c`）、`ev-baseline`（omos/ev-baseline @ `92e066b`）、
  `remove-peek`（omos/remove-peek @ `2c58f6c`）。清理前须确认 diff 已并入主线（`dedup`/`remove-peek`
  与 HEAD 同点，`ev-baseline` 需复核）。属破坏性操作，先报用户。
- ✅ **`apps/mcp` 空壳** — 已不存在。
- ✅ **文档清理** — 本轮：`docs/plans` 22 → 12 份（删 11 份阶段性 lane 记录 + design 并入 v2-fair）。

### B 类 — 去重（中低风险）

- ⬜ **`betRatios` 守卫归并**：`apps/server/src/profile.ts`（约 77–96 行的
  `isBetRatio`/`isBetRatioSlots`）与 `packages/shared/src/betRatios.ts` 的校验语义重叠，
  收敛为 shared 单一来源。
- ⬜ **测试 helper 收敛**：`apps/server/test/helpers/` 下 `evalDesign`/`evalCompare`/`evalMatch`/
  `evalStrategies` 的重叠辅助（如 seed/配对/聚合工具）合并到单一 helper。
- ⬜ **`clamp01` / `escapeRegExp` / `positiveInt` 去重**：实测 `escapeRegExp` 在
  `scripts/check-i18n.mjs:43` 与 `apps/web/src/shared/i18n/index.ts:30` 各一份；
  `positiveInt` 在 `apps/server/src/botSupervisor.ts:120` 与 `apps/server/src/botPolicy.ts:67` 各一份。
  （`clamp01` 仅见于 `packages/agent-core/test/fixtures/preflopPolicyBaseline.ts`，需确认是否另有生产侧副本。）
- ⬜ **`agent-core/index.ts` 的 `export *` 改显式白名单**：当前 19 条 `export *` 易造成符号漂移，
  改为显式具名导出（该文件对 Phase-1 pure layers 已用显式导出，继续统一即可）。

### C 类 — 拆大文件（高风险，按 §4 分批）

按当前行数优先级：

1. `apps/server/src/game.ts`(4624) — 批次 8/9
2. `apps/web/src/pages/table/TablePage.tsx`(2567) — 批次 5
3. `apps/server/src/handProjection.ts`(1795) — 批次 7
4. `apps/web/src/widgets/table/RoundTable.tsx`(1377) — 批次 6
5. `apps/server/src/botRoutes.ts`(1174)
6. `apps/server/src/handStats.ts`(1163) — 批次 7
7. `packages/agent-core/src/client.ts`(1135)
8. `apps/server/src/rooms.ts`(1105)
9. 同名消歧（hotkey/equity/house）— 批次 2

---

## 7. 不做清单

1. **不改协议 schema**：`wsProtocol.ts`、`betting.ts`、`cards.ts`、`agentSchema.ts`。
2. **不改加密核心**：`packages/mental-poker/src/*`、`apps/web/src/shared/crypto.ts`、
   `apps/server/src/platform-crypto.ts`（golden vector 必须继续通过）。
3. **不改账本、迁移与结算历史**：`merge.ts`、`ledger.ts`、`persist.ts`、`settle.ts`、
   `scripts/rewrite-rake-to-platform.ts`；不合并 ledger 与 settlement、不改 ledger kind、
   不改 ref/head 关联、不删历史 migration、不改 void 排除语义。
4. **不合并两种 equity**（安全边界不同）。
5. **不大规模重排 `packages/shared`**（只做 hotkey/house/偏好三处）。
6. **本轮不拆全部大文件**（social/botRoutes/profile/admin/PlayerPage/client 登记后续）。
7. **`docs/qa` 清理**：不归档、直接删；保留 feature README、最终 sign-off、关键基线图、
   probe fixture 与最终 result JSON；不做 `rm -rf docs/qa`。

---

## 8. 验证策略

- **纯移动/改名**：`npm run typecheck` + 三包 vitest；`git diff --find-renames`；
  export surface 不变、只有路径变化、无协议/SQL/常量 diff。
- **server 重构**：游戏时序（start/commit/shuffle/unmask/betting/timeout/fold/reveal/multirun/
  showdown/settlement/auto-deal）；资金不变量（ledger conservation、rake recipient、final stacks、
  duplicate idempotency、negative stack、time-bank epoch、squid net zero）；审计不变量
  （transcript head、player signature、reveal key、show shares、strict audit、malformed rollback）；
  bot/eval 全部检查项断言。
- **web 重构**：单测基线 + 浏览器探针（table-baseline、poker-hotkeys、post-hand-deal、
  table-overlap、stats-pro、stats-pro-real、bot-live、table-bots）。
- **截图规则**：不要求逐像素一致，但桌面 canvas 比例、座位锚点、hole cards 位置、
  action bar 与 betting panel 位置、prompt 遮挡、手机横竖屏溢出、reduced motion、
  overlay Escape/focus trap、`aria-label` 与 `data-testid` 必须不变。
  `geometry.ts` 变更一律视为行为变更，不能与组件拆分同提交。
- **agent-core**：clientResync、clientSocketHandoff、multiRunDecision、equity、decisionView、
  preflopAdaptive、postflopPolicy*、rulePolicy、sessionMemory；证明改名未改输入输出、
  `client.ts` 拆分未改 reconnect/resync/hand frame 过滤。
- **文档改动**：`npm run check:links`（worktree 跨包软链）保持通过；被删文档需先 grep
  代码注释与其它文档确认无引用。

---

## 9. 主要风险与缓解

| 风险 | 缓解 |
|---|---|
| 私有状态拆分导致隐式依赖丢失（顺序/`this`/timer/settlement/phase） | 第一阶段只移动 + callback；不强行纯函数化；每 section 拆完立刻跑测试 |
| worker URL 与构建环境变化 | 保留 `equity.ts` façade；`resolveWorkerUrl()` 原样；单跑 server equity tests + production build；不改动态 import |
| 结算事务边界被无意改变 | 先只移动文件；writer 单独提交；强制保留 `db.transaction(...)` 外层；duplicate settle / negative stack / projection rollback 测试 |
| 统计投影与实时结算解耦错误 | writer 仍同步调用 projection；API 保持同步；只改文件位置 |
| `TablePage` effect 生命周期变化 | `useTableSession` 先单独抽取 + unmount 测试；保留 `pokerActionLatch`；不改 dependency array；probe 验证 resize/route change/unmount |
| QA 清理误删证据 | QA 清理独立于源码重构；先 grep 出所有引用并修正 tracked 文档，再按文件/子目录精确删除；保留各 feature 的 README、最终结论与仍被 probe 使用的 fixture |
| 重构分支与功能 lane 冲突 | 功能 lane 全部完成后再做批次 5+；批次 1–3 可先做；每批从最新主线 rebase；不在重构提交顺手修 bug |

---

## 10. 完成标准

1. `game.ts` 只剩兼容入口，游戏领域按 dealing/betting/multirun/audit/showdown/settlement 分层。
2. `TablePage.tsx` 只负责页面组合，session/seat model/prompts/overlays 已独立。
3. `handProjection` 与 `handStats` 分成 projection/query/metrics/routes 层。
4. `pokerHotkeys`/`equity`/`house` 同名歧义消除。
5. 两种 equity 仍保持不同安全边界。
6. protocol/crypto/geometry/ledger/settlement 时序未改变。
7. 旧入口迁移期通过 façade 兼容，最终清理有独立提交。
8. 每批可独立测试、提交和回滚。
9. 三包基线测试全部通过。
10. browser baseline、bot/eval harness、ledger invariants 全部通过。
11. `docs/qa` 中间过程证据在修正引用后精确删除；各 feature 的最终结论与 probe fixture 保留。
12. 任何结构提交都不含功能扩展或产品行为修改。
