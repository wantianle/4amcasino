// Generated from packages/agent-core/src/rulePolicy.ts at HEAD 5f9b12a via
// `git show 5f9b12a:packages/agent-core/src/rulePolicy.ts`.
//
// Scope of the copy: this file additionally carries the generation header you
// are reading, and its preflop imports are repointed: `choosePreflopIntent` /
// `PreflopChoice` come from ./preflopPolicyBaseline.js (the true pre-step-3
// engine) and the relative imports are redirected to ../../src. Apart from
// those changes, the decision-logic body is byte-for-byte the 5f9b12a file. It
// exists so a test can compare the final `PolicyDecision` of the current
// `RulePolicy` with `adaptivePreflop` off against the pre-step-3 baseline.
//
// SIZING OVERLAY (2026-10-07): `raiseTo` uses the **shared** sizing constants
// (`src/betSizing.ts`) and the shared `heroIsIPToOpener` / `lastPreflopRaiserSeat`
// helpers (2.5bb open / 3bb SB open / 3x-4x 3-bet / 2.2x-2.5x 4-bet), so this
// fixture still isolates the `adaptivePreflop` flag rather than the orthogonal
// sizing change, without copying the standard. A sizing regression is covered by
// dedicated sizing unit tests, not this diff. This is the one deliberate
// exception to "byte-for-byte".
//
// DO NOT EDIT BY HAND - regenerate from git if the baseline ever changes.

import type { PlayerAction } from '@4am/shared';
import type { DecisionLegalActions, DecisionView } from '../../src/decisionView.js';
import { mulberry32 } from '../../src/equity.js';
import type { Policy, PolicyDecision } from '../../src/policy.js';
import type { PolicyKind } from '../../src/policyStyles.js';
import { PostflopPolicy, heroIsIPToOpener, lastPreflopRaiserSeat } from '../../src/postflopPolicy.js';
import {
  PREFLOP_3BET_IP_MULT,
  PREFLOP_3BET_OOP_MULT,
  PREFLOP_4BET_IP_MULT,
  PREFLOP_4BET_OOP_MULT,
  PREFLOP_OPEN_BB,
  PREFLOP_SB_OPEN_BB,
} from '../../src/betSizing.js';
import { choosePreflopIntent, type PreflopChoice } from './preflopPolicyBaseline.js';
import { deriveRulesSeed } from '../../src/rulesSeed.js';
import { RULE_PRESETS, type RuleParams } from '../../src/ruleStyles.js';

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
      opts.postflop ?? new PostflopPolicy({ params: this.params, seed: this.seed });
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
      // Standard opens: 2.5bb, small blind 3bb (out of position).
      target = choice.context.position === 'SB' ? bb * PREFLOP_SB_OPEN_BB : bb * PREFLOP_OPEN_BB;
    } else if (situation === 'facing3Bet') {
      // 4-bet: fixed multiple of the 3-bet — 2.2x IP, 2.5x OOP.
      target =
        currentBet *
        (heroIsIPToOpener(view, lastPreflopRaiserSeat(view))
          ? PREFLOP_4BET_IP_MULT
          : PREFLOP_4BET_OOP_MULT);
    } else {
      // 3-bet: fixed multiple of the open — 3x IP, 4x OOP. Shared sizing
      // constants + shared relative-position helper, so the fixture cannot
      // drift from the policy on the standard itself.
      target =
        currentBet *
        (heroIsIPToOpener(view, lastPreflopRaiserSeat(view))
          ? PREFLOP_3BET_IP_MULT
          : PREFLOP_3BET_OOP_MULT);
    }
    target = Math.round(target);
    target = Math.max(target, la.minRaiseTo);
    target = Math.min(target, la.maxRaiseTo);
    // `normalizeLegal` guarantees maxRaiseTo >= minRaiseTo when canRaise is set.
    target = Math.max(target, la.minRaiseTo);
    return { amount: target, allIn: target >= la.maxRaiseTo };
  }
}
