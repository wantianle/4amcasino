import type { DecisionView } from './decisionView.js';
import { positionGroup, type Position, type PositionGroup } from './preflopRanges.js';
import {
  canonicalSlot,
  computeBehindPending,
  preflopActionOrder,
} from './preflopCharts/index.js';
import { POSITIONS_BY_COUNT, positionForSeat, seatsInDealingOrder } from './tableContext.js';

/**
 * Preflop context layer: turn a `DecisionView` into a preflop spot, position and
 * stack context. Pure and deterministic. This module owns spot classification
 * and the headcount model; range construction lives in `preflopRange.ts`.
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

// Dealing order / position helpers moved to the neutral `tableContext` layer so
// `postflopPolicy` no longer depends on this module for `seatsInDealingOrder`.
// `seatsInDealingOrder` is re-exported from `preflopPolicy` for existing
// importers (including the frozen postflop baseline fixture).

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

/**
 * Number of seats that still act after `pos` in preflop action order at a
 * `dealtCount`-handed table. This is the **action-order suffix length**, the key
 * the Rust vs-open mapping uses (`preflopCharts/rustVsOpen.ts`): once the
 * players before a seat have folded, that suffix is the same 6-max subgame
 * whatever the dealt table size. `-1` when the table size / position is unknown.
 */
export function positionBehindCount(pos: Position, dealtCount: number): number {
  const table = POSITIONS_BY_COUNT[dealtCount];
  if (!table) return -1;
  const action =
    table.length <= 2 ? [...table] : [...table.slice(2), table[0]!, table[1]!];
  const idx = action.indexOf(pos);
  return idx < 0 ? -1 : action.length - 1 - idx;
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
