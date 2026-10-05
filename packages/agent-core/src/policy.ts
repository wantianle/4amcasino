import type { PlayerAction } from '@4am/shared';
import type { DecisionView } from './decisionView.js';

/**
 * Bot policy contract.
 *
 * Phase 0 defines only the interface and value types. Concrete strategies
 * (tight-aggressive, opponent modelling, ...) land in Phase 2; `scriptedPolicy`
 * is a deliberately small, legal placeholder for exercising the pipeline.
 */

/** A policy's full decision: the action plus why it chose it. */
export interface PolicyDecision {
  action: PlayerAction;
  /** Human/agent-readable justification, for logs and telemetry. */
  reason: string;
  /**
   * Where the action came from, when the policy can distinguish it. Model-backed
   * policies set `'model'` only when the returned action is the model's own
   * (validated) choice, and `'fallback'` whenever the local fallback produced it
   * - including shadow mode, where the model was consulted but not executed.
   * Pure local policies leave this undefined.
   */
  source?: 'model' | 'fallback';
}

export interface Policy {
  /** Stable identifier for logs and selection. */
  readonly name: string;
  /** Decide given the current view. Called only when it is the bot's turn. */
  decide(view: DecisionView): PolicyDecision | Promise<PolicyDecision>;
}
