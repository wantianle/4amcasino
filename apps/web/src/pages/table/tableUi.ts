export function unreadChatCount(
  totalMessages: number,
  seenMessages: number,
  drawerOpen: boolean,
): number {
  if (drawerOpen) return 0;
  return Math.max(0, totalMessages - seenMessages);
}

export type TableUtilityGroupId = 'people' | 'records' | 'table' | 'preferences';
export type TableUtilityAction =
  | 'invite'
  | 'watch'
   | 'ledger'
  | 'hands'
  | 'sit-out'
  | 'timer'
  | 'bots'
  | 'transfer-host'
  | 'auto-deal'
  | 'preferences';

export interface TableUtilityGroup {
  id: TableUtilityGroupId;
  actions: TableUtilityAction[];
}

/** Remove actions surfaced as dedicated top-bar controls from the overflow menu. */
export function filterDesktopMenuGroups(
  groups: TableUtilityGroup[],
  surfaced: TableUtilityAction[] = ['invite', 'watch'],
): TableUtilityGroup[] {
  return groups
    .map((group) => ({
      ...group,
      actions: group.actions.filter((action) => !surfaced.includes(action)),
    }))
    .filter((group) => group.actions.length > 0);
}

export function tableUtilityGroups({
  amSpectator,
  isBankerHere,
  isHost,
  hasSeat,
}: {
  amSpectator: boolean;
  isBankerHere: boolean;
  isHost: boolean;
  hasSeat: boolean;
}): TableUtilityGroup[] {
  const people: TableUtilityAction[] = [];
  if (!amSpectator) people.push('invite');
  if (isBankerHere) people.push('watch');

  const table: TableUtilityAction[] = [];
  if (!amSpectator) table.push('auto-deal');
  if (hasSeat) table.push('sit-out');
  if (isHost) table.push('timer');
  // host-only bot management; on desktop the same action rides the top-bar
  // chip (inlineSurfaced drops it from the menu), on phones this is the entry
  if (isHost) table.push('bots');
  // host-only: hand the role to another seated player (the only way it moves)
  if (isHost) table.push('transfer-host');

  return [
    ...(people.length > 0 ? [{ id: 'people' as const, actions: people }] : []),
    { id: 'records', actions: ['ledger', 'hands'] },
    ...(table.length > 0 ? [{ id: 'table' as const, actions: table }] : []),
    { id: 'preferences', actions: ['preferences'] },
  ];
}
