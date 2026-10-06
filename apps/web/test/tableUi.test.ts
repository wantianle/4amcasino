import { describe, expect, it } from 'vitest';
import {
  filterDesktopMenuGroups,
  tableUtilityGroups,
  unreadChatCount,
} from '../src/pages/table/tableUi.ts';
import {
  centerColumnBudgetPx,
  PHONE_CANVAS,
  SEAT_ANCHOR_PHONE,
  TABLE_CANVAS,
} from '../src/widgets/table/geometry.ts';

describe('table center-column geometry', () => {
  it('reserves the visible desktop hero holo overhang only when requested', () => {
    const baseline = centerColumnBudgetPx(TABLE_CANVAS);
    expect(baseline).toBeCloseTo(204, 5);
    expect(centerColumnBudgetPx(TABLE_CANVAS, undefined, 38)).toBeCloseTo(128, 5);
    expect(centerColumnBudgetPx(TABLE_CANVAS, undefined, 0)).toBe(baseline);
  });

  it('uses the phone holo overhang without changing the no-card path', () => {
    const baseline = centerColumnBudgetPx(PHONE_CANVAS, SEAT_ANCHOR_PHONE);
    // The phone's ±40° neighbour is the limiting edge, so its distinct
    // 13px holo allowance is already inside the existing budget here.
    expect(centerColumnBudgetPx(PHONE_CANVAS, SEAT_ANCHOR_PHONE, 13)).toBeCloseTo(baseline, 5);
    expect(centerColumnBudgetPx(PHONE_CANVAS, SEAT_ANCHOR_PHONE, 0)).toBe(baseline);
  });
});

describe('table chat drawer', () => {
  it('counts only messages received while the drawer is closed', () => {
    expect(unreadChatCount(7, 4, false)).toBe(3);
    expect(unreadChatCount(7, 4, true)).toBe(0);
    expect(unreadChatCount(3, 4, false)).toBe(0);
  });
});

describe('table utility menu', () => {
  it('groups the actions available to a seated host and banker', () => {
    expect(
      tableUtilityGroups({
        amSpectator: false,
        isBankerHere: true,
        isHost: true,
        hasSeat: true,
      }),
    ).toEqual([
      { id: 'people', actions: ['invite', 'watch'] },
      { id: 'records', actions: ['ledger', 'hands'] },
      { id: 'table', actions: ['auto-deal', 'sit-out', 'timer', 'bots'] },
      { id: 'preferences', actions: ['preferences'] },
    ]);
  });

  it('omits actions that a spectator cannot use', () => {
    expect(
      tableUtilityGroups({
        amSpectator: true,
        isBankerHere: false,
        isHost: false,
        hasSeat: false,
      }),
    ).toEqual([
      { id: 'records', actions: ['ledger', 'hands'] },
      { id: 'preferences', actions: ['preferences'] },
    ]);
  });

  it('keeps invite and watch available to the top bar without changing their permissions', () => {
    const groups = tableUtilityGroups({
      amSpectator: false,
      isBankerHere: true,
      isHost: false,
      hasSeat: true,
    });
    const menu = filterDesktopMenuGroups(groups);
    expect(menu.flatMap((group) => group.actions)).not.toEqual(
      expect.arrayContaining(['invite', 'watch']),
    );
    expect(groups.find((group) => group.id === 'people')?.actions).toEqual(['invite', 'watch']);
  });

  it('keeps the mobile invite/watch controls and filters the menu by permission', () => {
    const cases = [
      { amSpectator: true, isBankerHere: false, isHost: false, hasSeat: false },
      { amSpectator: false, isBankerHere: false, isHost: false, hasSeat: false },
      { amSpectator: false, isBankerHere: true, isHost: false, hasSeat: true },
      { amSpectator: false, isBankerHere: true, isHost: true, hasSeat: true },
    ];
    for (const permissions of cases) {
      const groups = tableUtilityGroups(permissions);
      const menu = filterDesktopMenuGroups(groups);
      expect(menu.flatMap((group) => group.actions)).not.toEqual(
        expect.arrayContaining(['invite', 'watch']),
      );
      // These are the dedicated top-bar entries; their presence is governed by
      // the same permissions as the source utility group.
      expect(groups.flatMap((group) => group.actions)).toEqual(
        expect.arrayContaining([
          ...(permissions.amSpectator ? [] : ['invite']),
          ...(permissions.isBankerHere ? ['watch'] : []),
        ]),
      );
    }
  });
});
