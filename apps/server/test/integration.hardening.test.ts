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

describe('P2 hardening', () => {
  async function enable(host: TestClient, roomId: string, features: unknown): Promise<void> {
    const res = await host.api(`/api/rooms/${roomId}/settings`, { features }, 'PUT');
    expect(res.ok).toBe(true);
  }

  function sendChoice(c: TestClient, decisionId: string, count: 1 | 2 | 3): void {
    const body = { decisionId, count };
    c.send({
      t: 'run_count_choice',
      handId: c.handId,
      decisionId,
      count,
      sig: c.signed('run_count_choice', body),
    });
  }

  function sendAgree(c: TestClient, decisionId: string, agree: boolean): void {
    const body = { decisionId, agree };
    c.send({
      t: 'run_count_agree',
      handId: c.handId,
      decisionId,
      agree,
      sig: c.signed('run_count_agree', body),
    });
  }

  it('idempotency: applyHandSettlement applies once and keeps the ledger chain valid', async () => {
    const { players, room } = await setupRoom(['ida', 'idb']);
    const a = players[0]!.userId;
    const b = players[1]!.userId;
    const args = {
      handId: 'idem-hand-1',
      roomId: room.id,
      head: 'idem-head-1',
      entries: [],
      // Synthetic fixture with no sealed transcript: the duplicate path may
      // validate against the ledger/candidate alone (never set in production).
      transcriptlessReceipt: true,
      rake: 5,
      commissionBps: 50,
      stackDeltas: [
        { userId: a, delta: -105 },
        { userId: b, delta: 100 },
      ],
      pokerLedger: [
        { userId: a, delta: -105 },
        { userId: b, delta: 100 },
      ],
      squidLedger: [],
      squidNote: 'Squid Game penalty/payout',
      timeBanks: [],
      timeBankEpoch: null,
      triggerIds: [],
      bombRan: false,
      rakeRecipientId: a,
      now: Date.now(),
    };
    const stackOf = (uid: number) =>
      (
        ctx.db
          .prepare('SELECT stack FROM room_players WHERE room_id = ? AND user_id = ?')
          .get(room.id, uid) as { stack: number }
      ).stack;

    expect(applyHandSettlement(ctx.db, args).status).toBe('applied');
    const a1 = stackOf(a);
    const b1 = stackOf(b);
    const ledgerRows = () =>
      (ctx.db.prepare('SELECT COUNT(*) AS n FROM ledger WHERE room_id = ?').get(room.id) as {
        n: number;
      }).n;
    const before = ledgerRows();

    expect(applyHandSettlement(ctx.db, args).status).toBe('duplicate');
    expect(stackOf(a)).toBe(a1);
    expect(stackOf(b)).toBe(b1);
    expect(ledgerRows()).toBe(before); // duplicate appended nothing
    expect(
      (ctx.db.prepare('SELECT COUNT(*) AS n FROM hand_settlements WHERE hand_id = ?').get(
        args.handId,
      ) as { n: number }).n,
    ).toBe(1);
    expect(verifyLedger(ctx.db, room.id).ok).toBe(true);
  });

  it('idempotency: a duplicate settlement never re-pays the 7-2 bounty', async () => {
    const { players, room } = await setupRoom(['dupa', 'dupb']);
    const a = players[0]!.userId;
    const b = players[1]!.userId;
    const args = {
      handId: 'dup-bounty-1',
      roomId: room.id,
      head: 'dup-head-1',
      entries: [],
      // Synthetic fixture with no sealed transcript: the duplicate path may
      // validate against the ledger/candidate alone (never set in production).
      transcriptlessReceipt: true,
      rake: 0,
      commissionBps: 50,
      stackDeltas: [
        { userId: a, delta: -20 },
        { userId: b, delta: 20 },
      ],
      pokerLedger: [],
      squidLedger: [],
      squidNote: 'Squid Game penalty/payout',
      timeBanks: [],
      timeBankEpoch: null,
      triggerIds: [],
      bombRan: false,
      rakeRecipientId: null,
      sevenDeuce: {
        winnerUserId: b,
        winnerSeat: 1,
        winnerAmount: 20,
        payerAmounts: [{ userId: a, amount: 20 }],
      },
      now: Date.now(),
    };
    const bountyRows = () =>
      ctx.db
        .prepare("SELECT COUNT(*) AS n FROM ledger WHERE room_id = ? AND kind = 'seven-deuce'")
        .get(room.id) as { n: number };
    expect(applyHandSettlement(ctx.db, args).status).toBe('applied');
    expect(bountyRows().n).toBe(2);
    expect(applyHandSettlement(ctx.db, args).status).toBe('duplicate');
    expect(bountyRows().n).toBe(2); // the bounty is never paid twice
  });

  it('recovery: releases a claimed trigger only when its settlement marker is absent', async () => {
    const { room } = await setupRoom(['rca', 'rcb']);
    const now = Date.now();
    ctx.db
      .prepare(
        `INSERT INTO room_feature_triggers
           (room_id, request_id, kind, source, status, requested_by, created_at, claimed_hand_id)
         VALUES (?, ?, 'squid', 'manual', 'claimed', NULL, ?, ?)`,
      )
      .run(room.id, 'rec-1', now, 'orphan-hand');
    expect(recoverOrphanedFeatureTriggers(ctx.db)).toBe(1);
    let row = ctx.db
      .prepare("SELECT id, status FROM room_feature_triggers WHERE room_id = ? AND kind = 'squid'")
      .get(room.id) as { id: number; status: string };
    expect(row.status).toBe('pending');

    // resolve the first so it does not block the partial pending unique index
    ctx.db.prepare("UPDATE room_feature_triggers SET status = 'applied' WHERE id = ?").run(row.id);
    ctx.db
      .prepare(
        `INSERT INTO room_feature_triggers
           (room_id, request_id, kind, source, status, requested_by, created_at, claimed_hand_id)
         VALUES (?, ?, 'squid', 'manual', 'claimed', NULL, ?, ?)`,
      )
      .run(room.id, 'rec-2', now, 'settled-hand');
    ctx.db
      .prepare(
        'INSERT INTO hand_settlements (hand_id, room_id, head, rake, applied_at) VALUES (?, ?, ?, 0, ?)',
      )
      .run('settled-hand', room.id, 'h', now);
    expect(recoverOrphanedFeatureTriggers(ctx.db)).toBe(0);
    row = ctx.db
      .prepare(
        "SELECT status FROM room_feature_triggers WHERE room_id = ? AND kind = 'squid' AND request_id = 'rec-2'",
      )
      .get(room.id) as { id: number; status: string };
    expect(row.status).toBe('claimed');

    // an aborted hand leaves no marker, so the next startup releases it
    ctx.db
      .prepare(
        "UPDATE room_feature_triggers SET status = 'claimed', resolved_at = NULL WHERE request_id = 'rec-2'",
      )
      .run();
    ctx.db.prepare("UPDATE hand_settlements SET hand_id = 'other' WHERE hand_id = 'settled-hand'").run();
    expect(recoverOrphanedFeatureTriggers(ctx.db)).toBe(1);
  });

  it('actions: rejected and duplicate actions never become transcript action entries', async () => {
    const { players, room, host } = await setupRoom(['ata', 'atb'], ['passive', 'passive']);
    const bob = players[1]!;
    host.ignoreActions = true; // drive the host manually
    bob.ignoreActions = true; // keep bob's turn open so the duplicate lands mid-round
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.lastState?.toAct === host.seat, 10000);

    const check = { type: 'check' as const };
    // bob acts out of turn
    bob.send({
      t: 'action',
      handId: bob.handId,
      action: check,
      sig: bob.signed('action', { action: check }),
    });
    await bob.waitFor(() => bob.errors.length > 0, 5000);

    const call = { type: 'call' as const };
    host.send({
      t: 'action',
      handId: host.handId,
      action: call,
      sig: host.signed('action', { action: call }),
    });
    await host.waitFor(() => host.lastState?.toAct === bob.seat, 5000);
    // host's stale duplicate is rejected
    host.send({
      t: 'action',
      handId: host.handId,
      action: call,
      sig: host.signed('action', { action: call }),
    });
    host.ignoreActions = false;
    await awaitHandEnd(players, 15000);

    const hand = await host.api(`/api/rooms/${room.id}/hands/${host.handEnd!.handId}`);
    const actions = (hand.entries as { type: string; payload: { seat: number } }[]).filter(
      (e) => e.type === 'action',
    );
    const rejected = (hand.entries as { type: string; payload: { seat: number } }[]).filter(
      (e) => e.type === 'action_rejected',
    );
    // every applied action has exactly one transcript entry; a rejected one has none
    for (const p of players) {
      const applied = p.actionApplied.filter((a) => a.seat === p.seat && !a.auto).length;
      expect(actions.filter((e) => e.payload.seat === p.seat)).toHaveLength(applied);
    }
    expect(rejected.some((e) => e.payload.seat === bob.seat)).toBe(true);
    expect(rejected.some((e) => e.payload.seat === host.seat)).toBe(true);
  }, 25000);

  it('deadline: an action before the deadline is honored, the timeout fold is the only later transition', async () => {
    const { players, room, host } = await setupRoom(['dla', 'dlb'], ['passive', 'passive']);
    const bob = players[1]!;
    bob.ignoreActions = true;
    host.thinkMs = 400; // acts ~1.1s before the 1.5s deadline
    host.send({ t: 'start_hand' });
    await bob.waitFor(() => bob.lastState?.toAct === bob.seat, 10000);
    await host.waitFor(() => host.handEnd !== null || host.handAbort !== null, 10000);
    expect(host.handAbort).toBeNull();

    const hand = await host.api(`/api/rooms/${room.id}/hands/${host.handEnd!.handId}`);
    const entries = hand.entries as { type: string; payload: { seat: number } }[];
    expect(entries.some((e) => e.type === 'action' && e.payload.seat === host.seat)).toBe(true);
    expect(entries.some((e) => e.type === 'action' && e.payload.seat === bob.seat)).toBe(false);
    expect(entries.some((e) => e.type === 'timeout_fold' && e.payload.seat === bob.seat)).toBe(true);
  }, 25000);

  it('deadline: an action sent at the final deadline is not honored', async () => {
    const { players, room, host } = await setupRoom(['dea', 'deb'], ['passive', 'passive']);
    const bob = players[1]!;
    host.ignoreActions = true;
    bob.ignoreActions = true;
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.lastState?.toAct === host.seat && host.lastDeadline !== null, 10000);
    const delay = Math.max(0, host.lastDeadline! - Date.now() + 25);
    setTimeout(() => {
      const call = { type: 'call' as const };
      host.send({
        t: 'action',
        handId: host.handId,
        action: call,
        sig: host.signed('action', { action: call }),
      });
    }, delay);
    await host.waitFor(() => host.handEnd !== null || host.handAbort !== null, 10000);
    expect(host.handAbort).toBeNull();
    const hand = await host.api(`/api/rooms/${room.id}/hands/${host.handEnd!.handId}`);
    const entries = hand.entries as { type: string; payload: { seat: number } }[];
    expect(entries.some((e) => e.type === 'action' && e.payload.seat === host.seat)).toBe(false);
    expect(entries.some((e) => e.type === 'timeout_fold' && e.payload.seat === host.seat)).toBe(true);
  }, 25000);

  it('squid: multiple losers pay each other and netBySeat is authoritative', async () => {
    const { players, room, host } = await setupRoom(
      ['sma', 'smb', 'smc'],
      ['fold-first', 'fold-first', 'passive'],
    );
    await enable(host, room.id, { squid: { enabled: true, penaltyBb: 1, minPlayers: 2 } });
    await host.api(`/api/rooms/${room.id}/feature-triggers`, {
      feature: 'squid',
      requestId: 'sq-multi',
    });
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players, 15000);
    const sq = players[2]!.squidResult!;
    expect(sq.winners).toHaveLength(1);
    const winnerSeat = sq.winners[0]!;
    const losers = players.map((p) => p.seat!).filter((s) => s !== winnerSeat);
    expect(sq.requestedPerLoser).toBe(40); // 1 * bb(20) * (3 - 1)
    expect(sq.transfers).toHaveLength(4); // each of 2 losers pays 2 recipients
    const net = new Map(sq.netBySeat!.map((n) => [n.seat, n.net]));
    // each loser pays 40 split over the two other seats, so the winner nets 40
    expect(net.get(winnerSeat)).toBe(40);
    for (const l of losers) expect(net.get(l)).toBe(-20); // pays 40, receives 20 from the other loser
    expect([...net.values()].reduce((s, v) => s + v, 0)).toBe(0);
    // losers receive from other losers, not only from the winner
    expect(sq.transfers.some((t) => losers.includes(t.to))).toBe(true);
    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    expect(ledger.verified.ok).toBe(true);
  }, 25000);

  it('time bank: an aborted hand discards in-memory debits', async () => {
    const { players, room, host } = await setupRoom(['tba2', 'tbb2']);
    await enable(host, room.id, {
      timeBank: { enabled: true, initialSeconds: 5, refillEveryHands: 30, refillSeconds: 30 },
    });
    const read = () =>
      (
        ctx.db
          .prepare('SELECT time_bank_ms FROM room_players WHERE room_id = ? AND user_id = ?')
          .get(room.id, host.userId) as { time_bank_ms: number }
      ).time_bank_ms;
    expect(read()).toBe(5000);
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.handId !== null, 5000);
    players[1]!.disconnect();
    await host.waitFor(() => host.handAbort !== null, 15000);
    // hand-atomic: the abort wrote nothing back, so the bank is untouched
    expect(read()).toBe(5000);
  }, 25000);

  it('time bank: a mid-hand epoch change is skipped and audited', async () => {
    const { players, room, host } = await setupRoom(['tce', 'tcf'], ['passive', 'passive']);
    await enable(host, room.id, {
      timeBank: { enabled: true, initialSeconds: 5, refillEveryHands: 30, refillSeconds: 30 },
    });
    for (const p of players) p.thinkMs = 300; // slow the hand so the mid-hand change lands
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.bettingStreets.includes('preflop'), 8000);
    // simulate a config change that resets the bank and bumps the epoch mid-hand
    ctx.db.prepare('UPDATE rooms SET time_bank_epoch = time_bank_epoch + 1 WHERE id = ?').run(room.id);
    const epoch = (
      ctx.db.prepare('SELECT time_bank_epoch AS e FROM rooms WHERE id = ?').get(room.id) as {
        e: number;
      }
    ).e;
    ctx.db
      .prepare(
        'UPDATE room_players SET time_bank_ms = 7000, time_bank_hands = 0, time_bank_epoch = ? WHERE room_id = ?',
      )
      .run(epoch, room.id);
    await awaitHandEnd(players, 20000);

    const row = ctx.db
      .prepare('SELECT time_bank_ms FROM room_players WHERE room_id = ? AND user_id = ?')
      .get(room.id, host.userId) as { time_bank_ms: number };
    expect(row.time_bank_ms).toBe(7000); // stale snapshot not written over the reset
    const hand = await host.api(`/api/rooms/${room.id}/hands/${host.handEnd!.handId}`);
    expect(
      (hand.entries as { type: string }[]).some((e) => e.type === 'time_bank_epoch_mismatch'),
    ).toBe(true);
  }, 30000);

  it('S0: a retry after a mid-hand epoch change records the mismatch audit exactly once', async () => {
    const { players, room, host } = await setupRoom(['tre', 'trf'], ['passive', 'passive']);
    await enable(host, room.id, {
      timeBank: { enabled: true, initialSeconds: 5, refillEveryHands: 30, refillSeconds: 30 },
    });
    for (const p of players) p.thinkMs = 300; // slow the hand so the mid-hand change lands
    fault.persistFailThrough = 1; // first durable attempt fails; the retry must reuse the seal
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.bettingStreets.includes('preflop'), 8000);
    // simulate a config change that resets the bank and bumps the epoch mid-hand
    ctx.db.prepare('UPDATE rooms SET time_bank_epoch = time_bank_epoch + 1 WHERE id = ?').run(room.id);
    const epoch = (
      ctx.db.prepare('SELECT time_bank_epoch AS e FROM rooms WHERE id = ?').get(room.id) as {
        e: number;
      }
    ).e;
    ctx.db
      .prepare(
        'UPDATE room_players SET time_bank_ms = 7000, time_bank_hands = 0, time_bank_epoch = ? WHERE room_id = ?',
      )
      .run(epoch, room.id);
    await host.waitFor(() => host.settlementFailures.length === 1, 10000);
    // the clock-driven retry must commit using the SAME sealed transcript
    await host.waitFor(() => host.handEnd !== null, 20000);

    // the stale snapshot is still not written over the reset
    const bank = ctx.db
      .prepare('SELECT time_bank_ms FROM room_players WHERE room_id = ? AND user_id = ?')
      .get(room.id, host.userId) as { time_bank_ms: number };
    expect(bank.time_bank_ms).toBe(7000);

    const hand = await host.api(`/api/rooms/${room.id}/hands/${host.handEnd!.handId}`);
    const mismatches = (hand.entries as { type: string }[]).filter(
      (e) => e.type === 'time_bank_epoch_mismatch',
    );
    // One sealed diagnostic; the retry must not append a second.
    expect(mismatches).toHaveLength(1);
    // The terminal head is the sealed head, and the marker agrees.
    const marker = ctx.db
      .prepare('SELECT head FROM hand_settlements WHERE hand_id = ?')
      .get(host.handEnd!.handId) as { head: string };
    expect(marker.head).toBe(host.handEnd!.head);
  }, 30000);

  it('multi-run: stale and duplicate decision ids are ignored', async () => {
    const { players, room, host } = await setupRoom(['mda', 'mdb'], ['shove-flop', 'passive']);
    await enable(host, room.id, { multiRun: { enabled: true } });
    for (const p of players) {
      p.runCountAnswer = null;
      p.runAgreeAnswer = null;
    }
    host.send({ t: 'start_hand' });
    await players[0]!.waitFor(
      () => players[0]!.multiRunOffers.some((o) => o.stage === 'choice'),
      15000,
    );
    const offer = players[0]!.multiRunOffers.find((o) => o.stage === 'choice')!;
    const behind = players.find((p) => p.seat === offer.behindSeat)!;
    const ahead = players.find((p) => p.seat === offer.aheadSeat)!;

    sendChoice(behind, 'bogus-decision', 2);
    await new Promise((r) => setTimeout(r, 150));
    expect(behind.multiRunOffers.some((o) => o.stage === 'agreement')).toBe(false);

    sendChoice(behind, offer.decisionId, 2);
    await ahead.waitFor(() => ahead.multiRunOffers.some((o) => o.stage === 'agreement'), 8000);
    // duplicate choice from the now-wrong stage is ignored
    sendChoice(behind, offer.decisionId, 3);
    await new Promise((r) => setTimeout(r, 150));

    sendAgree(ahead, 'bogus-decision', true);
    await new Promise((r) => setTimeout(r, 150));
    expect(players[0]!.multiRunResult).toBeNull();

    sendAgree(ahead, offer.decisionId, true);
    await awaitHandEnd(players, 15000);
    expect(players[0]!.handAbort).toBeNull();
    expect(players[0]!.multiRunResult).toMatchObject({ runs: 2, reason: 'agreed' });

    const hand = await host.api(`/api/rooms/${room.id}/hands/${players[0]!.handEnd!.handId}`);
    const entries = hand.entries as { type: string }[];
    expect(entries.filter((e) => e.type === 'run_count_choice')).toHaveLength(1);
    expect(entries.filter((e) => e.type === 'run_count_agree')).toHaveLength(1);
  }, 30000);

  it('multi-run: a reconnect during a stage resends the current offer', async () => {
    const { players, room, host } = await setupRoom(['rca2', 'rcb2'], ['shove-flop', 'passive']);
    await enable(host, room.id, { multiRun: { enabled: true } });
    for (const p of players) {
      p.runCountAnswer = 2;
      p.runAgreeAnswer = null;
    }
    host.send({ t: 'start_hand' });
    await players[0]!.waitFor(
      () => players[0]!.multiRunOffers.some((o) => o.stage === 'agreement'),
      15000,
    );
    const offer = players[0]!.multiRunOffers.find((o) => o.stage === 'agreement')!;
    const ahead = players.find((p) => p.seat === offer.aheadSeat)!;
    const seen = ahead.multiRunOffers.filter((o) => o.stage === 'agreement').length;

    ahead.disconnect();
    await ahead.connect(room.id);
    await ahead.waitFor(
      () => ahead.multiRunOffers.filter((o) => o.stage === 'agreement').length > seen,
      8000,
    );
    await awaitHandEnd(players, 15000);
    expect(players[0]!.handAbort).toBeNull();
  }, 30000);

  it('multi-run: a reconnect during the equity window still completes', async () => {
    const { players, room, host } = await setupRoom(['rea', 'reb'], ['allin-first', 'passive']);
    await enable(host, room.id, { multiRun: { enabled: true } });
    for (const p of players) {
      p.runCountAnswer = 1;
      p.runAgreeAnswer = true;
    }
    host.send({ t: 'start_hand' });
    await players[0]!.waitFor(() => players[0]!.handId !== null, 5000);
    const bob = players[1]!;
    bob.disconnect();
    await bob.connect(room.id);
    await awaitHandEnd(players, 15000);
    expect(players[0]!.handAbort).toBeNull();
    expect(players[0]!.multiRunResult).not.toBeNull();
  }, 25000);

  it('bomb pot: ante caps and pot conservation hold for 2-9 seats', () => {
    for (let n = 2; n <= 9; n++) {
      const stacks = Array.from({ length: n }, (_, i) => (i === 1 ? 5 : i === 2 ? 20 : 100));
      const st = startBombPot(
        stacks.map((stack, i) => ({ seat: i, stack })),
        0,
        20,
        20,
      );
      const total = st.seats.reduce((s, x) => s + x.total, 0);
      expect(total).toBe(stacks.reduce((s, x) => s + Math.min(x, 20), 0));
      for (const [i, x] of st.seats.entries()) {
        expect(x.committed).toBe(0);
        expect(x.total).toBe(Math.min(stacks[i]!, 20));
        if (stacks[i]! <= 20) expect(x.allIn).toBe(true);
      }
      const pots = computePots(st.seats);
      expect(pots.reduce((s, p) => s + p.amount, 0)).toBe(total);
      const scores = new Map(st.seats.map((x) => [x.seat, x.seat === 0 ? 100 : 1]));
      const awards = awardPots(
        pots,
        scores,
        st.seats.map((x) => x.seat),
      );
      expect([...awards.values()].reduce((s, a) => s + a, 0)).toBe(total);
    }
    // odd-chip remainder runs front-loaded
    expect(splitAmountEven(101, 3)).toEqual([34, 34, 33]);
  });

  it('multi-run: a side pot with two live players stays conserved', async () => {
    const { players, room, host } = await setupRoom(
      ['spf', 'spa', 'spb'],
      ['fold-first', 'shove-flop', 'shove-flop'],
    );
    await enable(host, room.id, { multiRun: { enabled: true } });
    // unequal stacks so a side pot forms between the two all-in players
    ctx.db
      .prepare('UPDATE room_players SET stack = ? WHERE room_id = ? AND user_id = ?')
      .run(400, room.id, players[1]!.userId);
    ctx.db
      .prepare('UPDATE room_players SET stack = ? WHERE room_id = ? AND user_id = ?')
      .run(700, room.id, players[2]!.userId);
    for (const p of players) {
      p.runCountAnswer = 2;
      p.runAgreeAnswer = true;
    }
    const before = (
      ctx.db.prepare('SELECT SUM(stack) AS s FROM room_players WHERE room_id = ?').get(room.id) as {
        s: number;
      }
    ).s;
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players, 20000);
    expect(players[0]!.handAbort).toBeNull();
    expect(players[0]!.multiRunResult).toMatchObject({ runs: 2 });
    const end = players[0]!.handEnd!;
    // B1: the table total is the authoritative `room_players.stack`; with no
    // platform user the rake returns to the in-room banker, so it is conserved.
    expect(end.stacks.reduce((s, x) => s + x.stack, 0)).toBe(before);
    expect(end.deltas.reduce((s, d) => s + d.delta, 0)).toBe(-(end.commission ?? 0));
    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    expect(ledger.verified.ok).toBe(true);
  }, 30000);

  it('bomb pot: unequal stacks, an ante-only short stack and a post-flop fold conserve chips', async () => {
    const { players, room, host } = await setupRoom(
      ['b4a', 'b4b', 'b4c', 'b4d'],
      ['passive', 'passive', 'fold-first', 'passive'],
    );
    await enable(host, room.id, {
      bombPot: { enabled: true, anteBb: 1, schedule: { mode: 'hands', value: 1 } },
    });
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players, 15000);
    const firstId = players[0]!.handEnd!.handId;
    await players[0]!.waitIdle(room.id);
    // one ante-only stack (15 < 20) and one unequal stack
    ctx.db
      .prepare('UPDATE room_players SET stack = ? WHERE room_id = ? AND user_id = ?')
      .run(15, room.id, players[1]!.userId);
    ctx.db
      .prepare('UPDATE room_players SET stack = ? WHERE room_id = ? AND user_id = ?')
      .run(300, room.id, players[2]!.userId);
    const before = (
      ctx.db.prepare('SELECT SUM(stack) AS s FROM room_players WHERE room_id = ?').get(room.id) as {
        s: number;
      }
    ).s;

    host.send({ t: 'start_hand' });
    await Promise.all(
      players.map((p) =>
        p.waitFor(() => p.handEnd !== null && p.handEnd.handId !== firstId, 20000),
      ),
    );
    expect(players[0]!.handAbort).toBeNull();
    expect(players[0]!.board).toHaveLength(5);
    expect(players[0]!.bettingStreets).not.toContain('preflop');
    const end = players[0]!.handEnd!;
    expect(end.stacks.reduce((s, x) => s + x.stack, 0)).toBe(before - (end.commission ?? 0));
    for (const s of end.stacks) expect(s.stack).toBeGreaterThanOrEqual(0);
    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    expect(ledger.verified.ok).toBe(true);
  }, 40000);
});
