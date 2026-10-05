import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createSession, createUser } from '../src/auth.js';
import { FUN_BOT_NAMES, pickFunBotName } from '../src/botNames.js';

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

function displayNameOf(userId: number): string {
  return (
    ctx.db
      .prepare('SELECT COALESCE(display_name, username) AS name FROM users WHERE id = ?')
      .get(userId) as { name: string }
  ).name;
}

function usernameOf(userId: number): string {
  return (ctx.db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string })
    .username;
}

/** True when `name` is a pool entry, optionally with a numeric dedup suffix. */
function fromPool(name: string): boolean {
  const base = name.replace(/\d+$/, '');
  return (FUN_BOT_NAMES as readonly string[]).includes(base);
}

beforeEach(async () => {
  process.env.BOT_IDENTITY_KEY = KEY;
  ctx = createApp(':memory:');
  hostId = createUser(ctx.db, 'name_host', 'a'.repeat(64), 'b'.repeat(64)).userId;
  hostToken = createSession(ctx.db, hostId);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/rooms',
    headers: auth(hostToken),
    payload: { name: 'Name room', sb: 10, bb: 20 },
  });
  room = res.json().id;
});

afterEach(async () => {
  if (ORIGINAL_KEY === undefined) delete process.env.BOT_IDENTITY_KEY;
  else process.env.BOT_IDENTITY_KEY = ORIGINAL_KEY;
  await ctx.app.close();
});

describe('pickFunBotName', () => {
  it('returns a pool name when nothing is taken', () => {
    for (let i = 0; i < 50; i++) {
      expect(FUN_BOT_NAMES).toContain(pickFunBotName());
    }
  });

  it('appends a numeric suffix when the chosen base name is already taken', () => {
    // Passing the whole pool forces the collision branch regardless of the pick.
    const allTaken = [...FUN_BOT_NAMES];
    for (let i = 0; i < 50; i++) {
      const name = pickFunBotName(allTaken);
      expect(FUN_BOT_NAMES as readonly string[]).not.toContain(name);
      expect(name).toMatch(/^(?:.+)\d+$/);
      expect(fromPool(name)).toBe(true);
    }
  });

  it('never returns a taken name even with every base and low suffix occupied', () => {
    const taken = new Set<string>();
    for (const base of FUN_BOT_NAMES) {
      taken.add(base);
      for (let i = 2; i <= 5; i++) taken.add(`${base}${i}`);
    }
    for (let i = 0; i < 50; i++) {
      expect(taken.has(pickFunBotName(taken))).toBe(false);
    }
  });
});

describe('bot default display name', () => {
  it('fills a fun pool name (not bot_*) when no name is given', async () => {
    const res = await createBot({ seat: 1 });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const name = displayNameOf(body.bot.userId);
    expect(name).toBe(body.bot.displayName);
    expect(FUN_BOT_NAMES).toContain(name);
    expect(name).not.toMatch(/^bot_/);
  });

  it('keeps generated names distinct for two bots at the same table', async () => {
    const first = (await createBot({ seat: 1 })).json();
    const second = (await createBot({ seat: 2 })).json();
    const first2 = displayNameOf(first.bot.userId);
    const second2 = displayNameOf(second.bot.userId);
    expect(first2).not.toBe(second2);
    expect(fromPool(first2)).toBe(true);
    expect(fromPool(second2)).toBe(true);
  });

  it('de-duplicates against every display name already at the table', async () => {
    // Seat one occupant per pool name so *any* base pick must collide; the new
    // bot then has to take a suffixed variant instead of a bare pool name.
    for (const [i, name] of FUN_BOT_NAMES.entries()) {
      const uid = createUser(ctx.db, `name_filler_${i}`, '0'.repeat(64), '1'.repeat(64)).userId;
      ctx.db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, uid);
      ctx.db.prepare('INSERT INTO room_players (room_id, user_id, stack) VALUES (?, ?, 0)').run(room, uid);
    }

    const created = (await createBot({ seat: 1 })).json();
    const name = displayNameOf(created.bot.userId);
    expect(FUN_BOT_NAMES as readonly string[]).not.toContain(name);
    expect(fromPool(name)).toBe(true);
    expect(name).toMatch(/\d+$/);
  });

  it('respects an explicit name over the pool', async () => {
    const res = await createBot({ seat: 1, name: '我的机器人' });
    const body = res.json();
    expect(displayNameOf(body.bot.userId)).toBe('我的机器人');
    expect(FUN_BOT_NAMES).not.toContain('我的机器人');
  });

  it('leaves username as a unique bot_<hex> identity', async () => {
    const first = (await createBot({ seat: 1 })).json();
    const second = (await createBot({ seat: 2, name: 'Explicit' })).json();
    const u1 = usernameOf(first.bot.userId);
    const u2 = usernameOf(second.bot.userId);
    expect(u1).toMatch(/^bot_[0-9a-f]{10}$/);
    expect(u2).toMatch(/^bot_[0-9a-f]{10}$/);
    expect(u1).not.toBe(u2);
    // The fun name must never leak into the login identity.
    expect(u1).not.toBe(displayNameOf(first.bot.userId));
  });
});
