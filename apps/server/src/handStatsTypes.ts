/**
 * Shared declarations for the hand-stat query layer (spec
 * `docs/plans/hand-stats-spec.md`, P2).
 *
 * Pure types plus the primitive definition constants every other handStats
 * module agrees on (metric version, sample gates, approximations, position
 * ring, hand limits). No runtime imports, so this is the root of the
 * intra-module dependency graph and can never participate in a cycle.
 */

export const METRIC_VERSION = 2;

/** HUD sample gates (spec §6): below `minHands` the sample is unusable, below
 *  {@link HUD_LOW_CONFIDENCE} it is returned but flagged low-confidence. These
 *  are fixed: a caller cannot lower the floor with a query parameter. */
export const HUD_MIN_SAMPLE = 20;
export const HUD_LOW_CONFIDENCE = 50;

/** 小冰 / 大冰 / 小火 / 大火. `null` is the neutral band (or too small a sample). */
export type StreakTier = 'cold1' | 'cold2' | 'hot1' | 'hot2';

export interface StreakResult {
  tier: StreakTier | null;
  /** TRUE net win of the window, in big blinds: the sum of each hand's
   *  `poker_delta / that hand's OWN bb`. Never truncated, so a big pot counts
   *  in full; this drives both the shown number and the `tier`. Eligible hands
   *  only (same `bb > 0` set as `sample`). */
  realNetBB: number;
  /** Eligible hands (known positive nominal bb) actually inside the window. */
  sample: number;
}

export const DEFAULT_HAND_LIMIT = 5000;
export const MAX_HAND_LIMIT = 100_000;

export type GameKind = 'normal' | 'bomb_pot';
export type IpOop = 'ip' | 'oop';
export type Street = 'preflop' | 'flop' | 'turn' | 'river';

export interface StatsFilter {
  from?: number;
  to?: number;
  roomId?: string;
  gameKind?: GameKind;
  position?: string;
  street?: Street;
  ipOop?: IpOop;
  /** Restrict to hands shared with this opponent (both dealt in). */
  opponentId?: number;
  /** HUD-only: select a single roster player. Ignored by computeHandStats. */
  playerId?: number;
  minHands?: number;
  /** Safety cap on the number of hands analysed (newest kept). Default 5000. */
  limit?: number;
}

/**
 * One metric. `hits` and `opportunities` are ALWAYS the raw numerator and
 * denominator. `pct` is the pre-computed value with the scale named by `unit`:
 *  - `pct`    frequency metrics, `hits/opportunities*100` (0..100), null when
 *             the denominator is zero.
 *  - `ratio`  AF/AFq, `hits/opportunities`, null when the denominator is zero.
 *  - `bb/100` `hits` is the bb total, `opportunities` the number of hands with a
 *             known positive bb (hands without a nominal bb are skipped), and
 *             `pct` bb per 100 hands (null with no eligible hands).
 *  - `chips`  `hits` is the chip total (net); `pct` is null - a sum, not a ratio.
 */
export interface Metric {
  hits: number;
  opportunities: number;
  pct: number | null;
  unit: 'pct' | 'ratio' | 'bb/100' | 'chips';
}

export interface DataQuality {
  exact: number;
  legacy: number;
  partial: number;
  total: number;
}

export interface MetricBucket {
  sample: number;
  stats: Record<string, Metric>;
}

export interface StatsResult {
  metricVersion: number;
  sample: number;
  minHands: number;
  sufficient: boolean;
  dataQuality: DataQuality;
  stats: Record<string, Metric>;
  byPosition: Record<string, MetricBucket>;
  byStreet: Record<string, { sample: number; af: Metric; afq: Metric }>;
  byIpOop: Record<IpOop, MetricBucket>;
  trend: { ts: number; hands: number; net: number }[];
  /** Hot/cold badge over the newest {@link STREAK_WINDOW} hands. */
  streak: StreakResult;
  approximations: string[];
}

/** The shape returned instead of real stats when they are withheld (private
 *  mode / HUD below the sample floor). Same keys as {@link StatsResult}, with
 *  `stats`/breakdowns/`trend` explicitly null so a client never mistakes an
 *  absent value for a zero. */
export interface RedactedStats {
  userId: number;
  hidden: true;
  metricVersion: number;
  sample: 0;
  minHands: number;
  sufficient: false;
  dataQuality: DataQuality;
  stats: null;
  byPosition: null;
  byStreet: null;
  byIpOop: null;
  trend: null;
  streak: null;
  approximations: string[];
}

export const STATS_APPROXIMATIONS: string[] = [
  'byIpOop uses the table-wide postflop action order, not a strict pairwise action order',
  'cbet opportunities infer "not all-in" from having a flop action (the projection has no all-in flag)',
  'bb/100 only counts hands with a known positive nominal bb',
];

export interface BaseRow {
  handId: string;
  roomId: string;
  gameKind: string;
  bb: number | null;
  settledAt: number | null;
  seat: number;
  userId: number;
  position: string | null;
  positionIndex: number | null;
  preflopOrder: number | null;
  postflopOrder: number | null;
  blindRole: string;
  nominalBlind: number;
  forcedPost: number;
  invested: number;
  pokerAward: number;
  pokerDelta: number;
  squidDelta: number;
  netDelta: number;
  folded: number;
  foldStreet: string | null;
  sawFlop: number;
  wentToShowdown: number;
  wonPoker: number;
  dataConfidence: string;
  playerCount: number;
  /** 1 when the hand belongs to the general stats target set. */
  inStats: number;
  /** 1 when the hand belongs to the streak (newest-50) target set. */
  inStreak: number;
}

export interface PlayerLite {
  handId: string;
  seat: number;
  userId: number;
  position: string | null;
  postflopOrder: number | null;
  foldStreet: string | null;
  sawFlop: number;
}

export interface ActionLite {
  handId: string;
  actionNo: number;
  userId: number | null;
  street: string;
  actionType: string;
  amountAdded: number;
  isForced: number;
}

export interface HandFacts {
  handId: string;
  ts: number;
  bomb: boolean;
  pokerDelta: number;
  bb: number;
  position: string;
  ipOop: IpOop | null;
  preflopOpp: boolean;
  vpip: boolean;
  pfr: boolean;
  threeBetOpp: boolean;
  threeBetHit: boolean;
  fourBetOpp: boolean;
  fourBetHit: boolean;
  cbetOpp: boolean;
  cbetHit: boolean;
  foldToCbetOpp: boolean;
  foldToCbetHit: boolean;
  wwsfOpp: boolean;
  wwsfHit: boolean;
  wsdOpp: boolean;
  wsdHit: boolean;
  agg: { street: Street; bets: number; calls: number; folds: number }[];
}

/** Position buckets, in the spec §5 ring order. */
export const POSITION_VALUES = [
  'BTN',
  'SB',
  'BB',
  'UTG',
  'UTG+1',
  'MP',
  'LJ',
  'HJ',
  'CO',
] as const;
