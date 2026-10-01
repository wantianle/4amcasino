import { useEffect, useState } from 'react';
import { api } from '../../shared/api.ts';
import {
  deriveAuthKey,
  deriveIdentity,
  deriveRecoveryAuthKey,
  generateRecoveryCode,
} from '../../shared/crypto.ts';
import { useStore } from '../../shared/store.ts';
import { Button, Input, Spinner } from '../../shared/ui/index.tsx';
import { t } from '../../shared/i18n/index.ts';

/** Password, username and recovery-code management (requested by notpritam,
 *  docs/FEATURES.md).
 *
 *  Everything here re-derives your ed25519 card-signing key in this browser and
 *  uploads the new public half - the server never sees a password, a recovery
 *  code, or a secret key. scrypt takes a second or two, hence the spinners. */

/** Lets the spinner paint before scrypt blocks the main thread. */
const yieldFrame = () => new Promise((r) => setTimeout(r, 30));

function Row({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-slate-200/70 py-5 first:border-t-0 first:pt-0 dark:border-slate-700/70">
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
      <p className="mb-3 mt-0.5 text-xs leading-relaxed text-slate-500">{hint}</p>
      {children}
    </div>
  );
}

function Note({ kind, children }: { kind: 'ok' | 'bad'; children: React.ReactNode }) {
  return (
    <p
      className={`mt-2 text-xs ${
        kind === 'ok'
          ? 'text-emerald-600 dark:text-emerald-400'
          : 'text-rose-600 dark:text-rose-400'
      }`}
    >
      {children}
    </p>
  );
}

function ChangePassword() {
  const auth = useStore((s) => s.auth);
  const setAuth = useStore((s) => s.setAuth);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (next !== confirm) return setMsg({ kind: 'bad', text: t('the new passwords do not match') });
    if (next.length < 6) return setMsg({ kind: 'bad', text: t('use at least 6 characters') });
    const username = auth.username;
    if (!username) return;
    setBusy(true);
    try {
      await yieldFrame();
      const currentAuthKey = deriveAuthKey(username, current);
      const newAuthKey = deriveAuthKey(username, next);
      const identity = deriveIdentity(username, next);
      await api.changePassword(currentAuthKey, newAuthKey, identity.publicKey);
      // the old identity is now dead - keep the store in step or every signature
      // this browser makes from here would be rejected
      setAuth({ ...auth, identity });
      setCurrent('');
      setNext('');
      setConfirm('');
      setMsg({ kind: 'ok', text: t('Password changed. Other devices were signed out.') });
    } catch (err) {
      setMsg({ kind: 'bad', text: err instanceof Error ? err.message : t('could not change it') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Row
      title={t('Password')}
      hint={t(
        'Your password also derives the key that signs your cards. Changing it issues a new signing key and signs out every other device. Old hands stay verifiable.',
      )}
    >
      <form onSubmit={submit} className="grid max-w-md gap-2">
        <Input
          type="password"
          aria-label={t('Current password')}
          placeholder={t('Current password')}
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
          required
          disabled={busy}
        />
        <Input
          type="password"
          aria-label={t('New password')}
          placeholder={t('New password')}
          value={next}
          onChange={(e) => setNext(e.target.value)}
          autoComplete="new-password"
          required
          minLength={6}
          disabled={busy}
        />
        <Input
          type="password"
          aria-label={t('Repeat new password')}
          placeholder={t('Repeat new password')}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
          minLength={6}
          disabled={busy}
        />
        <div>
          <Button type="submit" disabled={busy}>
            {busy ? <Spinner label={t('Re-keying…')} /> : t('Change password')}
          </Button>
        </div>
      </form>
      {msg && <Note kind={msg.kind}>{msg.text}</Note>}
    </Row>
  );
}

function ChangeUsername() {
  const auth = useStore((s) => s.auth);
  const setAuth = useStore((s) => s.setAuth);
  const [name, setName] = useState(auth.username ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const old = auth.username;
    if (!old) return;
    if (name === old) return setMsg({ kind: 'bad', text: t('that is already your name') });
    setBusy(true);
    try {
      await yieldFrame();
      // both derivation domains bake in the username, so a rename re-keys too
      const currentAuthKey = deriveAuthKey(old, password);
      const newAuthKey = deriveAuthKey(name, password);
      const identity = deriveIdentity(name, password);
      await api.changeUsername(name, currentAuthKey, newAuthKey, identity.publicKey);
      setAuth({ ...auth, username: name, identity });
      setPassword('');
      setMsg({
        kind: 'ok',
        text: t('You are now {name}. Other devices were signed out.', { name }),
      });
    } catch (err) {
      setMsg({ kind: 'bad', text: err instanceof Error ? err.message : t('could not rename you') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Row
      title={t('Username')}
      hint={t(
        'Your name is part of how your keys are derived, so renaming also issues a new signing key. You will log in with the new name and your same password.',
      )}
    >
      <form onSubmit={submit} className="grid max-w-md gap-2">
        <Input
          aria-label={t('New username')}
          placeholder={t('New username')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          minLength={2}
          maxLength={24}
          pattern="[a-zA-Z0-9_]+"
          required
          disabled={busy}
        />
        <Input
          type="password"
          aria-label={t('Your password')}
          placeholder={t('Your password')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
          disabled={busy}
        />
        <div>
          <Button type="submit" variant="secondary" disabled={busy}>
            {busy ? <Spinner label={t('Re-keying…')} /> : t('Change username')}
          </Button>
        </div>
      </form>
      {msg && <Note kind={msg.kind}>{msg.text}</Note>}
    </Row>
  );
}

function RecoveryCode() {
  const auth = useStore((s) => s.auth);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);

  useEffect(() => {
    void api
      .recoveryStatus()
      .then((r) => setEnabled(!!r.enabled))
      .catch(() => setEnabled(false));
  }, []);

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const username = auth.username;
    if (!username) return;
    setBusy(true);
    try {
      await yieldFrame();
      const fresh = generateRecoveryCode();
      const currentAuthKey = deriveAuthKey(username, password);
      const recoveryAuthKey = deriveRecoveryAuthKey(fresh);
      await api.setRecovery(currentAuthKey, recoveryAuthKey);
      setCode(fresh);
      setEnabled(true);
      setPassword('');
    } catch (err) {
      setMsg({ kind: 'bad', text: err instanceof Error ? err.message : t('could not set it up') });
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setMsg(null);
    const username = auth.username;
    if (!username || !password) {
      return setMsg({ kind: 'bad', text: t('enter your password first') });
    }
    setBusy(true);
    try {
      await yieldFrame();
      await api.setRecovery(deriveAuthKey(username, password), null);
      setEnabled(false);
      setCode(null);
      setPassword('');
      setMsg({ kind: 'ok', text: t('Recovery code turned off.') });
    } catch (err) {
      setMsg({ kind: 'bad', text: err instanceof Error ? err.message : t('could not turn it off') });
    } finally {
      setBusy(false);
    }
  }

  function copy() {
    if (!code) return;
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }

  function download() {
    if (!code) return;
    const body = `${t('4AM Casino recovery code')}\n${t('Account: {name}', { name: auth.username ?? '' })}\n\n${code}\n\n${t(
      'Keep this somewhere safe and private. It is the only way back into your account if you forget your password, and it works exactly once.',
    )}\n`;
    const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `4am-recovery-${auth.username}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Row
      title={t('Recovery code')}
      hint={t(
        'Nobody can reset your password for you - your key lives only in your browser. A recovery code is the one way back in. Generate it now, store it somewhere safe, and it works exactly once.',
      )}
    >
      {code ? (
        <div className="max-w-md rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-950/50">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300">
            {t('Save this now — you will not see it again')}
          </p>
          <code className="mt-2 block select-all break-all rounded-lg bg-white/80 px-3 py-2 font-mono text-sm font-bold tracking-wider text-slate-900 dark:bg-slate-900/70 dark:text-slate-100">
            {code}
          </code>
          <div className="mt-3 flex gap-2">
            <Button type="button" variant="secondary" onClick={copy}>
              {copied ? t('✓ Copied') : t('Copy')}
            </Button>
            <Button type="button" variant="secondary" onClick={download}>
              {t('Download')}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setCode(null)}>
              {t('I saved it')}
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={generate} className="grid max-w-md gap-2">
          <p className="text-xs">
            {enabled === null ? (
              <Spinner />
            ) : enabled ? (
              <span className="text-emerald-600 dark:text-emerald-400">
                {t('✓ A recovery code is armed on this account.')}
              </span>
            ) : (
              <span className="text-amber-600 dark:text-amber-400">
                {t('⚠ No recovery code. Forget your password and the account is gone for good.')}
              </span>
            )}
          </p>
          <Input
            type="password"
            aria-label={t('Your password')}
            placeholder={t('Your password')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            disabled={busy}
          />
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? (
                <Spinner label={t('Working…')} />
              ) : enabled ? (
                t('Generate a new code')
              ) : (
                t('Generate code')
              )}
            </Button>
            {enabled && (
              <Button type="button" variant="danger" onClick={disable} disabled={busy}>
                {t('Turn off')}
              </Button>
            )}
          </div>
        </form>
      )}
      {msg && <Note kind={msg.kind}>{msg.text}</Note>}
    </Row>
  );
}

function Devices() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <Row
      title={t('Signed-in devices')}
      hint={t('Signs out every browser except this one. Your password and keys stay the same.')}
    >
      <Button
        type="button"
        variant="secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await api.revokeOtherSessions();
            setMsg(
              r.revoked > 0
                ? t('Signed out {n} other session(s).', { n: r.revoked })
                : t('No other sessions.'),
            );
          } catch {
            setMsg(t('could not do that'));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <Spinner label={t('Working…')} /> : t('Sign out everywhere else')}
      </Button>
      {msg && <Note kind="ok">{msg}</Note>}
    </Row>
  );
}

export function AccountSecurity() {
  return (
    <div>
      <ChangePassword />
      <ChangeUsername />
      <RecoveryCode />
      <Devices />
    </div>
  );
}
