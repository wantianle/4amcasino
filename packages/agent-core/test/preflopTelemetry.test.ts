import { describe, expect, it } from 'vitest';
import { cardFromName } from '@4am/shared';
import type {
  DecisionLegalActions,
  DecisionSeat,
  DecisionView,
  PublicAction,
} from '../src/decisionView.js';
import { preflopActionOrder } from '../src/preflopCharts/index.js';
import { RulePolicy, type PreflopDecisionTelemetry } from '../src/rulePolicy.js';
import { RULE_PRESETS, type RuleParams } from '../src/ruleStyles.js';

/**
 * The preflop telemetry sink must be strictly observational: identical decisions
 * with and without it, and a throwing sink must not change the action. It also
 * carries the exact fields the "why no 4-bet?" diagnostic needs.
 */

const c = (n: string) => cardFromName(n);

function seat(over: Partial<DecisionSeat> = {}): DecisionSeat {
  return {
    seat: 0,
    userId: 1,
    displayName: 'p',
    isMe: false,
    stack: 10_000,
    committed: 0,
    total: 0,
    folded: false,
    allIn: false,
    sittingOut: false,
    connected: true,
    ...over,
  };
}

function act(s: number, type: PublicAction['action']['type'], amount?: number): PublicAction {
  return {
    actionSeq: 0,
    street: 'preflop',
    seat: s,
    action: { type, ...(amount === undefined ? {} : { amount }) },
    auto: false,
    ts: 0,
  };
}

const LEGAL_RAISE: DecisionLegalActions = {
  canCheck: false,
  canCall: true,
  callAmount: 500,
  canBet: false,
  canRaise: true,
  minRaiseTo: 1500,
  maxRaiseTo: 10_000,
};

function facing3BetView(heroCards: [string, string]): DecisionView {
  const n = 6;
  const heroSeat = 2;
  const villainSeat = 5;
  const seatOrder = Array.from({ length: n }, (_, i) => i);
  const order = preflopActionOrder(seatOrder);
  const heroIdx = order.indexOf(heroSeat);
  const pending = [heroSeat, ...order.slice(heroIdx + 1, heroIdx + 2)];
  const me = seat({ seat: heroSeat, isMe: true });
  const opponents = seatOrder
    .filter((s) => s !== heroSeat)
    .map((s) => seat({ seat: s, userId: 100 + s }));
  return {
    room: { id: 'r', name: 'r', sb: 50, bb: 100, minSettleHands: 0, sevenDeuceBonus: 0 },
    hand: {
      handId: 'h',
      street: 'preflop',
      buttonSeat: n - 1,
      board: [],
      pot: 1200,
      currentBet: 750,
      toAct: heroSeat,
      deadline: null,
      myCards: [c(heroCards[0]), c(heroCards[1])],
      mySeat: heroSeat,
    },
    me,
    legalActions: LEGAL_RAISE,
    potOdds: null,
    actionHistory: [act(heroSeat, 'raise', 250), act(villainSeat, 'raise', 750)],
    opponents,
    sessionMemory: { handsObserved: 0, netChips: null, recentHands: [], opponents: [] },
    historyComplete: true,
    seatOrder,
    actionSeq: 0,
    needToActSeats: pending,
  };
}

const PARAMS: RuleParams = { ...RULE_PRESETS['constrained-random'], adaptivePreflop: true };

describe('preflop telemetry sink', () => {
  it('does not change the decision output', () => {
    for (const cards of [
      ['Ac', 'Ad'],
      ['Kc', 'Kd'],
      ['Ac', 'Kc'],
      ['Qc', 'Qd'],
      ['7c', '2d'],
    ] as [string, string][]) {
      const view = facing3BetView(cards);
      const plain = new RulePolicy({ kind: 'constrained-random', params: PARAMS, seed: 7 }).decide(
        view,
      );
      const watched = new RulePolicy({
        kind: 'constrained-random',
        params: PARAMS,
        seed: 7,
        onPreflopDecision: () => {},
      }).decide(view);
      expect(watched).toEqual(plain);
    }
  });

  it('is fail-open: a throwing sink cannot change or crash the decision', () => {
    const view = facing3BetView(['Ac', 'Ad']);
    const plain = new RulePolicy({ kind: 'constrained-random', params: PARAMS, seed: 7 }).decide(
      view,
    );
    const watched = new RulePolicy({
      kind: 'constrained-random',
      params: PARAMS,
      seed: 7,
      onPreflopDecision: () => {
        throw new Error('sink down');
      },
    }).decide(view);
    expect(watched).toEqual(plain);
  });

  it('records the fields that answer "why no 4-bet?"', () => {
    const events: PreflopDecisionTelemetry[] = [];
    const view = facing3BetView(['Ac', 'Ad']);
    new RulePolicy({
      kind: 'constrained-random',
      params: PARAMS,
      seed: 7,
      onPreflopDecision: (e) => events.push(e),
    }).decide(view);

    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e).toMatchObject({
      policyKind: 'constrained-random',
      handClass: 'AA',
      spot: 'facing3Bet',
      situation: 'facing3Bet',
      raises: 2,
      callers: 0,
      heroRaised: true,
      historyComplete: true,
      adaptivePreflopAvailable: true,
      behindUnacted: 1,
      intent: 'raise',
      canRaise: true,
      minRaiseTo: 1500,
      maxRaiseTo: 10_000,
      returnedAction: 'raise',
      lastPreflopRaiserSeat: 5,
    });
    expect(e.frequencyRaise).toBeCloseTo(1, 9);
    expect(typeof e.heroIsIPToOpener).toBe('boolean');
  });

  it('exposes the constrained-random QQ flat (raise 0, call > 0)', () => {
    const events: PreflopDecisionTelemetry[] = [];
    new RulePolicy({
      kind: 'constrained-random',
      params: PARAMS,
      seed: 7,
      onPreflopDecision: (e) => events.push(e),
    }).decide(facing3BetView(['Qc', 'Qd']));
    const e = events[0]!;
    expect(e.handClass).toBe('QQ');
    expect(e.frequencyRaise).toBe(0);
    expect(e.frequencyCall).toBeGreaterThan(0);
    expect(e.intent).toBe('call');
    expect(e.returnedAction).toBe('call');
  });
});
