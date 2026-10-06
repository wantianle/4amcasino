import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeHead, type TranscriptEntry } from '@4am/mental-poker';
import { createApp } from '../src/app.js';
import type { DB } from '../src/db.js';
import { appendLedger } from '../src/ledger.js';
import { setPlatformUserId } from '../src/platform.js';
import { applyHandSettlement } from '../src/game.js';
import { SEVEN_DEUCE_SHOW_KIND } from '../src/handProjection.js';

// ---------------------------------------------------------------------------
// Invariant: one account's net change on one hand is the SAME number in every
// read model, and it is the authoritative game net
//
//   gameDelta = poker + squid + automatic 7-2 bounty        (DESIGN.md)
//
// i.e. the ledger legs `hand-settlement` + `squid-game` + `seven-deuce`, and
// NOT the head-ref-only whitelist `kind IN ('hand-settlement','squid-game')`
// that silently dropped the bounty. The `commission` rake credit is a separate
// account leg and is never part of this net.
//
// The two ref conventions are deliberately exercised: `hand-settlement` /
// `squid-game` / `commission` carry the transcript head, `seven-deuce` carries
// the hand id (DESIGN.md "the two ledger refs are strictly isolated").
// ---------------------------------------------------------------------------

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
function joinRoom(db: DB, roomId: string, userId: number, seat: number | null): void {
  db.prepare('INSERT INTO room_players (room_id, user_id, seat, stack) VALUES (?, ?, ?, ?)').run(
    roomId,
    userId,
    seat,
    1000,
  );
}

interface HandSeed {
  id: string;
  head: string;
  roomId: string;
  hero: number;
  villain: number;
  platform: number;
  /** poker leg: sum(hero + villain) must equal -rake. */
  pokerHero: number;
  pokerVillain: number;
  /** zero-sum squid leg, optional. */
  squidHero?: number;
  squidVillain?: number;
  /** zero-sum automatic 7-2 bounty leg (hand-id ref), optional. */
  bountyHero?: number;
  bountyVillain?: number;
  /** zero-sum POST-settlement voluntary show bounty (hand-id ref), optional. */
  showHero?: number;
  showVillain?: number;
  /** zero-sum peek transfer (hand-id ref), optional. */
  peekHero?: number;
  peekVillain?: number;
  rake?: number;
  /** Omit the durable `hand_settlements` marker, as a pre-marker legacy hand. */
  markerless?: boolean;
}

/** Seed a settled hand's ledger legs (head ref) + transcript; returns the
 *  authoritative hero game net. */
function seedHand(db: DB, h: HandSeed): number {
  const rake = h.rake ?? 0;
  const entries = JSON.stringify([
    {
      seq: 0,
      type: 'hand_start',
      payload: {
        seats: [
          { seat: 0, userId: h.hero },
          { seat: 1, userId: h.villain },
        ],
      },
    },
    { seq: 1, type: 'settlement', payload: { board: [0, 1, 2, 3, 4] } },
  ]);
  db.prepare('INSERT INTO transcripts (hand_id, room_id, head, entries, ts) VALUES (?, ?, ?, ?, ?)').run(
    h.id,
    h.roomId,
    h.head,
    entries,
    1000,
  );
  if (!h.markerless) {
    db.prepare(
      "INSERT INTO hand_settlements (hand_id, room_id, head, rake, final_stacks, applied_at) VALUES (?, ?, ?, ?, '[]', ?)",
    ).run(h.id, h.roomId, h.head, rake, 1000);
  }

  appendLedger(db, { roomId: h.roomId, userId: h.hero, delta: h.pokerHero, kind: 'hand-settlement', ref: h.head });
  appendLedger(db, { roomId: h.roomId, userId: h.villain, delta: h.pokerVillain, kind: 'hand-settlement', ref: h.head });
  if (h.squidHero || h.squidVillain) {
    appendLedger(db, { roomId: h.roomId, userId: h.hero, delta: h.squidHero ?? 0, kind: 'squid-game', ref: h.head });
    appendLedger(db, { roomId: h.roomId, userId: h.villain, delta: h.squidVillain ?? 0, kind: 'squid-game', ref: h.head });
  }
  if (h.bountyHero || h.bountyVillain) {
    // the automatic 7-2 bounty is written under the HAND ID ref, not the head.
    appendLedger(db, { roomId: h.roomId, userId: h.hero, delta: h.bountyHero ?? 0, kind: 'seven-deuce', ref: h.id });
    appendLedger(db, { roomId: h.roomId, userId: h.villain, delta: h.bountyVillain ?? 0, kind: 'seven-deuce', ref: h.id });
  }
  if (h.showHero || h.showVillain) {
    // a POST-settlement voluntary show bounty, under the voluntary kind.
    appendLedger(db, {
      roomId: h.roomId,
      userId: h.hero,
      delta: h.showHero ?? 0,
      kind: SEVEN_DEUCE_SHOW_KIND,
      ref: h.id,
    });
    appendLedger(db, {
      roomId: h.roomId,
      userId: h.villain,
      delta: h.showVillain ?? 0,
      kind: SEVEN_DEUCE_SHOW_KIND,
      ref: h.id,
    });
  }
  if (h.peekHero || h.peekVillain) {
    // an independent post-hand peek transfer, under the hand id ref.
    appendLedger(db, { roomId: h.roomId, userId: h.hero, delta: h.peekHero ?? 0, kind: 'peek', ref: h.id });
    appendLedger(db, { roomId: h.roomId, userId: h.villain, delta: h.peekVillain ?? 0, kind: 'peek', ref: h.id });
  }
  if (rake > 0) {
    appendLedger(db, { roomId: h.roomId, userId: h.platform, delta: rake, kind: 'commission', ref: h.head });
  }
  return h.pokerHero + (h.squidHero ?? 0) + (h.bountyHero ?? 0);
}

// ---- real `applyHandSettlement()` fixtures ---------------------------------
// A heads-up hand whose showdown winner also takes the automatic 7-2 bounty:
// pure poker ledger +10/-10, but the projected net is +16/-16 because the
// zero-sum bounty is folded into `net_delta` and written as separate
// `seven-deuce` legs on the hand-id ref.
type Entry = { seq: number; type: string; from: string; payload: unknown; sig: string };
const srv = (seq: number, type: string, payload: unknown): Entry => ({
  seq,
  type,
  from: 'server',
  payload,
  sig: 'sig',
});
const headOf = (entries: unknown[]): string => computeHead(entries as TranscriptEntry[]);

function huEntries(u1: number, u2: number, rake: number): Entry[] {
  return [
    srv(0, 'hand_start', {
      schemaVersion: 2,
      startedAt: 1,
      gameKind: 'normal',
      seats: [
        { seat: 0, userId: u1, stack: 1000 },
        { seat: 1, userId: u2, stack: 1000 },
      ],
      buttonSeat: 0,
      sb: 5,
      bb: 10,
      commissionBps: 50,
    }),
    srv(1, 'blind_post', {
      posts: [
        { seat: 0, userId: u1, kind: 'sb', nominal: 5, amount: 5, stackAfter: 995, allIn: false },
        { seat: 1, userId: u2, kind: 'bb', nominal: 10, amount: 10, stackAfter: 990, allIn: false },
      ],
      ts: 2,
    }),
    srv(2, 'settlement', {
      board: [0, 5, 9],
      commission: rake,
      awards: [{ seat: 0, amount: 20 - rake }],
      deltas: [
        { seat: 0, delta: 16 },
        { seat: 1, delta: -16 },
      ],
      pokerDeltas: [
        { seat: 0, delta: 16 },
        { seat: 1, delta: -16 },
      ],
      runCount: 1,
      grossPot: 20,
      showdown: true,
      reveals: [
        { seat: 0, cards: [0, 5] },
        { seat: 1, cards: [1, 6] },
      ],
      ts: 9,
    }),
  ];
}

describe('authoritative per-hand game net across read models', () => {
  it('reports poker + squid + 7-2 bounty identically everywhere (rake credit excluded)', async () => {
    const hero = await register('rmd_hero');
    const villain = await register('rmd_villain');
    const platform = await register('rmd_platform');
    setPlatformUserId(ctx.db, platform.userId);
    makeRoom(ctx.db, 'rmd_room', hero.userId);
    joinRoom(ctx.db, 'rmd_room', hero.userId, 0);
    joinRoom(ctx.db, 'rmd_room', villain.userId, 1);
    joinRoom(ctx.db, 'rmd_room', platform.userId, null);

    // poker: hero +100, villain -110 (rake 10); squid: hero -4, villain +4;
    // bounty: hero +6, villain -6  => hero game net 102, villain -112.
    const heroNet = seedHand(ctx.db, {
      id: 'rmd_h1',
      head: 'rmd_head1',
      roomId: 'rmd_room',
      hero: hero.userId,
      villain: villain.userId,
      platform: platform.userId,
      pokerHero: 100,
      pokerVillain: -110,
      squidHero: -4,
      squidVillain: 4,
      bountyHero: 6,
      bountyVillain: -6,
      rake: 10,
    });
    expect(heroNet).toBe(102);
    // conservation: the whole game leg is -rake; the commission leg is +rake.
    const sumGame = ctx.db
      .prepare(
        "SELECT SUM(delta) AS n FROM ledger WHERE kind IN ('hand-settlement','squid-game','seven-deuce')",
      )
      .get() as { n: number };
    expect(sumGame.n).toBe(-10);
    const sumCommission = ctx.db
      .prepare("SELECT SUM(delta) AS n FROM ledger WHERE kind = 'commission'")
      .get() as { n: number };
    expect(sumCommission.n).toBe(10);

    // 1. profile stats
    const profileRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/users/${hero.userId}/profile`,
      headers: auth(hero.token),
    });
    expect(profileRes.statusCode).toBe(200);
    expect((profileRes.json() as { stats: unknown }).stats).toMatchObject({
      net: 102,
      handsPlayed: 1,
      biggestWin: 102,
    });

    // 2. leaderboard (global + room)
    const lb = (
      await ctx.app.inject({ method: 'GET', url: '/api/leaderboard', headers: auth(hero.token) })
    ).json() as { rows: { userId: number; net: number; handsPlayed: number }[] };
    expect(lb.rows.find((r) => r.userId === hero.userId)).toMatchObject({ net: 102, handsPlayed: 1 });
    expect(lb.rows.find((r) => r.userId === villain.userId)).toMatchObject({ net: -112 });
    const roomLb = (
      await ctx.app.inject({
        method: 'GET',
        url: '/api/rooms/rmd_room/leaderboard',
        headers: auth(hero.token),
      })
    ).json() as { rows: { userId: number; net: number }[] };
    expect(roomLb.rows.find((r) => r.userId === hero.userId)!.net).toBe(102);

    // 3. timeline
    const timeline = (
      await ctx.app.inject({ method: 'GET', url: '/api/me/timeline', headers: auth(hero.token) })
    ).json() as { points: { net: number }[] };
    expect(timeline.points.at(-1)!.net).toBe(102);

    // 4. room session
    const session = (
      await ctx.app.inject({
        method: 'GET',
        url: '/api/rooms/rmd_room/session',
        headers: auth(hero.token),
      })
    ).json() as { hands: number; players: { userId: number; net: number; handsPlayed: number }[] };
    expect(session.hands).toBe(1);
    expect(session.players.find((p) => p.userId === hero.userId)).toMatchObject({
      net: 102,
      handsPlayed: 1,
    });

    // 5. hand history
    const hist = (
      await ctx.app.inject({ method: 'GET', url: '/api/me/hand-history', headers: auth(hero.token) })
    ).json() as { hands: { handId: string; net: number }[] };
    expect(hist.hands.find((h) => h.handId === 'rmd_h1')!.net).toBe(102);

    // 6. best hand
    const best = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/users/${hero.userId}/best-hand`,
        headers: auth(hero.token),
      })
    ).json() as { hand: { handId: string; amount: number } };
    expect(best.hand).toMatchObject({ handId: 'rmd_h1', amount: 102 });

    // 7. rooms /hands per-hand net
    const hands = (
      await ctx.app.inject({
        method: 'GET',
        url: '/api/rooms/rmd_room/hands',
        headers: auth(hero.token),
      })
    ).json() as { hands: { handId: string; myNet: number | null }[] };
    expect(hands.hands.find((h) => h.handId === 'rmd_h1')!.myNet).toBe(102);

    // 8. house dues: the full rake is allocated to the positive game-net winner.
    const house = (
      await ctx.app.inject({ method: 'GET', url: '/api/admin/house', headers: auth(platform.token) })
    ).json() as { totals: { accrued: number; unallocated: number } };
    expect(house.totals).toMatchObject({ accrued: 10, unallocated: 0 });

    // 9. admin merge balance uses the same game net.
    ctx.db
      .prepare(
        "INSERT INTO account_merge_requests (from_user, into_user, requested_by, status, created_at) VALUES (?, ?, ?, 'pending', 1)",
      )
      .run(hero.userId, villain.userId, hero.userId);
    const merges = (
      await ctx.app.inject({ method: 'GET', url: '/api/admin/merges', headers: auth(platform.token) })
    ).json() as { requests: { fromBalance: number }[] };
    expect(merges.requests[0]!.fromBalance).toBe(102);
  });

  it('keeps the rake recipient (in hand or out) out of the hand game net', async () => {
    const hero = await register('rmd_in_hero');
    const villain = await register('rmd_in_villain');
    const platform = await register('rmd_in_platform');
    setPlatformUserId(ctx.db, platform.userId);
    makeRoom(ctx.db, 'rmd_in', hero.userId);
    joinRoom(ctx.db, 'rmd_in', hero.userId, 0);
    joinRoom(ctx.db, 'rmd_in', villain.userId, 1);
    // the platform (rake recipient) is ALSO seated in this hand
    joinRoom(ctx.db, 'rmd_in', platform.userId, 2);
    const heroNet = seedHand(ctx.db, {
      id: 'rmd_in_h1',
      head: 'rmd_in_head1',
      roomId: 'rmd_in',
      hero: hero.userId,
      villain: villain.userId,
      platform: platform.userId,
      pokerHero: 95,
      pokerVillain: -100,
      rake: 5,
    });
    expect(heroNet).toBe(95);
    const profileRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/users/${hero.userId}/profile`,
      headers: auth(hero.token),
    });
    // hero net stays 95: the +5 commission credit is the recipient's separate leg.
    expect((profileRes.json() as { stats: unknown }).stats).toMatchObject({ net: 95 });
    const platformProfile = await ctx.app.inject({
      method: 'GET',
      url: `/api/users/${platform.userId}/profile`,
      headers: auth(platform.token),
    });
    expect((platformProfile.json() as { stats: unknown }).stats).toMatchObject({ net: 0 });
  });

  it('excludes a voided hand from every excluding read model (bounty legs included)', async () => {
    const hero = await register('rmd_v_hero');
    const villain = await register('rmd_v_villain');
    const platform = await register('rmd_v_platform');
    setPlatformUserId(ctx.db, platform.userId);
    makeRoom(ctx.db, 'rmd_v', hero.userId);
    joinRoom(ctx.db, 'rmd_v', hero.userId, 0);
    joinRoom(ctx.db, 'rmd_v', villain.userId, 1);
    const heroNet = seedHand(ctx.db, {
      id: 'rmd_v_h1',
      head: 'rmd_v_head1',
      roomId: 'rmd_v',
      hero: hero.userId,
      villain: villain.userId,
      platform: platform.userId,
      pokerHero: 50,
      pokerVillain: -50,
      bountyHero: 7,
      bountyVillain: -7,
    });
    expect(heroNet).toBe(57);
    // void by head: the read-side helper must also catch the hand-id bounty leg.
    appendLedger(ctx.db, { roomId: 'rmd_v', userId: hero.userId, delta: 0, kind: 'void-hand', ref: 'rmd_v_head1' });
    appendLedger(ctx.db, { roomId: 'rmd_v', userId: hero.userId, delta: 0, kind: 'void-hand', ref: 'rmd_v_h1' });

    const profileRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/users/${hero.userId}/profile`,
      headers: auth(hero.token),
    });
    expect((profileRes.json() as { stats: unknown }).stats).toMatchObject({
      net: 0,
      handsPlayed: 0,
      biggestWin: 0,
    });
    const timeline = (
      await ctx.app.inject({ method: 'GET', url: '/api/me/timeline', headers: auth(hero.token) })
    ).json() as { points: { net: number }[] };
    expect(timeline.points.at(-1)?.net ?? 0).toBe(0);
    const best = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/users/${hero.userId}/best-hand`,
        headers: auth(hero.token),
      })
    ).json() as { hand: unknown };
    expect(best.hand).toBeNull();
    const house = (
      await ctx.app.inject({ method: 'GET', url: '/api/admin/house', headers: auth(platform.token) })
    ).json() as { totals: { accrued: number } };
    expect(house.totals.accrued).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Blocker 1: a markerless legacy hand must NOT split into two groups
  // -------------------------------------------------------------------------
  it('markerless history: the head-ref settlement and the hand-id-ref bounty are ONE hand', async () => {
    const hero = await register('rmd_ml_hero');
    const villain = await register('rmd_ml_villain');
    const platform = await register('rmd_ml_platform');
    setPlatformUserId(ctx.db, platform.userId);
    makeRoom(ctx.db, 'rmd_ml', hero.userId);
    joinRoom(ctx.db, 'rmd_ml', hero.userId, 0);
    joinRoom(ctx.db, 'rmd_ml', villain.userId, 1);
    joinRoom(ctx.db, 'rmd_ml', platform.userId, null);

    // poker hero +100 / villain -110 (rake 10) + bounty hero +6 / villain -6.
    const heroNet = seedHand(ctx.db, {
      id: 'rmd_ml_h1',
      head: 'rmd_ml_head1',
      roomId: 'rmd_ml',
      hero: hero.userId,
      villain: villain.userId,
      platform: platform.userId,
      pokerHero: 100,
      pokerVillain: -110,
      bountyHero: 6,
      bountyVillain: -6,
      rake: 10,
      markerless: true,
    });
    expect(heroNet).toBe(106);
    // genuinely markerless: a transcript + ledger, but no durable marker.
    expect(
      ctx.db.prepare('SELECT COUNT(*) AS n FROM hand_settlements WHERE hand_id = ?').get('rmd_ml_h1'),
    ).toMatchObject({ n: 0 });

    const profile = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/users/${hero.userId}/profile`,
        headers: auth(hero.token),
      })
    ).json() as { stats: unknown };
    // ONE hand, net = 100 + 6, not two hands of 100 and 6.
    expect(profile.stats).toMatchObject({ net: 106, handsPlayed: 1, biggestWin: 106 });

    const lb = (
      await ctx.app.inject({ method: 'GET', url: '/api/leaderboard', headers: auth(hero.token) })
    ).json() as { rows: { userId: number; net: number; handsPlayed: number }[] };
    expect(lb.rows.find((r) => r.userId === hero.userId)).toMatchObject({
      net: 106,
      handsPlayed: 1,
    });

    const roomHands = (
      await ctx.app.inject({
        method: 'GET',
        url: '/api/rooms/rmd_ml/hands',
        headers: auth(hero.token),
      })
    ).json() as { hands: { handId: string; myNet: number | null }[] };
    // the whole hand's game net (settlement + bounty), not just the isolated
    // bounty leg the old `COALESCE(marker, ref)` produced.
    expect(roomHands.hands.find((h) => h.handId === 'rmd_ml_h1')!.myNet).toBe(106);

    const session = (
      await ctx.app.inject({
        method: 'GET',
        url: '/api/rooms/rmd_ml/session',
        headers: auth(hero.token),
      })
    ).json() as { hands: number; players: { userId: number; net: number; handsPlayed: number }[] };
    expect(session.hands).toBe(1);
    expect(session.players.find((p) => p.userId === hero.userId)).toMatchObject({
      net: 106,
      handsPlayed: 1,
    });

    const best = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/users/${hero.userId}/best-hand`,
        headers: auth(hero.token),
      })
    ).json() as { hand: { handId: string; amount: number } };
    expect(best.hand).toMatchObject({ handId: 'rmd_ml_h1', amount: 106 });

    const timeline = (
      await ctx.app.inject({ method: 'GET', url: '/api/me/timeline', headers: auth(hero.token) })
    ).json() as { points: { net: number }[] };
    expect(timeline.points.at(-1)!.net).toBe(106);

    const house = (
      await ctx.app.inject({ method: 'GET', url: '/api/admin/house', headers: auth(platform.token) })
    ).json() as { totals: { accrued: number; unallocated: number } };
    expect(house.totals).toMatchObject({ accrued: 10, unallocated: 0 });
  });

  // -------------------------------------------------------------------------
  // Blocker 2: a legacy head-only void must still kill a hand-id-ref bounty
  // -------------------------------------------------------------------------
  it('a legacy head-only void excludes the hand-id-ref bounty from every read model', async () => {
    const hero = await register('rmd_ho_hero');
    const villain = await register('rmd_ho_villain');
    const platform = await register('rmd_ho_platform');
    setPlatformUserId(ctx.db, platform.userId);
    makeRoom(ctx.db, 'rmd_ho', hero.userId);
    joinRoom(ctx.db, 'rmd_ho', hero.userId, 0);
    joinRoom(ctx.db, 'rmd_ho', villain.userId, 1);
    joinRoom(ctx.db, 'rmd_ho', platform.userId, null);
    const heroNet = seedHand(ctx.db, {
      id: 'rmd_ho_h1',
      head: 'rmd_ho_head1',
      roomId: 'rmd_ho',
      hero: hero.userId,
      villain: villain.userId,
      platform: platform.userId,
      pokerHero: 50,
      pokerVillain: -50,
      bountyHero: 7,
      bountyVillain: -7,
      rake: 5,
    });
    expect(heroNet).toBe(57);
    // Exactly what the OLD void route wrote: a single compensating row against
    // the transcript HEAD. It never mirrored the hand-id ref, so the bounty leg
    // (ref = hand id) has to be found via the derived head.
    appendLedger(ctx.db, {
      roomId: 'rmd_ho',
      userId: hero.userId,
      delta: 0,
      kind: 'void-hand',
      ref: 'rmd_ho_head1',
    });

    const profile = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/users/${hero.userId}/profile`,
        headers: auth(hero.token),
      })
    ).json() as { stats: unknown };
    expect(profile.stats).toMatchObject({ net: 0, handsPlayed: 0, biggestWin: 0 });

    const lb = (
      await ctx.app.inject({ method: 'GET', url: '/api/leaderboard', headers: auth(hero.token) })
    ).json() as { rows: { userId: number; net: number }[] };
    expect(lb.rows.find((r) => r.userId === hero.userId)?.net ?? 0).toBe(0);

    const timeline = (
      await ctx.app.inject({ method: 'GET', url: '/api/me/timeline', headers: auth(hero.token) })
    ).json() as { points: { net: number }[] };
    expect(timeline.points.at(-1)?.net ?? 0).toBe(0);

    const best = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/users/${hero.userId}/best-hand`,
        headers: auth(hero.token),
      })
    ).json() as { hand: unknown };
    expect(best.hand).toBeNull();

    const roomHands = (
      await ctx.app.inject({
        method: 'GET',
        url: '/api/rooms/rmd_ho/hands',
        headers: auth(hero.token),
      })
    ).json() as { hands: { handId: string; voided: boolean }[] };
    expect(roomHands.hands.find((h) => h.handId === 'rmd_ho_h1')!.voided).toBe(true);

    const session = (
      await ctx.app.inject({
        method: 'GET',
        url: '/api/rooms/rmd_ho/session',
        headers: auth(hero.token),
      })
    ).json() as { hands: number; players: { userId: number; net: number }[] };
    expect(session.hands).toBe(0);
    expect(session.players.find((p) => p.userId === hero.userId)?.net ?? 0).toBe(0);

    const house = (
      await ctx.app.inject({ method: 'GET', url: '/api/admin/house', headers: auth(platform.token) })
    ).json() as { totals: { accrued: number } };
    expect(house.totals.accrued).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Blocker 1+2+4: the LIVE void route (real POST) and the canonical house filter
  // -------------------------------------------------------------------------
  it('the live POST void route reverses the hand and its bounty in every read model', async () => {
    const hero = await register('rmd_pv_hero');
    const villain = await register('rmd_pv_villain');
    const platform = await register('rmd_pv_platform');
    setPlatformUserId(ctx.db, platform.userId);
    makeRoom(ctx.db, 'rmd_pv', hero.userId);
    joinRoom(ctx.db, 'rmd_pv', hero.userId, 0);
    joinRoom(ctx.db, 'rmd_pv', villain.userId, 1);
    joinRoom(ctx.db, 'rmd_pv', platform.userId, null);
    seedHand(ctx.db, {
      id: 'rmd_pv_h1',
      head: 'rmd_pv_head1',
      roomId: 'rmd_pv',
      hero: hero.userId,
      villain: villain.userId,
      platform: platform.userId,
      pokerHero: 50,
      pokerVillain: -50,
      bountyHero: 7,
      bountyVillain: -7,
      rake: 5,
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/rooms/rmd_pv/void-hand',
      headers: auth(hero.token),
      payload: { handId: 'rmd_pv_h1' },
    });
    expect(res.statusCode).toBe(200);
    // one reversal per leg: 2 settlement + 2 bounty + 1 commission.
    expect((res.json() as { reversed: number }).reversed).toBe(5);

    const profile = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/users/${hero.userId}/profile`,
        headers: auth(hero.token),
      })
    ).json() as { stats: unknown };
    expect(profile.stats).toMatchObject({ net: 0, handsPlayed: 0, biggestWin: 0 });

    const house = (
      await ctx.app.inject({ method: 'GET', url: '/api/admin/house', headers: auth(platform.token) })
    ).json() as { totals: { accrued: number } };
    expect(house.totals.accrued).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Blocker 3: a post-settlement voluntary 7-2 show is NOT part of the game net
  // -------------------------------------------------------------------------
  it('a post-settlement voluntary 7-2 show stays out of every game-net read model', async () => {
    const hero = await register('rmd_vol_hero');
    const villain = await register('rmd_vol_villain');
    const platform = await register('rmd_vol_platform');
    setPlatformUserId(ctx.db, platform.userId);
    makeRoom(ctx.db, 'rmd_vol', hero.userId);
    joinRoom(ctx.db, 'rmd_vol', hero.userId, 0);
    joinRoom(ctx.db, 'rmd_vol', villain.userId, 1);
    joinRoom(ctx.db, 'rmd_vol', platform.userId, null);
    const heroNet = seedHand(ctx.db, {
      id: 'rmd_vol_h1',
      head: 'rmd_vol_head1',
      roomId: 'rmd_vol',
      hero: hero.userId,
      villain: villain.userId,
      platform: platform.userId,
      pokerHero: 50,
      pokerVillain: -50,
      showHero: 7,
      showVillain: -7,
      rake: 5,
    });
    // the authoritative game net ignores the later voluntary transfer...
    expect(heroNet).toBe(50);
    // ...and both show legs exist under their own kind.
    expect(
      (
        ctx.db
          .prepare('SELECT COUNT(*) AS n FROM ledger WHERE room_id = ? AND kind = ?')
          .get('rmd_vol', SEVEN_DEUCE_SHOW_KIND) as { n: number }
      ).n,
    ).toBe(2);

    const profile = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/users/${hero.userId}/profile`,
        headers: auth(hero.token),
      })
    ).json() as { stats: unknown };
    expect(profile.stats).toMatchObject({ net: 50, handsPlayed: 1, biggestWin: 50 });

    const lb = (
      await ctx.app.inject({ method: 'GET', url: '/api/leaderboard', headers: auth(hero.token) })
    ).json() as { rows: { userId: number; net: number }[] };
    expect(lb.rows.find((r) => r.userId === hero.userId)!.net).toBe(50);

    const timeline = (
      await ctx.app.inject({ method: 'GET', url: '/api/me/timeline', headers: auth(hero.token) })
    ).json() as { points: { net: number }[] };
    expect(timeline.points.at(-1)!.net).toBe(50);

    const best = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/users/${hero.userId}/best-hand`,
        headers: auth(hero.token),
      })
    ).json() as { hand: { amount: number } };
    expect(best.hand).toMatchObject({ amount: 50 });

    const roomHands = (
      await ctx.app.inject({
        method: 'GET',
        url: '/api/rooms/rmd_vol/hands',
        headers: auth(hero.token),
      })
    ).json() as { hands: { handId: string; myNet: number | null }[] };
    expect(roomHands.hands.find((h) => h.handId === 'rmd_vol_h1')!.myNet).toBe(50);

    const session = (
      await ctx.app.inject({
        method: 'GET',
        url: '/api/rooms/rmd_vol/session',
        headers: auth(hero.token),
      })
    ).json() as { hands: number; players: { userId: number; net: number }[] };
    expect(session.hands).toBe(1);
    expect(session.players.find((p) => p.userId === hero.userId)).toMatchObject({ net: 50 });

    const history = (
      await ctx.app.inject({
        method: 'GET',
        url: '/api/me/hand-history',
        headers: auth(hero.token),
      })
    ).json() as { hands: { handId: string; net: number }[] };
    expect(history.hands.find((h) => h.handId === 'rmd_vol_h1')!.net).toBe(50);

    const house = (
      await ctx.app.inject({ method: 'GET', url: '/api/admin/house', headers: auth(platform.token) })
    ).json() as { totals: { accrued: number; unallocated: number } };
    expect(house.totals).toMatchObject({ accrued: 5, unallocated: 0 });
  });

  // -------------------------------------------------------------------------
  // Test-strength: a REAL `applyHandSettlement()` writes the AUTOMATIC bounty as
  // `seven-deuce`, and a markerless toggle of that same hand still collapses.
  // -------------------------------------------------------------------------
  it('real applyHandSettlement: automatic bounty is in the net, even after the marker is gone', async () => {
    const hero = await register('rmd_real_hero');
    const villain = await register('rmd_real_villain');
    setPlatformUserId(ctx.db, (await register('rmd_real_platform')).userId);
    makeRoom(ctx.db, 'rmd_real', hero.userId);
    joinRoom(ctx.db, 'rmd_real', hero.userId, 0);
    joinRoom(ctx.db, 'rmd_real', villain.userId, 1);

    const entries = huEntries(hero.userId, villain.userId, 0);
    const out = applyHandSettlement(ctx.db, {
      handId: 'rmd_real_h1',
      roomId: 'rmd_real',
      head: headOf(entries),
      entries,
      rake: 0,
      commissionBps: 50,
      stackDeltas: [
        { userId: hero.userId, delta: 16 },
        { userId: villain.userId, delta: -16 },
      ],
      pokerLedger: [
        { userId: hero.userId, delta: 10 },
        { userId: villain.userId, delta: -10 },
      ],
      projectionPokerLedger: [
        { userId: hero.userId, delta: 16 },
        { userId: villain.userId, delta: -16 },
      ],
      squidLedger: [],
      squidNote: '',
      timeBanks: [],
      timeBankEpoch: null,
      triggerIds: [],
      bombRan: false,
      rakeRecipientId: null,
      sevenDeuce: {
        winnerUserId: hero.userId,
        winnerSeat: 0,
        winnerAmount: 6,
        payerAmounts: [{ userId: villain.userId, amount: 6 }],
      },
      now: 100,
    });
    expect(out.status).toBe('applied');
    // the AUTOMATIC bounty rode the settlement transaction under the plain kind.
    expect(
      (
        ctx.db
          .prepare("SELECT COUNT(*) AS n FROM ledger WHERE room_id = 'rmd_real' AND kind = 'seven-deuce'")
          .get() as { n: number }
      ).n,
    ).toBe(2);
    expect(
      (
        ctx.db
          .prepare('SELECT COUNT(*) AS n FROM ledger WHERE room_id = ? AND kind = ?')
          .get('rmd_real', SEVEN_DEUCE_SHOW_KIND) as { n: number }
      ).n,
    ).toBe(0);

    const profileNet = async () =>
      (
        (
          await ctx.app.inject({
            method: 'GET',
            url: `/api/users/${hero.userId}/profile`,
            headers: auth(hero.token),
          })
        ).json() as { stats: { net: number; handsPlayed: number } }
      ).stats;
    const roomHandNet = async () =>
      (
        (
          await ctx.app.inject({
            method: 'GET',
            url: '/api/rooms/rmd_real/hands',
            headers: auth(hero.token),
          })
        ).json() as { hands: { handId: string; myNet: number | null }[] }
      ).hands.find((h) => h.handId === 'rmd_real_h1')!.myNet;

    expect(await profileNet()).toMatchObject({ net: 16, handsPlayed: 1 });
    expect(await roomHandNet()).toBe(16);

    // Now strip the durable marker: the transcript fallback must keep the
    // settlement (head-ref) and bounty (hand-id-ref) legs in ONE hand.
    ctx.db.prepare('DELETE FROM hand_settlements WHERE hand_id = ?').run('rmd_real_h1');
    expect(await profileNet()).toMatchObject({ net: 16, handsPlayed: 1 });
    expect(await roomHandNet()).toBe(16);
  });

  // -------------------------------------------------------------------------
  // Blocker (WRITE side): a markerless legacy hand (transcript + ledger, but NO
  // `hand_settlements` marker) must resolve BOTH ledger refs when voided, from
  // EITHER direction. Resolving from the marker alone saw only one ref family,
  // so a void passed as the settlement head left the hand-id-ref bounty /
  // voluntary show / peek un-reversed (and vice versa) - a real, reachable
  // historical shape now explicitly supported. These drive the REAL POST route.
  // -------------------------------------------------------------------------
  type LegRow = { user_id: number; delta: number; kind: string; ref: string };
  const handLedger = (roomId: string, handId: string, head: string): LegRow[] =>
    ctx.db
      .prepare('SELECT user_id, delta, kind, ref FROM ledger WHERE room_id = ? AND ref IN (?, ?)')
      .all(roomId, handId, head) as LegRow[];

  /** Every original leg has exactly one reversal under the SAME user/ref with
   *  the negated delta - i.e. all six kinds are covered, per leg - and the
   *  hand's originals + reversals conserve to zero per account and in total.
   *  A reversal row's own `kind` is always `void-hand`, so coverage is proven by
   *  the multiset (user, ref, -delta) match, not by re-checking the kind. */
  const expectAllLegsReversed = (rows: LegRow[]) => {
    const originals = rows.filter((r) => r.kind !== 'void-hand');
    const voids = rows.filter((r) => r.kind === 'void-hand');
    expect(voids).toHaveLength(originals.length);
    const pool = voids.slice();
    for (const o of originals) {
      const i = pool.findIndex((v) => v.user_id === o.user_id && v.ref === o.ref && v.delta === -o.delta);
      expect(i, `no reversal for ${o.kind} ref=${o.ref} user=${o.user_id}`).toBeGreaterThanOrEqual(0);
      pool.splice(i, 1);
    }
    expect(pool).toHaveLength(0);
    expect(rows.reduce((s, r) => s + r.delta, 0)).toBe(0);
    for (const u of new Set(rows.map((r) => r.user_id))) {
      expect(rows.filter((r) => r.user_id === u).reduce((s, r) => s + r.delta, 0)).toBe(0);
    }
    return { originals, voids };
  };

  /** A markerless hand carrying all six money kinds, zero-sum across the hand. */
  function seedMarkerlessSixKinds(
    roomId: string,
    id: string,
    head: string,
    hero: number,
    villain: number,
    platform: number,
  ): number {
    return seedHand(ctx.db, {
      id,
      head,
      roomId,
      hero,
      villain,
      platform,
      markerless: true,
      pokerHero: 47,
      pokerVillain: -52,
      squidHero: -3,
      squidVillain: 3,
      bountyHero: 4,
      bountyVillain: -4,
      showHero: 6,
      showVillain: -6,
      peekHero: -2,
      peekVillain: 2,
      rake: 5,
    });
  }

  async function seedMarkerlessRoom(prefix: string, roomId: string) {
    const hero = await register(`${prefix}_hero`);
    const villain = await register(`${prefix}_villain`);
    const platform = await register(`${prefix}_platform`);
    setPlatformUserId(ctx.db, platform.userId);
    makeRoom(ctx.db, roomId, hero.userId);
    joinRoom(ctx.db, roomId, hero.userId, 0);
    joinRoom(ctx.db, roomId, villain.userId, 1);
    joinRoom(ctx.db, roomId, platform.userId, null);
    return { hero, villain, platform };
  }

  const sixKinds = new Set([
    'hand-settlement',
    'commission',
    'squid-game',
    'seven-deuce',
    SEVEN_DEUCE_SHOW_KIND,
    'peek',
  ]);

  it('markerless hand voided by the settlement HEAD reverses all six kinds', async () => {
    const { hero, villain, platform } = await seedMarkerlessRoom('rmd_mlh', 'rmd_mlh');
    const heroNet = seedMarkerlessSixKinds('rmd_mlh', 'rmd_mlh_h1', 'rmd_mlh_head1', hero.userId, villain.userId, platform.userId);
    // game net = 47 poker - 3 squid + 4 bounty (the voluntary show and the
    // independent peek stay out of the game net).
    expect(heroNet).toBe(48);
    // Premise: markerless, but the transcript (and the ledger) are present.
    expect(
      (ctx.db.prepare('SELECT COUNT(*) AS n FROM hand_settlements WHERE hand_id = ?').get('rmd_mlh_h1') as { n: number }).n,
    ).toBe(0);
    expect(
      (ctx.db.prepare('SELECT COUNT(*) AS n FROM transcripts WHERE hand_id = ?').get('rmd_mlh_h1') as { n: number }).n,
    ).toBe(1);

    // The banker's client passes the settlement ledger ref, i.e. the HEAD.
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/rooms/rmd_mlh/void-hand',
      headers: auth(hero.token),
      payload: { handId: 'rmd_mlh_head1' },
    });
    expect(res.statusCode).toBe(200);
    // 2 settlement + 2 squid + 1 commission + 2 bounty + 2 show + 2 peek
    expect((res.json() as { reversed: number }).reversed).toBe(11);

    const { originals, voids } = expectAllLegsReversed(handLedger('rmd_mlh', 'rmd_mlh_h1', 'rmd_mlh_head1'));
    expect(new Set(originals.map((r) => r.kind))).toEqual(sixKinds);
    // both ref conventions were matched: head-ref and hand-id-ref legs.
    expect(voids.filter((v) => v.ref === 'rmd_mlh_head1')).toHaveLength(5);
    expect(voids.filter((v) => v.ref === 'rmd_mlh_h1')).toHaveLength(6);
    // the hand-id-ref kinds (bounty / voluntary show / peek) really do carry the
    // hand id, and their reversal landed under that same key.
    for (const k of ['seven-deuce', SEVEN_DEUCE_SHOW_KIND, 'peek']) {
      expect(originals.filter((o) => o.kind === k).every((o) => o.ref === 'rmd_mlh_h1')).toBe(true);
    }

    // duplicate guard: a second void, passed as the OTHER key, is rejected and
    // writes nothing new.
    const again = await ctx.app.inject({
      method: 'POST',
      url: '/api/rooms/rmd_mlh/void-hand',
      headers: auth(hero.token),
      payload: { handId: 'rmd_mlh_h1' },
    });
    expect(again.statusCode).toBe(400);
    expect(handLedger('rmd_mlh', 'rmd_mlh_h1', 'rmd_mlh_head1').filter((r) => r.kind === 'void-hand')).toHaveLength(11);
  });

  it('markerless hand voided by the HAND ID reverses all six kinds as well', async () => {
    const { hero, villain, platform } = await seedMarkerlessRoom('rmd_mli', 'rmd_mli');
    const heroNet = seedMarkerlessSixKinds('rmd_mli', 'rmd_mli_h1', 'rmd_mli_head1', hero.userId, villain.userId, platform.userId);
    expect(heroNet).toBe(48);

    // This caller knows only the hand id (not the head).
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/rooms/rmd_mli/void-hand',
      headers: auth(hero.token),
      payload: { handId: 'rmd_mli_h1' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { reversed: number }).reversed).toBe(11);

    const { originals, voids } = expectAllLegsReversed(handLedger('rmd_mli', 'rmd_mli_h1', 'rmd_mli_head1'));
    expect(new Set(originals.map((r) => r.kind))).toEqual(sixKinds);
    expect(voids.filter((v) => v.ref === 'rmd_mli_head1')).toHaveLength(5);
    expect(voids.filter((v) => v.ref === 'rmd_mli_h1')).toHaveLength(6);
  });
});
