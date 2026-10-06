import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../shared/api.ts';
import {
  deriveAuthKey,
  deriveIdentity,
  deriveRecoveryAuthKey,
  normalizeRecoveryCode,
} from '../../shared/crypto.ts';
import { takePendingJoin } from '../../shared/pendingJoin.ts';
import { useStore } from '../../shared/store.ts';
import { t } from '../../shared/i18n/index.ts';
import { Button, Input, Panel, Spinner } from '../../shared/ui/index.tsx';
import { PlayingCard } from '../../entities/card/PlayingCard.tsx';
import { cardFromName } from '@4am/shared';
import { adminDestination, isAdminSite } from '../../shared/adminSite.ts';
import { issuedRecoveryCode as recoveryCodeFrom } from './issuedRecovery.ts';

type Mode = 'login' | 'register' | 'recover';

export function LoginPage() {
  const admin = isAdminSite() || new URLSearchParams(window.location.search).get('admin') === '1';
  const [adminNext] = useState(adminDestination);
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [confirm, setConfirm] = useState('');
  const [phase, setPhase] = useState<'idle' | 'deriving' | 'submitting' | 'success'>('idle');
  const busy = phase !== 'idle';
  const [expired] = useState(() => new URLSearchParams(window.location.search).has('expired'));
  // a share link sent us here; the code is also parked in sessionStorage
  const [joinCode] = useState(() => new URLSearchParams(window.location.search).get('join'));
  const [error, setError] = useState<string | null>(null);
  // The registration response carries the recovery code exactly once. We hold
  // the success screen on it until the user confirms they saved it.
  const [issuedRecoveryCode, setIssuedRecoveryCode] = useState<string | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const setAuth = useStore((s) => s.setAuth);
  const nav = useNavigate();
  const onwardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      // The auth guard can navigate before the success animation finishes.
      // Its old timer must not pull someone out of their newly joined table.
      if (onwardTimer.current !== null) clearTimeout(onwardTimer.current);
    },
    [],
  );

  /** Land the user wherever they were actually headed: into the shared table if
   *  a /j/CODE link brought them here, otherwise the lobby. */
  async function goOnwards() {
    if (admin) {
      nav(adminNext);
      return;
    }
    const pending = takePendingJoin() ?? joinCode;
    if (pending) {
      try {
        const room = await api.joinRoom(pending);
        nav(`/room/${room.id}`);
        return;
      } catch {
        // the code went stale or the table is gone - don't strand them here
        nav('/lobby');
        return;
      }
    }
    nav('/lobby');
  }

  function copyRecoveryCode() {
    if (!issuedRecoveryCode) return;
    void navigator.clipboard.writeText(issuedRecoveryCode).then(() => {
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 1800);
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === 'recover') {
      if (password !== confirm) return setError(t('the new passwords do not match'));
      if (normalizeRecoveryCode(recoveryCode).length < 20) {
        return setError(t('that recovery code looks too short'));
      }
    }
    setPhase('deriving');
    try {
      // scrypt is intentionally slow; yield a frame so the spinner paints first
      await new Promise((r) => setTimeout(r, 30));
      const authKey = deriveAuthKey(username, password);
      const identity = deriveIdentity(username, password);
      setPhase('submitting');
      const res =
        mode === 'register'
          ? await api.register(username, authKey, identity.publicKey)
          : mode === 'recover'
            ? await api.recover(
                username,
                deriveRecoveryAuthKey(recoveryCode),
                authKey,
                identity.publicKey,
              )
            : await api.login(username, authKey);
      setAuth({ token: res.token, userId: res.userId, username, identity });
      setPhase('success');
      const oneTimeCode = recoveryCodeFrom(mode, res);
      if (oneTimeCode) {
        // Show the one-time code and wait: navigating away would make it unseeable.
        setIssuedRecoveryCode(oneTimeCode);
        return;
      }
      if (admin) nav(adminNext, { replace: true });
      else onwardTimer.current = setTimeout(() => void goOnwards(), 650);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('Could not sign in. Try again.');
      // shared/api.ts may translate err.message; `raw` keeps the original server
      // prose so the 'bad credentials' check works either way.
      const raw = err instanceof Error ? ((err as { raw?: string }).raw ?? err.message) : message;
      setError(
        raw === 'bad credentials' || message === 'bad credentials'
          ? t('Username or password is incorrect.')
          : message,
      );
      setPhase('idle');
    }
  }

  const cta =
    mode === 'login' ? t('Log in') : mode === 'register' ? t('Create account') : t('Reset my password');

  return (
    <div className="relative flex min-h-screen items-center justify-center px-4 py-20">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-end justify-center gap-1.5">
          {['As', 'Kh'].map((n, i) => (
            <PlayingCard
              key={n}
              card={cardFromName(n)}
              size="sm"
              className={i ? 'rotate-6' : '-rotate-6'}
            />
          ))}
        </div>
        <h1 className="mb-1 text-center font-display text-2xl font-bold">
          {admin ? t('Platform sign in') : '4AM Casino'}
        </h1>
        <p className="mb-6 text-center text-sm text-slate-500">
          {admin
            ? t('Use your 4AM Casino platform account to manage the casino.')
            : t("Hold'em with friends. Nobody sees your cards. Not even the house.")}
        </p>
        {joinCode && !admin && (
          <div className="mb-4 rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-200">
            {t(
              "You were invited to a table ({code}). Log in or create an account and we'll seat you straight away.",
              { code: joinCode },
            )}
          </div>
        )}
        {expired && (
          <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
            {t('Your session has expired. Sign in again to continue.')}
          </div>
        )}
        <Panel>
          {!admin && (
            <div className="mb-4 grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
              {(['login', 'register'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => {
                    setMode(m);
                    setError(null);
                  }}
                  className={`rounded-md py-1.5 text-sm font-medium capitalize transition-colors ${
                    mode === m
                      ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100'
                      : 'text-slate-500'
                  }`}
                >
                  {m === 'login' ? t('Log in') : t('Register')}
                </button>
              ))}
            </div>
          )}

          {issuedRecoveryCode ? (
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300">
                {t('Save this now — you will not see it again')}
              </p>
              <code className="block select-all break-all rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-center font-mono text-sm font-bold tracking-wider text-slate-900 dark:border-amber-700 dark:bg-amber-950/50 dark:text-slate-100">
                {issuedRecoveryCode}
              </code>
              <p className="text-xs leading-relaxed text-slate-500">
                {t(
                  'This is your recovery code, shown only once. It is the only way back in if you forget your password. Store it somewhere safe — it cannot be shown again.',
                )}
              </p>
              <div className="flex gap-2">
                <Button type="button" variant="secondary" onClick={copyRecoveryCode}>
                  {codeCopied ? t('✓ Copied') : t('Copy')}
                </Button>
                <Button type="button" className="flex-1" onClick={() => void goOnwards()}>
                  {joinCode ? t('✓ I saved it — seat me') : t('✓ I saved it — continue')}
                </Button>
              </div>
            </div>
          ) : (
            <>
          {mode === 'recover' && (
            <div className="mb-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs leading-relaxed text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
              {t(
                'Enter the recovery code you saved when you set up the account. It works once, and it issues you a brand-new signing key — your old hands stay verifiable either way.',
              )}
            </div>
          )}

          <form onSubmit={submit} className="space-y-3">
            <Input
              aria-label={t('Username')}
              placeholder={t('Username')}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              disabled={busy}
              required
              minLength={2}
              pattern="[a-zA-Z0-9_]+"
            />
            {mode === 'recover' && (
              <Input
                aria-label={t('Recovery code (XXXXXX-XXXXXX-…)')}
                placeholder={t('Recovery code (XXXXXX-XXXXXX-…)')}
                value={recoveryCode}
                onChange={(e) => setRecoveryCode(e.target.value)}
                disabled={busy}
                required
                className="font-mono tracking-wider"
              />
            )}
            <Input
              aria-label={mode === 'recover' ? t('New password') : t('Password')}
              placeholder={mode === 'recover' ? t('New password') : t('Password')}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              disabled={busy}
              required
              minLength={6}
            />
            {mode === 'recover' && (
              <Input
                aria-label={t('Repeat new password')}
                placeholder={t('Repeat new password')}
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                disabled={busy}
                required
                minLength={6}
              />
            )}
            {error && (
              <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
                {error}
              </p>
            )}
            <Button
              type="submit"
              className={
                phase === 'success' ? 'w-full bg-emerald-500 hover:bg-emerald-500' : 'w-full'
              }
              disabled={busy}
            >
              {phase === 'deriving' ? (
                <Spinner label={t('Deriving your keys…')} />
              ) : phase === 'submitting' ? (
                <Spinner
                  label={
                    mode === 'register'
                      ? t('Creating account…')
                      : mode === 'recover'
                        ? t('Recovering…')
                        : t('Signing in…')
                  }
                />
              ) : phase === 'success' ? (
                admin ? (
                  t('✓ Signed in. Opening dashboard…')
                ) : joinCode ? (
                  t('✓ Seating you at the table…')
                ) : mode === 'register' ? (
                  t('✓ Account created. Dealing you in…')
                ) : (
                  t('✓ Signed in. Dealing you in…')
                )
              ) : (
                cta
              )}
            </Button>
          </form>

          <button
            type="button"
            onClick={() => {
              setMode(mode === 'recover' ? 'login' : 'recover');
              setError(null);
              setConfirm('');
              setRecoveryCode('');
            }}
            className="mt-3 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            {mode === 'recover' ? t('← Back to log in') : t('Forgot your password?')}
          </button>
            </>
          )}

          <p className="mt-3 text-xs leading-relaxed text-slate-400">
            {t(
              'Your password also derives your card-signing key in this browser. It is never sent to the server.',
            )}
          </p>
        </Panel>
        <Link
          to={admin ? 'https://4amcasino.com' : '/fair'}
          className="mt-4 block text-center text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
        >
          {admin
            ? t('Back to 4AM Casino')
            : t('How can an online deck be fair? Watch the 60-second explainer')}
        </Link>
      </div>
    </div>
  );
}
