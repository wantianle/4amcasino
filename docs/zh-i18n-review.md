# 中文文案审查报告（oracle）

审查范围：`docs/zh-i18n.md`、登录/大厅/牌桌操作条/落地页/设置/玩家页，以及主要 `dict/*.ts`。
总体判断：术语骨架已经比较稳，口吻明显优于普通机翻。主要问题集中在少数语义偏差、几个全局词条撞车，以及「买点数控」「筹码堆」「银行账本」等不自然的产品术语。

> 实施说明：本文件是待办清单。落地时改词典值即可（`apps/web/src/shared/i18n/dict/*.ts`），必要时同步修订 `docs/zh-i18n.md` 的术语表。不要改用户内容、品牌、代码标识。

## Tier 1 — 必须修（语义 / 术语 / 界面理解）

1. `dict/server.ts` `no such user`：`没有这个用户。` → `没有这个用户名。`（是用户名不存在，不是用户本人）
2. ~~`dict/server.ts` `the buyer no longer has enough chips`：`买入方的筹码已经不够了。` → `出价方的筹码已经不够了。`（peek 买看者，勿与 buy-in 混淆）~~（该项于 2026-10-08 随买看功能移除而作废：该 key 已删除）
3. `dict/table.ts` `Deal when ready.`：`随时可以开桌。` → `准备好就发牌。`（是发牌，不是开桌）
4. `dict/table.ts` `Host deals soon…`：`等房主开桌…` → `等房主发牌…`
5. `dict/table.ts` + `dict/table-page.ts` `Call any`：`随时跟注` → `有注就跟`（any=任意注额自动跟，非时间）
6. `dict/settings.ts` `Recording cancelled.`：`已取消录入。` → `已取消录制。`
7. `dict/hands.ts` `sat out`：`旁观` → `休息中`（sit out ≠ spectator）
8. `dict/table-page.ts` `Could not stand them up`：`没能让他起身离座。` → `没能让这名玩家起身离座。`（勿臆断性别）
9. `dict/table.ts` / `dict/bank.ts` `Buy points`：`买点数控` / `向银行买点数控` → `买点数` / `向银行买点数`（修订 glossary）
10. `dict/player.ts` Play style VPIP 句：`参与 {vpip}% 的手牌，{pfr}% 先加注。` → `{vpip}% 的手牌主动入池，{pfr}% 的手牌率先加注。`
11. `dict/player.ts` `Aggression factor`：`攻击系数 {af}（每次跟注对应的下注加注数）。` → `激进度 {af}（每次跟注对应的下注或加注次数）。`
12. `dict/player.ts` `Biggest win`：`最大赢入` → `最大赢额`
13. `dict/landing.ts` `Your favourite group chat…`：`你最活跃的那个群，现在有牌桌了。` → `你最常聊的那个群，现在也有牌桌了。`（favourite≠活跃）
14. `dict/table.ts` `You are out of chips. Buy points from the bank...`：`你的筹码打光了。向银行买点数控（右上角菜单）。` → `你的筹码打光了。打开右上角菜单，向银行买点数。`
15. `dict/table.ts` `No cards were shown - the pot went to the last player standing.`：`没人亮牌——底池归了最后的留守者。` → `没人亮牌——底池归最后一个没弃牌的人。`

## Tier 2 — 应该改（翻译腔 / 僵硬 / 高频不自然）

1. `dict/login.ts` `Platform sign in`：`平台管理登录` → `平台账号登录`
2. `dict/login.ts` `manage the casino`：`…管理整个场子。` → `…管理平台。`
3. `dict/login.ts` 邀请句：`直接带你入席。` → `马上入席。`
4. `dict/landing.ts` Hero 副标题：`剩下的时间聊天。你最活跃的那个群…` → `留下来聊聊天。你最常聊的那个群，现在也有牌桌了。`
5. `dict/landing.ts` `6 位字母或数字房间码` → `6 位字母数字房间码`
6. `dict/landing.ts` `示例牌局互动演示` → `互动示例牌局`
7. `dict/landing.ts` `开一桌你的场子。` → `开一桌，变成你的场子。`
8. ~~`dict/landing.ts` 三步第 3 步~~：该条对应功能（3D 牌桌 / 社交酒廊）已删除，不再进入词典修订。
9. `dict/landing.ts` `Open source. Open to a closer look.`：`开源，随便查。` → `开源，欢迎细看。`
10. ~~`dict/landing.ts` FAQ 2D/3D~~：该条对应功能（3D 牌桌 / 社交酒廊）已删除，不再进入词典修订。
11. `dict/lobby.ts` `Archived tables`：`已归档的房间（{n}）` → `已归档的牌桌（{n}）`（table→牌桌）
12. `dict/lobby.ts` `Hands required before winnings count in settle-up`：`结算手数` → `计入结账前需打的手数`
13. `dict/lobby.ts` House cut：`台费：每个底池抽 {rate}，向下取整到整枚筹码。` → `台费：每个底池收取 {rate}，结果向下取整到整数筹码。`
14. `dict/table-page.ts` 连接休眠提示：`叫醒最多要一分钟…再等等` → `唤醒最多要一分钟。等一会儿，或手动重试。`
15. `dict/table-page.ts` viewer 权限：`也没有自己的筹码。` → `也不会有自己的筹码。`
16. `dict/table-page.ts` `Toggle chat`：`切换聊天` / `切换聊天，{n} 条未读` → `打开或关闭聊天` / `打开或关闭聊天，{n} 条未读`
17. `dict/table.ts` `Your balance. Bought {n} total.`：`你的余额。累计买入 {n}。` → `余额。累计买入 {n}。`
18. `dict/table.ts` auto-deal 说明：`让牌局一手接一手不停。` → `让牌局一手接一手。`
19. `dict/bank.ts` `Send chips to a player`：`送筹码给玩家` → `转筹码给玩家`（transfer）
20. `dict/bank.ts` `Approved. …`：`点数已经进你的筹码堆。` → `点数已进你的筹码。`
21. `dict/bank.ts` TV replays：`…每手结束后会保存每个玩家的底牌密钥…直播风格，随手就能剪视频。` → `…每手结束后都会保存所有玩家的底牌密钥，回放会亮出全部底牌——像直播一样，拿来就能剪视频。`
22. `dict/player.ts` 第 N 个账号：`4AM Casino 历史上第 {n} 个创建的账号。` → `4AM Casino 第 {n} 个账号。`
23. `dict/player.ts` 空状态：`你的牌局记录还是空的。` → `还没有牌局记录。`
24. `dict/player.ts` 结算说明：`线下把钱结清，然后你俩都标记一下，这边的账也就清了。` → `先在线下结清，再由你们双方标记已结清；平台这边也会同步清账。`
25. `dict/ledger.ts` `Bank ledger`：`银行账本` → `房间账本`
26. `dict/ledger.ts` + `dict/player.ts` `Biggest win`：统一 `最大赢额`
27. `dict/settle.ts` `已结清 — 双方都确认了。` → 破折号改 `——`
28. `dict/stats.ts` `Loose`：`松手` → `松`
29. `dict/fair.ts` `纯粹的数学——椭圆曲线上的一个点` → `都会编码成数学对象——椭圆曲线上的一个点`
30. ~~`dict/table3d.ts` 相机说明~~：该条对应功能（3D 牌桌）已删除，`dict/table3d.ts` 已不存在，不再进入词典修订。

## Tier 3 — 升级机会（更有梗 / 更像会打牌的老友）

1. `dict/landing.ts` Hero 第二句：`自己的牌局。`（可留）或 `今晚开牌。`
2. `dict/landing.ts` `把人凑齐。` → `先把人喊来。`
3. `dict/landing.ts` `发牌、闲聊、再来一局。` → `发牌，闲聊，再来一局。`
4. `dict/landing.ts` `那个「这次一定有牌」的朋友` → `那个每次都说「这把有牌」的朋友`
5. `dict/landing.ts` `牌局要爽，更要摊得开。`（保留，最成功的本土化）
6. `dict/landing.ts` `局总得有人攒。这回到你了。` → `总得有人攒局。这次就你来。`
7. `dict/login.ts` `✓ 账号建好了，这就拉你入桌…` → `✓ 账号建好了，马上发你入桌…`
8. `dict/login.ts` `✓ 登录成功，发牌了…`（保留）
9. `dict/table.ts` `还差有筹码的在线玩家（满两人开桌）…` → `还差一位在线且有筹码的玩家才能开牌…`
10. `dict/table.ts` `{names} 掉线了，牌局等大约 40 秒…` → `{names} 掉线了，这手牌等他们约 40 秒…`
11. `dict/table.ts` last player standing → `没人亮牌——最后一个没弃牌的人拿走底池。`
12. `dict/table.ts` `哎不行 💀` → `这也能输 💀`
13. `dict/bank.ts` `给筹码见底的朋友接济一把，或者结一笔桌外的账。`（保留）
14. `dict/player.ts` `鲨鱼 / 跟注站 / 疯子 / 岩石`（保留）
15. `dict/player.ts` `老对手`（保留）
16. ~~`dict/table3d.ts` `就当自己家`~~：该条对应功能（3D 牌桌）已删除，不再进入词典修订。
17. ~~`dict/table3d.ts` `…都能皮一下。互动全桌可见。`~~：该条对应功能（3D 牌桌）已删除，不再进入词典修订。
18. ~~`dict/table3d.ts` `高能一巴掌`~~：该条对应功能（3D 牌桌）已删除，不再进入词典修订。
19. ~~`dict/table3d.ts` 空桌口号~~：该条对应功能（3D 牌桌）已删除，不再进入词典修订。
20. `dict/fair.ts` `…那部分靠交情。`（保留）

## 全局模式（一次性修很多词条）

1. **统一 Buy points 体系**：buy-in→`买入`；buy points→`买点数`；解释性 prose→`娱乐筹码`；不用「充值」「点数控」。
2. **区分发牌 / 开一手 / 开一桌**：deal a hand→`发牌`；start a hand→`开一手`；open/create a table→`开一桌`。
3. **sit out 永远不要译成「旁观」**：sit out→`休息`；watch/viewer→`观战`；leave seat→`离座`。
4. **table / room / lobby 锁死**：room→`房间`；table→`牌桌`；lobby→`大厅`。
5. **服务器错误统一短句、无责备、给出下一步**：Could not…→`没能……，再试一次。`；no such…→`没有这个……。`；invalid…→`……无效。` 不用「出错啦/哎呀/失败了！」，0 感叹号。
6. **不要硬译 Your**：Your balance→`余额`；Your bet this street→`本轮已投入`；仅权限/隐私/所有权处保留「你的」。
7. **扑克统计用圈内术语**：loose→`松`；aggressive→`激进`；aggression factor→`激进度`；VPIP→`主动入池率`；PFR→`率先加注率`。
8. **避免 stack→「筹码堆」**：金额/HUD 直接用 `筹码`；starting stack→`起始筹码`。
9. **错误/设置/统计页少用拟人化营销句**；成功态可保留品牌口吻。
10. **中文 UI 动词优先**：Toggle chat→`打开或关闭聊天`；View chart data→`查看图表数据`；避免「切换/录入/进行……操作」。
11. **不臆断性别**：`他/她` → `这名玩家` / `对方` / `TA`（错误信息不用 TA）。
12. **保留已经很好的句子**（如 `自己人。`、`牌局要爽，更要摊得开。`、`那部分靠交情。`、`这手漂亮`）。
