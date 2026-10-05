// HistoryPage / HistoryRoomPage: the cross-room record of every table this
// account has ever played (active and archived), and the per-room hand list
// that drills into replay and the ledger. Keys are the exact English source;
// style per docs/zh-i18n.md (账本=ledger, 出牌记录=hand history, 战绩=history,
// 已归档=archived, 「…」single-char ellipsis, error sentences end in 句号).
const history: Record<string, string> = {
  // ── Navigation + shared labels ──────────────────────────────────────────
  History: '战绩',
  Host: '房主',

  // ── /history: room list ─────────────────────────────────────────────────
  'Loading your history…': '正在加载战绩…',
  'Could not load your history.': '加载战绩失败。',
  'Every table you have played, including archived ones. Open a room for your hands, replays and the ledger.':
    '你打过的每一张桌子，包含已归档的。点进房间查看手牌、回放和账本。',
  Rooms: '房间',
  // 'Hands played' is defined in dict/player.ts (已玩手数) - reused, not
  // redefined here. Likewise '{n} hands' lives in dict/leaderboard.ts.
  'Net result': '净结果',
  'Filter rooms': '筛选房间',
  All: '全部',
  Active: '进行中',
  Archived: '已归档',
  'No games yet. Your finished tables will show up here.': '还没有战绩。你打完的桌子会出现在这里。',
  'Nothing here for this filter.': '当前筛选下没有内容。',
  'Open history for {name}': '查看「{name}」的战绩',
  '{n} players · {time}': '{n} 名玩家 · {time}',
  'Blinds {sb}/{bb}': '盲注 {sb}/{bb}',

  // ── /history/:roomId: one room's hands ──────────────────────────────────
  '← Back to history': '← 返回战绩',
  'Open ledger': '打开账本',
  'Hands on this page': '本页手数',
  'Page net': '本页净胜',
  'Could not load this room.': '加载该房间失败。',
  'No hands in this room yet.': '这个房间还没有手牌。',
  '← Newer': '← 更新',
  'Older →': '更早 →',
  '{from}–{to} of {total}': '第 {from}–{to} 条，共 {total} 条',
  'Page {page}/{pages}': '第 {page}/{pages} 页',
};

export default history;
