import type { DecisionView } from './decisionView.js';
import type { RuleParams } from './ruleStyles.js';
import {
  BB_DEFEND,
  CALL_VS_OPEN,
  COLD_3BET_BLUFF,
  COLD_3BET_BLUFF_WEIGHT,
  COLD_3BET_COLD,
  COLD_3BET_VALUE,
  FACING_3BET_4BET,
  FACING_3BET_CALL,
  FACING_4BET_PLUS,
  ISO_RANGES,
  RFI_MARGINAL,
  RFI_RANGES,
  SHORT_JAM_RANGES,
  positionGroup,
  type Position,
  type PositionGroup,
} from './preflopRanges.js';
import {
  compileRangeMix,
  handClassForCards,
  mixFor,
  parseRange,
  type ActionMix,
  type CompiledMix,
  type HandClassInfo,
  type RangeEntry,
} from './rangeParser.js';

/**
 * Rules-v1 preflop policy: turn a `DecisionView` into a preflop spot, look the
 * hand class up in the baseline charts, and roll the seeded RNG to resolve the
 * mixed frequencies. Pure and deterministic: the only randomness comes from the
 * caller-supplied `rand` (a `mulberry32` seeded from the view + base seed in
 * `rulePolicy.ts`).
 *
 * Two invariants the gate review demanded and this module now enforces:
 *   1. A **value** raise is a continuation: style/context discounts may move
 *      probability from raise to call, but never to fold.
 *   2. Missing history is never read as "nobody acted": a public `currentBet`
 *      above the big blind forces a conservative facing-a-raise branch.
 */

/** Coarse exported situation (the four the spec asks for). */
export type PreflopSituation = 'unopened' | 'facingOpen' | 'facing3Bet' | 'multiway';
export type PreflopIntent = 'raise' | 'call' | 'fold';

/** Finer-grained internal spot, so the four exported situations stay simple. */
export type PreflopSpot =
  | 'unopened'
  | 'limped'
  | 'facingOpen'
  | 'facingOpenMultiway'
  | 'facing3Bet' // hero opened, now facing a 3-bet
  | 'facing3BetCold' // hero has not acted, faces an open + a 3-bet
  | 'facing4BetPlus'; // a fourth or higher raise

export interface PreflopContext {
  position: Position;
  positionGroup: PositionGroup;
  /**
   * Effective stack in big blinds: `min(hero stack, largest live opponent
   * stack) / bb`. This is the depth that governs commitment/stack-off.
   */
  stackBB: number;
  /** Hero's own remaining stack in big blinds (diagnostics / sizing). */
  myStackBB: number;
  situation: PreflopSituation;
  spot: PreflopSpot;
  /** Position of the first raiser, or null when unknown / incomplete history. */
  opener: Position | null;
  openerGroup: PositionGroup | null;
  /** Number of preflop bets/raises observed (implied opens included). */
  raises: number;
  /** Number of preflop calls observed. */
  callers: number;
  /** True when the hero appears as a preflop raiser in the observed history. */
  heroRaised: boolean;
  historyComplete: boolean;
  multiway: boolean;
  limped: boolean;
  /** `currentBet > bb` with no observed raise: an open we did not see. */
  incompleteOpen: boolean;
}

/**
 * Dealing-order seat table (index 0 = small blind) and the **short-handed
 * anchor mapping**. Each short seat reuses the chart of the full-ring position
 * named in the table; positions not named are simply absent. So a 6-max game
 * plays the UTG/HJ/CO/BTN charts, and heads-up plays the SB (button) and BB
 * charts.
 */
const POSITIONS_BY_COUNT: Record<number, Position[]> = {
  2: ['SB', 'BB'],
  3: ['SB', 'BB', 'BTN'],
  4: ['SB', 'BB', 'CO', 'BTN'],
  5: ['SB', 'BB', 'UTG', 'CO', 'BTN'],
  6: ['SB', 'BB', 'UTG', 'HJ', 'CO', 'BTN'],
  7: ['SB', 'BB', 'UTG', 'UTG1', 'HJ', 'CO', 'BTN'],
  8: ['SB', 'BB', 'UTG', 'UTG1', 'MP', 'HJ', 'CO', 'BTN'],
  9: ['SB', 'BB', 'UTG', 'UTG1', 'MP', 'LJ', 'HJ', 'CO', 'BTN'],
};

/**
 * Approximate the dealing order when the view does not carry `seatOrder`:
 * sort the known seats ascending and rotate so the first seat after the button
 * comes first. Heads-up is special-cased: the button **is** the small blind and
 * acts first preflop, so the order is `[button, other]`, not `[other, button]`.
 * TODO(rules-v2): drop this once every caller populates `DecisionView.seatOrder`.
 */
function fallbackSeatOrder(view: DecisionView): number[] {
  const seats: number[] = [];
  if (view.me) seats.push(view.me.seat);
  for (const o of view.opponents) seats.push(o.seat);
  seats.sort((a, b) => a - b);
  const button = view.hand?.buttonSeat;
  if (button === undefined) return seats;
  const btnIdx = seats.indexOf(button);
  if (btnIdx < 0) return seats;
  if (seats.length === 2) {
    const other = seats[1 - btnIdx]!;
    return [seats[btnIdx]!, other];
  }
  return [...seats.slice(btnIdx + 1), ...seats.slice(0, btnIdx + 1)];
}

export function seatsInDealingOrder(view: DecisionView): number[] {
  const supplied = view.seatOrder;
  if (supplied && supplied.length >= 2) return [...supplied];
  return fallbackSeatOrder(view);
}

function positionForSeat(seat: number, seatOrder: number[]): Position {
  const table = POSITIONS_BY_COUNT[seatOrder.length];
  const idx = seatOrder.indexOf(seat);
  if (table && idx >= 0 && idx < table.length) return table[idx]!;
  // Fallback for an unknown table size: approximate by dealing slot.
  return idx === 0 ? 'SB' : idx === 1 ? 'BB' : 'BTN';
}

/** Classify the preflop spot / position / stack from the view. */
export function derivePreflopContext(view: DecisionView): PreflopContext {
  const hand = view.hand;
  const me = view.me;
  const seatOrder = seatsInDealingOrder(view);
  const mySeat = hand?.mySeat ?? me?.seat ?? -1;
  const position = positionForSeat(mySeat, seatOrder);
  const bb = view.room?.bb && view.room.bb > 0 ? view.room.bb : 1;
  const myStack = me?.stack ?? bb;

  // "Active" = still able to put more chips in: not folded and not all-in.
  // Folded opponents cannot contest and all-in opponents cannot call a raise,
  // so neither caps the effective stack. With no active opponent the only risk
  // is our own stack (the remaining action is calling an all-in), so we fall
  // back to `myStack` rather than to 0.
  const activeOpponents = view.opponents.filter((o) => !o.folded && !o.allIn);
  const oppMax = activeOpponents.length
    ? Math.max(...activeOpponents.map((o) => o.stack))
    : 0;
  const effectiveStack = oppMax > 0 ? Math.min(myStack, oppMax) : myStack;

  const actions = view.actionHistory.filter((a) => a.street === 'preflop');
  const observedRaises = actions.filter(
    (a) => a.action.type === 'bet' || a.action.type === 'raise',
  ).length;
  const callers = actions.filter((a) => a.action.type === 'call').length;
  const heroRaised = actions.some(
    (a) =>
      a.seat === mySeat && (a.action.type === 'bet' || a.action.type === 'raise'),
  );

  // Public state can prove an open even when the frames were missed: a raise
  // always exceeds the big blind. Never treat that as unopened.
  const currentBet = hand?.currentBet ?? 0;
  const incompleteOpen = observedRaises === 0 && currentBet > bb;
  const raises = observedRaises + (incompleteOpen ? 1 : 0);

  const firstRaise = actions.find(
    (a) => a.action.type === 'bet' || a.action.type === 'raise',
  );
  const opener = firstRaise ? positionForSeat(firstRaise.seat, seatOrder) : null;

  let spot: PreflopSpot;
  if (raises === 0) {
    spot = callers === 0 ? 'unopened' : 'limped';
  } else if (raises === 1) {
    spot = callers >= 1 ? 'facingOpenMultiway' : 'facingOpen';
  } else if (heroRaised) {
    spot = raises >= 3 ? 'facing4BetPlus' : 'facing3Bet';
  } else {
    spot = raises >= 3 ? 'facing4BetPlus' : 'facing3BetCold';
  }

  // Partial history with at least one observed raise: a hidden higher raise
  // cannot be ruled out, so assume the worst about how deep the auction is
  // rather than honoring the (possibly stale) observed level. This routes to
  // the tighter cold/4-bet charts.
  if (!view.historyComplete && observedRaises >= 1) {
    spot = !heroRaised
      ? observedRaises >= 2
        ? 'facing4BetPlus'
        : 'facing3BetCold'
      : 'facing4BetPlus';
  }

  let situation: PreflopSituation;
  if (spot === 'unopened' || spot === 'limped') situation = 'unopened';
  else if (spot === 'facingOpen') situation = 'facingOpen';
  else if (spot === 'facingOpenMultiway') situation = 'multiway';
  else situation = 'facing3Bet';

  return {
    position,
    positionGroup: positionGroup(position),
    stackBB: effectiveStack / bb,
    myStackBB: myStack / bb,
    situation,
    spot,
    opener,
    openerGroup: opener ? positionGroup(opener) : null,
    raises,
    callers,
    heroRaised,
    historyComplete: view.historyComplete,
    multiway:
      spot === 'facingOpenMultiway' ||
      (spot === 'unopened' && callers >= 1) ||
      (spot === 'limped' && callers >= 2),
    limped: spot === 'limped',
    incompleteOpen,
  };
}

/**
 * Compiled mixes are pure functions of the charts, so memoise them per
 * spot/position/opener instead of re-parsing the range strings on every
 * decision. The returned maps are read-only to callers.
 */
const mixCache = new Map<string, Map<string, CompiledMix>>();

function buildMix(ctx: PreflopContext): Map<string, CompiledMix> {
  const openerKey =
    ctx.spot === 'unopened' || ctx.spot === 'limped' ? '' : (ctx.openerGroup ?? 'EP');
  const cacheKey = `${ctx.spot}|${ctx.position}|${openerKey}`;
  const cached = mixCache.get(cacheKey);
  if (cached) return cached;

  let mix: Map<string, CompiledMix>;
  switch (ctx.spot) {
    case 'unopened': {
      const base = RFI_RANGES[ctx.position];
      const marginal = RFI_MARGINAL[ctx.position];
      const entries: RangeEntry[] = [];
      if (base) entries.push({ range: base, action: 'raise', weight: 1, role: 'value' });
      if (marginal) entries.push({ range: marginal, action: 'raise', weight: 1, role: 'marginal' });
      mix = compileRangeMix(entries);
      break;
    }
    case 'limped':
      mix = compileRangeMix([
        { range: ISO_RANGES[ctx.positionGroup], action: 'raise', weight: 1, role: 'value' },
      ]);
      break;
    case 'facing4BetPlus':
      mix = compileRangeMix(FACING_4BET_PLUS);
      break;
    case 'facing3Bet':
      mix = compileRangeMix([...FACING_3BET_4BET, ...FACING_3BET_CALL]);
      break;
    case 'facing3BetCold':
      mix = compileRangeMix(COLD_3BET_COLD);
      break;
    default: {
      // facingOpen / facingOpenMultiway: 3-bet/call versus a single open.
      const openerGroup: PositionGroup = ctx.openerGroup ?? 'EP'; // conservative when unknown
      const entries: RangeEntry[] = [
        { range: COLD_3BET_VALUE[openerGroup], action: 'raise', weight: 1, role: 'value' },
        {
          range: COLD_3BET_BLUFF[openerGroup],
          action: 'raise',
          weight: COLD_3BET_BLUFF_WEIGHT,
          role: 'bluff',
        },
      ];
      if (ctx.positionGroup === 'BB') {
        entries.push(...BB_DEFEND[openerGroup]);
      } else {
        entries.push({ range: CALL_VS_OPEN[ctx.positionGroup], action: 'call', weight: 1 });
      }
      mix = compileRangeMix(entries);
      break;
    }
  }
  mixCache.set(cacheKey, mix);
  return mix;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/**
 * Stack-depth tightening (§2.1): the >=80BB charts are the baseline; 40–79BB
 * trims the flat-call range slightly and 20–39BB more so. Below 20BB there is no
 * flatting at all (see `shortStackMix`).
 */
function callDiscount(stackBB: number): number {
  if (stackBB < 40) return 0.5;
  if (stackBB < 80) return 0.85;
  return 1;
}

/** Premium flat-range hands that keep jamming when flatting is impossible. */
const SHOVE_HANDS = new Set(['AA', 'KK', 'QQ', 'JJ', 'TT', 'AKs', 'AKo', 'AQs']);

/** Short-stack open-jam sets, parsed once per position group. */
const shortJamCache = new Map<PositionGroup, Set<string>>();

function shortJamSet(group: PositionGroup): Set<string> {
  let set = shortJamCache.get(group);
  if (!set) {
    set = parseRange(SHORT_JAM_RANGES[group]).keys;
    shortJamCache.set(group, set);
  }
  return set;
}

/**
 * <20BB: there is no flatting.
 *
 * For an *opening* spot we consult the dedicated `SHORT_JAM_RANGES`, not the
 * deep-stack chart: `99`/`A2s`/`22` open at 100BB but are NOT auto-jams at
 * 19BB, so they fold here. The deep-stack 3-bet/4-bet value ranges, by
 * contrast, are already premium, so facing a raise a value hand jams; a premium
 * flat-range hand (e.g. QQ vs a 3-bet) also jams rather than folding.
 */
function shortStackMix(c: CompiledMix, key: string, ctx: PreflopContext): ActionMix {
  if (ctx.spot === 'unopened' || ctx.spot === 'limped') {
    return shortJamSet(ctx.positionGroup).has(key)
      ? { raise: 1, call: 0 }
      : { raise: 0, call: 0 };
  }
  if (c.valueRaise > 0) return { raise: clamp01(c.valueRaise), call: 0 };
  if (SHOVE_HANDS.has(key) && c.call > 0) return { raise: 1, call: 0 };
  return { raise: 0, call: 0 };
}

/**
 * Final, scaled probabilities. Invariants:
 *   - total `raise + call <= 1`;
 *   - value continuation is absolute (a discounted value raise becomes a call,
 *     never a fold);
 *   - `multiwayBluffScale` / the missing-history discount touch only the bluff
 *     component, never value or call;
 *   - marginal opens are `preflopScale - 1`.
 */
function effectiveFrequencies(
  c: CompiledMix,
  key: string,
  ctx: PreflopContext,
  params: RuleParams,
): ActionMix {
  if (ctx.stackBB < 20) return shortStackMix(c, key, ctx);

  const unopenedLike = ctx.spot === 'unopened' || ctx.spot === 'limped';
  const raiseScale = unopenedLike ? params.preflopScale : params.threeBetScale;

  const valueContinue = clamp01(c.valueRaise);
  const vRaise = clamp01(c.valueRaise * raiseScale);
  const valueCall = clamp01(valueContinue - vRaise); // never a fold

  let rawBluff = clamp01(
    c.bluffRaise * params.bluffScale * (unopenedLike ? 1 : params.threeBetScale),
  );
  if (ctx.spot === 'facingOpenMultiway') rawBluff = clamp01(rawBluff * params.multiwayBluffScale);
  if (!ctx.historyComplete && !unopenedLike) rawBluff = clamp01(rawBluff * 0.5);

  const marginalScale = ctx.spot === 'unopened' ? clamp01(params.preflopScale - 1) : 0;
  const rawMarginal = clamp01(c.marginalRaise * marginalScale);
  const rawCall = clamp01(c.call * params.preflopScale * callDiscount(ctx.stackBB));

  // Extras share the budget left after the absolute value continuation; scaling
  // them proportionally keeps raise + call <= 1 without starving one of them.
  const budget = clamp01(1 - valueContinue);
  const rawExtra = rawBluff + rawMarginal + rawCall;
  const k = rawExtra > 0 ? (rawExtra <= budget ? 1 : budget / rawExtra) : 0;

  return {
    raise: clamp01(vRaise + (rawBluff + rawMarginal) * k),
    call: clamp01(valueCall + rawCall * k),
  };
}

export interface PreflopChoice {
  intent: PreflopIntent;
  context: PreflopContext;
  handClass: HandClassInfo;
  /** Effective raise/call frequencies used, for tests and telemetry. */
  frequencies: ActionMix;
}

/**
 * Pick the preflop intent for the bot's hand. Never throws for a valid view;
 * the adapter still re-checks legality before returning an action.
 */
export function choosePreflopIntent(
  view: DecisionView,
  params: RuleParams,
  rand: () => number,
): PreflopChoice {
  const ctx = derivePreflopContext(view);
  const cards = view.hand?.myCards ?? [];
  const handClass = handClassForCards(cards[0] ?? 0, cards[1] ?? 1);
  const mix = mixFor(buildMix(ctx), handClass.key);
  const freqs = effectiveFrequencies(mix, handClass.key, ctx, params);

  const roll = rand();
  let intent: PreflopIntent;
  if (roll < freqs.raise) intent = 'raise';
  else if (roll < freqs.raise + freqs.call) intent = 'call';
  else intent = 'fold';

  return { intent, context: ctx, handClass, frequencies: freqs };
}
