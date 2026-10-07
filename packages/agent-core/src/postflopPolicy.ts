import { HAND_CATEGORY, type CardId } from '@4am/shared';
import {
  DEFAULT_SIZE_STREET,
  POSTFLOP_SIZE_GRIDS,
  nearestStreetSize,
  postflopStreetOf,
  streetSupportsOverbet,
  type PostflopStreet,
} from './betSizing.js';
import type { DecisionLegalActions, DecisionView } from './decisionView.js';
import { estimateEquity, mulberry32 } from './equity.js';
import type { PolicyDecision } from './policy.js';
import { deriveRulesSeed } from './rulesSeed.js';
import type { RuleParams } from './ruleStyles.js';
import { normalizeLegalActions } from './legalActions.js';
import { betAmount, guaranteedLegalAction, raiseToAmount } from './actionAdapter.js';
import { bluffToValueRatio, defendProbability, resolveFacingBetPrice } from './potPrice.js';
import {
  deriveTableContext,
  heroInPosition,
  heroWasAggressor,
  postflopActionOrder,
} from './tableContext.js';
import { clamp, clamp01 } from './postflopMath.js';
import { evaluateHand, type HandEval } from './postflopStrength.js';
import { classifyTexture, type BoardTexture } from './postflopTexture.js';
import { blockerScore, isExposedOverpair, madeHandSuppressedByBoard } from './postflopBlockers.js';
import { DEFAULT_P2, type P2Options } from './postflopP2.js';
import { handPercentile } from './postflopPercentile.js';
import { facingBetMargin, facingBetSamples, facingVillainRange } from './postflopVillain.js';

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
// value-bet / bluff / blocker probabilities (sizing)
// ---------------------------------------------------------------------------

// `mdf` and `bluffToValueRatio` moved to `potPrice.ts` (re-exported above).

/** Probability a value hand fires, from the style's value-bet scale. */
export function valueBetProbability(params: RuleParams, advantage: number): number {
  return clamp01(0.55 + 0.4 * params.valueBetScale + 0.15 * advantage);
}

/** Blocker multiplier in [0.2, 2.2], centred near 1 for a neutral blocker. */
export function blockerFactor(blocker: number): number {
  return clamp(0.4 + 1.6 * clamp01(blocker), 0.2, 2.2);
}

// `defendProbability` moved to `potPrice.ts` (re-exported above).

/**
 * Heuristic bluff bet probability for a bet of `fraction` pot: approximates the
 * MDF-consistent bluff:value ratio `f/(1+f)` times the value-bet probability,
 * scaled by style bluff, blocker, multiway and (bounded) exploit multipliers.
 * Not an equilibrium computation.
 */
export function bluffBetProbability(
  params: RuleParams,
  fraction: number,
  advantage: number,
  blocker: number,
  multiwayMultiplier = 1,
  exploit = 1,
): number {
  return clamp01(
    bluffToValueRatio(fraction) *
      valueBetProbability(params, advantage) *
      params.bluffScale *
      blockerFactor(blocker) *
      multiwayMultiplier *
      exploit,
  );
}


export interface SizingContext {
  spr: number;
  inPosition: boolean;
  rangeAdvantage: number;
  /** Seeded roll used only for the overbet gate. */
  overbetRoll?: number;
  maxOverbetFrequency?: number;
}

/**
 * Pick the bot's own bet size from the **street's** grid.
 *
 *  - wet boards: 75% (50% at low SPR, to avoid bloating with marginal equity);
 *  - dry ace-high / range-advantage boards: 33% range bet;
 *  - dry disadvantaged spots: 50%;
 *  - overbet only on dry, high-SPR, clear-advantage boards and within the
 *    style's `maxOverbetFrequency` — mapped to the top of the street's grid
 *    (150% on turn/river).
 *
 * The flop standard has **no overbet tier**, so `maxOverbetFrequency` is
 * ignored on `street === 'flop'` (see {@link streetSupportsOverbet}); the flop
 * top legal size is 75%.
 *
 * The heuristic picks a raw fraction and snaps it to the nearest point the
 * street actually allows (e.g. a 0.5-pot pick on the flop becomes 0.33), so the
 * returned value is always a legal size for `street`. Turn and river differ by
 * design: turn has no 33% tier.
 */
export function chooseBetFraction(
  texture: BoardTexture,
  ctx: SizingContext,
  street: PostflopStreet = DEFAULT_SIZE_STREET,
): number {
  const grid = POSTFLOP_SIZE_GRIDS[street];
  const overbetFreq = ctx.maxOverbetFrequency ?? 0;
  if (
    streetSupportsOverbet(street) &&
    !texture.wet &&
    ctx.rangeAdvantage >= 0.4 &&
    ctx.spr >= 4 &&
    overbetFreq > 0 &&
    (ctx.overbetRoll ?? 1) < overbetFreq
  ) {
    return grid[grid.length - 1]!;
  }
  let raw: number;
  if (texture.wet) raw = ctx.spr < 2.5 ? 0.5 : 0.75;
  else if (ctx.rangeAdvantage >= 0.3) raw = 0.33;
  else if (ctx.rangeAdvantage <= -0.3) raw = 0.5;
  else raw = texture.aceHigh ? 0.33 : 0.5;
  return nearestStreetSize(raw, grid);
}

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

/** Heuristic range/nut-advantage score in [-1, 1] (positive = hero favours). */
export function rangeAdvantage(input: {
  heroWasAggressor: boolean;
  inPosition: boolean;
  texture: BoardTexture;
}): number {
  let a = 0;
  if (input.heroWasAggressor) a += 0.4;
  if (input.inPosition) a += 0.2;
  if (input.texture.aceHigh) a += 0.25;
  if (input.texture.lowConnected) a -= 0.3;
  if (!input.heroWasAggressor && !input.inPosition) a -= 0.2;
  return clamp(a, -1, 1);
}

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

// P2 toggle type + frozen default moved into a neutral leaf module (the signal
// layer reads `DEFAULT_P2`, the policy reads both); `P2_ALL_OFF` stays here.
export { DEFAULT_P2, type P2Options } from './postflopP2.js';

/**
 * Frozen explicit all-off configuration: the pre-P2 decision path
 * (`sizeGrid` / `buckets` both `false`). With {@link DEFAULT_P2} now defaulting
 * both on this is the named **kill-switch / A/B control**, and it is no longer
 * identical to the default. It is kept as a named constant because callers
 * (server env `FOURAM_P2_ALL_OFF`, the eval harness) and tests reference it
 * explicitly, so the one-import rollback cannot drift from the `DEFAULT_P2`
 * shape. Pass it as `new PostflopPolicy({ ..., p2: P2_ALL_OFF })`.
 */
export const P2_ALL_OFF: Readonly<P2Options> = Object.freeze({
  sizeGrid: false,
  buckets: false,
});

// ---------------------------------------------------------------------------
// positional / aggression helpers
// ---------------------------------------------------------------------------

// `heroWasAggressor` / `heroInPosition` moved to `tableContext.ts`, where
// `heroInPosition` uses the postflop action order (`postflopActionOrder`) rather
// than the preflop dealing order, so heads-up IP/OOP stays correct. Both are
// re-exported above for existing importers.

/**
 * Seat of the aggressor hero is responding to: the **last** preflop bet/raise in
 * the observed history, or `null` when none is visible. For an opening decision
 * that is the opener; for a 4-bet it is the 3-bettor — i.e. the reference
 * opponent for preflop IP/OOP sizing.
 */
export function lastPreflopRaiserSeat(view: DecisionView): number | null {
  const pre = view.actionHistory.filter((a) => a.street === 'preflop');
  for (let i = pre.length - 1; i >= 0; i--) {
    const a = pre[i]!;
    if (a.action.type === 'bet' || a.action.type === 'raise') return a.seat;
  }
  return null;
}

/**
 * True when hero acts **after** the given opponent in **postflop** order, i.e.
 * hero is in position relative to that opponent. This is the position that
 * matters for the preflop 3-bet / 4-bet sizing standard (smaller in position,
 * larger out of position, to compensate for playing later streets OOP). Unlike
 * {@link heroInPosition} (which asks whether hero is last to act among *all*
 * active players), this compares hero to one specific opponent, so a third
 * active player behind hero does not flip the answer, and an all-in third party
 * is irrelevant.
 *
 * Uses {@link postflopActionOrder}, **not** the preflop dealing order: heads-up
 * they are opposites (button/SB first preflop, last postflop), so reusing the
 * dealing-order index would mark the BB as in position. Unknown hero /
 * opponent, or an opponent not present in the order, falls back to `false`
 * (treated as out of position, the larger sizing) rather than guessing — a
 * conservative, risk-averse default, not a claim that hero *is* OOP.
 */
export function heroIsIPToOpener(view: DecisionView, opponentSeat: number | null): boolean {
  const mySeat = view.hand?.mySeat ?? view.me?.seat ?? null;
  if (mySeat === null || opponentSeat === null || opponentSeat === mySeat) return false;
  const order = postflopActionOrder(view);
  const myIdx = order.indexOf(mySeat);
  const oppIdx = order.indexOf(opponentSeat);
  if (myIdx < 0 || oppIdx < 0) return false;
  return myIdx > oppIdx;
}

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
}

/** A legitimate, always-legal fallback action. */
function onlyLegal(la: DecisionLegalActions, reason: string): PolicyDecision {
  return { action: guaranteedLegalAction(la), reason };
}

export class PostflopPolicy {
  readonly name = 'rules-v1-postflop';
  private readonly params: RuleParams;
  private readonly seed: number;
  private readonly p2: P2Options;

  constructor(options: PostflopOptions) {
    this.params = options.params;
    this.seed = options.seed ?? 0x9e3779b9;
    this.p2 = { ...DEFAULT_P2, ...options.p2 };
  }

  decide(view: DecisionView): PolicyDecision {
    const raw = view.legalActions;
    if (!raw) throw new Error(`${this.name} asked to act out of turn`);
    const la = normalizeLegalActions(raw);
    const hole = view.hand?.myCards ?? [];
    const board = view.hand?.board ?? [];
    if (!view.hand || view.hand.street === 'preflop' || hole.length < 2 || board.length < 3) {
      return onlyLegal(la, 'rules-v1 postflop: no card context');
    }

    const rng = mulberry32(deriveRulesSeed(this.seed, view));
    const ev = evaluateHand(hole, board);
    const percentile = handPercentile(hole, board);
    const texture = classifyTexture(board);
    const inPosition = heroInPosition(view);
    const adv = rangeAdvantage({
      heroWasAggressor: heroWasAggressor(view),
      inPosition,
      texture,
    });
    const spr = this.spr(view);
    const active = Math.max(1, view.opponents.filter((o) => !o.folded).length);
    const call = la.callAmount;

    if (la.canCheck) {
      return this.decideUnopened(view, la, hole, board, ev, percentile, texture, adv, spr, rng);
    }
    return this.decideFacingBet(
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
      rng,
    );
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
    rng: () => number,
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

    if (la.canBet) {
      const sizingCtx: SizingContext = {
        spr,
        inPosition: heroInPosition(view),
        rangeAdvantage: adv,
        overbetRoll: rng(),
        maxOverbetFrequency: this.params.maxOverbetFrequency,
      };
      if (value && rng() < valueBetProbability(this.params, adv) * (exposedOverpair ? 0.6 : 1)) {
        return this.bet(view, la, texture, sizingCtx, `rules-v1 postflop value (pct ${percentile.toFixed(2)}${exposedOverpair ? ', no-suit overpair' : ''})`);
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
        if (rng() < prob) {
          return this.bet(view, la, texture, sizingCtx, `rules-v1 postflop bluff (blocker ${blocker.toFixed(2)})`);
        }
      }
    }
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
    rng: () => number,
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
    try {
      const knownValid = new Set([...hole, ...board]).size === hole.length + board.length;
      if (knownValid) {
        const estimate = estimateEquity({
          hole,
          board,
          opponents: active,
          samples,
          seed: deriveRulesSeed(this.seed, view),
          villainRange: facingVillainRange(view, hole, potBefore, call, this.p2),
        });
        equity = Number.isFinite(estimate.equity) ? clamp01(estimate.equity) : 0;
      }
    } catch {
      equity = requiredEquity;
    }

    let defend: boolean;
    if (!priceTrusted) {
      // Conservative neutral path: the price mirror is unusable, so never fold
      // solely on its account. Defend by hand percentile against the MDF of the
      // authoritative pot/call price (or a neutral 0.5 when the pot is bad too).
      defend = rng() < defendProbability(percentile, required);
    } else {
      // The band is the estimator's own ~2 standard errors, so a decision only
      // counts as clear when the observed edge exceeds sampling noise; inside
      // the band the former MDF/percentile mix still sets the frequency.
      const margin = facingBetMargin(equity, samples);
      if (equity > requiredEquity + margin) {
        defend = true;
      } else if (equity < requiredEquity - margin) {
        defend = false;
      } else {
        defend = rng() < defendProbability(percentile, required);
      }
    }
    if (!defend) {
      return {
        action: { type: 'fold' },
        reason: `rules-v1 postflop fold (equity ${equity.toFixed(2)} < pot odds ${requiredEquity.toFixed(2)}, pct ${percentile.toFixed(2)})`,
      };
    }

    const sizingCtx: SizingContext = {
      spr,
      inPosition: heroInPosition(view),
      rangeAdvantage: adv,
      overbetRoll: rng(),
      maxOverbetFrequency: this.params.maxOverbetFrequency,
    };

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
    if (strong && la.canRaise && rng() < (exposedOverpair ? 0.2 : 0.6)) {
      return this.raise(view, la, texture, sizingCtx, `rules-v1 postflop value raise (pct ${percentile.toFixed(2)}, eq ${equity.toFixed(2)}${exposedOverpair ? ', no-suit overpair' : ''})`);
    }

    const blocker = blockerScore(hole, board);
    const draw = ev.flushDraw || ev.straightDraw >= 1;
    if (
      la.canRaise &&
      (draw || blocker >= 0.5) &&
      rng() < 0.35 * (exposedOverpair ? 0.5 : 1) * this.aggressionMultiplier(view, blocker, active)
    ) {
      return this.raise(view, la, texture, sizingCtx, `rules-v1 postflop semibluff raise (blocker ${blocker.toFixed(2)})`);
    }
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
  ): { action: { type: 'bet'; amount: number }; reason: string } {
    // Short-stack override: below 20BB an unopened bet is a deliberate shove to
    // the stack, taking precedence over every standard grid size below. It
    // matches the raise() convention (and the shared engine's "bet up to stack"
    // rule), so a short stack never gets a "standard size, capped" instead.
    if (this.effectiveStackBB(view) < 20) {
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
    return { action: { type: 'bet', amount }, reason };
  }

  private raise(
    view: DecisionView,
    la: DecisionLegalActions,
    texture: BoardTexture,
    ctx: SizingContext,
    reason: string,
  ): { action: { type: 'raise'; amount: number }; reason: string } {
    // Short-stack override: see bet(); a sub-20BB raise is a deliberate shove.
    if (this.effectiveStackBB(view) < 20) {
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
    return { action: { type: 'raise', amount }, reason };
  }
}
