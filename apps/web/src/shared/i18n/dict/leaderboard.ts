// LeaderboardPage + the standings card it shares with room dialogs.
// NOTE: 'You' (self badge) is defined in dict/table.ts as 「你」 and '{n} more
// to qualify' here is also rendered by LedgerPage - both resolve through the
// one merged dictionary, no redefinition needed.
const leaderboard: Record<string, string> = {
  Leaderboard: '排行榜',
  'All-time net points from settled hands, across every room on this server.':
    '这台服务器上所有房间、已结算手牌累计下来的净点数。',
  'Loading standings…': '正在加载排名…',
  'No settled hands yet. Deal one and come back.': '还没有结算过的手牌。开一手再来。',
  'Winnings count in settle-up after {n} hands played.': '打满 {n} 手，输赢才计入结账。',
  '{n} hands': '{n} 手',
  best: '最佳一胜',
  '{n} more to qualify': '再打 {n} 手才达标',
};

export default leaderboard;
