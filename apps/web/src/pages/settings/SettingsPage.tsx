import {
  RiUser3Line,
  RiPokerClubsLine,
  RiShieldKeyholeLine,
  RiLinksLine,
  RiLogoutBoxLine,
  RiSunLine,
  RiKeyboardLine,
  RiCoinsLine,
} from '@remixicon/react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../shared/api.ts';
import { loadPrefs, saveBetRatios } from '../../shared/prefs.ts';
import {
  ALL_IN_RATIO,
  BET_RATIO_OPTIONS,
  DEFAULT_BET_RATIOS,
  useStore,
} from '../../shared/store.ts';
import { Button, Input, Spinner } from '../../shared/ui/index.tsx';
import { cn } from '../../shared/lib/cn.ts';
import { ProfileEditor } from '../../features/profile/ProfileDialog.tsx';
import { AccountSecurity } from '../../features/account/AccountSecurity.tsx';
import { KeyboardShortcuts } from '../../features/settings/KeyboardShortcuts.tsx';
import { SettingsCard } from '../../features/settings/SettingsCard.tsx';
import { AppearanceToggle } from '../../shared/ui/AppearanceToggle.tsx';
import { t } from '../../shared/i18n/index.ts';
import { tNode } from '../../shared/i18n/trans.tsx';
import { LOCALES, useLocaleStore } from '../../shared/i18n/locale.ts';

/** Profile and preferences as a real page: linkable, refreshable, back-button
 *  friendly - and laid out as titled cards with a rail instead of one long
 *  undifferentiated form (requested by notpritam, docs/FEATURES.md). */

const SECTIONS = [
  { id: 'profile', label: 'Profile', icon: RiUser3Line },
  { id: 'table', label: 'Table & play', icon: RiPokerClubsLine },
  { id: 'bet-sizing', label: 'Bet sizing', icon: RiCoinsLine },
  { id: 'shortcuts', label: 'Keyboard shortcuts', icon: RiKeyboardLine },
  { id: 'appearance', label: 'Appearance', icon: RiSunLine },
  { id: 'account', label: 'Account & security', icon: RiShieldKeyholeLine },
  { id: 'merge', label: 'Merge accounts', icon: RiLinksLine },
  { id: 'session', label: 'Session', icon: RiLogoutBoxLine },
] as const;

/** A10 (docs/table-redesign-spec.md): the quick-bet buttons at the table are
 *  four configurable pot ratios. The list applies instantly and is saved to
 *  the account; the table's ActionBar reads it from the store. */
function BetSizingSettings() {
  const ratios = useStore((s) => s.prefs.betRatios);
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flashSaved = () => {
    setSaved(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaved(false), 2500);
  };

  const optionLabel = (frac: number): string => {
    if (frac === ALL_IN_RATIO) return t('All-in');
    if (frac === 0.25) return t('¼ pot');
    if (frac === 1 / 3) return t('⅓ pot');
    if (frac === 0.5) return t('½ pot');
    if (frac === 0.75) return t('¾ pot');
    if (frac === 1) return t('Pot');
    return t('{n}× pot', { n: frac });
  };

  // review fix #12: duplicates would just collapse into one button at the
  // table, so picking an already-used ratio SWAPS the two slots instead - the
  // four quick buttons stay four distinct buttons.
  const changeSlot = (index: number, value: number) => {
    const next = [...ratios];
    const moved = next[index] ?? value;
    const clash = next.indexOf(value);
    if (clash !== -1 && clash !== index) next[clash] = moved;
    next[index] = value;
    saveBetRatios(next);
    flashSaved();
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {ratios.map((frac, index) => (
          <label key={index} className="block text-sm">
            <span className="mb-1 block text-slate-500">{t('Bet button {n}', { n: index + 1 })}</span>
            <select
              value={String(frac)}
              onChange={(e) => changeSlot(index, Number(e.target.value))}
              className="min-h-10 w-full rounded-lg border border-slate-200 bg-white px-2.5 text-sm font-medium dark:border-slate-700 dark:bg-slate-800"
            >
              {BET_RATIO_OPTIONS.map((option) => (
                <option key={String(option)} value={String(option)}>
                  {optionLabel(option)}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="ghost"
          type="button"
          onClick={() => {
            saveBetRatios([...DEFAULT_BET_RATIOS]);
            flashSaved();
          }}
        >
          {t('Restore defaults')}
        </Button>
        {saved && <p className="text-sm text-emerald-600 dark:text-emerald-400">{t('Saved.')}</p>}
      </div>
    </div>
  );
}

/** Asks the platform to fold one account into another. Nothing changes until
 *  a platform admin approves the request. */
function MergeAccountsForm() {
  const [fromUsername, setFromUsername] = useState('');
  const [intoUsername, setIntoUsername] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!fromUsername.trim() || !intoUsername.trim()) {
      setMsg({ kind: 'bad', text: t('Enter both usernames.') });
      return;
    }
    setBusy(true);
    try {
      await api.mergeRequest(fromUsername.trim(), intoUsername.trim(), note.trim() || undefined);
      setMsg({ kind: 'ok', text: t('Request sent to the platform for approval.') });
      setFromUsername('');
      setIntoUsername('');
      setNote('');
    } catch (err) {
      setMsg({
        kind: 'bad',
        text: err instanceof Error ? err.message : t('Could not send that request.'),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3">
      <p className="text-sm text-slate-500">
        {t(
          'Moves everything the first account owns to the second, then retires the first. Use this when the same person ended up with two accounts. A platform admin reviews every request before anything happens.',
        )}
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-slate-500">{t('Username to retire')}</span>
          <Input
            placeholder={t('username')}
            value={fromUsername}
            onChange={(e) => setFromUsername(e.target.value)}
            disabled={busy}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-500">{t('Username to keep')}</span>
          <Input
            placeholder={t('username')}
            value={intoUsername}
            onChange={(e) => setIntoUsername(e.target.value)}
            disabled={busy}
          />
        </label>
      </div>
      <label className="block text-sm">
        <span className="mb-1 block text-slate-500">{t('Note for the platform (optional)')}</span>
        <Input
          placeholder={t('Why these are the same person')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={busy}
        />
      </label>
      {msg && (
        <p
          className={
            msg.kind === 'ok'
              ? 'text-sm text-emerald-600 dark:text-emerald-400'
              : 'text-sm text-rose-600 dark:text-rose-400'
          }
        >
          {msg.text}
        </p>
      )}
      <Button type="submit" disabled={busy}>
        {busy ? <Spinner label={t('Sending…')} /> : t('Send merge request')}
      </Button>
    </form>
  );
}

/** UI language switcher. Device-level (localStorage via useLocaleStore), not
 *  an account pref - mirrors the theme control above it. App.tsx remounts the
 *  routed tree on change so every t() re-evaluates. */
function LanguagePicker() {
  const locale = useLocaleStore((s) => s.locale);
  const setLocale = useLocaleStore((s) => s.setLocale);

  return (
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border-button-default pt-5 dark:border-slate-700/70">
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{t('Language')}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-slate-500">
          {t('Choose the language of menus and messages. It is saved on this device.')}
        </p>
      </div>
      <div
        role="radiogroup"
        aria-label={t('Language')}
        className="inline-flex shrink-0 rounded-lg border border-border-button-default bg-slate-50 p-1 dark:border-slate-700 dark:bg-slate-800"
      >
        {LOCALES.map((l) => (
          <button
            key={l.value}
            type="button"
            role="radio"
            aria-checked={locale === l.value}
            onClick={() => setLocale(l.value)}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm transition-colors',
              locale === l.value
                ? 'bg-white font-semibold text-indigo-700 shadow-sm dark:bg-indigo-950/60 dark:text-indigo-300'
                : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200',
            )}
          >
            {l.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function SectionRail() {
  const [active, setActive] = useState<string>('profile');

  // highlight whichever card owns the top of the viewport
  useEffect(() => {
    const nodes = SECTIONS.map((s) => document.getElementById(s.id)).filter(
      (n): n is HTMLElement => !!n,
    );
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive(top.target.id);
      },
      { rootMargin: '-80px 0px -60% 0px', threshold: 0 },
    );
    nodes.forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, []);

  return (
    <nav className="sticky top-6 hidden w-52 shrink-0 lg:block" aria-label={t('Settings sections')}>
      <ul className="space-y-0.5">
        {SECTIONS.map((s) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              aria-current={active === s.id ? 'location' : undefined}
              onClick={(e) => {
                e.preventDefault();
                document
                  .getElementById(s.id)
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                history.replaceState(null, '', `#${s.id}`);
              }}
              className={cn(
                'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                active === s.id
                  ? 'bg-indigo-50 font-semibold text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300'
                  : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800',
              )}
            >
              <s.icon className="size-4" aria-hidden />
              {t(s.label)}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function SettingsPage() {
  const [ready, setReady] = useState(false);
  const auth = useStore((s) => s.auth);
  const logout = useStore((s) => s.logout);
  const nav = useNavigate();

  // pull the server's copy first so a direct visit never edits stale values
  useEffect(() => {
    void loadPrefs().finally(() => setReady(true));
  }, []);

  // deep link straight to a section (/settings#account)
  useEffect(() => {
    if (!ready) return;
    const id = location.hash.slice(1);
    if (id) {
      requestAnimationFrame(() =>
        document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      );
    }
  }, [ready]);

  if (!ready) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Spinner label={t('Loading your profile…')} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl p-6">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-bold">{t('Settings')}</h1>
        <p className="mt-1 text-sm text-slate-500">
          {tNode(
            'Signed in as {name}. Who you are at the table, and how the table behaves for you.',
            {
              name: (
                <span className="font-medium text-slate-700 dark:text-slate-300">
                  {auth.username}
                </span>
              ),
            },
          )}
        </p>
      </header>

      <div className="flex gap-8">
        <SectionRail />

        <div className="min-w-0 flex-1 space-y-6">
          <ProfileEditor sectioned />

          <SettingsCard
            id="bet-sizing"
            title={t('Bet sizing')}
            icon={<RiCoinsLine className="size-4" aria-hidden />}
            desc={t('Quick bet buttons on the table, saved to your account.')}
          >
            <BetSizingSettings />
          </SettingsCard>

          <SettingsCard
            id="shortcuts"
            title={t('Keyboard shortcuts')}
            icon={<RiKeyboardLine className="size-4" aria-hidden />}
            desc={t('Your quick actions, saved to your account.')}
          >
            <KeyboardShortcuts />
          </SettingsCard>

          <SettingsCard
            id="appearance"
            title={t('Appearance')}
            icon={<RiSunLine className="size-4" aria-hidden />}
            desc={t('Choose light or dark. Your preference is saved on this device.')}
          >
            <AppearanceToggle />
            <LanguagePicker />
          </SettingsCard>

          <SettingsCard
            id="account"
            title={t('Account & security')}
            icon={<RiShieldKeyholeLine className="size-4" aria-hidden />}
            desc={t(
              'Your password derives the key that signs your cards, right here in this browser. Nothing on this card is ever sent to the server in the clear.',
            )}
          >
            <AccountSecurity />
          </SettingsCard>

          <SettingsCard
            id="merge"
            title={t('Merge accounts')}
            icon={<RiLinksLine className="size-4" aria-hidden />}
            desc={t(
              'Combine two accounts that belong to the same person. Once a platform admin approves it, everything moves to the account you keep.',
            )}
          >
            <MergeAccountsForm />
          </SettingsCard>

          <SettingsCard
            id="session"
            title={t('Session')}
            icon={<RiLogoutBoxLine className="size-4" aria-hidden />}
            desc={t(
              'Signing out clears your keys from this browser. You get them back by logging in again with the same password.',
            )}
          >
            <Button
              variant="danger"
              onClick={() => {
                // kill the session server-side too, then clear this browser -
                // clearing localStorage alone left the token live forever
                void api
                  .logout()
                  .catch(() => {})
                  .finally(() => {
                    logout();
                    nav('/login');
                  });
              }}
            >
              {t('Sign out')}
            </Button>
          </SettingsCard>
        </div>
      </div>
    </div>
  );
}
