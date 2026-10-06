import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createSession, createUser } from '../src/auth.js';
import { getBot } from '../src/botRoutes.js';
import { BotSupervisor } from '../src/botSupervisor.js';

/**
 * Route-level regression for the per-room bot runner pool.
 *
 * Before the fix a single server-wide budget of 8 was shared by every room, so a
 * bot running in room A could crowd a start out of room B. Now the pool is
 * per-room (`BOT_MAX_PER_ROOM`, here 1): a full room is refused with 409 while
 * another room still starts, and closing the full room genuinely releases its
 * runner instead of only parking the bot.
 */

const KEY = 'ab'.repeat(32);
const ORIGINAL_KEY = process.env.BOT_IDENTITY_KEY;

let ctx: ReturnType<typeof createApp>;
let supervisor: BotSupervisor;
let hostToken: string;
let roomA: string;
let roomB: string;

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

function fakeRunner() {
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  return {
    start: async () => {},
    stop: async () => resolveDone(),
    done,
  };
}

async function createRoom(name: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/rooms',
    headers: auth(hostToken),
    payload: { name, sb: 10, bb: 20 },
  });
  return res.json().id;
}

async function createBot(room: string, seat: number): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/rooms/${room}/bots`,
    headers: auth(hostToken),
    payload: { seat },
  });
  expect(res.statusCode).toBe(200);
  return res.json().bot.id;
}

function startBot(room: string, botId: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/rooms/${room}/bots/${botId}/start`,
    headers: auth(hostToken),
  });
}

function botStatus(botId: string): string {
  const row = ctx.db.prepare('SELECT status FROM bot_accounts WHERE id = ?').get(botId) as
    | { status: string }
    | undefined;
  return row?.status ?? '';
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
  const hostId = createUser(ctx.db, 'pool_host', 'a'.repeat(64), 'b'.repeat(64)).userId;
  hostToken = createSession(ctx.db, hostId);
  roomA = await createRoom('Room A');
  roomB = await createRoom('Room B');
  supervisor = new BotSupervisor(ctx.db, {
    baseUrl: 'http://127.0.0.1:1',
    maxPerRoom: 1,
    runnerFactory: () => fakeRunner(),
    log: () => {},
  });
  ctx.botControl.hooks = supervisor;
  supervisor.subscribeRoomEvents();
});

afterEach(async () => {
  await supervisor.stopAll().catch(() => {});
  supervisor.detachRoomEvents();
  await ctx.app.close();
  if (ORIGINAL_KEY === undefined) delete process.env.BOT_IDENTITY_KEY;
  else process.env.BOT_IDENTITY_KEY = ORIGINAL_KEY;
});

describe('per-room bot runner pool', () => {
  it('refuses a start when the room is full, but leaves other rooms unaffected', async () => {
    const a1 = await createBot(roomA, 1);
    const a2 = await createBot(roomA, 2);
    const b1 = await createBot(roomB, 1);

    expect((await startBot(roomA, a1)).statusCode).toBe(200);
    expect(botStatus(a1)).toBe('running');

    // Room A is at its per-room limit.
    const refused = await startBot(roomA, a2);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/capacity reached for this room/);
    expect(botStatus(a2)).not.toBe('running');

    // Room B is untouched by A's fullness.
    expect((await startBot(roomB, b1)).statusCode).toBe(200);
    expect(botStatus(b1)).toBe('running');
    expect(supervisor.hasRunner(b1)).toBe(true);
  });

  it('closing a room releases its runner and revokes its grant', async () => {
    const a1 = await createBot(roomA, 1);
    expect((await startBot(roomA, a1)).statusCode).toBe(200);
    expect(supervisor.hasRunner(a1)).toBe(true);

    const closed = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${roomA}/close`,
      headers: auth(hostToken),
    });
    expect(closed.statusCode).toBe(200);

    await waitFor(() => botStatus(a1) === 'stopped');
    expect(supervisor.hasRunner(a1)).toBe(false);
    const grants = (
      ctx.db
        .prepare('SELECT COUNT(*) AS n FROM agent_grants WHERE bot_id = ? AND revoked_at IS NULL')
        .get(a1) as { n: number }
    ).n;
    expect(grants).toBe(0);
    // The seat was cleared by the archive transition, matching the removal path.
    const bot = getBot(ctx.db, roomA, a1)!;
    expect(bot.status).toBe('stopped');
  });
});
