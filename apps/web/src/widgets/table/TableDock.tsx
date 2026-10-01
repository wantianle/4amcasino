import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { ChatCircle, PauseCircle, Trophy, X } from '@phosphor-icons/react';
import { cn, fmt } from '../../shared/lib/cn.ts';
import { t } from '../../shared/i18n/index.ts';
import type { LeaderboardRow } from '../../pages/leaderboard/LeaderboardPage.tsx';

/** P1 table redesign (docs/table-redesign-spec.md):
 *  - A6: rankings and chat are no longer a right column - they are buttons in
 *    the table area that open popover panels over the felt.
 *  - A9: 「下一手休息」(sit out next hand) lives at the BOTTOM-LEFT of the
 *    table area.
 *  The dock anchors to the bottom-left corner of the table section. */

const glassChip =
  'inline-flex items-center gap-1.5 rounded-full bg-white/85 px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200/70 backdrop-blur transition-[color,background-color,transform] duration-200 hover:bg-white hover:text-slate-950 active:scale-[0.97] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 dark:bg-slate-900/80 dark:text-slate-200 dark:ring-slate-700/70 dark:hover:bg-slate-800 dark:hover:text-white';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]';

/**
 * Review fixes #6 + #7:
 * - the keydown/trap effect runs ONCE on mount (deps []), reading the close
 *   handler and the trigger ref through stable refs - so an inline callback
 *   that changes identity on every TablePage re-render can never re-fire the
 *   effect and steal focus mid-typing;
 * - Escape closes, Tab is trapped inside the panel, and on close focus goes
 *   back to the dock button that opened the panel;
 * - the panel carries a stable id the trigger references via aria-controls.
 */
function Popover({
  panelId,
  label,
  onClose,
  restoreFocusTo,
  children,
  className,
}: {
  panelId: string;
  label: string;
  onClose: () => void;
  restoreFocusTo: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
  className?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const restoreRef = useRef(restoreFocusTo);
  restoreRef.current = restoreFocusTo;

  useEffect(() => {
    const panel = panelRef.current;
    // start on the panel itself, not its first control: chat keeps the cursor
    // out of the input until the user chooses to type
    panel?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getClientRects().length > 0,
      );
      if (nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      // #6: restore focus to the trigger that opened this panel
      restoreRef.current.current?.focus();
    };
    // mount/unmount only - the stable refs above keep behaviour current
    // without making identity churn re-run (and steal focus on) every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      id={panelId}
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-label={label}
      data-poker-hotkeys-blocked
      className={cn(
        'pointer-events-auto absolute bottom-full left-0 z-40 mb-2 overflow-hidden rounded-2xl bg-white shadow-[0_20px_60px_rgba(15,23,42,0.22)] ring-1 ring-slate-200 outline-none dark:bg-slate-900 dark:ring-slate-700',
        className,
      )}
    >
      {children}
    </div>
  );
}

const RANK_PANEL_ID = 'table-rank-popover';
const CHAT_PANEL_ID = 'table-chat-popover';

export function TableDock({
  compact,
  hasSeat,
  sittingOut,
  sitOutDisabled,
  onToggleSitOut,
  rankOpen,
  onToggleRank,
  onClosePopovers,
  standings,
  minSettleHands,
  chatOpen,
  onToggleChat,
  unread,
  chatBody,
  balance,
  shortcut,
}: {
  /** Narrow viewport: labels drop out, icons carry the meaning (A1). */
  compact: boolean;
  hasSeat: boolean;
  sittingOut: boolean;
  sitOutDisabled: boolean;
  onToggleSitOut: () => void;
  rankOpen: boolean;
  onToggleRank: () => void;
  /** Closes both popovers; Escape and the X buttons use it, so closing from
   *  inside the panel never leaves the other one's state stale. */
  onClosePopovers: () => void;
  standings: LeaderboardRow[] | null;
  minSettleHands: number;
  chatOpen: boolean;
  onToggleChat: () => void;
  unread: number;
  /** The chat panel (input + quick phrases + stickers) - supplied by the page. */
  chatBody: ReactNode;
  /** Feedback #3: the account balance chip, folded out of the deleted bottom
   *  box into the bottom-left dock column. */
  balance?: ReactNode;
  /** Feedback #3: 「快捷键」 as its own standalone button, bottom-left. */
  shortcut?: ReactNode;
}) {
  const rankTriggerRef = useRef<HTMLButtonElement>(null);
  const chatTriggerRef = useRef<HTMLButtonElement>(null);
  // NOTE: the click-away catcher is NOT here - the page renders one over the
  // felt only (z-20), so the action bar stays live while a popover is open.
  return (
    <div className="pointer-events-none absolute bottom-2 left-2 z-30 flex flex-col items-start gap-1.5">
      {rankOpen && (
        <Popover
          panelId={RANK_PANEL_ID}
          label={t('Standings')}
          onClose={onClosePopovers}
          restoreFocusTo={rankTriggerRef}
          className="w-[min(20rem,92vw)]"
        >
          <div className="flex items-center justify-between border-b border-slate-100 px-3.5 py-2.5 dark:border-slate-800">
            <h2 className="font-display text-sm font-semibold">{t('Standings')}</h2>
            <button
              type="button"
              onClick={onClosePopovers}
              aria-label={t('Close')}
              className="rounded-md p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <X size={14} />
            </button>
          </div>
          <div className="max-h-[34dvh] overflow-y-auto p-2.5">
            {standings === null ? (
              <p className="px-1.5 py-2 text-xs text-slate-400">{t('Counting chips…')}</p>
            ) : standings.length === 0 ? (
              <p className="px-1.5 py-2 text-xs text-slate-400">
                {t('No completed hands yet. Deal one and check back.')}
              </p>
            ) : (
              <StandingsList rows={standings} minHands={minSettleHands} />
            )}
          </div>
        </Popover>
      )}

      {chatOpen && (
        <Popover
          panelId={CHAT_PANEL_ID}
          label={t('Table chat')}
          onClose={onClosePopovers}
          restoreFocusTo={chatTriggerRef}
          className="w-[min(21rem,94vw)]"
        >
          <div className="flex items-center justify-between border-b border-slate-100 px-3.5 py-2.5 dark:border-slate-800">
            <h2 className="font-display text-sm font-semibold">{t('Table chat')}</h2>
            <button
              type="button"
              onClick={onClosePopovers}
              aria-label={t('Close chat')}
              className="rounded-md p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <X size={14} />
            </button>
          </div>
          <div className="h-[min(26rem,52dvh)]">{chatBody}</div>
        </Popover>
      )}

      <div className="pointer-events-auto relative z-40 flex flex-col items-start gap-1.5">
        {/* feedback #3: balance chip + the standalone 「快捷键」 button join the
            dock column, so everything the old bottom box carried is reachable */}
        {balance}
        {shortcut}
        {/* A9: sit-out for the next hand, bottom-left of the table area */}
        {hasSeat && (
          <button
            type="button"
            onClick={onToggleSitOut}
            disabled={sitOutDisabled}
            aria-pressed={sittingOut}
            title={sittingOut ? t('Deal me back in') : t('Sit out next hand')}
            className={cn(
              glassChip,
              sittingOut && 'bg-amber-100/95 text-amber-700 ring-amber-200 dark:bg-amber-950/80 dark:text-amber-300',
              sitOutDisabled && 'opacity-50',
            )}
          >
            <PauseCircle size={15} />
            <span className={compact ? 'sr-only' : undefined}>
              {sittingOut ? t('Deal me back in') : t('Sit out next hand')}
            </span>
          </button>
        )}
        {/* A6: rankings + chat buttons -> popovers */}
        <div className="flex items-center gap-1.5">
          <button
            ref={rankTriggerRef}
            type="button"
            onClick={onToggleRank}
            aria-expanded={rankOpen}
            aria-controls={rankOpen ? RANK_PANEL_ID : undefined}
            aria-haspopup="dialog"
            title={t('Standings')}
            className={cn(glassChip, rankOpen && 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300')}
          >
            <Trophy size={15} />
            <span className={compact ? 'sr-only' : undefined}>{t('Standings')}</span>
          </button>
          <button
            ref={chatTriggerRef}
            type="button"
            onClick={onToggleChat}
            aria-expanded={chatOpen}
            aria-controls={chatOpen ? CHAT_PANEL_ID : undefined}
            aria-haspopup="dialog"
            title={unread > 0 ? t('Toggle chat, {n} unread messages', { n: unread }) : t('Toggle chat')}
            className={cn(
              glassChip,
              'relative',
              chatOpen && 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300',
            )}
          >
            <ChatCircle size={15} weight={chatOpen ? 'fill' : 'regular'} />
            <span className={compact ? 'sr-only' : undefined}>{t('Table chat')}</span>
            {unread > 0 && !chatOpen && (
              <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-indigo-600 px-1 text-[0.6rem] font-bold text-white ring-2 ring-white dark:ring-slate-900">
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Compact glance-list for the popover. The full table with every column
 *  still lives in the Standings dialog; this is the 30k-ft version. */
function StandingsList({ rows, minHands }: { rows: LeaderboardRow[]; minHands: number }) {
  return (
    <ol className="space-y-0.5 text-sm">
      {rows.slice(0, 10).map((r, i) => (
        <li
          key={r.userId}
          className="flex items-center gap-2 rounded-lg px-2 py-1.5 odd:bg-slate-50 dark:odd:bg-slate-800/50"
        >
          <span className="w-5 shrink-0 text-right font-display text-xs font-bold text-slate-400">
            {i + 1}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium">{r.displayName ?? r.username}</span>
          {r.handsPlayed < minHands && (
            <span className="shrink-0 text-[0.6rem] text-slate-400">{t('{n} hands', { n: r.handsPlayed })}</span>
          )}
          <span
            className={cn(
              'shrink-0 font-display text-xs font-bold tabular-nums',
              r.net > 0
                ? 'text-emerald-600 dark:text-emerald-400'
                : r.net < 0
                  ? 'text-rose-600 dark:text-rose-400'
                  : 'text-slate-400',
            )}
          >
            {r.net > 0 ? `+${fmt(r.net)}` : r.net < 0 ? `−${fmt(-r.net)}` : '0'}
          </span>
        </li>
      ))}
    </ol>
  );
}
