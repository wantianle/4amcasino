import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { appendLedger } from '../src/ledger.js';

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

describe('my-rooms and hand history', () => {
  it('lists only my rooms', async () => {
    const host = await user('host');
    const stranger = await user('stranger');
    const room = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/rooms',
        headers: auth(host.token),
        payload: { name: 'Mine', sb: 5, bb: 10 },
      })
    ).json();
    const mine = (
      await ctx.app.inject({ method: 'GET', url: '/api/my-rooms', headers: auth(host.token) })
    ).json();
    expect(mine.rooms).toHaveLength(1);
    expect(mine.rooms[0]).toMatchObject({ id: room.id, name: 'Mine', playerCount: 1 });
    const none = (
      await ctx.app.inject({ method: 'GET', url: '/api/my-rooms', headers: auth(stranger.token) })
    ).json();
    expect(none.rooms).toHaveLength(0);
  });

  it('lists and fetches stored hand transcripts for members only', async () => {
    const host = await user('host');
    const stranger = await user('stranger');
    const room = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/rooms',
        headers: auth(host.token),
        payload: { name: 'x', sb: 1, bb: 2 },
      })
    ).json();
    ctx.db
      .prepare('INSERT INTO transcripts (hand_id, room_id, head, entries, ts) VALUES (?, ?, ?, ?, ?)')
      .run('hand1', room.id, 'deadbeef', JSON.stringify([{ seq: 0, type: 'hand_start' }]), 123);

    const list = (
      await ctx.app.inject({ method: 'GET', url: `/api/rooms/${room.id}/hands`, headers: auth(host.token) })
    ).json();
    expect(list.hands).toEqual([
      { handId: 'hand1', head: 'deadbeef', ts: 123, myNet: null, outcome: 'sat out', voided: false },
    ]);
    expect(list.total).toBe(1);
    expect(list.limit).toBe(100);
    expect(list.offset).toBe(0);

    const detail = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/rooms/${room.id}/hands/hand1`,
        headers: auth(host.token),
      })
    ).json();
    expect(detail.head).toBe('deadbeef');
    expect(detail.entries[0].type).toBe('hand_start');

    const denied = await ctx.app.inject({
      method: 'GET',
      url: `/api/rooms/${room.id}/hands`,
      headers: auth(stranger.token),
    });
    expect(denied.statusCode).toBe(403);
  });

  it('paginates transcripts newest-first and flags a hand_id-voided hand (hand_id !== head)', async () => {
    const host = await user('pager');
    const room = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/rooms',
        headers: auth(host.token),
        payload: { name: 'Paged', sb: 1, bb: 2 },
      })
    ).json();
    const ins = ctx.db.prepare(
      'INSERT INTO transcripts (hand_id, room_id, head, entries, ts) VALUES (?, ?, ?, ?, ?)',
    );
    // hand_id and head are deliberately different: the void ref uses the
    // hand_id, so a naive `ref = head` comparison would leave voided false.
    ins.run('h1', room.id, 'head1', '[]', 100);
    ins.run('h2', room.id, 'head2', '[]', 200);
    ins.run('h3', room.id, 'head3', '[]', 300);
    appendLedger(ctx.db, { roomId: room.id, userId: host.userId, delta: 0, kind: 'void-hand', ref: 'h2' });

    const page1 = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/rooms/${room.id}/hands?limit=2&offset=0`,
        headers: auth(host.token),
      })
    ).json();
    expect(page1.total).toBe(3);
    expect(page1.hands.map((h: { handId: string }) => h.handId)).toEqual(['h3', 'h2']);
    expect(page1.hands.find((h: { handId: string }) => h.handId === 'h2')!.voided).toBe(true);
    expect(page1.hands.find((h: { handId: string }) => h.handId === 'h3')!.voided).toBe(false);

    const page2 = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/rooms/${room.id}/hands?limit=2&offset=2`,
        headers: auth(host.token),
      })
    ).json();
    expect(page2.hands.map((h: { handId: string }) => h.handId)).toEqual(['h1']);

    const bad = await ctx.app.inject({
      method: 'GET',
      url: `/api/rooms/${room.id}/hands?limit=0`,
      headers: auth(host.token),
    });
    expect(bad.statusCode).toBe(400);
  });

  it('breaks ts ties on hand_id so same-millisecond hands page without duplicates or gaps', async () => {
    const host = await user('ties');
    const room = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/rooms',
        headers: auth(host.token),
        payload: { name: 'Ties', sb: 1, bb: 2 },
      })
    ).json();
    const ins = ctx.db.prepare(
      'INSERT INTO transcripts (hand_id, room_id, head, entries, ts) VALUES (?, ?, ?, ?, ?)',
    );
    // Five hands share one millisecond: a ts-only sort is not a total order, so
    // LIMIT/OFFSET could repeat or skip rows. The hand_id DESC tie-breaker must
    // make the order deterministic (h5, h4, h3, h2, h1).
    for (const id of ['h1', 'h2', 'h3', 'h4', 'h5']) ins.run(id, room.id, `head_${id}`, '[]', 1000);

    const page = async (offset: number) => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/rooms/${room.id}/hands?limit=2&offset=${offset}`,
        headers: auth(host.token),
      });
      return (res.json() as { hands: { handId: string }[] }).hands.map((h) => h.handId);
    };
    const page1 = await page(0);
    const page2 = await page(2);
    const page3 = await page(4);
    expect(page1).toEqual(['h5', 'h4']);
    expect(page2).toEqual(['h3', 'h2']);
    expect(page3).toEqual(['h1']);
    // No hand may appear on two pages, and none may be dropped.
    const all = [...page1, ...page2, ...page3];
    expect(new Set(all).size).toBe(5);
  });
});
