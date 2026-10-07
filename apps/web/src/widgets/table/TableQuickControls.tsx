import { CardsThree, GearSix, Play, Robot, Sliders } from '@phosphor-icons/react';
import { Link } from 'react-router-dom';
import { cn } from '../../shared/lib/cn.ts';
import { t } from '../../shared/i18n/index.ts';

/** The switches you actually touch between hands, moved out of the ⋮ menu and
 *  onto the top bar: auto-deal on/off, the two record pages you always reach
 *  for (出牌记录 and 账本) and a gear straight to Settings.
 *  P1 redesign: sit-out moved to the table-area dock (A9); when the top bar
 *  runs out of room (A1) labels drop and only icons stay.
 *  The timer chip was removed by user request (「去掉右上角的时间牌」): the turn
 *  clock and time bank are fixed product settings, so the corner readout was
 *  pure decoration. The per-seat acting ring + drain bar still carry the live
 *  clock where it matters. */

const chipClass =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-xl px-2.5 text-xs font-semibold text-slate-600 transition-[color,background-color,transform] duration-200 hover:bg-slate-200/70 hover:text-slate-900 active:scale-[0.97] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white';

const iconOnlyClass = 'w-8 justify-center px-0';

export function TableQuickControls({
  roomId,
  isHost,
  autoDeal,
  autoDealPaused,
  amSpectator,
  compact = false,
  onChangeAutoDeal,
  onOpenAutoDealDialog,
  onOpenGameplay,
  onOpenBots,
  botCount = 0,
}: {
  /** Same room the ⋮ menu's record links point at - they live here now. */
  roomId: string;
  isHost: boolean;
  autoDeal: boolean;
  /** The engine paused auto-deal (too few ready players) though it is on. */
  autoDealPaused: boolean;
  amSpectator: boolean;
  /** A1: below the layout minimum, labels drop to icons-only. */
  compact?: boolean;
  onChangeAutoDeal: (value: boolean) => void;
  onOpenAutoDealDialog: () => void;
  /** P2 Lane F: host-only 「玩法规则」 entry that opens the GameplaySettings
   *  dialog (squid / bomb pot / multi-run - the time bank moved into the timer
   *  panel above). When the page cannot offer it (phones fold it into the dock
   *  instead), it stays undefined and the chip is not rendered. */
  onOpenGameplay?: () => void;
  /** Table bots: host-only 「机器人」 entry opening the BotsDialog. Phones fold
   *  it into the ⋮ menu instead, so it stays undefined there and the chip is
   *  not rendered. */
  onOpenBots?: () => void;
  /** Live bots in the room - a quiet count dot on the chip so the host sees
   *  「有机器人在打」 without opening anything. */
  botCount?: number;
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
             iconOnlyClass,
            autoDeal && !autoDealPaused && 'text-indigo-700 dark:text-indigo-300',
            autoDealPaused && 'text-amber-600 dark:text-amber-400',
          )}
        >
          <Play size={13} weight={autoDeal ? 'fill' : 'regular'} />
          <span className="sr-only">{t('Auto-deal')}</span>
        </button>
      )}

      {/* P2 玩法规则: the host edits squid / bomb pot / multi-run between
          hands - same rail as the switches you touch every hand. */}
      {isHost && onOpenGameplay && (
        <button
          type="button"
          onClick={onOpenGameplay}
          title={t('Gameplay rules')}
          aria-label={t('Gameplay rules')}
          className={cn(chipClass, compact && iconOnlyClass, 'text-[var(--table-gold-hi)]')}
        >
          <Sliders size={15} />
          {!compact && <span>{t('Gameplay')}</span>}
        </button>
      )}

      {/* Table bots: the host seats scripted opponents here. Cyan icon reads
          with the seat badges; the count dot shows live bots without opening
          the dialog. Phones take the same action from the ⋮ menu. */}
      {isHost && onOpenBots && (
        <button
          type="button"
          onClick={onOpenBots}
          title={t('Bot opponents')}
          aria-label={
            botCount > 0 ? t('Bot opponents - {n} at the table', { n: botCount }) : t('Bot opponents')
          }
          className={cn(chipClass, iconOnlyClass, 'relative text-[var(--table-stack)]')}
        >
          <Robot size={15} weight={botCount > 0 ? 'fill' : 'regular'} />
          {botCount > 0 && (
            <span
              aria-hidden
              className="absolute right-0.5 top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--table-stack)] px-0.5 font-display text-[0.55rem] font-black leading-none text-slate-950"
            >
              {botCount}
            </span>
          )}
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
