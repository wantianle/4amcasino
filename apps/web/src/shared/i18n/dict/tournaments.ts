// Tournament dictionary (pages/tournaments: TournamentsPage / TournamentWatchPage /
// TournamentTerms / TournamentEarnings / SponsorPlacements).
// Glossary per docs/zh-i18n.md §2: tournament formats 淘汰制 / 击倒赛 /
// 固定手数循环赛 (the format is fixed-hand-count, not monthly, so §2.2's
// fallback term 循环赛 is the locked site-wide choice), standings → 排名,
// enroll → 报名, prize pool → 奖池, place → 名次, house → 平台,
// agent → 代理 (matches dict/server.ts 代理令牌), spectator watch → 观战.
// Reused from other dicts, NOT redefined here: 'Tournaments'/'Tournament' (nav),
// 'Standings' (table-page), 'Last hand' (table), 'Retry' (lobby), 'Cancel' (ledger),
// 'Try again' (landing), 'Outstanding' (settle), 'All-in'/'Fold'/'Check'/'Call'/'Bet'/
// 'Raise'/'Raise to' (settings/table), 'Small blind'/'Big blind' (lobby), 'Offline' (table),
// 'Your cards'/'Community cards' (landing), 'Dealer button' (table), 'Copy invite link' (share),
// '{n} chips' (stats), '{n} hands' (leaderboard), 'Net chips' (stats), 'Saving…' (settings),
// 'Sponsors' (admin — the label lists sponsor entities, so 赞助商, not 赞助),
// 'Your sit-out budget is spent. You must play on.' (server).
// Pagination 'Previous'/'Next' (上一页/下一页) belong to dict/admin.ts; this page's
// replay stepper uses the distinct keys 'Previous step'/'Next step'.
// NOTE: the standings column 'Hands' also resolves through dict/table-page.ts ('牌局记录'),
// which owns that global key; not overridden here to keep the table-page nav button correct.
// Tournament names, usernames/agent names, seed hashes, URLs, BB/100, payout-percentage
// lists and sponsor headlines/descriptions are content — passed through untranslated.
const tournaments: Record<string, string> = {
  // ── Status words (badges; capitalized enum values + tab filters) ─────────
  'Enrollment open': '开放报名',
  Registration: '报名中',
  Running: '进行中',
  Paused: '已暂停',
  Completed: '已结束',
  Cancelled: '已取消',
  Pending: '待审批',
  Rejected: '未通过',
  Published: '已发布',
  'Awaiting approval': '等待审批',
  'Changes requested': '需要修改',
  Upcoming: '即将开始',
  Live: '进行中',
  Past: '已结束',
  'My proposals': '我的提案',

  // ── Tournament formats (display-site keys for shared tournamentFormatLabel) ──
  Freezeout: '淘汰制',
  Knockout: '击倒赛',
  'Fixed-hand league': '固定手数循环赛',

  // ── List page ───────────────────────────────────────────────────────────
  'Find your next table. Read the terms, bring your agent, and play for the published prizes.':
    '下一张桌在这里等你。看清条款，带上代理，去争公布的奖池。',
  'Connect an agent': '连接代理',
  'Close form': '收起表单',
  'Create tournament': '创建赛事',
  'Propose a tournament': '发起赛事提案',
  'Publish a tournament': '发布赛事',
  'Sign in to propose a tournament': '登录后即可发起赛事提案',
  'Filter tournaments': '筛选赛事',
  'Loading tournaments…': '正在加载赛事…',
  'Your next tournament starts here.': '你的下一场赛事从这里开始。',
  'No {state} tournaments yet.': '还没有{state}的赛事。',
  'Set the format, schedule, entry terms and prizes, then submit your proposal for platform review.':
    '定好赛制、赛程、报名条款和奖品，再把提案交给平台审核。',
  'Propose a fixed-hand league, knockout or freezeout to bring players together.':
    '发起固定手数循环赛、击倒赛或淘汰制，把大家凑到一张桌上。',
  'Events appear here when play begins. Check upcoming tournaments for your next seat.':
    '开赛后，赛事会出现在这里。想坐下一桌，去「即将开始」里找。',
  'Completed and cancelled tournaments stay here with their saved standings and prizes.':
    '已结束和已取消的赛事，连同存档的排名与奖品，都留在这里。',
  '{a}/{b} entrants': '{a}/{b} 人已报名',
  '{n} chips entry': '{n} 筹码报名费',
  'Free entry': '免费报名',
  'Final standings available': '最终排名已出',
  'Event closed': '赛事已关闭',
  'Play in progress': '比赛进行中',
  'Play paused': '比赛已暂停',
  'Organizer guarantee · {n} chips': '主办方保底 · {n} 筹码',
  'Choose your format': '挑一种赛制',
  'Stacks reset each hand. Compare net chips and BB/100 over a fixed run.':
    '每手重置筹码，比固定手数内的净胜筹码和 BB/100。',
  'Keep your stack between hands. Blinds rise on schedule and eliminated players leave play.':
    '筹码跨手保留，盲注按时上涨，出局的人离场。',
  'Read before you enroll': '报名前必读',
  'Entry fees, rewards, pot cuts and payout places are published before enrollment. Your accepted rule revision locks the terms.':
    '报名费、奖励、底池抽成和发奖名次都在开放报名前公布。你接受的条款版本一经确认即锁定。',
  'All accounting uses competition chips and manual settlement, separate from cash and ordinary poker room balances.':
    '账目全部使用比赛筹码，人工结账，与真钱和房间余额互不相干。',

  // ── Detail page: header & notices ────────────────────────────────────────
  'Loading tournament…': '正在加载赛事…',
  'All tournaments': '全部赛事',
  '{format} for people and their agents.': '人和代理都能上手的{format}。',
  'Public watch page': '公开观战页',
  'Tournament link copied.': '赛事链接已复制。',
  'Could not copy. Copy the address from your browser.': '没能复制，请从浏览器地址栏手动复制。',
  'Connect my agent': '连接我的代理',
  'Live updates interrupted: {error}': '实时更新中断：{error}',
  'Proposal awaiting approval': '提案等待审批',
  'This proposal is private. Enrollment opens after platform approval.':
    '提案只有你能看到，平台通过后开放报名。',
  'Platform review:': '平台审核意见：',
  'Edit tournament terms': '修改赛事条款',
  'Published terms updated.': '已更新发布条款。',
  'Proposal submitted for review.': '提案已提交审核。',
  'Take your place': '入座报名',
  'Enrollment pending approval': '报名待平台审批',
  'Tournament complete': '赛事已结束',
  'Tournament cancelled': '赛事已取消',
  'Hand {n}': '第 {n} 手',
  '{done} / {limit} hands': '{done} / {limit} 手',
  'Tournament hand progress': '赛事手数进度',
  'The platform must approve this revision before entrants can accept the terms.':
    '平台通过这一版条款后，参赛者才能接受。',
  'You’re enrolled as {name}.': '你已报名，参赛名为 {name}。',
  'Connect your agent before the tournament starts.': '开赛前先把你的代理连上。',
  'Keep this page open to take your turns.': '保持这个页面打开，轮到你时才能操作。',
  Withdraw: '退出报名',
  'Sit out · hands': '休息 · 手数',
  '{a} of {b} sit-out hands left. Blinds keep posting, so sitting out costs chips.':
    '休息额度还剩 {a} / {b} 手。盲注照付，休息也要花筹码。',
  'Sit out': '休息',
  'Sign in to enroll': '登录后即可报名',
  'Platform accounts manage tournaments. Use a player account to enroll.':
    '平台账号只负责管理赛事，报名请用玩家账号。',
  'Participant name': '参赛者名称',
  'Who will play?': '由谁来打？',
  'My agent': '我的代理',
  'I will play': '我自己打',
  'I accept revision {n}, including the entry fee, payouts, deductions and card disclosure.':
    '我接受第 {n} 版条款，包括报名费、奖金分配、抽成和亮牌方式。',
  'Tournament full': '名额已满',
  'Enrolling…': '报名中…',
  'Accept & enroll · {n} chips': '接受条款并报名 · {n} 筹码',
  'Accept & enroll for free': '接受条款并免费报名',

  // ── Detail page: live hand panel ─────────────────────────────────────────
  'Last hand ended before the flop.': '最后一手在翻牌前就结束了。',
  'Preflop · community cards follow the betting.': '翻牌前 · 下注后发公共牌。',
  '(you)': '（你）',
  Folded: '已弃牌',
  '{n} in': '已投入 {n}',
  'Your turn': '轮到你了',
  'Deadline {time}': '截止 {time}',
  'Waiting for {who}.': '正在等待：{who}',
  'the next hand': '下一手牌',
  'Paused. Scores and the current hand are saved; the organizer can resume.':
    '已暂停。成绩和当前这手都存着，主办方可以继续。',
  'Tournament results': '赛事结果',
  'Tournament sections': '赛事栏目',
  Winnings: '收益',
  'Rules & prizes': '规则与奖品',

  // ── Detail page: standings / winnings tabs ───────────────────────────────
  'No entrants yet. Share the link to fill the table.': '还没人报名。把链接发出去，凑齐一桌。',
  Place: '名次',
  Entrant: '参赛者',
  Stack: '筹码堆',
  'Play net': '实战盈亏',
  'Prize chips': '奖金筹码',
  Timeouts: '超时',
  Agent: '代理',
  Human: '真人',
  Online: '在线',
  'Ranked by elimination order, then remaining stack. Eliminated entrants keep their final place.':
    '按出局顺序、再看剩余筹码排名。出局的参赛者保持最终名次。',
  'Ranked by play net. Equal scores share a place. BB/100 is net big blinds per 100 hands.':
    '按实战盈亏排名，同分并列。BB/100 是每 100 手的净大盲数。',
  'Play net measures performance and is separate from settlement dues.':
    '实战盈亏只衡量表现，与结算欠款是两回事。',
  'Last completed hand': '最近完成的一手',
  'Results appear after the first hand finishes.': '第一手打完后，这里就有结果。',
  'Final chip allocation': '最终筹码分配',
  'Entry accounting': '报名账目',
  'Settlement net = joining reward + prize − entry fee. Positive outstanding means chips due to the entrant; negative means chips due from the entrant. Play net is shown separately.':
    '结算净额 = 入场奖励 + 奖金 − 报名费。待付为正，表示应付给参赛者筹码；为负，表示参赛者还要付出筹码。实战盈亏另行显示。',
  'Entry accounting appears when the first player enrolls.': '第一名玩家报名后，这里会出现报名账目。',
  'Entry fee': '报名费',
  'Joining reward': '入场奖励',
  Prize: '奖金',
  'Settlement net': '结算净额',
  'Recorded paid': '已记录付款',
  'All values are competition chips. Payments are recorded by the platform after manual settlement. Prizes become final when the event ends.':
    '数值全部是比赛筹码。付款在人工结账后由平台记录。赛事结束，奖金即最终确定。',
  'Award recipient': '获奖者',
  '{name} · place {n}': '{name} · 第 {n} 名',
  'Award note': '颁奖备注',
  'Reward and fulfillment status': '奖励内容与发放状态',
  'Record award note': '记录颁奖备注',

  // ── Detail page: organizer & platform controls ───────────────────────────
  'Review awards': '核对奖项',
  'Organizer controls': '主办方操作',
  'Close editor': '收起编辑器',
  'Edit terms': '编辑条款',
  'Open rules & prizes': '查看规则与奖品',
  'Start tournament': '开始赛事',
  'Pause tournament': '暂停赛事',
  'Resume tournament': '继续赛事',
  'Cancel this tournament? Before play, entry obligations reverse. After play, the earned pool is allocated by standings. Saved results remain and play cannot resume.':
    '确定取消这个赛事？开赛前取消，报名义务原路退回；开赛后取消，已累积的奖池按当前名次分配。存档的结果仍可查，但不能重开。',
  'Review the final standings, then record award notes for your entrants. Notes do not send payouts.':
    '先核对最终排名，再给参赛者记颁奖备注。备注不会发放奖金。',
  'Saved hands and standings remain available. This tournament cannot resume.':
    '存档的手数和排名仍可查。这个赛事不能重开。',
  'Approval is required before enrollment and play.': '先通过平台审批，才能开放报名和开赛。',
  'At least two entrants are required. Scheduled approved events start automatically; the organizer may also start them here.':
    '至少需要两名参赛者。定时且已通过的赛事会自动开始，主办方也可以在这里手动开赛。',
  'Pausing saves the current hand. Resume when entrants are ready to continue.':
    '暂停会保存当前这手。参赛者准备好后再继续。',
  'Entry terms are permanently locked because an entrant accepted them.': '有参赛者已接受条款，条款永久锁定。',
  'Terms can be edited until the first enrollment.': '第一名报名前，条款都可以修改。',
  'Broadcast links': '直播链接',
  'Broadcast links updated.': '直播链接已更新。',
  'Tournament funds': '赛事资金',
  'Available prize pool': '可发奖池',
  'Prizes allocated': '已分配奖金',
  'House accrued': '平台累计抽成',
  'Sponsor contributions': '赞助投入',
  'Competition-chip accounting. Recorded separately from cash and room balances.':
    '按比赛筹码记账，与真钱和房间余额分开记录。',
  'Join the broadcast': '进入直播',
  'Open stream': '打开直播',
  'Open Google Meet': '打开 Google Meet',
  'Links open in a new tab.': '链接会在新标签页打开。',
  'Bring your own agent': '自带代理',
  'Your agent connection': '你的代理连接',
  'Enroll, create a token for this tournament, then connect your MCP client. Your agent receives your cards and legal actions.':
    '先报名，为这场赛事建一个令牌，再连上你的 MCP 客户端。代理会收到你的底牌和合法操作。',
  'Your seat is enrolled. Connect your MCP client with a token for this tournament. Keep it running to respond when your turn arrives.':
    '你的席位已报名。用这场赛事的令牌连上 MCP 客户端并保持运行，轮到你时才能应答。',
  'Set up agent access': '设置代理访问',
  'Deal commitment': '发牌承诺',
  'The seed is committed before enrollment. It is revealed after completion so the shuffle sequence can be reproduced. The server still deals and knows the cards.':
    '种子在报名前就已承诺，结束后公开，洗牌顺序可以完整复现。服务器负责发牌，它知道所有的牌。',
  'Revealed seed': '已公开的种子',

  // ── Terms panel (TournamentTerms) ────────────────────────────────────────
  'Request failed. Please try again.': '请求失败，再试一次。',
  'Organizer starts when ready': '主办方随时可开赛',
  'Entry terms · revision {n}': '报名条款 · 第 {n} 版',
  'Locked on first enrollment': '已有报名，条款已锁定',
  'Locks on first enrollment': '第一名报名后锁定',
  Format: '赛制',
  'Scheduled start': '预计开赛',
  '{n} chips · vests at start': '{n} 筹码 · 开赛时生效',
  'Organizer guarantee': '主办方保底',
  'Payout places': '发奖名次',
  'Pot deductions': '底池抽成',
  'House {rate} · prize pool {pool}': '平台 {rate} · 奖池 {pool}',
  Blinds: '盲注',
  'double every {n} hands': '每 {n} 手翻倍',
  'fixed throughout': '全程固定',
  'Starting stack': '起始筹码',
  '{n} chips · your entry fee, carried between hands': '{n} 筹码 · 即报名费，跨手保留',
  '{n} chips · reset every hand': '{n} 筹码 · 每手重置',
  '{n} chips · carried between hands': '{n} 筹码 · 跨手保留',
  'Sit-out budget': '休息额度',
  '{a} hands · up to {b} at a time': '{a} 手 · 单次最多 {b} 手',
  'Blinds keep posting while you sit out.': '休息期间盲注照付。',
  'Hand limit': '手数上限',
  '{n} · then ranked by remaining stack': '{n} 手 · 之后按剩余筹码排名',
  'Decision timer': '行动计时',
  '{n} seconds · timeout checks when free, otherwise folds': '{n} 秒 · 超时时可过牌就过牌，否则弃牌',
  'Watching & disclosure': '观战与亮牌',
  'Public watching enabled.': '已开放公开观战。',
  'Public watching disabled.': '未开放公开观战。',
  'All hole cards, including folded cards, revealed after each hand.':
    '每手结束后公开全部底牌，弃的也算。',
  'Only showdown cards revealed.': '只公开摊牌的牌。',
  'Prizes:': '奖品：',
  'Organizer rules:': '主办方规则：',
  'Whole competition chips, settled manually. These amounts are separate from cash and ordinary room balances. Entry obligations reverse if cancelled before play. After play, cancellation allocates the earned pool by current standings. Tied places share their combined prize allocation.':
    '全部为比赛筹码，人工结算，与真钱和房间普通余额互不相关。开赛前取消，报名义务原路退回；开赛后取消，已累积的奖池按当前名次分配。并列名次合并分配对应的奖金。',
  'Deductions apply once to each contested pot; uncalled returns are exempt. The organizer guarantee funds joining rewards and the starting prize pool. Recorded payments are platform records of settlement.':
    '抽成只对有对抗的底池收一次，无人跟注的退回部分不收。主办方保底用于支付入场奖励和初始奖池。记录在案的付款，是平台对结算的存证。',

  // ── Terms form (create / edit dialog) ────────────────────────────────────
  'Payout percentages must be positive and add up to 100%. Separate each place with a comma.':
    '奖金比例必须是正数，合计 100%。名次之间用逗号分隔。',
  'The organizer guarantee must cover joining rewards for all {n} seats ({total} chips).':
    '主办方保底必须覆盖全部 {n} 个席位的入场奖励（{total} 筹码）。',
  'Broadcast links must use HTTPS and contain no embedded credentials.':
    '直播链接必须使用 HTTPS，且不能内嵌凭证。',
  'Use a YouTube or Twitch HTTPS link for the stream.': '直播请用 YouTube 或 Twitch 的 HTTPS 链接。',
  'Use a meet.google.com link for Google Meet.': 'Google Meet 请用 meet.google.com 链接。',
  'Event details': '赛事信息',
  'Tournament name': '赛事名称',
  'Friday Agent League': '周五代理联赛',
  Description: '描述',
  'Fixed-hand league · equal stacks': '固定手数循环赛 · 人手等量筹码',
  'Knockout · last player standing': '击倒赛 · 站到最后的人赢',
  'Freezeout · entry fee is your stack': '淘汰制 · 报名费就是你的筹码',
  'Scheduled start · your local time': '预计开赛 · 按你的本地时间',
  'Optional. Approved events start with at least two entrants.': '可不填。审核通过的赛事满两人即自动开赛。',
  Seats: '席位',
  'Maximum hands': '最多手数',
  'Hands per entrant': '每人手数',
  'Starting stack · set by the entry fee': '起始筹码 · 由报名费决定',
  'Stack reset every hand': '每手重置筹码',
  'Seconds per decision': '每步秒数',
  'Blind increase interval · hands': '盲注翻倍间隔 · 手数',
  'Blinds double at this interval in knockout and freezeout events.':
    '击倒赛和淘汰制中，盲注按这个间隔翻倍。',
  'Sit-out budget · hands': '休息额度 · 手数',
  'Total hands one entrant may sit out. Blinds still post, so sitting out costs chips.':
    '一名参赛者总共可休息的手数。盲注照付，休息也要花筹码。',
  'Longest single sit-out · hands': '单次休息上限 · 手数',
  'Cannot exceed the whole sit-out budget.': '不能超过休息总额度。',
  'Chips & payouts': '筹码与奖金',
  'Whole competition chips. No cash collection or automated payment occurs here.':
    '全部是比赛筹码。这里不收真钱，也没有自动打款。',
  'Entry fee · chips': '报名费 · 筹码',
  'Joining reward · chips': '入场奖励 · 筹码',
  'Organizer guarantee · chips': '主办方保底 · 筹码',
  'Funds joining rewards and any starting prize pool.': '用于支付入场奖励和初始奖池。',
  'House cut · %': '平台抽成 · %',
  'Prize pool cut · %': '奖池抽成 · %',
  'Payout percentages · first place onward': '奖金比例 · 从第一名起',
  'Comma-separated percentages adding to 100. Ties split affected places.':
    '逗号分隔，合计 100。并列名次合并拆分。',
  'Prize description': '奖品说明',
  'Additional entry & award rules': '补充报名与颁奖规则',
  'Watching & broadcast': '观战与直播',
  'Allow anonymous public watching': '允许匿名公开观战',
  'Saving these terms publishes all hole cards, including folded hands, after each hand. This disclosure is included in the entry terms accepted by entrants.':
    '保存这份条款后，每手结束都会公开全部底牌（含弃牌）。这条披露会写进参赛者接受的报名条款。',
  'YouTube or Twitch stream URL': 'YouTube 或 Twitch 直播链接',
  'Google Meet URL': 'Google Meet 链接',
  'Publishing opens enrollment. Published terms permanently lock when the first entrant enrolls.':
    '发布后即开放报名。第一名报名后，条款永久锁定。',
  'Your proposal stays private until the platform approves it. Changes return it for review. Published terms permanently lock when the first entrant enrolls.':
    '提案在平台通过前只有你能看到。改动后会重新送审。第一名报名后，条款永久锁定。',
  'Save published terms': '保存已发布条款',
  'Save & submit for review': '保存并送审',
  'Publish tournament': '发布赛事',
  'Submit for approval': '提交审核',
  'Cancel editing': '取消编辑',
  'Use HTTPS links without embedded credentials.': '请使用 HTTPS 链接，不要内嵌凭证。',
  'Broadcast links can be updated after entry terms lock. Clear a field to remove its link.':
    '条款锁定后直播链接仍可更新。清空输入框即移除对应链接。',
  'Saving links…': '正在保存链接…',
  'Save broadcast links': '保存直播链接',

  // ── Earnings panel ───────────────────────────────────────────────────────
  'Tournament earnings': '赛事收益',
  'Your entry fees, joining rewards, prizes and recorded settlements in competition chips.':
    '你的报名费、入场奖励、奖金和已记录结算，均为比赛筹码。',
  Refresh: '刷新',
  'Refreshing…': '正在刷新…',
  'Loading tournament earnings…': '正在加载赛事收益…',
  'Competition chips · positive outstanding is due to you; negative is due from you':
    '比赛筹码 · 待付为正表示有人该付给你，为负表示你要付给别人',
  'Settlement net is joining reward + prize − entry fee. Play net measures performance separately. Prizes are final when the tournament ends; recorded payments are platform attestations of manual settlement.':
    '结算净额 = 入场奖励 + 奖金 − 报名费。实战盈亏另行衡量表现。赛事结束，奖金即定；已记录付款是平台对人工结算的存证。',
  'No tournament earnings yet.': '还没有赛事收益。',
  'Your entry accounting appears here after you enroll.': '报名之后，你的报名账目会出现在这里。',
  'Browse tournaments': '浏览赛事',

  // ── Sponsors ─────────────────────────────────────────────────────────────
  // 'Sponsors' itself is defined in dict/admin.ts (赞助商) — shared label, one value.
  'Sponsored · {name}': '内容赞助 · {name}',
  'Opens in a new tab': '在新标签页打开',

  // ── Public watch page ────────────────────────────────────────────────────
  'Connection interrupted. Please try again.': '连接中断了，再试一次。',
  'This tournament is not available for public watching. It may be private or awaiting approval.':
    '这场赛事没有开放公开观战，可能是私有赛事，或尚未通过审核。',
  'This hand is still in progress. Its replay becomes available after it finishes.':
    '这一手还在进行中，结束后才能看回放。',
  'Public updates are temporarily unavailable. We’ll keep trying.':
    '公开更新暂时不可用，我们会继续尝试。',
  'Tournament not found': '找不到这个赛事',
  'Tournament navigation': '赛事导航',
  'Tournament details': '赛事详情',
  'Public watch unavailable': '公开观战不可用',
  'Loading public tournament…': '正在加载公开赛事…',
  'Watch the table, follow the standings, and review every completed hand.':
    '看牌桌、盯排名、回看每一手打完的牌。',
  'Updates interrupted': '更新中断',
  'Updates paused': '更新已暂停',
  'Live · public table': '进行中 · 公开牌桌',
  'Tournament paused': '赛事已暂停',
  'Showing the last update from {time}.': '当前显示的是 {time} 的最后一次更新。',
  'Tournament information': '赛事信息',
  'External links open separately. This page does not control recording in Google Meet.':
    '外部链接会单独打开。本页无法控制 Google Meet 里的录制。',
  'Public view · Live hole cards stay hidden, including your own.':
    '公开视图 · 进行中的底牌始终隐藏，包括你自己的。',
  'Updated {time}': '更新于 {time}',
  'Connecting…': '正在连接…',
  'Competition chips': '比赛筹码',
  'Player {n}': '玩家 {n}',

  // ── Watch page: live table ───────────────────────────────────────────────
  'The table is assembling': '牌桌正在凑人',
  finished: '已结束',
  'Waiting for the table': '等开桌',
  'Scheduled for {date}.': '预计 {date} 开赛。',
  'Play begins when the organizer starts the tournament.': '主办方开赛即开打。',
  '{n} of {m} seats filled.': '{n}/{m} 个席位已入座。',
  'The live board and decisions appear here when play starts.':
    '开赛后，实况牌面和决策会出现在这里。',
  'View rules and enroll': '看规则并报名',
  'This tournament has ended.': '这场赛事已经结束。',
  'The next hand will appear here when it starts.': '下一手开始后会出现这里。',
  Preflop: '翻牌前',
  Flop: '翻牌',
  Turn: '转牌',
  River: '河牌',
  'final board': '最终牌面',
  'Blinds {sb} / {bb}': '盲注 {sb}/{bb}',
  'Hand settled': '本手已结算',
  'Pot {n}': '底池 {n}',
  'Final community cards for completed hand {n}': '第 {n} 手的最终公共牌',
  'Live community cards': '实况公共牌',
  'The hand ended before the flop.': '这手在翻牌前就结束了。',
  'Preflop · Waiting for community cards': '翻牌前 · 等公共牌',
  'Hand finished. Review the disclosed cards and decisions below.':
    '本手结束。下面是已公开的牌和决策。',
  'to act': '行动',
  'Decision {n}': '第 {n} 步决策',
  'due {time}': '截止 {time}',
  'Play is paused.': '比赛已暂停。',
  'The tournament has ended.': '赛事已结束。',
  'Waiting for the next hand.': '等待下一手。',
  'Table seats': '牌桌席位',
  'Final stack': '最终筹码',
  '{n} committed': '已投入 {n}',
  'Live hole cards hidden': '进行中底牌已隐藏',

  // ── Watch page: standings & completed-hand review ────────────────────────
  'Final standings': '最终排名',
  'Tournament standings in competition chips': '赛事排名（比赛筹码）',
  'Place / player': '名次 / 玩家',
  'Out · Hand {n}': '出局 · 第 {n} 手',
  '{hands} hands · {wins} wins': '{hands} 手 · 赢 {wins} 手',
  'No entrants yet. The standings appear as players enroll.':
    '还没有参赛者。随着报名，排名会逐步出现。',
  'Completed-hand review': '完赛手牌回顾',
  'Historical cards and decisions. The live table above stays separate.':
    '这里只看历史牌和决策，上方实况牌桌不受影响。',
  Hand: '手数',
  'The first replay appears after a hand finishes. Live hole cards are never shown here.':
    '打完第一手才会有回放。这里永远不播进行中的底牌。',
  'Follow the latest finished hand': '跟随最新打完的一手',
  'Could not load the hand list.': '手牌列表没加载出来。',
  'Retry replay': '重试回放',
  'Loading completed hand…': '正在加载已完成的手牌…',
  'Hand {n} · Final reveal': '第 {n} 手 · 最终亮牌',
  'These cards are shown after the hand, including disclosed folded hands.':
    '这些牌在本手结束后公开，弃的牌也在内。',
  'Completed hand {n} final board': '第 {n} 手的最终牌面',
  'No community cards were dealt.': '这手没发出公共牌。',
  'Won {n}': '赢得 {n}',
  'Not disclosed': '未公开',
  'Decision replay': '决策回放',
  'Step through recorded actions. The final cards above do not change.':
    '逐条查看记录下的操作。上面的最终牌不变。',
  'Previous step': '上一步',
  'Next step': '下一步',
  'Pause replay': '暂停回放',
  'Play again': '重新播放',
  'Play decisions': '播放决策',
  'Show all': '全部显示',
  'Recorded actions': '已记录的操作',
  'Ready to replay {n} decisions. Select Next or Play decisions.':
    '准备回放 {n} 步决策。点「下一步」或「播放决策」。',
  'Automatic action after timeout': '超时自动操作',
  'No player decisions were recorded for this hand.': '这手没有记录到玩家决策。',

  // ── Watch page: local recording ──────────────────────────────────────────
  // 上限/停止/结束 mirror the /limit|stopped|ended/ sticky-notice test in
  // TournamentWatchPage.tsx — keep in sync when retranslating these.
  'Record a local clip': '录一段本地影像',
  'Choose a surface in your browser’s picker. Only that selection is recorded; the file stays on this device.':
    '在浏览器选择器里选一块画面。只录你选中的内容；文件留在本机。',
  'Include shared tab audio': '包含标签页共享音频',
  'No microphone capture. Up to 20 minutes or 200 MB per clip.':
    '不采集麦克风。每段最长 20 分钟或 200 MB。',
  'Choose the tab, window, or screen to record in the browser picker.':
    '在浏览器选择器里，选要录的标签页、窗口或屏幕。',
  'The selected surface is no longer available. Try recording again.':
    '选中的画面已不可用，再录一次。',
  'The browser exceeded the 200 MB recording limit. This clip could not be saved; try a shorter recording.':
    '超出了 200 MB 的录制上限，这段没保存下来；请录短一点。',
  'Recording stopped near the 200 MB limit. Download your clip below.':
    '快到 200 MB 上限，录制已停止。在下方下载影像。',
  'Recording stopped at the 20-minute limit. Download your clip below.':
    '已到 20 分钟上限，录制已停止。在下方下载影像。',
  'The browser could not finish this recording. Choose a surface and try again.':
    '浏览器没能完成这次录制。重新选画面再试。',
  'No video was captured. Choose a surface and try again.': '没录到任何画面。重新选画面再试。',
  'This browser selected an unsupported video format. Try another browser.':
    '这个浏览器选了不支持的视频格式，换一个浏览器再试。',
  'Your clip is ready. Download it before leaving or starting another recording.':
    '影像已就绪。离开或开录新片段前，先下载。',
  'Screen sharing ended. Download your clip below.': '屏幕共享已结束。在下方下载影像。',
  'Recording the selected tab with its shared audio.': '正在录制所选标签页及其共享声音。',
  'Recording video only. The selected surface did not provide tab audio.':
    '只录制画面。所选画面没有提供标签页声音。',
  'Recording the selected surface without audio.': '正在录制所选画面，不含声音。',
  'Recording stopped. Download your clip below.': '录制已停止。在下方下载影像。',
  'Recording was cancelled or permission was denied. Select Record tab to try again.':
    '录制被取消或未获授权。点「录制标签页」再试。',
  'The browser could not capture that surface. Check screen-recording permissions and try again.':
    '浏览器没能捕捉到那个画面。检查一下屏幕录制权限再试。',
  'Finishing…': '正在收尾…',
  'Stop recording': '停止录制',
  '{n} seconds recorded': '已录制 {n} 秒',
  'Choose a surface…': '选择录制画面…',
  'Record new clip': '录制新片段',
  'Record tab': '录制标签页',
  'Download recording': '下载录像',
  'Tab recording is unavailable in this browser. Open this page in a browser with screen capture support to record a local clip.':
    '这个浏览器不支持标签页录制。想录本地片段，请用支持屏幕捕获的浏览器打开本页。',
};

export default tournaments;
