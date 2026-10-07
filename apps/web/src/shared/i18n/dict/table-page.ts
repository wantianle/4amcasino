// Table page dictionary (pages/table/TablePage.tsx) — glossary per
// docs/zh-i18n.md §2: 牌桌 / 房间码 / 观战 / 账本 / 出牌记录 / 台费 / 买看 /
// 底牌 / 摊牌 / 公共牌 / 作废 / 全下 / 跑两次牌 / N 号位. host → 房主,
// banker → 账房 (never 庄家), the house → 平台.
// Style: 一律「你」, 按钮/徽章不加句号, 状态长句加; ellipsis 用「…」; 品牌
// 「4AM Casino」、房间码、用户名、URL、键名（如 Esc）原样透传，绝不进译文.
// Hand-strength wording is produced by shared/i18n/pokerLabels.ts (tScore),
// not by keys here. Persisted server prose (abort reasons) renders through
// tr() with keys in dict/server.ts. Reused keys owned elsewhere: 'Retry' /
// 'Turn timer' / 'No limit' (lobby), 'Try again' (landing), 'Settings'
// (settings), 'The table' (landing), 'Copy' (account).
const tablePage: Record<string, string> = {
  'Peek results': '买看结果',
  '{n} people want to peek at your cards': '{n} 人想看你的牌',
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

  // ── Closing / archiving the room ──────────────────────────────────────
  'Close and archive': '关闭并归档',
  'Closing and archiving…': '正在关闭并归档…',
  'Close and archive this room?': '关闭并归档这张桌？',
  'Closing archives this table and stands everyone up. It disappears from the lobby, the sidebar and the public list, and no further hands are dealt - but nothing is deleted. The ledger and every hand stay readable, and anything still owed is still owed.':
    '关闭会归档这张桌，并让所有人起身离座。它会从大厅、侧栏和公开列表中消失，也不再发牌——但不会删除任何数据。账本和每一手牌记录都仍可查看，欠账也仍然有效。',
  'Close and archive (nothing is deleted)': '关闭并归档（不删除任何数据）',
  'This room was closed and archived': '房主已关闭并归档本房间',
  'The host closed and archived this table. Nothing was deleted - you can still read its hands and ledger from History.':
    '房主已关闭并归档这张桌。没有删除任何数据——你仍可在「历史」中查看它的出牌记录和账本。',
  'This hand finishes first, then the room archives. Keep playing - nothing is deleted.':
    '本手打完后才会归档房间，请继续操作——不会删除任何数据。',
  'The host closed this table. This hand finishes first, then you can leave - nothing is deleted.':
    '房主已关闭这张桌。本手打完后即可离开——不会删除任何数据。',
  'This hand finishes first, then you can leave. Keep playing - nothing is deleted.':
    '本手打完后才能离开，请继续操作——不会删除任何数据。',

  // ── Turn / status lines ───────────────────────────────────────────────
  'Waiting for {name}…': '等 {name} 行动…',
  player: '玩家',
  'You are watching this table.': '你在观战这张桌。',
  "You can see everything public, but not anyone's cards, the join code, or the chips.":
    '公开信息你都能看，但看不到任何人的底牌和房间码，也不会有自己的筹码。',
  'Ask to join the game': '申请上桌',
  'Asked. Waiting for the host to let you in.': '已申请，等房主放行。',
  'Could not ask to join. Try again.': '申请没发出去，再试一次。',

  // ── Seats ─────────────────────────────────────────────────────────────
  'Seat {n}': '{n} 号位',
  'Pick a seat': '挑个位置',
  'Invite a friend to deal.': '邀请朋友来，人齐就发牌。',
  'Ready.': '就绪。',
  "You're in the next hand.": '下一手就有你的牌。',
  'Deal hand': '发牌',
  'Next hand in {n}s': '{n} 秒后开下一手',

  // ── Peek（买看）───────────────────────────────────────────────────────
  '{name} offers {amount} to privately see the cards you just had.':
    '{name} 出 {amount}，想私下看你刚打完的底牌。',
  'Accept {amount}': '接受 {amount}',
  Decline: '拒绝',
  '{name} had': '{name} 的底牌',
  'only you can see this': '只有你能看到',
  'Asked {name}': '已问过 {name}',
  'Peek at {name}': '看 {name} 的牌',
  '1 BB, paid only if they agree to show you': '1 BB，对方同意亮牌才支付',
  'Your peek offer expired.': '你的买看已过期。',
  'Your peek offer failed.': '你的买看没成功。',

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
  // Abort reasons are server prose (dict/server.ts) rendered through tr();
  // this banner only supplies the fixed lead-in above.
  Table: '牌桌',
  Showdown: '摊牌',
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
  Standings: '排名',
  Ledger: '账本',
  'Hand history': '出牌记录',
  Hands: '牌局记录',
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
  'No completed hands yet. Deal one and check back.': '还没有打完的手牌。开一手再回来看。',

  // ── Run-it-twice prompt ───────────────────────────────────────────────
  '🔁 Run it twice? · {n}s': '🔁 跑两次？· {n} 秒',
  'Twice 🔁': '跑两次 🔁',
  Once: '跑一遍',
  'Everyone is all-in - the rest of the board deals twice if all agree.':
    '所有人都已全下——如果都同意，剩余公共牌发两遍。',

  // ── P2 B4 全下多次发牌（staged prompt, docs/p2-gameplay-design.md）─────
  // Glossary: 落后方 / 领先方 / 全下多次发牌. Buttons carry no variable the
  // English source lacks; countdown reuses '{n}s' above.
  '🔁 Run it how many times?': '🔁 发几次牌？',
  'Multi-run all-in decision': '全下多次发牌',
  'You are behind': '你暂时落后',
  'Equity {pct}%': '胜率 {pct}%',
  'Deal {n} times': '发 {n} 次',
  'Waiting for the ahead player to confirm…': '等领先方确认…',
  'The behind player is choosing how many times to run the board…':
    '落后方正在选择发牌次数…',
  'They asked to run it {n} times': '对方想发 {n} 次',
  Agree: '同意',
  'Just once': '只发 1 次',
  'Only the losing side chooses; dealing more than once needs the other side to agree.':
    '由落后方选次数，领先方同意才会多发。',
  'Declining or running out of time means one run.': '不同意或超时，就只发 1 次。',
  'Dealing {n} runs': '已同意，本手发 {n} 次',
  'The ahead player declined - dealt once.': '领先方不同意，只发 1 次。',
  'Confirmation timed out - dealt once.': '确认超时，只发 1 次。',
  'Equity did not arrive in time - dealt once.': '胜率没算出来，只发 1 次。',
  'Dealt once.': '只发 1 次。',

  // ── P2 B1 鱿鱼游戏 / B3 炸弹池（felt 徽章 + 结算 + 房主触发）────────────
  // 徽章宽度紧，按 4.5 中英混排规则处理；BB 缩写保持原样。
  'Bomb pot · {n}× BB': '炸弹池 · {n} 倍大盲',
  'Squid Game · {n}× BB · {p} players': '鱿鱼游戏 · {n} 倍大盲 · {p} 人',
  'Squid Game settlement': '鱿鱼游戏结算',
  'Nobody won every run - no bounty.': '没人每跑都第一，罚金没有转移。',
  'Bounty {n}': '罚金赔付给 {n}',
  'Trigger Squid Game next hand': '触发下一手鱿鱼游戏',
  'Tap again to cancel the armed Squid Game': '再点一次，取消鱿鱼游戏的就位状态',
  'Trigger bomb pot next hand': '下一手开炸弹池',
  'Tap again to cancel the armed bomb pot': '再点一次，取消炸弹池的就位状态',

  // ── Multi-run 结算文案（跑 N 次牌）─────────────────────────────────────
  'ran it {n} times': '跑了 {n} 次牌',
  'They ran it {n} times - {name} took every run.': '跑了 {n} 次牌，{name} 每一跑都赢。',
  'They ran it {n} times. {detail}': '跑了 {n} 次牌。{detail}',
  'Run {n}: {name}': '第 {n} 跑：{name}',

  // ── Header / chrome（aria-label 与 title 同源）────────────────────────
  'Leave table': '离开牌桌',
  'Table menu': '牌桌菜单',
  // 手机 ⋮ 菜单里的视图组（全屏收进来，见 table-redesign-spec A1）
  View: '视图',
  'Not available': '不可用',
  'Open chat': '打开聊天',
  'Table chat': '牌桌聊天',
  'Close chat': '关闭聊天',
  Close: '关闭',
  'Toggle chat': '打开或关闭聊天',
  'Toggle chat, {n} unread messages': '打开或关闭聊天，{n} 条未读',
  'Full screen': '全屏',
  'Exit full screen': '退出全屏',
  'Table controls': '牌桌控制',
  'More table controls': '更多牌桌控制',
  'Close table controls': '关闭牌桌控制',
  'Join voice': '加入语音',
  'Mute voice': '关闭麦克风',
  'Unmute voice': '开启麦克风',
  Mute: '静音',
  Unmute: '取消静音',
  'Poker board': '扑克桌面',
  POT: '底池',
  'Empty community card {n}': '空的公共牌位（第 {n} 张）',
  'blinds {sb}/{bb}': '盲注 {sb}/{bb}',
  "Copy or share this table's invite link": '复制或分享这张桌的邀请链接',
  'Seated players / in this hand': '已入座玩家 / 参与本手',
  '{n} in hand': '{n} 人在局中',
  'strict audit': '严格审计',
  'void table': '作废牌桌',
  'The banker voided this table: results do not count anywhere':
    '账房把这张桌作废了：输赢在哪都不算数',

  // ── Durable settlement failure (host recovery) ─────────────────────────
  'This hand did not settle': '这一手没能结算',
  'The chips are not recorded yet and the table is frozen. Retry the settlement.':
    '筹码还没入账，牌桌已冻结。请重试结算。',
  'Settlement failed - retrying automatically': '结算失败——正在自动重试',
  'The server is re-attempting its own retry (attempt {n}).':
    '服务器正在自动重试（第 {n} 次）。',
  'Settlement failed - the host must retry.': '结算失败——需要房主重试。',
  'Settlement failed - retrying automatically (attempt {n}).':
    '结算失败——正在自动重试（第 {n} 次）。',
  'Retry settlement': '重试结算',
  'Retrying settlement…': '正在重试结算…',
  'Waiting for the server to confirm.': '等待服务器确认结果。',
  'Retry still failed': '重试仍失败',
  'You can retry again, or contact an administrator.':
    '可以再试一次，或联系管理员。',
  'Retry got no response': '重试没有得到响应',
  'Try again, or contact an administrator.': '可以再试一次，或联系管理员。',
  'Waiting for the host to retry the settlement.': '等待房主重试结算。',
  'Automatic retry stopped responding': '自动重试已停止响应',
  'You can retry the settlement now.': '现在可以重试结算了。',
  'Settlement recovery needs an administrator': '结算恢复需要管理员处理',
  'This hand did not settle and the table can no longer retry it. Ask an administrator to resolve it; the table recovers automatically once it is settled.':
    '这一手没能结算，牌桌已无法再重试。请联系管理员处理；处理完成后牌桌会自动恢复。',
  'An administrator is handling this hand': '管理员正在处理这一手',
  'This hand did not settle and no refund was made. The table recovers automatically once an administrator resolves it.':
    '这一手未能结算，也未发生退款。管理员处理完成后牌桌会自动恢复。',
  'Hand finished': '本手已结束',
  'The result was recovered after a server restart; per-hand details are unavailable.':
    '服务器重启后已恢复本手结果；具体逐位明细不可用。',
};

export default tablePage;
