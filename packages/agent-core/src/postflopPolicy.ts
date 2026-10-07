import { HAND_CATEGORY, type CardId } from '@4am/shared';
import { postflopStreetOf, type PostflopStreet } from './betSizing.js';
import type { DecisionLegalActions, DecisionView } from './decisionView.js';
import { estimateEquity, mulberry32 } from './equity.js';
import type { PolicyDecision } from './policy.js';
import { deriveRulesSeed } from './rulesSeed.js';
import type { RuleParams } from './ruleStyles.js';
import { normalizeLegalActions } from './legalActions.js';
import { betAmount, guaranteedLegalAction, raiseToAmount } from './actionAdapter.js';
import { defendProbability, resolveFacingBetPrice } from './potPrice.js';
import {
  blockerFactor,
  bluffBetProbability,
  chooseBetFraction,
  rangeAdvantage,
  valueBetProbability,
  type SizingContext,
} from './postflopSizing.js';
import { deriveTableContext, heroInPosition, heroWasAggressor } from './tableContext.js';
import { clamp, clamp01 } from './postflopMath.js';
import { evaluateHand, type HandEval } from './postflopStrength.js';
import { classifyTexture, type BoardTexture } from './postflopTexture.js';
import { blockerScore, isExposedOverpair, madeHandSuppressedByBoard } from './postflopBlockers.js';
import { DEFAULT_P2, type P2Options } from './postflopP2.js';
import { handPercentile } from './postflopPercentile.js';
import {
  facingBetMargin,
  facingBetSamples,
  facingVillainModel,
  facingVillainRange,
  opponentModelStats,
  type VillainRangeModel,
} from './postflopVillain.js';

// Price helpers moved to `potPrice.ts`; re-exported so existing importers keep
// their `postflopPolicy` import path.
export {
  mdf,
  bluffToValueRatio,
  defendProbability,
  resolveFacingBetPrice,
} from './potPrice.js';
export type { FacingBetPrice } from './potPrice.js';

// Table-context helpers moved to `tableContext.ts`; re-exported for existing
// importers (the postflop signal snapshot imports both).
export { heroInPosition, heroWasAggressor } from './tableContext.js';

// Postflop feature layer (hand strength, 24-bucket, texture, flush/blocker)
// moved into dedicated pure modules; re-exported so the historical public
// surface of `postflopPolicy.js` is unchanged.
export { evaluateHand, type HandEval } from './postflopStrength.js';
export { classifyTexture, type BoardTexture } from './postflopTexture.js';
export {
  MADE_BUCKETS,
  DRAW_BUCKETS,
  handBucket,
  bucketStrength,
  bucketAdvantage,
  type MadeBucket,
  type DrawBucket,
  type HandBucket,
} from './postflopBuckets.js';
export {
  dominantFlushSuit,
  flushLayerOf,
  heroFlushExposed,
  isExposedOverpair,
  isOverpair,
  madeHandSuppressedByBoard,
  blockerScore,
  type FlushLayer,
} from './postflopBlockers.js';

/**
 * Rules-v1 postflop engine.
 *
 * A compact, deterministic *heuristic* (no solver / CFR / network / GTO). It is
 * built around four modern concepts, each an intentional approximation:
 *
 *  1. **Conditional range equity vs pot odds** — facing a bet we assign the
 *     bettor a coarse continuing range (value-heavy / balanced / bluff-heavy)
 *     from public information, weight every board-remaining opponent combo by a
 *     heuristic strength tier, and estimate hero equity against that weighted
 *     range. We call when equity clears pot odds by an adaptive sampling-error
 *     band (`facingBetMargin`), fold when it is clearly short, and randomise by
 *     the old `mdf = P/(P+B)` percentile mix inside the band. This is still an
 *     approximation (no range propagation) but no longer a pure frequency
 *     argument against uniform unknown combos.
 *  2. **Flush stratification (P1)** — a made flush is not a flat nuts-weight:
 *     `flushLayerOf` splits it into nut / second / middle / low from the hand's
 *     own same-suit ranks versus every flush still makeable, and the villain
 *     range is weighted by that layer. Hero's own flush holding is folded into
 *     the range as a blocker correction (`heroFlushBlockFactor`): a nut/second
 *     blocker lightens the opponent's flush range, while holding no card of the
 *     suit keeps the flush range at full value and slightly heavier. Only an
 *     **overpair** with no card of that suit (`isExposedOverpair`, i.e.
 *     `isOverpair && heroFlushExposed`) is treated as a bluff-catcher and has
 *     its bet/raise frequency dialled
 *     down; every other made-hand category keeps its normal aggression. Both the
 *     facing-bet value raise and the unopened value bet additionally apply
 *     `madeHandSuppressedByBoard`, a board-aware correction: on a four-flush
 *     board with no card of the suit, on a four-to-a-straight board with no
 *     straight, or with a board-only made hand of value category (`>= 3`:
 *     trips / straight / flush / boat / quads / straight flush built by the
 *     board itself), the made hand is no longer treated as an automatic value
 *     hand (only a real equity edge / the normal check-bluff flow is).
 *  3. **Bet sizing** — per-street grid (`flop 33/75`, `turn 50/75/100/150`,
 *     `river 33/50/75/100/150`, plus all-in); the heuristic picks from texture
 *     (dry/wet, high/low, connected/suited) and SPR / position / range
 *     advantage, then snaps to the street's allowed sizes.
 *  4. **Value:bluff ratio** — approximates bluffs ≈ `f/(1+f)` × value for an
 *     `f`-pot bet.
 *  5. **Blockers** — a hand-built score preferring bluffs that block the
 *     opponent's continuing/nut range and avoiding those that block their folds;
 *     P1 also uses the flush-block factor above inside the facing-a-bet equity.
 *
 * Exported pure helpers (`mdf`, `classifyTexture`, `chooseBetFraction`,
 * `bluffToValueRatio`, `blockerScore`, `handPercentile`, ...) carry the logic
 * and are unit-tested directly. Hand ranking is delegated entirely to the shared
 * evaluator — this module never re-implements poker hand comparison.
 */

// ---------------------------------------------------------------------------
// value-bet / bluff / blocker probabilities + bet-size chooser (sizing)
// ---------------------------------------------------------------------------
//
// The sizing layer moved verbatim into `./postflopSizing.ts` (value-bet / bluff
// / blocker probabilities, `SizingContext`, `chooseBetFraction` and the
// `rangeAdvantage` score they consume). Re-exported here so the historical
// public surface of `postflopPolicy.js` is unchanged.
export {
  valueBetProbability,
  blockerFactor,
  bluffBetProbability,
  chooseBetFraction,
  rangeAdvantage,
  type SizingContext,
} from './postflopSizing.js';

// ---------------------------------------------------------------------------
// P2: per-street bet-size grid (single source: ./betSizing.ts)
// ---------------------------------------------------------------------------
//
// The grid data and the read helpers live in `./betSizing.ts` so the policy and
// the frozen baseline fixtures share one definition — a sizing edit cannot
// silently diverge between a policy and its differential baseline. Re-exported
// here for existing importers (`postflopPolicy.POSTFLOP_SIZE_GRID`, etc.).
export {
  POSTFLOP_SIZE_GRID,
  POSTFLOP_SIZE_GRIDS,
  OPPONENT_READ_GRID,
  DEFAULT_SIZE_STREET,
  streetSupportsOverbet,
  gridFraction,
  snapBetFraction,
  snapOpponentRead,
  postflopStreetOf,
} from './betSizing.js';
export type { PostflopSize, PostflopStreet } from './betSizing.js';

// Postflop signal layer: hand percentile (uniform prior) and the P0
// villain/range model moved into dedicated pure modules; re-exported so the
// historical public surface of `postflopPolicy.js` is unchanged.
export { unknownComboCount, handPercentile } from './postflopPercentile.js';
export {
  P0_FACING_BET_MARGIN,
  P0_BET_CONFIDENCE,
  P0_EQUITY_SAMPLES,
  P0_MULTIWAY_EQUITY_SAMPLES,
  facingBetSamples,
  facingBetMargin,
  chooseVillainModel,
  villainStrengthTier,
  villainModelWeight,
  buildVillainRange,
  opponentModelStats,
  facingVillainModel,
  facingVillainRange,
  type VillainRangeModel,
  type VillainModelInput,
} from './postflopVillain.js';

// P2 toggle type + frozen defaults moved into a neutral leaf module (the signal
// layer reads `DEFAULT_P2`, the policy reads both). `P2_ALL_OFF` moved there too
// in phase 6, next to `DEFAULT_P2` so the two controls cannot drift.
export { DEFAULT_P2, P2_ALL_OFF, type P2Options } from './postflopP2.js';

// ---------------------------------------------------------------------------
// positional / aggression helpers
// ---------------------------------------------------------------------------

// `heroWasAggressor` / `heroInPosition` moved to `tableContext.ts`, where
// `heroInPosition` uses the postflop action order (`postflopActionOrder`) rather
// than the preflop dealing order, so heads-up IP/OOP stays correct. Both are
// re-exported above for existing importers.

// Preflop relative-position helpers live in the preflop layer now (they read the
// preflop history and only size a preflop raise); re-exported so the historical
// import path from `postflopPolicy.js` keeps working.
export { lastPreflopRaiserSeat, heroIsIPToOpener } from './preflopPosition.js';

// ---------------------------------------------------------------------------
// policy
// ---------------------------------------------------------------------------

// `heroWasAggressor` / `heroInPosition` moved to `tableContext.ts` and
// re-exported above.

export interface PostflopOptions {
  params: RuleParams;
  /** Base seed; the per-decision seed is `deriveRulesSeed(seed, view)`. */
  seed?: number;
  /** P2 behaviour switches; omitted fields keep `DEFAULT_P2`. */
  p2?: Partial<P2Options>;
  /**
   * Optional, strictly read-only sink for one decision's INTERNAL state, called
   * once per `decide()` with the values the engine actually computed (not a
   * reconstruction from the exported helpers). This is what lets a behaviour
   * snapshot read `decide()`'s real `overbetRoll`, equity/model, intermediate
   * booleans, selected branch and final sizing.
   *
   * NEVER affects a decision: the trace is emitted after the action is resolved,
   * every `rng()` draw keeps its exact position in the seeded sequence (the
   * trace only *records* the value the draw returned), and any exception the
   * sink throws is swallowed. Omitted by default, in which case no trace object
   * is allocated and the emit helper returns on its first line.
   */
  onTrace?: (trace: PostflopTrace) => void;
}

/** The top-level branch `decide()` took. */
export type PostflopNode = 'unopened' | 'facingBet' | 'no-context';

/** RNG draws a decision may make, in the order `decide()` can consume them. */
export type PostflopRollKey =
  | 'overbetRoll'
  | 'valueRoll'
  | 'bluffRoll'
  | 'defendRoll'
  | 'raiseRoll'
  | 'semiBluffRoll';

/**
 * One `PostflopPolicy.decide()` call's internal decision state, emitted through
 * {@link PostflopOptions.onTrace}.
 *
 * This is the first-class trace the phase-0 behaviour snapshots had to
 * reconstruct: instead of recomputing `valueBetProbability` / `chooseBetFraction`
 * outside the policy (and risking a silent divergence), a snapshot can now pin
 * the exact numbers the engine used. Every field is computed on the real path;
 * `null` means that branch never produced the value (e.g. `defend` on an
 * unopened node, or a probability whose gate short-circuited past it).
 *
 * Purely observational, so it is safe to enable anywhere.
 */
export interface PostflopTrace {
  /** Which top-level branch produced the action. */
  node: PostflopNode;
  /** Resolved grid street for sizing. */
  street: PostflopStreet;
  context: {
    spr: number;
    inPosition: boolean;
    wasAggressor: boolean;
    /** `max(1, live opponents)` — the headcount the engine used. */
    activeOpponents: number;
    rangeAdvantage: number;
    exploitMultiplier: number;
  };
  hand: {
    category: number;
    flushDraw: boolean;
    straightDraw: number;
    overcards: number;
    percentile: number;
  };
  texture: BoardTexture;
  opponentModel: ReturnType<typeof opponentModelStats>;
  /** `blockerScore(hole, board)`; null on the no-context early return. */
  blocker: number | null;
  madeHandSuppressed: boolean;
  exposedOverpair: boolean;
  /** The intermediate booleans, as computed (null when not reached). */
  booleans: {
    value: boolean | null;
    bluffCandidate: boolean | null;
    defend: boolean | null;
    strong: boolean | null;
  };
  /** Named branch that returned the action. */
  branch: string;
  /** The real seeded draws, by gate. */
  rng: Record<PostflopRollKey, number | null>;
  /** Resolved sizing context + the size actually used (null when no bet/raise). */
  sizing: {
    fraction: number | null;
    overbetRoll: number | null;
    maxOverbetFrequency: number;
    amount: number | null;
    allIn: boolean;
  } | null;
  /** Facing-bet price + real equity/model (null on the unopened node). */
  facing: {
    priceTrusted: boolean;
    potBefore: number;
    requiredEquity: number;
    requiredMdf: number;
    equity: number;
    samples: number;
    margin: number;
    villainModel: VillainRangeModel;
    villainCombos: number;
  } | null;
  /** The probabilities the gates compared their roll against (null when unused). */
  probabilities: {
    valueBet: number | null;
    bluffBet: number | null;
    defend: number | null;
  };
  action: { type: string; amount?: number };
  reason: string;
}

/** A legitimate, always-legal fallback action. */
function onlyLegal(la: DecisionLegalActions, reason: string): PolicyDecision {
  return { action: guaranteedLegalAction(la), reason };
}

/** The draw recorder passed into the branch methods instead of a bare `rng`. */
type PostflopRoll = (key: PostflopRollKey) => number;

/** Skeleton for a trace; branch methods fill it in. */
function emptyTrace(view: DecisionView): PostflopTrace {
  return {
    node: 'no-context',
    street: postflopStreetOf(view.hand?.street ?? null),
    context: {
      spr: 0,
      inPosition: false,
      wasAggressor: false,
      activeOpponents: 1,
      rangeAdvantage: 0,
      exploitMultiplier: 1,
    },
    hand: { category: 0, flushDraw: false, straightDraw: 0, overcards: 0, percentile: 0 },
    texture: classifyTexture(view.hand?.board ?? []),
    opponentModel: {},
    blocker: null,
    madeHandSuppressed: false,
    exposedOverpair: false,
    booleans: { value: null, bluffCandidate: null, defend: null, strong: null },
    branch: 'no-context',
    rng: {
      overbetRoll: null,
      valueRoll: null,
      bluffRoll: null,
      defendRoll: null,
      raiseRoll: null,
      semiBluffRoll: null,
    },
    sizing: null,
    facing: null,
    probabilities: { valueBet: null, bluffBet: null, defend: null },
    action: { type: 'check' },
    reason: '',
  };
}

export class PostflopPolicy {
  readonly name = 'rules-v1-postflop';
  private readonly params: RuleParams;
  private readonly seed: number;
  private readonly p2: P2Options;
  private readonly onTrace?: (trace: PostflopTrace) => void;

  constructor(options: PostflopOptions) {
    this.params = options.params;
    this.seed = options.seed ?? 0x9e3779b9;
    this.p2 = { ...DEFAULT_P2, ...options.p2 };
    this.onTrace = options.onTrace;
  }

  decide(view: DecisionView): PolicyDecision {
    const raw = view.legalActions;
    if (!raw) throw new Error(`${this.name} asked to act out of turn`);
    const la = normalizeLegalActions(raw);
    const hole = view.hand?.myCards ?? [];
    const board = view.hand?.board ?? [];
    // Allocate the trace only when observed: with no sink the policy runs the
    // exact same code path and allocates nothing.
    const trace = this.onTrace ? emptyTrace(view) : undefined;
    if (!view.hand || view.hand.street === 'preflop' || hole.length < 2 || board.length < 3) {
      const decision = onlyLegal(la, 'rules-v1 postflop: no card context');
      this.finishTrace(trace, decision, 'no-context');
      return decision;
    }

    const rng = mulberry32(deriveRulesSeed(this.seed, view));
    // Records the value `rng()` returned without adding, reordering or skipping
    // a single draw: `rng()` is still called exactly where it was, and the trace
    // assignment is pure bookkeeping that cannot affect the sequence.
    const roll: PostflopRoll = (key) => {
      const value = rng();
      if (trace) trace.rng[key] = value;
      return value;
    };

    const ev = evaluateHand(hole, board);
    const percentile = handPercentile(hole, board);
    const texture = classifyTexture(board);
    const inPosition = heroInPosition(view);
    const wasAggressor = heroWasAggressor(view);
    const adv = rangeAdvantage({ heroWasAggressor: wasAggressor, inPosition, texture });
    const spr = this.spr(view);
    const active = Math.max(1, view.opponents.filter((o) => !o.folded).length);
    const call = la.callAmount;

    if (trace) {
      trace.context = {
        spr,
        inPosition,
        wasAggressor,
        activeOpponents: active,
        rangeAdvantage: adv,
        exploitMultiplier: this.exploitMultiplier(view),
      };
      trace.hand = {
        category: ev.category,
        flushDraw: ev.flushDraw,
        straightDraw: ev.straightDraw,
        overcards: ev.overcards,
        percentile,
      };
      trace.texture = texture;
      trace.opponentModel = opponentModelStats(view);
    }

    const decision = la.canCheck
      ? this.decideUnopened(view, la, hole, board, ev, percentile, texture, adv, spr, roll, trace)
      : this.decideFacingBet(
          view,
          la,
          hole,
          board,
          ev,
          percentile,
          texture,
          adv,
          spr,
          active,
          call,
          roll,
          trace,
        );
    this.finishTrace(trace, decision, la.canCheck ? 'unopened' : 'facingBet');
    return decision;
  }

  /**
   * Stamp the resolved action/reason onto a trace and emit it. Strictly
   * fail-open: the decision is already final, and a throwing or absent sink can
   * never change it. Returns on the first line when there is nothing to do.
   */
  private finishTrace(
    trace: PostflopTrace | undefined,
    decision: PolicyDecision,
    node: PostflopNode,
  ): void {
    if (!trace || !this.onTrace) return;
    trace.node = node;
    const action = decision.action;
    trace.action =
      action.type === 'bet' || action.type === 'raise'
        ? { type: action.type, amount: action.amount }
        : { type: action.type };
    trace.reason = decision.reason;
    try {
      this.onTrace(trace);
    } catch {
      // Telemetry must never affect a live decision.
    }
  }

  private spr(view: DecisionView): number {
    return deriveTableContext(view).spr;
  }

  private effectiveStackBB(view: DecisionView): number {
    return deriveTableContext(view).effectiveStackBB;
  }

  private exploitMultiplier(view: DecisionView): number {
    const bySeat = new Map(view.sessionMemory.opponents.map((o) => [o.seat, o]));
    let vpip = 0;
    let pfr = 0;
    let n = 0;
    for (const o of view.opponents) {
      if (o.folded) continue;
      const stats = bySeat.get(o.seat);
      if (!stats) continue;
      // Raw rates from opponents with a usable sample. The former `shrinkage`
      // branch (posterior-mean read + confidence-scaled exploit) was deleted
      // with its switch, so this cutoff is the permanent behaviour.
      if (stats.sampleHands < 10) continue;
      vpip += stats.vpipHands / stats.sampleHands;
      pfr += stats.pfrHands / stats.sampleHands;
      n++;
    }
    if (n === 0) return 1;
    const avgVpip = vpip / n;
    const avgPfr = pfr / n;
    let m = 1;
    if (avgVpip > 0.45 && avgPfr < 0.18) m *= 0.6; // station: bluff less
    else if (avgVpip < 0.22) m *= 1.25; // nit: bluff more
    return clamp(m, 0.4, 1.4);
  }

  private aggressionMultiplier(view: DecisionView, blocker: number, active: number): number {
    return clamp(
      this.params.bluffScale *
        blockerFactor(blocker) *
        this.exploitMultiplier(view) *
        (active >= 2 ? this.params.multiwayBluffScale : 1),
      0,
      4,
    );
  }

  private decideUnopened(
    view: DecisionView,
    la: DecisionLegalActions,
    hole: readonly CardId[],
    board: readonly CardId[],
    ev: HandEval,
    percentile: number,
    texture: BoardTexture,
    adv: number,
    spr: number,
    roll: PostflopRoll,
    trace?: PostflopTrace,
  ): PolicyDecision {
    const blocker = blockerScore(hole, board);
    const draw = ev.flushDraw || ev.straightDraw >= 1;
    // Board-aware: a made hand whose raw category is nullified by the board
    // (a four-flush / four-straight runout, or a board-only made hand of value
    // category - trips / straight / flush / boat / quads) is not an automatic
    // value bet - only a live hand is. See `madeHandSuppressedByBoard`.
    const boardSuppressed = madeHandSuppressedByBoard(hole, board, ev, texture);
    const value = !boardSuppressed && (ev.category >= HAND_CATEGORY.trips || percentile >= 0.8);
    const bluffCandidate = !value && percentile < 0.6 && (draw || blocker >= 0.4);
    // P1: an **overpair** with no card of the board's flush suit is a
    // bluff-catcher against a flush-heavy continuing range, so it bets less
    // often. The discount is deliberately scoped to exposed overpairs only -
    // sets, two pair, straights and strong draws keep their normal frequency.
    const exposedOverpair = isExposedOverpair(hole, board, ev);
    if (trace) {
      trace.blocker = blocker;
      trace.madeHandSuppressed = boardSuppressed;
      trace.exposedOverpair = exposedOverpair;
      trace.booleans.value = value;
      trace.booleans.bluffCandidate = bluffCandidate;
    }

    if (la.canBet) {
      const overbetRoll = roll('overbetRoll');
      const sizingCtx: SizingContext = {
        spr,
        inPosition: heroInPosition(view),
        rangeAdvantage: adv,
        overbetRoll,
        maxOverbetFrequency: this.params.maxOverbetFrequency,
      };
      if (trace) {
        trace.sizing = {
          fraction: null,
          overbetRoll,
          maxOverbetFrequency: this.params.maxOverbetFrequency,
          amount: null,
          allIn: false,
        };
      }
      const valueProb = valueBetProbability(this.params, adv) * (exposedOverpair ? 0.6 : 1);
      if (trace) trace.probabilities.valueBet = valueProb;
      if (value && roll('valueRoll') < valueProb) {
        if (trace) trace.branch = 'value-bet';
        return this.bet(view, la, texture, sizingCtx, `rules-v1 postflop value (pct ${percentile.toFixed(2)}${exposedOverpair ? ', no-suit overpair' : ''})`, trace);
      }
      if (bluffCandidate) {
        const fraction = chooseBetFraction(
          texture,
          sizingCtx,
          postflopStreetOf(view.hand?.street),
        );
        const active = Math.max(1, view.opponents.filter((o) => !o.folded).length);
        const prob = bluffBetProbability(
          this.params,
          fraction,
          adv,
          blocker,
          active >= 2 ? this.params.multiwayBluffScale : 1,
          this.exploitMultiplier(view),
        );
        if (trace && trace.sizing) {
          trace.sizing.fraction = fraction;
          trace.probabilities.bluffBet = prob;
        }
        if (roll('bluffRoll') < prob) {
          if (trace) trace.branch = 'bluff-bet';
          return this.bet(view, la, texture, sizingCtx, `rules-v1 postflop bluff (blocker ${blocker.toFixed(2)})`, trace);
        }
      }
    }
    if (trace) trace.branch = 'check';
    return { action: { type: 'check' }, reason: `rules-v1 postflop check (pct ${percentile.toFixed(2)})` };
  }

  private decideFacingBet(
    view: DecisionView,
    la: DecisionLegalActions,
    hole: readonly CardId[],
    board: readonly CardId[],
    ev: HandEval,
    percentile: number,
    texture: BoardTexture,
    adv: number,
    spr: number,
    active: number,
    call: number,
    roll: PostflopRoll,
    trace?: PostflopTrace,
  ): PolicyDecision {
    // Resolve the price from the snapshot (pure, unit-tested): a malformed
    // field, a mismatched call amount or a pot below the call is never clamped
    // into a fold. `price.trusted` gates the equity comparison; an untrusted
    // snapshot takes the conservative MDF/percentile path below.
    const price = resolveFacingBetPrice(view.potOdds, call);
    const potBefore = price.potBefore;
    const requiredEquity = price.requiredEquity;
    const priceTrusted = price.trusted;
    const required = price.requiredMdf;

    // P0: equity against a heuristic continuing range (value/balanced/bluff
    // weighted), compared with the price. A non-finite estimate fails closed to
    // zero equity rather than a neutral 0.5 that would invite a call. A
    // malformed view (hole/board overlap) or an estimator error falls back to
    // the neutral `requiredEquity` - the policy must never throw just because a
    // snapshot was inconsistent.
    const samples = facingBetSamples(active);
    let equity = requiredEquity;
    let villainCombos = 0;
    try {
      const knownValid = new Set([...hole, ...board]).size === hole.length + board.length;
      if (knownValid) {
        const villainRange = facingVillainRange(view, hole, potBefore, call, this.p2);
        villainCombos = villainRange.combos?.length ?? 0;
        const estimate = estimateEquity({
          hole,
          board,
          opponents: active,
          samples,
          seed: deriveRulesSeed(this.seed, view),
          villainRange,
        });
        equity = Number.isFinite(estimate.equity) ? clamp01(estimate.equity) : 0;
      }
    } catch {
      equity = requiredEquity;
    }

    const margin = facingBetMargin(equity, samples);
    let defend: boolean;
    if (!priceTrusted) {
      // Conservative neutral path: the price mirror is unusable, so never fold
      // solely on its account. Defend by hand percentile against the MDF of the
      // authoritative pot/call price (or a neutral 0.5 when the pot is bad too).
      const p = defendProbability(percentile, required);
      if (trace) trace.probabilities.defend = p;
      defend = roll('defendRoll') < p;
    } else {
      // The band is the estimator's own ~2 standard errors, so a decision only
      // counts as clear when the observed edge exceeds sampling noise; inside
      // the band the former MDF/percentile mix still sets the frequency.
      if (equity > requiredEquity + margin) {
        defend = true;
      } else if (equity < requiredEquity - margin) {
        defend = false;
      } else {
        const p = defendProbability(percentile, required);
        if (trace) trace.probabilities.defend = p;
        defend = roll('defendRoll') < p;
      }
    }
    if (trace) {
      trace.booleans.defend = defend;
      trace.facing = {
        priceTrusted,
        potBefore,
        requiredEquity,
        requiredMdf: required,
        equity,
        samples,
        margin,
        villainModel: facingVillainModel(view, potBefore, call, this.p2),
        villainCombos,
      };
    }
    if (!defend) {
      if (trace) trace.branch = 'fold';
      return {
        action: { type: 'fold' },
        reason: `rules-v1 postflop fold (equity ${equity.toFixed(2)} < pot odds ${requiredEquity.toFixed(2)}, pct ${percentile.toFixed(2)})`,
      };
    }

    const overbetRoll = roll('overbetRoll');
    const sizingCtx: SizingContext = {
      spr,
      inPosition: heroInPosition(view),
      rangeAdvantage: adv,
      overbetRoll,
      maxOverbetFrequency: this.params.maxOverbetFrequency,
    };
    if (trace) {
      trace.sizing = {
        fraction: null,
        overbetRoll,
        maxOverbetFrequency: this.params.maxOverbetFrequency,
        amount: null,
        allIn: false,
      };
    }

    // `equity` is already available; a clear equity edge also counts as value.
    // P1: only an **overpair** with no card of the flush suit is a bluff-catcher
    // on a suited board - it is held back from value raising (a much tighter
    // equity gate and a lower raise frequency).
    // Board-aware: a made hand whose raw category is nullified by a completed
    // board draw (`madeHandSuppressedByBoard`) is likewise held back - its
    // category / percentile proxies do not count as value, only a real equity
    // edge does. This stops a four-flush set (or a four-straight set / two pair)
    // from auto-raising when every continuing hand beats it.
    const exposedOverpair = isExposedOverpair(hole, board, ev);
    const boardSuppressed = madeHandSuppressedByBoard(hole, board, ev, texture);
    const strong =
      (!boardSuppressed && (ev.category >= HAND_CATEGORY.trips || percentile >= 0.85)) ||
      equity >= (exposedOverpair ? 0.86 : 0.8);
    if (trace) {
      trace.blocker = blockerScore(hole, board);
      trace.madeHandSuppressed = boardSuppressed;
      trace.exposedOverpair = exposedOverpair;
      trace.booleans.strong = strong;
    }
    if (strong && la.canRaise && roll('raiseRoll') < (exposedOverpair ? 0.2 : 0.6)) {
      if (trace) trace.branch = 'value-raise';
      return this.raise(view, la, texture, sizingCtx, `rules-v1 postflop value raise (pct ${percentile.toFixed(2)}, eq ${equity.toFixed(2)}${exposedOverpair ? ', no-suit overpair' : ''})`, trace);
    }

    const blocker = blockerScore(hole, board);
    const draw = ev.flushDraw || ev.straightDraw >= 1;
    if (
      la.canRaise &&
      (draw || blocker >= 0.5) &&
      roll('semiBluffRoll') < 0.35 * (exposedOverpair ? 0.5 : 1) * this.aggressionMultiplier(view, blocker, active)
    ) {
      if (trace) trace.branch = 'semibluff-raise';
      return this.raise(view, la, texture, sizingCtx, `rules-v1 postflop semibluff raise (blocker ${blocker.toFixed(2)})`, trace);
    }
    if (trace) trace.branch = 'call';
    return {
      action: { type: 'call' },
      reason: `rules-v1 postflop call (equity ${equity.toFixed(2)} vs pot odds ${requiredEquity.toFixed(2)}, pct ${percentile.toFixed(2)})`,
    };
  }

  private bet(
    view: DecisionView,
    la: DecisionLegalActions,
    texture: BoardTexture,
    ctx: SizingContext,
    reason: string,
    trace?: PostflopTrace,
  ): { action: { type: 'bet'; amount: number }; reason: string } {
    // Short-stack override: below 20BB an unopened bet is a deliberate shove to
    // the stack, taking precedence over every standard grid size below. It
    // matches the raise() convention (and the shared engine's "bet up to stack"
    // rule), so a short stack never gets a "standard size, capped" instead.
    if (this.effectiveStackBB(view) < 20) {
      if (trace?.sizing) {
        trace.sizing.amount = la.maxRaiseTo;
        trace.sizing.allIn = true;
      }
      return { action: { type: 'bet', amount: la.maxRaiseTo }, reason: `${reason} all-in` };
    }
    const pot = view.potOdds?.pot ?? 0;
    const fraction = chooseBetFraction(texture, ctx, postflopStreetOf(view.hand?.street));
    const amount = betAmount({
      pot,
      fraction,
      minRaiseTo: la.minRaiseTo,
      maxRaiseTo: la.maxRaiseTo,
    });
    if (trace?.sizing) {
      trace.sizing.fraction = fraction;
      trace.sizing.amount = amount;
    }
    return { action: { type: 'bet', amount }, reason };
  }

  private raise(
    view: DecisionView,
    la: DecisionLegalActions,
    texture: BoardTexture,
    ctx: SizingContext,
    reason: string,
    trace?: PostflopTrace,
  ): { action: { type: 'raise'; amount: number }; reason: string } {
    // Short-stack override: see bet(); a sub-20BB raise is a deliberate shove.
    if (this.effectiveStackBB(view) < 20) {
      if (trace?.sizing) {
        trace.sizing.amount = la.maxRaiseTo;
        trace.sizing.allIn = true;
      }
      return { action: { type: 'raise', amount: la.maxRaiseTo }, reason: `${reason} all-in` };
    }
    const pot = view.potOdds?.pot ?? 0;
    const currentBet = view.hand?.currentBet ?? 0;
    const fraction = chooseBetFraction(texture, ctx, postflopStreetOf(view.hand?.street));
    const amount = raiseToAmount({
      pot,
      currentBet,
      fraction,
      minRaiseTo: la.minRaiseTo,
      maxRaiseTo: la.maxRaiseTo,
    });
    if (trace?.sizing) {
      trace.sizing.fraction = fraction;
      trace.sizing.amount = amount;
    }
    return { action: { type: 'raise', amount }, reason };
  }
}
