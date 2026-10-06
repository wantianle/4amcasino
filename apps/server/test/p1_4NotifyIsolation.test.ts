import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { CardId } from '@4am/shared';
import { createApp } from '../src/app.js';
import { attachHub } from '../src/hub.js';
import { activeHands } from '../src/liveHands.js';
import { realClock, type GameOpts } from '../src/game.js';
import { TestClient } from './helpers/testClient.js';
import { setupRoom, awaitHandEnd } from './helpers/testRoom.js';

// ---------------------------------------------------------------------------
// P1-4: notifications & money isolation.
//
// The iron rule: a WS/room notification must never decide, roll back, or
// prevent a money transaction, and a notification failure must never mark the
// room unhealthy. These two tests are the direct evidence:
//
//   * the frame-order contract (transcript frames -> durable commit -> showdown
//     -> squid/7-2 -> hand_end) is asserted with the DB state sampled at the
//     exact moment each frame is handed to the transport;
//   * a publisher that throws on every settlement-path frame still leaves the
//     hand committed, the room healthy, and the terminal frame recoverable on
//     reconnect (`rememberHandEnd` ran after the failed broadcast).
// ---------------------------------------------------------------------------

type Live = { ctx: ReturnType<typeof createApp>; hub: ReturnType<typeof attachHub>; baseUrl: string };

async function startLive(): Promise<Live> {
  const ctx = createApp(':memory:');
  const opts: Partial<GameOpts> = {
    cryptoTimeoutMs: 1500,
    actionTimeoutMs: 1500,
    autoDealMs: 3_600_000,
    readyCheckMs: 1500,
    showdownHoldMs: 200,
    settleHoldMs: 0,
    ritVoteMs: 1500,
    clock: realClock,
  };
  const hub = attachHub(ctx.app, ctx.db, opts);
  await ctx.app.listen({ port: 0 });
  const addr = ctx.app.server.address() as AddressInfo;
  return { ctx, hub, baseUrl: `http://127.0.0.1:${addr.port}` };
}

function latestLifecycle(ctx: ReturnType<typeof createApp>, roomId: string): string | null {
  const row = ctx.db
    .prepare('SELECT status FROM hand_lifecycle WHERE room_id = ? ORDER BY rowid DESC LIMIT 1')
    .get(roomId) as { status: string } | undefined;
  return row?.status ?? null;
}

function settlementMarkers(ctx: ReturnType<typeof createApp>, handId: string): number {
  return (
    ctx.db.prepare('SELECT COUNT(*) AS n FROM hand_settlements WHERE hand_id = ?').get(handId) as {
      n: number;
    }
  ).n;
}

const SETTLEMENT_FRAMES = new Set(['showdown', 'squid_result', 'seven_deuce', 'hand_end']);

describe('P1-4: notification isolation', () => {
  const clients: TestClient[] = [];
  afterEach(() => {
    for (const c of clients.splice(0)) c.close();
  });

  it('frame order is unchanged: transcript frames -> durable commit -> showdown -> hand_end', async () => {
    const { ctx, hub, baseUrl } = await startLive();
    try {
      const { room, host, players } = await setupRoom(
        baseUrl,
        ['foa', 'fob'],
        ['passive', 'passive'],
        clients,
      );
      const gameRoom = hub.rooms.get(room.id)!;
      const seen: { frame: string; committed: string | null; markers: number }[] = [];
      const orig = gameRoom.broadcast.bind(gameRoom);
      gameRoom.broadcast = (msg) => {
        const frame = msg.t === 'transcript_entry' ? `transcript:${msg.type}` : msg.t;
        const handId = host.handId;
        seen.push({
          frame,
          committed: latestLifecycle(ctx, room.id),
          markers: handId ? settlementMarkers(ctx, handId) : 0,
        });
        orig(msg);
      };

      host.send({ t: 'start_hand' });
      await awaitHandEnd(players, 15000);
      const handId = host.handEnd!.handId;

      const transcriptAt = seen.findIndex((s) => s.frame === 'transcript:settlement');
      const showdownAt = seen.findIndex((s) => s.frame === 'showdown');
      const endAt = seen.findIndex((s) => s.frame === 'hand_end');
      expect(transcriptAt).toBeGreaterThanOrEqual(0);
      expect(showdownAt).toBeGreaterThan(transcriptAt);
      expect(endAt).toBeGreaterThan(showdownAt);

      // The durable commit is already visible at the exact moment the reveal
      // (and, later, the terminal) frame is handed to the transport.
      expect(seen[showdownAt]!.markers).toBe(1);
      expect(seen[showdownAt]!.committed).toBe('committed');
      expect(seen[endAt]!.markers).toBe(1);
      expect(seen[endAt]!.committed).toBe('committed');
      // Every `hand_end` is the last settlement frame; nothing reordered after it.
      expect(gameRoom.isUnhealthy()).toBe(false);
    } finally {
      await ctx.app.close();
    }
  }, 30000);

  it('a throwing publisher cannot prevent or undo a settlement, and the frame stays recoverable', async () => {
    const { ctx, hub, baseUrl } = await startLive();
    try {
      const { room, host, players } = await setupRoom(
        baseUrl,
        ['pia', 'pib'],
        ['passive', 'passive'],
        clients,
      );
      const gameRoom = hub.rooms.get(room.id)!;
      const orig = gameRoom.broadcast.bind(gameRoom);
      gameRoom.broadcast = (msg) => {
        // The publisher throws on every settlement-path notification. Gameplay
        // frames still flow, so the hand can actually reach settlement.
        if (
          SETTLEMENT_FRAMES.has(msg.t) ||
          (msg.t === 'transcript_entry' && msg.type === 'settlement')
        ) {
          throw new Error(`injected publisher failure: ${msg.t}`);
        }
        orig(msg);
      };

      host.send({ t: 'start_hand' });
      await host.waitFor(
        () =>
          latestLifecycle(ctx, room.id) === 'committed' &&
          settlementMarkers(ctx, host.handId ?? '') === 1,
        15000,
      );
      const handId = host.handId!;

      expect(latestLifecycle(ctx, room.id)).toBe('committed');
      expect(settlementMarkers(ctx, handId)).toBe(1);
      // The notification failure was isolated: no unhealthy mark.
      expect(gameRoom.isUnhealthy()).toBe(false);
      expect(host.handEnd).toBeNull(); // the live frame really was lost
      // Let the post-commit reveal hold elapse and the hand wind down
      // (`onDone`), which also proves the swallowed `hand_end` throw did not
      // stop teardown.
      await host.waitFor(() => !activeHands.has(room.id), 8000);

      // `rememberHandEnd` ran after the failed broadcast, so a reconnect still
      // receives the exact retained terminal frame via `room.send` (unaffected
      // by the broadcast patch).
      host.disconnect();
      await host.connect(room.id);
      await host.waitFor(() => host.handEnd?.handId === handId, 5000);
      expect(host.handEnd!.handId).toBe(handId);

      // onDone ran: the room released the hand and can deal again.
      host.errors = [];
      host.send({ t: 'start_hand' });
      await host.waitFor(() => host.handId !== null && host.handId !== handId, 10000);
      expect(activeHands.has(room.id)).toBe(true);
    } finally {
      await ctx.app.close();
    }
  }, 30000);

  // 3b/3c: a NON-settlement frame dropped mid-hand. There is no per-frame
  // transcript catch-up; the reconnect resync is the repair path. This test
  // pins that the loss is (a) really lost in real time while connected and
  // (b) fully repaired from authoritative state on reconnect, with the hand
  // still settling. It also documents the boundary: only replayed state is
  // recovered, not the dropped live frame itself.
  it('a dropped non-settlement frame is repaired from authoritative state on reconnect', async () => {
    const { ctx, hub, baseUrl } = await startLive();
    try {
      const { room, host, players } = await setupRoom(
        baseUrl,
        ['sra', 'srb'],
        ['passive', 'passive'],
        clients,
      );
      const gameRoom = hub.rooms.get(room.id)!;
      const orig = gameRoom.broadcast.bind(gameRoom);
      // Drop the flop's three `board_open` frames, then let the rest flow. These
      // are ordinary (non-settlement) frames, so the isolation rule applies: the
      // loss is logged and swallowed and the hand keeps running.
      const dropped: CardId[] = [];
      let flopDropped = false;
      gameRoom.broadcast = (msg) => {
        if (!flopDropped && msg.t === 'board_open') {
          dropped.push(msg.card);
          if (dropped.length === 3) flopDropped = true;
          throw new Error(`injected non-settlement drop: board_open ${msg.card}`);
        }
        orig(msg);
      };

      host.send({ t: 'start_hand' });
      await host.waitFor(() => flopDropped, 15000);
      // Real-time gap: the live frame was lost, so the still-connected client
      // has no flop.
      expect(host.board).toEqual([]);

      // Reconnect. `resendPending` -> `replayPublicState` replays the board via
      // the per-socket `send`, which the broadcast patch never touches.
      host.disconnect();
      await host.connect(room.id);
      await host.waitFor(() => host.board.length >= 3, 5000);
      // The replayed board is exactly the frames the live broadcast dropped.
      expect(host.board.slice(0, 3).sort()).toEqual([...dropped].sort());

      // The hand still reaches a committed settlement, so the dropped frame
      // neither stalled nor unwound it.
      await awaitHandEnd(players, 15000);
      expect(host.handEnd).not.toBeNull();
      expect(latestLifecycle(ctx, room.id)).toBe('committed');
      expect(gameRoom.isUnhealthy()).toBe(false);
    } finally {
      await ctx.app.close();
    }
  }, 30000);

  // 3a: the publisher's tiers. A programming error (TypeError and friends) is
  // reported distinctly from an ordinary delivery failure, yet is still
  // swallowed - so the "a notification bug must never unwind settlement" rule
  // holds for the unexpected tier too.
  it('a programming error in a frame is logged distinctly and still isolated', async () => {
    const { ctx, hub, baseUrl } = await startLive();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { room, host, players } = await setupRoom(
        baseUrl,
        ['tpa', 'tpb'],
        ['passive', 'passive'],
        clients,
      );
      const gameRoom = hub.rooms.get(room.id)!;
      const orig = gameRoom.broadcast.bind(gameRoom);
      let injected = false;
      gameRoom.broadcast = (msg) => {
        if (!injected && msg.t === 'board_open') {
          injected = true;
          throw new TypeError('injected programming error: circular frame');
        }
        orig(msg);
      };

      host.send({ t: 'start_hand' });
      await awaitHandEnd(players, 15000);
      expect(injected).toBe(true);
      expect(latestLifecycle(ctx, room.id)).toBe('committed');
      expect(gameRoom.isUnhealthy()).toBe(false);
      const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('unexpected programming error, not a delivery failure');
    } finally {
      errSpy.mockRestore();
      await ctx.app.close();
    }
  }, 30000);
});
