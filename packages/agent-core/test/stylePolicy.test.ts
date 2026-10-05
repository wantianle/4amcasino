import { describe, expect, it } from 'vitest';
import {
  applyAction,
  cardFromName,
  legalActions,
  type BettingState,
  type CardId,
} from '@4am/shared';
import type {
  DecisionHand,
  DecisionLegalActions,
  DecisionPotOdds,
  DecisionSeat,
  DecisionView,
} from '../src/decisionView.js';
import type { PolicyDecision } from '../src/policy.js';
import { POLICY_STYLES, parseStyleOverrides, type PolicyKind } from '../src/policyStyles.js';
import { StylePolicy, resolvePolicy } from '../src/stylePolicy.js';

const c = (n: string) => cardFromName(n);

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

function hand(myCards: CardId[], board: CardId[] = [], pot = 0): DecisionHand {
  return {
    handId: 'h1',
    street: board.length >= 3 ? 'flop' : 'preflop',
    buttonSeat: 0,
    board,
    pot,
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

const KINDS: PolicyKind[] = ['tight-aggressive', 'loose-aggressive', 'calling-station', 'constrained-random'];

/** A policy whose equity estimate is pinned, to isolate threshold logic. */
function pinned(kind: PolicyKind, equity: number, seed = 1): StylePolicy {
  return new StylePolicy(kind, { equity: () => equity, seed, samples: 30 });
}

function seat(over: Partial<DecisionSeat> = {}): DecisionSeat {
  return {
    seat: 1,
    userId: 2,
    displayName: 'opp',
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

/**
 * Rebuild a `BettingState` from the view's legal actions so the shared
 * `legalActions()` / `applyAction()` can authoritatively re-check the policy's
 * choice - including malformed inputs.
 */
function stateFor(la: DecisionLegalActions): BettingState {
  const currentBet = la.canCheck ? 0 : la.callAmount;
  const committed = 0;
  const lastRaiseSize = Math.max(1, la.minRaiseTo - currentBet);
  const stack = Math.max(1, la.maxRaiseTo, la.minRaiseTo);
  return {
    street: 'flop',
    buttonSeat: 0,
    sb: 1,
    bb: Math.max(1, la.minRaiseTo),
    currentBet,
    lastRaiseSize,
    lastFullRaiseAt: 0,
    toAct: 0,
    needToAct: [0],
    winnerByFold: null,
    seats: [
      { seat: 0, stack, committed, total: committed, folded: false, allIn: false, lastActedAt: null },
      {
        seat: 1,
        stack: 1000,
        committed: currentBet,
        total: currentBet,
        folded: false,
        allIn: false,
        lastActedAt: null,
      },
    ],
  };
}

/** The shared engine must accept the action (or it is not really legal). */
function assertSharedLegal(d: PolicyDecision, la: DecisionLegalActions): void {
  const st = stateFor(la);
  const auth = legalActions(st);
  expect(auth).not.toBeNull();
  applyAction(st, 0, d.action);
}

describe('StylePolicy: legality', () => {
  it('never returns an illegal action for any style across representative views', () => {
    const hands = [
      hand([c('Ac'), c('Ad')]),
      hand([c('2c'), c('2d')]),
      hand([c('7c'), c('2d')]),
      hand([c('Ah'), c('Kh')], [c('Qh'), c('Jh'), c('Th')]),
      hand([c('Qs'), c('Js')], [c('2d'), c('7c'), c('9h'), c('Kd')]),
    ];
    const legals = [
      la({ canCheck: true, canCall: false, callAmount: 0, canRaise: true, canBet: true, minRaiseTo: 20, maxRaiseTo: 100 }),
      la({ canCheck: false, canCall: true, canRaise: false, callAmount: 10 }),
      la({ canCheck: false, canCall: true, canRaise: true, minRaiseTo: 40, maxRaiseTo: 40, callAmount: 40 }),
      la({ canCheck: true, canCall: false, callAmount: 0, canRaise: false, canBet: false }),
      la({ canCheck: false, canCall: true, canRaise: true, minRaiseTo: 60, maxRaiseTo: 500, callAmount: 50 }),
    ];
    for (const kind of KINDS) {
      const policy = new StylePolicy(kind, { samples: 30, seed: 5 });
      for (const h of hands) {
        for (const legal of legals) {
          const decision = policy.decide(view({ legalActions: legal, hand: h, potOdds: odds() }));
          assertLegal(decision, legal);
        }
      }
    }
  });

  it('passes the shared legalActions()/applyAction() re-check, even for malformed views', () => {
    const malformed: DecisionLegalActions[] = [
      // canCall but nothing to call
      la({ canCheck: false, canCall: true, canRaise: false, callAmount: 0, minRaiseTo: 0, maxRaiseTo: 0 }),
      // raise range inverted / zero
      la({ canCheck: true, canCall: false, callAmount: 0, canRaise: true, canBet: true, minRaiseTo: 0, maxRaiseTo: 0 }),
      la({ canCheck: false, canCall: true, canRaise: true, callAmount: 10, minRaiseTo: 100, maxRaiseTo: 40 }),
      // short all-in: min == max
      la({ canCheck: false, canCall: true, canRaise: true, callAmount: 20, minRaiseTo: 40, maxRaiseTo: 40 }),
      // only fold is legal
      la({ canCheck: false, canCall: false, canRaise: false, callAmount: 0, minRaiseTo: 0, maxRaiseTo: 0 }),
      // normal shapes
      la({ canCheck: true, canCall: false, callAmount: 0, canRaise: true, canBet: true, minRaiseTo: 20, maxRaiseTo: 100 }),
      la({ canCheck: false, canCall: true, canRaise: true, callAmount: 50, minRaiseTo: 60, maxRaiseTo: 500 }),
    ];
    const hands = [hand([c('Ac'), c('Ad')]), hand([c('7c'), c('2d')]), hand([c('Ah'), c('Kh')], [c('Qh'), c('Jh'), c('2c')])];
    for (const kind of KINDS) {
      const policy = new StylePolicy(kind, { samples: 20, seed: 9 });
      for (const legal of malformed) {
        for (const h of hands) {
          const d = policy.decide(view({ legalActions: legal, hand: h, potOdds: odds() }));
          assertSharedLegal(d, legal);
        }
      }
    }
  });

  it('fails closed (equity 0) on non-finite injected equity and clamps out-of-range', () => {
    const facing = la({ canCheck: false, canCall: true, canRaise: false, callAmount: 20 });
    const v = view({ legalActions: facing, hand: hand([c('7c'), c('2d')]), potOdds: odds({ callAmount: 20, pot: 60, potOdds: 0.25, breakEvenEquity: 0.25 }) });
    const params = { ...POLICY_STYLES['tight-aggressive'], bluffFrequency: 0 };
    for (const bad of [Number.NaN, Infinity, -Infinity, -1]) {
      const d = new StylePolicy('tight-aggressive', { params, equity: () => bad }).decide(v);
      expect(d.action.type).toBe('fold');
    }
    // a finite value above 1 clamps to 1 and calls
    const high = new StylePolicy('tight-aggressive', { params, equity: () => 5 }).decide(v);
    expect(high.action.type).toBe('call');
  });

  it('never emits a zero-amount bet/raise when minRaiseTo is malformed to 0', () => {
    const legal = la({
      canCheck: false,
      canCall: false,
      canRaise: true,
      canBet: true,
      minRaiseTo: 0,
      maxRaiseTo: 100,
      callAmount: 0,
    });
    for (const kind of KINDS) {
      const d = new StylePolicy(kind, { samples: 20, seed: 3 }).decide(
        view({ legalActions: legal, hand: hand([c('Ac'), c('Ad')], [], 0), potOdds: odds() }),
      );
      if (d.action.type === 'bet' || d.action.type === 'raise')
        expect(d.action.amount).toBeGreaterThanOrEqual(1);
      assertSharedLegal(d, legal);
    }
  });

  it('honours canBet vs canRaise independently', () => {
    const betOnly = la({ canCheck: true, canCall: false, callAmount: 0, canBet: true, canRaise: false, minRaiseTo: 20, maxRaiseTo: 100 });
    const raiseOnly = la({ canCheck: false, canCall: true, callAmount: 20, canBet: false, canRaise: true, minRaiseTo: 40, maxRaiseTo: 200 });
    const vBet = view({ legalActions: betOnly, hand: hand([c('Ac'), c('Ad')], [], 50), potOdds: odds() });
    const vRaise = view({
      legalActions: raiseOnly,
      hand: hand([c('Ac'), c('Ad')], [], 50),
      potOdds: odds({ callAmount: 20, pot: 50, potOdds: 20 / 70, breakEvenEquity: 20 / 70 }),
    });
    for (const kind of KINDS) {
      const p = new StylePolicy(kind, { samples: 20, seed: 2, equity: () => 0.9 });
      const b = p.decide(vBet);
      assertLegal(b, betOnly);
      assertSharedLegal(b, betOnly);
      const r = p.decide(vRaise);
      assertLegal(r, raiseOnly);
      assertSharedLegal(r, raiseOnly);
    }
  });

  it('throws only when asked to act without legal actions', () => {
    const policy = new StylePolicy('tight-aggressive', { samples: 10 });
    expect(() => policy.decide(view())).toThrow(/out of turn/);
  });
});

describe('StylePolicy: character', () => {
  it('tight folds a weak hand facing a big bet, loose and station call', () => {
    const weak = hand([c('7c'), c('2d')]);
    const facingBet = la({ canCheck: false, canCall: true, canRaise: false, callAmount: 40 });
    const price = odds({ callAmount: 40, pot: 60, potOdds: 40 / 100, breakEvenEquity: 40 / 100 });
    const v = view({ legalActions: facingBet, hand: weak, potOdds: price });

    expect(pinned('tight-aggressive', 0.34).decide(v).action).toEqual({ type: 'fold' });
    expect(pinned('loose-aggressive', 0.34).decide(v).action).toEqual({ type: 'call' });
    expect(pinned('calling-station', 0.34).decide(v).action).toEqual({ type: 'call' });
  });

  it('sizes value bets from the style fraction, inside the legal bounds', () => {
    const legal = la({
      canCheck: true,
      canCall: false,
      callAmount: 0,
      canRaise: true,
      canBet: true,
      minRaiseTo: 20,
      maxRaiseTo: 1000,
    });
    const v = view({ legalActions: legal, hand: hand([c('Ac'), c('Ad')], [], 100), potOdds: odds() });
    const tight = pinned('tight-aggressive', 0.9).decide(v).action;
    const loose = pinned('loose-aggressive', 0.9).decide(v).action;
    const station = pinned('calling-station', 0.9).decide(v).action;
    expect(tight).toEqual({ type: 'bet', amount: 60 });
    expect(loose).toEqual({ type: 'bet', amount: 85 });
    expect(station).toEqual({ type: 'bet', amount: 25 });
    for (const a of [tight, loose, station]) assertLegal({ action: a, reason: '' }, legal);
  });

  it('sizes a raise from the current bet without double-counting it', () => {
    const legal = la({
      canCheck: false,
      canCall: true,
      canRaise: true,
      callAmount: 40,
      minRaiseTo: 60,
      maxRaiseTo: 1000,
    });
    const h = hand([c('Ac'), c('Ad')]);
    h.currentBet = 40;
    const v = view({
      legalActions: legal,
      hand: h,
      potOdds: odds({ callAmount: 40, pot: 0, potOdds: 1, breakEvenEquity: 1 }),
    });
    // minDelta = 60 - 40 = 20, pot*fraction = 0 -> raise to 40 + 20 = 60
    // (the old buggy math produced 40 + 60 = 100).
    expect(pinned('tight-aggressive', 0.9).decide(v).action).toEqual({ type: 'raise', amount: 60 });
  });

  it('a station does not raise a merely-good hand that tight/loose value-raise', () => {
    const legal = la({ canCheck: true, canCall: false, callAmount: 0, canRaise: true, canBet: true, minRaiseTo: 20, maxRaiseTo: 1000 });
    const v = view({ legalActions: legal, hand: hand([c('Ac'), c('Kd')], [], 100), potOdds: odds() });
    // equity 0.65 clears tight (0.60) and loose (0.54) but not station (0.74)
    const station = new StylePolicy('calling-station', {
      equity: () => 0.65,
      params: { ...POLICY_STYLES['calling-station'], bluffFrequency: 0 },
    });
    expect(pinned('tight-aggressive', 0.65).decide(v).action.type).toBe('bet');
    expect(pinned('loose-aggressive', 0.65).decide(v).action.type).toBe('bet');
    expect(station.decide(v).action.type).toBe('check');
  });
});

describe('StylePolicy: opponent counting', () => {
  it('counts all-in opponents (they reach showdown) in the equity estimate', () => {
    const seen: number[] = [];
    const policy = new StylePolicy('tight-aggressive', {
      equity: (input) => {
        seen.push(input.opponents ?? 0);
        return 0.5;
      },
      params: { ...POLICY_STYLES['tight-aggressive'], bluffFrequency: 0 },
    });
    const legal = la({ canCheck: true, canCall: false, callAmount: 0, canRaise: false, canBet: false });
    const call = (opponents: DecisionSeat[]) =>
      policy.decide(view({ legalActions: legal, hand: hand([c('Ac'), c('Kd')]), opponents }));

    call([]); // no opponents -> floor of 1
    call([seat({ folded: true })]); // only a folded opponent -> floor of 1
    call([seat()]); // one active
    call([seat(), seat({ allIn: true })]); // active + all-in -> both contest
    call([seat({ allIn: true }), seat({ allIn: true }), seat({ allIn: true })]); // three all-in

    expect(seen).toEqual([1, 1, 1, 2, 3]);
  });

  it('decides legally with the maximum 8 opponents across every board length (0–5)', () => {
    const others = Array.from({ length: 8 }, (_, i) => seat({ seat: i + 1, userId: i + 2 }));
    const boards: CardId[][] = [
      [],
      [c('2c'), c('3d'), c('4h')],
      [c('2c'), c('3d'), c('4h'), c('5s')],
      [c('2c'), c('3d'), c('4h'), c('5s'), c('7c')],
    ];
    const legal = la({
      canCheck: false,
      canCall: true,
      canRaise: true,
      callAmount: 20,
      minRaiseTo: 40,
      maxRaiseTo: 200,
    });
    const price = odds({ callAmount: 20, pot: 100, potOdds: 20 / 120, breakEvenEquity: 20 / 120 });
    for (const kind of KINDS) {
      for (const board of boards) {
        const d = new StylePolicy(kind, { samples: 30, seed: 4 }).decide(
          view({
            legalActions: legal,
            hand: hand([c('Ac'), c('Kd')], board),
            potOdds: price,
            opponents: others,
          }),
        );
        assertLegal(d, legal);
        assertSharedLegal(d, legal);
      }
    }
  });
});

describe('StylePolicy: constrained random', () => {
  it('is reproducible for a fixed seed and stays legal', () => {
    const legal = la({ canCheck: false, canCall: true, canRaise: true, minRaiseTo: 40, maxRaiseTo: 200, callAmount: 20 });
    const v = view({ legalActions: legal, hand: hand([c('7c'), c('2d')]), potOdds: odds() });
    const a = new StylePolicy('constrained-random', { seed: 123, equity: () => 0.5 }).decide(v);
    const b = new StylePolicy('constrained-random', { seed: 123, equity: () => 0.5 }).decide(v);
    expect(a.action).toEqual(b.action);
    assertLegal(a, legal);
  });

  it('remains legal across many seeds', () => {
    const legal = la({ canCheck: true, canCall: false, callAmount: 0, canRaise: true, canBet: true, minRaiseTo: 40, maxRaiseTo: 41 });
    const v = view({ legalActions: legal, hand: hand([c('Ah'), c('Kh')], [c('Qh'), c('Jh'), c('2c')], 120), potOdds: odds() });
    for (let seed = 0; seed < 50; seed++) {
      const d = new StylePolicy('constrained-random', { seed, equity: () => 0.5 }).decide(v);
      assertLegal(d, legal);
      assertSharedLegal(d, legal);
    }
  });

  it('makes randomness meaningful: 0 is the pure heuristic, 1 mixes legal actions', () => {
    const legal = la({ canCheck: false, canCall: true, canRaise: true, minRaiseTo: 40, maxRaiseTo: 200, callAmount: 20 });
    const v = view({
      legalActions: legal,
      hand: hand([c('7c'), c('2d')]),
      potOdds: odds({ callAmount: 20, pot: 60, potOdds: 0.25, breakEvenEquity: 0.25 }),
    });
    const base = POLICY_STYLES['constrained-random'];
    const zero = new Set<string>();
    const half = new Set<string>();
    const one = new Set<string>();
    const at = (randomness: number, seed: number) =>
      new StylePolicy('constrained-random', {
        params: { ...base, randomness, bluffFrequency: 0 },
        equity: () => 0.2,
        seed,
      }).decide(v).action.type;
    for (let seed = 0; seed < 200; seed++) {
      zero.add(at(0, seed));
      half.add(at(0.5, seed));
      one.add(at(1, seed));
    }
    // randomness 0 -> the equity heuristic (equity 0.2 below every bar -> fold)
    expect([...zero]).toEqual(['fold']);
    // randomness 1 -> a uniform draw over the legal candidates
    expect(one.size).toBeGreaterThan(1);
    // randomness 0.5 -> a blend: heuristic still dominates, but randomness shows
    expect(half.has('fold')).toBe(true);
    expect(half.has('call') || half.has('raise')).toBe(true);
  });
});

describe('resolvePolicy / parseStyleOverrides', () => {
  it('maps the four styles and their aliases', () => {
    expect(resolvePolicy('scripted').kind).toBe('tight-aggressive');
    expect(resolvePolicy('scripted').policy.name).toBe('scripted-tight-aggressive');
    expect(resolvePolicy('TAG').kind).toBe('tight-aggressive');
    expect(resolvePolicy('LAG').kind).toBe('loose-aggressive');
    expect(resolvePolicy('Station').kind).toBe('calling-station');
    expect(resolvePolicy('random').kind).toBe('constrained-random');
    expect(resolvePolicy(null).kind).toBe('tight-aggressive');
  });

  it('falls back to the default for an unknown kind and records a warning', () => {
    const resolved = resolvePolicy('no-such-style');
    expect(resolved.kind).toBe('tight-aggressive');
    expect(resolved.policy.name).toBe('scripted-tight-aggressive');
    expect(resolved.warnings.join(' ')).toMatch(/unknown policyKind/);
  });

  it('never throws on invalid policy_json and keeps the style default', () => {
    const bad = resolvePolicy('loose-aggressive', '{not json');
    expect(bad.kind).toBe('loose-aggressive');
    expect(bad.policy.name).toBe('style-loose-aggressive');
    expect(bad.warnings.join(' ')).toMatch(/not valid JSON/);
  });

  it('applies valid overrides (switching to the configurable implementation) and reports unknown keys', () => {
    const resolved = resolvePolicy(
      'tight-aggressive',
      JSON.stringify({ valueRaiseFraction: 0.9, bogus: 1 }),
    );
    expect(resolved.policy.name).toBe('style-tight-aggressive');
    expect(resolved.warnings.join(' ')).toMatch(/unknown policy parameter "bogus"/);
    expect(resolvePolicy('tight-aggressive').policy.name).toBe('scripted-tight-aggressive');
  });

  it('a randomness override changes resolved behavior, not just the field', () => {
    const legal = la({ canCheck: false, canCall: true, canRaise: true, minRaiseTo: 40, maxRaiseTo: 200, callAmount: 10 });
    const base = view({
      legalActions: legal,
      hand: hand([c('Ac'), c('Ad')], [], 40),
      potOdds: odds({ callAmount: 10, pot: 40, potOdds: 10 / 50, breakEvenEquity: 10 / 50 }),
    });
    const pure = resolvePolicy('constrained-random', JSON.stringify({ randomness: 0 })).policy as StylePolicy;
    const random = resolvePolicy('constrained-random').policy as StylePolicy; // default randomness = 1
    const pureTypes = new Set<string>();
    const randomTypes = new Set<string>();
    for (let i = 0; i < 80; i++) {
      const v = { ...base, hand: { ...base.hand!, handId: `h${i}` } };
      pureTypes.add(pure.decide(v).action.type);
      randomTypes.add(random.decide(v).action.type);
    }
    // AA facing a bet: pure heuristic always value-raises; the random policy mixes.
    expect([...pureTypes]).toEqual(['raise']);
    expect(randomTypes.size).toBeGreaterThan(1);
  });

  it('validates override types and ranges without throwing', () => {
    const ok = parseStyleOverrides('loose-aggressive', JSON.stringify({ callEquity: 0.5 }));
    expect(ok.applied).toBe(true);
    expect(ok.params.callEquity).toBe(0.5);
    expect(ok.errors).toEqual([]);

    const bad = parseStyleOverrides('loose-aggressive', JSON.stringify({ callEquity: 2 }));
    expect(bad.applied).toBe(false);
    expect(bad.params.callEquity).toBe(POLICY_STYLES['loose-aggressive'].callEquity);
    expect(bad.errors.length).toBe(1);

    const randomness = parseStyleOverrides('constrained-random', JSON.stringify({ randomness: 0 }));
    expect(randomness.applied).toBe(true);
    expect(randomness.params.randomness).toBe(0);
  });
});
