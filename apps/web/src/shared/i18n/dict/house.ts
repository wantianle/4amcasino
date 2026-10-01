// House dictionary (features/house/PlatformDues: platform receivables view
// shared by Admin, the house profile and Settle up). Glossary: the house →
// 平台 (never 庄家/赌场), house cut / commission → 台费, settle up → 结账.
// Usernames and IDs pass through as vars untranslated; amounts come in
// already formatted via fmt(). Error prose from the server goes through tr()
// and matches dict/server.ts.
// Reused, NOT redefined: 'Retry' (lobby) is not used here — this panel offers
// 'Use Refresh dues to try again.' instead. 'Platform due' (player) is the
// singular badge on profiles; the plural section title is defined below.
const house: Record<string, string> = {
  // Head
  'Platform dues': '平台欠款',
  'Who needs to pay the house, across active rooms.':
    '在各活跃房间里，谁还欠着平台台费。',
  'Could not load platform dues.': '没能加载平台欠款。',
  'Loading platform dues…': '正在加载平台欠款…',
  'Refresh dues': '刷新欠款',
  'Refreshing…': '正在刷新…',
  'The amounts below are from the last successful refresh.':
    '下面的金额来自上一次成功刷新的结果。',
  'Use Refresh dues to try again.': '点「刷新欠款」再试一次。',

  // Stat tiles. NOTE: 'Outstanding' is already '待付' in dict/settle.ts
  // (later in merge order, wins globally) — prose below uses the same term.
  'Users owing': '欠款用户',
  'Commission accrued': '累计台费',
  'Payments recorded': '已记付款',

  // Explainer and warnings
  'Outstanding is commission minus payments recorded by each user. Payment records are self-reported; they are not bank confirmations.':
    '待付 = 累计台费减去该用户已记录的付款。付款记录由本人自报，不是银行确认。',
  'Recorded credit: {n}.': '已记信用额：{n}。',
  '{n} in commission has no recorded winner to assign it to. It is excluded from user dues.':
    '有 {n} 台费找不到可归属的赢家，未计入用户欠款。',

  // Filter row
  'Find a user with platform dues': '查找有平台欠款的用户',
  'Search name, username or ID': '搜索昵称、用户名或 ID',
  'Show cleared users': '显示已结清的用户',
  '{n} users shown': '显示 {n} 位用户',

  // Empty states
  'No matching users. Try another name or include cleared users.':
    '没有匹配的用户。换个名字搜搜，或勾选已结清的用户。',
  'No outstanding platform dues. Include cleared users to see previous charges and payments.':
    '没有待付的平台欠款。勾选已结清的用户，可查看此前的台费和付款。',
  'No platform dues recorded yet. Commission from completed hands will appear here.':
    '还没有平台欠款记录。完成手牌抽出的台费会出现在这里。',

  // Person rows
  'Dues for {name}': '{name} 的欠款',
  'To pay': '待付',
  Cleared: '已结清',
  'Accrued: {accrued} · Payments recorded: {paid}': '累计台费 {accrued} · 已记付款 {paid}',
  '{n} credit': '信用额 {n}',
  'Commission by room ({n})': '各房间台费（{n}）',
};

export default house;
