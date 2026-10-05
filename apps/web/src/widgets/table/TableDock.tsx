import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { ChatCircle, PauseCircle, X } from '@phosphor-icons/react';
import { cn } from '../../shared/lib/cn.ts';
import { t } from '../../shared/i18n/index.ts';

/** Rankings and chat are buttons in the table area that open popover panels
 *  over the felt; 「下一手休息」(sit out next hand) lives at the BOTTOM-LEFT.
 *  The dock anchors to the bottom-left corner of the table section. */

const glassChip = 'table-dock-chip';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]';

/**
 * The keydown/trap effect runs ONCE on mount (deps []), reading the close
 * handler and the trigger ref through stable refs - so an inline callback that
 * changes identity on every re-render can never re-fire the effect and steal
 * focus mid-typing. Escape closes, Tab is trapped inside the panel, and on
 * close focus goes back to the dock button that opened the panel; the panel
 * carries a stable id the trigger references via aria-controls.
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

const CHAT_PANEL_ID = 'table-chat-popover';

export function TableDock({
  flow = false,
  phone = false,
  compact,
  hasSeat,
  sittingOut,
  sitOutDisabled,
  onToggleSitOut,
  onClosePopovers,
  chatOpen,
  onToggleChat,
  unread,
  chatBody,
  hostGameplay,
}: {
  /** L6 portrait phones: the dock rides the console strip below the canvas
   *  instead of overlaying the felt bottom-left. `relative` (not absolute)
   *  keeps it the positioning host for its popovers. */
  flow?: boolean;
  /** L6 phone: dock chips grow to the 44px touch minimum (table-controls.css). */
  phone?: boolean;
  /** Narrow viewport: labels drop out, icons carry the meaning (A1). */
  compact: boolean;
  hasSeat: boolean;
  sittingOut: boolean;
  sitOutDisabled: boolean;
  onToggleSitOut: () => void;
  /** Closes both popovers; Escape and the X buttons use it, so closing from
   *  inside the panel never leaves the other one's state stale. */
  onClosePopovers: () => void;
  chatOpen: boolean;
  onToggleChat: () => void;
  unread: number;
  /** The chat panel (input + quick phrases + stickers) - supplied by the page. */
  chatBody: ReactNode;
  /** Feedback #3: the account balance chip, folded out of the deleted bottom
   *  box into the bottom-left dock column. */
  /** Feedback #3: 「快捷键」 as its own standalone button, bottom-left. */
  /** P2 Lane F: the host's between-hand gameplay controls (arm the squid game
   *  or a bomb pot for the next hand, open the 玩法规则 editor on phones).
   *  Rendered as a column above the balance chip; omitted for everyone else. */
  hostGameplay?: ReactNode;
}) {
  const chatTriggerRef = useRef<HTMLButtonElement>(null);
  // NOTE: the click-away catcher is NOT here - the page renders one over the
  // felt only (z-20), so the action bar stays live while a popover is open.
  return (
    <div
      className={cn(
        'pointer-events-none flex flex-col items-start gap-1.5',
        flow ? 'relative' : 'absolute bottom-2 left-2 z-30',
        phone && 'table-dock--phone',
      )}
    >
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
        {/* P2 Lane F: host-only 鱿鱼游戏/炸弹池 arming row, above everything
            else the dock stacks */}
        {hostGameplay}
        {/* feedback #3: balance chip + the standalone 「快捷键」 button join the
            dock column, so everything the old bottom box carried is reachable */}
        {/* A9: sit-out for the next hand, bottom-left of the table area */}
        {hasSeat && (
          <button
            type="button"
            onClick={onToggleSitOut}
            disabled={sitOutDisabled}
            aria-pressed={sittingOut}
            title={sittingOut ? t('Deal me in next hand') : t('Sit out next deal')}
            className={cn(
              glassChip,
              sittingOut && 'table-dock-chip--active',
              sitOutDisabled && 'opacity-50',
            )}
          >
            <PauseCircle size={15} />
            <span className={compact ? 'sr-only' : undefined}>
              {sittingOut ? t('Deal me in next hand') : t('Sit out next deal')}
            </span>
          </button>
        )}
        {/* A6: rankings + chat buttons -> popovers */}
        <div className="flex items-center gap-1.5">
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
              chatOpen && 'table-dock-chip--active',
            )}
          >
            <ChatCircle size={15} weight={chatOpen ? 'fill' : 'regular'} />
            <span className={compact ? 'sr-only' : undefined}>{t('Table chat')}</span>
            {unread > 0 && !chatOpen && (
              <span className="table-dock-badge absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center px-1 ring-2 ring-(--table-surface-dock)">
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
