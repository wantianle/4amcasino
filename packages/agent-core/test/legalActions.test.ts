import { describe, expect, it } from 'vitest';
import type { DecisionLegalActions } from '../src/decisionView.js';
import { isLegalAction, normalizeLegalActions } from '../src/legalActions.js';

/**
 * Narrow unit tests for the phase-1 `legalActions` layer: pins the normalisation
 * rules and proves the extracted function matches the three pre-move copies
 * (`postflopPolicy`, `stylePolicy`, `rulePolicy` all had identical bodies).
 */

function la(over: Partial<DecisionLegalActions> = {}): DecisionLegalActions {
  return {
    canCheck: false,
    canCall: true,
    callAmount: 50,
    canBet: false,
    canRaise: true,
    minRaiseTo: 100,
    maxRaiseTo: 1000,
    ...over,
  };
}

// The three pre-move bodies, each copied verbatim from `git show main:<path>`.
// They are NOT one shared copy: `postflopPolicy` and `rulePolicy` were module
// functions, `stylePolicy` a class method, and their formatting differs (the
// style/rule object literals carry a trailing comma and span multiple lines).
// Extracting all three from git and normalising whitespace shows the *only*
// textual difference is that trailing comma, so they must all agree.
// Source lines on `main`:
//   postflopPolicy.ts  function normalizeLegal
//   stylePolicy.ts     private normalizeLegal (class method)
//   rulePolicy.ts      function normalizeLegal

function oldNormalizePostflop(la: DecisionLegalActions): DecisionLegalActions {
  const canCall = la.canCall && la.callAmount > 0;
  const canCheck = la.canCheck || !canCall;
  const canRaise =
    (la.canBet || la.canRaise) &&
    la.minRaiseTo >= 1 &&
    la.maxRaiseTo >= la.minRaiseTo &&
    la.maxRaiseTo > 0;
  return { ...la, canCheck, canCall, canRaise, canBet: canRaise && la.canBet };
}

function oldNormalizeStyle(la: DecisionLegalActions): DecisionLegalActions {
  const canCall = la.canCall && la.callAmount > 0;
  const canCheck = la.canCheck || !canCall;
  const canRaise =
    (la.canBet || la.canRaise) && la.minRaiseTo >= 1 && la.maxRaiseTo >= la.minRaiseTo && la.maxRaiseTo > 0;
  return {
    ...la,
    canCheck,
    canCall,
    canRaise,
    canBet: canRaise && la.canBet,
  };
}

function oldNormalizeRule(la: DecisionLegalActions): DecisionLegalActions {
  const canCall = la.canCall && la.callAmount > 0;
  const canCheck = la.canCheck || !canCall;
  const canRaise =
    (la.canBet || la.canRaise) &&
    la.minRaiseTo >= 1 &&
    la.maxRaiseTo >= la.minRaiseTo &&
    la.maxRaiseTo > 0;
  return {
    ...la,
    canCheck,
    canCall,
    canRaise,
    canBet: canRaise && la.canBet,
  };
}

const OLD_NORMALIZERS = {
  postflopPolicy: oldNormalizePostflop,
  stylePolicy: oldNormalizeStyle,
  rulePolicy: oldNormalizeRule,
} as const;

describe('legalActions: normalizeLegalActions', () => {
  it('a zero call amount means checking is free', () => {
    const n = normalizeLegalActions(la({ canCheck: false, canCall: true, callAmount: 0 }));
    expect(n.canCall).toBe(false);
    expect(n.canCheck).toBe(true);
  });

  it('drops an inverted or non-positive raise range', () => {
    for (const bad of [
      la({ minRaiseTo: 0 }),
      la({ minRaiseTo: 500, maxRaiseTo: 400 }),
      la({ minRaiseTo: 100, maxRaiseTo: 0 }),
    ]) {
      const n = normalizeLegalActions(bad);
      expect(n.canRaise).toBe(false);
      expect(n.canBet).toBe(false);
    }
  });

  it('keeps canBet only when a legal raise and canBet were both set', () => {
    expect(normalizeLegalActions(la({ canBet: true })).canBet).toBe(true);
    expect(normalizeLegalActions(la({ canBet: true, canRaise: false, minRaiseTo: 0 })).canBet).toBe(false);
    // A raise available but canBet false must not invent a bet.
    expect(normalizeLegalActions(la({ canBet: false })).canBet).toBe(false);
  });

  it('matches each of the three pre-move implementations across a matrix of shapes', () => {
    const bools = [false, true];
    const ranges: Array<[number, number]> = [
      [100, 1000],
      [0, 1000], // min below 1 must disable the raise
      [500, 400], // inverted
      [100, 0], // non-positive max
      [1, 1], // valid boundary
    ];
    for (const [source, oldNormalize] of Object.entries(OLD_NORMALIZERS)) {
      for (const canCheck of bools) {
        for (const canCall of bools) {
          for (const callAmount of [0, 50]) {
            for (const canBet of bools) {
              for (const canRaise of bools) {
                for (const [minRaiseTo, maxRaiseTo] of ranges) {
                  const input = la({ canCheck, canCall, callAmount, canBet, canRaise, minRaiseTo, maxRaiseTo });
                  expect(normalizeLegalActions(input), `${source} ${JSON.stringify(input)}`).toEqual(
                    oldNormalize(input),
                  );
                }
              }
            }
          }
        }
      }
    }
  });
});

describe('legalActions: isLegalAction', () => {
  const n = normalizeLegalActions(la());

  it('checks bounds for bet/raise and the flags for check/call/fold', () => {
    expect(isLegalAction({ type: 'raise', amount: 1000 }, n)).toBe(true);
    expect(isLegalAction({ type: 'raise', amount: 99 }, n)).toBe(false);
    expect(isLegalAction({ type: 'raise', amount: 1001 }, n)).toBe(false);
    expect(isLegalAction({ type: 'raise' }, n)).toBe(false); // no amount
    expect(isLegalAction({ type: 'fold' }, n)).toBe(true); // always legal
    expect(isLegalAction({ type: 'check' }, n)).toBe(false);
    expect(isLegalAction({ type: 'check' }, normalizeLegalActions(la({ canCheck: true })))).toBe(true);
    expect(isLegalAction({ type: 'call' }, n)).toBe(true);
  });
});
