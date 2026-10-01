// PlayerPage (个人主页): identity rail, best-hand snapshot, settle-up panel,
// player actions (friend + points transfer), the history rail, and the
// server-provided play-style prose (archetype badges, hand outcomes) rendered
// via tr(). Hand-strength labels do NOT live here: they are re-derived
// client-side from the score via tScore() (shared/i18n/pokerLabels.ts).
// Shared keys reused: '← Back to table', 'hand {id}', 'voided', filter words
// all/won/lost/folded (dict/hands.ts), 'Amount', 'You' (dict/table.ts),
// 'Send {n}' (dict/bank.ts), 'Copy' (dict/account.ts), 'Hands', 'Hand history',
// 'Full replay →', 'Seat {n}' (dict/table-page.ts / table.ts), 'Loading hands…'
// (dict/hands.ts), 'Net'/'When'/etc. (dict/ledger.ts).
const player: Record<string, string> = {
  // ── Header / identity ───────────────────────────────────────────────────
  'Loading player…': '正在加载玩家资料…',
  'joined {date}': '{date}加入',
  House: '平台',
  '#{rank} on the leaderboard': '排行榜第 {rank} 位',
  'The {n} account ever created on 4AM Casino': '4AM Casino 历史上第 {n} 个创建的账号。',
  'member #{n}': '第 {n} 位成员',
  'member #{n} of {total}': '第 {n} 位成员 · 共 {total} 人',

  // ── Stat rows ───────────────────────────────────────────────────────────
  'Net points': '净点数',
  'Hands played': '已玩手数',
  'Biggest win': '最大赢入',
  'Platform due': '平台欠款',
  'View platform dues in Settle up': '在结账页查看平台欠款',

  // ── Best hand card ──────────────────────────────────────────────────────
  'Best hand': '最佳一手',
  'Hide this from your profile': '在个人资料页隐藏它',
  'Your best hand is hidden from your profile. Show it?': '最佳一手没显示在你的资料页，要显示吗？',
  'Watch the replay →': '看回放 →',
  'won with {hand}': '赢下这手：{hand}',

  // ── History rail (fragments keep the <b> name/markup in the page) ──────
  'You made': '你拿到',
  against: '对战',
  '(voided)': '（作废）',
  board: '公共牌',
  'Money moves': '资金流水',
  'No hands on record yet.': '你的牌局记录还是空的。',
  'Nothing yet.': '还没有记录。',

  // ── Settle up panel ─────────────────────────────────────────────────────
  'Settle up': '结账',
  'By player': '按人',
  'By room': '按房间',
  'Square the debt outside the app, then both of you mark it settled and it clears here too.':
    '线下把钱结清，然后你俩都标记一下，这边的账也就清了。',
  'owes you': '欠你',
  'You owe': '你欠',
  'you owe': '你欠',
  'they owe': '对方欠',
  '{n} rooms': '{n} 个房间',
  'they marked it settled - confirm?': '对方已标记结清，要确认吗？',
  'waiting for {name} to confirm': '等 {name} 确认',
  '✓ marked': '✓ 已标记',
  'Mark settled': '标记结清',
  '{n} debts': '{n} 笔欠款',
  'You paid {name}': '你付给 {name}',
  '{name} paid you': '{name} 付给你',

  // ── Player actions (friend + transfer) ──────────────────────────────────
  'Friends ✓': '已是好友 ✓',
  'Request sent': '申请已发出',
  'Add friend': '加好友',
  'Send points': '转点数',
  'Send points to {name}': '给 {name} 转点数',
  'From your stack in': '用哪个房间的余额转出',
  'you have {n}': '余额 {n}',
  points: '点数',
  'A hand is running at that table - sends land between hands.':
    '那张桌正打着手牌，转账会在两手之间到账。',
  'could not send': '没发出去。',

  // ── Platform account profile ────────────────────────────────────────────
  "The table's bank": '牌桌的银行',
  'This is the platform account that receives table commission. Its owner can review amounts due from each user in Admin, on this profile, and in Settle up.':
    '这是收台费的平台账号。它的管理员可以在后台、这个主页和结账页查看每个用户的欠款。',

  // ── Play style (archetype prose from the server, via tr) ────────────────
  'Play style': '打法风格',
  'from {n} public hand transcripts': '来自 {n} 份公开出牌记录',
  'The shark': '鲨鱼',
  'The calling station': '跟注站',
  'The maniac': '疯子',
  'The rock': '岩石',
  Balanced: '攻守均衡',
  'Too early to tell': '还看不出来',
  'Plays {vpip}% of hands, raises first in {pfr}%.': '参与 {vpip}% 的手牌，{pfr}% 先加注。',
  'Aggression factor {af} (bets and raises per call).': '攻击系数 {af}（每次跟注对应的下注加注数）。',
  'Reaches showdown in {sd}% of hands and wins {win}%.': '{sd}% 的手牌打到摊牌，其中赢下 {win}%。',
  '{quiet}% of wins never showed a card.': '{quiet}% 的赢牌从没摊过牌。',

  // ── Rivals ──────────────────────────────────────────────────────────────
  Rivals: '老对手',
  'No shared hands yet.': '还没交过手。',
  'top rival': '头号对手',
  '{n} hands together': '交手 {n} 手',
  '{n} vs them': '对其净胜 {n}',
};

export default player;
