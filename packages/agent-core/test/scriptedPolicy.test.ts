import { describe, expect, it } from 'vitest';
import { cardFromName, type CardId } from '@4am/shared';
import type {
  DecisionHand,
  DecisionLegalActions,
  DecisionPotOdds,
  DecisionView,
} from '../src/decisionView.js';
import type { PolicyDecision } from '../src/policy.js';
import { ScriptedPolicy } from '../src/scriptedPolicy.js';

function la(over: Partial<DecisionLegalActions> = {}): DecisionLegalActions {
  return {
    canCheck: false,
    canCall: true,
    callAmount: 10,
    canBet: false,
    canRaise: false,
    minRaiseTo: 20,
    maxRaiseTo: 100,
    ...over,
  };
}

function hand(myCards: CardId[], board: CardId[] = []): DecisionHand {
  return {
    handId: 'h1',
    street: board.length >= 3 ? 'flop' : 'preflop',
    buttonSeat: 0,
    board,
    pot: 0,
    currentBet: 0,
    toAct: 0,
    deadline: null,
    myCards,
    mySeat: 0,
  };
}

function odds(over: Partial<DecisionPotOdds> = {}): DecisionPotOdds {
  return { callAmount: 10, pot: 100, potOdds: 10 / 110, breakEvenEquity: 10 / 110, ...over };
}

function view(over: Partial<DecisionView> = {}): DecisionView {
  return {
    room: null,
    hand: null,
    me: null,
    legalActions: null,
    potOdds: null,
    actionHistory: [],
    opponents: [],
    sessionMemory: { handsObserved: 0, netChips: null, recentHands: [], opponents: [] },
    historyComplete: true,
    ...over,
  };
}

function assertLegal(d: PolicyDecision, legal: DecisionLegalActions): void {
  const a = d.action;
  switch (a.type) {
    case 'check':
      expect(legal.canCheck).toBe(true);
      break;
    case 'call':
      expect(legal.canCall).toBe(true);
      break;
    case 'bet':
      expect(legal.canBet).toBe(true);
      expect(a.amount).toBeGreaterThanOrEqual(legal.minRaiseTo);
      expect(a.amount).toBeLessThanOrEqual(legal.maxRaiseTo);
      break;
    case 'raise':
      expect(legal.canRaise).toBe(true);
      expect(a.amount).toBeGreaterThanOrEqual(legal.minRaiseTo);
      expect(a.amount).toBeLessThanOrEqual(legal.maxRaiseTo);
      break;
    case 'fold':
      break;
  }
}

const policy = new ScriptedPolicy();

describe('ScriptedPolicy', () => {
  it('throws when asked to act without legal actions (out of turn)', () => {
    expect(() => policy.decide(view())).toThrow(/out of turn/);
  });

  it('checks a weak hand when checking is free', () => {
    const legal = la({ canCheck: true, canCall: false, callAmount: 0 });
    const decision = policy.decide(
      view({ legalActions: legal, hand: hand([cardFromName('7c'), cardFromName('2d')]) }),
    );
    expect(decision.action).toEqual({ type: 'check' });
    assertLegal(decision, legal);
  });

  it('calls a small pair when the price is acceptable', () => {
    const legal = la({ canCheck: false, canCall: true, canRaise: false, callAmount: 10 });
    const decision = policy.decide(
      view({
        legalActions: legal,
        potOdds: odds(),
        hand: hand([cardFromName('2c'), cardFromName('2d')]),
      }),
    );
    expect(decision.action).toEqual({ type: 'call' });
    assertLegal(decision, legal);
  });

  it('value bets/raises a strong hand at minRaiseTo without overstepping', () => {
    const strong = hand([cardFromName('Ac'), cardFromName('Ad')]);

    const raiseLegal = la({ canRaise: true, canBet: false, minRaiseTo: 60, maxRaiseTo: 200 });
    const raised = policy.decide(view({ legalActions: raiseLegal, hand: strong }));
    expect(raised.action).toEqual({ type: 'raise', amount: 60 });
    assertLegal(raised, raiseLegal);

    const betLegal = la({
      canCheck: true,
      canCall: false,
      callAmount: 0,
      canRaise: true,
      canBet: true,
      minRaiseTo: 20,
      maxRaiseTo: 100,
    });
    const bet = policy.decide(view({ legalActions: betLegal, hand: strong }));
    expect(bet.action).toEqual({ type: 'bet', amount: 20 });
    assertLegal(bet, betLegal);
  });

  it('checks back a strong hand when raising and calling are unavailable', () => {
    const legal = la({
      canCheck: true,
      canCall: false,
      callAmount: 0,
      canRaise: false,
      canBet: false,
    });
    const decision = policy.decide(
      view({ legalActions: legal, hand: hand([cardFromName('Ac'), cardFromName('Ad')]) }),
    );
    expect(decision.action).toEqual({ type: 'check' });
    assertLegal(decision, legal);
  });

  it('folds a weak hand facing a bet', () => {
    const legal = la({ canCheck: false, canCall: true, canRaise: false, callAmount: 50 });
    const decision = policy.decide(
      view({
        legalActions: legal,
        potOdds: odds({ callAmount: 50, potOdds: 50 / 150, breakEvenEquity: 50 / 150 }),
        hand: hand([cardFromName('7c'), cardFromName('2d')]),
      }),
    );
    expect(decision.action).toEqual({ type: 'fold' });
    assertLegal(decision, legal);
  });

  it('never returns an illegal action across representative views', () => {
    const hands = [
      hand([cardFromName('Ac'), cardFromName('Ad')]),
      hand([cardFromName('2c'), cardFromName('2d')]),
      hand([cardFromName('7c'), cardFromName('2d')]),
      hand([cardFromName('Ah'), cardFromName('Kh')], [
        cardFromName('Qh'),
        cardFromName('Jh'),
        cardFromName('Th'),
      ]),
    ];
    const legals = [
      la({ canCheck: true, canCall: false, callAmount: 0, canRaise: true, minRaiseTo: 20, maxRaiseTo: 100 }),
      la({ canCheck: false, canCall: true, canRaise: false, callAmount: 10 }),
      la({ canCheck: false, canCall: true, canRaise: true, minRaiseTo: 40, maxRaiseTo: 40 }),
      la({ canCheck: false, canCall: true, canRaise: true, minRaiseTo: 60, maxRaiseTo: 500 }),
    ];
    for (const h of hands) {
      for (const legal of legals) {
        const decision = policy.decide(view({ legalActions: legal, hand: h, potOdds: odds() }));
        assertLegal(decision, legal);
      }
    }
  });
});
