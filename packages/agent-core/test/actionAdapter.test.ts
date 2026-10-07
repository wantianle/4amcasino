import { describe, expect, it } from 'vitest';
import type { DecisionLegalActions } from '../src/decisionView.js';
import { betAmount, guaranteedLegalAction, raiseToAmount } from '../src/actionAdapter.js';

/**
 * Narrow unit tests for the phase-1 `actionAdapter` layer: pins the
 * guaranteed-legal fallback and the pot-fraction raise/bet sizing, and proves
 * they match the pre-move inline formulas in `postflopPolicy` / `stylePolicy`.
 */

function la(over: Partial<DecisionLegalActions> = {}): DecisionLegalActions {
  return {
    canCheck: false,
    canCall: false,
    callAmount: 0,
    canBet: false,
    canRaise: false,
    minRaiseTo: 0,
    maxRaiseTo: 0,
    ...over,
  };
}

// --- pre-move copies (the "before" side) ------------------------------------

// StylePolicy's old inline sizing (no non-finite guard).
function oldStyleRaiseAmount(pot: number, currentBet: number, fraction: number, min: number, max: number): number {
  const minDelta = Math.max(1, min - currentBet);
  const raw = currentBet + Math.max(minDelta, Math.round(pot * fraction));
  return Math.max(min, Math.min(max, raw));
}

// PostflopPolicy's old `raise()`, which used the finite-safe `clamp`.
function oldPostflopRaiseAmount(pot: number, currentBet: number, fraction: number, min: number, max: number): number {
  const clamp = (x: number, lo: number, hi: number) => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo);
  const minDelta = Math.max(1, min - currentBet);
  const target = currentBet + Math.max(minDelta, Math.round(pot * fraction));
  return clamp(target, min, max);
}

function oldPostflopBetAmount(pot: number, fraction: number, min: number, max: number): number {
  const raw = Math.round(pot * fraction);
  const clamp = (x: number, lo: number, hi: number) => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo);
  const amount = clamp(raw, min, max);
  return Math.max(1, amount);
}

describe('actionAdapter: guaranteedLegalAction', () => {
  it('prefers check, then call, then fold', () => {
    expect(guaranteedLegalAction(la({ canCheck: true }))).toEqual({ type: 'check' });
    expect(guaranteedLegalAction(la({ canCall: true }))).toEqual({ type: 'call' });
    expect(guaranteedLegalAction(la())).toEqual({ type: 'fold' });
  });
});

describe('actionAdapter: raiseToAmount', () => {
  it('matches both pre-move raise formulas over a finite matrix', () => {
    // For finite input the old style (`Math.max/min`) and postflop (`clamp`)
    // formulas agree; `raiseToAmount` must equal both.
    for (const pot of [0, 10, 100, 250]) {
      for (const currentBet of [0, 50, 200, 1000]) {
        for (const fraction of [0.33, 0.5, 0.75, 1.25]) {
          for (const [min, max] of [
            [1, 1000],
            [200, 400],
            [5000, 6000],
          ] as const) {
            const msg = `pot=${pot} cur=${currentBet} f=${fraction} [${min},${max}]`;
            const got = raiseToAmount({ pot, currentBet, fraction, minRaiseTo: min, maxRaiseTo: max });
            expect(got, `style ${msg}`).toBe(oldStyleRaiseAmount(pot, currentBet, fraction, min, max));
            expect(got, `postflop ${msg}`).toBe(oldPostflopRaiseAmount(pot, currentBet, fraction, min, max));
          }
        }
      }
    }
  });

  it('never double-counts currentBet and stays within the legal range', () => {
    // min raise is an absolute raise-to; delta floor must be over currentBet.
    expect(raiseToAmount({ pot: 100, currentBet: 50, fraction: 0.001, minRaiseTo: 100, maxRaiseTo: 1000 })).toBe(100);
    expect(raiseToAmount({ pot: 100, currentBet: 50, fraction: 10, minRaiseTo: 100, maxRaiseTo: 300 })).toBe(300);
  });

  it('falls back to minRaiseTo for a non-finite pot/currentBet/fraction, like the old postflop clamp', () => {
    const base = { pot: 100, currentBet: 50, fraction: 0.5, minRaiseTo: 100, maxRaiseTo: 1000 };
    for (const bad of [NaN, Infinity, -Infinity]) {
      for (const field of ['pot', 'currentBet', 'fraction'] as const) {
        const input = { ...base, [field]: bad };
        const msg = `${field}=${bad}`;
        // The extracted function must reproduce the old postflop behaviour...
        expect(raiseToAmount(input), `postflop ${msg}`).toBe(
          oldPostflopRaiseAmount(input.pot, input.currentBet, input.fraction, input.minRaiseTo, input.maxRaiseTo),
        );
        // ...which is the finite-safe fallback to `minRaiseTo`.
        expect(raiseToAmount(input), msg).toBe(base.minRaiseTo);
      }
    }
  });

  it('documented divergence: the old style formula returned non-legal values for NaN', () => {
    // Proof the finite guard is load-bearing, not decoration: the old StylePolicy
    // inline formula returned `NaN` where the old PostflopPolicy clamp returned
    // the finite `minRaiseTo`. `raiseToAmount` adopts the postflop behaviour.
    expect(oldStyleRaiseAmount(NaN, 50, 0.5, 100, 1000)).toBeNaN();
    expect(oldPostflopRaiseAmount(NaN, 50, 0.5, 100, 1000)).toBe(100);
    expect(raiseToAmount({ pot: NaN, currentBet: 50, fraction: 0.5, minRaiseTo: 100, maxRaiseTo: 1000 })).toBe(100);
  });
});

describe('actionAdapter: betAmount', () => {
  it('matches the pre-move PostflopPolicy bet formula over a matrix', () => {
    for (const pot of [0, 10, 100, 250]) {
      for (const fraction of [0.33, 0.5, 0.75, 1.25, 1.5]) {
        for (const [min, max] of [
          [1, 1000],
          [200, 400],
          [5000, 6000],
        ] as const) {
          const expected = oldPostflopBetAmount(pot, fraction, min, max);
          expect(
            betAmount({ pot, fraction, minRaiseTo: min, maxRaiseTo: max }),
            `pot=${pot} f=${fraction} [${min},${max}]`,
          ).toBe(expected);
        }
      }
    }
  });

  it('floors a bet at 1 chip and clamps to the legal range', () => {
    expect(betAmount({ pot: 0, fraction: 0.5, minRaiseTo: 1, maxRaiseTo: 1000 })).toBe(1);
    expect(betAmount({ pot: 100, fraction: 10, minRaiseTo: 1, maxRaiseTo: 1000 })).toBe(1000);
  });
});
