import { useRef, useState } from 'react';
import {
  DEFAULT_TOURNAMENT_POLICY,
  carriesStacks,
  tournamentFormatLabel,
  type TournamentPolicy,
  type TournamentSummary,
} from '@4am/shared';
import { Button, Input } from '../../shared/ui/index.tsx';
import { t } from '../../shared/i18n/index.ts';
import { fmt } from '../../shared/lib/cn.ts';
import { fmtDate, fmtTime } from '../../shared/lib/datetime.ts';
import './tournament-operations.css';

export const chips = (n: number) => fmt(n);
export const signedChips = (n: number) => `${n > 0 ? '+' : ''}${chips(n)}`;
export const tournamentError = (e: unknown) =>
  e instanceof Error ? e.message : t('Request failed. Please try again.');
export const formatName = (format: string) =>
  tournamentFormatLabel(format as TournamentPolicy['format']);
export const localDateInput = (value: number | null) =>
  value === null
    ? ''
    : new Date(value - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
// zh-CN combined form per §4.1: `10月1日 14:05` / `2026年10月1日 14:05`
// (same shape as pages/admin/TournamentAdmin.tsx `when`).
export const eventDate = (value: number | null) =>
  value === null
    ? t('Organizer starts when ready')
    : `${fmtDate(value)} ${fmtTime(value)}`;
export function safeExternalUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}
function supportedStreamUrl(value: string): boolean {
  if (!value) return true;
  if (!safeExternalUrl(value)) return false;
  const url = new URL(value);
  return (
    !url.port &&
    ['youtube.com', 'www.youtube.com', 'youtu.be', 'twitch.tv', 'www.twitch.tv'].includes(
      url.hostname,
    )
  );
}
export function ApprovalStatus({ tournament }: { tournament: TournamentSummary }) {
  const status = tournament.approvalStatus;
  return (
    <span className={`arena-status tournament-approval ${status}`}>
      {t(
        status === 'approved'
          ? 'Published'
          : status === 'pending'
            ? 'Awaiting approval'
            : 'Changes requested',
      )}
    </span>
  );
}
export function TournamentTerms({ tournament: tour }: { tournament: TournamentSummary }) {
  const p = tour.policy;
  return (
    <div className="tournament-terms">
      <div className="tournament-section-head">
        <h3>{t('Entry terms · revision {n}', { n: tour.revision })}</h3>
        <span className="arena-muted">
          {t(tour.termsLocked ? 'Locked on first enrollment' : 'Locks on first enrollment')}
        </span>
      </div>
      <dl className="tournament-facts">
        <div>
          <dt>{t('Format')}</dt>
          <dd>{t(formatName(p.format))}</dd>
        </div>
        <div>
          <dt>{t('Scheduled start')}</dt>
          <dd>{eventDate(p.startsAt)}</dd>
        </div>
        <div>
          <dt>{t('Entry fee')}</dt>
          <dd>{p.entryFee ? t('{n} chips', { n: chips(p.entryFee) }) : t('Free entry')}</dd>
        </div>
        <div>
          <dt>{t('Joining reward')}</dt>
          <dd>{t('{n} chips · vests at start', { n: chips(p.joiningReward) })}</dd>
        </div>
        <div>
          <dt>{t('Organizer guarantee')}</dt>
          <dd>{t('{n} chips', { n: chips(p.guaranteedPool) })}</dd>
        </div>
        <div>
          <dt>{t('Payout places')}</dt>
          <dd>{p.payoutBps.map((bps, i) => `${i + 1}: ${bps / 100}%`).join(' · ')}</dd>
        </div>
        <div>
          <dt>{t('Pot deductions')}</dt>
          <dd>
            {t('House {rate} · prize pool {pool}', {
              rate: `${p.houseBps / 100}%`,
              pool: `${p.prizeBps / 100}%`,
            })}
          </dd>
        </div>
        <div>
          <dt>{t('Blinds')}</dt>
          <dd>
            {tour.sb}/{tour.bb}
            {carriesStacks(p.format)
              ? ` · ${t('double every {n} hands', { n: p.blindEveryHands })}`
              : ` · ${t('fixed throughout')}`}
          </dd>
        </div>
        <div>
          <dt>{t('Starting stack')}</dt>
          <dd>
            {p.format === 'freezeout'
              ? t('{n} chips · your entry fee, carried between hands', { n: chips(p.entryFee) })
              : p.format === 'fixed-hand-league'
                ? t('{n} chips · reset every hand', { n: chips(tour.startingStack) })
                : t('{n} chips · carried between hands', { n: chips(tour.startingStack) })}
          </dd>
        </div>
        <div>
          <dt>{t('Sit-out budget')}</dt>
          <dd>
            {t('{a} hands · up to {b} at a time', {
              a: chips(p.sitOutBudget),
              b: chips(p.maxSitOutPerRequest),
            })}
            <br />
            <span className="arena-muted">{t('Blinds keep posting while you sit out.')}</span>
          </dd>
        </div>
        <div>
          <dt>{t('Hand limit')}</dt>
          <dd>
            {carriesStacks(p.format)
              ? t('{n} · then ranked by remaining stack', { n: chips(tour.handLimit) })
              : t('{n} hands', { n: chips(tour.handLimit) })}
          </dd>
        </div>
        <div>
          <dt>{t('Decision timer')}</dt>
          <dd>
            {t('{n} seconds · timeout checks when free, otherwise folds', {
              n: tour.actionSeconds,
            })}
          </dd>
        </div>
        <div>
          <dt>{t('Watching & disclosure')}</dt>
          <dd>
            {t(
              p.publicWatch ? 'Public watching enabled.' : 'Public watching disabled.',
            )}{' '}
            {t(
              p.revealAllAfterHand
                ? 'All hole cards, including folded cards, revealed after each hand.'
                : 'Only showdown cards revealed.',
            )}
          </dd>
        </div>
      </dl>
      {tour.prizeDescription && (
        <p className="arena-note">
          <strong>{t('Prizes:')}</strong> {tour.prizeDescription}
        </p>
      )}
      {tour.rules && (
        <p className="arena-note mt-3">
          <strong>{t('Organizer rules:')}</strong> {tour.rules}
        </p>
      )}
      <p className="arena-muted mt-4">
        {t(
          'Whole competition chips, settled manually. These amounts are separate from cash and ordinary room balances. Entry obligations reverse if cancelled before play. After play, cancellation allocates the earned pool by current standings. Tied places share their combined prize allocation.',
        )}
      </p>
      <p className="arena-muted mt-3">
        {t(
          'Deductions apply once to each contested pot; uncalled returns are exempt. The organizer guarantee funds joining rewards and the starting prize pool. Recorded payments are platform records of settlement.',
        )}
      </p>
    </div>
  );
}

export function TournamentTermsForm({
  tournament,
  platform,
  onSave,
  onCancel,
}: {
  tournament?: TournamentSummary;
  platform: boolean;
  onSave: (body: Record<string, unknown>) => Promise<void>;
  onCancel?: () => void;
}) {
  const p = tournament?.policy ?? DEFAULT_TOURNAMENT_POLICY;
  const [format, setFormat] = useState(p.format);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  return (
    <form
      className="tournament-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (pending.current) return;
        const f = new FormData(event.currentTarget);
        setError('');
        try {
          const payoutBps = String(f.get('payouts'))
            .split(',')
            .map((value) => Math.round(Number(value.trim()) * 100));
          if (
            !payoutBps.length ||
            payoutBps.some((v) => !Number.isInteger(v) || v <= 0) ||
            payoutBps.reduce((sum, n) => sum + n, 0) !== 10000
          )
            throw new Error(
              t(
                'Payout percentages must be positive and add up to 100%. Separate each place with a comma.',
              ),
            );
          const policy = {
            ...p,
            format,
            startsAt: f.get('startsAt') ? new Date(String(f.get('startsAt'))).getTime() : null,
            entryFee: Number(f.get('entryFee')),
            joiningReward: Number(f.get('joiningReward')),
            guaranteedPool: Number(f.get('guaranteedPool')),
            houseBps: Math.round(Number(f.get('houseRate')) * 100),
            prizeBps: Math.round(Number(f.get('prizeRate')) * 100),
            payoutBps,
            blindEveryHands: Number(f.get('blindEveryHands')),
            sitOutBudget: Number(f.get('sitOutBudget')),
            maxSitOutPerRequest: Number(f.get('maxSitOutPerRequest')),
            publicWatch: f.get('publicWatch') === 'on',
            revealAllAfterHand: true,
            streamUrl: String(f.get('streamUrl')).trim(),
            meetUrl: String(f.get('meetUrl')).trim(),
          };
          const capacity = Number(f.get('capacity'));
          if (policy.guaranteedPool < capacity * policy.joiningReward)
            throw new Error(
              t('The organizer guarantee must cover joining rewards for all {n} seats ({total} chips).', {
                n: capacity,
                total: chips(capacity * policy.joiningReward),
              }),
            );
          for (const url of [policy.streamUrl, policy.meetUrl])
            if (url && !safeExternalUrl(url))
              throw new Error(
                t('Broadcast links must use HTTPS and contain no embedded credentials.'),
              );
          if (!supportedStreamUrl(policy.streamUrl))
            throw new Error(t('Use a YouTube or Twitch HTTPS link for the stream.'));
          if (
            policy.meetUrl &&
            (new URL(policy.meetUrl).hostname !== 'meet.google.com' || new URL(policy.meetUrl).port)
          )
            throw new Error(t('Use a meet.google.com link for Google Meet.'));
          const body: Record<string, unknown> = {
            name: String(f.get('name')).trim(),
            description: String(f.get('description')).trim(),
            rules: String(f.get('rules')).trim(),
            prizeDescription: String(f.get('prizeDescription')).trim(),
            policy,
          };
          if (tournament) body.revision = tournament.revision;
          Object.assign(body, {
            capacity: Number(f.get('capacity')),
            handLimit: Number(f.get('handLimit')),
            startingStack: Number(f.get('startingStack')),
            sb: Number(f.get('sb')),
            bb: Number(f.get('bb')),
            actionSeconds: Number(f.get('actionSeconds')),
          });
          pending.current = true;
          setBusy(true);
          await onSave(body);
        } catch (e) {
          setError(tournamentError(e));
        } finally {
          pending.current = false;
          setBusy(false);
        }
      }}
    >
      <fieldset disabled={busy} className="tournament-fieldset arena-form">
        <legend>{t('Event details')}</legend>
        <label className="arena-field wide">
          {t('Tournament name')}
          <Input
            name="name"
            required
            minLength={3}
            maxLength={80}
            defaultValue={tournament?.name ?? ''}
            placeholder={t('Friday Agent League')}
          />
        </label>
        <label className="arena-field wide">
          {t('Description')}
          <textarea
            className="arena-input"
            name="description"
            rows={2}
            maxLength={2000}
            defaultValue={tournament?.description ?? ''}
          />
        </label>
        <label className="arena-field">
          {t('Format')}
          <select
            className="arena-input"
            value={format}
            onChange={(e) => setFormat(e.target.value as typeof format)}
          >
            <option value="fixed-hand-league">{t('Fixed-hand league · equal stacks')}</option>
            <option value="knockout">{t('Knockout · last player standing')}</option>
            <option value="freezeout">{t('Freezeout · entry fee is your stack')}</option>
          </select>
        </label>
        <label className="arena-field">
          {t('Scheduled start · your local time')}
          <Input type="datetime-local" name="startsAt" defaultValue={localDateInput(p.startsAt)} />
          <span className="arena-muted">
            {t('Optional. Approved events start with at least two entrants.')}
          </span>
        </label>
        <>
          <label className="arena-field">
            {t('Seats')}
            <Input
              name="capacity"
              type="number"
              min={2}
              max={9}
              step={1}
              defaultValue={tournament?.capacity ?? 6}
              required
            />
          </label>
          <label className="arena-field">
            {t(carriesStacks(format) ? 'Maximum hands' : 'Hands per entrant')}
            <Input
              name="handLimit"
              type="number"
              min={10}
              max={10000}
              step={1}
              defaultValue={tournament?.handLimit ?? 1000}
              required
            />
          </label>
          <label className="arena-field">
            {t(
              format === 'freezeout'
                ? 'Starting stack · set by the entry fee'
                : carriesStacks(format)
                  ? 'Starting stack'
                  : 'Stack reset every hand',
            )}
            <Input
              name="startingStack"
              type="number"
              min={100}
              max={1000000}
              step={1}
              defaultValue={tournament?.startingStack ?? 2000}
              required
            />
          </label>
          <label className="arena-field">
            {t('Seconds per decision')}
            <Input
              name="actionSeconds"
              type="number"
              min={10}
              max={300}
              step={1}
              defaultValue={tournament?.actionSeconds ?? 60}
              required
            />
          </label>
          <label className="arena-field">
            {t('Small blind')}
            <Input
              name="sb"
              type="number"
              min={1}
              max={10000}
              step={1}
              defaultValue={tournament?.sb ?? 10}
              required
            />
          </label>
          <label className="arena-field">
            {t('Big blind')}
            <Input
              name="bb"
              type="number"
              min={2}
              max={20000}
              step={1}
              defaultValue={tournament?.bb ?? 20}
              required
            />
          </label>
        </>
        <label className="arena-field">
          {t('Blind increase interval · hands')}
          <Input
            name="blindEveryHands"
            type="number"
            min={1}
            max={10000}
            step={1}
            defaultValue={p.blindEveryHands}
            required
          />
          <span className="arena-muted">
            {t('Blinds double at this interval in knockout and freezeout events.')}
          </span>
        </label>
        <label className="arena-field">
          {t('Sit-out budget · hands')}
          <Input
            name="sitOutBudget"
            type="number"
            min={0}
            max={200}
            step={1}
            defaultValue={p.sitOutBudget}
            required
          />
          <span className="arena-muted">
            {t('Total hands one entrant may sit out. Blinds still post, so sitting out costs chips.')}
          </span>
        </label>
        <label className="arena-field">
          {t('Longest single sit-out · hands')}
          <Input
            name="maxSitOutPerRequest"
            type="number"
            min={0}
            max={200}
            step={1}
            defaultValue={p.maxSitOutPerRequest}
            required
          />
          <span className="arena-muted">{t('Cannot exceed the whole sit-out budget.')}</span>
        </label>
      </fieldset>
      <fieldset disabled={busy} className="tournament-fieldset arena-form">
        <legend>{t('Chips & payouts')}</legend>
        <p className="arena-muted tournament-wide">
          {t('Whole competition chips. No cash collection or automated payment occurs here.')}
        </p>
        <label className="arena-field">
          {t('Entry fee · chips')}
          <Input
            name="entryFee"
            type="number"
            min={0}
            max={1000000000}
            step={1}
            defaultValue={p.entryFee}
            required
          />
        </label>
        <label className="arena-field">
          {t('Joining reward · chips')}
          <Input
            name="joiningReward"
            type="number"
            min={0}
            max={1000000000}
            step={1}
            defaultValue={p.joiningReward}
            required
          />
        </label>
        <label className="arena-field">
          {t('Organizer guarantee · chips')}
          <Input
            name="guaranteedPool"
            type="number"
            min={0}
            max={1000000000}
            step={1}
            defaultValue={p.guaranteedPool}
            required
          />
          <span className="arena-muted">{t('Funds joining rewards and any starting prize pool.')}</span>
        </label>
        {(
          [
            ['houseRate', 'House cut · %', p.houseBps],
            ['prizeRate', 'Prize pool cut · %', p.prizeBps],
          ] as const
        ).map(([name, label, value]) => (
          <label className="arena-field" key={name}>
            {t(label)}
            <Input
              name={name}
              type="number"
              min={0}
              max={10}
              step={0.01}
              defaultValue={value / 100}
              required
            />
          </label>
        ))}
        <label className="arena-field wide">
          {t('Payout percentages · first place onward')}
          <Input
            name="payouts"
            defaultValue={p.payoutBps.map((v) => v / 100).join(', ')}
            required
            placeholder="60, 30, 10"
          />
          <span className="arena-muted">
            {t('Comma-separated percentages adding to 100. Ties split affected places.')}
          </span>
        </label>
        <label className="arena-field wide">
          {t('Prize description')}
          <textarea
            className="arena-input"
            name="prizeDescription"
            rows={2}
            maxLength={1000}
            defaultValue={tournament?.prizeDescription ?? ''}
          />
        </label>
        <label className="arena-field wide">
          {t('Additional entry & award rules')}
          <textarea
            className="arena-input"
            name="rules"
            rows={3}
            maxLength={4000}
            defaultValue={tournament?.rules ?? ''}
          />
        </label>
      </fieldset>
      <fieldset disabled={busy} className="tournament-fieldset arena-form">
        <legend>{t('Watching & broadcast')}</legend>
        <label className="tournament-checkbox tournament-wide">
          <input name="publicWatch" type="checkbox" defaultChecked={p.publicWatch} />
          {t('Allow anonymous public watching')}
        </label>
        <p className="arena-muted tournament-wide">
          {t(
            'Saving these terms publishes all hole cards, including folded hands, after each hand. This disclosure is included in the entry terms accepted by entrants.',
          )}
        </p>
        <label className="arena-field">
          {t('YouTube or Twitch stream URL')}
          <Input name="streamUrl" type="url" defaultValue={p.streamUrl} placeholder="https://" />
        </label>
        <label className="arena-field">
          {t('Google Meet URL')}
          <Input
            name="meetUrl"
            maxLength={1000}
            type="url"
            defaultValue={p.meetUrl}
            placeholder="https://meet.google.com/…"
          />
        </label>
      </fieldset>
      <p className="arena-muted">
        {t(
          platform
            ? 'Publishing opens enrollment. Published terms permanently lock when the first entrant enrolls.'
            : 'Your proposal stays private until the platform approves it. Changes return it for review. Published terms permanently lock when the first entrant enrolls.',
        )}
      </p>
      {error && (
        <p className="arena-error" role="alert">
          {error}
        </p>
      )}
      <div className="arena-controls">
        <Button disabled={busy}>
          {busy
            ? t('Saving…')
            : t(
                tournament
                  ? platform
                    ? 'Save published terms'
                    : 'Save & submit for review'
                  : platform
                    ? 'Publish tournament'
                    : 'Submit for approval',
              )}
        </Button>
        {onCancel && (
          <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>
            {t('Cancel editing')}
          </Button>
        )}
      </div>
    </form>
  );
}

export function TournamentMediaForm({
  tournament,
  onSave,
}: {
  tournament: TournamentSummary;
  onSave: (body: { streamUrl: string; meetUrl: string }) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  return (
    <form
      className="tournament-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (pending.current) return;
        const f = new FormData(event.currentTarget);
        const body = {
          streamUrl: String(f.get('streamUrl')).trim(),
          meetUrl: String(f.get('meetUrl')).trim(),
        };
        if ([body.streamUrl, body.meetUrl].some((url) => url && !safeExternalUrl(url))) {
          setError(t('Use HTTPS links without embedded credentials.'));
          return;
        }
        if (!supportedStreamUrl(body.streamUrl)) {
          setError(t('Use a YouTube or Twitch HTTPS link for the stream.'));
          return;
        }
        if (
          body.meetUrl &&
          (new URL(body.meetUrl).hostname !== 'meet.google.com' || new URL(body.meetUrl).port)
        ) {
          setError(t('Use a meet.google.com link for Google Meet.'));
          return;
        }
        pending.current = true;
        setBusy(true);
        setError('');
        try {
          await onSave(body);
        } catch (e) {
          setError(tournamentError(e));
        } finally {
          pending.current = false;
          setBusy(false);
        }
      }}
    >
      <label className="arena-field">
        {t('YouTube or Twitch stream URL')}
        <Input
          name="streamUrl"
          maxLength={1000}
          type="url"
          disabled={busy}
          defaultValue={tournament.policy.streamUrl}
          placeholder="https://"
        />
      </label>
      <label className="arena-field">
        {t('Google Meet URL')}
        <Input
          name="meetUrl"
          maxLength={1000}
          type="url"
          disabled={busy}
          defaultValue={tournament.policy.meetUrl}
          placeholder="https://meet.google.com/…"
        />
      </label>
      <p className="arena-muted">
        {t('Broadcast links can be updated after entry terms lock. Clear a field to remove its link.')}
      </p>
      {error && (
        <p role="alert" className="arena-error">
          {error}
        </p>
      )}
      <Button disabled={busy}>{busy ? t('Saving links…') : t('Save broadcast links')}</Button>
    </form>
  );
}
