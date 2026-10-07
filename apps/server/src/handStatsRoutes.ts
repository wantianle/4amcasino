/**
 * HTTP surface of the hand-stat query layer: route registration, query parsing,
 * auth/membership gates and HUD redaction. The pure computation lives in
 * `handStatsQuery`; this module only turns requests into calls and hides what
 * the caller may not see.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from './db.js';
import { requireUser } from './auth.js';
import { getRoom, isMember, presentablePlayers } from './rooms.js';
import type { DataQuality, StatsFilter, StatsResult, StreakResult } from './handStatsTypes.js';
import {
  HUD_LOW_CONFIDENCE,
  HUD_MIN_SAMPLE,
  MAX_HAND_LIMIT,
  METRIC_VERSION,
  POSITION_VALUES,
  STATS_APPROXIMATIONS,
} from './handStatsTypes.js';
import { STREAK_MIN_SAMPLE } from './handStatsMetrics.js';
import { computeHandStats, computeHandStatsMany, redactedStats } from './handStatsQuery.js';

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
 * streak.sample=19) exposes `null`, never a fake `realNetBB`/tier. Shared
 * verbatim by the HUD entry and both stats routes.
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
