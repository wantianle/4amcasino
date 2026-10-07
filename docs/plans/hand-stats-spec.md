# 手牌统计：规范化数据结构 + 专业模式规格（2026-10-05）

来源：oracle 规格（只读设计）。本文件是落盘副本，实现前请以此为准。

## 0. 设计原则

- `transcripts` 仍是不变审计源；统计表是其**规范化投影**，不是新事实源。
- 只统计：已完成、未 void、`hand_settlements` 已确认的手牌，`ledger.kind='hand-settlement'` 的扑克输赢。
- `purchase`/`revert`/转账/house/squid 不计入扑克行动统计；squid 单独展示。
- 非摊牌底牌永不写入统计表；只有 transcript 已公开的牌可进 `revealed_cards_json`。
- 规范化数据必须与 `applyHandSettlement()` **同一 SQLite 事务**写入。

## 1. 表（SQLite）

### hands
`hand_id PK, room_id, source_head UNIQUE, status(settled/aborted/voided/invalid), game_kind(normal/bomb_pot), button_seat, sb, bb, bomb_ante, run_count, gross_pot, rake, commission_bps, board_json, boards_json, started_at, settled_at, transcript_ts, parser_version, projection_status(ok/legacy/invalid/error), projection_error`。索引 `(room_id, settled_at DESC)`、`(status, settled_at DESC)`、`(source_head)`。

### hand_players
`PK(hand_id, seat)`，`UNIQUE(hand_id,user_id)`：`user_id, position, position_index, preflop_order, postflop_order, starting_stack, ending_stack, blind_role(none/sb/bb/ante/sb_bb), nominal_blind, forced_post, invested, poker_award, poker_delta, squid_delta, net_delta, folded, fold_street, saw_flop, went_to_showdown, won_poker, revealed_cards_json, data_confidence(exact/legacy/partial)`。索引 `(user_id, hand_id)`、`(user_id, position, hand_id)`、`(hand_id, user_id)`。

### hand_actions
`PK(hand_id, action_no)`：`source_seq, engine_action_seq, seat, user_id, street(preflop/flop/turn/river), action_type(post_sb/post_bb/post_ante/check/call/bet/raise/fold/timeout_fold), amount_to, amount_added, pot_before, pot_after, is_forced, is_auto, event_ts, raw_json`。索引 `(hand_id,source_seq)` unique where not null、`(hand_id,street,action_no)`、`(user_id,street,action_type,hand_id)`、`(user_id,action_type,hand_id)`。

### 预聚合（P2/P3，非事实源）
`player_stats(user_id, scope_kind, scope_id, position, street, ip_oop, metric_version, ...counters, updated_at)`；`player_stats_vs(user_id, opponent_id, scope_kind, scope_id, metric_version, ...)`。P1 不建，后台从明细重建；必须支持 void/规则升级后的重建。

### 错误表
`hand_projection_errors(hand_id PK, source_head, parser_version, error_code, error_message, attempts, first_seen_at, last_seen_at)`。

## 2. 结算事务顺序（applyHandSettlement）
BEGIN → 1 insert hand_settlements(ON CONFLICT DO NOTHING) → 2 duplicate 直接返回 → 3 更新 stack → 4 hand-settlement ledger → 5 squid ledger → 6 rake ledger → 7 timebank/feature → 8 insert transcripts → 9-11 解析并 insert hands/hand_players/hand_actions → 12 更新 final_stacks → COMMIT。**解析错误必须抛异常回滚**。

对账：`hand_players.poker_delta` 必须能按 `ledger.kind='hand-settlement'` 对账；`squid_delta` 只来自 `ledger.kind='squid-game'`；`combined_delta = poker_delta + squid_delta`；`sum(poker_delta) = -rake`；`sum(squid_delta) = 0`。

## 3. game.ts 需补的 record 事件
- `hand_start`：加 `schemaVersion:2, startedAt, seats[].{position,positionIndex,dealingIndex,preflopOrder,postflopOrder}, gameKind`（`startMsg` 同步）。
- 普通盲注 `blind_post`（`startBetting()` 内，`betting_start` 前）：`posts[].{seat,userId,kind, nominal, amount(实际), stackAfter, potAfter, allIn}, ts`。
- Bomb `ante_post`（`startBombBetting()` 内）：同上（kind=ante）；不记 preflop betting round，ante 不算 VPIP。
- `action` 增强（`applyEngineAction()`，递增 actionSeq 前）：`street, amountAdded, potBefore, potAfter, ts`（`action.amount` 是 raise-to；`amountAdded` 才是投入；玩家签名仍只覆盖 `{action}`，新字段为服务器补充）。
- `timeout_fold`（`onTimeout()`/`foldDroppedIfDecisive()`）：`street, actionSeq, amountAdded:0, potBefore, potAfter, ts`。
- `street`（`afterBoardOpened()`）：`streetIndex, potAfter, ts`。
- `settlement`：加 `runCount, grossPot, showdown`、**`pokerDeltas`**（旧 `deltas` 无法区分 poker/squid）。
- 兼容：不删改现有 entry/字段；新字段进 transcript payload（影响新手牌 hash，不影响旧验证）；`ts` 用服务器 `Date.now()`，顺序仍以 `seq` 为准。

## 4. 指标定义（C=可推导 N=需新表 E=需新字段 P=隐私限制 L=旧牌仅 legacy）
- **Hands**：已结算未 void 且玩家在 hand_players 的手数。
- **VPIP**：preflop 有 call/bet/raise 的手数 / 有 preflop 决策机会的手数（排除 SB/BB 强制投入与 ante）。
- **PFR**：preflop 至少一次 bet/raise / 机会。
- **3bet/4bet**：面对一次 open(3bet) 后的首次再加注 / 机会（机会 = 该时点确有一次非强制加注且此前无 3bet）。
- **C-bet**：最后 preflop aggressor 进 flop、flop 前无人下注、面对 check 后主动 bet/raise；机会 = 该人进 flop 未 fold 未 all-in。
- **Fold to C-bet**：面对 flop c-bet 在本街首次非 fold 行动前 fold / 面对次数。
- **AF**：`(bet+raise)/call` 按街；分母 0 返回 `null`（不是 0）。AFq 类似。
- **W$SD**：`poker_award>0` 的 showdown 手数 / showdown 手数（tie/部分获奖算 win）。
- **WWSF**：`saw_flop 且 poker_award>0` / `saw_flop`。
- **bb/100**：`SUM(poker_delta/hand.bb)*100 / settled hands`（用该手 nominal bb）。
- **位置/IP-OOP**：position 由 button + occupied seat 固定表生成（见 §5）；IP/OOP 按 pairwise 实际 action order，仅在该街双方均可行动时计入。
- **底牌类**（起手牌频率、牌型、bluff/value、equity realization、range）受隐私限制，非摊牌不可得。
- **边界**：bomb pot 无 preflop 指标；multi-run 是一手（不按 run 放大）；squid 独立。

## 5. 位置算法（从 BTN 起行动环）
2:BTN,BB ｜ 3:BTN,SB,BB ｜ 4:BTN,SB,BB,CO ｜ 5:BTN,SB,BB,HJ,CO ｜ 6:…UTG,HJ,CO ｜ 7:…UTG,LJ,HJ,CO ｜ 8:…UTG,MP,LJ,HJ,CO ｜ 9:…UTG,UTG+1,MP,LJ,HJ,CO。只对实际发牌 seat 计算；button 用本手 `buttonSeat`；HU 中 BTN 即 SB；`position_index` 固定，不随 fold 变。

## 6. API 与前端
- 普通模式=现状（`/style`、`/timeline`、`/me/hand-history`、rooms hands、profile）语义不变。
- 现有接口契约 `GET /api/me/stats`（from/to/roomId/gameKind/position/street/ipOop/opponentId/minHands）返回 `{sample, stats:{<metric>:{hits,opportunities,pct}}, byPosition, byStreet, byIpOop, trend, dataQuality}`——**比率必须同时返回分子/分母**（已落地于 `apps/server/src/handStats.ts`）。
- 现有接口契约 `GET /api/users/:id/stats`（隐私更严，private_mode 隐藏）。
- 现有接口契约 `GET /api/rooms/:id/hud`（room member；minHands<20 样本不足、<50 低置信度）。
- 新增 `pages/stats/ProStatsPage.tsx` + `features/stats/{StatGrid,StatFilterBar,PositionMatrix,StreetStatsTable,OpponentHudTable}.tsx`；`/players/:id/stats`、`/room/:id/hud`；`?mode=pro` 显式 opt-in；metric version 变更提示。

## 7. 回填迁移
以 transcripts 为候选（优先有 hand_settlements）；每手独立事务解析→upsert→写 projection_status；失败写 `hand_projection_errors`，不改 transcript/ledger/stack。幂等键：`hand_id`、`source_head`、`(hand_id,seat)`、`(hand_id,action_no)`；同 source_head+version 跳过；head 不同标 error。旧牌缺 position/street/blind/potAfter/multi-run/bomb/squid 的兼容规则见 §3 与细则（严格区分 exact/legacy/partial，不伪装精确）。

## 8. 分阶段
- **P1**：三张明细表 + 同事务物化 + record 字段 + 回填 + `/api/me/stats` 基础（hands/VPIP/PFR/AF/net/bb100/WWSF/W$SD/位置基础）。验收：五表同事务、失败全回滚、ledger 逐手对账、squid 不污染、旧 replay/签名通过。
- **P2**：专业页 + 完整过滤 + 3bet/4bet/c-bet + 样本/置信度/metric version（可选 `player_stats` 缓存）。
- **P3**：`player_stats_vs` + `/hud` + 对手维度 + 增量缓存 + void/回填重建。

## 9. 明确不做
不做 OLAP/列存；不删改 transcript；不把 purchase/revert/squid 当扑克行动；不拆 multi-run；不把 bomb ante 当 VPIP；不从未公开底牌推导；无 opportunity 分母不返回伪精确百分比；不默认全表显示专业 HUD；不用客户端时间覆盖服务器顺序。

## 10. 风险
事务一致性（投影失败必须回滚）、旧数据不完整（legacy/partial）、写放大（聚合延后后台重建）、定义漂移（metricVersion）、隐私（room 权限/private mode/TV 权限）、对账（按 source_head 回 transcript、按 ledger ref 校验金额）。

## 11. 热/冷徽标（近 50 手净 bb，METRIC_VERSION=2）

后端在 `/api/rooms/:id/hud` 每个可见玩家条目上暴露 `streak` 字段。

### 口径
- **窗口**：该玩家在当前 scope（roomId / gameKind / position / opponentId 等过滤，scope 复用 `scopeHandsSql()`）下**最新 50 手**（`settled_at DESC`），与职业统计同一套 scope 约束；排除 void 手（复用 `VOIDED_HAND_EXCLUSION_SQL`）、未结算手、非 live 房间。
- **归一化**：每手用**该手自身**的 nominal bb，取 `poker_delta / bb`（bb>0 才计入，bb=0 无法归一化 → 跳过，不计样本）。
- **真实净赢 `realNetBB`**：窗口内每手 `poker_delta / bb` 的**未截断**之和（round 到 2 位小数）。大底池全量计入，不再对单手封顶——徽标分档直接看这个真实净赢。
- **有效样本**：窗口内 bb>0 的手数 `sample`。
- **中性带**：`|realNetBB| < 50` 不显示徽标（`tier=null`）。
- **样本下限**：`eligible sample < 20`，或 HUD 条目本身样本不足（隐藏 / private_mode）时整个 `streak` 为 `null`。注意 `eligible sample` 指 `bb>0` 的手数，不是 `stats.sample`（所有事实手数）；20 手里有 1 手 `bb=0` → `stats.sample=20` 但 `streak.sample=19` → 不显示。

### SQL 层 50 手窗口
`computeHandStatsMany()` 的每个 per-user 查询在同一条 SQL 内 `UNION ALL` 两个 target set，并用 `in_stats` / `in_streak` 列标记：
- `stats`：最新 `@limit` 手（通用统计窗口，默认 5000、上限 100000，行为不变）；
- `streak`：最新 `LIMIT 50` 手（字面量，绑在 SQL 里，**不是 JS `.slice(0,50)`**）。

两个 target set 复用同一个 `scopeHandsSql()` 片段与同一套 scope 约束（void / settlement / live room / roomId / gameKind / position / opponentId / from-to / street）。`buildResult()` 按标记拆分：`stats` facts 进通用统计，`streak` facts 进 `streakFor()`。这样
- 不新增每玩家一次 streak 查询（batch 设计不变）；
- 小 `limit` 不会缩小 streak 窗口，大 streak 窗口也不会灌进通用 sample；
- 50 手边界可在 SQL 层用测试断言（per-user SQL 同时含 `LIMIT @limit` 与 `LIMIT 50`）。
- **tie 排序**：SQL `ORDER BY settled_at DESC, hand_id DESC` 使用 BINARY collation；`streakFor()` 不再重排（直接消费 SQL 已排序/已截断的 facts），避免 JS `localeCompare` 与 SQLite 在 `settledAt` 相同时选出不同的第 50 手。

> **性能备注（复审观察，当前非错误、本轮不优化）**：`UNION ALL` 的两个 target set 各自执行一次 `scopeHandsSql()`，因此 scope predicate 实际会被求值两次；per-user 查询的 `ORDER BY settled_at DESC, hand_id DESC` 在 `EXPLAIN QUERY PLAN` 中会显示 `USE TEMP B-TREE FOR LAST TERM OF ORDER BY`。单玩家 / HUD roster 规模下开销可接受，先记录为此处已知代价；若后续成为热点，再考虑合并 target set 或补 `(user_id, settled_at DESC, hand_id DESC)` 覆盖索引，而不是改变 50 手上的语义。

### 阈值（真实数据校准）
生产库 4228 手、4179 个滚动 50 手窗口：真实 50 手净赢 **sd ≈ 93bb**（大底池主导：真实单手净赢 p50=0 / p90=+3 / max=+902bb，正因如此不再用截断分档）。四档取噪声地板的固定倍数：

| 档位 | 条件 | 含义 |
| --- | --- | --- |
| `hot2`（大火） | `realNetBB >= +100` | 大档热 |
| `hot1`（小火） | `+50 <= realNetBB < +100` | 小档热 |
| `cold1`（小冰） | `-100 < realNetBB <= -50` | 小档冷 |
| `cold2`（大冰） | `realNetBB <= -100` | 大档冷 |
| `null`（中性 / 样本不足） | `|realNetBB| < 50` 或 `sample < 20` | 不显示 |

边界包含端点：恰好 +50bb 是小火、恰好 +100bb 是大火。实测展示比例：±50 约 **13.2%** 的窗口有徽章（热 6.2% / 冷 7.0%），±100 约 **9.0%**（热 4.2% / 冷 4.8%）；对照已退役的 ±30 为 18.3%、±85 为 10.0%。

### 先验与再校准
上述 sd 由真实投影数据得到，属当前窗口（50 手）与单手模型的先验。若窗口长度或归一化模型变化（例如样本增大使 sd 变小），应**重新拟合 50 / 100 这两个绝对值**（以及相应的展示比例目标），而不是继续沿用旧档。

### API 形状
```
streak: { tier: 'hot2'|'hot1'|'cold1'|'cold2'|null, realNetBB: number, sample: number } | null
```
- 可见样本（`eligible sample >= 20` 且未被隐藏）：`streak` 恒为对象，`tier` 在中性带为 `null`，`realNetBB`/`sample` 始终给出。
- 样本不足（`stats.sample < 20` 或 `eligible sample < 20`）：`streak: null`。

### 三路径可见性（已拍板）
| 路径 | 可见性 |
| --- | --- |
| `GET /api/me/stats` | 本人恒见 `streak`（受 20 手 eligible 门禁）。 |
| `GET /api/users/:id/stats` | 仅**本人**见 `streak`；非本人 `streak: null`（即使对方未开 `private_mode`，通用 stats 仍可见）。`private_mode` 非本人整包 redacted（`streak: null`）。 |
| `GET /api/rooms/:id/hud` | 同房可见成员见 `streak`；`private_mode` 且非本人整条 hidden（`streak: null`）；样本不足 `streak: null`。 |

### METRIC_VERSION 与 web 侧同步（数据已接入）
本改动把 `METRIC_VERSION` 1 → 2。web 侧状态：
- `features/stats/types.ts`：`StreakTier`（`'hot2'|'hot1'|'cold1'|'cold2'`）、`StreakResult`（`{tier, realNetBB, sample}`）、`HandStats.streak`、`HiddenStats.streak: null`、`HudPlayer.streak`。
- **数据已接入**：`widgets/table/PlayerHud.tsx` 已消费 `p.streak`（渲染 `Last 50 hands net: {net} bb · {sample} hands`）；旧 winsorized 冷热分 tooltip 已移除。
- **视觉徽标仍待验收**：四档热/冷徽标（配色 + 图标，且 `streak !== null && streak.tier !== null` 才显示）尚未在座位头像/名字旁完全落地；`tier=null`（中性）或 `streak=null`（隐藏/低样本）不渲染的设计不变。
- mock/fixture 里的 `metricVersion` 更新为 2，补齐 `streak` 字段。

### 前端（数据已接入；视觉徽标待验收）
徽标放座位头像/名字旁。四档配色：红/黄/绿/蓝/紫需与既有 VPIP 色阶协商后再定；数据管道（`streak`）已接入 `PlayerHud.tsx`，**视觉徽标渲染本身仍待验收**。
