import { useEffect, useState } from 'react';
import { api } from '../../shared/api.ts';
import { useStore } from '../../shared/store.ts';
import { Button, Spinner } from '../../shared/ui/index.tsx';
import { t, tr } from '../../shared/i18n/index.ts';
import { fmtDate, fmtTime } from '../../shared/lib/datetime.ts';
import './arena.css';
type Scope = { id: string; name: string; kind: 'room' };
type Grant = Awaited<ReturnType<typeof api.agentGrants>>['grants'][number];
type Created = { id: string; token: string; expiresAt: number; scope: Scope; canPlay: boolean };

/** zh-CN expiry stamp, e.g. `10月8日 14:30` (docs/zh-i18n.md §4.1). */
function expiresText(ts: number): string {
  return `${fmtDate(ts)} ${fmtTime(ts)}`;
}

export function AgentsPage() {
  const auth = useStore((s) => s.auth);
  const [scopes, setScopes] = useState<Scope[] | null>(null);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [selected, setSelected] = useState(() => {
    const p = new URLSearchParams(location.search);
    return `${p.get('kind') ?? ''}:${p.get('id') ?? ''}`;
  });
  const [label, setLabel] = useState(t('My agent'));
  const [canPlay, setCanPlay] = useState(true);
  const [days, setDays] = useState(7);
  const [shareKey, setShareKey] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const scope = scopes?.find((s) => `${s.kind}:${s.id}` === selected);
  const load = async () => {
    const [s, g] = await Promise.all([api.agentScopes(), api.agentGrants()]);
    // Agent access is room-only now; drop any non-room scopes the server may
    // still return (legacy data) so they can never be granted.
    const roomScopes = s.scopes.filter((x) => (x as { kind: string }).kind === 'room');
    setScopes(roomScopes);
    setGrants(g.grants);
    setSelected((previous) =>
      roomScopes.some((s) => `${s.kind}:${s.id}` === previous)
        ? previous
        : roomScopes[0]
          ? `${roomScopes[0].kind}:${roomScopes[0].id}`
          : '',
    );
  };
  useEffect(() => {
    setCreated(null);
    void load().catch((e) => setError(e.message));
  }, [auth.userId]);
  const download = (name: string, content: string) => {
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  function config(redacted = false) {
    if (!created) return '';
    return JSON.stringify(
      {
        mcpServers: {
          '4am-casino': {
            command: 'npx',
            args: ['tsx', '/path/to/4amcasino/apps/mcp/src/index.ts'],
            env: {
              FOURAM_URL: location.origin,
              FOURAM_TOKEN: redacted ? '<private token included in download>' : created.token,
              ...(created.canPlay
                ? {
                    FOURAM_SIGNING_KEY: redacted
                      ? '<your local signing key included in download>'
                      : auth.identity?.secretKey,
                  }
                : {}),
            },
          },
        },
      },
      null,
      2,
    );
  }
  return (
    <main className="arena-page">
      <header className="arena-header">
        <div>
          <h1>{t('Agent access')}</h1>
          <p className="arena-muted">
            {t(
              'Connect your own agent to a single table. You choose what it can do and when access ends.',
            )}
          </p>
        </div>
      </header>
      {error && (
        <div className="arena-error" role="alert">
          {tr(error)}
        </div>
      )}
      {notice && (
        <p className="arena-toast" role="status">
          {notice}
        </p>
      )}
      <div className="arena-grid">
        <div className="arena-stack">
          <section className="arena-panel">
            <h2>{t('Create agent access')}</h2>
            {scopes === null ? (
              error ? (
                <Button onClick={() => void load().catch((e) => setError(e.message))}>
                  {t('Retry')}
                </Button>
              ) : (
                <Spinner label={t('Loading your tables…')} />
              )
            ) : scopes.length === 0 ? (
              <div className="arena-empty">
                <h3>{t('Choose a table first.')}</h3>
                <p className="arena-muted">
                  {t('Join a poker room before granting an agent access.')}
                </p>
              </div>
            ) : (
              <form
                className="arena-form"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (busy || !scope) return;
                  setBusy(true);
                  setError('');
                  setNotice('');
                  setCreated(null);
                  try {
                    const g = await api.createAgentGrant({
                      label,
                      scopeKind: scope.kind,
                      scopeId: scope.id,
                      canPlay,
                      days,
                    });
                    setCreated({ ...g, scope, canPlay });
                    await load();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Could not create access.');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <label className="arena-field">
                  {t('Agent label')}
                  <input
                    className="arena-input"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    required
                    maxLength={60}
                  />
                </label>
                <label className="arena-field">
                  {t('Expires in')}
                  <select
                    className="arena-input"
                    value={days}
                    onChange={(e) => setDays(Number(e.target.value))}
                  >
                    <option value={1}>{t('1 day')}</option>
                    <option value={7}>{t('7 days')}</option>
                    <option value={30}>{t('30 days')}</option>
                  </select>
                </label>
                <label className="arena-field wide">
                  {t('Room')}
                  <select
                    className="arena-input"
                    value={selected}
                    onChange={(e) => {
                      setSelected(e.target.value);
                      setShareKey(false);
                    }}
                  >
                    {scopes.map((s) => (
                      <option key={`${s.kind}:${s.id}`} value={`${s.kind}:${s.id}`}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="arena-check" style={{ gridColumn: '1/-1' }}>
                  <input
                    type="checkbox"
                    checked={canPlay}
                    onChange={(e) => setCanPlay(e.target.checked)}
                  />
                  <span>
                    <strong>{t('Allow this agent to play as me')}</strong>
                    {canPlay
                      ? t(
                          'It can make poker decisions for your seat. Banking and account settings are excluded.',
                        )
                      : t(
                          'Read-only: table details and public events. The agent cannot play.',
                        )}
                  </span>
                </label>
                {canPlay && (
                  <label className="arena-check" style={{ gridColumn: '1/-1' }}>
                    <input
                      type="checkbox"
                      checked={shareKey}
                      onChange={(e) => setShareKey(e.target.checked)}
                    />
                    <span>
                      <strong>
                        {t('Include my local poker signing key in the download')}
                      </strong>
                      {t(
                        'Encrypted-room play needs this key. Give the file only to your own trusted local agent. It runs the crypto on your computer; the key is not uploaded by this setup form.',
                      )}
                    </span>
                  </label>
                )}
                {canPlay && !auth.identity && (
                  <p className="arena-error">{t('Sign in again to load your poker signing key.')}</p>
                )}
                <Button
                  disabled={
                    busy ||
                    !scope ||
                    (canPlay && (!shareKey || !auth.identity))
                  }
                >
                  {busy ? t('Creating…') : t('Create access token')}
                </Button>
              </form>
            )}
          </section>
          {created && (
            <section className="arena-panel" aria-label={t('New agent configuration')}>
              <h2>{t('Your agent is ready to connect')}</h2>
              <p className="arena-muted">
                {t('Save this configuration now. The token is shown only for this setup.')}{' '}
                {t('Replace {path} with your local checkout path.', {
                  path: '/path/to/4amcasino',
                })}
              </p>
              <pre className="arena-code mt-4">{config(true)}</pre>
              <div className="arena-controls mt-4">
                <Button
                  onClick={() => {
                    download('4am-agent.mcp.json', config());
                    setNotice(t('Agent configuration downloaded. Keep it private.'));
                  }}
                >
                  {t('Download MCP configuration')}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(created.token)
                      .then(() => setNotice(t('Agent token copied.')))
                      .catch(() =>
                        setError('Clipboard unavailable. Download the configuration instead.'),
                      )
                  }
                >
                  {t('Copy token')}
                </Button>
                <Button variant="ghost" onClick={() => setCreated(null)}>
                  {t('Hide configuration')}
                </Button>
              </div>
              <p className="arena-muted mt-3">
                {t('Scope: {scope}. Expires {when}.', {
                  scope: created.scope.name,
                  when: expiresText(created.expiresAt),
                })}
              </p>
            </section>
          )}
          <section className="arena-panel">
            <h2>{t('Your access tokens')}</h2>
            {!grants.length ? (
              <p className="arena-muted">{t('No agent tokens yet.')}</p>
            ) : (
              grants.map((g) => {
                const active = !g.revokedAt && g.expiresAt > Date.now();
                return (
                  <div key={g.id} className="arena-grant">
                    <div className="arena-controls" style={{ justifyContent: 'space-between' }}>
                      <div>
                        <h3>{g.label}</h3>
                        <p className="arena-muted">
                          {scopes?.find((s) => s.id === g.scopeId)?.name ?? g.scopeId} ·{' '}
                          {g.canPlay ? t('Can play') : t('Read-only')}
                        </p>
                      </div>
                      {active ? (
                        <Button
                          variant="secondary"
                          disabled={busy}
                          onClick={async () => {
                            setBusy(true);
                            setError('');
                            try {
                              await api.revokeAgentGrant(g.id);
                              if (created?.id === g.id) setCreated(null);
                              await load();
                              setNotice(t('Agent access revoked.'));
                            } catch (e) {
                              setError(e instanceof Error ? e.message : 'Could not revoke access.');
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          {t('Revoke')}
                        </Button>
                      ) : (
                        <span className="arena-status">
                          {g.revokedAt ? t('Revoked') : t('Expired')}
                        </span>
                      )}
                    </div>
                    <p className="arena-muted mt-2">
                      {t('Expires {when}', { when: expiresText(g.expiresAt) })}
                    </p>
                  </div>
                );
              })
            )}
          </section>
        </div>
        <aside className="arena-stack">
          <section className="arena-panel">
            <h2>{t('Listen, then decide')}</h2>
            <ol className="arena-help-list arena-muted">
              <li>
                {t('Use {tool} to read your seat.', { tool: 'casino_state' })}
              </li>
              <li>{t('Use {tool} to wait for changes.', { tool: 'subscribe_events' })}</li>
              <li>{t('Read fresh state, then send a legal action.')}</li>
            </ol>
            <p className="arena-muted mt-4">
              {t(
                'Actions include a hand number, action sequence and request ID, so retries cannot play a later turn.',
              )}
            </p>
          </section>
          <section className="arena-panel">
            <h2>{t('Webhook delivery')}</h2>
            <p className="arena-muted">
              {t(
                'Run the local webhook relay from the repository to forward your subscribed room events to your agent. It signs deliveries and saves a cursor for retries.',
              )}
            </p>
            <pre className="arena-code mt-3">npm run webhook --workspace @4am/mcp</pre>
            <p className="arena-muted mt-3">
              {t('Configure the receiver, scope and signing secret in your environment.')}{' '}
              {t('Setup and the MCP tool reference are in {file}.', {
                file: 'apps/mcp/README.md',
              })}
            </p>
          </section>
        </aside>
      </div>
    </main>
  );
}
