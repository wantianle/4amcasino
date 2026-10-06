import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createSession, createUser } from '../src/auth.js';
import { BuyServiceError, requestRoomBuy } from '../src/buyService.js';
import { BotSupervisor } from '../src/botSupervisor.js';
import { getBot } from '../src/botRoutes.js';

/**
 * Regression for the two remaining funding entries into a bot that is being
 * hard-deleted. In the wind-down window the bot is only parked `stopping` with
 * `delete_requested_at` set (a live runner must fold first), yet its seat and
 * membership still exist - so both a peer-to-peer `/transfer` and an
 * auto-approved `/buy` used to credit it. `finalizeBotRemoved` then drops the
 * seat, leaving a funded purchase/transfer with no seat behind it.
 *
 * Every case holds the wind-down open with a stop-gated runner so the window is
 * deterministic rather than a race.
 */

const KEY = 'ab'.repeat(32);
const ORIGINAL_KEY = process.env.BOT_IDENTITY_KEY;

let ctx: ReturnType<typeof createApp>;
let hostId: number;
let hostToken: string;
let room: string;

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

function ledgerSum(userId: number): number {
  return (
    ctx.db
      .prepare('SELECT COALESCE(SUM(delta), 0) AS s FROM ledger WHERE room_id = ? AND user_id = ?')
      .get(room, userId) as { s: number }
  ).s;
}

function stackOf(userId: number): number | undefined {
  return (
    ctx.db
      .prepare('SELECT stack FROM room_players WHERE room_id = ? AND user_id = ?')
      .get(room, userId) as { stack: number } | undefined
  )?.stack;
}

function buyRequestCount(userId: number): number {
  return (
    ctx.db
      .prepare('SELECT COUNT(*) AS n FROM buy_requests WHERE room_id = ? AND user_id = ?')
      .get(room, userId) as { n: number }
  ).n;
}

/** Seat a human with a funded stack without going through the buy flow. */
function addMember(userId: number, stack: number): void {
  ctx.db
    .prepare('INSERT OR IGNORE INTO room_players (room_id, user_id, stack) VALUES (?, ?, ?)')
    .run(room, userId, stack);
  ctx.db
    .prepare('UPDATE room_players SET stack = ? WHERE room_id = ? AND user_id = ?')
    .run(stack, room, userId);
}

function newHuman(name: string, stack: number): { id: number; token: string } {
  const id = createUser(ctx.db, name, name.charCodeAt(0).toString(16).repeat(64), 'c'.repeat(64)).userId;
  const token = createSession(ctx.db, id);
  addMember(id, stack);
  return { id, token };
}

function createBot(payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/rooms/${room}/bots`,
    headers: auth(hostToken),
    payload,
  });
}

function startBot(botId: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/rooms/${room}/bots/${botId}/start`,
    headers: auth(hostToken),
  });
}

function removeBot(botId: string) {
  return ctx.app.inject({
    method: 'DELETE',
    url: `/api/rooms/${room}/bots/${botId}`,
    headers: auth(hostToken),
  });
}

async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor timed out');
}

/** A supervisor whose runner blocks in stop(), so DELETE parks the bot. */
function makeGatedSupervisor() {
  let releaseStop!: () => void;
  const stopGate = new Promise<void>((r) => {
    releaseStop = r;
  });
  const supervisor = new BotSupervisor(ctx.db, {
    baseUrl: 'http://127.0.0.1:1',
    runnerFactory: () => ({
      start: async () => {},
      stop: () => stopGate,
      done: stopGate,
    }),
  });
  return { supervisor, releaseStop };
}

/** Create a running bot and put it into the deterministic delete wind-down. */
async function parkBotInWindDown(
  supervisor: BotSupervisor,
  payload: Record<string, unknown>,
): Promise<{ botId: string; botUserId: number }> {
  ctx.botControl.hooks = supervisor;
  const created = (await createBot(payload)).json();
  const botId = created.bot.id as string;
  const botUserId = created.bot.userId as number;
  const start = await startBot(botId);
  expect(start.statusCode).toBe(200);
  expect(getBot(ctx.db, room, botId)!.status).toBe('running');
  const del = await removeBot(botId);
  expect(del.statusCode).toBe(202);
  const pending = getBot(ctx.db, room, botId)!;
  expect(pending.status).toBe('stopping');
  expect(pending.delete_requested_at).not.toBeNull();
  return { botId, botUserId };
}

beforeEach(async () => {
  process.env.BOT_IDENTITY_KEY = KEY;
  ctx = createApp(':memory:');
  hostId = createUser(ctx.db, 'funding_host', 'a'.repeat(64), 'b'.repeat(64)).userId;
  hostToken = createSession(ctx.db, hostId);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/rooms',
    headers: auth(hostToken),
    payload: { name: 'Funding room', sb: 10, bb: 20 },
  });
  room = res.json().id;
});

afterEach(async () => {
  if (ORIGINAL_KEY === undefined) delete process.env.BOT_IDENTITY_KEY;
  else process.env.BOT_IDENTITY_KEY = ORIGINAL_KEY;
  await ctx.app.close();
});

describe('transfer refuses a deleting bot (regression)', () => {
  it('rejects a transfer into a bot during its wind-down and moves no chips', async () => {
    const { supervisor, releaseStop } = makeGatedSupervisor();
    // Bot with a real stack so it is a normal member while it winds down.
    const { botId, botUserId } = await parkBotInWindDown(supervisor, {
      seat: 1,
      initialBuyIn: 1000,
    });
    const sender = newHuman('funding_sender', 1000);

    const botLedgerBefore = ledgerSum(botUserId);
    const botStackBefore = stackOf(botUserId)!;
    const senderStackBefore = stackOf(sender.id)!;
    expect(botStackBefore).toBe(1000);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room}/transfer`,
      headers: auth(sender.token),
      payload: { toUserId: botUserId, amount: 100 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/deletion|removed/i);

    // No ledger entry and no stack change on either side: nothing to orphan.
    expect(ledgerSum(botUserId)).toBe(botLedgerBefore);
    expect(stackOf(botUserId)).toBe(botStackBefore);
    expect(stackOf(sender.id)).toBe(senderStackBefore);

    releaseStop();
    await waitFor(() => getBot(ctx.db, room, botId) === undefined);
    await supervisor.stopAll();
  });

  it('still transfers between humans while a bot is deleting', async () => {
    const { supervisor, releaseStop } = makeGatedSupervisor();
    const { botId } = await parkBotInWindDown(supervisor, { seat: 1, initialBuyIn: 500 });

    const sender = newHuman('funding_human_a', 1000);
    const recipient = newHuman('funding_human_b', 0);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room}/transfer`,
      headers: auth(sender.token),
      payload: { toUserId: recipient.id, amount: 250 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(stackOf(sender.id)).toBe(750);
    expect(stackOf(recipient.id)).toBe(250);
    expect(ledgerSum(recipient.id)).toBe(250);

    releaseStop();
    await waitFor(() => getBot(ctx.db, room, botId) === undefined);
    await supervisor.stopAll();
  });
});

describe('auto-approved buy re-checks the bot lifecycle inside the transaction (regression)', () => {
  it('rejects the service call for a deleting bot with no ledger/stack write', async () => {
    ctx.db.prepare('UPDATE rooms SET auto_approve_buys = 1 WHERE id = ?').run(room);
    const { supervisor, releaseStop } = makeGatedSupervisor();
    // No initial buy-in: the buy we exercise is the one aimed at the deleting bot.
    const { botId, botUserId } = await parkBotInWindDown(supervisor, { seat: 2 });

    const requestsBefore = buyRequestCount(botUserId);
    const ledgerBefore = ledgerSum(botUserId);
    const stackBefore = stackOf(botUserId)!;

    // This is the state the `/bots/:botId/buy` route pre-read would have passed:
    // had DELETE committed just after that read, the service used to credit the
    // bot anyway. Calling the money path directly models that exact window.
    let thrown: unknown;
    try {
      requestRoomBuy(ctx.db, { roomId: room, userId: botUserId, amount: 300 });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BuyServiceError);
    expect((thrown as BuyServiceError).statusCode).toBe(409);
    expect((thrown as BuyServiceError).message).toMatch(/deletion|removed/i);

    // No money moved. (The request row is inserted before the transaction and is
    // left `pending` for `finalizeBotRemoved` to cancel, exactly like the banker
    // approval path; it can never be approved because `approveRoomBuy` refuses a
    // gone bot too.)
    expect(ledgerSum(botUserId)).toBe(ledgerBefore);
    expect(stackOf(botUserId)).toBe(stackBefore);
    expect(buyRequestCount(botUserId)).toBe(requestsBefore + 1);

    releaseStop();
    await waitFor(() => getBot(ctx.db, room, botId) === undefined);
    await supervisor.stopAll();
  });

  it('still auto-approves a human buy in the same room', async () => {
    ctx.db.prepare('UPDATE rooms SET auto_approve_buys = 1 WHERE id = ?').run(room);
    const human = newHuman('funding_human_buyer', 0);

    const result = requestRoomBuy(ctx.db, { roomId: room, userId: human.id, amount: 400 });
    expect(result.status).toBe('approved');
    expect(ledgerSum(human.id)).toBe(400);
    expect(stackOf(human.id)).toBe(400);
  });
});
