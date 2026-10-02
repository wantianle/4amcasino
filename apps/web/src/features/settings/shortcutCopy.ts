import type { PokerHotkeyAction } from '@4am/shared';
import { t } from '../../shared/i18n/index.ts';

/** Dictionary SOURCE keys (B+ scheme, docs/zh-i18n.md §6.2) for every shortcut
 *  action label and description — never run through `t()` here.
 *
 *  This module exists because module-level `t()` snapshots are the exact bug
 *  this fixes: ES module bodies evaluate once and are NOT re-evaluated on a
 *  language switch (App.tsx remounts the keyed tree, but the module cache
 *  survives), so baked labels/descriptions froze in whatever locale was
 *  active at first load. Callers must translate at render time through
 *  `shortcutLabel()` / `shortcutDescription()` below. */
export const SHORTCUT_LABEL_KEYS: Record<PokerHotkeyAction, string> = {
  fold: 'Fold',
  check: 'Check',
  call: 'Call',
  raise: 'Bet / raise',
  halfPot: 'Half pot',
  pot: 'Pot',
  allIn: 'All-in',
};

export const SHORTCUT_DESC_KEYS: Record<PokerHotkeyAction, string> = {
  fold: 'Fold immediately on your turn.',
  check: 'Check only when nothing is owed.',
  call: 'Call the amount shown on your turn.',
  raise: 'Edit the amount, then Enter to confirm.',
  halfPot: 'Select half pot, then Enter to confirm.',
  pot: 'Select pot size, then Enter to confirm.',
  allIn: 'Select your full stack, then Enter to confirm.',
};

/** Action name in the ACTIVE locale — call during render, not at module load. */
export function shortcutLabel(action: PokerHotkeyAction): string {
  return t(SHORTCUT_LABEL_KEYS[action]);
}

/** Action description in the ACTIVE locale — same render-time rule. */
export function shortcutDescription(action: PokerHotkeyAction): string {
  return t(SHORTCUT_DESC_KEYS[action]);
}
