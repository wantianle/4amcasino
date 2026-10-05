import { cardName, type PlayerAction } from '@4am/shared';
import type { DecisionView } from './decisionView.js';
import { MAX_OPPONENTS, MAX_RECENT_HANDS } from './sessionMemory.js';
import type { Policy, PolicyDecision } from './policy.js';

/**
 * Phase 3: an LLM-backed policy.
 *
 * This is deliberately the *only* place that talks to a model. It builds a
 * compact prompt from the same `DecisionView` every other policy consumes (so
 * it can never see more than the public protocol plus its own hole cards),
 * makes a single bounded OpenAI-compatible `/chat/completions` request with the
 * native `fetch`, validates the returned action against the *current* legal
 * actions, and otherwise falls back to a local policy. Every failure mode is
 * swallowed here and counted as a structured metric - it must never bubble up
 * to `BotRunner.fail()`.
 *
 * Contract with the runner:
 *   - `decide()` is only called when `view.legalActions` is non-null;
 *   - a returned action is always legal for the view that produced it;
 *   - the only way `decide()` rejects is when the *local fallback itself* throws,
 *     which is the existing fatal path.
 */

export type LlmFallbackReason =
  | 'disabled'
  | 'timeout'
  | 'http'
  /** The response body itself was not readable/parseable JSON. */
  | 'parse_body'
  /** The body parsed but no valid action could be read out of it. */
  | 'parse'
  | 'illegal'
  | 'budget';

export type LlmMetricType =
  | 'llm_calls'
  | 'llm_fallbacks'
  | 'latency'
  | 'tokens'
  | 'cost'
  | 'deadline_skips'
  | 'model_action_legal'
  | 'fallback_action_legal';

/**
 * A structured, non-sensitive metric event. It carries only counts, booleans
 * and locally computed numbers - never the prompt, the API key, the model's raw
 * output, or any private game state.
 */
export interface LlmMetric {
  type: LlmMetricType;
  /** Only for `llm_fallbacks`. */
  reason?: LlmFallbackReason;
  /** Only for `latency`: round-trip milliseconds (recorded once per request). */
  ms?: number;
  /** Only for `latency`: the provider's `choices[0].finish_reason`, when read. */
  finishReason?: string;
  /**
   * Only for `latency`: the final outcome of the whole request. `timeout`
   * samples are censored at the configured timeout and must not be read as the
   * provider's true latency tail.
   */
  outcome?: 'ok' | 'http' | 'timeout' | 'parse_body';
  /** Only for `tokens`. */
  promptTokens?: number;
  completionTokens?: number;
  /** Only for `tokens`: true when the response carried no usable usage block. */
  usageMissing?: boolean;
  /** Only for `llm_fallbacks` with `reason: 'parse'`: which parse stage failed. */
  parseStage?: 'tool' | 'content';
  /** Only for `deadline_skips`: action clock left when the request was skipped. */
  remainingMs?: number;
  /** Only for `deadline_skips`: the minimum budget a request requires. */
  minBudgetMs?: number;
  /** Only for `cost`: estimated USD, for observability only. NOT billing. */
  estimatedUsd?: number;
  /** Only for `cost`: the estimate is a fixed list-price constant, not a bill. */
  pricingBasis?: 'fixed-estimate';
  /** Only for `model_action_legal` / `fallback_action_legal`. */
  legal?: boolean;
}

export interface LlmPolicyOptions {
  /** Provider key. Empty string means the policy is disabled and always falls back. */
  apiKey: string;
  /** OpenAI-compatible base URL, e.g. `https://host/v1`. */
  baseUrl: string;
  model: string;
  /** Upper bound on one request; further clamped by the action deadline. */
  timeoutMs: number;
  /** Hard cap on model requests per hand. */
  maxCallsPerHand: number;
  /** Output token cap. Default 2048 (room for hidden reasoning + a tool call). */
  maxOutputTokens?: number;
  /**
   * Minimum action-clock budget (ms) a request must have left before the model
   * is consulted at all. Below it the policy degrades straight to the local
   * fallback instead of firing a request that would mostly time out on a short
   * clock. Default `DEFAULT_LLM_MIN_MODEL_BUDGET_MS`; `0` disables the check.
   */
  minModelBudgetMs?: number;
  /** Local policy used whenever the model cannot be consulted or trusted. */
  fallback: Policy;
  /** Injection seam for tests; defaults to the native `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Structured, non-sensitive metric sink. */
  onMetric?: (event: LlmMetric) => void;
  /** Shadow: still request + measure, but always execute the local fallback. */
  shadow?: boolean;
}

interface ModelChoice {
  action: PlayerAction['type'];
  amount?: number;
  /** Required, non-empty: `normalizeChoice` rejects a missing/blank reason. */
  reason: string;
}

/** The single HTTP call's outcome, shared by `request()` and its caller. */
type RequestOutcome =
  | { ok: true; json: unknown; finishReason?: string }
  | { ok: false; reason: 'timeout' | 'http' | 'parse_body'; finishReason?: string };

/**
 * Output token cap when the caller does not set one. Models that stream hidden
 * reasoning (e.g. deepseek-flash's `reasoning_content`) count those tokens
 * against `max_tokens` *before* the tool call, so a small cap truncates the
 * action JSON into an unparseable string and forces a fallback on every call.
 * 2048 leaves room for the reasoning plus a complete tool call; the server
 * resolver sets the same default (and `LLM_MAX_OUTPUT_TOKENS` can override it).
 */
export const DEFAULT_LLM_MAX_OUTPUT_TOKENS = 2_048;
/**
 * Minimum action-clock budget (ms) required before the model is consulted at
 * all. Derivation from live deepseek-flash numbers (12-hand runs):
 *   - successful round-trip p50 ~4.4s, p95 ~11s; the configured request timeout
 *     is 12s.
 *   - the local fallback (a 32-sample StylePolicy) and the send/scheduling path
 *     need roughly 1s of head-room in the worst case.
 *   - plus the policy's own `DEADLINE_MARGIN_MS` (300ms) and the runner's
 *     `DEADLINE_GUARD_MS` (200ms).
 * `ceil(4.4s + 1.0s + 0.3s + 0.2s)` rounds to 6s: below that a request would
 * mostly be cut off anyway. Rooms with a 5s action clock therefore degrade
 * straight to the local action instead of racing the deadline, while a 10s+
 * clock still uses the model. Override with `LLM_MIN_BUDGET_MS`; `0` disables.
 */
export const DEFAULT_LLM_MIN_MODEL_BUDGET_MS = 6_000;
/** Keep this much of the action clock in reserve before even trying a request. */
const DEADLINE_MARGIN_MS = 300;
/** Public actions included in the prompt (oldest of the tail, most recent). */
const MAX_ACTIONS_IN_PROMPT = 40;
const MAX_REASON_LEN = 160;
const TOOL_NAME = 'choose_poker_action';

/**
 * Rough list-price estimate, used only for the `cost` metric. It is never used
 * for billing and no one should reconcile it against a provider invoice.
 */
const PROMPT_USD_PER_TOKEN = 0.00000027;
const COMPLETION_USD_PER_TOKEN = 0.0000011;

const SYSTEM_PROMPT = [
  'You are a bot playing Texas Hold\'em at a poker table. Choose exactly one action.',
  'Rules for your reply:',
  '- Call the choose_poker_action function with a single action from: fold, check, call, bet, raise.',
  '- `amount` is the ABSOLUTE total "raise-to"/"bet-to" for the current street, NOT the increment on top of the current bet.',
  '- Only choose an action the provided `legal` flags allow; bet/raise amounts must lie within [minRaiseTo, maxRaiseTo].',
  '- check/call/fold take no amount; bet/raise require an integer amount.',
  '- `mySeat` is your own seat and `buttonSeat` is the dealer button; seats in `recentActions` and `opponents` use the same numbering.',
  '- `rules` holds the blinds and any bounty (e.g. `sevenDeuceBonus` is paid to a player who wins a hand with 7-2 offsuit).',
  '- Each opponent\'s `total` is the chips they have committed this whole hand (side-pot basis); use it, not a single stack-to-pot ratio, to judge all-ins.',
  '- `historyComplete` is false when this hand had a disconnect gap: treat the action history as partial and do NOT read missing actions as checking/folding.',
  '- `sessionMemory.recentHands` (<= 8) are your recent hand outcomes (myDelta, null when the outcome was not observed, plus endedStreet/showdown/historyComplete); `sessionMemory.opponents` are per-seat counts over each opponent\'s last complete hands (sampleHands/vpipHands/pfrHands/postflopBetsRaises/postflopCalls). Hands with historyComplete=false are excluded from those counts.',
  '- Keep `reason` to one short sentence (<= 160 characters).',
].join('\n');

const TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: TOOL_NAME,
    description: 'Choose one legal poker action.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['fold', 'check', 'call', 'bet', 'raise'],
        },
        amount: {
          type: 'integer',
          minimum: 0,
          description:
            'Absolute raise-to/bet-to total for this street. Required for bet/raise; omitted otherwise.',
        },
        reason: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_REASON_LEN,
          description: 'Required, short justification (one sentence, <= 160 characters).',
        },
      },
      required: ['action', 'reason'],
    },
  },
} as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isAbortError(err: unknown): boolean {
  const name = asRecord(err)?.name ?? (err instanceof Error ? err.name : undefined);
  return name === 'AbortError' || name === 'TimeoutError';
}

export class LlmPolicy implements Policy {
  readonly name = 'llm-deepseek-flash';

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxCallsPerHand: number;
  private readonly maxOutputTokens: number;
  private readonly minModelBudgetMs: number;
  private readonly fallback: Policy;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly onMetric: (event: LlmMetric) => void;
  private readonly shadow: boolean;

  /** Per-hand budget, reset whenever the hand changes. */
  private handId: string | null = null;
  private callsThisHand = 0;

  constructor(opts: LlmPolicyOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs;
    this.maxCallsPerHand = opts.maxCallsPerHand;
    this.maxOutputTokens = opts.maxOutputTokens ?? DEFAULT_LLM_MAX_OUTPUT_TOKENS;
    this.minModelBudgetMs = opts.minModelBudgetMs ?? DEFAULT_LLM_MIN_MODEL_BUDGET_MS;
    this.fallback = opts.fallback;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.onMetric = opts.onMetric ?? (() => {});
    this.shadow = opts.shadow ?? false;
  }

  async decide(view: DecisionView): Promise<PolicyDecision> {
    const la = view.legalActions;
    if (!la) throw new Error(`${this.name} asked to act out of turn`);

    const handId = view.hand?.handId ?? '';
    if (handId !== this.handId) {
      this.handId = handId;
      this.callsThisHand = 0;
    }

    // 1. No key configured: never touch the network, never error the bot.
    if (!this.apiKey) return this.localFallback(view, 'disabled');

    // 2. Not enough action clock left to make a model request worthwhile.
    //    Proactive degradation: on a short clock (e.g. a 5s room) a request
    //    would mostly time out and leave the action to the server's auto-fold,
    //    so we skip the network entirely and play the local fallback now. This
    //    is a *skip* (`deadline_skips`), deliberately distinct from a request
    //    that was actually sent and timed out (`llm_fallbacks` reason
    //    `timeout`).
    const remainingMs = this.remainingMs(view);
    if (remainingMs !== null && remainingMs < this.minModelBudgetMs) {
      this.emit({ type: 'deadline_skips', remainingMs, minBudgetMs: this.minModelBudgetMs });
      return this.localFallback(view);
    }
    const timeout = this.effectiveTimeout(view);
    if (timeout <= 0) {
      this.emit({
        type: 'deadline_skips',
        ...(remainingMs !== null ? { remainingMs } : {}),
        minBudgetMs: this.minModelBudgetMs,
      });
      return this.localFallback(view);
    }

    // 3. Per-hand request budget exhausted.
    if (this.callsThisHand >= this.maxCallsPerHand) return this.localFallback(view, 'budget');

    // 4. One bounded request.
    const response = await this.request(view, timeout);
    if (!response.ok) return this.localFallback(view, response.reason);

    // 5. tool_calls first, then a bare JSON content body. Nothing else parses.
    const parsed = this.parseChoice(response.json);
    if (!parsed.choice) return this.localFallback(view, 'parse', parsed.stage);

    // 6. Validate against the *current* legal actions.
    const legal = this.isLegal(view, parsed.choice);
    this.emit({ type: 'model_action_legal', legal });
    if (!legal) return this.localFallback(view, 'illegal');

    // Shadow: observe the model, execute the local decision.
    if (this.shadow) return this.localFallback(view);

    const choice = parsed.choice;
    const action: PlayerAction =
      choice.action === 'bet' || choice.action === 'raise'
        ? { type: choice.action, amount: choice.amount }
        : { type: choice.action };
    return { action, reason: choice.reason, source: 'model' };
  }

  /** Action-clock milliseconds left, or null when the hand is untimed. */
  private remainingMs(view: DecisionView): number | null {
    const deadline = view.hand?.deadline;
    return deadline === null || deadline === undefined ? null : deadline - Date.now();
  }

  /** `min(configured timeout, deadline - now - margin)`, or the configured value when untimed. */
  private effectiveTimeout(view: DecisionView): number {
    const deadline = view.hand?.deadline;
    if (deadline === null || deadline === undefined) return Math.max(0, this.timeoutMs);
    return Math.min(this.timeoutMs, deadline - Date.now() - DEADLINE_MARGIN_MS);
  }

  /**
   * One bounded HTTP call. Emits `llm_calls` immediately and exactly one
   * `latency` when the whole request has finished - including reading the
   * response body. A failure to read/parse that body is its own subclass
   * (`parse_body`), not lumped in with transport/HTTP errors.
   */
  private async request(view: DecisionView, timeout: number): Promise<RequestOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const startedAt = Date.now();
    this.callsThisHand++;
    this.emit({ type: 'llm_calls' });
    let outcome: RequestOutcome;
    try {
      const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(this.requestBody(view)),
        signal: controller.signal,
      });
      if (!res.ok) {
        // Consume the error body before sampling latency: the request is only
        // complete (and the socket only reusable) once the body is drained. An
        // abort while draining is the action clock expiring, i.e. a timeout -
        // not a plain HTTP failure.
        try {
          await res.text();
          outcome = { ok: false, reason: 'http' };
        } catch (err) {
          outcome = { ok: false, reason: isAbortError(err) ? 'timeout' : 'http' };
        }
      } else {
        try {
          const json: unknown = await res.json();
          const finishReason = this.finishReason(json);
          this.recordUsage(json);
          outcome = { ok: true, json, finishReason };
        } catch (err) {
          // An abort during the body read is a timeout, not a corrupt body: the
          // action clock ran out while the provider was still streaming.
          outcome = { ok: false, reason: isAbortError(err) ? 'timeout' : 'parse_body' };
        }
      }
    } catch (err) {
      outcome = { ok: false, reason: isAbortError(err) ? 'timeout' : 'http' };
    } finally {
      clearTimeout(timer);
    }
    // Exactly one sample per request, recorded after the body has settled, with
    // the final outcome so censored/successful latency can be separated.
    this.emit({
      type: 'latency',
      ms: Date.now() - startedAt,
      outcome: outcome.ok ? 'ok' : outcome.reason,
      ...(outcome.finishReason !== undefined ? { finishReason: outcome.finishReason } : {}),
    });
    return outcome;
  }

  /** `choices[0].finish_reason`, when the provider supplies it. */
  private finishReason(json: unknown): string | undefined {
    const choices = asRecord(json)?.choices;
    const choice = Array.isArray(choices) ? asRecord(choices[0]) : null;
    const finish = choice?.finish_reason;
    return typeof finish === 'string' ? finish : undefined;
  }

  private requestBody(view: DecisionView): Record<string, unknown> {
    return {
      model: this.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: this.buildPrompt(view) },
      ],
      temperature: 0,
      max_tokens: this.maxOutputTokens,
      tools: [TOOL_DEFINITION],
      // `"required"` is the most portable way to force the tool call across
      // OpenAI-compatible gateways; the object form
      // `{type:'function',function:{name}}` is rejected by the sub2api gateway
      // (live-verified), while standard OpenAI also accepts this string.
      tool_choice: 'required',
    };
  }

  /**
   * Compact JSON. Only the fields the bot is allowed to use are copied across,
   * and never identity (userId/displayName), room identifiers (id/name/join
   * code), tokens, keys, opponent hole cards, undealt cards or raw frames.
   */
  private buildPrompt(view: DecisionView): string {
    const h = view.hand;
    const room = view.room;
    const me = view.me;
    const la = view.legalActions;

    const recentActions = view.actionHistory.slice(-MAX_ACTIONS_IN_PROMPT).map((a) => {
      const item: Record<string, unknown> = {
        street: a.street,
        seat: a.seat,
        action: a.action.type,
        auto: a.auto,
      };
      if (a.action.amount !== undefined) item.amount = a.action.amount;
      return item;
    });

    return JSON.stringify({
      street: h?.street ?? null,
      board: (h?.board ?? []).map((c) => cardName(c)),
      pot: h?.pot ?? 0,
      currentBet: h?.currentBet ?? 0,
      mySeat: h?.mySeat ?? null,
      buttonSeat: h?.buttonSeat ?? null,
      // Room rules that change a decision. sb/bb set the price; sevenDeuceBonus
      // pays a 7-2 offsuit winner. Only real DecisionRoom fields, no identity.
      rules: room
        ? { sb: room.sb, bb: room.bb, sevenDeuceBonus: room.sevenDeuceBonus }
        : null,
      msRemaining: h?.deadline !== null && h?.deadline !== undefined ? Math.max(0, h.deadline - Date.now()) : null,
      self: {
        cards: (h?.myCards ?? []).map((c) => cardName(c)),
        stack: me?.stack ?? null,
        committed: me?.committed ?? null,
        total: me?.total ?? null,
      },
      opponents: view.opponents.map((o) => ({
        seat: o.seat,
        stack: o.stack,
        committed: o.committed,
        // Chips committed this whole hand: the side-pot basis, needed to judge
        // multi-way all-ins. No single stack-to-pot ratio is derived from it.
        total: o.total,
        folded: o.folded,
        allIn: o.allIn,
      })),
      legal: la
        ? {
            canCheck: la.canCheck,
            canCall: la.canCall,
            callAmount: la.callAmount,
            canBet: la.canBet,
            canRaise: la.canRaise,
            minRaiseTo: la.minRaiseTo,
            maxRaiseTo: la.maxRaiseTo,
          }
        : null,
      // A single break-even equity number; pot and callAmount are already above
      // (hand.pot / legal.callAmount), so the model can derive the rest.
      potOdds: view.potOdds ? view.potOdds.potOdds : null,
      recentActions,
      // False when this bot had a gap this hand; the model must not infer
      // silence from the (partial) history.
      historyComplete: view.historyComplete,
      sessionMemory: {
        handsObserved: view.sessionMemory.handsObserved,
        netChips: view.sessionMemory.netChips,
        recentHands: view.sessionMemory.recentHands.slice(-MAX_RECENT_HANDS),
        opponents: view.sessionMemory.opponents.slice(0, MAX_OPPONENTS),
      },
    });
  }

  /**
   * `tool_calls[].function.arguments` first, then a bare JSON `content` body.
   * `stage` names the branch that was attempted when no action was parsed, so a
   * parse failure can be reported by subclass (tool call vs bare content).
   */
  private parseChoice(json: unknown): {
    choice: ModelChoice | null;
    stage: 'tool' | 'content';
  } {
    const choices = asRecord(json)?.choices;
    const choice = Array.isArray(choices) && choices.length > 0 ? asRecord(choices[0]) : null;
    const message = asRecord(choice?.message);
    if (!message) return { choice: null, stage: 'content' };

    const fromTool = this.parseToolCalls(message.tool_calls);
    if (fromTool) return { choice: fromTool, stage: 'tool' };
    const fromContent = this.parseContent(message.content);
    if (fromContent) return { choice: fromContent, stage: 'content' };
    // Nothing parsed: report the branch that was actually present/attempted.
    const stage: 'tool' | 'content' =
      Array.isArray(message.tool_calls) && message.tool_calls.length > 0 ? 'tool' : 'content';
    return { choice: null, stage };
  }

  /** Shared "string JSON -> normalizeChoice" path used by both parse branches. */
  private parseJsonChoice(raw: string): ModelChoice | null {
    try {
      return this.normalizeChoice(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  private parseToolCalls(raw: unknown): ModelChoice | null {
    if (!Array.isArray(raw)) return null;
    for (const call of raw) {
      const fn = asRecord(asRecord(call)?.function);
      if (!fn || fn.name !== TOOL_NAME || typeof fn.arguments !== 'string') continue;
      return this.parseJsonChoice(fn.arguments);
    }
    return null;
  }

  private parseContent(content: unknown): ModelChoice | null {
    if (typeof content !== 'string') return null;
    const trimmed = content.trim();
    // Deliberately no markdown fence / prose / reasoning_content parsing.
    if (!trimmed.startsWith('{')) return null;
    return this.parseJsonChoice(trimmed);
  }

  private normalizeChoice(raw: unknown): ModelChoice | null {
    const obj = asRecord(raw);
    if (!obj) return null;
    const action = obj.action;
    if (
      action !== 'fold' &&
      action !== 'check' &&
      action !== 'call' &&
      action !== 'bet' &&
      action !== 'raise'
    )
      return null;
    let amount: number | undefined;
    if (action === 'bet' || action === 'raise') {
      if (typeof obj.amount !== 'number' || !Number.isInteger(obj.amount) || obj.amount < 0)
        return null;
      amount = obj.amount;
    }
    // `reason` is schema-required: a missing or blank justification is a parse
    // failure, not a silent default, so every accepted model action is auditable.
    if (typeof obj.reason !== 'string' || obj.reason.trim().length === 0) return null;
    const reason = obj.reason.slice(0, MAX_REASON_LEN);
    return { action, amount, reason };
  }

  /** Final authority: the action must satisfy the view's current `legalActions`. */
  private isLegal(view: DecisionView, choice: { action: string; amount?: number }): boolean {
    const la = view.legalActions;
    if (!la) return false;
    switch (choice.action) {
      case 'fold':
        return true;
      case 'check':
        return la.canCheck;
      case 'call':
        return la.canCall;
      // bet and raise share the same amount validation; only the enabling flag
      // differs. The fallback also runs through here, so the amount checks stay.
      case 'bet':
      case 'raise': {
        const enabled = choice.action === 'bet' ? la.canBet : la.canRaise;
        return (
          enabled &&
          typeof choice.amount === 'number' &&
          Number.isInteger(choice.amount) &&
          choice.amount >= la.minRaiseTo &&
          choice.amount <= la.maxRaiseTo
        );
      }
      default:
        return false;
    }
  }

  /**
   * Emit `tokens`/`cost` from the usage block. A `tokens` event is emitted even
   * when usage is absent, with `usageMissing: true`, so a silent provider can be
   * counted rather than looking like a request that never happened.
   */
  private recordUsage(json: unknown): void {
    const usage = asRecord(asRecord(json)?.usage);
    const promptTokens =
      usage && typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined;
    const completionTokens =
      usage && typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined;
    if (promptTokens === undefined && completionTokens === undefined) {
      this.emit({ type: 'tokens', usageMissing: true });
      return;
    }
    this.emit({ type: 'tokens', promptTokens, completionTokens, usageMissing: false });
    this.emit({
      type: 'cost',
      estimatedUsd:
        (promptTokens ?? 0) * PROMPT_USD_PER_TOKEN + (completionTokens ?? 0) * COMPLETION_USD_PER_TOKEN,
      pricingBasis: 'fixed-estimate',
    });
  }

  /**
   * Run the local fallback and record whether it was legal. This is the only
   * place errors are allowed out: a throwing fallback is the existing fatal.
   */
  private async localFallback(
    view: DecisionView,
    reason?: LlmFallbackReason,
    parseStage?: 'tool' | 'content',
  ): Promise<PolicyDecision> {
    if (reason) this.emit({ type: 'llm_fallbacks', reason, ...(parseStage ? { parseStage } : {}) });
    const decision = await this.fallback.decide(view);
    this.emit({
      type: 'fallback_action_legal',
      legal: this.isLegal(view, { action: decision.action.type, amount: decision.action.amount }),
    });
    // Tag the returned action so the runner/harness can attribute what was
    // actually executed, not merely what the model returned.
    return { ...decision, source: 'fallback' };
  }

  private emit(event: LlmMetric): void {
    try {
      this.onMetric(event);
    } catch {
      // A metric sink must never break a decision.
    }
  }
}
