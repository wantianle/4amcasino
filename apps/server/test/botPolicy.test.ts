import { describe, expect, it } from 'vitest';
import {
  LlmPolicy,
  P2_ALL_OFF,
  RulePolicy,
  ScriptedPolicy,
  StylePolicy,
  type DecisionLegalActions,
  type DecisionSeat,
  type DecisionView,
  type P2Options,
  type PreflopDecisionTelemetry,
} from '@4am/agent-core';
import { cardFromName, type CardId } from '@4am/shared';
import {
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_MAX_CALLS_PER_HAND,
  DEFAULT_LLM_MAX_OUTPUT_TOKENS,
  DEFAULT_LLM_MIN_MODEL_BUDGET_MS,
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_TIMEOUT_MS,
  isLlmPolicyKind,
  llmOptionsFromEnv,
  p2OptionsFromEnv,
  preflopTelemetryFromEnv,
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

  it('leaves the four built-in styles and scripted alias unchanged at low', () => {
    // `low` is the legacy opt-out; the medium default would force rules-v1.
    const scripted = resolveBotPolicyDetailed('scripted', null, undefined, undefined, 'low');
    expect(scripted.policy).toBeInstanceOf(ScriptedPolicy);
    expect(scripted.kind).toBe('tight-aggressive');

    const lag = resolveBotPolicyDetailed('loose-aggressive', null, undefined, undefined, 'low');
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

  it('defaults difficulty to medium and runs the rules-v1 engine', () => {
    const resolved = resolveBotPolicyDetailed('scripted', null);
    expect(resolved.difficulty).toBe('medium');
    expect(resolved.policy).toBeInstanceOf(RulePolicy);
    expect(resolved.policy.name).toBe('rules-v1');
  });

  it('honours an explicit low as a legacy opt-out', () => {
    const resolved = resolveBotPolicyDetailed('scripted', null, undefined, undefined, 'low');
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

  it('high is withdrawn: falls back to medium and surfaces a warning', () => {
    const resolved = resolveBotPolicyDetailed('loose-aggressive', null, undefined, undefined, 'high');
    expect(resolved.difficulty).toBe('medium');
    expect(resolved.requestedDifficulty).toBe('high');
    expect(resolved.downgraded).toBe(false);
    expect(resolved.policy.name).toBe('rules-v1');
    expect(resolved.warnings.join(' ')).toMatch(/high/);
    expect(resolved.warnings.join(' ')).toMatch(/withdrawn/);
  });

  it('unknown difficulty falls back to medium with a warning', () => {
    const resolved = resolveBotPolicyDetailed('scripted', null, undefined, undefined, 'galaxy-brain');
    expect(resolved.difficulty).toBe('medium');
    expect(resolved.policy.name).toBe('rules-v1');
    expect(resolved.warnings.join(' ')).toMatch(/unknown difficulty/);
  });

  it('keeps llm priority: difficulty never downgrades an LLM bot', () => {
    const medium = resolveBotPolicyDetailed('llm', null, llmOpts, undefined, 'medium');
    expect(medium.policy).toBeInstanceOf(LlmPolicy);
    expect(medium.difficulty).toBe('medium');
    expect(medium.warnings).toEqual([]);

    // A withdrawn `high` is reported (observability) but the policy stays the
    // LLM, never rules-v1; `downgraded` is always false now.
    const high = resolveBotPolicyDetailed('llm', null, llmOpts, undefined, 'high');
    expect(high.policy).toBeInstanceOf(LlmPolicy);
    expect(high.difficulty).toBe('medium');
    expect(high.requestedDifficulty).toBe('high');
    expect(high.downgraded).toBe(false);
    expect(high.warnings.join(' ')).toMatch(/withdrawn/);
  });
});

describe('p2OptionsFromEnv', () => {
  it('returns {} (keep DEFAULT_P2) when the switch is unset or unrecognised', () => {
    // Unset/unrecognised env returns `{}`, i.e. keep `DEFAULT_P2` - `sizeGrid` /
    // `buckets` on (a product default, not a statistically validated one).
    expect(p2OptionsFromEnv({} as NodeJS.ProcessEnv)).toEqual({});
    // An unrecognised value is ignored rather than erroring (original semantics).
    expect(p2OptionsFromEnv({ FOURAM_P2: 'maybe' } as NodeJS.ProcessEnv)).toEqual({});
    expect(p2OptionsFromEnv({ FOURAM_P2_ALL_OFF: '0' } as NodeJS.ProcessEnv)).toEqual({});
  });

  it('FOURAM_P2_ALL_OFF=true returns the frozen all-off switches', () => {
    for (const raw of ['1', 'true', 'on', 'yes', 'TRUE']) {
      expect(p2OptionsFromEnv({ FOURAM_P2_ALL_OFF: raw } as NodeJS.ProcessEnv)).toEqual({
        ...P2_ALL_OFF,
      });
    }
  });

  it('FOURAM_P2=on|true|all is an explicit all-on override', () => {
    const allOn = { sizeGrid: true, buckets: true };
    for (const raw of ['on', 'true', 'all', 'ON', 'All']) {
      expect(p2OptionsFromEnv({ FOURAM_P2: raw } as NodeJS.ProcessEnv)).toEqual(allOn);
    }
  });

  it('FOURAM_P2=off|false|0|no returns the all-off switches', () => {
    for (const raw of ['off', 'false', '0', 'no', 'OFF']) {
      expect(p2OptionsFromEnv({ FOURAM_P2: raw } as NodeJS.ProcessEnv)).toEqual({ ...P2_ALL_OFF });
    }
  });

  it('the FOURAM_P2_ALL_OFF kill-switch wins over FOURAM_P2=on', () => {
    expect(
      p2OptionsFromEnv({
        FOURAM_P2: 'on',
        FOURAM_P2_ALL_OFF: '1',
      } as NodeJS.ProcessEnv),
    ).toEqual({ ...P2_ALL_OFF });
  });
});

describe('preflopTelemetryFromEnv (default ON, explicit off)', () => {
  /** Minimal full event; the sink only inspects `spot`, the rest is payload. */
  function event(spot: PreflopDecisionTelemetry['spot']): PreflopDecisionTelemetry {
    return {
      policyKind: 'constrained-random',
      handClass: 'AKs',
      spot,
      situation: 'facing3Bet',
      raises: 2,
      callers: 0,
      heroRaised: true,
      historyComplete: true,
      adaptivePreflopAvailable: true,
      behindUnacted: 1,
      frequencyRaise: 0.5,
      frequencyCall: 0.25,
      intent: 'call',
      canRaise: true,
      minRaiseTo: 1500,
      maxRaiseTo: 10_000,
      returnedAction: 'call',
      lastPreflopRaiserSeat: 5,
      heroIsIPToOpener: false,
    };
  }

  it('is ON when the env var is unset (default-on)', () => {
    expect(preflopTelemetryFromEnv({} as NodeJS.ProcessEnv)).toBeTypeOf('function');
  });

  it('is ON for empty / whitespace-only / unrecognised values', () => {
    // Empty is deliberately NOT an off signal (indistinguishable from an
    // accidental `VAR=`); only a recognised off-token disables the sink.
    for (const raw of ['', '   ', '1', 'true', 'on', 'yes', 'TRUE', 'maybe', '2']) {
      expect(preflopTelemetryFromEnv({ BOT_PREFLOP_TELEMETRY: raw } as NodeJS.ProcessEnv)).toBeTypeOf(
        'function',
      );
    }
  });

  it('is OFF for the four recognised off-tokens (case/whitespace-insensitive)', () => {
    for (const raw of ['0', 'false', 'off', 'no', 'OFF', 'False', '  no  ']) {
      expect(
        preflopTelemetryFromEnv({ BOT_PREFLOP_TELEMETRY: raw } as NodeJS.ProcessEnv),
      ).toBeUndefined();
    }
  });

  it('the returned sink logs the three facing-raise spots and ignores others', () => {
    const calls: unknown[][] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      const sink = preflopTelemetryFromEnv({} as NodeJS.ProcessEnv)!;
      for (const spot of ['facing3Bet', 'facing3BetCold', 'facing4BetPlus'] as const) {
        sink(event(spot));
      }
      // Non-facing-raise spots must be silent (that is the whole point of the sink).
      sink(event('facingOpen'));
      sink(event('unopened'));
    } finally {
      console.log = original;
    }
    expect(calls).toHaveLength(3);
    for (const [line] of calls) {
      expect(String(line).startsWith('[preflop-telemetry] {')).toBe(true);
      expect(JSON.parse(String(line).slice('[preflop-telemetry] '.length))).toMatchObject({
        spot: expect.any(String),
      });
    }
  });
});

// ---------------------------------------------------------------------------
// P2 kill-switch through the PRODUCTION resolver chain
// resolveBotPolicyDetailed -> resolvePolicyForDifficulty -> resolvePolicy
//   -> RulePolicy({p2}) -> PostflopPolicy({p2})
// ---------------------------------------------------------------------------

function p2View(
  hole: CardId[],
  board: CardId[],
  pot: number,
  call: number,
  seq: number,
  memory: DecisionView['sessionMemory'],
): DecisionView {
  const villain: DecisionSeat = {
    seat: 0,
    userId: 2,
    displayName: 'villain',
    isMe: false,
    stack: 1000,
    committed: call,
    total: call,
    folded: false,
    allIn: false,
    sittingOut: false,
    connected: true,
  };
  const me: DecisionSeat = { ...villain, seat: 1, userId: 1, displayName: 'hero', isMe: true };
  const legalActions: DecisionLegalActions = {
    canCheck: false,
    canCall: true,
    callAmount: call,
    canBet: false,
    canRaise: true,
    minRaiseTo: call * 2,
    maxRaiseTo: 1000,
  };
  return {
    room: { id: 'r', name: 'r', sb: 1, bb: 2, minSettleHands: 0, sevenDeuceBonus: 0 },
    hand: {
      handId: `h${seq}`,
      street: board.length >= 5 ? 'river' : board.length === 4 ? 'turn' : 'flop',
      buttonSeat: 1,
      board,
      pot,
      currentBet: call,
      toAct: 1,
      deadline: null,
      myCards: hole,
      mySeat: 1,
    },
    me,
    legalActions,
    potOdds: {
      callAmount: call,
      pot,
      potOdds: call / (pot + call),
      breakEvenEquity: call / (pot + call),
    },
    actionHistory: [],
    opponents: [villain],
    sessionMemory: memory,
    historyComplete: true,
    seatOrder: [0, 1],
    actionSeq: seq,
  };
}

describe('P2 env kill-switch reaches the production resolver chain', () => {
  const c = (n: string) => cardFromName(n);
  // A 10-hand opponent sample and a 0.9-pot size (the sizeGrid read input).
  const maniac = {
    seat: 0,
    sampleHands: 10,
    vpipHands: 8,
    pfrHands: 7,
    postflopBetsRaises: 12,
    postflopCalls: 4,
  };
  const memory: DecisionView['sessionMemory'] = {
    handsObserved: 50,
    netChips: null,
    recentHands: [],
    opponents: [maniac],
  };

  /** Decide a fixed grid with a medium (rules-v1) resolution under `env`. */
  function decisionsWith(env: NodeJS.ProcessEnv, p2Override?: Partial<P2Options>): string[] {
    const policy = resolveBotPolicyDetailed(
      'tight-aggressive',
      null,
      undefined,
      7,
      'medium',
      p2Override ?? p2OptionsFromEnv(env),
    ).policy;
    const boards = [
      [c('Kh'), c('7d'), c('2c')],
      [c('Th'), c('9h'), c('8h')],
    ];
    const holes = [
      [c('Qs'), c('Qd')],
      [c('3s'), c('3d')],
    ];
    const sizes: [number, number][] = [
      [150, 50],
      [190, 90],
    ];
    const out: string[] = [];
    for (const board of boards)
      for (const hole of holes)
        for (const [pot, call] of sizes)
          for (let seq = 0; seq < 12; seq++)
            out.push(JSON.stringify(policy.decide(p2View(hole!, board!, pot, call, seq, memory))));
    return out;
  }

  it('env can roll P2 both ways through the production resolver chain', () => {
    const def = resolveBotPolicyDetailed(
      'tight-aggressive',
      null,
      undefined,
      7,
      'medium',
      p2OptionsFromEnv({}),
    ).policy;
    const kill = resolveBotPolicyDetailed(
      'tight-aggressive',
      null,
      undefined,
      7,
      'medium',
      p2OptionsFromEnv({ FOURAM_P2_ALL_OFF: '1' }),
    ).policy;
    expect(def).toBeInstanceOf(RulePolicy);
    expect(kill).toBeInstanceOf(RulePolicy);

    // The product default (no env) is buckets + sizeGrid ON; the explicit env
    // kill-switch restores the all-off pre-P2 path, so they must differ.
    const withDefault = decisionsWith({});
    const withKillSwitch = decisionsWith({ FOURAM_P2_ALL_OFF: '1' });
    expect(withKillSwitch).not.toEqual(withDefault);

    // `FOURAM_P2=off` is the same explicit all-off as the kill-switch...
    expect(decisionsWith({ FOURAM_P2: 'off' })).toEqual(withKillSwitch);
    // ...and `FOURAM_P2=on` flows through the resolver as the (already default)
    // all-on config, so it matches the product default.
    expect(decisionsWith({ FOURAM_P2: 'on' })).toEqual(withDefault);
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
