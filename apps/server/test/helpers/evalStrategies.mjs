/**
 * Harness-only baseline policies + statistics for the bot evaluation rig.
 *
 * These are deliberately registered *inside the harness* (never in
 * `@4am/agent-core`, which another lane owns): they exist to anchor a
 * comparison and to prove the evaluation machinery itself. They are ordinary
 * `Policy` objects, so they run through the exact same `BotRunner` path as the
 * shipped styles.
 *
 * Guarantees encoded here:
 *   - every returned action is checked against the legal-action snapshot before
 *     it leaves the policy (`ensureLegal`), so a baseline can never emit an
 *     illegal action (0 server `action_rejected`); the one exception is the
 *     engine's own forced folds, which never route through a policy;
 *   - any substitution `ensureLegal` makes is counted into an optional `stats`
 *     sink (`fallbacks` / `illegalDecisions`), so a policy bug is never hidden
 *     behind a silent fallback;
 *   - the equity baseline uses the shipped seeded `estimateEquity` (mulberry32),
 *     never `Math.random`, so a given view always decides the same way.
 */
import { estimateEquity, mulberry32 } from '@4am/agent-core';

/** Fresh per-run counter sink for fallback / illegal-decision accounting. */
export function createPolicyStats() {
  return { fallbacks: 0, illegalDecisions: 0 };
}

/** Local legality check, identical in semantics to `rulePolicy.isLegalAction`. */
export function isLegalDecision(action, la) {
  if (!action || !la) return false;
  switch (action.type) {
    case 'check':
      return la.canCheck;
    case 'call':
      return la.canCall;
    case 'bet':
      return (
        la.canBet &&
        typeof action.amount === 'number' &&
        action.amount >= la.minRaiseTo &&
        action.amount <= la.maxRaiseTo
      );
    case 'raise':
      return (
        la.canRaise &&
        typeof action.amount === 'number' &&
        action.amount >= la.minRaiseTo &&
        action.amount <= la.maxRaiseTo
      );
    case 'fold':
      return true;
    default:
      return false;
  }
}

/** The guaranteed-legal action: check if free, else call, else fold. */
export function fallbackDecision(la) {
  if (la.canCheck) return { action: { type: 'check' }, reason: 'fallback: check' };
  if (la.canCall) return { action: { type: 'call' }, reason: 'fallback: call' };
  return { action: { type: 'fold' }, reason: 'fallback: fold' };
}

/**
 * Wrap a raw decision so an illegal one is replaced by the legal fallback.
 *
 * When `stats` is supplied, a substitution is recorded: `fallbacks` counts every
 * replacement, `illegalDecisions` narrows that to the ones where the policy did
 * hand back an actual action that the snapshot rejected (a missing decision is a
 * fallback but not an illegal decision).
 */
export function ensureLegal(decision, la, stats) {
  if (decision && isLegalDecision(decision.action, la)) return decision;
  if (stats) {
    stats.fallbacks++;
    if (decision && decision.action && !isLegalDecision(decision.action, la))
      stats.illegalDecisions++;
  }
  return fallbackDecision(la);
}

class AlwaysFoldPolicy {
  name = 'always-fold';
  constructor(stats = null) {
    this.stats = stats;
  }
  decide(view) {
    const la = view.legalActions;
    if (!la) throw new Error('always-fold asked to act out of turn');
    // Folding is always legal; blinds are posted by the engine, not chosen here.
    // Routed through `ensureLegal` so the "every action is checked" guarantee
    // holds for every baseline (and a future engine change that made fold
    // illegal would surface as a counted fallback, not a server rejection).
    return ensureLegal({ action: { type: 'fold' }, reason: 'always-fold' }, la, this.stats);
  }
}

class AlwaysCallPolicy {
  constructor(stats = null) {
    this.stats = stats;
  }
  name = 'always-call';
  decide(view) {
    const la = view.legalActions;
    if (!la) throw new Error('always-call asked to act out of turn');
    // Pick a legal raw action up front (check when there is nothing to call)
    // instead of emitting an illegal `call` and relying on `ensureLegal` to
    // repair it - that repair would otherwise be counted as a policy fallback.
    const action = la.canCall
      ? { type: 'call' }
      : la.canCheck
        ? { type: 'check' }
        : { type: 'fold' };
    return ensureLegal({ action, reason: 'always-call' }, la, this.stats);
  }
}

class EquityThresholdPolicy {
  constructor(threshold = 0.5, samples = 160, seed = 0x4a6d2b79, stats = null) {
    this.threshold = threshold;
    this.samples = samples;
    this.seed = seed;
    this.stats = stats;
    this.name = `equity-threshold(${threshold})`;
  }
  decide(view) {
    const la = view.legalActions;
    if (!la) throw new Error('equity-threshold asked to act out of turn');
    const hole = view.hand?.myCards ?? [];
    const board = view.hand?.board ?? [];
    if (hole.length !== 2) {
      if (this.stats) this.stats.fallbacks++;
      return fallbackDecision(la);
    }
    const opponents = Math.max(1, (view.opponents ?? []).filter((o) => !o.folded).length);
    const { equity } = estimateEquity({
      hole,
      board,
      opponents,
      samples: this.samples,
      seed: this.seed,
    });
    let action;
    if (equity >= this.threshold) {
      // Value line: raise if allowed, else call, else check.
      if (la.canBet) action = { type: 'bet', amount: la.minRaiseTo };
      else if (la.canRaise) action = { type: 'raise', amount: la.minRaiseTo };
      else if (la.canCall) action = { type: 'call' };
      else action = { type: 'check' };
    } else {
      // Keep the pot cheap: check when free, call only if the price is right.
      if (la.canCheck) action = { type: 'check' };
      else if (la.canCall && equity >= (view.potOdds?.potOdds ?? 1)) action = { type: 'call' };
      else action = { type: 'fold' };
    }
    return ensureLegal({ action, reason: `equity=${equity.toFixed(3)}` }, la, this.stats);
  }
}

/** Names the evaluation rig understands out of the box. */
export function isBaselineStrategy(name) {
  return (
    name === 'always-fold' ||
    name === 'always-call' ||
    name === 'equity-threshold' ||
    name.startsWith('equity-threshold(')
  );
}

/**
 * Build a `Policy` by name. `equity-threshold` accepts `equity-threshold:0.55`
 * (or `equity-threshold(0.55)`) to change the threshold.
 */
export function makeStrategy(name, opts = {}) {
  const raw = String(name);
  if (raw === 'always-fold') return new AlwaysFoldPolicy(opts.stats ?? null);
  if (raw === 'always-call') return new AlwaysCallPolicy(opts.stats ?? null);
  const eqMatch = /^equity-threshold(?:[:(]?([0-9]*\.?[0-9]+)\)?)?$/.exec(raw);
  if (eqMatch) {
    const threshold = eqMatch[1] !== undefined ? Number(eqMatch[1]) : 0.5;
    return new EquityThresholdPolicy(
      threshold,
      opts.samples ?? 160,
      opts.seed ?? 0x4a6d2b79,
      opts.stats ?? null,
    );
  }
  return null;
}

/** Policy for any seat: a baseline when named, otherwise the shipped resolver. */
export function isSupportedStrategy(name) {
  return isBaselineStrategy(String(name));
}

/**
 * Percentile bootstrap CI of the mean. Deterministic (seeded mulberry32), so the
 * reported CI is reproducible run to run.
 *
 * Returns `{ mean, ci95: [lo, hi], width, sd, n, iters, seed }`.
 */
export function bootstrapCI(samples, { iters = 10_000, seed = 0x5eed, confidence = 0.95 } = {}) {
  if (!Number.isInteger(iters) || iters <= 0)
    throw new Error(`bootstrapCI: iters must be a positive integer, got ${iters}`);
  if (typeof confidence !== 'number' || !(confidence > 0 && confidence < 1))
    throw new Error(`bootstrapCI: confidence must be in (0, 1), got ${confidence}`);
  const n = samples.length;
  if (n === 0)
    return { mean: 0, ci95: [0, 0], width: 0, sd: 0, n: 0, iters, seed, confidence };
  const mean = samples.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? samples.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const rand = mulberry32(seed);
  const means = new Array(iters);
  for (let it = 0; it < iters; it++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += samples[Math.floor(rand() * n)];
    means[it] = sum / n;
  }
  means.sort((a, b) => a - b);
  const alpha = (1 - confidence) / 2;
  const lo = means[Math.min(iters - 1, Math.max(0, Math.floor(alpha * iters)))];
  const hi = means[Math.min(iters - 1, Math.max(0, Math.ceil((1 - alpha) * iters) - 1))];
  return {
    mean,
    ci95: [lo, hi],
    width: hi - lo,
    sd: Math.sqrt(variance),
    n,
    iters,
    seed,
    confidence,
  };
}
