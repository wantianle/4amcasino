/**
 * Pure metric computation for the hand-stat query layer: per-hand fact
 * derivation, the metric-bundle aggregation and the hot/cold streak badge.
 * No database access - every function is a pure function of already-loaded
 * projection rows.
 */

import type {
  ActionLite,
  BaseRow,
  DataQuality,
  HandFacts,
  IpOop,
  Metric,
  MetricBucket,
  PlayerLite,
  StatsResult,
  Street,
  StreakResult,
  StreakTier,
} from './handStatsTypes.js';
import { POSITION_VALUES } from './handStatsTypes.js';

// ---------------------------------------------------------------------------
// Hot/cold "streak" badge (热/冷徽标)
//
// The tier is read straight off the TRUE net win over the window (`realNetBB`):
// the sum of per-hand `poker_delta / that hand's bb`, uncapped. An earlier
// design winsorized each hand to +/-15bb before scoring; that cap was SYMMETRIC
// (+/-15bb, not "wins only"), but it still meant the truncated cumulative score
// no longer represented the window's true cumulative net win - the two could
// even carry opposite signs (a genuinely winning window scored 冰块). Real net
// is what the badge must reflect - big pots included.
//
// Calibration, computed read-only on the production DB with windowing done PER
// PLAYER (each player's OWN settled hands ordered by time, rolled in 50-hand
// windows; players are never concatenated into one series, which would inflate
// the denominator with cross-player cancellations and understate sigma; n=3603
// windows): the per-player rolling 50-hand real net has sd ~= 367bb. The bands
// are deliberately set far below that noise floor:
//   small = +/-50bb  (~0.14 sigma) -> ~77.6% of windows show a badge
//   large = +/-100bb (~0.27 sigma) -> ~66.4% of windows are LARGE
// i.e. the badge lights up often and skews to the large tier; this is a
// deliberately loose, not a conservative, threshold set.
// (The retired +/-30 / +/-85 bands acted on the truncated score, whose
// per-player 50-hand sd was ~= 37bb: ~41.5% of windows showed a badge and only
// ~2.5% were large.)
// These are fixed constants, not query parameters. If the window changes, refit
// the two raw bb values.
// ---------------------------------------------------------------------------

/** Number of newest target hands the streak looks at. */
export const STREAK_WINDOW = 50;
/** Minimum eligible hands before a badge is shown at all. */
export const STREAK_MIN_SAMPLE = 20;
/** Small band edge on |realNetBB| (~0.14 sigma of the per-player 50-hand
 *  distribution, i.e. a deliberately low bar). Inside it the badge is neutral
 *  (null). */
export const STREAK_SMALL_BB = 50;
/** Large band edge on |realNetBB| (~0.27 sigma). */
export const STREAK_LARGE_BB = 100;

const TREND_MAX_POINTS = 200;

const STREET_ORDER: Record<string, number> = { preflop: 0, flop: 1, turn: 2, river: 3 };
const RAISE_TYPES = new Set(['bet', 'raise']);
const VOLUNTARY_AGGRESSIVE_TYPES = new Set(['call', 'bet', 'raise']);

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

export function handFacts(target: BaseRow, players: PlayerLite[], actions: ActionLite[]): HandFacts {
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
export function metricsFor(facts: HandFacts[]): Record<string, Metric> {
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

export function aggregateByKey(
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

export function byStreetFor(facts: HandFacts[]): StatsResult['byStreet'] {
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

export function trendFor(rows: BaseRow[], factsByHand: Map<string, HandFacts>): StatsResult['trend'] {
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

/** Map a window's true net win, in bb, to one of the four badge tiers; a
 *  neutral net or a sample below {@link STREAK_MIN_SAMPLE} is `null`. Edges are
 *  inclusive, so exactly +50bb is 小火 and exactly +100bb is 大火. */
export function streakTier(realNetBB: number, sample: number): StreakTier | null {
  if (sample < STREAK_MIN_SAMPLE) return null;
  if (realNetBB >= STREAK_LARGE_BB) return 'hot2';
  if (realNetBB >= STREAK_SMALL_BB) return 'hot1';
  if (realNetBB <= -STREAK_LARGE_BB) return 'cold2';
  if (realNetBB <= -STREAK_SMALL_BB) return 'cold1';
  return null;
}

/**
 * Hot/cold streak over the newest {@link STREAK_WINDOW} facts. Each hand is
 * normalised by ITS OWN big blind (`poker_delta / bb`) and summed UNCAPPED:
 * `realNetBB` is the true net win and drives both the displayed number and the
 * `tier`. Big pots count in full - no winsorisation. Dividing by a single
 * shared bb would misprice a window whose hands have different blinds, so the
 * per-hand divisor is load-bearing. Hands without a known positive nominal bb
 * cannot be normalised and are skipped from both the sum and the sample.
 *
 * The caller hands over the ALREADY-WINDOWED streak facts: the SQL target set
 * applies `ORDER BY settled_at DESC, hand_id DESC LIMIT 50` (binary collation,
 * the same order as the outer fetch), so this function neither re-sorts nor
 * re-slices. That keeps SQLite and JS from disagreeing on a tie at the 50-hand
 * boundary and makes the 50-hand bound verifiable in the query itself.
 */
export function streakFor(facts: HandFacts[]): StreakResult {
  let real = 0;
  let sample = 0;
  for (const f of facts) {
    if (f.bb <= 0) continue;
    sample++;
    real += f.pokerDelta / f.bb;
  }
  const realNetBB = round2(real);
  return { tier: streakTier(realNetBB, sample), realNetBB, sample };
}

export function dataQualityFor(rows: BaseRow[]): DataQuality {
  const q: DataQuality = { exact: 0, legacy: 0, partial: 0, total: rows.length };
  for (const r of rows) {
    if (r.dataConfidence === 'exact') q.exact++;
    else if (r.dataConfidence === 'legacy') q.legacy++;
    else q.partial++;
  }
  return q;
}
