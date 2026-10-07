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
  'The {n} account ever created on 4AM Casino': '4AM Casino 第 {n} 个账号。',
  'member #{n}': '第 {n} 位成员',
  'member #{n} of {total}': '第 {n} 位成员 · 共 {total} 人',

  // ── Stat rows ───────────────────────────────────────────────────────────
  'Net points': '净点数',
  'Hands played': '已玩手数',
  'Biggest win': '最大赢额',
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
  'No hands on record yet.': '还没有牌局记录。',
  'Nothing yet.': '还没有记录。',

  // ── Settle up panel ─────────────────────────────────────────────────────
  'Settle up': '结账',
  'By player': '按人',
  'By room': '按房间',
  'Square the debt outside the app, then both of you mark it settled and it clears here too.':
    '先在线下结清，再由你们双方标记已结清；平台这边也会同步清账。',
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
  'Detailed hand statistics': '完整手牌统计',
  'Public hand transcripts, position splits, and postflop detail.': '公开手牌记录、位置拆分与翻后细节。',
  'Could not load player profile.': '无法加载玩家资料。',
  'Could not load player statistics.': '无法加载玩家统计。',
  'This player could not be found.': '找不到这位玩家。',
  'Loading statistics…': '正在加载统计…',
  'This player has not made detailed statistics public.': '该玩家未公开完整统计。',
  'There is not enough public hand data yet.': '目前还没有足够的公开手牌数据。',
  '{n} public hands · {exact} exact': '{n} 手牌 · {exact} 手牌为精确记录',
  'By position': '按位置',
  'By street': '按街道',
  'Position in the hand': '手牌位置',
  Trend: '趋势',
  Notes: '说明',
  AF: '激进度',
  AFq: '激进频率',
  'No trend data yet.': '暂时没有趋势数据。',
  '{n} hands': '{n} 手',
  'from {n} public hand transcripts': '来自 {n} 份公开出牌记录',
  'The shark': '鲨鱼',
  'The calling station': '跟注站',
  'The maniac': '疯子',
  'The rock': '岩石',
  Balanced: '攻守均衡',
  'Too early to tell': '还看不出来',
  'Plays {vpip}% of hands, raises first in {pfr}%.': '{vpip}% 的手牌主动入池，{pfr}% 的手牌率先加注。',
  'Aggression factor {af} (bets and raises per call).': '激进度 {af}（每次跟注对应的下注或加注次数）。',
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
