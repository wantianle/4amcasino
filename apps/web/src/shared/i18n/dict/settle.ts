// SettlePage (结账). Fragments like 'Settle up', 'owes you', 'You owe',
// 'you owe', 'Mark settled', 'Amount', 'You' resolve through dict/player.ts
// and dict/table.ts (one merged dictionary - no redefinition here).
const settle: Record<string, string> = {
  'Working out who owes whom…': '正在算谁欠谁…',
  'Platform commission due from users, with recorded payments and room details.':
    '平台向用户收取的台费欠款，含已记录的付款和各房间的明细。',
  'Every room you have played, netted down to one number per person.':
    '你打过的每个房间，按人合并成一个数。',

  // ── Balance tiles ───────────────────────────────────────────────────────
  'Players owe you': '别人欠你',
  'You owe players': '你欠别人',
  'Player balance': '玩家余额',

  // ── Redirects ───────────────────────────────────────────────────────────
  'Close two debts with one payment': '一笔付款，结两头的债',
  'Money owed to you can go straight to someone you owe — it never has to pass through your hands. Send them this and both debts clear at once.':
    '别人欠你的钱，可以直接转给你欠的人，不用过你的手。把这条发给双方，两笔债一次结清。',
  pays: '付给',
  // NOTE: 'Copy' is defined in dict/account.ts as 「复制」.
  '{payer} → {payee}: {amount} (settling up through me on 4AM Casino)':
    '{payer} → {payee}：{amount}（4AM Casino 居中结账）',

  // ── Platform dues ───────────────────────────────────────────────────────
  'Your platform dues': '你的平台欠款',
  'Your share of the platform commission deducted from pots you won. New rooms charge {rate}. Each hand uses its room’s rate when dealt. This total reflects the actual deductions.':
    '你赢下的底池里扣掉的那份平台台费就是你要付的。新房间按 {rate} 收取，每手牌发牌时按当时房间的费率。这个总数是实际扣下来的。',
  'the current platform rate': '平台当前费率',
  Outstanding: '待付',
  '{accrued} accrued · {paid} recorded payments': '{accrued} 已计 · {paid} 已记录',
  'Commission by room': '按房间的台费',
  'Recorded credit: {credit}': '已记录的余额：{credit}',
  'Record a payment': '记录一笔付款',

  // ── Per person ──────────────────────────────────────────────────────────
  'Per person': '按人',
  'No outstanding payments between players. Your platform dues are shown above.':
    '玩家之间没有未结的款项。平台欠款见上方。',
  'across {n} rooms': '跨 {n} 个房间',
  'Hide the rooms behind this': '收起背后的房间',
  'Show the rooms behind this': '展开背后的房间',

  // ── Settle dialog (name/amount keep their <span> styling via fragments;
  // 'owes you' / 'You owe' come from dict/player.ts) ──────────────────────
  'Settle with {name}': '和 {name} 结账',
  // key is the JSX text node that trails the amount span (period rides along)
  '. Both of you have to confirm before it clears on the platform.':
    '。两人都确认后，平台这边才会清账。',
  'paid on UPI, 9:40pm': 'UPI 转的，21:40',
  'Settled — both of you have confirmed.': '已结清——双方都确认了。',
  'Marked. It clears once {name} confirms too.': '已标记。{name} 确认后就会清账。',
  'could not mark it': '没能标记。',
  'could not load': '没能加载。',
  'Recording…': '记录中…',

  // ── Proof fields (shared by both dialogs) ───────────────────────────────
  Remark: '备注',
  'Photo of the transfer (optional)': '转账照片（可选）',

  // ── House payment dialog ────────────────────────────────────────────────
  'Record a payment to the house': '记录一笔付给平台的钱',
  'This keeps 4AM Casino online. Record what you sent and it comes off your outstanding balance.':
    '这是维持 4AM Casino 在线的成本。记下你转过的钱，会从待付余额里扣掉。',
  'UPI to notpritam@…': 'UPI 转给 notpritam@…',
  'Record payment': '记录付款',
  'could not record it': '没能记录。',
};

export default settle;
