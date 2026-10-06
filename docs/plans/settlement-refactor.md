# 结算子域重构方案

> 调研基线：HEAD `6828fb36dbde587cca44bb9b8b49d1091f8d5551`，叠加当前未提交工作区。
> 调研日期：2026-10-05。
> 本轮仅做静态、只读核查；没有修改文件，也没有运行测试。
> 审查输入：当前代码，以及任务提供的最近 reject 五项摘要。未检索到该轮独立 reject 报告原文，因此不声称已核对原报告全文。
> **行号说明：带 `†` 的位置来自正在被功能 lane 修改的工作区，行号乃至局部实现可能继续漂移。必须以函数名重新定位。调研期间已观察到 `game.ts` 从约 4041 行增长至 4137 行；下文不将多次读取视为一个原子快照。**

---

## 0. 一页摘要

### 现状根因

问题不是缺少一个 `try/catch`，而是结算尚未形成明确的领域边界：

- 计算结果、数据库提交结果、终局消息各自持有或组装 stacks/deltas。
- 资金结算与通知耦合：`GameRoom.broadcast()` 会先写 `agent_events`，再发送 WebSocket。
- 自动 7-2、手后自愿亮牌奖金、peek 属于不同时间发生的交易，却缺少清楚的事务归属与持久幂等契约。
- “已经提交”“等待重试”“重试耗尽”“展示结束”由多个布尔值和 `phase='done'` 组合表达。
- 未提交结算没有可靠的持久待办记录；“transcript 无 marker”检测无法发现事务回滚后两者都不存在的手。

**最新工作区已局部修复旧 reject：**自动 7-2 已进入主事务和 combined deltas；新增 `applyFinalStacks()`；duplicate 分支补记内存 7-2 状态；新增内存重试入口、发牌检查及 WebSocket 未知异常标记。因此这些旧症状不能全部写成“当前仍未修复”。但目前修补仍依赖多个可变字段，不足以构成完整契约。

### 目标契约

```text
冻结输入
  → computeSettlement(input)                 纯计算
  → 完成 audit、封存 transcript 与写入输入
  → persistSettlement(result)                唯一财务事务
      → applyHandSettlement(...)
      → PersistedSettlement
  → broadcastSettlement(persisted)           只读已提交回执
  → 展示 hold
  → finalizeHand(persisted)                  只做终局通知和内存收尾
```

**本手最终 stacks 的唯一应用层权威是 `applyHandSettlement()` 返回的已提交回执。**

首次提交和 duplicate 均必须返回完整回执；不得返回空 stacks 再让上层猜测。`hand_end`、本次结算的 `room_state` 更新和 projection 必须消费同一提交结果。

自动 7-2 属于主结算。手后才触发的 fold-winner 自愿亮牌奖金属于独立、持久幂等的手后交易，不能假装发生在已经完成的主事务中，也不能篡改已封存 transcript。

### 分批实施

1. 先锁定契约和补测试，不拆生产代码。
2. 按仓库总方案批次 8 做纯移动。
3. 单独做批次 9 的显式输入/输出和状态边界抽取。
4. 分开提交行为修复：完整回执、纯计算接入、奖金幂等、通知隔离、异常模型。
5. 最后引入持久恢复记录和 operator 恢复流程。
6. 每批独立验证、独立回滚；数据库行为提交只允许回退到理解新增恢复记录的兼容版本。

### 优先不变量

一次财务事务、marker 幂等、ledger 守恒、真实最终 stacks、已提交 transcript head、void 排除、projection/parser 契约、rake 收款人、`strict`/`verifyHead`，优先级均高于目录整齐和抽象完整。

### 恢复推荐

采用 **持久运行记录 + 已封存待结算输入 + fail-closed 发牌闸门 + operator 恢复接口**：

- 可确认的暂时性数据库异常，重试相同输入。
- 重试耗尽，不清除手、不发新牌。
- 重启后有 marker：加载回执，不再付钱。
- 无 marker、有完整输入：恢复同一个 writer 调用。
- 无 marker、缺少可验证输入：隔离房间，人工裁定，不自动重算、不伪造 marker。
- 未知编程错误必须正常日志记录并标记不健康，不能伪装成客户端业务错误。

---

## 1. 现状事实与证据边界

### 1.1 最近 reject 与当前工作区的差异

| reject 主题 | 当前核查结果 | 仍需解决的结构问题 |
|---|---|---|
| 内存 stacks 不含自动 7-2 | 最新 `Hand.persistSettlement()` 已调用 `applyFinalStacks()`，自动 bounty 也已计入 combined deltas。`game.ts:3918–4044†` | 缺少参与者行已 fail-closed（显式抛 `settlement missing participant row`）；`hand_end` 仍独立重组 deltas；故障测试与回执审计仍待补齐 |
| 自动 7-2 在 `onDone()` 后另开事务 | 当前自动 7-2 已进入 `applyHandSettlement()`；`onDone` 注释明确不再支付。`game.ts:458–487,1450–1458†` | fold-winner 自愿亮牌奖金仍为独立交易，幂等依赖内存 Set |
| compute/persist/broadcast/finalize 混合 | 已有 `publishSettlement`、`persistSettlement`、`broadcastHandEnd` 等方法 | 方法拆分没有形成类型和数据所有权边界，仍访问同一组可变私有状态 |
| 冻结无恢复入口 | 已新增 `retry_settlement` 和 `Hand.retrySettlement()`。`game.ts:1155–1164,3899 起†` | 只能恢复尚在内存中的 Hand；无持久 prepared 输入 |
| 重启后可能继续发牌 | 已新增 `firstUnsettledHand()`、`startHand()` 检查。`game.ts:808 起,1364 起†` | 检测只覆盖“有 transcript、无 marker”，不能识别主事务完全回滚的未结算手 |
| duplicate 后可能再次支付 7-2 | 当前 duplicate 路径及提交后路径补调 `markSevenDeucePaid()` | 依据候选内存结果而非已提交回执；支付标记不 durable；writer duplicate 现走 `loadSettledReceipt()`，返回含 `finalStacks`/`gameDeltas`/`commissionDeltas` 的完整回执 |
| 未知错误被当作普通客户端错误 | `hub.ts:250–270†` 已区分 `GameError` 并调用 `markUnhealthy()` | settlement catch、timer catch、其他回调尚未形成统一分类与健康状态处理 |

这里的“已局部修复”仅表示核查到对应代码，**不等于该 lane 已经审查通过或故障测试通过**。

### 1.2 事务与 durable 的定义

下表中：

- **主事务**：`applyHandSettlement()` 内的一次同步 SQLite transaction。
- **durable**：在 SQLite 提交成功后持久存在；不表示 WebSocket 已交付，也不对底层存储故障作额外保证。
- **独立写入**：不受主结算事务保护。
- **内存状态**：进程退出即丢失。

`appendLedger()` 本身不创建结算事务，也不更新 stack；它只追加带 hash chain 的账本行。因此原子性取决于调用者的事务边界。证据：`ledger.ts:25–69`。

---

## 2. 现状副作用清单

### 2.1 主结算事务中的副作用

主要入口：`applyHandSettlement()`，`game.ts:370–599†`。

| 副作用 | 执行时机与顺序 | 是否 durable | 失败、崩溃和重放行为 | 位置 |
|---|---|---|---|---|
| `hand_settlements` marker | 事务开始后首先插入，初始 `final_stacks='[]'` 仅作事务内占位；真实 final stacks 在事务末尾写入 | 主事务提交后 durable | 初始空串与真实值在**同一事务**内完成，任何异常使 marker 一并回滚，**不能形成合法的"marker 已提交、final stacks 仍缺"半提交阶段**；冲突即提前返回 duplicate | `applyHandSettlement`:376–384† |
| `room_players.stack` 主更新 | marker 成功后，按 `stack = stack + delta` 增量更新 | 主事务 | 回滚则不移动资金；增量方式保留手中途批准的买入 | 同函数：386–425† |
| 非负与主结算守恒检查 | stack 更新后、rake 收款入账前 | 检查本身不 durable | 失败抛错并回滚；缺失参与者行已显式抛 `settlement missing participant row`（fail-closed），不再用 `?? 0` 静默批准 | 同函数：406–425† |
| poker ledger | stack 检查后，非零记录 `kind='hand-settlement'`、`ref=head` | 主事务 | 与资金、marker 一起回滚；duplicate 不追加 | 同函数：427–436† |
| squid ledger | poker ledger 后，`kind='squid-game'`、`ref=head` | 主事务 | 同上 | 同函数：437–447† |
| rake | poker/squid ledger 后调用 `settleRake()` | 主事务 | commission rate、收款人 membership、stack credit、commission ledger 同成同败 | `game.ts:448–456†`；`rake.ts:30–55` |
| 自动 showdown 7-2 | 金额在 Hand 中先算；资金已包含在 `stackDeltas`；writer 此处只追加独立 ledger legs | 主事务 | 不再是 `onDone` 的晚付交易；marker 控制主事务只执行一次 | `game.ts:458–487†` |
| 最终 stacks 重读 | rake 和其他资金移动之后，重读参与者及 rake 收款人 | 读结果随后写入 marker/projection | 当前首次提交返回实际 DB stacks；duplicate 经 `loadSettledReceipt()` 加载并严格校验历史结果（身份/head/rake/final_stacks，`game.ts:635–880†`） | 同函数：489–506† |
| time bank | 最终 stacks 重读后，逐人检查 epoch，再写余额和计数 | 主事务 | epoch 不匹配跳过并返回 `timeBankSkipped`，不能覆盖配置重置 | 同函数：508–526† |
| feature trigger | `claimed → applied`，设置 `resolved_at` | 主事务 | writer 重放不重复推进；失败回滚 | 同函数：528–533† |
| transcript | 保存完整 entries 与 head | 主事务 | 事务失败则完全没有本次 transcript；并非每个 action 都已经落入此表 | 同函数：535–537† |
| projection | transcript 插入后同步 `materializeHandProjection()` | 主事务 | malformed、head mismatch、ledger mismatch 等导致整笔结算回滚 | 同函数：539–563†；`handProjection.ts:1199–1217` |
| `room_gameplay_state` | projection 后推进 `completed_hands`，更新 bomb anchors，保留 schedule reset | 主事务 | duplicate 不增加计数；失败回滚 | `game.ts:565–590†` |
| `hand_settlements.final_stacks` | 事务末尾写入与 projection 相同的 `resultStacks` | 主事务 | 不存在合法的“marker 已提交、final stacks 仍等待补写”阶段 | 同函数：592–597† |

补充事实：

1. `settleRake()` 优先使用调用者传入的收款人；调用者当前解析为 `platformUserId(db) ?? room.banker_id`。不能将“平台优先、banker fallback”偷换成“永远给平台”。
2. rake 收款人可能也是本手参与者，也可能不是。因此 writer 的 `finalStacks` 集合不等于 `hand_players` 集合。
3. 自动 7-2 ledger 目前使用 `ref=handId`，而 poker/squid/commission 使用 `ref=head`。重构不得机械统一 ref。
4. 当前 `projectionPokerLedger` 是 poker 加自动 bounty 的统计视图，**不等于实际 `kind='hand-settlement'` ledger**。变量名中的 `Ledger` 容易掩盖这一差别。
5. `strict: true`、`verifyHead: true` 由 live writer 明确传入。辅助测试调用允许空 entries 的例外，不应扩展到真实在线手。

### 2.2 计算、审计、广播和内存收尾

| 副作用 | 执行时机 | 是否 durable | 失败、崩溃行为 | 位置 |
|---|---|---|---|---|
| 停止当前 timer | `settle()` 开始；persist 前也调用 | 否 | 崩溃丢失；异常后可能没有继续推进的 timer | `Hand.settle():3453 起†`；`persistSettlement():3918 起†` |
| `this.settlement` 赋值 | pot/rake/award/squid 计算过程中 | 否 | 当前先赋值再完成部分检查；后续异常可能留下“已有 settlement”但未提交的对象 | `Hand.settle()` 中部† |
| 自动 7-2 候选计算 | 基于 awards、reveals、post-poker/post-squid stacks；当前读取 room bonus | 否 | 手中途配置读取、可变对象和资金计算耦合；崩溃不能恢复这个计算结果 | `settle()`；`sevenDeuceBounty():约4052 起†` |
| transcript 追加 | `settlement`、audit key、epoch mismatch 等在提交前追加至内存链 | 仅最终主事务 durable | `appendServer/appendPlayer` 同时广播 `transcript_entry`；通知可早于 durable transcript | `game.ts:2243 起†`；`settle()`；`persistSettlement()` |
| `need_keys` | strict-audit/TV replay 时，计算结算后等待 key 或 timeout | 否 | 等待状态和收到的未提交 key 会随进程丢失 | `settle()` audit 分支†；`onRevealKey():约3720 起†` |
| epoch mismatch 审计追加 | 每次 `persistSettlement()` 尝试前查 epoch | 内存追加，成功事务才 durable | 重试再次执行可能追加新的诊断 entry，因此“重试输入完全相同”目前并未由结构保证 | `persistSettlement():约3950–3973†` |
| `settlementApplied=true` | writer 返回后 | 否 | 财务提交和内存采用不是一个步骤；崩溃后只能靠 DB 判断 | `persistSettlement():约4017 起†` |
| 最终 stacks 回填 | 首次 `applied` 后 `applyFinalStacks()` | 否，来源 durable | 玩家映射不全/非法时显式抛错（fail-closed），不静默回退旧 stacks；`applyFinalStacks()` 对 `applied` 与 `duplicate` 均采用回执 | `applyFinalStacks():4034 起†` |
| showdown 广播 | 主事务成功后 | WS 非 durable；允许的 agent event 另存 | 失败被 `safeBroadcast()` 捕获；不能撤销结算 | `publishSettlement():3764 起†` |
| squid 广播 | showdown 后、hand_end 前 | WS 非 durable；当前 agent whitelist 不含此帧 | 丢帧不回滚资金；重连 hold 分支可重发 squid | 同函数†；`agentEvents.ts:43–60` |
| seven_deuce 广播 | 自动奖金已提交后 | WS 非 durable；当前 agent whitelist 不含此帧 | 丢帧不重新支付 | 同函数† |
| showdown hold | 广播后记录截止时间、安排 hand_end | 否 | 关闭进程只丢展示阶段，已提交资金保留 | `scheduleHandEnd():约4081 起†` |
| `hand_end` | hold 后；fold-out 通常立即 | WS 非 durable；agent event 独立 durable | 当前先标 `handEndBroadcast=true`，再发送；通知失败仍继续收尾 | `broadcastHandEnd():4094 起†` |
| `hand_end` payload 组装 | 发终局帧时再组合 poker/squid/bounty deltas，head 读取 live transcript | 否 | 第二套组装逻辑可能与写入输入漂移；没有类型禁止读取 mutable state | 同函数† |
| `room_state` | join/settings/onDone/奖金支付等多个入口 | 状态读取 DB；消息另存 agent event | `broadcastRoomState()` 还会 reconcile 自动发牌，不只是展示函数 | `GameRoom.broadcastRoomState():1004 起†` |
| `onDone` 收尾 | terminal frame 后，或 duplicate 分支直接执行 | 否 | 删除 `activeHands`、保存 button/show snapshot、清空 hand，随后 room state/auto-deal；重启不恢复这些字段 | `GameRoom.startHand()` 传入 callback：1450–1466† |
| 中止收尾 | `abort()` 追加 hand_abort、释放 feature claim、通知并 onDone | feature release 独立 durable；abort transcript 此路径未落入 transcripts | release 失败可中断收尾；不能拿 abort 当未决财务交易的通用恢复 | `Hand.abort/releaseFeatureClaims`:约2076–2120† |
| shutdown | 清理 timer、peek offer、hand 和 `activeHands` | 否 | 不会提交内存待结算结果，也没有保存其完整恢复输入 | `GameRoom.shutdown():约775 起†` |

**顺序承诺必须准确命名：**当前是“主结算提交先于最终 `showdown` 帧”，不是“任何牌信息都在提交后才公开”。`board_open`、多跑协商及其他游戏过程已经可能公开信息。

### 2.3 手后自愿亮牌奖金、peek、agent_events

| 副作用 | 执行时机 | 是否 durable | 失败、崩溃行为 | 位置 |
|---|---|---|---|---|
| 记录自愿亮牌 | 验证后写 `shown`，广播 `cards_shown`，再尝试奖金 | `shown` 非 durable；cards_shown 可写 agent event | 广播位于奖金 try/catch 外；广播失败可能已标 shown，却尚未尝试奖金 | `recordShow():1473–1490†` |
| fold-winner 7-2 | `lastHandShow` 证明获奖资格后，读取当前余额，独立 transaction 扣付 | stack/ledger durable | 主结算已结束；失败回滚此交易，但不影响主结算；没有 DB 级奖金 claim | `trySevenDeuce():1503–1558†` |
| 7-2 已支付标记 | 自动支付后或自愿亮牌支付成功后加入 Set | 否 | Set 不是跨重启幂等依据；当前 post-hand snapshot 也仅存在内存，不能据此声称已有跨重启可重放能力 | `markSevenDeucePaid()`、`sevenDeucePaid`† |
| post-hand 亮牌审计 | 提交后只通知，不追加主 transcript | 主 transcript 不变 | 这是当前明确的产品约定，不应在重构中静默改变 | `Hand.onShowCards():约2340–2354†`；`DESIGN.md:221–233†` |
| peek offer | 两人 fold-out、目标未公开、固定 1bb；创建内存 offer 和 5 秒 timer | 否 | 重启丢失未完成 offer；新手开始时清理 | `onPeekOffer/clearPeekOffers/expirePeekOffer`:约1585–1672† |
| peek 转账 | 签名、proof、余额通过后，独立 transaction 写两条 `peek` ledger 和两方 stack | 是，独立事务 | 当前余额预检在事务外；没有 durable offer receipt；提交后、结果送达前崩溃会出现“钱已动、买家未收到结果” | `onPeekAnswer():1674–1752†` |
| peek 私有结果 | 付款提交后删除 offer/timer，再给买家 `peek_result` | 否 | 发送失败不能退款或重付；当前无 durable 交付重放回执 | 同函数† |
| `agent_events` | `GameRoom.broadcast()` 在 WS fan-out 前调用 `publishRoomEvent()` | 独立 DB 写入 | insert/prune/emit 不在主结算事务；失败会阻断此轮 WS fan-out，甚至已 insert 但 prune 失败 | `GameRoom.broadcast():约993 起†`；`agentEvents.ts:17–39` |
| agent event 保留与订阅唤醒 | insert 后保留各 scope 最近 5000 条，再 emit | 删除 durable；emit 非 durable | 它是有限保留通知流，不是完整结算日志，也不是恢复所有 Hand 状态的事件源 | `agentEvents.ts:28–39,61–84` |

---

## 3. 目标契约

### 3.1 先明确三个不同的数字

必须区分：

1. **本手游戏净结果**：poker、squid、自动 bounty 的合计。
2. **本次结算事务的账户变化**：游戏净结果，加可能收到的 rake。
3. **本手提交后的真实余额**：事务开始时 DB 余额加本次账户变化。

不能无条件写：

```text
hand netDelta = endingStack - handStartStack
```

因为当前系统允许手中途买入，而且 rake 收款人可能也在本手。

应使用：

```text
gameDelta(u) =
  pokerDelta(u) + squidDelta(u) + automaticBountyDelta(u)

transactionDelta(u) =
  gameDelta(u) + rakeCredit(u)

finalStack(u) =
  transactionBeforeStack(u) + transactionDelta(u)

finalStack(u) - handStartStack(u) =
  interveningAccountDelta(u) + gameDelta(u) + rakeCredit(u)
```

证据：

- `integration.test.ts:890 起†` 明确测试手中途买入保留。
- `handStats.test.ts:751–765` 明确测试本手参与者收到 rake 后的真实 ending stack。
- `handProjection.ts:958–977` 分别取得 ending stack 与游戏 net delta，没有强制两者差值相等。

**自动 7-2 必须计入本手游戏净结果；买入和 rake 收款不得为了凑等式伪装为扑克盈利。**

### 3.2 `computeSettlement(input) → SettlementResult`

纯函数，禁止：

- 访问 DB、room、socket；
- 调用时钟、随机数；
- 追加 transcript 或签名广播；
- 读写 Hand 的 Map/Set；
- 修改输入的 betting state、pots、reveals。

输入使用 immutable snapshot：

- hand/room 标识与 seat→user 映射；
- betting seats、投入、剩余 chips、fold winner；
- boards、run count、已确认 reveals、dealing order；
- commission rate；
- squid/bomb 规则快照与 trigger IDs；
- 自动 7-2 规则快照；
- time-bank 剩余量、epoch、计数与 refill 参数；
- 显式计算时间戳；
- 所需的版本标识。

输出：

- poker awards、各跑结果；
- poker/squid/自动 bounty 分项；
- 合并 `gameDeltas`；
- ledger legs 的领域描述；
- time-bank 更新意图；
- settlement transcript payload；
- showdown/squid/seven-deuce 展示所需领域数据；
- 计算阶段校验结果。

可以输出“按手内 chips 计算的预计余额”，但不得命名为最终 stacks，也不得用于最终消息。

**保持现有算法顺序：**

```text
pot → 每 pot rake 扣除 → 单跑/多跑 awards
    → squid
    → 自动 7-2
```

包括 odd chip 分配、squid 多跑交集和 payer cap。不能借纯函数化调整规则。

### 3.3 audit 与封存输入

`computeSettlement()` 不负责加密审计流程。

保留当前事件顺序：

1. 计算并生成 settlement payload。
2. transcript assembler 按原顺序追加 settlement event。
3. strict-audit/TV replay 收集 key，或走既有 timeout 策略。
4. 封存完整 entries/head。
5. 将纯计算结果和 sealed transcript 绑定为不可变写入输入。

建议类型：

```ts
computeSettlement(input): SettlementResult

sealSettlement(
  result: SettlementResult,
  transcript: SealedTranscript,
  context: ResolvedPersistenceContext,
): ReadySettlement

persistSettlement(result: ReadySettlement): PersistedSettlement
```

`ReadySettlement` 是可持久化的 `SettlementResult`，不是另一套资金结果。seal 只绑定审计与已解析上下文，不重新算钱。

要求：

- 第一次 writer 尝试前冻结 entries/head。
- 重试不得重新追加 `settlement`、epoch mismatch 或重新读取规则计算奖金。
- 冻结后到来的自愿亮牌不能修改该 head。
- time-bank epoch 的事务内跳过结果进入回执；已封存 transcript 不因重试而变化。
- 若需要保留当前 `time_bank_epoch_mismatch` event，在封存前只记录一次；之后发生的 epoch 变化通过持久回执记录，不追加到旧链尾。

### 3.4 `persistSettlement(result) → PersistedSettlement`

对外服务内部调用：

```ts
applyHandSettlement(db, resolvedWrite): PersistedSettlement
```

**只有 `applyHandSettlement()` 拥有主结算财务事务。**

事务内容：

1. 验证 hand/room/input identity。
2. claim settlement marker。
3. duplicate：加载并校验已提交回执，直接返回。
4. 验证所有参与者、金额和 ledger legs。
5. 更新参与者余额。
6. 写 poker/squid/自动 bounty ledger。
7. 写 rake rate、收款人 membership、rake credit 和 commission ledger。
8. 写 time bank、feature trigger。
9. 写 sealed transcript。
10. 重读所有受影响账户最终余额。
11. 同事务写 projection。
12. 推进 gameplay anchors。
13. 保存 final stacks 与完整回执，标记恢复记录已提交。
14. 提交，返回回执。

顺序可在行为提交中精确整理，但不能将上述资金和派生持久化拆成多个独立 commit。

建议回执包含：

```ts
interface PersistedSettlement {
  status: 'applied' | 'duplicate';
  roomId: string;
  handId: string;
  head: string;
  inputHash: string;
  committedAt: number;

  participants: readonly SeatUser[];
  finalStacks: readonly UserStack[];
  gameDeltas: readonly UserDelta[];
  breakdown: SettlementBreakdown;

  rake: PersistedRake;
  sevenDeuce: PersistedBountyDecision;
  timeBankSkipped: readonly number[];

  presentation: SettlementPresentation;
}
```

具体约束：

- 不能由 broadcast/finalize 自行伪造该类型；运行期还须校验身份与完整性。
- duplicate 返回首次提交的 head、金额、final stacks、奖金决策，不返回空数组。
- duplicate 不从当前 `room_players` 余额构造历史最终 stacks：这些账户之后可能已发生买入、peek 或下一手。
- 同 handId、不同 room/head/input hash 不是普通 duplicate，而是一致性冲突。
- marker 已存在但回执缺失或损坏时，禁止再次支付；走受控历史恢复或隔离。
- 缺少参与者余额行、重复 user、非法金额必须在事务内报错，不能静默采用零。
- writer 必须核对实际 ledger legs 与资金更新一致，不能只比较两份由调用者传入的“预计 ledger”。

### 3.5 最终 stacks 的单一权威

**定义：`applyHandSettlement()` 返回的 `PersistedSettlement.finalStacks`，是该手提交时最终 stacks 的唯一应用层权威。**

数据流：

```text
事务内实际 room_players.stack
           ↓
同一份 finalStacks
   ├─ hand_settlements.final_stacks / durable receipt
   ├─ projection ending_stack（仅本手玩家）
   ├─ hand_end.stacks（按该手 seat 映射）
   └─ 结算时 room-state balance snapshot
```

`hand_end.deltas` 直接取回执的 `gameDeltas`，不重新组合分项、不通过相减反推。

`room_state` 需要区分时间：

- **本次结算发布时**：使用回执确认的余额更新。
- **以后发生买入、peek、手后奖金之后**：必须反映更新后的当前 DB 余额，不能用旧手的 final stacks 覆盖新余额。

因此“单一权威”不意味着历史 final stacks 永远等于当前 `room_players.stack`。一致性比较必须发生在同一个提交边界。

### 3.6 `broadcastSettlement` / `finalizeHand`

两者仅消费 `PersistedSettlement`，不接受 `SettlementResult` 或 mutable Hand settlement。

`broadcastSettlement`：

- 从回执产生 showdown、squid、seven-deuce；
- 使用当前展示 hold 参数安排终局展示；
- 不读 DB 计算资金、不调用 writer、不支付任何奖金。

`finalizeHand`：

- 从回执产生 `hand_end`；
- head 直接使用回执 head；
- 保存展示 snapshot、推进 button、移除当前 hand/`activeHands`；
- 设置现有 auto-deal hold，发布当前 room state；
- 不写 ledger、不计算 stacks、不追加主 transcript。

清理动作自身必须幂等，且用 handId 验证“仍然在结束同一手”。通知失败不能导致重复支付，也不能让旧 timer 清理下一手。

---

## 4. 自动 7-2、fold-winner 奖金与 peek 的事务归属

### 4.1 自动 showdown 7-2

- compute 阶段决定唯一获奖者、payer cap 和每条金额。
- persist 阶段在主事务中执行。
- 使用 durable bounty decision 标记本手这项权益已消费。
- duplicate 加载该决策，不通过候选 Hand 推断“是否付过”。
- broadcast/finalize 只展示。

建议唯一键：

```text
(room_id, hand_id, effect_kind='seven-deuce')
```

自动与自愿路径共用这一权益键，避免一个手通过不同入口领取两次。

零支付也应有明确决策：适用但支付为零是否消耗权益，按冻结后的产品契约记录，不能用“没有 ledger 行”推断未处理。

### 4.2 fold-winner 自愿亮牌奖金

这是必须明确的时间边界：

> 如果允许 hand_end 之后才决定是否自愿亮牌，就不可能把该支付塞回已经提交的主结算事务。

推荐保留现有手后亮牌能力，建模为独立命令：

```text
verify voluntary show
  → compute post-hand bounty
  → persistPostHandAward（独立单事务、独立回执）
  → broadcast cards_shown / seven_deuce / current room_state
```

要求：

- durable entitlement/claim，与自动奖金共用唯一键；
- 验证主手已提交、当前允许该手后操作、请求者身份与 winner/proof；
- 事务内核对当时余额、写 claim、两侧 ledger、两侧 stack、回执；
- 失败全部回滚，通知错误不得撤销支付 claim；
- 手后支付不重写主 transcript、主 hand_end、主 settlement final stacks；
- 手后交易余额是该独立交易的新回执，不再称为“主手最终余额”；
- 当前手后奖金读取操作时 room bonus；若改为发牌时快照，这是规则行为变更，必须单独确认，不能夹在抽文件提交里。

如果要求 fold-winner 奖金也必须在主结算中完成，唯一合理替代是增加**提交前的自愿亮牌窗口**并关闭事后兑奖。这会改变产品时序，本方案不默认采用。

### 4.3 peek

peek 继续是独立、需双方同意的手后交易，不进入主手统计净结果。

最小修复：

- offerId 作为 durable 幂等键；
- 付款、receipt 与 terminal status 同事务；
- 余额检查移入事务，缺目标账户直接拒绝；
- 已支付请求重放只返回回执，不重复扣款；
- 若要在重启后补交付私有 cards，必须保存受访问控制的私有结果，或足以验证并重建该结果的材料；
- 未接受的内存 offer 可以明确按重启过期处理，不必建设持久 timer 系统；
- 私有 cards 不进入 `agent_events` 或公共主 transcript。

这属于交易可靠性修复，不改变固定 1bb、5 秒、HU fold-only 规则。

---

## 5. 目标模块边界及与总方案批次 8/9 的关系

引用：`docs/plans/repo-refactor-plan.md:438–450,494–498†`。

总方案批次 8 负责目录拆分，批次 9 负责显式端口、snapshot 和 writer 解耦。本方案是其**结算子域细化**，不是另一条并行重写路线。

```text
apps/server/src/
  game.ts                         # 保留兼容 façade
  game/
    index.ts                      # 保持既有公共导出
    hand/
      settlement.ts               # Hand 适配器：snapshot / audit / 调度
    settlement/
      index.ts                    # 纯领域 API façade
      types.ts                    # Input / Result / Receipt 契约
      compute.ts                  # pot/rake/award/squid/bounty 组合
      invariants.ts               # 纯资金与结果断言
      presentation.ts             # receipt → 消息 payload，纯映射
    settlementWriter.ts           # SQLite 主事务、完整回执加载
```

在相应行为批次中再按实际体量增加：

- `game/settlementRecovery.ts`：启动检查、待结算重试、operator service；
- `game/postHandTransactions.ts`：手后奖金/peek 独立 writer。

不要预先为每个五行公式新建文件，也不引入通用 workflow 框架。

依赖方向：

```text
GameRoom / Hand orchestrator
  ├─ settlement facade（纯计算）
  ├─ settlementWriter（提交）
  ├─ settlementRecovery（恢复）
  └─ notification / room lifecycle ports

settlementWriter
  → settlement types/invariants
  → DB / ledger / rake / projection

settlement/*
  → shared 数值算法与类型
  ✗ DB / GameRoom / sockets / agent_events

stats
  → DB projection
  ✗ Hand / 实时计算 / 广播
```

说明：

- 总方案中的 `game/hand/settlement.ts` 保留为适配器；领域算法下沉至 `game/settlement/`，避免出现两个结算实现。
- 根 `game.ts` 暂时继续导出 `applyHandSettlement` 等已有符号，避免一次性修改全部调用者。
- 创建 `HandContext`、改变参数、注入 ports、抽取 writer 所有权属于非纯移动。总方案批次 8 中涉及这些工作的部分必须拆出，不应借“机械目录拆分”之名降低审查强度。
- 本方案新增的恢复记录、完整回执属于单独的行为/持久化扩展，不伪装成总方案原先承诺的零语义目录调整。

---

## 6. 分批迁移计划

### 6.1 提交分类与前置门槛

使用三类提交：

- **M：纯移动**——仅路径、imports/exports，方法体、SQL、顺序不变。
- **S：结构抽取**——改变参数/所有权/接口，但目标为保持已冻结行为。
- **B：行为修复**——故障处理、幂等、数据契约或恢复行为发生变化。
- 测试与文档基线提交另行标记。

**M、S、B 不混在同一提交。**

功能 lane 尚未结束时可以做：只读设计、测试矩阵、独立新增测试的工作树准备。生产结算代码、共享测试大文件及 schema 改动必须等待相关功能 lane 合并并重新冻结基线。

### 6.2 批次表

| 批次 | 改什么 | 保持什么不变 | 验证什么 | 回滚方式 / 开始条件 |
|---|---|---|---|---|
| S0：契约基线 | 记录实际 HEAD、功能 lane 最终语义、副作用顺序、fixtures；增加独立 characterization 测试 | 所有生产行为 | 基线全量测试；确认哪些 reject 已关闭 | 回退测试/文档提交即可；可立即准备，最终结果待 lane 稳定 |
| M1：已有独立代码归位 | 仅移动已能独立迁移的函数/类型，保留 façade | 方法体、SQL、异常文本、timer、append/broadcast 顺序 | AST/body 对比、export surface、typecheck、server 全量 | revert 此提交；相关 lane 合并后 |
| S2：writer 结构抽取 | 将事务集中至 `game/settlementWriter.ts`，显式传入已解析参数；对应总方案 8→9 边界 | 现有事务语句顺序和提交时机 | 逐点 rollback、duplicate、rake、projection strict | revert 此提交；M1 后 |
| B3：完整提交回执 | applied/duplicate 返回完整 receipt；验证身份、参与者、实际 ledger reconciliation；删除空结果和静默回退 | 金额算法、ledger kinds/ref、财务提交时机 | duplicate 输入冲突、缺行、提交后崩溃、final stacks 一致 | 保留新增兼容字段/表；回退到支持 receipt 的兼容版本；不得删 marker |
| S4：纯计算抽取 | `computeSettlement` 显式 snapshot；assembler seal；Hand 适配调用 | 冻结基线的 pot/rake/squid/bounty 算法和审计事件顺序 | 旧实现与纯函数 differential fixtures；输入不变性；多跑/odd chips | revert 结构提交；B3 后 |
| B5：只消费已提交结果 | broadcast/finalize 只接受 receipt；删重复 deltas 组装；冻结重试输入和 head | 用户展示帧顺序、hold 值、协议字段 | audit timeout、late key/show、重复 finalize、重连、room_state 时点 | revert 至 B3/S4 兼容实现；不得恢复已知错误 stacks 回填 |
| B6a：自动/自愿奖金幂等 | durable bounty decision，共享权益键；手后 writer 与通知分离 | 自动奖金金额；手后亮牌产品能力；主 transcript 不变 | 自动→自愿重放、零金额、transaction rollback、commit 后断线 | 停止手后支付入口后回退兼容 reader；保留 claims，不退回内存 Set 权威 |
| B6b：peek receipt | offerId 幂等、事务内余额检查、已支付结果重放 | 固定 1bb、5 秒、HU fold-only、私密性 | duplicate accept、提交后发送失败、重启交付、目标缺行 | 禁用新 peek 接受后 drain；保留支付 receipts；不回退至可重扣版本 |
| B7：通知隔离 | 拆 agent-event append 与 WS fan-out；已提交通知错误不得阻断收尾 | 不新增资金动作；保持公共/私有 whitelist | agent insert/prune/emit 错误、单 socket send 错误、终局恢复 | revert 通知实现；账务无需回滚；B5 后 |
| B8：异常与房间健康 | 统一已知/未知错误分类；timer、WS、recovery callback 一致；禁止未知错误普通化 | 已提交事务不退款；正常业务错误可回报 | TypeError、projection invariant、SQLITE_BUSY、I/O 错误分类 | revert 接入但保留 durable quarantine 读取；不能靠重启解锁 |
| B9a：恢复 schema | 增加运行记录、prepared input、receipt/quarantine 兼容读取 | 暂不改变发牌路径 | migration 幂等、旧数据读取、schema 降级限制 | 回退代码但保留新增表；此时尚未依赖新恢复行为 |
| B9b：运行期与启动恢复 | 发牌前 running record；prepared 输入；主事务更新 committed；startup fail-closed | 单实例部署、主财务事务、资金算法 | 所有 crash cut points，尤其无 transcript 且无 marker | 只能回退到识别恢复记录的版本；未决房间继续锁定 |
| B9c：operator 恢复 | inspect/retry/resolve-abort 服务与审计 | 不接受客户端指定任意 stacks/deltas | 权限、CAS、重复 retry、marker 已存在、材料不足 | 关闭 mutation 端点，保留只读与冻结；不删除未决记录 |
| M10：清理过渡入口 | 在引用全部迁移后删除无用 façade/重复旧实现 | 业务与 schema 无变化 | 无旧调用、全量测试、production build | revert 清理提交；最后执行 |

B6a 与 B6b 可以在 B5 后用独立 worktree、独立文件边界并行。B7/B8 可以在契约确定后准备，但若都修改同一个 Hand orchestration 文件，合入必须串行。只读审查不构成阻塞其他无冲突工作的理由。

### 6.3 数据变更后的“可回滚”

独立提交不等于任意版本都能安全降级。

- **结构提交**：通常可以直接 revert。
- **只新增 schema、尚未启用行为**：保留表，回退 reader/writer。
- **已产生新幂等记录或未决恢复记录**：只能回退到理解这些记录的版本。
- 回滚代码绝不能通过删除 ledger、marker、bounty claim、prepared input 来“恢复干净”。
- 新财务行为上线前，必须先有兼容旧逻辑但理解新记录的回滚版本。

---

## 7. 必须保持的不变量

> **不变量优先于重构。若某次模块拆分使其中任何一项无法证明，应缩小或撤回拆分，而不是放宽不变量。**

### I1. 主结算一次事务

主结算的 stack、ledger、rake、自动 7-2、time bank、trigger、transcript、projection、gameplay anchors、marker、receipt 一起提交或一起回滚。

不得使用异步 projection 队列或“先付钱再补 transcript”。

运行记录/prepared input 是恢复日志，不是另一次财务提交；手后奖金和 peek 是新的独立交易，不冒充主结算补丁。

### I2. marker 幂等且有身份校验

- marker 存在表示主财务效果已经提交。
- 同一 identity 重放返回原回执，所有资金、计数和 trigger 不再执行。
- identity 不匹配必须冻结，不是无害 duplicate。
- void 后也不得删除 marker 再次结算。

### I3. 最终余额真实且有时点

在主事务提交边界：

```text
receipt.finalStacks
  = hand_settlements.final_stacks
  = 本次事务完成后的账户余额
```

其中本手参与者映射为：

```text
hand_end.stacks = projection.ending_stack
```

以后发生手后交易，不改写这个历史快照。

### I4. ledger 守恒与资金归因一致

有 rake 收款人时：

```text
Σ poker ledger = -rake
Σ squid ledger = 0
Σ seven-deuce ledger = 0
Σ commission ledger = rake
Σ 主事务所有资金 legs = 0
```

逐账户验证 stack 变化等于实际 ledger legs 合计，不能只验证总和。

现有 writer 支持 `rakeRecipientId=null`。该情况下旧接口没有 credit 方，不能声称全账户 ledger 零和。结构迁移保留既有行为；生产入口是否应对 `rake>0 && recipient=null` fail-closed，必须作为明确行为修复，不能偷偷 fallback。

### I5. transcript head

```text
hand_end.head
  = receipt.head
  = transcripts.head
  = hand_settlements.head
  = projection.source_head
  = verifyHead(entries)
```

seal 后不追加 key/show/diagnostic 改变主 head。

### I6. `strict` / `verifyHead`

- live materialization 保持 `strict:true`、`verifyHead:true`。
- 非空 malformed transcript 导致主事务回滚。
- backfill 的历史兼容不能成为 live settlement 的降级理由。

### I7. projection 与 parser 契约

- `HAND_PARSER_VERSION` 当前为 1，目录迁移不得修改。
- `net_delta = poker_delta + squid_delta` 等当前契约必须明确保留。
- 功能 lane 已引入的自动 bounty 统计适配，在冻结后统一由一个 adapter 实现。
- 实际 poker ledger 与统计 poker 视图必须分开命名并校验。
- 若要新增独立 bounty 统计字段或改变 pokerDelta 含义，必须独立做 parser/version/backfill/read-model 设计，不能在纯结构提交中顺带处理。
- 真实 ending stack 不意味着 net delta 无条件等于 ending-starting。

### I8. void 排除语义

- 保留 room-scoped `(handId OR head)` 关联和唯一性前提。
- stats、HUD、history、house/admin 等读模型继续调用共享 exclusion helper。
- void 不删除 transcript/projection，不重置 settlement 幂等。

当前 `social.ts:599–603` 的反向资金查询只覆盖 `hand-settlement` 和 `commission`；并未同时逆转 squid、seven-deuce、peek。**保留 void 排除语义不等于证明所有附加转账已被完整逆转。**

是否扩大 void 的财务覆盖是独立行为议题，须明确每种手后交易是否可逆，不能借本次重构改变。

### I9. rake 收款人

保持 platform 优先、banker fallback；支持收款人在手内或手外。真实 final stacks 重读必须包含收款人，projection 玩家集合不能因此增加一个未参赛玩家。

### I10. lifecycle 与交易状态

- 未提交不走正常 finalize，不释放阻止下一手的占用。
- 已提交不能因广播失败转入 abort/refund。
- 只结束当前 handId，过期 timer 不得清理下一手。
- 恢复 pending 的房间不能因 `activeHands` 在重启后为空而开放资金冲突操作。

---

## 8. 恢复路径设计

### 8.1 当前恢复的缺口

`firstUnsettledHand()` 检查：

```text
transcripts LEFT JOIN hand_settlements
WHERE marker 不存在
```

但当前 transcript 与 marker 是同事务写入的。典型 persist 失败后，两者都不存在，因此该查询找不到真正需要恢复的手。

`recoverOrphanedFeatureTriggers()`，`db.ts:558–580`，会释放没有 marker 的 claimed trigger。这只是 feature 复位，不是手牌结算恢复；若新增 prepared settlement，启动时无条件先释放 claim 还会破坏待恢复手的输入归属。

`agent_events` 也不能替代完整恢复源：有限保留、过滤事件、缺少完整私有和审计上下文。

### 8.2 推荐最小持久模型

采用一个结算专用运行/恢复表，概念字段：

```text
hand_id, room_id, schema_version
status: running | prepared | committed | aborted | quarantined
prepared_input_json, prepared_input_hash
receipt_json
last_error_code, last_error_detail, attempts
started_at, prepared_at, resolved_at
```

这是设计示意，不要求把数据库错误和正常 lifecycle 全塞进一个难以约束的自由 JSON。

关键点：

1. **开始公开发牌前**，持久登记 running hand。
2. 与 feature claim 建立一致归属；最好在同一启动事务完成。
3. audit 完成后，保存 sealed、可重放的 prepared 输入。
4. `applyHandSettlement` 主事务提交时，同步标记 committed 和保存回执。
5. 正常 pre-settlement abort 持久标记 aborted，再释放相关 claim。
6. 未知状态或材料不足，quarantined，保留证据。
7. `prepared_input_hash` 用于检测候选输入漂移，不替代 transcript 签名/head 校验。

无需持久化每个 crypto action 来追求完整 Hand 热恢复。running 但无完整输入的手可以人工裁定中止；重要的是不能悄悄消失并继续发牌。

### 8.3 状态迁移

```text
running
  ├─ 正常中止 → aborted
  └─ 完整结果、审计封存 → prepared
                          ├─ 暂时性错误 → prepared / bounded retry
                          ├─ 不一致或耗尽 → quarantined
                          └─ 主事务提交 → committed
                                            └─ presentation/finalize
```

`quarantined` 不应再借用 `phase='done'`。`done` 是游戏/展示生命周期，不是财务失败状态。

### 8.4 故障处置表

| 情况 | 推荐动作 |
|---|---|
| writer 尚未提交，明确 `SQLITE_BUSY/LOCKED` | 使用同一 sealed 输入有界重试；不重算奖金、不追加 transcript |
| 重试耗尽 | durable quarantine；停自动发牌和 ready-check；保留输入；通知 operator |
| 主事务提交后、函数返回前进程退出 | 重启看到 marker，加载 receipt；不得重新支付 |
| 提交后、showdown/hand_end 前退出 | 根据 receipt 做重同步；不保证复现所有动画，不重复资金 |
| 重启，无 marker、有有效 prepared input | 恢复同一个 writer，校验 identity/hash/版本/账户前提 |
| 重启，只有 running record | fail-closed；不猜赢家，不根据有限 agent events 自动算钱 |
| marker 存在但 transcript/projection/receipt 缺失 | 一致性故障；冻结并核验，不能删除 marker 重来 |
| transcript 存在但 marker 不存在 | 保留现有检测，视为遗留/异常数据；人工核账 |
| 无 marker 且仍有 claimed feature | 先检查恢复记录；prepared 手不得释放 claim |
| 历史版本未写 running 记录，所有内存都丢失 | 无法保证自动识别全部未结算手；上线切换必须 drain，并进行遗留异常扫描 |

### 8.5 启动与发牌闸门

启动时先做恢复扫描，再允许房间自动发牌。发牌入口仍进行一次权威检查，防止绕过启动扫描。

同时扩展当前依赖 `activeHands` 的相关资金/生命周期检查：

- 未决手上的 void、merge、破坏性余额操作不能因进程重启而放行；
- pending/quarantine 必须是 durable room gate；
- `activeHands` 保持进程内用途，不再独自承担跨重启安全职责。

### 8.6 operator 服务

建议最小接口：

- `GET .../settlements/:handId/recovery`：查看状态、marker、input hash、receipt、错误。
- `POST .../settlements/:handId/retry`：重放已有 sealed 输入。
- `POST .../settlements/:handId/resolve-abort`：仅对无 marker、确认未发生主财务效果的手，记录人工裁定并释放占用。

要求：

- 使用已有 operator/admin 身份体系；
- 必须记录操作者、原因、旧状态、新状态、输入 hash；
- retry 做状态 CAS，不能并发恢复同一手；
- 不接受客户端提供任意 final stacks 或“跳过 strict”参数；
- resolve-abort 不能撤销已提交结算；已提交手走既有 void/补偿流程；
- 不提供“删除 pending/marker 即解锁”快捷操作。

当前 host `retry_settlement` 可以保留为受限入口，但只能调用同一恢复 service，不能重置所有错误后盲目重试。

---

## 9. 异常分类模型

“已知”与“可重试”不是同一个维度。建议四类：

| 类别 | 示例 | 对客户端 | 重试 | 健康状态 |
|---|---|---|---|---|
| 已知业务拒绝 | 已过期 offer、余额不足、身份不符、非获奖者、已结束手 | 明确业务结果 | 由新有效请求决定，不自动重试 | 通常健康 |
| 已知暂时性基础设施错误 | 明确的 SQLite busy/lock | pending/retrying 状态 | 同一输入、有界退避 | 暂停该手；耗尽后隔离 |
| 已知一致性错误 | projection mismatch、head mismatch、缺参与者、identity conflict、ledger 不守恒 | 结算被阻止，提供诊断 ID | 不盲目自动重试 | 不健康/隔离 |
| 未知编程错误 | TypeError、不可达分支、receipt 映射错误、未知异常 | server fault，不伪装成非法客户端命令 | 默认不重试资金计算 | 正常错误日志、堆栈、标记不健康 |

补充：

- I/O、disk full、database corrupt 不应一律按 `SQLITE_BUSY` 处理。
- 已提交之后的 transport 失败属于通知失败，不是 settlement failure。
- 未知错误发生在已提交后，仍必须承认“财务已提交”，只冻结后续行为或修复通知。
- catch 范围要小：数据库事务错误、回执采用错误、通知错误不能共用一句“未提交，可重试”。
- 正常日志应包含 roomId、handId、input hash/head、状态、阶段、attempt、异常堆栈，不能只依赖关闭默认输出的 `BOT_DEBUG`。
- WebSocket、timer、operator callback、startup recovery 使用相同分类规则。
- `GameError` 可承载业务拒绝，但不应把所有数据库错误、projection 错误统一包装成它。

当前 `hub.ts` 的分类改动是正确方向；`Hand.publishSettlement()` 对所有 persist 抛错都走重试，以及 `armTimer()` 仅 hdbg 的兜底，还需要独立完善。

---

## 10. 验证矩阵与验收标准

### 10.1 已核查存在的测试基础

- `integration.test.ts:890 起†`：手中途买入不被结算覆盖。
- `integration.test.ts:942–1080 左右†`：先 durable 后 hold、hold 中 shutdown、同 DB 重启。
- `integration.test.ts:1135 起†`：peek 价格、资格、超时、余额及私密性。
- `integration.test.ts:1411 起†`：自动 7-2 在 hand_end 前 durable。
- `integration.test.ts:1533、1569 起†`：失败重试、丢终局广播。
- `handStats.test.ts:445–518,751–765,855 起`：projection 回滚、head、真实 post-rake stacks、delta reconciliation。
- `voidHandStats.test.ts`、`voidHandReadModels.test.ts`：head/handId 两种关联与 room scope。
- `integration.test.ts:2592、2783 起†`：feature recovery、time-bank epoch。

这些测试的存在不代表完整覆盖本方案。`persist.test.ts` 测的是数据库 snapshot 上传/下载，不是主结算事务故障覆盖，不能仅凭文件名计入结算可靠性证据。

### 10.2 必须补足

1. **每一个 SQL 写入之后抛错**，验证 marker、stack、所有 ledger、rake、time bank、trigger、transcript、projection、anchors 全部回滚。
2. 主事务提交后、receipt 采用前退出。
3. 没有 transcript、没有 marker 的 prepared/running 手，重启仍禁止新牌。
4. duplicate 完整 receipt；candidate head/room/hash 冲突。
5. 自动 bounty、fold-show、duplicate、重启组合，最多支付一次。
6. 自动 bounty + squid + 多跑 + rake 收款人在手内。
7. 手中途买入 + 自动 bounty + 最终真实 stacks；不错误要求 net=ending-starting。
8. 缺玩家行、重复 user、零支付、payer cap、非安全整数金额。
9. audit timeout 与迟到 key/show；重试前后 sealed head 不变。
10. time-bank epoch 在封存后变化，跳过而不篡改旧 transcript。
11. agent_events insert/prune/emit 失败；单个 socket 发送失败；资金不回滚且其他通知可继续。
12. peek 已提交但结果未送达，重复 accept 不重扣且私有结果可受控重放。
13. 重复 finalize、旧 timer、重连，不影响下一手。
14. unknown error 在 WS 和 timer 上行为一致，房间健康状态不会因重启被无条件清除。
15. 新恢复记录与 `recoverOrphanedFeatureTriggers()` 的启动顺序。
16. 有未决手时 REST void/merge/其他冲突资金操作仍被拒绝。
17. 历史无完整 receipt 的 marker 不会触发重付。

结算故障测试优先使用确定性 clock 和事务内故障注入。当前 persist hook 位于 writer 调用前，只能证明“写入之前失败”，不能替代事务内部 rollback 测试。

---

## 11. 不做清单

1. 不重写整个 GameRoom/Hand 为 reducer，不引入全局 event bus。
2. 不将 SQLite writer 改为异步队列，不采用最终一致性财务结算。
3. 不改扑克评估、pot/side-pot、odd chip、多跑和 squid 规则。
4. 不在结构提交中改 7-2 资格、奖金配置生效时点、peek 价格或窗口。
5. 不把手后交易强塞回不可变主 transcript。
6. 不统一或重写历史 ledger kinds/ref，不删除历史 marker，不重链账本来适配新代码。
7. 不顺手扩大 void 的财务逆转范围；只保持既有排除语义，并显式列出附加交易覆盖问题。
8. 不通过修改 `HAND_PARSER_VERSION` 绕过 projection mismatch。
9. 不承诺 WebSocket exactly-once delivery；承诺交易幂等、结果可查询和受控重同步。
10. 不建设整个游戏的事件溯源与跨实例热迁移；继续遵守单实例房间所有权。
11. 不自动修复材料不足的历史未结算手，不根据猜测补赢家或补 ledger。
12. 不把代码回滚等同于财务回滚。

---

## 12. 风险表

| 风险 | 影响 | 缓解 / 阻断条件 |
|---|---|---|
| 功能 lane 持续修改相同文件 | 旧报告当现状、误覆盖返修、行号失效 | 本文行号标 `†`；功能合并后冻结真实基线；生产拆分不抢跑 |
| 事务边界被无意改变 | 付钱无 transcript/projection，marker 半完成 | writer 唯一事务所有者；每 SQL cut-point rollback 测试 |
| 私有状态拆分丢顺序语义 | audit/head/timer/auto-deal 竞态 | M 与 S/B 分离；保留 Hand orchestration；显式状态转换测试 |
| duplicate 返回空结果或信任候选结果 | 历史 stacks 错误、奖金重付 | 从 durable receipt 加载并校验身份 |
| 把真实余额和游戏盈利混为一谈 | 买入/rake 被当扑克盈利、错误守恒断言 | 三种数值分开命名；中途买入与手内 rake recipient fixtures |
| 自动 bounty 统计适配掩盖实际 ledger | projection 看似通过但资金 legs 不一致 | 明确 actual ledger 与 projection adapter；按账户核验实际 legs |
| 手后奖金修改主手历史 | head 失配、历史 final stacks 漂移 | 独立命令与回执，不改 sealed 主记录 |
| 广播隐含 DB 写入 | agent_events 错误阻断 WS/收尾 | 通知存储与发送拆 ports；已提交故障分层 |
| recovery 只查 transcript | 主事务全回滚的手不可见 | running/prepared durable 记录 |
| 启动过早释放 feature claim | 同一 trigger 被恢复手与新手重复使用 | 恢复扫描先于 claim release；prepared 手保留归属 |
| `activeHands` 重启丢失 | 未决手上允许冲突资金操作 | durable room gate 与相关 REST 检查联动 |
| timer catch 吞未知错误 | 房间静默卡死或带病继续 | 非 debug 日志、统一异常分类、durable quarantine |
| 测试只注入 writer 前失败 | 对原子性产生虚假信心 | 内部写入 cut points + 真正进程重启测试 |
| schema 行为上线后直接回退旧版 | 新 claim 不被识别，重新付款 | 先部署兼容 reader；回滚版本须识别所有新记录 |
| 完整恢复材料含私有信息 | peek 或审计数据误进入公共事件 | 恢复/私有 receipts 单独访问控制，延续公共事件 whitelist |
| 重构范围膨胀 | 大提交不可审查、无法回滚 | 模块按职责够用即可；每批明确非目标与验收 |

---

## 13. 完成标准

本重构完成的判据不是 `game.ts` 少了多少行，而是：

1. `computeSettlement` 可独立测试，不依赖 DB、room、时钟或广播。
2. `applyHandSettlement` 是主财务事务唯一所有者，并返回完整、可验证的已提交回执。
3. applied 与 duplicate 使用相同结果契约。
4. `hand_end`、projection 和结算余额采用同一份提交结果，不再独立重组资金事实。
5. 自动奖金只在主事务支付；手后奖金与 peek 各自具备 durable 幂等和 receipt。
6. 封存 transcript 在失败重试、late key、late show 下保持不变。
7. 未决手在进程重启后仍可识别，无法越过发牌和相关资金闸门。
8. 未知错误被记录、分类并隔离，不伪装成普通客户端错误。
9. 所有不变量与故障矩阵通过独立审查和测试。
10. 每批结构与行为变更均能单独解释、验证、回滚。

**财务 writer 已提供 durable `finalStacks` 回执**（`HandSettlementOutcome.finalStacks`，由资金动作后重读返回，`game.ts:1036–1053,1139–1169`）。**尚未完成的是让所有 broadcast/finalize 路径强制只消费该回执**，而不是各自重组资金事实；这一点做不到，这次结算重构就尚未完成。
