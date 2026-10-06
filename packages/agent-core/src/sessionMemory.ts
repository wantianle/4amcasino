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
