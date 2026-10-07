import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CaretDown, CaretUp, ClockCounterClockwise } from '@phosphor-icons/react';
import { useStore } from '../../shared/store.ts';
import { cn, fmt } from '../../shared/lib/cn.ts';
import { t } from '../../shared/i18n/index.ts';
import { tScore } from '../../shared/i18n/pokerLabels.ts';
import { PlayingCard } from '../../entities/card/PlayingCard.tsx';
import { ShowdownCards } from './ShowdownCards.tsx';

/** The rake a hand took out of the pot, from the players' side. The protocol
 *  guarantees `sum(hand_end.deltas) === -commission` (wsProtocol), so the
 *  negated seat leg is the total every seat's net already reflects - even when
 *  the recipient is not seated (`commissionDeltas`, the recipient projection,
 *  is empty then). This is the "how much was raked" figure, not "who received
 *  it". */
export function rakeTakenOf(deltas: readonly { delta: number }[]): number {
  // Subtract (not negate the sum): keeps zero at +0 instead of -0.
  return deltas.reduce((rake, d) => rake - d.delta, 0);
}

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
  const rakeTaken = rakeTakenOf(last.deltas);
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
        light ? 'bg-white/10 text-white' : 'table-lasthand',
      )}
    >
      <button
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left"
      >
        <ClockCounterClockwise
          size={15}
          className={light ? 'text-white/50' : 'lh-ic'}
          aria-label={t('Last hand')}
        />
        <span className={cn('text-xs font-semibold uppercase tracking-[0.14em]', !light && 'lh-lab')}>
          {t('Last hand')}
        </span>
        <span className={cn('lh-txt min-w-0 flex-1 truncate text-sm', light && 'text-white/70')}>
          {headline}
        </span>
        {open ? (
          <CaretDown size={14} className={light ? 'text-white/50' : 'lh-caret'} />
        ) : (
          <CaretUp size={14} className={light ? 'text-white/50' : 'lh-caret'} />
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
                  <span
                    className={cn(
                      'w-11 shrink-0 text-[0.65rem] font-bold uppercase tracking-wide',
                      light ? 'text-fuchsia-500' : 'text-[var(--table-gold-hi)]',
                    )}
                  >
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
                      light ? 'text-emerald-300' : 'text-[var(--table-up)]',
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
          {rakeTaken > 0 && (
            <p className={cn('text-xs', light ? 'text-white/60' : 'text-slate-500')}>
              {t('Rake')} {fmt(rakeTaken)}
            </p>
          )}
          {last.reveals.length === 0 && Object.keys(last.shown).length === 0 && (
            <p className={cn('lh-txt text-xs', light && 'text-white/50')}>
              {t('No cards were shown - the pot went to the last player standing.')}
            </p>
          )}
          <Link
            to={`/room/${roomId}/replay/${last.handId}`}
            className={cn('inline-block text-xs font-semibold', light && 'text-indigo-300')}
          >
            {t('Full replay →')}
          </Link>
        </div>
      )}
    </div>
  );
}
