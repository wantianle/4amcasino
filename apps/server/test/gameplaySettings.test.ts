import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { appendLedger } from '../src/ledger.js';
import { activeHands } from '../src/liveHands.js';
import { ROOM_FEATURE_DEFAULTS } from '../src/gameplaySettings.js';

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

async function makeRoom(hostToken: string, payload: Record<string, unknown> = {}) {
  return (
    await ctx.app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: auth(hostToken),
      payload: { name: 'r', sb: 1, bb: 2, ...payload },
    })
  ).json();
}

async function join(room: { joinCode: string }, token: string) {
  await ctx.app.inject({
    method: 'POST',
    url: '/api/rooms/join',
    headers: auth(token),
    payload: { joinCode: room.joinCode },
  });
}

const setFeatures = (roomId: string, token: string, features: unknown) =>
  ctx.app.inject({
    method: 'PUT',
    url: `/api/rooms/${roomId}/settings`,
    headers: auth(token),
    payload: { features },
  });

describe('room gameplay settings', () => {
  it('creates rooms with the migrated defaults and exposes them under features', async () => {
    const host = await user('gs_host');
    const room = await makeRoom(host.token);
    expect(room.features).toEqual(ROOM_FEATURE_DEFAULTS);
  });

  it('accepts and normalizes a features payload at creation time', async () => {
    const host = await user('gs_create');
    const room = await makeRoom(host.token, {
      features: { squid: { enabled: true, penaltyBb: 5, minPlayers: 2 } },
    });
    expect(room.features.squid).toEqual({ enabled: true, penaltyBb: 5, minPlayers: 2 });
    // untouched sections keep their defaults
    expect(room.features.bombPot).toEqual(ROOM_FEATURE_DEFAULTS.bombPot);
  });

  it('is host-only, not banker, and rejects bad limits', async () => {
    const host = await user('gs_owner');
    const alice = await user('gs_backup');
    const room = await makeRoom(host.token);
    await join(room, alice.token);
    // promote alice to backup banker: still not allowed to touch features
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/rooms/${room.id}/co-banker`,
      headers: auth(host.token),
      payload: { userId: alice.userId },
    });
    const denied = await setFeatures(room.id, alice.token, { squid: { enabled: true } });
    expect(denied.statusCode).toBe(403);

    const bad = await setFeatures(room.id, host.token, { squid: { penaltyBb: 0 } });
    expect(bad.statusCode).toBe(400);

    const badCadence = await setFeatures(room.id, host.token, {
      bombPot: { enabled: true, schedule: { mode: 'duration', value: 5 } },
    });
    expect(badCadence.statusCode).toBe(400);

    const ok = await setFeatures(room.id, host.token, {
      squid: { enabled: true, penaltyBb: 5, minPlayers: 2 },
      bombPot: { enabled: true, anteBb: 2 },
    });
    expect(ok.statusCode).toBe(200);
    const state = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/rooms/${room.id}`,
        headers: auth(host.token),
      })
    ).json();
    expect(state.features.squid).toEqual({ enabled: true, penaltyBb: 5, minPlayers: 2 });
    expect(state.features.bombPot.anteBb).toBe(2);
  });

  it('rejects feature changes while a hand is in progress', async () => {
    const host = await user('gs_live');
    const room = await makeRoom(host.token);
    activeHands.add(room.id);
    try {
      const res = await setFeatures(room.id, host.token, { squid: { enabled: true } });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('Gameplay settings apply between hands.');
    } finally {
      activeHands.delete(room.id);
    }
  });

  it('bumps the time-bank epoch and resets players on a config change', async () => {
    const host = await user('tb_host');
    const alice = await user('tb_alice');
    const room = await makeRoom(host.token);
    await join(room, alice.token);

    const on = await setFeatures(room.id, host.token, {
      timeBank: { enabled: true, initialSeconds: 45 },
    });
    expect(on.statusCode).toBe(200);
    const epoch1 = (
      ctx.db.prepare('SELECT time_bank_epoch as e FROM rooms WHERE id = ?').get(room.id) as {
        e: number;
      }
    ).e;
    expect(epoch1).toBe(1);
    for (const u of [host.userId, alice.userId]) {
      const row = ctx.db
        .prepare(
          'SELECT time_bank_ms as ms, time_bank_hands as hands, time_bank_epoch as epoch FROM room_players WHERE room_id = ? AND user_id = ?',
        )
        .get(room.id, u) as { ms: number; hands: number; epoch: number };
      expect(row).toEqual({ ms: 45_000, hands: 0, epoch: 1 });
    }

    // an unrelated feature change leaves the epoch alone
    await setFeatures(room.id, host.token, { squid: { enabled: true } });
    expect(
      (
        ctx.db.prepare('SELECT time_bank_epoch as e FROM rooms WHERE id = ?').get(room.id) as {
          e: number;
        }
      ).e,
    ).toBe(1);

    // disabling the bank still bumps the epoch so clients drop the old config
    await setFeatures(room.id, host.token, { timeBank: { enabled: false } });
    expect(
      (
        ctx.db.prepare('SELECT time_bank_epoch as e FROM rooms WHERE id = ?').get(room.id) as {
          e: number;
        }
      ).e,
    ).toBe(2);
  });
});

describe('manual feature triggers', () => {
  async function triggerRoom() {
    const host = await user('ft_host');
    const alice = await user('ft_alice');
    const room = await makeRoom(host.token, {
      features: {
        squid: { enabled: true, minPlayers: 2 },
        bombPot: { enabled: true },
      },
    });
    await join(room, alice.token);
    return { host, alice, room };
  }

  const post = (roomId: string, token: string, body: Record<string, unknown>) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/feature-triggers`,
      headers: auth(token),
      payload: body,
    });
  const del = (roomId: string, token: string, requestId: string) =>
    ctx.app.inject({
      method: 'DELETE',
      url: `/api/rooms/${roomId}/feature-triggers/${requestId}`,
      headers: auth(token),
    });

  it('is idempotent by request id and cancels pending manual triggers', async () => {
    const { host, alice, room } = await triggerRoom();

    const first = await post(room.id, host.token, { feature: 'squid', requestId: 'req-1' });
    expect(first.statusCode).toBe(200);
    expect(first.json().trigger).toMatchObject({
      requestId: 'req-1',
      feature: 'squid',
      source: 'manual',
      status: 'pending',
    });

    const repeat = await post(room.id, host.token, { feature: 'squid', requestId: 'req-1' });
    expect(repeat.json().duplicate).toBe(true);
    expect(repeat.json().trigger.id).toBe(first.json().trigger.id);

    // reusing the id for a different feature is a conflict, not a silent reuse
    const clash = await post(room.id, host.token, { feature: 'bomb', requestId: 'req-1' });
    expect(clash.statusCode).toBe(409);

    // only one pending trigger of a kind at a time
    const dupKind = await post(room.id, host.token, { feature: 'squid', requestId: 'req-2' });
    expect(dupKind.statusCode).toBe(409);

    // non-host cannot cancel
    expect((await del(room.id, alice.token, 'req-1')).statusCode).toBe(403);

    const cancel = await del(room.id, host.token, 'req-1');
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().ok).toBe(true);

    // with the slot free the next request goes through
    const next = await post(room.id, host.token, { feature: 'squid', requestId: 'req-2' });
    expect(next.statusCode).toBe(200);
  });

  it('gates squid triggers on the enabled flag and on the player count', async () => {
    const host = await user('ft_gate');
    const room = await makeRoom(host.token); // defaults on, one player
    // Squid is on by default, so turn it off first: the 400 below must come from
    // the disabled gate, not from the player-count gate that also returns 400.
    await setFeatures(room.id, host.token, { squid: { enabled: false } });
    const disabled = await post(room.id, host.token, { feature: 'squid', requestId: 'x' });
    expect(disabled.statusCode).toBe(400);
    expect(disabled.json().error).toBe('squid game is not enabled for this table');

    // Now enabled, but still one player short of the default minimum (3).
    await setFeatures(room.id, host.token, { squid: { enabled: true, minPlayers: 3 } });
    const tooFew = await post(room.id, host.token, { feature: 'squid', requestId: 'y' });
    expect(tooFew.statusCode).toBe(400);
    expect(tooFew.json().error).toBe('squid game needs at least 3 players');
  });

  it('refuses triggers during a live hand', async () => {
    const { host, room } = await triggerRoom();
    activeHands.add(room.id);
    try {
      const res = await post(room.id, host.token, { feature: 'squid', requestId: 'live' });
      expect(res.statusCode).toBe(409);
    } finally {
      activeHands.delete(room.id);
    }
  });
});

describe('squid-game reporting', () => {
  it('folds squid rows into the hand net but not the hand count', async () => {
    const host = await user('sr_host');
    const bob = await user('sr_bob');
    const room = await makeRoom(host.token);
    await join(room, bob.token);

    // hand 1: host wins 50, then squid claws 10 back for bob
    appendLedger(ctx.db, { roomId: room.id, userId: host.userId, delta: 50, kind: 'hand-settlement', ref: 'h1' });
    appendLedger(ctx.db, { roomId: room.id, userId: bob.userId, delta: -50, kind: 'hand-settlement', ref: 'h1' });
    appendLedger(ctx.db, { roomId: room.id, userId: host.userId, delta: -10, kind: 'squid-game', ref: 'h1' });
    appendLedger(ctx.db, { roomId: room.id, userId: bob.userId, delta: 10, kind: 'squid-game', ref: 'h1' });
    // hand 2: host loses 20 but squid pays 30
    appendLedger(ctx.db, { roomId: room.id, userId: host.userId, delta: -20, kind: 'hand-settlement', ref: 'h2' });
    appendLedger(ctx.db, { roomId: room.id, userId: bob.userId, delta: 20, kind: 'hand-settlement', ref: 'h2' });
    appendLedger(ctx.db, { roomId: room.id, userId: host.userId, delta: 30, kind: 'squid-game', ref: 'h2' });
    appendLedger(ctx.db, { roomId: room.id, userId: bob.userId, delta: -30, kind: 'squid-game', ref: 'h2' });

    const profile = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/users/${host.userId}/profile`,
        headers: auth(bob.token),
      })
    ).json();
    // net = 40 + 10 = 50, but only 2 hands, and the per-hand figure 40 caps it
    expect(profile.stats).toMatchObject({ net: 50, handsPlayed: 2, biggestWin: 40 });

    const lb = (
      await ctx.app.inject({ method: 'GET', url: '/api/leaderboard', headers: auth(host.token) })
    ).json();
    const hostRow = lb.rows.find((r: { username: string }) => r.username === 'sr_host');
    expect(hostRow).toMatchObject({ net: 50, handsPlayed: 2, biggestWin: 40 });

    const session = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/rooms/${room.id}/session`,
        headers: auth(host.token),
      })
    ).json();
    const hostPlayer = session.players.find((p: { username: string }) => p.username === 'sr_host');
    expect(hostPlayer).toMatchObject({ net: 50, handsPlayed: 2, biggestWin: 40, wins: 2 });
  });
});
