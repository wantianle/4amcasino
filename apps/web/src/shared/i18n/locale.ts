import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** UI locales this app ships. `zh-CN` is the product default (docs/zh-i18n.md). */
export type Locale = 'zh-CN' | 'en';

export const DEFAULT_LOCALE: Locale = 'zh-CN';

/** Options for the settings selector. `label` is the endonym - a language
 *  name is never translated into the other language it labels. */
export const LOCALES: ReadonlyArray<{ value: Locale; label: string }> = [
  { value: 'zh-CN', label: '中文' },
  { value: 'en', label: 'English' },
];

function isLocale(value: unknown): value is Locale {
  return value === 'zh-CN' || value === 'en';
}

interface LocaleStore {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

/** Device-level preference (like the theme), so it persists to localStorage
 *  under its own key instead of the account prefs in store.ts. Rehydration is
 *  synchronous (localStorage), so `getLocale()` is correct from first render. */
export const useLocaleStore = create<LocaleStore>()(
  persist(
    (set) => ({
      locale: DEFAULT_LOCALE,
      setLocale: (locale) => set({ locale }),
    }),
    {
      name: '4am.locale',
      partialize: (s) => ({ locale: s.locale }),
      merge: (persisted, current) => {
        // a hand-edited or future-shaped stored value must never break the UI
        const stored = (persisted as { locale?: unknown } | undefined)?.locale;
        return { ...current, locale: isLocale(stored) ? stored : current.locale };
      },
    },
  ),
);

/** Read the active locale outside React (t(), fmt(), datetime helpers). */
export function getLocale(): Locale {
  return useLocaleStore.getState().locale;
}

/** BCP 47 tag for Intl formatters and `document.documentElement.lang`. */
export function intlLocaleTag(locale: Locale = getLocale()): string {
  return locale === 'en' ? 'en-US' : 'zh-CN';
}
