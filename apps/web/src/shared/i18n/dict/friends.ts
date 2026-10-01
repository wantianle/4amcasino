// Friends dictionary (features/friends/FriendsPanel: friends list, invites,
// invite-from-table dialog). Glossary: friend request → 好友申请, room code →
// 房间码, join → 加入牌桌. Usernames, display names and room names pass
// through as vars and are never translated. Relative last-seen time is
// produced by fmtRelative() in shared/lib/datetime.ts (刚刚 / N 分钟前 / …),
// so the old `${n}m ago` strings have no keys here.
// Reused, NOT redefined: 'Blinds {sb}/{bb} · Code {code}' (lobby),
// 'Decline' (table-page), server prose like 'already friends' / 'no such user'
// lives in dict/server.ts and is matched via tr().
const friends: Record<string, string> = {
  // Presence
  online: '在线',
  offline: '离线',
  'never seen': '从未上线',

  // Panel head + add form
  Friends: '好友',
  'Add by username': '按用户名添加',
  'Send friend request': '发送好友申请',
  'You are now friends.': '你们已经是好友了。',
  'Request sent.': '申请已发出。',
  'could not add': '好友申请没发出去，稍后再试。',

  // Incoming requests — the name stays bold JSX, so only the trailing phrase
  // is keyed. Reused, NOT redefined: bare 'No' resolves to table-page's
  // '拒绝' (wins merge order), matching the Accept/拒绝 button pair.
  'wants to be friends': '想加你为好友',
  Accept: '通过',

  // Friends list
  'No friends yet. Add someone by username and play at the same tables.':
    '还没有好友。按用户名加一个，以后就能坐到同一张桌上。',
  'Waiting on: {names}': '还在等对方回应：{names}',

  // Table invites (lobby banner). 'Join table' → 加入牌桌 is owned by
  // dict/landing.ts; 'Blinds {sb}/{bb} · Code {code}' by dict/lobby.ts.
  'invited you to': '邀请你加入',
  invite: '邀请',

  // Invite-online-friends dialog (table)
  'All your friends are already here, or you have none yet. Add friends from the lobby, or just share the join code.':
    '好友要么已经在这张桌上，要么你还没加好友。去大厅加几个，或者直接把房间码发出去。',
  Invite: '邀请',
  'joined!': '已入座！',
  invited: '已邀请',
  failed: '没发出去',
};

export default friends;
