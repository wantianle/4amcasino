import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createSession, createUser } from '../src/auth.js';
import { roomEvents } from '../src/rooms.js';
import { BotSupervisor } from '../src/botSupervisor.js';
import { getBot } from '../src/botRoutes.js';

/**
 * Regression: DELETE must really delete the bot, not flag it `removed`. A live
 * runner is still wound down first (fold + leave seat), but once that is done
 * the `bot_accounts` row, every `agent_grants` row for the bot and its
 * `room_players` seat row are removed. The bot's `users` row and its `ledger`
 * entries stay: `/api/rooms/:id/ledger` joins `users`, so deleting the account
 * would silently drop the bot's entries from the room's money history.
 *
 * Both finalize paths are covered:
 *   - detached (no supervisor): DELETE deletes synchronously in the request;
 *   - supervised with a live runner: DELETE returns 202 and persists the delete
 *     intent; the supervisor hard-deletes once the runner has wound down.
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

async function createBot(payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/rooms/${room}/bots`,
    headers: auth(hostToken),
    payload,
  });
}

async function removeBot(botId: string) {
  return ctx.app.inject({
    method: 'DELETE',
    url: `/api/rooms/${room}/bots/${botId}`,
    headers: auth(hostToken),
  });
}

function seatRow(userId: number) {
  return ctx.db
    .prepare('SELECT seat, sitting_out AS sittingOut, stack FROM room_players WHERE room_id = ? AND user_id = ?')
    .get(room, userId) as { seat: number | null; sittingOut: number; stack: number } | undefined;
}

function agentGrantCount(botId: string): number {
  return (
    ctx.db.prepare('SELECT COUNT(*) AS n FROM agent_grants WHERE bot_id = ?').get(botId) as {
      n: number;
    }
  ).n;
}

function ledgerSum(userId: number): number {
  return (
    ctx.db
      .prepare('SELECT COALESCE(SUM(delta), 0) AS s FROM ledger WHERE room_id = ? AND user_id = ?')
      .get(room, userId) as { s: number }
  ).s;
}

function buyRequestCount(userId: number): number {
  return (
    ctx.db
      .prepare('SELECT COUNT(*) AS n FROM buy_requests WHERE room_id = ? AND user_id = ?')
      .get(room, userId) as { n: number }
  ).n;
}

function buyStatus(requestId: number): string {
  return (
    ctx.db.prepare('SELECT status FROM buy_requests WHERE id = ?').get(requestId) as {
      status: string;
    }
  ).status;
}

function collectRoomChanges(): { rooms: string[]; stop: () => void } {
  const rooms: string[] = [];
  const handler = (roomId: string) => rooms.push(roomId);
  roomEvents.on('changed', handler);
  return { rooms, stop: () => roomEvents.off('changed', handler) };
}

async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor timed out');
}

beforeEach(async () => {
  process.env.BOT_IDENTITY_KEY = KEY;
  ctx = createApp(':memory:');
  hostId = createUser(ctx.db, 'seat_host', 'a'.repeat(64), 'b'.repeat(64)).userId;
  hostToken = createSession(ctx.db, hostId);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/rooms',
    headers: auth(hostToken),
    payload: { name: 'Seat room', sb: 10, bb: 20 },
  });
  room = res.json().id;
});

afterEach(async () => {
  if (ORIGINAL_KEY === undefined) delete process.env.BOT_IDENTITY_KEY;
  else process.env.BOT_IDENTITY_KEY = ORIGINAL_KEY;
  await ctx.app.close();
});

describe('DELETE hard-deletes the bot (detached path)', () => {
  it('removes the bot, seat and grant rows, conserves the ledger, and broadcasts', async () => {
    const created = (await createBot({ seat: 1, initialBuyIn: 2000 })).json();
    expect(created.bot.status).toBe('ready'); // host is the banker -> inline approval
    const userId = created.bot.userId;
    const botId = created.bot.id;
    expect(seatRow(userId)).toMatchObject({ seat: 1, stack: 2000 });

    const ledgerBefore = ledgerSum(userId);
    expect(ledgerBefore).not.toBe(0);
    expect(agentGrantCount(botId)).toBe(0);

    const changes = collectRoomChanges();
    try {
      const del = await removeBot(botId);
      expect(del.statusCode).toBe(200);
      expect(del.json().bot.status).toBe('removed'); // terminal response snapshot
      expect(del.json().deletion).toBe('done');
    } finally {
      changes.stop();
    }

    // No bot row, no seat row: the bot is gone, not flagged `removed`.
    expect(getBot(ctx.db, room, botId)).toBeUndefined();
    expect(seatRow(userId)).toBeUndefined();
    expect(agentGrantCount(botId)).toBe(0);
    // The account and its ledger history stay so the room ledger still resolves
    // who the money belonged to.
    expect(ctx.db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)).toBeTruthy();
    expect(ledgerSum(userId)).toBe(ledgerBefore);

    // A room_state refresh was requested, not only implied by socket close.
    expect(changes.rooms).toContain(room);
  });
});

describe('DELETE hard-deletes the bot (supervised path)', () => {
  it('winds the runner down first, persists the intent, then deletes and broadcasts', async () => {
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
    ctx.botControl.hooks = supervisor;

    const created = (await createBot({ seat: 2, initialBuyIn: 750 })).json();
    const userId = created.bot.userId;
    const botId = created.bot.id;
    expect(seatRow(userId)).toMatchObject({ seat: 2, stack: 750 });

    const ledgerBefore = ledgerSum(userId);
    const start = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room}/bots/${botId}/start`,
      headers: auth(hostToken),
    });
    expect(start.statusCode).toBe(200);
    expect(getBot(ctx.db, room, botId)!.status).toBe('running');
    expect(supervisor.hasRunner(botId)).toBe(true);
    expect(agentGrantCount(botId)).toBe(1);

    const changes = collectRoomChanges();
    try {
      const del = await removeBot(botId);
      // A live runner cannot fold inside one request: 202 + a durable intent.
      expect(del.statusCode).toBe(202);
      expect(del.json().deletion).toBe('pending');

      // While the runner is still winding down the row survives, but is parked
      // `stopping` with the delete intent persisted so a crash cannot lose it.
      const pending = getBot(ctx.db, room, botId)!;
      expect(pending.status).toBe('stopping');
      expect(pending.delete_requested_at).not.toBeNull();
      expect(seatRow(userId)).toBeTruthy();

      // Release the wind-down; the supervisor now hard-deletes.
      releaseStop();
      await waitFor(() => getBot(ctx.db, room, botId) === undefined);
    } finally {
      changes.stop();
    }

    expect(seatRow(userId)).toBeUndefined();
    expect(agentGrantCount(botId)).toBe(0);
    expect(ledgerSum(userId)).toBe(ledgerBefore);
    expect(changes.rooms).toContain(room);
    await supervisor.stopAll();
  });
});

/**
 * Regression for the funds blocker: once a hard delete is requested the bot is
 * only `stopping` (not `removed`), so a `/buy` that checks `status === 'removed'`
 * alone still funds it. The supervisor then finalizes and deletes the seat row,
 * leaving a successful ledger purchase with no seat behind it.
 *
 * A stop-gated runner holds the wind-down open so the "pending but not yet
 * finalized" window is deterministic rather than a race.
 */
describe('DELETE pending rejects bot funding (regression)', () => {
  it('refuses /buy while the delete is pending, moving no money', async () => {
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
    ctx.botControl.hooks = supervisor;

    const created = (await createBot({ seat: 3, initialBuyIn: 750 })).json();
    const userId = created.bot.userId;
    const botId = created.bot.id;

    const start = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room}/bots/${botId}/start`,
      headers: auth(hostToken),
    });
    expect(start.statusCode).toBe(200);
    expect(getBot(ctx.db, room, botId)!.status).toBe('running');
    expect(supervisor.hasRunner(botId)).toBe(true);

    // DELETE persists the intent synchronously, then blocks winding down on the gate.
    const del = await removeBot(botId);
    expect(del.statusCode).toBe(202);
    const pending = getBot(ctx.db, room, botId)!;
    expect(pending.status).toBe('stopping');
    expect(pending.delete_requested_at).not.toBeNull();

    const requestsBefore = buyRequestCount(userId);
    const ledgerBefore = ledgerSum(userId);
    const stackBefore = seatRow(userId)!.stack;

    // Blocker: this used to be 200/approved, crediting the ledger and the seat.
    const buy = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room}/bots/${botId}/buy`,
      headers: auth(hostToken),
      payload: { amount: 300 },
    });
    expect(buy.statusCode).toBe(409);
    expect(buy.json().error).toMatch(/deletion/i);

    // No buy request, no ledger entry, no stack change: nothing to later orphan.
    expect(buyRequestCount(userId)).toBe(requestsBefore);
    expect(ledgerSum(userId)).toBe(ledgerBefore);
    expect(seatRow(userId)!.stack).toBe(stackBefore);

    // Release the wind-down so the deletion completes and no runner lingers.
    releaseStop();
    await waitFor(() => getBot(ctx.db, room, botId) === undefined);
    await supervisor.stopAll();
  });
});

/**
 * Regression for the OTHER funding entry into a deleting bot's seat: the
 * banker-approval path. A pending buy raised while the bot was alive is still
 * `pending` for the whole (potentially unbounded) wind-down of a DELETE, and
 * `approveRoomBuy` used to credit the ledger + stack without looking at the bot
 * at all. The supervisor's finalize then drops the seat row, orphaning a
 * successful purchase with no seat behind it.
 *
 * The same room's human pending buy must still approve: the guard is keyed on
 * the requested user's bot_accounts row, and a human has none.
 */
describe('banker approval refuses a deleting bot (regression)', () => {
  it('refuses a bot buy approval during wind-down but still approves a human buy', async () => {
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
    ctx.botControl.hooks = supervisor;

    // Host is not the banker and the room does not auto-approve, so a later
    // `/buy` leaves a pending request the banker decides.
    const bankerId = createUser(ctx.db, 'seat_banker', 'e'.repeat(64), 'f'.repeat(64)).userId;
    const bankerToken = createSession(ctx.db, bankerId);
    ctx.db
      .prepare('UPDATE rooms SET banker_id = ?, auto_approve_buys = 0 WHERE id = ?')
      .run(bankerId, room);

    // A running bot created WITHOUT an initial buy-in, so the pending request we
    // exercise is the later funding one (not the create-time buy-in).
    const created = (await createBot({ seat: 3 })).json();
    const botUserId = created.bot.userId;
    const botId = created.bot.id;
    const start = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room}/bots/${botId}/start`,
      headers: auth(hostToken),
    });
    expect(start.statusCode).toBe(200);
    expect(getBot(ctx.db, room, botId)!.status).toBe('running');

    const botBuy = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room}/bots/${botId}/buy`,
      headers: auth(hostToken),
      payload: { amount: 300 },
    });
    expect(botBuy.statusCode).toBe(200);
    expect(botBuy.json().buyRequest.status).toBe('pending');
    const botRequestId = botBuy.json().buyRequest.id;

    // A human in the same room raises their own pending buy.
    const humanId = createUser(ctx.db, 'seat_human', '1'.repeat(64), '2'.repeat(64)).userId;
    const humanToken = createSession(ctx.db, humanId);
    ctx.db.prepare('INSERT OR IGNORE INTO room_players (room_id, user_id) VALUES (?, ?)').run(room, humanId);
    const humanBuy = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room}/buy`,
      headers: auth(humanToken),
      payload: { amount: 100 },
    });
    expect(humanBuy.statusCode).toBe(200);
    expect(humanBuy.json().status).toBe('pending');
    const humanRequestId = humanBuy.json().id;

    // DELETE a running bot: parks it `stopping` with a durable intent; the gate
    // holds the wind-down open so the pending window is deterministic.
    const del = await removeBot(botId);
    expect(del.statusCode).toBe(202);
    expect(getBot(ctx.db, room, botId)!.delete_requested_at).not.toBeNull();

    const ledgerBefore = ledgerSum(botUserId);
    const stackBefore = seatRow(botUserId)!.stack;

    // Blocker: this used to be 200, crediting the deleting bot's ledger + seat.
    const approveBot = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room}/approve`,
      headers: auth(bankerToken),
      payload: { requestId: botRequestId, approve: true },
    });
    expect(approveBot.statusCode).toBe(409);
    expect(approveBot.json().error).toMatch(/deletion|removed/i);

    // No ledger entry, no stack change, and the request stays pending (not even
    // marked rejected) - nothing to later orphan.
    expect(buyStatus(botRequestId)).toBe('pending');
    expect(ledgerSum(botUserId)).toBe(ledgerBefore);
    expect(seatRow(botUserId)!.stack).toBe(stackBefore);

    // The human is untouched by the bot guard: their approval still settles.
    const approveHuman = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room}/approve`,
      headers: auth(bankerToken),
      payload: { requestId: humanRequestId, approve: true },
    });
    expect(approveHuman.statusCode).toBe(200);
    expect(buyStatus(humanRequestId)).toBe('approved');
    expect(seatRow(humanId)!.stack).toBe(100);
    expect(ledgerSum(humanId)).toBe(100);

    // Release the wind-down so the deletion completes and no runner lingers.
    releaseStop();
    await waitFor(() => getBot(ctx.db, room, botId) === undefined);
    await supervisor.stopAll();
  });
});
