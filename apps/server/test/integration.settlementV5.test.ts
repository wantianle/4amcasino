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

describe('settlement lifecycle v5', () => {
  it('P0-1: when the banker is in the hand the rake is an explicit per-seat commissionDelta', async () => {
    const { players, room, host } = await setupRoom(['bankera', 'bankerb'], ['passive', 'passive']);
    // No platform account: rake falls back to the in-room banker (the host).
    srv.ctx.db.prepare("DELETE FROM meta WHERE key = 'platform_user_id'").run();
    srv.ctx.db.prepare('UPDATE rooms SET commission_bps = 500 WHERE id = ?').run(room.id);
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players, 15000);
    expect(host.handAbort).toBeNull();
    const end = host.handEnd!;
    const rake = end.commission ?? 0;
    expect(rake).toBeGreaterThan(0);

    // Per-seat contract: ending - starting === net_delta + wire commissionDelta.
    const proj = srv.ctx.db
      .prepare(
        'SELECT user_id, seat, starting_stack, ending_stack, net_delta FROM hand_players WHERE hand_id = ?',
      )
      .all(end.handId) as {
      user_id: number;
      seat: number;
      starting_stack: number;
      ending_stack: number;
      net_delta: number;
    }[];
    const comm = srv.ctx.db
      .prepare(
        "SELECT user_id, SUM(delta) AS d FROM ledger WHERE ref = ? AND kind = 'commission' GROUP BY user_id",
      )
      .all(end.head) as { user_id: number; d: number }[];
    const commByUser = new Map(comm.map((c) => [c.user_id, c.d]));
    expect(commByUser.size).toBe(1);
    expect([...commByUser.values()][0]).toBe(rake);
    const bankerId = (
      srv.ctx.db.prepare('SELECT banker_id FROM rooms WHERE id = ?').get(room.id) as {
        banker_id: number;
      }
    ).banker_id;
    const bankerSeat = proj.find((p) => p.user_id === bankerId)!.seat;
    // Direct wire assertion, not an inference from a ledger query.
    const commissionLeg = end.commissionDeltas ?? [];
    expect(commissionLeg).toEqual([{ seat: bankerSeat, delta: rake }]);
    // The PERSISTED transcript carries the same seat leg, so a historical
    // replay recovers the recipient seat without re-deriving it from stacks.
    const transcript = (await host.api(`/api/rooms/${room.id}/hands/${end.handId}`)) as {
      entries: { type: string; payload: Record<string, unknown> }[];
    };
    const settleEntry = transcript.entries.find((e) => e.type === 'settlement')!;
    expect(settleEntry.payload.commissionDeltas).toEqual(commissionLeg);
    expect(settleEntry.payload.commission).toBe(rake);
    const wireCommissionBySeat = new Map(commissionLeg.map((c) => [c.seat, c.delta]));
    for (const p of proj) {
      expect(p.ending_stack - p.starting_stack).toBe(
        p.net_delta + (wireCommissionBySeat.get(p.seat) ?? 0),
      );
    }
    // The game leg remains -rake zero-sum; the commission leg is +rake, and
    // because the recipient is in hand the aggregate is exactly zero.
    const gameSum = end.deltas.reduce((s, d) => s + d.delta, 0);
    const commissionSum = commissionLeg.reduce((s, d) => s + d.delta, 0);
    expect(gameSum).toBe(-rake);
    expect(commissionSum).toBe(rake);
    expect(gameSum + commissionSum).toBe(0); // recipient in hand
    // The rake never left the table: total hand stacks are conserved.
    expect(end.stacks.reduce((s, x) => s + x.stack, 0)).toBe(2000);
  }, 20000);

  it('P0-1: with an out-of-hand platform recipient every seat still reconciles net_delta', async () => {
    const { players, room, host } = await setupRoom(['plata', 'platb'], ['passive', 'passive']);
    const { userId: platformId } = createUser(srv.ctx.db, 'platformv5', 'c'.repeat(64), 'd'.repeat(64));
    setPlatformUserId(srv.ctx.db, platformId);
    srv.ctx.db.prepare('UPDATE rooms SET commission_bps = 500 WHERE id = ?').run(room.id);
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players, 15000);
    const end = host.handEnd!;
    const rake = end.commission ?? 0;
    expect(rake).toBeGreaterThan(0);
    expect(end.commissionDeltas ?? []).toHaveLength(0); // platform has no seat
    // The transcript agrees: with an out-of-hand recipient the seat leg is
    // empty, exactly like the live frame (the credit is the external ledger row).
    const transcript = (await host.api(`/api/rooms/${room.id}/hands/${end.handId}`)) as {
      entries: { type: string; payload: Record<string, unknown> }[];
    };
    const settleEntry = transcript.entries.find((e) => e.type === 'settlement')!;
    expect(settleEntry.payload.commissionDeltas).toEqual([]);
    expect(settleEntry.payload.commission).toBe(rake);

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
    // Conditional aggregate: sum(deltas) is always -rake, but with the
    // recipient out of hand the in-hand commission leg is empty, so the sum is
    // -rake (NOT 0). The credit lives on the external account's ledger row.
    const gameSum = end.deltas.reduce((s, d) => s + d.delta, 0);
    const commissionSum = (end.commissionDeltas ?? []).reduce((s, d) => s + d.delta, 0);
    expect(gameSum).toBe(-rake);
    expect(gameSum + commissionSum).toBe(-rake);
    const platformStack = srv.ctx.db
      .prepare('SELECT stack FROM room_players WHERE room_id = ? AND user_id = ?')
      .get(room.id, platformId) as { stack: number };
    expect(platformStack.stack).toBe(rake);
  }, 20000);

  it('P0-3: an unresolvable pre-lifecycle transcript is quarantined and freezes the room', async () => {
    const dir = mkdtempSync(join(tmpdir(), '4am-legacy-'));
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
      const { players, room, host } = await setupRoom(['lega', 'legb'], ['passive', 'passive']);
      // Simulate a database written before hand_lifecycle existed: a transcript
      // with no settlement marker and no reconcilable ledger/projection.
      srv.ctx.db
        .prepare(
          "INSERT INTO transcripts (hand_id, room_id, head, entries, ts) VALUES (?, ?, ?, '[]', ?)",
        )
        .run('legacy-hand-1', room.id, 'legacyhead', 1);
      for (const c of players) c.close();
      await app.app.close();

      // Reopen: the strict reconciliation cannot prove this hand settled, so it
      // is QUARANTINED (fail closed) rather than whitelisted as history.
      const restarted = createApp(dbPath);
      const row = restarted.db
        .prepare('SELECT status, last_error FROM hand_lifecycle WHERE hand_id = ?')
        .get('legacy-hand-1') as { status: string; last_error: string | null } | undefined;
      expect(row?.status).toBe('quarantined');
      expect(firstPendingHandLifecycle(restarted.db, room.id)).toBe('legacy-hand-1');

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

  it('P0-2: a rolled-back settlement leaves a durable running row that a graceful shutdown resolves', async () => {
    const dir = mkdtempSync(join(tmpdir(), '4am-rollback-'));
    const dbPath = join(dir, 'game.db');
    const saved = { ctx: srv.ctx, baseUrl: srv.baseUrl, hub: srv.hub };
    const app = createApp(dbPath);
    const appHub = attachHub(app.app, app.db, {
      cryptoTimeoutMs: 1500,
      actionTimeoutMs: 1500,
      autoDealMs: 3_600_000,
      readyCheckMs: 1500,
      showdownHoldMs: 400,
      settleHoldMs: 0,
      clock: srv.clock,
      faultInjection: {
        persist: (attempt) => {
          if (srv.fault.persistFailThrough >= attempt) throw new Error('injected persist failure');
        },
      },
    });
    await app.app.listen({ port: 0 });
    const addr = app.app.server.address() as AddressInfo;
    srv.ctx = app;
    srv.hub = appHub;
    srv.baseUrl = `http://127.0.0.1:${addr.port}`;
    try {
      const { players, room, host } = await setupRoom(['rba', 'rbb'], ['passive', 'passive']);
      srv.fault.persistFailThrough = 1000;
      srv.clock.freeze();
      host.send({ t: 'start_hand' });
      await host.waitFor(() => host.settlementFailures.length === 1, 8000);
      const handId = host.handId!;
      for (let i = 0; i < 4; i++) {
        srv.clock.advance(250);
        await host.waitFor(() => host.settlementFailures.length === i + 2, 3000);
      }
      expect(host.settlementFailures.at(-1)!.retrying).toBe(false);

      // The rollback left no transcript and no marker - the old detector saw
      // nothing - but the durable lifecycle row survived.
      expect(
        srv.ctx.db.prepare('SELECT 1 FROM hand_settlements WHERE hand_id = ?').get(handId),
      ).toBeUndefined();
      expect(srv.ctx.db.prepare('SELECT 1 FROM transcripts WHERE hand_id = ?').get(handId)).toBeUndefined();
      expect(
        srv.ctx.db.prepare('SELECT status FROM hand_lifecycle WHERE hand_id = ?').get(handId),
      ).toEqual({ status: 'running' });

      for (const c of players) c.close();
      // A graceful shutdown drains the frozen, never-settled hand: it is
      // aborted (no chips moved) so the room is not permanently frozen.
      await app.app.close();

      const restarted = createApp(dbPath);
      expect(
        restarted.db.prepare('SELECT status FROM hand_lifecycle WHERE hand_id = ?').get(handId),
      ).toEqual({ status: 'aborted' });
      expect(firstPendingHandLifecycle(restarted.db, room.id)).toBeNull();
      srv.fault.persistFailThrough = 0;
      const restartHub = attachHub(restarted.app, restarted.db, {
        cryptoTimeoutMs: 1500,
        actionTimeoutMs: 1500,
        autoDealMs: 3_600_000,
        readyCheckMs: 1500,
        showdownHoldMs: 0,
        settleHoldMs: 0,
        clock: srv.clock,
      });
      await restarted.app.listen({ port: 0 });
      const addr2 = restarted.app.server.address() as AddressInfo;
      srv.ctx = restarted;
      srv.hub = restartHub;
      srv.baseUrl = `http://127.0.0.1:${addr2.port}`;
      // The old DB lifecycle protocol resumes: a fresh hand deals and settles.
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
  }, 30000);

  it('P1-1/P1-2: a rolled-back 7-2 bounty is retryable, does not lock the room, and does not re-broadcast the show', async () => {
    const { players, room, host } = await setupRoom(['uha', 'uhb'], ['fold-first', 'passive']);
    srv.ctx.db.prepare('UPDATE rooms SET auto_deal = 0, seven_deuce_bonus = 25 WHERE id = ?').run(room.id);
    // Seat 1 (bob) is dealt 7-2 offsuit; the host folds, so bob wins by fold.
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

    srv.fault.sevenDeuceFailOnce = true;
    bob.showCards();
    await new Promise((r) => setTimeout(r, 200));
    // A known, retryable business failure: the room must not go unhealthy...
    expect(gameRoom.isUnhealthy()).toBe(false);
    // ...and the public `cards_shown` frame must not have been sent before the
    // payment committed (so a retry cannot duplicate it).
    expect(host.cardsShown).toHaveLength(0);

    bob.showCards();
    await host.waitFor(() => host.cardsShown.length === 1, 3000);
    expect(host.cardsShown).toHaveLength(1);
    expect(bob.cardsShown).toHaveLength(1);
    expect(gameRoom.isUnhealthy()).toBe(false);
  }, 20000);

  it('P1-1: a recoverable mark clears only on the exact verified reason and then deals again', async () => {
    const { players, room, host } = await setupRoom(['mha', 'mhb'], ['passive', 'passive']);
    srv.ctx.db.prepare('UPDATE rooms SET auto_deal = 0 WHERE id = ?').run(room.id);
    const gameRoom = srv.hub.rooms.get(room.id)!;
    gameRoom.markUnhealthy('settlement failed: busy', { recoverable: true });
    expect(gameRoom.isUnhealthy()).toBe(true);
    expect(gameRoom.clearUnhealthy('some other reason')).toBe(false);
    expect(gameRoom.isUnhealthy()).toBe(true);
    expect(gameRoom.clearUnhealthy('settlement failed: busy')).toBe(true);
    expect(gameRoom.isUnhealthy()).toBe(false);
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players, 15000);
    expect(players[0]!.handAbort).toBeNull();
  }, 20000);

  it('P1-1: an unknown (non-recoverable) mark is not clearable and stays fail-closed', async () => {
    const { room, host } = await setupRoom(['nra', 'nrb'], ['passive', 'passive']);
    srv.ctx.db.prepare('UPDATE rooms SET auto_deal = 0 WHERE id = ?').run(room.id);
    const gameRoom = srv.hub.rooms.get(room.id)!;
    gameRoom.markUnhealthy('TypeError: boom');
    expect(gameRoom.clearUnhealthy('TypeError: boom')).toBe(false);
    expect(gameRoom.isUnhealthy()).toBe(true);
    host.errors = [];
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.errors.some((e) => /held for an operator/i.test(e)), 3000);
    expect(host.handEnd).toBeNull();
  }, 20000);
});
