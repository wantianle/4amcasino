# P2 玩法实现契约（设计定稿）

依据 `docs/table-redesign-spec.md` 的 P2 + 四轮问答。服务端 = Fastify + better-sqlite3；手牌引擎在 `apps/server/src/game.ts`（单房间内存态）；账本 `ledger.ts`（hash 链）。

## 0. 规则口径（实现按此）
- **B1 鱿鱼**：**仅手动**触发（房主）。触发后在本手结算时：**每个未获胜者**向**其他所有参赛者**平付罚金，`罚金 = n×BB×(参赛人数−1)`，从桌面筹码扣；`n` 房主可设，默认 1×BB；`squidMinPlayers` 门槛（默认 3），不达标则该手不触发（触发保持 pending）。参赛者 = 本手 `HandSeatInfo` 快照。单人=赢家，其余为未获胜者；短码只付可用筹码（不产生负筹码）。多次发牌时，须**每一跑都第一**才算赢家（交集为空则无人领赏、不转移）。
- **B2 计时银行**：每房开关。每人初始 X 秒；**每结算 N 手补 Y 秒**（默认 30s / 30手 / 30s）。普通行动计时先走，超时才扣银行；`actionSecs=0`（不限时）不扣银行。改配置清零重置（epoch 机制）。
- **B3 炸弹池**：设定后按**手数或时长**激活；触发**手动 + 定时都要**。激活手每人**前注**（按 BB，1×/2×/3×，默认 1×）才能参与，**跳过翻牌前下注**直接翻牌；前注进底池、正常抽水、正常参与边池；**双牌面不做**。手动与定时撞同一手 → 只开一次。
- **B4 全下多次发牌**：全下且有未发牌时，服务端按**实时胜率**判定优势方；**劣势方选 1–3 次**；**优势方同意才发**；拒绝/超时 → 发 1 次；**多人（>2 未弃牌）只发 1 次**；无未发牌只 1 次；胜率相等只 1 次。**发牌前先亮牌**再算权益。**鱿鱼游戏中允许多发，但只有全赢才拿鱿鱼**。
- **权益**：`equity.ts`/`equityWorker.ts` 已实现（flop/turn/river 精确枚举，preflop 确定性蒙特卡洛 25000 样本，tie=0.5，排除已弃牌，2s 超时→`equity_failed`→按 1 次）。

## 1. 已完成的 P2 基础（Lane 0/A/B/C，已提交 62de267）
- 共享类型：`@4am/shared` 的 `RoomGameplaySettings`、边界常量、`startBombPot()`、`bestScoreSeats/intersectSeatSets/splitAmountEven`；`wsProtocol` 新增 `run_count_choice/run_count_agree`（签名）与 `feature_started/time_bank_update/multi_run_offer/multi_run_result/squid_result`；`board_open.run:1|2|3`；`betting_state.baseDeadline/timeBanks`；`showdown.multiRun`。
- 服务端：`rooms`/`room_players` 迁移、`room_gameplay_state`、`room_feature_triggers`；`rooms.ts` 的 `features` 校验/序列化（**host-only**，手牌进行中拒绝 409）、`POST/DELETE /api/rooms/:id/feature-triggers`（requestId 幂等）；`profile.ts` 报表计入 `squid-game`（手数只算 `hand-settlement`）。
- 权益：`apps/server/src/equity.ts`（`computeHeadsUpEquity`）、`equityWorker.ts`。
- 客户端：`api.ts`（`setRoomFeatures/triggerFeature/cancelFeatureTrigger`）、`gameClient.ts`（`chooseRunCount/agreeRunCount` + 新消息处理）、`store.ts`（`boards:CardId[][]`、`baseDeadline`、`timeBanks`、`featureStarted/multiRunOffer/multiRunResult/squidResult`；`board/board2` 为临时兼容）。

## 2. 引擎改造要点（Lane E，独占 `game.ts`/`hub.ts`）
1. **手牌 ID 先于功能认领生成**（现在在 `Hand` 内生成）：在 `GameRoom.startHand()`（约 game.ts:731-800）生成，传入构造函数。
2. **原子认领**：`startHand()` 内一个 `db.transaction().immediate()`：读 pending 手动触发（`room_feature_triggers`）+ 定时（`room_gameplay_state` 手数/时长）→ 认领为 `claimed` 并绑手牌；快照 squid/bomb/timebank 设置与余额。启动恢复：`claimed` 且无对应 transcript → 复位 `pending`。
3. **炸弹池**：手牌创建后，`startBetting()`（约 1638-1649）若为炸弹手：调 `@4am/shared` 的 `startBombPot()`（无盲注、每人 `min(stack,ante)`、短码 all-in、合成已关闭的 preflop），记 `bomb_pot_start`，广播 `feature_started`，**直接开翻牌**，绝不广播翻牌前行动；随后走统一回合协调器，避免 `toAct=null` 卡死。
4. **回合计时重构**：把散落的“重算 deadline”改为显式 `beginTurnTimer()/consumeTurnTime()/finishTurnTimer()`；`baseDeadline = startedAt + actionTimeoutMs`，`finalDeadline = baseDeadline + 该座位银行`；只在**动作成功应用后**扣银行（`max(0, now-baseDeadline)`，封顶银行）；超时扣满当轮分配的银行再自动弃牌；非法/重复动作不扣。`broadcastBetting()` 不得再 mint 新 deadline。
5. **全下 → 先亮牌再决策**：街结束且 `activeNonAllIn<2` 时设 `runout=true`，若牌未发完先 `requestReveals()`，亮牌后算权益，再决定是否多次发牌，最后才发余牌。
6. **B4 决策**：权益→判优势/劣势；>2 未弃牌 / 无余牌 / 权益相等 → 1 次不发提示。发 `multi_run_offer`（stage=behind-chooses）；劣势方 `run_count_choice`（1/2/3）；选 1 立即定；选 2/3 → 新 deadline、stage=ahead-agrees；优势方 `run_count_agree`；拒绝/超时 → 1。全部带 `decisionId`，拒收过期/越权/无效/重复；`resendPending()` 要重发当前 stage。
7. **通用多跑**：`runMaps`（run 2..N 的 boardIndex→deckIndex），`boardForRun(run)`，按 run 顺序开牌（先补齐 run1 再 run2/run3）；已有公共牌各跑共享；`index<52` 断言，越界回退 1 次。结算按 `base=floor(pot/runs)`、余数给靠前的跑；每跑用该跑底池切片调 `awardPots()`，合并 per-seat awards。
8. **B1 结算**：`Hand.settle()`（约 2021-2120）算赢家集合（弃牌赢=该座；单跑=最高分并列；多跑=各跑最高集合的交集，空=无领赏）；`requestedPerLoser = n×bb×(participantCount-1)`；按可用筹码封顶 + 平摊到其他参赛者；聚合 per-seat squid net；写 `squid_result`。
9. **原子 finalization**（约 game.ts:2164-2223，一个事务）：poker 结算 + rake + **squid net** + 每座一条聚合 `kind='squid-game'` 账本（note「鱿鱼游戏罚金/赔付」）+ **time bank 余额/计数/补秒** + 触发 `applied` + transcript + `completed_hands` 累加 + 炸弹调度锚点更新。`hand_end.deltas` = poker+squid 合计，另带 `pokerDeltas/squidDeltas`。
10. **中止**：claimed 手动触发复位 `pending`；本手不落任何筹码/账本/银行。
11. **重连**：`resendPending()` 需恢复当前 multi-run stage 与 time bank。

## 3. 并发/幂等
- `GameRoom` 仍是单房间手牌唯一内存 owner；REST 不得直改内存手牌。
- 设置改动在 `activeHands` 期间拒绝；设置在手牌创建时快照。
- 触发认领用 immediate 事务 + requestId 幂等。
- 结算单事务 + transcript 主键/阶段守卫防重复。

## 4. i18n
新串按 `docs/zh-i18n.md`，加在 `dict/{lobby,table,table-page,server,misc}.ts`：玩法规则/鱿鱼/计时银行/炸弹池/多次发牌相关标签、状态、按钮、服务端校验消息、账本注（`Squid Game penalty/payout`→「鱿鱼游戏罚金/赔付」）。

## 5. 车道计划
- **Lane E（独占，串行）**：`game.ts` + `hub.ts` + 集成测试。依赖 0/A/B，已就绪。**最高风险**，勿并行改 game.ts。
- **Wave 2（E 稳定后并行）**：Lane F=2D（TablePage/ActionBar/TurnProgress/RoundTable/players/LastHandStrip+dict）、Lane G=3D（table3d/**）、Lane H=server prose 词典。
- **收尾**：跑共享/服务端/权益/集成测试（正常手、炸弹两种调度、短前注、计时银行动作与超时、2/3 跑同意与拒绝与两段超时、多人强制 1 跑、鱿鱼单跑/并列/多跑全赢/分跑无领赏、炸弹×多跑×鱿鱼同手、崩溃恢复）；web typecheck；2D/3D 重连手测；每笔经济后校验账本与筹码守恒。

## 6. 主要风险
**B4 × 计时/回合过渡改造**：现引擎假设“投票先于亮牌 / 至多两张牌 / 同一 yes-no / broadcast 可 mintage deadline / 专门的两跑结算分支”。B4 全部推翻。必须由单一 owner 用显式“回合协调器”一次性改造，避免：计时被延长、`toAct=null` 卡在翻牌、过期同意消息误伤、重复/缺失牌索引、奇数筹码分配错、鱿鱼误发给只赢一跑者、重连取不回当前决策阶段。
