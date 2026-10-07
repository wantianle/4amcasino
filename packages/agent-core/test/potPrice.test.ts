import { describe, expect, it } from 'vitest';
import type { DecisionPotOdds } from '../src/decisionView.js';
import {
  bluffToValueRatio,
  defendProbability,
  mdf,
  resolveFacingBetPrice,
} from '../src/potPrice.js';

/**
 * Narrow unit tests for the phase-1 `potPrice` layer: pins the price helpers
 * and proves the extraction matches the pre-move implementation.
 */

// --- pre-move copies (the "before" side) ------------------------------------

function oldMdf(potBeforeBet: number, bet: number): number {
  if (!Number.isFinite(bet) || bet <= 0) return 1;
  const p = Math.max(0, Number.isFinite(potBeforeBet) ? potBeforeBet : 0);
  return p / (p + bet);
}

function oldBluffToValue(fraction: number): number {
  const f = Math.max(0, Number.isFinite(fraction) ? fraction : 0);
  return f / (1 + f);
}

function oldDefendProbability(percentile: number, requiredMdf: number, band = 0.06): number {
  const required = Math.min(1, Math.max(0, requiredMdf));
  const threshold = 1 - required;
  const effectiveBand = Math.min(band, threshold, 1 - threshold);
  if (effectiveBand <= 0) return percentile >= threshold ? 1 : 0;
  return Math.min(1, Math.max(0, (percentile - (threshold - effectiveBand)) / (2 * effectiveBand)));
}

const EPS = 1e-6;

function oldResolveFacingBetPrice(
  potOdds: DecisionPotOdds | null | undefined,
  call: number,
): { trusted: boolean; potBefore: number; derivedOdds: number; requiredEquity: number; requiredMdf: number } {
  const callValid = Number.isFinite(call) && call >= 0;
  const potValue = potOdds?.pot;
  const mirrorCall = potOdds?.callAmount;
  const potUsable =
    callValid && typeof potValue === 'number' && Number.isFinite(potValue) && potValue >= 0 && potValue >= call;
  const mirrorCallValid =
    typeof mirrorCall === 'number' && Number.isFinite(mirrorCall) && mirrorCall >= 0 && mirrorCall === call;
  const potBefore = potUsable ? (potValue as number) - call : 0;
  const denominator = potBefore + 2 * call;
  const derivedOdds = potUsable && denominator > 0 ? call / denominator : 0;
  const oddsField = potOdds?.potOdds;
  const breakEvenField = potOdds?.breakEvenEquity;
  const oddsValid =
    typeof oddsField === 'number' &&
    Number.isFinite(oddsField) &&
    oddsField >= 0 &&
    oddsField <= 1 &&
    Math.abs(oddsField - derivedOdds) <= EPS;
  const breakEvenValid =
    typeof breakEvenField === 'number' &&
    Number.isFinite(breakEvenField) &&
    breakEvenField >= 0 &&
    breakEvenField <= 1 &&
    Math.abs(breakEvenField - derivedOdds) <= EPS &&
    typeof oddsField === 'number' &&
    breakEvenField === oddsField;
  const trusted = potUsable && mirrorCallValid && oddsValid && breakEvenValid;
  return {
    trusted,
    potBefore,
    derivedOdds,
    requiredEquity: trusted ? (oddsField as number) : derivedOdds,
    requiredMdf: potUsable ? oldMdf(potBefore, call) : 0.5,
  };
}

describe('potPrice: mdf / bluffToValueRatio', () => {
  it('matches the pre-move formulas (including non-finite inputs)', () => {
    for (const pot of [0, 10, 100, Number.NaN, Number.POSITIVE_INFINITY]) {
      for (const bet of [0, -5, 50, 100, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(mdf(pot, bet), `mdf(${pot},${bet})`).toBe(oldMdf(pot, bet));
      }
    }
    for (const f of [0, 0.5, 1, 2, Number.NaN, -1]) {
      expect(bluffToValueRatio(f), `bvr(${f})`).toBe(oldBluffToValue(f));
    }
  });
});

describe('potPrice: defendProbability', () => {
  it('matches the pre-move implementation over a percentile/required grid', () => {
    for (const required of [0, 0.25, 0.5, 0.75, 1]) {
      for (let i = 0; i <= 10; i++) {
        const pct = i / 10;
        expect(defendProbability(pct, required), `defend(${pct},${required})`).toBe(
          oldDefendProbability(pct, required),
        );
      }
    }
  });

  it('integrates to the required MDF on [0,1]', () => {
    const n = 2000;
    for (const required of [0.25, 0.4, 0.6, 0.75]) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += defendProbability((i + 0.5) / n, required);
      expect(sum / n).toBeCloseTo(required, 3);
    }
  });
});

describe('potPrice: resolveFacingBetPrice', () => {
  const valid = (over: Partial<DecisionPotOdds> = {}): DecisionPotOdds => {
    const pot = over.pot ?? 100;
    const call = over.callAmount ?? 50;
    const odds = call / (pot + call);
    return { callAmount: call, pot, potOdds: odds, breakEvenEquity: odds, ...over };
  };

  it('trusts a consistent snapshot and derives potBefore + requiredMdf', () => {
    const p = resolveFacingBetPrice(valid(), 50);
    expect(p.trusted).toBe(true);
    expect(p.potBefore).toBe(50);
    expect(p.requiredMdf).toBeCloseTo(oldMdf(50, 50), 12);
    expect(p.requiredEquity).toBeCloseTo(50 / 150, 12);
  });

  it('matches the pre-move implementation across valid and malformed snapshots', () => {
    const cases: Array<[DecisionPotOdds | null | undefined, number]> = [
      [valid(), 50],
      [null, 50],
      [undefined, 50],
      [valid({ pot: 40 }), 50], // pot < call
      [valid({ callAmount: 49 }), 50], // mirror mismatch
      [valid({ potOdds: 0.9, breakEvenEquity: 0.9 }), 50],
      [{ callAmount: 0, pot: 100, potOdds: 0, breakEvenEquity: 0 }, 0],
    ];
    for (const [po, call] of cases) {
      expect(resolveFacingBetPrice(po, call)).toEqual(oldResolveFacingBetPrice(po, call));
    }
  });
});
