import { describe, expect, it } from 'vitest';
import { cardFromName, type CardId } from '@4am/shared';
import type {
  DecisionHand,
  DecisionLegalActions,
  DecisionPotOdds,
  DecisionSeat,
  DecisionView,
} from '../src/decisionView.js';
import {
  BOT_DIFFICULTIES,
  DEFAULT_BOT_DIFFICULTY,
  normalizeBotDifficulty,
  resolveDifficulty,
  resolvePolicyForDifficulty,
} from '../src/difficultyPolicy.js';
import { RulePolicy } from '../src/rulePolicy.js';
import { ScriptedPolicy } from '../src/scriptedPolicy.js';
import { StylePolicy, resolvePolicy } from '../src/stylePolicy.js';

/** Difficulty dispatch layered on `resolvePolicy` (low/medium/high). */

const c = (n: string) => cardFromName(n);

// A stored preflop decision view good enough to compare resolved policies.
function la(over: Partial<DecisionLegalActions> = {}): DecisionLegalActions {
  return {
    canCheck: false,
    canCall: true,
    callAmount: 100,
    canBet: false,
    canRaise: true,
    minRaiseTo: 200,
    maxRaiseTo: 10_000,
    ...over,
  };
}

function hand(myCards: CardId[], over: Partial<DecisionHand> = {}): DecisionHand {
  return {
    handId: 'h1',
    street: 'preflop',
    buttonSeat: 8,
    board: [],
    pot: 150,
    currentBet: 100,
    toAct: 8,
    deadline: null,
    myCards,
    mySeat: 8,
    ...over,
  };
}

function odds(over: Partial<DecisionPotOdds> = {}): DecisionPotOdds {
  return { callAmount: 100, pot: 150, potOdds: 100 / 250, breakEvenEquity: 100 / 250, ...over };
}

function seat(over: Partial<DecisionSeat> = {}): DecisionSeat {
  return {
    seat: 1,
    userId: 2,
    displayName: 'opp',
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

function view(myCards: CardId[]): DecisionView {
  const mySeat = 8;
  const order = Array.from({ length: 9 }, (_, i) => i);
  return {
    room: { id: 'r1', name: 'room', sb: 50, bb: 100, minSettleHands: 0, sevenDeuceBonus: 0 },
    hand: hand(myCards, { mySeat, toAct: mySeat }),
    me: seat({ seat: mySeat, userId: 1, isMe: true }),
    legalActions: la(),
    potOdds: odds(),
    actionHistory: [],
    opponents: order.filter((s) => s !== mySeat).map((s) => seat({ seat: s, userId: 100 + s })),
    sessionMemory: { handsObserved: 0, netChips: null, recentHands: [], opponents: [] },
    historyComplete: true,
    seatOrder: order,
    actionSeq: 0,
  };
}

describe('normalizeBotDifficulty', () => {
  it('accepts the three tiers case/space-insensitively', () => {
    expect(BOT_DIFFICULTIES).toEqual(['low', 'medium', 'high']);
    expect(normalizeBotDifficulty(' LOW ')).toBe('low');
    expect(normalizeBotDifficulty('Medium')).toBe('medium');
    expect(normalizeBotDifficulty('high')).toBe('high');
  });

  it('returns null for empty or unknown values', () => {
    expect(normalizeBotDifficulty('')).toBeNull();
    expect(normalizeBotDifficulty('   ')).toBeNull();
    expect(normalizeBotDifficulty(null)).toBeNull();
    expect(normalizeBotDifficulty(undefined)).toBeNull();
    expect(normalizeBotDifficulty('galaxy-brain')).toBeNull();
  });
});

describe('resolveDifficulty', () => {
  it('defaults to low with no warning when absent', () => {
    const d = resolveDifficulty(undefined);
    expect(d.difficulty).toBe(DEFAULT_BOT_DIFFICULTY);
    expect(d.requested).toBeNull();
    expect(d.downgraded).toBe(false);
    expect(d.warnings).toEqual([]);
  });

  it('passes low/medium through unchanged', () => {
    expect(resolveDifficulty('low').difficulty).toBe('low');
    const medium = resolveDifficulty('medium');
    expect(medium.difficulty).toBe('medium');
    expect(medium.downgraded).toBe(false);
    expect(medium.warnings).toEqual([]);
  });

  it('downgrades the reserved high tier to medium with a warning', () => {
    const high = resolveDifficulty('high');
    expect(high.difficulty).toBe('medium');
    expect(high.requested).toBe('high');
    expect(high.downgraded).toBe(true);
    expect(high.warnings.join(' ')).toMatch(/high/);
    expect(high.warnings.join(' ')).toMatch(/not implemented/);
  });

  it('falls back to low and warns on an unknown value', () => {
    const unknown = resolveDifficulty('galaxy-brain');
    expect(unknown.difficulty).toBe('low');
    expect(unknown.ignored).toBe(true);
    expect(unknown.warnings.join(' ')).toMatch(/unknown difficulty/);
  });
});

describe('resolvePolicyForDifficulty: low keeps today\u2019s behaviour', () => {
  it('resolves tight-aggressive to ScriptedPolicy, exactly like resolvePolicy', () => {
    const low = resolvePolicyForDifficulty('tight-aggressive', null, 'low');
    const legacy = resolvePolicy('tight-aggressive', null);
    expect(low.policy).toBeInstanceOf(ScriptedPolicy);
    expect(low.policy.name).toBe('scripted-tight-aggressive');
    expect(low.policy.name).toBe(legacy.policy.name);
    expect(low.kind).toBe('tight-aggressive');
    expect(low.difficulty).toBe('low');
    expect(low.warnings).toEqual([]);
  });

  it('resolves other styles to StylePolicy and honours policy_json overrides', () => {
    const lag = resolvePolicyForDifficulty('loose-aggressive', null, 'low');
    expect(lag.policy).toBeInstanceOf(StylePolicy);
    expect(lag.policy.name).toBe('style-loose-aggressive');

    const overridden = resolvePolicyForDifficulty(
      'tight-aggressive',
      JSON.stringify({ valueRaiseFraction: 0.9 }),
      'low',
    );
    expect(overridden.policy).toBeInstanceOf(StylePolicy);
    expect(overridden.policy.name).toBe('style-tight-aggressive');
  });

  it('treats a missing difficulty as low (default)', () => {
    const missing = resolvePolicyForDifficulty('tight-aggressive', null);
    expect(missing.difficulty).toBe('low');
    expect(missing.policy.name).toBe('scripted-tight-aggressive');
    expect(missing.warnings).toEqual([]);
  });

  it('produces identical decisions to resolvePolicy() (zero-regression proof)', () => {
    const hands: CardId[][] = [[c('Ac'), c('Ad')], [c('Qc'), c('4c')], [c('7c'), c('2d')]];
    for (const cards of hands) {
      // ScriptedPolicy path: fully deterministic, no RNG.
      const legacyTag = resolvePolicy('tight-aggressive', null);
      const lowTag = resolvePolicyForDifficulty('tight-aggressive', null, 'low');
      expect(lowTag.policy.decide(view(cards))).toEqual(legacyTag.policy.decide(view(cards)));

      // StylePolicy path: same seed on both resolvers must decide identically.
      const legacyLag = resolvePolicy('loose-aggressive', null, { seed: 7 });
      const lowLag = resolvePolicyForDifficulty('loose-aggressive', null, 'low', { seed: 7 });
      expect(lowLag.policy.decide(view(cards))).toEqual(legacyLag.policy.decide(view(cards)));
    }
  });
});

describe('resolvePolicyForDifficulty: medium forces rules-v1', () => {
  it('builds a RulePolicy even without an explicit engine field', () => {
    const medium = resolvePolicyForDifficulty('tight-aggressive', null, 'medium');
    expect(medium.policy).toBeInstanceOf(RulePolicy);
    expect(medium.policy.name).toBe('rules-v1');
    expect(medium.difficulty).toBe('medium');
    expect(medium.requestedDifficulty).toBe('medium');
    expect(medium.downgraded).toBe(false);
    expect(medium.warnings).toEqual([]);
  });

  it('differs from low on the same kind', () => {
    const low = resolvePolicyForDifficulty('tight-aggressive', null, 'low');
    const medium = resolvePolicyForDifficulty('tight-aggressive', null, 'medium');
    expect(low.policy.name).not.toBe(medium.policy.name);
    expect(low.policy).not.toBeInstanceOf(RulePolicy);
    expect(medium.policy).toBeInstanceOf(RulePolicy);
  });

  it('still lets policy_kind select the rule preset', () => {
    const tag = resolvePolicyForDifficulty('tight-aggressive', null, 'medium', { seed: 42 });
    const lag = resolvePolicyForDifficulty('loose-aggressive', null, 'medium', { seed: 42 });
    const direct = new RulePolicy({ kind: 'loose-aggressive', seed: 42 });
    const v = view([c('Qc'), c('4c')]);
    // Same persisted preset + seed => identical decision to hand-building it.
    expect(lag.policy.decide(v)).toEqual(direct.decide(v));
    expect(lag.kind).toBe('loose-aggressive');
    // A different preset is a different rule config (not asserted to differ on
    // this particular roll, only that the kind is carried through).
    expect(tag.kind).toBe('tight-aggressive');
  });

  it('passes an existing rules-v1 blob through unchanged', () => {
    const json = JSON.stringify({ engine: 'rules-v1', preflopScale: 0.5 });
    const medium = resolvePolicyForDifficulty('tight-aggressive', json, 'medium');
    const explicit = resolvePolicy('tight-aggressive', json);
    expect(medium.policy).toBeInstanceOf(RulePolicy);
    expect(medium.policy.name).toBe('rules-v1');
    expect(medium.warnings).toEqual(explicit.warnings);
  });

  it('makes policyKind win over a conflicting policy_json.rules', () => {
    const withRules = resolvePolicyForDifficulty(
      'tight-aggressive',
      JSON.stringify({ engine: 'rules-v1', rules: 'loose-aggressive' }),
      'medium',
      { seed: 42 },
    );
    const withoutRules = resolvePolicyForDifficulty(
      'tight-aggressive',
      JSON.stringify({ engine: 'rules-v1' }),
      'medium',
      { seed: 42 },
    );
    // The `rules` override is dropped, so resolving with it is identical to
    // resolving without it: the persisted kind supplies the preset.
    for (const cards of [[c('Ac'), c('Ad')], [c('Qc'), c('4c')], [c('7c'), c('2d')]]) {
      expect(withRules.policy.decide(view(cards))).toEqual(withoutRules.policy.decide(view(cards)));
    }
    expect(withRules.warnings.join(' ')).toMatch(/"rules"/);
    expect(withRules.warnings.join(' ')).toMatch(/policyKind/);
  });

  it('keeps rules config warnings (and ignores inapplicable style keys)', () => {
    const medium = resolvePolicyForDifficulty(
      'tight-aggressive',
      JSON.stringify({ valueRaiseFraction: 0.9 }),
      'medium',
    );
    expect(medium.policy).toBeInstanceOf(RulePolicy);
    expect(medium.warnings.join(' ')).toMatch(/valueRaiseFraction/);
  });
});

describe('resolvePolicyForDifficulty: high is reserved', () => {
  it('falls back to medium (rules-v1), keeps requested=high and warns', () => {
    const high = resolvePolicyForDifficulty('tight-aggressive', null, 'high');
    expect(high.policy).toBeInstanceOf(RulePolicy);
    expect(high.policy.name).toBe('rules-v1');
    expect(high.difficulty).toBe('medium');
    expect(high.requestedDifficulty).toBe('high');
    expect(high.downgraded).toBe(true);
    expect(high.difficultyWarnings.join(' ')).toMatch(/not implemented/);
    expect(high.warnings.join(' ')).toMatch(/high/);
  });

  it('matches a plain medium resolution on the same kind', () => {
    const high = resolvePolicyForDifficulty('loose-aggressive', null, 'high', { seed: 3 });
    const medium = resolvePolicyForDifficulty('loose-aggressive', null, 'medium', { seed: 3 });
    expect(high.policy.name).toBe(medium.policy.name);
    expect(high.difficulty).toBe(medium.difficulty);
  });
});

describe('resolvePolicyForDifficulty: unknown difficulty', () => {
  it('falls back to low and reports the unknown value', () => {
    const unknown = resolvePolicyForDifficulty('tight-aggressive', null, 'galaxy-brain');
    expect(unknown.difficulty).toBe('low');
    expect(unknown.policy.name).toBe('scripted-tight-aggressive');
    expect(unknown.requestedDifficulty).toBe('galaxy-brain');
    expect(unknown.warnings.join(' ')).toMatch(/unknown difficulty/);
  });
});
