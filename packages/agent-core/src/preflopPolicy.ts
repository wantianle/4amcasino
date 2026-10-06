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
  adaptiveChartFor,
  bbDefendChartFor,
  buildDerivedChart,
  canonicalSlot,
  chartToRangeEntries,
  chartWidth,
  computeBehindPending,
  continueWidthScale,
  HAND_KEYS,
  multiwayWidthScale,
  preflopActionOrder,
  rescaleRangeMix,
  rfiChartForSlot,
  type PreflopChart,
} from './preflopCharts/index.js';
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
  /** 6-max reference slot of the first raiser (B0..B5), or null. */
  openerSlot: number | null;
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
  /** Players dealt into the hand (dealing-order length). */
  dealtCount: number;
  /** Players still able to act (not folded / all-in / sitting out). */
  activeCount: number;
  /**
   * Active players after the hero in preflop action order who have not yet
   * completed their preflop action. The primary independent variable of the
   * adaptive charts; only meaningful when `headcountReliable`.
   */
  behindUnacted: number;
  /** `clamp(behindUnacted, 0, 8)`, the canonical chart slot B0..B8. */
  actorSlot: number;
  /** True for a two-handed (heads-up) hand. */
  headsUp: boolean;
  /**
   * True when the seat states let us trust `dealtCount` / `behindUnacted`: the
   * server supplied a dealing order that names every known seat. Missing history
   * is tracked separately by `historyComplete`.
   */
  headcountReliable: boolean;
  /**
   * True when the view carried the server's current-round `needToAct` list, so
   * `behindUnacted` tracks the live betting round (a raise reopening the action
   * re-includes the earlier callers). False means the fallback "acted at some
   * point this hand" inference ran; the facing-open adaptive route refuses to
   * trust that, since it cannot see a reopening.
   */
  needToActTracked: boolean;
  /** Absolute hero seat, so the pending-list gate can check the hero owes action. */
  heroSeat: number;
  /**
   * The server's current-round pending seats copied verbatim, or `null` when
   * the server did not supply `needToAct`. Keeping the list (not just a
   * boolean) lets the facing-open route require a non-empty snapshot that
   * actually contains the hero: an empty list is "nobody owes an action" and a
   * list without the hero is not a live decision for them, so both must fall
   * back to the legacy tables even though `needToActTracked` is true.
   */
  needToActSeats: readonly number[] | null;
  /** True when the hero can still put chips in (not folded / all-in / sitting out). */
  heroActive: boolean;
  /**
   * True when the public turn is the hero's (`hand.toAct === heroSeat`). A
   * snapshot that lists the hero in `needToAct` but has the turn on someone
   * else is not a live hero decision.
   */
  heroToAct: boolean;
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

/**
 * 6-max reference slot for an opener's position, used to pick the
 * `FRLA_BB_DEFEND` anchor. The solver subset is 6-max, so every table size maps
 * its positions onto that reference: UTG/UTG1 -> B5 (UTG), MP/LJ/HJ -> B4 (MP),
 * CO -> B3, BTN -> B2, SB -> B1, BB -> B0. Using the raw behind-unacted slot
 * would misalign 9-max (there the BTN has 0 players behind, but the defence data
 * keys BTN at B2), so the position name is the stable key here.
 */
function sixMaxSlotForPosition(pos: Position): number {
  switch (pos) {
    case 'UTG':
    case 'UTG1':
      return 5;
    case 'MP':
    case 'LJ':
    case 'HJ':
      return 4;
    case 'CO':
      return 3;
    case 'BTN':
      return 2;
    case 'SB':
      return 1;
    default:
      return 0;
  }
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

  // --- headcount model -----------------------------------------------------
  // `behindUnacted` is measured from the actual preflop action order, so it
  // needs the seats' live state plus the actions already completed. We deliberately
  // do not fall back to "nobody acted" for a missing history: `headcountReliable`
  // (and the separate `historyComplete` gate) keep the adaptive charts off when
  // the seat states are not trustworthy.
  const order = preflopActionOrder(seatOrder);
  const activeSeats = new Set<number>();
  if (me && !me.folded && !me.allIn && !me.sittingOut) activeSeats.add(mySeat);
  for (const o of view.opponents) {
    if (!o.folded && !o.allIn && !o.sittingOut) activeSeats.add(o.seat);
  }
  // `behindUnacted` must count seats that still owe an action *in the current
  // betting round*, not seats that have acted at some point this hand. A raise
  // reopens the round: an earlier caller must act again facing a 3-bet, and the
  // flat "acted at some point" set would wrongly drop it, undercounting
  // `behindUnacted` exactly when the defensive charts matter. Prefer the
  // server's public `needToAct`; fall back to the historical set only when it is
  // unavailable (a legacy server), which the facing-open adaptive route refuses
  // to trust because it cannot observe a reopening.
  const needToActSeats = Array.isArray(view.needToActSeats) ? [...view.needToActSeats] : null;
  const needToActTracked = needToActSeats !== null;
  const currentRoundSeats = needToActSeats ? new Set(needToActSeats) : null;
  // The adaptive charts only ever serve a live hero decision. `needToAct` alone
  // is not enough: a stale/malformed snapshot can list the hero while the hero
  // is folded / all-in / sitting out, or while the public turn is another
  // seat's, so the route gate re-checks both here.
  const heroActive = !!me && !me.folded && !me.allIn && !me.sittingOut;
  const heroToAct = mySeat >= 0 && hand?.toAct === mySeat;
  const actedSeats = new Set(actions.map((a) => a.seat));
  const pendingSeats =
    currentRoundSeats ?? new Set([...activeSeats].filter((s) => !actedSeats.has(s)));
  const behindUnacted = computeBehindPending({
    order,
    heroSeat: mySeat,
    activeSeats,
    pendingSeats,
  });
  const actorSlot = canonicalSlot(behindUnacted);
  const dealtCount = seatOrder.length;
  const headsUp = dealtCount === 2;
  const suppliedOrder = view.seatOrder;
  const knownSeats = new Set<number>([mySeat, ...view.opponents.map((o) => o.seat)]);
  const suppliedSet = suppliedOrder ? new Set(suppliedOrder) : null;
  const headcountReliable =
    !!suppliedOrder &&
    !!suppliedSet &&
    suppliedOrder.length >= 2 &&
    suppliedOrder.length <= 9 &&
    // No duplicate seats: a repeated seat would inflate the count and make a
    // short table look longer (or double-count a dealing slot).
    suppliedSet.size === suppliedOrder.length &&
    // The order must name exactly the known seats — no more, no fewer. A subset
    // check alone would accept `[0,1]` while `{0,1,2}` is seated and misread a
    // 3-handed table as heads-up; the size + coverage pair forces equality.
    suppliedSet.size === knownSeats.size &&
    [...knownSeats].every((s) => suppliedSet.has(s));
  // The opener's slot keys the 6-max defence anchors (see
  // `sixMaxSlotForPosition`). Unlike `behindUnacted` it must not shrink as the
  // auction folds/acts: it encodes *how early the opener acted*, not how many
  // players happen to still owe action at the hero's decision.
  const openerSlot = opener ? sixMaxSlotForPosition(opener) : null;

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
    openerSlot,
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
    dealtCount,
    activeCount: activeSeats.size,
    behindUnacted,
    actorSlot,
    headsUp,
    headcountReliable,
    needToActTracked,
    heroSeat: mySeat,
    needToActSeats,
    heroActive,
    heroToAct,
  };
}

/**
 * Compiled mixes are pure functions of the charts, so memoise them per
 * spot/position/opener instead of re-parsing the range strings on every
 * decision. The returned maps are read-only to callers.
 */
const mixCache = new Map<string, Map<string, CompiledMix>>();

/**
 * The legacy position-named baseline charts. No longer the default: the
 * headcount-adaptive path is the default engine (see `ADAPTIVE_PREFLOP_DEFAULT`)
 * and this is the explicit fallback when adaptive is switched off
 * (`params.adaptivePreflop === false`) or the spot/headcount cannot be trusted.
 */
function buildLegacyMix(ctx: PreflopContext): Map<string, CompiledMix> {
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
  return mix;
}

/**
 * True when the adaptive headcount charts may serve this decision: the flag is
 * on, the history is complete, the hero is the live acting seat (active and
 * `toAct`), and the seat states give a trustworthy current-round behind-unacted
 * count. Anything else falls back to the legacy tables — missing history is
 * never read as "nobody acted", and a snapshot that is not actually the hero's
 * live decision is never served.
 *
 * Per-spot gates:
 *  - `unopened`: slot B1..B8 (B0 = BB never opens); HU uses the HU chart at B1.
 *  - `facingOpen`: non-HU, a known opener slot B1..B5, and the server's
 *    `needToAct` (`needToActTracked`) with a non-empty list that contains the
 *    hero — the defensive widths depend on who still owes an action after a
 *    raise, which the historical "acted at some point" set cannot express.
 *  - `limped`: non-HU. No raise has happened yet, so a reopening is impossible
 *    this round and the fallback pending inference is trustworthy.
 *  - `facingOpenMultiway` / `facing3Bet` / `facing3BetCold` / `facing4BetPlus`:
 *    non-HU and a raise is on the table, so the current-round `needToAct`
 *    contract is required exactly as for `facingOpen`.
 *
 * Heads-up facing a raise (or any later street of the auction) stays on the
 * legacy tables: the FRLA subset is 6-max and the step-1 contract pinned HU
 * BB-facing-raise to legacy. HU limped pots are pinned to legacy for the same
 * reason (no HU limp-iso anchor exists); see the `limped` branch below.
 */
export function adaptivePreflopAvailable(ctx: PreflopContext, params: RuleParams): boolean {
  if (!params.adaptivePreflop) return false;
  if (!ctx.historyComplete || !ctx.headcountReliable) return false;
  if (!(ctx.dealtCount >= 2 && ctx.dealtCount <= 9)) return false;
  if (!Number.isFinite(ctx.behindUnacted)) return false;
  // Every adaptive branch models a live decision by the hero. A stale or
  // malformed snapshot can list the hero in `needToAct` while the hero is
  // folded / all-in / sitting out, or while the public turn belongs to another
  // seat; such a view is not a hero decision and must fall back to legacy.
  if (!ctx.heroActive) return false;
  if (!ctx.heroToAct) return false;

  switch (ctx.spot) {
    case 'unopened':
      // HU first-in is the SB=BTN chart; B0 (BB) never opens first in.
      if (ctx.headsUp) return ctx.actorSlot === 1;
      return ctx.actorSlot >= 1 && ctx.actorSlot <= 8;

    case 'facingOpen':
      if (ctx.headsUp) return false;
      if (ctx.openerSlot === null || ctx.openerSlot < 1 || ctx.openerSlot > 5) return false;
      // Without `needToAct`, a raise reopening the round is invisible and
      // `behindUnacted` can undercount — never serve the defensive charts then.
      if (!ctx.needToActTracked) return false;
      // A tracked snapshot is necessary but not sufficient. The adaptive premise
      // is "the hero still owes this round and there are live players behind".
      // An empty list is a closed/mis-timed snapshot, and a list without the
      // hero is not a live decision for them; either way `behindUnacted` would
      // not measure the hero's own pending action, so fall back to legacy.
      if (!ctx.needToActSeats || ctx.needToActSeats.length === 0) return false;
      if (!ctx.needToActSeats.includes(ctx.heroSeat)) return false;
      return ctx.actorSlot >= 0 && ctx.actorSlot <= 8;

    case 'limped':
      // No raise yet, so the round cannot have reopened: the historical
      // "active and not acted" inference behind `behindUnacted` is exact.
      //
      // HU limped pots deliberately stay on the legacy tables. A heads-up BB
      // facing a SB limp is *not* the same decision as a multiway isolation
      // raise: there is no ISO_RANGES equivalent for HU (the legacy ISO tables
      // are position-group based, non-HU), and the FRLA/HU solver subsets have
      // no HU limp-iso anchor to derive from. Serving the multiway
      // `ISO_RANGES` here would import a wider, non-HU range into a 2-handed
      // pot with no evidence. The step-1 contract already pinned HU
      // BB-facing-raise to legacy; HU limped is pinned for the same reason.
      // Switching it to adaptive would require a dedicated HU limp-iso anchor,
      // not a gate tweak.
      if (ctx.headsUp) return false;
      return ctx.actorSlot >= 0 && ctx.actorSlot <= 8;

    case 'facingOpenMultiway':
    case 'facing3Bet':
    case 'facing3BetCold':
    case 'facing4BetPlus':
      // A raise is on the table: the round can reopen, so the current-round
      // pending list is required, non-empty, and must name the hero.
      if (ctx.headsUp) return false;
      if (!ctx.needToActTracked) return false;
      if (!ctx.needToActSeats || ctx.needToActSeats.length === 0) return false;
      if (!ctx.needToActSeats.includes(ctx.heroSeat)) return false;
      return ctx.actorSlot >= 0 && ctx.actorSlot <= 8;

    default:
      return false;
  }
}

/**
 * Non-BB cold 3-bet / cold-call versus a single open. No solver subset exists
 * for these seats, so the existing `COLD_3BET_*` / `CALL_VS_OPEN` tables are the
 * anchor and `behindUnacted` narrows them: the more players still to act behind
 * the hero, the tighter the continue. The opener group (from the opener's
 * position) already picks the 3-bet value/bluff brackets.
 */
function buildColdAdaptiveMix(ctx: PreflopContext): Map<string, CompiledMix> {
  const openerGroup: PositionGroup = ctx.openerGroup ?? 'EP';
  const entries: RangeEntry[] = [
    { range: COLD_3BET_VALUE[openerGroup], action: 'raise', weight: 1, role: 'value' },
    {
      range: COLD_3BET_BLUFF[openerGroup],
      action: 'raise',
      weight: COLD_3BET_BLUFF_WEIGHT,
      role: 'bluff',
    },
    // The BB branch is handled separately, so this is always a non-BB group.
    { range: CALL_VS_OPEN[ctx.positionGroup], action: 'call', weight: 1 },
  ];
  return rescaleRangeMix(entries, continueWidthScale(ctx.behindUnacted));
}

/** Anchor for a derived (no-solver-subset) adaptive spot. */
interface DerivedAnchor {
  situation: 'unopened' | 'facingOpen' | 'facing3Bet';
  actor: string | null;
  entries: RangeEntry[];
  usage: string;
}

/**
 * Map the remaining preflop spots onto their legacy anchor. These spots have no
 * solver subset, so the anchor is the hand-built rules-v1 table and
 * `behindUnacted` tapers it (see `buildDerivedChart`). Mixed raises keep their
 * explicit role: the value/bluff split of `COLD_3BET_*` and `FACING_3BET_*` is
 * preserved, and only the non-premium participation shrinks.
 */
function derivedAnchorFor(ctx: PreflopContext): DerivedAnchor | null {
  const openerGroup: PositionGroup = ctx.openerGroup ?? 'EP';
  switch (ctx.spot) {
    case 'limped':
      return {
        situation: 'unopened',
        actor: ctx.position,
        entries: [
          { range: ISO_RANGES[ctx.positionGroup], action: 'raise', weight: 1, role: 'value' },
        ],
        usage: `ISO_RANGES.${ctx.positionGroup}`,
      };
    case 'facingOpenMultiway': {
      const entries: RangeEntry[] = [];
      if (ctx.positionGroup === 'BB') {
        entries.push(...BB_DEFEND[openerGroup]);
      } else {
        entries.push(
          { range: COLD_3BET_VALUE[openerGroup], action: 'raise', weight: 1, role: 'value' },
          {
            range: COLD_3BET_BLUFF[openerGroup],
            action: 'raise',
            weight: COLD_3BET_BLUFF_WEIGHT,
            role: 'bluff',
          },
          { range: CALL_VS_OPEN[ctx.positionGroup], action: 'call', weight: 1 },
        );
      }
      return {
        situation: 'facingOpen',
        actor: ctx.position,
        entries,
        usage:
          ctx.positionGroup === 'BB'
            ? `BB_DEFEND.${openerGroup} (multiway)`
            : `COLD_3BET_*.${openerGroup} + CALL_VS_OPEN.${ctx.positionGroup} (multiway)`,
      };
    }
    case 'facing3Bet':
      return {
        situation: 'facing3Bet',
        actor: ctx.position,
        entries: [...FACING_3BET_4BET, ...FACING_3BET_CALL],
        usage: 'FACING_3BET_4BET + FACING_3BET_CALL',
      };
    case 'facing3BetCold':
      return {
        situation: 'facing3Bet',
        actor: ctx.position,
        entries: COLD_3BET_COLD,
        usage: 'COLD_3BET_COLD',
      };
    case 'facing4BetPlus':
      return {
        situation: 'facing3Bet',
        actor: ctx.position,
        entries: FACING_4BET_PLUS,
        usage: 'FACING_4BET_PLUS',
      };
    default:
      return null;
  }
}

/**
 * Build the derived adaptive mix for a remaining spot. Width tapers with
 * `behindUnacted` (`continueWidthScale`), plus an extra documented caller
 * squeeze factor in the multiway pot. The chart is a real `preflop-chart/v1`
 * (169 classes, sum 1, explicit roles); the compiled mix is then fed to the
 * unchanged style / short-stack pipeline.
 */
function buildDerivedAdaptiveMix(ctx: PreflopContext): Map<string, CompiledMix> | null {
  const anchor = derivedAnchorFor(ctx);
  if (!anchor) return null;
  const scale =
    ctx.spot === 'facingOpenMultiway'
      ? continueWidthScale(ctx.behindUnacted) * multiwayWidthScale(ctx.callers)
      : continueWidthScale(ctx.behindUnacted);
  const chart = buildDerivedChart({
    id: `derived-${ctx.spot}-${ctx.position}-b${ctx.actorSlot}`,
    situation: anchor.situation,
    actor: anchor.actor,
    actorSlot: ctx.actorSlot,
    opener: ctx.opener,
    openerSlot: ctx.openerSlot,
    behindUnacted: ctx.behindUnacted,
    activeCount: ctx.activeCount,
    seats: ctx.dealtCount,
    format: ctx.dealtCount <= 2 ? 'hu' : ctx.dealtCount <= 6 ? '6max' : '9max',
    depthBB: Math.round(ctx.stackBB),
    usage: anchor.usage,
    entries: anchor.entries,
    scale,
  });
  return compileRangeMix(chartToRangeEntries(chart));
}

/**
 * Adaptive RFI entries with an explicit `marginal` edge layer, so the style
 * presets differ on the adaptive default exactly as they do on the legacy
 * tables.
 *
 * The adaptive RFI chart alone cannot carry the gradient: `buildChartMix`'s
 * threshold narrowing leaves every `p = 1` class untouched, so the 9-max tail
 * (B6..B8) — a narrowing of the UTG anchor — keeps only a sliver of mixed
 * (raise/fold) cells (B8 ≈ 0.14pt). Tagging just those as marginal would leave
 * the four presets within ~0.1pt of each other, which is the bug this fixes.
 *
 * So the edge layer is taken from the slot's **anchor** — the UTG anchor for the
 * 9-max tail, the chart itself for B1..B5 — where the solver's mixed raises
 * exist in full. It is scaled by the slot's headcount ratio
 * (`chartWidth / anchorWidth <= 1`) so `B6 > B7 > B8` stays true, and compiled
 * with role `marginal`: `effectiveFrequencies` opens it at `preflopScale - 1`,
 * i.e. `tight-aggressive` (scale 1) folds it, `loose-aggressive` (1.5) opens
 * half, `calling-station` (1.15) and `constrained-random` (1.1) a tenth or so.
 *
 * The weight is the anchor's own raise frequency times the headcount ratio, so
 * a marginal open is `raise * (preflopScale - 1) <= raise <= 1`: it never
 * exceeds the frequency the source anchor gave the class, never invents a class
 * the anchor does not play, and therefore never widens past the source. The
 * premium core is untouched (`value` raises keep their full frequency).
 */
function adaptiveRfiEntries(chart: PreflopChart, ctx: PreflopContext): RangeEntry[] {
  const entries: RangeEntry[] = [];
  // Core: every style opens the chart's pure (`value`) raises and its flat
  // calls. The mixed cells are handled as the edge layer below instead.
  for (const key of HAND_KEYS) {
    const m = chart.mix[key];
    if (!m) continue;
    const raise = m.raise + m.allin;
    if (raise > 0 && m.raiseRole === 'value') {
      entries.push({ range: key, action: 'raise', weight: raise, role: 'value' });
    }
    if (m.call > 0) entries.push({ range: key, action: 'call', weight: m.call });
  }
  // Edge: the anchor's mixed raises, scaled to this slot's headcount. For
  // B1..B5 the anchor is the chart itself (identity, ratio 1); for the 9-max
  // tail it is B5, the UTG anchor the tail extrapolates from.
  const tail = ctx.actorSlot > 5;
  const anchor = tail ? rfiChartForSlot(5) : chart;
  if (anchor) {
    const ratio = tail ? Math.min(1, chartWidth(chart) / chartWidth(anchor)) : 1;
    for (const key of HAND_KEYS) {
      const m = anchor.mix[key];
      if (!m || m.raiseRole !== 'bluff') continue;
      const raise = m.raise + m.allin;
      if (raise <= 0) continue;
      entries.push({ range: key, action: 'raise', weight: raise * ratio, role: 'marginal' });
    }
  }
  return entries;
}

function buildAdaptiveMix(ctx: PreflopContext): Map<string, CompiledMix> | null {
  if (ctx.spot === 'facingOpen') {
    if (ctx.positionGroup === 'BB') {
      const chart = bbDefendChartFor(ctx.openerSlot ?? 0, ctx.behindUnacted);
      return compileRangeMix(chartToRangeEntries(chart));
    }
    return buildColdAdaptiveMix(ctx);
  }
  if (ctx.spot === 'unopened') {
    const chart = adaptiveChartFor({ actorSlot: ctx.actorSlot, headsUp: ctx.headsUp });
    if (!chart) return null;
    // HU stays on the literal chart split: it is a single MHL-anchored spot
    // (`HU.SB_OPEN`, ~87% open with a large limp share) that must not drift from
    // its source. The multiway RFI path carries the explicit marginal layer.
    if (ctx.headsUp) return compileRangeMix(chartToRangeEntries(chart));
    return compileRangeMix(adaptiveRfiEntries(chart, ctx));
  }
  return buildDerivedAdaptiveMix(ctx);
}

/**
 * Cache key for a compiled preflop mix. It carries every input that can change
 * the result across decisions: the headcount slot, the auction shape, the depth
 * band, and — crucially — the **final route** the context resolves to.
 *
 * The route, not the raw `adaptivePreflop` flag, is what must be encoded: the
 * flag alone says adaptive is *allowed*, while `adaptivePreflopAvailable` also
 * folds in `historyComplete` / `headcountReliable` / `spot` / `dealtCount` /
 * `actorSlot`. Two contexts that differ only in, say, `historyComplete` resolve
 * to different mixes (adaptive vs legacy) but would share a flag-only key — the
 * first one to populate `mixCache` would then poison the other, breaking the
 * "any failure falls back to the legacy tables" guarantee. Exported so tests can
 * pin that two contexts which must not share do not.
 */
export function preflopMixCacheKey(ctx: PreflopContext, params: RuleParams): string {
  const openerKey =
    ctx.spot === 'unopened' || ctx.spot === 'limped' ? '' : (ctx.openerGroup ?? 'EP');
  const route = adaptivePreflopAvailable(ctx, params) ? 'adaptive' : 'legacy';
  return [
    ctx.spot,
    ctx.position,
    openerKey,
    ctx.dealtCount,
    ctx.actorSlot,
    ctx.openerSlot ?? 'n',
    ctx.raises,
    ctx.callers,
    Math.round(ctx.stackBB),
    route,
  ].join('|');
}

/**
 * Resolve the compiled mix for `ctx`. `params.adaptivePreflop` defaults to on,
 * so with a trustworthy headcount the adaptive charts serve every covered spot;
 * a spot/headcount the adaptive path cannot trust — or an explicit
 * `adaptivePreflop:false` kill-switch — falls back to the legacy position tables
 * unchanged.
 */
function buildMix(ctx: PreflopContext, params: RuleParams): Map<string, CompiledMix> {
  const cacheKey = preflopMixCacheKey(ctx, params);
  const cached = mixCache.get(cacheKey);
  if (cached) return cached;

  let mix: Map<string, CompiledMix> | null = null;
  if (adaptivePreflopAvailable(ctx, params)) mix = buildAdaptiveMix(ctx);
  if (!mix) mix = buildLegacyMix(ctx);
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
  const mix = mixFor(buildMix(ctx, params), handClass.key);
  const freqs = effectiveFrequencies(mix, handClass.key, ctx, params);

  const roll = rand();
  let intent: PreflopIntent;
  if (roll < freqs.raise) intent = 'raise';
  else if (roll < freqs.raise + freqs.call) intent = 'call';
  else intent = 'fold';

  return { intent, context: ctx, handClass, frequencies: freqs };
}
