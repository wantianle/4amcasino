import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CaretDown, CaretUp, ClockCounterClockwise } from '@phosphor-icons/react';
import { useStore } from '../../shared/store.ts';
import { cn, fmt } from '../../shared/lib/cn.ts';
import { t } from '../../shared/i18n/index.ts';
import { tScore } from '../../shared/i18n/pokerLabels.ts';
import { PlayingCard } from '../../entities/card/PlayingCard.tsx';
import { ShowdownCards } from './ShowdownCards.tsx';

/** The previous hand, one click away at the bottom of the table: who won,
 *  with what, and everyone's revealed cards - open it when you want the
 *  recap, collapse it when you don't. The choice is remembered.
 *  (requested by notpritam, docs/FEATURES.md) */
export function LastHandStrip({ roomId, light = false }: { roomId: string; light?: boolean }) {
  const last = useStore((s) => s.lastHand);
  const currentHandId = useStore((s) => s.hand.handId);
  const [open, setOpen] = useState(() => localStorage.getItem('4am-last-hand') === 'on');
  // hidden while the hand it describes is still the one on the table
  if (!last || last.handId === currentHandId) return null;
  const toggle = () => {
    const next = !open;
    setOpen(next);
    localStorage.setItem('4am-last-hand', next ? 'on' : 'off');
  };
  const nameOf = (seat: number) => last.names[seat] ?? t('Seat {n}', { n: seat + 1 });
  const winners = last.deltas.filter((d) => d.delta > 0);
  const top = [...last.reveals].sort((a, b) => b.score - a.score)[0];
  // Every run the snapshot froze. New snapshots carry the canonical `boards`
  // (1-3 runs); older persisted recaps only have the legacy board/board2 pair.
  const runs =
    last.boards && last.boards.length > 0
      ? last.boards
      : last.board2.length > 0
        ? [last.board, last.board2]
        : last.board.length > 0
          ? [last.board]
          : [];
  const runAwards = last.multiRun?.awards ?? last.runTwice?.awards ?? [];
  const runCount = runs.length;
  const headline =
    winners.length === 0
      ? t('chips stayed put')
      : `${winners.map((w) => `${nameOf(w.seat)} +${fmt(w.delta)}`).join(' & ')} · ${
          runCount > 2
            ? t('ran it {n} times', { n: runCount })
            : runCount === 2
              ? t('ran it twice')
              : top
                ? tScore(top.score)
                : t('everyone folded')
        }`;

  return (
    <div
      className={cn(
        'rounded-2xl',
        light
          ? 'bg-white/10 text-white'
          : 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200/70 dark:bg-slate-900 dark:text-slate-100 dark:ring-slate-700/70',
      )}
    >
      <button
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left"
      >
        <ClockCounterClockwise
          size={15}
          className={light ? 'text-white/50' : 'text-slate-400'}
          aria-label={t('Last hand')}
        />
        <span className="text-xs font-semibold uppercase tracking-[0.14em]">{t('Last hand')}</span>
        <span className={cn('min-w-0 flex-1 truncate text-sm', light ? 'text-white/70' : 'text-slate-500')}>
          {headline}
        </span>
        {open ? (
          <CaretDown size={14} className={light ? 'text-white/50' : 'text-slate-400'} />
        ) : (
          <CaretUp size={14} className={light ? 'text-white/50' : 'text-slate-400'} />
        )}
      </button>
      {open && (
        <div className="space-y-2.5">
          {runs.map((cards, k) => {
            const awards = runAwards[k] ?? [];
            return (
              <div key={k} className="flex flex-wrap items-center gap-1.5">
                {/* a single-run hand needs no label; 2-3 runs get 第 N 跑 */}
                {runCount > 1 && (
                  <span className="w-11 shrink-0 text-[0.65rem] font-bold uppercase tracking-wide text-fuchsia-500">
                    {t('Run {n}', { n: k + 1 })}
                  </span>
                )}
                {cards.map((c) => (
                  <PlayingCard key={`r${k}-${c}`} card={c} size="xs" />
                ))}
                {awards.filter((a) => a.amount > 0).length > 0 && (
                  <span
                    className={cn(
                      'ml-1 text-xs font-semibold',
                      light ? 'text-emerald-300' : 'text-emerald-600 dark:text-emerald-400',
                    )}
                  >
                    {awards
                      .filter((a) => a.amount > 0)
                      .map((a) => `${nameOf(a.seat)} +${fmt(a.amount)}`)
                      .join(' & ')}
                  </span>
                )}
              </div>
            );
          })}
          <ShowdownCards
            reveals={last.reveals}
            shown={last.shown}
            deltas={last.deltas}
            nameOf={nameOf}
            light={light}
          />
          {last.reveals.length === 0 && Object.keys(last.shown).length === 0 && (
            <p className={cn('text-xs', light ? 'text-white/50' : 'text-slate-500')}>
              {t('No cards were shown - the pot went to the last player standing.')}
            </p>
          )}
          <Link
            to={`/room/${roomId}/replay/${last.handId}`}
            className={cn(
              'inline-block text-xs font-semibold',
              light ? 'text-indigo-300' : 'text-indigo-600 dark:text-indigo-400',
            )}
          >
            {t('Full replay →')}
          </Link>
        </div>
      )}
    </div>
  );
}
