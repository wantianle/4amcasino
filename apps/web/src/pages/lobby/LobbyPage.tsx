import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  DEFAULT_GAMEPLAY_SETTINGS,
  MAX_QUALIFYING_HANDS,
  commissionRateLabel,
  type RoomGameplaySettings,
} from '@4am/shared';
import { useCommissionSettings } from '../../shared/useCommissionSettings.ts';
import { api } from '../../shared/api.ts';
import { useStore } from '../../shared/store.ts';
import { t } from '../../shared/i18n/index.ts';
import { Badge, Button, Dialog, Input, Panel } from '../../shared/ui/index.tsx';
import { cn } from '../../shared/lib/cn.ts';
import { FriendsPanel, InvitesPanel } from '../../features/friends/FriendsPanel.tsx';
import { NetAreaChart } from '../../features/stats/charts.tsx';
import { CopyInvite } from '../../features/share/ShareRoom.tsx';
import {
  GameplayRulesToggle,
  GameplaySettingsEditor,
  cloneGameplaySettings,
  enabledFeatureCount,
  enabledFeatureNames,
} from '../../features/table/GameplaySettingsDialog.tsx';
import { fmt } from '../../shared/lib/cn.ts';

interface RoomSummary {
  id: string;
  name: string;
  joinCode: string;
  sb: number;
  bb: number;
  playerCount: number;
  /** Retired table: kept for its history, out of the active list. */
  archived?: number;
}

export function LobbyPage() {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const commission = useCommissionSettings(createOpen);
  const [joinCode, setJoinCode] = useState('');
  const [name, setName] = useState('');
  const [sb, setSb] = useState(10);
  const [bb, setBb] = useState(20);
  const [actionSecs, setActionSecs] = useState(45);
  const [minSettleHands, setMinSettleHands] = useState(0);
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  // P2 gameplay rules (squid / time bank / bomb pot / multi-run), seeded from
  // the shared defaults and sent with the room on create.
  const [features, setFeatures] = useState<RoomGameplaySettings>(() =>
    cloneGameplaySettings(DEFAULT_GAMEPLAY_SETTINGS),
  );
  const [rulesOpen, setRulesOpen] = useState(false);
  const [timeline, setTimeline] = useState<{ ts: number; net: number }[]>([]);
  const [myStats, setMyStats] = useState<{
    net: number;
    handsPlayed: number;
    biggestWin: number;
  } | null>(null);
  const [publicRooms, setPublicRooms] = useState<
    {
      id: string;
      name: string;
      sb: number;
      bb: number;
      playerCount: number;
      hostName: string;
    }[]
  >([]);
  const [strictAudit, setStrictAudit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prefs = useStore((s) => s.prefs);
  const username = useStore((s) => s.auth.username);
  const nav = useNavigate();

  useEffect(() => {
    api
      .myRooms({ archived: 'all' })
      .then((r) => setRooms(r.rooms))
      .catch(() => {});
    api
      .publicRooms()
      .then((r) => setPublicRooms(r.rooms))
      .catch(() => {});
    api
      .timeline()
      .then((r) => setTimeline(r.points))
      .catch(() => {});
  }, []);
  const userId = useStore((s) => s.auth.userId);
  useEffect(() => {
    if (userId)
      api
        .userProfile(userId)
        .then((r) => setMyStats(r.stats))
        .catch(() => {});
  }, [userId]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!commission.settings || commission.error) return;
    try {
      const room = await api.createRoom(
        name,
        sb,
        bb,
        strictAudit ? 'strict-audit' : undefined,
        actionSecs,
        minSettleHands,
        commission.settings.revision,
        enabledFeatureCount(features) > 0 ? features : undefined,
      );
      const extras: Record<string, unknown> = {};
      if (visibility === 'public') extras.visibility = 'public';
      if (Object.keys(extras).length) await api.roomExtras(room.id, extras);
      nav(`/room/${room.id}`);
    } catch (err) {
      void commission.refresh();
      setError(err instanceof Error ? err.message : t('could not create room'));
    }
  }

  async function join(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const room = await api.joinRoom(joinCode.trim());
      nav(`/room/${room.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('could not join'));
    }
  }

  // the lobby uses the whole screen, Linear-style: actions down the left,
  // your game and rooms in the middle, people down the right
  // (requested by notpritam, docs/FEATURES.md)
  return (
    <div className="mx-auto max-w-[1600px] p-4 md:p-6">
      <div className="mb-6">
        <h1 className="font-display text-2xl font-bold">
          {t('Your lobby, {name}', { name: prefs.displayName || username || '' })}
        </h1>
        <p className="mt-1 text-sm text-slate-500">{t('Start a table or join one with a code.')}</p>
      </div>

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[240px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-4">
          <Panel>
            <h2 className="mb-1 font-display font-semibold">{t('Start a table')}</h2>
            <p className="mb-4 text-sm text-slate-500">{t('You become host and banker.')}</p>
            <Button className="w-full" onClick={() => setCreateOpen(true)}>
              {t('Create room')}
            </Button>
          </Panel>
          <Panel>
            <h2 className="mb-1 font-display font-semibold">{t('Join a table')}</h2>
            <p className="mb-4 text-sm text-slate-500">{t('Ask the host for the 6-letter code.')}</p>
            <form onSubmit={join} className="flex gap-2">
              <Input
                aria-label={t('Room code')}
                placeholder="ABC123"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                maxLength={6}
                className="font-display uppercase tracking-widest"
              />
              <Button type="submit" variant="secondary" disabled={joinCode.length !== 6}>
                {t('Join')}
              </Button>
            </form>
          </Panel>
          {error && <p className="text-sm text-rose-600">{error}</p>}
        </div>

        <div className="min-w-0 space-y-5">
          <NetAreaChart points={timeline} hands={myStats?.handsPlayed} />

          <div>
            <h2 className="mb-3 font-display font-semibold">{t('Your rooms')}</h2>
            {rooms.length === 0 ? (
              <p className="text-sm text-slate-500">{t('No rooms yet. Create one and share the code.')}</p>
            ) : (
              <div className="grid gap-2 xl:grid-cols-2">
                {rooms
                  .filter((r) => !r.archived)
                  .map((r) => (
                    // the whole card is the link, but the share control has to sit
                    // above it - an interactive element cannot nest inside an anchor
                    <div
                      key={r.id}
                      className="relative flex items-center justify-between rounded-xl bg-white p-4 ring-1 ring-slate-200/70 transition-shadow hover:shadow-md dark:bg-slate-900 dark:ring-slate-700/70"
                    >
                      <Link
                        to={`/room/${r.id}`}
                        className="absolute inset-0 rounded-xl"
                        aria-label={t('Open {name}', { name: r.name })}
                      />
                      <div className="min-w-0">
                        <div className="font-medium">{r.name}</div>
                        <div className="text-xs text-slate-500">
                          {t('Blinds {sb}/{bb} · Code {code}', {
                            sb: r.sb,
                            bb: r.bb,
                            code: r.joinCode,
                          })}
                        </div>
                      </div>
                      <div className="relative z-10 flex items-center gap-2">
                        <CopyInvite joinCode={r.joinCode} roomName={r.name} />
                        <Badge tone="indigo">{t('{n} players', { n: r.playerCount })}</Badge>
                      </div>
                    </div>
                  ))}
              </div>
            )}
            {rooms.some((r) => r.archived) && (
              <details className="mt-6">
                <summary className="cursor-pointer text-sm font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
                  {t('Archived tables ({n})', { n: rooms.filter((r) => r.archived).length })}
                </summary>
                <p className="mt-1.5 text-xs text-slate-400">
                  {t(
                    'Retired, not deleted. The ledger and every hand stay readable, and anything still owed is still owed — they just stop counting towards your stats.',
                  )}
                </p>
                <div className="mt-2 space-y-1.5">
                  {rooms
                    .filter((r) => r.archived)
                    .map((r) => (
                      <div
                        key={r.id}
                        className="flex items-center gap-2 rounded-xl bg-slate-50 p-3 text-sm ring-1 ring-slate-200/70 dark:bg-slate-900/60 dark:ring-slate-700/70"
                      >
                        <Link
                          to={`/room/${r.id}/ledger`}
                          className="min-w-0 flex-1 truncate hover:underline"
                        >
                          {r.name}
                        </Link>
                      </div>
                    ))}
                </div>
              </details>
            )}
            {publicRooms.length > 0 && (
              <>
                <h2 className="mb-3 mt-8 font-display font-semibold">{t('Public tables')}</h2>
                <div className="space-y-2">
                  {publicRooms.map((r) => (
                    <div
                      key={r.id}
                      className="flex items-center justify-between gap-3 rounded-xl bg-white p-4 ring-1 ring-slate-200/70 dark:bg-slate-900 dark:ring-slate-700/70"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium">{r.name}</div>
                        <div className="text-xs text-slate-500">
                          {t('Hosted by {host} · Blinds {sb}/{bb} · {n} players', {
                            host: r.hostName,
                            sb: r.sb,
                            bb: r.bb,
                            n: r.playerCount,
                          })}
                        </div>
                      </div>
                      <Button
                        variant="secondary"
                        onClick={() => void api.joinPublic(r.id).then(() => nav(`/room/${r.id}`))}
                      >
                        {t('Join')}
                      </Button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="min-w-0 space-y-5 lg:col-span-2 xl:col-span-1">
          <InvitesPanel onJoined={(roomId) => nav(`/room/${roomId}`)} />
          <FriendsPanel />
        </div>
      </div>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} title={t('Create room')}>
        <form onSubmit={create} className="space-y-3">
          <Input
            aria-label={t('Room name')}
            placeholder={t('Room name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">
              <span className="mb-1 block text-slate-500">{t('Small blind')}</span>
              <Input type="number" min={1} value={sb} onChange={(e) => setSb(+e.target.value)} />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-slate-500">{t('Big blind')}</span>
              <Input type="number" min={1} value={bb} onChange={(e) => setBb(+e.target.value)} />
            </label>
          </div>
          <label className="block text-sm">
            <span className="mb-1 block text-slate-500">{t('Turn timer')}</span>
            <select
              value={actionSecs}
              onChange={(e) => setActionSecs(+e.target.value)}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800"
            >
              {[15, 30, 45, 60, 90, 120].map((s) => (
                <option key={s} value={s}>
                  {t('{s} seconds per decision', { s })}
                </option>
              ))}
              <option value={0}>{t('No limit')}</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-slate-500">{t('Who can find this table')}</span>
            <select
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as 'private' | 'public')}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800"
            >
              <option value="private">{t('Private: join with the 6-letter code only')}</option>
              <option value="public">{t('Public: listed in every lobby, anyone can join')}</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-slate-500">
              {t('Hands required before winnings count in settle-up')}
            </span>
            <Input
              type="number"
              min={0}
              max={MAX_QUALIFYING_HANDS}
              value={minSettleHands}
              onChange={(e) => setMinSettleHands(Math.max(0, +e.target.value))}
            />
            <span className="mt-1 block text-xs text-slate-400">
              {t('0 means everyone counts right away. Maximum 30 hands.')}
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-slate-600 dark:text-slate-300">
            <input
              type="checkbox"
              checked={strictAudit}
              onChange={(e) => setStrictAudit(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              {t(
                "Strict audit: everyone's cards become checkable after each hand (folded cards included)",
              )}
            </span>
          </label>

          {/* P2 — 「玩法规则」 collapsed section */}
          <div
            className={cn(
              'overflow-hidden rounded-xl ring-1 transition-colors',
              enabledFeatureCount(features) > 0
                ? 'bg-indigo-50/40 ring-indigo-200/80 dark:bg-indigo-950/20 dark:ring-indigo-900/60'
                : 'bg-slate-50/60 ring-slate-200/70 dark:bg-slate-900/40 dark:ring-slate-700/70',
            )}
          >
            <GameplayRulesToggle
              open={rulesOpen}
              onToggle={setRulesOpen}
              count={enabledFeatureCount(features)}
              summary={
                enabledFeatureCount(features) > 0
                  ? enabledFeatureNames(features).join(' · ')
                  : t('Optional twists on top of regular poker.')
              }
            />
            <div
              className={cn(
                'grid transition-[grid-template-rows] duration-300 ease-out',
                rulesOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
              )}
            >
              <div className="min-h-0 overflow-hidden">
                {rulesOpen && (
                  <div className="px-3.5 pb-3.5">
                    <GameplaySettingsEditor value={features} onChange={setFeatures} />
                    <p className="mt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                      {t('You can change these between hands from the table menu.')}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {error && <p className="text-sm text-rose-600">{error}</p>}
          <p className="text-xs leading-relaxed text-slate-500">
            {commission.settings
              ? t('House cut: {rate} per pot, rounded down to whole chips.', {
                  rate: commissionRateLabel(commission.settings.commissionBps),
                })
              : t('Loading the current house cut…')}
          </p>
          {commission.error && (
            <p role="alert" className="text-sm text-rose-600">
              {commission.error}{' '}
              <button type="button" className="underline" onClick={() => void commission.refresh()}>
                {t('Retry')}
              </button>
            </p>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={!commission.settings || !!commission.error}
          >
            {t('Create')}
          </Button>
        </form>
      </Dialog>
    </div>
  );
}
