/**
 * Hand-stat query layer (spec `docs/plans/hand-stats-spec.md`, P2) - public
 * facade.
 *
 * The implementation is split across four modules:
 *   - `handStatsTypes`   - shared types + definition constants (metric version,
 *                          sample gates, approximations, position ring)
 *   - `handStatsMetrics` - pure per-hand facts / metric aggregation / streak
 *   - `handStatsQuery`   - projection SQL, hand selection, computeHandStats*
 *   - `handStatsRoutes`  - HTTP routes, auth, HUD redaction
 *
 * This module re-exports the original public surface unchanged, so existing
 * `import { ... } from './handStats.js'` call sites keep working.
 */

export {
  METRIC_VERSION,
  HUD_MIN_SAMPLE,
  HUD_LOW_CONFIDENCE,
  STATS_APPROXIMATIONS,
  POSITION_VALUES,
} from './handStatsTypes.js';

export type {
  StreakTier,
  StreakResult,
  GameKind,
  IpOop,
  Street,
  StatsFilter,
  Metric,
  DataQuality,
  MetricBucket,
  StatsResult,
  RedactedStats,
} from './handStatsTypes.js';

export {
  STREAK_WINDOW,
  STREAK_MIN_SAMPLE,
  STREAK_SMALL_BB,
  STREAK_LARGE_BB,
  streakTier,
  streakFor,
} from './handStatsMetrics.js';

export { computeHandStatsMany, computeHandStats, redactedStats } from './handStatsQuery.js';

export { registerHandStatsRoutes } from './handStatsRoutes.js';
