import { Button } from '../../../shared/ui/index.tsx';
import { t } from '../../../shared/i18n/index.ts';
import { ritVote } from '../../../shared/gameClient.ts';
import { useNow } from '../hooks/useNow.ts';

/** The run-it-twice vote banner, with its own countdown - ticking here, not
 *  in the page body (review fix #8). */
function RunTwicePrompt({
  offer,
  mySeat,
}: {
  offer: { deadlineTs: number; voters: number[]; voted: boolean };
  mySeat: number | null;
}) {
  const now = useNow();
  return (
    <div className="table-prompt z-20">
      <span className="table-prompt-head">
        {t('🔁 Run it twice? · {n}s', {
          n: Math.max(0, Math.ceil((offer.deadlineTs - now) / 1000)),
        })}
      </span>
      {mySeat !== null && offer.voters.includes(mySeat) && !offer.voted ? (
        <div className="flex gap-2">
          <Button
            variant="secondary"
            className="border-0 bg-[var(--table-gold)]! text-[var(--table-gold-ink)]! hover:bg-[var(--table-gold-hi)]!"
            onClick={() => ritVote(true)}
          >
            {t('Twice 🔁')}
          </Button>
          <Button
            variant="secondary"
            className="border-0 bg-[var(--table-surface-btn)]! text-[var(--table-muted)]! hover:bg-[var(--table-surface-btn)]!"
            onClick={() => ritVote(false)}
          >
            {t('Once')}
          </Button>
        </div>
      ) : (
        <span className="table-prompt-note">
          {t('Everyone is all-in - the rest of the board deals twice if all agree.')}
        </span>
      )}
    </div>
  );
}

export { RunTwicePrompt };
