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

import type { DB } from './db.js';
import { VOIDED_HAND_EXCLUSION_SQL } from './handProjection.js';
import type {
  ActionLite,
  BaseRow,
  PlayerLite,
  RedactedStats,
  StatsFilter,
  StatsResult,
} from './handStatsTypes.js';
import {
  DEFAULT_HAND_LIMIT,
  MAX_HAND_LIMIT,
  METRIC_VERSION,
  STATS_APPROXIMATIONS,
} from './handStatsTypes.js';
import {
  STREAK_WINDOW,
  aggregateByKey,
  byStreetFor,
  dataQualityFor,
  handFacts,
  metricsFor,
  streakFor,
  trendFor,
} from './handStatsMetrics.js';

const CONTEXT_CHUNK = 900;

interface HandContext {
  playersByHand: Map<string, PlayerLite[]>;
  actionsByHand: Map<string, ActionLite[]>;
}

/**
 * HU has no dedicated SB seat label: the button posts the small blind, so the
 * spec (§4/§5) says BTN == SB heads-up. Bucket it as SB so a HUD split does not
 * pretend heads-up buttons are a separate position. The SQL predicate below
 * uses the same expression, so filtering and output agree.
 */
const POSITION_BUCKET_SQL = `(CASE WHEN (SELECT COUNT(*) FROM hand_players pc WHERE pc.hand_id = hands.hand_id) = 2 AND p.position = 'BTN'
  THEN 'SB' ELSE COALESCE(p.position, 'UNKNOWN') END)`;

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
