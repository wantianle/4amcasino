import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HeadlessClient, ScriptedPolicy, buildDecisionView, type Policy } from '@4am/agent-core';
import { createApp } from '../src/app.js';
import { attachHub } from '../src/hub.js';
import { BotRunner, type BotRunnerOptions, type RunnerActionEvent } from '../src/botRunner.js';
import { claimStartingBot } from '../src/botRoutes.js';

/**
 * Fault injection on the BOT RUNNER'S OWN socket (not an observer): the runner
 * is built directly on a real `HeadlessClient` we hold, so we can drop its
 * socket mid-hand and prove the reconnect path keeps the hand coherent.
 */

const KEY = 'ab'.repeat(32);
const ORIGINAL_KEY = process.env.BOT_IDENTITY_KEY;

let ctx: ReturnType<typeof createApp>;
let baseUrl: string;
let human: HeadlessClient;
let runner: BotRunner | null = null;
let botClient: HeadlessClient;
let routed: RunnerActionEvent[] = [];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(fn: () => boolean, timeoutMs = 20000, label = ''): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(15);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function botStatus(botId: string): string | null {
  const row = ctx.db.prepare('SELECT status FROM bot_accounts WHERE id = ?').get(botId) as
    | { status: string }
    | undefined;
  return row?.status ?? null;
}

async function createTable() {
  const room = (await human.api('/api/rooms', { name: 'Reconnect Table', sb: 10, bb: 20 }, 'POST')) as {
    id: string;
    joinCode: string;
  };
  await human.connect(room.id);
  human.send({ t: 'sit', seat: 0 });
  // auto-approval is on by default, so the buy funds the sitter immediately
  await human.api(`/api/rooms/${room.id}/buy`, { amount: 4000 });
  const bot = (await human.api(`/api/rooms/${room.id}/bots`, {
    seat: 1,
    initialBuyIn: 4000,
    policyKind: 'scripted',
    name: 'Robo',
  })) as { bot: { id: string; userId: number; seat: number } };
  return { room, bot: bot.bot };
}

async function startRunner(
  roomId: string,
  bot: { id: string },
  opts: { policy?: Policy } = {},
): Promise<void> {
  // No supervisor attached: the start route parks the bot in `starting` and we
  // claim it ourselves, so we control the runner's client instance.
  await human.api(`/api/rooms/${roomId}/bots/${bot.id}/start`, {});
  const claim = claimStartingBot(ctx.db, bot.id);
  if (!claim) throw new Error('claimStartingBot returned null');
  botClient = new HeadlessClient(baseUrl, `bot_${randomBytes(3).toString('hex')}`, 'x');
  const runnerOpts: BotRunnerOptions = {
    baseUrl,
    clientFactory: () => botClient,
    policy: opts.policy ?? new ScriptedPolicy(),
    pollMs: 25,
    graceMs: 4_000,
    onActionEvent: (e) => routed.push(e),
  };
  runner = new BotRunner(ctx.db, claim, runnerOpts);
  await runner.start();
}

/** Drop the runner's live socket WITHOUT marking it as a deliberate close. */
function dropRunnerSocket(): void {
  (botClient as unknown as { ws: { close(): void } | null }).ws?.close();
}

function driveHuman(maxMs: number): Promise<void> {
  return (async () => {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline && !human.result && !human.abort) {
      await human.waitForTurn(100);
      if (human.result || human.abort) break;
      if (!human.isResynced) continue;
      if (!human.myTurn()) continue;
      const view = buildDecisionView(human);
      if (!view.legalActions) continue;
      try {
        human.act({ type: view.legalActions.canCheck ? 'check' : 'call' });
      } catch {
        // the table advanced between the check and the send
      }
    }
  })();
}

function uniqueSentKeys(): boolean {
  const keys = routed.filter((e) => e.kind === 'sent').map((e) => `${e.handId}:${e.actionSeq}`);
  return new Set(keys).size === keys.length;
}

/** Parse the persisted transcript and prove the accepted action sequence is complete. */
function assertTranscriptComplete(handId: string): void {
  const row = ctx.db
    .prepare('SELECT entries FROM transcripts WHERE hand_id = ?')
    .get(handId) as { entries: string } | undefined;
  expect(row).toBeTruthy();
  const entries = JSON.parse(row!.entries) as {
    type: string;
    payload: { actionSeq?: number; seat: number };
  }[];
  const actions = entries.filter((e) => e.type === 'action');
  expect(actions.length).toBeGreaterThan(0);
  const seqs = actions.map((a) => a.payload.actionSeq) as number[];
  for (const s of seqs) expect(Number.isInteger(s)).toBe(true);

  const sorted = [...seqs].sort((a, b) => a - b);
  // No duplicate...
  expect(new Set(sorted).size).toBe(sorted.length);
  // ...and no gap: the server's action index is a dense run from the hand's
  // first accepted action, so a missing action would appear as a jump.
  for (let i = 1; i < sorted.length; i++) expect(sorted[i]).toBe(sorted[i - 1]! + 1);
  // A hand played from its start in a fresh room begins at index 0.
  expect(sorted[0]).toBe(0);
}

/** Ledger verifies and every stack equals the sum of that player's ledger deltas. */
async function assertLedgerConservation(roomId: string): Promise<void> {
  const ledger = (await human.api(`/api/rooms/${roomId}/ledger`)) as {
    verified: { ok: boolean };
  };
  expect(ledger.verified.ok).toBe(true);

  const roster = ctx.db
    .prepare('SELECT user_id, stack FROM room_players WHERE room_id = ?')
    .all(roomId) as { user_id: number; stack: number }[];
  for (const p of roster) {
    const sum = (
      ctx.db
        .prepare('SELECT COALESCE(SUM(delta),0) AS s FROM ledger WHERE room_id = ? AND user_id = ?')
        .get(roomId, p.user_id) as { s: number }
    ).s;
    expect(p.stack).toBe(sum);
  }
  const total = (
    ctx.db
      .prepare('SELECT COALESCE(SUM(delta),0) AS s FROM ledger WHERE room_id = ?')
      .get(roomId) as { s: number }
  ).s;
  const purchased = (
    ctx.db
      .prepare(
        "SELECT COALESCE(SUM(delta),0) AS s FROM ledger WHERE room_id = ? AND kind = 'purchase'",
      )
      .get(roomId) as { s: number }
  ).s;
  expect(total).toBe(purchased); // settlement is zero-sum against buy-ins
}

beforeEach(async () => {
  process.env.BOT_IDENTITY_KEY = KEY;
  ctx = createApp(':memory:');
  attachHub(ctx.app, ctx.db, {
    cryptoTimeoutMs: 3000,
    actionTimeoutMs: 5000,
    autoDealMs: 3_600_000,
    readyCheckMs: 2000,
  });
  const address = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = address;
  routed = [];
  runner = null;
  human = new HeadlessClient(baseUrl, `h${randomBytes(3).toString('hex')}`, 'hunter2');
  await human.login();
});

afterEach(async () => {
  await Promise.race([runner?.stop().catch(() => {}), sleep(6000)]);
  human.close();
  await ctx.app.close();
  if (ORIGINAL_KEY === undefined) delete process.env.BOT_IDENTITY_KEY;
  else process.env.BOT_IDENTITY_KEY = ORIGINAL_KEY;
});

describe('bot runner own-socket reconnect', () => {
  it('reconnects from a crypto-phase drop and finishes without abort', async () => {
    const { room, bot } = await createTable();
    await startRunner(room.id, bot);

    human.send({ t: 'start_hand' });
    await waitFor(() => botClient.handLive(), 10_000, 'bot sees hand_start');
    // Confirm we really are pre-betting (crypto deal/unmask) at the drop: a live
    // hand without a betting snapshot can only be the deal phase.
    expect(botClient.betting).toBeNull();
    dropRunnerSocket();

    const driver = driveHuman(30_000);
    await waitFor(() => human.result !== null || human.abort !== null, 30_000, 'hand settled');
    await driver;

    expect(human.abort).toBeNull();
    expect(human.result).not.toBeNull();
    expect(uniqueSentKeys()).toBe(true);
    assertTranscriptComplete(human.result!.handId);
    await assertLedgerConservation(room.id);
  }, 60_000);

  it('reconnects from a betting-phase drop and finishes without abort', async () => {
    const { room, bot } = await createTable();
    await startRunner(room.id, bot);

    human.send({ t: 'start_hand' });
    await waitFor(() => human.handLive() && bothBetting(), 15_000, 'betting underway');

    dropRunnerSocket();

    const driver = driveHuman(30_000);
    await waitFor(() => human.result !== null || human.abort !== null, 30_000, 'hand settled');
    await driver;

    expect(human.abort).toBeNull();
    expect(human.result).not.toBeNull();
    expect(uniqueSentKeys()).toBe(true);
    assertTranscriptComplete(human.result!.handId);
    await assertLedgerConservation(room.id);
  }, 60_000);

  it('voids a decision computed across a drop and never double-sends it', async () => {
    const { room, bot } = await createTable();
    let dropped = false;
    const dropOnDecide: Policy = {
      name: 'drop-on-first-decide',
      async decide(view) {
        if (!dropped) {
          dropped = true;
          dropRunnerSocket();
          // Let the socket `close` fire so the runner sees `connected === false`.
          await sleep(60);
        }
        const la = view.legalActions!;
        return { action: { type: la.canCheck ? 'check' : 'call' }, reason: 'drop-test' };
      },
    };
    await startRunner(room.id, bot, { policy: dropOnDecide });

    human.send({ t: 'start_hand' });
    const driver = driveHuman(30_000);
    await waitFor(() => routed.some((e) => e.kind === 'discarded' && e.reason === 'reconnect'), 15_000);
    await waitFor(() => human.result !== null || human.abort !== null, 30_000, 'hand settled');
    await driver;

    expect(routed).toContainEqual(
      expect.objectContaining({ kind: 'discarded', reason: 'reconnect' }),
    );
    expect(human.abort).toBeNull();
    expect(human.result).not.toBeNull();
    expect(uniqueSentKeys()).toBe(true);
    assertTranscriptComplete(human.result!.handId);
    await assertLedgerConservation(room.id);
  }, 60_000);
});

/** At least one player is in a live betting state (both clients see it). */
function bothBetting(): boolean {
  return human.betting !== null && botClient.betting !== null;
}
