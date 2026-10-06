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
import {
  estimateEquity,
  mulberry32,
  RulePolicy,
  PostflopPolicy,
  RULE_PRESETS,
  P2_ALL_OFF,
} from '@4am/agent-core';

/**
 * ---------------------------------------------------------------------------
 * Arm factory (`rules-v1` / `p2:*` / `adaptive-preflop`)
 * ---------------------------------------------------------------------------
 *
 * The baseline harness policies above are deliberately tiny. The *shipped*
 * `rules-v1` engine (`RulePolicy` + `PostflopPolicy`) is where the P2 switches
 * live, so an A/B of "P2 on vs off" must build real `RulePolicy` instances with
 * an explicit `p2` option. This factory does exactly that, by name, so the same
 * `runEvalMatch` path that seats a baseline can seat any arm.
 *
 * Name grammar (`+`-joined segments, order-independent):
 *   - `rules-v1` / `baseline` / `default`  -> explicit all-off P2 baseline
 *   - `p2:sizeGrid`                        -> all-off + one switch on
 *   - `p2:sizeGrid+buckets`                -> all-off + both surviving switches on
 *   - `p2:all`                             -> both switches on
 *   - `adaptive-preflop`                   -> `params.adaptivePreflop = true`
 *   - `p2:all+adaptive-preflop`            -> combined arm
 * Every arm starts from the explicit all-off `defaultP2()`, never the product
 * `DEFAULT_P2` (`sizeGrid` / `buckets` on since the 2026-10-06 prune), so the
 * baseline stays independent of how the product default is set.
 * An unknown segment (e.g. `p2:banana`, bare `sizeGrid`, or the deleted
 * `p2:shrinkage` / `p2:rangePropagation`) resolves to `null`, and `runEvalMatch`
 * turns that into a hard error rather than silently seating the wrong policy.
 */
export const P2_FLAGS = ['sizeGrid', 'buckets'];

/**
 * Explicit all-off P2 snapshot: the harness baseline, **decoupled from the
 * shipped `DEFAULT_P2` product default** (`sizeGrid` / `buckets` on since the
 * 2026-10-06 prune, but treated as an independent value that may change). The
 * baseline arm `rules-v1` must be the pre-P2 decision path regardless of how the
 * product flips its defaults, otherwise every `p2:*` arm would start from an
 * all-on config and a "one switch on" arm could be byte-identical to the
 * baseline (the A/B treatment and control would collapse to the same policy).
 * Anchored to the shipped, frozen `P2_ALL_OFF` constant so the shape can never
 * drift from `P2Options`.
 */
export function defaultP2() {
  return { ...P2_ALL_OFF };
}

/**
 * Parse an arm name into `{ name, p2, adaptivePreflop }`, or `null` when the
 * name is not an arm. Pure; never throws.
 */
export function parseArmName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) return null;
  const tokens = name
    .split('+')
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return null;

  const p2 = defaultP2();
  let adaptivePreflop = false;
  let sawP2 = false;
  let sawBase = false;

  // A bare flag (`sizeGrid`) is only accepted when the arm also carries at least
  // one explicit `p2:` segment. That keeps the order truly irrelevant - both
  // `p2:sizeGrid+buckets` and `buckets+p2:sizeGrid` parse the same - while
  // still rejecting a lone `sizeGrid`, which is almost certainly a typo for a
  // baseline style rather than an arm.
  const hasP2Segment = tokens.some((t) => t.startsWith('p2:'));

  for (const token of tokens) {
    if (token === 'rules-v1' || token === 'baseline' || token === 'default') {
      sawBase = true;
      continue;
    }
    if (token === 'adaptive-preflop') {
      adaptivePreflop = true;
      continue;
    }
    let body = token;
    if (body.startsWith('p2:')) {
      sawP2 = true;
      body = body.slice(3).trim();
      if (!body) return null;
    } else if (!hasP2Segment) {
      // A bare flag with no `p2:` segment anywhere in the name is not an arm.
      return null;
    }
    if (body === 'all') {
      for (const flag of P2_FLAGS) p2[flag] = true;
      continue;
    }
    if (!P2_FLAGS.includes(body)) return null;
    p2[body] = true;
  }

  // At least one recognised arm segment is required.
  if (!sawP2 && !sawBase && !adaptivePreflop) return null;
  return { name, p2, adaptivePreflop };
}

/** True when `name` names an arm the factory can build. */
export function isArmStrategy(name) {
  return parseArmName(name) !== null;
}

/** Parsed config for a valid arm (report keying: name + resolved p2 snapshot). */
export function armConfig(name) {
  const parsed = parseArmName(name);
  if (!parsed) return null;
  return {
    name: parsed.name,
    p2: { ...parsed.p2 },
    adaptivePreflop: parsed.adaptivePreflop,
  };
}

/** Build the shipped `RulePolicy` for a parsed arm, injecting the postflop P2 config. */
export function makeArmPolicy(name, opts = {}) {
  const parsed = parseArmName(name);
  if (!parsed) return null;
  const seed = opts.seed ?? 0x9e3779b9;
  const params = {
    ...RULE_PRESETS['tight-aggressive'],
    adaptivePreflop: parsed.adaptivePreflop,
  };
  // `RulePolicy` accepts a `postflop` policy, so the full preflop+postflop
  // engine is injectable with an explicit P2 config (not just a bare
  // PostflopPolicy). The baseline (`rules-v1`, all off, adaptive off) is
  // decision-for-decision the pre-P2 engine; it is NOT the same object as the
  // shipped `new RulePolicy({ kind: 'tight-aggressive' })`, whose postflop
  // engine defaults to all-off `DEFAULT_P2` since the 2026-10-06 A/B revert. The
  // harness deliberately isolates its baseline from that product default.
  const postflop = new PostflopPolicy({ params, seed, p2: parsed.p2 });
  return new RulePolicy({ kind: 'tight-aggressive', params, seed, postflop });
}

/**
 * Wrap any policy so every returned action is checked against the legal-action
 * snapshot before it leaves (the same `ensureLegal` guarantee the baselines
 * carry). Shipped `RulePolicy` never emits an illegal action, so this is a
 * safety net + accounting seam: a substitution is counted into `stats` instead
 * of surfacing as a server `action_rejected`.
 */
export function guardPolicy(policy, stats) {
  return {
    name: policy.name,
    decide(view) {
      const decision = policy.decide(view);
      return ensureLegal(decision, view.legalActions, stats);
    },
  };
}

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

/** Names the evaluation rig understands out of the box (baselines). */
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
 * (or `equity-threshold(0.55)`) to change the threshold. Arm names (see the arm
 * factory above) build a shipped `RulePolicy` with the resolved P2/adaptive
 * config. Unknown names return `null` (callers turn that into a hard error).
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
  return makeArmPolicy(raw, opts);
}

/** True for every strategy name the rig can seat: baselines + arms. */
export function isSupportedStrategy(name) {
  const raw = String(name);
  return isBaselineStrategy(raw) || isArmStrategy(raw);
}

/** Human-readable list of supported baseline names, for error messages. */
export const SUPPORTED_STRATEGY_HINT =
  'baselines: always-fold, always-call, equity-threshold[:t]; arms: rules-v1, ' +
  'p2:<sizeGrid|buckets|all>[+...], adaptive-preflop';

/**
 * Resolve a strategy name to a legality-guarded `Policy`, throwing on an
 * unknown name. The eval rig's single entry point for "seat this by name".
 */
export function resolveEvalStrategy(name, stats) {
  const policy = makeStrategy(name, { stats });
  if (!policy)
    throw new Error(`unknown eval strategy "${name}" (${SUPPORTED_STRATEGY_HINT})`);
  return guardPolicy(policy, stats);
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
