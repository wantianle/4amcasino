import { afterEach, describe, expect, it } from 'vitest';
import { TestClient } from './helpers/testClient.js';
import { useIntegrationServer } from './helpers/integrationServer.js';

/**
 * The sit-path half of the table-with-bots cap: a human sitting may push
 * seated humans + seated bots over MAX_TABLE_PLAYERS_WITH_BOTS, so `GameRoom`'s
 * `sit` handler evicts random SEATED bots through the ordinary removal path.
 * Verified over the real WS (nothing short of that proves the handler is wired), with the DB as the
 * authority for the resulting seat counts.
 *
 * NOTE: this is the ORCHESTRATOR'S INFERENCE (the user's "randomly remove one
 * bot" answer was about the pre-existing over-cap room). If the intended
 * semantics are "only the create route is capped, humans may overfill", revert
 * the `evictOverCapBots(...)` call in `game.ts`'s 'sit' case.
 */

const KEY = 'ab'.repeat(32);
const ORIGINAL_KEY = process.env.BOT_IDENTITY_KEY;
// Must be set before the suite's app boots (the create route refuses without it).
process.env.BOT_IDENTITY_KEY = KEY;

const srv = useIntegrationServer();

function botCount(roomId: string): number {
  return (
    srv.ctx.db
      .prepare(
        "SELECT COUNT(*) AS n FROM bot_accounts WHERE room_id = ? AND status != 'removed' AND delete_requested_at IS NULL",
      )
      .get(roomId) as { n: number }
  ).n;
}

function seatedTotal(roomId: string): number {
  return (
    srv.ctx.db
      .prepare('SELECT COUNT(*) AS n FROM room_players WHERE room_id = ? AND seat IS NOT NULL')
      .get(roomId) as { n: number }
  ).n;
}

async function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('waitFor timed out');
}

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.BOT_IDENTITY_KEY;
  else process.env.BOT_IDENTITY_KEY = ORIGINAL_KEY;
});

describe('sit-path 6-max cap', () => {
  it('evicts a random bot when a 7th player sits on a 6-bot table', async () => {
    const host = new TestClient(srv.baseUrl, 'sitcap_host');
    srv.clients.push(host);
    await host.register();
    const room = await host.api('/api/rooms', { name: 'Sit cap', sb: 10, bb: 20 });

    const botIds: string[] = [];
    for (let seat = 0; seat < 6; seat++) {
      const res = await host.api(`/api/rooms/${room.id}/bots`, { seat });
      botIds.push(res.bot.id);
    }
    expect(botCount(room.id)).toBe(6);

    const human = new TestClient(srv.baseUrl, 'sitcap_human');
    srv.clients.push(human);
    await human.register();
    await human.api('/api/rooms/join', { joinCode: room.joinCode });
    await human.connect(room.id);
    human.send({ t: 'sit', seat: 6 });

    await waitFor(() => botCount(room.id) === 5 && seatedTotal(room.id) === 6);

    expect(botCount(room.id)).toBe(5);
    expect(seatedTotal(room.id)).toBe(6);
    // The evicted bot is gone from the bots list, and the human kept a seat.
    const remaining = (
      srv.ctx.db
        .prepare("SELECT id FROM bot_accounts WHERE room_id = ? AND status != 'removed'")
        .all(room.id) as { id: string }[]
    ).map((r) => r.id);
    expect(botIds.filter((id) => remaining.includes(id))).toHaveLength(5);
    const humanSeats = (
      srv.ctx.db
        .prepare('SELECT seat FROM room_players WHERE room_id = ? AND user_id = ?')
        .get(room.id, human.userId) as { seat: number | null }
    ).seat;
    expect(humanSeats).not.toBeNull();
  });
});
