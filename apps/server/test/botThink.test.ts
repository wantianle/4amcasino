import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeadlessClient, buildDecisionView, type Policy } from '@4am/agent-core';
import { createApp } from '../src/app.js';
import { attachHub } from '../src/hub.js';
import { BotSupervisor } from '../src/botSupervisor.js';
import { openDb } from '../src/db.js';
import {
  BotRunner,
  computeThinkDelayMs,
  planThinkWaitMs,
  thinkConfigFromEnv,
  type RunnerActionEvent,
  type ThinkConfig,
} from '../src/botRunner.js';
import type { BotRow, ClaimedBot } from '../src/botRoutes.js';
import { FakeClient } from './helpers/fakeBotClient.js';

/**
 * Inter-action buffer tests.
 *
 * The buffer sits AFTER `policy.decide` and BEFORE `act()`, so the budget only
 * has to cover the guard + the send, never a hypothetical policy runtime. The
 * pure helpers are pinned directly (`computeThinkDelayMs`, `planThinkWaitMs`)
 * and the runner tests inject a controllable `sleep` + deterministic `rng`:
 * policy-first ordering, a slow policy cancelling/shortening the wait, a policy
 * that crosses the deadline (same as no-delay), a mid-wait stop/reconnect/turn
 * change abandoning the decision without looping the buffer, routing preserved,
 * and the removed name heuristic. A real 5s-room E2E pins no timeout_fold.
 */

const KEY = 'ab'.repeat(32);
const ORIGINAL_KEY = process.env.BOT_IDENTITY_KEY;

const THINK: ThinkConfig = {
  enabled: true,
  minMs: 150,
  maxMs: 450,
};

function claimedBot(botId = 'bot1', policyKind = 'scripted'): ClaimedBot {
  const bot: BotRow = {
    id: botId,
    room_id: 'room1',
    owner_id: 1,
    user_id: 2,
    status: 'running',
    policy_kind: policyKind,
    policy_json: null,
    difficulty: 'low',
    seat: 0,
    identity_ct: 'x',
    identity_nonce: 'y',
    identity_tag: 'z',
    created_at: 0,
    updated_at: 0,
    stopped_at: null,
    stop_requested_at: null,
  };
  return {
    bot,
    roomId: 'room1',
    userId: 2,
    grantToken: '4am_agent_test',
    seed: new Uint8Array(32),
    policyKind,
    policyJson: null,
    difficulty: 'low',
  };
}

beforeEach(() => {
  process.env.BOT_IDENTITY_KEY = KEY;
});
afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.BOT_IDENTITY_KEY;
  else process.env.BOT_IDENTITY_KEY = ORIGINAL_KEY;
});

describe('computeThinkDelayMs', () => {
  it('returns 0 when disabled', () => {
    expect(computeThinkDelayMs({ ...THINK, enabled: false }, () => 0.5)).toBe(0);
  });

  it('draws a single uniform buffer in the configured range', () => {
    expect(computeThinkDelayMs(THINK, () => 0)).toBe(150);
    expect(computeThinkDelayMs(THINK, () => 0.5)).toBe(300);
    expect(computeThinkDelayMs(THINK, () => 1)).toBe(450);
  });

  it('is not decision-dependent (no big-pot / easy-spot scaling)', () => {
    // The range is the whole contract: every decision gets the same draw.
    expect(computeThinkDelayMs(THINK, () => 0)).toBe(computeThinkDelayMs(THINK, () => 0));
    expect(computeThinkDelayMs(THINK, () => 1)).toBe(450);
  });

  it('orders an inverted min/max defensively', () => {
    const inverted: ThinkConfig = { ...THINK, minMs: 450, maxMs: 150 };
    expect(computeThinkDelayMs(inverted, () => 0)).toBe(150);
    expect(computeThinkDelayMs(inverted, () => 1)).toBe(450);
  });
});

describe('planThinkWaitMs (guard + send budget, no policy reserve)', () => {
  it('applies the full planned wait on an untimed decision', () => {
    expect(planThinkWaitMs(800, null)).toBe(800);
  });

  it('leaves the full wait on a healthy 5s clock', () => {
    expect(planThinkWaitMs(800, 5000)).toBe(800);
  });

  it('caps by both the fixed reserve (guard+margin=300) and the ratio', () => {
    // 2000ms: fixed = 1700; ratio = 1000 -> wait 800.
    expect(planThinkWaitMs(800, 2000)).toBe(800);
    // 1200ms: fixed = 900; ratio = 600 -> 600.
    expect(planThinkWaitMs(800, 1200)).toBe(600);
    // 700ms: fixed = 400; ratio = 350 -> 350.
    expect(planThinkWaitMs(800, 700)).toBe(350);
    // 500ms: fixed = 200; ratio = 250 -> 200.
    expect(planThinkWaitMs(800, 500)).toBe(200);
  });

  it('drops the delay entirely when even guard+margin cannot be spared', () => {
    expect(planThinkWaitMs(800, 300)).toBe(0);
    expect(planThinkWaitMs(800, 100)).toBe(0);
  });

  it('returns 0 for a zero plan and never exceeds it', () => {
    expect(planThinkWaitMs(0, 5000)).toBe(0);
    expect(planThinkWaitMs(300, 1200)).toBe(300);
  });
});

describe('thinkConfigFromEnv', () => {
  it('is off under NODE_ENV=test and on otherwise', () => {
    expect(thinkConfigFromEnv({ NODE_ENV: 'test' }).enabled).toBe(false);
    expect(thinkConfigFromEnv({ NODE_ENV: 'production' }).enabled).toBe(true);
    expect(thinkConfigFromEnv({}).enabled).toBe(true);
  });

  it('honours BOT_THINK_ENABLED in both directions', () => {
    expect(thinkConfigFromEnv({ BOT_THINK_ENABLED: '0', NODE_ENV: 'production' }).enabled).toBe(
      false,
    );
    expect(thinkConfigFromEnv({ BOT_THINK_ENABLED: 'off', NODE_ENV: 'production' }).enabled).toBe(
      false,
    );
    expect(thinkConfigFromEnv({ BOT_THINK_ENABLED: '1', NODE_ENV: 'test' }).enabled).toBe(true);
  });

  it('reads the min/max bounds', () => {
    const cfg = thinkConfigFromEnv({
      BOT_THINK_MIN_MS: '100',
      BOT_THINK_MAX_MS: '200',
      NODE_ENV: 'production',
    });
    expect(cfg.minMs).toBe(100);
    expect(cfg.maxMs).toBe(200);
  });
});

const flush = () => new Promise<void>((r) => setImmediate(r));

/**
 * Release deferred `sleep` calls one think slice at a time until the pending
 * queue stays empty for a few flushes (the wait loop has finished).
 */
async function releaseAll(pending: Array<() => void>, max = 300): Promise<number> {
  let idle = 0;
  let released = 0;
  for (let i = 0; i < max; i++) {
    const waiters = pending.splice(0);
    if (waiters.length === 0) {
      await flush();
      if (++idle >= 3) return released;
      continue;
    }
    idle = 0;
    released += waiters.length;
    for (const w of waiters) w();
    await flush();
  }
  return released;
}

async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor timed out');
}

interface RunnerHarness {
  runner: BotRunner;
  client: FakeClient;
  sleeps: number[];
  events: RunnerActionEvent[];
  pending: Array<() => void>;
}

function buildRunner(
  policy: Policy,
  opts: {
    think?: Partial<ThinkConfig>;
    deadline?: number | null;
    policyIsLlm?: boolean;
    deferredSleep?: boolean;
    sleepImpl?: (ms: number) => Promise<void>;
    turn?: boolean;
  } = {},
): RunnerHarness {
  const db = openDb(':memory:');
  const client = new FakeClient();
  if (opts.deadline !== undefined) client.deadline = opts.deadline;
  if (opts.turn === false) client.turn = false;
  const sleeps: number[] = [];
  const events: RunnerActionEvent[] = [];
  const pending: Array<() => void> = [];
  const sleepImpl =
    opts.sleepImpl ??
    ((ms: number) => {
      sleeps.push(ms);
      if (opts.deferredSleep && ms >= 100) return new Promise<void>((r) => pending.push(r));
      return Promise.resolve();
    });
  const runner = new BotRunner(db, claimedBot('bot1'), {
    baseUrl: 'http://127.0.0.1:1',
    clientFactory: () => client as unknown as HeadlessClient,
    policy,
    policyIsLlm: opts.policyIsLlm,
    pollMs: 1,
    settleMs: 25,
    sleep: sleepImpl,
    rng: () => 0,
    think: opts.think ?? { ...THINK },
    onActionEvent: (e) => events.push(e),
  });
  return { runner, client, sleeps, events, pending };
}

const delayFrames = (sleeps: number[]) => sleeps.filter((s) => s >= 50);

describe('BotRunner buffer wait (policy -> wait -> send)', () => {
  it('runs the policy first, then waits before sending', async () => {
    const decide = vi.fn(() => ({
      action: { type: 'call' as const },
      reason: 'x',
      source: 'model' as const,
    }));
    const h = buildRunner({ name: 't', decide }, { deferredSleep: true, turn: false });
    await h.runner.start();
    await flush();
    h.sleeps.length = 0; // isolate startup sleeps (ensureSeated 25/50)

    h.client.turn = true;
    await waitFor(() => h.pending.length > 0);
    // The decision is already computed...
    expect(decide).toHaveBeenCalledTimes(1);
    // ...but nothing has been sent while the display wait is pending.
    expect(h.client.actCount).toBe(0);

    const released = await releaseAll(h.pending);
    expect(released).toBeGreaterThan(0);
    await waitFor(() => h.client.actCount === 1);
    expect(h.client.lastAction).toEqual({ type: 'call' });
    expect(h.events).toContainEqual({
      kind: 'sent',
      handId: 'h1',
      actionSeq: 1,
      seat: 0,
      source: 'model',
    });

    h.client.turn = false;
    h.client.live = false;
    await h.runner.stop();
  });

  it('cancels/shortens the wait when a slow policy has eaten the clock, and still sends', async () => {
    const h = buildRunner(
      {
        name: 't',
        decide: async () => {
          await new Promise((r) => setTimeout(r, 300));
          return { action: { type: 'call' as const }, reason: 'slow' };
        },
      },
      { deadline: Date.now() + 600, turn: false },
    );
    await h.runner.start();
    await flush();
    h.sleeps.length = 0;

    h.client.turn = true;
    await waitFor(() => h.client.actCount === 1, 3000);
    // The wait was capped to (remaining - 300) so it never reached the plan,
    // and crucially no deadline discard happened.
    expect(delayFrames(h.sleeps).reduce((a, b) => a + b, 0)).toBeLessThan(800);
    expect(h.events.some((e) => e.kind === 'discarded' && e.reason === 'deadline')).toBe(false);

    h.client.turn = false;
    h.client.live = false;
    await h.runner.stop();
  });

  it('drops a decision whose policy outlived the clock (the same as with no delay)', async () => {
    const h = buildRunner(
      {
        name: 't',
        decide: async () => {
          await new Promise((r) => setTimeout(r, 300));
          return { action: { type: 'call' as const }, reason: 'too slow' };
        },
      },
      { turn: false },
    );
    await h.runner.start();
    await flush();
    h.sleeps.length = 0;

    // Enough clock for the pre-policy guard, but the 300ms policy crosses it.
    h.client.deadline = Date.now() + 450;
    h.client.turn = true;
    await waitFor(() =>
      h.events.some((e) => e.kind === 'discarded' && e.reason === 'deadline'),
    );
    expect(h.client.actCount).toBe(0);
    // No display time was spent: the policy itself consumed the clock.
    expect(delayFrames(h.sleeps)).toHaveLength(0);

    h.client.turn = false;
    h.client.live = false;
    await h.runner.stop();
  });

  it('tightens the wait on a short clock but still sends the decision', async () => {
    const h = buildRunner(
      { name: 't', decide: () => ({ action: { type: 'call' }, reason: 'x' }) },
      { deadline: Date.now() + 1200, turn: false },
    );
    await h.runner.start();
    await flush();
    h.sleeps.length = 0;

    h.client.turn = true;
    await waitFor(() => h.client.actCount === 1);
    const waited = delayFrames(h.sleeps).reduce((a, b) => a + b, 0);
    expect(waited).toBeGreaterThan(0);
    expect(waited).toBeLessThan(800);

    h.client.turn = false;
    h.client.live = false;
    await h.runner.stop();
  });

  it('does not decide or act when the clock is already inside the guard', async () => {
    const decide = vi.fn(() => ({ action: { type: 'call' as const }, reason: 'x' }));
    const h = buildRunner({ name: 't', decide }, { deadline: Date.now() + 100, turn: false });
    await h.runner.start();
    await flush();
    h.sleeps.length = 0;

    h.client.turn = true;
    await new Promise((r) => setTimeout(r, 60));
    expect(decide).not.toHaveBeenCalled();
    expect(h.client.actCount).toBe(0);
    expect(delayFrames(h.sleeps)).toHaveLength(0);

    h.client.turn = false;
    h.client.live = false;
    await h.runner.stop();
  });

  it('applies no wait when disabled and keeps a fallback source', async () => {
    const h = buildRunner(
      { name: 't', decide: () => ({ action: { type: 'call' }, reason: 'x', source: 'fallback' }) },
      { think: { enabled: false }, turn: false },
    );
    await h.runner.start();
    await flush();
    h.sleeps.length = 0;

    h.client.turn = true;
    await waitFor(() => h.client.actCount === 1);
    expect(delayFrames(h.sleeps)).toHaveLength(0);
    expect(h.events).toContainEqual({
      kind: 'sent',
      handId: 'h1',
      actionSeq: 1,
      seat: 0,
      source: 'fallback',
    });

    h.client.turn = false;
    h.client.live = false;
    await h.runner.stop();
  });

  it('never waits for a policy explicitly marked as LLM', async () => {
    const h = buildRunner(
      { name: 'llm-local', decide: () => ({ action: { type: 'call' }, reason: 'x' }) },
      { policyIsLlm: true, turn: false },
    );
    await h.runner.start();
    await flush();
    h.sleeps.length = 0;

    h.client.turn = true;
    await waitFor(() => h.client.actCount === 1);
    expect(delayFrames(h.sleeps)).toHaveLength(0);

    h.client.turn = false;
    h.client.live = false;
    await h.runner.stop();
  });

  it('still waits for a local policy whose name merely looks like an LLM (no name heuristic)', async () => {
    const h = buildRunner(
      { name: 'llm-local', decide: () => ({ action: { type: 'call' }, reason: 'x' }) },
      { policyIsLlm: false, deferredSleep: true, turn: false },
    );
    await h.runner.start();
    await flush();
    h.sleeps.length = 0;

    h.client.turn = true;
    await waitFor(() => h.pending.length > 0);
    expect(h.client.actCount).toBe(0);

    await releaseAll(h.pending);
    await waitFor(() => h.client.actCount === 1);

    h.client.turn = false;
    h.client.live = false;
    await h.runner.stop();
  });

  it('abandons the wait on stop without sending the decision', async () => {
    const decide = vi.fn(() => ({ action: { type: 'call' as const }, reason: 'x' }));
    const h = buildRunner({ name: 't', decide }, { deferredSleep: true, turn: false });
    await h.runner.start();
    await flush();
    h.client.turn = true;
    await waitFor(() => h.pending.length > 0);

    h.client.turn = false; // avoid a graceful fold so we assert "nothing sent"
    h.client.live = false;
    const stopping = h.runner.stop();
    await releaseAll(h.pending);
    await stopping;

    expect(decide).toHaveBeenCalledTimes(1);
    expect(h.client.actCount).toBe(0);
  });

  it('abandons a mid-wait reconnect, then sends on the retry without waiting again', async () => {
    const decide = vi.fn(() => ({
      action: { type: 'call' as const },
      reason: 'x',
      source: 'model' as const,
    }));
    const h = buildRunner({ name: 't', decide }, { deferredSleep: true, turn: false });
    await h.runner.start();
    await flush();
    h.client.turn = true;
    await waitFor(() => h.pending.length > 0);

    h.client.connectionEpoch++; // reconnect during the display wait
    await releaseAll(h.pending);
    await waitFor(() =>
      h.events.some((e) => e.kind === 'discarded' && e.reason === 'reconnect'),
    );
    expect(h.events).toContainEqual({
      kind: 'discarded',
      handId: 'h1',
      actionSeq: 1,
      seat: 0,
      source: 'model',
      reason: 'reconnect',
    });

    // The retry of the same turn must not loop the delay: it sends at once.
    await waitFor(() => h.client.actCount === 1);
    expect(h.pending).toHaveLength(0);
    expect(decide).toHaveBeenCalledTimes(2);

    h.client.turn = false;
    h.client.live = false;
    await h.runner.stop();
  });

  it('abandons the wait when the turn advances', async () => {
    const decide = vi.fn(() => ({
      action: { type: 'call' as const },
      reason: 'x',
      source: 'model' as const,
    }));
    const h = buildRunner({ name: 't', decide }, { deferredSleep: true, turn: false });
    await h.runner.start();
    await flush();
    h.client.turn = true;
    await waitFor(() => h.pending.length > 0);

    h.client.actionSeq++; // the table moved on
    h.client.turn = false;
    await releaseAll(h.pending);
    await waitFor(() => h.events.some((e) => e.kind === 'discarded' && e.reason === 'stale'));

    expect(h.client.actCount).toBe(0);
    expect(h.events).toContainEqual({
      kind: 'discarded',
      handId: 'h1',
      actionSeq: 1,
      seat: 0,
      source: 'model',
      reason: 'stale',
    });

    h.client.live = false;
    await h.runner.stop();
  });

  it('abandons the wait when the hand changes', async () => {
    const decide = vi.fn(() => ({
      action: { type: 'call' as const },
      reason: 'x',
      source: 'model' as const,
    }));
    const h = buildRunner({ name: 't', decide }, { deferredSleep: true, turn: false });
    await h.runner.start();
    await flush();
    h.client.turn = true;
    await waitFor(() => h.pending.length > 0);

    h.client.handId = 'h2';
    h.client.turn = false;
    await releaseAll(h.pending);
    await waitFor(() => h.events.some((e) => e.kind === 'discarded' && e.reason === 'stale'));

    expect(h.client.actCount).toBe(0);

    h.client.live = false;
    await h.runner.stop();
  });

  it('yields to the server timeout when timer overshoot eats the clock', async () => {
    const decide = vi.fn(() => ({
      action: { type: 'call' as const },
      reason: 'x',
      source: 'model' as const,
    }));
    const sleeps: number[] = [];
    const events: RunnerActionEvent[] = [];
    const db = openDb(':memory:');
    const client = new FakeClient();
    client.turn = false;
    client.deadline = Date.now() + 1500;
    const runner = new BotRunner(db, claimedBot('bot1'), {
      baseUrl: 'http://127.0.0.1:1',
      clientFactory: () => client as unknown as HeadlessClient,
      policy: { name: 't', decide },
      pollMs: 1,
      settleMs: 25,
      sleep: (ms) => {
        sleeps.push(ms);
        // Each slice runs ~400ms long: 300ms of overshoot beyond the slice.
        client.deadline = (client.deadline ?? 0) - 400;
        return Promise.resolve();
      },
      rng: () => 0,
      // Injected long on purpose: the default buffer is far too short for a
      // 400ms-per-slice overshoot to eat a 1500ms clock. This test still needs a
      // wait long enough to exercise the budget/overshoot cancellation path.
      think: { enabled: true, minMs: 1000, maxMs: 1000 },
      onActionEvent: (e) => events.push(e),
    });
    await runner.start();
    await flush();
    sleeps.length = 0;
    client.turn = true;
    await waitFor(() => events.some((e) => e.kind === 'discarded' && e.reason === 'deadline'));

    // The policy ran first; only the buffer wait crossed the clock.
    expect(decide).toHaveBeenCalledTimes(1);
    expect(client.actCount).toBe(0);

    client.turn = false;
    client.live = false;
    await runner.stop();
  });
});

describe('think delay against a real 5s room', () => {
  it('never records a timeout fold or a deadline rejection', async () => {
    const ctx = createApp(':memory:');
    attachHub(ctx.app, ctx.db, {
      cryptoTimeoutMs: 2500,
      actionTimeoutMs: 5000,
      autoDealMs: 60_000,
      readyCheckMs: 2000,
    });
    const baseUrl = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const routed: RunnerActionEvent[] = [];
    const supervisor = new BotSupervisor(ctx.db, {
      baseUrl,
      maxConcurrent: 2,
      runner: {
        graceMs: 10_000,
        pollMs: 25,
        onActionEvent: (e) => routed.push(e),
        think: { enabled: true, minMs: 300, maxMs: 300 },
        rng: () => 0,
      },
      log: () => {},
    });
    ctx.botControl.hooks = supervisor;
    const human = new HeadlessClient(baseUrl, `h${randomBytes(3).toString('hex')}`, 'hunter2');
    try {
      await human.login();
      const room = (await human.api('/api/rooms', { name: 'Think 5s', sb: 10, bb: 20 }, 'POST')) as {
        id: string;
      };
      await human.connect(room.id);
      human.send({ t: 'sit', seat: 0 });
      // auto-approval is on by default, so the buy funds the sitter immediately
      await human.api(`/api/rooms/${room.id}/buy`, { amount: 1000 });
      const bot = (await human.api(`/api/rooms/${room.id}/bots`, {
        seat: 1,
        initialBuyIn: 1000,
        policyKind: 'scripted',
        name: 'Robo',
      })) as { bot: { id: string; userId: number; seat: number } };
      await human.api(`/api/rooms/${room.id}/bots/${bot.bot.id}/start`, {});
      await waitFor(() => {
        const row = ctx.db
          .prepare('SELECT status FROM bot_accounts WHERE id = ?')
          .get(bot.bot.id) as { status?: string } | undefined;
        const p = human.room?.players.find((x) => x.userId === bot.bot.userId);
        return row?.status === 'running' && !!p && p.connected && p.stack > 0;
      }, 15_000);

      human.send({ t: 'start_hand' });
      const driving = (async () => {
        const end = Date.now() + 25_000;
        while (Date.now() < end && !human.result && !human.abort) {
          await human.waitForTurn(100);
          if (human.result || human.abort) break;
          if (!human.isResynced || !human.myTurn()) continue;
          const v = buildDecisionView(human);
          if (!v.legalActions) continue;
          try {
            human.act({ type: v.legalActions.canCheck ? 'check' : 'call' });
          } catch {
            // the table advanced between the check and the send
          }
        }
      })();
      await waitFor(() => human.result !== null || human.abort !== null, 25_000);
      await driving;

      expect(human.abort).toBeNull();
      const handId = human.result!.handId;
      const timeoutFolds = ctx.db
        .prepare(
          "SELECT COUNT(*) AS c FROM hand_actions WHERE hand_id = ? AND action_type = 'timeout_fold'",
        )
        .get(handId) as { c: number };
      expect(timeoutFolds.c).toBe(0);
      expect(routed.filter((e) => e.kind === 'discarded' && e.reason === 'deadline')).toHaveLength(
        0,
      );
      expect(routed.some((e) => e.kind === 'sent' && e.seat === bot.bot.seat)).toBe(true);
    } finally {
      await supervisor.stopAll().catch(() => {});
      human.close();
      await ctx.app.close();
    }
  }, 40_000);
});
