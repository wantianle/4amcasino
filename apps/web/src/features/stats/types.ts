/** Wire contract of handStats.ts; intentionally no server import in the web bundle. */
export interface Metric {
  hits: number;
  opportunities: number;
  pct: number | null;
  unit: 'pct' | 'ratio' | 'bb/100' | 'chips';
}
export interface MetricBucket { sample: number; stats: Record<string, Metric> }
export interface HandStats extends MetricBucket {
  userId: number;
  hidden?: false;
  metricVersion: number;
  minHands: number;
  sufficient: boolean;
  dataQuality: { exact: number; legacy: number; partial: number; total: number };
  byPosition: Record<string, MetricBucket>;
  byStreet: Record<string, { sample: number; af: Metric; afq: Metric }>;
  byIpOop: Record<'ip' | 'oop', MetricBucket>;
  trend: { ts: number; hands: number; net: number }[];
  approximations: string[];
}
export type HiddenStats = Omit<HandStats, 'hidden' | 'stats' | 'byPosition' | 'byStreet' | 'byIpOop' | 'trend'> & {
  hidden: true; stats: null; byPosition: null; byStreet: null; byIpOop: null; trend: null;
};
export interface HudPlayer {
  userId: number; username: string; displayName: string; hidden: boolean;
  sample: number; minHands: number; sufficient: boolean;
  confidence: 'insufficient' | 'low' | 'ok';
  dataConfidence: 'exact' | 'legacy' | 'partial' | null;
  stats: Record<string, Metric> | null;
}
export interface RoomHud { roomId: string; metricVersion: number; minHands: number; players: HudPlayer[] }
export interface StatsQuery { roomId?: string; minHands?: number; limit?: number }
export function statsQuery(query: StatsQuery): string {
  return new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
}

export const METRICS = [
  ['vpip', 'VPIP'], ['pfr', 'PFR'], ['threeBet', '3bet'], ['fourBet', '4bet'],
  ['cbet', 'c-bet'], ['foldToCbet', 'Fold to c-bet'], ['af', 'AF'], ['afq', 'AFq'],
  ['wwsf', 'WWSF'], ['wsd', 'W$SD'], ['bb100', 'bb/100'], ['net', 'Net chips'],
] as const;

export function metricValue(metric?: Metric): string {
  if (!metric || metric.opportunities === 0) return '—';
  const value = metric.unit === 'chips' ? metric.hits : metric.pct;
  if (value === null) return '—';
  return `${Number(value.toFixed(2))}${metric.unit === 'pct' ? '%' : ''}`;
}
