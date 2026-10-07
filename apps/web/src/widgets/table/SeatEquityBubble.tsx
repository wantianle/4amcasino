import { cn } from '../../shared/lib/cn.ts';
import { t } from '../../shared/i18n/index.ts';

/** A seat's live all-in equity, as a translucent chat bubble pinned to the
 *  avatar. The advantaged side reads green, the rest red. Under 3% the exact
 *  number is replaced by "还有机会"; under 1% by "听死牌" (poker terminology),
 *  so a near-dead hand never shows a misleading precision. */
export function SeatEquityBubble({ bps, advantaged }: { bps: number; advantaged: boolean }) {
  const pct = (bps / 100).toFixed(2);
  const text = bps < 100 ? t('Drawing dead') : bps < 300 ? t('Still alive') : `${pct}%`;
  return (
    <span
      role="status"
      aria-label={t('Equity {pct}%', { pct })}
      className={cn(
        'table-equity-bubble',
        advantaged ? 'table-equity-bubble--over' : 'table-equity-bubble--under',
      )}
    >
      {text}
    </span>
  );
}
