import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { genIdentity } from '@4am/mental-poker';
import type { ServerMsg } from '@4am/shared';
import { createApp } from '../src/app.js';
import { GameRoom, activeHands } from '../src/game.js';
import { appendLedger, verifyLedger } from '../src/ledger.js';
import { setPlatformUserId } from '../src/platform.js';

type Ctx = ReturnType<typeof createApp>;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function register(app: Ctx['app'], username: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/register',
    payload: { username, authKey: 'a'.repeat(64), publicKey: 'b'.repeat(64) },
  });
  return res.json() as { userId: number; token: string };
}

async function createRoom(
  ctx: Ctx,
  token: string,
  name = 'Close Test',
  extra: Record<string, unknown> = {},
) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/rooms',
    headers: auth(token),
    payload: { name, sb: 10, bb: 20, ...extra },
  });
  return res.json() as { id: string; joinCode: string };
}

function becomeFriends(ctx: Ctx, a: number, b: number) {
  ctx.db
    .prepare("INSERT INTO friends (requester_id, target_id, status, created_at) VALUES (?, ?, 'accepted', ?)")
    .run(a, b, Date.now());
}

function memberCount(ctx: Ctx, roomId: string, userId: number): number {
  return (
    ctx.db
      .prepare('SELECT COUNT(*) AS n FROM room_players WHERE room_id = ? AND user_id = ?')
      .get(roomId, userId) as { n: number }
  ).n;
}

async function join(ctx: Ctx, token: string, joinCode: string) {
  await ctx.app.inject({
    method: 'POST',
    url: '/api/rooms/join',
    headers: auth(token),
    payload: { joinCode },
  });
}

/** Seat and fund a player directly - the close route must preserve this state. */
function seat(ctx: Ctx, roomId: string, userId: number, seat: number, stack: number) {
  ctx.db
    .prepare('UPDATE room_players SET seat = ?, sitting_out = 0, stack = ? WHERE room_id = ? AND user_id = ?')
    .run(seat, stack, roomId, userId);
}

interface PlayerRow {
  user_id: number;
  seat: number | null;
  sitting_out: number;
  stack: number;
}

describe('POST /api/rooms/:id/close', () => {
  it('host closes: archives, clears every seat, keeps stacks and the ledger', async () => {
    const ctx = createApp(':memory:');
    const host = await register(ctx.app, 'close_host');
    const bob = await register(ctx.app, 'close_bob');
    const room = await createRoom(ctx, host.token);
    await join(ctx, bob.token, room.joinCode);
    seat(ctx, room.id, host.userId, 0, 1000);
    seat(ctx, room.id, bob.userId, 1, 500);
    appendLedger(ctx.db, { roomId: room.id, userId: host.userId, delta: 1000, kind: 'purchase' });
    appendLedger(ctx.db, { roomId: room.id, userId: bob.userId, delta: 500, kind: 'purchase' });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/close`,
      headers: auth(host.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      roomId: string;
      archived: boolean;
      closedAt: number;
      alreadyClosed: boolean;
    };
    expect(body).toMatchObject({ ok: true, roomId: room.id, archived: true, alreadyClosed: false });
    expect(typeof body.closedAt).toBe('number');

    const row = ctx.db.prepare('SELECT archived, archived_at FROM rooms WHERE id = ?').get(room.id) as {
      archived: number;
      archived_at: number | null;
    };
    expect(row.archived).toBe(1);
    expect(row.archived_at).toBe(body.closedAt);

    const players = ctx.db
      .prepare('SELECT user_id, seat, sitting_out, stack FROM room_players WHERE room_id = ? ORDER BY user_id')
      .all(room.id) as PlayerRow[];
    expect(players).toHaveLength(2);
    for (const p of players) {
      expect(p.seat).toBeNull();
      expect(p.sitting_out).toBe(1);
    }
    // stacks survive: closing is archiving, not a cash-out or a delete
    expect(players.find((p) => p.user_id === host.userId)?.stack).toBe(1000);
    expect(players.find((p) => p.user_id === bob.userId)?.stack).toBe(500);
    expect(verifyLedger(ctx.db, room.id).ok).toBe(true);

    await ctx.app.close();
  });

  it('rejects a member who is neither the host nor the platform account, and a stranger', async () => {
    const ctx = createApp(':memory:');
    const host = await register(ctx.app, 'close_host2');
    const member = await register(ctx.app, 'close_member');
    const stranger = await register(ctx.app, 'close_stranger');
    const room = await createRoom(ctx, host.token);
    await join(ctx, member.token, room.joinCode);

    const memberRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/close`,
      headers: auth(member.token),
    });
    expect(memberRes.statusCode).toBe(403);

    const strangerRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/close`,
      headers: auth(stranger.token),
    });
    expect(strangerRes.statusCode).toBe(403);

    const row = ctx.db.prepare('SELECT archived FROM rooms WHERE id = ?').get(room.id) as {
      archived: number;
    };
    expect(row.archived).toBe(0);

    await ctx.app.close();
  });

  it('lets the platform admin close a room it is not hosting', async () => {
    const ctx = createApp(':memory:');
    const host = await register(ctx.app, 'close_host3');
    const platform = await register(ctx.app, 'close_platform');
    setPlatformUserId(ctx.db, platform.userId);
    const room = await createRoom(ctx, host.token);
    await join(ctx, host.token, room.joinCode); // host already a member; keeps it explicit
    seat(ctx, room.id, host.userId, 0, 800);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/close`,
      headers: auth(platform.token),
    });
    expect(res.statusCode).toBe(200);
    const row = ctx.db.prepare('SELECT archived FROM rooms WHERE id = ?').get(room.id) as {
      archived: number;
    };
    expect(row.archived).toBe(1);
    const player = ctx.db
      .prepare('SELECT seat, sitting_out FROM room_players WHERE room_id = ? AND user_id = ?')
      .get(room.id, host.userId) as { seat: number | null; sitting_out: number };
    expect(player.seat).toBeNull();
    expect(player.sitting_out).toBe(1);

    await ctx.app.close();
  });

  it('is idempotent: a second close returns 200 with alreadyClosed and changes nothing', async () => {
    const ctx = createApp(':memory:');
    const host = await register(ctx.app, 'close_host4');
    const room = await createRoom(ctx, host.token);
    seat(ctx, room.id, host.userId, 0, 400);

    const first = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/close`,
      headers: auth(host.token),
    });
    const firstBody = first.json() as { closedAt: number };
    expect(first.statusCode).toBe(200);

    const second = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/close`,
      headers: auth(host.token),
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as { ok: boolean; archived: boolean; closedAt: number; alreadyClosed: boolean };
    expect(secondBody).toMatchObject({
      ok: true,
      archived: true,
      alreadyClosed: true,
      closedAt: firstBody.closedAt,
    });

    await ctx.app.close();
  });
});

describe('close stops dealing, and history stays readable', () => {
  it('the engine refuses to deal after close and broadcasts archived room_state', async () => {
    const ctx = createApp(':memory:');
    const host = await register(ctx.app, 'closedeal_host');
    const bob = await register(ctx.app, 'closedeal_bob');
    const room = await createRoom(ctx, host.token);
    await join(ctx, bob.token, room.joinCode);
    seat(ctx, room.id, host.userId, 0, 1000);
    seat(ctx, room.id, bob.userId, 1, 1000);

    const game = new GameRoom(ctx.db, room.id, genIdentity(), {
      cryptoTimeoutMs: 60_000,
      actionTimeoutMs: 30_000,
      autoDealMs: 1_000_000,
      readyCheckMs: 100_000,
    });
    const sent: ServerMsg[] = [];
    const ws = { send: (text: string) => sent.push(JSON.parse(text)) } as unknown as WebSocket;
    game.join(host.userId, ws);

    const close = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/close`,
      headers: auth(host.token),
    });
    expect(close.statusCode).toBe(200);

    sent.length = 0;
    game.handleMessage(host.userId, { t: 'start_hand' });
    expect(sent.some((m) => m.t === 'hand_start')).toBe(false);
    expect(sent.find((m) => m.t === 'error')).toBeDefined();

    // the room_state the client leaves on carries archived=true
    game.broadcastRoomState();
    const state = sent.filter((m) => m.t === 'room_state').at(-1) as Extract<
      ServerMsg,
      { t: 'room_state' }
    > & { room: { archived?: boolean; archivedAt?: number | null } };
    expect(state.room.archived).toBe(true);
    expect(state.room.archivedAt).toBe(close.json().closedAt);

    game.shutdown();
    await ctx.app.close();
  });

  it('a former participant can still read the ledger and the hand transcript after close', async () => {
    const ctx = createApp(':memory:');
    const host = await register(ctx.app, 'closehist_host');
    const bob = await register(ctx.app, 'closehist_bob');
    const stranger = await register(ctx.app, 'closehist_stranger');
    const room = await createRoom(ctx, host.token);
    await join(ctx, bob.token, room.joinCode);
    seat(ctx, room.id, host.userId, 0, 900);
    seat(ctx, room.id, bob.userId, 1, 1100);

    const entries = JSON.stringify([
      {
        type: 'hand_start',
        payload: {
          seats: [
            { seat: 0, userId: host.userId },
            { seat: 1, userId: bob.userId },
          ],
        },
      },
      { type: 'action', payload: { seat: 0, action: { type: 'fold' } } },
    ]);
    ctx.db
      .prepare('INSERT INTO transcripts (hand_id, room_id, head, entries, ts) VALUES (?, ?, ?, ?, ?)')
      .run('hand_close_1', room.id, 'head_close_1', entries, Date.now());
    appendLedger(ctx.db, { roomId: room.id, userId: host.userId, delta: -100, kind: 'hand-settlement', ref: 'head_close_1' });
    appendLedger(ctx.db, { roomId: room.id, userId: bob.userId, delta: 100, kind: 'hand-settlement', ref: 'head_close_1' });

    await ctx.app.inject({ method: 'POST', url: `/api/rooms/${room.id}/close`, headers: auth(host.token) });

    // participant: reads still work
    const hands = await ctx.app.inject({
      method: 'GET',
      url: `/api/rooms/${room.id}/hands`,
      headers: auth(bob.token),
    });
    expect(hands.statusCode).toBe(200);
    const handsBody = hands.json() as { hands: { handId: string; outcome: string }[] };
    expect(handsBody.hands.map((h) => h.handId)).toContain('hand_close_1');

    const single = await ctx.app.inject({
      method: 'GET',
      url: `/api/rooms/${room.id}/hands/hand_close_1`,
      headers: auth(bob.token),
    });
    expect(single.statusCode).toBe(200);
    expect((single.json() as { entries: unknown[] }).entries).toHaveLength(2);

    const ledger = await ctx.app.inject({
      method: 'GET',
      url: `/api/rooms/${room.id}/ledger`,
      headers: auth(host.token),
    });
    expect(ledger.statusCode).toBe(200);
    const ledgerBody = ledger.json() as { entries: { kind: string }[]; verified: { ok: boolean } };
    expect(ledgerBody.verified.ok).toBe(true);
    expect(ledgerBody.entries.some((e) => e.kind === 'hand-settlement')).toBe(true);

    // a non-participant is still locked out
    const outsider = await ctx.app.inject({
      method: 'GET',
      url: `/api/rooms/${room.id}/ledger`,
      headers: auth(stranger.token),
    });
    expect(outsider.statusCode).toBe(403);

    await ctx.app.close();
  });
});

describe('GET /api/me/rooms', () => {
  it('lists only the rooms the caller was part of, including closed ones', async () => {
    const ctx = createApp(':memory:');
    const host = await register(ctx.app, 'merooms_host');
    const bob = await register(ctx.app, 'merooms_bob');
    const other = await register(ctx.app, 'merooms_other');

    const joined = await createRoom(ctx, host.token, 'Joined Room');
    await join(ctx, bob.token, joined.joinCode);
    seat(ctx, joined.id, bob.userId, 1, 300);
    appendLedger(ctx.db, { roomId: joined.id, userId: bob.userId, delta: 500, kind: 'purchase' });
    appendLedger(ctx.db, { roomId: joined.id, userId: bob.userId, delta: -100, kind: 'hand-settlement', ref: 'h_me_1' });

    const neverJoined = await createRoom(ctx, other.token, 'Other Room');

    await ctx.app.inject({ method: 'POST', url: `/api/rooms/${joined.id}/close`, headers: auth(host.token) });

    const res = await ctx.app.inject({ method: 'GET', url: '/api/me/rooms', headers: auth(bob.token) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      rooms: {
        roomId: string;
        name: string;
        hostId: number;
        hostName: string;
        isHost: boolean;
        archived: boolean;
        closedAt: number | null;
        myNet: number;
        myHands: number;
      }[];
    };
    const ids = body.rooms.map((r) => r.roomId);
    expect(ids).toContain(joined.id);
    expect(ids).not.toContain(neverJoined.id);

    const mine = body.rooms.find((r) => r.roomId === joined.id)!;
    expect(mine.name).toBe('Joined Room');
    expect(mine.hostId).toBe(host.userId);
    expect(mine.hostName).toBe('merooms_host');
    expect(mine.isHost).toBe(false);
    expect(mine.archived).toBe(true);
    expect(typeof mine.closedAt).toBe('number');
    // 500 bought, 100 lost to the hand, 300 left on the table
    expect(mine.myNet).toBe(300 - 500);
    expect(mine.myHands).toBe(1);

    // archived filter / pagination
    const archived = await ctx.app.inject({
      method: 'GET',
      url: '/api/me/rooms?archived=true',
      headers: auth(bob.token),
    });
    expect((archived.json() as { rooms: { roomId: string }[] }).rooms.map((r) => r.roomId)).toEqual([
      joined.id,
    ]);
    const active = await ctx.app.inject({
      method: 'GET',
      url: '/api/me/rooms?archived=false&limit=1&offset=0',
      headers: auth(bob.token),
    });
    expect((active.json() as { rooms: unknown[] }).rooms).toHaveLength(0);

    // the host sees both rooms it participated in
    const hostRes = await ctx.app.inject({ method: 'GET', url: '/api/me/rooms', headers: auth(host.token) });
    const hostIds = (hostRes.json() as { rooms: { roomId: string }[] }).rooms.map((r) => r.roomId);
    expect(hostIds).toContain(joined.id);

    await ctx.app.close();
  });
});

describe('B1: a closed table takes no new members', () => {
  it('rejects the old join code after close and adds no member; members still read', async () => {
    const ctx = createApp(':memory:');
    const host = await register(ctx.app, 'b1_join_host');
    const late = await register(ctx.app, 'b1_join_late');
    const room = await createRoom(ctx, host.token);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/close`,
      headers: auth(host.token),
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/rooms/join',
      headers: auth(late.token),
      payload: { joinCode: room.joinCode },
    });
    expect(res.statusCode).toBe(409);
    expect(memberCount(ctx, room.id, late.userId)).toBe(0);

    // an existing member can still read the closed room
    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/rooms/${room.id}`,
      headers: auth(host.token),
    });
    expect(read.statusCode).toBe(200);
    expect((read.json() as { youAre: string }).youAre).toBe('member');

    await ctx.app.close();
  });

  it('rejects public join after close and adds no member', async () => {
    const ctx = createApp(':memory:');
    const host = await register(ctx.app, 'b1_pub_host');
    const late = await register(ctx.app, 'b1_pub_late');
    const room = await createRoom(ctx, host.token, 'Public Close', { visibility: 'public' });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/close`,
      headers: auth(host.token),
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/join-public`,
      headers: auth(late.token),
    });
    expect(res.statusCode).toBe(409);
    expect(memberCount(ctx, room.id, late.userId)).toBe(0);

    // the closed table is gone from the public listing too
    const listing = await ctx.app.inject({
      method: 'GET',
      url: '/api/rooms/public',
      headers: auth(late.token),
    });
    expect((listing.json() as { rooms: { id: string }[] }).rooms.map((r) => r.id)).not.toContain(
      room.id,
    );

    await ctx.app.close();
  });

  it('rejects a new invite (auto-join) after close and adds no member', async () => {
    const ctx = createApp(':memory:');
    const host = await register(ctx.app, 'b1_inv_host');
    const friend = await register(ctx.app, 'b1_inv_friend');
    becomeFriends(ctx, host.userId, friend.userId);
    ctx.db.prepare('UPDATE users SET auto_join_invites = 1 WHERE id = ?').run(friend.userId);
    const room = await createRoom(ctx, host.token);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/close`,
      headers: auth(host.token),
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/invite`,
      headers: auth(host.token),
      payload: { userId: friend.userId },
    });
    expect(res.statusCode).toBe(409);
    expect(memberCount(ctx, room.id, friend.userId)).toBe(0);

    await ctx.app.close();
  });

  it('rejects accepting a pending invite after close and adds no member', async () => {
    const ctx = createApp(':memory:');
    const host = await register(ctx.app, 'b1_invr_host');
    const friend = await register(ctx.app, 'b1_invr_friend');
    becomeFriends(ctx, host.userId, friend.userId);
    const room = await createRoom(ctx, host.token);
    const invite = ctx.db
      .prepare("INSERT INTO invites (room_id, from_id, to_id, status, ts) VALUES (?, ?, ?, 'pending', ?)")
      .run(room.id, host.userId, friend.userId, Date.now());
    await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/close`,
      headers: auth(host.token),
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/invites/${Number(invite.lastInsertRowid)}/respond`,
      headers: auth(friend.token),
      payload: { accept: true },
    });
    expect(res.statusCode).toBe(409);
    expect(memberCount(ctx, room.id, friend.userId)).toBe(0);
    const stillPending = ctx.db
      .prepare('SELECT status FROM invites WHERE id = ?')
      .get(Number(invite.lastInsertRowid)) as { status: string };
    expect(stillPending.status).toBe('pending');

    // declining is still allowed after close
    const decline = await ctx.app.inject({
      method: 'POST',
      url: `/api/invites/${Number(invite.lastInsertRowid)}/respond`,
      headers: auth(friend.token),
      payload: { accept: false },
    });
    expect(decline.statusCode).toBe(200);

    await ctx.app.close();
  });

  it('rejects admitting a watcher after close and adds no member', async () => {
    const ctx = createApp(':memory:');
    const host = await register(ctx.app, 'b1_adm_host');
    const watcher = await register(ctx.app, 'b1_adm_watcher');
    const room = await createRoom(ctx, host.token);
    ctx.db
      .prepare('INSERT INTO spectators (room_id, user_id, ts) VALUES (?, ?, ?)')
      .run(room.id, watcher.userId, Date.now());
    ctx.db
      .prepare("INSERT INTO join_requests (room_id, user_id, status, ts) VALUES (?, ?, 'pending', ?)")
      .run(room.id, watcher.userId, Date.now());
    await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/close`,
      headers: auth(host.token),
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/admit`,
      headers: auth(host.token),
      payload: { userId: watcher.userId, accept: true },
    });
    expect(res.statusCode).toBe(409);
    expect(memberCount(ctx, room.id, watcher.userId)).toBe(0);
    const request = ctx.db
      .prepare("SELECT status FROM join_requests WHERE room_id = ? AND user_id = ?")
      .get(room.id, watcher.userId) as { status: string };
    expect(request.status).toBe('pending');

    await ctx.app.close();
  });
});

describe('B2: close and hand start are mutually exclusive', () => {
  const opts = {
    cryptoTimeoutMs: 60_000,
    actionTimeoutMs: 30_000,
    autoDealMs: 1_000_000,
    readyCheckMs: 100_000,
  };
  const fakeWs = (sink: ServerMsg[]) =>
    ({ send: (text: string) => sink.push(JSON.parse(text)) }) as unknown as WebSocket;

  it('a closed room claims no trigger and creates no hand (atomic gate)', async () => {
    const ctx = createApp(':memory:');
    const host = await register(ctx.app, 'b2a_host');
    const bob = await register(ctx.app, 'b2a_bob');
    const room = await createRoom(ctx, host.token);
    await join(ctx, bob.token, room.joinCode);
    seat(ctx, room.id, host.userId, 0, 1000);
    seat(ctx, room.id, bob.userId, 1, 1000);
    // bomb pot enabled with a manual pending trigger waiting to be claimed
    ctx.db.prepare('UPDATE rooms SET bomb_pot_enabled = 1 WHERE id = ?').run(room.id);
    ctx.db
      .prepare(
        `INSERT INTO room_feature_triggers (room_id, request_id, kind, source, status, requested_by, created_at)
         VALUES (?, 'req-1', 'bomb', 'manual', 'pending', ?, ?)`,
      )
      .run(room.id, host.userId, Date.now());

    const game = new GameRoom(ctx.db, room.id, genIdentity(), opts);
    const sent: ServerMsg[] = [];
    game.join(host.userId, fakeWs(sent));
    await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/close`,
      headers: auth(host.token),
    });

    sent.length = 0;
    game.handleMessage(host.userId, { t: 'start_hand' });
    expect(sent.some((m) => m.t === 'hand_start')).toBe(false);
    expect((game as unknown as { hand: unknown }).hand).toBeNull();
    expect(activeHands.has(room.id)).toBe(false);
    expect((game as unknown as { autoDealerId: () => number | null }).autoDealerId()).toBeNull();

    // the authoritative gate inside the claim transaction also aborts
    const seats = [
      { seat: 0, userId: host.userId, username: 'h', pubkey: 'b'.repeat(64), stack: 1000 },
      { seat: 1, userId: bob.userId, username: 'b', pubkey: 'b'.repeat(64), stack: 1000 },
    ];
    const claim = (
      game as unknown as {
        claimHandFeatures: (r: string, s: typeof seats, h: string) => unknown;
      }
    ).claimHandFeatures(room.id, seats, 'hand_b2a');
    expect(claim).toBeNull();

    const trigger = ctx.db
      .prepare('SELECT status FROM room_feature_triggers WHERE room_id = ?')
      .get(room.id) as { status: string };
    expect(trigger.status).toBe('pending');

    game.shutdown();
    await ctx.app.close();
  });

  it('a hand started before close keeps running and settles on its own', async () => {
    const ctx = createApp(':memory:');
    const host = await register(ctx.app, 'b2b_host');
    const bob = await register(ctx.app, 'b2b_bob');
    const room = await createRoom(ctx, host.token);
    await join(ctx, bob.token, room.joinCode);
    seat(ctx, room.id, host.userId, 0, 1000);
    seat(ctx, room.id, bob.userId, 1, 1000);

    const game = new GameRoom(ctx.db, room.id, genIdentity(), opts);
    const sent: ServerMsg[] = [];
    game.join(host.userId, fakeWs(sent));
    game.join(bob.userId, fakeWs(sent));
    (game as unknown as { startHand: () => void }).startHand();
    expect(activeHands.has(room.id)).toBe(true);
    expect((game as unknown as { hand: unknown }).hand).not.toBeNull();

    const close = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/close`,
      headers: auth(host.token),
    });
    expect(close.statusCode).toBe(200);
    // close does not tear down the hand already in flight
    expect(activeHands.has(room.id)).toBe(true);
    expect((game as unknown as { hand: unknown }).hand).not.toBeNull();

    game.shutdown();
    expect(activeHands.has(room.id)).toBe(false);
    await ctx.app.close();
  });
});

describe('close freezes seating and money movement', () => {
  it('refuses sit / leave_seat / sit_out over the socket after close', async () => {
    const ctx = createApp(':memory:');
    const host = await register(ctx.app, 'freeze_ws_host');
    const bob = await register(ctx.app, 'freeze_ws_bob');
    const room = await createRoom(ctx, host.token);
    await join(ctx, bob.token, room.joinCode);
    seat(ctx, room.id, host.userId, 0, 1000);

    const game = new GameRoom(ctx.db, room.id, genIdentity(), {
      cryptoTimeoutMs: 60_000,
      actionTimeoutMs: 30_000,
      autoDealMs: 1_000_000,
      readyCheckMs: 100_000,
    });
    const sent: ServerMsg[] = [];
    const ws = { send: (text: string) => sent.push(JSON.parse(text)) } as unknown as WebSocket;
    game.join(host.userId, ws);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/close`,
      headers: auth(host.token),
    });

    sent.length = 0;
    game.handleMessage(host.userId, { t: 'sit', seat: 3 });
    expect(sent.find((m) => m.t === 'error')).toBeDefined();
    const row = ctx.db
      .prepare('SELECT seat, sitting_out FROM room_players WHERE room_id = ? AND user_id = ?')
      .get(room.id, host.userId) as { seat: number | null; sitting_out: number };
    expect(row.seat).toBeNull();

    sent.length = 0;
    game.handleMessage(host.userId, { t: 'leave_seat' });
    expect(sent.find((m) => m.t === 'error')).toBeDefined();

    sent.length = 0;
    game.handleMessage(host.userId, { t: 'sit_out', sittingOut: false });
    expect(sent.find((m) => m.t === 'error')).toBeDefined();
    const after = ctx.db
      .prepare('SELECT sitting_out FROM room_players WHERE room_id = ? AND user_id = ?')
      .get(room.id, host.userId) as { sitting_out: number };
    expect(after.sitting_out).toBe(1);

    game.shutdown();
    await ctx.app.close();
  });

  it('refuses buy / approve / transfer after close and writes no chips', async () => {
    const ctx = createApp(':memory:');
    const host = await register(ctx.app, 'freeze_money_host');
    const bob = await register(ctx.app, 'freeze_money_bob');
    const room = await createRoom(ctx, host.token);
    await join(ctx, bob.token, room.joinCode);

    // a real pending buy request raised before close
    const buy = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/buy`,
      headers: auth(bob.token),
      payload: { amount: 100 },
    });
    expect(buy.statusCode).toBe(200);
    const requestId = (buy.json() as { id: number }).id;

    // an existing purchase for the banker to try (and fail) to revert
    appendLedger(ctx.db, { roomId: room.id, userId: bob.userId, delta: 100, kind: 'purchase' });
    const purchaseId = (
      ctx.db
        .prepare("SELECT id FROM ledger WHERE room_id = ? AND kind = 'purchase' ORDER BY id DESC LIMIT 1")
        .get(room.id) as { id: number }
    ).id;

    await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/close`,
      headers: auth(host.token),
    });

    const buyAfter = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/buy`,
      headers: auth(bob.token),
      payload: { amount: 100 },
    });
    expect(buyAfter.statusCode).toBe(409);

    const approveAfter = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/approve`,
      headers: auth(host.token),
      payload: { requestId, approve: true },
    });
    expect(approveAfter.statusCode).toBe(409);

    const transferAfter = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/transfer`,
      headers: auth(bob.token),
      payload: { toUserId: host.userId, amount: 10 },
    });
    expect(transferAfter.statusCode).toBe(409);

    const revertAfter = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/revert`,
      headers: auth(host.token),
      payload: { entryId: purchaseId },
    });
    expect(revertAfter.statusCode).toBe(409);

    // the rejected requests moved nothing: the seeded purchase is untouched
    // and no revert/transfer/purchase row was written by the blocked calls
    const purchases = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM ledger WHERE room_id = ? AND kind = 'purchase'")
      .get(room.id) as { n: number };
    expect(purchases.n).toBe(1);
    const reverts = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM ledger WHERE room_id = ? AND kind = 'revert'")
      .get(room.id) as { n: number };
    expect(reverts.n).toBe(0);
    const transfers = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM ledger WHERE room_id = ? AND kind = 'transfer'")
      .get(room.id) as { n: number };
    expect(transfers.n).toBe(0);
    const stillPending = ctx.db
      .prepare('SELECT status FROM buy_requests WHERE id = ?')
      .get(requestId) as { status: string };
    expect(stillPending.status).toBe('pending');

    await ctx.app.close();
  });
});

describe('myHands excludes voided hands', () => {
  it('counts settled, ignores squid/aborted, and maps void handId and head correctly', async () => {
    const ctx = createApp(':memory:');
    const host = await register(ctx.app, 'mh_host');
    const bob = await register(ctx.app, 'mh_bob');
    const room = await createRoom(ctx, host.token);
    await join(ctx, bob.token, room.joinCode);

    const settle = ctx.db.prepare(
      "INSERT INTO hand_settlements (hand_id, room_id, head, rake, final_stacks, applied_at) VALUES (?, ?, ?, 0, '[]', ?)",
    );
    // two settled hands: h1/head1, h2/head2 (hand id and settlement ref differ)
    settle.run('h1', room.id, 'head1', Date.now());
    settle.run('h2', room.id, 'head2', Date.now());
    appendLedger(ctx.db, { roomId: room.id, userId: bob.userId, delta: -100, kind: 'hand-settlement', ref: 'head1' });
    appendLedger(ctx.db, { roomId: room.id, userId: bob.userId, delta: -50, kind: 'hand-settlement', ref: 'head2' });
    // squid row shares head1's ref and must not add a second count
    appendLedger(ctx.db, { roomId: room.id, userId: bob.userId, delta: 10, kind: 'squid-game', ref: 'head1' });
    // an aborted hand: transcript but no settlement row
    ctx.db
      .prepare('INSERT INTO transcripts (hand_id, room_id, head, entries, ts) VALUES (?, ?, ?, ?, ?)')
      .run('h3', room.id, 'head3', '[]', Date.now());

    const handsOf = async (token: string) => {
      const res = await ctx.app.inject({ method: 'GET', url: '/api/me/rooms', headers: auth(token) });
      const body = res.json() as { rooms: { roomId: string; myHands: number }[] };
      return body.rooms.find((r) => r.roomId === room.id)!.myHands;
    };
    expect(await handsOf(bob.token)).toBe(2);

    // void written with the true hand id (h1 != head1)
    appendLedger(ctx.db, { roomId: room.id, userId: bob.userId, delta: 0, kind: 'void-hand', ref: 'h1' });
    expect(await handsOf(bob.token)).toBe(1);

    // void written with the settlement ref (head2), the live client convention
    appendLedger(ctx.db, { roomId: room.id, userId: bob.userId, delta: 0, kind: 'void-hand', ref: 'head2' });
    expect(await handsOf(bob.token)).toBe(0);

    await ctx.app.close();
  });
});

describe('GET /api/me/rooms query validation', () => {
  it('rejects invalid limit/offset with 400 instead of clamping', async () => {
    const ctx = createApp(':memory:');
    const host = await register(ctx.app, 'q_host');
    for (const q of ['limit=0', 'limit=201', 'limit=abc', 'limit=1.5', 'offset=-1']) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/me/rooms?${q}`,
        headers: auth(host.token),
      });
      expect(res.statusCode, q).toBe(400);
    }
    const ok = await ctx.app.inject({
      method: 'GET',
      url: '/api/me/rooms?limit=1&offset=0',
      headers: auth(host.token),
    });
    expect(ok.statusCode).toBe(200);
    await ctx.app.close();
  });
});

describe('close concurrency and idempotency', () => {
  it('two overlapping closes yield exactly one transition and a stable archived_at', async () => {
    const ctx = createApp(':memory:');
    const host = await register(ctx.app, 'conc_host');
    const room = await createRoom(ctx, host.token);
    seat(ctx, room.id, host.userId, 0, 500);

    const [a, b] = await Promise.all([
      ctx.app.inject({
        method: 'POST',
        url: `/api/rooms/${room.id}/close`,
        headers: auth(host.token),
      }),
      ctx.app.inject({
        method: 'POST',
        url: `/api/rooms/${room.id}/close`,
        headers: auth(host.token),
      }),
    ]);
    const bodies = [a.json(), b.json()] as {
      closedAt: number;
      alreadyClosed: boolean;
    }[];
    expect(bodies.filter((x) => x.alreadyClosed === false)).toHaveLength(1);
    expect(bodies.filter((x) => x.alreadyClosed === true)).toHaveLength(1);
    const transition = bodies.find((x) => !x.alreadyClosed)!;
    const repeat = bodies.find((x) => x.alreadyClosed)!;
    expect(repeat.closedAt).toBe(transition.closedAt);

    const row = ctx.db
      .prepare('SELECT archived, archived_at FROM rooms WHERE id = ?')
      .get(room.id) as { archived: number; archived_at: number };
    expect(row.archived).toBe(1);
    expect(row.archived_at).toBe(transition.closedAt);

    // a third one after the fact never overwrites the timestamp
    const third = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/close`,
      headers: auth(host.token),
    });
    expect((third.json() as { alreadyClosed: boolean; closedAt: number }).alreadyClosed).toBe(true);
    expect((third.json() as { closedAt: number }).closedAt).toBe(transition.closedAt);
    const after = ctx.db.prepare('SELECT archived_at FROM rooms WHERE id = ?').get(room.id) as {
      archived_at: number;
    };
    expect(after.archived_at).toBe(transition.closedAt);

    await ctx.app.close();
  });
});

describe('watcher semantics after close', () => {
  it('blocks new spectators, ask-join and spectate-settings; existing watcher stays read-only', async () => {
    const ctx = createApp(':memory:');
    const host = await register(ctx.app, 'watch_host');
    const existing = await register(ctx.app, 'watch_existing');
    const newbie = await register(ctx.app, 'watch_newbie');
    const room = await createRoom(ctx, host.token);

    const settings = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/spectate-settings`,
      headers: auth(host.token),
      payload: { allow: true },
    });
    expect(settings.statusCode).toBe(200);
    const token = (settings.json() as { token: string }).token;

    // an existing watcher joins before close
    const before = await ctx.app.inject({
      method: 'GET',
      url: `/api/watch/${token}`,
      headers: auth(existing.token),
    });
    expect(before.statusCode).toBe(200);
    expect((before.json() as { member: boolean }).member).toBe(false);

    await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/close`,
      headers: auth(host.token),
    });

    // a brand-new watcher is refused and no spectator row is created
    const blocked = await ctx.app.inject({
      method: 'GET',
      url: `/api/watch/${token}`,
      headers: auth(newbie.token),
    });
    expect(blocked.statusCode).toBe(403);
    const spectators = ctx.db
      .prepare('SELECT COUNT(*) AS n FROM spectators WHERE room_id = ? AND user_id = ?')
      .get(room.id, newbie.userId) as { n: number };
    expect(spectators.n).toBe(0);

    // the existing watcher can still resolve the link and read the room
    const again = await ctx.app.inject({
      method: 'GET',
      url: `/api/watch/${token}`,
      headers: auth(existing.token),
    });
    expect(again.statusCode).toBe(200);
    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/rooms/${room.id}`,
      headers: auth(existing.token),
    });
    expect(read.statusCode).toBe(200);
    expect((read.json() as { youAre: string }).youAre).toBe('spectator');

    // but cannot ask to be dealt in
    const ask = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/ask-join`,
      headers: auth(existing.token),
    });
    expect(ask.statusCode).toBe(409);

    // and the host cannot change watch settings on a closed table
    const change = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room.id}/spectate-settings`,
      headers: auth(host.token),
      payload: { allow: false },
    });
    expect(change.statusCode).toBe(409);

    await ctx.app.close();
  });
});
