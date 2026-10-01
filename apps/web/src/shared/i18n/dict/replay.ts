// Replay step labels (built in shared/replay.ts) + ReplayPage chrome.
// Seat word follows the glossary: Seat N → 「N 号位」; the badge 'Run 2' and
// 'Seat {n}' templates are reused from dict/table-page.ts (identical forms).
// Note: renderReplayGif() reads these same step labels; the canvas share art
// is a separate localization phase (docs/zh-i18n.md §6.2.3).
const replay: Record<string, string> = {
  // ── Step labels ─────────────────────────────────────────────────────────
  'Cards dealt face down': '底牌发出，牌面朝下',
  'Blinds posted': '盲注就位',
  'Seat {seat} folds': '{seat} 号位弃牌',
  'Seat {seat} checks': '{seat} 号位过牌',
  'Seat {seat} calls': '{seat} 号位跟注',
  'Seat {seat} calls {amount}': '{seat} 号位跟 {amount}',
  'Seat {seat} bets': '{seat} 号位下注',
  'Seat {seat} bets {amount}': '{seat} 号位下注 {amount}',
  'Seat {seat} raises': '{seat} 号位加注',
  'Seat {seat} raises to {amount}': '{seat} 号位加注至 {amount}',
  'Seat {seat} timed out and folds': '{seat} 号位超时，自动弃牌',
  'Board card revealed': '开一张公共牌',
  'Run 2 card revealed': '开出第 2 跑的一张牌',
  'Seat {seat} votes to run it twice': '{seat} 号位选择跑两遍',
  'Seat {seat} votes to run it once': '{seat} 号位选择跑一遍',
  'Running it twice!': '跑两次牌！',
  'Running it once': '只跑一遍',
  'Preflop betting': '翻牌前下注',
  'Flop betting': '翻牌圈下注',
  'Turn betting': '转牌圈下注',
  'River betting': '河牌圈下注',
  Result: '本手结果',
  'Hand aborted: {reason}': '本手作废：{reason}',

  // ── Page chrome ─────────────────────────────────────────────────────────
  'Rebuilding hand from its transcript…': '正在按签名记录重建这手牌…',
  '← Hands': '← 出牌记录',
  Replay: '回放',
  'TV replay': '转播模式',
  'Renders the whole hand as a GIF, downloads it, and opens a tweet - attach the GIF and post':
    '把整手牌渲染成 GIF 并下载，再打开一条推文，挂上 GIF 直接发。',
  'GIF for Twitter': '导出 GIF 发推',
  'GIF {progress}…': 'GIF 生成中 {progress}…',
  'Save hand': '保存这手记录',
  'Everyone revealed their hand key after this hand, so every hole card is visible - broadcast style.':
    '这手牌结束后所有人都公布了密钥，每张底牌都看得见，转播视角。',
  'Rebuilt from the signed transcript, showing only what was public. Folded cards stay secret forever.':
    '按签名记录重建，只显示当时公开过的内容。弃掉的牌永远是秘密。',
  'POT {n}': '底池 {n}',
  restart: '回到开头',
  back: '上一步',
  forward: '下一步',
  'replay position': '回放进度',
  Pause: '暂停',
  Play: '播放',
  'This hand at 4AM Casino ♠ provably fair poker with friends - 4amcasino.com':
    '这手牌来自 4AM Casino ♠ 朋友间的德州扑克，发牌可验证 - 4amcasino.com',
};

export default replay;
