import { Timer } from '@phosphor-icons/react';
import { cn } from '../../../shared/lib/cn.ts';
import { useNow } from '../hooks/useNow.ts';

/** The header countdown: the only component that ticks off `deadline`. */
function CountdownChip({ deadline, urgent }: { deadline: number; urgent: boolean }) {
  const now = useNow(500);
  const secs = Math.max(0, Math.ceil((deadline - now) / 1000));
  return (
    <span
      className={cn(
        'flex shrink-0 items-center gap-1.5 rounded-xl bg-slate-100 px-2.5 py-1.5 font-display text-sm font-semibold tabular-nums dark:bg-slate-900',
        urgent && 'animate-urgent bg-rose-50 text-rose-600 dark:bg-rose-950 dark:text-rose-300',
      )}
    >
      <Timer size={15} weight="bold" /> 0:{String(secs).padStart(2, '0')}
    </span>
  );
}

export { CountdownChip };
