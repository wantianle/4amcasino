import { Coins } from '@phosphor-icons/react';
import { fmt } from '../../shared/lib/cn.ts';
import { t } from '../../shared/i18n/index.ts';

/** The rake of the hand that JUST ended, shown for the same instant as the
 *  result window and gone with it - NOT the recap.
 *
 *  f03ada3 deliberately removed the dismissible post-hand recap panel; this is
 *  the one number from it the player asked to see at the moment the hand ends
 *  instead of only in the next hand's LastHandStrip. It is therefore kept
 *  deliberately small: no headline, no board, no nets, no dismiss button - a
 *  muted chip that leaves the winner's gold ring as the visual focus.
 *
 *  The figure is the total taken out of the pot, from the players' side
 *  (`-sum(deltas)`, the same `rakeTakenOf` the LastHandStrip uses). It renders
 *  nothing at all for an unraked hand, so "Rake 0" can never appear. */
export function RakeNotice({ amount }: { amount: number }) {
  if (amount <= 0) return null;
  return (
    <span
      data-testid="rake-notice"
      className="pointer-events-none flex items-center gap-1.5 rounded-full bg-slate-950/75 px-3 py-1 text-xs font-medium text-white/80 ring-1 ring-white/10 backdrop-blur"
    >
      <Coins size={13} weight="fill" className="text-amber-300/80" aria-hidden />
      <span className="tabular-nums">
        {t('Rake')} {fmt(amount)}
      </span>
    </span>
  );
}
