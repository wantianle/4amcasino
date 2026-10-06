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

describe('full hand integration: ring, multi-run and commission', () => {
  it('multi-run: the player behind chooses 2 runs and the ahead player agrees', async () => {
    const { players, room, host } = await setupRoom(['mra', 'mrb'], ['shove-flop', 'passive']);
    await host.api(
      `/api/rooms/${room.id}/settings`,
      { features: { multiRun: { enabled: true } } },
      'PUT',
    );
    players[0]!.runCountAnswer = 2;
    players[1]!.runCountAnswer = 2;
    players[0]!.runAgreeAnswer = true;
    players[1]!.runAgreeAnswer = true;
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players, 20000);
    expect(players[0]!.handAbort).toBeNull();
    expect(players[0]!.multiRunResult).toMatchObject({ runs: 2, reason: 'agreed' });
    expect(players[0]!.sawMultiRunOffer).toBe(true);
    // the all-in happened on the flop, so only turn/river are run twice: the
    // flop is a shared card and the showdown reconstructs both full boards
    expect(players[0]!.board).toHaveLength(5);
    expect(players[0]!.board2).toHaveLength(2);
    expect(players[1]!.board2).toEqual(players[0]!.board2);
    const boards = players[0]!.lastShowdown!.multiRun!.boards;
    expect(boards).toHaveLength(2);
    for (const b of boards) expect(b).toHaveLength(5);
    expect(boards[1]!.slice(0, 3)).toEqual(boards[0]!.slice(0, 3)); // shared flop
    const all = [...boards.flat(), ...players.flatMap((p) => p.myCards)];
    // 5 shared run-1 cards + 2 run-2 turn/river + 4 hole cards, all distinct
    expect(new Set(all).size).toBe(11);
    // both halves settle: 2,000 pot, 0.5% rake, every chip accounted for
    expect(players[0]!.handEnd!.commission).toBe(10);
    expect(players[0]!.handEnd!.deltas.reduce((s, x) => s + x.delta, 0)).toBe(-10);
    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    expect(ledger.verified.ok).toBe(true);
  }, 25000);

  it('multi-run: refusing the run count runs the all-in board once', async () => {
    const { players, room, host } = await setupRoom(['mrc', 'mrd'], ['shove-flop', 'passive']);
    await host.api(
      `/api/rooms/${room.id}/settings`,
      { features: { multiRun: { enabled: true } } },
      'PUT',
    );
    players[0]!.runCountAnswer = 3;
    players[1]!.runCountAnswer = 3;
    players[0]!.runAgreeAnswer = false;
    players[1]!.runAgreeAnswer = false;
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players, 20000);
    expect(players[0]!.handAbort).toBeNull();
    expect(players[0]!.multiRunResult).toMatchObject({ runs: 1, reason: 'declined' });
    expect(players[0]!.board).toHaveLength(5);
    expect(players[0]!.board2).toHaveLength(0);
  }, 25000);

  it('new rooms pay 0.5% to the platform, conserving chips on the ledger', async () => {
    const { players, room, host } = await setupRoom(['coma', 'comb'], ['allin-first', 'passive']);
    expect(room.commissionBps).toBe(50);
    expect(host.roomState?.room.commissionBps).toBe(50);
    const { userId: platformId } = createUser(srv.ctx.db, 'platform', 'a'.repeat(64), 'b'.repeat(64));
    setPlatformUserId(srv.ctx.db, platformId);
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players, 15000);
    expect(players[0]!.handAbort).toBeNull();
    // 2,000 in the middle -> 10 raked, credited to the platform.
    expect(players[0]!.handEnd!.commission).toBe(10);
    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    const commission = ledger.entries.filter((e: { kind: string }) => e.kind === 'commission');
    expect(commission).toHaveLength(1);
    expect(commission[0].userId).toBe(platformId);
    expect(commission[0].delta).toBe(10);
    expect(commission[0].note).toContain('0.5%');
    expect(ledger.verified.ok).toBe(true);
    // room total unchanged: the rake moved, it did not vanish
    const state = await host.api(`/api/rooms/${room.id}`);
    expect(state.players.reduce((t: number, p: { stack: number }) => t + p.stack, 0)).toBe(1990);
    expect(
      srv.ctx.db.prepare('SELECT SUM(stack) AS total FROM room_players WHERE room_id = ?').get(room.id),
    ).toEqual({ total: 2000 });
    const transcript = await host.api(`/api/rooms/${room.id}/hands/${players[0]!.handEnd!.handId}`);
    expect(
      transcript.entries.find((e: { type: string }) => e.type === 'hand_start').payload
        .commissionBps,
    ).toBe(50);
  }, 20000);

  it('rooms assigned 1% still settle at that rate', async () => {
    const { players, room, host } = await setupRoom(
      ['oldcoma', 'oldcomb'],
      ['allin-first', 'passive'],
    );
    srv.ctx.db.prepare('UPDATE rooms SET commission_bps = 100 WHERE id = ?').run(room.id);
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players, 15000);
    expect(players[0]!.handAbort).toBeNull();
    expect(players[0]!.handEnd!.commission).toBe(20);
    const state = await host.api(`/api/rooms/${room.id}`);
    expect(state.commissionBps).toBe(100);
    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    expect(ledger.entries.find((e: { kind: string }) => e.kind === 'commission')).toMatchObject({
      delta: 20,
      note: '1% table commission - keeps the lights on',
    });
    expect(ledger.verified.ok).toBe(true);
  }, 20000);

  it('keeps a running hand at its original rate and applies an admin change to the next deal', async () => {
    const { players, room, host } = await setupRoom(['ratea', 'rateb']);
    const { userId } = createUser(srv.ctx.db, 'ratehouse', 'a'.repeat(64), 'b'.repeat(64));
    setPlatformUserId(srv.ctx.db, userId);
    const token = createSession(srv.ctx.db, userId);
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.handId !== null);
    const res = await srv.ctx.app.inject({
      method: 'PUT',
      url: '/api/admin/settings/commission',
      headers: { authorization: `Bearer ${token}` },
      payload: { commissionBps: 100, scope: 'all_rooms', revision: 1 },
    });
    expect(res.statusCode).toBe(200);
    await awaitHandEnd(players, 15000);
    expect(host.handAbort).toBeNull();
    expect(host.handEnd!.commissionBps).toBe(50);
    const firstId = host.handEnd!.handId;
    expect(srv.ctx.db.prepare('SELECT commission_bps FROM rooms WHERE id = ?').get(room.id)).toEqual({
      commission_bps: 100,
    });
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.handEnd !== null && host.handEnd.handId !== firstId, 15000);
    expect(host.handEnd!.commissionBps).toBe(100);
    const transcript = await host.api(`/api/rooms/${room.id}/hands/${host.handEnd!.handId}`);
    expect(
      transcript.entries.find((e: { type: string }) => e.type === 'hand_start').payload
        .commissionBps,
    ).toBe(100);
  }, 30000);

  it('small pots won by folding incur no fractional or minimum commission', async () => {
    const { players, room, host } = await setupRoom(
      ['foldcoma', 'foldcomb'],
      ['fold-first', 'passive'],
    );
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players, 15000);
    expect(players[0]!.handAbort).toBeNull();
    expect(players[0]!.handEnd!.commission).toBe(0);
    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    expect(ledger.entries.filter((e: { kind: string }) => e.kind === 'commission')).toEqual([]);
    expect(ledger.verified.ok).toBe(true);
    expect(
      srv.ctx.db.prepare('SELECT SUM(stack) AS total FROM room_players WHERE room_id = ?').get(room.id),
    ).toEqual({ total: 2000 });
  }, 20000);

  it('a leaver during the shuffle aborts fast and the redeal skips them', async () => {
    const { players, host } = await setupRoom(['lva', 'lvb', 'lvc']);
    host.send({ t: 'start_hand' });
    // carol vanishes while keys/shuffles are still in flight
    await players[2]!.waitFor(() => players[2]!.handId !== null, 5000);
    const t0 = Date.now();
    players[2]!.disconnect();
    await Promise.all(
      players
        .slice(0, 2)
        .map((p) => p.waitFor(() => p.handAbort !== null || p.handEnd !== null, 12000)),
    );
    // the pre-betting grace is ~4s (and cancelled on reconnect) - nothing like
    // the old multi-retry stall
    expect(Date.now() - t0).toBeLessThan(9000);
    if (players[0]!.handAbort) {
      expect(players[0]!.handAbort!.reason).toBe('player left during the deal');
    }
    // the very next deal excludes the leaver entirely
    const firstId = players[0]!.handId;
    host.send({ t: 'start_hand' });
    await Promise.all(
      players
        .slice(0, 2)
        .map((p) => p.waitFor(() => p.handEnd !== null && p.handId !== firstId, 15000)),
    );
    const seats = players[0]!.handEnd!.stacks.map((x) => x.seat).sort();
    expect(seats).toEqual([0, 1]);
  }, 30000);

  it('the ready check stops waiting for a player who left', async () => {
    const { players, host } = await setupRoom(['rlva', 'rlvb', 'rlvc']);
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players);
    const firstHandId = players[0]!.handEnd!.handId;
    // carol never clicks ready and then leaves: the other two must not sit
    // through her 1.5s (in prod: 20s) deadline once she is gone
    players[2]!.autoReady = false;
    await players[0]!.waitFor(() => players[0]!.sawReadyCheck, 10000);
    players[2]!.disconnect();
    await Promise.all(
      players
        .slice(0, 2)
        .map((p) => p.waitFor(() => p.handEnd !== null && p.handEnd.handId !== firstHandId, 15000)),
    );
    const seats = players[0]!.handEnd!.stacks.map((x) => x.seat).sort();
    expect(seats).toEqual([0, 1]);
  }, 25000);

  it('profile debts: who owes whom shows up and clears when both sides settle', async () => {
    const { players, room, host } = await setupRoom(['debta', 'debtb'], ['allin-first', 'passive']);
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players, 15000);
    expect(players[0]!.handAbort).toBeNull();
    // whoever bust the all-in owes the other their winnings (net of commission)
    const state = await host.api(`/api/rooms/${room.id}`);
    const nets = (state.players as { userId: number; stack: number; totalBought: number }[]).map(
      (p) => ({ userId: p.userId, net: p.stack - 1000 }),
    );
    const loser = players.find((p) => nets.find((n) => n.userId === p.userId)!.net < 0)!;
    const winner = players.find((p) => p !== loser)!;
    const owed = -nets.find((n) => n.userId === loser.userId)!.net;
    expect(owed).toBeGreaterThan(0);

    const mine = await loser.api('/api/me/debts');
    const row = mine.debts.find((d: { otherUserId: number }) => d.otherUserId === winner.userId);
    expect(row.direction).toBe('owe');
    expect(row.amount).toBe(owed);

    // the winner sees the mirror image
    const theirs = await winner.api('/api/me/debts');
    const mirror = theirs.debts.find(
      (d: { otherUserId: number }) => d.otherUserId === loser.userId,
    );
    expect(mirror.direction).toBe('owed');
    expect(mirror.amount).toBe(owed);

    // one side marking is only half the handshake
    const first = await loser.api('/api/settlements', {
      roomId: room.id,
      otherUserId: winner.userId,
    });
    expect(first.settled).toBe(false);
    const waiting = await winner.api('/api/me/debts');
    expect(
      waiting.debts.find((d: { otherUserId: number }) => d.otherUserId === loser.userId)
        .otherConfirmed,
    ).toBe(true);

    // both sides in: resolved on the platform, gone from the open list
    const second = await winner.api('/api/settlements', {
      roomId: room.id,
      otherUserId: loser.userId,
    });
    expect(second.settled).toBe(true);
    const after = await loser.api('/api/me/debts');
    expect(
      after.debts.filter((d: { otherUserId: number }) => d.otherUserId === winner.userId),
    ).toHaveLength(0);
    expect(after.settled.length).toBeGreaterThan(0);
    expect(after.settled[0].amount).toBe(owed);
  }, 20000);

  it('a sitting-out player is skipped when the next hand is dealt', async () => {
    const { players, host } = await setupRoom(['host', 'bob', 'carol']);
    players[2]!.send({ t: 'sit_out', sittingOut: true });
    await new Promise((r) => setTimeout(r, 100));
    host.send({ t: 'start_hand' });
    await Promise.all(players.slice(0, 2).map((p) => p.waitFor(() => p.handEnd !== null)));
    const seats = players[0]!.handEnd!.stacks.map((s) => s.seat).sort();
    expect(seats).toEqual([0, 1]);
  });

  it('the fold winner can voluntarily show cards after the hand ends', async () => {
    const { players, host } = await setupRoom(['host', 'bob'], ['fold-first', 'passive']);
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players);
    const bob = players[1]!;
    bob.showCards();
    await host.waitFor(() => host.cardsShown.length > 0);
    expect(host.cardsShown[0]!.seat).toBe(bob.seat);
    expect(host.cardsShown[0]!.cards.slice().sort()).toEqual(bob.myCards.slice().sort());
  });
});
