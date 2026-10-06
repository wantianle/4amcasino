// Gameplay-rules dictionary (P2 Lane D): lobby create-room 「玩法规则」 section and
// features/table/GameplaySettingsDialog.tsx.
// Glossary per docs/zh-i18n.md §2 + docs/p2-gameplay-design.md §4:
// squid → 鱿鱼游戏, time bank → 计时银行, bomb pot → 炸弹池, ante → 前注,
// multi-run → 全下多次发牌 / 跑 N 次牌, big blind → 大盲, hand → 手, host → 房主.
// Keys are the exact English source strings (B+ scheme, docs/zh-i18n.md §6.2).
// Reused, NOT redefined here: 'Saved.' (dict/profile.ts), 'Saving…' and
// 'Restore defaults' (dict/settings.ts), '{n} hands' (dict/leaderboard.ts),
// 'Retry' (dict/lobby.ts), and every server-prose key
// ('only the host can change gameplay settings', 'Gameplay settings apply
// between hands.', 'bomb pot interval must be …') which lives in dict/server.ts.
const gameplay: Record<string, string> = {
  // ── Section header / summary ─────────────────────────────────────────────
  'Gameplay rules': '玩法规则',
  'Gameplay settings': '玩法规则',
  'Optional twists on top of regular poker.': '在常规德扑之上，再叠几条可选玩法。',
  'Optional twists on top of regular poker. The host can change them between hands.':
    '在常规德扑之上，再叠几条可选玩法。房主随时能改，改动在本手结束后生效。',
  'None enabled': '都没开',
  '{n} on': '已开 {n} 项',
  'You can change these between hands from the table menu.':
    '这些设置开桌后也能改，房主在牌桌菜单里调，下一手生效。',

  // ── Shared control chrome ────────────────────────────────────────────────
  'Enter a whole number from {min} to {max}.': '请输入 {min} 到 {max} 之间的整数。',
  'Between {min} and {max}.': '范围 {min} 到 {max}。',
  players: '人',
  hands: '手',
  seconds: '秒',
  '× BB': '倍大盲',
  '{n}× BB': '{n} 倍大盲',
  '{n} seconds': '{n} 秒',
  '{n} minutes': '{n} 分钟',
  '{n} hours': '{n} 小时',
  '{n} days': '{n} 天',

  // ── B1 Squid Game ────────────────────────────────────────────────────────
  'Squid Game': '鱿鱼游戏',
  'Loser pays the whole table': '输的人赔给桌上所有人',
  'Enable Squid Game': '开启鱿鱼游戏',
  'Penalty per loser': '每个输家的罚金',
  'Minimum players': '最低参与人数',
  'At {players} players, each loser pays up to {amount} BB':
    '{players} 人时每人最多付 {amount} BB',
  'Only fires with at least {n} players in the hand': '本手至少 {n} 人参与才会触发',
  'The host triggers it by hand. Penalties come off table stakes; short stacks pay only what they have.':
    '由房主手动触发，罚金从桌面筹码里扣；筹码不够的只付得出多少赔多少。',

  // ── Time bank (timer popover, TableQuickControls) ────────────────────────
  // Moved out of the gameplay dialog: the bank is a between-hands knob, so it
  // lives in the table's 计时 chip popover now. Keys shared with the popover:
  'Time bank': '计时银行',
  'Banked thinking time': '存起来的思考时间',
  'Enable time bank': '开启计时银行',
  'Starting bank': '初始额度',
  'Refill every': '补秒间隔',
  'Refill amount': '每次补给',
  'Everyone starts with {initial} seconds, then gets {refill} seconds every {hands} hands':
    '每人先有 {initial} 秒，每 {hands} 手补 {refill} 秒',
  'The regular timer runs down first; an empty bank folds for you.':
    '先把每步的常规计时走完，才开始扣银行；银行扣光就自动弃牌。',
  'Change these numbers and every bank resets to the new start.':
    '这几个数字一改，所有人的银行清零，按新额度重算。',

  // ── B3 Bomb pot ──────────────────────────────────────────────────────────
  'Bomb pot': '炸弹池',
  'Ante up, straight to the flop': '每人交前注，直接开翻牌',
  'Enable bomb pot': '开启炸弹池',
  'Ante per player': '每人前注',
  'Ante presets': '前注快捷预设',
  'Fire every': '触发节奏',
  'By hands': '按手数',
  'By time': '按时长',
  Interval: '间隔',
  'Interval unit': '间隔单位',
  'Every {interval}: each player antes {ante} BB, blinds are skipped, and the hand starts on the flop':
    '每隔 {interval}：每人先付 {ante} 倍大盲的前注，跳过盲注，直接从翻牌开打',
  'The host can also drop one between hands.': '房主也能随时手动炸一手。',

  // ── B4 Multi-run all-in ──────────────────────────────────────────────────
  'Multi-run all-in': '全下多次发牌',
  'Run the board up to {maxRuns} times': '公共牌最多跑 {maxRuns} 次',
  'Enable multi-run all-in': '开启全下多次发牌',
  'Up to {maxRuns} runs when cards are still to come': '牌没发完就全下时，最多跑 {maxRuns} 次',
  'The behind hand picks 1–3 runs; the ahead hand has to agree.':
    '落后的一方选跑 1 到 3 次，领先的一方点头才发。',
  'More than two players all-in, or equal odds: it runs once.':
    '超过两人全下，或胜率持平，只跑一次。',

  // ── Dialog state / actions ───────────────────────────────────────────────
  'Unsaved changes': '有改动还没保存',
  'Save changes': '保存修改',
  Discard: '放弃修改',
  'Only the host can change gameplay settings.': '只有房主能改玩法规则。',
  'These settings apply between hands. The hand in play keeps its own rules.':
    '规则在两手牌之间生效。正在打的这一手照原来的规矩走完。',
  'could not save gameplay settings': '玩法规则没保存成功，再试一次。',

  // ── Hand-boundary save queue (dialog + timer popover) ────────────────────
  // The server 409s feature writes while a hand runs and does not queue them
  // itself, so a mid-hand click is held client-side until the next boundary.
  'Queued — saves as soon as this hand ends.': '已排队：这一手一结束就自动保存。',
  'Cancel queue': '取消排队',
  'Re-queue changes': '重新排队保存',
  'Only the host can change the timer settings.': '只有房主能改计时设置。',
  'could not load room settings': '没读到房间设置，再开一次试试。',

  // ── Timer chip popover (TableQuickControls) ──────────────────────────────
  'Turn timer & time bank': '计时与时间银行',
};

export default gameplay;
