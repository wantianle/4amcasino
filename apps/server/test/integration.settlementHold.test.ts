import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { attachHub } from '../src/hub.js';
import {
  cardLookup,
  genIdentity,
  handKeyCommit,
  invScalar,
  maskAndShuffle,
  mulPoint,
  pointFromHex,
  pointHex,
  proveUnmask,
  randScalar,
  randomPerm,
  recoverCard,
  signContent,
} from '@4am/mental-poker';
import type { BettingState, CardId, PlayerAction, ServerMsg } from '@4am/shared';
import { awardPots, computePots, splitAmountEven, startBombPot } from '@4am/shared';
import { createSession, createUser } from '../src/auth.js';
import { setPlatformUserId } from '../src/platform.js';
import { activeHands } from '../src/liveHands.js';
import { applyHandSettlement, type GameClock } from '../src/game.js';
import { rechainRoom, verifyLedger } from '../src/ledger.js';
import {
  auditMarkerlessTranscripts,
  firstPendingHandLifecycle,
  reconcileMissingSettlements,
  recoverOrphanedFeatureTriggers,
} from '../src/db.js';
import Database from 'better-sqlite3';
import { TestClient, type Strategy } from './helpers/testClient.js';
import { setupRoom as createRoom } from './helpers/testRoom.js';
import { awaitDeal, awaitHandEnd } from './helpers/testRoom.js';
import {
  ManualClock,
  createFaultBag,
  bootIntegrationServer,
  type FaultBag,
  type IntegrationCtx,
  type IntegrationHub,
} from './helpers/integrationServer.js';

let ctx: IntegrationCtx;
let baseUrl: string;
let clients: TestClient[] = [];
let hub: IntegrationHub;
let clock: ManualClock;
let fault: FaultBag;

beforeEach(async () => {
  clock = new ManualClock();
  fault = createFaultBag();
  ({ ctx, baseUrl, hub } = await bootIntegrationServer(clock, fault));
  clients = [];
});

afterEach(async () => {
  for (const c of clients) c.close();
  await ctx.app.close();
});

// Thin adapter onto the shared `setupRoom`, binding this file's server URL and
// client collector so the migrated call sites stay byte-identical.
const setupRoom = (names: string[], strategies: Strategy[] = []) =>
  createRoom(baseUrl, names, strategies, clients);

describe('full hand integration: settlement hold, 7-2 bounty and recovery', () => {
  it('replays the showdown to a client that reconnects during the hold', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['passive', 'passive']);
    clock.freeze();
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.showdownAt !== null);
    const handId = host.handId!;
    // the reconnected client has no cached reveal: ask the server to replay it
    host.disconnect();
    host.sawShowdown = false;
    host.lastShowdown = null;
    await host.connect(room.id);
    await host.waitFor(() => host.sawShowdown && host.lastShowdown !== null, 5000);
    expect(host.lastShowdown!.handId).toBe(handId);
    expect(host.handEnd).toBeNull(); // still inside the hold
    // release the hold so the room tears down cleanly
    clock.advance(400);
    await host.waitFor(() => host.handEnd !== null, 5000);
    expect(host.handEnd!.handId).toBe(handId);
  }, 20000);

  it('pays the automatic 7-2 showdown bounty durably, before hand_end and across a hold shutdown', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['passive', 'passive']);
    ctx.db.prepare('UPDATE rooms SET seven_deuce_bonus = ? WHERE id = ?').run(25, room.id);
    // Deterministic deal: one seat applies a fixed permutation, the other the
    // identity, so the final deck is exactly `deck[Q]`. Seat 0 gets hole
    // indexes 0/2 -> cards 0 (2s) and 21 (7h): 7-2 offsuit. Board 4..8 is
    // 7s 7d 7c 9c Kc, so the 7-2 holder wins with quads.
    const identity = Array.from({ length: 52 }, (_, i) => i);
    const wanted = [0, 4, 21, 8, 20, 22, 23, 31, 47];
    const seen = new Set(wanted);
    const Q = [...wanted, ...identity.filter((i) => !seen.has(i))];
    host.forcedShufflePerm = identity;
    players[1]!.forcedShufflePerm = Q;

    clock.freeze();
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.showdownAt !== null);
    const handId = host.handId!;

    expect(host.myCards.slice().sort((a, b) => a - b)).toEqual([0, 21]);
    expect(host.board).toEqual([20, 22, 23, 31, 47]);
    expect(host.lastShowdown!.awards.find((a) => a.seat === 0)!.amount).toBeGreaterThan(0);

    // The bounty is part of the durable settlement: paid BEFORE hand_end and
    // while the reveal is still on screen.
    const bountyRows = () =>
      ctx.db
        .prepare("SELECT user_id, delta FROM ledger WHERE room_id = ? AND kind = 'seven-deuce'")
        .all(room.id) as { user_id: number; delta: number }[];
    const rows = bountyRows();
    expect(rows).toHaveLength(2);
    expect(rows.reduce((s, r) => s + r.delta, 0)).toBe(0);
    expect(rows.find((r) => r.delta === 25)).toBeTruthy();
    const hostRow = ctx.db
      .prepare('SELECT user_id FROM room_players WHERE room_id = ? AND seat = 0')
      .get(room.id) as { user_id: number };
    expect(rows.find((r) => r.delta === 25)!.user_id).toBe(hostRow.user_id);
    expect(host.handEnd).toBeNull();

    // A crash/shutdown inside the hold can no longer lose the bounty.
    void hub.rooms.get(room.id)?.shutdown();
    clock.advance(5000);
    expect(host.handEnd).toBeNull();
    expect(bountyRows()).toHaveLength(2);
    expect(
      (
        ctx.db
          .prepare('SELECT COUNT(*) AS n FROM hand_settlements WHERE hand_id = ?')
          .get(handId) as { n: number }
      ).n,
    ).toBe(1);
    const total = ctx.db
      .prepare('SELECT SUM(stack) AS total FROM room_players WHERE room_id = ?')
      .get(room.id) as { total: number };
    // 2000 chips in, 0 rake on this tiny pot, bounty is zero-sum: conserved.
    expect(total.total).toBe(2000);
  }, 20000);

  it('B1: the 7-2 bounty is reflected in every settlement output consistently', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['passive', 'passive']);
    ctx.db.prepare('UPDATE rooms SET seven_deuce_bonus = ? WHERE id = ?').run(25, room.id);
    const identity = Array.from({ length: 52 }, (_, i) => i);
    const wanted = [0, 4, 21, 8, 20, 22, 23, 31, 47];
    const seen = new Set(wanted);
    const Q = [...wanted, ...identity.filter((i) => !seen.has(i))];
    host.forcedShufflePerm = identity;
    players[1]!.forcedShufflePerm = Q;

    clock.freeze();
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.showdownAt !== null);
    const handId = host.handId!;
    expect(host.handEnd).toBeNull();
    clock.advance(400);
    await host.waitFor(() => host.handEnd !== null, 8000);

    const stackRows = ctx.db
      .prepare('SELECT user_id, stack, seat FROM room_players WHERE room_id = ?')
      .all(room.id) as { user_id: number; stack: number; seat: number }[];
    const byUser = new Map(stackRows.map((r) => [r.user_id, r.stack]));
    const seatByUser = new Map(stackRows.map((r) => [r.user_id, r.seat]));

    // room_players.stack === hand_end.stacks
    for (const s of host.handEnd!.stacks) {
      const uid = [...seatByUser.entries()].find(([, seat]) => seat === s.seat)![0];
      expect(s.stack).toBe(byUser.get(uid));
    }
    // room_players.stack === hand_settlements.final_stacks
    const finalStacks = JSON.parse(
      (
        ctx.db
          .prepare('SELECT final_stacks FROM hand_settlements WHERE hand_id = ?')
          .get(handId) as { final_stacks: string }
      ).final_stacks,
    ) as { userId: number; stack: number }[];
    for (const f of finalStacks) expect(f.stack).toBe(byUser.get(f.userId));
    // room_players.stack === projection.ending_stack, and
    // net_delta === ending_stack - starting_stack
    const proj = ctx.db
      .prepare(
        'SELECT user_id, starting_stack, ending_stack, net_delta FROM hand_players WHERE hand_id = ?',
      )
      .all(handId) as {
      user_id: number;
      starting_stack: number;
      ending_stack: number;
      net_delta: number;
    }[];
    expect(proj).toHaveLength(2);
    for (const p of proj) {
      expect(p.ending_stack).toBe(byUser.get(p.user_id));
      expect(p.ending_stack - p.starting_stack).toBe(p.net_delta);
    }
    // hand_end.deltas are zero-sum and carry the bounty transfer
    const end = host.handEnd!;
    expect(end.commission).toBe(0);
    expect(end.deltas.reduce((s, d) => s + d.delta, 0)).toBe(0);
    const deltaBySeat = new Map(end.deltas.map((d) => [d.seat, d.delta]));
    const pokerBySeat = new Map(end.pokerDeltas!.map((d) => [d.seat, d.delta]));
    expect(host.myCards.slice().sort((a, b) => a - b)).toEqual([0, 21]);
    expect(deltaBySeat.get(0)! - pokerBySeat.get(0)!).toBe(25);
    expect(deltaBySeat.get(1)! - pokerBySeat.get(1)!).toBe(-25);
  }, 20000);

  it('B2: a settled showdown bounty is never paid again by a later voluntary show', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['passive', 'passive']);
    ctx.db.prepare('UPDATE rooms SET seven_deuce_bonus = ? WHERE id = ?').run(25, room.id);
    const identity = Array.from({ length: 52 }, (_, i) => i);
    const wanted = [0, 4, 21, 8, 20, 22, 23, 31, 47];
    const seen = new Set(wanted);
    const Q = [...wanted, ...identity.filter((i) => !seen.has(i))];
    host.forcedShufflePerm = identity;
    players[1]!.forcedShufflePerm = Q;
    const bountyRows = () =>
      ctx.db
        .prepare("SELECT COUNT(*) AS n FROM ledger WHERE room_id = ? AND kind = 'seven-deuce'")
        .get(room.id) as { n: number };
    clock.freeze();
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.showdownAt !== null);
    clock.advance(400);
    await host.waitFor(() => host.handEnd !== null, 8000);
    expect(bountyRows().n).toBe(2);
    // the showdown winner voluntarily shows once more: no second bounty
    host.showCards();
    await new Promise((r) => setTimeout(r, 150));
    expect(bountyRows().n).toBe(2);
  }, 20000);

  it('B2: a fold-winner bounty retries after a rolled-back transfer and pays once', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['fold-first', 'passive']);
    ctx.db.prepare('UPDATE rooms SET seven_deuce_bonus = ? WHERE id = ?').run(25, room.id);
    // seat 1 (bob) is dealt 7-2 offsuit; host folds, so bob wins by fold
    const identity = Array.from({ length: 52 }, (_, i) => i);
    const wanted = [9, 0, 10, 21, 11, 12, 13, 14, 15];
    const seen = new Set(wanted);
    const Q = [...wanted, ...identity.filter((i) => !seen.has(i))];
    host.forcedShufflePerm = identity;
    players[1]!.forcedShufflePerm = Q;
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players);
    const bob = players[1]!;
    expect(bob.myCards.slice().sort((a, b) => a - b)).toEqual([0, 21]);
    const bountyRows = () =>
      ctx.db
        .prepare(
          "SELECT COUNT(*) AS n FROM ledger WHERE room_id = ? AND kind IN ('seven-deuce', 'seven-deuce-show')",
        )
        .get(room.id) as { n: number };
    expect(bountyRows().n).toBe(0);

    // the first voluntary show rolls the transfer back: it must stay unpaid
    fault.sevenDeuceFailOnce = true;
    bob.showCards();
    await new Promise((r) => setTimeout(r, 200));
    expect(bountyRows().n).toBe(0);

    // retry: the show succeeds and pays exactly once
    bob.showCards();
    await host.waitFor(() => bountyRows().n === 2, 3000);
  }, 20000);

  it('a fresh client reconnecting during the hold restores the board and private cards, not just the reveal', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['passive', 'passive']);
    clock.freeze();
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.showdownAt !== null);
    const handId = host.handId!;
    const board = host.board.slice();
    const cards = host.myCards.slice();
    expect(board).toHaveLength(5);
    expect(cards).toHaveLength(2);

    // Simulate a page refresh: no cached hand context at all.
    host.disconnect();
    host.board = [];
    host.board2 = [];
    host.board3 = [];
    host.myCards = [];
    host.myCardPoints = [];
    host.sawShowdown = false;
    host.lastShowdown = null;
    await host.connect(room.id);

    await host.waitFor(
      () => host.myCards.length === 2 && host.board.length === 5 && host.sawShowdown,
      5000,
    );
    expect(host.board).toEqual(board);
    expect(host.myCards.slice().sort((a, b) => a - b)).toEqual(
      cards.slice().sort((a, b) => a - b),
    );
    expect(host.lastShowdown!.handId).toBe(handId);

    // release the hold so the room tears down cleanly
    clock.advance(400);
    await host.waitFor(() => host.handEnd !== null, 5000);
    expect(host.handEnd!.handId).toBe(handId);
  }, 20000);

  it('B3: a spectator connecting during the hold receives the public replay', async () => {
    const { room, host } = await setupRoom(['host', 'bob'], ['passive', 'passive']);
    clock.freeze();
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.showdownAt !== null);
    const handId = host.handId!;
    // a brand-new observer joins while the settlement is committed and held
    const spec = new TestClient(baseUrl, 'watcher');
    clients.push(spec);
    await spec.register();
    await spec.api('/api/rooms/join', { joinCode: room.joinCode });
    await spec.connect(room.id);
    await spec.waitFor(() => spec.board.length === 5 && spec.sawShowdown, 5000);
    expect(spec.handId).toBeNull(); // no seat: no private hand_start
    expect(spec.myCards).toHaveLength(0);
    expect(spec.lastShowdown!.handId).toBe(handId);
    clock.advance(400);
    await host.waitFor(() => host.handEnd !== null, 5000);
  }, 20000);

  it('B4: exhausted settlement retries freeze the table and host retry settles once', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['passive', 'passive']);
    ctx.db.prepare('UPDATE rooms SET seven_deuce_bonus = ? WHERE id = ?').run(25, room.id);
    const identity = Array.from({ length: 52 }, (_, i) => i);
    const wanted = [0, 4, 21, 8, 20, 22, 23, 31, 47];
    const seen = new Set(wanted);
    const Q = [...wanted, ...identity.filter((i) => !seen.has(i))];
    host.forcedShufflePerm = identity;
    players[1]!.forcedShufflePerm = Q;
    fault.persistFailThrough = 1000; // every durable-write attempt fails
    clock.freeze();
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.settlementFailures.length === 1, 5000);
    const handId = host.handId!;
    for (let i = 0; i < 4; i++) {
      clock.advance(250);
      await host.waitFor(() => host.settlementFailures.length === i + 2, 3000);
    }
    expect(host.settlementFailures.at(-1)!.retrying).toBe(false);
    // frozen: nothing committed, and no new hand may be dealt over it
    expect(
      ctx.db.prepare('SELECT 1 FROM hand_settlements WHERE hand_id = ?').get(handId),
    ).toBeUndefined();
    host.errors = [];
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.errors.some((e) => /hand already running/i.test(e)), 3000);

    // host recovery: clear the fault and retry; pays exactly once
    fault.persistFailThrough = 0;
    host.send({ t: 'retry_settlement' });
    await host.waitFor(() => host.sawShowdown, 5000);
    clock.advance(400);
    await host.waitFor(() => host.handEnd !== null, 5000);
    expect(
      (
        ctx.db
          .prepare('SELECT COUNT(*) AS n FROM hand_settlements WHERE hand_id = ?')
          .get(handId) as { n: number }
      ).n,
    ).toBe(1);
    expect(
      (
        ctx.db
          .prepare("SELECT COUNT(*) AS n FROM ledger WHERE ref = ? AND kind = 'seven-deuce'")
          .get(handId) as { n: number }
      ).n,
    ).toBe(2);
  }, 25000);

  it('holds hand_end for exactly the reveal window and broadcasts it only once', async () => {
    const { host } = await setupRoom(['host', 'bob'], ['passive', 'passive']);
    clock.freeze();
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.showdownAt !== null);
    // one tick short of the 400ms reveal hold: still held
    clock.advance(399);
    expect(host.handEnd).toBeNull();
    // the exact due tick releases it
    clock.advance(1);
    await host.waitFor(() => host.handEnd !== null, 5000);
    expect(host.handEndCount).toBe(1);
    // later timers/advances must never emit a second terminal frame
    clock.advance(10000);
    expect(host.handEndCount).toBe(1);
  }, 20000);

  it('a fold-out under a frozen clock ends without any clock advance', async () => {
    const { host } = await setupRoom(['host', 'bob'], ['fold-first', 'passive']);
    clock.freeze();
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.handEnd !== null, 5000);
    expect(host.handEndCount).toBe(1);
    expect(host.sawShowdown).toBe(false);
  }, 20000);

  it('isolates a failed durable settlement, blocks the next hand, and retries to success', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['passive', 'passive']);
    fault.persistFailThrough = 1; // first attempt fails; the retry succeeds
    clock.freeze();
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.settlementFailures.length > 0, 8000);
    const handId = host.handId!;
    expect(host.settlementFailures[0]!.retrying).toBe(true);
    // NOT committed: no marker, no reveal, no terminal frame
    expect(
      ctx.db.prepare('SELECT 1 FROM hand_settlements WHERE hand_id = ?').get(handId),
    ).toBeUndefined();
    expect(host.sawShowdown).toBe(false);
    expect(host.handEnd).toBeNull();

    // the next hand is blocked rather than dealt over an unsettled one
    host.errors = [];
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.errors.some((e) => /hand already running/i.test(e)), 3000);

    // the clock-driven retry commits the same deterministic result
    clock.advance(300);
    await host.waitFor(() => host.sawShowdown, 5000);
    expect(
      ctx.db.prepare('SELECT 1 FROM hand_settlements WHERE hand_id = ?').get(handId),
    ).toBeTruthy();
    expect(host.settlementFailures).toHaveLength(1);
    const total = ctx.db
      .prepare('SELECT SUM(stack) AS total FROM room_players WHERE room_id = ?')
      .get(room.id) as { total: number };
    expect(total.total).toBe(2000);
    clock.advance(400);
    await host.waitFor(() => host.handEnd !== null, 5000);
    expect(host.handEndCount).toBe(1);
  }, 25000);

  it('a duplicate finalize broadcasts hand_end once, adopts the receipt, and tears down once', async () => {
    const { room, host } = await setupRoom(['dwa', 'dwb'], ['passive', 'passive']);
    ctx.db.prepare('UPDATE rooms SET auto_deal = 0 WHERE id = ?').run(room.id);
    clock.freeze(); // hold the terminal frame so we can drive the retry by hand
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.showdownAt !== null, 15000);
    const handId = host.handId!;
    const marker = ctx.db
      .prepare('SELECT hand_id, head FROM hand_settlements WHERE hand_id = ?')
      .get(handId) as { hand_id: string; head: string };
    expect(marker.hand_id).toBe(handId);
    expect(host.handEnd).toBeNull(); // durable, but still inside the reveal hold

    const gameRoom = hub.rooms.get(room.id)! as unknown as {
      hand: { settlementApplied: boolean; publishSettlement(): void } | null;
      terminalFrames: { msg: { handId: string } }[];
    };
    expect(gameRoom.hand).not.toBeNull();
    // Simulate a retry whose in-memory `applied` flag was lost (crash between
    // the durable commit and the in-memory bookkeeping): `applyHandSettlement`
    // sees the existing marker and returns a DUPLICATE, so the writer must load
    // and adopt the first submission's receipt and broadcast the historical
    // terminal exactly once.
    gameRoom.hand!.settlementApplied = false;
    gameRoom.hand!.publishSettlement();

    await host.waitFor(() => host.handEnd !== null, 5000);
    expect(host.handEndCount).toBe(1);
    // The terminal carries the receipt's identity, not the candidate's.
    expect(host.handEnd!.handId).toBe(marker.hand_id);
    expect(host.handEnd!.head).toBe(marker.head);

    // The still-pending reveal-hold timer must never emit a second frame.
    clock.advance(10000);
    await new Promise((r) => setTimeout(r, 50));
    expect(host.handEndCount).toBe(1);
    // Retained exactly once for a future reconnect; never re-pushed to the
    // socket that already received it.
    expect(gameRoom.terminalFrames.filter((f) => f.msg.handId === handId)).toHaveLength(1);
    // `onDone` ran to completion exactly once: the room released the hand.
    expect(gameRoom.hand).toBeNull();
    expect(activeHands.has(room.id)).toBe(false);
  }, 25000);

  it('a reconnect re-asserts a frozen settlement failure so recovery stays reachable', async () => {
    const { room, host } = await setupRoom(['host', 'bob'], ['passive', 'passive']);
    fault.persistFailThrough = 1000; // every durable-write attempt fails
    clock.freeze();
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.settlementFailures.length === 1, 5000);
    const handId = host.handId!;
    for (let i = 0; i < 4; i++) {
      clock.advance(250);
      await host.waitFor(() => host.settlementFailures.length === i + 2, 3000);
    }
    expect(host.settlementFailures.at(-1)!.retrying).toBe(false);

    // the host refreshes the page: a fresh client has no failure frame in
    // memory. The server must re-assert it on (re)connect or the recovery
    // button is unreachable.
    host.disconnect();
    host.settlementFailures = [];
    await host.connect(room.id);
    await host.waitFor(() => host.settlementFailures.length >= 1, 5000);
    const replay = host.settlementFailures.at(-1)!;
    expect(replay.handId).toBe(handId);
    expect(replay.retrying).toBe(false);

    // and the replayed state is enough to recover
    fault.persistFailThrough = 0;
    host.send({ t: 'retry_settlement' });
    await host.waitFor(() => host.sawShowdown, 5000);
    clock.advance(400);
    await host.waitFor(() => host.handEnd !== null, 5000);
  }, 25000);

  it('replays the terminal hand_end to a participant who missed it', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['passive', 'passive']);
    // no auto-deal, so the retained terminal frame is not superseded
    ctx.db.prepare('UPDATE rooms SET auto_deal = 0 WHERE id = ?').run(room.id);
    const bob = players[1]!;
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.showdownAt !== null, 15000);
    // bob drops during the reveal hold, before the terminal frame
    bob.disconnect();
    await host.waitFor(() => host.handEnd !== null, 15000);
    const handId = host.handEnd!.handId;
    bob.handEnd = null;
    bob.handEndCount = 0;
    // the durable write committed; on reconnect the retained frame is replayed
    await bob.connect(room.id);
    await bob.waitFor(() => bob.handEnd !== null, 5000);
    expect(bob.handEnd!.handId).toBe(handId);
    expect(bob.handEndCount).toBe(1);
    expect(bob.handAbort).toBeNull();
  }, 25000);

  it('replays the previous hand terminal to a participant not dealt into the next hand', async () => {
    const { players, room, host } = await setupRoom(
      ['host', 'bob', 'carol'],
      ['passive', 'passive', 'passive'],
    );
    // manual dealing, so the retained terminal frame is not superseded by an
    // auto-deal before we can start the next hand ourselves
    ctx.db.prepare('UPDATE rooms SET auto_deal = 0 WHERE id = ?').run(room.id);
    const bob = players[1]!;
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.showdownAt !== null, 15000);
    // bob drops during the reveal hold and misses hand 1's terminal frame
    bob.disconnect();
    await host.waitFor(() => host.handEnd !== null, 15000);
    const hand1 = host.handEnd!.handId;
    await host.waitIdle(room.id);

    // Hand 2 is dealt WITHOUT bob (he is disconnected, so not eligible). The
    // old single-slot cache was cleared here by startHand, which stranded bob's
    // still-held hand-1 state with no terminal frame to ever clear it.
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.handEndCount === 2, 15000);
    expect(host.handEnd!.handId).not.toBe(hand1);

    // bob reconnects still holding hand 1 and must receive its old terminal
    bob.handEnd = null;
    bob.handEndCount = 0;
    await bob.connect(room.id);
    await bob.waitFor(() => bob.handEnd !== null, 5000);
    expect(bob.handEnd!.handId).toBe(hand1);
    expect(bob.handAbort).toBeNull();
  }, 30000);

  it('recovers a committed hand for a reconnecting client after a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), '4am-recover-'));
    const dbPath = join(dir, 'game.db');
    const saved = { ctx, baseUrl, hub, clients };
    let restarted: ReturnType<typeof createApp> | null = null;
    try {
      const app = createApp(dbPath);
      const appHub = attachHub(app.app, app.db, {
        cryptoTimeoutMs: 1500,
        actionTimeoutMs: 1500,
        autoDealMs: 3_600_000,
        readyCheckMs: 1500,
        showdownHoldMs: 400,
        settleHoldMs: 0,
        clock,
      });
      await app.app.listen({ port: 0 });
      const addr = app.app.server.address() as AddressInfo;
      ctx = app;
      hub = appHub;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      const { players, room, host } = await setupRoom(['ra', 'rb'], ['passive', 'passive']);
      clock.freeze();
      host.send({ t: 'start_hand' });
      await host.waitFor(() => host.showdownAt !== null, 15000);
      const handId = host.handId!;
      // the durable write already committed at the reveal; no graceful hand_end
      expect(host.handEnd).toBeNull();
      for (const c of players) c.close();
      await app.app.close();

      // a fresh process on the same DB has none of the in-memory terminal frames
      restarted = createApp(dbPath);
      const restartHub = attachHub(restarted.app, restarted.db, {
        cryptoTimeoutMs: 1500,
        actionTimeoutMs: 1500,
        autoDealMs: 3_600_000,
        readyCheckMs: 1500,
        showdownHoldMs: 400,
        settleHoldMs: 0,
        clock,
      });
      await restarted.app.listen({ port: 0 });
      const addr2 = restarted.app.server.address() as AddressInfo;
      ctx = restarted;
      hub = restartHub;
      baseUrl = `http://127.0.0.1:${addr2.port}`;

      // the client reconnect reports the hand it still holds; the server must
      // reconstruct the committed terminal from the persisted transcript/marker
      host.baseUrl = baseUrl;
      host.handEnd = null;
      host.handEndCount = 0;
      await host.connect(room.id);
      await host.waitFor(() => host.handEnd !== null, 5000);
      expect(host.handEnd!.handId).toBe(handId);
      expect(host.handEnd!.stacks.length).toBe(2);
      expect(host.handEnd!.deltas.reduce((s, d) => s + d.delta, 0)).toBe(0);
      // a full reconstruction was possible, so no status-only fallback was used
      expect(host.handRecoveries.length).toBe(0);
    } finally {
      if (restarted) await restarted.app.close().catch(() => {});
      ctx = saved.ctx;
      baseUrl = saved.baseUrl;
      hub = saved.hub;
      clients = saved.clients;
    }
  }, 30000);

  it('falls back to a status-only committed recovery when durable stacks are incomplete', async () => {
    const dir = mkdtempSync(join(tmpdir(), '4am-recover-partial-'));
    const dbPath = join(dir, 'game.db');
    const saved = { ctx, baseUrl, hub, clients };
    let restarted: ReturnType<typeof createApp> | null = null;
    try {
      const app = createApp(dbPath);
      const appHub = attachHub(app.app, app.db, {
        cryptoTimeoutMs: 1500,
        actionTimeoutMs: 1500,
        autoDealMs: 3_600_000,
        readyCheckMs: 1500,
        showdownHoldMs: 400,
        settleHoldMs: 0,
        clock,
      });
      await app.app.listen({ port: 0 });
      const addr = app.app.server.address() as AddressInfo;
      ctx = app;
      hub = appHub;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      const { players, room, host } = await setupRoom(['ra', 'rb'], ['passive', 'passive']);
      clock.freeze();
      host.send({ t: 'start_hand' });
      await host.waitFor(() => host.showdownAt !== null, 15000);
      const handId = host.handId!;
      for (const c of players) c.close();
      await app.app.close();

      restarted = createApp(dbPath);
      // Corrupt the marker's final stacks into an incomplete participant map.
      // Recovery must NOT substitute a hand-start stack or 0 and claim a full
      // hand_end: the only truthful answer is the status-only `committed`.
      restarted.db
        .prepare('UPDATE hand_settlements SET final_stacks = ? WHERE hand_id = ?')
        .run('[]', handId);
      const restartHub = attachHub(restarted.app, restarted.db, {
        cryptoTimeoutMs: 1500,
        actionTimeoutMs: 1500,
        autoDealMs: 3_600_000,
        readyCheckMs: 1500,
        showdownHoldMs: 400,
        settleHoldMs: 0,
        clock,
      });
      await restarted.app.listen({ port: 0 });
      const addr2 = restarted.app.server.address() as AddressInfo;
      ctx = restarted;
      hub = restartHub;
      baseUrl = `http://127.0.0.1:${addr2.port}`;

      host.baseUrl = baseUrl;
      host.handEnd = null;
      host.handEndCount = 0;
      await host.connect(room.id);
      await host.waitFor(() => host.handRecoveries.length > 0, 5000);
      const recovery = host.handRecoveries.at(-1)!;
      expect(recovery.handId).toBe(handId);
      expect(recovery.status).toBe('committed');
      // no fabricated per-seat terminal was replayed
      expect(host.handEnd).toBeNull();
    } finally {
      if (restarted) await restarted.app.close().catch(() => {});
      ctx = saved.ctx;
      baseUrl = saved.baseUrl;
      hub = saved.hub;
      clients = saved.clients;
    }
  }, 30000);

  it('a lost settlement broadcast still lets the room finish without a refund', async () => {
    const { players, room, host } = await setupRoom(['host', 'bob'], ['passive', 'passive']);
    fault.broadcastThrowT = 'showdown';
    host.send({ t: 'start_hand' });
    // The reveal frame is lost, but the terminal frame still arrives...
    await awaitHandEnd(players, 15000);
    const handId = host.handId!;
    expect(host.handEnd!.handId).toBe(handId);
    // ...and the hand was committed, not refunded/aborted.
    expect(host.handAbort).toBeNull();
    expect(
      ctx.db.prepare('SELECT 1 FROM hand_settlements WHERE hand_id = ?').get(handId),
    ).toBeTruthy();
    const total = ctx.db
      .prepare('SELECT SUM(stack) AS total FROM room_players WHERE room_id = ?')
      .get(room.id) as { total: number };
    expect(total.total).toBe(2000);
  }, 25000);

  it('seals the transcript: a late audit key and a hold-time voluntary show never change the head', async () => {
    const { players, room, host } = await setupRoom(
      ['host', 'bob', 'carol'],
      ['passive', 'passive', 'fold-first'],
    );
    ctx.db.prepare('UPDATE rooms SET tv_replays = 1, auto_deal = 0 WHERE id = ?').run(room.id);
    const [h, , carol] = players as [TestClient, TestClient, TestClient];
    clock.freeze();
    h.respondKeys = false; // force the audit timeout to settle best-effort
    h.send({ t: 'start_hand' });
    await h.waitFor(() => h.sawShowdown, 8000);
    const handId = h.handId!;
    const persisted = ctx.db
      .prepare('SELECT head FROM transcripts WHERE hand_id = ?')
      .get(handId) as { head: string } | undefined;
    expect(persisted).toBeTruthy();
    const entryCount = h.transcriptHeads.length;
    const headBefore = h.transcriptHeads.at(-1);

    // A key that missed the audit deadline and a folded player's voluntary show
    // during the hold are live-only: neither may append to the sealed chain.
    h.sendRevealKey();
    carol.showCards();
    await new Promise((r) => setTimeout(r, 200));

    expect(h.transcriptHeads).toHaveLength(entryCount);
    expect(h.transcriptHeads.at(-1) ?? headBefore).toBe(headBefore);
    expect(
      (ctx.db.prepare('SELECT head FROM transcripts WHERE hand_id = ?').get(handId) as {
        head: string;
      }).head,
    ).toBe(persisted!.head);

    clock.advance(400);
    await h.waitFor(() => h.handEnd !== null, 5000);
    expect(h.handEndCount).toBe(1);
  }, 20000);
});
