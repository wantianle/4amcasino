import { RANKS, rankOf, suitOf, type CardId } from '@4am/shared';
import { t } from '../../shared/i18n/index.ts';
import { fmt } from '../../shared/lib/cn.ts';

/** Everything the shareable result image needs; all of it is public info. */
export interface ShareRow {
  name: string;
  cards: CardId[] | null; // null = the cards were never shown
  label: string | null; // hand description, e.g. "Two Pair, Aces and Kings"
  delta: number;
}

export interface ShareData {
  roomName: string;
  headline: string;
  board: CardId[];
  rows: ShareRow[];
  winningFive: CardId[] | null;
}

const SUIT_GLYPHS = ['♣', '♦', '♥', '♠'] as const;
const SUIT_COLORS = ['#1e293b', '#e11d48', '#e11d48', '#1e293b'] as const;
const ACCENT = '#2563eb';

/**
 * Canvas font stacks. Per-glyph fallback walks the list in order, so the Han
 * faces have to be named explicitly: a stack that ends at `system-ui` /
 * `sans-serif` draws Chinese as tofu boxes on a machine whose default sans
 * carries no Han glyphs (docs/zh-i18n.md §6.2.3 rule ②).
 */
const CJK_FACES = '"Noto Sans SC", "PingFang SC", "Microsoft YaHei"';
/** Card faces, names, deltas, footer: Inter for Latin, Han faces before the generic. */
export const SANS_FONT = `"Inter", system-ui, ${CJK_FACES}, sans-serif`;
/** Replay header + pot: the display face, same Han fallback. */
export const DISPLAY_FONT = `"Unbounded", system-ui, ${CJK_FACES}, sans-serif`;
/** Step labels and seat rows: Latin stays monospaced (`monospace` resolves
 *  before the Han faces, so digits keep their column alignment). */
export const MONO_FONT = `"JetBrains Mono", monospace, ${CJK_FACES}, sans-serif`;
/** Suit pips only — they come from the system glyph font. */
export const PIP_FONT = `system-ui, ${CJK_FACES}, sans-serif`;

/** Every weight the canvases actually draw with, as `document.fonts` shorthands. */
const FONT_REQUESTS: readonly string[] = [
  ...['400', '500', '600', '700'].map((w) => `${w} 20px ${SANS_FONT}`),
  ...['500', '600', '700'].map((w) => `${w} 16px ${MONO_FONT}`),
  '700 20px ' + DISPLAY_FONT,
];

let fontsWarmed = false;
let warming: Promise<void> | null = null;

/**
 * Resolve once every face the canvas draws with is ready, so the first exported
 * PNG/GIF is never tofu. The work happens once per page load; later calls reuse
 * the same promise (or the settled flag).
 */
export function warmCanvasFonts(): Promise<void> {
  if (fontsWarmed) return Promise.resolve();
  if (typeof document === 'undefined' || !document.fonts?.load) {
    fontsWarmed = true;
    return Promise.resolve();
  }
  warming ??= Promise.all(
    FONT_REQUESTS.map((f) => document.fonts.load(f).catch(() => undefined)),
  )
    .then(() => document.fonts.ready)
    .then(() => {
      fontsWarmed = true;
    });
  return warming;
}

function rankLabel(id: CardId): string {
  const r = RANKS[rankOf(id)]!;
  return r === 'T' ? '10' : r;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

export function drawCardFace(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  id: CardId | null,
  highlight: boolean,
): void {
  const r = w * 0.14;
  ctx.save();
  // A soft contact shadow matches the Zeus card surfaces.
  ctx.shadowColor = 'rgba(24,42,66,0.14)';
  ctx.shadowBlur = w * 0.12;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = w * 0.055;
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = id === null ? '#2563eb' : '#ffffff';
  ctx.fill();
  ctx.restore();
  if (id === null) {
    // face-down back: diagonal hatching
    ctx.save();
    roundRect(ctx, x, y, w, h, r);
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = w * 0.045;
    for (let i = -h; i < w + h; i += w * 0.22) {
      ctx.beginPath();
      ctx.moveTo(x + i, y + h);
      ctx.lineTo(x + i + h, y);
      ctx.stroke();
    }
    ctx.restore();
  } else {
    ctx.save();
    const color = SUIT_COLORS[suitOf(id)]!;
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `700 ${w * 0.34}px ${SANS_FONT}`;
    ctx.fillText(rankLabel(id), x + w * 0.11, y + w * 0.42);
    ctx.textAlign = 'center';
    ctx.font = `${w * 0.52}px ${PIP_FONT}`;
    ctx.fillText(SUIT_GLYPHS[suitOf(id)]!, x + w / 2, y + h * 0.82);
    ctx.restore();
  }
  if (highlight) {
    roundRect(ctx, x - 3, y - 3, w + 6, h + 6, r + 3);
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 5;
    ctx.stroke();
  }
}

/**
 * Break text into wrap units. Latin text wraps on spaces; Chinese has none, so
 * a unit wider than the box is broken into single code points instead of
 * overflowing the card.
 */
function wrapUnits(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): { unit: string; glue: boolean }[] {
  const out: { unit: string; glue: boolean }[] = [];
  for (const word of text.split(' ')) {
    if (word.length === 0) continue;
    if (ctx.measureText(word).width > maxWidth) {
      // No space to break on: fall back to code points (CJK-safe, no split pairs).
      Array.from(word).forEach((ch) => out.push({ unit: ch, glue: true }));
    } else {
      out.push({ unit: word, glue: false });
    }
  }
  return out;
}

/** Measure after the font is set — callers always assign `ctx.font` first. */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const { unit, glue } of wrapUnits(ctx, text, maxWidth)) {
    // `glue` units (Han characters) join without inserting a space.
    const probe = line ? (glue ? line + unit : `${line} ${unit}`) : unit;
    if (ctx.measureText(probe).width > maxWidth && line) {
      lines.push(line);
      line = unit;
    } else {
      line = probe;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

/** Code-point-safe truncation: `slice` counts UTF-16 units and would split an
 *  extension-plane Han character or an emoji in half. */
export function clipCodePoints(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

/** Shrink to fit with a trailing …, one code point at a time. */
function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const chars = Array.from(text);
  while (chars.length > 1) {
    chars.pop();
    const probe = `${chars.join('')}\u2026`;
    if (ctx.measureText(probe).width <= maxWidth) return probe;
  }
  return '\u2026';
}

/** Subtle film grain over the finished card. */
function grain(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  const off = document.createElement('canvas');
  off.width = W;
  off.height = H;
  const octx = off.getContext('2d')!;
  const img = octx.createImageData(W, H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = 128 + (Math.random() - 0.5) * 255;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  octx.putImageData(img, 0, 0);
  ctx.globalAlpha = 0.05;
  ctx.globalCompositeOperation = 'overlay';
  ctx.drawImage(off, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

/** One duel column: avatar, name, cards, hand label, hero delta. */
function drawColumn(
  ctx: CanvasRenderingContext2D,
  cx: number,
  row: ShareRow,
  five: Set<CardId>,
  dim: boolean,
): void {
  ctx.save();
  if (dim) ctx.globalAlpha = 0.72;
  const winner = row.delta > 0;
  // avatar
  ctx.beginPath();
  ctx.arc(cx, 178, 28, 0, Math.PI * 2);
  ctx.fillStyle = winner ? '#2563eb' : 'rgba(0,0,0,0.04)';
  ctx.fill();
  ctx.fillStyle = winner ? '#ffffff' : '#171717';
  ctx.textAlign = 'center';
  ctx.font = `700 26px ${SANS_FONT}`;
  // First code point of the display name: `slice(0, 1)` would halve a name that
  // starts with an extension-plane character.
  ctx.fillText((Array.from(row.name)[0] ?? '').toUpperCase(), cx, 188);
  // name
  ctx.font = `600 27px ${SANS_FONT}`;
  ctx.fillText(ellipsize(ctx, row.name, 320), cx, 243);
  // cards
  const cw = 96;
  const ch = 134;
  const gap = 12;
  const startX = cx - cw - gap / 2;
  if (row.cards) {
    row.cards.forEach((c, j) =>
      drawCardFace(ctx, startX + j * (cw + gap), 262, cw, ch, c, five.has(c)),
    );
  } else {
    for (let j = 0; j < 2; j++)
      drawCardFace(ctx, startX + j * (cw + gap), 262, cw, ch, null, false);
  }
  // hand label
  ctx.textAlign = 'center';
  ctx.fillStyle = '#666666';
  ctx.font = `21px ${SANS_FONT}`;
  ctx.fillText(row.label ?? (row.cards ? '' : t('never shown')), cx, 428);
  // hero delta
  ctx.fillStyle = winner ? '#2563eb' : '#be123c';
  ctx.font = `700 54px ${SANS_FONT}`;
  ctx.fillText(`${winner ? '+' : '\u2212'}${fmt(Math.abs(row.delta))}`, cx, 492);
  ctx.restore();
}

/** Paint the 1200x630 shareable hand card. `drawHandCard` is the public entry. */
function paintHandCard(canvas: HTMLCanvasElement, data: ShareData): void {
  const W = 1200;
  const H = 630;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const five = new Set(data.winningFive ?? []);

  // background: near-black with a faint indigo glow behind the duel
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W / 2, 300, 60, W / 2, 300, 560);
  glow.addColorStop(0, 'rgba(37,99,235,0.04)');
  glow.addColorStop(1, 'rgba(37,99,235,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // quiet brand row
  ctx.fillStyle = '#2563eb';
  roundRect(ctx, 48, 38, 34, 34, 8);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.font = `20px ${PIP_FONT}`;
  ctx.fillText('\u2660', 65, 62);
  ctx.textAlign = 'left';
  ctx.font = `700 19px ${SANS_FONT}`;
  try {
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '4px';
  } catch {
    /* older browsers */
  }
  ctx.fillStyle = '#171717';
  // Brand: 「4AM CASINO」 never translates (docs/zh-i18n.md §4.3). The 4px
  // tracking is safe here because the string stays Latin.
  ctx.fillText('4AM CASINO', 96, 61);
  try {
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0px';
  } catch {
    /* older browsers */
  }
  ctx.textAlign = 'right';
  ctx.fillStyle = '#737373';
  ctx.font = `18px ${SANS_FONT}`;
  // Room names are user data: measured and trimmed, never translated.
  ctx.fillText(ellipsize(ctx, data.roomName, 360), W - 48, 61);

  // headline, one quiet line (already localized by the caller)
  ctx.textAlign = 'center';
  ctx.fillStyle = '#525252';
  ctx.font = `500 23px ${SANS_FONT}`;
  ctx.fillText(ellipsize(ctx, data.headline, W - 140), W / 2, 112);

  // the duel: winner vs the biggest loser
  const rows = data.rows;
  const winnerRow = rows[0];
  const loserRow = rows.length > 1 ? rows[rows.length - 1] : null;
  if (winnerRow && loserRow) {
    // center divider
    ctx.strokeStyle = '#ebebeb';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(W / 2, 160);
    ctx.lineTo(W / 2, 500);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(W / 2, 320, 26, 0, Math.PI * 2);
    ctx.fillStyle = '#f7f7f7';
    ctx.fill();
    ctx.strokeStyle = '#ebebeb';
    ctx.stroke();
    ctx.fillStyle = '#666666';
    ctx.textAlign = 'center';
    ctx.font = `600 19px ${SANS_FONT}`;
    ctx.fillText(t('vs'), W / 2, 327);
    drawColumn(ctx, W * 0.27, winnerRow, five, false);
    drawColumn(ctx, W * 0.73, loserRow, five, true);
  } else if (winnerRow) {
    drawColumn(ctx, W / 2, winnerRow, five, false);
  }

  // the board, small and quiet, winning five ringed
  const bw = 62;
  const bh = 87;
  const gap = 12;
  const startX = (W - (5 * bw + 4 * gap)) / 2;
  for (let i = 0; i < 5; i++) {
    const card = data.board[i];
    if (card !== undefined) {
      drawCardFace(ctx, startX + i * (bw + gap), 516, bw, bh, card, five.has(card));
    } else {
      roundRect(ctx, startX + i * (bw + gap), 516, bw, bh, 9);
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = '#ebebeb';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // quiet footer: everyone else, and the promise
  const others = rows.slice(1, -1);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#737373';
  ctx.font = `15px ${SANS_FONT}`;
  if (others.length > 0) {
    const line = others
      .map((o) => `${o.name} ${o.delta > 0 ? '+' : '\u2212'}${fmt(Math.abs(o.delta))}`)
      .join('  \u00b7  ');
    ctx.fillText(ellipsize(ctx, t('also in the pot: {others}', { others: line }), 560), 48, H - 20);
  }
  ctx.textAlign = 'right';
  ctx.fillText(t('provably fair · nobody sees your cards, not even the house'), W - 48, H - 20);

  grain(ctx, W, H);
}

/** Canvases still on screen when the fonts finally land, with the data to redraw. */
const repaintQueue = new Map<HTMLCanvasElement, ShareData>();
let repaintScheduled = false;

/**
 * Renders the 1200x630 shareable hand card onto the canvas. Synchronous so the
 * preview and the PNG export stay one call, but self-healing: if the webfonts
 * (Inter, and any Han face that has to be fetched) are not ready yet, the card
 * is painted once, then painted again from the same data the moment they are —
 * so a first export never ships tofu.
 */
export function drawHandCard(canvas: HTMLCanvasElement, data: ShareData): void {
  paintHandCard(canvas, data);
  if (fontsWarmed) return;
  repaintQueue.set(canvas, data);
  if (repaintScheduled) return;
  repaintScheduled = true;
  void warmCanvasFonts().then(() => {
    repaintScheduled = false;
    for (const [c, d] of repaintQueue) {
      if (c.isConnected) paintHandCard(c, d);
    }
    repaintQueue.clear();
  });
}
