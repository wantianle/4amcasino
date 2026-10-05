import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { setPlatformUserId } from '../src/platform.js';
import { roomEvents } from '../src/rooms.js';

// ---------------------------------------------------------------------------
// Blocker 2: the admin archive paths must share `/close`'s idempotent,
// seat-clearing transition - stable archived_at, no overwrite on a repeat, and
// no dealing into a retired table.
// ---------------------------------------------------------------------------

let ctx: ReturnType<typeof createApp>;
beforeEach(() => {
  ctx = createApp(':memory:');
});
afterEach(async () => {
  await ctx.app.close();
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function register(name: string) {
  const r = await ctx.app.inject({
    method: 'POST',
    url: '/api/register',
    payload: { username: name, authKey: 'a'.repeat(64), publicKey: 'b'.repeat(64) },
  });
  return { token: r.json().token as string, userId: r.json().userId as number };
}

async function createRoom(token: string, name = 'Admin Archive') {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/rooms',
    headers: auth(token),
    payload: { name, sb: 10, bb: 20 },
  });
  return res.json() as { id: string };
}

function seat(roomId: string, userId: number, seatNo: number, stack: number) {
  ctx.db
    .prepare('UPDATE room_players SET seat = ?, sitting_out = 0, stack = ? WHERE room_id = ? AND user_id = ?')
    .run(seatNo, stack, roomId, userId);
}

describe('admin archive shares the idempotent transition', () => {
  it('direct archive clears seats and keeps archived_at on a repeat', async () => {
    const host = await register('aa_host');
    const platform = await register('aa_platform');
    setPlatformUserId(ctx.db, platform.userId);
    const room = await createRoom(host.token);
    seat(room.id, host.userId, 0, 500);

    const first = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/rooms/${room.id}/archive`,
      headers: auth(platform.token),
      payload: { archived: true },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { archived: boolean; alreadyClosed: boolean; archivedAt: number };
    expect(firstBody).toMatchObject({ archived: true, alreadyClosed: false });
    expect(typeof firstBody.archivedAt).toBe('number');

    const row = ctx.db
      .prepare('SELECT archived, archived_at FROM rooms WHERE id = ?')
      .get(room.id) as { archived: number; archived_at: number };
    expect(row.archived).toBe(1);
    expect(row.archived_at).toBe(firstBody.archivedAt);
    const player = ctx.db
      .prepare('SELECT seat, sitting_out FROM room_players WHERE room_id = ? AND user_id = ?')
      .get(room.id, host.userId) as { seat: number | null; sitting_out: number };
    expect(player.seat).toBeNull();
    expect(player.sitting_out).toBe(1);

    const second = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/rooms/${room.id}/archive`,
      headers: auth(platform.token),
      payload: { archived: true },
    });
    const secondBody = second.json() as { alreadyClosed: boolean; archivedAt: number };
    expect(secondBody.alreadyClosed).toBe(true);
    expect(secondBody.archivedAt).toBe(firstBody.archivedAt);
    const after = ctx.db.prepare('SELECT archived_at FROM rooms WHERE id = ?').get(room.id) as {
      archived_at: number;
    };
    expect(after.archived_at).toBe(firstBody.archivedAt);
  });

  it('lifecycle approval archive clears seats and never overwrites an earlier archived_at', async () => {
    const host = await register('aa2_host');
    const platform = await register('aa2_platform');
    setPlatformUserId(ctx.db, platform.userId);
    const room = await createRoom(host.token, 'Lifecycle Archive');
    seat(room.id, host.userId, 0, 700);

    // the host queues an archive request
    const req = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/archive`,
      headers: auth(host.token),
      payload: { archived: true },
    });
    const { requestId } = req.json() as { requestId: number };

    // it is archived out from under the request first (e.g. the host /closes)
    const direct = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/close`,
      headers: auth(host.token),
    });
    const directAt = (direct.json() as { closedAt: number }).closedAt;

    // approving the now-redundant request changes nothing and preserves the time
    const decide = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/lifecycle/${requestId}`,
      headers: auth(platform.token),
      payload: { approve: true },
    });
    expect(decide.statusCode).toBe(200);
    const row = ctx.db
      .prepare('SELECT archived, archived_at FROM rooms WHERE id = ?')
      .get(room.id) as { archived: number; archived_at: number };
    expect(row.archived).toBe(1);
    expect(row.archived_at).toBe(directAt);
    const player = ctx.db
      .prepare('SELECT seat, sitting_out FROM room_players WHERE room_id = ? AND user_id = ?')
      .get(room.id, host.userId) as { seat: number | null; sitting_out: number };
    expect(player.seat).toBeNull();
    expect(player.sitting_out).toBe(1);
  });
});

describe('admin direct delete shares the idempotent transition', () => {
  let events: string[];
  let listener: (roomId: string) => void;
  beforeEach(() => {
    events = [];
    listener = (roomId: string) => events.push(roomId);
    roomEvents.on('changed', listener);
  });
  afterEach(() => {
    roomEvents.off('changed', listener);
  });

  const emissionsFor = (roomId: string) => events.filter((x) => x === roomId).length;
  const deletedRow = (roomId: string) =>
    ctx.db.prepare('SELECT deleted, deleted_at FROM rooms WHERE id = ?').get(roomId) as {
      deleted: number;
      deleted_at: number | null;
    };
  const directDelete = (token: string, roomId: string) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/admin/rooms/${roomId}/delete`,
      headers: auth(token),
    });

  it('first delete transitions and emits once; a repeat is a silent no-op with a stable timestamp', async () => {
    const host = await register('dd_host');
    const platform = await register('dd_platform');
    setPlatformUserId(ctx.db, platform.userId);
    const room = await createRoom(host.token, 'Direct Delete');

    const first = await directDelete(platform.token, room.id);
    expect(first.statusCode).toBe(200);
    expect(first.json() as { ok: boolean; changed: boolean }).toMatchObject({ ok: true, changed: true });
    expect(emissionsFor(room.id)).toBe(1);
    const firstRow = deletedRow(room.id);
    expect(firstRow.deleted).toBe(1);
    expect(typeof firstRow.deleted_at).toBe('number');
    const firstAt = firstRow.deleted_at;

    const second = await directDelete(platform.token, room.id);
    expect(second.statusCode).toBe(200);
    expect(second.json() as { ok: boolean; changed: boolean }).toMatchObject({
      ok: true,
      changed: false,
    });
    // no second emit, and the original deleted_at is preserved
    expect(emissionsFor(room.id)).toBe(1);
    const secondRow = deletedRow(room.id);
    expect(secondRow.deleted).toBe(1);
    expect(secondRow.deleted_at).toBe(firstAt);
  });

  it('is consistent with the lifecycle path: whichever deletes first wins, the other is a no-op', async () => {
    const host = await register('dd2_host');
    const platform = await register('dd2_platform');
    setPlatformUserId(ctx.db, platform.userId);
    const room = await createRoom(host.token, 'Lifecycle Delete');
    const request = (token: string, roomId: string) =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/rooms/${roomId}/delete`,
        headers: auth(token),
        payload: {},
      });
    const approve = (token: string, requestId: number) =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/admin/lifecycle/${requestId}`,
        headers: auth(token),
        payload: { approve: true },
      });

    // lifecycle delete first: approval emits once and stamps deleted_at
    const { requestId } = (await request(host.token, room.id)).json() as { requestId: number };
    expect((await approve(platform.token, requestId)).statusCode).toBe(200);
    expect(emissionsFor(room.id)).toBe(1);
    const lifecycleAt = deletedRow(room.id).deleted_at;
    expect(typeof lifecycleAt).toBe('number');

    // a direct delete afterwards changes nothing and does not re-emit
    const afterLifecycle = await directDelete(platform.token, room.id);
    expect((afterLifecycle.json() as { changed: boolean }).changed).toBe(false);
    expect(emissionsFor(room.id)).toBe(1);
    expect(deletedRow(room.id).deleted_at).toBe(lifecycleAt);

    // and the reverse order on a fresh room: direct delete wins, a later
    // redundant lifecycle approval is also a no-op
    const room2 = await createRoom(host.token, 'Lifecycle Delete Reverse');
    expect((await directDelete(platform.token, room2.id)).statusCode).toBe(200);
    expect(emissionsFor(room2.id)).toBe(1);
    const directAt = deletedRow(room2.id).deleted_at;
    const { requestId: req2 } = (await request(host.token, room2.id)).json() as { requestId: number };
    expect((await approve(platform.token, req2)).statusCode).toBe(200);
    expect(emissionsFor(room2.id)).toBe(1);
    expect(deletedRow(room2.id).deleted_at).toBe(directAt);
  });
});

describe('lifecycle approval emits room changes only on a real transition', () => {
  let events: string[];
  let listener: (roomId: string) => void;
  beforeEach(() => {
    events = [];
    listener = (roomId: string) => events.push(roomId);
    roomEvents.on('changed', listener);
  });
  afterEach(() => {
    roomEvents.off('changed', listener);
  });

  const archiveRequest = async (token: string, roomId: string, archived: boolean) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/archive`,
      headers: auth(token),
      payload: { archived },
    });
    return (res.json() as { requestId: number }).requestId;
  };
  const decide = async (token: string, requestId: number, approve: boolean) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/admin/lifecycle/${requestId}`,
      headers: auth(token),
      payload: { approve },
    });
  const emissionsFor = (roomId: string) => events.filter((x) => x === roomId).length;

  it('approve archive emits once; reject and a redundant archive emit nothing', async () => {
    const host = await register('le_host');
    const platform = await register('le_platform');
    setPlatformUserId(ctx.db, platform.userId);
    const room = await createRoom(host.token, 'Lifecycle Emit');

    // reject: no room change, no emit
    const rejected = await archiveRequest(host.token, room.id, true);
    await decide(platform.token, rejected, false);
    expect(emissionsFor(room.id)).toBe(0);

    // approve a fresh request: exactly one emit
    const approved = await archiveRequest(host.token, room.id, true);
    await decide(platform.token, approved, true);
    expect(emissionsFor(room.id)).toBe(1);
    const first = ctx.db.prepare('SELECT archived_at FROM rooms WHERE id = ?').get(room.id) as {
      archived_at: number;
    };

    // a later request that finds the room already archived changes nothing
    const redundant = await archiveRequest(host.token, room.id, true);
    await decide(platform.token, redundant, true);
    expect(emissionsFor(room.id)).toBe(1);
    const after = ctx.db
      .prepare('SELECT archived, archived_at FROM rooms WHERE id = ?')
      .get(room.id) as { archived: number; archived_at: number };
    expect(after.archived).toBe(1);
    expect(after.archived_at).toBe(first.archived_at);
  });

  it('unarchive is conditional: a real 1->0 emits and clears archived_at; a no-op does not', async () => {
    const host = await register('le2_host');
    const platform = await register('le2_platform');
    setPlatformUserId(ctx.db, platform.userId);
    const room = await createRoom(host.token, 'Lifecycle Unarchive');

    // archive directly (no route emit) so the listener only sees lifecycle emits
    ctx.db.prepare('UPDATE rooms SET archived = 1, archived_at = ? WHERE id = ?').run(1234, room.id);

    const req = await archiveRequest(host.token, room.id, false);
    await decide(platform.token, req, true);
    expect(emissionsFor(room.id)).toBe(1);
    const row = ctx.db
      .prepare('SELECT archived, archived_at FROM rooms WHERE id = ?')
      .get(room.id) as { archived: number; archived_at: number | null };
    expect(row.archived).toBe(0);
    expect(row.archived_at).toBeNull();

    // a second unarchive request now finds it already live: no emit, no change
    const noop = await archiveRequest(host.token, room.id, false);
    await decide(platform.token, noop, true);
    expect(emissionsFor(room.id)).toBe(1);
  });
});
