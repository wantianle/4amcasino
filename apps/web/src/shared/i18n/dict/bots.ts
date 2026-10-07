// Table bots dictionary (features/bots/* + the seat badge/pill in RoundTable +
// the host entry chips). Glossary per docs/zh-i18n.md §2: bot → 机器人,
// room → 房间, table → 牌桌, seat → 号位 (server.ts), buy-in → 买入,
// banker → 账房, chips → 筹码. Play styles use the standard CJK poker terms
// 紧凶/松凶/紧弱/松弱. Reused, NOT redefined here: 'Seat {n}' / 'Retry' /
// 'Cancel' / 'Send' / 'Delete' / 'Settings' and the pod copy (table.ts),
// 'Chip leader' / 'Ready'-adjacent pills; every server-provided error
// ('that seat is taken', 'BOT_IDENTITY_KEY is not configured…', …) lives in
// dict/server.ts and reaches the UI through tr() inside ApiError.
const bots: Record<string, string> = {
  // ── entry points ──────────────────────────────────────────────────────────
  Bot: '机器人',
  Bots: '机器人',
  'Bot opponents': '机器人对手',
  'Bot opponents - {n} at the table': '机器人对手 · 桌上 {n} 个',
  'Bot - {status}': '机器人 · {status}',
  'Bot opponent - {status}': '机器人对手 · {status}',
  '{n} seated': '已入座 {n} 个',

  // ── dialog frame ──────────────────────────────────────────────────────────
  'Seat a bot opponent when the table is one short. Bots buy in like any player and play on their own clock.':
    '三缺一时，用机器人补个位。机器人和真人一样买入，按自己的节奏打牌。',
  'Loading bots…': '正在加载机器人…',
  'No bots yet. Seat one below and it takes the next free chair.':
    '桌上还没有机器人。在下面放一个，它会坐到下一个空位上。',
  'Bots at this table': '桌边的机器人',
  'Seat a new bot': '添加机器人',

  // ── lifecycle status prose (server botRoutes.ts state machine) ───────────
  'Just created': '刚创建',
  'Waiting for buy-in approval': '等买入审批',
  Ready: '已就绪',
  'Starting up': '正在上场',
  Playing: '牌局中',
  'Finishing the hand': '收尾这手牌',
  Stopped: '已停止',
  'Hit an error': '出了点问题',
  Removed: '已移除',
  'Between hands': '还没坐定',

  // ── per-bot actions ───────────────────────────────────────────────────────
  Start: '开始',
  Stop: '停止',
  'Add chips': '补码',
  'Current stack': '当前筹码',
  'Add chips for this bot': '给这个机器人补码',
  // the server's remove route is a hard delete, so the copy says 删除, not 移除
  'Delete this bot': '永久删除这个机器人',
  'Delete for good?': '确认永久删除？',
  'Chips to add for {name}': '给 {name} 补多少筹码',
  amount: '数量',
  'Goes through the banker queue, same as a player.': '和真人一样走账房的审批队列。',

  // ── result + error prose ──────────────────────────────────────────────────
  '{name} is in and taking its seat at seat {seat}.': '{name} 已上场，坐上 {seat} 号位。',
  '{name} is seated - the buy-in waits for the banker. Press Start once it clears.':
    '{name} 已入座——买入还在账房排队。批下来后点「开始」。',
  '{name} leaves the table.': '{name} 离开了牌桌。',
  'Stopping - it finishes the hand it is in, then leaves.': '正在停止——它会打完手里这手牌再离桌。',
  'Chips on the way - the buy was approved.': '筹码在路上——买入已批准。',
  'The buy-in waits for the banker.': '这笔买入在等账房审批。',
  'That did not go through. Try again.': '操作没走通，再试一次。',
  'The bot service is not available right now - try again in a moment.':
    '机器人服务现在不可用——过一会儿再试。',

  // ── create form ───────────────────────────────────────────────────────────
  Seat: '座位',
  'Seat {n} - taken': '{n} 号位 · 已占',
  'Play style': '打法风格',
  Difficulty: '难度',
  Basic: '基础',
  Advanced: '进阶',
  'Uses the existing local rules.': '使用现有本地规则。',
  'Uses rules-v1 with modern preflop ranges and postflop heuristics.':
    '使用 rules-v1：现代翻前范围与翻后启发式。',
  'Large language models are not affected by difficulty.': '大模型不受难度影响。',
  'Buy-in': '买入',
  'Custom buy-in in chips': '自定买入额（筹码）',
  'Name (optional)': '名字（可选）',
  'e.g. River Bot': '比如：大河机器人',
  'Seat & start': '入座并开局',
  'Seating…': '正在入座…',
  'Buys in for {n} chips ({bb} BB).': '买入 {n} 筹码（{bb} 倍大盲）。',
  'Enter a whole number of chips.': '请输入整数筹码数。',
  'Up to 6 players including bots - {left} more can join.':
    '每桌最多 6 人（含机器人）· 还能加入 {left} 个。',
  'This table is full (6 players, bots included) - remove a bot or have a player stand up first.':
    '这张桌已坐满 6 人（含机器人）· 先删掉一个机器人，或让真人先离座。',
  'All nine seats are taken - stop and remove a bot to free one up.':
    '九个座位都坐满了——先停止并移除一个机器人腾个位。',

  // ── play styles ───────────────────────────────────────────────────────────
  'Tight-aggressive': '紧凶',
  'Loose-aggressive': '松凶',
  'Calling station': '跟注站',
  'Constrained random': '约束随机',
  'Large language model': '大模型',
  'Solid preflop ranges, strong when it has a hand.': '翻前范围扎实，成牌就下重手。',
  'Applies pressure with a wide range.': '用宽范围持续施压。',
  'Calls often, raises rarely.': '经常跟注，很少加注。',
  'Makes varied choices while staying within legal moves.': '在合法操作范围内灵活出牌。',
  'Decides step by step; slower, needs a server key. Short action timers use local play, without a model request.':
    '由大模型逐步决策，速度较慢；行动时限过短的房间会自动改用本地策略，不请求大模型。',
  'Coming soon': '敬请期待',
  Soon: '未上线',
};

export default bots;
