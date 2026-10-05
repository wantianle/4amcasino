import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type MyHandRef } from '../../shared/api.ts';
import { cn, fmt } from '../../shared/lib/cn.ts';
import { fmtDate, fmtTime } from '../../shared/lib/datetime.ts';
import { Badge, Button, Panel, Spinner } from '../../shared/ui/index.tsx';
import { t, tr } from '../../shared/i18n/index.ts';

const PAGE_SIZE = 20;

function netTone(net: number | null): string {
  if (net === null || net === 0) return 'text-slate-400';
  return net > 0
    ? 'text-emerald-600 dark:text-emerald-400'
    : 'text-rose-600 dark:text-rose-400';
}

function netLabel(net: number | null): string {
  if (net === null) return '—';
  if (net === 0) return '±0';
  return `${net > 0 ? '+' : '−'}${fmt(Math.abs(net))}`;
}

/**
 * My hands in one room, paged. A read-only drill-down from /history: each row
 * links to the existing replay page (`/room/:id/replay/:handId`) and the room
 * ledger - the point is to reach the existing solo views, not to rebuild them.
 */
export function HistoryRoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const [roomName, setRoomName] = useState<string | null>(null);
  const [hands, setHands] = useState<MyHandRef[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState('');
  // Explicit retry trigger: offset is a page cursor, so "Try again" must not
  // fake a change with `setOffset((o) => o)` (React bails out on Object.is) -
  // bumping this nonce is what re-runs the loader effect.
  const [reloadNonce, setReloadNonce] = useState(0);
  // Switching rooms must start back on page 1. React Router keeps this
  // component mounted across `/history/:roomId` param changes, so without this
  // a stale offset (e.g. page 2 of room A) would request an out-of-range page
  // in room B and render a wrong empty state. Adjusting state during render
  // (the documented "derive from props" pattern) resets it before the loader
  // effect runs, so no request is wasted on the stale offset.
  const [offsetRoomId, setOffsetRoomId] = useState(roomId);
  if (roomId !== offsetRoomId) {
    setOffsetRoomId(roomId);
    setOffset(0);
  }

  useEffect(() => {
    if (!roomId) return;
    let active = true;
    setRoomName(null);
    void api
      .getRoom(roomId)
      .then((r) => {
        if (active) setRoomName((r as { name?: string }).name ?? null);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [roomId]);

  useEffect(() => {
    if (!roomId) return;
    let active = true;
    setHands(null);
    setError('');
    void api
      .hands(roomId, { limit: PAGE_SIZE, offset })
      .then((r) => {
        if (!active) return;
        setHands(r.hands);
        setTotal(r.total);
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [roomId, offset, reloadNonce]);

  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const live = (hands ?? []).filter((h) => !h.voided);
  const net = live.reduce((sum, h) => sum + (h.myNet ?? 0), 0);

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 md:p-6">
      <header className="flex flex-wrap items-center gap-3">
        <Link to="/history" className="text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
          {t('← Back to history')}
        </Link>
        <h1 className="font-display text-xl font-bold">{roomName ?? t('Hand history')}</h1>
        {roomId && (
          <Link
            to={`/room/${roomId}/ledger`}
            className="ml-auto text-sm font-semibold text-indigo-600 hover:underline dark:text-indigo-400"
          >
            {t('Open ledger')}
          </Link>
        )}
      </header>

      {hands && total > 0 && (
        <Panel className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-xs text-slate-500">{t('Hands on this page')}</div>
            <div className="font-display text-lg font-bold tabular-nums">{live.length}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">{t('Page net')}</div>
            <div className={cn('font-display text-lg font-bold tabular-nums', netTone(net))}>
              {netLabel(net)}
            </div>
          </div>
        </Panel>
      )}

      {error ? (
        <Panel className="space-y-3 text-sm">
          <p role="alert" className="text-rose-600 dark:text-rose-400">
            {t('Could not load this room.')}
          </p>
          <p className="text-xs text-slate-500">{error}</p>
          <Button onClick={() => setReloadNonce((n) => n + 1)}>{t('Try again')}</Button>
        </Panel>
      ) : !hands ? (
        <div className="flex min-h-[40vh] items-center justify-center">
          <Spinner label={t('Loading hands…')} />
        </div>
      ) : hands.length === 0 ? (
        <Panel className="text-sm text-slate-500">{t('No hands in this room yet.')}</Panel>
      ) : (
        <>
          <div className="space-y-2">
            {hands.map((h) => (
              <div
                key={h.handId}
                className={cn(
                  'flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-white p-4 ring-1 ring-slate-200/70 dark:bg-slate-900 dark:ring-slate-700/70',
                  h.voided && 'opacity-70',
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-display text-sm font-semibold">
                      {t('hand {id}', { id: h.handId.slice(0, 8) })}
                    </span>
                    {h.voided && <Badge tone="rose">{t('voided')}</Badge>}
                  </div>
                  <div className="text-xs text-slate-500">
                    {fmtDate(h.ts)} {fmtTime(h.ts)} · {tr(h.outcome)}
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <span
                    className={cn('font-display font-bold tabular-nums', netTone(h.myNet))}
                  >
                    {netLabel(h.myNet)}
                  </span>
                  <Link
                    to={`/room/${roomId}/replay/${h.handId}`}
                    className="text-xs font-semibold text-indigo-600 hover:underline dark:text-indigo-400"
                  >
                    {t('Replay')}
                  </Link>
                </div>
              </div>
            ))}
          </div>

          {pages > 1 && (
            <div className="flex items-center justify-center gap-3">
              <Button
                variant="secondary"
                disabled={offset === 0}
                onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
              >
                {t('← Newer')}
              </Button>
              <span className="text-sm text-slate-500">
                {t('{from}–{to} of {total}', { from, to, total })} · {t('Page {page}/{pages}', { page, pages })}
              </span>
              <Button
                variant="secondary"
                disabled={to >= total}
                onClick={() => setOffset((o) => o + PAGE_SIZE)}
              >
                {t('Older →')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
