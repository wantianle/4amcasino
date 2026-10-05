import { memo, useMemo } from 'react';
import { cn } from '../../shared/lib/cn.ts';
import {
  CHIP_PALETTES,
  chipBreakdown,
  sbFromBb,
  type ChipColor,
  type ChipPalette,
} from '../../shared/lib/chips.ts';

/** Chips that look like chips: an amount breaks into SB-based denominations
 *  (shared math + palette in shared/lib/chips.ts — white 1 / red 5 / green 25 /
 *  blue 100 / purple 500 SB) and every stack renders as a small cylinder:
 *  dashed-edge slices with a glossy, ringed face chip capping the pile, plus a
 *  soft ground shadow so the pile sits ON the felt instead of floating.
 *
 *  Today this widget only renders the street-bet pile (the chips pushed out
 *  between a seat and the pot). The seat-bank and center-pot variants were
 *  removed in the table-ui refactor.
 *
 *  Requested by notpritam (docs/FEATURES.md); the dimensional redesign is user
 *  feedback on the P1 table ("nicer, smaller, color denominations, and never
 *  overlap"). */

/** face Ø / per-chip slice height in design-px. Deliberately tiny - the value
 *  label beside each pile carries precision; the pile only needs to read as
 *  "chips of these colors". `xs` is the phone bet lane. */
const DIMS = {
  xs: { face: 11, step: 3 },
  sm: { face: 14, step: 3.5 },
} as const;

/** How many chips of ONE tier get drawn. The pile is an approximate visual
 *  only (no count badge); tuned for the street-bet pile so huge bets stay sane. */
const MAX_SHOWN = 4;

/** Deterministic side-to-side sway per slice (px, × face/14) so a pile reads
 *  as hand-stacked chips, not a perfect render. */
const WOBBLE = [0, 0.05, -0.06, 0.035, -0.045];

function sideStyle(p: ChipPalette, face: number): React.CSSProperties {
  const dash = Math.max(2, Math.round(face / 5));
  return {
    width: face,
    height: face,
    borderRadius: '50%',
    // edge dashes over a top-lit cylinder slice (only the bottom crescent shows)
    backgroundImage: `repeating-linear-gradient(90deg, rgba(255,255,255,0.5) 0 ${dash}px, rgba(255,255,255,0) ${dash}px ${dash * 2.6}px), linear-gradient(to bottom, ${p.light} 0%, ${p.base} 34%, ${p.dark} 100%)`,
    boxShadow:
      'inset 0 -1px 2px rgba(0,0,0,0.38), inset 0 1px 1px rgba(255,255,255,0.35)',
  };
}

function faceStyle(p: ChipPalette, face: number): React.CSSProperties {
  return {
    width: face,
    height: face,
    borderRadius: '50%',
    // bottom-up: solid body → dashed rim ring (shows only outside the inner
    // disc) → inner disc with a dark separation ring → specular gloss
    backgroundImage: `radial-gradient(circle at 30% 24%, rgba(255,255,255,0.62), rgba(255,255,255,0) 46%),
      radial-gradient(circle at 50% 52%, ${p.light} 0 20%, ${p.base} 21% 52%, ${p.dark} 53% 58%, rgba(0,0,0,0) 59%),
      repeating-conic-gradient(from 12deg, ${p.edge} 0 14deg, rgba(0,0,0,0.16) 14deg 45deg),
      linear-gradient(${p.base}, ${p.base})`,
    boxShadow:
      'inset 0 0 0 1px rgba(0,0,0,0.32), inset 0 -2px 3px rgba(0,0,0,0.28), inset 0 1.5px 2px rgba(255,255,255,0.4), 0 1px 2px rgba(0,0,0,0.35)',
  };
}

/** One vertical stack: ground shadow, side slices with a slight sway, glossy
 *  face chip on top. The pile is intentionally an approximate visual cue; the
 *  adjacent amount label carries the precise value. */
function ChipColumn({
  color,
  count,
  face,
  step,
  maxShown,
}: {
  color: ChipColor;
  count: number;
  face: number;
  step: number;
  maxShown: number;
}) {
  const p = CHIP_PALETTES[color];
  const shown = Math.min(count, maxShown);
  const height = (shown - 1) * step + face;
  return (
    <div className="relative shrink-0" style={{ width: face, height }}>
      {/* the pile sits on the felt: a soft contact shadow under the base */}
      <span
        aria-hidden="true"
        className="absolute left-1/2 rounded-[50%] bg-black/35 blur-[2px]"
        style={{ width: face * 0.92, height: face * 0.3, bottom: -Math.max(1.5, face * 0.12), transform: 'translateX(-50%)' }}
      />
      {Array.from({ length: shown }, (_, i) => {
        const top = i === shown - 1;
        const lean = (WOBBLE[i % WOBBLE.length] ?? 0) * face;
        return (
          <span
            key={i}
            aria-hidden="true"
            className="absolute left-0"
            style={{
              bottom: i * step,
              transform: lean ? `translateX(${lean.toFixed(1)}px)` : undefined,
              ...(top ? faceStyle(p, face) : sideStyle(p, face)),
            }}
          />
        );
      })}
    </div>
  );
}

export const ChipStack = memo(function ChipStack({
  amount,
  bb,
  sb,
  size = 'sm',
  className,
}: {
  amount: number;
  /** Big blind of the room; the SB unit derives from it unless `sb` overrides
   *  (standard structure: sb = bb/2 - see shared/lib/chips.ts). */
  bb: number;
  /** Explicit small-blind unit for non-standard structures. */
  sb?: number;
  size?: 'xs' | 'sm';
  className?: string;
}) {
  const unit = sb ?? sbFromBb(bb);
  // memoized: recompute only when an amount or the blind structure changes.
  const breakdown = useMemo(
    () => (amount > 0 ? chipBreakdown(amount, unit) : []),
    [amount, unit],
  );
  if (amount <= 0 || breakdown.length === 0) return null;
  const { face, step } = DIMS[size];
  return (
    <div
      className={cn('flex items-end gap-[3px]', className)}
      aria-hidden="true"
    >
      {breakdown.map((tier) => (
        <ChipColumn
          key={tier.color}
          color={tier.color}
          count={tier.count}
          face={face}
          step={step}
          maxShown={MAX_SHOWN}
        />
      ))}
    </div>
  );
});
