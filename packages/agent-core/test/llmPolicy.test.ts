import { describe, expect, it, vi } from 'vitest';
import { cardFromName } from '@4am/shared';
import type { DecisionSeat, DecisionView, PublicAction } from '../src/decisionView.js';
import { LlmPolicy, type LlmMetric } from '../src/llmPolicy.js';
import type { Policy, PolicyDecision } from '../src/policy.js';

/**
 * Unit tests for the Phase 3 LLM policy. A fake `fetch` stands in for the
 * OpenAI-compatible endpoint, so every branch of the fallback chain and the
 * metric/redaction contract is exercised without a network.
 */

const KEY = 'sk-secret-test-key';

function seat(over: Partial<DecisionSeat> = {}): DecisionSeat {
  return {
    seat: 1,
    userId: 7777,
    displayName: 'VillainName',
    isMe: false,
    stack: 900,
    committed: 20,
    total: 20,
    folded: false,
    allIn: false,
    sittingOut: false,
    connected: true,
    ...over,
  };
}

function action(street: PublicAction['street'], seatNo: number, amount?: number): PublicAction {
  return {
    actionSeq: 0,
    street,
    seat: seatNo,
    action: amount === undefined ? { type: 'call' } : { type: 'raise', amount },
    auto: false,
    ts: 0,
  };
}

function makeView(over: Partial<DecisionView> = {}): DecisionView {
  return {
    room: {
      id: 'room-secret-id',
      name: 'Secret Room',
      sb: 10,
      bb: 20,
      minSettleHands: 0,
      sevenDeuceBonus: 0,
    },
    hand: {
      handId: 'h1',
      street: 'flop',
      buttonSeat: 0,
      board: [cardFromName('2c'), cardFromName('7d'), cardFromName('Js')],
      pot: 100,
      currentBet: 20,
      toAct: 0,
      // A normal room clock, comfortably above the proactive-degradation budget.
      deadline: Date.now() + 30_000,
      myCards: [cardFromName('Ah'), cardFromName('Kd')],
      mySeat: 0,
    },
    me: {
      seat: 0,
      userId: 4242,
      displayName: 'SneakyBot',
      isMe: true,
      stack: 1_000,
      committed: 0,
      total: 0,
      folded: false,
      allIn: false,
      sittingOut: false,
      connected: true,
    },
    legalActions: {
      canCheck: false,
      canCall: true,
      callAmount: 20,
      canBet: false,
      canRaise: true,
      minRaiseTo: 40,
      maxRaiseTo: 200,
    },
    potOdds: { callAmount: 20, pot: 100, potOdds: 20 / 120, breakEvenEquity: 20 / 120 },
    actionHistory: [action('preflop', 1, 20), action('flop', 1)],
    opponents: [seat()],
    sessionMemory: {
      handsObserved: 3,
      netChips: -15,
      recentHands: [{ myDelta: -15, endedStreet: 'flop', showdown: false, historyComplete: true }],
      opponents: [
        {
          seat: 1,
          sampleHands: 3,
          vpipHands: 2,
          pfrHands: 1,
          postflopBetsRaises: 1,
          postflopCalls: 2,
        },
      ],
    },
    historyComplete: true,
    ...over,
  };
}

/** A legal-by-construction local fallback: prefer check, then call, then fold. */
const fallback: Policy = {
  name: 'fallback',
  decide(view: DecisionView): PolicyDecision {
    const la = view.legalActions!;
    if (la.canCheck) return { action: { type: 'check' }, reason: 'fallback check' };
    if (la.canCall) return { action: { type: 'call' }, reason: 'fallback call' };
    return { action: { type: 'fold' }, reason: 'fallback fold' };
  },
};

function isLegalAction(view: DecisionView, a: { type: string; amount?: number }): boolean {
  const la = view.legalActions!;
  switch (a.type) {
    case 'fold':
      return true;
    case 'check':
      return la.canCheck;
    case 'call':
      return la.canCall;
    case 'bet':
      return la.canBet && a.amount !== undefined && a.amount >= la.minRaiseTo && a.amount <= la.maxRaiseTo;
    case 'raise':
      return la.canRaise && a.amount !== undefined && a.amount >= la.minRaiseTo && a.amount <= la.maxRaiseTo;
    default:
      return false;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const USAGE = { prompt_tokens: 100, completion_tokens: 12 };

function toolResponse(args: unknown, usage: unknown = USAGE): Response {
  return jsonResponse({
    choices: [
      {
        message: {
          tool_calls: [
            { id: '1', type: 'function', function: { name: 'choose_poker_action', arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
    usage,
  });
}

function contentResponse(content: string, usage: unknown = USAGE): Response {
  return jsonResponse({ choices: [{ message: { content } }], usage });
}

type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>;

function fakeFetch(handler: FetchHandler) {
  const fn = vi.fn(async (url: unknown, init: unknown) =>
    handler(String(url), (init ?? {}) as RequestInit),
  );
  return { fetch: fn as unknown as typeof globalThis.fetch, fn };
}

function makePolicy(
  over: Partial<ConstructorParameters<typeof LlmPolicy>[0]> = {},
): { policy: LlmPolicy; metrics: LlmMetric[] } {
  const metrics: LlmMetric[] = [];
  const policy = new LlmPolicy({
    apiKey: KEY,
    baseUrl: 'https://llm.example/v1',
    model: 'test-model',
    timeoutMs: 1_000,
    maxCallsPerHand: 24,
    fallback,
    onMetric: (e) => metrics.push(e),
    ...over,
  });
  return { policy, metrics };
}

const types = (metrics: LlmMetric[]) => metrics.map((m) => m.type);

describe('LlmPolicy', () => {
  it('uses a tool call and returns the validated model action', async () => {
    const { fetch, fn } = fakeFetch(() => toolResponse({ action: 'raise', amount: 60, reason: 'value' }));
    const { policy, metrics } = makePolicy({ fetch });
    const decision = await policy.decide(makeView());

    expect(decision.action).toEqual({ type: 'raise', amount: 60 });
    expect(decision.reason).toBe('value');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(types(metrics)).toEqual(
      expect.arrayContaining(['llm_calls', 'latency', 'tokens', 'cost', 'model_action_legal']),
    );
    expect(metrics.find((m) => m.type === 'model_action_legal')?.legal).toBe(true);
    // A successful model action must not go through the fallback.
    expect(types(metrics)).not.toContain('llm_fallbacks');
    expect(types(metrics)).not.toContain('fallback_action_legal');
  });

  it('parses a bare JSON content response when there is no tool call', async () => {
    const { fetch } = fakeFetch(() =>
      contentResponse(JSON.stringify({ action: 'call', reason: 'ok' })),
    );
    const { policy } = makePolicy({ fetch });
    expect((await policy.decide(makeView())).action).toEqual({ type: 'call' });
  });

  it('does not parse markdown-fenced or prose content', async () => {
    const { fetch } = fakeFetch(() => contentResponse('```json\n{"action":"call"}\n```'));
    const { policy, metrics } = makePolicy({ fetch });
    const decision = await policy.decide(makeView());
    expect(decision.action).toEqual({ type: 'call' }); // the fallback, not the model
    expect(metrics.find((m) => m.type === 'llm_fallbacks')?.reason).toBe('parse');
  });

  it('falls back on a timeout and records it', async () => {
    const { fetch } = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          (init.signal as AbortSignal).addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    const { policy, metrics } = makePolicy({ fetch, timeoutMs: 5 });
    const decision = await policy.decide(makeView());
    expect(decision.action).toEqual({ type: 'call' });
    expect(metrics.find((m) => m.type === 'llm_fallbacks')?.reason).toBe('timeout');
  });

  it('falls back on a non-2xx response', async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: 'nope' }, 503));
    const { policy, metrics } = makePolicy({ fetch });
    expect((await policy.decide(makeView())).action).toEqual({ type: 'call' });
    expect(metrics.find((m) => m.type === 'llm_fallbacks')?.reason).toBe('http');
  });

  it('falls back when the body is not JSON', async () => {
    const { fetch } = fakeFetch(() => contentResponse('definitely not json'));
    const { policy, metrics } = makePolicy({ fetch });
    expect((await policy.decide(makeView())).action).toEqual({ type: 'call' });
    expect(metrics.find((m) => m.type === 'llm_fallbacks')?.reason).toBe('parse');
  });

  it('falls back on a schema violation (bet without an integer amount)', async () => {
    const { fetch } = fakeFetch(() => toolResponse({ action: 'bet' }));
    const { policy, metrics } = makePolicy({ fetch });
    expect((await policy.decide(makeView())).action).toEqual({ type: 'call' });
    expect(metrics.find((m) => m.type === 'llm_fallbacks')?.reason).toBe('parse');
  });

  it('rejects a missing or blank reason as a parse failure', async () => {
    const missing = makePolicy({ fetch: fakeFetch(() => toolResponse({ action: 'call' })).fetch });
    expect((await missing.policy.decide(makeView())).action).toEqual({ type: 'call' });
    expect(missing.metrics.find((m) => m.type === 'llm_fallbacks')?.reason).toBe('parse');

    const blank = makePolicy({
      fetch: fakeFetch(() => toolResponse({ action: 'call', reason: '   ' })).fetch,
    });
    expect((await blank.policy.decide(makeView())).action).toEqual({ type: 'call' });
    expect(blank.metrics.find((m) => m.type === 'llm_fallbacks')?.reason).toBe('parse');
  });

  it('advertises reason as a required tool field', async () => {
    const { fetch, fn } = fakeFetch(() => toolResponse({ action: 'call', reason: 'ok' }));
    const { policy } = makePolicy({ fetch });
    await policy.decide(makeView());
    const body = JSON.parse(String((fn.mock.calls[0]![1] as RequestInit).body)) as {
      tools: {
        function: { parameters: { required: string[]; properties: Record<string, unknown> } };
      }[];
    };
    const schema = body.tools[0]!.function.parameters;
    expect(schema.required).toEqual(expect.arrayContaining(['action', 'reason']));
    expect(Object.keys(schema.properties)).toContain('reason');
  });

  it('falls back on an illegal action and an out-of-range amount', async () => {
    const below = makePolicy({
      fetch: fakeFetch(() => toolResponse({ action: 'raise', amount: 5, reason: 'too small' })).fetch,
    });
    expect((await below.policy.decide(makeView())).action).toEqual({ type: 'call' });
    expect(below.metrics.find((m) => m.type === 'model_action_legal')?.legal).toBe(false);
    expect(below.metrics.find((m) => m.type === 'llm_fallbacks')?.reason).toBe('illegal');

    const above = makePolicy({
      fetch: fakeFetch(() => toolResponse({ action: 'raise', amount: 9_999, reason: 'too big' })).fetch,
    });
    expect((await above.policy.decide(makeView())).action).toEqual({ type: 'call' });
    expect(above.metrics.find((m) => m.type === 'llm_fallbacks')?.reason).toBe('illegal');
  });

  it('stops requesting the model once maxCallsPerHand is reached', async () => {
    const { fetch, fn } = fakeFetch(() => toolResponse({ action: 'raise', amount: 60, reason: 'value' }));
    const { policy, metrics } = makePolicy({ fetch, maxCallsPerHand: 2 });
    const view = makeView();

    expect((await policy.decide(view)).action).toEqual({ type: 'raise', amount: 60 });
    expect((await policy.decide(view)).action).toEqual({ type: 'raise', amount: 60 });
    expect((await policy.decide(view)).action).toEqual({ type: 'call' });

    expect(fn).toHaveBeenCalledTimes(2);
    expect(metrics.filter((m) => m.type === 'llm_calls')).toHaveLength(2);
    expect(metrics.find((m) => m.type === 'llm_fallbacks')?.reason).toBe('budget');
  });

  it('resets the per-hand budget when the hand changes', async () => {
    const { fetch, fn } = fakeFetch(() => toolResponse({ action: 'call', reason: 'ok' }));
    const { policy } = makePolicy({ fetch, maxCallsPerHand: 1 });
    await policy.decide(makeView());
    await policy.decide(makeView({ hand: { ...makeView().hand!, handId: 'h2' } }));
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('never calls the model when the API key is missing and never errors', async () => {
    const { fetch, fn } = fakeFetch(() => toolResponse({ action: 'raise', amount: 60, reason: 'value' }));
    const { policy, metrics } = makePolicy({ fetch, apiKey: '' });
    const decision = await policy.decide(makeView());
    expect(decision.action).toEqual({ type: 'call' });
    expect(fn).not.toHaveBeenCalled();
    expect(metrics.find((m) => m.type === 'llm_fallbacks')?.reason).toBe('disabled');
    expect(metrics.find((m) => m.type === 'fallback_action_legal')?.legal).toBe(true);
  });

  it('skips the request when the deadline is too close', async () => {
    const { fetch, fn } = fakeFetch(() => toolResponse({ action: 'raise', amount: 60, reason: 'value' }));
    const { policy, metrics } = makePolicy({ fetch });
    const view = makeView();
    view.hand!.deadline = Date.now() + 100; // < DEADLINE_MARGIN_MS
    expect((await policy.decide(view)).action).toEqual({ type: 'call' });
    expect(fn).not.toHaveBeenCalled();
    expect(types(metrics)).toContain('deadline_skips');
  });

  it('proactively degrades below the minimum model budget without firing a request', async () => {
    const { fetch, fn } = fakeFetch(() => toolResponse({ action: 'raise', amount: 60, reason: 'value' }));
    const { policy, metrics } = makePolicy({ fetch }); // default budget 6s
    const view = makeView();
    view.hand!.deadline = Date.now() + 4_000; // a 5s room: below the budget
    const decision = await policy.decide(view);
    expect(decision.action).toEqual({ type: 'call' }); // local fallback, not the raise
    expect(decision.source).toBe('fallback');
    expect(fn).not.toHaveBeenCalled();
    // It is a *skip*, not a request timeout: no call, no request-timeout fallback.
    expect(metrics.filter((m) => m.type === 'llm_calls')).toHaveLength(0);
    expect(types(metrics)).not.toContain('llm_fallbacks');
    const skip = metrics.find((m) => m.type === 'deadline_skips')!;
    expect(skip.remainingMs).toBeGreaterThan(0);
    expect(skip.minBudgetMs).toBe(6_000);
  });

  it('still calls the model when the remaining clock exceeds the budget', async () => {
    const { fetch, fn } = fakeFetch(() => toolResponse({ action: 'raise', amount: 60, reason: 'value' }));
    const { policy, metrics } = makePolicy({ fetch });
    const view = makeView();
    view.hand!.deadline = Date.now() + 10_000; // a 10s room: above the budget
    expect((await policy.decide(view)).action).toEqual({ type: 'raise', amount: 60 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(types(metrics)).not.toContain('deadline_skips');
  });

  it('a zero minimum budget disables proactive degradation', async () => {
    const { fetch, fn } = fakeFetch(() => toolResponse({ action: 'raise', amount: 60, reason: 'value' }));
    const { policy } = makePolicy({ fetch, minModelBudgetMs: 0 });
    const view = makeView();
    view.hand!.deadline = Date.now() + 2_000; // below 6s but the check is off
    expect((await policy.decide(view)).action).toEqual({ type: 'raise', amount: 60 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('shadow mode observes the model but executes the local action', async () => {
    const { fetch, fn } = fakeFetch(() => toolResponse({ action: 'raise', amount: 60, reason: 'value' }));
    const { policy, metrics } = makePolicy({ fetch, shadow: true });
    const decision = await policy.decide(makeView());
    expect(decision.action).toEqual({ type: 'call' }); // local, not the model raise
    expect(fn).toHaveBeenCalledTimes(1);
    expect(metrics.find((m) => m.type === 'model_action_legal')?.legal).toBe(true);
    expect(metrics.find((m) => m.type === 'fallback_action_legal')?.legal).toBe(true);
    // Shadow must never claim the model was executed, even when the model legal.
    expect(decision.source).toBe('fallback');
  });

  it('tags the executed source: model only for a returned model action, fallback otherwise', async () => {
    const model = makePolicy({
      fetch: fakeFetch(() => toolResponse({ action: 'raise', amount: 60, reason: 'value' })).fetch,
    });
    expect((await model.policy.decide(makeView())).source).toBe('model');

    const disabled = makePolicy({ apiKey: '' });
    expect((await disabled.policy.decide(makeView())).source).toBe('fallback');

    const illegal = makePolicy({
      fetch: fakeFetch(() => toolResponse({ action: 'raise', amount: 1, reason: 'tiny' })).fetch,
    });
    expect((await illegal.policy.decide(makeView())).source).toBe('fallback');
  });

  it('records exactly one latency sample per request, after the body, with finish_reason', async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              tool_calls: [
                {
                  id: '1',
                  type: 'function',
                  function: {
                    name: 'choose_poker_action',
                    arguments: JSON.stringify({ action: 'call', reason: 'ok' }),
                  },
                },
              ],
            },
          },
        ],
        usage: USAGE,
      }),
    );
    const { policy, metrics } = makePolicy({ fetch });
    await policy.decide(makeView());
    const latencies = metrics.filter((m) => m.type === 'latency');
    expect(latencies).toHaveLength(1);
    expect(latencies[0]!.finishReason).toBe('tool_calls');
  });

  it('classifies a corrupt response body as parse_body and still samples latency once', async () => {
    const { fetch } = fakeFetch(
      () => new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const { policy, metrics } = makePolicy({ fetch });
    expect((await policy.decide(makeView())).action).toEqual({ type: 'call' });
    expect(metrics.find((m) => m.type === 'llm_fallbacks')?.reason).toBe('parse_body');
    const latencies = metrics.filter((m) => m.type === 'latency');
    expect(latencies).toHaveLength(1);
    expect(latencies[0]!.outcome).toBe('parse_body');
  });

  it('classifies an abort while reading the body as a timeout, not a corrupt body', async () => {
    const { fetch } = fakeFetch((_url, init) => {
      const signal = init.signal as AbortSignal;
      const res = {
        ok: true,
        json: () =>
          new Promise<unknown>((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              const err = new Error('aborted mid-body');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      };
      return Promise.resolve(res as unknown as Response);
    });
    const { policy, metrics } = makePolicy({ fetch, timeoutMs: 10 });
    expect((await policy.decide(makeView())).action).toEqual({ type: 'call' });
    expect(metrics.find((m) => m.type === 'llm_fallbacks')?.reason).toBe('timeout');
    const latencies = metrics.filter((m) => m.type === 'latency');
    expect(latencies).toHaveLength(1);
    expect(latencies[0]!.outcome).toBe('timeout');
  });

  it('drains a non-2xx body and samples latency once with an http outcome', async () => {
    const text = vi.fn(async () => 'upstream exploded');
    const { fetch } = fakeFetch(() => ({ ok: false, status: 503, text }) as unknown as Response);
    const { policy, metrics } = makePolicy({ fetch });
    expect((await policy.decide(makeView())).action).toEqual({ type: 'call' });
    expect(metrics.find((m) => m.type === 'llm_fallbacks')?.reason).toBe('http');
    expect(text).toHaveBeenCalledTimes(1);
    const latencies = metrics.filter((m) => m.type === 'latency');
    expect(latencies).toHaveLength(1);
    expect(latencies[0]!.outcome).toBe('http');
  });

  it('classifies an abort while draining a non-2xx body as a timeout', async () => {
    const { fetch } = fakeFetch((_url, init) => {
      const signal = init.signal as AbortSignal;
      const res = {
        ok: false,
        status: 503,
        text: () =>
          new Promise<string>((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              const err = new Error('aborted mid-error-body');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      };
      return Promise.resolve(res as unknown as Response);
    });
    const { policy, metrics } = makePolicy({ fetch, timeoutMs: 10 });
    expect((await policy.decide(makeView())).action).toEqual({ type: 'call' });
    expect(metrics.find((m) => m.type === 'llm_fallbacks')?.reason).toBe('timeout');
    const latencies = metrics.filter((m) => m.type === 'latency');
    expect(latencies).toHaveLength(1);
    expect(latencies[0]!.outcome).toBe('timeout');
  });

  it('stamps a successful request latency with outcome ok', async () => {
    const { fetch } = fakeFetch(() => toolResponse({ action: 'call', reason: 'ok' }));
    const { policy, metrics } = makePolicy({ fetch });
    await policy.decide(makeView());
    const latency = metrics.find((m) => m.type === 'latency')!;
    expect(latency.outcome).toBe('ok');
  });

  it('reports the action-parse subclass (tool call vs bare content)', async () => {
    const tool = makePolicy({
      fetch: fakeFetch(() => toolResponse({ action: 'bet', reason: 'no amount' })).fetch,
    });
    await tool.policy.decide(makeView());
    expect(tool.metrics.find((m) => m.type === 'llm_fallbacks')?.reason).toBe('parse');
    expect(tool.metrics.find((m) => m.type === 'llm_fallbacks')?.parseStage).toBe('tool');

    const content = makePolicy({
      fetch: fakeFetch(() => contentResponse(JSON.stringify({ action: 'bet', reason: 'no amount' }))).fetch,
    });
    await content.policy.decide(makeView());
    expect(content.metrics.find((m) => m.type === 'llm_fallbacks')?.reason).toBe('parse');
    expect(content.metrics.find((m) => m.type === 'llm_fallbacks')?.parseStage).toBe('content');
  });

  it('flags a missing usage block without losing the tokens metric', async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ choices: [{ message: { content: '{}' } }] }));
    const { policy, metrics } = makePolicy({ fetch });
    await policy.decide(makeView());
    const tokens = metrics.find((m) => m.type === 'tokens');
    expect(tokens).toBeDefined();
    expect(tokens!.usageMissing).toBe(true);
    // A missing usage block still yields exactly one latency sample.
    expect(metrics.filter((m) => m.type === 'latency')).toHaveLength(1);
  });

  it('always returns a legal fallback action across every fallback branch', async () => {
    const branches = [
      makePolicy({ fetch: fakeFetch(() => jsonResponse({}, 500)).fetch }),
      makePolicy({ fetch: fakeFetch(() => contentResponse('nope')).fetch }),
      makePolicy({ fetch: fakeFetch(() => toolResponse({ action: 'raise', amount: 1, reason: 'tiny' })).fetch }),
      makePolicy({ apiKey: '' }),
    ];
    for (const { policy } of branches) {
      const view = makeView();
      const decision = await policy.decide(view);
      expect(isLegalAction(view, decision.action)).toBe(true);
    }
  });

  it('catches a throwing metric sink without breaking the decision', async () => {
    const { fetch } = fakeFetch(() => toolResponse({ action: 'call', reason: 'ok' }));
    const { policy } = makePolicy({
      fetch,
      onMetric: () => {
        throw new Error('sink exploded');
      },
    });
    expect((await policy.decide(makeView())).action).toEqual({ type: 'call' });
  });

  it('defaults max_tokens high enough for reasoning + a tool call', async () => {
    const { fetch, fn } = fakeFetch(() => toolResponse({ action: 'call', reason: 'ok' }));
    const { policy } = makePolicy({ fetch });
    await policy.decide(makeView());
    const body = JSON.parse(String((fn.mock.calls[0]![1] as RequestInit).body)) as {
      max_tokens: number;
    };
    // A 160-token cap is eaten by `reasoning_content` and truncates the tool JSON.
    expect(body.max_tokens).toBe(2_048);
  });

  it('builds a compact prompt without identity, room secrets or key material', async () => {
    const { fetch, fn } = fakeFetch(() => toolResponse({ action: 'call', reason: 'ok' }));
    const { policy } = makePolicy({ fetch });
    await policy.decide(makeView());

    const init = fn.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      messages: { role: string; content: string }[];
      max_tokens: number;
    };
    const text = body.messages.map((m) => m.content).join('\n');
    const user = body.messages.find((m) => m.role === 'user')!.content;
    const payload = JSON.parse(user) as Record<string, unknown>;

    // Required fields are present.
    for (const field of [
      'street',
      'board',
      'pot',
      'currentBet',
      'mySeat',
      'buttonSeat',
      'rules',
      'msRemaining',
      'self',
      'opponents',
      'legal',
      'potOdds',
      'recentActions',
      'historyComplete',
      'sessionMemory',
    ]) {
      expect(payload).toHaveProperty(field);
    }
    expect((payload.self as Record<string, unknown>).cards).toContain('Ah');
    expect(body.max_tokens).toBe(2_048);

    // Newly surfaced public information.
    expect(payload.mySeat).toBe(0);
    expect(payload.buttonSeat).toBe(0);
    expect(payload.rules).toEqual({ sb: 10, bb: 20, sevenDeuceBonus: 0 });
    expect((payload.opponents as { total: number }[])[0]!.total).toBe(20);
    expect((payload.legal as { canCall: boolean }).canCall).toBe(true);
    // potOdds is a single break-even number, not a redundant object.
    expect(typeof payload.potOdds).toBe('number');
    expect(text).toContain('sevenDeuceBonus');

    // History completeness + bounded session memory are surfaced faithfully.
    expect(payload.historyComplete).toBe(true);
    const sm = payload.sessionMemory as {
      recentHands: { myDelta: number; historyComplete: boolean }[];
      opponents: { sampleHands: number; vpipHands: number; pfrHands: number }[];
    };
    expect(sm.recentHands).toEqual([
      { myDelta: -15, endedStreet: 'flop', showdown: false, historyComplete: true },
    ]);
    expect(sm.opponents[0]).toMatchObject({ sampleHands: 3, vpipHands: 2, pfrHands: 1 });
    // No raw userId leaks into the prompt (only seat-labelled summaries).
    expect(text).not.toContain('7777');

    // Forbidden material never appears.
    for (const forbidden of [
      'SneakyBot',
      '4242',
      'VillainName',
      '7777',
      'Secret Room',
      'room-secret-id',
      'ZZZ999',
      'sk-secret',
      'authorization',
      'myCardPoints',
      'handKeys',
    ]) {
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    // The absolute-amount rule is spelled out for the model.
    expect(text).toContain('ABSOLUTE');
  });

  it('serializes an unknown session-memory delta as null, not zero', async () => {
    const { fetch, fn } = fakeFetch(() => toolResponse({ action: 'call', reason: 'ok' }));
    const { policy } = makePolicy({ fetch });
    await policy.decide(
      makeView({
        sessionMemory: {
          handsObserved: 2,
          netChips: null,
          recentHands: [
            { myDelta: null, endedStreet: 'turn', showdown: false, historyComplete: true },
            { myDelta: 0, endedStreet: 'preflop', showdown: false, historyComplete: true },
          ],
          opponents: [],
        },
      }),
    );
    const init = fn.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      messages: { role: string; content: string }[];
    };
    const user = body.messages.find((m) => m.role === 'user')!.content;
    const payload = JSON.parse(user) as {
      sessionMemory: { recentHands: { myDelta: number | null }[] };
    };
    // Unknown stays null; an exactly-zero result stays 0 - never conflated.
    expect(payload.sessionMemory.recentHands.map((h) => h.myDelta)).toEqual([null, 0]);
  });

  it('emits complete, non-sensitive metrics', async () => {
    const { fetch } = fakeFetch(() => toolResponse({ action: 'call', reason: 'ok' }));
    const { policy, metrics } = makePolicy({ fetch });
    await policy.decide(makeView());

    expect(types(metrics)).toEqual(
      expect.arrayContaining(['llm_calls', 'latency', 'tokens', 'cost', 'model_action_legal']),
    );
    const tokens = metrics.find((m) => m.type === 'tokens')!;
    expect(tokens.promptTokens).toBe(100);
    expect(tokens.completionTokens).toBe(12);
    const cost = metrics.find((m) => m.type === 'cost')!;
    expect(cost.estimatedUsd).toBeGreaterThan(0);
    expect(cost.pricingBasis).toBe('fixed-estimate');
    const latency = metrics.find((m) => m.type === 'latency')!;
    expect(latency.ms).toBeGreaterThanOrEqual(0);

    const serialized = JSON.stringify(metrics).toLowerCase();
    for (const forbidden of ['sk-secret', 'authorization', 'sneakybot', '4242']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
