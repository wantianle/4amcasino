import { describe, expect, it } from 'vitest';
import type {
  DecisionHand,
  DecisionLegalActions,
  DecisionSeat,
  DecisionView,
} from '../src/decisionView.js';
import {
  deriveTableContext,
  heroInPosition,
  heroWasAggressor,
  positionForSeat,
  seatsInDealingOrder,
} from '../src/tableContext.js';

/**
 * Narrow unit tests for the phase-1 `tableContext` layer.
 *
 * Two jobs:
 *  1. pin the new public helpers (dealing order, position, SPR, headcount,
 *     position/aggression reads), and
 *  2. prove the extraction is behaviour-preserving by comparing the extracted
 *     functions against literal copies of the pre-move implementations
 *     (`oldSpr`, `oldEffectiveStackBB`) over a matrix of views.
 */

function seat(over: Partial<DecisionSeat> = {}): DecisionSeat {
  return {
    seat: 0,
    userId: 1,
    displayName: 'p',
    isMe: false,
    stack: 1000,
    committed: 0,
    total: 0,
    folded: false,
    allIn: false,
    sittingOut: false,
    connected: true,
    ...over,
  };
}

function hand(over: Partial<DecisionHand> = {}): DecisionHand {
  return {
    handId: 'h',
    street: 'flop',
    buttonSeat: 0,
    board: [],
    pot: 100,
    currentBet: 0,
    toAct: 0,
    deadline: null,
    myCards: [],
    mySeat: 0,
    ...over,
  };
}

function la(over: Partial<DecisionLegalActions> = {}): DecisionLegalActions {
  return {
    canCheck: true,
    canCall: false,
    callAmount: 0,
    canBet: false,
    canRaise: false,
    minRaiseTo: 0,
    maxRaiseTo: 0,
    ...over,
  };
}

function view(over: Partial<DecisionView> = {}): DecisionView {
  return {
    room: { id: 'r', name: 'r', sb: 1, bb: 2, minSettleHands: 0, sevenDeuceBonus: 0 },
    hand: hand(),
    me: seat({ seat: 0, isMe: true }),
    legalActions: la(),
    potOdds: { callAmount: 0, pot: 100, potOdds: 0, breakEvenEquity: 0 },
    actionHistory: [],
    opponents: [seat({ seat: 1, userId: 2 })],
    sessionMemory: { handsObserved: 0, netChips: null, recentHands: [], opponents: [] },
    historyComplete: true,
    ...over,
  };
}

// --- pre-move copies (the "before" side of the equivalence proof) -----------

function oldSpr(v: DecisionView): number {
  const pot = v.potOdds?.pot ?? 0;
  if (pot <= 0) return 10;
  const myStack = v.me?.stack ?? 0;
  const activeStacks = v.opponents.filter((o) => !o.folded && !o.allIn).map((o) => o.stack);
  const oppMax = activeStacks.length ? Math.max(...activeStacks) : 0;
  const effective = oppMax > 0 ? Math.min(myStack, oppMax) : myStack;
  return effective / pot;
}

function oldEffectiveStackBB(v: DecisionView): number {
  const bb = v.room?.bb && v.room.bb > 0 ? v.room.bb : 1;
  const myStack = v.me?.stack ?? 0;
  const activeStacks = v.opponents.filter((o) => !o.folded && !o.allIn).map((o) => o.stack);
  const oppMax = activeStacks.length ? Math.max(...activeStacks) : 0;
  return (oppMax > 0 ? Math.min(myStack, oppMax) : myStack) / bb;
}

describe('tableContext: seatsInDealingOrder', () => {
  it('copies the supplied seatOrder verbatim (no aliasing)', () => {
    const supplied = [3, 1, 2];
    const v = view({ seatOrder: supplied, me: seat({ seat: 1, isMe: true }) });
    const order = seatsInDealingOrder(v);
    expect(order).toEqual([3, 1, 2]);
    expect(order).not.toBe(supplied);
  });

  it('infers a rotated order from the button when no seatOrder is supplied', () => {
    // seats [0,1,2,3], button 2 -> order after button: 3, 0, 1, 2
    const v = view({
      hand: hand({ buttonSeat: 2 }),
      me: seat({ seat: 0, isMe: true }),
      opponents: [seat({ seat: 1, userId: 2 }), seat({ seat: 2, userId: 3 }), seat({ seat: 3, userId: 4 })],
    });
    expect(seatsInDealingOrder(v)).toEqual([3, 0, 1, 2]);
  });

  it('special-cases heads-up: the button (SB) is first', () => {
    const v = view({
      hand: hand({ buttonSeat: 0 }),
      me: seat({ seat: 0, isMe: true }),
      opponents: [seat({ seat: 1, userId: 2 })],
    });
    expect(seatsInDealingOrder(v)).toEqual([0, 1]);
  });
});

describe('tableContext: position + reads', () => {
  it('maps dealing slots to position names and falls back for unknown sizes', () => {
    expect(positionForSeat(0, [0, 1, 2, 3, 4, 5])).toBe('SB');
    expect(positionForSeat(5, [0, 1, 2, 3, 4, 5])).toBe('BTN');
    expect(positionForSeat(4, [0, 1, 2])).toBe('BTN'); // unknown table size, slot 2
  });

  it('reports hero in position only when last to act among active seats', () => {
    const ip = view({
      hand: hand({ mySeat: 2 }),
      seatOrder: [0, 1, 2],
      me: seat({ seat: 2, isMe: true }),
      opponents: [seat({ seat: 0, userId: 2 }), seat({ seat: 1, userId: 3 })],
    });
    expect(heroInPosition(ip)).toBe(true);
    const oop = view({
      hand: hand({ mySeat: 0 }),
      seatOrder: [0, 1, 2],
      me: seat({ seat: 0, isMe: true }),
      opponents: [seat({ seat: 1, userId: 2 }), seat({ seat: 2, userId: 3 })],
    });
    expect(heroInPosition(oop)).toBe(false);
  });

  it('resolves heads-up IP/OOP both ways from the button seat', () => {
    const hu = (heroSeat: number, buttonSeat: number): DecisionView =>
      view({
        hand: hand({ mySeat: heroSeat, buttonSeat }),
        me: seat({ seat: heroSeat, isMe: true }),
        opponents: [seat({ seat: heroSeat === 0 ? 1 : 0, userId: 2 })],
      });
    // HU: the button is the small blind and acts LAST postflop -> in position.
    expect(heroInPosition(hu(0, 0))).toBe(true);
    // The other seat is the big blind and acts first -> out of position.
    expect(heroInPosition(hu(1, 0))).toBe(false);
  });

  it('resolves heads-up IP/OOP with reversed (non-zero-based) seat numbers', () => {
    const hu = (heroSeat: number, buttonSeat: number): DecisionView =>
      view({
        hand: hand({ mySeat: heroSeat, buttonSeat }),
        me: seat({ seat: heroSeat, isMe: true }),
        opponents: [seat({ seat: heroSeat === 3 ? 7 : 3, userId: 2 })],
      });
    expect(heroInPosition(hu(3, 3))).toBe(true); // BTN/SB
    expect(heroInPosition(hu(7, 3))).toBe(false); // BB
  });

  it('lets buttonSeat decide the heads-up last actor when seatOrder disagrees', () => {
    // A supplied dealing order [0,1] claims SB-first, but buttonSeat 1 already
    // places the button last: the postflop order stays [0,1], so seat 1 acts last.
    const v1 = view({
      hand: hand({ mySeat: 1, buttonSeat: 1 }),
      seatOrder: [0, 1],
      me: seat({ seat: 1, isMe: true }),
      opponents: [seat({ seat: 0, userId: 2 })],
    });
    expect(heroInPosition(v1)).toBe(true);
    const v1b = view({
      hand: hand({ mySeat: 0, buttonSeat: 1 }),
      seatOrder: [0, 1],
      me: seat({ seat: 0, isMe: true }),
      opponents: [seat({ seat: 1, userId: 2 })],
    });
    expect(heroInPosition(v1b)).toBe(false);
    // Mirror: a reversed supplied order with buttonSeat 0 keeps seat 0 last.
    const v2 = view({
      hand: hand({ mySeat: 0, buttonSeat: 0 }),
      seatOrder: [1, 0],
      me: seat({ seat: 0, isMe: true }),
      opponents: [seat({ seat: 1, userId: 2 })],
    });
    expect(heroInPosition(v2)).toBe(true);
  });

  it('returns a best-effort, not trusted, heads-up answer with neither seatOrder nor buttonSeat', () => {
    // LIMITATION stated on `postflopActionOrder`: without a supplied order and
    // without `buttonSeat` the pair is sorted ascending, so reversing it is an
    // assumption rather than a determination. The helper still returns a
    // deterministic value (the ascending-first seat ends up last), which is why
    // the comment says such a view "must not be trusted" for HU IP/OOP.
    const v0 = view({
      hand: hand({ mySeat: 0, buttonSeat: undefined }),
      me: seat({ seat: 0, isMe: true }),
      opponents: [seat({ seat: 1, userId: 2 })],
    });
    const v1 = view({
      hand: hand({ mySeat: 1, buttonSeat: undefined }),
      me: seat({ seat: 1, isMe: true }),
      opponents: [seat({ seat: 0, userId: 2 })],
    });
    expect(seatsInDealingOrder(v0)).toEqual([0, 1]); // ascending, no button to rotate
    expect(heroInPosition(v0)).toBe(true); // best-effort: reversed [1,0]
    expect(heroInPosition(v1)).toBe(false);
  });

  it('detects the last preflop aggressor', () => {
    const v = view({
      hand: hand({ mySeat: 1 }),
      actionHistory: [
        { actionSeq: 0, street: 'preflop', seat: 1, action: { type: 'raise', amount: 6 }, auto: false, ts: 0 },
      ],
      me: seat({ seat: 1, isMe: true }),
    });
    expect(heroWasAggressor(v)).toBe(true);
  });
});

describe('tableContext: deriveTableContext', () => {
  it('floors active opponents at 1 and counts only non-folded', () => {
    expect(deriveTableContext(view({ opponents: [] })).activeOpponentCount).toBe(1);
    const v = view({
      opponents: [
        seat({ seat: 1, userId: 2, folded: true }),
        seat({ seat: 2, userId: 3 }),
        seat({ seat: 3, userId: 4 }),
      ],
    });
    expect(deriveTableContext(v).activeOpponentCount).toBe(2);
  });

  it('uses pot <= 0 as SPR 10 and the min effective stack otherwise', () => {
    expect(
      deriveTableContext(view({ potOdds: { callAmount: 0, pot: 0, potOdds: 0, breakEvenEquity: 0 } })).spr,
    ).toBe(10);
    const v = view({
      me: seat({ seat: 0, isMe: true, stack: 1000 }),
      opponents: [
        seat({ seat: 1, userId: 2, stack: 600 }),
        seat({ seat: 2, userId: 3, stack: 400, allIn: true }), // all-in excluded
      ],
      potOdds: { callAmount: 0, pot: 200, potOdds: 0, breakEvenEquity: 0 },
    });
    expect(deriveTableContext(v).spr).toBe(3); // min(1000, 600) / 200
  });

  it('derives street, heads-up, bb fallback and effective stack in BB', () => {
    const v = view({
      room: { id: 'r', name: 'r', sb: 0, bb: 0, minSettleHands: 0, sevenDeuceBonus: 0 },
      hand: hand({ street: 'river' }),
      me: seat({ seat: 0, isMe: true, stack: 500 }),
      opponents: [seat({ seat: 1, userId: 2, stack: 300 })],
    });
    const ctx = deriveTableContext(v);
    expect(ctx.street).toBe('river');
    expect(ctx.headsUp).toBe(true);
    expect(ctx.bb).toBe(1); // unset bb floors at 1
    expect(ctx.effectiveStack).toBe(300);
    expect(ctx.effectiveStackBB).toBe(300);
  });

  it('equals the pre-move spr / effectiveStackBB implementations over a matrix', () => {
    const stacks = [0, 50, 300, 1000];
    const pots = [0, 5, 100, 1000];
    const bb = [0, 2, 100];
    const opponents: DecisionSeat[][] = [
      [],
      [seat({ seat: 1, userId: 2, stack: 200 })],
      [seat({ seat: 1, userId: 2, stack: 200, folded: true }), seat({ seat: 2, userId: 3, stack: 400, allIn: true })],
      [seat({ seat: 1, userId: 2, stack: 100 }), seat({ seat: 2, userId: 3, stack: 900 })],
    ];
    for (const myStack of stacks) {
      for (const pot of pots) {
        for (const bigBlind of bb) {
          for (const opps of opponents) {
            const v = view({
              room: { id: 'r', name: 'r', sb: 0, bb: bigBlind, minSettleHands: 0, sevenDeuceBonus: 0 },
              me: seat({ seat: 0, isMe: true, stack: myStack }),
              opponents: opps,
              potOdds: { callAmount: 0, pot, potOdds: 0, breakEvenEquity: 0 },
            });
            const ctx = deriveTableContext(v);
            expect(ctx.spr, `spr stack=${myStack} pot=${pot}`).toBe(oldSpr(v));
            expect(ctx.effectiveStackBB, `effBB bb=${bigBlind}`).toBe(oldEffectiveStackBB(v));
          }
        }
      }
    }
  });
});
