import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
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
import { useIntegrationServer } from './helpers/integrationServer.js';

const srv = useIntegrationServer();

// Thin adapter onto the shared `setupRoom`, binding this file's server URL and
// client collector so the migrated call sites stay byte-identical.
const setupRoom = (names: string[], strategies: Strategy[] = []) =>
  createRoom(srv.baseUrl, names, strategies, srv.clients);

describe('auto-deal cadence', () => {
  it('with hub-default options the next hand starts promptly after settlement', async () => {
    // A second app wired exactly like production (hub defaults, no test timing
    // overrides) - the bug was that the hub never passed the short cadence, so
    // prod waited the 15s fallback plus a 20s ready check.
    const ctx2 = createApp(':memory:');
    attachHub(ctx2.app, ctx2.db, { cryptoTimeoutMs: 1500, actionTimeoutMs: 1500 });
    await ctx2.app.listen({ port: 0 });
    const addr = ctx2.app.server.address() as AddressInfo;
    const url = `http://127.0.0.1:${addr.port}`;
    const local: TestClient[] = [];
    try {
      for (const name of ['adp1', 'adp2']) {
        const c = new TestClient(url, name, 'fold-first');
        local.push(c);
        await c.register();
      }
      const host = local[0]!;
      const room = await host.api('/api/rooms', { name: 'AutoDeal', sb: 10, bb: 20 });
      for (const c of local.slice(1)) await c.api('/api/rooms/join', { joinCode: room.joinCode });
      for (const c of local) {
        const req = await c.api(`/api/rooms/${room.id}/buy`, { amount: 1000 });
        await host.api(`/api/rooms/${room.id}/approve`, { requestId: req.id, approve: true });
      }
      for (const [i, c] of local.entries()) {
        await c.connect(room.id);
        c.send({ t: 'sit', seat: i });
      }
      await new Promise((r) => setTimeout(r, 100));
      // everyone opts into server-side auto-ready: the ready check resolves instantly
      ctx2.db
        .prepare(`UPDATE users SET auto_ready = 1 WHERE id IN (${local.map(() => '?').join(',')})`)
        .run(...local.map((c) => c.userId));

      await host.api(`/api/rooms/${room.id}/settings`, { autoDeal: true }, 'PUT');
      // first auto-dealt hand
      await Promise.all(local.map((c) => c.waitFor(() => c.handEnd !== null, 12000)));
      const firstId = host.handEnd!.handId;

      const t0 = Date.now();
      await Promise.all(
        local.map((c) => c.waitFor(() => c.handEnd !== null && c.handEnd.handId !== firstId, 12000)),
      );
      const gap = Date.now() - t0;
      // old behaviour would be >=15s before the ready check even opened
      expect(gap).toBeLessThan(9000);
      expect(host.handAbort).toBeNull();
    } finally {
      for (const c of local) c.close();
      await ctx2.app.close();
    }
  }, 40000);
});
