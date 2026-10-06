import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeadlessClient, LlmPolicy, type Policy } from '@4am/agent-core';
import type { DB } from '../src/db.js';
import { openDb } from '../src/db.js';
import { BotRunner } from '../src/botRunner.js';
import type { BotRow, ClaimedBot } from '../src/botRoutes.js';
import { activeHands } from '../src/liveHands.js';
import { FakeClient, sleep } from './helpers/fakeBotClient.js';

/**
 * Unit tests for the Phase 1b runner. The real WS/HeadlessClient is replaced by
 * a fake via the `clientFactory` seam, so these exercise only the decision
 * loop's contracts: single-flight, stale-snapshot re-check, start/stop
 * cancellation, and fail-closed on a policy exception or an illegal action.
 */

const KEY = 'ab'.repeat(32);
const ORIGINAL_KEY = process.env.BOT_IDENTITY_KEY;

function claimedBot(botId = 'bot1', seat = 0): ClaimedBot {
  const bot: BotRow = {
    id: botId,
    room_id: 'room1',
    owner_id: 1,
    user_id: 2,
    status: 'running',
    policy_kind: 'scripted',
    policy_json: null,
    difficulty: 'low',
    seat,
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
    policyKind: 'scripted',
    policyJson: null,
    difficulty: 'low',
  };
}

function insertBotRow(db: DB, botId: string, status: string): void {
  db.prepare(
    `INSERT INTO bot_accounts
       (id, room_id, owner_id, user_id, status, policy_kind, policy_json, seat, created_at, updated_at)
     VALUES (?, 'room1', 1, 2, ?, 'scripted', NULL, 0, 0, 0)`,
  ).run(botId, status);
}

function statusOf(db: DB, botId: string): string {
  return (db.prepare('SELECT status FROM bot_accounts WHERE id = ?').get(botId) as { status: string })
    .status;
}

async function waitFor(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(10);
  }
  throw new Error('waitFor timed out');
}

function makeRunner(
  db: DB,
  client: FakeClient,
  policy: Policy,
  botId = 'bot1',
): BotRunner {
  return new BotRunner(db, claimedBot(botId), {
    baseUrl: 'http://127.0.0.1:1',
    clientFactory: () => client as unknown as HeadlessClient,
    policy,
    pollMs: 1,
    settleMs: 25,
  });
}

beforeEach(() => {
  process.env.BOT_IDENTITY_KEY = KEY;
});
afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.BOT_IDENTITY_KEY;
  else process.env.BOT_IDENTITY_KEY = ORIGINAL_KEY;
});

describe('BotRunner decision loop', () => {
  it('sits back in and readies on connect (a restart after a graceful stop plays again)', async () => {
    const db = openDb(':memory:');
    const client = new FakeClient();
    const runner = makeRunner(db, client, { name: 't', decide: async () => ({ action: { type: 'fold' as const }, reason: 'x' }) });
    await runner.start();
    expect(client.sent).toContainEqual({ t: 'sit_out', sittingOut: false });
    expect(client.sent).toContainEqual({ t: 'im_ready' });
    client.turn = false;
    client.live = false;
    await runner.stop();
  });

  it('cancels startup and closes the socket when stop races start', async () => {
    const db = openDb(':memory:');
    const client = new FakeClient();
    client.live = false; // no hand: the cancelled startup should wind down and close
    let releaseLogin!: () => void;
    client.loginBlock = new Promise<void>((resolve) => {
      releaseLogin = resolve;
    });
    const runner = makeRunner(db, client, {
      name: 't',
      decide: async () => ({ action: { type: 'fold' as const }, reason: 'x' }),
    });

    const started = runner.start(); // blocks inside loginWithGrant
    const stopped = runner.stop(); // stop lands while startup is in flight
    releaseLogin();
    await started;
    await stopped;

    expect(client.closed).toBe(true);
    // Cancellation was observed before any further protocol message went out.
    expect(client.sent).toEqual([]);
  });

  it('resolves the persisted style and logs (never throws on) invalid policy_json', async () => {
    const db = openDb(':memory:');
    const client = new FakeClient();
    client.turn = false;
    client.live = false;
    const logs: string[] = [];
    const claim = claimedBot('bot1');
    claim.policyKind = 'loose-aggressive';
    claim.policyJson = '{not json';
    const runner = new BotRunner(db, claim, {
      baseUrl: 'http://127.0.0.1:1',
      clientFactory: () => client as unknown as HeadlessClient,
      pollMs: 1,
      settleMs: 25,
      log: (l) => logs.push(l),
    });
    expect(logs.join(' ')).toMatch(/not valid JSON/);
    await runner.start();
    await runner.stop();
  });

  it('dispatches on the claimed difficulty: medium selects rules-v1', () => {
    const logs: string[] = [];
    const claim = claimedBot('bot1');
    claim.policyKind = 'scripted';
    claim.difficulty = 'medium';
    new BotRunner(openDb(':memory:'), claim, {
      baseUrl: 'http://127.0.0.1:1',
      clientFactory: () => new FakeClient() as unknown as HeadlessClient,
      log: (l) => logs.push(l),
    });
    expect(logs.join(' ')).toMatch(/policy rules-v1 selected \(kind tight-aggressive, difficulty medium\)/);
  });

  it('reports the withdrawn high difficulty at runner startup', () => {
    const logs: string[] = [];
    const claim = claimedBot('bot1');
    claim.difficulty = 'high';
    new BotRunner(openDb(':memory:'), claim, {
      baseUrl: 'http://127.0.0.1:1',
      clientFactory: () => new FakeClient() as unknown as HeadlessClient,
      log: (l) => logs.push(l),
    });
    // A legacy `high` is still read and reported as withdrawn, then runs the
    // default medium (rules-v1) engine. Core's `downgraded` is always false now,
    // so no separate downgrade marker is emitted.
    expect(logs.join(' ')).toMatch(/withdrawn/);
    expect(logs.join(' ')).toMatch(/policy rules-v1 selected \(kind tight-aggressive, difficulty medium\)/);
    expect(logs.join(' ')).not.toMatch(/downgraded=true/);
  });

  it('keeps llm priority over difficulty at runner startup', () => {
    const logs: string[] = [];
    const claim = claimedBot('bot1');
    claim.policyKind = 'llm';
    claim.difficulty = 'medium';
    new BotRunner(openDb(':memory:'), claim, {
      baseUrl: 'http://127.0.0.1:1',
      clientFactory: () => new FakeClient() as unknown as HeadlessClient,
      log: (l) => logs.push(l),
    });
    // LLM wins; the effective tier is still reported but never swaps the policy.
    expect(logs.join(' ')).toMatch(/policy llm-deepseek-flash selected \(kind llm, difficulty medium\)/);
    expect(logs.join(' ')).not.toMatch(/rules-v1 selected/);
  });

  it('falls back to the default style for an unknown policyKind', () => {
    const logs: string[] = [];
    const claim = claimedBot('bot1');
    claim.policyKind = 'mystery-style';
    new BotRunner(openDb(':memory:'), claim, {
      baseUrl: 'http://127.0.0.1:1',
      clientFactory: () => new FakeClient() as unknown as HeadlessClient,
      log: (l) => logs.push(l),
    });
    expect(logs.join(' ')).toMatch(/unknown policyKind/);
  });

  it('keeps the socket open while the server has an active hand, despite a stale terminal frame', async () => {
    const db = openDb(':memory:');
    const client = new FakeClient();
    // Stale terminal from the previous hand, still cached on the client, and
    // the client is not locally mid-hand.
    client.handId = 'old-hand';
    client.result = { deltas: [] };
    client.live = false;
    const runner = makeRunner(db, client, {
      name: 't',
      decide: async () => ({ action: { type: 'fold' as const }, reason: 'x' }),
    });
    await runner.start();

    // The server has already started the NEXT hand (activeHands set before the
    // new hand_start is broadcast), but the client has not cleared `result`.
    activeHands.add('room1');
    try {
      const stopping = runner.stop();
      await sleep(80);
      // The stale terminal must NOT license leaving while the server is active.
      expect(client.closed).toBe(false);
      expect(client.sent).not.toContainEqual({ t: 'sit_out', sittingOut: true });

      // Only once the server confirms no active hand may stop complete.
      activeHands.delete('room1');
      await stopping;
      expect(client.closed).toBe(true);
      expect(client.sent).toContainEqual({ t: 'sit_out', sittingOut: true });
    } finally {
      activeHands.delete('room1');
    }
  });

  it('skips acting when the action clock is already too close, and recovers next turn', async () => {
    const db = openDb(':memory:');
    const client = new FakeClient();
    client.deadline = Date.now() + 50;
    const decide = vi.fn(async () => ({ action: { type: 'call' as const }, reason: 'x' }));
    const runner = makeRunner(db, client, { name: 't', decide });
    await runner.start();
    await sleep(80);
    // Pre-policy guard: the policy is never even consulted.
    expect(client.actCount).toBe(0);
    expect(decide).not.toHaveBeenCalled();

    // A fresh clock later must not be blocked by the previous skip.
    client.deadline = Date.now() + 10_000;
    await waitFor(() => client.actCount === 1);
    client.turn = false;
    client.live = false;
    await runner.stop();
  });

  it('re-checks the clock after a slow policy and drops the late action', async () => {
    const db = openDb(':memory:');
    const client = new FakeClient();
    client.deadline = Date.now() + 10_000;
    let first = true;
    const decide = vi.fn(async () => {
      if (first) {
        first = false;
        // A slow (Monte-Carlo) policy burns the remaining time mid-decision.
        client.deadline = Date.now() + 50;
      }
      return { action: { type: 'call' as const }, reason: 'slow' };
    });
    const runner = makeRunner(db, client, { name: 't', decide });
    await runner.start();
    await waitFor(() => decide.mock.calls.length >= 1);
    await sleep(40);
    expect(client.actCount).toBe(0); // post-policy guard skipped the late send

    // Next turn (new actionSeq) with time left: the loop is not stuck.
    client.actionSeq = 2;
    client.deadline = Date.now() + 10_000;
    await waitFor(() => client.actCount === 1);
    client.turn = false;
    client.live = false;
    await runner.stop();
  });

  it('sends at most one action per handId+actionSeq while the snapshot is stale', async () => {
    const db = openDb(':memory:');
    const client = new FakeClient();
    const decide = vi.fn(async () => ({ action: { type: 'call' as const }, reason: 'x' }));
    const runner = makeRunner(db, client, { name: 't', decide });

    await runner.start();
    await sleep(40);
    expect(client.actCount).toBe(1);
    expect(decide).toHaveBeenCalledTimes(1);

    // The table advances: same bot, new actionSeq -> a new decision is allowed.
    client.actionSeq = 2;
    await waitFor(() => client.actCount === 2);
    expect(decide).toHaveBeenCalledTimes(2);

    client.turn = false;
    client.live = false;
    await runner.stop();
  });

  it('marks the bot error and stops the runner when the policy throws', async () => {
    const db = openDb(':memory:');
    insertBotRow(db, 'bot1', 'running');
    const client = new FakeClient();
    const policy: Policy = {
      name: 'boom',
      decide: async () => {
        throw new Error('policy blew up');
      },
    };
    const runner = makeRunner(db, client, policy);

    await runner.start();
    await waitFor(() => statusOf(db, 'bot1') === 'error');
    expect(statusOf(db, 'bot1')).toBe('error');
    await runner.stop();
  });

  it('fails closed on a fatal during an active hand (immediate error + close)', async () => {
    const db = openDb(':memory:');
    insertBotRow(db, 'bot1', 'running');
    const client = new FakeClient();
    const runner = makeRunner(db, client, {
      name: 'boom',
      decide: async () => {
        throw new Error('boom');
      },
    });
    // The server still has a hand running; the fatal contract is fail-closed and
    // deliberately does not wind down gracefully (see BotRunner.fail).
    activeHands.add('room1');
    try {
      await runner.start();
      await waitFor(() => statusOf(db, 'bot1') === 'error');
      await waitFor(() => client.closed);
      expect(client.closed).toBe(true);
      expect(client.sent).not.toContainEqual({ t: 'sit_out', sittingOut: true });
    } finally {
      activeHands.delete('room1');
      await runner.stop();
    }
  });

  it('marks the bot error when the table rejects the action as illegal', async () => {
    const db = openDb(':memory:');
    insertBotRow(db, 'bot1', 'running');
    const client = new FakeClient();
    client.throwOnAct = true;
    const runner = makeRunner(db, client, {
      name: 't',
      decide: async () => ({ action: { type: 'raise', amount: 999999 }, reason: 'oops' }),
    });

    await runner.start();
    await waitFor(() => statusOf(db, 'bot1') === 'error');
    expect(statusOf(db, 'bot1')).toBe('error');
    await runner.stop();
  });

  it('folds on its turn once a stop is requested instead of playing on', async () => {
    const db = openDb(':memory:');
    const client = new FakeClient();
    const decide = vi.fn(async () => ({ action: { type: 'check' as const }, reason: 'x' }));
    const runner = makeRunner(db, client, { name: 't', decide });
    await runner.start();
    await waitFor(() => client.actCount === 1);

    // Keep the hand live but request stop: the loop must fold, not run policy.
    const stopPromise = runner.stop();
    await waitFor(() => client.actCount >= 2);
    expect(client.lastAction).toEqual({ type: 'fold' });
    client.live = false;
    await stopPromise;
  });

  it('awaits an async LLM decision before sending the action', async () => {
    const db = openDb(':memory:');
    const client = new FakeClient();
    const decide = vi.fn(async () => {
      await sleep(5);
      return { action: { type: 'call' as const }, reason: 'async llm' };
    });
    const runner = makeRunner(db, client, { name: 'async-llm', decide });
    await runner.start();
    await waitFor(() => client.actCount === 1);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(client.lastAction).toEqual({ type: 'call' });
    client.turn = false;
    client.live = false;
    await runner.stop();
  });

  it('falls back to the local action when the LLM request times out (no bot error)', async () => {
    const db = openDb(':memory:');
    insertBotRow(db, 'bot1', 'running');
    const client = new FakeClient();
    let fetchCalls = 0;
    const llmFetch = ((_url: string, init?: RequestInit) => {
      fetchCalls++;
      return new Promise<Response>((_resolve, reject) => {
        (init?.signal as AbortSignal | undefined)?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }) as unknown as typeof globalThis.fetch;
    const policy = new LlmPolicy({
      apiKey: 'k',
      baseUrl: 'http://llm.test/v1',
      model: 'm',
      timeoutMs: 5,
      maxCallsPerHand: 5,
      fallback: { name: 'fb', decide: () => ({ action: { type: 'call' }, reason: 'local' }) },
      fetch: llmFetch,
    });
    const runner = makeRunner(db, client, policy);
    await runner.start();
    await waitFor(() => client.actCount === 1);
    expect(client.lastAction).toEqual({ type: 'call' });
    expect(statusOf(db, 'bot1')).toBe('running');
    expect(fetchCalls).toBeGreaterThanOrEqual(1);
    client.turn = false;
    client.live = false;
    await runner.stop();
  });

  it('reports the routed source of each action actually sent', async () => {
    const db = openDb(':memory:');
    const client = new FakeClient();
    const events: import('../src/botRunner.js').RunnerActionEvent[] = [];
    const runner = new BotRunner(db, claimedBot('bot1'), {
      baseUrl: 'http://127.0.0.1:1',
      clientFactory: () => client as unknown as HeadlessClient,
      policy: { name: 'm', decide: () => ({ action: { type: 'call' }, reason: 'x', source: 'model' }) },
      pollMs: 1,
      settleMs: 25,
      onActionEvent: (e) => events.push(e),
    });
    await runner.start();
    await waitFor(() => client.actCount === 1);
    expect(events).toContainEqual({
      kind: 'sent',
      handId: 'h1',
      actionSeq: 1,
      seat: 0,
      source: 'model',
    });
    client.turn = false;
    client.live = false;
    await runner.stop();
  });

  it('reports a model decision dropped after a slow policy as a deadline discard', async () => {
    const db = openDb(':memory:');
    const client = new FakeClient();
    client.deadline = Date.now() + 10_000;
    const events: import('../src/botRunner.js').RunnerActionEvent[] = [];
    const decide = vi.fn(async () => {
      client.deadline = Date.now() + 50; // the policy burned the clock
      return { action: { type: 'call' as const }, reason: 'slow', source: 'model' as const };
    });
    const runner = new BotRunner(db, claimedBot('bot1'), {
      baseUrl: 'http://127.0.0.1:1',
      clientFactory: () => client as unknown as HeadlessClient,
      policy: { name: 't', decide },
      pollMs: 1,
      settleMs: 25,
      onActionEvent: (e) => events.push(e),
    });
    await runner.start();
    await waitFor(() => events.some((e) => e.kind === 'discarded'));
    expect(events).toContainEqual({
      kind: 'discarded',
      handId: 'h1',
      actionSeq: 1,
      seat: 0,
      source: 'model',
      reason: 'deadline',
    });
    expect(client.actCount).toBe(0);
    client.turn = false;
    client.live = false;
    await runner.stop();
  });

  it('reports a model decision dropped because the turn moved on as a stale discard', async () => {
    const db = openDb(':memory:');
    const client = new FakeClient();
    client.deadline = Date.now() + 10_000;
    const events: import('../src/botRunner.js').RunnerActionEvent[] = [];
    const decide = vi.fn(async () => {
      client.actionSeq = 2; // the table advanced while the policy thought
      return { action: { type: 'call' as const }, reason: 'stale', source: 'model' as const };
    });
    const runner = new BotRunner(db, claimedBot('bot1'), {
      baseUrl: 'http://127.0.0.1:1',
      clientFactory: () => client as unknown as HeadlessClient,
      policy: { name: 't', decide },
      pollMs: 1,
      settleMs: 25,
      onActionEvent: (e) => events.push(e),
    });
    await runner.start();
    await waitFor(() => events.some((e) => e.kind === 'discarded' && e.reason === 'stale'));
    expect(events).toContainEqual({
      kind: 'discarded',
      handId: 'h1',
      actionSeq: 1,
      seat: 0,
      source: 'model',
      reason: 'stale',
    });
    client.turn = false;
    client.live = false;
    await runner.stop();
  });

  it('voids a decision whose connection epoch changed during the policy call', async () => {
    const db = openDb(':memory:');
    const client = new FakeClient();
    client.deadline = Date.now() + 10_000;
    const events: import('../src/botRunner.js').RunnerActionEvent[] = [];
    const decide = vi.fn(async () => {
      // A reconnect happened while the policy was thinking: the resynced state
      // may be the same hand/actionSeq, so the epoch alone proves the gap.
      client.connectionEpoch++;
      return { action: { type: 'call' as const }, reason: 'stale-conn', source: 'model' as const };
    });
    const runner = new BotRunner(db, claimedBot('bot1'), {
      baseUrl: 'http://127.0.0.1:1',
      clientFactory: () => client as unknown as HeadlessClient,
      policy: { name: 't', decide },
      pollMs: 1,
      settleMs: 25,
      onActionEvent: (e) => events.push(e),
    });
    await runner.start();
    await waitFor(() => events.some((e) => e.kind === 'discarded'));
    expect(events).toContainEqual({
      kind: 'discarded',
      handId: 'h1',
      actionSeq: 1,
      seat: 0,
      source: 'model',
      reason: 'reconnect',
    });
    expect(client.actCount).toBe(0);
    client.turn = false;
    client.live = false;
    await runner.stop();
  });

  it('does not consult the policy while the socket is down', async () => {
    const db = openDb(':memory:');
    const client = new FakeClient();
    client.connected = false;
    const decide = vi.fn(async () => ({ action: { type: 'call' as const }, reason: 'x' }));
    const runner = makeRunner(db, client, { name: 't', decide });
    await runner.start();
    await sleep(60);
    expect(decide).not.toHaveBeenCalled();
    expect(client.actCount).toBe(0);

    // Once the socket resyncs, a normal decision resumes.
    client.connected = true;
    await waitFor(() => client.actCount === 1);
    client.turn = false;
    client.live = false;
    await runner.stop();
  });

  it('does not consult the policy after an explicit client close()', async () => {
    const db = openDb(':memory:');
    const client = new FakeClient();
    const decide = vi.fn(async () => ({ action: { type: 'call' as const }, reason: 'x' }));
    const runner = makeRunner(db, client, { name: 't', decide });
    await runner.start();
    // One normal decision while connected...
    await waitFor(() => client.actCount === 1);
    const decideCalls = decide.mock.calls.length;

    // ...then a deliberate close must immediately invalidate the connection:
    // no further policy consultation or send until a new socket resyncs.
    client.turn = false; // avoid the graceful-fold path on stop
    client.close();
    await sleep(60);
    expect(decide.mock.calls.length).toBe(decideCalls);
    expect(client.actCount).toBe(1);

    client.turn = false;
    client.live = false;
    await runner.stop();
  });

  it('does not consult the policy in the open->room_state window of a new epoch', async () => {
    const db = openDb(':memory:');
    const client = new FakeClient();
    // The critical window: the socket is open (`connected` true) and a new
    // connection epoch began, but this epoch's `room_state` has not arrived, so
    // the cached turn is the PRE-reconnect one. `myTurn()` still reads true.
    client.connectionEpoch = 1;
    client.isResynced = false;
    client.turn = true;
    const decide = vi.fn(async () => ({ action: { type: 'call' as const }, reason: 'x' }));
    const runner = makeRunner(db, client, { name: 't', decide });
    await runner.start();
    await sleep(60);
    // The stale cache must not license a decision or a send.
    expect(decide).not.toHaveBeenCalled();
    expect(client.actCount).toBe(0);

    // This epoch's room_state lands: the snapshot is resynced and a normal
    // decision proceeds.
    client.isResynced = true;
    await waitFor(() => client.actCount === 1);
    expect(decide).toHaveBeenCalledTimes(1);
    client.turn = false;
    client.live = false;
    await runner.stop();
  });

  it('does not fold through a stale connection during graceful stop', async () => {
    const db = openDb(':memory:');
    const client = new FakeClient();
    client.connected = true;
    client.isResynced = false; // open, but this epoch is not resynced
    client.turn = true; // a bare client would fold here
    const decide = vi.fn(async () => ({ action: { type: 'call' as const }, reason: 'x' }));
    const runner = makeRunner(db, client, { name: 't', decide });
    await runner.start();
    await sleep(40);
    expect(decide).not.toHaveBeenCalled();

    // Graceful stop runs `foldIfMyTurn`; it must obey the same resync gate.
    const stop = runner.stop();
    await sleep(60);
    client.turn = false;
    client.live = false; // let the wind-down confirm "no active hand" and exit
    await stop;

    expect(client.actCount).toBe(0);
  });

  it('keeps a live-hand reconnect gated until the authoritative betting_state arrives', async () => {
    const db = openDb(':memory:');
    const client = new FakeClient();
    // A new epoch whose room_state reported a live hand, but whose replayed
    // betting_state has not landed yet: the turn gate must stay closed even
    // though the cached snapshot still reads "our turn".
    client.connectionEpoch = 1;
    client.isResynced = false;
    client.turn = true;
    const decide = vi.fn(async () => ({ action: { type: 'call' as const }, reason: 'x' }));
    const runner = makeRunner(db, client, { name: 't', decide });
    await runner.start();
    await sleep(60);
    expect(decide).not.toHaveBeenCalled();
    expect(client.actCount).toBe(0);

    // The replayed betting_state lands: the gate opens and a normal decision runs.
    client.isResynced = true;
    await waitFor(() => client.actCount === 1);
    expect(decide).toHaveBeenCalledTimes(1);
    client.turn = false;
    client.live = false;
    await runner.stop();
  });

  it('classifies a hand change during the policy as stale, not deadline', async () => {
    const db = openDb(':memory:');
    const client = new FakeClient();
    client.deadline = Date.now() + 10_000;
    const events: import('../src/botRunner.js').RunnerActionEvent[] = [];
    const decide = vi.fn(async () => {
      // The hand ended and a new one began while the policy was thinking; the
      // new hand's clock would otherwise look like a deadline drop.
      client.handId = 'h2';
      client.deadline = Date.now() + 50;
      return { action: { type: 'call' as const }, reason: 'next hand', source: 'model' as const };
    });
    const runner = new BotRunner(db, claimedBot('bot1'), {
      baseUrl: 'http://127.0.0.1:1',
      clientFactory: () => client as unknown as HeadlessClient,
      policy: { name: 't', decide },
      pollMs: 1,
      settleMs: 25,
      onActionEvent: (e) => events.push(e),
    });
    await runner.start();
    await waitFor(() => events.some((e) => e.kind === 'discarded'));
    expect(events).toContainEqual({
      kind: 'discarded',
      handId: 'h1',
      actionSeq: 1,
      seat: 0,
      source: 'model',
      reason: 'stale',
    });
    expect(events.some((e) => e.kind === 'discarded' && e.reason === 'deadline')).toBe(false);
    expect(client.actCount).toBe(0);
    client.turn = false;
    client.live = false;
    await runner.stop();
  });

  it('falls back locally when the LLM has too little deadline left', async () => {
    const db = openDb(':memory:');
    const client = new FakeClient();
    client.turn = false; // gate the loop until the short deadline is installed
    let fetchCalls = 0;
    const policy = new LlmPolicy({
      apiKey: 'k',
      baseUrl: 'http://llm.test/v1',
      model: 'm',
      timeoutMs: 2_000,
      maxCallsPerHand: 5,
      fallback: { name: 'fb', decide: () => ({ action: { type: 'call' }, reason: 'local' }) },
      fetch: (() => {
        fetchCalls++;
        return Promise.resolve(new Response('{}', { status: 200 }));
      }) as unknown as typeof globalThis.fetch,
    });
    const runner = makeRunner(db, client, policy);
    await runner.start();

    // Remaining clock is below the LLM margin but above the runner's guard, so
    // the runner consults the policy and the policy skips the network.
    client.deadline = Date.now() + 280;
    client.turn = true;
    await waitFor(() => client.actCount === 1);
    expect(client.lastAction).toEqual({ type: 'call' });
    expect(fetchCalls).toBe(0);

    client.turn = false;
    client.live = false;
    await runner.stop();
  });
});
