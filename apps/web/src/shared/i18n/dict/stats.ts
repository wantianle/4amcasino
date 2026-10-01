// Stats dictionary (features/stats/charts.tsx: net-winnings area chart and
// play-style radar on the player page). Axis tick labels come from fmtTime /
// fmtDate in shared/lib/datetime.ts (zh-CN, 24h), so dates carry no keys here.
// Amounts arrive pre-formatted via fmt(); per §4.1 the sign keeps U+2212 and
// chip counts stay bare numbers. Radar axes use short poker words (§1.4:
// 允许一点玩家黑话) : Loose/Aggressive → 松手/激进, showdown → 摊牌.
const stats: Record<string, string> = {
  // Net winnings card
  'Net winnings': '净胜筹码',
  '{n} hands played · chips': '已打 {n} 手 · 筹码',
  'Your results appear after your first hand': '打完第一手，这里就有战绩。',
  'Winnings time range': '战绩时间范围',
  'All time': '全部时间',
  'Last 30 days': '最近 30 天',
  'Last 7 days': '最近 7 天',

  // Empty states (period-filtered vs no history at all)
  'No hands in this period': '这段时间没有牌局',
  'Your next poker night starts here': '下一个牌局夜从这里开始',
  'Choose a longer period to see your results.': '选个更长的时间段，就能看到战绩。',
  'Create or join a table to start your history.': '开一桌或加入一张桌，记录从这里开始。',

  // Tooltip / legend / data table
  '{n} chips': '{n} 筹码',
  'Cumulative chips': '筹码累计',
  'View chart data': '查看图表数据',
  'Net winnings over time': '净胜筹码随时间变化',
  Date: '日期',
  'Net chips': '净胜筹码',

  // Style radar axes (0-100 normalized)
  Loose: '松手',
  Aggressive: '激进',
  Pressure: '施压',
  Showdowns: '摊牌',
  Wins: '胜率',
};

export default stats;
