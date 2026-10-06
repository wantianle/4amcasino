import type { PlayerAction } from '@4am/shared';
import type { DecisionLegalActions, DecisionView } from './decisionView.js';
import { mulberry32 } from './equity.js';
import type { Policy, PolicyDecision } from './policy.js';
import type { PolicyKind } from './policyStyles.js';
import { PostflopPolicy, type P2Options } from './postflopPolicy.js';
import { choosePreflopIntent, type PreflopChoice } from './preflopPolicy.js';
import { deriveRulesSeed } from './rulesSeed.js';
import { RULE_PRESETS, type RuleParams } from './ruleStyles.js';

/**
 * Rules-v1: a chart-and-frequency policy with no CFR, solver or network in the
 * loop.
 *
 * Preflop it reads the baseline ranges in `preflopRanges.ts`; postflop it runs
 * the heuristic engine in `postflopPolicy.ts` (MDF defence, texture-based
 * sizing, value:bluff ratios, blockers, range advantage). Both resolve mixed
 * frequencies with a seeded `mulberry32` (never `Math.random`), so a given
 * `(view, seed)` always decides the same way.
 *
 * `fallback` is the exception path: if the postflop engine ever throws, the
 * decision fails closed to this always-legal policy (the server resolver injects
 * a `StylePolicy`; standalone it is a minimal check/call/fold).
 */

export const RULE_POLICY_NAME = 'rules-v1';

/**
 * The synchronous subset of `Policy` used for the postflop placeholder. A
 * `StylePolicy` satisfies it structurally, which lets the resolver inject a
 * richer fallback without `rulePolicy.ts` importing `stylePolicy.ts`.
 */
export interface RuleFallbackPolicy {
  readonly name: string;
  decide(view: DecisionView): PolicyDecision;
}

export interface RulePolicyOptions {
  /** Preset used when `params` is omitted. Defaults to `tight-aggressive`. */
  kind?: PolicyKind;
  /** Explicit, already-validated rule params. */
  params?: RuleParams;
  /** Base seed for the mixed-frequency RNG. */
  seed?: number;
  /** Postflop engine; defaults to `PostflopPolicy` with the same params/seed. */
  postflop?: RuleFallbackPolicy;
  /** Exception fallback if the postflop engine throws; defaults to check/call/fold. */
  fallback?: RuleFallbackPolicy;
  /**
   * P2 behaviour switches for the default postflop engine. Omitted fields keep
   * `DEFAULT_P2` (`sizeGrid` / `buckets` on since the 2026-10-06 prune; a
   * product default, not a validated one); pass explicit `P2_ALL_OFF` for the
   * pre-P2 path. Ignored when `postflop` is injected explicitly (the caller owns
   * that engine's config).
   */
  p2?: Partial<P2Options>;
}

/** Defensive normalisation shared with `StylePolicy`: malformed legal actions
 * can never make us emit something the table would reject. */
function normalizeLegal(la: DecisionLegalActions): DecisionLegalActions {
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

/** Is `action` legal against the already-normalised legal actions? */
function isLegalAction(action: PlayerAction, la: DecisionLegalActions): boolean {
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
  }
}

/** The guaranteed-legal action: check if free, else call, else fold. */
function onlyLegalAction(la: DecisionLegalActions): PolicyDecision {
  if (la.canCheck) return { action: { type: 'check' }, reason: 'rules-v1 fail-closed: check' };
  if (la.canCall) return { action: { type: 'call' }, reason: 'rules-v1 fail-closed: call' };
  return { action: { type: 'fold' }, reason: 'rules-v1 fail-closed: fold' };
}

/** A minimal, always-legal postflop placeholder (see the module TODO). */
class ConservativePostflopPolicy implements RuleFallbackPolicy {
  readonly name = 'rules-v1-postflop-placeholder';

  decide(view: DecisionView): PolicyDecision {
    const raw = view.legalActions;
    if (!raw) throw new Error(`${this.name} asked to act out of turn`);
    const la = normalizeLegal(raw);
    if (la.canCheck) {
      return { action: { type: 'check' }, reason: 'rules-v1 postflop placeholder: check' };
    }
    const odds = view.potOdds?.potOdds ?? 0;
    if (la.canCall && odds <= 0.3) {
      return { action: { type: 'call' }, reason: 'rules-v1 postflop placeholder: call a small price' };
    }
    return { action: { type: 'fold' }, reason: 'rules-v1 postflop placeholder: fold' };
  }
}

export class RulePolicy implements Policy {
  readonly name = RULE_POLICY_NAME;
  private readonly kind: PolicyKind;
  private readonly params: RuleParams;
  private readonly seed: number;
  private readonly postflop: RuleFallbackPolicy;
  private readonly fallback: RuleFallbackPolicy;

  constructor(kindOrOptions: PolicyKind | RulePolicyOptions = 'tight-aggressive') {
    const opts: RulePolicyOptions =
      typeof kindOrOptions === 'string' ? { kind: kindOrOptions } : kindOrOptions;
    this.kind = opts.kind ?? 'tight-aggressive';
    this.params = opts.params ?? RULE_PRESETS[this.kind];
    this.seed = opts.seed ?? 0x9e3779b9;
    this.postflop =
      opts.postflop ?? new PostflopPolicy({ params: this.params, seed: this.seed, p2: opts.p2 });
    this.fallback = opts.fallback ?? new ConservativePostflopPolicy();
  }

  decide(view: DecisionView): PolicyDecision {
    const raw = view.legalActions;
    if (!raw) throw new Error(`${this.name} asked to act out of turn`);
    const la = normalizeLegal(raw);
    const hole = view.hand?.myCards ?? [];

    if (view.hand && view.hand.street === 'preflop' && hole.length >= 2) {
      const choice = choosePreflopIntent(view, this.params, mulberry32(this.seedFor(view)));
      return this.preflopAction(view, la, choice);
    }
    // Postflop: the rules-v1 engine, failing closed to a verified legal action.
    try {
      return this.postflop.decide(view);
    } catch {
      return this.safeFallback(view, la);
    }
  }

  /**
   * True fail-closed: try the injected fallback, accept its action only if it is
   * legal, and otherwise return a guaranteed-legal action. A throwing fallback
   * is caught here too, so `decide` never propagates a postflop error.
   */
  private safeFallback(view: DecisionView, la: DecisionLegalActions): PolicyDecision {
    try {
      const decision = this.fallback.decide(view);
      if (isLegalAction(decision.action, la)) return decision;
    } catch {
      // fall through to the guaranteed-legal action
    }
    return onlyLegalAction(la);
  }

  /**
   * Deterministic per-decision seed:
   *   hash(baseSeed, 'rules-v1', handId, actionSeq, mySeat, street, myCards)
   * Same view + same base seed ⇒ same roll; advancing `actionSeq` changes it, so
   * mixed frequencies actually mix across actions of one hand.
   */
  private seedFor(view: DecisionView): number {
    return deriveRulesSeed(this.seed, view);
  }

  /** Convert the chosen intent into a legal action, sizing raises legally. */
  private preflopAction(view: DecisionView, la: DecisionLegalActions, choice: PreflopChoice): PolicyDecision {
    const ctx = choice.context;
    const tag = `${ctx.position}/${ctx.situation}`;

    if (choice.intent === 'raise' && la.canRaise) {
      const { amount, allIn } = this.raiseTo(view, la, choice);
      const type: PlayerAction['type'] = la.canBet ? 'bet' : 'raise';
      return {
        action: { type, amount },
        reason: `rules-v1 ${tag} ${choice.handClass.key}: ${type}${allIn ? ' all-in' : ''} to ${amount}`,
      };
    }
    if (choice.intent === 'raise' || choice.intent === 'call') {
      if (la.canCall) {
        return {
          action: { type: 'call' },
          reason: `rules-v1 ${tag} ${choice.handClass.key}: call`,
        };
      }
      if (la.canCheck) {
        return {
          action: { type: 'check' },
          reason: `rules-v1 ${tag} ${choice.handClass.key}: check (cannot raise)`,
        };
      }
      return {
        action: { type: 'fold' },
        reason: `rules-v1 ${tag} ${choice.handClass.key}: fold (no legal call/raise)`,
      };
    }
    // fold intent: checking is free when we are unopened and nobody bet.
    if (la.canCheck) {
      return {
        action: { type: 'check' },
        reason: `rules-v1 ${tag} ${choice.handClass.key}: check (free)`,
      };
    }
    return {
      action: { type: 'fold' },
      reason: `rules-v1 ${tag} ${choice.handClass.key}: fold`,
    };
  }

  /**
   * A legal raise-to target clamped to `[minRaiseTo, maxRaiseTo]`. A sub-20BB
   * stack is an explicit shove to `maxRaiseTo`, not an accidental clamp, so the
   * adapter and its tests can tell a deliberate all-in from a capped raise.
   */
  private raiseTo(
    view: DecisionView,
    la: DecisionLegalActions,
    choice: PreflopChoice,
  ): { amount: number; allIn: boolean } {
    const currentBet = view.hand?.currentBet ?? 0;
    const bb = view.room?.bb && view.room.bb > 0 ? view.room.bb : 1;
    const situation = choice.context.situation;

    if (choice.context.stackBB < 20) return { amount: la.maxRaiseTo, allIn: true };

    let target: number;
    if (situation === 'unopened') {
      // SB opens larger (out of position); everyone else uses a ~2.5x standard.
      target = choice.context.position === 'SB' ? bb * 3 : bb * 2.5;
    } else if (situation === 'facing3Bet') {
      target = currentBet * 2.2; // 4-bet
    } else {
      target = currentBet * 3; // 3-bet
    }
    target = Math.round(target);
    target = Math.max(target, la.minRaiseTo);
    target = Math.min(target, la.maxRaiseTo);
    // `normalizeLegal` guarantees maxRaiseTo >= minRaiseTo when canRaise is set.
    target = Math.max(target, la.minRaiseTo);
    return { amount: target, allIn: target >= la.maxRaiseTo };
  }
}
