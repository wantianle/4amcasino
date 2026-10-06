import { useEffect, useRef, useState } from 'react';
import {
  CardsThree,
  GearSix,
  Play,
  Robot,
  Sliders,
  Timer,
} from '@phosphor-icons/react';
import { Link } from 'react-router-dom';
import { cn } from '../../shared/lib/cn.ts';
import { t } from '../../shared/i18n/index.ts';

/** The switches you actually touch between hands, moved out of the ⋮ menu and
 *  onto the top bar: auto-deal on/off, the timer chip, the two record pages
 *  you always reach for (出牌记录 and 账本) and a gear straight to Settings.
 *  P1 redesign: sit-out moved to the table-area dock (A9); when the top bar
 *  runs out of room (A1) labels drop and only icons stay.
 *  P2 follow-up: the timer chip opens a compact panel. The turn clock and the
 *  time bank are now FIXED product settings (30s per turn; 5 time cards of 30s
 *  each, one more every 20 hands), so the panel is a read-only readout rather
 *  than a bank editor. */

const chipClass =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-xl px-2.5 text-xs font-semibold text-slate-600 transition-[color,background-color,transform] duration-200 hover:bg-slate-200/70 hover:text-slate-900 active:scale-[0.97] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white';

const iconOnlyClass = 'w-8 justify-center px-0';

/** The fixed turn clock, in seconds. The engine default is 30s and the host
 *  can no longer tune it (see hub.ts `defaultGameOpts`), so the popover is a
 *  display-only readout. */
const TURN_SECONDS = 30;
/** The fixed time bank: five 30s cards, refilled one per 20 hands. */
const TIME_BANK_CARDS = 5;
const TIME_BANK_REFILL_HANDS = 20;

/** The Timer chip + its popover. Both the per-turn clock and the time bank are
 *  fixed product settings now, so this is purely informational: no timer
 *  select, no bank fields, nothing to save - and therefore no room props to
 *  read the old `actionSecs` from. */
function TimerControl({
  compact,
}: {
  compact: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // outside click / Escape dismiss the panel
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onDown = (event: Event) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={t('Turn timer')}
        className={cn(chipClass, compact && 'px-1.5', 'text-amber-600 dark:text-amber-400')}
      >
        <Timer size={14} />
        <span className="tabular-nums">{t('{n}s', { n: TURN_SECONDS })}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t('Turn timer')}
          className="absolute left-0 top-full z-40 mt-1.5 w-72 rounded-xl border border-slate-200 bg-white p-3 shadow-xl ring-1 ring-black/5 dark:border-slate-700 dark:bg-slate-900"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
              {t('Turn timer')}
            </span>
            <span className="font-display text-sm font-semibold tabular-nums">
              {t('{n}s', { n: TURN_SECONDS })}
            </span>
          </div>
          <p className="mt-1 text-[0.65rem] leading-snug text-slate-400 dark:text-slate-500">
            {t('Fixed at {n}s - the host cannot change it.', { n: TURN_SECONDS })}
          </p>

          <div aria-hidden className="my-3 h-px bg-slate-100 dark:bg-slate-800" />

          <div className="flex items-baseline justify-between gap-2">
            <span className="block font-display text-sm font-semibold">{t('Time bank')}</span>
            <span className="font-display text-sm font-semibold tabular-nums text-amber-600 dark:text-amber-400">
              {t('{cards} × {n}s', { cards: TIME_BANK_CARDS, n: TURN_SECONDS })}
            </span>
          </div>
          <p className="mt-1 text-[0.65rem] leading-snug text-slate-400 dark:text-slate-500">
            {t(
              '{cards} time cards of {n}s: one to start, one more every {hands} hands. An empty bank folds for you.',
              { cards: TIME_BANK_CARDS, n: TURN_SECONDS, hands: TIME_BANK_REFILL_HANDS },
            )}
          </p>
        </div>
      )}
    </div>
  );
}

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

      {/* 计时 chip: a read-only readout of the fixed 30s turn clock and the
          fixed time bank (hosts can no longer change either). */}
      {!amSpectator && <TimerControl compact={compact} />}

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
