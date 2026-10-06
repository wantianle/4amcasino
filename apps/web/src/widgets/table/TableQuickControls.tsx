import { useEffect, useRef, useState } from 'react';
import {
  TIME_BANK_REFILL_EVERY_HANDS_MAX,
  TIME_BANK_REFILL_EVERY_HANDS_MIN,
  TIME_BANK_SECONDS_MAX,
  TIME_BANK_SECONDS_MIN,
  type RoomGameplaySettings,
} from '@4am/shared';
import {
  CardsThree,
  GearSix,
  Play,
  Robot,
  Sliders,
  Timer,
} from '@phosphor-icons/react';
import { Link } from 'react-router-dom';
import {
  Field,
  Switch,
  cloneGameplaySettings,
  useFeatureSaveQueue,
} from '../../features/table/GameplaySettingsDialog.tsx';
import { api } from '../../shared/api.ts';
import { cn } from '../../shared/lib/cn.ts';
import { t } from '../../shared/i18n/index.ts';

/** The switches you actually touch between hands, moved out of the ⋮ menu and
 *  onto the top bar: auto-deal on/off, the timer chip, the two record pages
 *  you always reach for (出牌记录 and 账本) and a gear straight to Settings.
 *  P1 redesign: sit-out moved to the table-area dock (A9); when the top bar
 *  runs out of room (A1) labels drop and only icons stay.
 *  P2 follow-up: the timer chip opens a compact panel holding the 行动计时
 *  select AND the 计时银行 settings - the bank moved out of the gameplay
 *  dialog because it is a between-hands knob the host touches far more often
 *  than the exotic rules. Non-hosts open the same panel read-only. */

const chipClass =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-xl px-2.5 text-xs font-semibold text-slate-600 transition-[color,background-color,transform] duration-200 hover:bg-slate-200/70 hover:text-slate-900 active:scale-[0.97] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white';

const iconOnlyClass = 'w-8 justify-center px-0';

const ghostBtnClass =
  'rounded-lg px-2 py-1 text-xs font-semibold text-slate-500 transition-colors hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-400 dark:hover:text-slate-200';

const primaryBtnClass =
  'rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50';

/** The Timer chip + its popover: the per-hand action timer and the time bank.
 *
 *  The bank save goes through `useFeatureSaveQueue` (see GameplaySettings-
 *  Dialog.tsx): the server only accepts feature writes between hands (409
 *  during a hand, and it does not queue them itself), so a mid-hand click
 *  queues the change client-side and flushes it at the next boundary. The
 *  queue is deliberately dropped when the panel closes - nothing writes while
 *  nobody is watching. */
function TimerControl({
  roomId,
  isHost,
  actionSecs,
  timerDisabled,
  compact,
  onChangeActionSecs,
}: {
  roomId: string;
  isHost: boolean;
  actionSecs: number;
  /** Mid-hand: a timer edit only lands from the next deal. */
  timerDisabled: boolean;
  compact: boolean;
  onChangeActionSecs: (seconds: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [stored, setStored] = useState<RoomGameplaySettings | null>(null);
  const [draft, setDraft] = useState<RoomGameplaySettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const queue = useFeatureSaveQueue({
    roomId,
    handActive: timerDisabled,
    onSaved: (features) => {
      const canonical = cloneGameplaySettings(features);
      setStored(canonical);
      setDraft(canonical);
    },
  });

  const dirty =
    !!draft && !!stored && JSON.stringify(draft.timeBank) !== JSON.stringify(stored.timeBank);

  // outside click / Escape dismiss the panel; closing drops any queued write
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

  function toggle() {
    const next = !open;
    setOpen(next);
    if (!next) {
      queue.cancel();
      return;
    }
    // Re-read the stored rules on the way in - the panel edits whatever the
    // server has right now, not the copy from page load.
    setLoadError(null);
    api
      .getRoom(roomId)
      .then((r) => {
        const f = (r as { features?: RoomGameplaySettings }).features;
        if (!f) {
          setLoadError(t('could not load room settings'));
          return;
        }
        const seed = cloneGameplaySettings(f);
        setStored(seed);
        setDraft(seed);
      })
      .catch((e: unknown) =>
        setLoadError(e instanceof Error ? e.message : t('could not load room settings')),
      );
  }

  const bank = draft?.timeBank;
  const setTimeBank = (p: Partial<RoomGameplaySettings['timeBank']>) =>
    draft && setDraft({ ...draft, timeBank: { ...draft.timeBank, ...p } });

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={t('Turn timer & time bank')}
        className={cn(
          chipClass,
          compact && 'px-1.5',
          stored?.timeBank.enabled && 'text-amber-600 dark:text-amber-400',
        )}
      >
        <Timer size={14} />
        <span className="tabular-nums">
          {actionSecs === 0 ? t('No limit') : t('{n}s', { n: actionSecs })}
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t('Turn timer & time bank')}
          className="absolute left-0 top-full z-40 mt-1.5 w-72 rounded-xl border border-slate-200 bg-white p-3 shadow-xl ring-1 ring-black/5 dark:border-slate-700 dark:bg-slate-900"
        >
          {/* the 行动计时 select that used to sit bare on the bar */}
          <label className="block text-sm">
            <span className="mb-1 flex items-baseline justify-between gap-2">
              <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                {t('Turn timer')}
              </span>
              {isHost && timerDisabled && (
                <span className="text-[0.65rem] text-amber-600 dark:text-amber-400">
                  {t('Applies from the next hand')}
                </span>
              )}
            </span>
            <select
              aria-label={t('Turn timer')}
              value={actionSecs}
              disabled={!isHost || timerDisabled}
              onChange={(event) => onChangeActionSecs(+event.target.value)}
              className="min-h-9 w-full cursor-pointer rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm font-semibold tabular-nums text-slate-700 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              {[15, 30, 45, 60, 90, 120].map((seconds) => (
                <option key={seconds} value={seconds}>
                  {t('{n}s', { n: seconds })}
                </option>
              ))}
              <option value={0}>{t('No limit')}</option>
            </select>
          </label>

          <div aria-hidden className="my-3 h-px bg-slate-100 dark:bg-slate-800" />

          {/* 计时银行: moved out of the gameplay dialog - this is the high-
              frequency knob now. Fields reuse the dialog's primitives. */}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <span className="block font-display text-sm font-semibold">{t('Time bank')}</span>
              <span className="block text-[0.65rem] leading-snug text-slate-500 dark:text-slate-400">
                {t('The regular timer runs down first; an empty bank folds for you.')}
              </span>
            </div>
            <Switch
              checked={!!bank?.enabled}
              disabled={!isHost || !draft || queue.saving}
              onChange={(v) => setTimeBank({ enabled: v })}
              label={t('Enable time bank')}
            />
          </div>

          {bank?.enabled && (
            <div className="mt-2.5 grid grid-cols-2 gap-2.5">
              <Field
                label={t('Starting bank')}
                unit={t('seconds')}
                min={TIME_BANK_SECONDS_MIN}
                max={TIME_BANK_SECONDS_MAX}
                value={bank.initialSeconds}
                disabled={!isHost || queue.saving}
                onChange={(n) => setTimeBank({ initialSeconds: n })}
              />
              <Field
                label={t('Refill amount')}
                unit={t('seconds')}
                min={TIME_BANK_SECONDS_MIN}
                max={TIME_BANK_SECONDS_MAX}
                value={bank.refillSeconds}
                disabled={!isHost || queue.saving}
                onChange={(n) => setTimeBank({ refillSeconds: n })}
              />
              <div className="col-span-2">
                <Field
                  label={t('Refill every')}
                  unit={t('hands')}
                  min={TIME_BANK_REFILL_EVERY_HANDS_MIN}
                  max={TIME_BANK_REFILL_EVERY_HANDS_MAX}
                  value={bank.refillEveryHands}
                  disabled={!isHost || queue.saving}
                  onChange={(n) => setTimeBank({ refillEveryHands: n })}
                />
              </div>
            </div>
          )}

          <div aria-live="polite" className="mt-2 min-h-4 text-xs">
            {loadError ? (
              <p role="alert" className="text-rose-600 dark:text-rose-400">
                {loadError}
              </p>
            ) : queue.error ? (
              <p role="alert" className="text-rose-600 dark:text-rose-400">
                {queue.error}
              </p>
            ) : queue.saved ? (
              <p className="text-emerald-600 dark:text-emerald-400">{t('Saved.')}</p>
            ) : queue.queued ? (
              <p className="text-amber-600 dark:text-amber-400">
                {t('Queued — saves as soon as this hand ends.')}
              </p>
            ) : !isHost ? (
              <p className="text-slate-500 dark:text-slate-400">
                {t('Only the host can change the timer settings.')}
              </p>
            ) : null}
          </div>

          {isHost && (
            <div className="mt-1.5 flex items-center justify-end gap-1.5">
              {queue.queued && (
                <button type="button" onClick={queue.cancel} className={ghostBtnClass}>
                  {t('Cancel queue')}
                </button>
              )}
              <button
                type="button"
                disabled={!dirty || queue.saving}
                onClick={() => {
                  if (stored) setDraft(cloneGameplaySettings(stored));
                  queue.cancel();
                }}
                className={ghostBtnClass}
              >
                {t('Discard')}
              </button>
              <button
                type="button"
                disabled={!dirty || queue.saving}
                onClick={() => draft && queue.submit({ timeBank: draft.timeBank })}
                className={primaryBtnClass}
              >
                {queue.saving ? t('Saving…') : t('Save changes')}
              </button>
            </div>
          )}

          {dirty && bank?.enabled && !queue.queued && (
            <p className="mt-2 text-[0.65rem] leading-snug text-slate-400">
              {t('Change these numbers and every bank resets to the new start.')}
            </p>
          )}
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
  actionSecs,
  timerDisabled,
  amSpectator,
  compact = false,
  onChangeAutoDeal,
  onOpenAutoDealDialog,
  onChangeActionSecs,
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
  actionSecs: number;
  /** Mid-hand: a timer edit only lands from the next deal. */
  timerDisabled: boolean;
  amSpectator: boolean;
  /** A1: below the layout minimum, labels drop to icons-only. */
  compact?: boolean;
  onChangeAutoDeal: (value: boolean) => void;
  onOpenAutoDealDialog: () => void;
  onChangeActionSecs: (seconds: number) => void;
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

      {/* 计时 chip: opens the compact panel with the action timer select and
          the time bank (P3: the bank is a between-hands knob, not exotic
          rules - it lives on the rail now). Host edits; players read. */}
      {!amSpectator && (
        <TimerControl
          roomId={roomId}
          isHost={isHost}
          actionSecs={actionSecs}
          timerDisabled={timerDisabled}
          compact={compact}
          onChangeActionSecs={onChangeActionSecs}
        />
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
