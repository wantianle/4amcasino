import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { verifyHandTranscript, type TranscriptEntry } from '@4am/mental-poker';
import { CaretDown, CardsThree } from '@phosphor-icons/react';
import { evaluate7, type Street } from '@4am/shared';
import { api } from '../../shared/api.ts';
import { cn, fmt } from '../../shared/lib/cn.ts';
import { Badge, Button, Dialog, Panel, Spinner } from '../../shared/ui/index.tsx';
import { t, tr } from '../../shared/i18n/index.ts';
import { tScore } from '../../shared/i18n/pokerLabels.ts';
import { PlayingCard } from '../../entities/card/PlayingCard.tsx';
import { summarizeHand, summaryActionLabel, type HandSummary } from '../../shared/replay.ts';
import { ProStats } from '../../features/stats/ProStats.tsx';

interface HandRef {
  handId: string;
  head: string;
  ts: number;
  /** Your net chips for the hand from the settlement ledger; null if you had no stake. */
  myNet: number | null;
  /** How the hand ended for you: folded (and where), showdown, quiet win, sat out. */
  outcome: string;
  voided: boolean;
}

interface HandDetail {
  handId: string;
  head: string;
  entries: TranscriptEntry[];
}

interface RoomPlayerLite {
  userId: number;
  username: string;
  displayName: string;
}

function netTone(net: number | null): string {
  if (net === null || net === 0) return 'text-slate-400';
  return net > 0 ? 'text-emerald-500' : 'text-rose-500';
}

function netLabel(net: number | null): string {
  if (net === null) return '—';
  if (net === 0) return '±0';
  return `${net > 0 ? '+' : '−'}${fmt(Math.abs(net))}`;
}

const FILTERS = ['all', 'won', 'lost', 'folded', 'showdown'] as const;
type Filter = (typeof FILTERS)[number];

// street labels follow docs/zh-i18n.md §2.1: 翻牌前 / 翻牌 / 转牌 / 河牌
const STREET_LABEL_KEYS: Record<Street, string> = {
  preflop: 'Preflop',
  flop: 'Flop',
  turn: 'Turn',
  river: 'River',
};
// how many board positions are open once each street is dealt
const STREET_BOARD_COUNT: Record<Street, number> = {
  preflop: 0,
  flop: 3,
  turn: 4,
  river: 5,
};

/**
 * The expandable detail of one finished hand, rebuilt from its signed
 * transcript (summarizeHand in shared/replay.ts) - per-street actions with
 * amounts, public hole cards, community cards, the pot and the rake. It is
 * deliberately compact: the full motion belongs to the replay, the raw proof
 * to the transcript dialog. (request that grew out of the table recap removal:
 * the detail people wanted from the old result panel now lives here.)
 */
function HandSummaryBlock({
  summary,
  nameOf,
}: {
  summary: HandSummary;
  nameOf: (seat: number, userId: number) => string;
}) {
  const userIdOf = (seat: number) => summary.seats.find((s) => s.seat === seat)?.userId ?? 0;
  const rows = useMemo(() => {
    const list = summary.seats.map((s) => {
      const cards = summary.revealed[s.seat] ?? null;
      const delta = summary.deltas.find((d) => d.seat === s.seat)?.delta ?? 0;
      return {
        seat: s.seat,
        userId: s.userId,
        cards,
        delta,
        score:
          cards && summary.board.length === 5 ? evaluate7([...cards, ...summary.board]) : null,
      };
    });
    return list.sort((a, b) => b.delta - a.delta);
  }, [summary]);
  const streetsWithAction = summary.streets.filter((s) => s.actions.length > 0);

  return (
    <div className="grid gap-5 border-t border-slate-100 px-4 pb-4 pt-3 lg:grid-cols-[minmax(0,1fr)_21rem] dark:border-slate-800">
      {/* who held what, and how the hand ended for them */}
      <section aria-label={t('Hole cards')} className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge tone="slate">{t('blinds {sb}/{bb}', { sb: summary.sb, bb: summary.bb })}</Badge>
          <Badge tone="slate">
            {t('Dealer button')} · {t('Seat {n}', { n: summary.buttonSeat + 1 })}
          </Badge>
          {summary.pot > 0 && (
            <Badge tone="indigo">{t('POT {n}', { n: fmt(summary.pot) })}</Badge>
          )}
          {summary.commission > 0 && (
            <Badge tone="amber">
              {t('Rake')} {fmt(summary.commission)}
            </Badge>
          )}
          {summary.ranItTwice && <Badge tone="rose">{t('ran it twice')}</Badge>}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-slate-400">
            {t('Community cards')}
          </span>
          {summary.board.length === 0 && (
            <span className="text-xs text-slate-400">{t('No board was dealt.')}</span>
          )}
          {summary.board.map((c) => (
            <PlayingCard key={c} card={c} size="xs" />
          ))}
        </div>
        {summary.board2.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded-full bg-fuchsia-500/15 px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wide text-fuchsia-500">
              {t('Run 2')}
            </span>
            {summary.board2.map((c) => (
              <PlayingCard key={`r2-${c}`} card={c} size="xs" />
            ))}
          </div>
        )}

        <div className="grid gap-1.5 sm:grid-cols-2">
          {rows.map((r) => (
            <div
              key={r.seat}
              className="flex items-center gap-2.5 rounded-lg bg-slate-50 p-2 dark:bg-slate-800/50"
            >
              {r.cards ? (
                <div className="flex shrink-0 gap-0.5">
                  {r.cards.map((c) => (
                    <PlayingCard key={c} card={c} size="xs" />
                  ))}
                </div>
              ) : (
                <div className="flex shrink-0 gap-0.5" title={t('Cards stay hidden')}>
                  <PlayingCard faceDown size="xs" />
                  <PlayingCard faceDown size="xs" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium leading-tight">
                  {nameOf(r.seat, r.userId)}
                  {r.seat === summary.buttonSeat && (
                    <span
                      className="ml-1.5 inline-flex size-4 items-center justify-center rounded-full bg-white text-[0.55rem] font-bold text-slate-700 ring-1 ring-slate-200 dark:bg-slate-700 dark:text-white dark:ring-slate-600"
                      title={t('Dealer button')}
                    >
                      D
                    </span>
                  )}
                </div>
                <div className="text-[0.68rem] leading-tight text-slate-400">
                  {r.cards ? (
                    r.score !== null ? (
                      tScore(r.score)
                    ) : (
                      t('showed after folding')
                    )
                  ) : (
                    t('Cards stay hidden')
                  )}
                </div>
              </div>
              <div
                className={cn(
                  'shrink-0 font-display text-sm font-bold tabular-nums',
                  r.delta > 0 ? 'text-emerald-600 dark:text-emerald-400' : r.delta < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-400',
                )}
              >
                {netLabel(r.delta)}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* street by street, what everyone did */}
      <section aria-label={t('Actions by street')} className="min-w-0 space-y-2.5">
        {streetsWithAction.length === 0 && (
          <p className="text-xs text-slate-400">{t('No betting actions were recorded.')}</p>
        )}
        {streetsWithAction.map((street) => (
          <div
            key={street.street}
            className="rounded-xl ring-1 ring-slate-200/70 dark:ring-slate-700/60"
          >
            <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-1.5 dark:border-slate-800">
              <span className="text-[0.65rem] font-bold uppercase tracking-[0.14em] text-indigo-500 dark:text-indigo-400">
                {t(STREET_LABEL_KEYS[street.street])}
              </span>
              <span className="flex gap-0.5">
                {summary.board.slice(0, STREET_BOARD_COUNT[street.street]).map((c) => (
                  <span key={c} className="font-mono text-[0.6rem] text-slate-400">
                    {c}
                  </span>
                ))}
              </span>
            </div>
            <ul className="space-y-0.5 px-3 py-2">
              {street.actions.map((a, index) => (
                <li key={`${a.seat}-${index}`} className="flex items-baseline gap-1 text-xs">
                  <span className="text-slate-500 dark:text-slate-400">
                    {summaryActionLabel(nameOf(a.seat, userIdOf(a.seat)), a)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </div>
  );
}

export function HandsPage() {
  const { id } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  const pro = params.get('mode') === 'pro';
  return <>
    <div className="mx-auto max-w-[1600px] px-4 pt-4 md:px-6" role="group" aria-label={t('Hand history mode')}>
      {['normal', 'pro'].map((mode) => <Button key={mode} className="mr-2" variant={pro === (mode === 'pro') ? 'primary' : 'secondary'} aria-pressed={pro === (mode === 'pro')} onClick={() => {
        const next = new URLSearchParams(params);
        if (mode === 'pro') next.set('mode', 'pro'); else next.delete('mode');
        setParams(next);
      }}>{t(mode === 'pro' ? 'Professional mode' : 'Normal mode')}</Button>)}
    </div>
    {pro ? <div className="mx-auto max-w-[1600px] space-y-4 p-4 md:p-6"><header className="flex flex-wrap items-center gap-4"><Link to={`/room/${id}`} className="text-sm text-slate-400 hover:text-slate-200">{t('← Back to table')}</Link><h1 className="font-display text-xl font-bold">{t('Hand history')} · {t('Professional mode')}</h1></header><ProStats key={id} roomId={id!} /></div> : <NormalHandsPage />}
  </>;
}

function NormalHandsPage() {
  const { id: roomId } = useParams<{ id: string }>();
  const [hands, setHands] = useState<HandRef[] | null>(null);
  // expanded row: one hand open at a time keeps the page scannable
  const [openId, setOpenId] = useState<string | null>(null);
  // transcripts fetched for the inline detail, cached by hand id; null = loading
  const [details, setDetails] = useState<Record<string, HandDetail | null>>({});
  const [detail, setDetail] = useState<HandDetail | null>(null);
  const [players, setPlayers] = useState<Map<number, RoomPlayerLite>>(new Map());
  // which hands you want to relive rides the URL, so the view is shareable
  // (filters requested by notpritam, docs/FEATURES.md)
  const [params, setParams] = useSearchParams();
  const filter = (FILTERS.includes(params.get('f') as Filter) ? params.get('f') : 'all') as Filter;
  const setFilter = (f: Filter) => {
    const next = new URLSearchParams(params);
    if (f === 'all') next.delete('f');
    else next.set('f', f);
    setParams(next, { replace: true });
  };
  const matchesFilter = (h: HandRef) =>
    filter === 'all' ||
    (filter === 'won' && (h.myNet ?? 0) > 0) ||
    (filter === 'lost' && (h.myNet ?? 0) < 0 && !h.outcome.startsWith('folded')) ||
    (filter === 'folded' && h.outcome.startsWith('folded')) ||
    (filter === 'showdown' && h.outcome.includes('showdown'));

  useEffect(() => {
    api.hands(roomId!).then((r) => setHands(r.hands));
    void api
      .getRoom(roomId!)
      .then((room) => {
        const ps = (room as { players: RoomPlayerLite[] }).players;
        setPlayers(new Map(ps.map((p) => [p.userId, p])));
      })
      .catch(() => {});
  }, [roomId]);

  // your session in numbers, voided hands excluded (they cancel on the ledger)
  const totals = useMemo(() => {
    const live = (hands ?? []).filter((h) => !h.voided && h.outcome !== 'sat out');
    const net = live.reduce((sum, h) => sum + (h.myNet ?? 0), 0);
    const folded = live.filter((h) => h.outcome.startsWith('folded'));
    const foldBleed = folded.reduce((sum, h) => sum + Math.min(0, h.myNet ?? 0), 0);
    const showdowns = live.filter((h) => h.outcome.includes('showdown'));
    const won = live.filter((h) => (h.myNet ?? 0) > 0).length;
    return { played: live.length, net, folds: folded.length, foldBleed, showdowns: showdowns.length, won };
  }, [hands]);

  const loadDetail = (handId: string) => {
    if (details[handId] !== undefined) return;
    setDetails((d) => ({ ...d, [handId]: null }));
    api
      .hand(roomId!, handId)
      .then((d) => setDetails((prev) => ({ ...prev, [handId]: d })))
      .catch(() => setDetails((prev) => ({ ...prev, [handId]: null })));
  };

  const toggle = (handId: string) => {
    setOpenId((cur) => (cur === handId ? null : handId));
    loadDetail(handId);
  };

  const nameOf = (seat: number, userId: number) =>
    players.get(userId)?.displayName ?? t('Seat {n}', { n: seat + 1 });

  function download(d: HandDetail) {
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `4am-hand-${d.handId}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  if (!hands) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner label={t('Loading hands…')} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1600px] space-y-6 p-4 md:p-6">
      <header className="flex items-center gap-3">
        <Link to={`/room/${roomId}`} className="text-sm text-slate-500 hover:text-slate-800">
          {t('← Back to table')}
        </Link>
        <h1 className="font-display text-xl font-bold">{t('Hand history')}</h1>
      </header>
      <p className="text-sm text-slate-500">
        {t(
          'Every completed hand stores its full signed transcript with your result on it. Download one to audit the shuffle, every unmask proof, and every action offline.',
        )}
      </p>

      {totals.played > 0 && (
        <Panel className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div>
            <div className="text-xs text-slate-500">{t('Your net · {n} hands', { n: totals.played })}</div>
            <div className={cn('font-display text-lg font-bold', netTone(totals.net))}>
              {netLabel(totals.net)}
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-500">{t('Hands won')}</div>
            <div className="font-display text-lg font-bold">{totals.won}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">{t('Folds')}</div>
            <div className="font-display text-lg font-bold">{totals.folds}</div>
          </div>
          <div>
            <div className="text-xs text-slate-500">{t('Paid to fold (blinds and bets)')}</div>
            <div className={cn('font-display text-lg font-bold', netTone(totals.foldBleed))}>
              {netLabel(totals.foldBleed)}
            </div>
          </div>
        </Panel>
      )}

      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              'rounded-full px-3 py-1.5 text-xs font-semibold capitalize',
              filter === f
                ? 'bg-indigo-600 text-white'
                : 'bg-white text-slate-500 ring-1 ring-slate-200/70 hover:text-slate-700 dark:bg-slate-900 dark:ring-slate-700/70 dark:hover:text-slate-300',
            )}
          >
            {t(f)}
          </button>
        ))}
      </div>

      {hands.length === 0 ? (
        <Panel className="text-sm text-slate-500">{t('No completed hands yet.')}</Panel>
      ) : (
        <div className="space-y-2">
          {hands.filter(matchesFilter).map((h) => {
            const open = openId === h.handId;
            const loaded = details[h.handId];
            const summary = loaded ? summarizeHand(loaded.entries) : null;
            return (
              <div
                key={h.handId}
                className={cn(
                  'overflow-hidden rounded-xl bg-white ring-1 ring-slate-200/70 dark:bg-slate-900 dark:ring-slate-700/70',
                  open && 'shadow-md',
                  h.voided && 'opacity-70',
                )}
              >
                <div className="flex items-stretch">
                  <button
                    type="button"
                    onClick={() => toggle(h.handId)}
                    aria-expanded={open}
                    className="flex min-w-0 flex-1 items-center gap-3 p-4 text-left hover:bg-slate-50/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500 dark:hover:bg-slate-800/40"
                  >
                    <CaretDown
                      size={14}
                      weight="bold"
                      className={cn(
                        'shrink-0 text-slate-400 transition-transform',
                        open ? 'rotate-180' : '-rotate-90',
                      )}
                    />
                    <div className="min-w-0">
                      <div className="font-display text-sm font-semibold">
                        {t('hand {id}', { id: h.handId.slice(0, 8) })}
                      </div>
                      <div className="text-xs text-slate-500">{new Date(h.ts).toLocaleString('zh-CN')}</div>
                    </div>
                    <div className="ml-auto flex shrink-0 items-center gap-2.5">
                      {h.voided && <Badge tone="rose">{t('voided')}</Badge>}
                      <span className="max-w-24 truncate text-xs text-slate-500 sm:max-w-none">
                        {tr(h.outcome)}
                      </span>
                      <span
                        className={cn(
                          'w-16 text-right font-display text-sm font-bold tabular-nums',
                          netTone(h.myNet),
                        )}
                      >
                        {netLabel(h.myNet)}
                      </span>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      loadDetail(h.handId);
                      const cached = details[h.handId];
                      if (cached) setDetail(cached);
                      else api.hand(roomId!, h.handId).then(setDetail);
                    }}
                    aria-label={t('Transcript')}
                    title={t('Transcript')}
                    className="flex shrink-0 items-center gap-1.5 border-l border-slate-100 px-3 text-xs font-semibold text-indigo-600 hover:bg-indigo-50/60 dark:border-slate-800 dark:text-indigo-400 dark:hover:bg-slate-800/50"
                  >
                    <CardsThree size={14} />
                    <span className="hidden md:inline">{t('Transcript')}</span>
                  </button>
                </div>
                {open &&
                  (loaded ? (
                    <>
                      {(h.voided || summary?.aborted) && (
                        <p className="border-t border-slate-100 bg-rose-50/60 px-4 py-2 text-xs font-medium text-rose-600 dark:border-slate-800 dark:bg-rose-950/30 dark:text-rose-300">
                          {t('This hand was voided.')}
                          {summary?.abortReason ? ` ${tr(summary.abortReason)}` : ''}
                        </p>
                      )}
                      {summary ? (
                        <HandSummaryBlock summary={summary} nameOf={nameOf} />
                      ) : (
                        <p className="px-4 pb-4 pt-3 text-xs text-slate-500">
                          {t('Nothing was recorded for this hand.')}
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="px-4 pb-4 pt-3">
                      <Spinner label={t('Loading hand…')} />
                    </p>
                  ))}
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={detail !== null} onClose={() => setDetail(null)} title={t('Hand transcript')}>
        {detail && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Badge tone="slate">{t('{n} entries', { n: detail.entries.length })}</Badge>
              {(() => {
                const v = verifyHandTranscript(detail.handId, detail.entries, detail.head);
                return v.ok ? (
                  <Badge tone="emerald">{t('✓ verified in your browser')}</Badge>
                ) : (
                  <Badge tone="rose">
                    {v.badSeq === undefined
                      ? t('TAMPERED. {reason}', { reason: tr(v.reason ?? 'invalid') })
                      : t('TAMPERED. {reason} at entry {seq}', {
                          reason: tr(v.reason ?? 'invalid'),
                          seq: v.badSeq,
                        })}
                  </Badge>
                );
              })()}
              <span className="font-mono text-xs text-slate-400">
                {t('head {head}…', { head: detail.head.slice(0, 16) })}
              </span>
            </div>
            <Link to={`/room/${roomId}/replay/${detail.handId}`}>
              <Button variant="secondary" className="w-full">
                {t('▶ Watch replay')}
              </Button>
            </Link>
            <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg bg-slate-50 p-3 dark:bg-slate-950/60">
              {detail.entries.map((e) => (
                <div key={e.seq} className="flex gap-2 text-xs">
                  <span className="w-8 text-right font-mono text-slate-400">{e.seq}</span>
                  <span className="w-32 font-medium">{e.type}</span>
                  <span className="truncate font-mono text-slate-400">{e.from.slice(0, 12)}</span>
                </div>
              ))}
            </div>
            <Button className="w-full" onClick={() => download(detail)}>
              {t('Download JSON')}
            </Button>
          </div>
        )}
      </Dialog>
    </div>
  );
}
