import { describe, expect, it } from 'vitest';
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
import { TestClient, type Strategy } from './helpers/testClient.js';
import { setupRoom as createRoom } from './helpers/testRoom.js';
import { awaitHandEnd } from './helpers/testRoom.js';
import { useIntegrationServer } from './helpers/integrationServer.js';

const srv = useIntegrationServer();

// Thin adapter onto the shared `setupRoom`, binding this file's server URL and
// client collector so the migrated call sites stay byte-identical.
const setupRoom = (names: string[], strategies: Strategy[] = []) =>
  createRoom(srv.baseUrl, names, strategies, srv.clients);

describe('settlement lifecycle v6', () => {
  it('P0-1: a fallback banker outside the hand gets no seat leg and the aggregate is conditional', async () => {
    const { players, room, host } = await setupRoom(['fba', 'fbb'], ['passive', 'passive']);
    srv.ctx.db.prepare("DELETE FROM meta WHERE key = 'platform_user_id'").run();
    const { userId: bankerId } = createUser(srv.ctx.db, 'outbanker', 'e'.repeat(64), 'f'.repeat(64));
    srv.ctx.db
      .prepare('UPDATE rooms SET commission_bps = 500, banker_id = ? WHERE id = ?')
      .run(bankerId, room.id);
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players, 15000);
    const end = host.handEnd!;
    const rake = end.commission ?? 0;
    expect(rake).toBeGreaterThan(0);
    // The recipient has no seat: the wire commission leg is empty.
    expect(end.commissionDeltas ?? []).toHaveLength(0);
    const gameSum = end.deltas.reduce((s, d) => s + d.delta, 0);
    const commissionSum = (end.commissionDeltas ?? []).reduce((s, d) => s + d.delta, 0);
    expect(gameSum).toBe(-rake); // unconditional
    expect(gameSum + commissionSum).toBe(-rake); // NOT 0: recipient out of hand
    // Every seat still reconciles without a commission delta.
    const proj = srv.ctx.db
      .prepare(
        'SELECT user_id, starting_stack, ending_stack, net_delta FROM hand_players WHERE hand_id = ?',
      )
      .all(end.handId) as {
      user_id: number;
      starting_stack: number;
      ending_stack: number;
      net_delta: number;
    }[];
    for (const p of proj) expect(p.ending_stack - p.starting_stack).toBe(p.net_delta);
    const banker = srv.ctx.db
      .prepare('SELECT stack FROM room_players WHERE room_id = ? AND user_id = ?')
      .get(room.id, bankerId) as { stack: number };
    expect(banker.stack).toBe(rake);
  }, 20000);

  it('P0-2: a post-cutoff transcript without a marker is quarantined and freezes the room', async () => {
    const dir = mkdtempSync(join(tmpdir(), '4am-qtn-'));
    const dbPath = join(dir, 'game.db');
    const saved = { ctx: srv.ctx, baseUrl: srv.baseUrl, hub: srv.hub };
    const app = createApp(dbPath);
    const appHub = attachHub(app.app, app.db, {
      cryptoTimeoutMs: 1500,
      actionTimeoutMs: 1500,
      autoDealMs: 3_600_000,
      readyCheckMs: 1500,
      clock: srv.clock,
    });
    await app.app.listen({ port: 0 });
    const addr = app.app.server.address() as AddressInfo;
    srv.ctx = app;
    srv.hub = appHub;
    srv.baseUrl = `http://127.0.0.1:${addr.port}`;
    try {
      const { players, room, host } = await setupRoom(['qta', 'qtb'], ['passive', 'passive']);
      // A transcript created AFTER the lifecycle cutoff with no settlement
      // marker: cannot be assumed settled (half-settled / corrupted), so it
      // must be quarantined rather than whitelisted as legacy.
      srv.ctx.db
        .prepare(
          "INSERT INTO transcripts (hand_id, room_id, head, entries, ts) VALUES (?, ?, ?, '[]', ?)",
        )
        .run('orphan-hand-1', room.id, 'orphanhead', Date.now() + 1000);
      for (const c of players) c.close();
      await app.app.close();

      const restarted = createApp(dbPath);
      const row = restarted.db
        .prepare('SELECT status FROM hand_lifecycle WHERE hand_id = ?')
        .get('orphan-hand-1') as { status: string } | undefined;
      expect(row?.status).toBe('quarantined');
      expect(firstPendingHandLifecycle(restarted.db, room.id)).toBe('orphan-hand-1');

      const nextHub = attachHub(restarted.app, restarted.db, {
        cryptoTimeoutMs: 1500,
        actionTimeoutMs: 1500,
        autoDealMs: 3_600_000,
        readyCheckMs: 1500,
        clock: srv.clock,
      });
      await restarted.app.listen({ port: 0 });
      const addr2 = restarted.app.server.address() as AddressInfo;
      srv.ctx = restarted;
      srv.hub = nextHub;
      srv.baseUrl = `http://127.0.0.1:${addr2.port}`;
      for (const p of players) {
        p.baseUrl = srv.baseUrl;
        await p.connect(room.id);
      }
      host.errors = [];
      host.send({ t: 'start_hand' });
      await host.waitFor(() => host.errors.some((e) => /never settled|frozen/i.test(e)), 4000);
      for (const p of players) p.close();
      await restarted.app.close();
    } finally {
      srv.ctx = saved.ctx;
      srv.baseUrl = saved.baseUrl;
      srv.hub = saved.hub;
    }
  }, 30000);

  it('P0-3: a graceful shutdown drains a live hand to terminal so restart is not frozen', async () => {
    const dir = mkdtempSync(join(tmpdir(), '4am-drain-'));
    const dbPath = join(dir, 'game.db');
    const saved = { ctx: srv.ctx, baseUrl: srv.baseUrl, hub: srv.hub };
    const app = createApp(dbPath);
    const appHub = attachHub(app.app, app.db, {
      cryptoTimeoutMs: 1500,
      actionTimeoutMs: 1500,
      autoDealMs: 3_600_000,
      readyCheckMs: 1500,
      shutdownDrainMs: 120,
      clock: srv.clock,
    });
    await app.app.listen({ port: 0 });
    const addr = app.app.server.address() as AddressInfo;
    srv.ctx = app;
    srv.hub = appHub;
    srv.baseUrl = `http://127.0.0.1:${addr.port}`;
    try {
      const { players, room, host } = await setupRoom(['sda', 'sdb'], ['passive', 'passive']);
      // Stall the hand so the drain window must abort it.
      players[1]!.respondShares = false;
      host.send({ t: 'start_hand' });
      await host.waitFor(() => host.handId !== null, 5000);
      const handId = host.handId!;

      // Graceful shutdown drains the live hand: the stalled hand cannot reach a
      // terminal state, so after the bounded window it is aborted and its
      // lifecycle row becomes terminal. This is exactly what the hub's onClose
      // awaits before dropping sockets.
      await srv.hub.rooms.get(room.id)!.shutdown();
      expect(
        srv.ctx.db.prepare('SELECT status FROM hand_lifecycle WHERE hand_id = ?').get(handId),
      ).toEqual({ status: 'aborted' });

      // Tear the first server down, then "restart" on the same file.
      for (const p of players) p.close();
      await app.app.close();

      const restarted = createApp(dbPath);
      const row = restarted.db
        .prepare('SELECT status FROM hand_lifecycle WHERE hand_id = ?')
        .get(handId) as { status: string } | undefined;
      expect(row?.status).toBe('aborted');
      expect(firstPendingHandLifecycle(restarted.db, room.id)).toBeNull();

      const nextHub = attachHub(restarted.app, restarted.db, {
        cryptoTimeoutMs: 1500,
        actionTimeoutMs: 1500,
        autoDealMs: 3_600_000,
        readyCheckMs: 1500,
        shutdownDrainMs: 120,
        clock: srv.clock,
      });
      await restarted.app.listen({ port: 0 });
      const addr2 = restarted.app.server.address() as AddressInfo;
      srv.ctx = restarted;
      srv.hub = nextHub;
      srv.baseUrl = `http://127.0.0.1:${addr2.port}`;
      players[1]!.respondShares = true;
      for (const p of players) {
        p.baseUrl = srv.baseUrl;
        await p.connect(room.id);
      }
      host.send({ t: 'start_hand' });
      await awaitHandEnd(players, 15000);
      expect(players[0]!.handAbort).toBeNull();
      for (const p of players) p.close();
      await restarted.app.close();
    } finally {
      srv.ctx = saved.ctx;
      srv.baseUrl = saved.baseUrl;
      srv.hub = saved.hub;
    }
  }, 40000);

  it('P1-4: an unexpected internal TypeError in the 7-2 bounty is NOT classified retryable', async () => {
    const { players, room, host } = await setupRoom(['i4a', 'i4b'], ['fold-first', 'passive']);
    srv.ctx.db.prepare('UPDATE rooms SET auto_deal = 0, seven_deuce_bonus = 25 WHERE id = ?').run(room.id);
    const identity = Array.from({ length: 52 }, (_, i) => i);
    const wanted = [9, 0, 10, 21, 11, 12, 13, 14, 15];
    const seen = new Set(wanted);
    const Q = [...wanted, ...identity.filter((i) => !seen.has(i))];
    host.forcedShufflePerm = identity;
    players[1]!.forcedShufflePerm = Q;
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players, 15000);
    const bob = players[1]!;
    const gameRoom = srv.hub.rooms.get(room.id)!;

    srv.fault.sevenDeuceInternal = () => {
      throw new TypeError('internal boom');
    };
    bob.showCards();
    await host.waitFor(() => gameRoom.isUnhealthy(), 3000);
    srv.fault.sevenDeuceInternal = null;
    // A programming error is a permanent mark: never clearable.
    expect(gameRoom.clearUnhealthy('anything')).toBe(false);
    host.errors = [];
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.errors.some((e) => /held for an operator/i.test(e)), 3000);
  }, 20000);

  it('P1-5: an unknown error after a recoverable mark escalates and survives a settlement success', async () => {
    const { room, host } = await setupRoom(['i5a', 'i5b'], ['passive', 'passive']);
    srv.ctx.db.prepare('UPDATE rooms SET auto_deal = 0 WHERE id = ?').run(room.id);
    const gameRoom = srv.hub.rooms.get(room.id)!;
    gameRoom.markUnhealthy('settlement failed: busy', { recoverable: true });
    // A later, genuinely unknown programming error must escalate the mark.
    gameRoom.markUnhealthy('TypeError: late');
    expect(gameRoom.isUnhealthy()).toBe(true);
    // A settlement success can no longer clear it.
    gameRoom.settlementRecovered();
    expect(gameRoom.isUnhealthy()).toBe(true);
    expect(gameRoom.clearUnhealthy('TypeError: late')).toBe(false);
    expect(gameRoom.clearUnhealthy('settlement failed: busy')).toBe(false);
    host.errors = [];
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.errors.some((e) => /held for an operator/i.test(e)), 3000);
  }, 20000);

  it('P1-5b: an unknown error first is not downgraded by a later recoverable mark', async () => {
    const { room } = await setupRoom(['i5c', 'i5d'], ['passive', 'passive']);
    srv.ctx.db.prepare('UPDATE rooms SET auto_deal = 0 WHERE id = ?').run(room.id);
    const gameRoom = srv.hub.rooms.get(room.id)!;
    gameRoom.markUnhealthy('TypeError: first');
    gameRoom.markUnhealthy('settlement failed: busy', { recoverable: true });
    gameRoom.settlementRecovered();
    expect(gameRoom.isUnhealthy()).toBe(true);
    expect(gameRoom.clearUnhealthy('TypeError: first')).toBe(false);
  }, 20000);

  it('P1-6: mid-hand buy breaks ending-starting === net_delta even with commission', async () => {
    const { players, room, host } = await setupRoom(['m6a', 'm6b'], ['fold-first', 'passive']);
    srv.ctx.db.prepare('UPDATE rooms SET commission_bps = 500 WHERE id = ?').run(room.id);
    host.send({ t: 'start_hand' });
    const req = await host.api(`/api/rooms/${room.id}/buy`, { amount: 500 });
    await host.api(`/api/rooms/${room.id}/approve`, { requestId: req.id, approve: true });
    await awaitHandEnd(players, 15000);
    const end = host.handEnd!;
    const rake = end.commission ?? 0;
    expect(rake).toBeGreaterThan(0);
    const hostUser = srv.ctx.db
      .prepare('SELECT user_id FROM room_players WHERE room_id = ? AND seat = 0')
      .get(room.id) as { user_id: number };
    const p = srv.ctx.db
      .prepare(
        'SELECT starting_stack, ending_stack, net_delta FROM hand_players WHERE hand_id = ? AND user_id = ?',
      )
      .get(end.handId, hostUser.user_id) as {
      starting_stack: number;
      ending_stack: number;
      net_delta: number;
    };
    const comm = srv.ctx.db
      .prepare(
        "SELECT COALESCE(SUM(delta), 0) AS d FROM ledger WHERE ref = ? AND kind = 'commission' AND user_id = ?",
      )
      .get(end.head, hostUser.user_id) as { d: number };
    // The buy is an intervening account delta: the naive identity explicitly
    // does NOT hold, and the exception is the 500 chips bought mid-hand (plus
    // any commission leg this seat happens to receive).
    expect(p.ending_stack - p.starting_stack).not.toBe(p.net_delta);
    expect(p.ending_stack - p.starting_stack).toBe(p.net_delta + 500 + comm.d);
  }, 20000);

  it('P1-7: resolving a pending lifecycle row unblocks dealing without a restart', async () => {
    const { players, room, host } = await setupRoom(['c7a', 'c7b'], ['passive', 'passive']);
    srv.ctx.db.prepare('UPDATE rooms SET auto_deal = 0 WHERE id = ?').run(room.id);
    srv.ctx.db
      .prepare(
        "INSERT INTO hand_lifecycle (hand_id, room_id, status, created_at, updated_at) VALUES ('stale-cache-hand', ?, 'running', 1, 1)",
      )
      .run(room.id);
    host.errors = [];
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.errors.some((e) => /never settled|frozen/i.test(e)), 3000);
    // The operator resolves the row in the same process: the next deal must see
    // it (no stale startup cache).
    srv.ctx.db
      .prepare("UPDATE hand_lifecycle SET status = 'committed', resolved_at = ? WHERE hand_id = 'stale-cache-hand'")
      .run(Date.now());
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players, 15000);
    expect(players[0]!.handAbort).toBeNull();
  }, 20000);
});
