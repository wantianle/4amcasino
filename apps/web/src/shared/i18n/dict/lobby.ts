// Lobby dictionary (LobbyPage) — glossary per docs/zh-i18n.md §2:
// 房间名 / 小盲 / 大盲 / 行动计时 / 可见性 / 计入结账前需打的手数 / 严格审计 / 台费.
// host → 房主, banker → 账房 (never 庄家), lobby → 大厅, room → 房间.
// Keys with {vars} are template keys; room names and usernames pass through as
// vars and are never translated.
// Shared keys defined elsewhere: 'Start a table' (landing), 'Room code' (landing),
// 'Retry'/'Join' kept local to lobby below.
const lobby: Record<string, string> = {
  // Page head
  'Your lobby, {name}': '{name}，欢迎回到大厅。',
  'Start a table or join one with a code.': '自己开一桌，或者凭房间码加入。',

  // Start / join panels
  'You become host and banker.': '你既是房主，又当账房。',
  'Create room': '创建房间',
  'Join a table': '加入牌桌',
  'Ask the host for the 6-letter code.': '找房主要 6 位房间码。',
  Join: '加入',

  // Your rooms
  'Your rooms': '你的房间',
  'No rooms yet. Create one and share the code.': '还没有房间。开一桌，把码发群里。',
  'Open {name}': '进入 {name}',
  'Blinds {sb}/{bb} · Code {code}': '盲注 {sb}/{bb} · 房间码 {code}',
  '{n} players': '{n} 名玩家',

  // Archived
  'Archived tables ({n})': '已归档的牌桌（{n}）',
  'Retired, not deleted. The ledger and every hand stay readable, and anything still owed is still owed — they just stop counting towards your stats.':
    '只是退役，不是删除。账本和每一手牌照常可查，欠的账也照旧——只是不再计入你的统计。',

  // Public tables
  'Public tables': '公开牌桌',
  'Hosted by {host} · Blinds {sb}/{bb} · {n} players': '房主 {host} · 盲注 {sb}/{bb} · {n} 名玩家',
  'Join call': '加入通话',

  // Create room dialog
  'Room name': '房间名',
  'Small blind': '小盲',
  'Big blind': '大盲',
  'Turn timer': '行动计时',
  '{s} seconds per decision': '每步 {s} 秒',
  'No limit': '不限时',
  'Video call link (Meet or Zoom, optional)': '视频通话链接（Meet 或 Zoom，可选）',
  'Who can find this table': '可见性',
  'Private: join with the 6-letter code only': '私密：只能凭 6 位房间码加入',
  'Public: listed in every lobby, anyone can join': '公开：在所有大厅列出，任何人都能加入',
  'Hands required before winnings count in settle-up': '计入结账前需打的手数',
  '0 means everyone counts right away. Maximum 30 hands.': '0 表示开局就计入；最多 30 手。',
  "Strict audit: everyone's cards become checkable after each hand (folded cards included)":
    '严格审计：每手结束后，所有人的底牌都可查验（含弃牌）',
  'House cut: {rate} per pot, rounded down to whole chips.':
    '台费：每个底池收取 {rate}，结果向下取整到整数筹码。',
  'Loading the current house cut…': '正在读取当前台费…',
  Retry: '重试',
  Create: '创建',

  // Client-side fallbacks (server prose is handled by shared/api.ts)
  'could not create room': '房间没建起来，稍后再试。',
  'could not join': '没能进房，检查一下房间码。',
};

export default lobby;
