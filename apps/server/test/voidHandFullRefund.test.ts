import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  cardPoint,
  genIdentity,
  handKeyCommit,
  mulPoint,
  pointHex,
  proveUnmask,
  randScalar,
  signContent,
} from '@4am/mental-poker';
import type { CardId, ServerMsg } from '@4am/shared';
import { createApp } from '../src/app.js';
import type { DB } from '../src/db.js';
import { GameRoom } from '../src/game.js';
import { appendLedger } from '../src/ledger.js';
import { setPlatformUserId } from '../src/platform.js';

// ---------------------------------------------------------------------------
// Full-funding void: voiding a hand must reverse ALL of its money legs, not
// just the poker settlement and the rake. A hand writes chips under five
// ledger kinds:
//   hand-settlement, commission, squid-game  -> ref = transcript head
//   seven-deuce, peek                        -> ref = hand id
// The two keys are NOT interchangeable, so the reversal matches each kind on
// its own key. These tests drive the REAL `POST /void-hand` route and assert
// per-account conservation (stack change == sum of reversed legs), that the
// hand's combined legs net to zero, idempotency, and that the read models stay
// in step with the refund.
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
function addPlayer(db: DB, roomId: string, userId: number, seat: number | null, stack: number): void {
  db.prepare('INSERT INTO room_players (room_id, user_id, seat, stack) VALUES (?, ?, ?, ?)').run(
    roomId,
    userId,
    seat,
    stack,
  );
}
function stackOf(db: DB, roomId: string, userId: number): number {
  return (db.prepare('SELECT stack FROM room_players WHERE room_id = ? AND user_id = ?').get(roomId, userId) as {
    stack: number;
  }).stack;
}

type SeedKind = 'hand-settlement' | 'squid-game' | 'seven-deuce' | 'peek';
interface SeedLeg {
  userId: number;
  delta: number;
  kind: SeedKind;
}

/** The ref a leg is written under: head for the settlement-family kinds,
 *  hand id for seven-deuce / peek. */
function refFor(kind: SeedKind, ids: { handId: string; head: string }): string {
  return kind === 'seven-deuce' || kind === 'peek' ? ids.handId : ids.head;
}

/**
 * Seed one fully settled hand the way the engine writes it: projection rows,
 * transcript, hand_settlements marker, the money legs under their own refs,
 * and the matching stack moves. `players` get a `hand_players` row so the
 * stats/HUD read models see them.
 */
function seedHand(
  db: DB,
  o: {
    handId: string;
    head: string;
    roomId: string;
    legs: SeedLeg[];
    players?: { userId: number; seat: number }[];
    rake?: number;
    rakeTo?: number | null;
    rakeBps?: number;
  },
): void {
  const rake = o.rake ?? 0;
  const players = o.players ?? [];
  db.prepare(
    `INSERT INTO hands (hand_id, room_id, source_head, status, game_kind, bb, settled_at, transcript_ts, parser_version, projection_status)
     VALUES (?, ?, ?, 'settled', 'normal', 10, 1000, 1000, 1, 'ok')`,
  ).run(o.handId, o.roomId, o.head);
  db.prepare(
    "INSERT INTO hand_settlements (hand_id, room_id, head, rake, final_stacks, applied_at) VALUES (?, ?, ?, ?, '[]', 1000)",
  ).run(o.handId, o.roomId, o.head, rake);
  const entries = JSON.stringify([
    {
      type: 'hand_start',
      payload: { seats: players.map((p) => ({ seat: p.seat, userId: p.userId })) },
    },
    { type: 'settlement', payload: { board: [0, 1, 2, 3, 4], reveals: [] } },
  ]);
  db.prepare('INSERT INTO transcripts (hand_id, room_id, head, entries, ts) VALUES (?, ?, ?, ?, 1000)').run(
    o.handId,
    o.roomId,
    o.head,
    entries,
  );
  const insPlayer = db.prepare(
    `INSERT INTO hand_players (
       hand_id, seat, user_id, position, position_index, preflop_order, postflop_order,
       blind_role, nominal_blind, forced_post, invested, poker_award, poker_delta, squid_delta,
       net_delta, folded, fold_street, saw_flop, went_to_showdown, won_poker, data_confidence
     ) VALUES (?, ?, ?, ?, NULL, NULL, ?, 'none', 0, 0, 0, 0, ?, ?, ?, 0, NULL, 0, 0, 0, 'exact')`,
  );
  for (const p of players) {
    const pd = o.legs
      .filter((l) => l.kind === 'hand-settlement' && l.userId === p.userId)
      .reduce((s, l) => s + l.delta, 0);
    const sd = o.legs
      .filter((l) => l.kind === 'squid-game' && l.userId === p.userId)
      .reduce((s, l) => s + l.delta, 0);
    insPlayer.run(o.handId, p.seat, p.userId, 'BTN', p.seat, pd, sd, pd + sd);
  }
  for (const leg of o.legs) {
    appendLedger(db, {
      roomId: o.roomId,
      userId: leg.userId,
      delta: leg.delta,
      kind: leg.kind,
      ref: refFor(leg.kind, o),
    });
  }
  if (rake > 0 && o.rakeTo !== null && o.rakeTo !== undefined) {
    db.prepare(
      'INSERT OR IGNORE INTO hand_commission_rates (room_id, ref, commission_bps) VALUES (?, ?, ?)',
    ).run(o.roomId, o.head, o.rakeBps ?? 0);
    appendLedger(db, { roomId: o.roomId, userId: o.rakeTo, delta: rake, kind: 'commission', ref: o.head });
  }
  // Apply the original money moves so the room stacks reflect the settled hand.
  const moves = o.legs.map((l) => ({ userId: l.userId, delta: l.delta }));
  if (rake > 0 && o.rakeTo !== null && o.rakeTo !== undefined) moves.push({ userId: o.rakeTo, delta: rake });
  for (const m of moves) {
    db.prepare('INSERT OR IGNORE INTO room_players (room_id, user_id) VALUES (?, ?)').run(o.roomId, m.userId);
    db.prepare('UPDATE room_players SET stack = stack + ? WHERE room_id = ? AND user_id = ?').run(
      m.delta,
      o.roomId,
      m.userId,
    );
  }
}

/** Every money row correlated to the hand - originals AND reversals - under
 *  either convention. */
function handMoney(
  db: DB,
  roomId: string,
  handId: string,
  head: string,
): { user_id: number; delta: number; kind: string; ref: string }[] {
  return db
    .prepare(
      `SELECT user_id, delta, kind, ref FROM ledger
       WHERE room_id = ? AND ref IN (?, ?)
         AND kind IN ('hand-settlement','commission','squid-game','seven-deuce','peek','void-hand')`,
    )
    .all(roomId, handId, head) as { user_id: number; delta: number; kind: string; ref: string }[];
}

function voidHand(roomId: string, token: string, handId: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/rooms/${roomId}/void-hand`,
    headers: auth(token),
    payload: { handId },
  });
}

describe('void-hand reverses every money kind', () => {
  it('reverses settlement + commission + squid + seven-deuce + peek account-by-account', async () => {
    const host = await register('ff_host');
    const villain = await register('ff_villain');
    const platform = await register('ff_platform');
    setPlatformUserId(ctx.db, platform.userId);
    makeRoom(ctx.db, 'ff', host.userId);
    addPlayer(ctx.db, 'ff', host.userId, 0, 1000);
    addPlayer(ctx.db, 'ff', villain.userId, 1, 1000);
    addPlayer(ctx.db, 'ff', platform.userId, null, 0);

    // legs net to zero: settlement -5, commission +5; squid/seven/peek pair off.
    seedHand(ctx.db, {
      handId: 'h_full',
      head: 'head_full',
      roomId: 'ff',
      players: [
        { userId: host.userId, seat: 0 },
        { userId: villain.userId, seat: 1 },
      ],
      legs: [
        { userId: host.userId, delta: 47, kind: 'hand-settlement' },
        { userId: villain.userId, delta: -52, kind: 'hand-settlement' },
        { userId: host.userId, delta: -3, kind: 'squid-game' },
        { userId: villain.userId, delta: 3, kind: 'squid-game' },
        { userId: villain.userId, delta: -4, kind: 'seven-deuce' },
        { userId: host.userId, delta: 4, kind: 'seven-deuce' },
        { userId: host.userId, delta: -2, kind: 'peek' },
        { userId: villain.userId, delta: 2, kind: 'peek' },
      ],
      rake: 5,
      rakeTo: platform.userId,
      rakeBps: 100,
    });

    const users = [host.userId, villain.userId, platform.userId];
    const before = new Map(users.map((u) => [u, stackOf(ctx.db, 'ff', u)]));
    // the hand's original legs sum to zero (a necessary conservation premise)
    const originals = handMoney(ctx.db, 'ff', 'h_full', 'head_full').filter((r) => r.kind !== 'void-hand');
    expect(originals.reduce((s, r) => s + r.delta, 0)).toBe(0);

    const res = await voidHand('ff', host.token, 'h_full');
    expect(res.statusCode).toBe(200);
    expect((res.json() as { reversed: number }).reversed).toBe(9);

    // per-account: stack change == sum of that account's reversed legs
    for (const u of users) {
      const original = originals.filter((r) => r.user_id === u).reduce((s, r) => s + r.delta, 0);
      expect(stackOf(ctx.db, 'ff', u) - before.get(u)!).toBe(-original);
    }
    // and the hand restores to its pre-settlement stacks exactly
    expect(stackOf(ctx.db, 'ff', host.userId)).toBe(1000);
    expect(stackOf(ctx.db, 'ff', villain.userId)).toBe(1000);
    expect(stackOf(ctx.db, 'ff', platform.userId)).toBe(0);

    // whole-hand conservation: originals + reversals sum to zero, per account too
    const all = handMoney(ctx.db, 'ff', 'h_full', 'head_full');
    expect(all.reduce((s, r) => s + r.delta, 0)).toBe(0);
    for (const u of users) expect(all.filter((r) => r.user_id === u).reduce((s, r) => s + r.delta, 0)).toBe(0);

    // each kind was matched on its own key: settlement-family comps carry the
    // head, seven-deuce/peek comps carry the hand id.
    const voids = all.filter((r) => r.kind === 'void-hand');
    expect(voids).toHaveLength(9);
    expect(voids.filter((r) => r.ref === 'head_full')).toHaveLength(5); // 2 settlement + 2 squid + 1 commission
    expect(voids.filter((r) => r.ref === 'h_full')).toHaveLength(4); // 2 seven-deuce + 2 peek
  });

  it('reverses a partial hand that only wrote seven-deuce and peek legs', async () => {
    const host = await register('pf_host');
    const villain = await register('pf_villain');
    makeRoom(ctx.db, 'pf', host.userId);
    addPlayer(ctx.db, 'pf', host.userId, 0, 1000);
    addPlayer(ctx.db, 'pf', villain.userId, 1, 1000);
    seedHand(ctx.db, {
      handId: 'h_partial',
      head: 'head_partial',
      roomId: 'pf',
      players: [
        { userId: host.userId, seat: 0 },
        { userId: villain.userId, seat: 1 },
      ],
      legs: [
        { userId: villain.userId, delta: -4, kind: 'seven-deuce' },
        { userId: host.userId, delta: 4, kind: 'seven-deuce' },
        { userId: host.userId, delta: -2, kind: 'peek' },
        { userId: villain.userId, delta: 2, kind: 'peek' },
      ],
    });

    const before = new Map([
      [host.userId, stackOf(ctx.db, 'pf', host.userId)],
      [villain.userId, stackOf(ctx.db, 'pf', villain.userId)],
    ]);
    // void by the HEAD: seven-deuce/peek key on the hand id, so a mechanical
    // head-only match would miss both.
    const res = await voidHand('pf', host.token, 'head_partial');
    expect(res.statusCode).toBe(200);
    expect((res.json() as { reversed: number }).reversed).toBe(4);
    expect(stackOf(ctx.db, 'pf', host.userId) - before.get(host.userId)!).toBe(-2);
    expect(stackOf(ctx.db, 'pf', villain.userId) - before.get(villain.userId)!).toBe(2);
    expect(handMoney(ctx.db, 'pf', 'h_partial', 'head_partial').reduce((s, r) => s + r.delta, 0)).toBe(0);
  });

  it('stays conservative when the rake recipient is an in-hand player', async () => {
    const host = await register('rk_host');
    const villain = await register('rk_villain');
    makeRoom(ctx.db, 'rk', host.userId);
    addPlayer(ctx.db, 'rk', host.userId, 0, 1000);
    addPlayer(ctx.db, 'rk', villain.userId, 1, 1000);
    seedHand(ctx.db, {
      handId: 'h_rake',
      head: 'head_rake',
      roomId: 'rk',
      players: [
        { userId: host.userId, seat: 0 },
        { userId: villain.userId, seat: 1 },
      ],
      legs: [
        { userId: host.userId, delta: 42, kind: 'hand-settlement' },
        { userId: villain.userId, delta: -47, kind: 'hand-settlement' },
        { userId: villain.userId, delta: -1, kind: 'peek' },
        { userId: host.userId, delta: 1, kind: 'peek' },
      ],
      rake: 5,
      rakeTo: host.userId,
      rakeBps: 100,
    });

    // host nets +48 (settlement +42, rake +5, peek +1) and must fund it.
    const before = new Map([
      [host.userId, stackOf(ctx.db, 'rk', host.userId)],
      [villain.userId, stackOf(ctx.db, 'rk', villain.userId)],
    ]);
    const res = await voidHand('rk', host.token, 'h_rake');
    expect(res.statusCode).toBe(200);
    expect((res.json() as { reversed: number }).reversed).toBe(5);
    expect(stackOf(ctx.db, 'rk', host.userId) - before.get(host.userId)!).toBe(-48);
    expect(stackOf(ctx.db, 'rk', villain.userId) - before.get(villain.userId)!).toBe(48);
    expect(handMoney(ctx.db, 'rk', 'h_rake', 'head_rake').reduce((s, r) => s + r.delta, 0)).toBe(0);
  });

  it('is idempotent: a second void is a no-op and does not refund twice', async () => {
    const host = await register('id_host');
    const villain = await register('id_villain');
    makeRoom(ctx.db, 'id', host.userId);
    addPlayer(ctx.db, 'id', host.userId, 0, 1000);
    addPlayer(ctx.db, 'id', villain.userId, 1, 1000);
    seedHand(ctx.db, {
      handId: 'h_idem',
      head: 'head_idem',
      roomId: 'id',
      players: [
        { userId: host.userId, seat: 0 },
        { userId: villain.userId, seat: 1 },
      ],
      legs: [
        { userId: host.userId, delta: 10, kind: 'hand-settlement' },
        { userId: villain.userId, delta: -10, kind: 'hand-settlement' },
      ],
    });

    const first = await voidHand('id', host.token, 'head_idem');
    expect(first.statusCode).toBe(200);
    const afterFirst = new Map([
      [host.userId, stackOf(ctx.db, 'id', host.userId)],
      [villain.userId, stackOf(ctx.db, 'id', villain.userId)],
    ]);
    const voidsAfterFirst = (
      ctx.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE room_id = 'id' AND kind = 'void-hand'").get() as {
        n: number;
      }
    ).n;

    // repeat with the head AND with the hand id: both must be recognised
    const againHead = await voidHand('id', host.token, 'head_idem');
    expect(againHead.statusCode).toBe(400);
    const againId = await voidHand('id', host.token, 'h_idem');
    expect(againId.statusCode).toBe(400);

    expect(stackOf(ctx.db, 'id', host.userId)).toBe(afterFirst.get(host.userId)!);
    expect(stackOf(ctx.db, 'id', villain.userId)).toBe(afterFirst.get(villain.userId)!);
    expect(
      (
        ctx.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE room_id = 'id' AND kind = 'void-hand'").get() as {
          n: number;
        }
      ).n,
    ).toBe(voidsAfterFirst);
  });
});

describe('read models stay consistent with the full refund', () => {
  it('drops the hand from stats / HUD / history / house after a full-kind void', async () => {
    const host = await register('rm_host');
    const villain = await register('rm_villain');
    const platform = await register('rm_platform');
    setPlatformUserId(ctx.db, platform.userId);
    makeRoom(ctx.db, 'rm', host.userId);
    addPlayer(ctx.db, 'rm', host.userId, 0, 1000);
    addPlayer(ctx.db, 'rm', villain.userId, 1, 1000);
    addPlayer(ctx.db, 'rm', platform.userId, null, 0);
    seedHand(ctx.db, {
      handId: 'h_rm',
      head: 'head_rm',
      roomId: 'rm',
      players: [
        { userId: host.userId, seat: 0 },
        { userId: villain.userId, seat: 1 },
      ],
      legs: [
        { userId: host.userId, delta: 47, kind: 'hand-settlement' },
        { userId: villain.userId, delta: -52, kind: 'hand-settlement' },
        { userId: host.userId, delta: -3, kind: 'squid-game' },
        { userId: villain.userId, delta: 3, kind: 'squid-game' },
        { userId: villain.userId, delta: -4, kind: 'seven-deuce' },
        { userId: host.userId, delta: 4, kind: 'seven-deuce' },
        { userId: host.userId, delta: -2, kind: 'peek' },
        { userId: villain.userId, delta: 2, kind: 'peek' },
      ],
      rake: 5,
      rakeTo: platform.userId,
      rakeBps: 100,
    });

    const meStats = async (token: string) =>
      (
        (await ctx.app.inject({ method: 'GET', url: '/api/me/stats', headers: auth(token) })).json() as {
          sample: number;
        }
      ).sample;
    const hudSample = async (token: string, userId: number) => {
      const r = await ctx.app.inject({ method: 'GET', url: '/api/rooms/rm/hud', headers: auth(token) });
      return (r.json() as { players: { userId: number; sample: number }[] }).players.find((p) => p.userId === userId)!
        .sample;
    };
    const houseAccrued = async () =>
      (
        (await ctx.app.inject({ method: 'GET', url: '/api/admin/house', headers: auth(platform.token) })).json() as {
          totals: { accrued: number };
        }
      ).totals.accrued;
    const historyVoided = async (token: string) => {
      const r = await ctx.app.inject({ method: 'GET', url: '/api/me/hand-history', headers: auth(token) });
      const h = (r.json() as { hands: { handId: string; voided: boolean }[] }).hands.find((x) => x.handId === 'h_rm')!;
      return h.voided;
    };

    expect(await meStats(host.token)).toBe(1);
    expect(await hudSample(villain.token, host.userId)).toBe(1);
    expect(await houseAccrued()).toBe(5);
    expect(await historyVoided(host.token)).toBe(false);

    const res = await voidHand('rm', host.token, 'h_rm');
    expect(res.statusCode).toBe(200);

    expect(await meStats(host.token)).toBe(0);
    expect(await hudSample(villain.token, host.userId)).toBe(0);
    expect(await houseAccrued()).toBe(0);
    expect(await historyVoided(host.token)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Void guard: no money leg may be added after a hand is voided.
//
// The refund reverses what was already written, but the engine kept accepting
// NEW legs against the same hand afterwards. A fold winner's legitimate later
// 7-2 show (or a peek agreed after the offer was made pre-void) re-opened a
// transfer a second void could never reverse - the second void is rejected as
// "already voided", so the hand stayed unbalanced forever. These tests drive
// the REAL /void-hand route with an in-memory GameRoom and assert every later
// leg is refused with no transfer, no broadcast and no ledger row.
// ---------------------------------------------------------------------------

/** A fake socket that records the JSON frames sent to it. */
function fakeSocket(): { sent: ServerMsg[]; ws: WebSocket } {
  const sent: ServerMsg[] = [];
  return {
    sent,
    ws: { send: (raw: string) => sent.push(JSON.parse(raw) as ServerMsg) } as unknown as WebSocket,
  };
}

interface SeatFixture {
  seat: {
    userId: number;
    pubkey: string;
    commit: unknown;
    cards: { deckIndex: number; point: unknown }[];
  };
  shares: { deckIndex: number; out: string; proof: { A1: string; A2: string; z: string } }[];
}

/**
 * A valid snapshot seat for `deckIndexes`: a fresh hand-key commitment plus the
 * exact DLEQ shares the holder would produce, so a peek/show acceptance passes
 * `verifySnapshotShares` and would otherwise move money.
 */
function seatFixture(userId: number, pubkey: string, cards: CardId[], deckIndexes: number[]): SeatFixture {
  const k = randScalar();
  const commit = handKeyCommit(k);
  const entries = deckIndexes.map((deckIndex, i) => {
    const point = mulPoint(cardPoint(cards[i]!), k);
    const { out, proof } = proveUnmask(k, point);
    return { deckIndex, point, share: { deckIndex, out: pointHex(out), proof } };
  });
  return {
    seat: {
      userId,
      pubkey,
      commit,
      cards: entries.map((e) => ({ deckIndex: e.deckIndex, point: e.point })),
    },
    shares: entries.map((e) => e.share),
  };
}

/** Install a `lastHandShow` snapshot on a GameRoom (private engine state). */
function setSnapshot(
  room: GameRoom,
  handId: string,
  seats: { seat: number; fixture: Pick<SeatFixture, 'seat'> }[],
  winnerSeats: number[],
  endedByFold: boolean,
): void {
  (room as unknown as { lastHandShow: unknown }).lastHandShow = {
    handId,
    bySeat: new Map(seats.map((s) => [s.seat, s.fixture.seat])),
    revealedSeats: new Set<number>(),
    winnerSeats,
    reveals: new Map<number, CardId[]>(),
    endedByFold,
  };
}

function gameOpts() {
  return { cryptoTimeoutMs: 60_000, actionTimeoutMs: 30_000, shutdownDrainMs: 50 };
}

describe('void guard: no money leg may be added after a hand is voided', () => {
  let room: GameRoom | null = null;
  afterEach(async () => {
    await room?.shutdown();
    room = null;
  });

  const ledgerKindCount = (roomId: string, kind: string) =>
    (
      ctx.db
        .prepare('SELECT COUNT(*) AS n FROM ledger WHERE room_id = ? AND kind = ?')
        .get(roomId, kind) as { n: number }
    ).n;

  it('rejects a 7-2 show after the hand was voided: no transfer, no cards_shown', async () => {
    const host = await register('vg1_host');
    const bob = await register('vg1_bob');
    makeRoom(ctx.db, 'vg1', host.userId);
    addPlayer(ctx.db, 'vg1', host.userId, 0, 1000);
    addPlayer(ctx.db, 'vg1', bob.userId, 1, 1000);
    // net-zero settlement so the void refund itself leaves stacks unchanged
    seedHand(ctx.db, {
      handId: 'h_vg1',
      head: 'head_vg1',
      roomId: 'vg1',
      players: [
        { userId: host.userId, seat: 0 },
        { userId: bob.userId, seat: 1 },
      ],
      legs: [
        { userId: host.userId, delta: -5, kind: 'hand-settlement' },
        { userId: bob.userId, delta: 5, kind: 'hand-settlement' },
      ],
    });
    ctx.db.prepare('UPDATE rooms SET seven_deuce_bonus = ? WHERE id = ?').run(25, 'vg1');

    room = new GameRoom(ctx.db, 'vg1', genIdentity(), gameOpts());
    const hostSock = fakeSocket();
    room.join(host.userId, hostSock.ws);
    setSnapshot(
      room,
      'h_vg1',
      [
        { seat: 0, fixture: seatFixture(host.userId, genIdentity().publicKey, [], []) },
        { seat: 1, fixture: seatFixture(bob.userId, genIdentity().publicKey, [], []) },
      ],
      [1],
      true,
    );

    // the banker voids the settled hand: the two settlement legs are reversed
    const res = await voidHand('vg1', host.token, 'h_vg1');
    expect(res.statusCode).toBe(200);
    expect((res.json() as { reversed: number }).reversed).toBe(2);
    expect(stackOf(ctx.db, 'vg1', host.userId)).toBe(1000);
    expect(stackOf(ctx.db, 'vg1', bob.userId)).toBe(1000);
    const sevenBefore = ledgerKindCount('vg1', 'seven-deuce');

    // the fold winner now legally reveals 7-2 offsuit: must be refused
    const broadcast = vi.spyOn(room, 'broadcast');
    expect(() => room!.recordShow('h_vg1', 1, [0, 21])).toThrow(/void/i);
    expect(broadcast.mock.calls.some(([m]) => (m as ServerMsg).t === 'cards_shown')).toBe(false);
    // no bounty transfer, no new leg, stacks untouched
    expect(ledgerKindCount('vg1', 'seven-deuce')).toBe(sevenBefore);
    expect(stackOf(ctx.db, 'vg1', host.userId)).toBe(1000);
    expect(stackOf(ctx.db, 'vg1', bob.userId)).toBe(1000);
    // the hand's rows still net to zero: the refusal cannot unbalance it
    expect(
      (
        ctx.db.prepare("SELECT COALESCE(SUM(delta), 0) AS s FROM ledger WHERE room_id = 'vg1'").get() as {
          s: number;
        }
      ).s,
    ).toBe(0);
    // and a second void is still refused, so there is no double refund
    const again = await voidHand('vg1', host.token, 'h_vg1');
    expect(again.statusCode).toBe(400);
  });

  it('rejects a peek accepted after the hand was voided: no transfer, peek_result failed', async () => {
    const host = await register('vg2_host'); // buyer / requester
    const bob = await register('vg2_bob'); // target
    makeRoom(ctx.db, 'vg2', host.userId);
    addPlayer(ctx.db, 'vg2', host.userId, 0, 1000);
    addPlayer(ctx.db, 'vg2', bob.userId, 1, 1000);
    seedHand(ctx.db, {
      handId: 'h_vg2',
      head: 'head_vg2',
      roomId: 'vg2',
      players: [
        { userId: host.userId, seat: 0 },
        { userId: bob.userId, seat: 1 },
      ],
      legs: [
        { userId: host.userId, delta: -5, kind: 'hand-settlement' },
        { userId: bob.userId, delta: 5, kind: 'hand-settlement' },
      ],
    });

    room = new GameRoom(ctx.db, 'vg2', genIdentity(), gameOpts());
    const hostSock = fakeSocket();
    const bobSock = fakeSocket();
    room.join(host.userId, hostSock.ws);
    room.join(bob.userId, bobSock.ws);
    const bobIdentity = genIdentity();
    const bobFixture = seatFixture(bob.userId, bobIdentity.publicKey, [0, 4], [0, 1]);
    setSnapshot(
      room,
      'h_vg2',
      [
        { seat: 0, fixture: seatFixture(host.userId, genIdentity().publicKey, [], []) },
        { seat: 1, fixture: bobFixture },
      ],
      [0],
      true,
    );

    // the offer is made while the hand is still live (pre-void)
    (room as unknown as { onPeekOffer(u: number, m: unknown): void }).onPeekOffer(host.userId, {
      t: 'peek_offer',
      handId: 'h_vg2',
      targetSeat: 1,
    });
    const offer = bobSock.sent.find((m) => m.t === 'peek_offer') as
      | { t: 'peek_offer'; offerId: string }
      | undefined;
    expect(offer).toBeTruthy();

    // the banker voids the hand
    const res = await voidHand('vg2', host.token, 'h_vg2');
    expect(res.statusCode).toBe(200);
    const peekBefore = ledgerKindCount('vg2', 'peek');

    // the target then accepts - with a genuinely valid signature and shares
    const shares = bobFixture.shares;
    const sig = signContent(bobIdentity.secretKey, 'h_vg2', 'peek_accept', {
      offerId: offer!.offerId,
      shares,
    });
    (room as unknown as { onPeekAnswer(u: number, m: unknown): void }).onPeekAnswer(bob.userId, {
      t: 'peek_accept',
      handId: 'h_vg2',
      offerId: offer!.offerId,
      shares,
      sig,
    });

    // refused: requester told `failed`, target gets an error, no money moved
    expect(hostSock.sent.some((m) => m.t === 'peek_result' && m.status === 'failed')).toBe(true);
    expect(bobSock.sent.some((m) => m.t === 'error' && /void/i.test(m.message))).toBe(true);
    expect(ledgerKindCount('vg2', 'peek')).toBe(peekBefore);
    expect(stackOf(ctx.db, 'vg2', host.userId)).toBe(1000);
    expect(stackOf(ctx.db, 'vg2', bob.userId)).toBe(1000);
  });

  it('rejects a brand-new peek offer after the hand was voided: no offer, no ledger row', async () => {
    const host = await register('vg3_host');
    const bob = await register('vg3_bob');
    makeRoom(ctx.db, 'vg3', host.userId);
    addPlayer(ctx.db, 'vg3', host.userId, 0, 1000);
    addPlayer(ctx.db, 'vg3', bob.userId, 1, 1000);
    seedHand(ctx.db, {
      handId: 'h_vg3',
      head: 'head_vg3',
      roomId: 'vg3',
      players: [
        { userId: host.userId, seat: 0 },
        { userId: bob.userId, seat: 1 },
      ],
      legs: [
        { userId: host.userId, delta: -5, kind: 'hand-settlement' },
        { userId: bob.userId, delta: 5, kind: 'hand-settlement' },
      ],
    });

    room = new GameRoom(ctx.db, 'vg3', genIdentity(), gameOpts());
    const hostSock = fakeSocket();
    room.join(host.userId, hostSock.ws);
    setSnapshot(
      room,
      'h_vg3',
      [
        { seat: 0, fixture: seatFixture(host.userId, genIdentity().publicKey, [], []) },
        { seat: 1, fixture: seatFixture(bob.userId, genIdentity().publicKey, [0, 4], [0, 1]) },
      ],
      [0],
      true,
    );

    const res = await voidHand('vg3', host.token, 'h_vg3');
    expect(res.statusCode).toBe(200);

    (room as unknown as { onPeekOffer(u: number, m: unknown): void }).onPeekOffer(host.userId, {
      t: 'peek_offer',
      handId: 'h_vg3',
      targetSeat: 1,
    });
    expect(hostSock.sent.some((m) => m.t === 'error' && /void/i.test(m.message))).toBe(true);
    // no offer was registered and nothing hit the ledger
    expect((room as unknown as { peekOffers: Map<string, unknown> }).peekOffers.size).toBe(0);
    expect(ledgerKindCount('vg3', 'peek')).toBe(0);
  });
});
