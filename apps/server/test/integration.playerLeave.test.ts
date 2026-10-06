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

describe('player leave resilience', () => {
  it('a folded player leaving mid-hand no longer kills the hand', async () => {
    const { players, room, host } = await setupRoom(
      ['resa', 'resb', 'resc'],
      ['passive', 'fold-first', 'passive'],
    );
    const folder = players[1]!;
    host.send({ t: 'start_hand' });
    // the fold_key escrow is queued before the fold flag flips, so the close
    // frame always lands at the server after the key does
    await folder.waitFor(() => folder.sawOwnFold);
    const folderSeat = folder.seat;
    folder.disconnect();

    const rest = [players[0]!, players[2]!];
    await awaitHandEnd(rest, 15000);
    for (const p of rest) expect(p.handAbort).toBeNull();
    const end = host.handEnd!;

    // the server stepped over the absent folder with server-signed shares
    const hand = await host.api(`/api/rooms/${room.id}/hands/${end.handId}`);
    const recovered = hand.entries.filter((e: { type: string }) => e.type === 'recovered_share');
    expect(recovered.length).toBeGreaterThan(0);
    for (const e of recovered) expect(e.payload.seat).toBe(folderSeat);

    // chips conserved and the ledger still verifies end to end
    expect(end.deltas.reduce((s: number, x: { delta: number }) => s + x.delta, 0)).toBe(0);
    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    expect(ledger.verified.ok).toBe(true);
  }, 20000);

  it('a live player dropping heads-up ends the hand by fold instead of aborting', async () => {
    const { players, host, room } = await setupRoom(['dropa', 'dropb'], ['passive', 'passive']);
    const leaver = players[1]!;
    const stayer = players[0]!;
    host.send({ t: 'start_hand' });
    // wait until they are genuinely in the hand and have NOT folded, so this is
    // the case that used to be unrecoverable: nobody holds their key
    await leaver.waitFor(() => leaver.myCards.length === 2);
    expect(leaver.sawOwnFold).toBe(false);
    leaver.disconnect();

    // folding them leaves one contestant, so the pot is already decided and no
    // card has to be opened - the hand must finish rather than abort
    await stayer.waitFor(() => stayer.handEnd !== null, 15000);
    expect(stayer.handAbort).toBeNull();

    const end = stayer.handEnd!;
    expect(end.deltas.reduce((s: number, x: { delta: number }) => s + x.delta, 0)).toBe(0);
    // the player who stayed cannot have lost chips on a hand nobody contested
    const mine = end.deltas.find((d: { seat: number }) => d.seat === stayer.seat);
    expect(mine!.delta).toBeGreaterThanOrEqual(0);
    const ledger = await host.api(`/api/rooms/${room.id}/ledger`);
    expect(ledger.verified.ok).toBe(true);
  }, 20000);

  it('no escrow, no rescue: a folder without a key still aborts the hand', async () => {
    const { players, room, host } = await setupRoom(
      ['noka', 'nokb', 'nokc'],
      ['passive', 'fold-first', 'passive'],
    );
    const folder = players[1]!;
    folder.autoFoldKey = false; // an old client that never escrows
    host.send({ t: 'start_hand' });
    await folder.waitFor(() => folder.sawOwnFold);
    const folderSeat = folder.seat;
    folder.disconnect();

    const rest = [players[0]!, players[2]!];
    await Promise.all(rest.map((p) => p.waitFor(() => p.handAbort !== null, 15000)));
    expect(rest[0]!.handAbort!.reason).toBe('unmask timeout');
    expect(rest[0]!.handAbort!.blamedSeat).toBe(folderSeat);

    // the abort returned every bet: all stacks back to their buy-ins
    const state = await host.api(`/api/rooms/${room.id}`);
    expect(state.players.reduce((s: number, p: { stack: number }) => s + p.stack, 0)).toBe(3000);
  }, 20000);

  it('a non-folded player leaving still aborts with refunds', async () => {
    const { players, room, host } = await setupRoom(['npa', 'npb', 'npc']);
    const leaver = players[2]!;
    host.send({ t: 'start_hand' });
    await leaver.waitFor(() => leaver.myCards.length === 2);
    leaver.disconnect(); // never folded, never escrowed: the hand cannot be saved

    const rest = [players[0]!, players[1]!];
    await Promise.all(rest.map((p) => p.waitFor(() => p.handAbort !== null, 15000)));
    expect(rest[0]!.handAbort!.reason).toBe('unmask timeout');

    const state = await host.api(`/api/rooms/${room.id}`);
    expect(state.players.reduce((s: number, p: { stack: number }) => s + p.stack, 0)).toBe(3000);
  }, 20000);

  it('a wrong escrow key is rejected', async () => {
    const { players, room, host } = await setupRoom(
      ['wka', 'wkb', 'wkc'],
      ['passive', 'fold-first', 'passive'],
    );
    const folder = players[1]!;
    folder.autoFoldKey = false;
    host.send({ t: 'start_hand' });
    await folder.waitFor(() => folder.sawOwnFold);
    // a bogus key, correctly signed: the commitment check must throw it out
    const key = '1234abcd';
    folder.send({
      t: 'fold_key',
      handId: folder.handId,
      key,
      sig: folder.signed('fold_key', { key }),
    });
    folder.disconnect();

    const rest = [players[0]!, players[2]!];
    await Promise.all(rest.map((p) => p.waitFor(() => p.handAbort !== null, 15000)));
    expect(rest[0]!.handAbort!.reason).toBe('unmask timeout');

    const state = await host.api(`/api/rooms/${room.id}`);
    expect(state.players.reduce((s: number, p: { stack: number }) => s + p.stack, 0)).toBe(3000);
  }, 20000);

  it('joining mid-hand spectates, then plays the next hand', async () => {
    const { players, room, host } = await setupRoom(['j2a', 'j2b']);
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.handId !== null);

    // a third player arrives while the hand is live
    const late = new TestClient(baseUrl, 'j2late');
    clients.push(late);
    await late.register();
    await late.api('/api/rooms/join', { joinCode: room.joinCode });
    const req = await late.api(`/api/rooms/${room.id}/buy`, { amount: 1000 });
    await host.api(`/api/rooms/${room.id}/approve`, { requestId: req.id, approve: true });
    await late.connect(room.id);
    late.send({ t: 'sit', seat: 2 });
    await late.waitFor(() => late.errors.length > 0);
    expect(late.errors).toContain('wait for the hand to end');

    await awaitHandEnd(players);
    const firstHandId = host.handEnd!.handId;
    const firstSeats = host.handEnd!.stacks.map((s) => s.seat).sort();
    expect(firstSeats).toEqual([0, 1]); // hand 1 never included the latecomer

    // now the seat sticks, and the next deal has them in it (the spectator saw
    // hand 1's hand_end broadcast too, so wait for a hand_end with a NEW id)
    late.send({ t: 'sit', seat: 2 });
    await new Promise((r) => setTimeout(r, 150));
    host.send({ t: 'start_hand' });
    await late.waitFor(() => late.handEnd !== null && late.handEnd.handId !== firstHandId, 15000);
    expect(late.handEnd!.stacks.map((s) => s.seat).sort()).toEqual([0, 1, 2]);
    expect(late.myCards).toHaveLength(2);
  }, 20000);

  it("TV replays recover an absent folder's cards", async () => {
    const { players, room, host } = await setupRoom(
      ['tvda', 'tvdb', 'tvdc'],
      ['passive', 'fold-first', 'passive'],
    );
    await host.api(`/api/rooms/${room.id}/settings`, { tvReplays: true }, 'PUT');
    host.send({ t: 'start_hand' });
    const folder = players[1]!;
    await folder.waitFor(() => folder.sawOwnFold);
    const folderSeat = folder.seat;
    const folderCards = [...folder.myCards];
    folder.disconnect();

    const rest = [players[0]!, players[2]!];
    await awaitHandEnd(rest, 15000);
    expect(rest[0]!.handAbort).toBeNull();
    const end = rest[0]!.handEnd!;

    // the escrowed fold-key filled in the absent folder's replay cards
    const hand = await host.api(`/api/rooms/${room.id}/hands/${end.handId}`);
    const hole = hand.entries.find(
      (e: { type: string; payload: { seat: number } }) =>
        e.type === 'hole_cards' && e.payload.seat === folderSeat,
    );
    expect(hole).toBeDefined();
    expect(new Set(hole.payload.cards)).toEqual(new Set(folderCards));
  }, 20000);
});
