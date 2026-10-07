import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from './db.js';
import { requireUser } from './auth.js';
import { getRoom, isMember, presentablePlayers } from './rooms.js';
import { VOIDED_HAND_EXCLUSION_SQL } from './handProjection.js';

/**
 * Hand-stat query layer (spec `docs/plans/hand-stats-spec.md`, P2).
 *
 * Everything here is computed FROM THE PROJECTION TABLES (`hands` /
 * `hand_players` / `hand_actions`) - the transcripts stay the immutable audit
 * source. Three rules are non-negotiable and shape every query:
 *
 *  1. A hand counts only when it is a confirmed settlement:
 *     `hands.status = 'settled'`, a `hand_settlements` marker exists, the room
 *     is live (not voided / archived / deleted), and there is no `void-hand`
 *     ledger row. A real-time void leaves a stale `settled` projection until the
 *     next backfill, so plain `status='settled'` is not enough:
 *     {@link VOIDED_HAND_EXCLUSION_SQL} is always ANDed in.
 *  2. The analysed set is the NEWEST `limit` hands (`settled_at DESC`), and the
 *     context load (other players' rows / actions) reuses that exact set so it
 *     can never widen back to the room's full history.
 *  3. Ratios are returned as `{hits, opportunities, pct}`, never as a bare
 *     percentage, so a caller can see the denominator and refuse to trust a
 *     100% built on one hand.
 *
 * Money semantics: poker and squid are separate ledgers. Every money figure
 * here (`net`, `bb100`) is `poker_delta` only; squid never contaminates the
 * poker stats. `purchase` / `revert` never enter these tables at all.
 *
 * Documented approximations (also returned in `approximations`) are in the
 * metric implementations below.
 */

export const METRIC_VERSION = 2;

/** HUD sample gates (spec §6): below `minHands` the sample is unusable, below
 *  {@link HUD_LOW_CONFIDENCE} it is returned but flagged low-confidence. These
 *  are fixed: a caller cannot lower the floor with a query parameter. */
export const HUD_MIN_SAMPLE = 20;
export const HUD_LOW_CONFIDENCE = 50;

// ---------------------------------------------------------------------------
// Hot/cold "streak" badge (热/冷徽标)
//
// Calibration (real projected data + bootstrap): a single hand's poker
// result expressed in big blinds is winsorized to +/-{@link STREAK_WINSOR_BB}bb,
// which leaves a per-hand sigma of ~8.2bb. A {STREAK_WINDOW}-hand sum therefore
// has sigma_50 ~= 54bb, so the two symmetric bands below are fixed multiples of
// that noise floor:
//   small  = 0.55 * sigma_50 ~= 30bb
//   large  = 1.55 * sigma_50 ~= 85bb
// The neutral band (|net| < small) is ~40% of the distribution and shows no
// badge. These are fixed constants, not query parameters. If the window or the
// per-hand model changes (more hands -> smaller sigma_50), refit the two
// multipliers rather than re-tuning the raw bb values.
// ---------------------------------------------------------------------------

/** Number of newest target hands the streak looks at. */
export const STREAK_WINDOW = 50;
/** Per-hand winsorization of `poker_delta / bb`, in bb. */
export const STREAK_WINSOR_BB = 15;
/** Minimum eligible hands before a badge is shown at all. */
export const STREAK_MIN_SAMPLE = 20;
/** Small band edge, ~0.55 * sigma_50. Inside it the badge is neutral (null). */
export const STREAK_SMALL_BB = 30;
/** Large band edge, ~1.55 * sigma_50. */
export const STREAK_LARGE_BB = 85;

/** 小冰 / 大冰 / 小火 / 大火. `null` is the neutral band (or too small a sample). */
export type StreakTier = 'cold1' | 'cold2' | 'hot1' | 'hot2';

export interface StreakResult {
  tier: StreakTier | null;
  /** Winsorized sum of the window's `poker_delta / bb`, in big blinds. This is
   *  the HOT/COLD score only (each hand is capped to +/-{@link STREAK_WINSOR_BB}bb
   *  so one cooler cannot dominate); it is NOT the true net win and must never be
   *  presented to a user as one. */
  netBB: number;
  /** TRUE (unwinsorized) sum of the window's `poker_delta / bb`, in big blinds.
   *  Each hand is divided by its OWN big blind, so a mix of stakes aggregates
   *  correctly. Eligible hands only (same `bb > 0` set as `netBB`/`sample`). */
  realNetBB: number;
  /** Eligible hands (known positive nominal bb) actually inside the window. */
  sample: number;
}

const DEFAULT_HAND_LIMIT = 5000;
const MAX_HAND_LIMIT = 100_000;
const TREND_MAX_POINTS = 200;
const CONTEXT_CHUNK = 900;

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

interface BaseRow {
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

interface PlayerLite {
  handId: string;
  seat: number;
  userId: number;
  position: string | null;
  postflopOrder: number | null;
  foldStreet: string | null;
  sawFlop: number;
}

interface ActionLite {
  handId: string;
  actionNo: number;
  userId: number | null;
  street: string;
  actionType: string;
  amountAdded: number;
  isForced: number;
}

interface HandContext {
  playersByHand: Map<string, PlayerLite[]>;
  actionsByHand: Map<string, ActionLite[]>;
}

const STREET_ORDER: Record<string, number> = { preflop: 0, flop: 1, turn: 2, river: 3 };
const RAISE_TYPES = new Set(['bet', 'raise']);
const VOLUNTARY_AGGRESSIVE_TYPES = new Set(['call', 'bet', 'raise']);

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

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function ratio(hits: number, opportunities: number, unit: Metric['unit']): Metric {
  if (opportunities <= 0) return { hits, opportunities, pct: null, unit };
  const raw = hits / opportunities;
  const pct = unit === 'pct' ? round2(raw * 100) : round4(raw);
  return { hits, opportunities, pct, unit };
}

/**
 * HU has no dedicated SB seat label: the button posts the small blind, so the
 * spec (§4/§5) says BTN == SB heads-up. Bucket it as SB so a HUD split does not
 * pretend heads-up buttons are a separate position. The SQL predicate below
 * uses the same expression, so filtering and output agree.
 */
const POSITION_BUCKET_SQL = `(CASE WHEN (SELECT COUNT(*) FROM hand_players pc WHERE pc.hand_id = hands.hand_id) = 2 AND p.position = 'BTN'
  THEN 'SB' ELSE COALESCE(p.position, 'UNKNOWN') END)`;

interface HandFacts {
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

function isRaise(a: ActionLite): boolean {
  return RAISE_TYPES.has(a.actionType);
}

/** IP/OOP for a target who saw the flop: the last-to-act (largest
 *  `postflop_order`) among the players still in at the flop is in position.
 *  Only counted when at least two players reached the flop, because a
 *  single live player has no pairwise position. Approximation: table-wide
 *  order, not a strict pairwise action order. */
function flopPosition(target: BaseRow, players: PlayerLite[]): IpOop | null {
  if (!target.sawFlop) return null;
  const active = players.filter(
    (p) => p.foldStreet === null || (STREET_ORDER[p.foldStreet] ?? 0) >= STREET_ORDER.flop!,
  );
  if (active.length < 2) return null;
  let max = -Infinity;
  for (const p of active) max = Math.max(max, p.postflopOrder ?? -1);
  return (target.postflopOrder ?? -1) >= max && max >= 0 ? 'ip' : 'oop';
}

function handFacts(target: BaseRow, players: PlayerLite[], actions: ActionLite[]): HandFacts {
  const bomb = target.gameKind === 'bomb_pot';
  const preVoluntary = actions.filter((a) => a.street === 'preflop' && a.isForced === 0);
  const minePre = preVoluntary.filter((a) => a.userId === target.userId);
  const mineAll = actions.filter((a) => a.userId === target.userId && a.isForced === 0);

  const preflopOpp = !bomb && minePre.length > 0;
  const vpip = minePre.some((a) => VOLUNTARY_AGGRESSIVE_TYPES.has(a.actionType));
  const pfr = minePre.some((a) => isRaise(a));

  // 3bet / 4bet: the Nth re-raise after the open. `raisesBefore` counts the
  // non-forced raises already made in the hand; acting when it is exactly 1 is a
  // 3bet spot (raise after one open), exactly 2 is a 4bet spot (raise after
  // open + 3bet). Hands where the target never faced such a spot are not
  // opportunities and must not inflate the denominator.
  let threeBetOpp = false;
  let threeBetHit = false;
  let fourBetOpp = false;
  let fourBetHit = false;
  let raisesBefore = 0;
  for (const a of preVoluntary) {
    if (a.userId === target.userId) {
      if (raisesBefore === 1) {
        threeBetOpp = true;
        if (isRaise(a)) threeBetHit = true;
      } else if (raisesBefore === 2) {
        fourBetOpp = true;
        if (isRaise(a)) fourBetHit = true;
      }
    }
    if (isRaise(a)) raisesBefore++;
  }

  const flop = actions.filter((a) => a.street === 'flop');
  let lastAggressor: number | null = null;
  for (const a of preVoluntary) if (isRaise(a)) lastAggressor = a.userId;

  // A c-bet is the preflop aggressor's continuation bet: the FIRST bet/raise on
  // the flop must come from the last preflop aggressor. A donk bet by anyone
  // else is not a c-bet, and it turns the aggressor's later bet into a raise
  // over a bet, not a continuation bet.
  const firstFlopAgg = flop.find((a) => isRaise(a));
  const cbetAction =
    firstFlopAgg && lastAggressor !== null && firstFlopAgg.userId === lastAggressor
      ? firstFlopAgg
      : undefined;

  // C-bet for the target: the target is the aggressor, reached the flop able to
  // act (a flop action exists - an all-in player has none), and made that first
  // flop bet.
  let cbetOpp = false;
  let cbetHit = false;
  if (!bomb && lastAggressor !== null && lastAggressor === target.userId) {
    const first = flop.find((a) => a.userId === target.userId);
    const betBefore = first
      ? flop.some((a) => a.actionNo < first.actionNo && isRaise(a))
      : false;
    // Only a player who reaches their flop turn without a bet in front and does
    // not fold has a c-bet opportunity: folding to a donk is not one.
    const canCbet =
      !!first &&
      !betBefore &&
      first.actionType !== 'fold' &&
      first.actionType !== 'timeout_fold';
    if (canCbet && first) {
      cbetOpp = true;
      if (isRaise(first)) cbetHit = true;
    }
  }

  // Fold to c-bet: only a c-bet (by the preflop aggressor, as defined above)
  // counts as the bet being folded to. The target faces it when they still owe a
  // response after the c-bet. Leading checks do not use up the response: the
  // first NON-check action after the c-bet decides - a fold is a hit, a
  // call/bet/raise is not. This covers both check-then-fold lines.
  let foldToCbetOpp = false;
  let foldToCbetHit = false;
  if (!bomb && cbetAction && cbetAction.userId !== target.userId) {
    const responses = flop.filter(
      (a) => a.userId === target.userId && a.actionNo > cbetAction.actionNo,
    );
    if (responses.length > 0) {
      foldToCbetOpp = true;
      for (const a of responses) {
        if (a.actionType === 'check') continue;
        if (a.actionType === 'fold' || a.actionType === 'timeout_fold') foldToCbetHit = true;
        break;
      }
    }
  }

  const sawFlop = target.sawFlop === 1;
  const wwsfOpp = sawFlop;
  const wwsfHit = sawFlop && target.pokerAward > 0;
  const wsdOpp = target.wentToShowdown === 1;
  const wsdHit = wsdOpp && target.pokerAward > 0;

  // Aggression: voluntary bet/raise vs call vs fold, grouped by street.
  const aggMap = new Map<Street, { street: Street; bets: number; calls: number; folds: number }>();
  for (const a of mineAll) {
    const s = (STREET_ORDER[a.street] !== undefined ? a.street : 'preflop') as Street;
    let e = aggMap.get(s);
    if (!e) {
      e = { street: s, bets: 0, calls: 0, folds: 0 };
      aggMap.set(s, e);
    }
    if (RAISE_TYPES.has(a.actionType)) e.bets++;
    else if (a.actionType === 'call') e.calls++;
    else if (a.actionType === 'fold' || a.actionType === 'timeout_fold') e.folds++;
  }

  return {
    handId: target.handId,
    ts: target.settledAt ?? 0,
    bomb,
    pokerDelta: target.pokerDelta,
    bb: target.bb ?? 0,
    position: positionBucketFrom(target),
    ipOop: flopPosition(target, players),
    preflopOpp,
    vpip,
    pfr,
    threeBetOpp,
    threeBetHit,
    fourBetOpp,
    fourBetHit,
    cbetOpp,
    cbetHit,
    foldToCbetOpp,
    foldToCbetHit,
    wwsfOpp,
    wwsfHit,
    wsdOpp,
    wsdHit,
    agg: [...aggMap.values()],
  };
}

/** Mirror of {@link POSITION_BUCKET_SQL} in JS. */
function positionBucketFrom(row: Pick<BaseRow, 'position' | 'playerCount'>): string {
  if (row.playerCount === 2 && row.position === 'BTN') return 'SB';
  return row.position ?? 'UNKNOWN';
}

/** Aggregate a set of per-hand facts into the metric bundle. */
function metricsFor(facts: HandFacts[]): Record<string, Metric> {
  const sample = facts.length;
  let preflopOpp = 0;
  let vpipHits = 0;
  let pfrHits = 0;
  let threeBetOpp = 0;
  let threeBetHit = 0;
  let fourBetOpp = 0;
  let fourBetHit = 0;
  let cbetOpp = 0;
  let cbetHit = 0;
  let foldToCbetOpp = 0;
  let foldToCbetHit = 0;
  let wwsfOpp = 0;
  let wwsfHit = 0;
  let wsdOpp = 0;
  let wsdHit = 0;
  let bets = 0;
  let calls = 0;
  let folds = 0;
  let bbEligible = 0;
  let bbWon = 0;
  let pokerNet = 0;
  for (const f of facts) {
    if (f.preflopOpp) preflopOpp++;
    if (f.preflopOpp && f.vpip) vpipHits++;
    if (f.preflopOpp && f.pfr) pfrHits++;
    if (f.threeBetOpp) threeBetOpp++;
    if (f.threeBetOpp && f.threeBetHit) threeBetHit++;
    if (f.fourBetOpp) fourBetOpp++;
    if (f.fourBetOpp && f.fourBetHit) fourBetHit++;
    if (f.cbetOpp) cbetOpp++;
    if (f.cbetOpp && f.cbetHit) cbetHit++;
    if (f.foldToCbetOpp) foldToCbetOpp++;
    if (f.foldToCbetOpp && f.foldToCbetHit) foldToCbetHit++;
    if (f.wwsfOpp) wwsfOpp++;
    if (f.wwsfHit) wwsfHit++;
    if (f.wsdOpp) wsdOpp++;
    if (f.wsdHit) wsdHit++;
    for (const a of f.agg) {
      bets += a.bets;
      calls += a.calls;
      folds += a.folds;
    }
    // Skip a hand with no known nominal bb rather than pretending it moved 0 bb.
    if (f.bb > 0) {
      bbEligible++;
      bbWon += f.pokerDelta / f.bb;
    }
    pokerNet += f.pokerDelta;
  }
  const bbTotal = bbWon * 100;
  const stats: Record<string, Metric> = {
    hands: ratio(sample, sample, 'pct'),
    net: { hits: pokerNet, opportunities: sample, pct: null, unit: 'chips' },
    vpip: ratio(vpipHits, preflopOpp, 'pct'),
    pfr: ratio(pfrHits, preflopOpp, 'pct'),
    threeBet: ratio(threeBetHit, threeBetOpp, 'pct'),
    fourBet: ratio(fourBetHit, fourBetOpp, 'pct'),
    cbet: ratio(cbetHit, cbetOpp, 'pct'),
    foldToCbet: ratio(foldToCbetHit, foldToCbetOpp, 'pct'),
    af: ratio(bets, calls, 'ratio'),
    afq: ratio(bets, bets + calls + folds, 'ratio'),
    wwsf: ratio(wwsfHit, wwsfOpp, 'pct'),
    wsd: ratio(wsdHit, wsdOpp, 'pct'),
    bb100: ratio(bbTotal, bbEligible, 'bb/100'),
  };
  return stats;
}

function aggregateByKey(
  facts: HandFacts[],
  keyOf: (f: HandFacts) => string | null,
): Record<string, MetricBucket> {
  const groups = new Map<string, HandFacts[]>();
  for (const f of facts) {
    const k = keyOf(f);
    if (k === null) continue;
    const arr = groups.get(k);
    if (arr) arr.push(f);
    else groups.set(k, [f]);
  }
  const out: Record<string, MetricBucket> = {};
  const order = (k: string) => {
    const i = POSITION_VALUES.indexOf(k as (typeof POSITION_VALUES)[number]);
    return i < 0 ? POSITION_VALUES.length : i;
  };
  for (const k of [...groups.keys()].sort((a, b) => order(a) - order(b) || a.localeCompare(b))) {
    const arr = groups.get(k)!;
    out[k] = { sample: arr.length, stats: metricsFor(arr) };
  }
  return out;
}

function byStreetFor(facts: HandFacts[]): StatsResult['byStreet'] {
  const groups = new Map<Street, { bets: number; calls: number; folds: number; hands: Set<string> }>();
  for (const f of facts) {
    for (const a of f.agg) {
      let g = groups.get(a.street);
      if (!g) {
        g = { bets: 0, calls: 0, folds: 0, hands: new Set() };
        groups.set(a.street, g);
      }
      g.bets += a.bets;
      g.calls += a.calls;
      g.folds += a.folds;
      g.hands.add(f.handId);
    }
  }
  const out: StatsResult['byStreet'] = {};
  for (const street of ['preflop', 'flop', 'turn', 'river'] as Street[]) {
    const g = groups.get(street);
    if (!g) continue;
    out[street] = {
      sample: g.hands.size,
      af: ratio(g.bets, g.calls, 'ratio'),
      afq: ratio(g.bets, g.bets + g.calls + g.folds, 'ratio'),
    };
  }
  return out;
}

function trendFor(rows: BaseRow[], factsByHand: Map<string, HandFacts>): StatsResult['trend'] {
  const sorted = [...rows].sort(
    (a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0) || a.handId.localeCompare(b.handId),
  );
  const points: { ts: number; hands: number; net: number }[] = [];
  let net = 0;
  let hands = 0;
  for (const r of sorted) {
    net += factsByHand.get(r.handId)?.pokerDelta ?? 0;
    hands++;
    points.push({ ts: r.settledAt ?? 0, hands, net });
  }
  if (points.length <= TREND_MAX_POINTS) return points;
  const out: typeof points = [];
  const step = points.length / (TREND_MAX_POINTS - 1);
  for (let i = 0; i < TREND_MAX_POINTS - 1; i++) out.push(points[Math.floor(i * step)]!);
  out.push(points[points.length - 1]!);
  return out;
}

/** Map a winsorized net to one of the four badge tiers; neutral or a sample
 *  below {@link STREAK_MIN_SAMPLE} is `null`. Edges are inclusive, so exactly
 *  +30bb is 小火 and exactly +85bb is 大火. */
export function streakTier(netBB: number, sample: number): StreakTier | null {
  if (sample < STREAK_MIN_SAMPLE) return null;
  if (netBB >= STREAK_LARGE_BB) return 'hot2';
  if (netBB >= STREAK_SMALL_BB) return 'hot1';
  if (netBB <= -STREAK_LARGE_BB) return 'cold2';
  if (netBB <= -STREAK_SMALL_BB) return 'cold1';
  return null;
}

/**
 * Hot/cold streak over the newest {@link STREAK_WINDOW} facts. Each hand is
 * normalised by ITS OWN big blind (`poker_delta / bb`) and winsorized to
 * +/-{@link STREAK_WINSOR_BB}bb so a single cooler cannot dominate a 50-hand
 * sum. Hands without a known positive nominal bb cannot be normalised and are
 * skipped from both the sum and the sample.
 *
 * Two outputs share the SAME eligible-hand window and the SAME per-hand
 * `poker_delta / bb` normalisation:
 *   - `netBB`: the winsorized HOT/COLD score (drives `tier`), and
 *   - `realNetBB`: the true, uncapped net win in big blinds for display.
 * Never swap them: a +900bb hand contributes only +15 to `netBB` but its full
 * +900 to `realNetBB` (see STREAK_WINSOR_BB). Dividing by a single shared bb
 * would misprice a window whose hands have different blinds, so the per-hand
 * divisor is load-bearing.
 *
 * The caller hands over the ALREADY-WINDOWED streak facts: the SQL target set
 * applies `ORDER BY settled_at DESC, hand_id DESC LIMIT 50` (binary collation,
 * the same order as the outer fetch), so this function neither re-sorts nor
 * re-slices. That keeps SQLite and JS from disagreeing on a tie at the 50-hand
 * boundary and makes the 50-hand bound verifiable in the query itself.
 */
export function streakFor(facts: HandFacts[]): StreakResult {
  let net = 0;
  let real = 0;
  let sample = 0;
  for (const f of facts) {
    if (f.bb <= 0) continue;
    sample++;
    const raw = f.pokerDelta / f.bb;
    real += raw;
    net += Math.max(-STREAK_WINSOR_BB, Math.min(STREAK_WINSOR_BB, raw));
  }
  const netBB = round2(net);
  return { tier: streakTier(netBB, sample), netBB, realNetBB: round2(real), sample };
}

function dataQualityFor(rows: BaseRow[]): DataQuality {
  const q: DataQuality = { exact: 0, legacy: 0, partial: 0, total: rows.length };
  for (const r of rows) {
    if (r.dataConfidence === 'exact') q.exact++;
    else if (r.dataConfidence === 'legacy') q.legacy++;
    else q.partial++;
  }
  return q;
}

const BASE_SELECT = `
  SELECT hands.hand_id AS handId,
         hands.room_id AS roomId,
         hands.game_kind AS gameKind,
         hands.bb AS bb,
         hands.settled_at AS settledAt,
         p.seat AS seat,
         p.user_id AS userId,
         p.position AS position,
         p.position_index AS positionIndex,
         p.preflop_order AS preflopOrder,
         p.postflop_order AS postflopOrder,
         p.blind_role AS blindRole,
         p.nominal_blind AS nominalBlind,
         p.forced_post AS forcedPost,
         p.invested AS invested,
         p.poker_award AS pokerAward,
         p.poker_delta AS pokerDelta,
         p.squid_delta AS squidDelta,
         p.net_delta AS netDelta,
         p.folded AS folded,
         p.fold_street AS foldStreet,
         p.saw_flop AS sawFlop,
         p.went_to_showdown AS wentToShowdown,
         p.won_poker AS wonPoker,
         p.data_confidence AS dataConfidence,
         (SELECT COUNT(*) FROM hand_players pc WHERE pc.hand_id = hands.hand_id) AS playerCount
    FROM hand_players p
    JOIN hands ON hands.hand_id = p.hand_id`;

/**
 * The shared target-hand predicate. `hands` MUST be the alias so the imported
 * {@link VOIDED_HAND_EXCLUSION_SQL} fragment resolves unchanged.
 */
function scopeWhere(filter: StatsFilter): { sql: string; params: Record<string, unknown> } {
  const conds = [
    'p.user_id = @userId',
    "hands.status = 'settled'",
    'EXISTS (SELECT 1 FROM hand_settlements hs WHERE hs.hand_id = hands.hand_id)',
    'EXISTS (SELECT 1 FROM rooms r WHERE r.id = hands.room_id AND r.voided = 0 AND r.archived = 0 AND r.deleted = 0)',
    VOIDED_HAND_EXCLUSION_SQL,
  ];
  const params: Record<string, unknown> = {};
  if (filter.roomId !== undefined) {
    conds.push('hands.room_id = @roomId');
    params.roomId = filter.roomId;
  }
  if (filter.gameKind !== undefined) {
    conds.push('hands.game_kind = @gameKind');
    params.gameKind = filter.gameKind;
  }
  if (filter.from !== undefined) {
    conds.push('hands.settled_at >= @from');
    params.from = filter.from;
  }
  if (filter.to !== undefined) {
    conds.push('hands.settled_at <= @to');
    params.to = filter.to;
  }
  if (filter.position !== undefined) {
    // Compare on the same bucket the output uses, so a HU button matches SB and
    // never leaks into a BTN filter.
    conds.push(`${POSITION_BUCKET_SQL} = @position`);
    params.position = filter.position;
  }
  if (filter.opponentId !== undefined) {
    conds.push(
      'EXISTS (SELECT 1 FROM hand_players opp WHERE opp.hand_id = hands.hand_id AND opp.user_id = @opponentId)',
    );
    params.opponentId = filter.opponentId;
  }
  if (filter.street !== undefined) {
    conds.push(
      'EXISTS (SELECT 1 FROM hand_actions sa WHERE sa.hand_id = hands.hand_id AND sa.user_id = @userId AND sa.street = @street AND sa.is_forced = 0)',
    );
    params.street = filter.street;
  }
  return { sql: conds.join(' AND '), params };
}

/** The newest target hands. `limitExpr` defaults to the `@limit` bind used by
 *  the general stats window; the streak window passes the literal
 *  {@link STREAK_WINDOW} so its 50-hand bound is enforced in SQL, not in JS.
 *  Both windows share this fragment so their scope (void / settlement / room)
 *  can never diverge. */
function scopeHandsSql(whereSql: string, limitExpr = '@limit'): string {
  return `SELECT hands.hand_id AS hand_id
            FROM hand_players p
            JOIN hands ON hands.hand_id = p.hand_id
           WHERE ${whereSql}
           ORDER BY hands.settled_at DESC, hands.hand_id DESC
           LIMIT ${limitExpr}`;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Load every player and action for the given hand ids, in chunks so a large
 *  scope never trips SQLite's variable limit. */
function loadContext(db: DB, handIds: string[]): HandContext {
  const playersByHand = new Map<string, PlayerLite[]>();
  const actionsByHand = new Map<string, ActionLite[]>();
  for (const part of chunk(handIds, CONTEXT_CHUNK)) {
    const ph = part.map(() => '?').join(',');
    const players = db
      .prepare(
        `SELECT hp.hand_id AS handId, hp.seat AS seat, hp.user_id AS userId, hp.position AS position,
                hp.postflop_order AS postflopOrder, hp.fold_street AS foldStreet, hp.saw_flop AS sawFlop
           FROM hand_players hp WHERE hp.hand_id IN (${ph})`,
      )
      .all(...part) as PlayerLite[];
    for (const p of players) {
      const arr = playersByHand.get(p.handId);
      if (arr) arr.push(p);
      else playersByHand.set(p.handId, [p]);
    }
    const actions = db
      .prepare(
        `SELECT ha.hand_id AS handId, ha.action_no AS actionNo, ha.user_id AS userId, ha.street AS street,
                ha.action_type AS actionType, ha.amount_added AS amountAdded, ha.is_forced AS isForced
           FROM hand_actions ha WHERE ha.hand_id IN (${ph})
          ORDER BY ha.hand_id, ha.action_no`,
      )
      .all(...part) as ActionLite[];
    for (const a of actions) {
      const arr = actionsByHand.get(a.handId);
      if (arr) arr.push(a);
      else actionsByHand.set(a.handId, [a]);
    }
  }
  return { playersByHand, actionsByHand };
}

function buildResult(
  rows: BaseRow[],
  ctx: HandContext,
  filter: StatsFilter,
  minHands: number,
): StatsResult {
  let facts = rows.map((r) =>
    handFacts(r, ctx.playersByHand.get(r.handId) ?? [], ctx.actionsByHand.get(r.handId) ?? []),
  );
  if (filter.ipOop !== undefined) facts = facts.filter((f) => f.ipOop === filter.ipOop);

  // The row fetch returns the UNION of two SQL target sets: the general stats
  // window and the streak window (a 50-hand bound enforced in SQL). Split them
  // back apart so widening the streak window can never inflate the sample, and
  // a small `limit` can never shrink the streak window.
  const statsIds = new Set(rows.filter((r) => r.inStats === 1).map((r) => r.handId));
  const streakIds = new Set(rows.filter((r) => r.inStreak === 1).map((r) => r.handId));
  const statsFacts = facts.filter((f) => statsIds.has(f.handId));
  const streakFacts = facts.filter((f) => streakIds.has(f.handId));

  const keptIds = new Set(statsFacts.map((f) => f.handId));
  const keptRows = rows.filter((r) => keptIds.has(r.handId));
  const factsByHand = new Map(statsFacts.map((f) => [f.handId, f]));
  const ipFacts = statsFacts.filter((f) => f.ipOop === 'ip');
  const oopFacts = statsFacts.filter((f) => f.ipOop === 'oop');

  return {
    metricVersion: METRIC_VERSION,
    sample: statsFacts.length,
    minHands,
    sufficient: statsFacts.length >= minHands,
    dataQuality: dataQualityFor(keptRows),
    stats: metricsFor(statsFacts),
    byPosition: aggregateByKey(statsFacts, (f) => f.position),
    byStreet: byStreetFor(statsFacts),
    byIpOop: {
      ip: { sample: ipFacts.length, stats: metricsFor(ipFacts) },
      oop: { sample: oopFacts.length, stats: metricsFor(oopFacts) },
    },
    trend: trendFor(keptRows, factsByHand),
    streak: streakFor(streakFacts),
    approximations: STATS_APPROXIMATIONS,
  };
}

function clampLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(limit ?? DEFAULT_HAND_LIMIT, MAX_HAND_LIMIT));
}

/**
 * Compute stats for several users at once, loading the hand context ONCE for
 * the union of their scoped hands. The HUD uses this so a full roster does not
 * repeat the same context scan per player.
 */
export function computeHandStatsMany(
  db: DB,
  userIds: number[],
  filter: StatsFilter = {},
): Map<number, StatsResult> {
  const limit = clampLimit(filter.limit);
  const minHands = filter.minHands ?? 0;
  const where = scopeWhere(filter);
  // Two target sets over the SAME scope, fetched in one per-user query:
  //  - stats:  the newest `@limit` hands (current behaviour),
  //  - streak: the newest STREAK_WINDOW hands, bounded in SQL by a literal
  //            LIMIT so no more than 50 are ever pulled for the badge.
  // `in_stats`/`in_streak` markers let buildResult() split them without a
  // second per-player scan and without letting a small `limit` shrink the badge.
  const statsScope = scopeHandsSql(where.sql);
  const streakScope = scopeHandsSql(where.sql, String(STREAK_WINDOW));
  const scopeUnion = `SELECT hand_id, MAX(in_stats) AS in_stats, MAX(in_streak) AS in_streak
    FROM (
      SELECT hand_id, 1 AS in_stats, 0 AS in_streak FROM (${statsScope})
      UNION ALL
      SELECT hand_id, 0 AS in_stats, 1 AS in_streak FROM (${streakScope})
    ) GROUP BY hand_id`;
  const rowsByUser = new Map<number, BaseRow[]>();
  const allHandIds = new Set<string>();
  for (const userId of userIds) {
    if (rowsByUser.has(userId)) continue;
    const raw = db
      .prepare(
        `SELECT b.*, t.in_stats AS inStats, t.in_streak AS inStreak
           FROM (${BASE_SELECT}) b
           JOIN (${scopeUnion}) t ON t.hand_id = b.handId
          WHERE b.userId = @userId
          ORDER BY b.settledAt DESC, b.handId DESC`,
      )
      .all({ ...where.params, userId, limit }) as BaseRow[];
    const seen = new Set<string>();
    const unique = raw.filter((r) => {
      if (seen.has(r.handId)) return false;
      seen.add(r.handId);
      return true;
    });
    rowsByUser.set(userId, unique);
    for (const r of unique) allHandIds.add(r.handId);
  }
  const ctx = loadContext(db, [...allHandIds]);
  const out = new Map<number, StatsResult>();
  for (const userId of userIds) {
    out.set(userId, buildResult(rowsByUser.get(userId) ?? [], ctx, filter, minHands));
  }
  return out;
}

/** Compute the full stats bundle for one user. */
export function computeHandStats(db: DB, userId: number, filter: StatsFilter = {}): StatsResult {
  return computeHandStatsMany(db, [userId], filter).get(userId)!;
}

export function redactedStats(userId: number, minHands = 0): RedactedStats {
  return {
    userId,
    hidden: true,
    metricVersion: METRIC_VERSION,
    sample: 0,
    minHands,
    sufficient: false,
    dataQuality: { exact: 0, legacy: 0, partial: 0, total: 0 },
    stats: null,
    byPosition: null,
    byStreet: null,
    byIpOop: null,
    trend: null,
    streak: null,
    approximations: STATS_APPROXIMATIONS,
  };
}

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

const statsQuerySchema = z
  .object({
    from: z.coerce.number().int().nonnegative().optional(),
    to: z.coerce.number().int().nonnegative().optional(),
    roomId: z.string().min(1).max(64).optional(),
    gameKind: z.enum(['normal', 'bomb_pot']).optional(),
    position: z.enum(POSITION_VALUES).optional(),
    street: z.enum(['preflop', 'flop', 'turn', 'river']).optional(),
    ipOop: z.enum(['ip', 'oop']).optional(),
    opponentId: z.coerce.number().int().positive().optional(),
    playerId: z.coerce.number().int().positive().optional(),
    minHands: z.coerce.number().int().nonnegative().max(MAX_HAND_LIMIT).optional(),
    limit: z.coerce.number().int().positive().max(MAX_HAND_LIMIT).optional(),
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, {
    message: 'from must be <= to',
  });

function parseStatsQuery(raw: unknown): StatsFilter | null {
  const parsed = statsQuerySchema.safeParse(raw ?? {});
  if (!parsed.success) return null;
  const q = parsed.data;
  const filter: StatsFilter = {};
  if (q.from !== undefined) filter.from = q.from;
  if (q.to !== undefined) filter.to = q.to;
  if (q.roomId !== undefined) filter.roomId = q.roomId;
  if (q.gameKind !== undefined) filter.gameKind = q.gameKind;
  if (q.position !== undefined) filter.position = q.position;
  if (q.street !== undefined) filter.street = q.street;
  if (q.ipOop !== undefined) filter.ipOop = q.ipOop;
  if (q.opponentId !== undefined) filter.opponentId = q.opponentId;
  if (q.playerId !== undefined) filter.playerId = q.playerId;
  if (q.minHands !== undefined) filter.minHands = q.minHands;
  if (q.limit !== undefined) filter.limit = q.limit;
  return filter;
}

const userParamsSchema = z.object({ id: z.coerce.number().int().positive() });

type HudConfidence = 'insufficient' | 'low' | 'ok';

function hudConfidence(sample: number, minHands: number): HudConfidence {
  if (sample < minHands) return 'insufficient';
  if (sample < HUD_LOW_CONFIDENCE) return 'low';
  return 'ok';
}

function overallDataConfidence(q: DataQuality): 'exact' | 'legacy' | 'partial' {
  if (q.partial > 0) return 'partial';
  if (q.legacy > 0) return 'legacy';
  return 'exact';
}

interface HudBase {
  userId: number;
  username: string;
  displayName: string;
}

/**
 * One HUD roster entry. Visible and hidden entries share the exact same keys so
 * a client can render either without a shape check; every statistic on a hidden
 * entry is an explicit `null`, never a misleading zero.
 */
interface HudEntry extends HudBase {
  hidden: boolean;
  sample: number;
  minHands: number;
  sufficient: boolean;
  confidence: HudConfidence;
  dataConfidence: 'exact' | 'legacy' | 'partial' | null;
  dataQuality: DataQuality;
  stats: StatsResult['stats'] | null;
  byPosition: StatsResult['byPosition'] | null;
  byStreet: StatsResult['byStreet'] | null;
  byIpOop: StatsResult['byIpOop'] | null;
  trend: StatsResult['trend'] | null;
  /** Hot/cold badge, withheld exactly like `stats` when the sample is short. */
  streak: StreakResult | null;
  approximations: string[];
}

function hudHiddenEntry(base: HudBase, minHands: number): HudEntry {
  return {
    ...base,
    hidden: true,
    sample: 0,
    minHands,
    sufficient: false,
    confidence: 'insufficient',
    dataConfidence: null,
    dataQuality: { exact: 0, legacy: 0, partial: 0, total: 0 },
    stats: null,
    byPosition: null,
    byStreet: null,
    byIpOop: null,
    trend: null,
    streak: null,
    approximations: STATS_APPROXIMATIONS,
  };
}

/**
 * HTTP-contract gate for the hot/cold badge. Pure computation always returns a
 * non-null {@link StreakResult} (its `tier` may be `null`); whether the client
 * is allowed to see it is a display/redaction decision made HERE, at the
 * contract layer, so `StatsResult.streak` stays non-nullable and callers never
 * have to reason about a half-computed badge.
 *
 * A badge requires BOTH:
 *  - the bundle is `sufficient` for its `minHands` (and not hidden/redacted), and
 *  - at least {@link STREAK_MIN_SAMPLE} ELIGIBLE hands in the window, i.e.
 *    hands with a known positive nominal bb that can be normalised.
 *
 * So 20 settled hands containing one `bb=0` hand (stats.sample=20, eligible
 * streak.sample=19) exposes `null`, never a fake `netBB`/tier. Shared verbatim
 * by the HUD entry and both stats routes.
 */
function displayStreak(stats: StatsResult): StreakResult | null {
  return stats.sufficient && stats.streak.sample >= STREAK_MIN_SAMPLE ? stats.streak : null;
}

function hudVisibleEntry(base: HudBase, stats: StatsResult, minHands: number): HudEntry {
  const sufficient = stats.sample >= minHands;
  return {
    ...base,
    hidden: false,
    sample: stats.sample,
    minHands,
    sufficient,
    confidence: hudConfidence(stats.sample, minHands),
    dataConfidence: overallDataConfidence(stats.dataQuality),
    dataQuality: stats.dataQuality,
    stats: sufficient ? stats.stats : null,
    byPosition: sufficient ? stats.byPosition : null,
    byStreet: sufficient ? stats.byStreet : null,
    byIpOop: sufficient ? stats.byIpOop : null,
    trend: sufficient ? stats.trend : null,
    // The badge has its own ELIGIBLE-sample gate (hands with bb>0): a player
    // with enough total hands but fewer than STREAK_MIN_SAMPLE normalisable ones
    // must not show a badge at all.
    streak: displayStreak(stats),
    approximations: STATS_APPROXIMATIONS,
  };
}

export function registerHandStatsRoutes(app: FastifyInstance, db: DB): void {
  const authed = { preHandler: requireUser(db) };

  // My own stats: full breakdown, holes only ever the aggregate projection.
  // The hot/cold badge is display-gated here (eligible bb>0 sample >= 20), NOT
  // left as the raw non-null StatsResult.streak.
  app.get('/api/me/stats', authed, async (req, reply) => {
    const filter = parseStatsQuery(req.query);
    if (!filter) return reply.code(400).send({ error: 'invalid query' });
    const stats = computeHandStats(db, req.userId, filter);
    return { userId: req.userId, ...stats, streak: displayStreak(stats) };
  });

  // Someone else's stats. Private mode hides the bundle from everyone but the
  // owner (mirrors /api/users/:id/profile). The withheld response is the
  // explicit {@link RedactedStats} contract, not a half-filled stats object.
  app.get('/api/users/:id/stats', authed, async (req, reply) => {
    const params = userParamsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid user id' });
    const id = params.data.id;
    const user = db
      .prepare('SELECT id, private_mode AS privateMode FROM users WHERE id = ?')
      .get(id) as { id: number; privateMode: number } | undefined;
    if (!user) return reply.code(404).send({ error: 'no such user' });
    const filter = parseStatsQuery(req.query);
    if (!filter) return reply.code(400).send({ error: 'invalid query' });
    if (user.privateMode && req.userId !== id) return redactedStats(id, filter.minHands ?? 0);
    const stats = computeHandStats(db, id, filter);
    // Even when the bundle is visible, the hot/cold badge is owner-only here:
    // a third party reading someone's public stats does not get a fresh-form
    // read on their recent results (same stricter stance as private_mode).
    return {
      userId: id,
      hidden: false,
      ...stats,
      streak: req.userId === id ? displayStreak(stats) : null,
    };
  });

  // Room HUD: one entry per presentable player, sample-gated so a fresh seat is
  // never dressed in a fake 100%. Members only (spec §6/§10 privacy). The 20/50
  // gates are fixed - `minHands` in the query cannot lower them.
  app.get('/api/rooms/:id/hud', authed, async (req, reply) => {
    const roomId = (req.params as { id: string }).id;
    if (!getRoom(db, roomId)) return reply.code(404).send({ error: 'no such room' });
    if (!isMember(db, roomId, req.userId)) return reply.code(403).send({ error: 'not a member' });
    const filter = parseStatsQuery(req.query);
    if (!filter) return reply.code(400).send({ error: 'invalid query' });
    // The stats must describe the room in the path: a query roomId that points
    // somewhere else would pass the r1 membership check but aggregate r2.
    if (filter.roomId !== undefined && filter.roomId !== roomId)
      return reply.code(400).send({ error: 'roomId does not match the room in the path' });
    const minHands = HUD_MIN_SAMPLE;

    const roster = presentablePlayers(db, roomId).filter(
      (p) => filter.playerId === undefined || p.userId === filter.playerId,
    );
    const results = computeHandStatsMany(
      db,
      roster.map((p) => p.userId),
      { ...filter, roomId, minHands },
    );
    const players = roster.map((p) => {
      const base = { userId: p.userId, username: p.username, displayName: p.displayName };
      // private_mode hides the numbers from everyone but the owner, even inside
      // the room HUD.
      if (p.privateMode && p.userId !== req.userId) return hudHiddenEntry(base, minHands);
      return hudVisibleEntry(base, results.get(p.userId)!, minHands);
    });
    return { roomId, metricVersion: METRIC_VERSION, minHands, players };
  });
}
