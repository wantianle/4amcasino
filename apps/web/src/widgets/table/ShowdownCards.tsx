import { cn, fmt } from '../../shared/lib/cn.ts';
import { HAND_CATEGORY_NAMES, handCategory } from '@4am/shared';
import { t } from '../../shared/i18n/index.ts';
import { tHandCategory } from '../../shared/i18n/pokerLabels.ts';
import { PlayingCard } from '../../entities/card/PlayingCard.tsx';

/** The hand's ending, per player: THEIR two cards, what they made, their net.
 *  Everyone sees exactly what they won or lost to, not just the winning five
 *  (requested by notpritam, docs/FEATURES.md). */
export function ShowdownCards({
  reveals,
  shown,
  deltas,
  nameOf,
  light,
}: {
  reveals: { seat: number; cards: number[]; score: number }[];
  shown: Record<number, number[]>;
  deltas: { seat: number; delta: number }[];
  nameOf: (seat: number) => string;
  light: boolean;
}) {
  const rows: { seat: number; cards: number[]; score: number | null }[] = [
    ...reveals.map((r) => ({ seat: r.seat, cards: r.cards, score: r.score as number | null })),
    ...Object.entries(shown)
      .filter(([seat]) => !reveals.some((r) => r.seat === +seat))
      .map(([seat, cards]) => ({ seat: +seat, cards, score: null })),
  ];
  const deltaOf = (seat: number) => deltas.find((d) => d.seat === seat)?.delta ?? 0;
  rows.sort((a, b) => deltaOf(b.seat) - deltaOf(a.seat));
  if (rows.length === 0) return null;
  const labelOf = (score: number | null) => {
    if (score === null) return t('showed after folding');
    const cat = HAND_CATEGORY_NAMES[handCategory(score)];
    return cat ? tHandCategory(cat) : '';
  };
  return (
    <div className="flex flex-wrap gap-2.5">
      {rows.map((r) => {
        const delta = deltaOf(r.seat);
        return (
          <div
            key={r.seat}
            className={cn(
              'flex items-center gap-2.5 rounded-xl p-2 pr-3',
              light
                ? 'bg-white/10'
                : 'bg-[var(--table-surface-label)] ring-1 ring-[var(--table-hairline)] text-[var(--table-ink)]',
            )}
          >
            {/* shrink-0: as flex children these were compressed narrower than a
                card whenever the row was tight, which read as overlapping */}
            <div className="flex shrink-0 gap-1">
              {r.cards.map((c) => (
                <PlayingCard key={c} card={c} size="sm" deal className="shrink-0" />
              ))}
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold leading-tight">{nameOf(r.seat)}</div>
              <div className={cn('text-xs', light ? 'text-white/60' : 'text-[var(--table-muted)]')}>
                {labelOf(r.score)}
              </div>
            </div>
            <div
              className={cn(
                'font-display text-sm font-bold',
                delta > 0
                  ? light
                    ? 'text-emerald-300'
                    : 'text-[var(--table-up)]'
                  : delta < 0
                    ? light
                      ? 'text-rose-300'
                      : 'text-[var(--table-down)]'
                    : light
                      ? 'text-white/50'
                      : 'text-[var(--table-faint)]',
              )}
            >
              {delta > 0 ? '+' : ''}
              {fmt(delta)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

