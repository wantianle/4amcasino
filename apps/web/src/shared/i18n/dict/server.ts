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
  'only the host or the banker can archive a table': '只有房主或账房能存档牌桌。',
  'only the host or the banker can delete a table': '只有房主或账房能删除牌桌。',
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

  // ── HTTP: agent tokens & live subscriptions ─────────────────────────────
  'Agent token not found.': '找不到代理令牌。',
  'Agent token is expired or revoked.': '代理令牌已过期或已被吊销。',
  'Sign in or use a valid agent token.': '请先登录，或使用有效的代理令牌。',
  'This agent token does not allow that action.': '这个代理令牌没有该操作的权限。',
  'Invalid agent access settings.': '代理访问设置无效。',
  'Revoke an existing agent token first (20 active tokens maximum).':
    '先吊销一个现有的代理令牌（最多同时 20 个有效令牌）。',
  'Room not found.': '找不到房间。',
  'Join this room first.': '先进这个房间。',
  'Join this room or enroll in this tournament first.': '先进这个房间，或先报名这个赛事。',
  'Join this room or tournament to subscribe.': '先进这个房间或赛事才能订阅。',
  'Invalid event subscription.': '事件订阅无效。',
  'Subscription access ended.': '订阅已到期。',
  'At most three simultaneous subscriptions per account.': '每个账号最多同时订阅 3 个。',
  'Invalid audit cursor.': '审计游标无效。',
  'Invalid result cursor.': '结果游标无效。',
  'The complete audit opens after the league completes.': '完整审计记录要等联赛结束才开放。',

  // ── HTTP: tournaments ───────────────────────────────────────────────────
  'Enter a participant name and choose human or agent.': '填一个参赛者名字，选真人还是代理。',
  'That participant name is already taken.': '这个参赛者名字已被占用。',
  'At least two entrants are required.': '至少需要两名参赛者。',
  'This tournament is full.': '这个赛事满员了。',
  'Entrant not found.': '找不到这名参赛者。',
  'Tournament not found.': '找不到这个赛事。',
  'Use a player account to enter tournaments.': '请用玩家账号报名赛事。',
  'Enrollment opens after platform approval.': '平台批准后才开放报名。',
  'Read and accept the current tournament rules before enrolling.':
    '报名前先读一遍当前赛事条款并接受。',
  'Enrollment is locked after a tournament starts.': '赛事开始后，报名就锁定了。',
  'Enrollment is locked after start.': '开赛后报名已锁定。',
  'Entry fees are locked after start.': '开赛后报名费已锁定。',
  'An active enrollment already has a different entry fee.': '已有的有效报名用了不同的报名费。',
  'You are already out of this tournament.': '你已经退出这个赛事了。',
  'Only an entrant can sit out.': '只有参赛者能申请休息。',
  'Choose how many hands to sit out.': '选好要休息几手。',
  'A single sit-out cannot exceed {n} hands.': '单次休息不能超过 {n} 手。',
  'Only {n} sit-out hands remain.': '只剩 {n} 手休息额度。',
  'Your sit-out budget is spent. You must play on.': '你的休息额度用完了，得继续打。',
  'A single sit-out cannot exceed the whole sit-out budget.':
    '单次休息不能超过休息总额度。',
  'Tournament is not running.': '赛事不在进行中。',
  'Only an approved, open tournament can start.': '只有已批准、开放中的赛事才能开始。',
  'An action requires handNumber, actionSeq, requestId and a valid decision.':
    '操作需要 handNumber、actionSeq、requestId 和有效的决策。',
  'The table has changed. Read state before acting again.': '牌局状态变了，先刷新再操作。',
  'This request ID was used for a different action.': '这个请求 ID 用在别的操作上了。',
  'Invalid action.': '这个操作无效。',
  'Invalid hand number.': '手牌编号无效。',
  'Only completed hands can be replayed.': '只有打完的手牌才能回放。',
  'Watching is limited to tournament participants.': '观战仅限赛事参赛者。',
  'Invalid tournament control.': '赛事指令无效。',
  'Only the organizer can control this tournament.': '只有主办方能控制这个赛事。',
  'That control is not available now. Pause before cancelling a running league.':
    '这个指令现在不可用，联赛要先暂停才能取消。',
  'Finish or cancel an existing tournament first (five active tournaments maximum).':
    '先打完或取消现有赛事（最多同时进行 5 个）。',
  'Check the tournament settings (2–9 entrants, 10–10,000 hands).':
    '检查一下赛事设置（2–9 名参赛者，10–10,000 手牌）。',
  'Check the tournament settings.': '检查一下赛事设置。',
  'Big blind must cover the small blind; stack must cover at least two big blinds.':
    '大盲要能覆盖小盲，筹码至少要能覆盖两个大盲。',
  'Starting stack must cover two big blinds.': '起始筹码要能覆盖两个大盲。',
  'The tournament changed. Reload before saving.': '赛事有变动，刷新后再保存。',
  'Terms are locked after the first enrollment. Create a new tournament for different rules.':
    '条款在第一个报名后就锁定了。想改规则请新建赛事。',
  'Use a YouTube/Twitch stream and a Google Meet HTTPS link.':
    '直播用 YouTube/Twitch 链接，会议用 Google Meet 的 HTTPS 链接。',
  'Provide the current revision and a review note.': '提供当前修订号并填写审核备注。',
  'This proposal has changed, was cancelled, or was already reviewed. Reload it.':
    '这个提案已变动、已取消或已审过，刷新再看。',
  'Choose an entrant and provide an award note.': '选一名参赛者，并写一条奖励备注。',
  'Record awards after the tournament completes.': '奖励要在赛事结束后再记。',

  // ── HTTP: tournament policy & economy validation ────────────────────────
  'Invalid tournament policy.': '赛事规则无效。',
  'Tournament cuts may only go to the house and prize pool.': '赛事抽成只能给平台和奖池。',
  'Check tournament fees, payout percentages, schedule and broadcast links.':
    '检查赛事费用、派奖比例、日程和直播链接。',
  'Prize percentages must total 100%.': '奖金比例合计必须是 100%。',
  'The organizer guarantee must cover the joining reward for every seat.':
    '主办方保底必须覆盖每个座位的加入奖励。',
  'A freezeout entry fee must cover two big blinds.': '淘汰制的报名费要能覆盖两个大盲。',
  'A freezeout entry fee is the starting stack and cannot exceed {n} chips.':
    '淘汰制的报名费就是起始筹码，不能超过 {n} 筹码。',
  'Payout basis points must total 10000.': '派奖基点合计必须是 10000。',
  'Payout percentages must fund an occupied place.': '派奖比例必须对应有人占据的名次。',
  'Invalid prize rank.': '奖次无效。',
  'Prize rankings repeat a player.': '奖励排名里有玩家重复。',
  'Prize rankings must include every entrant exactly once.':
    '奖励排名必须恰好包含每名参赛者一次。',
  'Tied ranks must reflect their occupied payout places.': '并列名次要对应它们占据的派奖位置。',
  'Prizes were finalized with different rankings or payouts.':
    '奖金已按不同的排名或派奖定稿。',
  'A funded pool requires entrants before prizes can complete.':
    '已注资的奖池要先有参赛者，才能完成派奖。',
  'A started tournament must pay prizes instead of reversing its entries.':
    '已开赛的赛事只能派奖，不能退报名。',
  'Tournament accounting is closed after completion or cancellation.':
    '赛事结束或取消后，账目已封账。',
  'The unstarted pool contains unreconciled play.': '未开赛的奖池里有未对平的交易。',
  'Invalid funding source.': '注资来源无效。',
  'Joining rewards were started with different terms.': '加入奖励已按不同条款开启。',
  'Hand number must be positive.': '手牌编号必须为正数。',
  'Hand result contains an unknown entrant.': '手牌结果里有不认识的参赛者。',
  'A request reference of at most 200 characters is required.':
    '需要不超过 200 字符的请求凭据。',
  'This reference was used for a different accounting transfer.':
    '这个凭据编号用在别的转账上了。',
  'A journal transfer repeats an account.': '账本转账里同一个账户出现了两次。',
  'Tournament transfers must balance to zero.': '赛事转账必须收支相抵为零。',
  'Journal balance exceeds the supported chip limit.': '账本余额超出了支持的筹码上限。',
  'The prize pool cannot fund this transfer.': '奖池余额不够这笔转账。',
  'Settlement amount must be nonzero.': '结算金额不能为零。',
  'Settlement note must be at most 2000 characters.': '结算备注不能超过 2000 字符。',
  'Record settlements only after the tournament has ended.': '结算记录要在赛事结束后再记。',
  'This request ID was used for a different settlement record.':
    '这个请求 ID 用在别的结算记录上了。',

  // ── HTTP: sponsors ──────────────────────────────────────────────────────
  'Invalid sponsor input.': '赞助信息无效。',
  'Sponsor campaign not found.': '找不到这个赞助活动。',
  'The sponsor campaign changed. Reload before saving.': '赞助活动有变动，刷新后再保存。',
  'The sponsor campaign changed. Reload before deleting.': '赞助活动有变动，刷新后再删除。',
  'Campaigns with receipts cannot be deleted. Disable the placement instead.':
    '已有收款的赞助活动不能删除，改为停用投放。',
  'Booked chips cannot be less than recorded receipts.': '登记筹码不能少于已记录的收款。',
  'Recorded receipts cannot exceed booked chips. Update the booking first.':
    '已记录收款不能超过登记筹码，先改登记数。',
  'This request ID was used for a different sponsor receipt.':
    '这个请求 ID 用在别的赞助收款上了。',
  'Select a tournament for the prize contribution.': '给奖金注资选一个赛事。',
  'Prize contributions require an approved tournament in registration or play.':
    '注资奖金需要处于报名或比赛阶段的已批准赛事。',
  'Choose a player, signed chip amount and receipt note.':
    '选择玩家，填写带符号的筹码数和收款备注。',

  // ── HTTP: chip-amount validation (label + generic) ──────────────────────
  '{label} must be whole chips within the supported limit.':
    '{label} 必须是支持范围内的整数筹码。',
  'Journal balance must be whole chips within the supported limit.':
    '账本余额必须是支持范围内的整数筹码。',
  'Journal transfer must be whole chips within the supported limit.':
    '账本转账必须是支持范围内的整数筹码。',
  'Entry fee must be whole chips within the supported limit.':
    '报名费必须是支持范围内的整数筹码。',
  'Funding amount must be whole chips within the supported limit.':
    '注资金额必须是支持范围内的整数筹码。',
  'Joining reward must be whole chips within the supported limit.':
    '加入奖励必须是支持范围内的整数筹码。',
  'Total joining rewards must be whole chips within the supported limit.':
    '加入奖励总额必须是支持范围内的整数筹码。',
  'Hand number must be whole chips within the supported limit.':
    '手牌编号必须是支持范围内的整数筹码。',
  'Hand result must be whole chips within the supported limit.':
    '手牌结果必须是支持范围内的整数筹码。',
  'House fee must be whole chips within the supported limit.':
    '平台抽成必须是支持范围内的整数筹码。',
  'Prize contribution must be whole chips within the supported limit.':
    '奖金注资必须是支持范围内的整数筹码。',
  'Recorded payments must be whole chips within the supported limit.':
    '已记录付款必须是支持范围内的整数筹码。',
  'Settlement balance must be whole chips within the supported limit.':
    '结算余额必须是支持范围内的整数筹码。',
  'Outstanding balance must be whole chips within the supported limit.':
    '待结余额必须是支持范围内的整数筹码。',
  'Settlement amount must be whole chips within the supported limit.':
    '结算金额必须是支持范围内的整数筹码。',

  // ── HTTP: tournament engine errors forwarded from @4am/shared arena ─────
  'hand completed': '这手牌已经结束了。',
  'invalid action': '这个操作无效。',
  'invalid amount': '金额无效。',
  'invalid arena configuration': '赛事牌局配置无效。',
  'invalid deck': '牌堆无效。',
  'no opponent can call': '没有对手能跟注。',

  // ── WS: table & lounge toasts ({ t: 'error', message }) ─────────────────
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
  'Join this table as a member to explore the lounge.': '先以成员身份入桌，才能去酒廊逛逛。',
  'Only table members have a seat to leave.': '只有桌上的成员才有座可离。',
  'Take a break before leaving your chair.': '要先申请休息，才能离座。',
  'Finish this hand before walking away. Your break is saved.':
    '先打完这手再走，你的休息已经排上了。',
  'Choose an open seat to return to the table.': '选个空位坐下，回到牌桌。',
  'Choose a clear spot on the lounge floor.': '在酒廊里挑块空地站。',
  'That part of the lounge is full. Choose another spot.': '酒廊那块位置满了，换一个。',

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

  // ── Client-generated prose at the same display boundary ─────────────────
  'request failed ({status})': '请求失败（{status}）',
  'session expired': '登录状态已过期',
  'Refused an unmask request for a card dealt to me.': '拒绝对发给我的牌做解掩请求。',
  'Could not decode a dealt card. The hand will abort.': '有一张发出来的牌解不开，这手牌要作废。',
  'Your peek offer was declined.': '你的买看被拒了。',
};

export default server;
