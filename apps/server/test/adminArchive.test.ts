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
});
