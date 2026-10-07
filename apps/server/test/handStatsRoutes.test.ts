import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { type DB } from '../src/db.js';
import {
  HUD_LOW_CONFIDENCE,
  HUD_MIN_SAMPLE,
  METRIC_VERSION,
  STREAK_LARGE_BB,
  STREAK_MIN_SAMPLE,
  STREAK_SMALL_BB,
  STREAK_WINDOW,
  STREAK_WINSOR_BB,
} from '../src/handStats.js';

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
        'streak',
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
      streak: null,
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

// ---------------------------------------------------------------------------
// 7. hot/cold streak badge: near-50 winsorized net bb
// ---------------------------------------------------------------------------

/**
 * Build `n` per-hand poker deltas (chips) that winsorize to exactly `target`
 * bb with bb=10: 15bb chunks first, the remainder next, then break-even hands.
 * A negative target mirrors the whole sequence.
 */
function streakDeltas(target: number, n = 20): number[] {
  const sign = target < 0 ? -1 : 1;
  let abs = Math.abs(target);
  const out: number[] = [];
  while (abs >= STREAK_WINSOR_BB && out.length < n) {
    out.push(STREAK_WINSOR_BB * 10);
    abs -= STREAK_WINSOR_BB;
  }
  if (abs > 0) out.push(abs * 10);
  while (out.length < n) out.push(0);
  return out.map((d) => sign * d);
}

/** Seed one stake's whole window; `settledAt` ascends with the array index. */
function seedStreak(
  db: DB,
  roomId: string,
  userId: number,
  deltas: number[],
  bb = 10,
  opponent = 99,
): void {
  deltas.forEach((delta, i) => {
    addHand(db, {
      id: `st-${userId}-${i}`,
      roomId,
      bb,
      settledAt: 1000 + i,
      players: [
        P(0, userId, { position: 'BTN', postflopOrder: 1, pokerDelta: delta }),
        P(1, opponent, { position: 'BB', postflopOrder: 0, pokerDelta: -delta }),
      ],
    });
  });
}

/** A normal `POST /void-hand` leaves a ledger row keyed by hand_id/head. */
function voidLedgerHand(db: DB, handId: string, roomId = 'r1'): void {
  db.prepare(
    "INSERT INTO ledger (room_id, user_id, delta, kind, ref, ts, prev_hash, entry_hash) VALUES (?, 1, 0, 'void-hand', ?, 1, 'p', 'e')",
  ).run(roomId, handId);
}

/** Void correlated by the settlement/transcript head (`hands.source_head`). */
function voidLedgerRef(db: DB, ref: string, roomId = 'r1'): void {
  db.prepare(
    "INSERT INTO ledger (room_id, user_id, delta, kind, ref, ts, prev_hash, entry_hash) VALUES (?, 1, 0, 'void-hand', ?, 1, 'p', 'e')",
  ).run(roomId, ref);
}

describe('HUD hot/cold streak badge', () => {
  it('pins the four tiers at the exact +/-30bb and +/-85bb edges', async () => {
    const host = await register('streak_host');
    makeRoom(ctx.db, 'r1', host.userId);
    joinRoom(ctx.db, 'r1', host.userId, 0);

    const cases: { name: string; target: number; tier: string | null }[] = [
      { name: 'neutral_plus', target: STREAK_SMALL_BB - 1, tier: null },
      { name: 'hot1_edge', target: STREAK_SMALL_BB, tier: 'hot1' },
      { name: 'hot1_plus', target: STREAK_SMALL_BB + 1, tier: 'hot1' },
      { name: 'hot1_large', target: STREAK_LARGE_BB - 1, tier: 'hot1' },
      { name: 'hot2_edge', target: STREAK_LARGE_BB, tier: 'hot2' },
      { name: 'hot2_plus', target: STREAK_LARGE_BB + 1, tier: 'hot2' },
      { name: 'neutral_minus', target: -(STREAK_SMALL_BB - 1), tier: null },
      { name: 'cold1_edge', target: -STREAK_SMALL_BB, tier: 'cold1' },
      { name: 'cold1_plus', target: -(STREAK_SMALL_BB + 1), tier: 'cold1' },
      { name: 'cold1_large', target: -(STREAK_LARGE_BB - 1), tier: 'cold1' },
      { name: 'cold2_edge', target: -STREAK_LARGE_BB, tier: 'cold2' },
      { name: 'cold2_plus', target: -(STREAK_LARGE_BB + 1), tier: 'cold2' },
    ];

    const ids = new Map<string, number>();
    let seat = 1;
    for (const c of cases) {
      const u = await register(`streak_${c.name}`);
      joinRoom(ctx.db, 'r1', u.userId, seat++);
      seedStreak(ctx.db, 'r1', u.userId, streakDeltas(c.target));
      ids.set(c.name, u.userId);
    }

    const res = await ctx.app.inject({ method: 'GET', url: '/api/rooms/r1/hud', headers: auth(host.token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    for (const c of cases) {
      const entry = entryFor(body, ids.get(c.name)!);
      expect(entry.sample, c.name).toBe(20);
      expect(entry.sufficient, c.name).toBe(true);
      expect(entry.streak, c.name).toMatchObject({ sample: 20, netBB: c.target, tier: c.tier });
    }
  });

  it('winsorizes a single hand to +/-15bb so one cooler cannot dominate', async () => {
    const host = await register('winsor_host');
    makeRoom(ctx.db, 'r1', host.userId);
    joinRoom(ctx.db, 'r1', host.userId, 0);
    // one monstrous 1000bb win among 19 break-even hands: uncapped that is
    // hot2 by a mile, capped it is exactly the winsorization edge
    const ups = await register('winsor_up');
    joinRoom(ctx.db, 'r1', ups.userId, 1);
    seedStreak(ctx.db, 'r1', ups.userId, [10_000, ...Array(19).fill(0)]);
    const downs = await register('winsor_down');
    joinRoom(ctx.db, 'r1', downs.userId, 2);
    seedStreak(ctx.db, 'r1', downs.userId, [-10_000, ...Array(19).fill(0)]);

    const res = await ctx.app.inject({ method: 'GET', url: '/api/rooms/r1/hud', headers: auth(host.token) });
    expect(STREAK_WINSOR_BB).toBe(15);
    expect(entryFor(res.json(), ups.userId).streak).toEqual({
      tier: null,
      netBB: STREAK_WINSOR_BB,
      realNetBB: 1000,
      sample: 20,
    });
    expect(entryFor(res.json(), downs.userId).streak).toEqual({
      tier: null,
      netBB: -STREAK_WINSOR_BB,
      realNetBB: -1000,
      sample: 20,
    });
  });

  it('only counts the newest 50 hands, not the full history', async () => {
    const host = await register('window_host');
    makeRoom(ctx.db, 'r1', host.userId);
    joinRoom(ctx.db, 'r1', host.userId, 0);
    // 60 hands: the 10 OLDEST are huge losses, the newest 50 are +1bb each.
    // Counting the full history would give (50 - 150) = -100bb -> cold2.
    const deltas = Array.from({ length: 60 }, (_, i) => (i < 10 ? -10_000 : 10));
    seedStreak(ctx.db, 'r1', host.userId, deltas);

    const res = await ctx.app.inject({ method: 'GET', url: '/api/rooms/r1/hud', headers: auth(host.token) });
    const entry = entryFor(res.json(), host.userId);
    expect(STREAK_WINDOW).toBe(50);
    expect(entry.sample).toBe(60); // the HUD sample still sees all 60
    expect(entry.streak).toEqual({ tier: 'hot1', netBB: 50, realNetBB: 50, sample: 50 });
  });

  it('excludes voided hands from the streak window', async () => {
    const host = await register('void_host');
    makeRoom(ctx.db, 'r1', host.userId);
    joinRoom(ctx.db, 'r1', host.userId, 0);
    seedStreak(ctx.db, 'r1', host.userId, streakDeltas(STREAK_SMALL_BB)); // +30bb -> hot1
    // newest hand is a monster loss; voided it must not touch the window
    addHand(ctx.db, {
      id: 'st-void',
      roomId: 'r1',
      settledAt: 9000,
      players: [
        P(0, host.userId, { position: 'BTN', postflopOrder: 1, pokerDelta: -10_000 }),
        P(1, 99, { position: 'BB', postflopOrder: 0, pokerDelta: 10_000 }),
      ],
    });
    voidLedgerHand(ctx.db, 'st-void');

    const res = await ctx.app.inject({ method: 'GET', url: '/api/rooms/r1/hud', headers: auth(host.token) });
    const entry = entryFor(res.json(), host.userId);
    expect(entry.sample).toBe(20);
    expect(entry.streak).toEqual({ tier: 'hot1', netBB: STREAK_SMALL_BB, realNetBB: STREAK_SMALL_BB, sample: 20 });
  });

  it('withholds the streak entirely below the 20-hand floor', async () => {
    const host = await register('low_host');
    makeRoom(ctx.db, 'r1', host.userId);
    joinRoom(ctx.db, 'r1', host.userId, 0);
    seedStreak(ctx.db, 'r1', host.userId, Array.from({ length: 5 }, () => 150)); // +75bb over 5

    const res = await ctx.app.inject({ method: 'GET', url: '/api/rooms/r1/hud', headers: auth(host.token) });
    const entry = entryFor(res.json(), host.userId);
    expect(STREAK_MIN_SAMPLE).toBe(20);
    expect(entry).toMatchObject({ sample: 5, sufficient: false, confidence: 'insufficient', streak: null });
  });

  it('bounds the streak window to 50 IN SQL, in the same per-user batch query', async () => {
    const host = await register('batch_host');
    makeRoom(ctx.db, 'r1', host.userId);
    const p1 = await register('batch_hot1');
    const p2 = await register('batch_hot2');
    const p3 = await register('batch_cold1');
    for (const [i, u] of [host, p1, p2, p3].entries()) joinRoom(ctx.db, 'r1', u.userId, i);
    seedStreak(ctx.db, 'r1', p1.userId, streakDeltas(STREAK_SMALL_BB));
    seedStreak(ctx.db, 'r1', p2.userId, streakDeltas(STREAK_LARGE_BB));
    seedStreak(ctx.db, 'r1', p3.userId, streakDeltas(-STREAK_SMALL_BB));

    const spy = vi.spyOn(ctx.db as unknown as { prepare: (sql: string) => unknown }, 'prepare');
    const res = await ctx.app.inject({ method: 'GET', url: '/api/rooms/r1/hud', headers: auth(host.token) });
    const scoped = spy.mock.calls
      .map((c) => String(c[0]))
      .filter((sql) => sql.includes('AS inStreak'));
    spy.mockRestore();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(entryFor(body, p1.userId).streak).toMatchObject({ tier: 'hot1' });
    expect(entryFor(body, p2.userId).streak).toMatchObject({ tier: 'hot2' });
    expect(entryFor(body, p3.userId).streak).toMatchObject({ tier: 'cold1' });

    // One bounded per-user query per roster member - the streak window rides
    // that same query (no extra per-player streak scan).
    expect(scoped.length).toBe(4);
    expect(STREAK_WINDOW).toBe(50);
    for (const sql of scoped) {
      // General stats window stays parameterised...
      expect(sql).toContain('LIMIT @limit');
      // ...while the streak target carries the literal 50-hand bound in SQL,
      // not an in-memory slice. Both live in the one prepared statement.
      expect(sql).toContain('LIMIT 50');
      expect(sql.split('LIMIT 50').length - 1).toBe(1);
    }
  });

  it('withholds the streak when the ELIGIBLE (bb>0) sample is below 20 even though total hands reach 20', async () => {
    const host = await register('elig_host');
    makeRoom(ctx.db, 'r1', host.userId);
    joinRoom(ctx.db, 'r1', host.userId, 0);
    // 20 settled hands, but one has no nominal bb -> stats.sample = 20,
    // streak.sample = 19. The badge must not appear at all.
    for (let i = 0; i < 20; i++) {
      addHand(ctx.db, {
        id: `elig_${i}`,
        roomId: 'r1',
        bb: i === 0 ? 0 : 10,
        settledAt: 1000 + i,
        players: [
          P(0, host.userId, { position: 'BTN', postflopOrder: 1, pokerDelta: 15 }),
          P(1, 99, { position: 'BB', postflopOrder: 0, pokerDelta: -15 }),
        ],
      });
    }

    const res = await ctx.app.inject({ method: 'GET', url: '/api/rooms/r1/hud', headers: auth(host.token) });
    const entry = entryFor(res.json(), host.userId);
    expect(entry.sample).toBe(20);
    expect(entry.sufficient).toBe(true);
    expect(entry.streak).toBeNull();
  });

  it('breaks the 50-hand boundary tie with SQLite binary hand_id DESC order', async () => {
    const host = await register('tie_host');
    makeRoom(ctx.db, 'r1', host.userId);
    joinRoom(ctx.db, 'r1', host.userId, 0);
    // 51 hands share one settledAt. Binary DESC of the hand_id ranks
    // tt_m* > tt_a > tt_B, so the newest 50 exclude tt_B. Unicode localeCompare
    // would instead rank a < B < m and drop tt_a, pulling the +30bb hand in.
    // If JS re-sorted with localeCompare this would be hot1; SQL binary keeps
    // it neutral.
    const deltas: [string, number][] = [
      ['tt_B', 300], // +30bb if (wrongly) counted
      ['tt_a', 0],
      ...Array.from({ length: 49 }, (_, i) => [`tt_m${String(i).padStart(2, '0')}`, 0] as [string, number]),
    ];
    for (const [id, delta] of deltas) {
      addHand(ctx.db, {
        id,
        roomId: 'r1',
        settledAt: 1000,
        players: [
          P(0, host.userId, { position: 'BTN', postflopOrder: 1, pokerDelta: delta }),
          P(1, 99, { position: 'BB', postflopOrder: 0, pokerDelta: -delta }),
        ],
      });
    }

    const res = await ctx.app.inject({ method: 'GET', url: '/api/rooms/r1/hud', headers: auth(host.token) });
    const entry = entryFor(res.json(), host.userId);
    expect(entry.sample).toBe(51);
    expect(entry.streak).toEqual({ tier: null, netBB: 0, realNetBB: 0, sample: 50 });
  });

  it('excludes a hand voided by its settlement head (ref=head) from the streak net/tier', async () => {
    const host = await register('voidhead_host');
    makeRoom(ctx.db, 'r1', host.userId);
    joinRoom(ctx.db, 'r1', host.userId, 0);
    seedStreak(ctx.db, 'r1', host.userId, streakDeltas(STREAK_SMALL_BB)); // +30bb -> hot1
    addHand(ctx.db, {
      id: 'headvoid',
      roomId: 'r1',
      settledAt: 9000,
      players: [
        P(0, host.userId, { position: 'BTN', postflopOrder: 1, pokerDelta: -10_000 }),
        P(1, 99, { position: 'BB', postflopOrder: 0, pokerDelta: 10_000 }),
      ],
    });
    // the canonical void correlates by transcript head, not by hand_id
    voidLedgerRef(ctx.db, 'head-headvoid');

    const res = await ctx.app.inject({ method: 'GET', url: '/api/rooms/r1/hud', headers: auth(host.token) });
    const entry = entryFor(res.json(), host.userId);
    expect(entry.sample).toBe(20);
    expect(entry.streak).toEqual({ tier: 'hot1', netBB: STREAK_SMALL_BB, realNetBB: STREAK_SMALL_BB, sample: 20 });
  });

  it('hides the streak from a non-owner on /api/users/:id/stats but keeps it for the owner', async () => {
    const alice = await register('ustats_a');
    const bob = await register('ustats_b');
    makeRoom(ctx.db, 'r1', alice.userId);
    seedStreak(ctx.db, 'r1', bob.userId, streakDeltas(STREAK_SMALL_BB)); // +30bb -> hot1

    const asAlice = await ctx.app.inject({
      method: 'GET',
      url: `/api/users/${bob.userId}/stats`,
      headers: auth(alice.token),
    });
    expect(asAlice.statusCode).toBe(200);
    expect(asAlice.json().stats).not.toBeNull();
    expect(asAlice.json().streak).toBeNull();

    const asBob = await ctx.app.inject({
      method: 'GET',
      url: `/api/users/${bob.userId}/stats`,
      headers: auth(bob.token),
    });
    expect(asBob.statusCode).toBe(200);
    expect(asBob.json().streak).toEqual({ tier: 'hot1', netBB: STREAK_SMALL_BB, realNetBB: STREAK_SMALL_BB, sample: 20 });
  });
});

// ---------------------------------------------------------------------------
// 7b. REAL (unwinsorized) net win over the same 50-hand window
//
// `streak.realNetBB` is the true sum of per-hand `poker_delta / that hand's bb`;
// `streak.netBB` stays the winsorized hot/cold score. These tests pin the
// user-facing number (the +1057.3bb production window whose capped score was
// +32.3bb) and the per-hand big-blind normalisation.
// ---------------------------------------------------------------------------

describe('HUD streak real net win (unwinsorized)', () => {
  /** Seed hands with an explicit per-hand `bb` (unlike seedStreak's single
   *  stake). `settledAt` ascends with the array so the window order is fixed. */
  function seedMixedBb(
    db: DB,
    roomId: string,
    userId: number,
    specs: { delta: number; bb: number }[],
    tag: string,
    opponent = 99,
  ): void {
    specs.forEach((s, i) => {
      addHand(db, {
        id: `${tag}_${i}`,
        roomId,
        bb: s.bb,
        settledAt: 1000 + i,
        players: [
          P(0, userId, { position: 'BTN', postflopOrder: 1, pokerDelta: s.delta }),
          P(1, opponent, { position: 'BB', postflopOrder: 0, pokerDelta: -s.delta }),
        ],
      });
    });
  }

  it('reproduces the production case: real net +1057.3bb while the hot/cold score is +32.3bb', async () => {
    const host = await register('realnet_host');
    makeRoom(ctx.db, 'r1', host.userId);
    joinRoom(ctx.db, 'r1', host.userId, 0);
    // 50 hands at bb=10 - one monster (+901.6bb, the user's hand), one +153.4bb,
    // one +2.3bb, 47 break-even. Uncapped sum: 1057.3bb. Winsorized:
    // 15 + 15 + 2.3 = 32.3bb -> hot1.
    const specs: { delta: number; bb: number }[] = [
      { delta: 9016, bb: 10 },
      { delta: 1534, bb: 10 },
      { delta: 23, bb: 10 },
      ...Array.from({ length: 47 }, () => ({ delta: 0, bb: 10 })),
    ];
    seedMixedBb(ctx.db, 'r1', host.userId, specs, 'realnet');

    const res = await ctx.app.inject({ method: 'GET', url: '/api/rooms/r1/hud', headers: auth(host.token) });
    expect(entryFor(res.json(), host.userId).streak).toEqual({
      tier: 'hot1',
      netBB: 32.3,
      realNetBB: 1057.3,
      sample: 50,
    });
  });

  it('keeps a single +901.6bb hand fully in realNetBB but caps its hot/cold contribution at 15bb', async () => {
    const host = await register('monster_host');
    makeRoom(ctx.db, 'r1', host.userId);
    joinRoom(ctx.db, 'r1', host.userId, 0);
    // bb=20: +18032 chips = +901.6bb, plus 19 break-even hands to clear the floor.
    seedMixedBb(
      ctx.db,
      'r1',
      host.userId,
      [{ delta: 18032, bb: 20 }, ...Array.from({ length: 19 }, () => ({ delta: 0, bb: 20 }))],
      'monster',
    );

    const res = await ctx.app.inject({ method: 'GET', url: '/api/rooms/r1/hud', headers: auth(host.token) });
    expect(entryFor(res.json(), host.userId).streak).toEqual({
      tier: null,
      netBB: 15,
      realNetBB: 901.6,
      sample: 20,
    });
  });

  it('normalises EACH hand by its OWN big blind (a shared bb would misprice the window)', async () => {
    const host = await register('mixedbb_host');
    makeRoom(ctx.db, 'r1', host.userId);
    joinRoom(ctx.db, 'r1', host.userId, 0);
    // The same +200 chips at two stakes: 200/10 = 20bb and 200/20 = 10bb.
    // Per-hand divisors -> realNetBB 30, netBB 15 + 10 = 25. A single shared
    // bb=10 would instead give realNetBB 40, netBB 30 - both assertions red.
    seedMixedBb(
      ctx.db,
      'r1',
      host.userId,
      [
        { delta: 200, bb: 10 },
        { delta: 200, bb: 20 },
        ...Array.from({ length: 18 }, () => ({ delta: 0, bb: 10 })),
      ],
      'mixedbb',
    );

    const res = await ctx.app.inject({ method: 'GET', url: '/api/rooms/r1/hud', headers: auth(host.token) });
    expect(entryFor(res.json(), host.userId).streak).toEqual({
      tier: null,
      netBB: 25,
      realNetBB: 30,
      sample: 20,
    });
  });

  it('excludes bb=0, unsettled and voided hands from realNetBB too', async () => {
    const host = await register('boundary_host');
    makeRoom(ctx.db, 'r1', host.userId);
    joinRoom(ctx.db, 'r1', host.userId, 0);
    // 20 clean +1bb hands -> realNetBB 20, netBB 20, eligible sample 20.
    seedStreak(ctx.db, 'r1', host.userId, Array.from({ length: 20 }, () => 10));
    const monster = (id: string, bb: number, settledAt: number) =>
      addHand(ctx.db, {
        id,
        roomId: 'r1',
        bb,
        settledAt,
        players: [
          P(0, host.userId, { position: 'BTN', postflopOrder: 1, pokerDelta: 100_000 }),
          P(1, 99, { position: 'BB', postflopOrder: 0, pokerDelta: -100_000 }),
        ],
      });
    // Each of these three would add +10000bb if the scope leaked.
    monster('bd_zero', 0, 5000); // bb<=0 cannot be normalised
    monster('bd_pending', 10, 5001); // not settled
    ctx.db.prepare("UPDATE hands SET status = 'pending' WHERE hand_id = 'bd_pending'").run();
    monster('bd_void', 10, 5002); // voided via ledger
    voidLedgerHand(ctx.db, 'bd_void');

    const res = await ctx.app.inject({ method: 'GET', url: '/api/rooms/r1/hud', headers: auth(host.token) });
    expect(entryFor(res.json(), host.userId).streak).toEqual({
      tier: null,
      netBB: 20,
      realNetBB: 20,
      sample: 20,
    });
  });
});

// ---------------------------------------------------------------------------
// 8. hot/cold streak badge on the per-user stats routes
//
// The pure `StatsResult.streak` is ALWAYS an object; the eligible (bb>0) 20-hand
// floor is enforced at the HTTP contract layer for `/api/me/stats` and the
// owner's `/api/users/:id/stats` too - not just the HUD.
// ---------------------------------------------------------------------------

describe('hot/cold streak badge on /api/me/stats and /api/users/:id/stats', () => {
  /** 20 settled hands for `userId`, the first one with `bb=0` -> eligible 19. */
  function seedIneligibleWindow(db: DB, roomId: string, userId: number, tag: string): void {
    for (let i = 0; i < 20; i++) {
      addHand(db, {
        id: `${tag}_${i}`,
        roomId,
        bb: i === 0 ? 0 : 10,
        settledAt: 1000 + i,
        players: [
          P(0, userId, { position: 'BTN', postflopOrder: 1, pokerDelta: 15 }),
          P(1, 99, { position: 'BB', postflopOrder: 0, pokerDelta: -15 }),
        ],
      });
    }
  }

  it('/api/me/stats withholds `streak` when only 19 of 20 hands are eligible (bb>0)', async () => {
    const alice = await register('me_elig');
    makeRoom(ctx.db, 'r1', alice.userId);
    seedIneligibleWindow(ctx.db, 'r1', alice.userId, 'me_elig');

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/me/stats',
      headers: auth(alice.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // The overall bundle is still sufficient: 20 total hands, minHands defaults
    // to 0, and the aggregate stats remain visible.
    expect(body.sample).toBe(20);
    expect(body.sufficient).toBe(true);
    expect(body.stats).not.toBeNull();
    // ...but the badge needs 20 ELIGIBLE hands, and the bb=0 hand cannot be
    // normalised, so it must be null - never `{tier, netBB, sample: 19}`.
    expect(body.streak).toBeNull();
  });

  it('/api/users/:id/stats withholds the owner badge below the eligible 20 floor', async () => {
    const owner = await register('u_elig');
    makeRoom(ctx.db, 'r1', owner.userId);
    seedIneligibleWindow(ctx.db, 'r1', owner.userId, 'u_elig');

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/users/${owner.userId}/stats`,
      headers: auth(owner.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hidden).toBe(false);
    expect(body.sample).toBe(20);
    expect(body.streak).toBeNull();
  });

  it('/api/me/stats returns the streak object with the correct tier once 20 hands are eligible', async () => {
    const alice = await register('me_ok');
    makeRoom(ctx.db, 'r1', alice.userId);
    // 20 eligible hands, +30bb winsorized net -> 小火 hot1.
    seedStreak(ctx.db, 'r1', alice.userId, streakDeltas(STREAK_SMALL_BB));

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/me/stats',
      headers: auth(alice.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sample).toBe(20);
    expect(body.streak).toEqual({ tier: 'hot1', netBB: STREAK_SMALL_BB, realNetBB: STREAK_SMALL_BB, sample: 20 });
  });
});
