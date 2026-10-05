import type { PlayerAction, Street } from '@4am/shared';
import type {
  OpponentStats,
  RecentHandSummary,
  SessionMemory,
} from './decisionView.js';

/**
 * Bounded, public-only session memory. It is deliberately a small fixed-size
 * store with no LLM summarizer: a ring of the last few hand outcomes plus a
 * per-opponent ring of hand observations. It never carries hole cards, deck
 * state, identities or anything not already public at the table.
 *
 * Discovery rule: only COMPLETE observed hands feed the per-opponent counts.
 * A hand with `historyComplete === false` (a disconnect gap or a mid-hand join)
 * has partial action history, so it is excluded from the VPIP/PFR denominator
 * instead of being misread as "the opponent did not enter the pot".
 */

export const MAX_RECENT_HANDS = 8;
export const MAX_OPPONENT_SAMPLES = 32;
export const MAX_OPPONENTS = 8;

/** One complete hand's observation of a single opponent. */
interface OppHandObs {
  vpip: boolean;
  pfr: boolean;
  postflopBetsRaises: number;
  postflopCalls: number;
}

interface OppRecord {
  /** Ring of the most recent complete observations, oldest first. */
  obs: OppHandObs[];
  /** Monotonic tick of the last hand this opponent was seen in (for eviction). */
  lastSeen: number;
}

/** Everything public needed to fold one settled hand into memory. */
export interface HandObservation {
  historyComplete: boolean;
  mySeat: number | null;
  /** This bot's net chip change; null when unknown. */
  myDelta: number | null;
  endedStreet: Street | null;
  showdown: boolean;
  /** Seats dealt into the hand, with their public userId. */
  participants: { seat: number; userId: number }[];
  /** Public actions observed this hand (auto included; auto is filtered here). */
  actions: { seat: number; street: Street; type: PlayerAction['type']; auto: boolean }[];
}

const POSTFLOP: ReadonlySet<Street> = new Set(['flop', 'turn', 'river']);

function emptyObs(): OppHandObs {
  return { vpip: false, pfr: false, postflopBetsRaises: 0, postflopCalls: 0 };
}

// ---------------------------------------------------------------------------
// P2: shrinkage (Beta / Dirichlet posterior-mean) opponent estimates
// ---------------------------------------------------------------------------

const clamp01 = (x: number): number =>
  Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;

/**
 * A Beta prior for one binary rate, expressed as a mean and a pseudo-count
 * ("strength"). The posterior mean after `hits` successes in `n` trials is
 * `(k*mean + hits) / (k + n)`, which shrinks a noisy small sample toward the
 * prior and converges to the raw frequency as `n` grows. `strength` is how many
 * pseudo-observations the prior is worth.
 */
export interface ShrinkagePrior {
  /** Prior mean in [0, 1]. */
  mean: number;
  /** Pseudo-count `k >= 0`; the larger, the stronger the shrink. */
  strength: number;
}

/**
 * Per-stat priors for the opponent model. **These are uncalibrated heuristic
 * guesses, not fitted values** - they were chosen by hand to sit near the
 * population of our own bot styles so an unread opponent produces a neutral
 * read, and `strength` so a handful of hands moves the estimate only a little
 * while ~30+ hands dominate it. They must not be presented as measured
 * population parameters; calibrating them is future work.
 *
 *  - `vpip`       ~28% (between the nit and the maniac bands, so a tiny sample
 *                 of limps does not flip the exploit read);
 *  - `pfr`        ~15% (a typical tight-open frequency);
 *  - `foldToBet`  ~55% (a default fold-to-a-bet rate; kept for callers once the
 *                 stat is surfaced - see the module report);
 *  - `aggression` ~30% (postflop bet/raise share of bet+raise+call).
 */
export const OPPONENT_PRIORS = {
  vpip: { mean: 0.28, strength: 20 },
  pfr: { mean: 0.15, strength: 20 },
  foldToBet: { mean: 0.55, strength: 16 },
  aggression: { mean: 0.3, strength: 12 },
} as const satisfies Record<string, ShrinkagePrior>;

/**
 * Beta posterior mean `(k*mean + hits) / (k + n)`, with an explicit total input
 * contract:
 *
 *  - `prior.mean` is clamped to `[0, 1]`; `prior.strength` (`k`) and `n` are
 *    clamped to `>= 0`; a non-finite value in any of them reads as its neutral
 *    (0 for `k`/`n`, the prior mean is only consulted for the output).
 *  - `hits` is a count of successes among `n` trials. It is clamped to
 *    `[0, n]`: a caller that reports more successes than trials is treated as a
 *    saturated 100% observation rather than producing an out-of-range rate.
 *    Fractional values are allowed (weighted pseudo-counts) and negative /
 *    non-finite values read as 0.
 *  - `k + n === 0` (no sample and no prior) leaves the posterior undefined, so
 *    the function falls back to `prior.mean` - the "no evidence" neutral read.
 *
 * The result is always in `[0, 1]` and never `NaN`.
 */
export function shrinkRate(hits: number, n: number, prior: ShrinkagePrior): number {
  const mean = clamp01(prior.mean);
  const k = Number.isFinite(prior.strength) ? Math.max(0, prior.strength) : 0;
  const count = Number.isFinite(n) ? Math.max(0, n) : 0;
  const successes = Number.isFinite(hits) ? Math.max(0, hits) : 0;
  const h = Math.min(successes, count);
  const denominator = k + count;
  if (denominator <= 0) return mean; // no prior, no sample: neutral fallback
  return clamp01((k * mean + h) / denominator);
}

/**
 * Confidence in [0, 1] of an `n`-sample estimate: `n / (n + k)`, with the same
 * input contract as `shrinkRate` (`n`/`k` clamped to `>= 0`, non-finite reads as
 * 0). `n + k === 0` has no information at all and returns 0; `k === 0` with a
 * positive sample is full confidence (1). Never `NaN`.
 */
export function shrinkConfidence(n: number, prior: ShrinkagePrior): number {
  const k = Number.isFinite(prior.strength) ? Math.max(0, prior.strength) : 0;
  const count = Number.isFinite(n) ? Math.max(0, n) : 0;
  const denominator = count + k;
  return denominator > 0 ? count / denominator : 0;
}

/** A shrunk, posterior-mean read on one opponent (all values in [0, 1]). */
export interface OpponentEstimate {
  vpip: number;
  pfr: number;
  /** Postflop bet/raise share of (bet/raise + call), with its own prior. */
  aggression: number;
  /** `n / (n + k_vpip)`: how much to trust this read over the prior. */
  confidence: number;
  /** Raw complete-hand denominator the estimate was built from. */
  sampleHands: number;
}

/**
 * Map an opponent's raw counts to posterior-mean rates. Unlike the old
 * `sampleHands < 10` cutoff this never discards a sample: a small sample simply
 * stays close to `OPPONENT_PRIORS`, a large one approaches the observed
 * frequency.
 */
export function estimateOpponent(stats: OpponentStats): OpponentEstimate {
  const n = Number.isFinite(stats.sampleHands) ? Math.max(0, stats.sampleHands) : 0;
  const postflop = Math.max(0, stats.postflopBetsRaises) + Math.max(0, stats.postflopCalls);
  return {
    vpip: shrinkRate(stats.vpipHands, n, OPPONENT_PRIORS.vpip),
    pfr: shrinkRate(stats.pfrHands, n, OPPONENT_PRIORS.pfr),
    aggression: shrinkRate(stats.postflopBetsRaises, postflop, OPPONENT_PRIORS.aggression),
    confidence: shrinkConfidence(n, OPPONENT_PRIORS.vpip),
    sampleHands: n,
  };
}

export class SessionTracker {
  private handsObserved = 0;
  private netChips: number | null = null;
  private recentHands: RecentHandSummary[] = [];
  private readonly opponents = new Map<number, OppRecord>();
  private tick = 0;

  observeHand(hand: HandObservation): void {
    this.handsObserved++;
    if (hand.myDelta !== null) this.netChips = (this.netChips ?? 0) + hand.myDelta;
    this.recentHands.push({
      // Preserve "unknown" (null) rather than coercing it to 0: a hand whose
      // delta could not be read must not be reported as a break-even hand.
      myDelta: hand.myDelta,
      endedStreet: hand.endedStreet,
      showdown: hand.showdown,
      historyComplete: hand.historyComplete,
    });
    if (this.recentHands.length > MAX_RECENT_HANDS)
      this.recentHands.splice(0, this.recentHands.length - MAX_RECENT_HANDS);

    // Partial history must not create a VPIP/PFR sample for anyone.
    if (!hand.historyComplete) return;

    this.tick++;
    const perSeat = new Map<number, OppHandObs>();
    for (const a of hand.actions) {
      if (a.auto) continue; // a timeout action is not a read on the player
      const obs = perSeat.get(a.seat) ?? emptyObs();
      const voluntary = a.type === 'call' || a.type === 'bet' || a.type === 'raise';
      if (a.street === 'preflop' && voluntary) obs.vpip = true;
      if (a.street === 'preflop' && (a.type === 'bet' || a.type === 'raise')) obs.pfr = true;
      if (POSTFLOP.has(a.street) && (a.type === 'bet' || a.type === 'raise'))
        obs.postflopBetsRaises++;
      if (POSTFLOP.has(a.street) && a.type === 'call') obs.postflopCalls++;
      perSeat.set(a.seat, obs);
    }

    for (const p of hand.participants) {
      if (p.seat === hand.mySeat) continue;
      const record = this.opponents.get(p.userId) ?? { obs: [], lastSeen: 0 };
      // A dealt-in opponent with no voluntary action still counts as a sample
      // (it is a hand they did not enter voluntarily).
      record.obs.push(perSeat.get(p.seat) ?? emptyObs());
      if (record.obs.length > MAX_OPPONENT_SAMPLES)
        record.obs.splice(0, record.obs.length - MAX_OPPONENT_SAMPLES);
      record.lastSeen = this.tick;
      this.opponents.set(p.userId, record);
    }

    this.pruneOpponents();
  }

  /** Keep only the most recently seen `MAX_OPPONENTS` users, bounding state. */
  private pruneOpponents(): void {
    if (this.opponents.size <= MAX_OPPONENTS) return;
    const byRecency = [...this.opponents.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (const [userId] of byRecency.slice(0, this.opponents.size - MAX_OPPONENTS))
      this.opponents.delete(userId);
  }

  /** Build the bounded, seat-mapped view handed to a policy. */
  snapshot(
    myUserId: number,
    currentSeats: { seat: number; userId: number }[],
  ): SessionMemory {
    const opponents: OpponentStats[] = [];
    const seen = new Set<number>();
    for (const s of currentSeats) {
      if (s.userId === myUserId || seen.has(s.userId)) continue;
      seen.add(s.userId);
      // One fallback for "never seen": a bounded window, identity-mapped per
      // seat and de-duplicated by `seen` above. `record` existence is folded
      // into `obs` so the five stats read uniformly.
      const obs = this.opponents.get(s.userId)?.obs ?? [];
      opponents.push({
        seat: s.seat,
        sampleHands: obs.length,
        vpipHands: obs.filter((o) => o.vpip).length,
        pfrHands: obs.filter((o) => o.pfr).length,
        postflopBetsRaises: obs.reduce((n, o) => n + o.postflopBetsRaises, 0),
        postflopCalls: obs.reduce((n, o) => n + o.postflopCalls, 0),
      });
      if (opponents.length >= MAX_OPPONENTS) break;
    }
    return {
      handsObserved: this.handsObserved,
      netChips: this.netChips,
      recentHands: [...this.recentHands],
      opponents,
    };
  }
}
