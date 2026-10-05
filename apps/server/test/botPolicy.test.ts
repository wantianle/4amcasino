import { describe, expect, it } from 'vitest';
import { LlmPolicy, RulePolicy, ScriptedPolicy, StylePolicy } from '@4am/agent-core';
import {
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_MAX_CALLS_PER_HAND,
  DEFAULT_LLM_MAX_OUTPUT_TOKENS,
  DEFAULT_LLM_MIN_MODEL_BUDGET_MS,
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_TIMEOUT_MS,
  isLlmPolicyKind,
  llmOptionsFromEnv,
  resolveBotPolicyDetailed,
} from '../src/botPolicy.js';

/** Phase 3 server resolver: `llm` plus the untouched built-in styles. */

describe('resolveBotPolicyDetailed', () => {
  it('builds an LlmPolicy (with a local fallback) for the llm kind', () => {
    const resolved = resolveBotPolicyDetailed('llm', null, {
      apiKey: '',
      baseUrl: 'http://x/v1',
      model: 'm',
      timeoutMs: 1_000,
      maxCallsPerHand: 3,
    });
    expect(resolved.kind).toBe('llm');
    expect(resolved.policy).toBeInstanceOf(LlmPolicy);
    expect(resolved.policy.name).toBe('llm-deepseek-flash');
    expect(resolved.warnings).toEqual([]);
  });

  it('leaves the four built-in styles and scripted alias unchanged', () => {
    const scripted = resolveBotPolicyDetailed('scripted', null);
    expect(scripted.policy).toBeInstanceOf(ScriptedPolicy);
    expect(scripted.kind).toBe('tight-aggressive');

    const lag = resolveBotPolicyDetailed('loose-aggressive', null);
    expect(lag.policy).toBeInstanceOf(StylePolicy);
    expect(lag.kind).toBe('loose-aggressive');
  });

  it('still reports unknown kinds and invalid policy_json as warnings', () => {
    const unknown = resolveBotPolicyDetailed('mystery', null);
    expect(unknown.warnings.join(' ')).toMatch(/unknown policyKind/);
    const badJson = resolveBotPolicyDetailed('calling-station', '{oops');
    expect(badJson.warnings.join(' ')).toMatch(/not valid JSON/);
  });

  it('builds a default LlmPolicy from env defaults when no options are given', () => {
    expect(resolveBotPolicyDetailed('llm', null).policy).toBeInstanceOf(LlmPolicy);
  });

  it('detects the llm kind case-insensitively', () => {
    expect(isLlmPolicyKind(' LLM ')).toBe(true);
    expect(isLlmPolicyKind('tag')).toBe(false);
    expect(isLlmPolicyKind(null)).toBe(false);
  });

  // ---- difficulty dispatch -------------------------------------------------

  const llmOpts = {
    apiKey: '',
    baseUrl: 'http://x/v1',
    model: 'm',
    timeoutMs: 1_000,
    maxCallsPerHand: 3,
  };

  it('defaults difficulty to low and keeps the legacy scripted resolution', () => {
    const resolved = resolveBotPolicyDetailed('scripted', null);
    expect(resolved.difficulty).toBe('low');
    expect(resolved.policy).toBeInstanceOf(ScriptedPolicy);
  });

  it('medium forces the rules-v1 engine over a plain policyKind', () => {
    const resolved = resolveBotPolicyDetailed('tight-aggressive', null, undefined, undefined, 'medium');
    expect(resolved.policy).toBeInstanceOf(RulePolicy);
    expect(resolved.policy.name).toBe('rules-v1');
    expect(resolved.difficulty).toBe('medium');
    expect(resolved.requestedDifficulty).toBe('medium');
    expect(resolved.downgraded).toBe(false);
    expect(resolved.warnings).toEqual([]);
  });

  it('high is reserved: falls back to medium and surfaces a warning', () => {
    const resolved = resolveBotPolicyDetailed('loose-aggressive', null, undefined, undefined, 'high');
    expect(resolved.difficulty).toBe('medium');
    expect(resolved.requestedDifficulty).toBe('high');
    expect(resolved.downgraded).toBe(true);
    expect(resolved.policy.name).toBe('rules-v1');
    expect(resolved.warnings.join(' ')).toMatch(/high/);
    expect(resolved.warnings.join(' ')).toMatch(/not implemented/);
  });

  it('unknown difficulty falls back to low with a warning', () => {
    const resolved = resolveBotPolicyDetailed('scripted', null, undefined, undefined, 'galaxy-brain');
    expect(resolved.difficulty).toBe('low');
    expect(resolved.policy).toBeInstanceOf(ScriptedPolicy);
    expect(resolved.warnings.join(' ')).toMatch(/unknown difficulty/);
  });

  it('keeps llm priority: difficulty never downgrades an LLM bot', () => {
    const medium = resolveBotPolicyDetailed('llm', null, llmOpts, undefined, 'medium');
    expect(medium.policy).toBeInstanceOf(LlmPolicy);
    expect(medium.difficulty).toBe('medium');
    expect(medium.warnings).toEqual([]);

    // `high` still downgrades the reported tier (observability) but the policy
    // remains the LLM, never rules-v1.
    const high = resolveBotPolicyDetailed('llm', null, llmOpts, undefined, 'high');
    expect(high.policy).toBeInstanceOf(LlmPolicy);
    expect(high.difficulty).toBe('medium');
    expect(high.requestedDifficulty).toBe('high');
    expect(high.downgraded).toBe(true);
    expect(high.warnings.join(' ')).toMatch(/not implemented/);
  });
});

describe('llmOptionsFromEnv', () => {
  it('applies documented defaults and parses overrides', () => {
    const defaults = llmOptionsFromEnv({} as NodeJS.ProcessEnv);
    expect(defaults.apiKey).toBe('');
    expect(defaults.baseUrl).toBe(DEFAULT_LLM_BASE_URL);
    expect(defaults.model).toBe(DEFAULT_LLM_MODEL);
    // Real deepseek-flash latency is ~3-4s p50 / ~10-15s p95; the old 2s default
    // timed out most calls, so pin the new production default explicitly.
    expect(DEFAULT_LLM_TIMEOUT_MS).toBe(12_000);
    expect(defaults.timeoutMs).toBe(12_000);
    expect(defaults.maxCallsPerHand).toBe(DEFAULT_LLM_MAX_CALLS_PER_HAND);
    expect(defaults.maxOutputTokens).toBe(DEFAULT_LLM_MAX_OUTPUT_TOKENS);
    expect(defaults.minModelBudgetMs).toBe(DEFAULT_LLM_MIN_MODEL_BUDGET_MS);
    expect(DEFAULT_LLM_MIN_MODEL_BUDGET_MS).toBe(6_000);
    expect(defaults.shadow).toBe(false);

    const overridden = llmOptionsFromEnv({
      LLM_API_KEY: 'k',
      LLM_BASE_URL: 'http://custom/v1',
      LLM_MODEL: 'other',
      LLM_TIMEOUT_MS: '1500',
      LLM_MAX_CALLS_PER_HAND: '7',
      LLM_MAX_OUTPUT_TOKENS: '80',
      LLM_MIN_BUDGET_MS: '2500',
      LLM_SHADOW: '1',
    } as NodeJS.ProcessEnv);
    expect(overridden.apiKey).toBe('k');
    expect(overridden.baseUrl).toBe('http://custom/v1');
    expect(overridden.model).toBe('other');
    expect(overridden.timeoutMs).toBe(1_500);
    expect(overridden.maxCallsPerHand).toBe(7);
    expect(overridden.maxOutputTokens).toBe(80);
    expect(overridden.minModelBudgetMs).toBe(2_500);
    expect(overridden.shadow).toBe(true);
  });

  it('lets LLM_MIN_BUDGET_MS=0 disable proactive degradation', () => {
    const opts = llmOptionsFromEnv({ LLM_MIN_BUDGET_MS: '0' } as NodeJS.ProcessEnv);
    expect(opts.minModelBudgetMs).toBe(0);
    // A non-numeric override is ignored rather than disabling the guard.
    const bad = llmOptionsFromEnv({ LLM_MIN_BUDGET_MS: 'nope' } as NodeJS.ProcessEnv);
    expect(bad.minModelBudgetMs).toBe(DEFAULT_LLM_MIN_MODEL_BUDGET_MS);
  });

  it('defaults max output tokens high enough for reasoning + a tool call', () => {
    // deepseek-flash's `reasoning_content` counts against `max_tokens`; the old
    // 160-token cap truncated the tool-call JSON and forced a parse fallback.
    expect(DEFAULT_LLM_MAX_OUTPUT_TOKENS).toBe(2_048);
    const defaults = llmOptionsFromEnv({} as NodeJS.ProcessEnv);
    expect(defaults.maxOutputTokens).toBe(2_048);
  });

  it('lets LLM_MAX_OUTPUT_TOKENS override the default', () => {
    const opts = llmOptionsFromEnv({ LLM_MAX_OUTPUT_TOKENS: '4096' } as NodeJS.ProcessEnv);
    expect(opts.maxOutputTokens).toBe(4_096);
  });

  it('ignores non-positive numeric overrides', () => {
    const opts = llmOptionsFromEnv({
      LLM_TIMEOUT_MS: '0',
      LLM_MAX_CALLS_PER_HAND: 'nope',
    } as NodeJS.ProcessEnv);
    expect(opts.timeoutMs).toBe(DEFAULT_LLM_TIMEOUT_MS);
    expect(opts.maxCallsPerHand).toBe(DEFAULT_LLM_MAX_CALLS_PER_HAND);
  });
});
