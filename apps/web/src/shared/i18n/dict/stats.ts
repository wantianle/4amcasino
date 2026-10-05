// Stats dictionary (features/stats/charts.tsx: net-winnings area chart and
// play-style radar on the player page). Axis tick labels come from fmtTime /
// fmtDate in shared/lib/datetime.ts (zh-CN, 24h), so dates carry no keys here.
// Amounts arrive pre-formatted via fmt(); per §4.1 the sign keeps U+2212 and
// chip counts stay bare numbers. Radar axes use short poker words (§1.4:
// 允许一点玩家黑话) : Loose/Aggressive → 松/激进, showdown → 摊牌.
const stats: Record<string, string> = {
  'Big hot streak': '大火：手气很热',
  'Hot streak': '小火：手气热',
  'Cold streak': '小冰：手气冷',
  'Big cold streak': '大冰：手气很冷',
  'Professional mode': '专业模式',
  'Normal mode': '普通模式',
  'Hand history mode': '手牌记录模式',
  'Your room statistics': '我的本桌数据',
  'Newest 5,000 settled hands · poker only, excluding squid.': '最近 5,000 手已结算手牌 · 仅扑克收益，不含鱿鱼账本',
  'Loading statistics…': '正在加载统计…',
  'Could not load statistics.': '统计加载失败',
  'Statistics appear after a settled hand. Missing values are not zero.': '手牌结算后会显示统计。缺失数据不代表零。',
  'Low sample: {n} / {min} hands. Treat these numbers as observations, not conclusions.': '样本不足：{n} / {min} 手。当前数值仅供观察，不宜据此下结论。',
  'Low sample: {n} / {min} hands': '样本不足：{n} / {min} 手',
  'Low sample': '样本不足',
  'Low confidence': '低置信度',
  'Statistics table': '手牌指标表',
  'Statistics dimension': '统计维度',
  Overview: '总览',
  Position: '位置',
  Street: '街',
  Metric: '指标',
  'No opportunities': '无机会样本',
  'Street breakdown contains AF and AFq only.': '街维度仅提供 AF / AFq；不以全手指标冒充单街统计。',
  'Value · hits / opportunities. Each column is an independent sample.': '数值 · 命中 / 机会。每列为独立样本，横向滚动可查看全部分组。',
  'AFq is a ratio (0–1). Net is a chip sum, not a percentage. Raw numerator / denominator follow the API; bb/100 numerator is scaled by 100.': 'AFq 为比率（0–1）。净值为筹码合计，不是百分比。分子 / 分母按 API 原样显示；bb/100 分子已乘以 100。',
  'Data quality': '数据质量',
  'Calculation notes': '计算说明',
  'Metric version': '指标版本',
  'byIpOop uses the table-wide postflop action order, not a strict pairwise action order': 'IP/OOP 按全桌翻牌后行动顺序近似分组，并非严格的两两位置关系。',
  'cbet opportunities infer "not all-in" from having a flop action (the projection has no all-in flag)': 'c-bet 机会通过翻牌行动推断玩家未全下；投影数据没有全下标记。',
  'bb/100 only counts hands with a known positive nominal bb': 'bb/100 仅计入名义大盲已知且大于零的手牌。',
  'Player HUD': '玩家 HUD',
  'This room only · minimum {n} hands': '仅本桌数据 · 至少 {n} 手后显示',
  'Statistics hidden': '统计已隐藏',
  'No players yet.': '暂无玩家。',
  'Last 50 hands: {net} bb · {sample} hands': '近 50 手 {net} bb · {sample} 手',
  'Last 50 hands: unavailable': '近 50 手：暂无数据',
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
  Loose: '松',
  Aggressive: '激进',
  Pressure: '施压',
  Showdowns: '摊牌',
  Wins: '胜率',
};

export default stats;
