import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { type DB } from '../src/db.js';
import { HUD_LOW_CONFIDENCE, HUD_MIN_SAMPLE, METRIC_VERSION } from '../src/handStats.js';

// ---------------------------------------------------------------------------
// Real HTTP route contract / privacy regression for the stats API (gate P1).
//
// This suite drives the actual Fastify routes over `app.inject` and seeds REAL
// projection rows (`hands` / `hand_players` / `hand_actions` /
// `hand_settlements`) - it never calls `computeHandStats` directly. That is the
// difference between testing the metric math and testing the wire contract a
// client (and the privacy gate) actually depends on.
//
// Focus areas deliberately under-covered by handStatsQuery.test.ts:
//   1. per-field redaction of private_mode /api/users/:id/stats
//   2. HUD confidence boundaries (19/20/49/50) and dataConfidence mapping
//   3. HUD ?roomId= vs path mismatch -> 400
//   4. minHands cannot lower the fixed HUD floor
//   5. hidden vs visible HUD entries share an identical key set, explicit nulls
//   6. 401 / 403 / 404 / 400 (including path ids) across every stats route
// ---------------------------------------------------------------------------

interface PlayerOpts {
  position?: string;
  postflopOrder?: number;
  pokerDelta?: number;
  dataConfidence?: string;
}
interface ResolvedPlayerOpts {
  position: string | null;
  postflopOrder: number | null;
  pokerDelta: number;
  dataConfidence: string;
}
interface P {
  seat: number;
  userId: number;
  o: ResolvedPlayerOpts;
}
const P = (seat: number, userId: number, o: PlayerOpts = {}): P => ({
  seat,
  userId,
  o: {
    position: o.position ?? null,
    postflopOrder: o.postflopOrder ?? null,
    pokerDelta: o.pokerDelta ?? 0,
    dataConfidence: o.dataConfidence ?? 'exact',
  },
});

interface A {
  no: number;
  street: string;
  type: string;
  userId: number;
  forced?: number;
  added?: number;
}
const A = (no: number, street: string, type: string, userId: number, forced = 0, added = 0): A => ({
  no,
  street,
  type,
  userId,
  forced,
  added,
});

interface HandInput {
  id: string;
  roomId?: string;
  bb?: number;
  settledAt?: number;
  players: P[];
  actions?: A[];
}

/** Write one settled hand and its projection rows exactly as the projector does. */
function addHand(db: DB, h: HandInput): void {
  const roomId = h.roomId ?? 'r1';
  const head = `head-${h.id}`;
  db.prepare(
    `INSERT INTO hands (hand_id, room_id, source_head, status, game_kind, bb, settled_at, transcript_ts, parser_version, projection_status)
     VALUES (?, ?, ?, 'settled', 'normal', ?, ?, 1000, 1, 'ok')`,
  ).run(h.id, roomId, head, h.bb ?? 10, h.settledAt ?? 1000);
  db.prepare(
    "INSERT INTO hand_settlements (hand_id, room_id, head, rake, final_stacks, applied_at) VALUES (?, ?, ?, 0, '[]', ?)",
  ).run(h.id, roomId, head, 1000);
  const insPlayer = db.prepare(
    `INSERT INTO hand_players (
       hand_id, seat, user_id, position, position_index, preflop_order, postflop_order,
       blind_role, nominal_blind, forced_post, invested, poker_award, poker_delta, squid_delta,
       net_delta, folded, fold_street, saw_flop, went_to_showdown, won_poker, data_confidence
     ) VALUES (?, ?, ?, ?, NULL, NULL, ?, 'none', 0, 0, 0, 0, ?, 0, ?, 0, NULL, 0, 0, 0, ?)`,
  );
  for (const p of h.players) {
    insPlayer.run(
      h.id,
      p.seat,
      p.userId,
      p.o.position,
      p.o.postflopOrder,
      p.o.pokerDelta,
      p.o.pokerDelta,
      p.o.dataConfidence,
    );
  }
  const insAction = db.prepare(
    `INSERT INTO hand_actions (hand_id, action_no, user_id, street, action_type, amount_added, is_forced)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const a of h.actions ?? []) {
    insAction.run(h.id, a.no, a.userId, a.street, a.type, a.added ?? 0, a.forced ?? 0);
  }
}

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

/** Seed `n` settled hands for `userId` vs an opponent outside the room. */
function seedHandsFor(
  db: DB,
  roomId: string,
  userId: number,
  n: number,
  opponentId: number,
  confidence = 'exact',
  tag = '',
): void {
  for (let i = 0; i < n; i++) {
    addHand(db, {
      id: `s-${tag}-${userId}-${i}`,
      roomId,
      players: [
        P(0, userId, { position: 'BTN', postflopOrder: 1, pokerDelta: 1, dataConfidence: confidence }),
        P(1, opponentId, { position: 'BB', postflopOrder: 0, pokerDelta: -1 }),
      ],
      actions: [A(0, 'preflop', 'raise', userId), A(1, 'preflop', 'fold', opponentId)],
    });
  }
}

const entryFor = (body: { players: { userId: number }[] }, userId: number): any =>
  (body.players as any[]).find((p) => p.userId === userId);

// ---------------------------------------------------------------------------
// 1. /api/users/:id/stats privacy contract
// ---------------------------------------------------------------------------

describe('GET /api/users/:id/stats privacy contract', () => {
  it('redacts every stats field to a non-owner of a private user, and reflects minHands', async () => {
    const alice = await register('alice');
    const bob = await register('bob');
    makeRoom(ctx.db, 'r1', alice.userId);
    joinRoom(ctx.db, 'r1', bob.userId, 0);
    joinRoom(ctx.db, 'r1', alice.userId, 1);
    seedHandsFor(ctx.db, 'r1', bob.userId, 3, alice.userId);
    ctx.db.prepare('UPDATE users SET private_mode = 1 WHERE id = ?').run(bob.userId);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/users/${bob.userId}/stats`,
      headers: auth(alice.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Every field is asserted one by one: a future refactor that leaks a single
    // breakdown back into the redacted shape fails here, not in production.
    expect(body.userId).toBe(bob.userId);
    expect(body.hidden).toBe(true);
    expect(body.metricVersion).toBe(METRIC_VERSION);
    expect(body.sample).toBe(0);
    expect(body.minHands).toBe(0);
    expect(body.sufficient).toBe(false);
    expect(body.dataQuality).toEqual({ exact: 0, legacy: 0, partial: 0, total: 0 });
    expect(body.stats).toBeNull();
    expect(body.byPosition).toBeNull();
    expect(body.byStreet).toBeNull();
    expect(body.byIpOop).toBeNull();
    expect(body.trend).toBeNull();
    expect(Array.isArray(body.approximations)).toBe(true);
    expect(body.approximations.length).toBeGreaterThan(0);

    // The redacted bundle still echoes the requested minHands for the gate.
    const withQuery = await ctx.app.inject({
      method: 'GET',
      url: `/api/users/${bob.userId}/stats?minHands=7`,
      headers: auth(alice.token),
    });
    expect(withQuery.statusCode).toBe(200);
    expect(withQuery.json().hidden).toBe(true);
    expect(withQuery.json().minHands).toBe(7);
    expect(withQuery.json().stats).toBeNull();

    // The owner is not redacted.
    const self = await ctx.app.inject({
      method: 'GET',
      url: `/api/users/${bob.userId}/stats`,
      headers: auth(bob.token),
    });
    expect(self.statusCode).toBe(200);
    expect(self.json().hidden).toBe(false);
    expect(self.json().sample).toBe(3);
    expect(self.json().stats).not.toBeNull();
    expect(self.json().stats.hands.hits).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 2 + 3 + 4. HUD confidence gates, dataConfidence mapping, roomId pinning
// ---------------------------------------------------------------------------

describe('GET /api/rooms/:id/hud confidence gates', () => {
  it('maps sample size onto insufficient/low/ok exactly at the boundaries', async () => {
    const host = await register('host');
    const p19 = await register('p19');
    const p20 = await register('p20');
    const p49 = await register('p49');
    const p50 = await register('p50');
    makeRoom(ctx.db, 'r1', host.userId);
    joinRoom(ctx.db, 'r1', host.userId, 0);
    joinRoom(ctx.db, 'r1', p19.userId, 1);
    joinRoom(ctx.db, 'r1', p20.userId, 2);
    joinRoom(ctx.db, 'r1', p49.userId, 3);
    joinRoom(ctx.db, 'r1', p50.userId, 4);
    seedHandsFor(ctx.db, 'r1', p19.userId, 19, 99, 'exact', 'b19');
    seedHandsFor(ctx.db, 'r1', p20.userId, 20, 99, 'exact', 'b20');
    seedHandsFor(ctx.db, 'r1', p49.userId, 49, 99, 'exact', 'b49');
    seedHandsFor(ctx.db, 'r1', p50.userId, 50, 99, 'exact', 'b50');

    const res = await ctx.app.inject({ method: 'GET', url: '/api/rooms/r1/hud', headers: auth(host.token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.minHands).toBe(HUD_MIN_SAMPLE);
    expect(HUD_MIN_SAMPLE).toBe(20);

    const below = entryFor(body, p19.userId);
    expect(below).toMatchObject({
      sample: 19,
      sufficient: false,
      confidence: 'insufficient',
      stats: null,
      byPosition: null,
      byStreet: null,
      byIpOop: null,
      trend: null,
    });

    const at = entryFor(body, p20.userId);
    expect(at.sample).toBe(20);
    expect(at.sufficient).toBe(true);
    expect(at.confidence).toBe('low');
    expect(at.stats).not.toBeNull();

    const mid = entryFor(body, p49.userId);
    expect(mid.sample).toBe(49);
    expect(mid.sufficient).toBe(true);
    expect(mid.confidence).toBe('low');

    const full = entryFor(body, p50.userId);
    expect(full.sample).toBe(50);
    expect(full.sufficient).toBe(true);
    expect(full.confidence).toBe('ok');
    expect(HUD_LOW_CONFIDENCE).toBe(50);
  });

  it('maps dataQuality onto the HUD dataConfidence field (partial > legacy > exact)', async () => {
    const host = await register('host2');
    const ex = await register('exactP');
    const lg = await register('legacyP');
    const pt = await register('partialP');
    makeRoom(ctx.db, 'r1', host.userId);
    for (const [i, u] of [host, ex, lg, pt].entries()) joinRoom(ctx.db, 'r1', u.userId, i);
    seedHandsFor(ctx.db, 'r1', ex.userId, 20, 99, 'exact', 'ex');
    seedHandsFor(ctx.db, 'r1', lg.userId, 20, 99, 'legacy', 'lg');
    // 19 exact + 1 partial: any partial row forces the whole entry to 'partial'
    seedHandsFor(ctx.db, 'r1', pt.userId, 19, 99, 'exact', 'pt');
    addHand(ctx.db, {
      id: 'partial-extra',
      roomId: 'r1',
      players: [P(0, pt.userId, { position: 'BTN', postflopOrder: 1, dataConfidence: 'partial' })],
      actions: [],
    });

    const res = await ctx.app.inject({ method: 'GET', url: '/api/rooms/r1/hud', headers: auth(host.token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(entryFor(body, ex.userId)).toMatchObject({
      hidden: false,
      dataConfidence: 'exact',
      dataQuality: { exact: 20, legacy: 0, partial: 0, total: 20 },
    });
    expect(entryFor(body, lg.userId)).toMatchObject({
      hidden: false,
      dataConfidence: 'legacy',
      dataQuality: { exact: 0, legacy: 20, partial: 0, total: 20 },
    });
    expect(entryFor(body, pt.userId)).toMatchObject({
      hidden: false,
      dataConfidence: 'partial',
      dataQuality: { exact: 19, legacy: 0, partial: 1, total: 20 },
    });
  });

  it('rejects a query roomId that disagrees with the id in the path', async () => {
    const alice = await register('alice2');
    makeRoom(ctx.db, 'r1', alice.userId);
    makeRoom(ctx.db, 'r2', alice.userId);
    joinRoom(ctx.db, 'r1', alice.userId, 0);
    joinRoom(ctx.db, 'r2', alice.userId, 0);
    seedHandsFor(ctx.db, 'r1', alice.userId, 1, 99, 'exact', 'r1');
    seedHandsFor(ctx.db, 'r2', alice.userId, 2, 99, 'exact', 'r2');

    const mismatch = await ctx.app.inject({
      method: 'GET',
      url: '/api/rooms/r1/hud?roomId=r2',
      headers: auth(alice.token),
    });
    expect(mismatch.statusCode).toBe(400);

    const match = await ctx.app.inject({
      method: 'GET',
      url: '/api/rooms/r1/hud?roomId=r1',
      headers: auth(alice.token),
    });
    expect(match.statusCode).toBe(200);
    expect(entryFor(match.json(), alice.userId).sample).toBe(1);
  });

  it('never lets ?minHands= lower the fixed HUD floor', async () => {
    const alice = await register('alice3');
    makeRoom(ctx.db, 'r1', alice.userId);
    joinRoom(ctx.db, 'r1', alice.userId, 0);
    seedHandsFor(ctx.db, 'r1', alice.userId, 5, 99, 'exact', 'mh');

    for (const q of ['?minHands=0', '?minHands=1', '?minHands=5', '?minHands=19']) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/api/rooms/r1/hud${q}`,
        headers: auth(alice.token),
      });
      expect(res.statusCode, q).toBe(200);
      expect(res.json().minHands, q).toBe(HUD_MIN_SAMPLE);
      expect(entryFor(res.json(), alice.userId), q).toMatchObject({
        sample: 5,
        sufficient: false,
        confidence: 'insufficient',
        stats: null,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. hidden vs visible HUD entries: identical key set, explicit nulls
// ---------------------------------------------------------------------------

describe('HUD hidden vs visible entry shape', () => {
  it('keeps an identical key set and writes every withheld field as an explicit null', async () => {
    const alice = await register('alice4');
    const bob = await register('bob4');
    makeRoom(ctx.db, 'r1', alice.userId);
    joinRoom(ctx.db, 'r1', alice.userId, 0);
    joinRoom(ctx.db, 'r1', bob.userId, 1);
    seedHandsFor(ctx.db, 'r1', bob.userId, 25, 99, 'exact', 'hv');
    ctx.db.prepare('UPDATE users SET private_mode = 1 WHERE id = ?').run(bob.userId);

    const asAlice = await ctx.app.inject({
      method: 'GET',
      url: '/api/rooms/r1/hud',
      headers: auth(alice.token),
    });
    const asBob = await ctx.app.inject({
      method: 'GET',
      url: '/api/rooms/r1/hud',
      headers: auth(bob.token),
    });
    const hidden = entryFor(asAlice.json(), bob.userId);
    const visible = entryFor(asBob.json(), bob.userId);

    // Identical key set: a client can render either without a shape check.
    expect(Object.keys(hidden).sort()).toEqual(Object.keys(visible).sort());
    expect(Object.keys(hidden).sort()).toEqual(
      [
        'approximations',
        'byIpOop',
        'byPosition',
        'byStreet',
        'confidence',
        'dataConfidence',
        'dataQuality',
        'displayName',
        'hidden',
        'minHands',
        'sample',
        'stats',
        'sufficient',
        'trend',
        'userId',
        'username',
      ].sort(),
    );

    // The hidden entry is explicit null, never a misleading zero.
    expect(hidden).toMatchObject({
      userId: bob.userId,
      username: 'bob4',
      displayName: 'bob4',
      hidden: true,
      sample: 0,
      minHands: HUD_MIN_SAMPLE,
      sufficient: false,
      confidence: 'insufficient',
      dataConfidence: null,
      stats: null,
      byPosition: null,
      byStreet: null,
      byIpOop: null,
      trend: null,
    });
    expect(hidden.dataQuality).toEqual({ exact: 0, legacy: 0, partial: 0, total: 0 });
    expect(Array.isArray(hidden.approximations)).toBe(true);

    // ...while the owner sees the real bundle with the same keys.
    expect(visible.hidden).toBe(false);
    expect(visible.sample).toBe(25);
    expect(visible.confidence).toBe('low');
    expect(visible.dataConfidence).toBe('exact');
    expect(visible.stats).not.toBeNull();
    expect(visible.byPosition).not.toBeNull();
    expect(visible.trend).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. auth / membership / not-found / validation across all stats routes
// ---------------------------------------------------------------------------

describe('stats routes auth, membership and validation', () => {
  it('returns 401 for every stats route without a token', async () => {
    const anon = [
      '/api/me/stats',
      '/api/users/1/stats',
      '/api/rooms/r1/hud',
    ];
    for (const url of anon) {
      const res = await ctx.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('returns 403 for a room non-member and 404 for unknown rooms/users', async () => {
    const alice = await register('alice5');
    const carol = await register('carol5');
    makeRoom(ctx.db, 'r1', alice.userId);
    joinRoom(ctx.db, 'r1', alice.userId, 0);

    const nonMember = await ctx.app.inject({
      method: 'GET',
      url: '/api/rooms/r1/hud',
      headers: auth(carol.token),
    });
    expect(nonMember.statusCode).toBe(403);

    const unknownRoom = await ctx.app.inject({
      method: 'GET',
      url: '/api/rooms/nope/hud',
      headers: auth(alice.token),
    });
    expect(unknownRoom.statusCode).toBe(404);

    const unknownUser = await ctx.app.inject({
      method: 'GET',
      url: '/api/users/9999/stats',
      headers: auth(alice.token),
    });
    expect(unknownUser.statusCode).toBe(404);
  });

  it('returns 400 for invalid path ids and invalid HUD queries', async () => {
    const alice = await register('alice6');
    makeRoom(ctx.db, 'r1', alice.userId);
    joinRoom(ctx.db, 'r1', alice.userId, 0);

    // path ids: non-numeric, zero and negative all fail `int().positive()`
    for (const url of ['/api/users/abc/stats', '/api/users/0/stats', '/api/users/-1/stats']) {
      const res = await ctx.app.inject({ method: 'GET', url, headers: auth(alice.token) });
      expect(res.statusCode, url).toBe(400);
    }

    // HUD query validation reaches the schema only for a real member's room
    const badQueries = [
      '/api/rooms/r1/hud?from=5&to=1',
      '/api/rooms/r1/hud?gameKind=bogus',
      '/api/rooms/r1/hud?position=XX',
      '/api/rooms/r1/hud?limit=0',
      '/api/rooms/r1/hud?playerId=-3',
    ];
    for (const url of badQueries) {
      const res = await ctx.app.inject({ method: 'GET', url, headers: auth(alice.token) });
      expect(res.statusCode, url).toBe(400);
    }

    // A valid HUD request still succeeds after the rejections.
    const ok = await ctx.app.inject({ method: 'GET', url: '/api/rooms/r1/hud', headers: auth(alice.token) });
    expect(ok.statusCode).toBe(200);
  });
});
