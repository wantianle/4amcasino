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
 *  shaded side slices with a striped, glossy face chip capping the pile. The
 *  same widget draws each player's committed stack on the felt and the center
 *  pot, so both share one design language.
 *
 *  Requested by notpritam (docs/FEATURES.md); the dimensional redesign is user
 *  feedback on the P1 table ("nicer, smaller, color denominations"). */

/** A taller tier is drawn truncated with a ×n tail marker so a big pot never
 *  grows into the board. The number beside the pile stays exact. */
const MAX_CHIPS_SHOWN = 5;

/** face Ø / per-chip slice height in px - deliberately tiny; the value label
 *  carries precision, the pile only needs to read as "chips". */
const DIMS = {
  sm: { face: 14, step: 3 },
  lg: { face: 20, step: 5 },
} as const;

function sideStyle(p: ChipPalette, face: number): React.CSSProperties {
  const dash = Math.max(2, Math.round(face / 6));
  return {
    width: face,
    height: face,
    borderRadius: '50%',
    // dashes (chip edge markings) over a top-lit cylinder slice
    backgroundImage: `repeating-linear-gradient(90deg, rgba(255,255,255,0.45) 0 ${dash}px, rgba(255,255,255,0) ${dash}px ${dash * 3}px), linear-gradient(to bottom, ${p.light} 0%, ${p.base} 40%, ${p.dark} 100%)`,
    boxShadow: 'inset 0 -1px 2px rgba(0,0,0,0.3), inset 0 1px 1px rgba(255,255,255,0.4)',
  };
}

function faceStyle(p: ChipPalette, face: number): React.CSSProperties {
  return {
    width: face,
    height: face,
    borderRadius: '50%',
    backgroundImage: `radial-gradient(circle at 32% 26%, rgba(255,255,255,0.75), rgba(255,255,255,0) 46%),
      radial-gradient(circle at 50% 50%, ${p.base} 0 50%, rgba(0,0,0,0.18) 51% 55%, rgba(0,0,0,0) 56%),
      repeating-conic-gradient(from 18deg, ${p.edge} 0 16deg, ${p.dark} 16deg 45deg)`,
    boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.28), 0 2px 4px rgba(0,0,0,0.35)',
  };
}

/** One vertical stack: side slices, glossy face chip on top, ×n tail when the
 *  true count is taller than what gets drawn. */
function ChipColumn({
  color,
  count,
  face,
  step,
}: {
  color: ChipColor;
  count: number;
  face: number;
  step: number;
}) {
  const p = CHIP_PALETTES[color];
  const shown = Math.min(count, MAX_CHIPS_SHOWN);
  const height = (shown - 1) * step + face;
  return (
    <div className="relative shrink-0" style={{ width: face, height }}>
      {Array.from({ length: shown }, (_, i) => {
        const top = i === shown - 1;
        return (
          <span
            key={i}
            aria-hidden="true"
            className="absolute left-0"
            style={{
              bottom: i * step,
              ...(top ? faceStyle(p, face) : sideStyle(p, face)),
            }}
          />
        );
      })}
      {count > shown && (
        <span className="absolute -right-0.5 -top-1.5 font-display text-[0.5rem] font-bold tabular-nums text-white/90 drop-shadow-[0_1px_1px_rgba(0,0,0,0.9)] dark:text-slate-100">
          ×{count}
        </span>
      )}
    </div>
  );
}

export function ChipStack({
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
  size?: 'sm' | 'lg';
  className?: string;
}) {
  if (amount <= 0) return null;
  const unit = sb ?? sbFromBb(bb);
  const breakdown = chipBreakdown(amount, unit);
  const { face, step } = DIMS[size];
  return (
    <div className={cn('flex items-end gap-[3px] pb-0.5', className)} aria-hidden="true">
      {breakdown.map((tier) => (
        <ChipColumn key={tier.color} color={tier.color} count={tier.count} face={face} step={step} />
      ))}
    </div>
  );
}
