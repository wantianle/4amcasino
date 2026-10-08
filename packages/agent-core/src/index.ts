// B4: explicit export whitelist. `@4am/agent-core` is a private, source-only
// package; only these symbols are consumed outside the package. Everything else
// stays module-internal (cross-module imports and package tests use relative
// paths, so they are unaffected).

// Phase-1 pure strategy layers, kept as explicit named exports.
export { deriveTableContext, positionForSeat, type TableContext } from './tableContext.js';
export { normalizeLegalActions, isLegalAction } from './legalActions.js';
export {
  bluffToValueRatio,
  defendProbability,
  mdf,
  resolveFacingBetPrice,
  type FacingBetPrice,
} from './potPrice.js';
export { betAmount, guaranteedLegalAction, raiseToAmount } from './actionAdapter.js';

// Consumers across apps/server (src / test / scripts).
export { HeadlessClient } from './client.js';
export {
  buildDecisionView,
  type DecisionLegalActions,
  type DecisionSeat,
  type DecisionView,
  type PublicAction,
} from './decisionView.js';
export { SessionTracker } from './sessionMemory.js';
export { type Policy } from './policy.js';
export { ScriptedPolicy } from './scriptedPolicy.js';
export { normalizePolicyKind, type PolicyKind } from './policyStyles.js';
export { estimateEquity, mulberry32 } from './equity.js';
export { StylePolicy } from './stylePolicy.js';
export {
  resolveDifficulty,
  resolvePolicyForDifficulty,
  type BotDifficulty,
} from './difficultyPolicy.js';
export { handClassForCards, parseRange } from './rangeParser.js';
export { RFI_MARGINAL, RFI_RANGES, type Position } from './preflopRanges.js';
export { preflopActionOrder } from './preflopCharts/headcount.js';
export { normalizeRustTriple, rustVsOpenSpotKey } from './preflopCharts/rustVsOpen.js';
export { RUST_VS_OPEN } from './preflopCharts/data/rustVsOpen.js';
export { choosePreflopIntent } from './preflopPolicy.js';
export { RULE_PRESETS } from './ruleStyles.js';
export { PostflopPolicy } from './postflopPolicy.js';
export { RulePolicy, type PreflopDecisionTelemetry } from './rulePolicy.js';
export {
  DEFAULT_LLM_MAX_OUTPUT_TOKENS,
  DEFAULT_LLM_MIN_MODEL_BUDGET_MS,
  LlmPolicy,
  type LlmMetric,
  type LlmPolicyOptions,
} from './llmPolicy.js';
export { gridFraction, POSTFLOP_SIZE_GRID, snapBetFraction } from './betSizing.js';
export { chooseVillainModel } from './postflopVillain.js';
export { P2_ALL_OFF, type P2Options } from './postflopP2.js';
export { derivePreflopContext } from './preflopContext.js';
export { postflopActionOrder } from './tableContext.js';
