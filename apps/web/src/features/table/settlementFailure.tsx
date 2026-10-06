import { useEffect, useState } from 'react';
import { retrySettlement } from '../../shared/gameClient.ts';
import { t, tr } from '../../shared/i18n/index.ts';
import { useStore, type SettlementFailure } from '../../shared/store.ts';
import { Button, Spinner } from '../../shared/ui/index.tsx';

/** How long a manual retry may stay unanswered before we stop showing
 *  "retrying…". The server's own auto-retry interval is 250ms and its DB busy
 *  timeout is a few seconds, so 10s is comfortably past any real reply; without
 *  this a lost/already-settled request would leave the button looking dead. */
export const SETTLE_RETRY_STALL_MS = 10_000;

/** How long the SERVER's own auto-retry may go without a further frame before
 *  we treat it as lost and offer the host a manual retry. The server retries
 *  every 250ms up to 4 times, then freezes and sends a final frame - so 10s
 *  with no frame means a broadcast was swallowed (or the client dropped) and
 *  the table would otherwise sit on an action-less "retrying" banner forever. */
export const SERVER_RETRY_STALL_MS = 10_000;

/** The exact UI state derived from the store, so tests can pin every branch. */
export type SettlementFailurePhase =
  | 'server-retrying'
  | 'server-retry-stalled'
  | 'frozen'
  | 'retrying'
  | 'retry-stalled'
  | 'retry-failed'
  | 'orphaned';

export function settlementFailurePhase(
  failed: SettlementFailure | null,
  now: number,
  stallMs: number = SETTLE_RETRY_STALL_MS,
  serverStallMs: number = SERVER_RETRY_STALL_MS,
): SettlementFailurePhase | null {
  if (!failed) return null;
  // The hand is gone from the server: neither the server's auto-retry nor a
  // host retry can act, so no timeout applies and only an admin can resolve it.
  if (failed.orphaned) return 'orphaned';
  if (failed.retryRequestedAt !== null) {
    return now - failed.retryRequestedAt < stallMs ? 'retrying' : 'retry-stalled';
  }
  if (failed.manualRetry && !failed.retrying) return 'retry-failed';
  if (failed.retrying) {
    // The server owns the retry only while its frames keep arriving; once that
    // window lapses, fall back to a state the host can act on.
    return now - failed.since < serverStallMs ? 'server-retrying' : 'server-retry-stalled';
  }
  return 'frozen';
}

export interface SettlementFailureCopy {
  title: string;
  detail: string;
  /** The host's retry control is usable in this phase. */
  canRetry: boolean;
  /** Show the "waiting for the host" line (non-host viewers). */
  waitingForHost: boolean;
  /** A retry request is in flight: spinner, no button. */
  pending: boolean;
}

export function settlementFailureCopy(
  phase: SettlementFailurePhase,
  isHost: boolean,
  attempt: number,
): SettlementFailureCopy {
  const waitingForHost = !isHost;
  switch (phase) {
    case 'server-retrying':
      return {
        title: t('Settlement failed - retrying automatically'),
        detail: t('The server is re-attempting its own retry (attempt {n}).', { n: attempt }),
        canRetry: false,
        waitingForHost,
        pending: false,
      };
    case 'server-retry-stalled':
      return {
        title: t('Automatic retry stopped responding'),
        detail: isHost
          ? t('You can retry the settlement now.')
          : t('Waiting for the host to retry the settlement.'),
        canRetry: isHost,
        waitingForHost,
        pending: false,
      };
    case 'orphaned':
      return {
        title: t('Settlement recovery needs an administrator'),
        // The exit is explicit: an operator resolves the durable lifecycle, and
        // the client recovers on its next reconnect (the server then reports
        // the hand as committed or aborted). There is no in-app retry to press.
        detail: t(
          'This hand did not settle and the table can no longer retry it. Ask an administrator to resolve it; the table recovers automatically once it is settled.',
        ),
        canRetry: false,
        waitingForHost: false,
        pending: false,
      };
    case 'retrying':
      return {
        title: t('Retrying settlement…'),
        detail: t('Waiting for the server to confirm.'),
        canRetry: false,
        waitingForHost,
        pending: true,
      };
    case 'retry-stalled':
      return {
        title: t('Retry got no response'),
        detail: t('Try again, or contact an administrator.'),
        canRetry: isHost,
        waitingForHost,
        pending: false,
      };
    case 'retry-failed':
      return {
        title: t('Retry still failed'),
        detail: isHost
          ? t('You can retry again, or contact an administrator.')
          : t('Waiting for the host to retry the settlement.'),
        canRetry: isHost,
        waitingForHost,
        pending: false,
      };
    case 'frozen':
    default:
      return {
        title: t('This hand did not settle'),
        detail: isHost
          ? t('The chips are not recorded yet and the table is frozen. Retry the settlement.')
          : t('Waiting for the host to retry the settlement.'),
        canRetry: isHost,
        waitingForHost,
        pending: false,
      };
  }
}

/** An `unresolved` durable hand is admin-only. This banner is shown only when
 *  there is no local `settlement_failed` frame (otherwise the failure banner
 *  already renders the orphaned/admin-needed state), so a client that never saw
 *  a failure still gets a truthful "not terminal, operator required" state
 *  instead of a fabricated refund. There is deliberately no retry control, and
 *  no fake terminal: the chips did not move. */
export function HandRecoveryBanner() {
  const recovery = useStore((s) => s.hand.handRecovery);
  const failed = useStore((s) => s.hand.settlementFailed);
  if (recovery !== 'unresolved' || failed) return null;
  return (
    <div
      role="status"
      data-testid="hand-recovery-banner"
      className="fixed left-1/2 top-16 z-[60] w-[min(30rem,calc(100%-1.5rem))] -translate-x-1/2 rounded-2xl border border-amber-300 bg-white/95 px-4 py-3 text-slate-900 shadow-2xl ring-1 ring-amber-200 dark:border-amber-800 dark:bg-slate-950/95 dark:text-slate-100"
    >
      <p className="font-display text-sm font-bold text-amber-700 dark:text-amber-300">
        {t('An administrator is handling this hand')}
      </p>
      <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
        {t(
          'This hand did not settle and no refund was made. The table recovers automatically once an administrator resolves it.',
        )}
      </p>
    </div>
  );
}

/** A durable settlement failure is NOT a toast: the table stays frozen until it
 *  clears, so this banner persists. The retry button is host-only (server
 *  enforces the same rule, game.ts), and never disappears on a failed retry -
 *  it either shows "retrying…", "retry still failed", or a stalled request. */
export function SettlementFailureBanner({ isHost }: { isHost: boolean }) {
  const failed = useStore((s) => s.hand.settlementFailed);
  const [now, setNow] = useState(() => Date.now());
  const phase = settlementFailurePhase(failed, now);

  // Re-render once an in-flight request - manual or server-owned - passes its
  // stall window, so a reply that never arrives flips to a state the host can
  // act on and the button comes back.
  useEffect(() => {
    if (!failed || failed.orphaned) return;
    const manual = failed.retryRequestedAt !== null;
    if (!manual && !failed.retrying) return;
    const since = manual ? failed.retryRequestedAt! : failed.since;
    const stall = manual ? SETTLE_RETRY_STALL_MS : SERVER_RETRY_STALL_MS;
    const remaining = stall - (Date.now() - since);
    if (remaining <= 0) {
      setNow(Date.now());
      return;
    }
    const id = setTimeout(() => setNow(Date.now()), remaining + 50);
    return () => clearTimeout(id);
  }, [failed]);

  if (!failed || !phase) return null;
  const copy = settlementFailureCopy(phase, isHost, failed.attempt);

  return (
    <div
      // `role="alert"` already implies assertive, so no explicit aria-live; a
      // server-owned auto-retry is low-stakes progress, so announce it politely
      // instead of interrupting the whole table on every attempt.
      role={phase === 'server-retrying' ? 'status' : 'alert'}
      data-testid="settlement-failed-banner"
      className="fixed left-1/2 top-16 z-[60] w-[min(30rem,calc(100%-1.5rem))] -translate-x-1/2 rounded-2xl border border-rose-300 bg-white/95 px-4 py-3 text-slate-900 shadow-2xl ring-1 ring-rose-200 dark:border-rose-800 dark:bg-slate-950/95 dark:text-slate-100"
    >
      <p className="flex items-center gap-2 font-display text-sm font-bold text-rose-700 dark:text-rose-300">
        {copy.pending && <Spinner />}
        {copy.title}
      </p>
      <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{copy.detail}</p>
      {failed.reason && (
        <p className="mt-1 break-words text-[0.7rem] text-slate-500 dark:text-slate-400">
          {tr(failed.reason)}
        </p>
      )}
      {isHost && copy.canRetry && (
        <Button
          className="mt-2"
          variant="danger"
          data-testid="settlement-retry-button"
          onClick={() => retrySettlement()}
        >
          {t('Retry settlement')}
        </Button>
      )}
      {copy.waitingForHost && (
        <p
          className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-300"
          data-testid="settlement-waiting-host"
        >
          {t('Waiting for the host to retry the settlement.')}
        </p>
      )}
    </div>
  );
}
