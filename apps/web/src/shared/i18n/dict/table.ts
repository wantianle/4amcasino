// Table widget dictionary (widgets/table/*, features/table/preActions.ts,
// features/table/AutoDealDialog.tsx): action-bar buttons and status lines,
// seat badges, ready check, run-it-twice, chat panel.
// Keys are the exact English source strings (B+ scheme, docs/zh-i18n.md §6.2);
// §5d samples are used verbatim where the doc provides them.
// Keys already defined elsewhere and deliberately NOT repeated here (the
// merged dictionary resolves them globally): Fold / Check / Call / Pot /
// All-in / None / Saving… / Sending… / Retry (dict/settings.ts), Small blind /
// Big blind (dict/lobby.ts). Hand categories + rank words live in
// dict/shared.ts and reach the UI through tHandCategory()/tScore() only.
const table: Record<string, string> = {
  'Bomb pot!': '炸弹池！',
  'Everyone antes · No preflop betting': '本手全员强制 ante · 无翻前下注',
  'Sit out next deal': '下一手离座',
  'Deal me in next hand': '下一手发牌',
  Gameplay: '玩法',
  // NOTE: the table's History chip links to /room/:id/hands, i.e. 出牌记录 —
  // it uses 'Hand history' (dict/table-page.ts). Do not re-add a bare 'History'
  // key here: it silently overrode dict/history.ts's 「战绩」(HistoryPage title).
  // ── Action bar buttons (§5d) ─────────────────────────────────────────────
  'Call {n}': '跟 {n}',
  'Bet {n}': '下注 {n}',
  Bet: '下注',
  Raise: '加注',
  'Raise to {n}': '加注至 {n}',
  'Check / Fold': '过牌·弃牌',
  'Call any': '有注就跟',
  'Ahead of turn': '提前操作',
  'Arms now, acts on your turn': '先挂上，轮到你自动执行',
  'Raising unlocks on your turn': '轮到你才能加注',
  'Shortcut: {key}': '快捷键：{key}',
  'Fold ({key})': '弃牌（{key}）',
  Min: '最小',
  '⅓ pot': '⅓ 池',
  '½ pot': '½ 池',
  '¾ pot': '¾ 池',
  // A10 bet-ratio labels: the configured slots can reach beyond pot-sized.
  // 'Pot' / 'All-in' / 'Min' are reused from dict/settings.ts and above.
  '¼ pot': '¼ 池',
  '{n}× pot': '{n}× 池',

  // ── Table dock（A6/A9：排名·聊天浮层 + 下手牌离座）─────────────────────
  // '{n} hands' 复用 dict/leaderboard.ts 已有键。
  'Betting options': '下注选项',
  // A8 下注区（GGPoker 样式，牌桌区右下角的紧凑下注面板）。BB 是单位缩写，
  // 按 4.5 保持原样，不进词典。
  'Betting controls': '下注控制',

  // ── Win moment (WinnerFx) ────────────────────────────────────────────────
  // The WIN tag stays in English on purpose: it is a poker-table glyph, like
  // `gg` in §3.3 -圈内通用, and the badge is too small to read 「胜」 cleanly.
  WIN: 'WIN',

  // ── Action bar status lines (§5d) ────────────────────────────────────────
  'Your turn.': '轮到你了。',
  'Out of chips. Chips menu → Buy points.': '筹码打光了。打开「筹码」菜单 → 买点数。',
  'Automatic ready check soon…': '马上自动发起就绪确认…',
  'Auto-deal paused. Table menu → Auto-deal.': '自动发牌已暂停。去「牌桌」菜单 → 自动发牌 开启。',
  'Deal when ready.': '准备好就发牌。',
  'Waiting for two online players with chips…': '还差一位在线且有筹码的玩家才能开牌…',
  'Host deals soon…': '等房主发牌…',
  'Holding ~40s for {names}…': '{names} 掉线了，这手牌等他们约 40 秒…',
  'Shuffling…': '洗牌中…',
  '{name}…': '{name}…',
  'Could not send your action.': '操作没发出去，再试一次。',

  // ── Ready check (§5d) ────────────────────────────────────────────────────
  "I'm ready · {n}s": '我准备好了 · {n} 秒',
  '✓ You are ready': '✓ 已就绪',
  'Ready check': '就绪确认',
  '{a}/{b} ready · deals in {n}s, without the rest': '{a}/{b} 人就绪 · {n} 秒后发牌，不等其余',
  '{a}/{b} — dealing without the rest shortly': '{a}/{b} — 稍后就发牌，不等其余',
  "✋ I'm ready · {a}/{b}": '✋ 我准备好了 · {a}/{b}',

  // ── Action bar HUD labels ────────────────────────────────────────────────
  'Your bet': '你的下注',
  'Your bet this street': '本轮已投入',
  'Your balance': '余额',
  'Your balance. Bought {n} total.': '余额。累计买入 {n}。',
  'Start hand': '开一手',
  'Deal hand': '发牌',
  'Show cards': '亮牌',
  'Bet amount': '下注金额',
  'Raise to': '加注至',
  'Bet or raise amount': '下注或加注金额',
  'Raise amount': '加注金额',
  Amount: '金额',
  'Enter to confirm': '回车确认',
  'Enter a whole-chip amount from {min} to {max}.': '请输入 {min} 到 {max} 之间的整数筹码。',

  // ── Seat / player badges (RoundTable.tsx) ────────────────────────────────
  You: '你',
  '(dealer)': '（庄位）',
  'Dealer button': '庄位',
  'Timed out': '超时',
  'Out of chips': '筹码打光',
  'Sitting out': '休息中',
  Offline: '掉线',
  away: '休息',
  out: '空筹',
  playing: '行动中',
  '✓ ready': '✓ 就绪',
  'ready?': '就绪？',
  'all-in': '全下',
  'Chip leader': '筹码王',
  'Host - deals the hands': '房主 · 负责发牌',
  Banker: '账房',
  'Backup banker': '副账房',
  'Small blind (button)': '小盲（庄位）',
  muted: '已静音',
  "{name}'s profile": '{name}的主页',
  Sit: '入席',
  'Buy waiting for banker approval': '买入待账房批准',
  '+{n} soon': '+{n} 即将到账',
  'Stand this player up': '请这名玩家起身',
  'Tap again to stand them up': '再点一次，确认让其起身',
  'stand up?': '起身？',
  // L2 seat stack unit toggle (local device preference, taps every seat)
  pts: '分',
  '{n} chips · tap to show BB': '{n} 分 · 点此改用 BB 显示',
  '{n} BB · tap to show points': '{n} BB · 点此改用分显示',
  // L4 action cluster sub line
  'To call {n}': '要跟 {n}',
  'Pot {n}': '底池 {n}',
  'in {n}': '买入 {n}',

  // ── Chat panel (ChatPanel.tsx) ───────────────────────────────────────────
  Chat: '聊天',
  'Say hi. Messages are not saved.': '说点什么吧。消息不会被保存。',
  'nice hand 👏': '这手漂亮 👏',
  'bluff! 🤨': '诈的！🤨',
  'run it again 🔁': '再来一手 🔁',
  'ouch 💀': '这也能输 💀',
  gg: 'gg',
  'so lucky 🍀': '手气真好 🍀',
  'send {s} sticker': '发送 {s} 表情',
  stickers: '表情贴纸',
  'Message…': '发消息…',
  Send: '发送',

  // ── Run it twice / showdown / last hand ──────────────────────────────────
  '🔁 Run it twice?': '🔁 跑两次？',
  'Twice 🔁': '跑两次 🔁',
  Once: '跑一遍',
  'showed after folding': '弃牌后亮牌',
  'Run {n}': '第 {n} 跑',
  'Last hand': '上一手牌',
  'chips stayed put': '筹码原地不动',
  'ran it twice': '跑了两次牌',
  'everyone folded': '全部弃牌',
  'No cards were shown - the pot went to the last player standing.':
    '没人亮牌——底池归最后一个没弃牌的人。',
  'Full replay →': '完整回放 →',
  'Seat {n}': '{n} 号位',

  // ── Mobile table extras ──────────────────────────────────────────────────
  'You are out of chips. Buy points from the bank (menu, top right).':
    '你的筹码打光了。打开右上角菜单，向银行买点数。',
  'Automatic ready check soon. Menu → sit out if you need a break.':
    '马上自动发起就绪确认。要缓口气就打开菜单 → 休息。',
  'Waiting for two online players with chips.': '还差一位在线且有筹码的玩家才能开牌。',
  'Waiting for the host to deal.': '等房主发牌。',
  'Waiting…': '等待中…',
  'Waiting for friends to sit down…': '等朋友入座…',
  pot: '底池',

  // ── TurnProgress.tsx ─────────────────────────────────────────────────────
  'time remaining to act': '剩余行动时间',

  // ── P2 B2 计时银行 (TurnProgress / BettingPanel ring / seat pods) ─────────
  // Glossary: time bank → 计时银行 (docs/zh-i18n.md + p2-gameplay-design §4).
  'time bank remaining': '计时银行剩余',
  'Bank {n}s': '银行 {n} 秒',
  'Base clock then time bank remaining': '常规计时加计时银行剩余',
  'The base clock drains first, then the time bank.': '先走完常规行动计时，才开始扣计时银行。',
  '{secs}s, then {bank}s of time bank': '还剩 {secs} 秒 · 另有计时银行 {bank} 秒',
  'Spending your time bank': '正在花你的计时银行',

  // ── P2 B3 炸弹池 (BettingPanel 前注提示) ─────────────────────────────────
  // 状态长句，按定稿原句：不加句号。
  'Bomb pot ante posted - straight to the flop.': '炸弹池前注已下，直接看翻牌',

  // ── Auto-deal dialog (features/table/AutoDealDialog.tsx) ─────────────────
  'Auto-deal': '自动发牌',
  'Waiting for two seated, online players with chips.': '还差两名已入座、在线且有筹码的玩家。',
  'Reconnecting to the table…': '正在重连牌桌…',
  'Off. The host starts each hand manually.': '已关闭，每手牌由房主手动开。',
  'The next ready check starts after this hand.': '就绪确认会在这手牌结束后发起。',
  '{a} of {b} players ready.': '{a}/{b} 名玩家已就绪。',
  'Paused because fewer than two players were ready.': '因就绪的人不足两个，已暂停。',
  'Ready check in {n}s.': '{n} 秒后发起就绪确认。',
  'Waiting for the next ready check.': '等下一次就绪确认。',
  'Could not save auto-deal. Try again.': '自动发牌设置没保存成功，再试一次。',
  'Enable auto-deal': '开启自动发牌',
  'Keep the table moving between hands.': '让牌局一手接一手。',
  'Automatic dealer:': '自动发牌：',
  Fallback: '替补',
  'The seated, online host is preferred. If they leave, sit out or run out of chips, another seated, online player takes over automatically.':
    '优先由已入座且在线的房主发牌。对方离席、休息或筹码打光时，自动换另一名已入座在线的玩家接手。',
  'After a 15-second break, everyone gets up to 20 seconds to choose “I’m ready”. Your “Auto ready” preference still applies. At least two ready players are needed.':
    '15 秒休息后，大家最多有 20 秒点「我准备好了」。你的「自动就绪」设置照常生效。至少需要两人就绪才会发牌。',
  'Only the host can change this room setting.': '只有房主能改这个房间设置。',
  'Try ready check again': '再发起一次就绪确认',
};

export default table;
