import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HeadlessClient } from '@4am/agent-core';
import { createApp } from '../src/app.js';
import { attachHub } from '../src/hub.js';
import { GONE_ABORT_GRACE_MS, type GameOpts } from '../src/game.js';

/**
 * P0-1 regression guard: the pre-betting disconnect grace must be
 * *reconnect-aware*. A player who drops during the shuffle/deal and reconnects
 * 1.5s / 2.5s / 4s later must keep their hand; only a client that stays offline
 * past the grace is aborted.
 *
 * This is a real end-to-end test: a real Fastify server, real WebSockets and a
 * real `HeadlessClient` (the same protocol/crypto/signature path a browser
 * uses). The grace is injected per test so the three reconnect tiers are
 * exercised deterministically instead of racing the production 4s boundary.
 */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(fn: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

interface Table {
  roomId: string;
  clients: HeadlessClient[];
}

const openApps: ReturnType<typeof createApp>[] = [];
const openClients: HeadlessClient[] = [];
let seq = 0;

afterEach(async () => {
  for (const c of openClients.splice(0)) {
    try {
      c.close();
    } catch {
      /* already gone */
    }
  }
  for (const app of openApps.splice(0)) await app.app.close();
});

/** Three real clients seated and funded at a fresh table. */
async function createTable(opts: Partial<GameOpts> = {}): Promise<Table> {
  const ctx = createApp(':memory:');
  openApps.push(ctx);
  attachHub(ctx.app, ctx.db, {
    cryptoTimeoutMs: 30_000,
    actionTimeoutMs: 30_000,
    // keep auto-deal out of the way: every hand here is started by hand
    autoDealMs: 60_000,
    readyCheckMs: 2_000,
    ...opts,
  });
  await ctx.app.listen({ host: '127.0.0.1', port: 0 });
  const baseUrl = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;

  const tag = `${Date.now().toString(36)}${(seq++).toString(36)}${randomBytes(2).toString('hex')}`;
  const clients = [0, 1, 2].map((i) => new HeadlessClient(baseUrl, `rg${tag}p${i}`, 'hunter2'));
  openClients.push(...clients);
  for (const c of clients) await c.login();

  const host = clients[0]!;
  const room = (await host.api('/api/rooms', { name: 'Grace', sb: 10, bb: 20, autoApproveBuys: false }, 'POST')) as {
    id: string;
    joinCode: string;
  };
  // the creator is already a member; the other two join by code
  for (const c of clients.slice(1)) await c.api('/api/rooms/join', { joinCode: room.joinCode });
  for (const c of clients) {
    const req = (await c.api(`/api/rooms/${room.id}/buy`, { amount: 1000 })) as { id: number };
    await host.api(`/api/rooms/${room.id}/approve`, { requestId: req.id, approve: true });
  }
  for (const [i, c] of clients.entries()) {
    await c.connect(room.id);
    c.send({ t: 'sit', seat: i });
  }
  await waitFor(
    () =>
      clients.every((c) =>
        c.room?.players.some((p) => p.userId === c.userId && p.seat !== null),
      ),
    5000,
    'all three clients seated',
  );
  return { roomId: room.id, clients };
}

describe('pre-betting reconnect grace is reconnect-aware', () => {
  // The production grace must stay generous enough for a real network blip
  // (the 2s regression is what this whole guard exists for).
  it('keeps the production grace at least at the 4s blip budget', () => {
    expect(GONE_ABORT_GRACE_MS).toBeGreaterThanOrEqual(4_000);
  });

  // The three reconnect tiers from the review: all land BEFORE the front door
  // of a real blip recovery, so none may abort the hand the player is rejoining.
  it.each([[1_500], [2_500], [4_000]])(
    'a player who reconnects %dms after dropping keeps their hand',
    async (delay) => {
      const { roomId, clients } = await createTable({ goneGraceMs: 6_000 });
      const host = clients[0]!;
      const victim = clients[2]!;
      const watcher = clients[1]!;

      host.send({ t: 'start_hand' });
      await waitFor(() => victim.handId !== null, 8_000, 'victim hand_start');
      // hand_start is broadcast before any crypto, so the hand is still
      // pre-betting (commit) when the socket drops - exactly the path guarded.
      expect(victim.betting).toBeNull();

      const t0 = Date.now();
      victim.close();
      await sleep(delay);
      await victim.connect(roomId);

      // Past the injected grace: if the abort timer had fired, the watcher
      // would already have seen it.
      const afterGrace = t0 + 6_000 + 1_500;
      while (Date.now() < afterGrace) await sleep(50);

      expect(watcher.abort).toBeNull();
      expect(victim.abort).toBeNull();
      expect(watcher.result).toBeNull();
    },
    30_000,
  );

  // Direct regression guard for the shipped 2s value: with the production
  // grace a 2.5s reconnect is well inside the window and must keep the hand.
  it('a 2.5s reconnect survives under the production grace', async () => {
    const { roomId, clients } = await createTable();
    const host = clients[0]!;
    const victim = clients[2]!;
    const watcher = clients[1]!;

    host.send({ t: 'start_hand' });
    await waitFor(() => victim.handId !== null, 8_000, 'victim hand_start');

    const t0 = Date.now();
    victim.close();
    await sleep(2_500);
    await victim.connect(roomId);

    // Past the production 4s grace: a 2s grace would have aborted at t0 + 2s.
    const afterGrace = t0 + GONE_ABORT_GRACE_MS + 1_500;
    while (Date.now() < afterGrace) await sleep(50);

    expect(watcher.abort).toBeNull();
    expect(victim.abort).toBeNull();
  }, 20_000);

  it('a player who stays offline past the grace aborts the hand', async () => {
    // No override: this exercises the production `GONE_ABORT_GRACE_MS`.
    const { clients } = await createTable();
    const host = clients[0]!;
    const victim = clients[2]!;
    const watcher = clients[1]!;

    host.send({ t: 'start_hand' });
    await waitFor(() => victim.handId !== null, 8_000, 'victim hand_start');

    const t0 = Date.now();
    victim.close();
    await waitFor(() => watcher.abort !== null, 9_000, 'hand_abort after the grace');

    expect(watcher.abort!.reason).toBe('player left during the deal');
    const elapsed = Date.now() - t0;
    // It waited the grace, not an immediate teardown...
    expect(elapsed).toBeGreaterThanOrEqual(3_500);
    // ...and it aborted well before the crypto timeout could blame the client.
    expect(elapsed).toBeLessThan(9_000);
  }, 20_000);
});
