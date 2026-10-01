import { parsePokerHotkeys, type PokerHotkeys } from '@4am/shared';
import { api } from './api.ts';
import { isCardBack, sanitizeBetRatios, useStore } from './store.ts';

export function applyAppearance(): void {
  // Appearance is a device preference; a profile refresh must not reset it.
  document.documentElement.classList.remove('cyber');
  document.documentElement.classList.add('zeus');
}

/** Quick-bet ratios (A10) live in the persisted auth store so they ride with
 *  the signed-in account across reloads. `loadPrefs` only overwrites them when
 *  the server actually returns a `betRatios` field - until the profile endpoint
 *  stores it, an unsynced server value must never clobber the local pick. */
export function saveBetRatios(ratios: number[]): void {
  const clean = sanitizeBetRatios(ratios);
  useStore.getState().setPrefs({ betRatios: clean });
  // fire a profile write too, so the day the server adopts the field the value
  // is already on its way up; a not-yet-supported server harmlessly ignores it.
  void api.updateProfile({ betRatios: clean }).catch(() => {});
}

/** Pull profile prefs from the server into the store (and apply the Zeus appearance). */
let prefsRevision = 0;
export function savePokerHotkeysLocally(pokerHotkeys: PokerHotkeys, userId: number): void {
  prefsRevision++;
  useStore.getState().setPokerHotkeys(pokerHotkeys, userId);
  localStorage.setItem('4am-hotkeys-changed', JSON.stringify({ userId, at: Date.now() }));
}

export async function loadPrefs({
  onlyHotkeys = false,
}: { onlyHotkeys?: boolean } = {}): Promise<void> {
  const auth = useStore.getState().auth;
  const revision = ++prefsRevision;
  if (!auth.token) return;
  try {
    const p = await api.profile();
    if (useStore.getState().auth.token !== auth.token || p.userId !== auth.userId) return;
    if (revision === prefsRevision) {
      const hotkeys = parsePokerHotkeys(p.pokerHotkeys);
      if (hotkeys) useStore.getState().setPokerHotkeys(hotkeys, p.userId);
    }
    if (onlyHotkeys) return;
    useStore.getState().setPrefs({
      displayName: p.displayName,
      bio: p.bio,
      hasAvatar: p.hasAvatar,
      avatarVersion: p.avatarVersion,
      // A missing or foreign server value must never clobber the live pick with
      // `undefined` — that class template (`card-back-${value}`) would render a
      // dead picker and invisible backs until the next rehydrate.
      cardBack: isCardBack(p.cardBack) ? p.cardBack : useStore.getState().prefs.cardBack,
      fourColor: p.fourColor,
      quickPhrases: p.quickPhrases ?? [],
      privateMode: !!p.privateMode,
      autoJoinInvites: !!p.autoJoinInvites,
      autoReady: !!p.autoReady,
      // A10: the server copy wins once it ships the field; until the profile
      // GET returns betRatios the locally saved list stays authoritative.
      betRatios:
        p.betRatios !== undefined ? sanitizeBetRatios(p.betRatios) : useStore.getState().prefs.betRatios,
    });
    applyAppearance();
  } catch {
    /* not logged in yet */
  }
}

export { soundsEnabled, setSoundsEnabled, soundVolume, setSoundVolume } from './sounds.ts';
