import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { RiArrowRightLine, RiAddLine, RiRobot2Line } from '@remixicon/react';
import type { PlayerAction, TournamentState, TournamentSummary } from '@4am/shared';
import { carriesStacks } from '@4am/shared';
import { api } from '../../shared/api.ts';
import { useStore } from '../../shared/store.ts';
import { t } from '../../shared/i18n/index.ts';
import { fmt } from '../../shared/lib/cn.ts';
import { fmtTime } from '../../shared/lib/datetime.ts';
import { Button, Input, Spinner } from '../../shared/ui/index.tsx';
import { PlayingCard } from '../../entities/card/PlayingCard.tsx';
import './arena.css';
import { SponsorPlacements } from './SponsorPlacements.tsx';
import {
  ApprovalStatus,
  TournamentTerms,
  TournamentTermsForm,
  TournamentMediaForm,
  eventDate,
  formatName,
  safeExternalUrl,
} from './TournamentTerms.tsx';

// zh-CN grouping via shared fmt (docs/zh-i18n.md §4.1/§6.2 — no bare toLocaleString).
const number = (n: number) => fmt(n);
const signed = (n: number) => `${n > 0 ? '+' : ''}${number(n)}`;
const errorText = (e: unknown) =>
  e instanceof Error ? e.message : t('Request failed. Please try again.');
function Status({ status }: { status: string }) {
  return (
    <span className={`arena-status ${status}`}>
      {t(status === 'registration' ? 'Enrollment open' : status[0]!.toUpperCase() + status.slice(1))}
    </span>
  );
}

export function TournamentsPage() {
  const { id } = useParams();
  return id ? <TournamentDetail key={id} id={id} /> : <TournamentList />;
}
function TournamentList() {
  const auth = useStore((s) => s.auth);
  const [rows, setRows] = useState<TournamentSummary[] | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState('Upcoming');
  const nav = useNavigate();
  const load = useCallback(() => {
    setError('');
    void api
      .tournaments()
      .then((r) => setRows(r.tournaments))
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);
  const visible = rows?.filter((row) =>
    filter === 'My proposals'
      ? row.ownerId === auth.userId
      : row.approvalStatus === 'approved' &&
        (filter === 'Upcoming'
          ? row.status === 'registration'
          : filter === 'Live'
            ? ['running', 'paused'].includes(row.status)
            : ['completed', 'cancelled'].includes(row.status)),
  );
  return (
    <main className="arena-page">
      <header className="arena-header">
        <div>
          <h1>{t('Tournaments')}</h1>
          <p className="arena-muted">
            {t(
              'Find your next table. Read the terms, bring your agent, and play for the published prizes.',
            )}
          </p>
        </div>
        <div className="arena-controls">
          {auth.token ? (
            <>
              <Link className="arena-link" to="/agents">
                {t('Connect an agent')}
              </Link>
              <Button
                type="button"
                variant={creating ? 'secondary' : 'primary'}
                onClick={() => setCreating((v) => !v)}
              >
                <RiAddLine size={18} />
                {creating
                  ? t('Close form')
                  : auth.isPlatform
                    ? t('Create tournament')
                    : t('Propose a tournament')}
              </Button>
            </>
          ) : (
            <Link className="arena-link" to="/login?next=%2Ftournaments">
              {t('Sign in to propose a tournament')}
            </Link>
          )}
        </div>
      </header>
      {error && (
        <div role="alert" className="arena-error">
          {error}{' '}
          <Button variant="ghost" onClick={load}>
            {t('Retry')}
          </Button>
        </div>
      )}
      {creating && auth.token && (
        <section className="arena-panel tournament-create">
          <h2>{t(auth.isPlatform ? 'Publish a tournament' : 'Propose a tournament')}</h2>
          <TournamentTermsForm
            platform={!!auth.isPlatform}
            onSave={async (body) => {
              const result = await api.createTournament(body);
              nav(`/tournaments/${result.id}`);
            }}
          />
        </section>
      )}
      <div className="arena-grid">
        <section className="arena-panel" aria-label={t('Tournaments')}>
          <div className="arena-tabs tournament-filter" aria-label={t('Filter tournaments')}>
            {['Upcoming', 'Live', 'Past', ...(auth.token ? ['My proposals'] : [])].map((name) => (
              <button
                key={name}
                type="button"
                aria-pressed={filter === name}
                onClick={() => setFilter(name)}
              >
                {t(name)}
              </button>
            ))}
          </div>
          {rows === null && !error ? (
            <Spinner label={t('Loading tournaments…')} />
          ) : !visible?.length ? (
            <div className="arena-empty">
              <h2>
                {filter === 'My proposals'
                  ? t('Your next tournament starts here.')
                  : t('No {state} tournaments yet.', { state: t(filter) })}
              </h2>
              <p className="arena-muted">
                {filter === 'My proposals'
                  ? t(
                      'Set the format, schedule, entry terms and prizes, then submit your proposal for platform review.',
                    )
                  : filter === 'Upcoming'
                    ? t(
                        'Propose a fixed-hand league, knockout or freezeout to bring players together.',
                      )
                    : filter === 'Live'
                      ? t(
                          'Events appear here when play begins. Check upcoming tournaments for your next seat.',
                        )
                      : t(
                          'Completed and cancelled tournaments stay here with their saved standings and prizes.',
                        )}
              </p>
            </div>
          ) : (
            visible.map((row) => (
              <Link key={row.id} to={`/tournaments/${row.id}`} className="arena-row">
                <div>
                  <div className="arena-name">{row.name}</div>
                  <div className="arena-row-meta">
                    <span>{t(formatName(row.format))}</span>
                    <span>
                      {t('{a}/{b} entrants', { a: row.entrantCount ?? 0, b: row.capacity })}
                    </span>
                    <span>
                      {row.entryFee
                        ? t('{n} chips entry', { n: number(row.entryFee) })
                        : t('Free entry')}
                    </span>
                  </div>
                  <div className="arena-row-meta">
                    <Status status={row.status} />
                    {row.approvalStatus !== 'approved' && <ApprovalStatus tournament={row} />}
                    <span>
                      {row.status === 'completed'
                        ? t('Final standings available')
                        : row.status === 'cancelled'
                          ? t('Event closed')
                          : row.status === 'running'
                            ? t('Play in progress')
                            : row.status === 'paused'
                              ? t('Play paused')
                              : eventDate(row.policy.startsAt)}
                    </span>
                  </div>
                  {row.policy.guaranteedPool > 0 && (
                    <div className="arena-row-meta">
                      {t('Organizer guarantee · {n} chips', {
                        n: number(row.policy.guaranteedPool),
                      })}
                    </div>
                  )}
                </div>
                <RiArrowRightLine size={20} aria-hidden />
              </Link>
            ))
          )}
        </section>
        <aside className="arena-stack">
          <SponsorPlacements placement="directory" />
          <section className="arena-panel">
            <h2>{t('Choose your format')}</h2>
            <h3>{t('Fixed-hand league')}</h3>
            <p className="arena-muted">
              {t('Stacks reset each hand. Compare net chips and BB/100 over a fixed run.')}
            </p>
            <h3 className="mt-5">{t('Knockout')}</h3>
            <p className="arena-muted">
              {t('Keep your stack between hands. Blinds rise on schedule and eliminated players leave play.')}
            </p>
          </section>
          <section className="arena-panel">
            <h2>{t('Read before you enroll')}</h2>
            <p className="arena-muted">
              {t(
                'Entry fees, rewards, pot cuts and payout places are published before enrollment. Your accepted rule revision locks the terms.',
              )}
            </p>
            <p className="arena-muted mt-3">
              {t(
                'All accounting uses competition chips and manual settlement, separate from cash and ordinary poker room balances.',
              )}
            </p>
          </section>
        </aside>
      </div>
    </main>
  );
}
function TournamentDetail({ id }: { id: string }) {
  const auth = useStore((s) => s.auth);
  const [state, setState] = useState<TournamentState | null>(null);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [tab, setTab] = useState('Standings');
  const [amount, setAmount] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(false);
  const [acceptedRevision, setAcceptedRevision] = useState<number | null>(null);
  const refresh = useCallback(async () => {
    const s = await api.tournament(id);
    setState(s);
    return s;
  }, [id]);
  useEffect(() => {
    let active = true,
      loading = false;
    const load = async () => {
      if (loading || document.hidden) return;
      loading = true;
      try {
        const s = await api.tournament(id);
        if (active) {
          setState(s);
          setPollError('');
        }
      } catch (e) {
        if (active) setPollError(errorText(e));
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [id]);
  useEffect(() => setAmount(''), [state?.round?.handNumber, state?.round?.actionSeq]);
  async function mutate(fn: () => Promise<unknown>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  if (!state)
    return (
      <main className="arena-page">
        {error || pollError ? (
          <div role="alert" className="arena-error">
            {error || pollError}{' '}
            <Button onClick={() => void refresh().catch((e) => setError(errorText(e)))}>
              {t('Retry')}
            </Button>
          </div>
        ) : (
          <Spinner label={t('Loading tournament…')} />
        )}
      </main>
    );
  const me = state.entries.find((e) => e.userId === auth.userId);
  const organizer = state.ownerId === auth.userId || auth.isPlatform;
  const preStart = ['registration', 'pending', 'rejected'].includes(state.status);
  const round = state.round;
  const legal = state.status === 'running' ? round?.legalActions : null;
  const act = (action: PlayerAction) => {
    if (!round) return;
    void mutate(() =>
      api.tournamentAction(id, round.handNumber, round.actionSeq, crypto.randomUUID(), action),
    );
  };
  return (
    <main className="arena-page">
      <Link className="arena-link arena-detail-nav" to="/tournaments">
        {t('All tournaments')}
      </Link>
      <header className="arena-header">
        <div>
          <h1>{state.name}</h1>
          <p className="arena-muted">
            {state.description ||
              t('{format} for people and their agents.', {
                format: t(formatName(state.format)),
              })}
          </p>
          <div className="arena-row-meta">
            <Status status={state.status} />
            <span>
              {t('{a}/{b} entrants', { a: state.entries.length, b: state.capacity })}
            </span>
            <span>
              {t(formatName(state.format))} ·{' '}
              {state.entryFee
                ? t('{n} chips entry', { n: number(state.entryFee) })
                : t('Free entry')}
            </span>
            <ApprovalStatus tournament={state} />
          </div>
        </div>
        <div className="arena-controls">
          {state.policy.publicWatch && state.approvalStatus === 'approved' && (
            <Link className="arena-link" to={`/tournaments/${id}/watch`}>
              {t('Public watch page')}
            </Link>
          )}
          <Button
            variant="secondary"
            onClick={() =>
              void navigator.clipboard
                .writeText(location.href)
                .then(() => setNotice(t('Tournament link copied.')))
                .catch(() =>
                  setError(t('Could not copy. Copy the address from your browser.')),
                )
            }
          >
            {t('Copy invite link')}
          </Button>
          {me && (
            <Link className="arena-link" to={`/agents?kind=tournament&id=${id}`}>
              <RiRobot2Line size={18} className="inline mr-1" />
              {t('Connect my agent')}
            </Link>
          )}
        </div>
      </header>
      {error && (
        <div className="arena-error" role="alert">
          {error}
        </div>
      )}
      {pollError && (
        <div className="arena-error" role="alert">
          {t('Live updates interrupted: {error}', { error: pollError })}
        </div>
      )}
      {notice && (
        <p className="arena-toast" role="status">
          {notice}
        </p>
      )}
      {state.approvalStatus !== 'approved' && state.status !== 'cancelled' && (
        <section className="arena-panel tournament-create">
          <h2>
            {t(
              state.approvalStatus === 'pending'
                ? 'Proposal awaiting approval'
                : 'Changes requested',
            )}
          </h2>
          <p className="arena-muted">
            {t('This proposal is private. Enrollment opens after platform approval.')}
          </p>
          {state.reviewNote && (
            <p className="arena-note mt-3">
              <strong>{t('Platform review:')}</strong> {state.reviewNote}
            </p>
          )}
        </section>
      )}
      {editing && organizer && !state.termsLocked && (
        <section className="arena-panel tournament-create">
          <h2>{t('Edit tournament terms')}</h2>
          <TournamentTermsForm
            key={state.revision}
            tournament={state}
            platform={!!auth.isPlatform}
            onCancel={() => setEditing(false)}
            onSave={async (body) => {
              await api.tournamentTerms(id, body);
              setEditing(false);
              await refresh();
              setNotice(
                auth.isPlatform
                  ? t('Published terms updated.')
                  : t('Proposal submitted for review.'),
              );
            }}
          />
        </section>
      )}
      <div className="arena-grid">
        <div className="arena-stack">
          <section className="arena-panel">
            <div className="arena-controls" style={{ justifyContent: 'space-between' }}>
              <h2 style={{ marginBottom: 0 }}>
                {preStart
                  ? state.approvalStatus === 'approved'
                    ? t('Take your place')
                    : t('Enrollment pending approval')
                  : state.status === 'completed'
                    ? t('Tournament complete')
                    : state.status === 'cancelled'
                      ? t('Tournament cancelled')
                      : t('Hand {n}', { n: round?.handNumber ?? 0 })}
              </h2>
              <span className="arena-muted">
                {t('{done} / {limit} hands', {
                  done: number(state.completedHands),
                  limit: number(state.handLimit),
                })}
              </span>
            </div>
            <progress
              className="arena-progress"
              value={state.completedHands}
              max={state.handLimit}
              aria-label={t('Tournament hand progress')}
            />
            {preStart ? (
              state.approvalStatus !== 'approved' ? (
                <p className="arena-muted mt-4">
                  {t(
                    'The platform must approve this revision before entrants can accept the terms.',
                  )}
                </p>
              ) : me ? (
                <div className="arena-empty">
                  <h3>{t('You’re enrolled as {name}.', { name: me.agentName })}</h3>
                  <p className="arena-muted">
                    {me.kind === 'agent'
                      ? t('Connect your agent before the tournament starts.')
                      : t('Keep this page open to take your turns.')}
                  </p>
                  {state.status === 'registration' && (
                    <Button
                      className="mt-4"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void mutate(() => api.withdrawTournament(id))}
                    >
                      {t('Withdraw')}
                    </Button>
                  )}
                  {state.status === 'running' && me.eliminatedHand === null && (
                    <form
                      className="mt-4"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const hands = Number(new FormData(e.currentTarget).get('hands'));
                        void mutate(() => api.sitOutTournament(id, hands));
                      }}
                    >
                      <label className="arena-field">
                        {t('Sit out · hands')}
                        <Input
                          name="hands"
                          type="number"
                          min={1}
                          max={Math.max(
                            1,
                            Math.min(state.policy.maxSitOutPerRequest, me.sitOutRemaining),
                          )}
                          step={1}
                          defaultValue={1}
                          disabled={busy || me.sitOutRemaining === 0}
                        />
                        <span className="arena-muted">
                          {me.sitOutRemaining > 0
                            ? t(
                                '{a} of {b} sit-out hands left. Blinds keep posting, so sitting out costs chips.',
                                { a: number(me.sitOutRemaining), b: number(state.policy.sitOutBudget) },
                              )
                            : t('Your sit-out budget is spent. You must play on.')}
                        </span>
                      </label>
                      <Button
                        type="submit"
                        variant="secondary"
                        disabled={busy || me.sitOutRemaining === 0}
                      >
                        {t('Sit out')}
                      </Button>
                    </form>
                  )}
                </div>
              ) : (
                <>
                  <div className="mt-5">
                    <TournamentTerms tournament={state} />
                  </div>
                  {auth.isPlatform ? (
                    <p className="arena-muted mt-5">
                      {t('Platform accounts manage tournaments. Use a player account to enroll.')}
                    </p>
                  ) : !auth.token ? (
                    <Link
                      className="arena-link inline-block mt-5"
                      to={`/login?next=${encodeURIComponent(`/tournaments/${id}`)}`}
                    >
                      {t('Sign in to enroll')}
                    </Link>
                  ) : (
                    <form
                      className="arena-form mt-5"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (!auth.token || acceptedRevision !== state.revision) return;
                        const f = new FormData(e.currentTarget);
                        void mutate(() =>
                          api.enrollTournament(
                            id,
                            String(f.get('name')),
                            f.get('kind') as 'human' | 'agent',
                            state.revision,
                          ),
                        );
                      }}
                    >
                      <label className="arena-field">
                        {t('Participant name')}
                        <input
                          name="name"
                          className="arena-input"
                          required
                          minLength={2}
                          maxLength={48}
                          defaultValue={auth.username ?? ''}
                        />
                      </label>
                      <label className="arena-field">
                        {t('Who will play?')}
                        <select name="kind" className="arena-input">
                          <option value="agent">{t('My agent')}</option>
                          <option value="human">{t('I will play')}</option>
                        </select>
                      </label>
                      <label className="tournament-checkbox tournament-wide">
                        <input
                          type="checkbox"
                          required
                          checked={acceptedRevision === state.revision}
                          onChange={(e) =>
                            setAcceptedRevision(e.target.checked ? state.revision : null)
                          }
                        />
                        {t(
                          'I accept revision {n}, including the entry fee, payouts, deductions and card disclosure.',
                          { n: state.revision },
                        )}
                      </label>
                      <Button
                        disabled={
                          busy ||
                          acceptedRevision !== state.revision ||
                          state.entries.length >= state.capacity
                        }
                      >
                        {state.entries.length >= state.capacity
                          ? t('Tournament full')
                          : busy
                            ? t('Enrolling…')
                            : state.entryFee
                              ? t('Accept & enroll · {n} chips', { n: number(state.entryFee) })
                              : t('Accept & enroll for free')}
                      </Button>
                    </form>
                  )}
                </>
              )
            ) : (
              round && (
                <>
                  <div className="arena-board" aria-label={t('Community cards')}>
                    {round.board.length ? (
                      round.board.map((card) => <PlayingCard key={card} card={card} size="sm" />)
                    ) : (
                      <p className="arena-muted">
                        {state.status === 'completed'
                          ? t('Last hand ended before the flop.')
                          : t('Preflop · community cards follow the betting.')}
                      </p>
                    )}
                  </div>
                  <div>
                    {round.seats.map((p) => (
                      <div
                        key={p.userId}
                        className={`arena-player ${round.toActUserId === p.userId && state.status === 'running' ? 'active' : ''}`}
                      >
                        <span>
                          {state.entries.find((e) => e.userId === p.userId)?.agentName}
                          {p.userId === auth.userId ? ` ${t('(you)')}` : ''}
                          {p.folded ? ` · ${t('Folded')}` : p.allIn ? ` · ${t('All-in')}` : ''}
                        </span>
                        <span>
                          {t('{n} chips', {
                            n: number(
                              round.result
                                ? (round.result.net.find((e) => e.userId === p.userId)?.endStack ??
                                    p.stack +
                                      (round.result.net.find((e) => e.userId === p.userId)
                                        ?.won ?? 0))
                                : p.stack,
                            ),
                          })}
                          {!round.result && p.committed
                            ? ` · ${t('{n} in', { n: number(p.committed) })}`
                            : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                  {!!round.myCards.length && (
                    <div className="arena-hand mt-5">
                      <span className="arena-muted">{t('Your cards')}</span>
                      {round.myCards.map((card) => (
                        <PlayingCard key={card} card={card} size="sm" />
                      ))}
                    </div>
                  )}
                  {state.status === 'running' && me && (
                    <div className="mt-5">
                      <p className="arena-muted">
                        {legal
                          ? t('Your turn') +
                            (state.deadline
                              ? ` · ${t('Deadline {time}', {
                                  time: fmtTime(state.deadline),
                                })}`
                              : '')
                          : t('Waiting for {who}.', {
                              who:
                                state.entries.find((e) => e.userId === round.toActUserId)
                                  ?.agentName ?? t('the next hand'),
                            })}
                      </p>
                      <div className="arena-actions">
                        <Button
                          variant="secondary"
                          disabled={!legal || busy}
                          onClick={() => act({ type: 'fold' })}
                        >
                          {t('Fold')}
                        </Button>
                        <Button
                          disabled={!legal || busy}
                          onClick={() => act({ type: legal?.canCheck ? 'check' : 'call' })}
                        >
                          {legal?.canCheck
                            ? t('Check')
                            : legal
                              ? t('Call {n}', { n: number(legal.callAmount) })
                              : t('Call')}
                        </Button>
                        <label className="arena-field">
                          {round.betting.currentBet ? t('Raise to') : t('Bet')}
                          <input
                            aria-label={t('Bet or raise amount')}
                            className="arena-input"
                            type="number"
                            min={legal?.minRaiseTo}
                            max={legal?.maxRaiseTo}
                            value={amount}
                            onChange={(e) => setAmount(e.target.value)}
                            disabled={!legal?.canRaise || busy}
                            placeholder={String(legal?.minRaiseTo ?? '')}
                          />
                        </label>
                        <Button
                          variant="secondary"
                          disabled={
                            !legal?.canRaise ||
                            busy ||
                            !Number.isInteger(Number(amount)) ||
                            Number(amount) < (legal?.minRaiseTo ?? Infinity) ||
                            Number(amount) > (legal?.maxRaiseTo ?? 0)
                          }
                          onClick={() =>
                            act({
                              type: round.betting.currentBet ? 'raise' : 'bet',
                              amount: Number(amount),
                            })
                          }
                        >
                          {round.betting.currentBet ? t('Raise') : t('Bet')}
                        </Button>
                      </div>
                    </div>
                  )}
                  {state.status === 'paused' && (
                    <p className="arena-muted mt-5">
                      {t('Paused. Scores and the current hand are saved; the organizer can resume.')}
                    </p>
                  )}
                </>
              )
            )}
          </section>
          <div id="arena-results" tabIndex={-1} aria-label={t('Tournament results')}>
            <div className="arena-tabs" aria-label={t('Tournament sections')}>
              {['Standings', 'Winnings', 'Last hand', 'Rules & prizes'].map((name) => (
                <button key={name} aria-pressed={tab === name} onClick={() => setTab(name)}>
                  {t(name)}
                </button>
              ))}
            </div>
            <section className="arena-panel">
              {tab === 'Standings' && (
                <>
                  <h2>{t('Standings')}</h2>
                  {!state.entries.length ? (
                    <p className="arena-muted">
                      {t('No entrants yet. Share the link to fill the table.')}
                    </p>
                  ) : (
                    <div className="arena-table-wrap">
                      <table className="arena-table">
                        <thead>
                          <tr>
                            <th>{t('Place')}</th>
                            <th>{t('Entrant')}</th>
                            <th>{t(carriesStacks(state.format) ? 'Stack' : 'Play net')}</th>
                            <th>{t('Prize chips')}</th>
                            <th>BB / 100</th>
                            <th>{t('Hands')}</th>
                            <th>{t('Timeouts')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {state.entries.map((e) => (
                            <tr key={e.userId}>
                              <td>{e.hands ? e.rank : '—'}</td>
                              <td className="name">
                                {e.agentName}
                                <div className="arena-muted" style={{ fontSize: 12 }}>
                                  {t(e.kind === 'agent' ? 'Agent' : 'Human')} ·{' '}
                                  {t(e.online ? 'Online' : 'Offline')}
                                </div>
                              </td>
                              <td
                                className={
                                  e.net > 0 ? 'arena-positive' : e.net < 0 ? 'arena-negative' : ''
                                }
                              >
                                {carriesStacks(state.format) ? number(e.stack) : signed(e.net)}
                              </td>
                              <td>{number(e.prize)}</td>
                              <td>{e.bbPer100.toFixed(2)}</td>
                              <td>{number(e.hands)}</td>
                              <td>{e.timeouts}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <p className="arena-muted mt-4">
                    {t(
                      carriesStacks(state.format)
                        ? 'Ranked by elimination order, then remaining stack. Eliminated entrants keep their final place.'
                        : 'Ranked by play net. Equal scores share a place. BB/100 is net big blinds per 100 hands.',
                    )}{' '}
                    {t('Play net measures performance and is separate from settlement dues.')}
                  </p>
                </>
              )}
              {tab === 'Last hand' && (
                <>
                  <h2>{t('Last completed hand')}</h2>
                  {state.lastResult ? (
                    <>
                      <p className="arena-muted">{t('Hand {n}', { n: state.lastResult.handNumber })}</p>
                      <div className="arena-board">
                        {state.lastResult.board.map((card) => (
                          <PlayingCard key={card} card={card} size="sm" />
                        ))}
                      </div>
                      {state.lastResult.net.map((p) => (
                        <div className="arena-player" key={p.userId}>
                          <span>{state.entries.find((e) => e.userId === p.userId)?.agentName}</span>
                          <span className={p.net >= 0 ? 'arena-positive' : 'arena-negative'}>
                            {signed(p.net)}
                          </span>
                        </div>
                      ))}
                    </>
                  ) : (
                    <p className="arena-muted">
                      {t('Results appear after the first hand finishes.')}
                    </p>
                  )}
                </>
              )}
              {tab === 'Winnings' && (
                <>
                  <h2>
                    {t(
                      ['completed', 'cancelled'].includes(state.status)
                        ? 'Final chip allocation'
                        : 'Entry accounting',
                    )}
                  </h2>
                  <p className="arena-muted">
                    {t(
                      'Settlement net = joining reward + prize − entry fee. Positive outstanding means chips due to the entrant; negative means chips due from the entrant. Play net is shown separately.',
                    )}
                  </p>
                  {!state.entries.length ? (
                    <p className="arena-muted mt-4">
                      {t('Entry accounting appears when the first player enrolls.')}
                    </p>
                  ) : (
                    <div className="arena-table-wrap mt-4">
                      <table className="arena-table">
                        <thead>
                          <tr>
                            <th>{t('Entrant')}</th>
                            <th>{t('Entry fee')}</th>
                            <th>{t('Joining reward')}</th>
                            <th>{t('Prize')}</th>
                            <th>{t('Play net')}</th>
                            <th>{t('Settlement net')}</th>
                            <th>{t('Recorded paid')}</th>
                            <th>{t('Outstanding')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {state.entries.map((e) => (
                            <tr key={e.userId}>
                              <td className="name">{e.agentName}</td>
                              <td>{number(e.entryFee)}</td>
                              <td>{number(e.joiningReward)}</td>
                              <td>{number(e.prize)}</td>
                              <td>{signed(e.net)}</td>
                              <td>{signed(e.joiningReward + e.prize - e.entryFee)}</td>
                              <td>{signed(e.recordedPaid)}</td>
                              <td>{signed(e.outstanding)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <p className="arena-muted mt-4">
                    {t(
                      'All values are competition chips. Payments are recorded by the platform after manual settlement. Prizes become final when the event ends.',
                    )}
                  </p>
                </>
              )}
              {tab === 'Rules & prizes' && (
                <>
                  <h2>{t('Rules & prizes')}</h2>
                  <TournamentTerms tournament={state} />
                  {state.entries
                    .filter((e) => e.awardNote)
                    .map((e) => (
                      <p key={e.userId} className="arena-note mt-4">
                        <strong>{e.agentName}:</strong> {e.awardNote}
                      </p>
                    ))}
                  {organizer && state.status === 'completed' && (
                    <form
                      className="arena-form mt-5"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const f = new FormData(e.currentTarget);
                        void mutate(() =>
                          api.tournamentAward(id, Number(f.get('entrant')), String(f.get('note'))),
                        );
                      }}
                    >
                      <label className="arena-field">
                        {t('Award recipient')}
                        <select name="entrant" className="arena-input">
                          {state.entries.map((e) => (
                            <option key={e.userId} value={e.userId}>
                              {t('{name} · place {n}', { name: e.agentName, n: e.rank })}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="arena-field">
                        {t('Award note')}
                        <input
                          className="arena-input"
                          name="note"
                          maxLength={500}
                          required
                          placeholder={t('Reward and fulfillment status')}
                        />
                      </label>
                      <Button disabled={busy}>{t('Record award note')}</Button>
                    </form>
                  )}
                </>
              )}
            </section>
          </div>
        </div>
        <aside className="arena-stack">
          <SponsorPlacements placement="tournament" tournamentId={id} />
          {organizer && (
            <section className="arena-panel">
              <h2>
                {t(
                  state.status === 'completed'
                    ? 'Review awards'
                    : state.status === 'cancelled'
                      ? 'Tournament cancelled'
                      : 'Organizer controls',
                )}
              </h2>
              <div className="arena-controls">
                {preStart && !state.termsLocked && (
                  <Button
                    variant="secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => setEditing((v) => !v)}
                  >
                    {t(editing ? 'Close editor' : 'Edit terms')}
                  </Button>
                )}
                {state.status === 'completed' && (
                  <Button
                    onClick={() => {
                      setTab('Rules & prizes');
                      requestAnimationFrame(() => {
                        const results = document.getElementById('arena-results');
                        results?.focus({ preventScroll: true });
                        results?.scrollIntoView({ block: 'start' });
                      });
                    }}
                  >
                    {t('Open rules & prizes')}
                  </Button>
                )}
                {state.status === 'registration' && state.approvalStatus === 'approved' && (
                  <Button
                    disabled={busy || state.entries.length < 2}
                    onClick={() => void mutate(() => api.controlTournament(id, 'start'))}
                  >
                    {t('Start tournament')}
                  </Button>
                )}
                {state.status === 'running' && (
                  <Button
                    disabled={busy}
                    variant="secondary"
                    onClick={() => void mutate(() => api.controlTournament(id, 'pause'))}
                  >
                    {t('Pause tournament')}
                  </Button>
                )}
                {state.status === 'paused' && (
                  <Button
                    disabled={busy}
                    onClick={() => void mutate(() => api.controlTournament(id, 'resume'))}
                  >
                    {t('Resume tournament')}
                  </Button>
                )}
                {['registration', 'paused', 'pending', 'rejected'].includes(state.status) && (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          t(
                            'Cancel this tournament? Before play, entry obligations reverse. After play, the earned pool is allocated by standings. Saved results remain and play cannot resume.',
                          ),
                        )
                      )
                        void mutate(() => api.controlTournament(id, 'cancel'));
                    }}
                  >
                    {t('Cancel')}
                  </Button>
                )}
              </div>
              <p className="arena-muted mt-3">
                {t(
                  state.status === 'completed'
                    ? 'Review the final standings, then record award notes for your entrants. Notes do not send payouts.'
                    : state.status === 'cancelled'
                      ? 'Saved hands and standings remain available. This tournament cannot resume.'
                      : preStart
                        ? state.approvalStatus !== 'approved'
                          ? 'Approval is required before enrollment and play.'
                          : 'At least two entrants are required. Scheduled approved events start automatically; the organizer may also start them here.'
                        : 'Pausing saves the current hand. Resume when entrants are ready to continue.',
                )}
              </p>
              {state.scheduleNote && <p className="arena-note mt-3">{state.scheduleNote}</p>}
              <p className="arena-muted mt-3">
                {t(
                  state.termsLocked
                    ? 'Entry terms are permanently locked because an entrant accepted them.'
                    : 'Terms can be edited until the first enrollment.',
                )}
              </p>
            </section>
          )}
          {auth.isPlatform && (
            <section className="arena-panel">
              <h2>{t('Broadcast links')}</h2>
              <TournamentMediaForm
                key={`${state.policy.streamUrl}:${state.policy.meetUrl}`}
                tournament={state}
                onSave={async (body) => {
                  await api.tournamentMedia(id, body);
                  await refresh();
                  setNotice(t('Broadcast links updated.'));
                }}
              />
            </section>
          )}
          <section className="arena-panel">
            <h2>{t('Tournament funds')}</h2>
            <dl className="tournament-facts tournament-facts-single">
              <div>
                <dt>{t('Available prize pool')}</dt>
                <dd>{t('{n} chips', { n: number(state.finance.pool) })}</dd>
              </div>
              <div>
                <dt>{t('Prizes allocated')}</dt>
                <dd>{t('{n} chips', { n: number(state.finance.prizes) })}</dd>
              </div>
              <div>
                <dt>{t('House accrued')}</dt>
                <dd>{t('{n} chips', { n: number(state.finance.house) })}</dd>
              </div>
              <div>
                <dt>{t('Sponsor contributions')}</dt>
                <dd>{t('{n} chips', { n: number(state.finance.sponsorContributions) })}</dd>
              </div>
            </dl>
            <p className="arena-muted">
              {t(
                'Competition-chip accounting. Recorded separately from cash and room balances.',
              )}
            </p>
          </section>
          {(state.policy.streamUrl || state.policy.meetUrl) && (
            <section className="arena-panel">
              <h2>{t('Join the broadcast')}</h2>
              <div className="arena-controls">
                {safeExternalUrl(state.policy.streamUrl) && (
                  <a
                    className="arena-link"
                    href={safeExternalUrl(state.policy.streamUrl)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t('Open stream')}
                  </a>
                )}
                {safeExternalUrl(state.policy.meetUrl) && (
                  <a
                    className="arena-link"
                    href={safeExternalUrl(state.policy.meetUrl)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t('Open Google Meet')}
                  </a>
                )}
              </div>
              <p className="arena-muted mt-3">{t('Links open in a new tab.')}</p>
            </section>
          )}
          {auth.token &&
            (state.status === 'registration' ||
              (me && ['running', 'paused'].includes(state.status))) && (
              <section className="arena-panel">
                <h2>
                  {t(
                    state.status === 'registration'
                      ? 'Bring your own agent'
                      : 'Your agent connection',
                  )}
                </h2>
                <p className="arena-muted">
                  {t(
                    state.status === 'registration'
                      ? 'Enroll, create a token for this tournament, then connect your MCP client. Your agent receives your cards and legal actions.'
                      : 'Your seat is enrolled. Connect your MCP client with a token for this tournament. Keep it running to respond when your turn arrives.',
                  )}
                </p>
                <Link
                  className="arena-link inline-block mt-4"
                  to={`/agents?kind=tournament&id=${id}`}
                >
                  {t('Set up agent access')}
                </Link>
              </section>
            )}
          <section className="arena-panel">
            <h2>{t('Deal commitment')}</h2>
            <p className="arena-muted">
              {t(
                'The seed is committed before enrollment. It is revealed after completion so the shuffle sequence can be reproduced. The server still deals and knows the cards.',
              )}
            </p>
            <code className="arena-code block mt-3">{state.seedCommitment}</code>
            {state.seed && (
              <>
                <h3 className="mt-4">{t('Revealed seed')}</h3>
                <code className="arena-code block">{state.seed}</code>
              </>
            )}
          </section>
        </aside>
      </div>
    </main>
  );
}
