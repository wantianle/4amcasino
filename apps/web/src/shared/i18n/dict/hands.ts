// HandsPage: hand history list, session filters, the transcript dialog, and
// the per-hand `outcome` prose the server persists (rooms.ts / profile.ts) -
// rendered through `tr()` at the display boundary. Keys are the exact English
// source; style per docs/zh-i18n.md (账本=账本, 出牌记录=hand history, 摊牌,
// 作废, 「…」单字符省略号, 错误 0 感叹号).
const hands: Record<string, string> = {
  // ── Shared chrome (also used by LedgerPage / PlayerPage) ────────────────
  '← Back to table': '← 返回牌桌',

  // ── Page header ─────────────────────────────────────────────────────────
  // NOTE: 'Hand history' (page title) is defined in dict/table-page.ts as
  // 「出牌记录」 - reused here, not redefined.
  'Loading hands…': '正在加载手牌…',
  'Every completed hand stores its full signed transcript with your result on it. Download one to audit the shuffle, every unmask proof, and every action offline.':
    '每一手打完的牌都存着完整的签名出牌记录，上面带着你的结果。下载任意一手，离线也能核查洗牌、每一次解掩验证和每一个操作。',

  // ── Session totals ──────────────────────────────────────────────────────
  'Your net · {n} hands': '你的净胜 · 共 {n} 手',
  'Hands won': '赢下的手数',
  Folds: '弃牌次数',
  'Paid to fold (blinds and bets)': '弃牌扔掉的（盲注和下注）',

  // ── Filter tabs (also used by PlayerPage's history rail) ────────────────
  all: '全部',
  won: '赢',
  lost: '输',
  folded: '弃牌',
  showdown: '摊牌',

  // ── Hand list ───────────────────────────────────────────────────────────
  'No completed hands yet.': '还没有打完的手牌。',
  'hand {id}': '手牌 {id}',
  voided: '作废',

  // ── Persisted `outcome` prose (tr()) - rooms.ts / profile.ts ───────────
  played: '参与',
  'sat out': '休息中',
  aborted: '本手作废',
  'folded preflop': '翻牌前弃牌',
  'folded on the flop': '翻牌后弃牌',
  'folded on the turn': '转牌后弃牌',
  'folded on the river': '河牌后弃牌',
  'won at showdown': '摊牌获胜',
  'lost at showdown': '摊牌落败',
  'won, everyone folded': '别人全弃牌，直接赢下',
  'won quietly': '悄悄赢下',

  // ── Transcript dialog ───────────────────────────────────────────────────
  'Hand transcript': '出牌记录原文',
  '{n} entries': '共 {n} 条',
  '✓ verified in your browser': '✓ 已在浏览器里验证通过',
  'TAMPERED. {reason}': '记录被改动：{reason}',
  'TAMPERED. {reason} at entry {seq}': '记录被改动：{reason}（第 {seq} 条）',
  invalid: '数据无效',

  // ── verifyHandTranscript() reasons (packages/mental-poker audit.ts) ─────
  'empty transcript': '记录为空',
  'hash chain mismatch': '哈希链对不上',
  'sequence gap': '序号断档',
  'bad signature on {type}': '{type} 的签名不对',

  'head {head}…': '链头 {head}…',
  '▶ Watch replay': '▶ 看回放',
  'Download JSON': '下载 JSON',
};

export default hands;
