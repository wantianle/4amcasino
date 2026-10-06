import { RiCheckLine, RiUser3Line, RiPokerClubsLine } from '@remixicon/react';
import { useRef, useState } from 'react';
import { api } from '../../shared/api.ts';
import {
  play,
  setSoundVolume,
  setSoundsEnabled,
  soundVolume,
  soundsEnabled,
} from '../../shared/sounds.ts';
import { CARD_BACKS, CARD_FACES, TABLE_SKINS, useStore, type Prefs } from '../../shared/store.ts';
import { cn } from '../../shared/lib/cn.ts';
import { Button, Input } from '../../shared/ui/index.tsx';
import { Avatar } from '../../entities/user/Avatar.tsx';
import { PlayingCard } from '../../entities/card/PlayingCard.tsx';
import { SettingsCard } from '../settings/SettingsCard.tsx';
import { DISPLAY_NAME_MAX_WIDTH, displayNameError } from '../account/displayName.ts';
import { cardFromName } from '@4am/shared';
import { t } from '../../shared/i18n/index.ts';

const BACKS = CARD_BACKS;
const FACES = CARD_FACES;
const SKINS = TABLE_SKINS;

/** Downscale + center-crop the chosen file to a 256px JPEG data URL. */
async function toAvatarDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const g = canvas.getContext('2d')!;
  g.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    256,
    256,
  );
  return canvas.toDataURL('image/jpeg', 0.85);
}

/** The profile form. Lives on /settings; the dialog wrapper below is legacy.
 *  `sectioned` splits it into the settings page's titled cards with a sticky save
 *  bar - one instance either way, so the two halves can never save over each
 *  other's stale copy of a field (requested by notpritam, docs/FEATURES.md). */
export function ProfileEditor({
  onSaved,
  wide = false,
  sectioned = false,
}: {
  onSaved?: () => void;
  wide?: boolean;
  sectioned?: boolean;
}) {
  const auth = useStore((s) => s.auth);
  const prefs = useStore((s) => s.prefs);
  const setPrefs = useStore((s) => s.setPrefs);
  const [displayName, setDisplayName] = useState(prefs.displayName || (auth.username ?? ''));
  const [bio, setBio] = useState(prefs.bio);
  const [phrasesText, setPhrasesText] = useState(prefs.quickPhrases.join('\n'));
  const [sounds, setSounds] = useState(soundsEnabled());
  const [volume, setVolume] = useState(soundVolume());
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Instant feedback; the server re-checks with the same rule and is the referee.
  const nameError = displayNameError(displayName);

  async function pickAvatar(file: File | undefined) {
    if (!file) return;
    try {
      const dataUrl = await toAvatarDataUrl(file);
      const res = await api.uploadAvatar(dataUrl);
      setPrefs({ hasAvatar: true, avatarVersion: res.avatarVersion });
    } catch (e) {
      setError(e instanceof Error ? e.message : t('upload failed'));
    }
  }

  async function save() {
    if (nameError) {
      setError(nameError);
      return;
    }
    setSaving(true);
    setError(null);
    const quickPhrases = phrasesText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 8)
      .map((s) => s.slice(0, 60));
    try {
      await api.updateProfile({
        // Sent exactly as typed: only the true empty string clears the column
        // (so the table falls back to the login name). We never trim - a value
        // with leading/trailing whitespace already failed `nameError` above.
        displayName,
        bio,
        cardBack: prefs.cardBack,
        cardFace: prefs.cardFace,
        tableSkin: prefs.tableSkin,
        privateMode: prefs.privateMode,
        autoJoinInvites: prefs.autoJoinInvites,
        autoReady: prefs.autoReady,
        quickPhrases,
      });
      setPrefs({ displayName: displayName || (auth.username ?? ''), bio, quickPhrases });
      setSoundsEnabled(sounds);
      if (onSaved) {
        onSaved();
      } else {
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('could not save'));
    } finally {
      setSaving(false);
    }
  }

  const identity = (
    <>
      <div className="flex items-center gap-4">
        <Avatar
          userId={auth.userId ?? 0}
          name={displayName || '?'}
          version={prefs.avatarVersion}
          size="xl"
        />
        <div className="space-y-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => void pickAvatar(e.target.files?.[0])}
          />
          <Button variant="secondary" onClick={() => fileRef.current?.click()}>
            {t('Change photo')}
          </Button>
          {prefs.hasAvatar && (
            <Button
              variant="ghost"
              onClick={() =>
                api
                  .deleteAvatar()
                  .then(() =>
                    setPrefs({ hasAvatar: false, avatarVersion: prefs.avatarVersion + 1 }),
                  )
              }
            >
              {t('Remove')}
            </Button>
          )}
        </div>
      </div>

      <label className="block text-sm">
        <span className="mb-1 block text-slate-500">{t('Display name')}</span>
        <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        {nameError ? (
          <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{t(nameError)}</p>
        ) : (
          <p className="mt-1 text-xs text-slate-400">
            {t('Up to {n} columns wide — Chinese counts as two. Leave empty to use your username.', {
              n: DISPLAY_NAME_MAX_WIDTH,
            })}
          </p>
        )}
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-slate-500">{t('Bio')}</span>
        <textarea
          aria-label={t('Bio')}
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          maxLength={280}
          rows={2}
          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800"
          placeholder={t('Tight is right.')}
        />
      </label>

      <label className="block text-sm">
        <span className="mb-1 block text-slate-500">{t('Your quick chat phrases (one per line, max 8)')}</span>
        <textarea
          aria-label={t('Your quick chat phrases')}
          value={phrasesText}
          onChange={(e) => setPhrasesText(e.target.value)}
          rows={3}
          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800"
          placeholder={t('nice hand 👏\nbluff! 🤨\nrun it again 🔁')}
        />
      </label>
    </>
  );

  /** Deck style must survive the next `loadPrefs()` account re-sync (app start
   *  and every /settings mount pull the server's copy). The sticky bar
   *  promises "Deck and sound apply instantly", so a pick writes the store —
   *  every surface renders card backs and 4-color suits from it — and quietly
   *  syncs the server in the background. Offline, the local pick still applies
   *  and the next explicit save re-sends it. */
  function applyDeckStyle(patch: Partial<Prefs>) {
    setPrefs(patch);
    void api.updateProfile(patch).catch(() => {});
  }

  const tableStyle = (
    <>
      <div className="text-sm">
        <span className="mb-2 block text-slate-500">{t('Card back')}</span>
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
          {BACKS.map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => applyDeckStyle({ cardBack: b })}
              aria-label={t(`${b} card back`)}
              aria-pressed={prefs.cardBack === b}
              className={cn(
                // Exactly ONE ring-color utility at a time. `ring-transparent`
                // and `ring-indigo-500` both set --tw-ring-color, and the
                // compiled CSS emits transparent after indigo — with both on
                // the button the selection ring was always invisible and the
                // picker looked dead no matter what you clicked.
                'relative rounded-lg p-1 text-center ring-2 transition-shadow hover:bg-slate-100 dark:hover:bg-slate-800',
                prefs.cardBack === b ? 'ring-indigo-500' : 'ring-transparent',
              )}
            >
              <PlayingCard faceDown cardBackStyle={b} size="sm" className="mx-auto" />
              {prefs.cardBack === b && (
                // locale-proof confirmation: a check badge on the chosen swatch
                <span
                  className="absolute -bottom-1 -right-1 grid size-4.5 place-items-center rounded-full bg-indigo-500 text-white shadow-sm"
                  aria-hidden
                >
                  <RiCheckLine className="size-3" />
                </span>
              )}
              </button>
          ))}
        </div>
        <span className="mb-2 mt-4 block text-slate-500">{t('Card face')}</span>
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
          {FACES.map((face) => (
            <button key={face} type="button" onClick={() => applyDeckStyle({ cardFace: face })}
              aria-label={t(`${face} card face`)} aria-pressed={prefs.cardFace === face}
              className={cn('relative rounded-lg p-1 text-center ring-2 transition-shadow hover:bg-slate-100 dark:hover:bg-slate-800', prefs.cardFace === face ? 'ring-indigo-500' : 'ring-transparent')}>
              <PlayingCard card={cardFromName('Td')} cardFace={face} size="sm" className="mx-auto" />
              {prefs.cardFace === face && <RiCheckLine className="absolute right-0 top-0 size-4 rounded-full bg-indigo-500 text-white" aria-hidden />}
            </button>
          ))}
        </div>
        <span className="mb-2 mt-4 block text-slate-500">{t('Table skin')}</span>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {SKINS.map((skin) => (
            <button key={skin} type="button" onClick={() => applyDeckStyle({ tableSkin: skin })}
              aria-label={t(`${skin} table skin`)} aria-pressed={prefs.tableSkin === skin}
              className={cn('relative overflow-hidden rounded-xl p-2 text-left ring-2 transition-shadow hover:scale-[1.02]', prefs.tableSkin === skin ? 'ring-indigo-500' : 'ring-transparent')}>
              <div data-table-skin={skin} className="table-app-bg h-16 rounded-lg p-2">
                <div className="h-full rounded-[50%] border border-white/20 bg-[var(--table-felt-core)] shadow-inner" />
              </div>
              <span className="mt-1 block text-xs font-medium">{t(`${skin} table skin`)}</span>
              {prefs.tableSkin === skin && <RiCheckLine className="absolute right-2 top-2 size-4 rounded-full bg-indigo-500 text-white" aria-hidden />}
            </button>
          ))}
        </div>
      </div>

      <label className="flex items-start gap-2 text-sm text-slate-600 dark:text-slate-300">
        <input
          type="checkbox"
          checked={prefs.autoJoinInvites}
          onChange={(e) => setPrefs({ autoJoinInvites: e.target.checked })}
          className="mt-0.5"
        />
        <span>{t('Auto-join: when a friend invites me to a table, add me right away instead of asking.')}</span>
      </label>

      <label className="flex items-start gap-2 text-sm text-slate-600 dark:text-slate-300">
        <input
          type="checkbox"
          checked={prefs.autoReady}
          onChange={(e) => setPrefs({ autoReady: e.target.checked })}
          className="mt-0.5"
        />
        <span>
          {t(
            `Auto ready: deal me into every hand without asking. Skips the "I'm ready" check — turn it off if you want a beat to step away between hands.`,
          )}
        </span>
      </label>

      <label className="flex items-start gap-2 text-sm text-slate-600 dark:text-slate-300">
        <input
          type="checkbox"
          checked={prefs.privateMode}
          onChange={(e) => setPrefs({ privateMode: e.target.checked })}
          className="mt-0.5"
        />
        <span>
          {t(
            'Private mode: hide my winnings from other players. Leaderboards, the session report, and the chip-leader crown skip you; bankers still see everything so the group can settle up.',
          )}
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
        <label className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
          <input
            type="checkbox"
            checked={sounds}
            onChange={(e) => {
              setSounds(e.target.checked);
              setSoundsEnabled(e.target.checked);
              if (e.target.checked) play('chip');
            }}
          />
          {t('Game sounds')}
        </label>
      </div>

      {sounds && (
        <div className="flex items-center gap-3 text-sm text-slate-600 dark:text-slate-300">
          <span className="text-slate-500">{t('Volume')}</span>
          <input
            type="range"
            min={0.05}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => {
              const v = +e.target.value;
              setVolume(v);
              setSoundVolume(v);
            }}
            onPointerUp={() => play('chip')}
            className="flex-1 accent-indigo-600"
            aria-label={t('Sound volume')}
          />
          <Button variant="ghost" onClick={() => play('win')}>
            {t('Test')}
          </Button>
        </div>
      )}
    </>
  );

  if (sectioned) {
    return (
      <div className="space-y-6">
        <SettingsCard
          id="profile"
          title={t('Profile')}
          icon={<RiUser3Line className="size-4" aria-hidden />}
          desc={t(
            'Your face and name at the table, and the phrases you can fire into chat in one tap.',
          )}
        >
          <div className="space-y-4">{identity}</div>
        </SettingsCard>

        <SettingsCard
          id="table"
          title={t('Table & play')}
          icon={<RiPokerClubsLine className="size-4" aria-hidden />}
          desc={t('How the felt looks and sounds for you, and what other players get to see.')}
        >
          <div className="space-y-4">{tableStyle}</div>
        </SettingsCard>

        {/* follows you down the page so a change three sections up is never
            stranded behind a scroll */}
        <div className="sticky bottom-4 z-10 flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200/70 bg-white/90 px-4 py-3 shadow-lg backdrop-blur dark:border-slate-700/70 dark:bg-slate-900/90">
          <Button onClick={() => void save()} disabled={saving || !!nameError}>
            {saving ? t('Saving…') : t('Save profile')}
          </Button>
          {error && <p className="text-sm text-rose-600">{error}</p>}
          {saved && <p className="text-sm text-emerald-600">{t('✓ Saved.')}</p>}
          {!error && !saved && (
            <p className="text-xs text-slate-400">{t('Deck and sound apply instantly.')}</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={wide ? 'grid gap-x-10 gap-y-4 md:grid-cols-2' : 'space-y-4'}>
      <div className="space-y-4">{identity}</div>
      <div className="space-y-4">{tableStyle}</div>
      <div className={cn('space-y-3', wide && 'md:col-span-2')}>
        {error && <p className="text-sm text-rose-600">{error}</p>}
        {saved && <p className="text-sm text-emerald-600">{t('Saved.')}</p>}
        <Button
          className={wide ? 'w-full sm:w-auto' : 'w-full'}
          onClick={() => void save()}
          disabled={saving || !!nameError}
        >
          {saving ? t('Saving…') : t('Save profile')}
        </Button>
      </div>
    </div>
  );
}
