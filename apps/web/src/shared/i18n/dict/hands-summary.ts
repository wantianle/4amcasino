// Hand-history inline detail (HandsPage expand + shared/replay.ts summarizeHand
// / summaryActionLabel) and the table result flash (TablePage / ResultFlash).
// Glossary per docs/zh-i18n.md §2.1: 底牌 / 公共牌 / 底池 / 翻牌前·翻牌·转牌·河牌.
// 抽水: the task's wording for the rake line in the hand recap. The ledger and
// the table commission badges keep 台费 (house cut, §2.1) - same money, and the
// two words never appear side by side on one screen. Seat word: N 号位.
// Reused keys owned elsewhere: 'POT {n}' / 'Run 2' (replay), 'Community cards'
// (landing), 'ran it twice' / 'showed after folding' (table), 'Hand history' /
// 'Seat {n}' / 'blinds {sb}/{bb}' / 'Dealer button' / 'voided' / 'Dismiss result'.
const handsSummary: Record<string, string> = {
  // ── Expandable row chrome ───────────────────────────────────────────────
  Transcript: '原始记录',
  'Loading hand…': '正在加载这手牌…',
  'This hand was voided.': '这手牌已作废。',
  'Nothing was recorded for this hand.': '这手牌没有留下记录。',

  // ── Summary meta ────────────────────────────────────────────────────────
  'Actions by street': '各下注轮操作',
  'No betting actions were recorded.': '没有记录到任何下注操作。',
  'No board was dealt.': '没有发出过公共牌。',
  'Hole cards': '底牌',
  'Cards stay hidden': '底牌未公开',
  Rake: '抽水',

  // ── Street headers ──────────────────────────────────────────────────────
  Preflop: '翻牌前',
  Flop: '翻牌',
  Turn: '转牌',
  River: '河牌',

  // ── Action lines (summaryActionLabel, keyed by player name) ─────────────
  '{name} folds': '{name} 弃牌',
  '{name} checks': '{name} 过牌',
  '{name} calls': '{name} 跟注',
  '{name} calls {amount}': '{name} 跟 {amount}',
  '{name} bets': '{name} 下注',
  '{name} bets {amount}': '{name} 下注 {amount}',
  '{name} raises': '{name} 加注',
  '{name} raises to {amount}': '{name} 加注至 {amount}',
  '{name} timed out': '{name} 超时弃牌',

  // ── Table result flash (TablePage renderFlash) ──────────────────────────
  'Hand aborted': '本手作废',
};

export default handsSummary;
