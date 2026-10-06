import { describe, expect, it } from 'vitest';
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
import { TestClient, type Strategy } from './helpers/testClient.js';
import { setupRoom as createRoom } from './helpers/testRoom.js';
import { awaitHandEnd } from './helpers/testRoom.js';
import { useIntegrationServer } from './helpers/integrationServer.js';

const srv = useIntegrationServer();

// Thin adapter onto the shared `setupRoom`, binding this file's server URL and
// client collector so the migrated call sites stay byte-identical.
const setupRoom = (names: string[], strategies: Strategy[] = []) =>
  createRoom(srv.baseUrl, names, strategies, srv.clients);

describe('P2 gameplay integration', () => {
  async function enable(host: TestClient, roomId: string, features: unknown): Promise<void> {
    const res = await host.api(`/api/rooms/${roomId}/settings`, { features }, 'PUT');
    expect(res.ok).toBe(true);
  }

  it('multi-run: choosing 3 runs with agreement deals three boards', async () => {
    const { players, room, host } = await setupRoom(['m3a', 'm3b'], ['shove-flop', 'passive']);
    await enable(host, room.id, { multiRun: { enabled: true } });
    for (const p of players) {
      p.runCountAnswer = 3;
      p.runAgreeAnswer = true;
    }
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players, 20000);
    expect(players[0]!.handAbort).toBeNull();
    expect(players[0]!.multiRunResult).toMatchObject({ runs: 3, reason: 'agreed' });
    expect(players[0]!.board).toHaveLength(5);
    expect(players[0]!.board2).toHaveLength(2);
    expect(players[0]!.board3).toHaveLength(2);
    const boards = players[0]!.lastShowdown!.multiRun!.boards;
    expect(boards).toHaveLength(3);
    for (const b of boards) expect(b).toHaveLength(5);
    expect(boards[1]!.slice(0, 3)).toEqual(boards[0]!.slice(0, 3)); // shared flop
    expect(boards[2]!.slice(0, 3)).toEqual(boards[0]!.slice(0, 3));
    const all = [...boards.flat(), ...players.flatMap((p) => p.myCards)];
    // 5 shared run-1 + 2 + 2 run-specific + 4 hole cards, all distinct
    expect(new Set(all).size).toBe(13);
    expect(players[0]!.handEnd!.deltas.reduce((s, d) => s + d.delta, 0)).toBe(-10);
    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    expect(ledger.verified.ok).toBe(true);
  }, 25000);

  it('multi-run: ignoring the choice stage times out to a single run', async () => {
    const { players, room, host } = await setupRoom(['mta', 'mtb'], ['shove-flop', 'passive']);
    await enable(host, room.id, { multiRun: { enabled: true } });
    for (const p of players) p.runCountAnswer = null;
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players, 20000);
    expect(players[0]!.handAbort).toBeNull();
    expect(players[0]!.multiRunResult).toMatchObject({ runs: 1, reason: 'timeout' });
    expect(players[0]!.board).toHaveLength(5);
    expect(players[0]!.board2).toHaveLength(0);
  }, 25000);

  it('multi-run: an unanswered agreement stage also falls back to one run', async () => {
    const { players, room, host } = await setupRoom(['mua', 'mub'], ['shove-flop', 'passive']);
    await enable(host, room.id, { multiRun: { enabled: true } });
    for (const p of players) {
      p.runCountAnswer = 2; // the player behind asks for two runs...
      p.runAgreeAnswer = null; // ...but the player ahead never answers
    }
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players, 20000);
    expect(players[0]!.handAbort).toBeNull();
    expect(players[0]!.multiRunResult).toMatchObject({ runs: 1, reason: 'timeout' });
    expect(players[0]!.board2).toHaveLength(0);
  }, 25000);

  it('multi-run: more than two players all-in is forced to a single run', async () => {
    const { players, room, host } = await setupRoom(
      ['mwa', 'mwb', 'mwc'],
      ['shove-flop', 'shove-flop', 'shove-flop'],
    );
    await enable(host, room.id, { multiRun: { enabled: true } });
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players, 20000);
    expect(players[0]!.handAbort).toBeNull();
    expect(players.every((p) => !p.sawMultiRunOffer)).toBe(true);
    expect(players[0]!.multiRunResult).toMatchObject({ runs: 1, reason: 'ineligible' });
    expect(players[0]!.board).toHaveLength(5);
    expect(players[0]!.board2).toHaveLength(0);
  }, 25000);

  it('bomb pot: a scheduled bomb antes everyone and opens the flop directly', async () => {
    const { players, room, host } = await setupRoom(['bomba', 'bombb']);
    await enable(host, room.id, {
      bombPot: { enabled: true, anteBb: 1, schedule: { mode: 'hands', value: 1 } },
    });
    // hand 1 is a normal deal: no bomb is due until one hand has completed
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players, 15000);
    expect(players[0]!.featureStarted.some((f) => f.bombPot)).toBe(false);
    const firstId = players[0]!.handEnd!.handId;
    await players[0]!.waitIdle(room.id);

    host.send({ t: 'start_hand' });
    await Promise.all(
      players.map((p) =>
        p.waitFor(() => p.handEnd !== null && p.handEnd.handId !== firstId, 15000),
      ),
    );
    expect(players[0]!.handAbort).toBeNull();
    expect(players[0]!.featureStarted.some((f) => f.bombPot)).toBe(true);
    expect(players[0]!.board).toHaveLength(5);
    // the transcript records the bomb and starts betting on the flop
    const hand = await host.api(`/api/rooms/${room.id}/hands/${players[0]!.handEnd!.handId}`);
    expect(hand.entries.some((e: { type: string }) => e.type === 'bomb_pot_start')).toBe(true);
    // a bomb pot has no preflop betting round: no betting_start entry at all
    expect(hand.entries.some((e: { type: string }) => e.type === 'betting_start')).toBe(false);
    const streets = hand.entries.filter((e: { type: string }) => e.type === 'street');
    expect(streets[0].payload.street).toBe('flop');
    // and no client ever saw a legal preflop action
    expect(players[0]!.bettingStreets).not.toContain('preflop');
    expect(players[0]!.bettingStreets).toContain('flop');
    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    expect(ledger.verified.ok).toBe(true);
  }, 30000);

  it('bomb pot: a duration schedule fires once its clock has elapsed', async () => {
    const { players, room, host } = await setupRoom(['bda', 'bdb']);
    await enable(host, room.id, {
      bombPot: { enabled: true, anteBb: 2, schedule: { mode: 'duration', value: 60 } },
    });
    // hand 1 seeds the schedule clock and is a normal deal
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players, 15000);
    expect(players[0]!.featureStarted.some((f) => f.bombPot)).toBe(false);
    const firstId = players[0]!.handEnd!.handId;
    await players[0]!.waitIdle(room.id);
    // age the anchor past the 60s interval
    srv.ctx.db
      .prepare('UPDATE room_gameplay_state SET schedule_reset_at = ? WHERE room_id = ?')
      .run(Date.now() - 61_000, room.id);

    host.send({ t: 'start_hand' });
    await Promise.all(
      players.map((p) =>
        p.waitFor(() => p.handEnd !== null && p.handEnd.handId !== firstId, 15000),
      ),
    );
    expect(players[0]!.handAbort).toBeNull();
    expect(players[0]!.featureStarted.some((f) => f.bombPot)).toBe(true);
    expect(players[0]!.board).toHaveLength(5);
  }, 30000);

  it('bomb pot: a short stack antes what it has and goes all-in', async () => {
    const { players, room, host } = await setupRoom(['shorta', 'shortb']);
    await enable(host, room.id, {
      bombPot: { enabled: true, anteBb: 1, schedule: { mode: 'hands', value: 1 } },
    });
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players, 15000);
    // stand bob down to a stack smaller than the ante before the bomb hand
    srv.ctx.db
      .prepare('UPDATE room_players SET stack = 5 WHERE room_id = ? AND user_id = ?')
      .run(room.id, players[1]!.userId);
    const before = (
      srv.ctx.db.prepare('SELECT SUM(stack) AS s FROM room_players WHERE room_id = ?').get(room.id) as {
        s: number;
      }
    ).s;

    const firstId = players[0]!.handEnd!.handId;
    await players[0]!.waitIdle(room.id);
    host.send({ t: 'start_hand' });
    await Promise.all(
      players.map((p) =>
        p.waitFor(() => p.handEnd !== null && p.handEnd.handId !== firstId, 20000),
      ),
    );
    expect(players[0]!.handAbort).toBeNull();
    expect(players[1]!.myCards).toHaveLength(2);
    expect(players[0]!.board).toHaveLength(5);
    expect(players[0]!.handEnd!.stacks.reduce((s, x) => s + x.stack, 0)).toBe(before);
    const shortDelta = players[0]!.handEnd!.deltas.find((d) => d.seat === players[1]!.seat)!;
    expect(shortDelta.delta).toBeGreaterThanOrEqual(-5);
  }, 30000);

  /** The time bank is a fixed product setting now, so tests seed a seat's
   *  balance directly (on the room's current epoch) instead of configuring it
   *  through the no-longer-writable feature surface. */
  function seedBank(roomId: string, userId: number, ms: number, hands = 0): void {
    const epoch = (
      srv.ctx.db.prepare('SELECT time_bank_epoch AS e FROM rooms WHERE id = ?').get(roomId) as {
        e: number;
      }
    ).e;
    srv.ctx.db
      .prepare(
        'UPDATE room_players SET time_bank_ms = ?, time_bank_hands = ?, time_bank_epoch = ? WHERE room_id = ? AND user_id = ?',
      )
      .run(ms, hands, epoch, roomId, userId);
  }

  it('time bank: a slow-but-legal action spends bank past the base clock', async () => {
    const { players, room, host } = await setupRoom(['tba', 'tbb']);
    seedBank(room.id, players[0]!.userId, 2_000);
    // the host acts ~200ms past the 1,500ms base clock each turn
    players[0]!.thinkMs = 1700;
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players, 20000);
    expect(players[0]!.handAbort).toBeNull();
    const updates = players[0]!.timeBankUpdates.filter((u) => u.seat === players[0]!.seat);
    expect(updates.length).toBeGreaterThan(0);
    const last = updates[updates.length - 1]!;
    expect(last.remainingMs).toBeLessThan(2_000);
    expect(last.remainingMs).toBeGreaterThan(0);
    const row = srv.ctx.db
      .prepare('SELECT time_bank_ms FROM room_players WHERE room_id = ? AND user_id = ?')
      .get(room.id, players[0]!.userId) as { time_bank_ms: number };
    expect(row.time_bank_ms).toBe(last.remainingMs);
  }, 30000);

  it('time bank: a timeout burns what is left and auto-folds', async () => {
    const { players, room, host } = await setupRoom(['tca', 'tcb']);
    seedBank(room.id, players[0]!.userId, 200);
    // the host never acts: base 1.5s + 0.2s bank = 1.7s, then auto-fold
    players[0]!.ignoreActions = true;
    host.send({ t: 'start_hand' });
    await players[1]!.waitFor(() => players[1]!.handEnd !== null, 20000);
    expect(players[0]!.handAbort).toBeNull();
    const updates = players[0]!.timeBankUpdates.filter((u) => u.seat === players[0]!.seat);
    expect(updates.some((u) => u.remainingMs === 0)).toBe(true);
    const row = srv.ctx.db
      .prepare('SELECT time_bank_ms FROM room_players WHERE room_id = ? AND user_id = ?')
      .get(room.id, players[0]!.userId) as { time_bank_ms: number };
    expect(row.time_bank_ms).toBe(0);
  }, 25000);

  it('time bank: a legacy balance above the cap is clamped (no timer overflow)', async () => {
    const { players, room, host } = await setupRoom(['capa', 'capb']);
    // far above 2^31-1 ms: without the clamp this becomes a 1ms setTimeout and an
    // immediate auto-fold; the balance must be capped at 5 x 30s = 150_000.
    seedBank(room.id, players[0]!.userId, 2_200_000_000);
    // both stay put so we can sample the deadline the server armed
    host.ignoreActions = true;
    players[1]!.ignoreActions = true;
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.lastState?.toAct === host.seat, 8000);
    const remaining = host.lastDeadline! - Date.now();
    // base 1.5s + capped 150s, nowhere near the overflow ceiling
    expect(remaining).toBeGreaterThan(100_000);
    expect(remaining).toBeLessThanOrEqual(151_500);
    // still the actor's turn: not folded by a 1ms overflow timer
    expect(host.lastState?.toAct).toBe(host.seat);
    expect(host.handAbort).toBeNull();
  }, 20000);

  it('time bank: one card refills every 20 hands, and the 150s cap holds', async () => {
    const { players, room, host } = await setupRoom(['rfa', 'rfb'], ['passive', 'passive']);
    // p0 is one hand short of a refill AND already at the five-card cap; acting
    // fast spends no bank, so this hand's refill would push the row to 180s if
    // the cap were not applied on the write.
    seedBank(room.id, players[0]!.userId, 150_000, 19);
    for (const p of players) p.thinkMs = 50;
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players, 20000);
    expect(players[0]!.handAbort).toBeNull();
    const row = srv.ctx.db
      .prepare(
        'SELECT time_bank_ms AS ms, time_bank_hands AS hands FROM room_players WHERE room_id = ? AND user_id = ?',
      )
      .get(room.id, players[0]!.userId) as { ms: number; hands: number };
    // the 20th hand refilled (counter reset) but the balance stayed capped
    expect(row).toEqual({ ms: 150_000, hands: 0 });
  }, 20000);

  it('two consecutive timeouts stand the player up, chips staying on the room row', async () => {
    const { players, room, host } = await setupRoom(['tooa', 'toob']);
    const bob = players[1]!;
    seedBank(room.id, bob.userId, 0); // fold bob on the base clock
    const row = (userId: number) =>
      srv.ctx.db
        .prepare('SELECT seat, stack FROM room_players WHERE room_id = ? AND user_id = ?')
        .get(room.id, userId) as { seat: number | null; stack: number };
    const before = row(bob.userId);
    expect(before.seat).not.toBeNull();
    const playHand = async () => {
      host.send({ t: 'start_hand' });
      await host.waitFor(() => host.handEnd === null, 6000); // a fresh hand dealt
      await awaitHandEnd(players, 20000);
    };

    // hand 1: bob times out (streak 1) - still seated
    bob.ignoreActions = true;
    await playHand();
    expect(row(bob.userId).seat).not.toBeNull();

    // hand 2: bob times out again (streak 2) - stood up at the hand boundary
    const bobSeat = bob.seat!;
    await playHand();
    const after = row(bob.userId);
    expect(after.seat).toBeNull();
    // same as a voluntary leave_seat: the seat is released and the stack is
    // left exactly as the settlement wrote it (no cash-out, no refund)
    const settled = bob.handEnd!.stacks.find((s) => s.seat === bobSeat)!.stack;
    expect(after.stack).toBe(settled);
  }, 40000);

  it('a voluntary action resets the timeout streak (no removal)', async () => {
    const { players, room, host } = await setupRoom(['resa', 'resb']);
    const bob = players[1]!;
    seedBank(room.id, bob.userId, 0);
    const seatOf = (userId: number) =>
      (
        srv.ctx.db
          .prepare('SELECT seat FROM room_players WHERE room_id = ? AND user_id = ?')
          .get(room.id, userId) as { seat: number | null }
      ).seat;
    const playHand = async () => {
      host.send({ t: 'start_hand' });
      await host.waitFor(() => host.handEnd === null, 6000); // a fresh hand dealt
      await awaitHandEnd(players, 20000);
    };

    // hand 1: bob times out (streak 1)
    bob.ignoreActions = true;
    await playHand();

    // hand 2: bob acts for real - the streak is cleared
    bob.ignoreActions = false;
    bob.thinkMs = 100;
    await playHand();

    // hand 3: bob times out again (streak 1, not 2) - stays seated
    bob.ignoreActions = true;
    await playHand();
    expect(seatOf(bob.userId)).not.toBeNull();
  }, 55000);

  it('squid: the fold loser pays the penalty to the winner', async () => {
    const { players, room, host } = await setupRoom(['sqa', 'sqb'], ['fold-first', 'passive']);
    await enable(host, room.id, { squid: { enabled: true, penaltyBb: 1, minPlayers: 2 } });
    const trig = await host.api(`/api/rooms/${room.id}/feature-triggers`, {
      feature: 'squid',
      requestId: 'sq-1',
    });
    expect(trig.trigger.status).toBe('pending');

    host.send({ t: 'start_hand' });
    await awaitHandEnd(players, 15000);
    expect(players[0]!.handAbort).toBeNull();
    const hostSeat = players[0]!.seat!;
    const bobSeat = players[1]!.seat!;
    const sq = players[1]!.squidResult!;
    expect(sq.noClaimant).toBe(false);
    expect(sq.winners).toEqual([bobSeat]);
    expect(sq.requestedPerLoser).toBe(20); // 1 * bb(20) * (2 - 1)
    expect(sq.transfers).toEqual([{ from: hostSeat, to: bobSeat, amount: 20 }]);

    const hostDelta = players[0]!.handEnd!.deltas.find((d) => d.seat === hostSeat)!.delta;
    const bobDelta = players[1]!.handEnd!.deltas.find((d) => d.seat === bobSeat)!.delta;
    expect(hostDelta).toBe(-30); // SB 10 + squid 20
    expect(bobDelta).toBe(30);
    expect(players[0]!.handEnd!.deltas.reduce((s, d) => s + d.delta, 0)).toBe(0);
    expect(players[0]!.handEnd!.squidDeltas!.reduce((s, d) => s + d.delta, 0)).toBe(0);

    const row = srv.ctx.db
      .prepare("SELECT status FROM room_feature_triggers WHERE room_id = ? AND kind = 'squid'")
      .get(room.id) as { status: string };
    expect(row.status).toBe('applied');
    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    expect(ledger.verified.ok).toBe(true);
    const squidRows = ledger.entries.filter((e: { kind: string }) => e.kind === 'squid-game');
    expect(squidRows.map((e: { delta: number }) => e.delta).sort((a: number, b: number) => a - b)).toEqual(
      [-20, 20],
    );
  }, 25000);

  it('squid: a multi-run hand only pays a common winner and conserves chips', async () => {
    const { players, room, host } = await setupRoom(['smra', 'smrb'], ['shove-flop', 'passive']);
    await enable(host, room.id, {
      multiRun: { enabled: true },
      squid: { enabled: true, penaltyBb: 1, minPlayers: 2 },
    });
    await host.api(`/api/rooms/${room.id}/feature-triggers`, {
      feature: 'squid',
      requestId: 'smr-1',
    });
    for (const p of players) {
      p.runCountAnswer = 2;
      p.runAgreeAnswer = true;
    }
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players, 20000);
    expect(players[0]!.handAbort).toBeNull();
    const sq = players[1]!.squidResult!;
    expect(sq).not.toBeNull();
    expect(players[0]!.handEnd!.squidDeltas!.reduce((s, d) => s + d.delta, 0)).toBe(0);
    if (sq.winners.length === 0) {
      expect(sq.noClaimant).toBe(true);
      expect(sq.transfers).toEqual([]);
    } else {
      expect(sq.noClaimant).toBe(false);
      // every transfer moves chips; the broke all-in loser can only pay what
      // it has left, so an empty transfer list is legitimate
      for (const t of sq.transfers) expect(t.amount).toBeGreaterThan(0);
    }
    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    expect(ledger.verified.ok).toBe(true);
  }, 25000);

  it('abort: a claimed manual squid trigger returns to pending and moves no chips', async () => {
    const { players, room, host } = await setupRoom(['aba', 'abb']);
    await enable(host, room.id, { squid: { enabled: true, penaltyBb: 1, minPlayers: 2 } });
    await host.api(`/api/rooms/${room.id}/feature-triggers`, {
      feature: 'squid',
      requestId: 'ab-1',
    });
    host.send({ t: 'start_hand' });
    await players[0]!.waitFor(() => players[0]!.handId !== null, 5000);
    await players[0]!.waitFor(() => {
      const r = srv.ctx.db
        .prepare("SELECT status FROM room_feature_triggers WHERE room_id = ? AND kind = 'squid'")
        .get(room.id) as { status: string } | undefined;
      return r?.status === 'claimed';
    }, 5000);
    players[1]!.disconnect();
    await players[0]!.waitFor(() => players[0]!.handAbort !== null, 15000);
    const row = srv.ctx.db
      .prepare("SELECT status FROM room_feature_triggers WHERE room_id = ? AND kind = 'squid'")
      .get(room.id) as { status: string };
    expect(row.status).toBe('pending');
    const state = await host.api(`/api/rooms/${room.id}`);
    for (const p of state.players) expect(p.stack).toBe(1000);
  }, 25000);

  it('bomb pot x multi-run x squid all settle together in one hand', async () => {
    // hand 1 stays small so both players remain funded for the bomb hand;
    // they shove the flop only once the bomb is live
    const { players, room, host } = await setupRoom(['comba', 'combb'], ['passive', 'passive']);
    await enable(host, room.id, {
      bombPot: { enabled: true, anteBb: 1, schedule: { mode: 'hands', value: 1 } },
      multiRun: { enabled: true },
      squid: { enabled: true, penaltyBb: 1, minPlayers: 2 },
    });
    for (const p of players) {
      p.runCountAnswer = 2;
      p.runAgreeAnswer = true;
    }
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players, 20000);
    expect(players[0]!.handAbort).toBeNull();
    const firstId = players[0]!.handEnd!.handId;
    await players[0]!.waitIdle(room.id);
    for (const p of players) p.strategy = 'shove-flop';
    const before = (
      srv.ctx.db
        .prepare('SELECT SUM(stack) AS s FROM room_players WHERE room_id = ?')
        .get(room.id) as { s: number }
    ).s;
    await host.api(`/api/rooms/${room.id}/feature-triggers`, {
      feature: 'squid',
      requestId: 'combo-1',
    });
    host.send({ t: 'start_hand' });
    await Promise.all(
      players.map((p) =>
        p.waitFor(() => p.handEnd !== null && p.handEnd.handId !== firstId, 30000),
      ),
    );
    expect(players[0]!.handAbort).toBeNull();
    expect(players[0]!.featureStarted.some((f) => f.bombPot)).toBe(true);
    expect(players[0]!.multiRunResult).toMatchObject({ runs: 2 });
    expect(players[1]!.squidResult).not.toBeNull();
    // B1: `room_players.stack` (hence `hand_end.stacks`) is authoritative. This
    // room has no platform user, so the rake is credited to the in-room banker
    // and the table total is fully conserved; the players' combined deltas are
    // still net of that commission.
    const end = players[0]!.handEnd!;
    expect(end.stacks.reduce((s, x) => s + x.stack, 0)).toBe(before);
    expect(players[0]!.handEnd!.squidDeltas!.reduce((s, d) => s + d.delta, 0)).toBe(0);
    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    expect(ledger.verified.ok).toBe(true);
  }, 45000);
});
