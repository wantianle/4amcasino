import { motion } from 'motion/react';
import { ShareNetwork, Trophy, WarningCircle, X } from '@phosphor-icons/react';
import { cn } from '../../shared/lib/cn.ts';
import { t } from '../../shared/i18n/index.ts';

/** The whole post-hand recap is now a two-second glance: who took how much,
 *  with what, on one pill that steps aside by itself. The detail lives in the
 *  last-hand strip, in 出牌记录 (hand history) and in the replay - the table
 *  stays the table. Dismissible by X or Esc like the big panel it replaces. */
export function ResultFlash({
  headline,
  detail = null,
  aborted = false,
  onDismiss,
  onShare,
}: {
  headline: string;
  detail?: string | null;
  /** The hand was voided, not won: red, no trophy. */
  aborted?: boolean;
  onDismiss: () => void;
  /** Present only when a share card can actually be built from this result. */
  onShare?: () => void;
}) {
  const sideButton = cn(
    'shrink-0 rounded-full p-1.5 transition-colors',
    'text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200',
  );
  return (
    <motion.div
      role="status"
      aria-live="polite"
      initial={{ y: -10, opacity: 0, scale: 0.95 }}
      animate={{ y: 0, opacity: 1, scale: 1 }}
      transition={{ type: 'spring', stiffness: 420, damping: 30 }}
      className={cn(
        'pointer-events-auto flex max-w-full items-center gap-2 rounded-full py-1.5 pl-3 pr-1.5 backdrop-blur',
        'bg-white/95 text-slate-900 shadow-[0_14px_40px_rgba(15,23,42,0.18)] ring-1 ring-slate-200/80 dark:bg-slate-900/90 dark:text-white dark:shadow-[0_14px_40px_rgba(2,6,23,0.55)] dark:ring-white/10',
      )}
    >
      {aborted ? (
        <WarningCircle size={16} weight="fill" className="shrink-0 text-rose-500" />
      ) : (
        <Trophy size={16} weight="fill" className="shrink-0 text-amber-500" />
      )}
      <span className="min-w-0 truncate font-display text-sm font-bold">{headline}</span>
      {detail && (
        <span
          className={cn(
            // min-w-0 + shrink let the flex item take a bounded width so truncate
            // really ellipsizes; shrink-[2] makes the secondary detail yield to the
            // headline (and, above all, to the shrink-0 action buttons) when both
            // are long. A shrink-0 here pushed the pill past max-w-full and threw
            // the Dismiss/Share buttons off-screen.
            'min-w-0 shrink-[2] truncate text-xs',
            'text-slate-500 dark:text-slate-400',
          )}
        >
          {detail}
        </span>
      )}
      {onShare && (
        <button type="button" onClick={onShare} aria-label={t('Share')} title={t('Share')} className={sideButton}>
          <ShareNetwork size={14} />
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t('Dismiss result')}
        aria-keyshortcuts="Escape"
        title={t('Dismiss result (Esc)')}
        className={sideButton}
      >
        <X size={14} />
      </button>
    </motion.div>
  );
}
