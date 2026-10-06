import { beforeEach, describe, expect, it } from 'vitest';
import { t } from '../src/shared/i18n/index.ts';
import { useLocaleStore } from '../src/shared/i18n/locale.ts';

// The product default is zh-CN; make it explicit so these assertions do not
// depend on a persisted device preference.
beforeEach(() => {
  useLocaleStore.setState({ locale: 'zh-CN' });
});

describe('i18n template matching: unit templates must not hijack prose', () => {
  it('leaves an untranslated m-ending English string untouched', () => {
    // 'Close room' ends in "m" and (before the table-page fix lands) has no
    // exact key. The `{m}m` unit template used to swallow it as "Close roo 分钟".
    expect(t('Close room')).not.toBe('Close roo 分钟');
    expect(t('Close room')).not.toContain('分钟');
  });

  it('does not hijack t("Platform") (exact key) and falls back to its translation', () => {
    expect(t('Platform')).toBe('平台');
    expect(t('Platform')).not.toBe('Platfor 分钟');
    expect(t('Platform')).not.toContain('分钟');
  });

  it('never turns an m-ending non-matching string into a unit capture', () => {
    expect(t('Brilliant stream')).toBe('Brilliant stream');
  });

  it('keeps the numeric minutes template working', () => {
    expect(t('{m}m', { m: 5 })).toBe('5 分钟');
    expect(t('{m}m', { m: 90 })).toBe('90 分钟');
  });

  it('keeps the hours+minutes template working', () => {
    expect(t('{h}h {m}m', { h: 2, m: 30 })).toBe('2 小时 30 分');
  });

  it('keeps ordinary text placeholders working', () => {
    expect(t('Seat {n}', { n: 3 })).toBe('3 号位');
    expect(t('Waiting for {name}…', { name: 'Bob' })).toBe('等 Bob 行动…');
    expect(t('Next hand in {n}s', { n: 12 })).toBe('12 秒后开下一手');
  });
});
