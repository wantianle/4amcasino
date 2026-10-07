import { memo, useMemo } from 'react';
import { cn } from '../../shared/lib/cn.ts';
import {
  CHIP_PALETTES,
  CHIP_TIERS,
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

/** Horizontal gap between columns, design-px. Named so the width budget reasons
 *  about the exact same number the flex `gap-[3px]` renders - no second source. */
const GAP = 3;

/** How many chips of ONE tier get drawn. The pile is an approximate visual
 *  only (no count badge); tuned for the street-bet pile so huge bets stay sane. */
const MAX_SHOWN = 4;

/** Deterministic side-to-side sway per slice (px, × face/14) so a pile reads
 *  as hand-stacked chips, not a perfect render. */
const WOBBLE = [0, 0.05, -0.06, 0.035, -0.045];

/** Below this fraction of the natural face a chip stops reading as a chip, so
 *  the fitter folds the lowest tiers into a `+N` marker instead of shrinking
 *  further. */
const MIN_FACE_RATIO = 0.6;

/** Number of denomination tiers the shared model can ever emit. Deriving the
 *  worst-case width from the data (not a blessed magic number) keeps the
 *  default budget honest if the palette ever grows. */
const TIER_COUNT = CHIP_TIERS.length;

/** The natural (uncompressed) width of a full pile, per size tier, in design-px.
 *  This is the value the default path renders today, and the baseline a caller
 *  who wants compression should undercut. */
export const CHIP_STACK_NATURAL_MAX_PX: Record<'xs' | 'sm', number> = {
  xs: TIER_COUNT * DIMS.xs.face + (TIER_COUNT - 1) * GAP,
  sm: TIER_COUNT * DIMS.sm.face + (TIER_COUNT - 1) * GAP,
};

/** The laid-out geometry of a pile once the width budget has been applied.
 *  Pure data so the fit is unit-testable without a DOM (jsdom has no layout). */
export interface ChipStackLayout {
  /** Effective chip face Ø, design-px (≤ the tier's natural face). */
  face: number;
  /** Effective gap between rendered items, design-px (≤ GAP). */
  gap: number;
  /** How many denomination columns are actually drawn (highest tiers first). */
  columns: number;
  /** Tiers folded into the `+N` marker; 0 = every denomination is shown. */
  overflow: number;
  /** Computed total width of the laid-out pile, design-px. */
  width: number;
  /** True when the pile had to give up any of its natural geometry. */
  compact: boolean;
}

/**
 * Fit a pile of `tierCount` denomination columns into `maxWidthPx` design-px.
 *
 * Deliberately deterministic and DOM-free so the invariant (rendered width ≤
 * budget) can be asserted under SSR/jsdom where `getBoundingClientRect()` has
 * no layout to measure. The ladder is:
 *   1. squeeze the gaps (keep every chip and every denomination);
 *   2. shrink the face, but never below the readable floor;
 *   3. fold the lowest tiers into one `+N` marker.
 *
 * With no `maxWidthPx` (or a budget the natural pile already fits) the natural
 * geometry is returned untouched - the default path is byte-for-byte the
 * current render, which is what keeps desktop at zero regression.
 */
export function fitChipStack(
  tierCount: number,
  size: 'xs' | 'sm',
  maxWidthPx?: number,
): ChipStackLayout {
  const { face: naturalFace } = DIMS[size];
  const n = Math.max(0, Math.floor(tierCount));
  const natural = n * naturalFace + Math.max(0, n - 1) * GAP;
  if (n === 0 || !maxWidthPx || maxWidthPx <= 0 || natural <= maxWidthPx) {
    return {
      face: naturalFace,
      gap: GAP,
      columns: n,
      overflow: 0,
      width: natural,
      compact: false,
    };
  }
  // 1) every column survives; only the air between them goes.
  if (n * naturalFace <= maxWidthPx) {
    const gap = n > 1 ? Math.max(0, Math.floor((maxWidthPx - n * naturalFace) / (n - 1))) : 0;
    return {
      face: naturalFace,
      gap,
      columns: n,
      overflow: 0,
      width: n * naturalFace + (n - 1) * gap,
      compact: gap < GAP,
    };
  }
  // 2) shrink the face, gaps already gone, down to the readable floor.
  const minFace = Math.max(3, Math.round(naturalFace * MIN_FACE_RATIO));
  const fitFace = Math.floor(maxWidthPx / n);
  if (fitFace >= minFace) {
    return { face: fitFace, gap: 0, columns: n, overflow: 0, width: fitFace * n, compact: true };
  }
  // 3) last resort: keep the readable floor and fold the lowest tiers into a
  //    single `+N` marker. `items` is every rendered child (columns + marker).
  const face = minFace;
  const slots = Math.max(0, Math.floor((maxWidthPx + GAP) / (face + GAP)));
  const columns = Math.min(n, Math.max(0, slots - 1));
  const overflow = n - columns;
  const items = columns + (overflow > 0 ? 1 : 0);
  const gap = items > 1 ? GAP : 0;
  return {
    face,
    gap,
    columns,
    overflow,
    width: items * face + Math.max(0, items - 1) * gap,
    compact: true,
  };
}

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
  maxWidthPx,
}: {
  amount: number;
  /** Big blind of the room; the SB unit derives from it unless `sb` overrides
   *  (standard structure: sb = bb/2 - see shared/lib/chips.ts). */
  bb: number;
  /** Explicit small-blind unit for non-standard structures. */
  sb?: number;
  size?: 'xs' | 'sm';
  className?: string;
  /** Optional width budget in design-px. Omitted = no compression at all, so
   *  every existing caller (pot + street bets) keeps its exact current render.
   *  Callers that need a phone/desktop budget pass the oracle-ratified number;
   *  this widget only owns the mechanism, not the threshold. */
  maxWidthPx?: number;
}) {
  const unit = sb ?? sbFromBb(bb);
  // memoized: recompute only when an amount or the blind structure changes.
  const breakdown = useMemo(
    () => (amount > 0 ? chipBreakdown(amount, unit) : []),
    [amount, unit],
  );
  if (amount <= 0 || breakdown.length === 0) return null;
  const layout = fitChipStack(breakdown.length, size, maxWidthPx);
  const columns = breakdown.slice(0, layout.columns);
  return (
    <div
      className={cn('flex items-end gap-[3px]', className)}
      // only when compact: overrides the class gap; absent on the default path
      style={layout.compact ? { gap: layout.gap } : undefined}
      aria-hidden="true"
      data-table-bet-stack=""
      data-chip-face={size}
      data-chip-columns={String(layout.columns)}
      data-chip-amount={String(amount)}
      data-chip-width={String(layout.width)}
      {...(layout.overflow > 0 ? { 'data-chip-overflow': String(layout.overflow) } : {})}
      {...(layout.compact ? { 'data-chip-compact': 'true' } : {})}
    >
      {columns.map((tier) => (
        <ChipColumn
          key={tier.color}
          color={tier.color}
          count={tier.count}
          face={layout.face}
          step={DIMS[size].step}
          maxShown={MAX_SHOWN}
        />
      ))}
      {layout.overflow > 0 && (
        <span
          aria-hidden="true"
          className="shrink-0 text-center font-bold leading-none text-[color:var(--table-gold-hi)]"
          style={{ width: layout.face, fontSize: Math.max(7, Math.round(layout.face * 0.62)) }}
        >
          +{layout.overflow}
        </span>
      )}
    </div>
  );
});
