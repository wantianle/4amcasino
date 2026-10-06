import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { RiHistoryLine } from '@remixicon/react';
import { api, type MyRoomSummary } from '../../shared/api.ts';
import { cn, fmt } from '../../shared/lib/cn.ts';
import { fmtRelative } from '../../shared/lib/datetime.ts';
import { Badge, Button, Panel, Spinner } from '../../shared/ui/index.tsx';
import { t } from '../../shared/i18n/index.ts';

type Filter = 'all' | 'active' | 'archived';

const PAGE_SIZE = 20;

function netTone(net: number): string {
  if (net === 0) return 'text-slate-400';
  return net > 0
    ? 'text-emerald-600 dark:text-emerald-400'
    : 'text-rose-600 dark:text-rose-400';
}

function netLabel(net: number): string {
  if (net === 0) return '±0';
  return `${net > 0 ? '+' : '−'}${fmt(Math.abs(net))}`;
}

/**
 * Career record across every table this account has ever been part of.
 *
 * The data source is `GET /api/me/rooms`, which aggregates each room from
 * `room_players` + the hash-chained ledger and therefore keeps working after a
 * table is archived or deleted. It is paged server-side (with `total`/`hasMore`
 * and the `archived` filter pushed into the query) so an account with more than
 * one page of rooms never loses data and never filters only the loaded slice.
 * The page is the lobby for finished tables: it links into the per-room hand
 * list (`/history/:roomId`) and the room ledger (`/room/:id/ledger`), so it
 * complements - and never duplicates - the Lobby's live rooms and the player
 * profile rather than reimplementing them.
 */
export function HistoryPage() {
  const [rooms, setRooms] = useState<MyRoomSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [totals, setTotals] = useState({ hands: 0, net: 0 });
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let active = true;
    setRooms(null);
    setError('');
    void api
      .meRooms({
        limit: PAGE_SIZE,
        offset,
        // The filter runs server-side so it applies to the whole history, not
        // just the rooms already on screen. `all` must be explicit: the API's
        // default hides archived rooms, and this page is the one place that is
        // supposed to still show them under the "All" tab.
        ...(filter === 'all' ? { archived: 'all' as const } : { archived: filter === 'archived' }),
      })
      .then((r) => {
        if (!active) return;
        setRooms(r.rooms);
        setTotal(r.total);
        setHasMore(r.hasMore);
        setTotals(r.totals);
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [filter, offset, nonce]);

  const reload = () => setNonce((n) => n + 1);
  const changeFilter = (f: Filter) => {
    setFilter(f);
    setOffset(0);
  };

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);

  if (error) {
    return (
      <div className="mx-auto max-w-4xl p-4 md:p-6">
        <Panel className="space-y-3 text-sm">
          <p role="alert" className="text-rose-600 dark:text-rose-400">
            {t('Could not load your history.')}
          </p>
          <p className="text-xs text-slate-500">{error}</p>
          <Button onClick={reload}>{t('Try again')}</Button>
        </Panel>
      </div>
    );
  }

  if (!rooms) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spinner label={t('Loading your history…')} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 md:p-6">
      <header className="flex items-center gap-3">
        <RiHistoryLine className="size-6 text-indigo-500" aria-hidden />
        <h1 className="font-display text-xl font-bold">{t('History')}</h1>
      </header>
      <p className="text-sm text-slate-500">
        {t(
          'Every table you have played, including archived ones. Open a room for your hands, replays and the ledger.',
        )}
      </p>

      {total > 0 && (
        <Panel className="grid grid-cols-3 gap-4">
          <div>
            <div className="text-xs text-slate-500">{t('Rooms')}</div>
            <div className="font-display text-lg font-bold tabular-nums">{total}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">{t('Hands played')}</div>
            <div className="font-display text-lg font-bold tabular-nums">{totals.hands}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">{t('Net result')}</div>
            <div className={cn('font-display text-lg font-bold tabular-nums', netTone(totals.net))}>
              {netLabel(totals.net)}
            </div>
          </div>
        </Panel>
      )}

      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('Filter rooms')}>
        {(['all', 'active', 'archived'] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => changeFilter(f)}
            aria-pressed={filter === f}
            className={cn(
              'rounded-full px-3 py-1.5 text-xs font-semibold',
              filter === f
                ? 'bg-indigo-600 text-white'
                : 'bg-white text-slate-500 ring-1 ring-slate-200/70 hover:text-slate-700 dark:bg-slate-900 dark:ring-slate-700/70 dark:hover:text-slate-300',
            )}
          >
            {t(f === 'all' ? 'All' : f === 'active' ? 'Active' : 'Archived')}
          </button>
        ))}
      </div>

      {total === 0 ? (
        <Panel className="text-sm text-slate-500">
          {filter === 'all'
            ? t('No games yet. Your finished tables will show up here.')
            : t('Nothing here for this filter.')}
        </Panel>
      ) : (
        <>
          <div className="space-y-2">
            {rooms.map((r) => (
              <div
                key={r.roomId}
                className="relative flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-white p-4 ring-1 ring-slate-200/70 transition-shadow hover:shadow-md dark:bg-slate-900 dark:ring-slate-700/70"
              >
                <Link
                  to={`/history/${r.roomId}`}
                  className="absolute inset-0 rounded-xl"
                  aria-label={t('Open history for {name}', { name: r.name })}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{r.name}</span>
                    {r.archived && <Badge tone="slate">{t('Archived')}</Badge>}
                    {r.isHost && <Badge tone="indigo">{t('Host')}</Badge>}
                  </div>
                  <div className="text-xs text-slate-500">
                    {t('{n} players · {time}', {
                      n: r.playerCount,
                      time: fmtRelative(r.updatedAt),
                    })}
                    {' · '}
                    {t('Blinds {sb}/{bb}', { sb: r.sb, bb: r.bb })}
                  </div>
                </div>
                <div className="relative z-10 flex items-center gap-4">
                  <div className="text-right">
                    <div className="text-xs text-slate-500">{t('{n} hands', { n: r.myHands })}</div>
                    <div className={cn('font-display font-bold tabular-nums', netTone(r.myNet))}>
                      {netLabel(r.myNet)}
                    </div>
                  </div>
                  <Link
                    to={`/room/${r.roomId}/ledger`}
                    className="text-xs font-semibold text-indigo-600 hover:underline dark:text-indigo-400"
                  >
                    {t('Ledger')}
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
                {t('{from}–{to} of {total}', { from, to, total })} ·{' '}
                {t('Page {page}/{pages}', { page, pages })}
              </span>
              <Button
                variant="secondary"
                disabled={!hasMore}
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
