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

describe('full hand integration: auto-deal and transcript replay', () => {
  it('the next hand deals itself while the host stays online', async () => {
    const { players, host } = await setupRoom(['host', 'bob'], ['fold-first', 'passive']);
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players);
    const firstHandId = players[0]!.handEnd!.handId;
    // the clients answer the ready check, so the server deals again on its own
    await Promise.all(
      players.map((p) =>
        p.waitFor(() => p.handEnd !== null && p.handEnd.handId !== firstHandId, 15000),
      ),
    );
    expect(players[0]!.handEnd!.handId).not.toBe(firstHandId);
  }, 20000);

  it('auto-deals and settles the next hand with a fallback after the host disconnects', async () => {
    const { players, host } = await setupRoom(['fallbacka', 'fallbackb', 'fallbackc'], ['fold-first', 'passive', 'passive']);
    host.send({ t: 'start_hand' });
    await Promise.all(players.map(p => p.waitFor(() => p.handEnd !== null)));
    const firstHandId = players[1]!.handEnd!.handId;
    host.disconnect();
    await Promise.all(players.slice(1).map(p => p.waitFor(() => p.handEnd !== null && p.handEnd.handId !== firstHandId, 15000)));
    expect(players[1]!.roomState!.room.autoDealerId).toBe(players[1]!.userId);
    expect(players[1]!.roomState!.room.hostId).toBe(host.userId);
    expect(players[1]!.handEnd!.stacks.map(s => s.seat).sort()).toEqual([1, 2]);
    const ledger = await players[1]!.api(`/api/rooms/${players[1]!.roomState!.room.id}/ledger`);
    expect(ledger.verified.ok).toBe(true);
  }, 20000);

  it('a player who ignores the ready check is left out of the auto-dealt hand', async () => {
    const { players, host } = await setupRoom(['reada', 'readb', 'readc']);
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players);
    const firstHandId = players[0]!.handEnd!.handId;
    // carol never clicks I'm ready: opt her out of the (now default-on)
    // server-side auto-ready, then the deadline passes and the other two play
    players[2]!.autoReady = false;
    ctx.db.prepare('UPDATE users SET auto_ready = 0 WHERE id = ?').run(players[2]!.userId);
    await Promise.all(
      players
        .slice(0, 2)
        .map((p) => p.waitFor(() => p.handEnd !== null && p.handEnd.handId !== firstHandId, 15000)),
    );
    const seats = players[0]!.handEnd!.stacks.map((x) => x.seat).sort();
    expect(seats).toEqual([0, 1]);
  }, 20000);

  it('TV replays save every key and decrypt folded hole cards into the transcript', async () => {
    const { players, room, host } = await setupRoom(
      ['tva', 'tvb', 'tvc'],
      ['passive', 'fold-first', 'passive'],
    );
    await host.api(`/api/rooms/${room.id}/settings`, { tvReplays: true }, 'PUT');
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players);
    expect(players[0]!.handAbort).toBeNull();

    const hand = await host.api(`/api/rooms/${room.id}/hands/${players[0]!.handEnd!.handId}`);
    const keys = hand.entries.filter((e: { type: string }) => e.type === 'reveal_key');
    expect(keys).toHaveLength(3);
    // bob folded, so he never revealed at showdown - the key reveal decrypts him
    const holes = hand.entries.filter((e: { type: string }) => e.type === 'hole_cards');
    const bobSeatHole = holes.find((e: { payload: { seat: number } }) => e.payload.seat === 1);
    expect(bobSeatHole).toBeDefined();
    expect(new Set(bobSeatHole.payload.cards)).toEqual(new Set(players[1]!.myCards));
    // and the stored transcript still verifies end to end
    const row = ctx.db
      .prepare('SELECT head FROM transcripts WHERE hand_id = ?')
      .get(players[0]!.handEnd!.handId) as { head: string };
    expect(row.head).toBe(hand.head);
  });
});
