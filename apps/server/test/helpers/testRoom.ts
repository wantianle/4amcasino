import { TestClient, type Strategy } from './testClient.js';

/**
 * Room/table scenario builders for the WebSocket server suite. `setupRoom`
 * was the `setupRoom` helper in `integration.test.ts:796-813`; `startHand`,
 * `awaitDeal` and `awaitHandEnd` were inline snippets repeated dozens of times
 * in the same file.
 */

/**
 * Register `names`, open one table, buy each player in, seat them in order and
 * connect their sockets. Copied verbatim from `integration.test.ts:796-813`
 * with the test-module `baseUrl` and `clients` bag lifted into parameters.
 *
 * @param baseUrl  URL of the booted test server.
 * @param names    Player usernames, in seat order; index 0 is the host.
 * @param strategies  Per-player betting strategy (defaults to `passive`).
 * @param clients  Optional collector the created clients are pushed onto, so
 *                 the caller can close them in `afterEach`.
 */
export async function setupRoom(
  baseUrl: string,
  names: string[],
  strategies: Strategy[] = [],
  clients?: TestClient[],
) {
  const players = names.map((n, i) => new TestClient(baseUrl, n, strategies[i] ?? 'passive'));
  clients?.push(...players);
  for (const p of players) await p.register();
  const host = players[0]!;
  const room = await host.api('/api/rooms', { name: 'Test', sb: 10, bb: 20 });
  for (const p of players.slice(1)) await p.api('/api/rooms/join', { joinCode: room.joinCode });
  for (const p of players) {
    const req = await p.api(`/api/rooms/${room.id}/buy`, { amount: 1000 });
    await host.api(`/api/rooms/${room.id}/approve`, { requestId: req.id, approve: true });
  }
  for (const [i, p] of players.entries()) {
    await p.connect(room.id);
    p.send({ t: 'sit', seat: i });
  }
  await new Promise((r) => setTimeout(r, 100)); // let sits settle
  return { players, room, host };
}

/** Ask the host's server to deal a hand. Mirror of the inline
 *  `host.send({ t: 'start_hand' })` used throughout `integration.test.ts`. */
export function startHand(host: TestClient): void {
  host.send({ t: 'start_hand' });
}

/** Wait until every client has seen the new hand's `hand_start`
 *  (`handId !== null`), matching `integration.test.ts:1012`. */
export async function awaitDeal(players: TestClient[], ms = 15000): Promise<void> {
  await Promise.all(players.map((p) => p.waitFor(() => p.handId !== null, ms)));
}

/** Wait until every client has seen `hand_end` for the current hand, matching
 *  the dominant `Promise.all(players.map((p) => p.waitFor(() => p.handEnd !==
 *  null)))` pattern in `integration.test.ts`. */
export async function awaitHandEnd(players: TestClient[], ms = 15000): Promise<void> {
  await Promise.all(players.map((p) => p.waitFor(() => p.handEnd !== null, ms)));
}
