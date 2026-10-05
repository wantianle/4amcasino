import {
  ALL_CARDS,
  evaluate5,
  evaluate7,
  handCategory,
  rankOf,
  suitOf,
  type CardId,
} from '@4am/shared';
import type { DecisionLegalActions, DecisionView } from './decisionView.js';
import { mulberry32 } from './equity.js';
import type { PolicyDecision } from './policy.js';
import { seatsInDealingOrder } from './preflopPolicy.js';
import { deriveRulesSeed } from './rulesSeed.js';
import type { RuleParams } from './ruleStyles.js';

/**
 * Rules-v1 postflop engine.
 *
 * A compact, deterministic *heuristic* (no solver / CFR / network / GTO). It is
 * built around four modern concepts, each an intentional approximation:
 *
 *  1. **MDF-derived defence** — `mdf = P/(P+B)`. We defend the top `mdf` of a
 *     uniform *unknown-opponent-combo prior* (board and hero cards removed),
 *     using the shared `@4am/shared` evaluator for hand ranking and an
 *     empirical, mid-rank percentile. A boundary-clamped linear band keeps the
 *     expected defence frequency ≈ `mdf` under that prior; it does not model
 *     the opponent's actual betting range.
 *  2. **Bet sizing** — `33% / 50% / 75% / overbet` chosen heuristically from
 *     board texture (dry/wet, high/low, connected/suited) and SPR / position /
 *     range advantage.
 *  3. **Value:bluff ratio** — approximates bluffs ≈ `f/(1+f)` × value for an
 *     `f`-pot bet.
 *  4. **Blockers** — a hand-built score preferring bluffs that block the
 *     opponent's continuing/nut range and avoiding those that block their folds.
 *
 * Exported pure helpers (`mdf`, `classifyTexture`, `chooseBetFraction`,
 * `bluffToValueRatio`, `blockerScore`, `handPercentile`, ...) carry the logic
 * and are unit-tested directly. Hand ranking is delegated entirely to the shared
 * evaluator — this module never re-implements poker hand comparison.
 */

const clamp = (x: number, lo: number, hi: number): number =>
  Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo;
const clamp01 = (x: number): number => clamp(x, 0, 1);

// ---------------------------------------------------------------------------
// hand strength / evaluation
// ---------------------------------------------------------------------------

export interface HandEval {
  /** Shared `handCategory(score)` value: 0 high card .. 8 straight flush. */
  category: number;
  /**
   * Best-hand score from the shared evaluator (`evaluate5`/`evaluate7`); the
   * single source of truth for hand ranking. Higher is better and ties compare
   * exactly (wheel, straight flush, flush/straight kickers included).
   */
  score: number;
  flushDraw: boolean;
  /** 0 none, 1 gutshot, 2 open-ended / double-gutter (draw heuristic only). */
  straightDraw: number;
  overcards: number;
}

/** Best 5-card score from 5..7 cards, using the shared evaluators. */
function bestScore(cards: readonly CardId[]): number {
  if (cards.length < 5) return 0;
  if (cards.length === 5) return evaluate5([...cards]);
  if (cards.length === 7) return evaluate7([...cards]);
  // 6 cards: best 5 of 6.
  let best = 0;
  for (let skip = 0; skip < cards.length; skip++) {
    const five = cards.filter((_, i) => i !== skip);
    const s = evaluate5(five);
    if (s > best) best = s;
  }
  return best;
}

/** Straight presence in a 13-rank count array, wheel (A2345) included. */
function hasStraight(counts: number[]): boolean {
  const p = counts.map((n) => n > 0);
  if (p[12] && p[0] && p[1] && p[2] && p[3]) return true; // A-2-3-4-5
  for (let i = 0; i + 4 < 13; i++) {
    if (p[i] && p[i + 1] && p[i + 2] && p[i + 3] && p[i + 4]) return true;
  }
  return false;
}

function straightOuts(rankCount: number[], boardLength: number): number {
  if (boardLength >= 5) return 0;
  let outs = 0;
  for (let r = 0; r < 13; r++) {
    if (rankCount[r]! > 0) continue; // the rank is already held
    const trial = rankCount.slice();
    trial[r] = trial[r]! + 1;
    if (hasStraight(trial)) outs++;
  }
  return outs;
}

/**
 * Hand strength via the shared evaluator; draw flags are a separate, clearly
 * heuristic layer (used only to pick bluff candidates, never to compare hands).
 */
export function evaluateHand(hole: readonly CardId[], board: readonly CardId[]): HandEval {
  const cards = [...hole, ...board];
  const rankCount = new Array<number>(13).fill(0);
  const suitCount = new Array<number>(4).fill(0);
  for (const card of cards) {
    rankCount[rankOf(card)] = rankCount[rankOf(card)]! + 1;
    suitCount[suitOf(card)] = suitCount[suitOf(card)]! + 1;
  }

  const score = bestScore(cards);
  const category = handCategory(score);

  const maxBoardRank = board.length ? Math.max(...board.map(rankOf)) : -1;
  const overcards = hole.filter((c) => rankOf(c) > maxBoardRank).length;
  const outs = straightOuts(rankCount, board.length);
  // A flush draw needs four to a suit *and* at least one of them in our hand.
  const flushDraw =
    board.length < 5 &&
    suitCount.some((n, s) => n === 4 && hole.some((c) => suitOf(c) === s));

  return {
    category,
    score,
    flushDraw,
    straightDraw: outs >= 2 ? 2 : outs === 1 ? 1 : 0,
    overcards,
  };
}

// ---------------------------------------------------------------------------
// board texture
// ---------------------------------------------------------------------------

export interface BoardTexture {
  maxSuit: number;
  /** Flush draw / made-flush heavy (>= 3 of a suit on the board). */
  suited: boolean;
  connected: boolean;
  paired: boolean;
  aceHigh: boolean;
  highCard: number;
  /** Connected and low — favours the caller's range. */
  lowConnected: boolean;
  wet: boolean;
}

export function classifyTexture(board: readonly CardId[]): BoardTexture {
  const suitCount = [0, 0, 0, 0];
  const seen = new Set<number>();
  let maxRank = -1;
  let minRank = 99;
  for (const card of board) {
    suitCount[suitOf(card)] = suitCount[suitOf(card)]! + 1;
    const r = rankOf(card);
    seen.add(r);
    if (r > maxRank) maxRank = r;
    if (r < minRank) minRank = r;
  }
  const ranks = [...seen].sort((a, b) => a - b);
  let adjacent = 0;
  for (let i = 1; i < ranks.length; i++) if (ranks[i]! - ranks[i - 1]! === 1) adjacent++;
  const maxSuit = Math.max(0, ...suitCount);
  const paired = seen.size < board.length;
  const suited = maxSuit >= 3;
  const connected = adjacent >= 2 || (board.length >= 3 && maxRank - minRank <= 4 && adjacent >= 1);
  const aceHigh = maxRank === 12;
  return {
    maxSuit,
    suited,
    connected,
    paired,
    aceHigh,
    highCard: maxRank,
    lowConnected: connected && maxRank <= 9,
    wet: suited || connected,
  };
}

// ---------------------------------------------------------------------------
// MDF / sizing / bluff ratio / blockers
// ---------------------------------------------------------------------------

/** Minimum defence frequency `P/(P+B)`, in [0, 1]. */
export function mdf(potBeforeBet: number, bet: number): number {
  if (!Number.isFinite(bet) || bet <= 0) return 1;
  const p = Math.max(0, Number.isFinite(potBeforeBet) ? potBeforeBet : 0);
  return p / (p + bet);
}

/** Equilibrium bluffs per value hand for a bet of `fraction` pot: `f/(1+f)`. */
export function bluffToValueRatio(fraction: number): number {
  const f = Math.max(0, Number.isFinite(fraction) ? fraction : 0);
  return f / (1 + f);
}

/** Probability a value hand fires, from the style's value-bet scale. */
export function valueBetProbability(params: RuleParams, advantage: number): number {
  return clamp01(0.55 + 0.4 * params.valueBetScale + 0.15 * advantage);
}

/** Blocker multiplier in [0.2, 2.2], centred near 1 for a neutral blocker. */
export function blockerFactor(blocker: number): number {
  return clamp(0.4 + 1.6 * clamp01(blocker), 0.2, 2.2);
}

/**
 * Approximate MDF defence probability for a bet requiring `requiredMdf`.
 *
 * A linear ramp of half-width `band` centred on `1 - requiredMdf`. The band is
 * clamped to the distance to either edge (`min(band, threshold, 1-threshold)`),
 * so integrating over a uniform percentile yields exactly `requiredMdf` even at
 * the boundaries (`requiredMdf = 0` defends nothing, `= 1` defends everything)
 * while remaining a seeded mix rather than a hard cutoff. This models *our*
 * range under a uniform unknown-combo prior, not the opponent's actual betting
 * range — it is an approximation, not an equilibrium solution.
 */
export function defendProbability(percentile: number, requiredMdf: number, band = 0.06): number {
  const required = clamp01(requiredMdf);
  const threshold = 1 - required;
  const effectiveBand = Math.min(band, threshold, 1 - threshold);
  if (effectiveBand <= 0) return percentile >= threshold ? 1 : 0;
  return clamp01((percentile - (threshold - effectiveBand)) / (2 * effectiveBand));
}

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

/**
 * Heuristic blocker score in [0, 1]: higher when our cards plausibly block the
 * opponent's continuing / nut range, lower when they block the hands they would
 * fold. A hand-built approximation (not a range-vs-range equity computation),
 * using only our hole cards and the public board.
 */
export function blockerScore(hole: readonly CardId[], board: readonly CardId[]): number {
  if (hole.length < 2 || board.length < 3) return 0;
  const boardRanks = board.map(rankOf);
  const minBoardRank = Math.min(...boardRanks);
  const maxBoardRank = Math.max(...boardRanks);
  const suitCount = [0, 0, 0, 0];
  for (const card of board) suitCount[suitOf(card)] = suitCount[suitOf(card)]! + 1;

  let score = 0;
  for (const card of hole) {
    const r = rankOf(card);
    const s = suitOf(card);
    if (r === 12) score += 0.45; // ace blocks the nuts
    else if (r === 11) score += 0.3; // king
    if (suitCount[s]! >= 2) score += 0.25; // blocks flush draws
    if (r >= minBoardRank - 1 && r <= maxBoardRank + 1) score += 0.15; // blocks straights
    if (r <= 4 && !boardRanks.includes(r)) score -= 0.2; // low junk = their folds
  }
  return clamp01(score / 1.5);
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
 * Pick one of `33% / 50% / 75% / 125% (overbet)`.
 *
 *  - wet boards: 75% (50% at low SPR, to avoid bloating with marginal equity);
 *  - dry ace-high / range-advantage boards: 33% range bet;
 *  - dry disadvantaged spots: 50%;
 *  - overbet only on dry, high-SPR, clear-advantage boards and within the
 *    style's `maxOverbetFrequency`.
 */
export function chooseBetFraction(texture: BoardTexture, ctx: SizingContext): number {
  const overbetFreq = ctx.maxOverbetFrequency ?? 0;
  if (
    !texture.wet &&
    ctx.rangeAdvantage >= 0.4 &&
    ctx.spr >= 4 &&
    overbetFreq > 0 &&
    (ctx.overbetRoll ?? 1) < overbetFreq
  ) {
    return 1.25;
  }
  if (texture.wet) return ctx.spr < 2.5 ? 0.5 : 0.75;
  if (ctx.rangeAdvantage >= 0.3) return 0.33;
  if (ctx.rangeAdvantage <= -0.3) return 0.5;
  return texture.aceHigh ? 0.33 : 0.5;
}

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

// ---------------------------------------------------------------------------
// hand percentile (empirical CDF vs all *opponent* combos: board + hero removed)
// ---------------------------------------------------------------------------

interface BoardDist {
  /** Sorted scores of every board-remaining two-card combo (includes hero cards). */
  scores: number[];
  /** Per-card sorted scores of the combos containing that card. */
  byCard: Map<CardId, number[]>;
}

const distCache = new Map<string, BoardDist>();

/** All cards not on the board and not in hero's hand. */
function unknownDeck(hole: readonly CardId[], board: readonly CardId[]): CardId[] {
  const known = new Set<CardId>([...board, ...hole]);
  return ALL_CARDS.filter((card) => !known.has(card));
}

/** Number of opponent combos in the prior: C(52 - board - hole, 2). */
export function unknownComboCount(hole: readonly CardId[], board: readonly CardId[]): number {
  const n = unknownDeck(hole, board).length;
  return (n * (n - 1)) / 2;
}

/** Number of entries `< target` (strict) or `<= target` in a sorted list. */
function countLess(list: readonly number[], target: number, strict: boolean): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const v = list[mid]!;
    const less = strict ? v < target : v <= target;
    if (less) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Board-level combo distribution, computed once per board (all C(49,2) combos
 * of the board-remaining deck, hero's cards included). Hero-card exclusion for a
 * specific hand is then handled analytically in `handPercentile`, so the
 * expensive `evaluate7` sweep is NOT repeated per decision.
 */
function boardDist(board: readonly CardId[]): BoardDist {
  const key = [...board].sort((a, b) => a - b).join(',');
  const cached = distCache.get(key);
  if (cached) return cached;
  const boardSet = new Set(board);
  const deck = ALL_CARDS.filter((card) => !boardSet.has(card));
  const scores: number[] = [];
  const byCard = new Map<CardId, number[]>();
  for (const card of deck) byCard.set(card, []);
  for (let i = 0; i < deck.length; i++) {
    for (let j = i + 1; j < deck.length; j++) {
      const a = deck[i]!;
      const b = deck[j]!;
      const s = bestScore([a, b, ...board]);
      scores.push(s);
      byCard.get(a)!.push(s);
      byCard.get(b)!.push(s);
    }
  }
  scores.sort((a, b) => a - b);
  for (const list of byCard.values()) list.sort((a, b) => a - b);
  if (distCache.size > 256) distCache.clear();
  const dist = { scores, byCard };
  distCache.set(key, dist);
  return dist;
}

/**
 * Approximate percentile of our hand versus a uniform prior over all opponent
 * combos with **both** board and hero's cards removed (C(47,2) = 1081 on a
 * flop). Ties are counted with their mid-rank so the value is unbiased under
 * equal scores. Derived from the per-board distribution by subtracting the
 * combos that use either of hero's cards (their shared combo added back once).
 */
export function handPercentile(hole: readonly CardId[], board: readonly CardId[]): number {
  if (hole.length < 2 || board.length < 3) return 0.5;
  const [a, b] = hole;
  if (a === undefined || b === undefined) return 0.5;
  const total = unknownComboCount(hole, board);
  if (total <= 0) return 0.5;
  const dist = boardDist(board);
  const s = bestScore([...hole, ...board]);

  const aList = dist.byCard.get(a) ?? [];
  const bList = dist.byCard.get(b) ?? [];
  const less = countLess(dist.scores, s, true) - countLess(aList, s, true) - countLess(bList, s, true);
  const equalOrLess =
    countLess(dist.scores, s, false) -
    countLess(aList, s, false) -
    countLess(bList, s, false) +
    1; // the {a,b} combo equals our score and is counted in both card lists
  const equal = equalOrLess - less;
  return (less + 0.5 * equal) / total;
}

// ---------------------------------------------------------------------------
// positional / aggression helpers
// ---------------------------------------------------------------------------

export function heroWasAggressor(view: DecisionView): boolean {
  const mySeat = view.hand?.mySeat ?? view.me?.seat ?? null;
  if (mySeat === null) return false;
  const pre = view.actionHistory.filter((a) => a.street === 'preflop');
  for (let i = pre.length - 1; i >= 0; i--) {
    const a = pre[i]!;
    if (a.action.type === 'bet' || a.action.type === 'raise') return a.seat === mySeat;
  }
  return false;
}

/** True when hero is the last active seat to act postflop (i.e. on the button). */
export function heroInPosition(view: DecisionView): boolean {
  const mySeat = view.hand?.mySeat ?? view.me?.seat ?? null;
  if (mySeat === null) return false;
  const order = seatsInDealingOrder(view);
  if (order.length === 0) return false;
  const active = order.filter(
    (seat) => seat === mySeat || view.opponents.some((o) => o.seat === seat && !o.folded),
  );
  return active.length > 0 && active[active.length - 1] === mySeat;
}

// ---------------------------------------------------------------------------
// policy
// ---------------------------------------------------------------------------

function normalizeLegal(la: DecisionLegalActions): DecisionLegalActions {
  const canCall = la.canCall && la.callAmount > 0;
  const canCheck = la.canCheck || !canCall;
  const canRaise =
    (la.canBet || la.canRaise) &&
    la.minRaiseTo >= 1 &&
    la.maxRaiseTo >= la.minRaiseTo &&
    la.maxRaiseTo > 0;
  return { ...la, canCheck, canCall, canRaise, canBet: canRaise && la.canBet };
}

export interface PostflopOptions {
  params: RuleParams;
  /** Base seed; the per-decision seed is `deriveRulesSeed(seed, view)`. */
  seed?: number;
}

/** A legitimate, always-legal fallback action. */
function onlyLegal(la: DecisionLegalActions, reason: string): PolicyDecision {
  if (la.canCheck) return { action: { type: 'check' }, reason };
  if (la.canCall) return { action: { type: 'call' }, reason };
  return { action: { type: 'fold' }, reason };
}

export class PostflopPolicy {
  readonly name = 'rules-v1-postflop';
  private readonly params: RuleParams;
  private readonly seed: number;

  constructor(options: PostflopOptions) {
    this.params = options.params;
    this.seed = options.seed ?? 0x9e3779b9;
  }

  decide(view: DecisionView): PolicyDecision {
    const raw = view.legalActions;
    if (!raw) throw new Error(`${this.name} asked to act out of turn`);
    const la = normalizeLegal(raw);
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
    const potBefore = Math.max(0, (view.potOdds?.pot ?? 0) - call);

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
      potBefore,
      call,
      rng,
    );
  }

  private spr(view: DecisionView): number {
    const pot = view.potOdds?.pot ?? 0;
    if (pot <= 0) return 10;
    const myStack = view.me?.stack ?? 0;
    const activeStacks = view.opponents
      .filter((o) => !o.folded && !o.allIn)
      .map((o) => o.stack);
    const oppMax = activeStacks.length ? Math.max(...activeStacks) : 0;
    const effective = oppMax > 0 ? Math.min(myStack, oppMax) : myStack;
    return effective / pot;
  }

  private effectiveStackBB(view: DecisionView): number {
    const bb = view.room?.bb && view.room.bb > 0 ? view.room.bb : 1;
    const myStack = view.me?.stack ?? 0;
    const activeStacks = view.opponents
      .filter((o) => !o.folded && !o.allIn)
      .map((o) => o.stack);
    const oppMax = activeStacks.length ? Math.max(...activeStacks) : 0;
    return (oppMax > 0 ? Math.min(myStack, oppMax) : myStack) / bb;
  }

  private exploitMultiplier(view: DecisionView): number {
    const bySeat = new Map(view.sessionMemory.opponents.map((o) => [o.seat, o]));
    let vpip = 0;
    let pfr = 0;
    let n = 0;
    for (const o of view.opponents) {
      if (o.folded) continue;
      const stats = bySeat.get(o.seat);
      if (!stats || stats.sampleHands < 10) continue;
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
    const value = ev.category >= 3 || percentile >= 0.8;
    const bluffCandidate = !value && percentile < 0.6 && (draw || blocker >= 0.4);

    if (la.canBet) {
      const sizingCtx: SizingContext = {
        spr,
        inPosition: heroInPosition(view),
        rangeAdvantage: adv,
        overbetRoll: rng(),
        maxOverbetFrequency: this.params.maxOverbetFrequency,
      };
      if (value && rng() < valueBetProbability(this.params, adv)) {
        return this.bet(view, la, texture, sizingCtx, `rules-v1 postflop value (pct ${percentile.toFixed(2)})`);
      }
      if (bluffCandidate) {
        const fraction = chooseBetFraction(texture, sizingCtx);
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
    potBefore: number,
    call: number,
    rng: () => number,
  ): PolicyDecision {
    const required = mdf(potBefore, call);
    // Defence is decided purely by the (boundary-corrected) MDF mix; a strong
    // hand with a high percentile already defends with probability 1, so value
    // never folds while the realised defence frequency still tracks `required`.
    const defendChance = defendProbability(percentile, required);
    const defend = rng() < defendChance;
    if (!defend) {
      return { action: { type: 'fold' }, reason: `rules-v1 postflop fold below MDF (pct ${percentile.toFixed(2)})` };
    }

    const sizingCtx: SizingContext = {
      spr,
      inPosition: heroInPosition(view),
      rangeAdvantage: adv,
      overbetRoll: rng(),
      maxOverbetFrequency: this.params.maxOverbetFrequency,
    };

    const strong = ev.category >= 3 || percentile >= 0.85;
    if (strong && la.canRaise && rng() < 0.6) {
      return this.raise(view, la, texture, sizingCtx, `rules-v1 postflop value raise (pct ${percentile.toFixed(2)})`);
    }

    const blocker = blockerScore(hole, board);
    const draw = ev.flushDraw || ev.straightDraw >= 1;
    if (
      la.canRaise &&
      (draw || blocker >= 0.5) &&
      rng() < 0.35 * this.aggressionMultiplier(view, blocker, active)
    ) {
      return this.raise(view, la, texture, sizingCtx, `rules-v1 postflop semibluff raise (blocker ${blocker.toFixed(2)})`);
    }
    return { action: { type: 'call' }, reason: `rules-v1 postflop MDF call (pct ${percentile.toFixed(2)})` };
  }

  private bet(
    view: DecisionView,
    la: DecisionLegalActions,
    texture: BoardTexture,
    ctx: SizingContext,
    reason: string,
  ): { action: { type: 'bet'; amount: number }; reason: string } {
    // Sub-20BB: an unopened bet is a deliberate shove to the stack, matching the
    // raise() convention (and the shared engine's "bet up to stack" rule).
    if (this.effectiveStackBB(view) < 20) {
      return { action: { type: 'bet', amount: la.maxRaiseTo }, reason: `${reason} all-in` };
    }
    const pot = view.potOdds?.pot ?? 0;
    const fraction = chooseBetFraction(texture, ctx);
    const raw = Math.round(pot * fraction);
    const amount = clamp(raw, la.minRaiseTo, la.maxRaiseTo);
    return { action: { type: 'bet', amount: Math.max(1, amount) }, reason };
  }

  private raise(
    view: DecisionView,
    la: DecisionLegalActions,
    texture: BoardTexture,
    ctx: SizingContext,
    reason: string,
  ): { action: { type: 'raise'; amount: number }; reason: string } {
    if (this.effectiveStackBB(view) < 20) {
      return { action: { type: 'raise', amount: la.maxRaiseTo }, reason: `${reason} all-in` };
    }
    const pot = view.potOdds?.pot ?? 0;
    const currentBet = view.hand?.currentBet ?? 0;
    const fraction = chooseBetFraction(texture, ctx);
    const minDelta = Math.max(1, la.minRaiseTo - currentBet);
    const target = currentBet + Math.max(minDelta, Math.round(pot * fraction));
    const amount = clamp(target, la.minRaiseTo, la.maxRaiseTo);
    return { action: { type: 'raise', amount }, reason };
  }
}
