import { describe, expect, it } from 'vitest';
import { tableUtilityGroups, unreadChatCount } from '../src/pages/table/tableUi.ts';
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
        hasMeetLink: true,
      }),
    ).toEqual([
      { id: 'people', actions: ['invite', 'watch', 'video'] },
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
        hasMeetLink: false,
      }),
    ).toEqual([
      { id: 'records', actions: ['ledger', 'hands'] },
      { id: 'preferences', actions: ['preferences'] },
    ]);
  });
});
