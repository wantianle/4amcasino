import type { DecisionView } from './decisionView.js';
import { mulberry32 } from './equity.js';
import type { Policy, PolicyDecision } from './policy.js';
import { RulePolicy, type RulePolicyOptions } from './rulePolicy.js';
import { sampleConstrainedRandomParams, type RuleParams } from './ruleStyles.js';

/**
 * Make `constrained-random` behave like its name at the default `medium`
 * difficulty, without touching the rules engine for any other preset.
 *
 * The problem: at `medium`, `forceRulesEngine` injects `engine: 'rules-v1'`, so
 * `resolvePolicy` builds a `RulePolicy` from the fixed `RULE_PRESETS` table. A
 * `constrained-random` bot is therefore *not* random in style: every bot of that
 * kind shares the same knobs, and only the seeded frequency roll varies. The one
 * place that really mixes styles — `StylePolicy.mixedDecision` — is unreachable
 * at `medium`.
 *
 * The fix: keep the same rules engine (same strength class as the other medium
 * bots) but re-sample the `constrained-random` *numeric* knobs once per hand.
 * `RulePolicy`'s preflop and postflop engines both consume `params` at
 * construction, so swapping in a freshly-parameterised delegate at the first
 * decision of each hand is enough; the decision-level RNG and seed derivation
 * are untouched.
 *
 * Scope and guarantees:
 *   - only `constrained-random` is wrapped (the resolver chooses the class);
 *   - the rule preset table itself is unchanged, so the preflop/postflop
 *     behaviour snapshots (which read `RULE_PRESETS` directly) are byte-stable;
 *   - per HAND granularity, not per decision: within one hand the sampled style
 *     is fixed, which makes a hand reproducible and its reasoning explainable.
 *     The one exception is a view with a missing/empty `handId` (see
 *     `decide`): with no hand identity we cannot detect a hand boundary, so the
 *     fallback advances per decision instead of silently freezing;
 *   - `seed` still governs everything: same base seed + same `handId` ⇒ same
 *     sampled params ⇒ same decisions.
 *
 * Strength: this is a bounded stylistic perturbation around the existing
 * parameters. It is not expected to produce an obvious systematic directional
 * shift, but the strength mean has not yet been verified. The 25% jitter is kept
 * because the product goal is a *visibly* different style across hands; if the
 * goal were instead to hold strength as constant as possible, 10–15% would be
 * the safer band.
 *
 * `name` mirrors the delegate (`rules-v1`) so server logs and observability stay
 * identical to every other medium bot; the randomisation is an implementation
 * detail, not a new policy kind.
 */
export interface ConstrainedRandomPolicyOptions extends Omit<RulePolicyOptions, 'params'> {
  /** Base `constrained-random` preset, jittered per hand. */
  params: RuleParams;
}

export class ConstrainedRandomPolicy implements Policy {
  readonly name: string;
  private readonly baseParams: RuleParams;
  private readonly baseSeed: number;
  private readonly ruleOptions: Omit<RulePolicyOptions, 'params'>;
  /**
   * Identity of the hand whose params are currently loaded; `null` = none seen
   * yet. Real handIds are namespaced (`id:`) and the no-handId fallback uses a
   * distinct `seq:` namespace, so the two can never collide.
   */
  private currentHandKey: string | null = null;
  /**
   * Ordinal of decisions taken without a usable `handId`, used as the fallback
   * hand identity (see {@link handKeyFor}).
   */
  private missingHandSeq = 0;
  private delegate: RulePolicy;

  constructor(opts: ConstrainedRandomPolicyOptions) {
    const { params, ...rest } = opts;
    this.baseParams = params;
    this.baseSeed = rest.seed ?? 0x9e3779b9;
    this.ruleOptions = rest;
    this.delegate = new RulePolicy({ ...rest, params });
    this.name = this.delegate.name;
  }

  decide(view: DecisionView): PolicyDecision | Promise<PolicyDecision> {
    const { key, seed } = this.handKeyFor(view.hand?.handId);
    if (key !== this.currentHandKey) {
      this.currentHandKey = key;
      const rng = mulberry32(seed);
      const params = sampleConstrainedRandomParams(this.baseParams, rng);
      this.delegate = new RulePolicy({ ...this.ruleOptions, params });
    }
    return this.delegate.decide(view);
  }

  /**
   * Identity + per-hand parameter seed for this view.
   *
   * A missing or empty `handId` is deliberately NOT treated as a stable hand
   * identity: `''` would make every id-less hand share one parameter draw, and
   * the old `null` initial value meant the first id-less view was never sampled
   * at all. Without an id there is no way to detect a hand boundary, so we key
   * on this policy's decision ordinal instead — the style still varies, and it
   * does so deterministically from the base seed, with no external input. The
   * cost is that id-less decisions are re-sampled individually rather than once
   * per hand; that is the best available guarantee and strictly better than a
   * silent constant.
   */
  private handKeyFor(handId: string | undefined): { key: string; seed: number } {
    if (typeof handId === 'string' && handId !== '') {
      return { key: `id:${handId}`, seed: deriveHandParamsSeed(this.baseSeed, handId) };
    }
    const seq = this.missingHandSeq++;
    return { key: `seq:${seq}`, seed: deriveMissingHandParamsSeed(this.baseSeed, seq) };
  }
}

/**
 * Domain-separated hand seed for the per-hand parameter draw. Reuses the same
 * FNV-1a mixing as `deriveRulesSeed` but with its own `'constrained-random'`
 * prefix, so the sampled params cannot collide with the decision-level roll.
 */
function deriveHandParamsSeed(baseSeed: number, handId: string): number {
  const parts = `constrained-random|${handId}`;
  let h = baseSeed >>> 0;
  for (let i = 0; i < parts.length; i++) {
    h = Math.imul(h ^ parts.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Parameter seed for the no-handId fallback, in its own `'constrained-random
 * missing'` domain so a fallback ordinal can never collide with a real handId
 * that happens to look like a number.
 */
function deriveMissingHandParamsSeed(baseSeed: number, seq: number): number {
  const parts = `constrained-random|missing|${seq}`;
  let h = baseSeed >>> 0;
  for (let i = 0; i < parts.length; i++) {
    h = Math.imul(h ^ parts.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}
