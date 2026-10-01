// Table page dictionary (pages/table/TablePage.tsx) — glossary per
// docs/zh-i18n.md §2: 牌桌 / 房间码 / 观战 / 账本 / 出牌记录 / 台费 / 买看 /
// 底牌 / 摊牌 / 公共牌 / 作废 / 全下 / 跑两次牌 / N 号位. host → 房主,
// banker → 账房 (never 庄家), the house → 平台.
// Style: 一律「你」, 按钮/徽章不加句号, 状态长句加; ellipsis 用「…」; 品牌
// 「4AM Casino」、房间码、用户名、URL、键名（Esc/WASD）原样透传，绝不进译文.
// Hand-strength wording is produced by shared/i18n/pokerLabels.ts (tScore),
// not by keys here. Persisted server prose (abort reasons) renders through
// tr() with keys in dict/server.ts. Reused keys owned elsewhere: 'Retry' /
// 'Turn timer' / 'No limit' (lobby), 'Try again' (landing), 'Settings'
// (settings), 'The table' (landing), 'Copy' (account).
const tablePage: Record<string, string> = {
  // ── Joining the room / connection states ──────────────────────────────
  'Could not join this table: {error}': '这张桌进不去：{error}',
  'Could not load room': '房间没能加载出来。',
  'Joining table…': '正在进桌…',
  'Back to lobby': '返回大厅',
  'Still connecting. On free hosting the server sleeps when idle and can take up to a minute to wake. Hang tight, or retry.':
    '还在连接。免费托管的服务器闲置时会休眠，唤醒最多要一分钟。等一会儿，或手动重试。',
  'Connection lost. Reconnecting…': '连接已断开，正在重连…',
  'That change did not go through. Try again.': '改动没生效，再试一次。',
  'Could not stand them up': '没能让这名玩家起身离座。',
  'Full screen is unavailable in this browser.': '这个浏览器不支持全屏。',

  // ── Turn / status lines ───────────────────────────────────────────────
  'You are not in this hand. You will be dealt in at the next deal.':
    '这手牌没你的份。下一手会发给你。',
  '{names} lost connection. Holding the hand for them to rejoin…':
    '{names} 掉线了，这手牌先等着他们回来…',
  'Waiting for {name}…': '等 {name} 行动…',
  player: '玩家',
  'Shuffling the encrypted deck…': '正在洗加密牌堆…',
  'You are watching this table.': '你在观战这张桌。',
  "You can see everything public, but not anyone's cards, the join code, or the chips.":
    '公开信息你都能看，但看不到任何人的底牌和房间码，也不会有自己的筹码。',
  'Ask to join the game': '申请上桌',
  'Asked. Waiting for the host to let you in.': '已申请，等房主放行。',
  'Could not ask to join. Try again.': '申请没发出去，再试一次。',

  // ── Seats ─────────────────────────────────────────────────────────────
  'Seat {n}': '{n} 号位',
  'Pick a seat': '挑个位置',
  'Pick a seat.': '先挑个位置。',
  'Pick a seat. Friends join with code {code}': '挑个位置。朋友凭房间码 {code} 加入',
  'Invite a friend to deal.': '邀请朋友来，人齐就发牌。',
  'Ready.': '就绪。',
  "You're in the next hand.": '下一手就有你的牌。',
  'Deal hand': '发牌',

  // ── Peek（买看）───────────────────────────────────────────────────────
  '{name} offers {amount} to privately see the cards you just had.':
    '{name} 出 {amount}，想私下看你刚打完的底牌。',
  'Accept {amount}': '接受 {amount}',
  Decline: '拒绝',
  '{name} had': '{name} 的底牌',
  'only you can see this': '只有你能看到',
  'Pay to peek at': '付费买看',
  'Asked {name}': '已问过 {name}',
  'Peek offer amount': '买看报价金额',
  'chips, paid only if they agree to show you': '筹码，对方同意亮牌才支付',

  // ── Result headlines（牌力措辞由 pokerLabels.tScore 产出）─────────────
  '{name} takes the pot. Everyone else folded, so no cards had to be shown.':
    '{name} 拿下底池。其余人全弃牌，不用亮牌。',
  'They ran it twice - {name} took both boards.': '跑两次牌——{name} 两跑全赢。',
  'They ran it twice. {w1} takes run 1, {w2} takes run 2.':
    '跑两次牌。第 1 跑 {w1} 赢，第 2 跑 {w2} 赢。',
  'Split pot: {names} tie with {hand}.': '平分底池：{names} 同为{hand}。',
  ' and ': ' 和 ',
  "{name} wins with {hand} against {other}'s {theirHand}.":
    '{name} 以 {hand} 赢了 {other} 的 {theirHand}。',
  '{name} wins with {hand}.': '{name} 以 {hand} 拿下底池。',

  // ── Result banner ─────────────────────────────────────────────────────
  'Hand aborted:': '本手作废：',
  // Keys keep the original `. ` lead-in so the English fallback still reads
  // right; the zh value joins onto the abort reason, which already ends in 。.
  '. {name} did not come back in time; all bets were returned.':
    '{name} 超时未归，全部注金已退回。',
  '. Seat {n}; stacks rolled back.': '{n} 号位未归；筹码已回滚。',
  'The winning five': '致胜五张',
  'Winning five': '致胜五张',
  Table: '牌桌',
  Showdown: '摊牌',
  'Everyone folded': '全员弃牌',
  '{rate} table commission · {amount} to the house': '{rate} 台费 · {amount} 归平台',
  '{rate} commission · {amount} to the house': '{rate} 台费 · {amount} 归平台',
  Share: '分享',
  'Dismiss result': '关闭结果',
  'Dismiss result (Esc)': '关闭结果（Esc）',
  'Hand result': '本手结果',
  'Run 1': '第 1 跑',
  'Run 2': '第 2 跑',

  // ── Table menu（分组 / 条目）──────────────────────────────────────────
  People: '人员',
  Records: '记录',
  Preferences: '偏好',
  'Auto-deal': '自动发牌',
  On: '已开启',
  Off: '已关闭',
  'Invite friends': '邀请朋友',
  code: '房间码',
  'Watch-only link': '观战链接',
  'Watch-only share link': '观战分享链接',
  'Open video call': '打开视频通话',
  'Join the video call': '进入视频通话',
  Standings: '排名',
  Ledger: '账本',
  'Hand history': '出牌记录',
  Hands: '牌局记录',
  'Sit out next hand': '下一手休息',
  'Sit out next hands': '接下来几手休息',
  'Deal me back in': '继续发牌',
  '(next hand)': '（下一手起）',
  'Applies from the next hand': '下一手起生效',
  '{n}s': '{n} 秒',
  '(opens in a new tab)': '（在新标签页打开）',

  // ── Dialogs ───────────────────────────────────────────────────────────
  'Invite friends to this table': '邀请朋友来这张桌',
  'Or invite a friend directly': '也可以直接邀请好友',
  'Let anyone with the link watch this table. Viewers see the public game only: no hole cards, no join code, no chips of their own.':
    '拿到链接的人都能观战这张桌。观战者只看得到公开牌局：没有底牌，没有房间码，也不会有自己的筹码。',
  'Watchers asking to play': '想上桌的观战者',
  'Let them in': '让 TA 上桌',
  No: '拒绝',
  'Room standings': '房间排名',
  'Counting the chips…': '正在数筹码…',
  'Counting chips…': '正在数筹码…',
  'No completed hands yet. Deal one and check back.': '还没有打完的手牌。开一手再回来看。',

  // ── Run-it-twice prompt ───────────────────────────────────────────────
  '🔁 Run it twice? · {n}s': '🔁 跑两次？· {n} 秒',
  'Twice 🔁': '跑两次 🔁',
  Once: '跑一遍',
  'Everyone is all-in - the rest of the board deals twice if all agree.':
    '所有人都已全下——如果都同意，剩余公共牌发两遍。',

  // ── Header / chrome（aria-label 与 title 同源）────────────────────────
  'Leave table': '离开牌桌',
  'Table menu': '牌桌菜单',
  // 手机 ⋮ 菜单里的视图组（3D / 全屏收进来，见 table-redesign-spec A1）
  View: '视图',
  'Not available': '不可用',
  'Open chat': '打开聊天',
  'Table chat': '牌桌聊天',
  'Close chat': '关闭聊天',
  Close: '关闭',
  'Toggle chat': '打开或关闭聊天',
  'Toggle chat, {n} unread messages': '打开或关闭聊天，{n} 条未读',
  '3D table': '3D 牌桌',
  'Full screen': '全屏',
  'Exit full screen': '退出全屏',
  'Table controls': '牌桌控制',
  'More table controls': '更多牌桌控制',
  'Close table controls': '关闭牌桌控制',
  'Join voice': '加入语音',
  'Mute voice': '关闭麦克风',
  'Unmute voice': '开启麦克风',
  'Join voice chat': '加入语音聊天',
  Mute: '静音',
  Unmute: '取消静音',
  'Poker board': '扑克桌面',
  POT: '底池',
  'Empty community card {n}': '空的公共牌位（第 {n} 张）',
  'Empty run 2 card {n}': '第 2 跑的空牌位（第 {n} 张）',
  'blinds {sb}/{bb}': '盲注 {sb}/{bb}',
  "Copy or share this table's invite link": '复制或分享这张桌的邀请链接',
  'Seated players / in this hand': '已入座玩家 / 参与本手',
  '{n} in hand': '{n} 人在局中',
  'strict audit': '严格审计',
  'void table': '作废牌桌',
  'The banker voided this table: results do not count anywhere':
    '账房把这张桌作废了：输赢在哪都不算数',
};

export default tablePage;
