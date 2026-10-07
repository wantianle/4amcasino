import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { genIdentity } from '@4am/mental-poker';
import type { ServerMsg } from '@4am/shared';
import { openDb } from '../src/db.js';
import { GameRoom } from '../src/game.js';
import { createApp } from '../src/app.js';
import { roomEvents } from '../src/rooms.js';
import { setPlatformUserId } from '../src/platform.js';

/**
 * A host who goes offline keeps the role: there is no timer. This is the
 * regression guard for the incident where an offline host was auto-transferred
 * to a bot, which then locked the real owner out of their own settings.
 */
describe('host role is never handed over on a timer', () => {
  let db: ReturnType<typeof openDb>, room: GameRoom, sockets: WebSocket[];
  let messages: ServerMsg[][];
  beforeEach(() => {
    vi.useFakeTimers();
    db = openDb(':memory:');
    db.prepare(
      'INSERT INTO rooms (id,name,join_code,host_id,banker_id,sb,bb,auto_deal,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run('h1', 'Host', 'HOSTAA', 1, 1, 10, 20, 0, Date.now());
    for (let id = 1; id <= 3; id++) {
      db.prepare(
        'INSERT INTO users (id,username,auth_hash,auth_salt,pubkey,created_at) VALUES (?,?,?,?,?,?)',
      ).run(id, `player${id}`, 'test', 'test', genIdentity().publicKey, Date.now());
      db.prepare('INSERT INTO room_players (room_id,user_id,seat,stack) VALUES (?,?,?,?)').run(
        'h1',
        id,
        id - 1,
        1000,
      );
    }
    room = new GameRoom(db, 'h1', genIdentity(), {
      cryptoTimeoutMs: 60000,
      actionTimeoutMs: 30000,
      autoDealMs: 1000,
      readyCheckMs: 2000,
      shutdownDrainMs: 50,
    });
    messages = [[], [], []];
    sockets = messages.map(
      (list) => ({ send: (text: string) => list.push(JSON.parse(text)) }) as unknown as WebSocket,
    );
    for (let id = 1; id <= 3; id++) room.join(id, sockets[id - 1]!);
  });
  afterEach(async () => {
    vi.useRealTimers();
    await room.shutdown();
    db.close();
  });

  it('keeps the host after they leave, well past the old one-minute window', () => {
    const broadcasted = () =>
      messages.flat().filter((m) => m.t === 'chat' && m.from === '4AM');
    room.leave(1, sockets[0]!);
    expect(
      (db.prepare('SELECT host_id FROM rooms WHERE id = ?').get('h1') as { host_id: number })
        .host_id,
    ).toBe(1);
    // The removed handover fired at 60_000ms; wait three times that.
    vi.advanceTimersByTime(180_000);
    expect(
      (db.prepare('SELECT host_id FROM rooms WHERE id = ?').get('h1') as { host_id: number })
        .host_id,
    ).toBe(1);
    expect(broadcasted()).toHaveLength(0);
  });
});

describe('POST /api/rooms/:id/transfer-host', () => {
  let ctx: ReturnType<typeof createApp>;
  beforeEach(() => {
    ctx = createApp(':memory:');
  });
  afterEach(async () => {
    await ctx.app.close();
  });
  async function user(username: string) {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/register',
      payload: { username, authKey: 'a'.repeat(64), publicKey: 'b'.repeat(64) },
    });
    return response.json() as { token: string; userId: number };
  }
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  async function makeRoom() {
    const host = await user('host');
    const member = await user('member');
    const outsider = await user('outsider');
    const created = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/rooms',
        headers: auth(host.token),
        payload: { name: 'Host club', sb: 10, bb: 20 },
      })
    ).json() as { id: string };
    // `member` belongs to the room and is seated; `outsider` never joins.
    ctx.db
      .prepare('INSERT INTO room_players (room_id,user_id,seat) VALUES (?,?,?)')
      .run(created.id, member.userId, 0);
    return { host, member, outsider, id: created.id };
  }
  const transfer = (id: string, token: string, toUserId: unknown) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${id}/transfer-host`,
      headers: auth(token),
      payload: { toUserId },
    });
  const setBanker = (id: string, userId: number, co = false) =>
    ctx.db
      .prepare(`UPDATE rooms SET ${co ? 'co_banker_id' : 'banker_id'} = ? WHERE id = ?`)
      .run(userId, id);

  it('moves the role and the settings authority to the new host', async () => {
    const { host, member, id } = await makeRoom();
    expect((await transfer(id, host.token, member.userId)).statusCode).toBe(200);
    const room = (
      await ctx.app.inject({ url: `/api/rooms/${id}`, headers: auth(host.token) })
    ).json();
    expect(room.hostId).toBe(member.userId);
    // The old host loses the auto-deal switch; the new host gains it.
    expect(
      (
        await ctx.app.inject({
          method: 'PUT',
          url: `/api/rooms/${id}/settings`,
          headers: auth(host.token),
          payload: { autoDeal: false },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await ctx.app.inject({
          method: 'PUT',
          url: `/api/rooms/${id}/settings`,
          headers: auth(member.token),
          payload: { autoDeal: false },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('refuses anyone who is not the current host', async () => {
    const { member, id } = await makeRoom();
    // `member` is seated but not the host.
    expect((await transfer(id, member.token, member.userId)).statusCode).toBe(403);
  });

  it('refuses the main banker and the backup banker', async () => {
    const { host, member, id } = await makeRoom();
    // The main banker holds money authority, not the settings role.
    setBanker(id, member.userId);
    expect((await transfer(id, member.token, host.userId)).statusCode).toBe(403);
    // Nor does the backup banker.
    setBanker(id, member.userId, true);
    expect((await transfer(id, member.token, host.userId)).statusCode).toBe(403);
  });

  it('refuses a self-transfer', async () => {
    const { host, id } = await makeRoom();
    expect((await transfer(id, host.token, host.userId)).statusCode).toBe(400);
  });

  it('404s for a room that does not exist', async () => {
    const { host } = await makeRoom();
    expect((await transfer('deadbeef', host.token, host.userId)).statusCode).toBe(404);
  });

  it('refuses an archived or deleted table', async () => {
    const { host, member, id } = await makeRoom();
    ctx.db.prepare('UPDATE rooms SET archived = 1, archived_at = ? WHERE id = ?').run(Date.now(), id);
    expect((await transfer(id, host.token, member.userId)).statusCode).toBe(409);
    ctx.db.prepare('UPDATE rooms SET archived = 0, deleted = 1 WHERE id = ?').run(id);
    expect((await transfer(id, host.token, member.userId)).statusCode).toBe(409);
  });

  it('rejects a malformed target id', async () => {
    const { host, id } = await makeRoom();
    for (const bad of ['member', -1, 1.5, null, undefined]) {
      expect((await transfer(id, host.token, bad)).statusCode).toBe(400);
    }
    // A well-formed but unknown id is refused as "not in this room".
    expect((await transfer(id, host.token, 9_000_000_000)).statusCode).toBe(400);
  });

  it('leaves the main and backup banking roles untouched', async () => {
    const { host, member, id } = await makeRoom();
    const co = await user('cobanker');
    ctx.db
      .prepare('INSERT INTO room_players (room_id,user_id,seat) VALUES (?,?,?)')
      .run(id, co.userId, 1);
    setBanker(id, host.userId);
    setBanker(id, co.userId, true);
    expect((await transfer(id, host.token, member.userId)).statusCode).toBe(200);
    const room = ctx.db
      .prepare('SELECT banker_id, co_banker_id FROM rooms WHERE id = ?')
      .get(id) as { banker_id: number; co_banker_id: number };
    expect(room.banker_id).toBe(host.userId);
    expect(room.co_banker_id).toBe(co.userId);
  });

  it('emits a room "changed" event so the hub can refresh room_state', async () => {
    const { host, member, id } = await makeRoom();
    const seen: string[] = [];
    const onChange = (roomId: string) => seen.push(roomId);
    roomEvents.on('changed', onChange);
    try {
      expect((await transfer(id, host.token, member.userId)).statusCode).toBe(200);
    } finally {
      roomEvents.off('changed', onChange);
    }
    expect(seen).toContain(id);
  });

  it('refuses a target that is not a seated member of this room', async () => {
    const { host, member, outsider, id } = await makeRoom();
    // not a member at all
    expect((await transfer(id, host.token, outsider.userId)).statusCode).toBe(400);
    // a member but not seated
    ctx.db
      .prepare('UPDATE room_players SET seat = NULL WHERE room_id = ? AND user_id = ?')
      .run(id, member.userId);
    expect((await transfer(id, host.token, member.userId)).statusCode).toBe(400);
  });

  it('refuses the house account and bots as targets', async () => {
    const { host, member, id } = await makeRoom();
    setPlatformUserId(ctx.db, member.userId);
    expect((await transfer(id, host.token, member.userId)).statusCode).toBe(400);
    // Restore and instead mark the member a bot account at this room.
    setPlatformUserId(ctx.db, 0);
    ctx.db
      .prepare(
        `INSERT INTO bot_accounts (id,room_id,owner_id,user_id,status,policy_kind,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run('bot1', id, host.userId, member.userId, 'running', 'rules-v1', Date.now(), Date.now());
    expect((await transfer(id, host.token, member.userId)).statusCode).toBe(400);
  });
});
