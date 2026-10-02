import { CardsThree, GearSix, Play, Receipt, Sliders, Timer } from '@phosphor-icons/react';
import { Link } from 'react-router-dom';
import { cn } from '../../shared/lib/cn.ts';
import { t } from '../../shared/i18n/index.ts';

/** The switches you actually touch between hands, moved out of the ⋮ menu and
 *  onto the top bar: auto-deal on/off, the turn timer, the two record pages
 *  you always reach for (出牌记录 and 账本) and a gear straight to Settings.
 *  P1 redesign: sit-out moved to the table-area dock (A9); when the top bar
 *  runs out of room (A1) labels drop and only icons stay. */

const chipClass =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-xl px-2.5 text-xs font-semibold text-slate-600 transition-[color,background-color,transform] duration-200 hover:bg-slate-200/70 hover:text-slate-900 active:scale-[0.97] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white';

const iconOnlyClass = 'w-8 justify-center px-0';

/** A miniature switch for the auto-deal chip, decorative: the button
 *  itself carries aria-pressed. */
function MiniSwitch({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors',
        on ? 'bg-indigo-600' : 'bg-slate-300 dark:bg-slate-600',
      )}
    >
      <span
        className={cn(
          'absolute left-0.5 size-3 rounded-full bg-white shadow-sm transition-transform',
          on && 'translate-x-3',
        )}
      />
    </span>
  );
}

export function TableQuickControls({
  roomId,
  isHost,
  autoDeal,
  autoDealPaused,
  actionSecs,
  timerDisabled,
  amSpectator,
  compact = false,
  onChangeAutoDeal,
  onOpenAutoDealDialog,
  onChangeActionSecs,
  onOpenGameplay,
}: {
  /** Same room the ⋮ menu's record links point at - they live here now. */
  roomId: string;
  isHost: boolean;
  autoDeal: boolean;
  /** The engine paused auto-deal (too few ready players) though it is on. */
  autoDealPaused: boolean;
  actionSecs: number;
  /** Mid-hand: a timer edit only lands from the next deal. */
  timerDisabled: boolean;
  amSpectator: boolean;
  /** A1: below the layout minimum, labels drop to icon-only. */
  compact?: boolean;
  onChangeAutoDeal: (value: boolean) => void;
  onOpenAutoDealDialog: () => void;
  onChangeActionSecs: (seconds: number) => void;
  /** P2 Lane F: host-only 「玩法规则」 entry that opens the GameplaySettings
   *  dialog (squid / time bank / bomb pot / multi-run). When the page cannot
   *  offer it (phones fold it into the dock instead), it stays undefined and
   *  the chip is not rendered. */
  onOpenGameplay?: () => void;
}) {
  return (
    <div
      role="group"
      aria-label={t('Table controls')}
      className="mx-1 flex items-center gap-1 rounded-2xl bg-slate-100/70 p-1 ring-1 ring-slate-200/50 dark:bg-slate-900/60 dark:ring-slate-800"
    >
      {!amSpectator && (
        <button
          type="button"
          onClick={() => (isHost ? onChangeAutoDeal(!autoDeal) : onOpenAutoDealDialog())}
          aria-pressed={autoDeal}
          title={isHost ? t('Auto-deal') : t('Only the host can change this room setting.')}
          className={cn(
            chipClass,
            compact && iconOnlyClass,
            autoDeal && !autoDealPaused && 'text-indigo-700 dark:text-indigo-300',
            autoDealPaused && 'text-amber-600 dark:text-amber-400',
          )}
        >
          <Play size={13} weight={autoDeal ? 'fill' : 'regular'} />
          {!compact && <span>{t('Auto-deal')}</span>}
          {!compact && <MiniSwitch on={autoDeal} />}
        </button>
      )}

      {isHost && (
        <label
          className={cn(
            chipClass,
            'cursor-default hover:bg-transparent dark:hover:bg-transparent',
            compact && 'w-auto px-1',
          )}
          title={timerDisabled ? t('Applies from the next hand') : t('Turn timer')}
        >
          <Timer size={14} />
          <select
            aria-label={t('Turn timer')}
            value={actionSecs}
            disabled={timerDisabled}
            onChange={(event) => onChangeActionSecs(+event.target.value)}
            className={cn(
              'cursor-pointer rounded-md bg-white px-1 py-1 text-xs font-semibold tabular-nums text-slate-700 ring-1 ring-slate-200/70 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700',
              compact ? 'w-14' : 'w-20',
            )}
          >
            {[15, 30, 45, 60, 90, 120].map((seconds) => (
              <option key={seconds} value={seconds}>
                {t('{n}s', { n: seconds })}
              </option>
            ))}
            <option value={0}>{t('No limit')}</option>
          </select>
        </label>
      )}

      {/* P2 玩法规则: the host edits squid / time bank / bomb pot / multi-run
          between hands - same rail as the switches you touch every hand. */}
      {isHost && onOpenGameplay && (
        <button
          type="button"
          onClick={onOpenGameplay}
          title={t('Gameplay rules')}
          aria-label={t('Gameplay rules')}
          className={cn(chipClass, compact && iconOnlyClass, 'text-fuchsia-700 dark:text-fuchsia-300')}
        >
          <Sliders size={15} />
          {!compact && <span>{t('Gameplay rules')}</span>}
        </button>
      )}

      {/* the two records you actually check between hands: 出牌记录 and 账本 */}
      <Link
        to={`/room/${roomId}/hands`}
        className={cn(chipClass, compact && iconOnlyClass)}
        title={t('Hand history')}
        aria-label={t('Hand history')}
      >
        <CardsThree size={15} />
        {!compact && <span>{t('Hand history')}</span>}
      </Link>
      <Link
        to={`/room/${roomId}/ledger`}
        className={cn(chipClass, compact && iconOnlyClass)}
        title={t('Ledger')}
        aria-label={t('Ledger')}
      >
        <Receipt size={15} />
        {!compact && <span>{t('Ledger')}</span>}
      </Link>

      <Link
        to="/settings"
        target="_blank"
        rel="noreferrer"
        className={cn(chipClass, iconOnlyClass)}
        title={t('Settings')}
        aria-label={t('Settings')}
      >
        <GearSix size={15} />
        <span className="sr-only">{t('(opens in a new tab)')}</span>
      </Link>
    </div>
  );
}
