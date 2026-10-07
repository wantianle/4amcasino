import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { DB } from '../src/db.js';
import { appendLedger } from '../src/ledger.js';

// ---------------------------------------------------------------------------
// Global void-hand correlation (Blocker 1).
//
// The projection tables key a hand by `hand_id`, but a settlement ledger row's
// `ref` is the transcript `head` - and the live client voids with that head.
// These tests build a real settled projection where hand_id !== head, drive the
// REAL `POST /void-hand` route with the head, and assert the global read models
// (/api/me/stats, /api/users/:id/stats, /api/rooms/:id/hud) stop counting it.
// A hand voided by the other convention (a direct `void-hand` row carrying the
// hand_id) is excluded too.
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

/** Write one settled hand + projection where `handId !== head`, plus the two
 *  settlement ledger rows the real void route reverses. `hero` defaults to
 *  winning 10 (1bb at bb=10); `heroDelta`/`bb` override for streak scenarios. */
function addSettledHand(
  db: DB,
  args: { id: string; roomId: string; head: string; hero: number; villain: number; heroDelta?: number; bb?: number },
): void {
  const bb = args.bb ?? 10;
  const heroDelta = args.heroDelta ?? 10;
  const villainDelta = -heroDelta;
  db.prepare(
    `INSERT INTO hands (hand_id, room_id, source_head, status, game_kind, bb, settled_at, transcript_ts, parser_version, projection_status)
     VALUES (?, ?, ?, 'settled', 'normal', ?, 1000, 1000, 1, 'ok')`,
  ).run(args.id, args.roomId, args.head, bb);
  db.prepare(
    "INSERT INTO hand_settlements (hand_id, room_id, head, rake, final_stacks, applied_at) VALUES (?, ?, ?, 0, '[]', ?)",
  ).run(args.id, args.roomId, args.head, 1000);
  const insPlayer = db.prepare(
    `INSERT INTO hand_players (
       hand_id, seat, user_id, position, position_index, preflop_order, postflop_order,
       blind_role, nominal_blind, forced_post, invested, poker_award, poker_delta, squid_delta,
       net_delta, folded, fold_street, saw_flop, went_to_showdown, won_poker, data_confidence
     ) VALUES (?, ?, ?, ?, NULL, NULL, ?, 'none', 0, 0, 0, 0, ?, 0, ?, 0, NULL, 0, 0, 0, 'exact')`,
  );
  insPlayer.run(args.id, 0, args.hero, 'BTN', 1, heroDelta, heroDelta);
  insPlayer.run(args.id, 1, args.villain, 'BB', 0, villainDelta, villainDelta);
  appendLedger(db, {
    roomId: args.roomId,
    userId: args.hero,
    delta: heroDelta,
    kind: 'hand-settlement',
    ref: args.head,
  });
  appendLedger(db, {
    roomId: args.roomId,
    userId: args.villain,
    delta: villainDelta,
    kind: 'hand-settlement',
    ref: args.head,
  });
}

async function meStats(token: string): Promise<number> {
  const res = await ctx.app.inject({ method: 'GET', url: '/api/me/stats', headers: auth(token) });
  expect(res.statusCode).toBe(200);
  return (res.json() as { sample: number }).sample;
}
async function userStats(token: string, userId: number): Promise<number> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/users/${userId}/stats`,
    headers: auth(token),
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { sample: number }).sample;
}
async function hudSample(token: string, roomId: string, userId: number): Promise<number> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/rooms/${roomId}/hud`,
    headers: auth(token),
  });
  expect(res.statusCode).toBe(200);
  const p = (res.json() as { players: { userId: number; sample: number }[] }).players.find(
    (x) => x.userId === userId,
  )!;
  return p.sample;
}

async function hudStreak(
  token: string,
  roomId: string,
  userId: number,
): Promise<{ tier: string | null; realNetBB: number; sample: number } | null> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/rooms/${roomId}/hud`,
    headers: auth(token),
  });
  expect(res.statusCode).toBe(200);
  const p = (
    res.json() as { players: { userId: number; streak: { tier: string | null; realNetBB: number; sample: number } | null }[] }
  ).players.find((x) => x.userId === userId)!;
  return p.streak;
}

describe('void-hand excludes a hand from every global stats read model', () => {
  it('a real POST /void-hand with the settlement head drops the hand from /me/stats, /users/:id/stats and /hud', async () => {
    const host = await register('vh_host');
    const bob = await register('vh_bob');
    makeRoom(ctx.db, 'r1', host.userId);
    joinRoom(ctx.db, 'r1', host.userId, 0);
    joinRoom(ctx.db, 'r1', bob.userId, 1);

    // control hand that stays settled
    addSettledHand(ctx.db, { id: 'h_keep', roomId: 'r1', head: 'head_keep', hero: bob.userId, villain: host.userId });
    // hand voided by its HEAD (the real client convention)
    addSettledHand(ctx.db, { id: 'h_head', roomId: 'r1', head: 'head_head', hero: bob.userId, villain: host.userId });
    // hand voided by its HAND ID (the other convention)
    addSettledHand(ctx.db, { id: 'h_hid', roomId: 'r1', head: 'head_hid', hero: bob.userId, villain: host.userId });
    appendLedger(ctx.db, { roomId: 'r1', userId: bob.userId, delta: 0, kind: 'void-hand', ref: 'h_hid' });

    // one is excluded already by the hand-id correlation
    expect(await meStats(bob.token)).toBe(2);
    expect(await userStats(host.token, bob.userId)).toBe(2);
    expect(await hudSample(host.token, 'r1', bob.userId)).toBe(2);

    // the real route: the client passes the settlement ref (= head), not the hand id
    const voidRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/rooms/r1/void-hand',
      headers: auth(host.token),
      payload: { handId: 'head_head' },
    });
    expect(voidRes.statusCode).toBe(200);
    expect((voidRes.json() as { reversed: number }).reversed).toBe(2);

    // now every global read model excludes it
    expect(await meStats(bob.token)).toBe(1);
    expect(await userStats(host.token, bob.userId)).toBe(1);
    expect(await hudSample(host.token, 'r1', bob.userId)).toBe(1);
  });

  it('accepts the hand id too and records the canonical settlement ref', async () => {
    const host = await register('vh2_host');
    const bob = await register('vh2_bob');
    makeRoom(ctx.db, 'r1', host.userId);
    joinRoom(ctx.db, 'r1', host.userId, 0);
    joinRoom(ctx.db, 'r1', bob.userId, 1);
    addSettledHand(ctx.db, { id: 'h_byid', roomId: 'r1', head: 'head_byid', hero: bob.userId, villain: host.userId });

    expect(await meStats(bob.token)).toBe(1);
    // pass the hand id: the route resolves it to the settlement head
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/rooms/r1/void-hand',
      headers: auth(host.token),
      payload: { handId: 'h_byid' },
    });
    expect(res.statusCode).toBe(200);
    const ref = (
      ctx.db
        .prepare("SELECT DISTINCT ref FROM ledger WHERE room_id = 'r1' AND kind = 'void-hand'")
        .get() as { ref: string }
    ).ref;
    expect(ref).toBe('head_byid');
    expect(await meStats(bob.token)).toBe(0);
  });

  it('blocks a second void when the first was written with the hand id (OR duplicate guard)', async () => {
    const host = await register('vd_host');
    const bob = await register('vd_bob');
    makeRoom(ctx.db, 'r1', host.userId);
    joinRoom(ctx.db, 'r1', host.userId, 0);
    joinRoom(ctx.db, 'r1', bob.userId, 1);
    addSettledHand(ctx.db, { id: 'h_dup', roomId: 'r1', head: 'head_dup', hero: bob.userId, villain: host.userId });

    // a legacy void recorded against the hand id
    appendLedger(ctx.db, { roomId: 'r1', userId: bob.userId, delta: 0, kind: 'void-hand', ref: 'h_dup' });
    const before = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM ledger WHERE room_id = 'r1' AND kind = 'void-hand'")
      .get() as { n: number };

    // the client now voids with the head: it must be recognised as the same hand
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/rooms/r1/void-hand',
      headers: auth(host.token),
      payload: { handId: 'head_dup' },
    });
    expect(res.statusCode).toBe(400);
    const after = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM ledger WHERE room_id = 'r1' AND kind = 'void-hand'")
      .get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('scopes the duplicate guard to the room', async () => {
    const host = await register('vd2_host');
    const bob = await register('vd2_bob');
    makeRoom(ctx.db, 'r1', host.userId);
    joinRoom(ctx.db, 'r1', host.userId, 0);
    joinRoom(ctx.db, 'r1', bob.userId, 1);
    addSettledHand(ctx.db, { id: 'h_scope', roomId: 'r1', head: 'head_scope', hero: bob.userId, villain: host.userId });

    // a void with the same ref in a DIFFERENT room must not block r1's void
    makeRoom(ctx.db, 'r2', host.userId);
    appendLedger(ctx.db, { roomId: 'r2', userId: bob.userId, delta: 0, kind: 'void-hand', ref: 'head_scope' });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/rooms/r1/void-hand',
      headers: auth(host.token),
      payload: { handId: 'head_scope' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('a real POST /void-hand with the head removes the hand from the streak net/tier', async () => {
    const host = await register('vs_host');
    const bob = await register('vs_bob');
    makeRoom(ctx.db, 'r1', host.userId);
    joinRoom(ctx.db, 'r1', host.userId, 0);
    joinRoom(ctx.db, 'r1', bob.userId, 1);

    // 25 wins of +25 chips (2.5bb each at bb=10) -> +62.5bb -> hot1
    for (let i = 0; i < 25; i++) {
      addSettledHand(ctx.db, {
        id: `vs_${i}`,
        roomId: 'r1',
        head: `head_vs_${i}`,
        hero: bob.userId,
        villain: host.userId,
        heroDelta: 25,
      });
    }
    // newest hand is a monster loss: counted at face value it drags the window
    // to 62.5 - 1000 = -937.5bb -> cold2; voided it must vanish and the badge
    // returns to hot1.
    addSettledHand(ctx.db, {
      id: 'vs_big',
      roomId: 'r1',
      head: 'head_vs_big',
      hero: bob.userId,
      villain: host.userId,
      heroDelta: -10_000,
    });

    expect(await hudStreak(host.token, 'r1', bob.userId)).toEqual({
      tier: 'cold2',
      realNetBB: -937.5,
      sample: 26,
    });

    // the void route makes the winner give the pot back, so it needs chips
    ctx.db
      .prepare("UPDATE room_players SET stack = 50000 WHERE room_id = 'r1' AND user_id = ?")
      .run(host.userId);
    const voidRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/rooms/r1/void-hand',
      headers: auth(host.token),
      payload: { handId: 'head_vs_big' },
    });
    expect(voidRes.statusCode).toBe(200);

    expect(await hudStreak(host.token, 'r1', bob.userId)).toEqual({
      tier: 'hot1',
      realNetBB: 62.5,
      sample: 25,
    });
  });
});
