import { parsePokerHotkeys, type PokerHotkeys } from '@4am/shared';
import { api } from './api.ts';
import { isCardBack, sanitizeBetRatios, useStore } from './store.ts';

/** Quick-bet ratios (A10) live in the persisted auth store so they ride with
 *  the signed-in account across reloads. The profile endpoint is the
 *  authoritative copy, so every local save is mirrored there too. */
export function saveBetRatios(ratios: number[]): void {
  const clean = sanitizeBetRatios(ratios);
  useStore.getState().setPrefs({ betRatios: clean });
  void api.updateProfile({ betRatios: clean }).catch(() => {});
}

/** Pull profile prefs from the server into the store. */
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
      // A10: when the server returns the field it is authoritative, and the
      // sanitizer migrates an old four-slot value to the current five-slot
      // default. When the server omits it (`bet_ratios` is still NULL because
      // an earlier save never reached the server - a failed/late PUT), keep the
      // local pick instead of clobbering it with the defaults; it still goes
      // through the sanitizer, so a local legacy four-slot shape is migrated.
      betRatios:
        p.betRatios !== undefined
          ? sanitizeBetRatios(p.betRatios)
          : sanitizeBetRatios(useStore.getState().prefs.betRatios),
    });
  } catch {
    /* not logged in yet */
  }
}

export { soundsEnabled, setSoundsEnabled, soundVolume, setSoundVolume } from './sounds.ts';
