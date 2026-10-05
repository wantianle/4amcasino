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
} from './helpers/evalStrategies.mjs';
import { runEvalMatch } from './helpers/evalMatch.mjs';
import { comparePair, duplicateCardsReplayed } from './helpers/evalCompare.mjs';

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
      expect(run.policyFallbacks).toBe(0);
      expect(run.policyIllegalDecisions).toBe(0);
    }
  }, 420000);
});
