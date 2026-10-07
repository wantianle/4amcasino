import { describe, expect, it } from 'vitest';
import { cardFromName, type CardId } from '@4am/shared';
import type {
  DecisionLegalActions,
  DecisionSeat,
  DecisionView,
} from '../src/decisionView.js';
import { ConstrainedRandomPolicy } from '../src/constrainedRandom.js';
import {
  CONSTRAINED_RANDOM_SPREAD,
  RULE_PRESETS,
  sampleConstrainedRandomParams,
  type RuleParams,
} from '../src/ruleStyles.js';
import { mulberry32 } from '../src/equity.js';
import { RulePolicy, type PreflopDecisionTelemetry } from '../src/rulePolicy.js';
import { resolvePolicyForDifficulty } from '../src/difficultyPolicy.js';
import { StylePolicy } from '../src/stylePolicy.js';

/**
 * `constrained-random` must actually randomise its *style*, at the default
 * `medium` tier, while leaving every other preset (and the `low` tier)
 * byte-for-byte unchanged. These tests pin:
 *   - the pure per-hand parameter sampler (reproducible, mean-preserving, legal);
 *   - that a medium constrained-random bot's preflop frequencies vary by hand;
 *   - that other presets still resolve to a plain `RulePolicy` with the exact
 *     preset params, and that `low` still resolves to a `StylePolicy`.
 */

const c = (n: string) => cardFromName(n);

type Pos = 'UTG' | 'UTG1' | 'MP' | 'LJ' | 'HJ' | 'CO' | 'BTN' | 'SB' | 'BB';
const POS_INDEX: Record<Pos, number> = {
  SB: 0,
  BB: 1,
  UTG: 2,
  UTG1: 3,
  MP: 4,
  LJ: 5,
  HJ: 6,
  CO: 7,
  BTN: 8,
};
const SEAT_ORDER = Array.from({ length: 9 }, (_, i) => i);
const STACK = 10_000;

function seat(over: Partial<DecisionSeat> = {}): DecisionSeat {
  return {
    seat: 0,
    userId: 1,
    displayName: 'p',
    isMe: false,
    stack: STACK,
    committed: 0,
    total: 0,
    folded: false,
    allIn: false,
    sittingOut: false,
    connected: true,
    ...over,
  };
}

const LEGAL_OPEN: DecisionLegalActions = {
  canCheck: false,
  canCall: true,
  callAmount: 100,
  canBet: false,
  canRaise: true,
  minRaiseTo: 200,
  maxRaiseTo: STACK,
};

/**
 * Unopened BTN view with a marginal hand (`Q4s` by default): its open frequency
 * is driven by `preflopScale` / `bluffScale`, so it is a sensitive probe of the
 * sampled params. `handId` is the only per-hand input that changes.
 */
function openView(
  handId: string | null | undefined,
  cards: CardId[] = [c('Qc'), c('4c')],
): DecisionView {
  const mySeat = POS_INDEX.BTN;
  return {
    room: { id: 'r1', name: 'room', sb: 50, bb: 100, minSettleHands: 0, sevenDeuceBonus: 0 },
    hand: {
      // Deliberately cast: these tests exercise the view's runtime shape when a
      // producer sends a missing/empty id, which the declared type forbids.
      handId: handId as string,
      street: 'preflop',
      buttonSeat: POS_INDEX.BTN,
      board: [],
      pot: 150,
      currentBet: 100,
      toAct: mySeat,
      deadline: null,
      myCards: cards,
      mySeat,
    },
    me: seat({ seat: mySeat, isMe: true }),
    legalActions: LEGAL_OPEN,
    potOdds: { callAmount: 100, pot: 150, potOdds: 100 / 250, breakEvenEquity: 100 / 250 },
    actionHistory: [],
    opponents: SEAT_ORDER.filter((s) => s !== mySeat).map((s) => seat({ seat: s, userId: 100 + s })),
    sessionMemory: { handsObserved: 0, netChips: null, recentHands: [], opponents: [] },
    historyComplete: true,
    seatOrder: SEAT_ORDER,
    actionSeq: 0,
  };
}

const BASE: RuleParams = { ...RULE_PRESETS['constrained-random'] };
const KNOBS = [
  'preflopScale',
  'threeBetScale',
  'bluffScale',
  'valueBetScale',
  'multiwayBluffScale',
  'maxOverbetFrequency',
] as const;

describe('sampleConstrainedRandomParams', () => {
  it('is reproducible: the same seed yields identical params', () => {
    const a = sampleConstrainedRandomParams(BASE, mulberry32(1234));
    const b = sampleConstrainedRandomParams(BASE, mulberry32(1234));
    expect(a).toEqual(b);
  });

  it('actually varies: different seeds yield different params', () => {
    const a = sampleConstrainedRandomParams(BASE, mulberry32(1));
    const b = sampleConstrainedRandomParams(BASE, mulberry32(2));
    expect(a).not.toEqual(b);
    // At least one knob moved (not just float noise on one field).
    expect(KNOBS.some((k) => a[k] !== b[k])).toBe(true);
  });

  it('keeps every draw finite, in range, and inside the jitter band', () => {
    for (let seed = 0; seed < 500; seed++) {
      const p = sampleConstrainedRandomParams(BASE, mulberry32(seed));
      for (const k of KNOBS) {
        const v = p[k];
        const base = BASE[k];
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(Math.max(0, base * (1 - CONSTRAINED_RANDOM_SPREAD)));
        expect(v).toBeLessThanOrEqual(base * (1 + CONSTRAINED_RANDOM_SPREAD) + 1e-12);
      }
      expect(p.adaptivePreflop).toBe(BASE.adaptivePreflop);
    }
  });

  it('preserves the base mean (no systematic strength shift)', () => {
    const n = 20_000;
    const sums: Record<string, number> = Object.fromEntries(KNOBS.map((k) => [k, 0]));
    for (let i = 0; i < n; i++) {
      const p = sampleConstrainedRandomParams(BASE, mulberry32(i + 1));
      for (const k of KNOBS) sums[k]! += p[k];
    }
    for (const k of KNOBS) {
      const mean = sums[k]! / n;
      // Uniform symmetric jitter: mean ≈ base, within 2% of the base value.
      expect(Math.abs(mean - BASE[k])).toBeLessThanOrEqual(Math.abs(BASE[k]) * 0.02 + 1e-6);
    }
  });

  it('does not mutate the base preset', () => {
    const snapshot = { ...BASE };
    sampleConstrainedRandomParams(BASE, mulberry32(9));
    expect(BASE).toEqual(snapshot);
  });
});

describe('ConstrainedRandomPolicy', () => {
  it('re-samples per hand, so preflop frequencies vary across hands', () => {
    const events: PreflopDecisionTelemetry[] = [];
    const policy = new ConstrainedRandomPolicy({
      kind: 'constrained-random',
      params: BASE,
      seed: 1234,
      onPreflopDecision: (e) => events.push(e),
    });
    const handIds = ['h-1', 'h-2', 'h-3', 'h-4', 'h-5', 'h-6'];
    for (const id of handIds) policy.decide(openView(id));

    expect(events).toHaveLength(handIds.length);
    const rates = events.map((e) => e.frequencyRaise);
    const distinct = new Set(rates.map((r) => r.toFixed(9)));
    // The whole point: not all hands share one fixed frequency vector.
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('is reproducible: same seed + same hand sequence ⇒ same frequencies', () => {
    const run = (seed: number): number[] => {
      const events: PreflopDecisionTelemetry[] = [];
      const policy = new ConstrainedRandomPolicy({
        kind: 'constrained-random',
        params: BASE,
        seed,
        onPreflopDecision: (e) => events.push(e),
      });
      for (const id of ['hand-A', 'hand-B', 'hand-C', 'hand-D', 'hand-E']) policy.decide(openView(id));
      return events.map((e) => e.frequencyRaise);
    };
    expect(run(777)).toEqual(run(777));
    // A different seed samples a different style sequence.
    expect(run(778)).not.toEqual(run(777));
  });

  it('keeps the rules-v1 name so observability is unchanged', () => {
    const policy = new ConstrainedRandomPolicy({ kind: 'constrained-random', params: BASE, seed: 1 });
    expect(policy.name).toBe(new RulePolicy('constrained-random').name);
    expect(policy.name).toBe('rules-v1');
  });
});

describe('ConstrainedRandomPolicy — missing/empty handId fallback', () => {
  /**
   * A missing or empty `handId` is not a stable hand identity: treating it as
   * one made the very first `null` view never sample (initial `currentHandId`
   * was `null`) and made every subsequent `''` hand share a single frozen draw.
   * The fallback keys on this policy's decision ordinal, so the style still
   * varies — exactly what these tests pin.
   */
  const frequenciesFor = (seed: number, ids: (string | null | undefined)[]): number[] => {
    const events: PreflopDecisionTelemetry[] = [];
    const policy = new ConstrainedRandomPolicy({
      kind: 'constrained-random',
      params: BASE,
      seed,
      onPreflopDecision: (e) => events.push(e),
    });
    for (const id of ids) policy.decide(openView(id));
    return events.map((e) => e.frequencyRaise);
  };

  it('null handId re-samples per decision instead of freezing on one draw', () => {
    const rates = frequenciesFor(1234, [null, null, null, null, null, null]);
    const distinct = new Set(rates.map((r) => r.toFixed(9)));
    expect(rates).toHaveLength(6);
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('empty-string handId re-samples per decision instead of freezing on one draw', () => {
    const rates = frequenciesFor(1234, ['', '', '', '', '', '']);
    const distinct = new Set(rates.map((r) => r.toFixed(9)));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('is reproducible without a handId: same seed + same call sequence ⇒ same frequencies', () => {
    const seq: (string | null)[] = [null, null, '', '', null, ''];
    expect(frequenciesFor(777, seq)).toEqual(frequenciesFor(777, seq));
    // A different seed samples a different fallback style sequence.
    expect(frequenciesFor(778, seq)).not.toEqual(frequenciesFor(777, seq));
  });

  it('restores a real handId style after id-less decisions (keys stay separate)', () => {
    // Same real hand ⇒ same style, even with id-less decisions in between. This
    // holds only because the fallback uses its own `seq:` namespace and cannot
    // clobber the `id:h-1` key. (Absolute frequency equality is used, so no
    // saturation assumption is needed.)
    const events: PreflopDecisionTelemetry[] = [];
    const policy = new ConstrainedRandomPolicy({
      kind: 'constrained-random',
      params: BASE,
      seed: 4242,
      onPreflopDecision: (e) => events.push(e),
    });
    policy.decide(openView('h-1'));
    policy.decide(openView(null));
    policy.decide(openView(null));
    policy.decide(openView('h-1'));
    const rates = events.map((e) => e.frequencyRaise);
    expect(rates[3]).toBe(rates[0]);
  });
});

describe('difficulty dispatch', () => {
  it('medium constrained-random builds the randomising wrapper', () => {
    const resolved = resolvePolicyForDifficulty('constrained-random', null, 'medium', {
      seed: 42,
    });
    expect(resolved.kind).toBe('constrained-random');
    expect(resolved.policy).toBeInstanceOf(ConstrainedRandomPolicy);
    expect(resolved.policy.name).toBe('rules-v1');
    expect(resolved.difficulty).toBe('medium');
  });

  it('medium tight-aggressive / loose-aggressive / calling-station stay plain RulePolicy with exact preset params', () => {
    const view = openView('h-eq', [c('Ac'), c('5c')]);
    for (const kind of ['tight-aggressive', 'loose-aggressive', 'calling-station'] as const) {
      const resolved = resolvePolicyForDifficulty(kind, null, 'medium', { seed: 999 });
      expect(resolved.policy).toBeInstanceOf(RulePolicy);
      expect(resolved.policy).not.toBeInstanceOf(ConstrainedRandomPolicy);
      const direct = new RulePolicy({ kind, seed: 999 }).decide(view);
      expect(resolved.policy.decide(view)).toEqual(direct);
    }
  });

  it('low constrained-random still resolves to the legacy StylePolicy (semantics untouched)', () => {
    const resolved = resolvePolicyForDifficulty('constrained-random', null, 'low');
    expect(resolved.policy).toBeInstanceOf(StylePolicy);
    expect(resolved.policy).not.toBeInstanceOf(ConstrainedRandomPolicy);
    expect(resolved.policy.name).toBe('style-constrained-random');
  });

  it('low tight-aggressive stays the ScriptedPolicy (no regression)', () => {
    const resolved = resolvePolicyForDifficulty('tight-aggressive', null, 'low');
    expect(resolved.policy.name).toBe('scripted-tight-aggressive');
    expect(resolved.policy).not.toBeInstanceOf(ConstrainedRandomPolicy);
  });
});
