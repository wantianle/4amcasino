import { CardsThree, GearSix, PauseCircle, Play, Receipt, Timer } from '@phosphor-icons/react';
import { Link } from 'react-router-dom';
import { cn } from '../../shared/lib/cn.ts';
import { t } from '../../shared/i18n/index.ts';

/** The switches you actually touch between hands, moved out of the ⋮ menu and
 *  onto the top bar: auto-deal on/off, sit out for the next hand, the turn
 *  timer, the two record pages you always reach for (出牌记录 and 账本) and a
 *  gear straight to Settings. Rendered on the desktop header only - the mobile
 *  sheet keeps its compact list variant of the same. */

const chipClass =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-xl px-2.5 text-xs font-semibold text-slate-600 transition-[color,background-color,transform] duration-200 hover:bg-slate-200/70 hover:text-slate-900 active:scale-[0.97] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white';

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
  hasSeat,
  sittingOut,
  sitOutDisabled,
  actionSecs,
  timerDisabled,
  amSpectator,
  onChangeAutoDeal,
  onOpenAutoDealDialog,
  onToggleSitOut,
  onChangeActionSecs,
}: {
  /** Same room the ⋮ menu's record links point at - they live here now. */
  roomId: string;
  isHost: boolean;
  autoDeal: boolean;
  /** The engine paused auto-deal (too few ready players) though it is on. */
  autoDealPaused: boolean;
  hasSeat: boolean;
  sittingOut: boolean;
  /** Socket down: sit-out rides the WS, so it waits for a reconnect. */
  sitOutDisabled: boolean;
  actionSecs: number;
  /** Mid-hand: a timer edit only lands from the next deal. */
  timerDisabled: boolean;
  amSpectator: boolean;
  onChangeAutoDeal: (value: boolean) => void;
  onOpenAutoDealDialog: () => void;
  onToggleSitOut: () => void;
  onChangeActionSecs: (seconds: number) => void;
}) {
  return (
    <div
      role="group"
      aria-label={t('Table controls')}
      className="mx-1 flex flex-wrap items-center gap-1 rounded-2xl bg-slate-100/70 p-1 ring-1 ring-slate-200/50 dark:bg-slate-900/60 dark:ring-slate-800"
    >
      {!amSpectator && (
        <button
          type="button"
          onClick={() => (isHost ? onChangeAutoDeal(!autoDeal) : onOpenAutoDealDialog())}
          aria-pressed={autoDeal}
          title={isHost ? t('Auto-deal') : t('Only the host can change this room setting.')}
          className={cn(
            chipClass,
            autoDeal && !autoDealPaused && 'text-indigo-700 dark:text-indigo-300',
            autoDealPaused && 'text-amber-600 dark:text-amber-400',
          )}
        >
          <Play size={13} weight={autoDeal ? 'fill' : 'regular'} />
          <span>{t('Auto-deal')}</span>
          <MiniSwitch on={autoDeal} />
        </button>
      )}

      {hasSeat && (
        <button
          type="button"
          onClick={onToggleSitOut}
          disabled={sitOutDisabled}
          aria-pressed={sittingOut}
          title={t('Sit out next hand')}
          className={cn(
            chipClass,
            sittingOut &&
              'bg-amber-100 text-amber-700 hover:bg-amber-100 dark:bg-amber-950 dark:text-amber-300',
            sitOutDisabled && 'opacity-50',
          )}
        >
          <PauseCircle size={14} />
          <span>{sittingOut ? t('Deal me back in') : t('Sit out next hand')}</span>
        </button>
      )}

      {isHost && (
        <label
          className={cn(chipClass, 'cursor-default hover:bg-transparent dark:hover:bg-transparent')}
          title={timerDisabled ? t('Applies from the next hand') : t('Turn timer')}
        >
          <Timer size={14} />
          <select
            aria-label={t('Turn timer')}
            value={actionSecs}
            disabled={timerDisabled}
            onChange={(event) => onChangeActionSecs(+event.target.value)}
            className="w-20 cursor-pointer rounded-md bg-white px-1 py-1 text-xs font-semibold tabular-nums text-slate-700 ring-1 ring-slate-200/70 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700"
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

      {/* the two records you actually check between hands: 出牌记录 and 账本 */}
      <Link
        to={`/room/${roomId}/hands`}
        className={chipClass}
        title={t('Hand history')}
        aria-label={t('Hand history')}
      >
        <CardsThree size={15} />
        <span>{t('Hand history')}</span>
      </Link>
      <Link
        to={`/room/${roomId}/ledger`}
        className={chipClass}
        title={t('Ledger')}
        aria-label={t('Ledger')}
      >
        <Receipt size={15} />
        <span>{t('Ledger')}</span>
      </Link>

      <Link to="/settings" target="_blank" rel="noreferrer" className={chipClass} title={t('Settings')}>
        <GearSix size={15} />
        <span className="sr-only">{t('Settings')}</span>
        <span className="sr-only">{t('(opens in a new tab)')}</span>
      </Link>
    </div>
  );
}
