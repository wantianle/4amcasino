import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createSession, createUser } from '../src/auth.js';
import {
  TABLE_FULL_MESSAGE,
  botCapacity,
  evictOverCapBots,
  finalizeBotRemoved,
  getBot,
  setBotEvictionRunner,
} from '../src/botRoutes.js';
import { MAX_TABLE_PLAYERS_WITH_BOTS } from '@4am/shared';

/**
 * The table-with-bots cap: seated humans plus SEATED bots may not exceed
 * MAX_TABLE_PLAYERS_WITH_BOTS. The create route is the authority; the host
 * dialog only mirrors it.
 *
 * The authority is the real seat: `room_players.seat IS NOT NULL`, joined to
 * the bot rows. A bot ROW with no seat (a ghost/legacy row) is NOT capacity - a
 * regression test below locks that in, because counting rows would refuse a new
 * bot on a table that was not really full and would make eviction delete a bot
 * that freed no seat.
 *
 * "Human" follows the route's definition: a seated `room_players` row whose
 * owner has no effective (non-`removed`) bot row in this room. A room member
 * who has not sat down does not count, so a table with a lurking non-seated
 * member can still hold the full 6 bots.
 */

const KEY = 'ab'.repeat(32);
const ORIGINAL_KEY = process.env.BOT_IDENTITY_KEY;

let ctx: ReturnType<typeof createApp>;
let hostId: number;
let hostToken: string;
let room: string;

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

function createBot(payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/rooms/${room}/bots`,
    headers: auth(hostToken),
    payload,
  });
}

function removeBot(botId: string) {
  return ctx.app.inject({
    method: 'DELETE',
    url: `/api/rooms/${room}/bots/${botId}`,
    headers: auth(hostToken),
  });
}

function botCount(): number {
  return (
    ctx.db
      .prepare(
        "SELECT COUNT(*) AS n FROM bot_accounts WHERE room_id = ? AND status != 'removed' AND delete_requested_at IS NULL",
      )
      .get(room) as { n: number }
  ).n;
}

/** Seat a real (non-bot) user at `seat`, or at no seat when `seat` is null. */
function seatHuman(name: string, seat: number | null): number {
  const { userId } = createUser(ctx.db, name, 'a'.repeat(64), 'b'.repeat(64));
  ctx.db
    .prepare(
      'INSERT INTO room_players (room_id, user_id, seat, stack, sitting_out) VALUES (?, ?, ?, ?, 0)',
    )
    .run(room, userId, seat, 1000);
  return userId;
}

/**
 * Insert a bot row and (optionally) a `room_players` row at `seat`, bypassing
 * the create route so a GHOST - a bot row with no real seat - can be built.
 * `seat: null` with `seatRow: true` is the null-seat variant.
 */
function insertBotRow(
  name: string,
  opts: { rowSeat: number | null; withSeatRow: boolean; configuredSeat?: number | null },
): { botId: string; userId: number } {
  const { userId } = createUser(ctx.db, name, 'c'.repeat(64), 'd'.repeat(64));
  if (opts.withSeatRow) {
    ctx.db
      .prepare('INSERT INTO room_players (room_id, user_id, seat, stack, sitting_out) VALUES (?, ?, ?, 0, 0)')
      .run(room, userId, opts.rowSeat);
  }
  const botId = randomBytes(6).toString('hex');
  ctx.db
    .prepare(
      `INSERT INTO bot_accounts
         (id, room_id, owner_id, user_id, status, policy_kind, policy_json, difficulty, seat,
          identity_ct, identity_nonce, identity_tag, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'ready', 'scripted', NULL, 'medium', ?, NULL, NULL, NULL, ?, ?)`,
    )
    .run(botId, room, hostId, userId, opts.configuredSeat ?? opts.rowSeat, Date.now(), Date.now());
  return { botId, userId };
}

/** The bot's real `room_players` row, or undefined when it holds no seat. */
function botSeatRow(botId: string) {
  const bot = getBot(ctx.db, room, botId);
  if (!bot) return undefined;
  return ctx.db
    .prepare('SELECT seat FROM room_players WHERE room_id = ? AND user_id = ?')
    .get(room, bot.user_id) as { seat: number | null } | undefined;
}

async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor timed out');
}

beforeEach(async () => {
  process.env.BOT_IDENTITY_KEY = KEY;
  ctx = createApp(':memory:');
  hostId = createUser(ctx.db, 'cap_host', 'a'.repeat(64), 'b'.repeat(64)).userId;
  hostToken = createSession(ctx.db, hostId);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/rooms',
    headers: auth(hostToken),
    payload: { name: 'Cap room', sb: 10, bb: 20 },
  });
  room = res.json().id;
});

afterEach(async () => {
  setBotEvictionRunner(null);
  if (ORIGINAL_KEY === undefined) delete process.env.BOT_IDENTITY_KEY;
  else process.env.BOT_IDENTITY_KEY = ORIGINAL_KEY;
  await ctx.app.close();
});

describe('6-max bot table cap', () => {
  it('allows 6 bots with no human, then refuses the 7th', async () => {
    for (let seat = 0; seat < MAX_TABLE_PLAYERS_WITH_BOTS; seat++) {
      const res = await createBot({ seat });
      expect(res.statusCode).toBe(200);
    }
    expect(botCount()).toBe(MAX_TABLE_PLAYERS_WITH_BOTS);
    expect(botCapacity(ctx.db, room)).toMatchObject({
      seatedHumans: 0,
      bots: 6,
      total: 6,
      full: true,
    });

    const refused = await createBot({ seat: 6 });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe(TABLE_FULL_MESSAGE);
    // The refusal must not leave a bot (or account) behind.
    expect(botCount()).toBe(MAX_TABLE_PLAYERS_WITH_BOTS);
  });

  it('allows only 5 bots with one human seated, then refuses the 6th', async () => {
    seatHuman('cap_human1', 0);
    for (let seat = 1; seat <= MAX_TABLE_PLAYERS_WITH_BOTS - 1; seat++) {
      const res = await createBot({ seat });
      expect(res.statusCode).toBe(200);
    }
    expect(botCapacity(ctx.db, room)).toMatchObject({
      seatedHumans: 1,
      bots: 5,
      total: 6,
      full: true,
    });

    const refused = await createBot({ seat: MAX_TABLE_PLAYERS_WITH_BOTS });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe(TABLE_FULL_MESSAGE);
    expect(botCount()).toBe(MAX_TABLE_PLAYERS_WITH_BOTS - 1);
  });

  it('does not count a room member who has not sat down', async () => {
    seatHuman('cap_lurker', null);
    for (let seat = 0; seat < MAX_TABLE_PLAYERS_WITH_BOTS; seat++) {
      const res = await createBot({ seat });
      expect(res.statusCode).toBe(200);
    }
    expect(botCapacity(ctx.db, room)).toMatchObject({ seatedHumans: 0, bots: 6, total: 6 });
  });

  it('frees a slot when a bot is deleted, so another can be added', async () => {
    const ids: string[] = [];
    for (let seat = 0; seat < MAX_TABLE_PLAYERS_WITH_BOTS; seat++) {
      ids.push((await createBot({ seat })).json().bot.id);
    }
    expect((await createBot({ seat: 6 })).statusCode).toBe(409);

    const del = await removeBot(ids[0]!);
    expect(del.statusCode).toBe(200);
    expect(botCount()).toBe(MAX_TABLE_PLAYERS_WITH_BOTS - 1);

    const added = await createBot({ seat: 0 });
    expect(added.statusCode).toBe(200);
    expect(botCount()).toBe(MAX_TABLE_PLAYERS_WITH_BOTS);
  });

  it('admits exactly one of two concurrent adds competing for the last slot', async () => {
    for (let seat = 0; seat < MAX_TABLE_PLAYERS_WITH_BOTS - 1; seat++) {
      expect((await createBot({ seat })).statusCode).toBe(200);
    }
    // Two free seats, but only one may land: the route is synchronous after
    // `await hostRoom()`, so the second sees the first's row.
    const [a, b] = await Promise.all([createBot({ seat: 5 }), createBot({ seat: 6 })]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    expect(botCount()).toBe(MAX_TABLE_PLAYERS_WITH_BOTS);
  });

  it('does not count a bot row with no seat toward capacity (ghost)', async () => {
    insertBotRow('cap_ghost_noseat', { rowSeat: 4, withSeatRow: false });
    // The ghost is invisible to capacity: the authority is the real seat.
    expect(botCapacity(ctx.db, room)).toMatchObject({
      seatedHumans: 0,
      bots: 0,
      total: 0,
      full: false,
    });

    // All six real seats are still free for new bots - the OLD row-counting
    // implementation would have refused the first one as the 7th.
    for (let seat = 0; seat < MAX_TABLE_PLAYERS_WITH_BOTS; seat++) {
      expect((await createBot({ seat })).statusCode).toBe(200);
    }
    expect(botCapacity(ctx.db, room)).toMatchObject({ bots: 6, total: 6, full: true });
  });

  it('does not count a bot whose room_players row has a NULL seat', () => {
    insertBotRow('cap_ghost_nullseat', { rowSeat: null, withSeatRow: true });
    expect(botCapacity(ctx.db, room)).toMatchObject({ bots: 0, total: 0, full: false });
  });

  it('counts a bot by its real seat even when bot_accounts.seat disagrees', () => {
    // A legacy/config drift: configured seat 7, really seated at 2.
    insertBotRow('cap_mismatch', { rowSeat: 2, withSeatRow: true, configuredSeat: 7 });
    expect(botCapacity(ctx.db, room)).toMatchObject({ seatedHumans: 0, bots: 1, total: 1 });
  });
});

/**
 * Eviction / cleanup: `evictOverCapBots` is what the sit path calls when a
 * human sits over the cap, and it is the same function used to clean a
 * pre-existing over-cap room. It removes random bots through the ordinary
 * removal path; with no bot left it does nothing (an all-human table is over
 * the SEAT count, not the bot count - the caller decides whether to allow it).
 */
describe('6-max table cap eviction', () => {
  async function seedBots(n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let seat = 0; seat < n; seat++) ids.push((await createBot({ seat })).json().bot.id);
    return ids;
  }

  it('removes one random bot from a 6-bot + 1-human table, back to 6', async () => {
    const ids = await seedBots(MAX_TABLE_PLAYERS_WITH_BOTS);
    seatHuman('cap_sitter', MAX_TABLE_PLAYERS_WITH_BOTS); // seat 6 -> total 7
    expect(botCapacity(ctx.db, room).total).toBe(7);

    const evicted = evictOverCapBots(ctx.db, room);

    expect(evicted).toHaveLength(1);
    expect(ids).toContain(evicted[0]!);
    expect(botCount()).toBe(MAX_TABLE_PLAYERS_WITH_BOTS - 1);
    expect(botCapacity(ctx.db, room)).toMatchObject({ seatedHumans: 1, bots: 5, total: 6 });
  });

  it('leaves an all-human over-cap table alone (no bot to evict)', () => {
    for (let seat = 0; seat <= MAX_TABLE_PLAYERS_WITH_BOTS; seat++) seatHuman(`cap_h${seat}`, seat);
    expect(botCapacity(ctx.db, room)).toMatchObject({ seatedHumans: 7, bots: 0, total: 7 });

    expect(evictOverCapBots(ctx.db, room)).toEqual([]);
    // Deliberate: the cap limits bots, not seats. A 7-human table is the game's
    // own 9-max concern; sit must not be refused for lack of a bot.
    expect(botCapacity(ctx.db, room).total).toBe(7);
  });

  it('is a no-op when the table is already within the cap', async () => {
    await seedBots(2);
    seatHuman('cap_ok', 5);
    expect(evictOverCapBots(ctx.db, room)).toEqual([]);
    expect(botCapacity(ctx.db, room).total).toBe(3);
  });

  it('evicts the seated bot, never a ghost that holds no seat', () => {
    // 6 seated humans (total already 6) + a ghost bot row + one SEATED bot
    // (seat 6 -> total 7). Only the seated bot may go; the ghost frees nothing
    // and must survive so the host can still see and delete it.
    for (let seat = 0; seat < MAX_TABLE_PLAYERS_WITH_BOTS; seat++) seatHuman(`cap_h${seat}`, seat);
    const ghost = insertBotRow('cap_evict_ghost', { rowSeat: null, withSeatRow: false });
    const seated = insertBotRow('cap_evict_seated', {
      rowSeat: MAX_TABLE_PLAYERS_WITH_BOTS,
      withSeatRow: true,
    });
    expect(botCapacity(ctx.db, room).total).toBe(7);

    const evicted = evictOverCapBots(ctx.db, room);

    expect(evicted).toEqual([seated.botId]);
    expect(getBot(ctx.db, room, seated.botId)).toBeUndefined();
    // The ghost is untouched: it was never a legal eviction target.
    expect(getBot(ctx.db, room, ghost.botId)).toBeTruthy();
    expect(botCapacity(ctx.db, room)).toMatchObject({ seatedHumans: 6, bots: 0, total: 6 });
  });
});

/**
 * Eviction with a live runner. `setBotEvictionRunner` is the process-wide
 * injection seam `index.ts` wires to the supervisor; a fake here proves the
 * sit-path cap genuinely (a) persists the delete intent, (b) hands the bot to
 * its runner, and (c) does NOT touch the row or seat until that runner has
 * wound down - the same contract the DELETE route honours.
 */
describe('table cap eviction with a live runner', () => {
  async function seedBots(n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let seat = 0; seat < n; seat++) ids.push((await createBot({ seat })).json().bot.id);
    return ids;
  }

  it('parks the delete intent, hands off to the runner, and only then frees the seat', async () => {
    const ids = await seedBots(MAX_TABLE_PLAYERS_WITH_BOTS);
    seatHuman('cap_live_sitter', MAX_TABLE_PLAYERS_WITH_BOTS); // total 7

    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    setBotEvictionRunner({
      hasRunner: (botId) => ids.includes(botId),
      removeBot: (botId) => {
        calls.push(botId);
        // Mimic the supervisor: the row goes only once the runner has stopped.
        return gate.then(() => {
          finalizeBotRemoved(ctx.db, botId);
        });
      },
    });

    const evicted = evictOverCapBots(ctx.db, room);
    expect(evicted).toHaveLength(1);
    const id = evicted[0]!;
    expect(calls).toEqual([id]);

    // (a) Durable intent, parked `stopping`; (c) row + seat still present while
    // the runner is winding down, so capacity still reads the true 7.
    const parked = getBot(ctx.db, room, id)!;
    expect(parked.status).toBe('stopping');
    expect(parked.delete_requested_at).not.toBeNull();
    expect(botSeatRow(id)).toBeTruthy();
    expect(botCapacity(ctx.db, room).total).toBe(7);

    // Runner finally winds down: now the row and seat go, freeing exactly one.
    release();
    await waitFor(() => getBot(ctx.db, room, id) === undefined);
    expect(botSeatRow(id)).toBeUndefined();
    expect(botCapacity(ctx.db, room)).toMatchObject({ seatedHumans: 1, bots: 5, total: 6 });
  });

  it('finalizes immediately and frees the seat when the bot has no live runner', async () => {
    await seedBots(MAX_TABLE_PLAYERS_WITH_BOTS);
    seatHuman('cap_direct_sitter', MAX_TABLE_PLAYERS_WITH_BOTS);
    const calls: string[] = [];
    setBotEvictionRunner({
      hasRunner: () => false,
      removeBot: (botId) => {
        calls.push(botId);
      },
    });

    const evicted = evictOverCapBots(ctx.db, room);

    expect(evicted).toHaveLength(1);
    expect(calls).toEqual([]); // no runner -> never handed off
    expect(getBot(ctx.db, room, evicted[0]!)).toBeUndefined();
    expect(botCapacity(ctx.db, room).total).toBe(6);
  });
});

/**
 * `finalizeBotRemoved`'s retention contract, asserted as a table-by-table
 * boundary: the bot's account, seat and grants go; its `users` row, its money
 * history (`ledger`), its funding history (`buy_requests`) and its hand history
 * (`hand_players`) stay. `/api/rooms/:id/ledger` INNER JOINs `users`, so
 * deleting the account would silently drop the bot's entries from the room
 * ledger even though the ledger rows exist.
 */
describe('finalizeBotRemoved retention contract', () => {
  it('drops bot/seat/grant rows but keeps users, ledger, buy_requests and hand_players', async () => {
    const created = (await createBot({ seat: 1, initialBuyIn: 2000 })).json();
    const botId: string = created.bot.id;
    const userId: number = created.bot.userId;

    // A finished-hand projection row referencing the bot's user.
    ctx.db
      .prepare('INSERT INTO hand_players (hand_id, seat, user_id) VALUES (?, ?, ?)')
      .run('cap_hand_1', 1, userId);
    // A runner grant that must be removed.
    ctx.db
      .prepare(
        `INSERT INTO agent_grants
           (id,user_id,token_hash,label,scope_kind,scope_id,can_play,created_at,expires_at,grant_kind,bot_id)
         VALUES ('cap_grant', ?, 'cap_hash', 'cap', 'room', ?, 1, ?, ?, 'bot_runner', ?)`,
      )
      .run(userId, room, Date.now(), Date.now() + 100_000, botId);

    const count = (sql: string, ...args: unknown[]) =>
      (ctx.db.prepare(sql).get(...args) as { n: number }).n;
    const ledgerBefore = count('SELECT COUNT(*) AS n FROM ledger WHERE room_id = ? AND user_id = ?', room, userId);
    const buysBefore = count(
      'SELECT COUNT(*) AS n FROM buy_requests WHERE room_id = ? AND user_id = ?',
      room,
      userId,
    );
    expect(ledgerBefore).toBeGreaterThan(0);
    expect(buysBefore).toBeGreaterThan(0);
    expect(count('SELECT COUNT(*) AS n FROM agent_grants WHERE bot_id = ?', botId)).toBe(1);

    expect(finalizeBotRemoved(ctx.db, botId)).toBe(true);

    // Removed: bot row, seat row, every grant for the bot.
    expect(getBot(ctx.db, room, botId)).toBeUndefined();
    expect(
      ctx.db.prepare('SELECT 1 FROM room_players WHERE room_id = ? AND user_id = ?').get(room, userId),
    ).toBeUndefined();
    expect(count('SELECT COUNT(*) AS n FROM agent_grants WHERE bot_id = ?', botId)).toBe(0);

    // Retained: account, money history, funding history, hand history.
    expect(ctx.db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)).toBeTruthy();
    expect(count('SELECT COUNT(*) AS n FROM ledger WHERE room_id = ? AND user_id = ?', room, userId)).toBe(
      ledgerBefore,
    );
    expect(
      count('SELECT COUNT(*) AS n FROM buy_requests WHERE room_id = ? AND user_id = ?', room, userId),
    ).toBe(buysBefore);
    expect(count('SELECT COUNT(*) AS n FROM hand_players WHERE user_id = ?', userId)).toBe(1);
  });
});
