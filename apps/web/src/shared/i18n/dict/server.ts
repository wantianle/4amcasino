// Server-provided prose: HTTP `{ error: '...' }` payloads (including errors
// thrown server-side and forwarded as the error string), WS `{ t: 'error',
// message: '...' }` toasts, hand-abort reasons, ledger `kind` badges + `note`
// strings, and the boundary prose this client itself generates in the same
// shapes. Keys are the exact English the server sends; dynamic strings use
// `{placeholder}` template keys. Canonical English stays in the server, logs
// and tests — `tr()` only ever runs at the web display boundary.
//
// Style per docs/zh-i18n.md: 一律「你」, 短句优先, 错误文案 0 感叹号, 术语表
// (账房/副账房, 台费, 买看, 结算, 作废, 买入, 底牌, 号位…), 错误长句以句号收尾,
// 徽章与流水短语不加标点.
const server: Record<string, string> = {
  // ── HTTP: rooms & membership ────────────────────────────────────────────
  'invalid input': '输入无效。',
  'no such room': '没有这个房间。',
  'no such invite': '没有这条邀请。',
  'no such pending request': '没有这个待处理申请。',
  'no such request': '没有这条申请。',
  'no such watch link': '这个观战链接不存在。',
  'not a member': '不是房间成员。',
  'not a member of this table': '你不是这张桌的成员。',
  'no such player': '没有这名玩家。',
  'no player with that username': '没有这个用户名的玩家。',
  'already at this table': '已经在这张桌上了。',
  'already invited': '已经邀请过了。',
  'request already sent': '申请已经发过了。',
  'you can only invite friends': '只能邀请好友。',
  'this table is private': '这张桌是私密的。',
  'the host turned watching off for this table': '房主关掉了这张桌的观战。',
  'watchers only': '只有观战者能查看这个。',
  'host or banker only': '只有房主或账房能操作。',
  'banker only': '只有账房能操作。',
  'only the host or the main banker can change that': '只有房主或正账房能改这个。',
  'only the main banker can pick a backup': '只有正账房能指定副账房。',
  'the backup banker must be a room member': '副账房得先是房间成员。',
  'only the host can change auto-deal': '只有房主能改自动发牌。',
  'big blind must be >= small blind': '大盲不能小于小盲。',
  'turn time must be 0 (no limit) or 5-180 seconds': '行动时限只能设 0（不限时）或 5-180 秒。',
  'a hand is in progress - wait for it to finish': '这手牌正在进行，等它打完。',
  'wait for the hand to finish': '等这手牌打完。',
  'The house cut changed. Review the updated rate and create the room again.':
    '台费比例变了。确认新费率后，重新开一桌。',
  'already decided': '这条申请已经处理过了。',
  'cannot disable the platform account': '不能停用平台账号。',
  'platform only': '只有平台账号能做这个操作。',

  // ── HTTP: P2 gameplay features (rooms.ts PATCH `features` + feature-triggers
  // POST/DELETE; bounds strings from gameplaySettings.ts, whose ${MIN}/${MAX}
  // interpolations are compile-time constants from @4am/shared roomRules.ts
  // (BOMB_POT_HANDS 1–1000, BOMB_POT_DURATION 60–604800s) — literal keys,
  // re-check if the shared bounds change. The `${feature}` in
  // `a ${feature} trigger is already pending` is a z.enum(['squid','bomb']),
  // so it's expanded into the two concrete strings instead of a {feature}
  // template (that would inject an English token into Chinese prose). ───────
  'only the host can change gameplay settings': '只有房主能改玩法设置。',
  'Gameplay settings apply between hands.': '玩法设置在手与手之间生效。',
  'bomb pot interval must be 1-1000 hands': '炸弹池间隔必须是 1-1000 手。',
  'bomb pot interval must be 60-604800 seconds': '炸弹池间隔必须是 60-604800 秒。',
  'host only': '只有房主能操作。',
  'this table is closed': '这张桌已经关了。',
  'squid game is not enabled for this table': '这张桌没开鱿鱼游戏。',
  'bomb pot is not enabled for this table': '这张桌没开炸弹池。',
  'wait for the current hand to finish': '等当前这手牌打完。',
  'that request id was already used for a different feature':
    '这个请求 ID 用在别的玩法触发上了。',
  // Exact keys (not a `{n}` template) on purpose: `squid_min_players` is bound
  // to 2-9 (roomRules.ts), and lobby.ts registers a generic `'{n} players'`
  // template earlier in the merge order — a template key here would be
  // shadowed and render "squid game needs at least 5 名玩家". Exact match is
  // stage (a) of `tr()`, so these always win. If SQUID_MIN_PLAYERS_* bounds
  // ever widen, add the missing counts here.
  'squid game needs at least 2 players': '鱿鱼游戏至少需要 2 名玩家。',
  'squid game needs at least 3 players': '鱿鱼游戏至少需要 3 名玩家。',
  'squid game needs at least 4 players': '鱿鱼游戏至少需要 4 名玩家。',
  'squid game needs at least 5 players': '鱿鱼游戏至少需要 5 名玩家。',
  'squid game needs at least 6 players': '鱿鱼游戏至少需要 6 名玩家。',
  'squid game needs at least 7 players': '鱿鱼游戏至少需要 7 名玩家。',
  'squid game needs at least 8 players': '鱿鱼游戏至少需要 8 名玩家。',
  'squid game needs at least 9 players': '鱿鱼游戏至少需要 9 名玩家。',
  'a squid trigger is already pending': '已经有一个鱿鱼游戏触发在排队了。',
  'a bomb trigger is already pending': '已经有一个炸弹池触发在排队了。',
  'no such pending trigger': '没有这个待触发的玩法安排。',
  'only manual triggers can be cancelled': '只有手动触发才能取消。',

  // ── P2 brief-specified keys NOT emitted verbatim by the server at lane E ──
  // The engine's multi-run guards reject stale/wrong-role decisions SILENTLY
  // (game.ts onRunCountChoice/Agree just `return`), and its HTTP/WS prose reads
  // differently (see the pairs noted per line). Kept as defensive wording per
  // the Lane H brief: `tr()` only matches these if a server build ever sends
  // them; meanwhile every real string above is covered. 优势方/劣势方 follow
  // docs/p2-gameplay-design.md §0 B4.
  // (= 'only the host can change gameplay settings' / 'host only')
  'only the host can trigger gameplay features': '只有房主能触发玩法。',
  // (= 'squid game is not enabled...' / 'bomb pot is not enabled...')
  'that feature is disabled': '这个玩法没开。',
  // (= 'wait for the current hand to finish' / 'hand already running')
  'a hand is already running': '已经有手牌在打了。',
  // (= 'squid game needs at least {2..9} players', the exact-key family above)
  'not enough players for Squid Game': '人不够，开不了鱿鱼游戏。',
  // (= 'a squid/bomb trigger is already pending')
  'that feature is already armed': '这个玩法已经排上了。',
  // (= 'no such pending trigger', the already-claimed cancel path)
  'that trigger was already claimed by a hand': '这个触发已经被一手牌用掉了。',
  // (= 'that request id was already used for a different feature'; matches the
  // existing tournament style 'This request ID was used for a different action.')
  'This request ID was used for a different trigger.': '这个请求 ID 用在别的触发上了。',
  // multi-run role/stage rejections — currently silent drops server-side:
  'only the behind player chooses the run count': '只有劣势方能选跑几次。',
  'only the ahead player can agree': '只有优势方能同意。',
  'that multi-run decision is no longer active': '这次多跑决策已经失效了。',

  // ── HTTP: chips, buys, transfers, settlement, ledger actions ────────────
  'no such ledger entry': '账本里没有这条记录。',
  'you already have buy requests waiting': '你已经有一条买入申请在排队了。',
  'wait for the hand to finish before moving chips': '等这手牌打完再动筹码。',
  'not enough chips to send that': '筹码不够，转不出这个数。',
  'that is you': '这就是你自己。',
  'that is your own stack': '这是你自己的筹码。',
  'both players must be at this table': '两个人都得在这张桌上。',
  'both players must be in this room': '两个人都得在这个房间里。',
  'that purchase was already reverted': '这笔买入已经撤销过了。',
  'only purchases can be reverted': '只有买入能撤销。',
  'the player no longer has enough chips to revert this': '这名玩家筹码不够，没法撤销了。',
  'no settled hand with that id': '这个 ID 对应的手牌还没结算。',
  'that hand was already voided': '那手牌已经作废过了。',
  'a winner no longer has enough chips to reverse this hand':
    '赢家的筹码已经不够，这手牌没法倒退了。',
  'no such settlement': '没有这笔结算。',
  'not your settlement': '这不是你的结算。',
  'you cannot settle with yourself': '自己没法跟自己结账。',
  'nothing to settle between you two here': '你俩在这没账要结。',

  // ── HTTP: accounts, auth, profile, friends ──────────────────────────────
  'bad credentials': '用户名或密码不对。',
  'wrong password': '密码不对。',
  'username taken': '用户名已被占用。',
  'that name is taken': '这个名字已被占用。',
  '2-24 characters, letters, numbers and _ only': '用户名需 2-24 位，只能用字母、数字和下划线。',
  'that is not your current password': '这不是你现在的密码。',
  'that is already your password': '新密码和现在用的一样。',
  'that recovery code does not match': '恢复码不正确。',
  'that recovery code was already used': '这个恢复码已经被用过了。',
  'recovery codes are issued automatically at signup and cannot be changed':
    '恢复码在注册时自动生成，无法修改。',
  'stand up from your seat first - changing your password re-keys your cards':
    '先起身离座。改密码会重新签发你的签名密钥。',
  'stand up from your seat first - renaming re-keys your cards':
    '先起身离座。改用户名会重新签发你的签名密钥。',
  'you are seated at a table - leave the seat before recovering':
    '你还坐在牌桌上，恢复账号前先起身离座。',
  'that user is seated at a table - they must stand up before a reset':
    '这名用户正坐在牌桌上，重置前需要先起身离座。',
  'account merged': '账号已合并，请用保留的账号登录。',
  'already friends': '已经是好友了。',
  'no such user': '没有这个用户名。',
  'no such user: {name}': '没有这个用户名：{name}',
  'too many attempts - try again in {n}s': '尝试次数太多，{n} 秒后再试。',
  'unauthorized': '请先登录。',
  'not found': '内容不存在。',
  'bad id': 'ID 无效。',
  'bad user id': '用户 ID 无效。',
  'invalid user search.': '用户搜索条件无效。',
  'Server restarting.': '服务器正在重启。',
  'invalid profile': '资料内容无效。',
  'no photo': '没有这张照片。',
  'no avatar': '还没有头像。',
  'that photo is not a usable image': '这张照片没法用。',
  'unsupported image type': '不支持这种图片格式。',
  'send a png, jpeg, or webp data URL': '请发送 png、jpeg 或 webp 格式的 data URL。',
  'image must be under {n}KB': '图片不能超过 {n}KB。',

  // ── HTTP: rate limits ───────────────────────────────────────────────────
  'too many requests - try again in {n}s': '请求太频繁，{n} 秒后再试。',

  // ── HTTP: account merges (thrown by merge.ts, forwarded as error) ───────
  'cannot merge an account into itself': '不能把账号合并到它自己。',
  'cannot merge the platform account': '平台账号不能参与合并。',
  'user {name} is already disabled': '用户 {name} 已经被停用了。',
  'cannot merge: finish or cancel owned tournaments and withdraw active tournament entries first':
    '不能合并：先打完或取消你主办的赛事，并撤回进行中的报名。',
  'cannot merge: settle outstanding tournament entries and prizes first':
    '不能合并：先结清未完成的赛事报名和奖金。',
  'cannot merge: a hand is in progress in room {room}': '不能合并：房间 {room} 有手牌正在进行。',
  'ledger integrity check failed for room {room} after merge (bad entry id {id})':
    '合并后房间 {room} 的账本校验失败（问题记录 ID {id}）。',
  'merge failed': '合并失败。',

  // ── HTTP: bot identity token (apps/server/src/botRoutes.ts) ─────────────
  // The agent-token / live-subscription routes were removed with the Agent
  // access chain (dd0da72); this is the one survivor still emitted there.
  'Agent token is expired or revoked.': '代理令牌已过期或已被吊销。',

  // ── HTTP: chip-amount validation (label + generic) ──────────────────────
  '{label} must be whole chips within the supported limit.':
    '{label} 必须是支持范围内的整数筹码。',

  // ── HTTP: game engine errors forwarded from @4am/shared ─────────────────
  'hand completed': '这手牌已经结束了。',
  'invalid action': '这个操作无效。',
  'invalid amount': '金额无效。',
  'invalid deck': '牌堆无效。',
  'no opponent can call': '没有对手能跟注。',

  // ── WS: table toasts ({ t: 'error', message }) ───────────────────────────
  'invalid json': 'JSON 格式无效。',
  'invalid message': '消息格式无效。',
  'slow down': '太快了，缓一缓。',
  'join a room first': '先进一个房间。',
  'not a member of that room': '你不是那个房间的成员。',
  'Agent token does not permit this command.': '这个代理令牌不允许这条指令。',
  'wait for the hand to end': '等这手牌结束。',
  'hand already running': '这手牌已经在打了。',
  'a new hand already started': '新的一手已经开始了。',
  'no such hand': '没有这手牌。',
  'you were not in that hand': '你不在那手牌里。',
  'not in this hand': '你不在这手牌里。',
  'seat taken': '这个位子已经有人了。',
  'only the host starts hands': '只有房主能开新的一手。',
  'need at least 2 seated, funded, connected players':
    '至少需要 2 名已入座、有筹码、在线的玩家。',
  'this table is archived - unarchive it to deal again':
    '这张桌已存档，取消存档才能继续发牌。',
  'bad signature': '签名不对。',
  'invalid card reveal': '亮牌无效。',
  'those are your own cards': '这是你自己的底牌。',
  'those cards are already public': '这几张牌已经公开了。',
  'you can show your cards after folding or once the hand ends':
    '弃牌之后或这手结束之后才能亮牌。',
  'peek offers only work between hands': '买看报价只能在一手牌结束后发出。',
  'not enough chips for that offer': '你的筹码不够出这个价。',
  'that offer is gone': '这条报价已经没了。',
  'that offer is not yours to answer': '这条买看报价不是发给你的。',
  'the buyer no longer has enough chips': '出价方的筹码已经不够了。',
  'that player was not in the last hand': '那名玩家不在上一手牌里。',
  'bad commit point': '提交点数据无效。',
  'not in commit phase': '现在不在承诺阶段。',
  'not in shuffle phase': '现在不在洗牌阶段。',
  'not your shuffle turn': '没轮到你来洗牌。',
  'not in a betting round': '现在不在下注轮里。',
  'no share expected from you': '这一步不需要你提交共享值。',
  'illegal action': '这个操作不合法。',
  // P2 engine (game.ts): server-side deadline backstop + multi-run run-count
  // validation. `maxRuns` is min(3, features.multiRun.maxRuns) — template key.
  'the action clock expired': '你的行动时间用完了。',
  'run count must be between 1 and {n}': '跑牌次数只能是 1 到 {n}。',
  'Only table members have a seat to leave.': '只有桌上的成员才有座可离。',

  // ── WS: betting-rule rejections thrown by @4am/shared, forwarded here ───
  'not your turn': '还没轮到你。',
  'amount required': '要填金额。',
  'cannot bet more than stack': '下注不能超过你的筹码。',
  'cannot check facing a bet': '有人下注了，不能过牌。',
  'nothing to call - check instead': '没有要跟的注，改成过牌。',
  'use bet when unopened': '无人下注时请用下注。',
  'use raise when facing a bet': '有人下注时请用加注。',
  'raise must exceed current bet': '加注必须高过当前注额。',
  'raise rights closed': '加注窗口已关闭。',
  'street not closed': '这一轮还没结束。',
  'no street after river': '河牌之后没有下一轮了。',
  'need at least 2 players': '至少需要 2 名玩家。',
  'minimum is {min}': '最少要 {min}。',

  // ── Hand-abort reasons (hand_abort.reason) ──────────────────────────────
  'key commitment timeout': '密钥承诺超时。',
  'shuffle timeout': '洗牌超时。',
  'unmask timeout': '解掩超时。',
  'invalid deck from shuffler': '洗牌者提交的牌堆无效。',
  'shuffled deck has duplicates': '洗好的牌堆有重复的牌。',
  'malformed unmask point': '解掩数据格式错误。',
  'invalid unmask proof': '解掩验证不通过。',
  'player left during the deal': '发牌途中有人离开了。',
  'opened board point at index {idx} is not a card (mis-shuffle)':
    '第 {idx} 个公共牌位解出来不是牌，洗牌出了问题。',
  'revealed hole point at index {idx} is not a card (mis-shuffle)':
    '第 {idx} 个亮牌位解出来不是牌，洗牌出了问题。',
  'The server restarted during this hand. Bets were returned; the host can deal again.':
    '这手牌打到一半服务器重启了。注已退回，房主可以重新发牌。',

  // ── Ledger: kind badges (short nouns, no punctuation) ───────────────────
  purchase: '买入',
  transfer: '转账',
  revert: '撤销',
  commission: '台费',
  'hand-settlement': '结算',
  'void-hand': '作废',
  peek: '买看',
  'seven-deuce': '7-2 彩头',
  // P2: one aggregated row per seat at settlement (game.ts applyHandSettlement).
  'squid-game': '鱿鱼游戏',

  // ── Ledger: note phrases ────────────────────────────────────────────────
  'paid the 7-2 offsuit bounty': '付了 7-2 不同花的彩头',
  'won with 7-2 offsuit': '靠 7-2 不同花赢下这手',
  "paid to see seat {seat}'s cards": '付费看了 {seat} 号位的底牌',
  'showed cards privately': '私下亮出了底牌',
  '{rate} table commission - keeps the lights on': '{rate} 台费——电费的钱',
  'revert of purchase #{id}': '撤销买入 #{id}',
  'hand voided by the banker': '账房作废了这手牌',
  'sent to {name}': '转给 {name}',
  'from {name}': '来自 {name}',
  // P2 squid settlement: the server writes ONE constant note per row
  // (game.ts:3112 `squidNote: 'Squid Game penalty/payout'`); the sign of the
  // delta decides whether a given seat paid or collected. The combined key is
  // the only one the server actually sends today — the split pair below is the
  // Lane H brief's requested wording, kept for display layers that resolve the
  // note per-direction. Glossary: 罚金/赔付 per docs/p2-gameplay-design.md §4.
  'Squid Game penalty/payout': '鱿鱼游戏罚金/赔付',
  'Squid Game penalty': '鱿鱼游戏罚金',
  'Squid Game payout': '鱿鱼游戏赔付',

  // ── HTTP: table bots (apps/server/src/botRoutes.ts) ──────────────────────
  'no such bot': '没有这个机器人。',
  'that seat is taken': '那个座位已经有人了。',
  'table is full: adding a bot would exceed the 6-player limit for tables with bots':
    '这张桌已经达到「含机器人最多 6 人」的上限，加不了新机器人了。',
  'bot username collision - try again': '机器人账号名撞车了，再试一次。',
  'room is not active': '这张桌已经不在开局状态。',
  'bot has been removed': '这个机器人已被移除。',
  'BOT_IDENTITY_KEY is not configured; refusing to create a bot':
    '服务器没有配置 BOT_IDENTITY_KEY，无法创建机器人。',
  'server is shutting down; cannot start bots': '服务器正在关闭，暂时不能启动机器人。',
  'bot identity is not recoverable; refusing to start':
    '机器人的身份密钥无法恢复，已拒绝启动。',
  'bot runner capacity reached for this room; stop one of its running bots first':
    '本桌机器人运行位已满；先停下一个在跑的机器人。',
  'bot state changed; retry the start': '机器人状态刚有变化，请重试开始。',
  'bot state changed; retry the stop': '机器人状态刚有变化，请重试停止。',
  // status-specific start refusals; the template is the catch-all
  'bot cannot start from waiting_buy_approval': '机器人还在等买入审批，还不能开始。',
  'bot cannot start from running': '机器人已经在打牌了；先停止再重新开始。',
  'bot cannot start from created': '机器人还没准备就绪，稍等再试。',
  'bot cannot start from stopping': '机器人正在收尾，等它停下后再开始。',
  'bot cannot start from {status}': '机器人当前是 {status} 状态，不能开始。',
  // status-specific stop refusals (stopping/stopped answer 200, removed has
  // its own message above - only the non-stoppable states reach this prose)
  'bot cannot stop from created': '机器人还没准备就绪，不用停止。',
  'bot cannot stop from waiting_buy_approval': '机器人还没开始打牌，不用停止。',
  'bot cannot stop from error': '机器人已经停下了，只是出了点问题。',
  'bot cannot stop from {status}': '机器人当前是 {status} 状态，不能停止。',

  // ── Client-generated prose at the same display boundary ─────────────────
  'request failed ({status})': '请求失败（{status}）',
  'session expired': '登录状态已过期',
  'Refused an unmask request for a card dealt to me.': '拒绝对发给我的牌做解掩请求。',
  'Could not decode a dealt card. The hand will abort.': '有一张发出来的牌解不开，这手牌要作废。',
  'Your peek offer was declined.': '你的买看被拒了。',
};

export default server;
