import { type FormEvent, type ReactNode, memo, useCallback, useEffect, useState } from 'react';
import { commissionRateLabel } from '@4am/shared';
import { api, type AdminAuditEntry } from '../../shared/api.ts';
import { fmtDate } from '../../shared/lib/datetime.ts';
import { deriveAuthKey, deriveIdentity } from '../../shared/crypto.ts';
import { fmt } from '../../shared/lib/cn.ts';
import { t } from '../../shared/i18n/index.ts';
import { Badge, Button, Dialog, Input, Panel, Spinner } from '../../shared/ui/index.tsx';

/** Lets the spinner paint before scrypt blocks the main thread deriving keys. */
const yieldFrame = () => new Promise((resolve) => setTimeout(resolve, 30));

const netStr = (n: number) => `${n > 0 ? '+' : ''}${fmt(n)}`;

function Note({ kind, children }: { kind: 'ok' | 'bad'; children: ReactNode }) {
  return (
    <p
      className={
        kind === 'ok'
          ? 'mt-2 text-xs text-emerald-600 dark:text-emerald-400'
          : 'mt-2 text-xs text-rose-600 dark:text-rose-400'
      }
    >
      {children}
    </p>
  );
}

interface LifecycleRequest {
  id: number;
  roomId: string;
  roomName: string;
  action: string;
  requestedBy: number;
  requesterName: string;
  note: string | null;
  createdAt: number;
}

export function LifecycleSection() {
  const [requests, setRequests] = useState<LifecycleRequest[] | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function load() {
    void api
      .adminLifecycle()
      .then((r) => {
        setRequests(r.requests ?? []);
        setErr(null);
      })
      .catch(() => setErr(t('Could not load requests. Try again.')));
  }
  useEffect(load, []);

  async function decide(id: number, approve: boolean) {
    setErr(null);
    setBusyId(id);
    try {
      await api.adminDecideLifecycle(id, approve);
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('could not decide that request'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Panel>
      <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">
        {t('Room requests')}
      </h2>
      <p className="mt-1 text-sm text-slate-500">{t('Hosts asking to archive, restore, or delete a table.')}</p>

      {requests === null ? (
        <div className="mt-4">
          {err ? (
            <Button variant="secondary" onClick={load}>
              {t('Retry requests')}
            </Button>
          ) : (
            <Spinner label={t('Loading requests…')} />
          )}
        </div>
      ) : requests.length === 0 ? (
        <p className="mt-4 text-sm text-slate-400">{t('Nothing waiting on you.')}</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {requests.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-slate-50 p-3 text-sm ring-1 ring-slate-200/70 dark:bg-slate-900/60 dark:ring-slate-700/70"
            >
              <div className="min-w-0">
                <div className="font-medium text-slate-900 dark:text-slate-100">{r.roomName}</div>
                <div className="text-xs text-slate-400">
                  {t('{name} asked to {action} this table', {
                    name: r.requesterName,
                    action: t(r.action),
                  })}
                  {r.note ? t(', note: {note}', { note: r.note }) : ''}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  variant="success"
                  disabled={busyId === r.id}
                  onClick={() => void decide(r.id, true)}
                >
                  {busyId === r.id ? <Spinner label={t('Working…')} /> : t('Approve')}
                </Button>
                <Button
                  variant="danger"
                  disabled={busyId === r.id}
                  onClick={() => void decide(r.id, false)}
                >
                  {t('Reject')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {err && <Note kind="bad">{err}</Note>}
    </Panel>
  );
}

interface MergeRequestRow {
  id: number;
  fromUser: number;
  fromUsername: string;
  intoUser: number;
  intoUsername: string;
  note: string | null;
  createdAt: number;
  fromBalance: number;
  fromRooms: number;
  intoBalance: number;
  intoRooms: number;
}

export function MergeSection() {
  const [requests, setRequests] = useState<MergeRequestRow[] | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<MergeRequestRow | null>(null);

  const [directFrom, setDirectFrom] = useState('');
  const [directInto, setDirectInto] = useState('');
  const [directNote, setDirectNote] = useState('');
  const [directConfirm, setDirectConfirm] = useState(false);
  const [directBusy, setDirectBusy] = useState(false);
  const [directMsg, setDirectMsg] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);

  function load() {
    void api
      .adminMerges()
      .then((r) => {
        setRequests(r.requests ?? []);
        setErr(null);
      })
      .catch(() => setErr(t('Could not load requests. Try again.')));
  }
  useEffect(load, []);

  async function decide(id: number, approve: boolean) {
    setErr(null);
    setBusyId(id);
    try {
      await api.adminDecideMerge(id, approve);
      setConfirmTarget(null);
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('could not decide that request'));
    } finally {
      setBusyId(null);
    }
  }

  function openDirectConfirm(e: FormEvent) {
    e.preventDefault();
    setDirectMsg(null);
    if (!directFrom.trim() || !directInto.trim()) {
      setDirectMsg({ kind: 'bad', text: t('enter both usernames') });
      return;
    }
    setDirectConfirm(true);
  }

  async function mergeNow() {
    setDirectBusy(true);
    setDirectMsg(null);
    try {
      const from = directFrom.trim();
      const into = directInto.trim();
      await api.adminMergeNow(from, into, directNote.trim() || undefined);
      setDirectMsg({ kind: 'ok', text: t('Merged @{from} into @{into}.', { from, into }) });
      setDirectFrom('');
      setDirectInto('');
      setDirectNote('');
      setDirectConfirm(false);
      load();
    } catch (e) {
      setDirectMsg({
        kind: 'bad',
        text: e instanceof Error ? e.message : t('could not merge those accounts'),
      });
    } finally {
      setDirectBusy(false);
    }
  }

  return (
    <Panel>
      <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">
        {t('Merge requests')}
      </h2>
      <p className="mt-1 text-sm text-slate-500">
        {t('Folding one account into another. Approving cannot be undone.')}
      </p>

      {requests === null ? (
        <div className="mt-4">
          {err ? (
            <Button variant="secondary" onClick={load}>
              {t('Retry requests')}
            </Button>
          ) : (
            <Spinner label={t('Loading requests…')} />
          )}
        </div>
      ) : requests.length === 0 ? (
        <p className="mt-4 text-sm text-slate-400">{t('Nothing waiting on you.')}</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {requests.map((r) => (
            <li
              key={r.id}
              className="rounded-xl bg-slate-50 p-3 text-sm ring-1 ring-slate-200/70 dark:bg-slate-900/60 dark:ring-slate-700/70"
            >
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-slate-900 dark:text-slate-100">
                    @{r.fromUsername} <span className="text-slate-400">{t('into')}</span> @{r.intoUsername}
                  </div>
                  {r.note && (
                    <div className="text-xs text-slate-400">{t('note: {note}', { note: r.note })}</div>
                  )}
                  <div className="mt-1.5 grid grid-cols-1 gap-1 text-xs text-slate-500 sm:grid-cols-2">
                    <div>
                      {t(r.fromRooms === 1 ? '{user}: {net} net, {n} room' : '{user}: {net} net, {n} rooms', {
                        user: `@${r.fromUsername}`,
                        net: netStr(r.fromBalance),
                        n: r.fromRooms,
                      })}
                    </div>
                    <div>
                      {t(r.intoRooms === 1 ? '{user}: {net} net, {n} room' : '{user}: {net} net, {n} rooms', {
                        user: `@${r.intoUsername}`,
                        net: netStr(r.intoBalance),
                        n: r.intoRooms,
                      })}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    variant="success"
                    disabled={busyId === r.id}
                    onClick={() => setConfirmTarget(r)}
                  >
                    {t('Approve')}
                  </Button>
                  <Button
                    variant="danger"
                    disabled={busyId === r.id}
                    onClick={() => void decide(r.id, false)}
                  >
                    {t('Reject')}
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {err && <Note kind="bad">{err}</Note>}

      <form
        onSubmit={openDirectConfirm}
        className="mt-5 border-t border-slate-200/70 pt-4 dark:border-slate-700/70"
      >
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {t('Merge accounts directly')}
        </h3>
        <p className="mt-0.5 text-xs text-slate-500">
          {t('Skips the request queue and folds one account into another immediately. Approving cannot be undone.')}
        </p>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Input
            aria-label={t('From username')}
            placeholder={t('From username')}
            value={directFrom}
            onChange={(e) => setDirectFrom(e.target.value)}
            disabled={directBusy}
          />
          <Input
            aria-label={t('Into username')}
            placeholder={t('Into username')}
            value={directInto}
            onChange={(e) => setDirectInto(e.target.value)}
            disabled={directBusy}
          />
        </div>
        <div className="mt-2">
          <Input
            aria-label={t('Note (optional)')}
            placeholder={t('Note (optional)')}
            value={directNote}
            onChange={(e) => setDirectNote(e.target.value)}
            disabled={directBusy}
          />
        </div>
        <div className="mt-2">
          <Button type="submit" variant="secondary" disabled={directBusy}>
            {directBusy ? <Spinner label={t('Merging…')} /> : t('Merge now')}
          </Button>
        </div>
        {directMsg && <Note kind={directMsg.kind}>{directMsg.text}</Note>}
      </form>

      <Dialog
        open={confirmTarget !== null}
        onClose={() => setConfirmTarget(null)}
        title={t('Approve this merge?')}
      >
        {confirmTarget && (
          <div>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {t(
                'Everything @{a} owns moves to @{b}, and @{a} is retired. This cannot be undone.',
                { a: confirmTarget.fromUsername, b: confirmTarget.intoUsername },
              )}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => setConfirmTarget(null)}
                disabled={busyId === confirmTarget.id}
              >
                {t('Cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={() => void decide(confirmTarget.id, true)}
                disabled={busyId === confirmTarget.id}
              >
                {busyId === confirmTarget.id ? (
                  <Spinner label={t('Merging…')} />
                ) : (
                  t('Merge accounts')
                )}
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      <Dialog
        open={directConfirm}
        onClose={() => setDirectConfirm(false)}
        title={t('Merge these accounts now?')}
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {t(
            'Everything @{a} owns moves to @{b}, and @{a} is retired. This takes effect immediately and cannot be undone.',
            { a: directFrom, b: directInto },
          )}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDirectConfirm(false)} disabled={directBusy}>
            {t('Cancel')}
          </Button>
          <Button variant="danger" onClick={() => void mergeNow()} disabled={directBusy}>
            {directBusy ? <Spinner label={t('Merging…')} /> : t('Merge accounts')}
          </Button>
        </div>
      </Dialog>
    </Panel>
  );
}

export interface AdminTarget {
  userId: number;
  username: string;
  displayName: string;
  isPlatform?: boolean;
  /** sqlite 0/1 over JSON; absent when the target came from a bare ID lookup. */
  disabled?: number;
  /** Set once a merge retired this account; it can no longer be enabled/reset. */
  mergedInto?: number | null;
}

export function UserAdminSection({
  initialTarget,
  onChanged,
}: {
  initialTarget?: AdminTarget;
  onChanged?: () => void;
}) {
  const [idInput, setIdInput] = useState(initialTarget ? String(initialTarget.userId) : '');
  const [target, setTarget] = useState<AdminTarget | null>(initialTarget ?? null);
  const [lookupErr, setLookupErr] = useState<string | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);

  const [disableConfirm, setDisableConfirm] = useState(false);
  const [disableBusy, setDisableBusy] = useState(false);
  const [disableMsg, setDisableMsg] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);

  const [initialConfirm, setInitialConfirm] = useState(false);
  const [initialBusy, setInitialBusy] = useState(false);
  const [initialMsg, setInitialMsg] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);

  const [newPassword, setNewPassword] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);

  async function lookup(e: FormEvent) {
    e.preventDefault();
    setLookupErr(null);
    setTarget(null);
    setDisableMsg(null);
    setPwMsg(null);
    const id = Number(idInput);
    if (!Number.isInteger(id) || id <= 0) {
      setLookupErr(t('enter a valid user ID'));
      return;
    }
    setLookupBusy(true);
    try {
      // Platform-only lookup: the player profile endpoint does not expose
      // `disabled`/`mergedInto`, which the controls below need.
      const { user } = await api.adminLookupUser(id);
      if (!user) {
        setLookupErr(t('could not find that user'));
        return;
      }
      setTarget({
        userId: user.userId,
        username: user.username,
        displayName: user.displayName,
        isPlatform: user.isPlatform,
        disabled: user.disabled,
        mergedInto: user.mergedInto,
      });
    } catch (e2) {
      setLookupErr(e2 instanceof Error ? e2.message : t('could not find that user'));
    } finally {
      setLookupBusy(false);
    }
  }

  async function disable() {
    if (!target) return;
    setDisableBusy(true);
    setDisableMsg(null);
    try {
      await api.adminDisableUser(target.userId);
      setTarget({ ...target, disabled: 1 });
      setDisableMsg({
        kind: 'ok',
        text: t('@{user} is disabled and signed out everywhere.', { user: target.username }),
      });
      setDisableConfirm(false);
      onChanged?.();
    } catch (e) {
      setDisableMsg({
        kind: 'bad',
        text: e instanceof Error ? e.message : t('could not disable that account'),
      });
    } finally {
      setDisableBusy(false);
    }
  }

  async function enable() {
    if (!target) return;
    setDisableBusy(true);
    setDisableMsg(null);
    try {
      await api.adminEnableUser(target.userId);
      setTarget({ ...target, disabled: 0 });
      setDisableMsg({
        kind: 'ok',
        text: t('@{user} is enabled and can log in again.', { user: target.username }),
      });
      onChanged?.();
    } catch (e) {
      setDisableMsg({
        kind: 'bad',
        text: e instanceof Error ? e.message : t('could not enable that account'),
      });
    } finally {
      setDisableBusy(false);
    }
  }

  async function resetInitial() {
    if (!target) return;
    setInitialBusy(true);
    setInitialMsg(null);
    try {
      await api.adminResetUserInitialPassword(target.userId);
      setInitialConfirm(false);
      setInitialMsg({
        kind: 'ok',
        text: t(
          'Password reset to 123456 for @{user}. They were signed out everywhere and re-keyed. Tell them the password directly.',
          { user: target.username },
        ),
      });
      onChanged?.();
    } catch (e) {
      setInitialMsg({
        kind: 'bad',
        text: e instanceof Error ? e.message : t('could not reset that password'),
      });
    } finally {
      setInitialBusy(false);
    }
  }

  async function resetPassword(e: FormEvent) {
    e.preventDefault();
    setPwMsg(null);
    if (!target) return;
    if (newPassword.length < 6) {
      setPwMsg({ kind: 'bad', text: t('use at least 6 characters') });
      return;
    }
    setPwBusy(true);
    try {
      await yieldFrame();
      const newAuthKey = deriveAuthKey(target.username, newPassword);
      const identity = deriveIdentity(target.username, newPassword);
      await api.adminSetUserPassword(target.userId, newAuthKey, identity.publicKey);
      setNewPassword('');
      setPwMsg({
        kind: 'ok',
        text: t(
          'Password reset for @{user}. Tell them the new password directly, they were signed out everywhere.',
          { user: target.username },
        ),
      });
    } catch (e2) {
      setPwMsg({
        kind: 'bad',
        text: e2 instanceof Error ? e2.message : t('could not reset that password'),
      });
    } finally {
      setPwBusy(false);
    }
  }

  return (
    <Panel>
      <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">
        {t('User admin')}
      </h2>
      <p className="mt-1 text-sm text-slate-500">
        {t("Look a player up by their user ID. It's visible in the URL of their profile page, /players/ID.")}
      </p>

      <form onSubmit={(e) => void lookup(e)} className="mt-4 flex max-w-sm gap-2">
        <Input
          type="number"
          min={1}
          aria-label={t('User ID')}
          placeholder={t('User ID')}
          value={idInput}
          onChange={(e) => setIdInput(e.target.value)}
          disabled={lookupBusy}
        />
        <Button type="submit" variant="secondary" disabled={lookupBusy}>
          {lookupBusy ? <Spinner label={t('Looking up…')} /> : t('Look up')}
        </Button>
      </form>
      {lookupErr && <Note kind="bad">{lookupErr}</Note>}

      {target && (
        <div className="mt-5 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200/70 dark:bg-slate-900/60 dark:ring-slate-700/70">
          <div className="flex items-center gap-2 font-medium text-slate-900 dark:text-slate-100">
            {target.displayName}
            <span className="font-normal text-slate-400">@{target.username}</span>
            {target.mergedInto != null && <Badge tone="amber">{t('Merged')}</Badge>}
            {target.isPlatform && <Badge tone="indigo">{t('House account')}</Badge>}
          </div>

          {target.isPlatform ? (
            <p className="mt-2 text-xs text-slate-400">
              {t("The house account can't be disabled or reset from here.")}
            </p>
          ) : target.mergedInto != null ? (
            <p className="mt-2 text-xs text-slate-400">
              {t('This account was merged into another one. It cannot be enabled or reset.')}
            </p>
          ) : (
            <>
              <div className="mt-3 border-t border-slate-200/70 pt-3 dark:border-slate-700/70">
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {target.disabled ? t('Enable account') : t('Disable account')}
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  {target.disabled
                    ? t('Lets the account log in again. Nothing was deleted while it was disabled.')
                    : t('Signs them out everywhere and blocks further logins. Nothing is deleted.')}
                </p>
                <div className="mt-2">
                  {target.disabled ? (
                    <Button variant="success" onClick={() => void enable()} disabled={disableBusy}>
                      {disableBusy ? (
                        <Spinner label={t('Working…')} />
                      ) : (
                        t('Enable @{user}', { user: target.username })
                      )}
                    </Button>
                  ) : (
                    <Button
                      variant="danger"
                      onClick={() => setDisableConfirm(true)}
                      disabled={disableBusy}
                    >
                      {t('Disable @{user}', { user: target.username })}
                    </Button>
                  )}
                </div>
                {disableMsg && <Note kind={disableMsg.kind}>{disableMsg.text}</Note>}
              </div>

              <form
                onSubmit={(e) => void resetPassword(e)}
                className="mt-3 border-t border-slate-200/70 pt-3 dark:border-slate-700/70"
              >
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {t('Reset password')}
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  {t(
                    'Sets a new password and signing key for @{user}. They must not be seated at a table when you do this.',
                    { user: target.username },
                  )}
                </p>
                <div className="mt-2 flex max-w-sm gap-2">
                  <Input
                    type="password"
                    aria-label={t('New password')}
                    placeholder={t('New password')}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    minLength={6}
                    disabled={pwBusy}
                  />
                  <Button type="submit" disabled={pwBusy}>
                    {pwBusy ? <Spinner label={t('Re-keying…')} /> : t('Reset password')}
                  </Button>
                </div>
                {pwMsg && <Note kind={pwMsg.kind}>{pwMsg.text}</Note>}
              </form>

              <div className="mt-3 border-t border-slate-200/70 pt-3 dark:border-slate-700/70">
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {t('Reset to initial password')}
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  {t(
                    'Sets @{user} back to the password 123456, re-keys their signing identity, and signs them out everywhere. They must not be seated at a table.',
                    { user: target.username },
                  )}
                </p>
                <div className="mt-2">
                  <Button
                    variant="danger"
                    onClick={() => setInitialConfirm(true)}
                    disabled={initialBusy}
                  >
                    {initialBusy ? (
                      <Spinner label={t('Resetting…')} />
                    ) : (
                      t('Reset to 123456')
                    )}
                  </Button>
                </div>
                {initialMsg && <Note kind={initialMsg.kind}>{initialMsg.text}</Note>}
              </div>
            </>
          )}
        </div>
      )}

      <Dialog
        open={disableConfirm}
        onClose={() => setDisableConfirm(false)}
        title={t('Disable @{user}?', { user: target?.username ?? '' })}
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {t(
            "They're signed out everywhere and can't log back in until re-enabled. Nothing they own is deleted.",
          )}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDisableConfirm(false)} disabled={disableBusy}>
            {t('Cancel')}
          </Button>
          <Button variant="danger" onClick={() => void disable()} disabled={disableBusy}>
            {disableBusy ? <Spinner label={t('Working…')} /> : t('Disable account')}
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={initialConfirm}
        onClose={() => setInitialConfirm(false)}
        title={t('Reset @{user} to the initial password?', { user: target?.username ?? '' })}
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {t(
            'This sets @{user}\'s password back to 123456 and re-keys their signing identity. Every device they are signed in on is cleared immediately. Tell them the new password directly.',
            { user: target?.username ?? '' },
          )}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setInitialConfirm(false)} disabled={initialBusy}>
            {t('Cancel')}
          </Button>
          <Button variant="danger" onClick={() => void resetInitial()} disabled={initialBusy}>
            {initialBusy ? <Spinner label={t('Resetting…')} /> : t('Reset to 123456')}
          </Button>
        </div>
      </Dialog>
    </Panel>
  );
}

interface AdminRoomRow {
  id: string;
  name: string;
  commissionBps: number;
  archived: number; // sqlite INTEGER 0/1 round-trips as a number over JSON
  hostName: string;
  playerCount: number;
}

export const RoomsSection = memo(function RoomsSection() {
  const [query, setQuery] = useState('');
  const [rooms, setRooms] = useState<AdminRoomRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminRoomRow | null>(null);

  function load(q?: string) {
    void api
      .adminRooms(q)
      .then((r) => {
        setRooms(r.rooms ?? []);
        setErr(null);
      })
      .catch(() => setErr(t('Could not load rooms. Search again to retry.')));
  }
  useEffect(() => load(), []);

  function onSearch(e: FormEvent) {
    e.preventDefault();
    load(query.trim() || undefined);
  }

  async function toggleArchive(room: AdminRoomRow) {
    setErr(null);
    setBusyId(room.id);
    try {
      await api.adminArchiveRoom(room.id, !room.archived);
      load(query.trim() || undefined);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('could not update that room'));
    } finally {
      setBusyId(null);
    }
  }

  async function doDelete() {
    if (!deleteTarget) return;
    setErr(null);
    setBusyId(deleteTarget.id);
    try {
      await api.adminDeleteRoom(deleteTarget.id);
      setDeleteTarget(null);
      load(query.trim() || undefined);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('could not delete that room'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Panel>
      <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">
        {t('Rooms')}
      </h2>
      <p className="mt-1 text-sm text-slate-500">
        {t('Archive or delete any table directly. Delete cannot be undone.')}
      </p>

      <form onSubmit={onSearch} className="mt-4 flex max-w-sm gap-2">
        <Input
          aria-label={t('Search by name')}
          placeholder={t('Search by name')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button type="submit" variant="secondary">
          {t('Search')}
        </Button>
      </form>

      {rooms === null ? (
        <div className="mt-4">
          <Spinner label={t('Loading rooms…')} />
        </div>
      ) : rooms.length === 0 ? (
        <p className="mt-4 text-sm text-slate-400">{t('No rooms found.')}</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {rooms.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-slate-50 p-3 text-sm ring-1 ring-slate-200/70 dark:bg-slate-900/60 dark:ring-slate-700/70"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 font-medium text-slate-900 dark:text-slate-100">
                  {r.name}
                  {!!r.archived && <Badge tone="amber">{t('Archived')}</Badge>}
                </div>
                <div className="text-xs text-slate-400">
                  {t(
                    r.playerCount === 1
                      ? 'Hosted by {host} · {n} player · {rate} house cut'
                      : 'Hosted by {host} · {n} players · {rate} house cut',
                    {
                      host: r.hostName,
                      n: r.playerCount,
                      rate: commissionRateLabel(r.commissionBps),
                    },
                  )}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  variant="secondary"
                  disabled={busyId === r.id}
                  onClick={() => void toggleArchive(r)}
                >
                  {busyId === r.id ? (
                    <Spinner label={t('Working…')} />
                  ) : r.archived ? (
                    t('Unarchive')
                  ) : (
                    t('Archive')
                  )}
                </Button>
                <Button
                  variant="danger"
                  disabled={busyId === r.id}
                  onClick={() => setDeleteTarget(r)}
                >
                  {t('Delete')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {err && <Note kind="bad">{err}</Note>}

      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={t('Delete this room?')}
      >
        {deleteTarget && (
          <div>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {t('"{name}" will be removed from every list. This cannot be undone.', {
                name: deleteTarget.name,
              })}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => setDeleteTarget(null)}
                disabled={busyId === deleteTarget.id}
              >
                {t('Cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={() => void doDelete()}
                disabled={busyId === deleteTarget.id}
              >
                {busyId === deleteTarget.id ? (
                  <Spinner label={t('Deleting…')} />
                ) : (
                  t('Delete room')
                )}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </Panel>
  );
});
RoomsSection.displayName = 'RoomsSection';

const AUDIT_PAGE_SIZE = 50;

/** One-line human summary of an audit row's JSON detail. */
function detailSummary(detail: unknown): string {
  if (detail === null || detail === undefined) return '—';
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

/** Read-only admin audit trail: time, operator, action, target and a detail
 *  summary, filterable by exact action / target id and paged newest-first. */
export function AuditSection() {
  const [entries, setEntries] = useState<AdminAuditEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [action, setAction] = useState('');
  const [targetId, setTargetId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(
    async (nextOffset: number, filter: { action: string; targetId: string }) => {
      setBusy(true);
      setErr(null);
      try {
        const page = await api.adminAudit({
          limit: AUDIT_PAGE_SIZE,
          offset: nextOffset,
          action: filter.action.trim() || undefined,
          targetId: filter.targetId.trim() || undefined,
        });
        setEntries(page.entries);
        setTotal(page.total);
        setOffset(page.offset);
        setHasMore(page.hasMore);
      } catch (e) {
        setErr(e instanceof Error ? e.message : t('Could not load the audit log.'));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  useEffect(() => {
    void load(0, { action: '', targetId: '' });
  }, [load]);

  function applyFilters(e: FormEvent) {
    e.preventDefault();
    void load(0, { action, targetId });
  }

  function clearFilters() {
    setAction('');
    setTargetId('');
    void load(0, { action: '', targetId: '' });
  }

  return (
    <Panel>
      <h2 className="font-display text-lg font-semibold text-slate-900 dark:text-slate-100">
        {t('Audit log')}
      </h2>
      <p className="mt-1 text-sm text-slate-500">
        {t('Every administrative action, newest first.')}
      </p>

      <form onSubmit={applyFilters} className="admin-search">
        <Input
          aria-label={t('Filter by action')}
          placeholder={t('Action, e.g. user.disable')}
          value={action}
          onChange={(e) => setAction(e.target.value)}
          disabled={busy}
        />
        <Input
          aria-label={t('Filter by target ID')}
          placeholder={t('Target ID')}
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          disabled={busy}
        />
        <Button type="submit" variant="secondary" disabled={busy}>
          {t('Apply filters')}
        </Button>
        <Button type="button" variant="ghost" onClick={clearFilters} disabled={busy}>
          {t('Clear')}
        </Button>
      </form>

      {entries === null ? (
        <div className="mt-4">
          {err ? (
            <Button variant="secondary" onClick={() => void load(0, { action, targetId })}>
              {t('Retry')}
            </Button>
          ) : (
            <Spinner label={t('Loading audit log…')} />
          )}
        </div>
      ) : entries.length === 0 ? (
        <p className="admin-empty">{t('No audit entries match.')}</p>
      ) : (
        <>
          <div className="admin-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('Time')}</th>
                  <th>{t('Operator')}</th>
                  <th>{t('Action')}</th>
                  <th>{t('Target')}</th>
                  <th>{t('Detail')}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const target =
                    entry.targetType || entry.targetId
                      ? `${entry.targetType ?? ''}${entry.targetType && entry.targetId ? ' ' : ''}${
                          entry.targetId ?? ''
                        }`
                      : '—';
                  return (
                    <tr key={entry.id}>
                      <td title={new Date(entry.ts).toISOString()}>{fmtDate(entry.ts)}</td>
                      <td>
                        {entry.operatorName ?? '—'}
                        {entry.operatorName && (
                          <small>
                            ID {entry.operatorUserId}
                          </small>
                        )}
                      </td>
                      <td>
                        <code>{entry.action}</code>
                      </td>
                      <td>
                        <code>{target}</code>
                      </td>
                      <td>
                        <span className="admin-audit-detail">{detailSummary(entry.detail)}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="admin-pagination">
            <span>
              {t('{from}–{to} of {total} entries', {
                from: offset + 1,
                to: offset + entries.length,
                total,
              })}
            </span>
            <div>
              <Button
                variant="secondary"
                disabled={busy || offset === 0}
                onClick={() => void load(Math.max(0, offset - AUDIT_PAGE_SIZE), { action, targetId })}
              >
                {t('Previous')}
              </Button>
              <Button
                variant="secondary"
                disabled={busy || !hasMore}
                onClick={() => void load(offset + AUDIT_PAGE_SIZE, { action, targetId })}
              >
                {t('Next')}
              </Button>
            </div>
          </div>
        </>
      )}
      {err && entries !== null && <Note kind="bad">{err}</Note>}
    </Panel>
  );
}
