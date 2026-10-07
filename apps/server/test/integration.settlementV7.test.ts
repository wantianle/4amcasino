import { describe, expect, it } from 'vitest';
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
import { awaitHandEnd } from './helpers/testRoom.js';
import { useIntegrationServer } from './helpers/integrationServer.js';

const srv = useIntegrationServer();

// Thin adapter onto the shared `setupRoom`, binding this file's server URL and
// client collector so the migrated call sites stay byte-identical.
const setupRoom = (names: string[], strategies: Strategy[] = []) =>
  createRoom(srv.baseUrl, names, strategies, srv.clients);

describe('settlement lifecycle v7', () => {
  const playOneHand = async (
    names: [string, string],
    strategies: [Strategy, Strategy] = ['passive', 'passive'],
  ) => {
    const { players, room, host } = await setupRoom(names, strategies);
    srv.ctx.db.prepare('UPDATE rooms SET auto_deal = 0 WHERE id = ?').run(room.id);
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players, 15000);
    expect(players[0]!.handAbort).toBeNull();
    return { players, room, host };
  };
  /** Drop the settlement marker and lifecycle row: exactly the state a database
   *  written by the pre-lifecycle protocol is in. */
  const makePreLifecycle = (handId: string) => {
    srv.ctx.db.prepare('DELETE FROM hand_settlements WHERE hand_id = ?').run(handId);
    srv.ctx.db.prepare('DELETE FROM hand_lifecycle WHERE hand_id = ?').run(handId);
  };
  const lifecycleRow = (handId: string) =>
    srv.ctx.db.prepare('SELECT status, last_error FROM hand_lifecycle WHERE hand_id = ?').get(handId) as
      | { status: string; last_error: string | null }
      | undefined;

  it('P0-2: a fully reconciled historical hand is committed (not frozen) and the dry run is read-only', async () => {
    const { host, room } = await playOneHand(['ra', 'rb']);
    const handId = host.handEnd!.handId;
    makePreLifecycle(handId);

    // Dry run first: it sees one markerless transcript and reconciles it.
    const audit = auditMarkerlessTranscripts(srv.ctx.db);
    expect(audit.transcripts).toBe(1);
    expect(audit.markerless).toBe(1);
    expect(audit.reconciled).toBe(1);
    expect(audit.quarantined).toEqual([]);
    // read-only: the dry run wrote nothing
    expect(lifecycleRow(handId)).toBeUndefined();

    reconcileMissingSettlements(srv.ctx.db);
    expect(lifecycleRow(handId)).toEqual({ status: 'committed', last_error: 'legacy reconciled' });
    expect(firstPendingHandLifecycle(srv.ctx.db, room.id)).toBeNull();

    // The removed `legacy` status is re-reconciled on the next pass (the old
    // "flag already exists -> no-op" hole is gone).
    srv.ctx.db.prepare("UPDATE hand_lifecycle SET status = 'legacy' WHERE hand_id = ?").run(handId);
    reconcileMissingSettlements(srv.ctx.db);
    expect(lifecycleRow(handId)?.status).toBe('committed');
  }, 25000);

  it('P0-2: a missing settlement leg quarantines the hand and freezes the room', async () => {
    // fold-first makes the poker outcome deterministic: the folder loses the
    // blind and the other seat wins it, so this hand ALWAYS commits two
    // non-zero `hand-settlement` legs. (A passive check-down hand can net a
    // player to exactly zero - the writer skips a zero delta - which is what
    // made the old MIN(id) fixture depend on a random deal.)
    const { host, room } = await playOneHand(['qa', 'qb'], ['fold-first', 'passive']);
    const handId = host.handEnd!.handId;
    const head = host.handEnd!.head;
    makePreLifecycle(handId);
    // Pick a REAL non-zero hand-settlement leg, assert it exists, then delete
    // exactly it: removing one non-zero leg leaves the per-hand sum
    // `-rake - delta != -rake`, so the reconciliation must quarantine. Asserting
    // `changes === 1` prevents a NULL subquery from turning the delete into a
    // silent no-op (the previous flake).
    const legs = srv.ctx.db
      .prepare(
        "SELECT id, delta FROM ledger WHERE room_id = ? AND ref = ? AND kind = 'hand-settlement' ORDER BY id",
      )
      .all(room.id, head) as { id: number; delta: number }[];
    expect(legs.length).toBeGreaterThan(0);
    expect(legs[0]!.delta).not.toBe(0);
    const removed = srv.ctx.db.prepare('DELETE FROM ledger WHERE id = ?').run(legs[0]!.id);
    expect(removed.changes).toBe(1);

    const audit = auditMarkerlessTranscripts(srv.ctx.db);
    expect(audit.reconciled).toBe(0);
    expect(audit.quarantined).toHaveLength(1);
    expect(audit.quarantined[0]!.reason).toMatch(/hand-settlement legs sum/);

    reconcileMissingSettlements(srv.ctx.db);
    expect(lifecycleRow(handId)?.status).toBe('quarantined');
    expect(firstPendingHandLifecycle(srv.ctx.db, room.id)).toBe(handId);
    // Frozen: the next deal is refused while the quarantined row stands.
    host.errors = [];
    host.send({ t: 'start_hand' });
    await host.waitFor(() => host.errors.some((e) => /never settled|frozen/i.test(e)), 3000);
  }, 25000);

  it('P0-2: a head that does not match the transcript chain quarantines the hand', async () => {
    const { host, room } = await playOneHand(['ha', 'hb']);
    const handId = host.handEnd!.handId;
    makePreLifecycle(handId);
    srv.ctx.db.prepare('UPDATE transcripts SET head = ? WHERE hand_id = ?').run('deadbeef', handId);
    const audit = auditMarkerlessTranscripts(srv.ctx.db);
    expect(audit.reconciled).toBe(0);
    expect(audit.quarantined[0]!.reason).toMatch(/head does not match|legs sum/);
    reconcileMissingSettlements(srv.ctx.db);
    expect(firstPendingHandLifecycle(srv.ctx.db, room.id)).toBe(handId);
  }, 25000);

  it('P0-2: a missing stats projection quarantines the hand', async () => {
    const { host, room } = await playOneHand(['pa', 'pb']);
    const handId = host.handEnd!.handId;
    makePreLifecycle(handId);
    srv.ctx.db.prepare('DELETE FROM hand_players WHERE hand_id = ?').run(handId);
    const audit = auditMarkerlessTranscripts(srv.ctx.db);
    expect(audit.reconciled).toBe(0);
    expect(audit.quarantined[0]!.reason).toMatch(/no hand_players projection rows/);
    reconcileMissingSettlements(srv.ctx.db);
    expect(firstPendingHandLifecycle(srv.ctx.db, room.id)).toBe(handId);
  }, 25000);

  // --- v8 hardening: the reconciliation must not trust self-consistent fakes ---

  /** Insert a raw ledger leg; every negative test re-chains afterwards so the
   *  ONLY failing rule is the one under test. */
  const addLeg = (roomId: string, userId: number, delta: number, kind: string, ref: string) =>
    srv.ctx.db
      .prepare(
        "INSERT INTO ledger (room_id,user_id,delta,kind,ref,ts,prev_hash,entry_hash) VALUES (?,?,?,?,?,?,'seed','seed')",
      )
      .run(roomId, userId, delta, kind, ref, Date.now());

  const playerIds = (roomId: string): number[] =>
    (
      srv.ctx.db
        .prepare('SELECT user_id FROM room_players WHERE room_id = ? ORDER BY user_id')
        .all(roomId) as { user_id: number }[]
    ).map((r) => r.user_id);

  const playRakeHand = async (names: [string, string]) => {
    const { players, room, host } = await setupRoom(names, ['passive', 'passive']);
    // No platform account: the rake falls back to the in-room banker and the
    // hand has a real commission leg.
    srv.ctx.db.prepare("DELETE FROM meta WHERE key = 'platform_user_id'").run();
    srv.ctx.db
      .prepare('UPDATE rooms SET auto_deal = 0, commission_bps = 500 WHERE id = ?')
      .run(room.id);
    host.send({ t: 'start_hand' });
    await awaitHandEnd(players, 15000);
    expect(players[0]!.handAbort).toBeNull();
    expect(host.handEnd!.commission ?? 0).toBeGreaterThan(0);
    return { players, room, host };
  };

  const corruptCommission = (handId: string, value: unknown) => {
    const row = srv.ctx.db
      .prepare('SELECT entries FROM transcripts WHERE hand_id = ?')
      .get(handId) as { entries: string };
    const entries = JSON.parse(row.entries) as { type?: string; payload?: Record<string, unknown> }[];
    const settlement = entries.find((e) => e.type === 'settlement')!;
    settlement.payload!.commission = value;
    srv.ctx.db
      .prepare('UPDATE transcripts SET entries = ? WHERE hand_id = ?')
      .run(JSON.stringify(entries), handId);
  };

  it('v8/项2: a hand-settlement leg for a user outside hand_players is rejected', async () => {
    const { host, room } = await playOneHand(['e2a', 'e2b']);
    const handId = host.handEnd!.handId;
    const head = host.handEnd!.head;
    makePreLifecycle(handId);
    // A self-consistent pair of external legs: the sum stays -rake and the
    // projection players are untouched, so only the participant rule catches it.
    addLeg(room.id, 90001, 100, 'hand-settlement', head);
    addLeg(room.id, 90002, -100, 'hand-settlement', head);
    rechainRoom(srv.ctx.db, room.id);
    const audit = auditMarkerlessTranscripts(srv.ctx.db);
    expect(audit.quarantined[0]?.reason).toMatch(/is not a seat in this hand/);
    reconcileMissingSettlements(srv.ctx.db);
    expect(lifecycleRow(handId)?.status).toBe('quarantined');
  }, 25000);

  it('v9/项2d: a non-seven-deuce leg on the hand-id ref is rejected', async () => {
    const wrong: [string, string][] = [
      ['commission', 'cc'],
      ['hand-settlement', 'hh'],
      ['squid-game', 'ss'],
    ];
    for (const [kind, tag] of wrong) {
      const { host, room } = await playOneHand([`q9${tag}`, `r9${tag}`]);
      const handId = host.handEnd!.handId;
      makePreLifecycle(handId);
      addLeg(room.id, playerIds(room.id)[0]!, 10, kind, handId);
      rechainRoom(srv.ctx.db, room.id);
      const audit = auditMarkerlessTranscripts(srv.ctx.db);
      expect(audit.quarantined[0]?.reason).toMatch(/unexpected ledger kind .* on the hand-id ref/);
      reconcileMissingSettlements(srv.ctx.db);
      expect(lifecycleRow(handId)?.status).toBe('quarantined');
      srv.ctx.db.prepare('DELETE FROM transcripts WHERE hand_id = ?').run(handId);
    }
  }, 40000);

  it('v9/项2d: a historical peek leg on the hand-id ref is tolerated (feature removed 2026-10-08)', async () => {
    const { host, room } = await playOneHand(['q9pk', 'r9pk']);
    const handId = host.handEnd!.handId;
    makePreLifecycle(handId);
    // A retired paid-peek transfer, exactly as historical hands wrote it: a
    // balanced pair under the hand-id ref. It must be tolerated (the feature is
    // gone, but old rows remain) and the hand must still reconcile to committed.
    const [u1, u2] = playerIds(room.id);
    addLeg(room.id, u1!, 2, 'peek', handId);
    addLeg(room.id, u2!, -2, 'peek', handId);
    rechainRoom(srv.ctx.db, room.id);

    const audit = auditMarkerlessTranscripts(srv.ctx.db);
    expect(audit.quarantined).toEqual([]);
    expect(audit.reconciled).toBe(1);
    reconcileMissingSettlements(srv.ctx.db);
    expect(lifecycleRow(handId)?.status).toBe('committed');
  }, 25000);

  it('v9/项2d: a seven-deuce leg on the settlement-head ref is rejected', async () => {
    const { host, room } = await playOneHand(['q9sd', 'r9sd']);
    const handId = host.handEnd!.handId;
    const head = host.handEnd!.head;
    makePreLifecycle(handId);
    addLeg(room.id, playerIds(room.id)[0]!, 10, 'seven-deuce', head);
    rechainRoom(srv.ctx.db, room.id);
    const audit = auditMarkerlessTranscripts(srv.ctx.db);
    expect(audit.quarantined[0]?.reason).toMatch(
      /unexpected ledger kind 'seven-deuce' on the settlement head/,
    );
    reconcileMissingSettlements(srv.ctx.db);
    expect(lifecycleRow(handId)?.status).toBe('quarantined');
  }, 25000);


  it('v8/项3: two commission recipients are rejected (single-rake-recipient contract)', async () => {
    const { host, room } = await playRakeHand(['c3a', 'c3b']);
    const handId = host.handEnd!.handId;
    const head = host.handEnd!.head;
    const legs = srv.ctx.db
      .prepare(
        "SELECT user_id, delta FROM ledger WHERE room_id = ? AND ref = ? AND kind = 'commission'",
      )
      .all(room.id, head) as { user_id: number; delta: number }[];
    expect(legs).toHaveLength(1);
    const total = legs[0]!.delta;
    const others = playerIds(room.id).filter((u) => u !== legs[0]!.user_id);
    makePreLifecycle(handId);
    srv.ctx.db
      .prepare("DELETE FROM ledger WHERE room_id = ? AND ref = ? AND kind = 'commission'")
      .run(room.id, head);
    const half = Math.floor(total / 2);
    addLeg(room.id, legs[0]!.user_id, half, 'commission', head);
    addLeg(room.id, others[0]!, total - half, 'commission', head);
    rechainRoom(srv.ctx.db, room.id);
    const audit = auditMarkerlessTranscripts(srv.ctx.db);
    expect(audit.quarantined[0]?.reason).toMatch(/exactly one commission leg/);
    reconcileMissingSettlements(srv.ctx.db);
    expect(lifecycleRow(handId)?.status).toBe('quarantined');
  }, 25000);

  it('v8/项4a: a duplicate seven-deuce leg on the hand-id ref is rejected', async () => {
    const { host, room } = await playOneHand(['d4a', 'd4b']);
    const handId = host.handEnd!.handId;
    makePreLifecycle(handId);
    const [u1] = playerIds(room.id);
    // Duplicate is only catchable when the hand-id ref is covered too.
    addLeg(room.id, u1!, 25, 'seven-deuce', handId);
    addLeg(room.id, u1!, 25, 'seven-deuce', handId);
    rechainRoom(srv.ctx.db, room.id);
    const audit = auditMarkerlessTranscripts(srv.ctx.db);
    expect(audit.quarantined[0]?.reason).toMatch(/duplicate seven-deuce leg/);
    reconcileMissingSettlements(srv.ctx.db);
    expect(lifecycleRow(handId)?.status).toBe('quarantined');
  }, 25000);

  it('v8/项4b: a seven-deuce winner not funded by its payers is rejected', async () => {
    const { host, room } = await playOneHand(['d4c', 'd4d']);
    const handId = host.handEnd!.handId;
    makePreLifecycle(handId);
    const [u1, u2] = playerIds(room.id);
    addLeg(room.id, u1!, 100, 'seven-deuce', handId); // winner
    addLeg(room.id, u2!, -50, 'seven-deuce', handId); // payer underpays
    rechainRoom(srv.ctx.db, room.id);
    const audit = auditMarkerlessTranscripts(srv.ctx.db);
    expect(audit.quarantined[0]?.reason).toMatch(/seven-deuce payers 50 != winner 100/);
    reconcileMissingSettlements(srv.ctx.db);
    expect(lifecycleRow(handId)?.status).toBe('quarantined');
  }, 25000);

  it('v8/项5: a projection from a different room is rejected', async () => {
    const { host, room } = await playOneHand(['e5a', 'e5b']);
    const handId = host.handEnd!.handId;
    makePreLifecycle(handId);
    srv.ctx.db.prepare('UPDATE hands SET room_id = ? WHERE hand_id = ?').run('other-room', handId);
    const audit = auditMarkerlessTranscripts(srv.ctx.db);
    expect(audit.quarantined[0]?.reason).toMatch(/projection room_id .* != transcript room_id/);
    reconcileMissingSettlements(srv.ctx.db);
    expect(lifecycleRow(handId)?.status).toBe('quarantined');
  }, 25000);

  it('v8/项6: a fractional or negative rake is rejected', async () => {
    for (const bad of [1.5, -5, '5']) {
      const { host, room } = await playOneHand([`r6${String(bad).length}`, `s6${String(bad).length}`]);
      const handId = host.handEnd!.handId;
      makePreLifecycle(handId);
      corruptCommission(handId, bad);
      const audit = auditMarkerlessTranscripts(srv.ctx.db);
      expect(audit.quarantined[0]?.reason).toMatch(/commission is not a non-negative integer/);
      reconcileMissingSettlements(srv.ctx.db);
      expect(lifecycleRow(handId)?.status).toBe('quarantined');
      srv.ctx.db.prepare('DELETE FROM transcripts WHERE hand_id = ?').run(handId);
    }
  }, 40000);

  it('v8/项7: a consistent marker overrides a stale running/quarantined/legacy/aborted row', async () => {
    for (const stale of ['running', 'prepared', 'quarantined', 'legacy', 'aborted'] as const) {
      const { host, room } = await playOneHand([`m7${stale[0]}`, `n7${stale[0]}`]);
      const handId = host.handEnd!.handId;
      // The hand actually settled (marker present); force a stale lifecycle row.
      srv.ctx.db
        .prepare(
          `INSERT INTO hand_lifecycle (hand_id, room_id, status, created_at, updated_at, resolved_at)
           VALUES (?, ?, ?, 1, 1, NULL)
           ON CONFLICT(hand_id) DO UPDATE SET status = excluded.status, resolved_at = NULL`,
        )
        .run(handId, room.id, stale);
      expect(firstPendingHandLifecycle(srv.ctx.db, room.id)).toBe(
        stale === 'legacy' || stale === 'aborted' ? null : handId,
      );
      reconcileMissingSettlements(srv.ctx.db);
      expect(lifecycleRow(handId)?.status).toBe('committed');
      expect(firstPendingHandLifecycle(srv.ctx.db, room.id)).toBeNull();
      srv.ctx.db.prepare('DELETE FROM transcripts WHERE hand_id = ?').run(handId);
    }
  }, 40000);

  it('v8/项7: a marker that disagrees with the transcript is quarantined, not trusted', async () => {
    const { host, room } = await playOneHand(['m7x', 'n7x']);
    const handId = host.handEnd!.handId;
    srv.ctx.db.prepare('UPDATE hand_settlements SET head = ? WHERE hand_id = ?').run('wrong', handId);
    const audit = auditMarkerlessTranscripts(srv.ctx.db);
    expect(audit.markerConflicts).toHaveLength(1);
    expect(audit.markerConflicts[0]!.reason).toMatch(/marker disagrees/);
    reconcileMissingSettlements(srv.ctx.db);
    expect(lifecycleRow(handId)?.status).toBe('quarantined');
    expect(firstPendingHandLifecycle(srv.ctx.db, room.id)).toBe(handId);
  }, 25000);

  it('P0-3: the real app.close() path drains a live hand before it resolves and terminates the sockets', async () => {
    const dir = mkdtempSync(join(tmpdir(), '4am-close-'));
    const dbPath = join(dir, 'game.db');
    const saved = { ctx: srv.ctx, baseUrl: srv.baseUrl, hub: srv.hub };
    const app = createApp(dbPath);
    const appHub = attachHub(app.app, app.db, {
      cryptoTimeoutMs: 1500,
      actionTimeoutMs: 1500,
      autoDealMs: 3_600_000,
      readyCheckMs: 1500,
      shutdownDrainMs: 100,
      clock: srv.clock,
    });
    await app.app.listen({ port: 0 });
    const addr = app.app.server.address() as AddressInfo;
    srv.ctx = app;
    srv.hub = appHub;
    srv.baseUrl = `http://127.0.0.1:${addr.port}`;
    try {
      const { players, room, host } = await setupRoom(['dca', 'dcb'], ['passive', 'passive']);
      players[1]!.respondShares = false; // a stuck hand the drain must abort
      host.send({ t: 'start_hand' });
      await host.waitFor(() => host.handId !== null, 5000);
      const handId = host.handId!;

      // The REAL deployment path: close the Fastify app with the websockets
      // still open. Its preClose hook must drain the rooms and only then let
      // the server close.
      await app.app.close();

      const probe = new Database(dbPath, { readonly: true });
      const row = probe
        .prepare('SELECT status FROM hand_lifecycle WHERE hand_id = ?')
        .get(handId) as { status: string } | undefined;
      probe.close();
      expect(row?.status).toBe('aborted');
      // The sockets were terminated as part of the same close.
      await host.waitFor(() => players[0]!.ws.readyState === WebSocket.CLOSED, 3000);
      expect(players[0]!.ws.readyState).toBe(WebSocket.CLOSED);

      // Restart: the room is not frozen and can deal again.
      const restarted = createApp(dbPath);
      expect(firstPendingHandLifecycle(restarted.db, room.id)).toBeNull();
      const nextHub = attachHub(restarted.app, restarted.db, {
        cryptoTimeoutMs: 1500,
        actionTimeoutMs: 1500,
        autoDealMs: 3_600_000,
        readyCheckMs: 1500,
        shutdownDrainMs: 100,
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
  }, 60000);
});
