import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { createUser } from '../src/auth.js';
import { openDb } from '../src/db.js';
import { appendLedger } from '../src/ledger.js';
import {
  ALL_IN_RATIO,
  BET_RATIO_OPTIONS,
  BET_RATIO_SLOTS,
  DEFAULT_BET_RATIOS,
} from '../src/profile.js';

// Two real processes (not two connections in one process - better-sqlite3 is
// synchronous and cannot interleave) opening the same file, used to prove the
// immediate migration transaction is safe under a concurrent startup.
const DB_SOURCE_URL = new URL('../src/db.ts', import.meta.url).href;
const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));
function openInChild(dbPath: string): Promise<{ code: number | null; stderr: string }> {
  const script = `import { openDb } from ${JSON.stringify(DB_SOURCE_URL)};\nconst db = openDb(process.env.READY_DB_PATH);\ndb.close();`;
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      { cwd: SERVER_DIR, env: { ...process.env, READY_DB_PATH: dbPath }, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (e) => resolve({ code: -1, stderr: String(e) }));
    child.on('exit', (code) => resolve({ code, stderr }));
  });
}

let ctx: ReturnType<typeof createApp>;
beforeEach(() => {
  ctx = createApp(':memory:');
});
afterEach(async () => {
  await ctx.app.close();
});

async function user(name: string) {
  const r = await ctx.app.inject({
    method: 'POST',
    url: '/api/register',
    payload: { username: name, authKey: 'a'.repeat(64), publicKey: 'b'.repeat(64) },
  });
  return { token: r.json().token as string, userId: r.json().userId as number };
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

// 1x1 transparent PNG
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('profile', () => {
  it('creates new accounts on the crimson four-color deck', async () => {
    const alice = await user('decknew');
    const me = (
      await ctx.app.inject({ method: 'GET', url: '/api/profile', headers: auth(alice.token) })
    ).json();
    expect(me.cardBack).toBe('crimson');
    expect(me.fourColor).toBe(true);
  });

  it('defaults autoReady to true for a new account and keeps an explicit opt-out', async () => {
    const alice = await user('readynew');
    const stored = ctx.db
      .prepare('SELECT auto_ready FROM users WHERE id = ?')
      .get(alice.userId) as { auto_ready: number };
    expect(stored.auto_ready).toBe(1);

    const first = (
      await ctx.app.inject({ method: 'GET', url: '/api/profile', headers: auth(alice.token) })
    ).json();
    expect(first.autoReady).toBe(true);

    // The player can still turn it off; that stored false must stick.
    const put = await ctx.app.inject({
      method: 'PUT',
      url: '/api/profile',
      headers: auth(alice.token),
      payload: { autoReady: false },
    });
    expect(put.statusCode).toBe(200);
    const off = (
      await ctx.app.inject({ method: 'GET', url: '/api/profile', headers: auth(alice.token) })
    ).json();
    expect(off.autoReady).toBe(false);

    // And back on again.
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/profile',
      headers: auth(alice.token),
      payload: { autoReady: true },
    });
    const on = (
      await ctx.app.inject({ method: 'GET', url: '/api/profile', headers: auth(alice.token) })
    ).json();
    expect(on.autoReady).toBe(true);
  });

  it('flips legacy auto_ready=0 rows to 1 and keeps new accounts on 1', () => {
    const dir = mkdtempSync(join(tmpdir(), '4am-ready-'));
    const path = join(dir, 'old.sqlite');
    try {
      // An existing database whose auto_ready column predates the flip and still
      // defaults to 0, with old rows already stored as 0.
      const old = new Database(path);
      old.exec(`CREATE TABLE users (
        id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, auth_hash TEXT NOT NULL,
        auth_salt TEXT NOT NULL, pubkey TEXT NOT NULL, created_at INTEGER NOT NULL,
        auto_ready INTEGER NOT NULL DEFAULT 0)`);
      old.prepare(
        'INSERT INTO users (username, auth_hash, auth_salt, pubkey, created_at, auto_ready) VALUES (?,?,?,?,?,0)',
      ).run('legacyoff', 'h', 's', 'p', 1);
      old.close();

      const db = openDb(path);
      try {
        const legacy = db
          .prepare("SELECT auto_ready FROM users WHERE username = 'legacyoff'")
          .get() as { auto_ready: number };
        expect(legacy.auto_ready).toBe(1); // one-time migration flips the old default
        const flag = db
          .prepare("SELECT value FROM meta WHERE key = 'auto-ready-default-on-1'")
          .get() as { value: string } | undefined;
        expect(flag?.value).toBe('1');
        const { userId } = createUser(db, 'readyfresh', 'a'.repeat(64), 'p');
        const fresh = db
          .prepare('SELECT auto_ready FROM users WHERE id = ?')
          .get(userId) as { auto_ready: number };
        expect(fresh.auto_ready).toBe(1); // new account gets the current default
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs the auto-ready migration exactly once, so a later opt-out survives a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), '4am-ready-once-'));
    const path = join(dir, 'old.sqlite');
    try {
      const old = new Database(path);
      old.exec(`CREATE TABLE users (
        id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, auth_hash TEXT NOT NULL,
        auth_salt TEXT NOT NULL, pubkey TEXT NOT NULL, created_at INTEGER NOT NULL,
        auto_ready INTEGER NOT NULL DEFAULT 0)`);
      const insert = old.prepare(
        'INSERT INTO users (username, auth_hash, auth_salt, pubkey, created_at, auto_ready) VALUES (?,?,?,?,?,0)',
      );
      insert.run('m1', 'h', 's', 'p', 1);
      insert.run('m2', 'h', 's', 'p', 2);
      insert.run('m3', 'h', 's', 'p', 3);
      old.close();

      // First start: every legacy 0 flips to 1 and the flag is written.
      const first = openDb(path);
      expect(first.prepare('SELECT auto_ready FROM users ORDER BY id').all()).toEqual([
        { auto_ready: 1 },
        { auto_ready: 1 },
        { auto_ready: 1 },
      ]);
      // The player then explicitly turns it off.
      first.prepare('UPDATE users SET auto_ready = 0 WHERE username = ?').run('m2');
      first.close();

      // Second start: the flag is present, the migration must not run again, so
      // the explicit opt-out stays 0 while everyone else stays 1.
      const second = openDb(path);
      expect(second.prepare('SELECT auto_ready FROM users ORDER BY id').all()).toEqual([
        { auto_ready: 1 },
        { auto_ready: 0 },
        { auto_ready: 1 },
      ]);
      expect(
        (
          second
            .prepare("SELECT COUNT(*) as n FROM meta WHERE key = 'auto-ready-default-on-1'")
            .get() as { n: number }
        ).n,
      ).toBe(1);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls the whole migration back when the marker write fails inside the transaction', () => {
    const dir = mkdtempSync(join(tmpdir(), '4am-ready-atomic-'));
    const path = join(dir, 'old.sqlite');
    try {
      const old = new Database(path);
      old.exec(`CREATE TABLE users (
        id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, auth_hash TEXT NOT NULL,
        auth_salt TEXT NOT NULL, pubkey TEXT NOT NULL, created_at INTEGER NOT NULL,
        auto_ready INTEGER NOT NULL DEFAULT 0)`);
      old.prepare(
        'INSERT INTO users (username, auth_hash, auth_salt, pubkey, created_at, auto_ready) VALUES (?,?,?,?,?,0)',
      ).run('victim', 'h', 's', 'p', 1);
      // A trigger makes the marker INSERT throw, emulating a failure in the
      // window between the UPDATE and the marker write.
      old.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
      old.exec(`CREATE TRIGGER block_auto_ready_marker BEFORE INSERT ON meta
        WHEN NEW.key = 'auto-ready-default-on-1'
        BEGIN SELECT RAISE(ABORT, 'marker write failed'); END`);
      old.close();

      expect(() => openDb(path)).toThrow(/marker write failed/);

      // The UPDATE rolled back with the failed INSERT: nothing was flipped and
      // no marker survived.
      const check = new Database(path);
      try {
        expect(
          check.prepare("SELECT auto_ready FROM users WHERE username = 'victim'").get(),
        ).toEqual({ auto_ready: 0 });
        expect(
          check
            .prepare("SELECT COUNT(*) as n FROM meta WHERE key = 'auto-ready-default-on-1'")
            .get(),
        ).toEqual({ n: 0 });
      } finally {
        check.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets two processes open the same database at once without a duplicate migration', async () => {
    const dir = mkdtempSync(join(tmpdir(), '4am-ready-conc-'));
    const path = join(dir, 'old.sqlite');
    try {
      // Build the full schema once, then reset to the un-migrated state (marker
      // gone, legacy rows 0) so the two processes race exactly the ready
      // migration instead of every other DDL statement.
      const seed = new Database(path);
      seed.exec(`CREATE TABLE users (
        id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, auth_hash TEXT NOT NULL,
        auth_salt TEXT NOT NULL, pubkey TEXT NOT NULL, created_at INTEGER NOT NULL,
        auto_ready INTEGER NOT NULL DEFAULT 0)`);
      seed.close();
      const setup = openDb(path);
      setup.prepare("DELETE FROM meta WHERE key = 'auto-ready-default-on-1'").run();
      const insert = setup.prepare(
        'INSERT INTO users (username, auth_hash, auth_salt, pubkey, created_at, auto_ready) VALUES (?,?,?,?,?,0)',
      );
      for (let i = 1; i <= 4; i++) insert.run(`c${i}`, 'h', 's', 'p', i);
      setup.close();

      const [a, b] = await Promise.all([openInChild(path), openInChild(path)]);
      expect(a.code, a.stderr).toBe(0);
      expect(b.code, b.stderr).toBe(0);

      const check = new Database(path);
      try {
        expect(check.prepare('SELECT auto_ready FROM users ORDER BY id').all()).toEqual([
          { auto_ready: 1 },
          { auto_ready: 1 },
          { auto_ready: 1 },
          { auto_ready: 1 },
        ]);
        expect(
          check
            .prepare("SELECT COUNT(*) as n FROM meta WHERE key = 'auto-ready-default-on-1'")
            .get(),
        ).toEqual({ n: 1 });
      } finally {
        check.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it('keeps an already-stored card preference instead of forcing the new default', async () => {
    const alice = await user('deckold');
    // An account that explicitly saved the old look must survive the flip.
    ctx.db
      .prepare("UPDATE users SET card_back = 'indigo', four_color = 0 WHERE id = ?")
      .run(alice.userId);
    const me = (
      await ctx.app.inject({ method: 'GET', url: '/api/profile', headers: auth(alice.token) })
    ).json();
    expect(me.cardBack).toBe('indigo');
    expect(me.fourColor).toBe(false);
  });

  it('adds the card columns without rewriting an existing database', async () => {
    const dir = mkdtempSync(join(tmpdir(), '4am-card-'));
    const path = join(dir, 'old.sqlite');
    try {
      // An old database: the columns already exist with the retired defaults,
      // and one user explicitly saved the old look.
      const old = new Database(path);
      old.exec(`CREATE TABLE users (
        id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, auth_hash TEXT NOT NULL,
        auth_salt TEXT NOT NULL, pubkey TEXT NOT NULL, created_at INTEGER NOT NULL,
        card_back TEXT NOT NULL DEFAULT 'indigo', four_color INTEGER NOT NULL DEFAULT 0)`);
      old.prepare(
        'INSERT INTO users (username, auth_hash, auth_salt, pubkey, created_at, card_back, four_color) VALUES (?,?,?,?,?,?,?)',
      ).run('legacy', 'h', 's', 'p', 1, 'indigo', 0);
      old.close();

      const db = openDb(path);
      try {
        const legacy = db
          .prepare("SELECT card_back, four_color FROM users WHERE username = 'legacy'")
          .get() as { card_back: string; four_color: number };
        expect(legacy.card_back).toBe('indigo');
        expect(legacy.four_color).toBe(0);

        // A new account on this old database still gets the current default.
        const { userId } = createUser(db, 'fresh', 'a'.repeat(64), 'p');
        const fresh = db
          .prepare('SELECT card_back, four_color FROM users WHERE id = ?')
          .get(userId) as { card_back: string; four_color: number };
        expect(fresh.card_back).toBe('crimson');
        expect(fresh.four_color).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('updates display name and bio, and returns them', async () => {
    const alice = await user('alice');
    const put = await ctx.app.inject({
      method: 'PUT',
      url: '/api/profile',
      headers: auth(alice.token),
      payload: { displayName: 'Ace Alice', bio: 'river rat since 2020' },
    });
    expect(put.statusCode).toBe(200);
    const me = (
      await ctx.app.inject({ method: 'GET', url: '/api/profile', headers: auth(alice.token) })
    ).json();
    expect(me).toMatchObject({
      username: 'alice',
      displayName: 'Ace Alice',
      bio: 'river rat since 2020',
      hasAvatar: false,
    });
  });

  it('rejects an over-long bio', async () => {
    const alice = await user('alice');
    const put = await ctx.app.inject({
      method: 'PUT',
      url: '/api/profile',
      headers: auth(alice.token),
      payload: { bio: 'x'.repeat(281) },
    });
    expect(put.statusCode).toBe(400);
  });

  it('uploads, serves, and deletes an avatar with version bumps', async () => {
    const alice = await user('alice');
    const up = await ctx.app.inject({
      method: 'PUT',
      url: '/api/profile/avatar',
      headers: auth(alice.token),
      payload: { image: TINY_PNG },
    });
    expect(up.statusCode).toBe(200);
    expect(up.json().avatarVersion).toBe(1);

    const img = await ctx.app.inject({ method: 'GET', url: `/api/users/${alice.userId}/avatar` });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.rawPayload.length).toBeGreaterThan(20);

    const del = await ctx.app.inject({
      method: 'DELETE',
      url: '/api/profile/avatar',
      headers: auth(alice.token),
    });
    expect(del.statusCode).toBe(200);
    const gone = await ctx.app.inject({ method: 'GET', url: `/api/users/${alice.userId}/avatar` });
    expect(gone.statusCode).toBe(404);
  });

  it('rejects a non-image or oversized upload', async () => {
    const alice = await user('alice');
    const notImage = await ctx.app.inject({
      method: 'PUT',
      url: '/api/profile/avatar',
      headers: auth(alice.token),
      payload: { image: 'data:text/html;base64,PGI+aGk8L2I+' },
    });
    expect(notImage.statusCode).toBe(400);
    const huge = await ctx.app.inject({
      method: 'PUT',
      url: '/api/profile/avatar',
      headers: auth(alice.token),
      payload: { image: 'data:image/png;base64,' + 'A'.repeat(500_000) },
    });
    expect(huge.statusCode).toBe(400);
  });
});

describe('quick-bet ratio slots', () => {
  const getProfile = async (token: string) =>
    (await ctx.app.inject({ method: 'GET', url: '/api/profile', headers: auth(token) })).json();
  const putRatios = (token: string, betRatios: number[]) =>
    ctx.app.inject({
      method: 'PUT',
      url: '/api/profile',
      headers: auth(token),
      payload: { betRatios },
    });

  it('defaults to the current five-slot list, 150% included', () => {
    expect(BET_RATIO_SLOTS).toBe(5);
    expect(DEFAULT_BET_RATIOS).toEqual([1 / 3, 0.5, 0.75, 1, 1.5]);
    expect(BET_RATIO_OPTIONS).toContain(1.5);
    expect(BET_RATIO_OPTIONS).toContain(ALL_IN_RATIO);
  });

  it('round-trips five slots including the 150% preset', async () => {
    const alice = await user('bets5');
    // Never saved: the GET omits the field so the client keeps its local pick.
    expect((await getProfile(alice.token)).betRatios).toBeUndefined();
    const five = [1 / 3, 0.5, 0.75, 1, 1.5];
    expect((await putRatios(alice.token, five)).statusCode).toBe(200);
    expect((await getProfile(alice.token)).betRatios).toEqual(five);
    const raw = ctx.db
      .prepare('SELECT bet_ratios FROM users WHERE id = ?')
      .get(alice.userId) as { bet_ratios: string };
    expect(JSON.parse(raw.bet_ratios)).toEqual(five);
  });

  it('keeps a legacy four-slot list readable', async () => {
    const alice = await user('bets4');
    const four = [0.5, 1, 1.5, ALL_IN_RATIO];
    expect((await putRatios(alice.token, four)).statusCode).toBe(200);
    expect((await getProfile(alice.token)).betRatios).toEqual(four);
  });

  it('accepts an all-in slot in the five-slot shape', async () => {
    const alice = await user('betsallin');
    const five = [1 / 3, 0.5, 1.5, 2, ALL_IN_RATIO];
    expect((await putRatios(alice.token, five)).statusCode).toBe(200);
    expect((await getProfile(alice.token)).betRatios).toEqual(five);
  });

  it('rejects a list that is neither four nor five slots', async () => {
    const alice = await user('betsbad');
    expect((await putRatios(alice.token, [1 / 3, 0.5, 0.75])).statusCode).toBe(400);
    expect((await putRatios(alice.token, [1 / 3, 0.5, 0.75, 1, 1.5, 2])).statusCode).toBe(400);
  });

  it('rejects a foreign ratio', async () => {
    const alice = await user('betsbad2');
    expect((await putRatios(alice.token, [1 / 3, 0.5, 0.75, 1, 99])).statusCode).toBe(400);
  });
});

describe('leaderboards', () => {
  it('ranks players by net hand winnings with hands played and biggest win', async () => {
    const host = await user('host');
    const bob = await user('bob');
    const room = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/rooms',
        headers: auth(host.token),
        payload: { name: 'r', sb: 1, bb: 2 },
      })
    ).json();
    // simulate settled hands directly in the ledger
    appendLedger(ctx.db, { roomId: room.id, userId: host.userId, delta: 100, kind: 'hand-settlement', ref: 'h1' });
    appendLedger(ctx.db, { roomId: room.id, userId: bob.userId, delta: -100, kind: 'hand-settlement', ref: 'h1' });
    appendLedger(ctx.db, { roomId: room.id, userId: host.userId, delta: -30, kind: 'hand-settlement', ref: 'h2' });
    appendLedger(ctx.db, { roomId: room.id, userId: bob.userId, delta: 30, kind: 'hand-settlement', ref: 'h2' });
    appendLedger(ctx.db, { roomId: room.id, userId: host.userId, delta: 500, kind: 'purchase' }); // ignored

    const lb = (
      await ctx.app.inject({ method: 'GET', url: '/api/leaderboard', headers: auth(host.token) })
    ).json();
    expect(lb.rows).toHaveLength(2);
    expect(lb.rows[0]).toMatchObject({ username: 'host', net: 70, handsPlayed: 2, biggestWin: 100 });
    expect(lb.rows[1]).toMatchObject({ username: 'bob', net: -70, handsPlayed: 2, biggestWin: 30 });
  });

  it('room leaderboard is scoped and member-only', async () => {
    const host = await user('host');
    const stranger = await user('stranger');
    const room = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/rooms',
        headers: auth(host.token),
        payload: { name: 'r', sb: 1, bb: 2 },
      })
    ).json();
    appendLedger(ctx.db, { roomId: room.id, userId: host.userId, delta: 40, kind: 'hand-settlement', ref: 'h1' });
    const ok = await ctx.app.inject({
      method: 'GET',
      url: `/api/rooms/${room.id}/leaderboard`,
      headers: auth(host.token),
    });
    expect(ok.json().rows[0]).toMatchObject({ username: 'host', net: 40 });
    const denied = await ctx.app.inject({
      method: 'GET',
      url: `/api/rooms/${room.id}/leaderboard`,
      headers: auth(stranger.token),
    });
    expect(denied.statusCode).toBe(403);
  });
});

describe('user profile page data', () => {
  it('returns stats, rivals, and transactions', async () => {
    const a = await user('aa');
    const b = await user('bb');
    const c = await user('cc');
    const room = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/rooms',
        headers: auth(a.token),
        payload: { name: 'r', sb: 1, bb: 2 },
      })
    ).json();
    // two hands with b, one with c
    appendLedger(ctx.db, { roomId: room.id, userId: a.userId, delta: 50, kind: 'hand-settlement', ref: 'h1' });
    appendLedger(ctx.db, { roomId: room.id, userId: b.userId, delta: -50, kind: 'hand-settlement', ref: 'h1' });
    appendLedger(ctx.db, { roomId: room.id, userId: a.userId, delta: -20, kind: 'hand-settlement', ref: 'h2' });
    appendLedger(ctx.db, { roomId: room.id, userId: b.userId, delta: 20, kind: 'hand-settlement', ref: 'h2' });
    appendLedger(ctx.db, { roomId: room.id, userId: a.userId, delta: 10, kind: 'hand-settlement', ref: 'h3' });
    appendLedger(ctx.db, { roomId: room.id, userId: c.userId, delta: -10, kind: 'hand-settlement', ref: 'h3' });

    const p = (
      await ctx.app.inject({ method: 'GET', url: `/api/users/${a.userId}/profile`, headers: auth(b.token) })
    ).json();
    expect(p.stats).toMatchObject({ net: 40, handsPlayed: 3, biggestWin: 50 });
    expect(p.rivals[0]).toMatchObject({ username: 'bb', handsTogether: 2, netVs: 30 });
    expect(p.rivals[1]).toMatchObject({ username: 'cc', handsTogether: 1, netVs: 10 });
    // the money rail carries settlement notes, so it is owner-only
    expect(p.transactions).toEqual([]);

    const own = (
      await ctx.app.inject({ method: 'GET', url: `/api/users/${a.userId}/profile`, headers: auth(a.token) })
    ).json();
    expect(own.transactions).toHaveLength(3);
  });

  it('treats an instant repeat buy-in as the same buy, not a second one', async () => {
    const host = await user('dedup1');
    const room = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/rooms',
        headers: auth(host.token),
        payload: { name: 'dd', sb: 1, bb: 2 },
      })
    ).json();
    const buy = () =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/rooms/${room.id}/buy`,
        headers: auth(host.token),
        payload: { amount: 500 },
      });

    const first = (await buy()).json();
    const second = (await buy()).json();
    // the double-tap gets the first request back rather than creating another
    expect(second.duplicate).toBe(true);
    expect(second.id).toBe(first.id);
    const rows = ctx.db
      .prepare('SELECT COUNT(*) as n FROM buy_requests WHERE room_id = ? AND user_id = ?')
      .get(room.id, host.userId) as { n: number };
    expect(rows.n).toBe(1);

    // a different amount is a different intent and still goes through
    const other = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/buy`,
      headers: auth(host.token),
      payload: { amount: 250 },
    });
    expect(other.json().duplicate).toBeUndefined();
  });

  it('charges house dues to the players who won the raked pots', async () => {
    const winner = await user('hd1');
    const loser = await user('hd2');
    const room = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/rooms',
        headers: auth(winner.token),
        payload: { name: 'rake', sb: 1, bb: 2 },
      })
    ).json();

    // one hand: the winner takes 198 of a 200 pot, 2 goes to the house
    appendLedger(ctx.db, { roomId: room.id, userId: winner.userId, delta: 198, kind: 'hand-settlement', ref: 'hh1' });
    appendLedger(ctx.db, { roomId: room.id, userId: loser.userId, delta: -200, kind: 'hand-settlement', ref: 'hh1' });
    appendLedger(ctx.db, { roomId: room.id, userId: winner.userId, delta: 2, kind: 'commission', ref: 'hh1' });

    const duesOf = async (u: { token: string }) =>
      (await ctx.app.inject({ method: 'GET', url: '/api/me/house', headers: auth(u.token) })).json();

    // the rake came off the pot the winner collected, so it is theirs to owe
    expect(await duesOf(winner)).toMatchObject({ accrued: 2, paid: 0, outstanding: 2 });
    // the player who lost the hand did not pay the rake and owes the house nothing
    expect(await duesOf(loser)).toMatchObject({ accrued: 0, outstanding: 0 });

    const paid = await ctx.app.inject({
      method: 'POST',
      url: '/api/house/pay',
      headers: auth(winner.token),
      payload: { amount: 2, note: 'upi' },
    });
    expect(paid.statusCode).toBe(200);
    expect(await duesOf(winner)).toMatchObject({ accrued: 2, paid: 2, outstanding: 0 });
  });

  it('numbers players by the order they joined the platform', async () => {
    const before = (
      ctx.db.prepare('SELECT COALESCE(MAX(join_number), 0) as n FROM users').get() as { n: number }
    ).n;
    const first = await user('jo1');
    const second = await user('jo2');
    const third = await user('jo3');

    const numberOf = async (u: { userId: number; token: string }) =>
      (await ctx.app.inject({ method: 'GET', url: `/api/users/${u.userId}/profile`, headers: auth(u.token) })).json()
        .joinNumber;

    expect(await numberOf(first)).toBe(before + 1);
    expect(await numberOf(second)).toBe(before + 2);
    expect(await numberOf(third)).toBe(before + 3);

    // the number is its own fact, not a restatement of the row id: it must
    // survive a gap in the primary key
    ctx.db.prepare('DELETE FROM users WHERE id = ?').run(second.userId);
    const fourth = await user('jo4');
    expect(await numberOf(fourth)).toBe(before + 4);
    expect(await numberOf(third)).toBe(before + 3);
  });

  it('hides stats and rivals from others when private mode is on', async () => {
    const a = await user('pa');
    const b = await user('pb');
    ctx.db.prepare('UPDATE users SET private_mode = 1 WHERE id = ?').run(a.userId);

    const seen = (
      await ctx.app.inject({ method: 'GET', url: `/api/users/${a.userId}/profile`, headers: auth(b.token) })
    ).json();
    expect(seen.hidden).toBe(true);
    expect(seen.stats).toBeNull();
    expect(seen.rivals).toEqual([]);
    expect(seen.transactions).toEqual([]);
    // ...but the owner still sees their own page in full
    const mine = (
      await ctx.app.inject({ method: 'GET', url: `/api/users/${a.userId}/profile`, headers: auth(a.token) })
    ).json();
    expect(mine.hidden).toBeUndefined();
    expect(mine.stats).not.toBeNull();
  });
});
