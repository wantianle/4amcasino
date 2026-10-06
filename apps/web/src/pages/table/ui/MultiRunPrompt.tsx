import { useEffect, useState } from 'react';
import { Button } from '../../../shared/ui/index.tsx';
import { cn } from '../../../shared/lib/cn.ts';
import { t } from '../../../shared/i18n/index.ts';
import { agreeRunCount, chooseRunCount } from '../../../shared/gameClient.ts';
import type { ServerMsg } from '@4am/shared';
import { useNow } from '../hooks/useNow.ts';

type MultiRunOfferMsg = Extract<ServerMsg, { t: 'multi_run_offer' }>;

/**
 * P2 B4 (docs/p2-gameplay-design.md): the server-authoritative staged
 * all-in multi-run negotiation, replacing the old run-it-twice vote.
 *
 * stage `choice`  - the BEHIND hand picks how many times to run the board
 *                   (1-3, countdown on offer.deadlineTs);
 * stage `agreement` - the AHEAD hand must accept the pick or fall back to
 *                   one run. Everyone else watches a read-only line.
 *
 * The pick is optimistic on the buttons only (the game client patches
 * requestedRuns); boards are NEVER created here - they arrive with the
 * board_open frames after multi_run_result resolves the hand.
 */
function MultiRunPrompt({
  offer,
  mySeat,
  nameOf,
}: {
  offer: MultiRunOfferMsg;
  mySeat: number | null;
  nameOf: (seat: number) => string;
}) {
  const now = useNow();
  const secs = Math.max(0, Math.ceil((offer.deadlineTs - now) / 1000));
  const amBehind = mySeat !== null && mySeat === offer.behindSeat;
  const amAhead = mySeat !== null && mySeat === offer.aheadSeat;
  const behind = nameOf(offer.behindSeat);
  // one in-flight decision per decisionId: after a click the buttons die until
  // the server's next offer frame (new stage, or the result clearing it)
  const [sentPick, setSentPick] = useState<string | null>(null);
  useEffect(() => {
    setSentPick(null);
  }, [offer.decisionId, offer.stage]);
  // if the socket ate the first attempt, hand the player their buttons back
  // after a few seconds - a re-sent choice the server already processed is
  // refused by its stage guard, so retrying can only help
  useEffect(() => {
    if (!sentPick) return;
    const iv = setTimeout(() => setSentPick(null), 4000);
    return () => clearTimeout(iv);
  }, [sentPick]);

  const pick = (count: 1 | 2 | 3) => {
    if (sentPick) return;
    // chooseRunCount() patches requestedRuns optimistically; the latch just
    // keeps a double-click from sending a second signed choice.
    setSentPick(`${offer.decisionId}:${count}`);
    chooseRunCount(count);
  };
  const answer = (agree: boolean) => {
    if (sentPick) return;
    setSentPick(`${offer.decisionId}:${agree ? 'y' : 'n'}`);
    agreeRunCount(agree);
  };

  const myEquity =
    mySeat === null ? null : (offer.equities.find((e) => e.seat === mySeat)?.bps ?? null);
  const chosen = offer.requestedRuns !== undefined && offer.requestedRuns > 1;

  let headline: string;
  let detail: string | null = null;
  if (offer.stage === 'choice') {
    if (amBehind && !chosen) {
      headline = t('You are behind');
      if (myEquity !== null) detail = t('Equity {pct}%', { pct: Math.round(myEquity / 100) });
    } else if (amBehind) {
      headline = t('Waiting for the ahead player to confirm…');
    } else {
      headline = t('The behind player is choosing how many times to run the board…');
      detail = behind;
    }
  } else {
    headline = amAhead
      ? t('They asked to run it {n} times', { n: offer.requestedRuns ?? 2 })
      : t('Waiting for the ahead player to confirm…');
    if (amAhead) detail = behind;
  }

  const acting =
    (offer.stage === 'choice' && amBehind && (!chosen || sentPick !== null)) ||
    (offer.stage === 'agreement' && amAhead);

  return (
    <div
      role="region"
      aria-live="polite"
      aria-label={t('Multi-run all-in decision')}
      className="table-prompt z-20"
    >
      <div className="flex items-center gap-2">
        <span className="table-prompt-head">{t('🔁 Run it how many times?')}</span>
        <span
          className={cn(
            'rounded-full bg-white/10 px-2 py-0.5 font-display text-xs font-bold tabular-nums text-[var(--table-gold-hi)]',
            secs <= 5 && 'bg-[var(--table-red)]/80 text-white',
          )}
        >
          {t('{n}s', { n: secs })}
        </span>
      </div>
      <p className="table-prompt-detail text-center">
        {headline}
        {detail && <span className="table-prompt-note ml-1.5 font-normal">{detail}</span>}
      </p>
      {offer.stage === 'choice' && amBehind ? (
        <div className="flex gap-2">
          {([1, 2, 3] as const).map((count) => (
            <Button
              key={count}
              variant="secondary"
              className={cn(
                'border-0',
                count > 1
                  ? 'bg-[var(--table-gold)]! text-[var(--table-gold-ink)]! hover:bg-[var(--table-gold-hi)]!'
                  : 'bg-[var(--table-surface-btn)]! text-[var(--table-muted)]! hover:bg-[var(--table-surface-btn)]!',
              )}
              disabled={sentPick !== null}
              onClick={() => pick(count)}
            >
              {t('Deal {n} times', { n: count })}
            </Button>
          ))}
        </div>
      ) : offer.stage === 'agreement' && amAhead ? (
        <div className="flex gap-2">
          <Button
            variant="success"
            disabled={sentPick !== null}
            onClick={() => answer(true)}
            className="text-sm!"
          >
            {t('Agree')}
          </Button>
          <Button
            variant="secondary"
            className="border-0 bg-[var(--table-surface-btn)]! text-[var(--table-muted)]! hover:bg-[var(--table-surface-btn)]!"
            disabled={sentPick !== null}
            onClick={() => answer(false)}
          >
            {t('Just once')}
          </Button>
        </div>
      ) : null}
      {!acting && (
        <span className="table-prompt-note">
          {offer.stage === 'choice'
            ? t(
                'Only the losing side chooses; dealing more than once needs the other side to agree.',
              )
            : t('Declining or running out of time means one run.')}
        </span>
      )}
    </div>
  );
}

export { MultiRunPrompt };
