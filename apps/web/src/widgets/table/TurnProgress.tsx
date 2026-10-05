import { useEffect, useRef } from 'react';
import { useStore } from '../../shared/store.ts';
import { cn } from '../../shared/lib/cn.ts';
import { ACTION_TIMEOUT_MS } from '../../shared/lib/tableTimers.ts';
import { t } from '../../shared/i18n/index.ts';

/**
 * Draining time bar for the seat currently facing action.
 * rAF-driven and self-contained so the 60fps updates never re-render the table.
 *
 * P2 B2 (docs/p2-gameplay-design.md): the bar is SEGMENTED when the room runs
 * a time bank. The base clock (action timeout up to `baseDeadline`) drains
 * first in table gold (L2 — was indigo); only after it empties does the amber
 * bank segment drain, for exactly as long as `finalDeadline - baseDeadline` -
 * the bank this seat walked into the turn with. Rooms without the feature keep
 * the single-segment bar.
 */
export function TurnProgress({ className, seat }: { className?: string; seat?: number }) {
  const baseRef = useRef<HTMLDivElement>(null);
  const bankRef = useRef<HTMLDivElement>(null);
  const deadline = useStore((s) => s.hand.deadline);
  const baseDeadline = useStore((s) => s.hand.baseDeadline);
  const totalMs = useStore((s) => s.room?.room.actionTimeoutMs ?? ACTION_TIMEOUT_MS);

  useEffect(() => {
    if (!deadline || !baseRef.current) return;
    // Bank window for THIS turn: whatever the final deadline reaches beyond
    // the base clock. Zero (single-segment bar) when the feature is off or
    // this seat walks onto the clock with an empty bank.
    const bankMs = baseDeadline ? Math.max(0, deadline - baseDeadline) : 0;
    const window = totalMs + bankMs;
    let raf = 0;
    const tick = () => {
      const now = Date.now();
      const remaining = Math.max(0, deadline - now);
      const baseLeft = baseDeadline
        ? Math.max(0, Math.min(baseDeadline - now, totalMs))
        : remaining;
      const bankLeft = baseDeadline
        ? Math.max(0, deadline - Math.max(now, baseDeadline))
        : 0;
      const base = baseRef.current;
      const bank = bankRef.current;
      // L5: drain via transform (scaleX) only - never width/top - so the
      // 60fps updates stay on the compositor. The 1px base/bank divider is
      // reproduced by translating the bank fill one pixel past the base.
      if (base) {
        const baseFrac = baseLeft / window;
        base.style.transform = `scaleX(${baseFrac})`;
        base.classList.toggle('table-timer-hot', remaining <= 10_000);
        base.classList.toggle('table-timer-base', remaining > 10_000);
        if (bank) {
          bank.style.transform = `translateX(calc(${baseFrac * 100}% + 1px)) scaleX(${bankLeft / window})`;
          bank.classList.toggle('table-timer-hot', remaining <= 10_000);
        }
      }
      if (remaining > 0) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // `seat` resets the effect when the bar hops to another player mid-hand.
  }, [deadline, baseDeadline, totalMs, seat]);

  if (!deadline) return null;
  const segmented = baseDeadline !== null && baseDeadline < deadline;
  return (
    <div
      className={cn(
        'table-timer-track absolute inset-x-3 bottom-1 h-1 overflow-hidden rounded-full',
        className,
      )}
      role="progressbar"
      aria-label={segmented ? t('Base clock then time bank remaining') : t('time remaining to act')}
      title={segmented ? t('The base clock drains first, then the time bank.') : undefined}
    >
      <div
        ref={baseRef}
        style={{ transform: 'scaleX(0)' }}
        className="table-timer-base absolute inset-y-0 left-0 w-full origin-left transition-colors"
      />
      {segmented && (
        <div
          ref={bankRef}
          style={{ transform: 'translateX(0) scaleX(0)' }}
          className="table-timer-bank absolute inset-y-0 left-0 w-full origin-left transition-colors"
        />
      )}
    </div>
  );
}
