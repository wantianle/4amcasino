// Bank dictionary (widgets/table/BankControls.tsx chips menu & dialogs,
// features/bank/BrokeBuyInDialog.tsx).
// Keys are the exact English source strings (B+ scheme, docs/zh-i18n.md §6.2).
// buy-in / buy points → 买入 / 买点数 (play-money, never 充值);
// banker → 账房 (never 庄家); settle up → 结账; viewer → 观战.
// Keys already defined elsewhere and NOT repeated here: None / Volume
// (dict/settings.ts), Amount / Send / Sending… (resolved via dict/table.ts
// and dict/settings.ts).
const bank: Record<string, string> = {
  // ── Chips menu (BankControls) ────────────────────────────────────────────
  Chips: '筹码',
  'Close chips menu': '关闭筹码菜单',
  'Chip controls': '筹码操作',
  'Buy points': '买点数',
  'Send chips': '转筹码',
  'Bank inbox': '账房收件箱',

  // ── Buy points dialog ────────────────────────────────────────────────────
  'Buy points from the bank': '向银行买点数',
  'Approved. The points are already in your stack.': '已批准，点数已进你的筹码。',
  'Request sent. The banker will review it.': '申请已发出，等账房过目。',
  'Points are play money. Every purchase is written to the room ledger so the group can settle up later.':
    '点数只是娱乐筹码。每笔买入都记进房间账本，方便大家之后结账。',
  'This table auto-approves buys, so they land instantly.': '这张桌自动批准买入，即时到账。',
  'Note (optional)': '备注（可选）',
  'paid via UPI': '通过 UPI 付的',
  'Requesting…': '正在提交…',
  'Request {n} points': '申请买入 {n}',
  'buy failed': '买入没成功。',

  // ── Send chips dialog ────────────────────────────────────────────────────
  'Send chips to a player': '转筹码给玩家',
  'Lend a short-stacked friend some chips or settle a side bet. Every transfer is written to the room ledger. Chips move between hands only.':
    '给筹码见底的朋友接济一把，或者结一笔桌外的账。每笔转账都记进房间账本。筹码只能在两手牌之间移动。',
  To: '给',
  'Pick a player': '选一名玩家',
  'loan until next buy-in': '先借着，下次买入前还',
  'Send {n}': '送出 {n}',
  'Sent. It is on the ledger.': '已转出，账本上有记录。',
  'transfer failed': '转账没成功。',

  // ── Bank inbox dialog ────────────────────────────────────────────────────
  'Pending purchases': '待批准的买入',
  'Auto-approve buys: credit every purchase request instantly, in your name, instead of waiting for you to review it. Everything still lands on the ledger and stays revertable.':
    '自动批准买入：每笔买入请求不经你过目，立刻以你的名义到账。一切照常进账本，也照样可以撤销。',
  "TV replays: after every hand each player's hand key is saved, so replays show ALL hole cards - broadcast style, ready to cut a video from. Folded cards stop being secret from this table's replays.":
    '电视回放：每手结束后都会保存所有玩家的底牌密钥，回放会亮出全部底牌——像直播一样，拿来就能剪视频。在这张桌的回放里，弃牌不再是秘密。',
  'Hands required before winnings count (0–30; 0 = everyone counts)':
    '输赢计入前需完成的手数（0–30；0 = 全部计入）',
  'Could not update the hand requirement.': '手数设置没更新成功。',
  '7-2 offsuit bounty per player (0 = off). Winning with 7-2 offsuit collects this from everyone; fold-winners claim it by showing their cards.':
    '每个玩家的 7-2 彩头（0 = 关闭）。用 7-2 不同花获胜，可从所有人那里收下这笔彩头；靠别人弃牌赢下的，要亮牌才能领。',
  'Backup banker (same powers, so the bank keeps working when you are away)':
    '副账房（权限相同，你不在时账房照常运转）',
  'Nothing waiting for approval.': '没有等审批的申请。',
  Reject: '驳回',
  Approve: '批准',
  "Approved points land on the player's stack between hands": '批准的点数会在两手牌之间转入玩家筹码。',
  'approval failed': '审批没成功。',
  'update failed': '更新没成功。',

  // ── Broke buy-in dialog (features/bank) ──────────────────────────────────
  'You are out of chips': '你的筹码打光了',
  '{n} points are awaiting approval.': '{n} 点数正在等审批。',
  'Buy-in request sent.': '买入申请已发出。',
  'As soon as the banker approves it, the points land on your stack and you are back in the next hand.':
    '账房一批准，点数立刻进你的筹码，下一手牌你就归队。',
  'Got it': '知道了',
  'Your stack is empty, so the next hands will deal around you. Buy more points from the bank, or stand up and watch.':
    '你的筹码见底了，接下来几手牌会绕开你发。可以向银行再买点数，或者起身去观战。',
  'Buy-in amount': '买入金额',
  'Watch as a viewer': '起身观战',
  'buy request failed': '买入申请没发出去。',
};

export default bank;
