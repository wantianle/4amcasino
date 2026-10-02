import { afterAll, describe, expect, it, vi } from 'vitest';
import { POKER_HOTKEY_ACTIONS, type PokerHotkeyAction } from '@4am/shared';

/** The locale store persists via zustand/persist, whose default storage is
 *  `() => window.localStorage` (node env has no `window` → it would warn on
 *  every setLocale). Stub a minimal window+storage BEFORE the store module is
 *  evaluated, hence the dynamic imports below. */
const memory = new Map<string, string>();
vi.stubGlobal('window', {
  localStorage: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
  },
});

const { useLocaleStore } = await import('../src/shared/i18n/locale.ts');
const { t, hasTranslation } = await import('../src/shared/i18n/index.ts');
const { SHORTCUT_LABEL_KEYS, SHORTCUT_DESC_KEYS, shortcutLabel, shortcutDescription } =
  await import('../src/features/settings/shortcutCopy.ts');

/** The exact option list from the shortcuts panel screenshot (docs/zh-i18n.md §5a). */
const ZH_LABELS: Record<PokerHotkeyAction, string> = {
  fold: '弃牌',
  check: '过牌',
  call: '跟注',
  raise: '下注·加注',
  halfPot: '半池',
  pot: '满池',
  allIn: '全下',
};

const setLocale = (locale: 'zh-CN' | 'en') => useLocaleStore.getState().setLocale(locale);

afterAll(() => setLocale('zh-CN'));

describe('shortcut settings copy is locale-reactive at render time', () => {
  it('stores action names and descriptions as dictionary source keys, never baked text', () => {
    for (const action of POKER_HOTKEY_ACTIONS) {
      // semantic English keys — the very bug was calling t() at module load
      expect(SHORTCUT_LABEL_KEYS[action]).not.toMatch(/[\u4e00-\u9fff]/);
      expect(SHORTCUT_DESC_KEYS[action]).not.toMatch(/[\u4e00-\u9fff]/);
      expect(hasTranslation(SHORTCUT_LABEL_KEYS[action])).toBe(true);
      expect(hasTranslation(SHORTCUT_DESC_KEYS[action])).toBe(true);
    }
  });

  it('re-translates labels and descriptions the instant the locale store flips', () => {
    setLocale('zh-CN');
    for (const action of POKER_HOTKEY_ACTIONS) {
      expect(shortcutLabel(action)).toBe(ZH_LABELS[action]);
    }
    expect(shortcutDescription('check')).toBe('无需跟注时才能过牌。');

    // same module instance, no reload: switching to English must take effect now
    setLocale('en');
    for (const action of POKER_HOTKEY_ACTIONS) {
      expect(shortcutLabel(action)).toBe(SHORTCUT_LABEL_KEYS[action]);
    }
    expect(shortcutDescription('check')).toBe('Check only when nothing is owed.');

    // …and back to Chinese again, still without re-evaluating the module
    setLocale('zh-CN');
    expect(shortcutLabel('allIn')).toBe('全下');
    expect(shortcutLabel('raise')).toBe('下注·加注');
  });

  it('interpolates the record-confirmation template in both locales', () => {
    // mirrors how KeyboardShortcuts renders Feedback: template + action label
    // are translated at display time, so a language switch retimes old toasts.
    const template = '{action} set to {key}. Save to apply.';
    setLocale('zh-CN');
    expect(t(template, { action: shortcutLabel('call'), key: 'C' })).toBe(
      '「跟注」已设为 C，保存后生效。',
    );
    setLocale('en');
    expect(t(template, { action: shortcutLabel('call'), key: 'C' })).toBe(
      'Call set to C. Save to apply.',
    );
  });
});
