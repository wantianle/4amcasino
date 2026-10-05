# 4amcasino 精简重构方案

> 基线：`f4a5904`
> 来源：oracle 设计审查（只读设计，未改代码）
> 范围：目录层级调整、模块重组、重复命名消歧、依赖方向改善。
> 非范围：新增功能、协议变更、数据库语义变更、游戏规则调整、UI 改版。
>
> 本方案只基于 `f4a5904` 的已提交结构设计。执行须在本轮所有功能 lane 合并之后，从最新主线重新建分支。

---

## 1. 总体结论

仓库当前不是“目录完全失控”，而是存在四类可量化问题：

1. **少数核心文件承担过多职责**
   - `apps/server/src/game.ts` 同时包含房间生命周期、加密发牌、下注、超时、多跑、摊牌、结算、审计和数据库写入。
   - `apps/web/src/pages/table/TablePage.tsx` 同时包含 websocket 生命周期、页面状态、响应式布局、牌桌座位模型、弹窗、提示条、快捷操作和完整 JSX。
   - `handProjection.ts`、`handStats.ts` 把统计投影、解析、查询和 HTTP 路由混在一起。

2. **同名文件实际职责不同**
   - `equity.ts` 有两个完全不同的算法边界。
   - `pokerHotkeys.ts` 一个是配置协议校验，一个是浏览器运行期动作解析。
   - `house.ts` 一个是 shared 类型，一个是 server 数据库业务。
   - 这些文件不应简单合并实现，应先改名、再通过稳定 façade 保持兼容。

3. **部分跨层依赖反向**
   - web 的 `widgets/table/TableDock.tsx` 依赖 `pages/leaderboard/LeaderboardPage.tsx` 中导出的 `LeaderboardRow` 类型。
   - server 的路由文件直接承担大量 SQL、聚合和业务状态变换。
   - `game.ts` 直接依赖房间查询、统计投影、账本、平台账户和权益 worker。

4. **仓库体积主要由证据和本地工具状态造成**
   - `docs/qa` 在既有审计中约 44M；`f4a5904` 下有 220 个文件，其中 139 个为图片类文件。
   - `node_modules`、`.slim` 是忽略的本地生成物，不应进入重构范围。
   - `.botenv`、`.cortexkit/` 等在 `f4a5904` 的 `.gitignore` 中已经忽略。
   - `.codex/hooks.json`、`.cursor/hooks.json`、`.grok/hooks/impeccable.json` 虽然已被忽略规则覆盖，但在 HEAD 中仍被跟踪，且部分写死 `/Users/notpritamm/...`。

核心原则：

- **先移动和改名，后拆行为。**
- **先保留 façade，再删除旧入口。**
- **每个提交只解决一个结构问题。**
- **不修改 websocket 协议、结算时序、账本语义、加密算法和几何常量。**
- **所有功能 lane 合并完成后，才开始执行高风险拆分。**

---

## 2. 现状评估

### 2.1 顶层结构

当前 workspace 定义位于根目录 `package.json:7`：

```json
"workspaces": ["packages/*", "apps/*"]
```

当前实际 workspace：

```text
apps/
  web/
  server/
  mcp/

packages/
  shared/
  agent-core/
  mental-poker/
```

现有边界总体合理：

- `packages/shared`：协议、牌、下注、评估、偏好类型。
- `packages/mental-poker`：心理扑克加密协议。
- `packages/agent-core`：机器人策略、客户端、equity、preflop charts。
- `apps/server`：Fastify、SQLite、房间和游戏权威逻辑。
- `apps/web`：React/FSD 前端。
- `apps/mcp`：MCP 入口和对 `agent-core/client` 的兼容导出。

不建议把所有文件机械地搬进更深的目录。目录调整只针对高耦合边界。

### 2.2 应该拆分的巨型模块

#### A. `apps/server/src/game.ts`

HEAD 实际为 **3382 行**，比既有审计中的 3161 行更大。审计文档中的数字已过时，应以 HEAD 为准。

主要边界：

| 区域 | HEAD 行号 | 当前职责 |
|---|---:|---|
| `GameRoom` | 497–1427 | socket、房间状态、自动发牌、ready check、房间级展示 |
| `Hand` | 1428–3382 | 一手牌的全部生命周期 |
| lifecycle | 1531 起 | timer、abort、重试、disconnect recovery |
| transcript | 1829 起 | 服务端/玩家事件链 |
| message entry | 1874 起 | 客户端消息分派 |
| voluntary shows | 1919 起 | 展示牌、peek |
| commit + shuffle | 1991 起 | commit、shuffle、unmask |
| dealing | 2055 起 | 发牌和加密链 |
| betting | 2202 起 | 下注、回合、time bank |
| fold-key recovery | 2648 起 | fold 后密钥恢复 |
| multi-run | 2793 起 | equity、多跑投票、额外 board |
| showdown | 2994 起 | reveal |
| settlement | 3029 起 | pot、rake、squid、ledger、projection、hand_end |

此外，文件顶部还包含：

- `applyHandSettlement()`：约 200–477 行范围内的原子数据库结算写入。
- `GameRoom` 与 `Hand` 两个状态机。
- 对以下模块的直接依赖：

```text
handProjection.ts
rooms.ts
gameplaySettings.ts
equity.ts
rake.ts
agentEvents.ts
platform.ts
ledger.ts
```

**判断：该拆，不该重写。** 正确拆法是保留 `GameRoom` 和 `Hand` 的时序，先按现有 section 移动，再逐步把纯逻辑变成显式输入/输出函数。不能一次性改成全新状态机。

#### B. `apps/web/src/pages/table/TablePage.tsx`

HEAD 实际为 **2506 行**。文件前 440 行已经包含多个应该独立的局部模块：

| HEAD 行号 | 局部模块 |
|---:|---|
| 95 | `useNow` |
| 108 | `useUrgentAt` |
| 130 | `CountdownChip` |
| 147 | `RunTwicePrompt` |
| 209 | `MultiRunPrompt` |
| 355 | `DesktopIconButton` |
| 409 | `useViewportSize` |
| 425 | `holeStrengthLabel` |
| 441 | `TablePage` 主组件 |

`TablePage` 主体还承担：room websocket join/leave（约 562–583）、feature trigger 和 gameplay settings（约 469–631）、chat/result/reaction/voice 状态（约 644–814）、bot 状态 polling（约 723–764）、`SeatView[]` 组装（约 816–864）、feature overlays（约 1427 起）、host controls（约 1571 起）、大量 JSX 组合（约 900–2506）。

**判断：该拆，不应改布局语义。** 第一阶段只抽局部组件和 hooks；第二阶段再抽 table session、seat view model 和 overlay 状态。不要在拆文件的同时重新设计牌桌布局。

#### C. `apps/server/src/handProjection.ts`

HEAD 实际为 **1509 行**。职责混合：

| 区域 | HEAD 行号 | 职责 |
|---|---:|---|
| SQL void helper | 35–67 | void-hand 查询语义 |
| projection 类型和位置计算 | 69–160 | hand projection contract |
| DDL/migration | 166 起 | `hands`、`hand_players`、`hand_actions` 等 |
| transcript parser | 503 起 | 事件解析、数据校验 |
| writer | 1078 起 | 写入 projection |
| backfill | 1382 起 | 历史 transcript 回填 |

**判断：该拆，但属于中风险统计层重组。** 不要把它和 `handStats.ts` 合并。正确关系是 `handProjection = transcript -> normalized tables`，`handStats = normalized tables -> metrics/API`，二者是上下游。

#### D. `apps/server/src/handStats.ts`

HEAD 实际为 **997 行**。主要职责：stats contract 和 metric 类型、SQL scope、hand facts、metric aggregation、trend/streak、redaction/privacy、HUD shaping、HTTP routes。

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

以 HEAD 行数为准：

| 文件 | 行数 | 建议 |
|---|---:|---|
| `apps/server/src/rooms.ts` | 947 | 路由、查询、生命周期、展示拆开 |
| `apps/server/src/social.ts` | 858 | 社交路由、房间历史查询拆开 |
| `apps/server/src/botRoutes.ts` | 826 | bot API、权限和查询拆开 |
| `apps/server/src/profile.ts` | 799 | profile、leaderboard、history、preferences 拆开 |
| `apps/server/src/admin.ts` | 715 | admin route 已部分拆到 `adminControl.ts`，继续拆需谨慎 |
| `apps/server/src/tournaments.ts` | 1090 | tournament query、operations、routes |
| `apps/web/src/widgets/table/RoundTable.tsx` | 1036 | canvas、seat、card、motion、feedback |
| `apps/web/src/pages/tournaments/TournamentsPage.tsx` | 1162 | list/filter/card |
| `apps/web/src/pages/tournaments/TournamentWatchPage.tsx` | 1146 | live state、broadcast、replay |
| `apps/web/src/pages/player/PlayerPage.tsx` | 1105 | profile header、stats、history |
| `apps/web/src/pages/admin/AdminSections.tsx` | 1111 | section views、table、dialogs |
| `apps/web/src/pages/admin/TournamentAdmin.tsx` | 1072 | tournament admin subsections |
| `packages/agent-core/src/client.ts` | 1081 | socket、reconnect、hand state、action、waiter |
| `packages/agent-core/src/postflopPolicy.ts` | 1469 | policy stages、range、decision helpers |

这些文件不是首轮重点。先完成 `game.ts`、`TablePage.tsx`、stats 层和命名消歧，再根据实际依赖图决定是否继续拆。

### 2.3 应该合并或消歧的重复模块

#### A. `pokerHotkeys`

```text
packages/shared/src/pokerHotkeys.ts         # 84 行：PokerHotkeyAction、默认绑定、配置校验、event->binding 解析
apps/web/src/features/table/pokerHotkeys.ts # 100 行：当前下注状态可用性、hotkeyIntent()、action latch、overlay/typing 判断
```

**结论：不合并实现，只改名消歧。**

```text
packages/shared/src/pokerHotkeyPrefs.ts
apps/web/src/features/table/hotkeyIntent.ts
```

旧路径短期保留 re-export façade，等调用方和测试迁移后再单独删除。

#### B. `equity`

```text
apps/server/src/equity.ts         # 124 行：已知双方 hole cards + 公共牌，exact/MC，worker，服务 all-in multi-run
apps/server/src/equityWorker.ts   # 169 行
packages/agent-core/src/equity.ts # 387 行：bot 自己 hole cards，对未知对手范围采样，多对手 MC，内联于决策
```

**结论：绝不能合并算法。** 建议改名：

```text
apps/server/src/multirun/equityWorkerService.ts
apps/server/src/multirun/equityWorker.ts
packages/agent-core/src/equityEstimator.ts
```

旧入口保留 re-export。worker 的 URL 探测和 `tsx` 启动参数必须保持原样；只改文件名和 import，不改 timeout、seed、samples、error code。

#### C. `house`

```text
packages/shared/src/house.ts # 60 行，类型和协议形状
apps/server/src/house.ts     # 167 行，SQLite 业务查询和 dues 分配
```

**结论：类型可以归并命名，业务实现不能搬入 shared。**

```text
packages/shared/src/houseTypes.ts
apps/server/src/finance/houseDues.ts
```

shared 只保留 `HouseBalance`/`HouseRoom`/`HouseDues`/`PlatformDuesReport`/`CommissionSettings`/`AdminOverview`；server 继续负责 SQL、commission 分配、odd chip 分配、void-hand 排除、platform account 解析、`houseDues()`/`platformDues()`。

#### D. `platform-crypto`

`apps/server/src/platform-crypto.ts`（18 行）与 `apps/web/src/shared/crypto.ts`（41 行）存在逐字节镜像关系。

**结论：本轮不抽成 shared 包。** 原因：① `packages/shared` 不应依赖 `packages/mental-poker`；② 浏览器和 server 的 crypto runtime 不同；③ 金融账户登录依赖 golden vector，统一收益不足抵风险。保留双份实现并保持参数 `N/r/p/dkLen`、salt/domain string、`identityFromSeed`、golden-vector 测试。

### 2.4 应该删除的内容

#### A. 直接删除 tracked IDE hook 配置

HEAD 中仍跟踪：`.codex/hooks.json`、`.cursor/hooks.json`、`.grok/hooks/impeccable.json`（前两者写死 `/Users/notpritamm/...`）。`.gitignore` 已包含这些目录，但忽略规则不会自动取消跟踪。建议删除 tracked 文件；如需 hook 则放本地或 `.example`。

#### B. 可删除的 generated duplicate

根 `.impeccable/` 与 `apps/web/.impeccable/`。建议先确认工具读取路径后只保留一套源：根 `.impeccable/design.json` 作为 authority，`apps/web/.impeccable/surfaces/` 视为生成物。**未确认前不要直接删除。**

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
    routes.ts                      # room HTTP routes
    repository.ts                  # room row / membership / player queries
    presentation.ts                # presentablePlayers、room state
    lifecycle.ts                   # archive/unarchive/delete/close
    permissions.ts                 # membership/canBank/isSpectator

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
- `game.ts` 在迁移期间作为稳定入口，避免一次性修改 `hub.ts`、测试和其他 server 调用点。

**纯移动**：将既有 section 按原代码移动到对应文件、调整 import/export、保持方法体/调用顺序/异常文本/计时值不变、`game.ts` 继续导出原有公共符号。

**非纯移动**：将 `Hand` 私有状态拆成 `HandContext`/`HandPorts`；将 settlement writer 抽出；将 SQL 查询从路由注册函数抽出。均属中/高风险，需单独提交和更强测试。

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
        TablePrompts.tsx          # countdown、run prompts
        TableOverlays.tsx         # feature ribbon、result、last hand
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

职责规则：`TablePage.tsx` 只负责组合；`features/table/model` 负责页面状态与 view model；`widgets/table/canvas` 负责牌桌视觉与座位呈现；`widgets/table/controls` 负责可操作控件；`widgets/table/overlays` 负责覆盖层。禁止 widget 依赖 page（`LeaderboardRow` 迁到 `entities/leaderboard/model.ts`）。

**保持不动的前端 authority**：`apps/web/src/widgets/table/geometry.ts`（拆 `RoundTable` 时不得复制或移动其中的桌面尺寸、座位锚点和 ribbon 计算常量）。

### 3.3 packages 目标结构

`packages/shared` 不做大规模目录重写，只做命名整理（`houseTypes.ts`、`pokerHotkeyPrefs.ts` 等），核心协议文件 `cards.ts`/`betting.ts`/`wsProtocol.ts` 保持顶层。

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

`preflopCharts/data/*.ts` 是自动生成/导入数据（`build.ts` 405、`frlaRfi.ts` 417、`frlaBbDefend.ts` 442、`mhlHu.ts` 178），体积是内容本身，保持自动生成边界，不手工重写。

---

## 4. 重点拆分设计

### 4.1 `game.ts` 拆分边界

**第一层：保持两个状态机**（`GameRoom` 房间连接与桌级状态；`Hand` 一手牌权威时序），不要先合成一个 reducer，也不要引入通用 event bus。

`GameRoom` 抽出到 `game/room.ts`，保留 `join`/`leave`/`send`/`broadcast`/`broadcastRoomState`/`settingsChanged`/host handover/auto-deal/ready check/`startHand` 调用/post-hand show 与 peek 房间入口。纯操作抽到 `game/roomFeatures.ts`（`claimHandFeatures`/`releaseFeatureClaims`/feature snapshot normalization）。

`Hand` 拆分：

1. `hand/lifecycle.ts`：`begin`/`clearTimer`/`armTimer`/`onTimeout`/`abort`/`onPlayerGone`/`foldDroppedIfDecisive`/`renudge`/retry 与 deadline。约束：不改 timer 创建与清除顺序，不改 timeout 后 abort/fold/recover 逻辑，不改全局 scheduler。
2. `hand/transcript.ts`：`appendServer`/`appendPlayer`/head 计算/事件 payload。约束：不改事件 type、不改签名覆盖 payload、不改 head 计算顺序。
3. `hand/audit.ts`：`onShowCards`/`verifyShowShares`/`onKeyCommit`/`onRevealKey`/voluntary show/peek/key recovery 审计事件。加密核心仍调用 `@4am/mental-poker`。
4. `hand/dealing.ts`：`requestShuffle`/`onShuffle`/`startDealing`/`kickChain`/`onUnmaskShare`/`chainDone`/board opening/fold-key recovery；`Chain`/`Point`/deck index 映射集中到 `hand/types.ts`。
5. `hand/betting.ts`：`startBetting`/`startBombBetting`/`onAction`/`applyEngineAction`/turn timer/`timeBanks`/`broadcastBetting`/`coordinateTurn`/street transitions。只做文件拆分，不做算法简化。
6. `hand/multirun.ts`：`runBoardIndexes`/`boardForRun`/`runoutIndexes`/`beginMultiRunDecision`/`onRunCountChoice`/`onRunCountAgree`/`finishMultiRun`/equity error handling。worker service 通过明确接口注入（`MultiRunPorts`），第一阶段可仍通过 `Hand` callback 调用。
7. `hand/showdown.ts`：`requestReveals`/`afterRevealsComplete`/reveal snapshot/board reveal sequencing/winner score 前的 reveal assembly。
8. `hand/settlement.ts`：pot 与 commission 计算/单跑与多跑 award/squid/settlement deltas/`hand_end` 组装。纯计算优先变成 `computeSettlement(input): SettlementResult`（不访问 DB、不 broadcast）。
9. `game/settlementWriter.ts`：`applyHandSettlement`/ledger/rake/hand projection/final stack/time bank epoch/feature trigger 标记/settlement idempotency。**必须保持“一次 SQLite transaction”。**

### 4.2 `TablePage.tsx` 拆分边界

**第一批（低风险纯组件）**：`95–129 -> TableClock.tsx`、`130–354 -> TablePrompts.tsx`、`355–408 -> DesktopIconButton.tsx`、`409–424 -> useViewportSize.ts`、`425–440 -> holeStrengthLabel.ts`。这些模块只接收 props，不访问整个 page state。

**第二批（table session hook）**：约 562–583 的 join/leave 抽为 `useTableSession(roomId)`（`bindGameClient`/`wsClient.joinRoom`/`api.getRoom`/room feature fetch/cleanup/voice leave/ws leave/store room reset），不负责渲染、dialog 状态、layout。

**第三批（seat view model）**：约 816–864 的 `seatViews` 组装抽为 `useTableSeatViews.ts`（输入 room/hand/auth/voiceState/botByUserId，输出 `SeatView[]`）。

**第四批（overlay 与 dialog 状态）**：`useTableOverlays.ts` + `TableOverlays.tsx` + `TableDialogs.tsx`，覆盖 chat/result/reaction/feature ribbon/peek/share/standings/invite/watch/auto-deal/gameplay settings/bots/broke buy-in。

**最终 `TablePage.tsx`** 目标约 300–600 行：读 route 参数、调用 hooks、少量 page-level flags、组合 canvas/controls/overlays/dialogs。

---

## 5. 分批实施计划

每批单独提交，保留父提交作为回滚点，不把功能修改混入重构提交。

### 批次 0：冻结基线（不改代码）
等待本轮所有功能 lane 合并；从最新主线建重构分支；记录实际 commit 与基线（`npm run typecheck` + 三包 `vitest`：agent-core ~317 / server ~723 / web ~85，以执行时输出为准）。任何 baseline 失败先修功能 lane，不开始重构。

### 批次 1：仓库卫生与独立工具归位（纯机械）
删除 tracked 的 `.codex/hooks.json`、`.cursor/hooks.json`、`.grok/hooks/impeccable.json`；把独立预览应用 `docs/qa/table-skins/`、`docs/qa/table-faces/` 移到 `tools/visual/`；更新 README 与 Vite root/import。不移动截图与 QA 报告。验证：两个 preview 跑通、`git diff --find-renames` 确认是移动、测试不受影响。

### 批次 2：重复命名消歧（不改算法与 API）
新增 `pokerHotkeyPrefs.ts`/`hotkeyIntent.ts`/`multirun/equityWorkerService.ts`/`equityEstimator.ts`/`houseTypes.ts`/`finance/houseDues.ts`；旧入口保留 re-export。验证重点：server equity（exact board、MC seed 复现、worker timeout、equity_failed）、agent equity（uniform/weighted/multiway fallback/seed 复现）、hotkeys（config 校验、event 解析、action latch、legal mapping）、house（platform dues、odd chip、void 排除）。回滚只恢复旧 import；**本提交不能删除 façade**。

### 批次 3：shared 偏好与类型归并
消除 `ALL_IN_RATIO`/`BET_RATIO_OPTIONS`/`BET_RATIO_SLOTS`/`DEFAULT_BET_RATIOS` 在 `web/shared/store.ts` 与 `server/profile.ts` 的重复，提取到 `packages/shared/src/preferences.ts`；server 只留 `storedBetRatios`，web 只留 `sanitizeBetRatios`。约束：四槽历史仍可读、五槽不变、损坏 JSON 回退默认、server 不依赖 web、shared 不依赖 mental-poker。

### 批次 4：web table 低风险组件拆分
只抽 `TableClock`/`TablePrompts`/`DesktopIconButton`/`useViewportSize`/`holeStrengthLabel`，`TablePage` 仍是唯一组装入口。验证：web 85 tests + hotkey/tableUi/bettingPanel + browser baseline（1440×900、1280×720、390×844、844×390、multi-run、showdown、idle）对比 `data-testid`、文本、倒计时、disabled 状态、关键区域尺寸。

### 批次 5：web table session / seat model / overlay 解耦
拆 `useTableSession`/`useTableSeatViews`/`useTableOverlays`/`TableDialogs`/`TableOverlays`。验证除批次 4 外，重点覆盖 join 失败与 retry、slow message、watcher/spectator、feature claim/cancel、auto-ready、chat unread、result dismiss/Escape、fullscreen、bots polling、standings reload、voice cleanup、unmount 后不再发送。先迁移一类状态，确认后再删 page 内逻辑。

### 批次 6：`RoundTable` 拆分
目标 `canvas/RoundTable.tsx`、`canvas/HoleCards.tsx`、`canvas/SeatPod.tsx`、`canvas/tableMotion.ts`、`model/seatView.ts`、`feedback/CheckFeedback.tsx`；`geometry.ts` 不移动不复制。验证：browser baseline 全视口 + overlap probe + post-hand deal + hotkey probe + bots probe + stats HUD probe + reduced-motion，对比座位位置、table scale、揭示、winner FX、turn progress、bot badge、mobile canvas。`RoundTable` 保留兼容导出。

### 批次 7：统计层拆分
拆 `handProjection.ts` 为 `stats/projection/{ddl,voidSql,parser,writer,backfill}.ts`；拆 `handStats.ts` 为 `stats/{types,metrics,query,hud,routes}.ts`；旧入口只 re-export。**严禁改变**：`HAND_PARSER_VERSION`、DDL、migration 顺序、void-hand 语义、`strict`/`verifyHead`、projection 与 settlement 同事务关系、HUD 样本门槛、private mode redaction、metricVersion、统计结果字段名。

### 批次 8：`game.ts` 机械目录拆分
按 section 移动为 `game/{index,room,settlementWriter}.ts` + `game/hand/{types,lifecycle,transcript,audit,dealing,betting,multirun,showdown,settlement}.ts`；根 `game.ts` 暂为 `export * from './game/index.js'`。规则：方法体原样移动；私有访问用 `HandContext`/callback 解决、不用 `any`；不改 timer/broadcast/append 顺序、异常文案、事务边界、`activeHands` 生命周期。验证：server 全量（重点 autoDeal/botE2E/botRunnerReconnectE2E/integration/lifecycle/roomClose/equity/pokerHotkeys/persist/ledger/merge/history/voidHand*）+ `node --import tsx apps/server/test/botEval.mjs`（200 hands、deterministic seed、0 abort、0 rejected、0 bot error、ledger conserved、duplicate replay same cards、0 fallback、0 illegal）。

### 批次 9：`GameRoom`/`Hand` 高风险解耦
仅在批次 8 稳定后进行：`Hand` 依赖改显式 `HandPorts`；settlement 纯计算改 snapshot 输入；DB settlement writer 只接收已解析的 `HandSettlementWrite`；multi-run equity 经端口注入；audit/transcript 只经事件 writer；room lifecycle 不再直读 Hand 私有字段。目标依赖方向：`game/room -> game/hand facade`；`game/hand/* -> shared protocol / mental-poker / injected ports`；`game/settlementWriter -> db / ledger / projection`；`stats -> db projection only`。不做：全局 event bus、reducer 化、协议变更、DB writer 异步队列、时钟模型变更、最终一致性结算。验证除全部单测外，必须运行 server 全量 + browser baseline + post-hand deal + poker hotkeys + bot live + `evalInfra.test.mjs` + `botEval.mjs` duplicate + 至少一次真实多跑/strict-audit/断线恢复与 timeout。**高风险批次必须在独立分支提交，失败整体回滚，不做局部热修复。**

### 批次 10：中间产物与临时文件清理（已拍板不归档，独立提交）
目标：回收仓库体积、清掉一次性中间证据与冗余 dotfile。**只删产物与文件，不改业务代码。**

实测基线（`6828fb3` 工作区）：`docs/qa` 92M / 429 文件，其中 **201 个未跟踪 / 约 65M**（`table-layout-b` 95、`table-motion` 68、`stats-pro` 14、`bot-playtest` 14、`table-hero-clear` 10）；仓库内无一次性 probe/tmp 脚本、无 `*.log/tmp/bak/orig/rej`、无 tracked `dist/`；`.impeccable/` 根与 `apps/web/` 两处并存。

顺序与约束：
1. **先 grep 并修正引用**：删除前确认 `docs/plans/*.md`、各 feature README、代码注释中是否引用待删文件（已报 `table-layout-b/README.md`、`stats-pro/README.md` 引用未跟踪截图），先改文档再删。
2. **裁定 `docs/qa/table-hero-clear/`**：确认为最新结论则补提交，否则删——不能悬着。
3. **按文件/子目录精确删除**未跟踪的中间证据与被取代的报告；保留各 feature 的 README、最终 sign-off、关键基线图与仍被 probe 使用的 fixture。
4. **`.impeccable` 重复**：先确认工具读取路径，再删冗余的一份。
5. **`/tmp` 本项目产物**（实测约 2.2G，`/tmp/4am-*`、`/tmp/opencode/4am-*`）：不在仓库内、**不属于任何提交**，可随时直接清理；不影响仓库体积，不必等重构。
6. **不做**：`rm -rf docs/qa` 式整目录删除；删除仍被 harness/probe 引用的 fixture；与源码重构混在同一提交。

验证：`git status` 干净、`docs/qa` 体积下降、所有 harness 与 probe 仍可运行、`git diff --find-renames` 不出现意外的源码改动。

---

## 6. 不做清单

1. **不改协议 schema**：`wsProtocol.ts`、`betting.ts`、`cards.ts`、`agentSchema.ts`。
2. **不改加密核心**：`packages/mental-poker/src/*`、`apps/web/src/shared/crypto.ts`、`apps/server/src/platform-crypto.ts`（golden vector 必须继续通过）。
3. **不改账本、迁移与结算历史**：`merge.ts`、`ledger.ts`、`persist.ts`、`settle.ts`、`scripts/rewrite-rake-to-platform.ts`；不合并 ledger 与 settlement、不改 ledger kind、不改 ref/head 关联、不删历史 migration、不改 void 排除语义。
4. **不合并两种 equity**（安全边界不同）。
5. **不大规模重排 `packages/shared`**（只做 hotkey/house/偏好三处）。
6. **本轮不拆全部大文件**（tournaments/social/botRoutes/profile/tournaments 页面/admin 页面/PlayerPage/postflopPolicy 登记后续）。
7. **`docs/qa` 清理**（已拍板：**不归档，直接删**，见批次 10）：保留每个 feature 的 README、最终 sign-off、关键基线图、仍用于 probe 的 fixture 与最终 result JSON；删除中间过程截图、被后续轮次取代的证据、旧时间戳报告、重复 JSON。**先修正引用它的 tracked 文档，再删，独立提交。** 仍不建议 `rm -rf docs/qa`（按文件/子目录精确删除）。

---

## 7. 验证策略

- **纯移动/改名**：`npm run typecheck` + 三包 vitest；`git diff --find-renames`；export surface 不变、只有路径变化、无协议/SQL/常量 diff。
- **server 重构**：游戏时序（start/commit/shuffle/unmask/betting/timeout/fold/reveal/multirun/showdown/settlement/auto-deal）；资金不变量（ledger conservation、rake recipient、final stacks、duplicate idempotency、negative stack、time-bank epoch、squid net zero）；审计不变量（transcript head、player signature、reveal key、show shares、strict audit、malformed rollback）；bot/eval 全部检查项断言。
- **web 重构**：单测基线 + 浏览器探针（table-baseline、poker-hotkeys、post-hand-deal、table-overlap、stats-pro、stats-pro-real、bot-live、table-bots）。
- **截图规则**：不要求逐像素一致，但桌面 canvas 比例、座位锚点、hole cards 位置、action bar 与 betting panel 位置、prompt 遮挡、手机横竖屏溢出、reduced motion、overlay Escape/focus trap、`aria-label` 与 `data-testid` 必须不变。`geometry.ts` 变更一律视为行为变更，不能与组件拆分同提交。
- **agent-core**：clientResync、clientSocketHandoff、multiRunDecision、equity、decisionView、preflopAdaptive、postflopPolicy*、rulePolicy、sessionMemory；证明改名未改输入输出、`client.ts` 拆分未改 reconnect/resync/hand frame 过滤、`apps/mcp/src/client.ts` 兼容 re-export 仍可用。

---

## 8. 主要风险与缓解

| 风险 | 缓解 |
|---|---|
| 私有状态拆分导致隐式依赖丢失（顺序/`this`/timer/settlement/phase） | 第一阶段只移动 + callback；不强行纯函数化；每 section 拆完立刻跑测试 |
| worker URL 与构建环境变化 | 保留 `equity.ts` façade；`resolveWorkerUrl()` 原样；单跑 server equity tests + production build；不改动态 import |
| 结算事务边界被无意改变 | 先只移动文件；writer 单独提交；强制保留 `db.transaction(...)` 外层；duplicate settle / negative stack / projection rollback 测试 |
| 统计投影与实时结算解耦错误 | writer 仍同步调用 projection；API 保持同步；只改文件位置 |
| `TablePage` effect 生命周期变化 | `useTableSession` 先单独抽取 + unmount 测试；保留 `pokerActionLatch`；不改 dependency array；probe 验证 resize/route change/unmount |
| QA 清理误删证据 | QA 清理独立于源码重构；先 grep 出所有引用并修正 tracked 文档，再按文件/子目录精确删除；保留各 feature 的 README、最终结论与仍被 probe 使用的 fixture |
| 重构分支与功能 lane 冲突 | 功能 lane 全部完成后再做批次 4+；批次 1–3 可先做；每批从最新主线 rebase；不在重构提交顺手修 bug |

---

## 9. 完成标准

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
11. `docs/qa` 中间过程证据在修正引用后按批次 10 精确删除；各 feature 的最终结论与 probe fixture 保留。
12. 任何结构提交都不含功能扩展或产品行为修改。
