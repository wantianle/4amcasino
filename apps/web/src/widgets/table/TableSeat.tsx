import type { CSSProperties, ReactNode, Ref } from 'react';
import { cn } from '../../shared/lib/cn.ts';

export type SeatHandMode = 'hidden' | 'showdown' | 'hero';

/** Keep the three visual hand states explicit at the seat boundary. */
export function seatHandMode({
  isHero,
  cardsVisible,
  revealed,
}: {
  isHero: boolean;
  cardsVisible: boolean;
  revealed: boolean;
}): SeatHandMode {
  if (isHero) return 'hero';
  if (cardsVisible && revealed) return 'showdown';
  return 'hidden';
}

/**
 * The one positioning boundary for a seat unit.
 *
 * RoundTable still owns the game-specific contents for now (the next layer
 * can move those concerns here incrementally), but avatar, cards, plaque and
 * status pills can no longer drift away from the same anchor. This component
 * intentionally emits the same single absolutely-positioned wrapper that the
 * inline implementation emitted before L2.
 */
export function TableSeat({
  seat,
  x,
  y,
  tx,
  ty,
  lift,
  heroTop,
  podRef,
  handMode,
  children,
}: {
  seat: number;
  x: number;
  y: number;
  tx: string;
  ty: string;
  lift?: string;
  heroTop?: boolean;
  podRef: Ref<HTMLDivElement>;
  handMode: SeatHandMode;
  children: ReactNode;
}) {
  const style = {
    left: `${x}%`,
    top: `${y}%`,
    transform: `translate(${tx}, ${ty}) translateY(${lift ?? 'var(--table-pod-lift, 0px)'})`,
  } satisfies CSSProperties;

  return (
    <div
      ref={podRef}
      className={cn(
        'absolute z-20 flex flex-col items-center gap-[4px]',
        heroTop && 'table-pod--hero-top',
      )}
      style={style}
      data-seat-anchor={seat}
      data-seat-hand-mode={handMode}
    >
      {children}
    </div>
  );
}
