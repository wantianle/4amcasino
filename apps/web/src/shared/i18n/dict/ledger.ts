// LedgerPage (房间账本). `entry.kind` badges and `entry.note` prose are
// persisted server data rendered via tr() - their keys live in dict/server.ts
// (purchase/transfer/revert/commission/hand-settlement/void-hand/seven-deuce
// + the note templates) and are NOT redefined here.
// Shared keys reused from other modules: '← Back to table', 'hand {id}',
// 'voided' (dict/hands.ts), 'Requesting…' (dict/bank.ts), 'Hands played'
// (dict/player.ts), '{n} more to qualify' (dict/leaderboard.ts).
const ledger: Record<string, string> = {
  // ── Header ──────────────────────────────────────────────────────────────
  'Loading ledger…': '正在加载账本…',
  'Bank ledger': '房间账本',
  'chain verified': '账链校验通过',
  'TAMPERED: hashes do not match': '记录被改动：哈希对不上',

  // ── Session report ──────────────────────────────────────────────────────
  'Session report': '战绩小结',
  'Time played': '时长',
  '{h}h {m}m': '{h} 小时 {m} 分',
  '{m}m': '{m} 分钟',
  'Hands dealt': '发牌手数',
  'Biggest pot': '最大底池',
  'Chips on the table': '桌上的筹码',
  'Who is winning': '谁在赢',
  'Net chips won at the table. Bars to the right of the line are winnings, to the left are losses.':
    '桌上的净赢筹码。中线右边是赢的，左边是输的。',
  Player: '玩家',
  Won: '赢',
  'Best pot': '最大赢额',
  'Worst hit': '最惨一手',
  Bought: '买入',
  'Stack now': '现有筹码',
  Net: '净胜',
  private: '私密',

  // ── Buy summary ─────────────────────────────────────────────────────────
  'Bought from the bank (to settle up)': '向银行买入（用于结账）',
  'No purchases yet.': '还没有买入记录。',

  // ── Void (banker controls) ──────────────────────────────────────────────
  'The banker voided this table. Nothing here counts toward leaderboards, profiles, or who owes whom.':
    '账房作废了这张桌。这里的输赢不进排行榜、个人主页，也不算谁欠谁。',
  'Restore this table (results count again)': '恢复这张桌（输赢重新计入）',
  'Void this table (results stop counting)': '作废这张桌（输赢不再计入）',

  // ── Errors (client fallback prose + server prose via tr) ────────────────
  'Could not revert: {error}': '撤销失败：{error}',
  'could not revert': '撤销没成功。',
  'could not void the hand': '这手牌没能作废。',

  // ── Entry table ─────────────────────────────────────────────────────────
  When: '时间',
  Kind: '类型',
  Delta: '增减',
  'Note / ref': '备注 / 凭据',
  Hash: '哈希',
  reverted: '已撤销',
  Revert: '撤销',
  'Void hand': '作废这手牌',
  'The ledger is empty. Buy points to start.': '账本还是空的，先买点数。',
  Cancel: '取消',
};

export default ledger;
