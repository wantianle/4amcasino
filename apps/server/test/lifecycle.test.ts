import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { appendLedger, verifyLedger } from '../src/ledger.js';
import { settleRake } from '../src/rake.js';
import { setPlatformUserId } from '../src/platform.js';

async function register(app: ReturnType<typeof createApp>['app'], username: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/register',
    payload: { username, authKey: 'a'.repeat(64), publicKey: 'b'.repeat(64) },
  });
  return res.json() as { userId: number; token: string };
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

describe('lifecycle schema (Task 1)', () => {
  it('adds rooms.deleted / rooms.deleted_at columns', () => {
    const db = openDb(':memory:');
    const cols = db.pragma('table_info(rooms)') as { name: string }[];
    expect(cols.some((c) => c.name === 'deleted')).toBe(true);
    expect(cols.some((c) => c.name === 'deleted_at')).toBe(true);
    db.close();
  });
});

describe('exclude archived/deleted rooms from money and listings (Task 2)', () => {
  it('drops settle/house/public entries once a room is archived, then deleted', async () => {
    const ctx = createApp(':memory:');
    const alice = await register(ctx.app, 't2_alice');
    const bob = await register(ctx.app, 't2_bob');
    const house = await register(ctx.app, 't2_house');
    setPlatformUserId(ctx.db, house.userId);

    const room = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/rooms',
        headers: auth(alice.token),
        payload: { name: 'Lifecycle Test', sb: 10, bb: 20, visibility: 'public' },
      })
    ).json() as { id: string; joinCode: string };

    await ctx.app.inject({
      method: 'POST',
      url: '/api/rooms/join',
      headers: auth(bob.token),
      payload: { joinCode: room.joinCode },
    });

    for (const p of [alice, bob]) {
      const buyRes = (
        await ctx.app.inject({
          method: 'POST',
          url: `/api/rooms/${room.id}/buy`,
          headers: auth(p.token),
          payload: { amount: 500 },
        })
      ).json() as { id: number };
      await ctx.app.inject({
        method: 'POST',
        url: `/api/rooms/${room.id}/approve`,
        headers: auth(alice.token),
        payload: { requestId: buyRes.id, approve: true },
      });
    }

    // Simulate a settled hand: alice wins 200, bob loses 250, 50 goes to rake.
    ctx.db
      .prepare('UPDATE room_players SET stack = stack + ? WHERE room_id = ? AND user_id = ?')
      .run(200, room.id, alice.userId);
    ctx.db
      .prepare('UPDATE room_players SET stack = stack + ? WHERE room_id = ? AND user_id = ?')
      .run(-250, room.id, bob.userId);
    appendLedger(ctx.db, {
      roomId: room.id,
      userId: alice.userId,
      delta: 200,
      kind: 'hand-settlement',
      ref: 'h1',
    });
    appendLedger(ctx.db, {
      roomId: room.id,
      userId: bob.userId,
      delta: -250,
      kind: 'hand-settlement',
      ref: 'h1',
    });
    settleRake(ctx.db, { roomId: room.id, recipientId: house.userId, rake: 50, ref: 'h1', commissionBps: 100 });
    expect(verifyLedger(ctx.db, room.id).ok).toBe(true);

    async function settleOtherIds(token: string) {
      const res = await ctx.app.inject({ method: 'GET', url: '/api/me/settle', headers: auth(token) });
      const body = res.json() as { people: { otherUserId: number }[] };
      return body.people.map((p) => p.otherUserId);
    }
    async function houseAccrued(token: string) {
      const res = await ctx.app.inject({ method: 'GET', url: '/api/me/house', headers: auth(token) });
      return (res.json() as { accrued: number }).accrued;
    }
    async function myRoomIds(token: string) {
      const res = await ctx.app.inject({ method: 'GET', url: '/api/my-rooms', headers: auth(token) });
      const body = res.json() as { rooms: { id: string }[] };
      return body.rooms.map((r) => r.id);
    }
    async function publicRoomIds() {
      const res = await ctx.app.inject({ method: 'GET', url: '/api/rooms/public', headers: auth(alice.token) });
      const body = res.json() as { rooms: { id: string }[] };
      return body.rooms.map((r) => r.id);
    }

    // Before any lifecycle change: debt + commission + listings are all visible.
    expect(await settleOtherIds(bob.token)).toContain(alice.userId);
    expect(await houseAccrued(alice.token)).toBe(50);
    expect(await myRoomIds(bob.token)).toContain(room.id);
    expect(await publicRoomIds()).toContain(room.id);

    // Archived: drops out of settle + house + my-rooms. The default listing
    // hides retired tables (archiving means the room disappears); the explicit
    // `archived=all` view still returns it, so history is never lost.
    ctx.db.prepare('UPDATE rooms SET archived = 1, archived_at = ? WHERE id = ?').run(Date.now(), room.id);
    expect(await settleOtherIds(bob.token)).not.toContain(alice.userId);
    expect(await houseAccrued(alice.token)).toBe(0);
    expect(await myRoomIds(bob.token)).not.toContain(room.id);
    const allArchived = await ctx.app.inject({
      method: 'GET',
      url: '/api/my-rooms?archived=all',
      headers: auth(bob.token),
    });
    expect((allArchived.json() as { rooms: { id: string }[] }).rooms.map((r) => r.id)).toContain(
      room.id,
    );

    // Reset archived, then delete: drops out of settle + house + my-rooms + public.
    ctx.db.prepare('UPDATE rooms SET archived = 0, archived_at = NULL WHERE id = ?').run(room.id);
    expect(await settleOtherIds(bob.token)).toContain(alice.userId); // sanity: back once unarchived

    ctx.db.prepare('UPDATE rooms SET deleted = 1, deleted_at = ? WHERE id = ?').run(Date.now(), room.id);
    expect(await settleOtherIds(bob.token)).not.toContain(alice.userId);
    expect(await houseAccrued(alice.token)).toBe(0);
    expect(await myRoomIds(bob.token)).not.toContain(room.id);
    expect(await publicRoomIds()).not.toContain(room.id);

    await ctx.app.close();
  });
});
