import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createApp } from '../src/app.js';
import type { DB } from '../src/db.js';
import { appendLedger } from '../src/ledger.js';
import { setPlatformUserId } from '../src/platform.js';
import { migrateHandStats } from '../src/handProjection.js';

// ---------------------------------------------------------------------------
// Blocker 1a: every read model must exclude a voided hand under BOTH
// historical conventions - `void-hand.ref = head` (the live client) and
// `void-hand.ref = hand_id` (legacy/other callers). These routes build their
// own SQL, so each is driven end to end with a real settled projection where
// hand_id !== head.
// ---------------------------------------------------------------------------

let ctx: ReturnType<typeof createApp>;
beforeEach(() => {
  ctx = createApp(':memory:');
});
afterEach(async () => {
  await ctx.app.close();
});

async function register(name: string): Promise<{ token: string; userId: number }> {
  const r = await ctx.app.inject({
    method: 'POST',
    url: '/api/register',
    payload: { username: name, authKey: 'a'.repeat(64), publicKey: 'b'.repeat(64) },
  });
  return { token: r.json().token as string, userId: r.json().userId as number };
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

function makeRoom(db: DB, id: string, hostId: number): void {
  db.prepare(
    'INSERT INTO rooms (id, name, join_code, host_id, banker_id, sb, bb, created_at) VALUES (?, ?, ?, ?, ?, 5, 10, ?)',
  ).run(id, id, `CODE${id}`, hostId, hostId, 1000);
}
function joinRoom(db: DB, roomId: string, userId: number, seat: number): void {
  db.prepare('INSERT INTO room_players (room_id, user_id, seat, stack) VALUES (?, ?, ?, ?)').run(
    roomId,
    userId,
    seat,
    1000,
  );
}

interface SeedHand {
  id: string;
  head: string;
  roomId: string;
  hero: number;
  villain: number;
  heroNet: number;
  commission: number;
  /** The `hands` projection has a globally UNIQUE source_head, so cross-room
   *  same-head fixtures skip it (these read models use ledger/transcripts). */
  withProjection?: boolean;
}

function seedHand(db: DB, h: SeedHand): void {
  const entries = JSON.stringify([
    {
      type: 'hand_start',
      payload: {
        seats: [
          { seat: 0, userId: h.hero },
          { seat: 1, userId: h.villain },
        ],
      },
    },
    { type: 'settlement', payload: { board: [0, 1, 2, 3, 4], reveals: [{ seat: 0, cards: [5, 6] }] } },
  ]);
  if (h.withProjection !== false) {
    db.prepare(
      `INSERT INTO hands (hand_id, room_id, source_head, status, game_kind, bb, settled_at, transcript_ts, parser_version, projection_status)
       VALUES (?, ?, ?, 'settled', 'normal', 10, 1000, 1000, 1, 'ok')`,
    ).run(h.id, h.roomId, h.head);
  }
  db.prepare('INSERT INTO transcripts (hand_id, room_id, head, entries, ts) VALUES (?, ?, ?, ?, ?)').run(
    h.id,
    h.roomId,
    h.head,
    entries,
    1000,
  );
  db.prepare(
    "INSERT INTO hand_settlements (hand_id, room_id, head, rake, final_stacks, applied_at) VALUES (?, ?, ?, 0, '[]', ?)",
  ).run(h.id, h.roomId, h.head, 1000);
  appendLedger(db, { roomId: h.roomId, userId: h.hero, delta: h.heroNet, kind: 'hand-settlement', ref: h.head });
  appendLedger(db, { roomId: h.roomId, userId: h.villain, delta: -h.heroNet, kind: 'hand-settlement', ref: h.head });
  appendLedger(db, { roomId: h.roomId, userId: h.hero, delta: h.commission, kind: 'commission', ref: h.head });
}

interface Ctx {
  hero: { token: string; userId: number };
  villain: { token: string; userId: number };
  platform: { token: string; userId: number };
}

/** Seed one kept and one voided (bigger) hand, then void it using the chosen
 *  convention. The voided hand would dominate every metric if not excluded. */
async function scenario(voidRef: 'head' | 'hand_id'): Promise<Ctx> {
  const hero = await register(`vhr_${voidRef}_hero`);
  const villain = await register(`vhr_${voidRef}_villain`);
  const platform = await register(`vhr_${voidRef}_platform`);
  setPlatformUserId(ctx.db, platform.userId);
  makeRoom(ctx.db, `r_${voidRef}`, hero.userId);
  joinRoom(ctx.db, `r_${voidRef}`, hero.userId, 0);
  joinRoom(ctx.db, `r_${voidRef}`, villain.userId, 1);
  seedHand(ctx.db, {
    id: `h_keep_${voidRef}`,
    head: `head_keep_${voidRef}`,
    roomId: `r_${voidRef}`,
    hero: hero.userId,
    villain: villain.userId,
    heroNet: 10,
    commission: 1,
  });
  seedHand(ctx.db, {
    id: `h_void_${voidRef}`,
    head: `head_void_${voidRef}`,
    roomId: `r_${voidRef}`,
    hero: hero.userId,
    villain: villain.userId,
    heroNet: 20,
    commission: 1,
  });
  appendLedger(ctx.db, {
    roomId: `r_${voidRef}`,
    userId: hero.userId,
    delta: 0,
    kind: 'void-hand',
    ref: voidRef === 'head' ? `head_void_${voidRef}` : `h_void_${voidRef}`,
  });
  return { hero, villain, platform };
}

async function expectAllReadModelsExclude(c: Ctx, tag: string) {
  const roomId = `r_${tag}`;

  // /api/users/:id/profile stats
  const profile = await ctx.app.inject({
    method: 'GET',
    url: `/api/users/${c.hero.userId}/profile`,
    headers: auth(c.hero.token),
  });
  expect(profile.statusCode).toBe(200);
  expect((profile.json() as { stats: { net: number; handsPlayed: number; biggestWin: number } }).stats).toMatchObject(
    { net: 10, handsPlayed: 1, biggestWin: 10 },
  );

  // /api/leaderboard
  const lb = await ctx.app.inject({ method: 'GET', url: '/api/leaderboard', headers: auth(c.hero.token) });
  const row = (lb.json() as { rows: { userId: number; net: number; handsPlayed: number }[] }).rows.find(
    (r) => r.userId === c.hero.userId,
  )!;
  expect(row).toMatchObject({ net: 10, handsPlayed: 1 });

  // /api/me/timeline
  const timeline = await ctx.app.inject({
    method: 'GET',
    url: '/api/me/timeline',
    headers: auth(c.hero.token),
  });
  const points = (timeline.json() as { points: { net: number }[] }).points;
  expect(points.at(-1)!.net).toBe(10);

  // /api/rooms/:id/session
  const session = await ctx.app.inject({
    method: 'GET',
    url: `/api/rooms/${roomId}/session`,
    headers: auth(c.hero.token),
  });
  const sBody = session.json() as {
    hands: number;
    biggestPot: number;
    players: { userId: number; handsPlayed: number }[];
  };
  expect(sBody.hands).toBe(1);
  expect(sBody.biggestPot).toBe(10);
  expect(sBody.players.find((p) => p.userId === c.hero.userId)!.handsPlayed).toBe(1);

  // /api/users/:id/style: the voided hand's actions must not shape the profile
  const style = await ctx.app.inject({
    method: 'GET',
    url: `/api/users/${c.hero.userId}/style`,
    headers: auth(c.hero.token),
  });
  expect((style.json() as { hands: number }).hands).toBe(1);

  // /api/users/:id/best-hand: the +20 voided hand must not win
  const best = await ctx.app.inject({
    method: 'GET',
    url: `/api/users/${c.hero.userId}/best-hand`,
    headers: auth(c.hero.token),
  });
  expect((best.json() as { hand: { handId: string; amount: number } }).hand).toMatchObject({
    handId: `h_keep_${tag}`,
    amount: 10,
  });

  // /api/admin/house (platformDues)
  const house = await ctx.app.inject({
    method: 'GET',
    url: '/api/admin/house',
    headers: auth(c.platform.token),
  });
  expect(house.statusCode).toBe(200);
  expect((house.json() as { totals: { accrued: number } }).totals.accrued).toBe(1);

  // /api/admin/overview hands count
  const overview = await ctx.app.inject({
    method: 'GET',
    url: '/api/admin/overview',
    headers: auth(c.platform.token),
  });
  expect(overview.statusCode).toBe(200);
  expect((overview.json() as { hands: number }).hands).toBe(1);
}

describe('void exclusion across profile / house / admin read models', () => {
  it('excludes a hand voided by its head (live client convention)', async () => {
    const c = await scenario('head');
    await expectAllReadModelsExclude(c, 'head');
  });

  it('excludes a hand voided by its hand_id (legacy convention)', async () => {
    const c = await scenario('hand_id');
    await expectAllReadModelsExclude(c, 'hand_id');
  });

  it('flags a hand_id-voided hand in /api/me/hand-history and is room-scoped', async () => {
    const c = await scenario('hand_id');
    const hist = await ctx.app.inject({
      method: 'GET',
      url: '/api/me/hand-history',
      headers: auth(c.hero.token),
    });
    expect(hist.statusCode).toBe(200);
    const hands = (hist.json() as { hands: { handId: string; voided: boolean }[] }).hands;
    expect(hands.find((h) => h.handId === 'h_void_hand_id')!.voided).toBe(true);
    expect(hands.find((h) => h.handId === 'h_keep_hand_id')!.voided).toBe(false);

    // a void in another room with the same ref string must not leak across rooms
    const other = await register('vhr_other');
    makeRoom(ctx.db, 'r_other', other.userId);
    joinRoom(ctx.db, 'r_other', other.userId, 0);
    seedHand(ctx.db, {
      id: 'h_shared',
      head: 'head_shared',
      roomId: 'r_other',
      hero: other.userId,
      villain: c.villain.userId,
      heroNet: 5,
      commission: 0,
    });
    // same ref value as a hand_id in a different room: must only void r_other's
    appendLedger(ctx.db, { roomId: 'r_other', userId: other.userId, delta: 0, kind: 'void-hand', ref: 'h_shared' });
    const otherHist = await ctx.app.inject({
      method: 'GET',
      url: '/api/me/hand-history',
      headers: auth(other.token),
    });
    const otherHands = (otherHist.json() as { hands: { handId: string; voided: boolean }[] }).hands;
    expect(otherHands.find((h) => h.handId === 'h_shared')!.voided).toBe(true);
  });
});

describe('profile read models are room-scoped and void-aware', () => {
  it('rivals do not link the same ref across rooms and drop after a void', async () => {
    const hero = await register('rv_hero');
    const opp1 = await register('rv_opp1');
    const other = await register('rv_other');
    const opp2 = await register('rv_opp2');
    makeRoom(ctx.db, 'r1', hero.userId);
    joinRoom(ctx.db, 'r1', hero.userId, 0);
    joinRoom(ctx.db, 'r1', opp1.userId, 1);
    makeRoom(ctx.db, 'r2', other.userId);
    joinRoom(ctx.db, 'r2', other.userId, 0);
    joinRoom(ctx.db, 'r2', opp2.userId, 1);

    // same head string in both rooms; hero only plays in r1
    seedHand(ctx.db, { id: 'r1_h', head: 'same_head', roomId: 'r1', hero: hero.userId, villain: opp1.userId, heroNet: 10, commission: 0, withProjection: false });
    seedHand(ctx.db, { id: 'r2_h', head: 'same_head', roomId: 'r2', hero: other.userId, villain: opp2.userId, heroNet: 5, commission: 0, withProjection: false });

    const rivalsOf = async (token: string) => {
      const res = await ctx.app.inject({ method: 'GET', url: `/api/users/${hero.userId}/profile`, headers: auth(token) });
      return (res.json() as { rivals: { userId: number }[] }).rivals.map((r) => r.userId);
    };
    let rivals = await rivalsOf(hero.token);
    expect(rivals).toContain(opp1.userId);
    expect(rivals).not.toContain(opp2.userId);
    expect(rivals).not.toContain(other.userId);

    // voiding the r1 hand removes the only shared hand -> no rivals at all
    appendLedger(ctx.db, { roomId: 'r1', userId: hero.userId, delta: 0, kind: 'void-hand', ref: 'same_head' });
    rivals = await rivalsOf(hero.token);
    expect(rivals).not.toContain(opp1.userId);
  });

  it('best-hand reads the transcript from the winning room, not a same-head other room', async () => {
    const hero = await register('bh_hero');
    const other = await register('bh_other');
    makeRoom(ctx.db, 'r1', hero.userId);
    joinRoom(ctx.db, 'r1', hero.userId, 0);
    makeRoom(ctx.db, 'r2', other.userId);
    joinRoom(ctx.db, 'r2', other.userId, 0);

    // the other room's same-head transcript is inserted first, so an
    // unfiltered `WHERE head=? LIMIT 1` would pick the wrong hand
    seedHand(ctx.db, { id: 'bh_other', head: 'bh_head', roomId: 'r2', hero: other.userId, villain: other.userId, heroNet: 1, commission: 0, withProjection: false });
    seedHand(ctx.db, { id: 'bh_hero', head: 'bh_head', roomId: 'r1', hero: hero.userId, villain: other.userId, heroNet: 100, commission: 0, withProjection: false });

    const res = await ctx.app.inject({ method: 'GET', url: `/api/users/${hero.userId}/best-hand`, headers: auth(hero.token) });
    expect((res.json() as { hand: { handId: string; amount: number } }).hand).toMatchObject({
      handId: 'bh_hero',
      amount: 100,
    });
  });

  it('hand-history net is room-scoped for a shared head string', async () => {
    const hero = await register('hh_hero');
    const v1 = await register('hh_v1');
    makeRoom(ctx.db, 'r1', hero.userId);
    joinRoom(ctx.db, 'r1', hero.userId, 0);
    joinRoom(ctx.db, 'r1', v1.userId, 1);
    makeRoom(ctx.db, 'r2', hero.userId);
    joinRoom(ctx.db, 'r2', hero.userId, 0);
    joinRoom(ctx.db, 'r2', v1.userId, 1);

    seedHand(ctx.db, { id: 'hh_1', head: 'hh_head', roomId: 'r1', hero: hero.userId, villain: v1.userId, heroNet: 10, commission: 0, withProjection: false });
    seedHand(ctx.db, { id: 'hh_2', head: 'hh_head', roomId: 'r2', hero: hero.userId, villain: v1.userId, heroNet: 5, commission: 0, withProjection: false });

    const res = await ctx.app.inject({ method: 'GET', url: '/api/me/hand-history', headers: auth(hero.token) });
    const hands = (res.json() as { hands: { handId: string; roomId: string; net: number }[] }).hands;
    expect(hands.find((h) => h.roomId === 'r1')!.net).toBe(10);
    expect(hands.find((h) => h.roomId === 'r2')!.net).toBe(5);
  });
});

describe('head uniqueness invariant', () => {
  it('rejects a second row for the same (room, head), the premise of the OR mapping', () => {
    const insTranscript = ctx.db.prepare(
      'INSERT INTO transcripts (hand_id, room_id, head, entries, ts) VALUES (?, ?, ?, ?, ?)',
    );
    insTranscript.run('t1', 'r1', 'head_same', '[]', 1);
    expect(() => insTranscript.run('t2', 'r1', 'head_same', '[]', 1)).toThrow();

    const insSettlement = ctx.db.prepare(
      "INSERT INTO hand_settlements (hand_id, room_id, head, rake, final_stacks, applied_at) VALUES (?, ?, ?, 0, '[]', ?)",
    );
    insSettlement.run('s1', 'r1', 'head_same', 1);
    expect(() => insSettlement.run('s2', 'r1', 'head_same', 1)).toThrow();

    // the scope is per room: the same head string in another room is fine
    expect(() => insTranscript.run('t3', 'r2', 'head_same', '[]', 1)).not.toThrow();
  });

  it('the migration preflight fails closed with duplicate detail and creates no index', () => {
    const raw = new Database(':memory:');
    try {
      raw.exec(`
        CREATE TABLE transcripts (hand_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, head TEXT NOT NULL);
        CREATE TABLE hand_settlements (hand_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, head TEXT NOT NULL);
      `);
      raw.prepare('INSERT INTO transcripts VALUES (?, ?, ?)').run('h1', 'r1', 'H');
      raw.prepare('INSERT INTO transcripts VALUES (?, ?, ?)').run('h2', 'r1', 'H');
      raw.prepare('INSERT INTO hand_settlements VALUES (?, ?, ?)').run('s1', 'r1', 'H');
      raw.prepare('INSERT INTO hand_settlements VALUES (?, ?, ?)').run('s2', 'r1', 'H');

      let err: Error | undefined;
      try {
        migrateHandStats(raw as unknown as DB);
      } catch (e) {
        err = e as Error;
      }
      expect(err).toBeDefined();
      // precise diagnostic: which table, room, head and how many rows
      expect(err!.message).toContain('transcripts');
      expect(err!.message).toContain('room=r1');
      expect(err!.message).toContain('head=H');
      expect(err!.message).toContain('rows=2');
      // fail-closed, not silent dedupe: no unique index was created
      const idx = raw
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_transcripts_room_head'")
        .get();
      expect(idx).toBeUndefined();
      // the offending audit rows are untouched
      expect((raw.prepare('SELECT COUNT(*) AS n FROM transcripts').get() as { n: number }).n).toBe(2);
    } finally {
      raw.close();
    }
  });
});
