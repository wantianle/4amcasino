// Canvas dictionary (features/share/shareCard.ts PNG export + replayGif.ts GIF).
// These strings never live in the DOM, so they need their own short forms:
// docs/zh-i18n.md §6.2.3 rule ① — the canvas lane allows tighter variants than
// the on-screen copy. Rule ② is handled in the renderers themselves: every
// ctx.font stack carries CJK faces, and truncation is code-point safe.
//
// Never translated (code-level text, §4.3): the brands 「4AM CASINO」 / 「4AM」,
// `4amcasino.com`, the ♠ pip, the `(D)` dealer marker, card faces, room names
// and player names. Separator characters (·) and symbol positions are kept
// exactly where the source puts them (§4.4).
//
// Reused, NOT redefined here:
//   'POT {n}'  → 底池 {n}      (dict/replay.ts)
//   'Bet {n}'  → 下注 {n}      (dict/table.ts)   — the GIF's `bet 200`
//   'folded'   → 弃牌          (dict/hands.ts)   — the seat-row suffix
// 'RUN 2' is the all-caps GIF corner badge; dict/table-page.ts holds the
// sentence-case 'Run 2' for the DOM, so the canvas keeps its own key.
const canvas: Record<string, string> = {
  // ── shareCard.ts: the 1200x630 result image ───────────────────────────────
  /** Under a player whose hole cards stayed face down. */
  'never shown': '从未亮牌',
  /** The badge in the middle of the duel divider. */
  vs: '对决',
  'also in the pot: {others}': '同桌还有：{others}',
  'provably fair · nobody sees your cards, not even the house':
    '发牌可验证 · 没人看得到你的底牌——平台也不行',

  // ── replayGif.ts: the 720x480 replay animation ────────────────────────────
  'RUN 2': '第 2 跑',
  '4amcasino.com · provably fair': '4amcasino.com · 发牌可验证',
  /** The GIF header's room label. It arrives from the caller as data, so the
   *  canvas looks it up as a whole key only: known labels translate, real room
   *  names match nothing and come back untouched (§4.3). */
  'the 4AM table': '4AM 牌桌',
};

export default canvas;
