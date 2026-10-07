// Unit guards for the gameplay-ux lane: the bomb-pot ante is a free whole-BB
// number now (shared BOMB_POT_ANTE_BB_MIN..MAX, not the old 1/2/3 enum), and
// both the time bank and multi-run have left the gameplay feature set - the
// table's timer popover owns the bank, multi-run is a fixed product rule, so
// the dialog must neither count, name, nor write either.
import { beforeEach, describe, expect, it } from 'vitest';
import { BOMB_POT_ANTE_BB_MAX, BOMB_POT_ANTE_BB_MIN, DEFAULT_GAMEPLAY_SETTINGS } from '@4am/shared';
import {
  cloneGameplaySettings,
  enabledFeatureCount,
  enabledFeatureNames,
  normalizeGameplaySettings,
  ownedFeaturePatch,
} from '../src/features/table/GameplaySettingsDialog.tsx';
import { useLocaleStore } from '../src/shared/i18n/locale.ts';

beforeEach(() => {
  useLocaleStore.setState({ locale: 'zh-CN' });
});

const withAnte = (anteBb: unknown) =>
  normalizeGameplaySettings({
    ...cloneGameplaySettings(DEFAULT_GAMEPLAY_SETTINGS),
    bombPot: { enabled: true, anteBb: anteBb as never, schedule: { mode: 'hands', value: 10 } },
  } as never);

describe('bomb-pot ante: free numeric range', () => {
  it('accepts any whole BB value inside MIN..MAX', () => {
    for (const n of [BOMB_POT_ANTE_BB_MIN, 4, 5, BOMB_POT_ANTE_BB_MAX]) {
      expect(withAnte(n).bombPot.anteBb).toBe(n);
    }
  });

  it('clamps out-of-range and junk values into the range', () => {
    expect(withAnte(0).bombPot.anteBb).toBe(BOMB_POT_ANTE_BB_MIN);
    expect(withAnte(BOMB_POT_ANTE_BB_MAX + 5).bombPot.anteBb).toBe(BOMB_POT_ANTE_BB_MAX);
    expect(withAnte(undefined).bombPot.anteBb).toBe(DEFAULT_GAMEPLAY_SETTINGS.bombPot.anteBb);
    // server echoes are clamped too, never snapped back to an off-preset default
    expect(withAnte(2).bombPot.anteBb).toBe(2);
  });
});

describe('time bank and multi-run are no longer gameplay-dialog features', () => {
  it('is excluded from the enabled count and the lobby summary names', () => {
    const allOn = cloneGameplaySettings(DEFAULT_GAMEPLAY_SETTINGS);
    expect(allOn.timeBank.enabled).toBe(true); // still ON in the room's settings
    expect(allOn.multiRun.enabled).toBe(true); // fixed product rule, always on
    // squid + bomb pot only - the bank and multi-run have their own homes now
    expect(enabledFeatureCount(allOn)).toBe(2);
    const names = enabledFeatureNames(allOn);
    expect(names).toHaveLength(2);
    expect(names).not.toContain('计时银行');
    expect(names).not.toContain('多次发牌');
  });

  it('is never part of the dialog save patch (so a stale copy cannot overwrite it)', () => {
    const patch = ownedFeaturePatch(cloneGameplaySettings(DEFAULT_GAMEPLAY_SETTINGS));
    expect(Object.keys(patch).sort()).toEqual(['bombPot', 'squid']);
    expect(patch).not.toHaveProperty('multiRun');
    expect(patch).not.toHaveProperty('timeBank');
  });
});
