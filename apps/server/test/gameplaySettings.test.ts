import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MULTI_RUN_MAX_RUNS } from '@4am/shared';
import { createApp } from '../src/app.js';
import { appendLedger } from '../src/ledger.js';
import { activeHands } from '../src/liveHands.js';
import { ROOM_FEATURE_DEFAULTS, migrateMultiRunFixed } from '../src/gameplaySettings.js';

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

  // Bomb-pot ante: the old 1/2/3 enum is now a whole-BB range (shared
  // BOMB_POT_ANTE_BB_MIN..MAX = 1..10). The DB column is an unconstrained
  // INTEGER, so these zod bounds plus the readRoomFeatures clamp are the
  // entire guard - they must cover both write paths (create and settings).
  it('accepts any whole BB bomb-pot ante from 1 to 10 and rejects outside', async () => {
    const host = await user('gs_ante');
    const room = await makeRoom(host.token);
    for (const anteBb of [1, 4, 5, 10]) {
      const ok = await setFeatures(room.id, host.token, { bombPot: { enabled: true, anteBb } });
      expect(ok.statusCode).toBe(200);
      const state = (
        await ctx.app.inject({ method: 'GET', url: `/api/rooms/${room.id}`, headers: auth(host.token) })
      ).json();
      expect(state.features.bombPot.anteBb).toBe(anteBb);
    }
    for (const anteBb of [0, 11, 2.5]) {
      const bad = await setFeatures(room.id, host.token, { bombPot: { enabled: true, anteBb } });
      expect(bad.statusCode).toBe(400);
    }
  });

  it('accepts a free-range ante at room creation too', async () => {
    const host = await user('gs_ante_create');
    const room = await makeRoom(host.token, {
      features: { bombPot: { enabled: true, anteBb: 7 } },
    });
    expect(room.features.bombPot.anteBb).toBe(7);
    const tooBig = await ctx.app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: auth(host.token),
      payload: { name: 'r2', sb: 1, bb: 2, features: { bombPot: { enabled: true, anteBb: 99 } } },
    });
    expect(tooBig.statusCode).toBe(400);
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

  it('refuses any time-bank config change (fixed "5 cards of 30s")', async () => {
    const host = await user('tb_host');
    const alice = await user('tb_alice');
    const room = await makeRoom(host.token);
    await join(room, alice.token);

    const epochOf = () =>
      (
        ctx.db.prepare('SELECT time_bank_epoch as e FROM rooms WHERE id = ?').get(room.id) as {
          e: number;
        }
      ).e;
    const bankOf = (userId: number) =>
      ctx.db
        .prepare(
          'SELECT time_bank_ms as ms, time_bank_hands as hands FROM room_players WHERE room_id = ? AND user_id = ?',
        )
        .get(room.id, userId) as { ms: number; hands: number };

    // creation seeded every player with one 30s card on a fresh epoch
    expect(epochOf()).toBe(1);
    expect(bankOf(host.userId)).toEqual({ ms: 30_000, hands: 0 });

    // any divergent value is rejected outright: no PUT can move the bank
    for (const patch of [
      { enabled: false },
      { initialSeconds: 45 },
      { refillEveryHands: 30 },
      { refillSeconds: 60 },
    ]) {
      const res = await setFeatures(room.id, host.token, { timeBank: patch });
      expect(res.statusCode).toBe(400);
    }
    expect(epochOf()).toBe(1);
    expect(bankOf(host.userId)).toEqual({ ms: 30_000, hands: 0 });

    // the canonical values are accepted but change nothing (idempotent)
    const canonical = await setFeatures(room.id, host.token, {
      timeBank: { enabled: true, initialSeconds: 30, refillEveryHands: 20, refillSeconds: 30 },
    });
    expect(canonical.statusCode).toBe(200);
    expect(epochOf()).toBe(1);
    expect(bankOf(host.userId)).toEqual({ ms: 30_000, hands: 0 });
  });

  it('refuses any multi-run config change (fixed heads-up product rule)', async () => {
    const host = await user('mr_host');
    const room = await makeRoom(host.token);

    // multi-run is always on with the fixed cap: no PUT can switch it off or
    // lower the cap (a hand-built request would otherwise let a host disable
    // the heads-up run-it-2/3 rule the engine now enforces).
    for (const patch of [{ enabled: false }, { maxRuns: 2 }, { maxRuns: 1 }]) {
      const res = await setFeatures(room.id, host.token, { multiRun: patch });
      expect(res.statusCode).toBe(400);
    }
    const state = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/rooms/${room.id}`,
        headers: auth(host.token),
      })
    ).json();
    expect(state.features.multiRun).toEqual({ enabled: true, maxRuns: 3 });

    // the canonical values are accepted but change nothing (idempotent)
    const canonical = await setFeatures(room.id, host.token, {
      multiRun: { enabled: true, maxRuns: 3 },
    });
    expect(canonical.statusCode).toBe(200);
    const after = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/rooms/${room.id}`,
        headers: auth(host.token),
      })
    ).json();
    expect(after.features.multiRun).toEqual({ enabled: true, maxRuns: 3 });
  });

  it('fixes the turn clock at 30s: a host cannot set actionSecs', async () => {
    const host = await user('tm_host');
    // creation still accepts the legacy key, but the room reports no override
    const created = await makeRoom(host.token, { actionSecs: 90 });
    expect(created.actionSecs).toBeNull();
    // and a settings PUT cannot write it either
    const put = await ctx.app.inject({
      method: 'PUT',
      url: `/api/rooms/${created.id}/settings`,
      headers: auth(host.token),
      payload: { actionSecs: 15 },
    });
    expect(put.statusCode).toBe(200); // the schema strips the unknown key
    const state = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/rooms/${created.id}`,
        headers: auth(host.token),
      })
    ).json();
    expect(state.actionSecs).toBeNull();
    expect(ctx.db.prepare('SELECT action_secs AS v FROM rooms WHERE id = ?').get(created.id)).toEqual(
      { v: null },
    );
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

describe('migrateMultiRunFixed', () => {
  it('normalizes a legacy room once, is marker-idempotent, and leaves player state alone', async () => {
    const host = await user('mr_mig_host');
    const guest = await user('mr_mig_guest');
    const room = await makeRoom(host.token);
    await join(room, guest.token);

    // Simulate a pre-change file: the host had switched multi-run off with cap 2,
    // and the one-time marker has not been written yet.
    ctx.db
      .prepare('UPDATE rooms SET multi_run_enabled = 0, multi_run_max_runs = 2 WHERE id = ?')
      .run(room.id);
    ctx.db.prepare('DELETE FROM meta WHERE key = ?').run('multi-run-fixed-1');

    const multiRunRow = () =>
      ctx.db
        .prepare(
          `SELECT multi_run_enabled AS enabled, multi_run_max_runs AS maxRuns
           FROM rooms WHERE id = ?`,
        )
        .get(room.id);
    // The pass must touch ONLY rooms.multi_run_*: money, bank and epochs stay put.
    const playerSnapshot = () =>
      ctx.db
        .prepare(
          `SELECT stack, time_bank_ms AS bankMs, time_bank_hands AS bankHands,
                  time_bank_epoch AS bankEpoch
           FROM room_players WHERE room_id = ? AND user_id = ?`,
        )
        .get(room.id, guest.userId);
    const before = playerSnapshot();

    migrateMultiRunFixed(ctx.db);

    expect(multiRunRow()).toEqual({ enabled: 1, maxRuns: MULTI_RUN_MAX_RUNS });
    expect(playerSnapshot()).toEqual(before);

    // Second run is a no-op: same 1/3, no double-apply.
    migrateMultiRunFixed(ctx.db);
    expect(multiRunRow()).toEqual({ enabled: 1, maxRuns: MULTI_RUN_MAX_RUNS });

    // Marker semantics: a later divergence is NOT re-normalized - the pass is
    // genuinely once-only, not merely idempotent-looking.
    ctx.db
      .prepare('UPDATE rooms SET multi_run_enabled = 0, multi_run_max_runs = 2 WHERE id = ?')
      .run(room.id);
    migrateMultiRunFixed(ctx.db);
    expect(multiRunRow()).toEqual({ enabled: 0, maxRuns: 2 });
  });
});
