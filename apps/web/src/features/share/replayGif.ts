import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import type { Replay, ReplayStep } from '../../shared/replay.ts';
import {
  clipCodePoints,
  DISPLAY_FONT,
  MONO_FONT,
  warmCanvasFonts,
  drawCardFace,
} from './shareCard.ts';
import { fmt } from '../../shared/lib/cn.ts';
import { t } from '../../shared/i18n/index.ts';

/** Render a whole replay into an animated GIF - one frame per step, the
 *  result held longer at the end - ready to drop into a tweet
 *  (requested by notpritam, docs/FEATURES.md). */

const W = 720;
const H = 480;
const FRAME_MS = 900;
const LAST_MS = 3000;

function drawStep(
  ctx: CanvasRenderingContext2D,
  replay: Replay,
  step: ReplayStep,
  nameOf: (seat: number) => string,
  roomName: string,
): void {
  ctx.fillStyle = '#0b1220';
  ctx.fillRect(0, 0, W, H);

  // header: the room and what just happened
  ctx.fillStyle = '#5cff72';
  ctx.font = `700 20px ${DISPLAY_FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  // `♠ 4AM` is brand and stays; the room label is data, so it is looked up as a
  // whole key only: the canned 「the 4AM table」 translates, a real room name
  // matches nothing and comes back character-for-character untouched.
  ctx.fillText(clipCodePoints(`♠ 4AM · ${t(roomName)}`, 40), 24, 38);
  ctx.fillStyle = '#e2e8f0';
  ctx.font = `600 16px ${MONO_FONT}`;
  // Step labels are already localized by shared/replay.ts; clip by code point.
  ctx.fillText(clipCodePoints(step.label, 60), 24, 66);

  // pot
  const pot = step.betting ? step.betting.seats.reduce((s, x) => s + x.total, 0) : 0;
  ctx.fillStyle = '#94a3b8';
  ctx.textAlign = 'right';
  ctx.font = `700 18px ${DISPLAY_FONT}`;
  ctx.fillText(t('POT {n}', { n: fmt(pot) }), W - 24, 38);

  // board (and the second runout when the table ran it twice)
  const cw = 64;
  const ch = cw * 1.4;
  const bx = 24;
  const by = 84;
  for (let i = 0; i < 5; i++) {
    if (step.board[i] !== undefined) drawCardFace(ctx, bx + i * (cw + 10), by, cw, ch, step.board[i]!, false);
    else {
      ctx.strokeStyle = 'rgba(148,163,184,0.3)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 5]);
      ctx.strokeRect(bx + i * (cw + 10), by, cw, ch);
      ctx.setLineDash([]);
    }
  }
  if (step.board2.length > 0) {
    ctx.fillStyle = '#e879f9';
    ctx.font = `700 11px ${MONO_FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText(t('RUN 2'), bx + 5 * (cw + 10) + 6, by + 20);
    step.board2.forEach((c, i) => {
      drawCardFace(ctx, bx + i * (cw * 0.62 + 8), by + ch + 10, cw * 0.62, ch * 0.62, c, false);
    });
  }

  // seats: name, stack, action state, revealed cards
  const top = step.board2.length > 0 ? by + ch + 10 + ch * 0.62 + 16 : by + ch + 22;
  const rowH = Math.min(52, (H - top - 16) / Math.max(replay.seats.length, 1));
  replay.seats.forEach((s, i) => {
    const y = top + i * rowH;
    const es = step.betting?.seats.find((x) => x.seat === s.seat);
    const folded = !!es?.folded;
    const isActor = step.actor === s.seat;
    const award = step.awards?.find((a) => a.seat === s.seat);

    if (isActor) {
      ctx.fillStyle = 'rgba(92,255,114,0.1)';
      ctx.fillRect(16, y - 4, W - 32, rowH - 4);
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = folded ? '#475569' : '#f1f5f9';
    ctx.font = `600 15px ${MONO_FONT}`;
    // Seat name is user data; `(D)` is the dealer marker and the `·` separator
    // keep their source positions (docs/zh-i18n.md §4.4). `folded` reuses
    // dict/hands.ts (弃牌).
    const seatLine = `${nameOf(s.seat)}${replay.buttonSeat === s.seat ? ' (D)' : ''}${
      folded ? ` · ${t('folded')}` : ''
    }`;
    ctx.fillText(clipCodePoints(seatLine, 30), 24, y + 18);
    ctx.fillStyle = '#64748b';
    ctx.font = `500 13px ${MONO_FONT}`;
    ctx.fillText(fmt(es ? es.stack : s.stack), 24, y + 36);
    if (es && es.committed > 0) {
      ctx.fillStyle = '#fbbf24';
      // 'Bet {n}' is the shared form from dict/table.ts — 下注 {n}.
      ctx.fillText(t('Bet {n}', { n: fmt(es.committed) }), 120, y + 36);
    }
    const revealed = step.reveals[s.seat];
    if (revealed) {
      revealed.forEach((c, ci) => {
        drawCardFace(ctx, 320 + ci * 34, y - 2, 30, 42, c, false);
      });
    } else if (es && !folded) {
      drawCardFace(ctx, 320, y - 2, 30, 42, null, false);
      drawCardFace(ctx, 354, y - 2, 30, 42, null, false);
    }
    if (award && award.amount > 0) {
      ctx.fillStyle = '#5cff72';
      ctx.textAlign = 'right';
      ctx.font = `700 17px ${DISPLAY_FONT}`;
      ctx.fillText(`+${fmt(award.amount)}`, W - 24, y + 26);
    }
  });

  // footer: the brand stays, the promise is the canvas short form
  ctx.fillStyle = '#475569';
  ctx.textAlign = 'right';
  ctx.font = `500 11px ${MONO_FONT}`;
  ctx.fillText(t('4amcasino.com · provably fair'), W - 24, H - 12);
}

export async function renderReplayGif(
  replay: Replay,
  nameOf: (seat: number) => string,
  roomName: string,
  onProgress?: (done: number, total: number) => void,
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  // Wait for every face in the stacks above before frame 1, otherwise the GIF
  // frames bake tofu (docs/zh-i18n.md §6.2.3). Resolves fast when the fonts
  // are already loaded or come from the system.
  await warmCanvasFonts();
  const gif = GIFEncoder();
  const steps = replay.steps;
  for (let i = 0; i < steps.length; i++) {
    drawStep(ctx, replay, steps[i]!, nameOf, roomName);
    const { data } = ctx.getImageData(0, 0, W, H);
    const palette = quantize(data, 256);
    const index = applyPalette(data, palette);
    gif.writeFrame(index, W, H, { palette, delay: i === steps.length - 1 ? LAST_MS : FRAME_MS });
    onProgress?.(i + 1, steps.length);
    // keep the page breathing while we grind frames
    await new Promise((r) => requestAnimationFrame(r));
  }
  gif.finish();
  return new Blob([gif.bytes()], { type: 'image/gif' });
}
