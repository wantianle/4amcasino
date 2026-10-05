#!/usr/bin/env node
/**
 * Bot playtest harness (Node script, NOT vitest).
 *
 * Boots the real server in-process (temp DB, dynamic port, real WS), seats one
 * scripted "human" host plus N bots of configurable styles, plays many hands,
 * and writes a quantitative, persisted report. It reuses the exact boot /
 * assertion approach proven in `botE2E.test.ts` (real crypto, real ledger, no
 * stubs).
 *
 * Run:
 *   node --import tsx apps/server/test/botPlaytest.mjs
 *   HANDS=50 BOTS=5 SEED=7 node --import tsx apps/server/test/botPlaytest.mjs
 *   node --import tsx apps/server/test/botPlaytest.mjs --hands=10 --styles=tight-aggressive,calling-station
 *
 * Exits non-zero if any invariant fails (abort, ledger break, negative stack,
 * bot errored, missing transcript, illegal/no bot actions).
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { attachHub } from '../src/hub.js';
import { activeHands } from '../src/liveHands.js';
import { BotSupervisor } from '../src/botSupervisor.js';
import { BotRunner } from '../src/botRunner.js';
import {
  isLlmPolicyKind,
  llmOptionsFromEnv,
  resolveBotPolicyDetailed,
} from '../src/botPolicy.js';
import { HeadlessClient, buildDecisionView } from '@4am/agent-core';
import { humanLlmTookEffect, joinActionAttribution } from './helpers/actionAttribution.js';

// ---------------------------------------------------------------- config ----

function cliValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}
function cfg(name, fallback) {
  const raw = cliValue(name) ?? process.env[name.toUpperCase()];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
function cfgStr(name, fallback) {
  return cliValue(name) ?? process.env[name.toUpperCase()] ?? fallback;
}

const HANDS = Math.max(1, Math.floor(cfg('hands', 30)));
const SEED = Math.floor(cfg('seed', 1234));
const SB = Math.floor(cfg('sb', 10));
const BB = Math.floor(cfg('bb', 20));
// 200 big blinds: shallow enough that a legal min-raise war terminates in a
// bounded number of actions. Deep stacks (2500bb) let ScriptedPolicy's
// min-raise strategy grind thousands of actions in one preflop.
const BUYIN = Math.floor(cfg('buyin', 4000));
// A pathological hand (deep min-raise war) is failed by name, not as a timeout.
const MAX_HAND_ACTIONS = Math.floor(cfg('max_hand_actions', 600));
const STYLES = cfgStr(
  'styles',
  'tight-aggressive,loose-aggressive,calling-station,constrained-random',
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const BOTS = Math.max(1, Math.min(8, Math.floor(cfg('bots', STYLES.length))));
const HUMAN_STYLE = cfgStr('human_style', 'scripted');
// Kind matching mirrors the server's `isLlmPolicyKind()` (trim + lowercase), so
// `STYLES=LLM` or `HUMAN_STYLE=LLM` is treated as the `llm` policy too. Must be
// resolved before `ACTION_MS`: a live model needs a clock wide enough for a real
// round-trip (the plain 1.5s action clock is *smaller* than a ~1.2s model call,
// so every request used to time out).
const LLM_ENABLED = STYLES.some((s) => isLlmPolicyKind(s)) || isLlmPolicyKind(HUMAN_STYLE);
// Inject bounded session memory into each decision view (`LLM_MEMORY=off` for an
// on/off comparison; memory is only consumed by the LLM policy's prompt).
const MEMORY_ON = cfgStr('llm_memory', 'on').trim().toLowerCase() !== 'off';
const OUT_DIR = cfgStr('out', 'docs/qa/bot-playtest');
const CRYPTO_MS = Math.floor(cfg('crypto_ms', 1500));
// Live LLM runs get a 30s action clock (override via ACTION_MS); pure local
// styles keep the tight 1.5s clock that makes the harness fast.
const ACTION_MS = Math.floor(cfg('action_ms', LLM_ENABLED ? 30_000 : 1_500));
const READY_MS = Math.floor(cfg('ready_ms', 800));
// Generous per-hand budget: 5 players can each burn the action timeout on every
// street, so a legitimate slow hand can approach 4 * players * actionMs. LLM runs
// use a 30s action clock, so their settle budget grows to match.
const HAND_MS = Math.floor(cfg('hand_ms', LLM_ENABLED ? 600_000 : 90_000));
const KEY = cfgStr('bot_identity_key', 'ab'.repeat(32));
// The harness measures policy/ledger behaviour, not human timing: force the
// runner's think delay off (it is off under NODE_ENV=test too, but this is a
// plain node script). An empty value counts as unset (production would treat it
// as on), so `if (!...)` also normalises ''. Set BOT_THINK_ENABLED=1 to
// exercise the delay here.
if (!process.env.BOT_THINK_ENABLED) process.env.BOT_THINK_ENABLED = '0';

// ---------------------------------------------------------------- helpers ---

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(15);
  }
  throw new Error(`waitFor timed out: ${label ?? ''}`);
}

/** The shared engine's rules, mirrored for the harness's own legality guard. */
function isLegal(action, la) {
  switch (action.type) {
    case 'check':
      return la.canCheck;
    case 'call':
      return la.canCall;
    case 'bet':
      return (
        la.canBet && action.amount >= la.minRaiseTo && action.amount <= la.maxRaiseTo
      );
    case 'raise':
      return (
        la.canRaise && action.amount >= la.minRaiseTo && action.amount <= la.maxRaiseTo
      );
    case 'fold':
      return true;
    default:
      return false;
  }
}

function fallbackAction(la) {
  if (la.canCheck) return { type: 'check' };
  if (la.canCall) return { type: 'call' };
  return { type: 'fold' };
}

// -------------------------------------------------------------- LLM config ---

// Server env only (injected via `. .botenv`); never persisted or logged. Taken
// verbatim so a run exercises the *production* defaults (timeout, output cap)
// unless overridden with `LLM_TIMEOUT_MS` / `LLM_MAX_OUTPUT_TOKENS` (e.g.
// `LLM_TIMEOUT_MS=1` to force the fallback path).
const LLM_OPTIONS = llmOptionsFromEnv(process.env);
// What a run is expected to demonstrate: `model` (a live legal model action must
// appear), `fallback` (the fallback path must be reached, e.g. tiny timeout), or
// `off`. Defaults to `model` whenever an `llm` policy is selected. `off` only
// disables the expectation *assertion*; the model is still called when an `llm`
// policy is selected.
const LLM_EXPECT = cfgStr('llm_expect', LLM_ENABLED ? 'model' : 'off');
const LLM_EXPECT_VALUES = ['model', 'fallback', 'off'];

/** Every structured, non-sensitive LlmPolicy metric, tagged by its owner. */
const llmEvents = [];
/**
 * MEASUREMENT SEAM (opt-in, no default behaviour change).
 *
 * Per-request join of the per-request metric stream. The policy emits a fixed
 * order for one request: `llm_calls` -> `tokens`/`cost` -> `latency`, followed
 * by `llm_fallbacks`/`model_action_legal`. Events from different policies can
 * interleave, but one policy instance issues requests serially, so joining by
 * `tag` is exact. Written only when `LLM_PER_REQUEST_FILE` is set; otherwise
 * nothing is persisted and `llmEvents` behaves exactly as before.
 */
const perRequestByTag = new Map();
const perRequestRecords = [];
function flushPendingRequest(tag) {
  const pending = perRequestByTag.get(tag);
  if (!pending) return;
  perRequestByTag.delete(tag);
  perRequestRecords.push(pending);
}
function recordLlmMetric(tag, event) {
  llmEvents.push({ tag, event });
  if (event.type === 'deadline_skips') {
    perRequestRecords.push({
      tag,
      kind: 'deadline_skip',
      remainingMs: event.remainingMs,
      minBudgetMs: event.minBudgetMs,
    });
    return;
  }
  if (event.type === 'llm_calls') {
    // A prior request for this tag without a fallback is complete.
    flushPendingRequest(tag);
    perRequestByTag.set(tag, { tag, kind: 'request' });
    return;
  }
  const pending = perRequestByTag.get(tag);
  if (!pending) return;
  switch (event.type) {
    case 'tokens':
      pending.promptTokens = event.promptTokens;
      pending.completionTokens = event.completionTokens;
      pending.usageMissing = event.usageMissing;
      break;
    case 'cost':
      pending.estimatedUsd = event.estimatedUsd;
      break;
    case 'latency':
      pending.ms = event.ms;
      pending.outcome = event.outcome;
      pending.finishReason = event.finishReason;
      break;
    case 'llm_fallbacks':
      pending.fallbackReason = event.reason;
      pending.parseStage = event.parseStage;
      break;
    case 'model_action_legal':
      pending.modelLegal = event.legal;
      break;
    case 'fallback_action_legal':
      pending.fallbackLegal = event.legal;
      break;
    default:
      break;
  }
}
function flushAllRequests() {
  for (const tag of [...perRequestByTag.keys()]) flushPendingRequest(tag);
}

/**
 * Every decision the runners (and the human driver) actually routed, keyed by
 * turn. The server transcript is the authority on what was *accepted*; these
 * events say which accepted action came from the model vs the local fallback,
 * and which results were dropped as stale/deadline.
 */
const routedActions = [];
function recordRoutedAction(event) {
  routedActions.push(event);
}

/**
 * Single policy entry point for the whole harness: the server resolver builds
 * the four styles (via the new seed seam) and `llm` (from env config) alike, so
 * there is no second, drifting policy factory here.
 */
// A/B seam (harness-only, product request body untouched): `LLM_EXTRA_BODY` is
// a JSON object merged into every `/chat/completions` body via the policy's
// injected `fetch`. Used to test provider-specific knobs (e.g.
// `{"enable_thinking":false}`) without changing product code or defaults.
const EXTRA_BODY = (() => {
  const raw = process.env.LLM_EXTRA_BODY;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`LLM_EXTRA_BODY is not valid JSON: ${raw}`);
  }
})();
function withExtraBody(fetchImpl, extra) {
  return (url, init) => {
    if (init && typeof init.body === 'string') {
      try {
        const parsed = JSON.parse(init.body);
        init = { ...init, body: JSON.stringify({ ...parsed, ...extra }) };
      } catch {
        // leave the body untouched
      }
    }
    return fetchImpl(url, init);
  };
}
function makePolicy(kind, seed, tag) {
  const opts = { ...LLM_OPTIONS, onMetric: (event) => recordLlmMetric(tag, event) };
  if (EXTRA_BODY) opts.fetch = withExtraBody(LLM_OPTIONS.fetch ?? globalThis.fetch, EXTRA_BODY);
  return resolveBotPolicyDetailed(kind, null, opts, seed).policy;
}

function hashSeed(seed, text) {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
}

// ------------------------------------------------------- LLM metric summary ---

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** min/p50/p95/p99/max for a sorted sample. */
function latencyStats(sorted) {
  return {
    samples: sorted.length,
    min: sorted[0] ?? null,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? null,
  };
}

/** Roll up tagged `LlmPolicy` metric events: calls, fallbacks, latency, tokens, cost. */
function aggregateLlm(events) {
  const fallbacks = {
    disabled: 0,
    timeout: 0,
    http: 0,
    parse_body: 0,
    parse: 0,
    illegal: 0,
    budget: 0,
  };
  const latencies = [];
  const okLatencies = [];
  const outcomes = { ok: 0, http: 0, timeout: 0, parse_body: 0 };
  const finishReasons = {};
  const parseStages = { tool: 0, content: 0 };
  let calls = 0;
  let deadlineSkips = 0;
  let usageMissing = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let costUsd = 0;
  let modelLegalTrue = 0;
  let modelLegalFalse = 0;
  let fallbackLegalTrue = 0;
  let fallbackLegalFalse = 0;

  for (const { event } of events) {
    switch (event.type) {
      case 'llm_calls':
        calls++;
        break;
      case 'llm_fallbacks':
        if (fallbacks[event.reason] !== undefined) fallbacks[event.reason]++;
        if (event.reason === 'parse' && event.parseStage) {
          parseStages[event.parseStage] = (parseStages[event.parseStage] ?? 0) + 1;
        }
        break;
      case 'latency':
        if (typeof event.ms === 'number') {
          latencies.push(event.ms);
          // A `timeout` sample is censored at the configured timeout: it is a
          // lower bound on the true latency, not a measurement.
          if (event.outcome === 'ok') okLatencies.push(event.ms);
        }
        if (event.outcome && outcomes[event.outcome] !== undefined) outcomes[event.outcome]++;
        if (typeof event.finishReason === 'string')
          finishReasons[event.finishReason] = (finishReasons[event.finishReason] ?? 0) + 1;
        break;
      case 'tokens':
        if (event.usageMissing) usageMissing++;
        promptTokens += event.promptTokens ?? 0;
        completionTokens += event.completionTokens ?? 0;
        break;
      case 'cost':
        costUsd += event.estimatedUsd ?? 0;
        break;
      case 'deadline_skips':
        deadlineSkips++;
        break;
      case 'model_action_legal':
        if (event.legal) modelLegalTrue++;
        else modelLegalFalse++;
        break;
      case 'fallback_action_legal':
        if (event.legal) fallbackLegalTrue++;
        else fallbackLegalFalse++;
        break;
      default:
        break;
    }
  }

  const allSorted = [...latencies].sort((a, b) => a - b);
  const okSorted = [...okLatencies].sort((a, b) => a - b);
  return {
    calls,
    fallbacks,
    deadlineSkips,
    outcomes,
    latencyMs: {
      // `...all` (top-level) = every attempt, censored timeouts included.
      ...latencyStats(allSorted),
      successful: latencyStats(okSorted),
      censored: outcomes.timeout,
      timeoutRate: calls ? +(outcomes.timeout / calls).toFixed(3) : 0,
      note: 'successful = outcome ok only; all-attempt p95 is truncated by the configured request timeout (censored), so it is a lower bound, not the provider raw p95.',
    },
    tokens: { prompt: promptTokens, completion: completionTokens, total: promptTokens + completionTokens },
    cost: {
      estimatedUsd: +costUsd.toFixed(6),
      pricingBasis: 'fixed-estimate',
      note: 'fixed-estimate from LlmPolicy list-price constants; NOT billing',
    },
    finishReasons,
    usageMissing,
    parseStages,
    modelActionLegal: { true: modelLegalTrue, false: modelLegalFalse },
    fallbackActionLegal: { true: fallbackLegalTrue, false: fallbackLegalFalse },
  };
}

/** Per-owner and global summaries. */
function summarizeLlm(events) {
  const byTag = new Map();
  for (const { tag, event } of events) {
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag).push({ tag, event });
  }
  const byPolicy = {};
  for (const [tag, evts] of byTag) byPolicy[tag] = aggregateLlm(evts);
  return { global: aggregateLlm(events), byPolicy };
}

// ------------------------------------------------------------------- main ---

async function main() {
  // Reject a bad LLM_EXPECT instead of silently turning the gate off.
  if (!LLM_EXPECT_VALUES.includes(LLM_EXPECT))
    throw new Error(
      `LLM_EXPECT must be one of ${LLM_EXPECT_VALUES.join('|')}, got "${LLM_EXPECT}"`,
    );
  const startedAt = Date.now();
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-seed${SEED}-hands${HANDS}`;
  const dbPath = join(tmpdir(), `4am-playtest-${randomBytes(5).toString('hex')}.db`);
  process.env.BOT_IDENTITY_KEY = KEY;

  const ctx = createApp(dbPath);
  // Enable the engine's structured hand diagnostics when requested.
  if (process.env.PLAYTEST_DEBUG) {
    process.env.BOT_DEBUG = '1';
    process.env.BOT_DEBUG_FILE = process.env.BOT_DEBUG_FILE ?? '/tmp/opencode/hand-debug.log';
    rmSync(process.env.BOT_DEBUG_FILE, { force: true });
  }
  const hub = attachHub(ctx.app, ctx.db, {
    cryptoTimeoutMs: CRYPTO_MS,
    actionTimeoutMs: ACTION_MS,
    autoDealMs: 3_600_000, // harness starts every hand explicitly
    readyCheckMs: READY_MS,
  });
  const baseUrl = await ctx.app.listen({ host: '127.0.0.1', port: 0 });

  const supervisor = new BotSupervisor(ctx.db, {
    baseUrl,
    maxConcurrent: BOTS,
    runner: {
      graceMs: 8_000,
      pollMs: 15,
      settleMs: 200,
      memory: MEMORY_ON,
      onActionEvent: recordRoutedAction,
    },
    log: () => {},
    // Per-bot policy through the shared resolver, with a seed derived from
    // SEED + bot id for reproducible local styles (the resolver's seed seam).
    runnerFactory: (db, claim, opts) =>
      new BotRunner(db, claim, {
        ...opts,
        policy: makePolicy(
          claim.policyKind,
          hashSeed(SEED, claim.bot.id),
          `bot#${claim.bot.seat ?? '?'}:${claim.policyKind}`,
        ),
      }),
  });
  ctx.botControl.hooks = supervisor;

  const human = new HeadlessClient(baseUrl, `host_${randomBytes(3).toString('hex')}`, 'playtest');
  const humanPolicy = makePolicy(HUMAN_STYLE, SEED, `human:${HUMAN_STYLE}`);

  const botStatus = (botId) =>
    ctx.db.prepare('SELECT status FROM bot_accounts WHERE id = ?').get(botId)?.status ?? null;

  const checks = [];
  const fail = (name, detail) => checks.push({ name, ok: false, detail });
  const pass = (name, detail) => checks.push({ name, ok: true, detail });

  try {
    await human.login();
    const room = await human.api(
      '/api/rooms',
      { name: 'Playtest', sb: SB, bb: BB },
      'POST',
    );
    await human.connect(room.id);
    human.send({ t: 'sit', seat: 0 });
    const buy = await human.api(`/api/rooms/${room.id}/buy`, { amount: BUYIN });
    await human.api(`/api/rooms/${room.id}/approve`, { requestId: buy.id, approve: true });

    // Seat the bots through the real create API (host is banker -> auto-approved).
    const bots = [];
    for (let i = 0; i < BOTS; i++) {
      const kind = STYLES[i % STYLES.length];
      const created = await human.api(`/api/rooms/${room.id}/bots`, {
        seat: i + 1,
        initialBuyIn: BUYIN,
        policyKind: kind,
        name: `Bot${i + 1}`,
      });
      if (created.bot.status !== 'ready')
        throw new Error(`bot ${kind} created in state ${created.bot.status}`);
      bots.push({ id: created.bot.id, userId: created.bot.userId, seat: created.bot.seat, kind });
    }
    for (const b of bots) await human.api(`/api/rooms/${room.id}/bots/${b.id}/start`, {});
    await waitFor(
      () =>
        bots.every(
          (b) =>
            botStatus(b.id) === 'running' &&
            !!human.room?.players.find((p) => p.userId === b.userId && p.connected),
        ),
      20_000,
      'bots running + connected',
    );

    // seat -> metadata for attribution.
    const seatMeta = new Map();
    // Prefix the human row so it never collides with a bot style of the same name.
    seatMeta.set(0, { label: 'HUMAN', kind: `human:${HUMAN_STYLE}`, isBot: false });
    for (const b of bots) seatMeta.set(b.seat, { label: `Bot${b.seat}`, kind: b.kind, isBot: true });

    // Per-bot accounting straight from the signed transcript (accepted `action`
    // entries and server `action_rejected` entries), not just a global count.
    const perBot = new Map(
      bots.map((b) => [
        b.id,
        {
          id: b.id,
          kind: b.kind,
          seat: b.seat,
          userId: b.userId,
          handsParticipated: 0,
          acceptedActions: 0,
          rejectedActions: 0,
          rejections: [],
          lastStatus: 'ready',
        },
      ]),
    );
    const botRejections = []; // {handId, botId, kind, seat, reason}

    const stackOf = (userId) =>
      ctx.db
        .prepare('SELECT stack FROM room_players WHERE room_id = ? AND user_id = ?')
        .get(room.id, userId)?.stack ?? 0;
    // A busted player is excluded from the next deal; top everyone back up so
    // all styles play all HANDS (keeps per-style samples comparable). Net is
    // still measured by hand deltas, so top-ups never inflate results.
    let topUps = 0;
    // Vary each top-up amount: buy requests dedup identical (room,user,amount)
    // buys within a short window, which otherwise collapses two consecutive
    // top-ups into one no-op credit.
    let topUpSeq = 1;
    const nextTopUpAmount = () => BUYIN + topUpSeq++;
    const ensureFunded = async () => {
      if (stackOf(human.userId) <= 0) {
        const req = await human.api(`/api/rooms/${room.id}/buy`, {
          amount: nextTopUpAmount(),
        });
        await human.api(`/api/rooms/${room.id}/approve`, { requestId: req.id, approve: true });
        topUps++;
      }
      for (const b of bots) {
        if (stackOf(b.userId) <= 0) {
          await human.api(`/api/rooms/${room.id}/bots/${b.id}/buy`, {
            amount: nextTopUpAmount(),
          });
          topUps++;
          if (stackOf(b.userId) <= 0)
            console.warn(`[playtest] top-up did not fund bot ${b.kind} (status=${botStatus(b.id)})`);
        }
      }
    };

    const hands = [];
    // Flat, authoritative accepted-action list across all hands, plus a count of
    // accepted actions whose transcript payload lacked an actionSeq (which makes
    // them unjoinable - a hard failure, never a silent skip).
    const allAccepted = [];
    let acceptedMissingActionSeq = 0;
    let abortCount = 0;
    let aborts = [];
    let botActions = 0;
    let illegalActionSignals = 0;
    // Human-LLM audit: decisions returned by the policy vs times the harness's
    // own fallbackAction had to replace them (should be zero when the model works).
    let humanLlmDecisions = 0;
    let humanHarnessFallbacks = 0;

    const driveHuman = async (handId, deadline) => {
      while (Date.now() < deadline) {
        if (human.handId !== handId || human.abort) break;
        if (human.result && human.result.handId === handId) break;
        await human.waitForTurn(80);
        if (human.handId !== handId || human.abort) break;
        if (human.result && human.result.handId === handId) break;
        if (!human.myTurn()) continue;
        const view = buildDecisionView(human);
        if (!view.legalActions) continue;
        // Never race the action clock: a late action can be rejected server-side
        // while the client marks it acted, wedging the turn. If the deadline is
        // imminent, let the server's timeout auto-action handle it.
        if (view.hand?.deadline && view.hand.deadline - Date.now() < 150) continue;
        let action;
        let source;
        try {
          // `Policy.decide` may be sync (style/scripted) or async (`llm`);
          // awaiting a plain value is a no-op, so this keeps both compatible.
          const decision = await humanPolicy.decide(view);
          action = decision.action;
          source = decision.source;
          if (isLlmPolicyKind(HUMAN_STYLE)) humanLlmDecisions++;
        } catch {
          action = undefined;
        }
        if (!action || !isLegal(action, view.legalActions)) {
          action = fallbackAction(view.legalActions);
          source = undefined; // the harness, not the policy's own fallback
          if (isLlmPolicyKind(HUMAN_STYLE)) humanHarnessFallbacks++;
        }
        const actionSeq = human.actionSeq;
        try {
          human.act(action);
          // The human driver routes through the same attribution as the runners,
          // so a `HUMAN_STYLE=llm` run is accounted for too.
          recordRoutedAction({ kind: 'sent', handId, actionSeq, seat: human.mySeat(), source });
        } catch {
          // the table advanced between the check and the send
        }
      }
    };

    for (let h = 0; h < HANDS; h++) {
      await ensureFunded();
      const prevHandId = human.handId;
      const handStart = Date.now();
      human.send({ t: 'start_hand' });
      await waitFor(
        () => !!human.abort || (human.handId && human.handId !== prevHandId),
        15_000,
        `hand ${h + 1} dealt`,
      );
      if (human.abort) {
        aborts.push(human.abort);
        abortCount++;
        break;
      }
      const handId = human.handId;
      const driver = driveHuman(handId, Date.now() + HAND_MS);
      try {
        const settleDeadline = Date.now() + HAND_MS;
        for (;;) {
          const settled =
            (human.result && human.result.handId === handId) ||
            (human.abort && human.abort.handId === handId);
          if (settled) break;
          const actionSeq = hub.rooms.get(room.id)?.hand?.actionSeq ?? 0;
          if (actionSeq > MAX_HAND_ACTIONS)
            throw new Error(
              `pathological hand ${handId}: actionSeq=${actionSeq} (> ${MAX_HAND_ACTIONS}) - deep min-raise war`,
            );
          if (Date.now() > settleDeadline)
            throw new Error(`waitFor timed out: hand ${h + 1} settled`);
          await sleep(20);
        }
      } catch (err) {
        const lastT = ctx.db
          .prepare('SELECT hand_id, entries FROM transcripts ORDER BY ts DESC LIMIT 1')
          .get();
        const lastEvents = lastT ? JSON.parse(lastT.entries).slice(-6).map((e) => e.type) : [];
        // Reach into the live GameRoom/Hand (private only at the type level) for
        // the exact server-side turn/timer state at the moment of the hang.
        const gameRoom = hub.rooms.get(room.id);
        const hand = gameRoom?.hand;
        console.error('[playtest] stuck hand', handId, {
          serverHand: hand
            ? {
                handId: hand.id,
                phase: hand.phase,
                actionSeq: hand.actionSeq,
                lastDeadline: hand.lastDeadline,
                turnBaseDeadline: hand.turnBaseDeadline,
                timerArmed: !!hand.timer,
                retriesLeft: hand.retriesLeft,
                betting: hand.betting,
              }
            : null,
          // server-side truth
          activeServerHand: activeHands.has(room.id),
          phaseProxy: human.betting?.street ?? null,
          lastCompletedHand: lastT?.hand_id ?? null,
          lastTranscriptEvents: lastEvents,
          // client-observed state
          humanHandId: human.handId,
          handLive: human.handLive(),
          result: human.result?.handId ?? null,
          abort: human.abort ?? null,
          myTurn: human.myTurn(),
          betting: human.betting
            ? {
                street: human.betting.street,
                toAct: human.betting.toAct,
                seats: human.betting.seats.map((s) => ({
                  seat: s.seat,
                  stack: s.stack,
                  folded: s.folded,
                  allIn: s.allIn,
                })),
              }
            : null,
          humanCards: human.myCards,
          board: human.board,
          bots: bots.map((b) => {
            // The runner's HeadlessClient (private at the type level) lets us
            // compare the client view against the server's for this seat.
            const client = supervisor.runners?.get(b.id)?.client;
            return {
              kind: b.kind,
              seat: b.seat,
              status: botStatus(b.id),
              connected: !!human.room?.players.find((p) => p.userId === b.userId)?.connected,
              accepted: perBot.get(b.id)?.acceptedActions ?? 0,
              rejected: perBot.get(b.id)?.rejectedActions ?? 0,
              client: client
                ? {
                    handId: client.handId,
                    actionSeq: client.actionSeq,
                    lastActedSeq: client.lastActedSeq,
                    deadline: client.deadline,
                    myTurn: client.myTurn(),
                    handLive: client.handLive(),
                    bettingToAct: client.betting?.toAct ?? null,
                    result: client.result?.handId ?? null,
                    abort: !!client.abort,
                  }
                : null,
            };
          }),
        });
        throw err;
      }
      await driver;
      if (human.abort) {
        aborts.push(human.abort);
        abortCount++;
        break;
      }

      const result = human.result;
      const tRow = ctx.db
        .prepare('SELECT head, entries FROM transcripts WHERE hand_id = ?')
        .get(handId);
      if (!tRow) throw new Error(`missing transcript for hand ${handId}`);

      // Authoritative server view: only accepted `action` entries are written,
      // and every rejected attempt is an `action_rejected` server entry.
      const tEntries = JSON.parse(tRow.entries);
      const acceptedBySeat = {};
      // Every accepted signed action, keyed by the server-authoritative
      // `actionSeq` written into its transcript payload. This - not a locally
      // accumulated ordinal - is what links a transcript action to the runner's
      // routed decision, so it survives missed frames/reconnects.
      const handRejections = [];
      for (const e of tEntries) {
        if (e.type === 'action' && e.payload && typeof e.payload.seat === 'number') {
          acceptedBySeat[e.payload.seat] = (acceptedBySeat[e.payload.seat] ?? 0) + 1;
          if (typeof e.payload.actionSeq === 'number') {
            allAccepted.push({ handId, seat: e.payload.seat, actionSeq: e.payload.actionSeq });
          } else {
            // An accepted action with no authoritative seq cannot be joined.
            acceptedMissingActionSeq++;
          }
        } else if (e.type === 'action_rejected')
          handRejections.push({
            seat: e.payload?.seat,
            reason: e.payload?.reason ?? 'unknown',
          });
      }

      const commitments = {};
      let pot = 0;
      for (const s of human.betting?.seats ?? []) {
        commitments[s.seat] = s.total;
        pot += s.total;
      }
      if (pot <= 0)
        pot = result.deltas.filter((d) => d.delta > 0).reduce((sum, d) => sum + d.delta, 0);

      const actions = (human.actionHistory ?? []).map((a) => ({
        // Server-authoritative index (falls back to an ordinal only against a
        // legacy server). Used for auto-action accounting and style stats.
        actionSeq: a.actionSeq,
        seat: a.seat,
        street: a.street,
        type: a.action.type,
        amount: a.action.amount ?? null,
        auto: !!a.auto,
      }));
      for (const a of actions) if (seatMeta.get(a.seat)?.isBot) botActions++;

      const seats = result.deltas.map((d) => d.seat);
      // Roll the signed transcript up per bot and record any rejection.
      for (const b of bots) {
        const pb = perBot.get(b.id);
        if (seats.includes(b.seat)) pb.handsParticipated++;
        pb.acceptedActions += acceptedBySeat[b.seat] ?? 0;
        for (const rej of handRejections) {
          if (rej.seat !== b.seat) continue;
          pb.rejectedActions++;
          pb.rejections.push({ handId, reason: rej.reason });
          botRejections.push({ handId, botId: b.id, kind: b.kind, seat: b.seat, reason: rej.reason });
        }
      }

      hands.push({
        handId,
        // `deltas` lists every seat dealt into the hand (including a player who
        // busted to 0), whereas `stacks` can omit a zero stack.
        participants: result.deltas.length,
        seats,
        pot,
        commission: result.commission ?? 0,
        deltas: result.deltas,
        commitments,
        actions,
        acceptedBySeat,
        rejections: handRejections,
        durationMs: Date.now() - handStart,
      });
    }

    for (const b of bots) perBot.get(b.id).lastStatus = botStatus(b.id);
    const perBotList = [...perBot.values()];
    flushAllRequests();
    const perRequestFile = process.env.LLM_PER_REQUEST_FILE;
    if (perRequestFile)
      writeFileSync(perRequestFile, JSON.stringify(perRequestRecords, null, 2));
    const llmSummary = summarizeLlm(llmEvents);

    // ---- execution attribution -------------------------------------------
    // The transcript is the authority on accepted actions; the runner's routed
    // events say whether each accepted action came from the model or the local
    // fallback. Only a model-sourced action that the server actually accepted
    // proves the model took effect (shadow runs route everything to fallback).
    // The join is a pure helper so it can be unit-tested independently.
    const routedSends = routedActions.filter((e) => e.kind === 'sent');
    const attribution = joinActionAttribution(routedSends, allAccepted, acceptedMissingActionSeq);
    const modelAccepted = attribution.modelAccepted;
    const fallbackAccepted = attribution.fallbackAccepted;
    const otherAccepted = attribution.otherAccepted;
    const modelAcceptedBySeat = attribution.modelAcceptedBySeat;
    let autoActions = 0;
    for (const hand of hands) for (const a of hand.actions) if (a.auto) autoActions++;
    let staleDiscards = 0;
    let deadlineDiscards = 0;
    let reconnectDiscards = 0;
    let modelDiscarded = 0;
    let fallbackDiscarded = 0;
    for (const e of routedActions) {
      if (e.kind !== 'discarded') continue;
      if (e.reason === 'deadline') deadlineDiscards++;
      else if (e.reason === 'reconnect') reconnectDiscards++;
      else staleDiscards++;
      if (e.source === 'model') modelDiscarded++;
      else if (e.source === 'fallback') fallbackDiscarded++;
    }
    const execution = {
      modelRequests: llmSummary.global.calls,
      modelLegalResults: llmSummary.global.modelActionLegal.true,
      modelAccepted,
      fallbackAccepted,
      otherAccepted,
      modelDiscarded,
      fallbackDiscarded,
      staleDiscards,
      deadlineDiscards,
      reconnectDiscards,
      autoActions,
      acceptedWithoutRoute: attribution.acceptedWithoutRoute,
      routeWithoutAccepted: attribution.routeWithoutAccepted,
      duplicateRoute: attribution.duplicateRoute,
      seatMismatch: attribution.seatMismatch,
      acceptedMissingActionSeq: attribution.acceptedMissingActionSeq,
      acceptedWithoutRouteSamples: attribution.samples.acceptedWithoutRoute,
      routeWithoutAcceptedSamples: attribution.samples.routeWithoutAccepted,
      duplicateRouteSamples: attribution.samples.duplicateRoute,
      seatMismatchSamples: attribution.samples.seatMismatch,
      modelAcceptedBySeat: Object.fromEntries(
        [...modelAcceptedBySeat.entries()].map(([seat, n]) => [
          `${seatMeta.get(seat)?.kind ?? seat}#${seat}`,
          n,
        ]),
      ),
      note: 'Attribution joins each accepted transcript action (authoritative handId:actionSeq + seat) to a routed decision; unmapped/seats that disagree/duplicate/seq-less are counted as integrity failures. modelAccepted counts server-accepted actions whose decision source was the model; shadow routes to fallback and therefore scores 0.',
    };

    // ---- assertions -------------------------------------------------------
    pass('server booted + bots ran', `${bots.length} bots, ${hands.length} hands`);

    if (abortCount === 0) pass('no hand_abort', '0 aborts');
    else fail('no hand_abort', `${abortCount} abort(s): ${JSON.stringify(aborts)}`);

    if (hands.length === HANDS) pass('completed hands', `played ${hands.length}/${HANDS}`);
    else fail('completed hands', `only ${hands.length}/${HANDS} settled`);

    // ledger conservation (the exact invariant the E2E test proves)
    const roster = ctx.db
      .prepare('SELECT user_id, stack FROM room_players WHERE room_id = ?')
      .all(room.id);
    let stackMismatch = 0;
    let negativeStack = 0;
    for (const p of roster) {
      const sum = ctx.db
        .prepare(
          'SELECT COALESCE(SUM(delta), 0) AS s FROM ledger WHERE room_id = ? AND user_id = ?',
        )
        .get(room.id, p.user_id).s;
      if (p.stack !== sum) stackMismatch++;
      if (p.stack < 0) negativeStack++;
    }
    if (stackMismatch === 0) pass('per-player stack == SUM(ledger.delta)', `${roster.length} players`);
    else fail('per-player stack == SUM(ledger.delta)', `${stackMismatch} mismatched`);
    if (negativeStack === 0) pass('no negative stack', `${roster.length} players`);
    else fail('no negative stack', `${negativeStack} negative`);

    const ledgerTotal = ctx.db
      .prepare('SELECT COALESCE(SUM(delta), 0) AS s FROM ledger WHERE room_id = ?')
      .get(room.id).s;
    const purchased = ctx.db
      .prepare(
        "SELECT COALESCE(SUM(delta), 0) AS s FROM ledger WHERE room_id = ? AND kind = 'purchase'",
      )
      .get(room.id).s;
    if (ledgerTotal === purchased)
      pass('room ledger total == purchases', `${ledgerTotal}`);
    else fail('room ledger total == purchases', `ledger ${ledgerTotal} vs purchases ${purchased}`);

    const errored = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM bot_accounts WHERE room_id = ? AND status = 'error'")
      .get(room.id).n;
    illegalActionSignals = errored;
    if (errored === 0) pass('no bot errored (no illegal action / policy throw)', '0 errors');
    else fail('no bot errored', `${errored} bot(s) in error`);

    if (botActions > 0) pass('bots acted legally', `${botActions} bot actions observed`);
    else fail('bots acted legally', 'no bot actions observed');

    // Server-side rejection audit: any bot action_rejected is a hard failure.
    if (botRejections.length === 0)
      pass('no bot action_rejected (server-side)', '0 rejections');
    else
      fail(
        'no bot action_rejected (server-side)',
        `${botRejections.length} rejected: ${JSON.stringify(botRejections.slice(0, 10))}`,
      );

    // Per-bot: each bot must actually play several hands and get actions in.
    // >= 80% of hands, rounded up: 3 hands -> 3, 12 -> 10. `Math.floor` would
    // let 3 hands pass at 2 (66.7%) and 12 at 9 (75%), both below the bar.
    const minHandsPerBot = Math.max(1, Math.ceil(HANDS * 0.8));
    const starved = perBotList.filter(
      (b) =>
        b.handsParticipated < minHandsPerBot ||
        b.acceptedActions < 1 ||
        b.lastStatus === 'error' ||
        b.rejectedActions > 0,
    );
    const totalAccepted = perBotList.reduce((s, b) => s + b.acceptedActions, 0);
    const perBotSummary = perBotList
      .map(
        (b) =>
          `${b.kind}#${b.seat}:part=${b.handsParticipated},acc=${b.acceptedActions},rej=${b.rejectedActions},status=${b.lastStatus}`,
      )
      .join(' ');
    if (starved.length === 0 && totalAccepted > 0)
      pass('every bot participated + had accepted actions', perBotSummary);
    else
      fail(
        'every bot participated + had accepted actions',
        `minHands=${minHandsPerBot}; ${starved.length} starved; ${perBotSummary}`,
      );

    const ledger = await human.api(`/api/rooms/${room.id}/ledger`);
    if (ledger.verified?.ok) pass('ledger hash chain verified', 'ok');
    else fail('ledger hash chain verified', 'verify failed');

    // Attribution integrity: every server-accepted action must join exactly one
    // routed decision at the same authoritative (handId, actionSeq) and seat,
    // and no routed send may go unaccounted for. Any non-zero value means the
    // execution numbers below cannot be trusted.
    if (execution.acceptedWithoutRoute === 0)
      pass('every accepted action has a routed decision', `0 unmatched`);
    else
      fail(
        'every accepted action has a routed decision',
        `${execution.acceptedWithoutRoute} unmatched: ${JSON.stringify(execution.acceptedWithoutRouteSamples)}`,
      );
    if (execution.seatMismatch === 0) pass('routed seat matches transcript seat', '0 mismatches');
    else
      fail(
        'routed seat matches transcript seat',
        `${execution.seatMismatch} mismatches: ${JSON.stringify(execution.seatMismatchSamples)}`,
      );
    if (execution.routeWithoutAccepted === 0)
      pass('every routed send was accepted', '0 unaccepted sends');
    else
      fail(
        'every routed send was accepted',
        `${execution.routeWithoutAccepted} unaccepted: ${JSON.stringify(execution.routeWithoutAcceptedSamples)}`,
      );
    if (execution.duplicateRoute === 0)
      pass('no duplicate routed decisions', '0 duplicates');
    else
      fail(
        'no duplicate routed decisions',
        `${execution.duplicateRoute} duplicates: ${JSON.stringify(execution.duplicateRouteSamples)}`,
      );
    if (execution.acceptedMissingActionSeq === 0)
      pass('every accepted action carries an authoritative actionSeq', '0 missing');
    else
      fail(
        'every accepted action carries an authoritative actionSeq',
        `${execution.acceptedMissingActionSeq} accepted action(s) had no actionSeq`,
      );

    // Latency bookkeeping is a gate, not just a report: one sample per request
    // and each request classified exactly once.
    if (LLM_ENABLED) {
      const g = llmSummary.global;
      const outcomeSum = Object.values(g.outcomes).reduce((s, n) => s + n, 0);
      if (g.latencyMs.samples === g.calls)
        pass('latency samples == llm_calls', `${g.latencyMs.samples}/${g.calls}`);
      else
        fail('latency samples == llm_calls', `${g.latencyMs.samples} samples vs ${g.calls} calls`);
      if (outcomeSum === g.calls)
        pass('sum(request outcomes) == llm_calls', `${outcomeSum}/${g.calls}`);
      else
        fail(
          'sum(request outcomes) == llm_calls',
          `${outcomeSum} outcomes vs ${g.calls} calls (${JSON.stringify(g.outcomes)})`,
        );
    }

    // LLM gate: the local fallback must always be legal (it guards every model
    // failure), and `llm` bots must finish >= 80% of the requested hands.
    // NOTE: zero fallbacks is a *healthy* run (the model always answered), so
    // 0/0 must pass. Fallback reachability is proved by a dedicated run with
    // `LLM_EXPECT=fallback` (e.g. a tiny LLM_TIMEOUT_MS), never demanded here.
    const fallbackLegal = llmSummary.global.fallbackActionLegal;
    if (fallbackLegal.false === 0)
      pass(
        'llm fallback actions all legal',
        `true=${fallbackLegal.true}, false=${fallbackLegal.false}`,
      );
    else
      fail('llm fallback actions all legal', `${fallbackLegal.false} illegal fallback action(s)`);
    const llmBotRows = perBotList.filter((b) => isLlmPolicyKind(b.kind));
    const llmStarved = llmBotRows.filter((b) => b.handsParticipated < minHandsPerBot);
    if (llmBotRows.length === 0 || llmStarved.length === 0)
      pass(
        'LLM bots completed >= 80% of hands',
        llmBotRows.length
          ? llmBotRows.map((b) => `${b.kind}#${b.seat}:${b.handsParticipated}`).join(' ')
          : 'no llm bots in this run',
      );
    else
      fail(
        'LLM bots completed >= 80% of hands',
        `minHands=${minHandsPerBot}; ${llmStarved.map((b) => `${b.kind}#${b.seat}:${b.handsParticipated}`).join(' ')}`,
      );

    // Any LLM-enabled run must actually reach the provider: zero calls means
    // every decision silently used the local fallback, which makes the whole
    // model result meaningless. A missing key gets a more specific message.
    if (LLM_ENABLED) {
      if (llmSummary.global.calls === 0) {
        // Zero calls is a *failure* only when nothing explains it. On a short
        // action clock the policy proactively degrades (deadline_skips) without
        // touching the network, which is the intended behaviour.
        if (llmSummary.global.deadlineSkips > 0)
          pass(
            'llm actually called',
            `0 calls: ${llmSummary.global.deadlineSkips} decision(s) proactively degraded below the ${LLM_OPTIONS.minModelBudgetMs}ms budget`,
          );
        else
          fail(
            'llm actually called',
            LLM_OPTIONS.apiKey
              ? 'LLM is enabled with a key configured, but zero llm_calls were made (every decision used the local fallback)'
              : 'LLM_API_KEY is missing; every llm decision used the local fallback',
          );
      } else pass('llm actually called', `${llmSummary.global.calls} llm call(s)`);
    }

    // A live run must prove the model actually took effect, not just that a
    // request was attempted or that a legal result came back: a model-sourced
    // action must have been *accepted by the server*. A shadow run routes every
    // decision to the local fallback, so it can never satisfy this gate. A
    // `fallback` run instead proves the fallback path was reached.
    if (LLM_ENABLED && (LLM_EXPECT === 'model' || LLM_EXPECT === 'fallback')) {
      if (LLM_EXPECT === 'model') {
        if (execution.modelAccepted > 0)
          pass(
            'llm model action accepted by server',
            `modelAccepted=${execution.modelAccepted} (calls=${execution.modelRequests}, modelLegal=${execution.modelLegalResults}, fallbackAccepted=${execution.fallbackAccepted})`,
          );
        else
          fail(
            'llm model action accepted by server',
            `no server-accepted model action (calls=${execution.modelRequests}, modelLegal=${execution.modelLegalResults}, modelAccepted=0, fallbackAccepted=${execution.fallbackAccepted})`,
          );
      } else if (execution.fallbackAccepted > 0)
        // Same standard as the model gate: not merely "a fallback was
        // evaluated", but the server actually accepted a fallback-sourced
        // action. `fallbackLegal.false === 0` is still enforced above.
        pass(
          'llm fallback action accepted by server',
          `fallbackAccepted=${execution.fallbackAccepted} (evaluated=${fallbackLegal.true + fallbackLegal.false}, calls=${execution.modelRequests})`,
        );
      else
        fail(
          'llm fallback action accepted by server',
          `no server-accepted fallback action (evaluated=${fallbackLegal.true + fallbackLegal.false}, fallbackAccepted=0)`,
        );
    }

    // When the human itself drives an `llm` policy, its decisions must show the
    // same evidence: a real call and a legal model action, keyed under
    // `human:<style>` in the per-policy metrics.
    if (isLlmPolicyKind(HUMAN_STYLE)) {
      const humanLlmKey = Object.keys(llmSummary.byPolicy).find((k) => k.startsWith('human:'));
      const h = humanLlmKey ? llmSummary.byPolicy[humanLlmKey] : null;
      // `modelAcceptedBySeat` is keyed by NUMERIC seat; the human is seat 0. The
      // string label (`human:<style>#0`) is only for report serialisation below.
      const { ok: humanOk, accepted: humanAccepted } = humanLlmTookEffect(
        modelAcceptedBySeat,
        0,
        h
          ? { calls: h.calls, decisions: humanLlmDecisions, harnessFallbacks: humanHarnessFallbacks }
          : null,
        LLM_EXPECT === 'model',
      );
      const detail = h
        ? `${humanLlmKey}: calls=${h.calls} modelAccepted=${humanAccepted} decisions=${humanLlmDecisions} harnessFallbacks=${humanHarnessFallbacks}`
        : 'no human:* llm metrics were emitted';
      if (humanOk) pass('human llm decisions took effect', detail);
      else fail('human llm decisions took effect', detail);
    }

    // ---- quantitative report ---------------------------------------------
    const styleAgg = {};
    const ensure = (key, label, kind) =>
      (styleAgg[key] ??= {
        key,
        label,
        kind,
        hands: 0,
        vpipHands: 0,
        pfrHands: 0,
        actions: { fold: 0, check: 0, call: 0, bet: 0, raise: 0 },
        netChips: 0,
        commitTotal: 0,
        potsWon: 0,
      });
    for (const [, meta] of seatMeta)
      ensure(meta.kind, meta.label, meta.kind);

    for (const hand of hands) {
      const seenSeats = new Set(hand.seats);
      for (const [seat, meta] of seatMeta) {
        if (!seenSeats.has(seat)) continue;
        const agg = ensure(meta.kind, meta.label, meta.kind);
        agg.hands++;
        agg.commitTotal += hand.commitments[seat] ?? 0;
        const mine = hand.actions.filter((a) => a.seat === seat);
        const preflop = mine.filter((a) => a.street === 'preflop' && !a.auto);
        if (preflop.some((a) => ['call', 'bet', 'raise'].includes(a.type))) agg.vpipHands++;
        if (preflop.some((a) => ['bet', 'raise'].includes(a.type))) agg.pfrHands++;
        for (const a of mine) if (agg.actions[a.type] !== undefined) agg.actions[a.type]++;
        const d = hand.deltas.find((x) => x.seat === seat)?.delta ?? 0;
        agg.netChips += d;
        if (d > 0) agg.potsWon++;
      }
    }

    const allRows = Object.values(styleAgg).map((s) => {
      const totalActions = Object.values(s.actions).reduce((a, b) => a + b, 0) || 1;
      return {
        kind: s.kind,
        hands: s.hands,
        vpip: s.hands ? +(s.vpipHands / s.hands).toFixed(3) : 0,
        pfr: s.hands ? +(s.pfrHands / s.hands).toFixed(3) : 0,
        // Action shares: denominator is this style's total actions.
        actionFoldShare: +(s.actions.fold / totalActions).toFixed(3),
        actionCallShare: +(s.actions.call / totalActions).toFixed(3),
        actionRaiseShare: +((s.actions.bet + s.actions.raise) / totalActions).toFixed(3),
        // Average per hand of the seat's final committed total (chips put in).
        avgCommit: s.hands ? +(s.commitTotal / s.hands).toFixed(1) : 0,
        netChips: s.netChips,
        bbPer100: s.hands ? +(((s.netChips / BB) / s.hands) * 100).toFixed(1) : 0,
        potsWon: s.potsWon,
        actions: s.actions,
      };
    });

    const styles = allRows.filter((s) => !s.kind.startsWith('human:'));
    const humanRow = allRows.find((s) => s.kind.startsWith('human:')) ?? null;

    const spread = (key) => {
      const vals = styles.map((s) => s[key]);
      if (vals.length < 2) return 0;
      return +(Math.max(...vals) - Math.min(...vals)).toFixed(3);
    };
    const vpipSpread = spread('vpip');
    const pfrSpread = spread('pfr');
    const foldSpread = spread('actionFoldShare');

    const globals = {
      hands: hands.length,
      requestedHands: HANDS,
      aborts: abortCount,
      botActions,
      topUps,
      botErrors: illegalActionSignals,
      humanLlmDecisions,
      humanHarnessFallbacks,
      ledgerVerified: !!ledger.verified?.ok,
      ledgerTotal,
      purchased,
      players: roster.length,
      totalPot: hands.reduce((s, h) => s + h.pot, 0),
      avgPot: hands.length ? +(hands.reduce((s, h) => s + h.pot, 0) / hands.length).toFixed(1) : 0,
      durationMs: Date.now() - startedAt,
    };

    const distinctiveness = {
      vpipSpread,
      pfrSpread,
      foldSpread,
      note: 'Spread across styles; larger = more separable behaviour. Report-only, not a pass/fail gate.',
      distinct: vpipSpread >= 0.1 || foldSpread >= 0.15 || pfrSpread >= 0.08,
    };

    const report = {
      runId,
      config: {
        hands: HANDS,
        seed: SEED,
        bots: BOTS,
        styles: STYLES,
        humanStyle: HUMAN_STYLE,
        sb: SB,
        bb: BB,
        buyIn: BUYIN,
        cryptoMs: CRYPTO_MS,
        actionMs: ACTION_MS,
        memory: MEMORY_ON,
        llm: {
          enabled: LLM_ENABLED,
          expect: LLM_EXPECT,
          shadow: !!LLM_OPTIONS.shadow,
          model: LLM_OPTIONS.model,
          baseUrl: LLM_OPTIONS.baseUrl,
          timeoutMs: LLM_OPTIONS.timeoutMs,
          maxCallsPerHand: LLM_OPTIONS.maxCallsPerHand,
          maxOutputTokens: LLM_OPTIONS.maxOutputTokens,
          extraBody: EXTRA_BODY ?? null,
          minModelBudgetMs: LLM_OPTIONS.minModelBudgetMs,
          apiKeyPresent: !!LLM_OPTIONS.apiKey,
        },
      },
      startedAt: new Date(startedAt).toISOString(),
      notes: [
        'SEED seeds the policy RNG only; the deal uses server randomness, so hands are not reproducible run to run.',
        'Top-ups (reloads) are part of the experiment; netChips excludes buy-ins (it is the sum of hand deltas).',
        'avgCommit = average per hand of the seat final committed total (chips put into the pot).',
        'action*Share denominator is that style total actions; bb/100 is descriptive only at this sample size.',
        'LLM latency is exactly one sample per request, recorded after the response body has been read (never at the headers), so latencyMs.samples == llm_calls.',
        'Latency is reported two ways: successful-only (outcome ok) and all-attempt. A timeout sample is CENSORED at the configured request timeout (~12s), so all-attempt p95/p99 are lower bounds on the provider tail, NOT the provider raw latency; see latencyMs.censored/timeoutRate.',
        'usageMissing counts only parseable responses that carried no usable usage block; timeout/http/parse_body requests have no usage by definition and are not counted there.',
        'LLM cost is a fixed-estimate from list-price constants inside LlmPolicy; it is observability only, not billing.',
        'LLM runs default to a 30s action clock and a 12s request timeout so a real model round-trip can complete; zero fallbacks is a healthy live run, not a failure.',
        'On a short action clock the policy degrades proactively: `deadline_skips` counts decisions that never fired a request (below LLM_MIN_BUDGET_MS, default 6000ms), which is distinct from `llm_fallbacks.timeout` (a request that was sent and cut off).',
        'The decision view carries `historyComplete` (false after a mid-hand disconnect gap) and a bounded `sessionMemory` (<=8 recentHands + <=8 opponents over their last complete hands); reconnectDiscards counts policy results dropped because the connection epoch changed during the await.',
        '`LLM_EXPECT=model` (default) demands a server-accepted action whose decision source was the model - not merely a legal model result, so a shadow run cannot satisfy it; `LLM_EXPECT=fallback` demands a server-accepted action from the local fallback. Attribution joins transcript actions to routed decisions on the server-authoritative (handId, actionSeq) + seat; acceptedWithoutRoute/routeWithoutAccepted/duplicateRoute/seatMismatch/acceptedMissingActionSeq must all be 0, and latency.samples and sum(outcomes) must equal llm_calls.',
      ],
      globals,
      execution,
      distinctiveness,
      bots: perBotList,
      human: humanRow,
      styles,
      llm: { global: llmSummary.global, byPolicy: llmSummary.byPolicy },
      checks,
      hands: hands.map((h) => ({
        handId: h.handId,
        participants: h.participants,
        pot: h.pot,
        commission: h.commission,
        deltas: h.deltas,
        acceptedBySeat: h.acceptedBySeat,
        rejections: h.rejections,
        durationMs: h.durationMs,
      })),
    };

    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, `${runId}.json`), JSON.stringify(report, null, 2));
    writeFileSync(join(OUT_DIR, `${runId}.md`), renderMarkdown(report));

    // ---- console summary --------------------------------------------------
    const failures = checks.filter((c) => !c.ok);
    console.log(`\n=== bot playtest ${runId} ===`);
    console.log(
      `hands=${globals.hands}/${HANDS} aborts=${abortCount} botActions=${botActions} ` +
        `avgPot=${globals.avgPot} duration=${(globals.durationMs / 1000).toFixed(1)}s`,
    );
    console.log('styles:');
    for (const s of [...styles, humanRow].filter(Boolean))
      console.log(
        `  ${s.kind.padEnd(24)} hands=${s.hands} vpip=${s.vpip} pfr=${s.pfr} ` +
          `fold=${s.actionFoldShare} call=${s.actionCallShare} raise=${s.actionRaiseShare} ` +
          `avgCommit=${s.avgCommit} net=${s.netChips} bb/100=${s.bbPer100}`,
      );
    console.log('bots:');
    for (const b of perBotList)
      console.log(
        `  ${(b.kind + '#' + b.seat).padEnd(24)} part=${b.handsParticipated} acc=${b.acceptedActions} ` +
          `rej=${b.rejectedActions} status=${b.lastStatus}`,
      );
    console.log(
      `distinctiveness: vpipSpread=${vpipSpread} pfrSpread=${pfrSpread} foldSpread=${foldSpread} distinct=${distinctiveness.distinct}`,
    );
    if (LLM_ENABLED) {
      const g = llmSummary.global;
      console.log(
        `llm(${LLM_OPTIONS.shadow ? 'shadow' : 'live'}): calls=${g.calls} fallbacks=${JSON.stringify(g.fallbacks)} ` +
          `deadlineSkips=${g.deadlineSkips} outcomes=${JSON.stringify(g.outcomes)} ` +
          `latencyMs[all min/p50/p95/p99/max]=${g.latencyMs.min}/${g.latencyMs.p50}/${g.latencyMs.p95}/${g.latencyMs.p99}/${g.latencyMs.max} ` +
          `latencyMs[ok p50/p95/p99]=${g.latencyMs.successful.p50}/${g.latencyMs.successful.p95}/${g.latencyMs.successful.p99} ` +
          `samples=${g.latencyMs.samples} censored=${g.latencyMs.censored} timeoutRate=${g.latencyMs.timeoutRate} ` +
          `finishReasons=${JSON.stringify(g.finishReasons)} usageMissing=${g.usageMissing} ` +
          `tokens=${g.tokens.prompt}+${g.tokens.completion} cost~$${g.cost.estimatedUsd} ` +
          `modelLegal=${g.modelActionLegal.true}/${g.modelActionLegal.true + g.modelActionLegal.false} ` +
          `fallbackLegal=${g.fallbackActionLegal.true}/${g.fallbackActionLegal.true + g.fallbackActionLegal.false}`,
      );
      console.log(
        `execution: modelRequests=${execution.modelRequests} modelLegalResults=${execution.modelLegalResults} ` +
          `modelAccepted=${execution.modelAccepted} fallbackAccepted=${execution.fallbackAccepted} otherAccepted=${execution.otherAccepted} ` +
          `modelDiscarded=${execution.modelDiscarded} fallbackDiscarded=${execution.fallbackDiscarded} ` +
          `staleDiscards=${execution.staleDiscards} deadlineDiscards=${execution.deadlineDiscards} reconnectDiscards=${execution.reconnectDiscards} autoActions=${execution.autoActions} ` +
          `acceptedWithoutRoute=${execution.acceptedWithoutRoute} routeWithoutAccepted=${execution.routeWithoutAccepted} ` +
          `duplicateRoute=${execution.duplicateRoute} seatMismatch=${execution.seatMismatch} acceptedMissingActionSeq=${execution.acceptedMissingActionSeq} ` +
          `modelAcceptedBySeat=${JSON.stringify(execution.modelAcceptedBySeat)}`,
      );
    }
    console.log(`report: ${join(OUT_DIR, `${runId}.md`)} + .json`);
    if (failures.length) {
      console.error('\nFAILED checks:');
      for (const c of failures) console.error(`  - ${c.name}: ${c.detail}`);
    } else {
      console.log('all checks passed');
    }

    return failures.length === 0 ? 0 : 1;
  } finally {
    await supervisor.stopAll().catch(() => {});
    human.close();
    await ctx.app.close().catch(() => {});
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

function renderMarkdown(r) {
  const lines = [];
  lines.push(`# Bot playtest — ${r.runId}`);
  lines.push('');
  lines.push(`Config: \`${JSON.stringify(r.config)}\``);
  lines.push('');
  lines.push('## Global');
  lines.push('');
  lines.push('| metric | value |');
  lines.push('| --- | --- |');
  for (const [k, v] of Object.entries(r.globals)) lines.push(`| ${k} | ${v} |`);
  lines.push('');
  lines.push('## Per style');
  lines.push('');
  lines.push('| style | hands | VPIP | PFR | fold | call | raise | avgCommit | net | bb/100 | potsWon |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const s of r.styles)
    lines.push(
      `| ${s.kind} | ${s.hands} | ${s.vpip} | ${s.pfr} | ${s.actionFoldShare} | ${s.actionCallShare} | ${s.actionRaiseShare} | ${s.avgCommit} | ${s.netChips} | ${s.bbPer100} | ${s.potsWon} |`,
    );
  lines.push('');
  if (r.human)
    lines.push(
      `Control (human): \`${r.human.kind}\` hands=${r.human.hands} vpip=${r.human.vpip} pfr=${r.human.pfr} fold=${r.human.actionFoldShare} call=${r.human.actionCallShare} raise=${r.human.actionRaiseShare} avgCommit=${r.human.avgCommit} net=${r.human.netChips} bb/100=${r.human.bbPer100}`,
    );
  lines.push('');
  lines.push('## Per bot (signed transcript audit)');
  lines.push('');
  lines.push('| bot | seat | participated | accepted | rejected | lastStatus |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const b of r.bots ?? [])
    lines.push(
      `| ${b.kind} | ${b.seat} | ${b.handsParticipated} | ${b.acceptedActions} | ${b.rejectedActions} | ${b.lastStatus} |`,
    );
  const rejected = (r.bots ?? []).reduce((s, b) => s + b.rejectedActions, 0);
  lines.push('');
  lines.push(`Total bot action_rejected: **${rejected}**`);
  lines.push('');
  lines.push('## LLM');
  lines.push('');
  if (!r.llm || (r.llm.global.calls === 0 && !r.config?.llm?.enabled)) {
    lines.push('_No `llm` policy in this run._');
  } else {
    const g = r.llm.global;
    lines.push(
      `Mode: **${r.config?.llm?.shadow ? 'shadow (observe only)' : 'live'}** · model \`${r.config?.llm?.model}\` · baseUrl \`${r.config?.llm?.baseUrl}\``,
    );
    lines.push('');
    lines.push('| metric | value |');
    lines.push('| --- | --- |');
    lines.push(`| llm_calls | ${g.calls} |`);
    lines.push(`| llm_fallbacks | ${JSON.stringify(g.fallbacks)} |`);
    lines.push(`| deadline_skips | ${g.deadlineSkips} |`);
    lines.push(`| latency samples (all attempts) | ${g.latencyMs.samples} (= llm_calls for completed requests) |`);
    lines.push(`| request outcomes | ${JSON.stringify(g.outcomes)} |`);
    lines.push(
      `| latency ms all attempts min/p50/p95/p99/max | ${g.latencyMs.min}/${g.latencyMs.p50}/${g.latencyMs.p95}/${g.latencyMs.p99}/${g.latencyMs.max} |`,
    );
    lines.push(
      `| latency ms successful-only min/p50/p95/p99/max | ${g.latencyMs.successful.min}/${g.latencyMs.successful.p50}/${g.latencyMs.successful.p95}/${g.latencyMs.successful.p99}/${g.latencyMs.successful.max} (n=${g.latencyMs.successful.samples}) |`,
    );
    lines.push(
      `| censored (timeout) / timeout rate | ${g.latencyMs.censored} / ${g.latencyMs.timeoutRate} |`,
    );
    lines.push(`| finish_reason distribution | ${JSON.stringify(g.finishReasons)} |`);
    lines.push(`| usageMissing (parseable response w/o usage) | ${g.usageMissing} |`);
    lines.push(`| parse failure stages (tool/content) | ${JSON.stringify(g.parseStages)} |`);
    lines.push(`| tokens prompt/completion/total | ${g.tokens.prompt}/${g.tokens.completion}/${g.tokens.total} |`);
    lines.push(`| cost estimatedUsd (fixed-estimate) | ${g.cost.estimatedUsd} |`);
    lines.push(`| model_action_legal true/false | ${g.modelActionLegal.true}/${g.modelActionLegal.false} |`);
    lines.push(
      `| fallback_action_legal true/false | ${g.fallbackActionLegal.true}/${g.fallbackActionLegal.false} |`,
    );
    lines.push('');
    lines.push('### Execution attribution');
    lines.push('');
    lines.push(
      'A model action only counts as *taken effect* when the server accepted it. In shadow mode every decision routes to the local fallback, so `modelAccepted` is 0.',
    );
    lines.push('');
    lines.push('| metric | value |');
    lines.push('| --- | --- |');
    lines.push(`| modelRequests | ${r.execution.modelRequests} |`);
    lines.push(`| modelLegalResults | ${r.execution.modelLegalResults} |`);
    lines.push(`| modelAccepted | ${r.execution.modelAccepted} |`);
    lines.push(`| fallbackAccepted | ${r.execution.fallbackAccepted} |`);
    lines.push(`| otherAccepted | ${r.execution.otherAccepted} |`);
    lines.push(`| modelDiscarded | ${r.execution.modelDiscarded} |`);
    lines.push(`| fallbackDiscarded | ${r.execution.fallbackDiscarded} |`);
    lines.push(`| staleDiscards | ${r.execution.staleDiscards} |`);
    lines.push(`| deadlineDiscards | ${r.execution.deadlineDiscards} |`);
    lines.push(`| reconnectDiscards | ${r.execution.reconnectDiscards} |`);
    lines.push(`| server auto-actions | ${r.execution.autoActions} |`);
    lines.push(`| acceptedWithoutRoute | ${r.execution.acceptedWithoutRoute} |`);
    lines.push(`| routeWithoutAccepted | ${r.execution.routeWithoutAccepted} |`);
    lines.push(`| duplicateRoute | ${r.execution.duplicateRoute} |`);
    lines.push(`| seatMismatch | ${r.execution.seatMismatch} |`);
    lines.push(`| acceptedMissingActionSeq | ${r.execution.acceptedMissingActionSeq} |`);
    lines.push(
      `| modelAcceptedBySeat | ${JSON.stringify(r.execution.modelAcceptedBySeat)} |`,
    );
    lines.push('');
    lines.push('### Per policy');
    lines.push('');
    lines.push(
      '| policy | calls | fallbacks | p50 | p95 | p99 | prompt tok | completion tok | cost estimatedUsd | modelLegal | fallbackLegal |',
    );
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const [tag, s] of Object.entries(r.llm.byPolicy))
      lines.push(
        `| ${tag} | ${s.calls} | ${JSON.stringify(s.fallbacks)} | ${s.latencyMs.p50} | ${s.latencyMs.p95} | ${s.latencyMs.p99} | ${s.tokens.prompt} | ${s.tokens.completion} | ${s.cost.estimatedUsd} | ${s.modelActionLegal.true}/${s.modelActionLegal.false} | ${s.fallbackActionLegal.true}/${s.fallbackActionLegal.false} |`,
      );
  }
  lines.push('');
  lines.push('## Distinctiveness');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(r.distinctiveness, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  for (const n of r.notes ?? []) lines.push(`- ${n}`);
  lines.push('');
  lines.push('## Checks');
  lines.push('');
  for (const c of r.checks) lines.push(`- ${c.ok ? 'PASS' : 'FAIL'} — ${c.name} (${c.detail})`);
  lines.push('');
  lines.push('## Hands');
  lines.push('');
  lines.push('| handId | players | pot | commission | accepted | rejected | durationMs |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const h of r.hands)
    lines.push(
      `| ${h.handId} | ${h.participants} | ${h.pot} | ${h.commission} | ${Object.values(h.acceptedBySeat ?? {}).reduce((a, b) => a + b, 0)} | ${(h.rejections ?? []).length} | ${h.durationMs} |`,
    );
  lines.push('');
  return lines.join('\n');
}

const exitCode = await main().catch((err) => {
  console.error('playtest crashed:', err);
  return 1;
});
process.exit(exitCode);
