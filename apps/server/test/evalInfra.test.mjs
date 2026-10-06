/**
 * Acceptance tests for the bot evaluation infrastructure:
 *   - deterministic shuffle seam (same seed => same deal, different => different)
 *   - baseline policies always emit legal actions
 *   - bootstrap CI sanity
 *   - duplicate match cancels luck (CI excludes 0, direction correct, narrower)
 *   - cross-run reproducibility of the hand-id sequence
 *
 * These spin up the real server in-process, so the timeouts are generous.
 */
import { describe, it, expect } from 'vitest';
import { RulePolicy, P2_ALL_OFF } from '@4am/agent-core';
import {
  deterministicPerm,
  hashSeed,
  installDeterministicShuffle,
  uninstallDeterministicShuffle,
  isDeterministicShuffleInstalled,
} from './helpers/deterministicShuffle.mjs';
import {
  bootstrapCI,
  createPolicyStats,
  ensureLegal,
  isLegalDecision,
  makeStrategy,
  parseArmName,
  isArmStrategy,
  armConfig,
  defaultP2,
  resolveEvalStrategy,
  makeArmPolicy,
} from './helpers/evalStrategies.mjs';
import { runEvalMatch } from './helpers/evalMatch.mjs';
import {
  comparePair,
  pairedDelta,
  duplicateCardsReplayed,
  runDigestIsClean,
  runMemoryComplete,
} from './helpers/evalCompare.mjs';
import { runArmComparison } from './helpers/evalArms.mjs';

function snapshotKeys(keys) {
  const snap = {};
  for (const k of keys) snap[k] = process.env[k];
  return snap;
}
function restoreKeys(snap) {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const LEGAL_AGGRO = {
  canCheck: false,
  canCall: true,
  callAmount: 20,
  canBet: false,
  canRaise: true,
  minRaiseTo: 40,
  maxRaiseTo: 4000,
};
const LEGAL_FREE = {
  canCheck: true,
  canCall: false,
  callAmount: 0,
  canBet: true,
  canRaise: false,
  minRaiseTo: 20,
  maxRaiseTo: 4000,
};

function view(la, myCards = [0, 1]) {
  return {
    legalActions: la,
    hand: { myCards, board: [] },
    opponents: [{ folded: false }],
    potOdds: { potOdds: 0.2, callAmount: la.callAmount, pot: 80 },
  };
}

describe('deterministic shuffle seam', () => {
  it('same seed+label is identical, different seed/label differs', () => {
    const a = deterministicPerm(777, 'hand-abc');
    const b = deterministicPerm(777, 'hand-abc');
    expect(a).toEqual(b);
    expect(deterministicPerm(778, 'hand-abc')).not.toEqual(a);
    expect(deterministicPerm(777, 'hand-xyz')).not.toEqual(a);
    // Valid permutation of the 52-card deck.
    expect([...a].sort((x, y) => x - y)).toEqual(Array.from({ length: 52 }, (_, i) => i));
    expect(new Set(a).size).toBe(52);
  });

  it('hashSeed is a stable 32-bit function', () => {
    expect(hashSeed(1, 'x')).toBe(hashSeed(1, 'x'));
    expect(hashSeed(1, 'x')).toBeGreaterThanOrEqual(0);
    expect(hashSeed(1, 'x')).toBeLessThanOrEqual(0xffffffff);
  });

  it('is a singleton: same seed/salt is a no-op, a different one throws', () => {
    const first = installDeterministicShuffle(1, { salt: 'a' });
    expect(isDeterministicShuffleInstalled()).toBe(true);
    expect(installDeterministicShuffle(1, { salt: 'a' })).toBe(first);
    expect(() => installDeterministicShuffle(2)).toThrow(/already installed/);
    expect(() => installDeterministicShuffle(1, { salt: 'b' })).toThrow(/already installed/);
    uninstallDeterministicShuffle();
    expect(isDeterministicShuffleInstalled()).toBe(false);
    // Reinstall for a different seed now succeeds.
    installDeterministicShuffle(2, { salt: 'b' });
    uninstallDeterministicShuffle();
  });
});

describe('bootstrapCI', () => {
  it('is deterministic and brackets the mean', () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const a = bootstrapCI(samples, { iters: 2000, seed: 42 });
    const b = bootstrapCI(samples, { iters: 2000, seed: 42 });
    expect(a).toEqual(b);
    expect(a.mean).toBeCloseTo(5.5, 6);
    expect(a.ci95[0]).toBeLessThanOrEqual(a.mean);
    expect(a.ci95[1]).toBeGreaterThanOrEqual(a.mean);
    expect(a.width).toBeGreaterThan(0);
  });

  it('handles the empty sample', () => {
    expect(bootstrapCI([]).n).toBe(0);
  });

  it('rejects invalid iters/confidence and reports n/width/sd consistently', () => {
    expect(() => bootstrapCI([1, 2, 3], { iters: 0 })).toThrow(/iters/);
    expect(() => bootstrapCI([1, 2, 3], { iters: -5 })).toThrow(/iters/);
    expect(() => bootstrapCI([1, 2, 3], { iters: 1.5 })).toThrow(/iters/);
    expect(() => bootstrapCI([1, 2, 3], { confidence: 1 })).toThrow(/confidence/);
    expect(() => bootstrapCI([1, 2, 3], { confidence: 0 })).toThrow(/confidence/);
    expect(() => bootstrapCI([1, 2, 3], { confidence: Number.NaN })).toThrow(/confidence/);

    const s = [1, 2, 3, 4, 5];
    const b = bootstrapCI(s, { iters: 1000, seed: 7 });
    expect(b.n).toBe(5);
    expect(b.iters).toBe(1000);
    // width is exactly the CI bracket, not a separately-derived value.
    expect(b.width).toBeCloseTo(b.ci95[1] - b.ci95[0], 12);
    // sd is the sample standard deviation (n-1 denominator).
    const mean = 3;
    const sampleSd = Math.sqrt(s.reduce((a, x) => a + (x - mean) ** 2, 0) / (s.length - 1));
    expect(b.sd).toBeCloseTo(sampleSd, 12);
  });
});

describe('baseline policies', () => {
  it('always-fold folds', () => {
    const p = makeStrategy('always-fold');
    const d = p.decide(view(LEGAL_AGGRO));
    expect(d.action).toEqual({ type: 'fold' });
    expect(isLegalDecision(d.action, LEGAL_AGGRO)).toBe(true);
  });

  it('always-call calls when legal', () => {
    const p = makeStrategy('always-call');
    const d = p.decide(view(LEGAL_AGGRO));
    expect(d.action).toEqual({ type: 'call' });
    expect(isLegalDecision(d.action, LEGAL_AGGRO)).toBe(true);
    // When checking is free it checks instead.
    expect(p.decide(view(LEGAL_FREE)).action).toEqual({ type: 'check' });
  });

  it('equity-threshold emits only legal actions', () => {
    const p = makeStrategy('equity-threshold');
    for (const legal of [LEGAL_AGGRO, LEGAL_FREE]) {
      for (let i = 0; i < 8; i++) {
        const d = p.decide(view(legal, [i, i + 2]));
        expect(isLegalDecision(d.action, legal)).toBe(true);
      }
    }
  });

  it('ensureLegal replaces an illegal action with a legal fallback', () => {
    const forced = ensureLegal({ action: { type: 'raise', amount: 1 } }, LEGAL_AGGRO);
    expect(isLegalDecision(forced.action, LEGAL_AGGRO)).toBe(true);
  });

  it('ensureLegal counts fallbacks and illegal decisions separately', () => {
    const stats = createPolicyStats();
    const ok = ensureLegal({ action: { type: 'call' } }, LEGAL_AGGRO, stats);
    expect(ok.action).toEqual({ type: 'call' });
    expect(stats).toEqual({ fallbacks: 0, illegalDecisions: 0 });

    ensureLegal({ action: { type: 'raise', amount: 1 } }, LEGAL_AGGRO, stats);
    expect(stats).toEqual({ fallbacks: 1, illegalDecisions: 1 });

    // A missing decision is a fallback but not an illegal decision.
    ensureLegal(null, LEGAL_AGGRO, stats);
    expect(stats).toEqual({ fallbacks: 2, illegalDecisions: 1 });
  });

  it('baseline policies never fall back on honest legal snapshots', () => {
    const stats = createPolicyStats();
    for (const name of ['always-fold', 'always-call', 'equity-threshold']) {
      const p = makeStrategy(name, { stats });
      for (const legal of [LEGAL_AGGRO, LEGAL_FREE]) {
        const d = p.decide(view(legal, [0, 1]));
        expect(isLegalDecision(d.action, legal)).toBe(true);
      }
    }
    expect(stats).toEqual({ fallbacks: 0, illegalDecisions: 0 });
  });
});

const RULE_AGG = {
  canCheck: false,
  canCall: true,
  callAmount: 20,
  canBet: false,
  canRaise: true,
  minRaiseTo: 40,
  maxRaiseTo: 4000,
};
const RULE_FREE = {
  canCheck: true,
  canCall: false,
  callAmount: 0,
  canBet: true,
  canRaise: false,
  minRaiseTo: 20,
  maxRaiseTo: 4000,
};

/** A shape-complete `DecisionView` the shipped `RulePolicy` can decide on. */
function ruleView({ street = 'preflop', myCards = [0, 1], board = [], legalActions }) {
  const call = legalActions.canCheck ? 0 : legalActions.callAmount;
  return {
    room: { sb: 10, bb: 20 },
    hand: {
      handId: 'h1',
      street,
      buttonSeat: 0,
      board,
      pot: 100,
      currentBet: call,
      toAct: 0,
      deadline: null,
      myCards,
      mySeat: 0,
    },
    me: {
      seat: 0,
      userId: 1,
      displayName: 'me',
      isMe: true,
      stack: 1000,
      committed: 0,
      total: 0,
      folded: false,
      allIn: false,
      sittingOut: false,
      connected: true,
    },
    legalActions,
    potOdds:
      call > 0
        ? {
            callAmount: call,
            pot: 100,
            potOdds: call / (100 + call),
            breakEvenEquity: call / (100 + call),
          }
        : { callAmount: 0, pot: 100, potOdds: 0, breakEvenEquity: 0 },
    actionHistory: [],
    opponents: [
      {
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
      },
    ],
    sessionMemory: { handsObserved: 0, netChips: null, recentHands: [], opponents: [] },
    historyComplete: true,
  };
}

const RULE_GRID = [
  ruleView({ street: 'preflop', myCards: [0, 1], legalActions: RULE_AGG }),
  ruleView({ street: 'preflop', myCards: [48, 49], legalActions: RULE_FREE }),
  ruleView({ street: 'flop', myCards: [0, 5], board: [9, 13, 22], legalActions: RULE_AGG }),
  ruleView({ street: 'flop', myCards: [0, 5], board: [9, 13, 22], legalActions: RULE_FREE }),
  ruleView({ street: 'turn', myCards: [10, 11], board: [9, 13, 22, 30], legalActions: RULE_FREE }),
  ruleView({
    street: 'river',
    myCards: [2, 14],
    board: [9, 13, 22, 30, 40],
    legalActions: RULE_AGG,
  }),
];

describe('arm factory (rules-v1 / p2:* / adaptive-preflop)', () => {
  it('parses every supported arm into an explicit p2 / adaptive config', () => {
    expect(defaultP2()).toEqual({
      sizeGrid: false,
      buckets: false,
    });
    expect(parseArmName('rules-v1')).toMatchObject({
      name: 'rules-v1',
      p2: defaultP2(),
      adaptivePreflop: false,
    });
    expect(parseArmName('p2:sizeGrid')).toMatchObject({
      p2: { ...defaultP2(), sizeGrid: true },
      adaptivePreflop: false,
    });
    expect(parseArmName('p2:sizeGrid+buckets')).toMatchObject({
      p2: { ...defaultP2(), sizeGrid: true, buckets: true },
    });
    expect(parseArmName('p2:all')).toMatchObject({
      p2: { sizeGrid: true, buckets: true },
    });
    expect(parseArmName('adaptive-preflop')).toMatchObject({
      p2: defaultP2(),
      adaptivePreflop: true,
    });
    expect(parseArmName('p2:all+adaptive-preflop')).toMatchObject({
      p2: { sizeGrid: true, buckets: true },
      adaptivePreflop: true,
    });
    // Report keying: name + resolved snapshot, not just the prefix.
    expect(armConfig('p2:buckets').p2.buckets).toBe(true);
    expect(armConfig('p2:buckets').p2.sizeGrid).toBe(false);
  });

  it('parses flags order-independently, merges p2 segments, and de-duplicates', () => {
    const flags = (name) => armConfig(name).p2;
    // The bare flag may precede or follow the `p2:` segment.
    expect(flags('p2:sizeGrid+buckets')).toEqual(flags('buckets+p2:sizeGrid'));
    expect(flags('buckets+p2:sizeGrid')).toEqual({
      sizeGrid: true,
      buckets: true,
    });
    // Several `p2:` segments merge, `all` unions with explicit flags, repeats
    // are idempotent.
    const want = { sizeGrid: true, buckets: true };
    expect(flags('p2:all+p2:sizeGrid')).toEqual(want);
    expect(flags('p2:sizeGrid+p2:buckets')).toEqual(want);
    expect(flags('p2:all+p2:all')).toEqual(want);
    // adaptive-preflop stays order-independent too.
    expect(armConfig('p2:all+adaptive-preflop').p2).toEqual(
      armConfig('adaptive-preflop+p2:all').p2,
    );
    expect(armConfig('adaptive-preflop+p2:all').adaptivePreflop).toBe(true);
  });

  it('rejects unknown arm names instead of silently seating the wrong policy', () => {
    for (const bad of [
      'p2:banana',
      'sizeGrid',
      'p2:',
      'shrinkage',
      'p2:shrinkage',
      'p2:rangePropagation',
      'all',
      'p2:all+banana',
      'p2:banana+p2:sizeGrid',
      '',
    ]) {
      expect(parseArmName(bad)).toBeNull();
      expect(isArmStrategy(bad)).toBe(false);
      expect(makeStrategy(bad)).toBeNull();
    }
    expect(() => resolveEvalStrategy('p2:banana')).toThrow(/unknown eval strategy/);
    // Baselines still resolve alongside the arms.
    expect(makeStrategy('always-fold').name).toBe('always-fold');
    expect(makeStrategy('equity-threshold:0.4').name).toContain('equity-threshold');
    expect(resolveEvalStrategy('p2:all').name).toBe('rules-v1');
  });

  it('default arm is the explicit all-off baseline, isolated from the product default', () => {
    // The harness baseline must NOT track the shipped `DEFAULT_P2` (`sizeGrid` /
    // `buckets` on since the 2026-10-06 prune, but treated as an independent
    // value): it is the pre-P2 engine, built by passing `P2_ALL_OFF` explicitly.
    // That makes `rules-v1` a real A/B control for every `p2:*` arm.
    const allOff = new RulePolicy({ kind: 'tight-aggressive', p2: P2_ALL_OFF });
    const arm = makeStrategy('rules-v1');
    const alias = makeStrategy('default');
    for (const view of RULE_GRID) {
      const expected = allOff.decide(view);
      expect(arm.decide(view)).toEqual(expected);
      expect(alias.decide(view)).toEqual(expected);
    }
    // ...and the alias really is the explicit all-off arm, not a product default
    // that could change.
    expect(armConfig('default').p2).toEqual(armConfig('rules-v1').p2);
  });

  it('every p2 arm emits only legal actions on the grid', () => {
    for (const name of ['p2:sizeGrid', 'p2:buckets', 'p2:all', 'adaptive-preflop']) {
      const p = resolveEvalStrategy(name);
      for (const view of RULE_GRID) {
        const d = p.decide(view);
        expect(isLegalDecision(d.action, view.legalActions)).toBe(true);
      }
    }
  });

  it('injected switch config is distinct from the all-off baseline', () => {
    const base = armConfig('rules-v1');
    const all = armConfig('p2:all');
    expect(all.p2).not.toEqual(base.p2);
    // A combination arm parses to exactly the combined flag set.
    expect(armConfig('p2:sizeGrid+buckets').p2).toEqual({
      sizeGrid: true,
      buckets: true,
    });
  });
});

describe('cross-hand memory path', () => {
  it(
    'with memory on, the arm actually sees settled opponent history across hands',
    async () => {
      const out = await runEvalMatch({
        seed: 7788,
        hands: 12,
        seatPolicies: { 1: 'rules-v1', 2: 'p2:buckets' },
        anchor: 'always-call',
        memory: true,
        actionMs: 800,
        cryptoMs: 2000,
        handMs: 20000,
      });
      expect(out.memory).toBe(true);
      expect(out.hands).toBe(12);
      // Seat 1 and seat 2 each have a distinct opponent with settled hands, so
      // both should cross the `withOpponentStats > 0` bar once a hand settles.
      expect(out.seatMemory[1].withOpponentStats).toBeGreaterThan(0);
      expect(out.seatMemory[2].withOpponentStats).toBeGreaterThan(0);
      expect(out.policyLegalityFallbacks).toBe(0);
      expect(out.policyLegalityIllegalDecisions).toBe(0);
    },
    180000,
  );

  it(
    'without memory (legacy default), no seat ever sees opponent history',
    async () => {
      const out = await runEvalMatch({
        seed: 7789,
        hands: 6,
        seatPolicies: { 1: 'rules-v1', 2: 'p2:buckets' },
        anchor: 'always-call',
        actionMs: 800,
        cryptoMs: 2000,
        handMs: 20000,
      });
      expect(out.memory).toBe(false);
      for (const seat of [1, 2]) {
        expect(out.seatMemory[seat].withOpponentStats).toBe(0);
        expect(out.seatMemory[seat].nonEmptyOpponents).toBe(0);
      }
    },
    120000,
  );
});

describe('paired estimator', () => {
  it('averages the two seat-swapped strategy deltas: (a1-b1+a2-b2)/2', () => {
    expect(pairedDelta(10, 4, 6, 2)).toBe(5); // ((10-4) + (6-2)) / 2
    expect(pairedDelta(0, 0, 0, 0)).toBe(0);
    expect(pairedDelta(-3, 3, 1, -1)).toBe(-2); // (-6 + 2) / 2
  });

  it('the bootstrap mean over synthetic pairs equals the paired-mean', () => {
    const bb = 20;
    const pairs = [
      [10, 4, 6, 2],
      [2, 8, -1, 3],
      [5, 5, 5, 5],
      [-4, 0, 2, 6],
    ];
    const samples = pairs.map(([a1, b1, a2, b2]) => (pairedDelta(a1, b1, a2, b2) / bb) * 100);
    const expected = samples.reduce((s, x) => s + x, 0) / samples.length;
    const ci = bootstrapCI(samples, { iters: 1000, seed: 7 });
    expect(ci.mean).toBeCloseTo(expected, 6);
  });
});

describe('experiment-validity gates', () => {
  it('rejects an empty comparison instead of reading green', async () => {
    const r = await runArmComparison({ arms: ['rules-v1'] });
    expect(r.pairs).toEqual([]);
    expect(r.allClean).toBe(false);
  });

  it('runDigestIsClean rejects an empty or card-incomplete run', () => {
    // The exact counterexample from review: a zero-hand, unfingerprinted run.
    expect(
      runDigestIsClean({
        aborts: 0,
        rejected: 0,
        ledgerOk: true,
        hands: 0,
        cardsFingerprintComplete: false,
      }),
    ).toBe(false);
    // Complete hand count but no card proof.
    expect(
      runDigestIsClean({
        aborts: 0,
        rejected: 0,
        ledgerOk: true,
        hands: 10,
        requestedHands: 10,
        cardsFingerprintComplete: false,
      }),
    ).toBe(false);
    // Requested hands not reached.
    expect(
      runDigestIsClean({
        aborts: 0,
        rejected: 0,
        ledgerOk: true,
        hands: 7,
        requestedHands: 10,
        cardsFingerprintComplete: true,
      }),
    ).toBe(false);
    // The positive control.
    expect(
      runDigestIsClean({
        aborts: 0,
        rejected: 0,
        ledgerOk: true,
        hands: 10,
        requestedHands: 10,
        cardsFingerprintComplete: true,
      }),
    ).toBe(true);
  });

  it('runMemoryComplete rejects a run whose memory dropped a middle hand', () => {
    // memory off => vacuous truth (legacy path is not gated on memory).
    expect(runMemoryComplete({ memory: false, hands: 10, seatMemory: {} })).toBe(true);
    // memory on, every seat reached hands-1 => complete.
    expect(
      runMemoryComplete({
        memory: true,
        hands: 10,
        seatMemory: { 0: { maxHandsObserved: 9 }, 1: { maxHandsObserved: 9 } },
      }),
    ).toBe(true);
    // A dropped middle record leaves maxHandsObserved below hands-1.
    expect(
      runMemoryComplete({
        memory: true,
        hands: 10,
        seatMemory: { 0: { maxHandsObserved: 9 }, 1: { maxHandsObserved: 8 } },
      }),
    ).toBe(false);
    // No seats recorded at all => not complete.
    expect(runMemoryComplete({ memory: true, hands: 10, seatMemory: {} })).toBe(false);
  });
});

describe('memory-on A/A equivalence', () => {
  it(
    'two names of the same config differ by zero, hand for hand, with no dropped record',
    async () => {
      const hands = 30;
      const r = await comparePair('rules-v1', 'default', {
        seed: 1234,
        hands,
        memory: true,
        bootstrapIters: 2000,
        actionMs: 800,
        cryptoMs: 2000,
        handMs: 20000,
      });
      // A complete, card-proven experiment with full memory recording.
      expect(r.clean).toBe(true);
      expect(r.memory).toBe(true);
      expect(r.cardsReplayed).toBe(true);
      expect(r.cards.handIdsMatch).toBe(true);
      expect(r.cards.fingerprintsComplete).toBe(true);
      expect(r.runs.every(runMemoryComplete)).toBe(true);
      // A/A => exactly zero difference, no spread. (The single-seating
      // `nonDuplicate` need not be zero: seat 1/2 face different cards even
      // when the two policies are identical; the seat-swap average is what
      // cancels that, and it is exactly 0 here.)
      expect(r.delta.bb100).toBe(0);
      expect(r.delta.sd).toBe(0);
      // Both seatings produced the same seat action streams (swap-invariant).
      for (const seat of [1, 2])
        expect(r.runs[0].seatActions[seat]).toEqual(r.runs[1].seatActions[seat]);
      // No bot seat missed a settled hand (seat 0 is the memory-less anchor).
      for (const run of r.runs)
        for (const seat of [1, 2])
          expect(run.seatMemory[seat].maxHandsObserved).toBeGreaterThanOrEqual(hands - 1);
    },
    180000,
  );
});

const RUN_OPTS = {
  hands: 2,
  seatPolicies: { 1: 'always-fold', 2: 'always-call' },
  actionMs: 800,
  cryptoMs: 2000,
  handMs: 20000,
};

describe('cross-run reproducibility', () => {
  it('same seed => identical hand ids; a different seed differs', async () => {
    const a = await runEvalMatch({ ...RUN_OPTS, seed: 4242 });
    const b = await runEvalMatch({ ...RUN_OPTS, seed: 4242 });
    const c = await runEvalMatch({ ...RUN_OPTS, seed: 4243 });
    expect(a.handIds.length).toBe(2);
    expect(a.handIds).toEqual(b.handIds);
    expect(a.handIds).not.toEqual(c.handIds);
    // Ledger/law invariants on every run.
    for (const run of [a, b, c]) {
      expect(run.aborts).toBe(0);
      expect(run.rejected).toBe(0);
      expect(run.botErrors).toBe(0);
      expect(run.ledgerOk).toBe(true);
    }
  }, 120000);
});

describe('eval harness isolation', () => {
  const MANAGED = ['BOT_TEST_SHUFFLE_SEED', 'BOT_IDENTITY_KEY', 'BOT_THINK_ENABLED'];

  it('restores the managed env verbatim after a run', async () => {
    const outer = snapshotKeys(MANAGED);
    try {
      // Pre-existing values the run must put back exactly (including a set seed
      // and an absent BOT_THINK_ENABLED).
      process.env.BOT_TEST_SHUFFLE_SEED = 'pre-existing-seed';
      process.env.BOT_IDENTITY_KEY = 'cd'.repeat(32);
      delete process.env.BOT_THINK_ENABLED;
      const before = snapshotKeys(MANAGED);

      await runEvalMatch({ ...RUN_OPTS, seed: 4242 });
      expect(snapshotKeys(MANAGED)).toEqual(before);
    } finally {
      restoreKeys(outer);
    }
  }, 120000);

  it('leaves the default (no seed) path dealing random hand ids', async () => {
    const outer = snapshotKeys(MANAGED);
    try {
      delete process.env.BOT_TEST_SHUFFLE_SEED;
      const a = await runEvalMatch({ ...RUN_OPTS, seed: null });
      const b = await runEvalMatch({ ...RUN_OPTS, seed: null });
      expect(a.handIds.length).toBe(2);
      // A deterministic, restored polluter would hand back the SAME ids here.
      expect(a.handIds).not.toEqual(b.handIds);
      expect(process.env.BOT_TEST_SHUFFLE_SEED).toBeUndefined();
    } finally {
      restoreKeys(outer);
    }
  }, 120000);
});

describe('card-level replay proof', () => {
  it('fingerprints every seat hole cards + board, and replay holds on a true duplicate', async () => {
    const one = await runEvalMatch({ ...RUN_OPTS, seed: 777 });
    expect(one.cardsFingerprintComplete).toBe(true);
    expect(one.cardFingerprints.length).toBe(one.hands);
    for (const fp of one.cardFingerprints) {
      expect(fp.complete).toBe(true);
      // 3 dealt seats -> s0..s2 each with two cards, plus a board field.
      expect(fp.fingerprint).toMatch(/^s0:.+\|s1:.+\|s2:.+\|board:/);
    }
    const two = await runEvalMatch({ ...RUN_OPTS, seed: 777 });
    expect(duplicateCardsReplayed(one, two)).toBe(true);
  }, 120000);

  it('NEGATIVE: same hand ids but a broken permutation make the card assertion fail', async () => {
    // `shuffleSalt` only changes the permutation label, never the hand-id
    // selector: the old cardsReplayed (handIds only) would pass here.
    const left = await runEvalMatch({ ...RUN_OPTS, seed: 9001, shuffleSalt: 'left' });
    const right = await runEvalMatch({ ...RUN_OPTS, seed: 9001, shuffleSalt: 'right' });
    expect(left.handIds).toEqual(right.handIds); // selector unchanged
    expect(left.cardsFingerprintComplete).toBe(true);
    expect(right.cardsFingerprintComplete).toBe(true);
    expect(left.cardFingerprints[0].fingerprint).not.toBe(
      right.cardFingerprints[0].fingerprint,
    );
    // The real proof rejects what the label-only proof would have accepted.
    expect(duplicateCardsReplayed(left, right)).toBe(false);
  }, 120000);
});

describe('duplicate match', () => {
  it('always-fold vs equity-threshold: real cards replayed, CI excludes 0, narrower than no-swap', async () => {
    const r = await comparePair('always-fold', 'equity-threshold', {
      seed: 1234,
      hands: 80,
      bootstrapIters: 3000,
      actionMs: 800,
      cryptoMs: 2000,
      handMs: 20000,
    });
    expect(r.cardsReplayed).toBe(true);
    expect(r.cards.handIdsMatch).toBe(true);
    expect(r.cards.fingerprintsComplete).toBe(true);
    expect(r.cards.firstMismatch).toBeNull();
    expect(r.hands).toBe(80);
    expect(r.delta.ciExcludesZero).toBe(true);
    expect(r.delta.direction).toBe('equity-threshold > always-fold');
    expect(r.delta.width).toBeLessThanOrEqual(r.nonDuplicate.width);
    for (const run of r.runs) {
      expect(run.aborts).toBe(0);
      expect(run.rejected).toBe(0);
      expect(run.botErrors).toBe(0);
      expect(run.ledgerOk).toBe(true);
      expect(run.policyLegalityFallbacks).toBe(0);
      expect(run.policyLegalityIllegalDecisions).toBe(0);
    }
  }, 420000);
});
