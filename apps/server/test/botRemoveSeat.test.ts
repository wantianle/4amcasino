import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createSession, createUser } from '../src/auth.js';
import { roomEvents } from '../src/rooms.js';
import { BotSupervisor } from '../src/botSupervisor.js';
import { getBot } from '../src/botRoutes.js';

/**
 * Regression: removing a bot must actually give up its `room_players` seat and
 * broadcast it, not only flip `bot_accounts.status`. Before the fix the seat row
 * kept rendering until the runner's socket closed (shown as "disconnected").
 *
 * Both finalize paths are covered:
 *   - detached (no supervisor): DELETE calls finalizeBotRemoved directly;
 *   - supervised: DELETE parks `stopping`, the supervisor winds the runner down
 *     and finalizes.
 * Chips are never cashed out: the `room_players` row and its stack stay, and the
 * ledger is conserved.
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

function ledgerSum(userId: number): number {
  return (
    ctx.db
      .prepare('SELECT COALESCE(SUM(delta), 0) AS s FROM ledger WHERE room_id = ? AND user_id = ?')
      .get(room, userId) as { s: number }
  ).s;
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

describe('finalizeBotRemoved clears the seat (detached path)', () => {
  it('nulls the seat, keeps the row and stack, conserves the ledger, and broadcasts', async () => {
    const created = (await createBot({ seat: 1, initialBuyIn: 2000 })).json();
    expect(created.bot.status).toBe('ready'); // host is the banker -> inline approval
    const userId = created.bot.userId;
    expect(seatRow(userId)).toMatchObject({ seat: 1, stack: 2000 });

    const ledgerBefore = ledgerSum(userId);
    const rowsBefore = (
      ctx.db.prepare('SELECT COUNT(*) AS n FROM room_players WHERE room_id = ? AND user_id = ?').get(room, userId) as {
        n: number;
      }
    ).n;

    const changes = collectRoomChanges();
    try {
      const del = await removeBot(created.bot.id);
      expect(del.statusCode).toBe(200);
      expect(del.json().bot.status).toBe('removed');
    } finally {
      changes.stop();
    }

    // Seat released with the same semantics as a human `leave_seat`...
    expect(seatRow(userId)).toMatchObject({ seat: null, sittingOut: 1, stack: 2000 });
    // ...but the row (and its accounting) is deliberately NOT deleted.
    const rowsAfter = (
      ctx.db.prepare('SELECT COUNT(*) AS n FROM room_players WHERE room_id = ? AND user_id = ?').get(room, userId) as {
        n: number;
      }
    ).n;
    expect(rowsAfter).toBe(rowsBefore);

    expect(getBot(ctx.db, room, created.bot.id)!.status).toBe('removed');
    expect(ledgerSum(userId)).toBe(ledgerBefore);

    // A room_state refresh was requested, not only implied by socket close.
    expect(changes.rooms).toContain(room);
  });
});

describe('finalizeBotRemoved clears the seat (supervised path)', () => {
  it('winds the runner down, then clears the seat, keeps chips, and broadcasts', async () => {
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });
    const supervisor = new BotSupervisor(ctx.db, {
      baseUrl: 'http://127.0.0.1:1',
      runnerFactory: () => ({
        start: async () => {},
        stop: async () => resolveDone(),
        done,
      }),
    });
    ctx.botControl.hooks = supervisor;

    const created = (await createBot({ seat: 2, initialBuyIn: 750 })).json();
    const userId = created.bot.userId;
    expect(seatRow(userId)).toMatchObject({ seat: 2, stack: 750 });

    const ledgerBefore = ledgerSum(userId);
    const start = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room}/bots/${created.bot.id}/start`,
      headers: auth(hostToken),
    });
    expect(start.statusCode).toBe(200);
    expect(getBot(ctx.db, room, created.bot.id)!.status).toBe('running');
    expect(supervisor.hasRunner(created.bot.id)).toBe(true);

    const changes = collectRoomChanges();
    try {
      const del = await removeBot(created.bot.id);
      expect(del.statusCode).toBe(200);
      // Removal is async once a runner is live: wait for the finalize.
      await waitFor(() => getBot(ctx.db, room, created.bot.id)!.status === 'removed');
    } finally {
      changes.stop();
    }

    expect(seatRow(userId)).toMatchObject({ seat: null, sittingOut: 1, stack: 750 });
    expect(ledgerSum(userId)).toBe(ledgerBefore);
    expect(changes.rooms).toContain(room);
    await supervisor.stopAll();
  });
});
