import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { identityFromSeed } from '@4am/mental-poker';
import { createApp } from '../src/app.js';
import { createSession, createUser } from '../src/auth.js';
import { migrateBots } from '../src/db.js';
import { resolveAgentGrant } from '../src/agentAccess.js';
import { BuyServiceError, requestRoomBuy } from '../src/buyService.js';
import {
  claimStartingBot,
  getBot,
  markBotError,
  markBotStopped,
  verifyBotIdentity,
  type BotRow,
} from '../src/botRoutes.js';

const KEY = 'ab'.repeat(32);
const ORIGINAL_KEY = process.env.BOT_IDENTITY_KEY;

let ctx: ReturnType<typeof createApp>;
let hostId: number;
let hostToken: string;
let outsiderId: number;
let outsiderToken: string;
let room: string;

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function createBot(payload: Record<string, unknown>, token = hostToken, roomId = room) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/rooms/${roomId}/bots`,
    headers: auth(token),
    payload,
  });
}

async function startBot(botId: string, token = hostToken, roomId = room) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/rooms/${roomId}/bots/${botId}/start`,
    headers: auth(token),
  });
}

function botRow(botId: string, roomId = room): BotRow {
  return getBot(ctx.db, roomId, botId)!;
}

function stackOf(userId: number): number {
  return (
    ctx.db.prepare('SELECT stack FROM room_players WHERE room_id = ? AND user_id = ?').get(room, userId) as {
      stack: number;
    }
  ).stack;
}

beforeEach(async () => {
  process.env.BOT_IDENTITY_KEY = KEY;
  ctx = createApp(':memory:');
  hostId = createUser(ctx.db, 'bot_host', 'a'.repeat(64), 'b'.repeat(64)).userId;
  hostToken = createSession(ctx.db, hostId);
  outsiderId = createUser(ctx.db, 'bot_outsider', 'c'.repeat(64), 'd'.repeat(64)).userId;
  outsiderToken = createSession(ctx.db, outsiderId);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/rooms',
    headers: auth(hostToken),
    payload: { name: 'Bot room', sb: 10, bb: 20 },
  });
  room = res.json().id;
});

afterEach(async () => {
  if (ORIGINAL_KEY === undefined) delete process.env.BOT_IDENTITY_KEY;
  else process.env.BOT_IDENTITY_KEY = ORIGINAL_KEY;
  await ctx.app.close();
});

describe('bot create', () => {
  it('creates an independent account and bot_accounts row, and mints no grant until claimed', async () => {
    const res = await createBot({ seat: 1, name: 'Robo', policyKind: 'scripted', policyJson: '{"a":1}' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bot.status).toBe('ready');
    expect(body.bot.seat).toBe(1);
    expect(body.bot.configuredSeat).toBe(1);
    expect(body.bot.identityRecoverable).toBe(true);
    expect(body.grantToken).toBeUndefined();
    expect(body.buyRequest).toBeNull();

    const user = ctx.db
      .prepare('SELECT id, username, pubkey, display_name FROM users WHERE id = ?')
      .get(body.bot.userId) as { id: number; username: string; pubkey: string; display_name: string };
    expect(user.username).toMatch(/^bot_[0-9a-f]{10}$/);
    expect(user.display_name).toBe('Robo');
    expect(user.id).not.toBe(hostId);

    const bot = botRow(body.bot.id);
    expect(bot.room_id).toBe(room);
    expect(bot.owner_id).toBe(hostId);
    expect(bot.user_id).toBe(body.bot.userId);
    expect(bot.status).toBe('ready');
    expect(bot.identity_ct && bot.identity_nonce && bot.identity_tag).toBeTruthy();

    // The validated identity unwrap round-trips to the account's real public key.
    // There is no bare seed-recovery export left; verifyBotIdentity is the only
    // way to unwrap it, so 1b cannot skip the pubkey proof.
    const verified = verifyBotIdentity(ctx.db, bot);
    expect(verified).not.toBeNull();
    expect(identityFromSeed(verified!.seed).publicKey).toBe(user.pubkey);
    // plain seed never appears in the row
    expect(JSON.stringify(bot)).not.toContain(Buffer.from(verified!.seed).toString('hex'));

    expect(stackOf(body.bot.userId)).toBe(0);
    // no grant is created by POST; the supervisor mints one at claim time
    expect((ctx.db.prepare('SELECT COUNT(*) AS n FROM agent_grants').get() as { n: number }).n).toBe(0);
  });

  it('mints an internal bot_runner grant on claim', async () => {
    const created = (await createBot({ seat: 2, name: 'Hidden' })).json();
    await startBot(created.bot.id);
    const claim = claimStartingBot(ctx.db, created.bot.id)!;
    expect(claim.grantToken).toMatch(/^4am_agent_[0-9a-f]{64}$/);

    const grant = ctx.db
      .prepare('SELECT grant_kind, bot_id, can_play, scope_id, user_id FROM agent_grants')
      .get() as Record<string, unknown>;
    expect(grant.grant_kind).toBe('bot_runner');
    expect(grant.bot_id).toBe(created.bot.id);
    expect(grant.can_play).toBe(1);
    expect(grant.scope_id).toBe(room);
    expect(grant.user_id).toBe(created.bot.userId);
    expect(resolveAgentGrant(ctx.db, claim.grantToken)?.user_id).toBe(created.bot.userId);
  });

  it('rejects a non-host', async () => {
    const res = await createBot({ seat: 1 }, outsiderToken);
    expect(res.statusCode).toBe(403);
    expect((ctx.db.prepare('SELECT COUNT(*) AS n FROM bot_accounts').get() as { n: number }).n).toBe(0);
  });

  it('rejects an agent token (real login required)', async () => {
    const created = (await createBot({ seat: 1 })).json();
    await startBot(created.bot.id);
    const claim = claimStartingBot(ctx.db, created.bot.id)!;
    const res = await createBot({ seat: 2 }, claim.grantToken);
    expect(res.statusCode).toBe(401);
  });

  it('rejects a taken seat', async () => {
    const fillerId = createUser(ctx.db, 'bot_filler', '3'.repeat(64), '4'.repeat(64)).userId;
    ctx.db
      .prepare('INSERT INTO room_players (room_id, user_id, seat, stack) VALUES (?, ?, 3, 0)')
      .run(room, fillerId);
    const res = await createBot({ seat: 3 });
    expect(res.statusCode).toBe(409);
  });

  it('fails closed when BOT_IDENTITY_KEY is missing', async () => {
    delete process.env.BOT_IDENTITY_KEY;
    const before = (ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
    const res = await createBot({ seat: 1 });
    expect(res.statusCode).toBe(503);
    const after = (ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it('funds a chip-less bot through the host-only buy route', async () => {
    const created = (await createBot({ seat: 1 })).json();
    expect(stackOf(created.bot.userId)).toBe(0);

    const before = await ctx.app.inject({ url: `/api/rooms/${room}/bots`, headers: auth(hostToken) });
    expect(before.statusCode).toBe(200);
    expect(before.json().bots.find((b: { id: string }) => b.id === created.bot.id).stack).toBe(0);

    const denied = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room}/bots/${created.bot.id}/buy`,
      headers: auth(outsiderToken),
      payload: { amount: 700 },
    });
    expect(denied.statusCode).toBe(403);

    const buy = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room}/bots/${created.bot.id}/buy`,
      headers: auth(hostToken),
      payload: { amount: 700 },
    });
    expect(buy.statusCode).toBe(200);
    expect(buy.json().buyRequest.status).toBe('approved'); // host is the banker
    expect(stackOf(created.bot.userId)).toBe(700);

    const after = await ctx.app.inject({ url: `/api/rooms/${room}/bots`, headers: auth(hostToken) });
    expect(after.json().bots.find((b: { id: string }) => b.id === created.bot.id).stack).toBe(700);
  });
});

describe('bot initial buy-in', () => {
  it('leaves the buy pending when the host is not the banker, then goes ready on approval', async () => {
    const bankerId = createUser(ctx.db, 'bot_banker', 'e'.repeat(64), 'f'.repeat(64)).userId;
    const bankerToken = createSession(ctx.db, bankerId);
    ctx.db.prepare('UPDATE rooms SET banker_id = ? WHERE id = ?').run(bankerId, room);
    // This case exercises the human approval flow, so opt this room out of the
    // default-on auto-approval before raising the buy.
    ctx.db.prepare('UPDATE rooms SET auto_approve_buys = 0 WHERE id = ?').run(room);

    const res = await createBot({ seat: 1, initialBuyIn: 500 });
    const body = res.json();
    expect(body.bot.status).toBe('waiting_buy_approval');
    expect(body.buyRequest.status).toBe('pending');
    expect(stackOf(body.bot.userId)).toBe(0);

    const approve = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room}/approve`,
      headers: auth(bankerToken),
      payload: { requestId: body.buyRequest.id, approve: true },
    });
    expect(approve.statusCode).toBe(200);
    expect(botRow(body.bot.id).status).toBe('ready');
    expect(stackOf(body.bot.userId)).toBe(500);
  });

  it('auto-approves the initial buy when the host is the banker', async () => {
    const body = (await createBot({ seat: 1, initialBuyIn: 300 })).json();
    expect(body.bot.status).toBe('ready');
    expect(body.buyRequest.status).toBe('approved');
    expect(stackOf(body.bot.userId)).toBe(300);
  });
});

describe('bot lifecycle / claim handoff', () => {
  it('start -> claim -> stop -> stopped -> start -> claim yields a fresh token', async () => {
    const created = (await createBot({ seat: 1, name: 'Cycler' })).json();
    const botId = created.bot.id;

    // GET never leaks secrets.
    const list = await ctx.app.inject({ url: `/api/rooms/${room}/bots`, headers: auth(hostToken) });
    expect(list.statusCode).toBe(200);
    expect(list.json().bots[0].id).toBe(botId);
    expect(list.body).not.toContain('identity_ct');
    expect(list.body).not.toContain(created.grantToken ?? 'no-token');

    expect((await startBot(botId)).json().bot.status).toBe('starting');
    const first = claimStartingBot(ctx.db, botId)!;
    expect(first.bot.status).toBe('running');
    expect(resolveAgentGrant(ctx.db, first.grantToken)).not.toBeNull();

    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: `/api/rooms/${room}/bots/${botId}/stop`,
          headers: auth(hostToken),
        })
      ).json().bot.status,
    ).toBe('stopping');
    // stop revokes the runner grant
    expect(resolveAgentGrant(ctx.db, first.grantToken)).toBeNull();
    expect(markBotStopped(ctx.db, botId)).toBe(true);
    expect(botRow(botId).status).toBe('stopped');

    // restart mints a brand-new token; the old one stays dead
    expect((await startBot(botId)).json().bot.status).toBe('starting');
    const second = claimStartingBot(ctx.db, botId)!;
    expect(second.grantToken).not.toBe(first.grantToken);
    expect(resolveAgentGrant(ctx.db, first.grantToken)).toBeNull();
    expect(resolveAgentGrant(ctx.db, second.grantToken)?.user_id).toBe(created.bot.userId);
  });

  it('lets only one supervisor claim a starting bot', async () => {
    const created = (await createBot({ seat: 1 })).json();
    await startBot(created.bot.id);
    const first = claimStartingBot(ctx.db, created.bot.id);
    const second = claimStartingBot(ctx.db, created.bot.id);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(botRow(created.bot.id).status).toBe('running');
  });

  it('markBotError revokes the active runner grant and parks the bot as error', async () => {
    const created = (await createBot({ seat: 1 })).json();
    await startBot(created.bot.id);
    const claim = claimStartingBot(ctx.db, created.bot.id)!;
    expect(resolveAgentGrant(ctx.db, claim.grantToken)).not.toBeNull();

    expect(markBotError(ctx.db, created.bot.id)).toBe(true);
    expect(resolveAgentGrant(ctx.db, claim.grantToken)).toBeNull();
    expect(botRow(created.bot.id).status).toBe('error');
    expect(
      (ctx.db.prepare('SELECT COUNT(*) AS n FROM agent_grants WHERE revoked_at IS NULL').get() as { n: number }).n,
    ).toBe(0);
  });

  it('markBotError refuses to rewrite a state it does not own (ready/stopped)', async () => {
    const created = (await createBot({ seat: 1 })).json();
    expect(markBotError(ctx.db, created.bot.id)).toBe(false);
    expect(botRow(created.bot.id).status).toBe('ready');

    await startBot(created.bot.id);
    claimStartingBot(ctx.db, created.bot.id);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room}/bots/${created.bot.id}/stop`,
      headers: auth(hostToken),
    });
    markBotStopped(ctx.db, created.bot.id);
    expect(markBotError(ctx.db, created.bot.id)).toBe(false);
    expect(botRow(created.bot.id).status).toBe('stopped');
  });

  it('rolls back the claim when grant issuance fails, leaving the bot claimable', async () => {
    const created = (await createBot({ seat: 1 })).json();
    await startBot(created.bot.id);
    // Force the grant INSERT inside the claim transaction to abort.
    ctx.db.exec(
      "CREATE TRIGGER bot_grant_boom BEFORE INSERT ON agent_grants BEGIN SELECT RAISE(ABORT, 'boom'); END;",
    );
    expect(() => claimStartingBot(ctx.db, created.bot.id)).toThrow();
    // The status preemption rolled back with the grant: no `running` bot with no token.
    expect(botRow(created.bot.id).status).toBe('starting');
    expect(
      (ctx.db.prepare('SELECT COUNT(*) AS n FROM agent_grants').get() as { n: number }).n,
    ).toBe(0);
  });

  it('clears stop bookkeeping when a stopped bot restarts', async () => {
    const created = (await createBot({ seat: 1 })).json();
    await startBot(created.bot.id);
    claimStartingBot(ctx.db, created.bot.id);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room}/bots/${created.bot.id}/stop`,
      headers: auth(hostToken),
    });
    markBotStopped(ctx.db, created.bot.id);
    const stopped = botRow(created.bot.id);
    expect(stopped.stopped_at).not.toBeNull();
    expect(stopped.stop_requested_at).not.toBeNull();

    await startBot(created.bot.id);
    const restarted = botRow(created.bot.id);
    expect(restarted.status).toBe('starting');
    expect(restarted.stopped_at).toBeNull();
    expect(restarted.stop_requested_at).toBeNull();
  });

  it('refuses start from waiting_buy_approval and from running', async () => {
    const bankerId = createUser(ctx.db, 'bot_other_banker', '5'.repeat(64), '6'.repeat(64)).userId;
    ctx.db.prepare('UPDATE rooms SET banker_id = ? WHERE id = ?').run(bankerId, room);
    // A pending buy-in is required to produce the `waiting_buy_approval` state,
    // so disable the default-on auto-approval for this case.
    ctx.db.prepare('UPDATE rooms SET auto_approve_buys = 0 WHERE id = ?').run(room);
    const waiting = (await createBot({ seat: 1, initialBuyIn: 100 })).json();
    expect((await startBot(waiting.bot.id)).statusCode).toBe(409);

    // ready bot, then running -> start is a conflict
    ctx.db.prepare('UPDATE rooms SET banker_id = ? WHERE id = ?').run(hostId, room);
    const created = (await createBot({ seat: 2 })).json();
    await startBot(created.bot.id);
    claimStartingBot(ctx.db, created.bot.id);
    expect((await startBot(created.bot.id)).statusCode).toBe(409);
  });

  it('refuses start on an archived room', async () => {
    const created = (await createBot({ seat: 1 })).json();
    ctx.db.prepare('UPDATE rooms SET archived = 1 WHERE id = ?').run(room);
    expect((await startBot(created.bot.id)).statusCode).toBe(409);
    expect(botRow(created.bot.id).status).toBe('ready');
  });

  it('returns 503 for /start while the supervisor is shutting down', async () => {
    const created = (await createBot({ seat: 1 })).json();
    ctx.botControl.hooks = {
      canStart: () => false,
      isShuttingDown: () => true,
      hasRunner: () => false,
      startBot: () => {},
      stopBot: () => {},
      removeBot: () => {},
    };
    const res = await startBot(created.bot.id);
    expect(res.statusCode).toBe(503);
    // Not advanced into `starting`: a shutting-down server must not strand it.
    expect(botRow(created.bot.id).status).toBe('ready');
  });

  it('fails closed on a wrong-but-well-formed identity key without entering starting', async () => {
    const created = (await createBot({ seat: 1 })).json();
    process.env.BOT_IDENTITY_KEY = 'cd'.repeat(32); // valid shape, wrong key
    const res = await startBot(created.bot.id);
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('error');
    expect(botRow(created.bot.id).status).toBe('error');
    expect(botRow(created.bot.id).status).not.toBe('starting');
  });

  it('marks a bot error and refuses to start when the key is gone', async () => {
    const created = (await createBot({ seat: 1 })).json();
    delete process.env.BOT_IDENTITY_KEY;
    const res = await startBot(created.bot.id);
    expect(res.statusCode).toBe(503);
    expect(botRow(created.bot.id).status).toBe('error');
  });

  it('claim returns null (and errors the bot) when the identity is corrupted', async () => {
    const created = (await createBot({ seat: 1 })).json();
    await startBot(created.bot.id);
    ctx.db.prepare("UPDATE bot_accounts SET identity_ct = '00', identity_tag = '00' WHERE id = ?").run(created.bot.id);
    expect(claimStartingBot(ctx.db, created.bot.id)).toBeNull();
    expect(botRow(created.bot.id).status).toBe('error');
    expect((ctx.db.prepare('SELECT COUNT(*) AS n FROM agent_grants').get() as { n: number }).n).toBe(0);
  });

  it('claim returns null (and errors the bot) when the room is archived', async () => {
    const created = (await createBot({ seat: 1 })).json();
    await startBot(created.bot.id);
    ctx.db.prepare('UPDATE rooms SET archived = 1 WHERE id = ?').run(room);
    expect(claimStartingBot(ctx.db, created.bot.id)).toBeNull();
    expect(botRow(created.bot.id).status).toBe('error');
  });

  it('removes a bot permanently', async () => {
    const created = (await createBot({ seat: 1, initialBuyIn: 2500 })).json();
    const userId = created.bot.userId;
    const botId = created.bot.id;
    await startBot(botId);
    claimStartingBot(ctx.db, botId);
    expect(
      (ctx.db.prepare('SELECT COUNT(*) AS n FROM agent_grants WHERE bot_id = ?').get(botId) as {
        n: number;
      }).n,
    ).toBe(1);

    const ledgerBefore = (
      ctx.db
        .prepare('SELECT COALESCE(SUM(delta), 0) AS s FROM ledger WHERE room_id = ? AND user_id = ?')
        .get(room, userId) as { s: number }
    ).s;
    expect(ledgerBefore).not.toBe(0);

    const del = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/rooms/${room}/bots/${botId}`,
      headers: auth(hostToken),
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().bot.status).toBe('removed');
    expect(del.json().deletion).toBe('done');

    // The database row is really gone, not flagged `removed`.
    expect(getBot(ctx.db, room, botId)).toBeUndefined();
    // So is every grant and the seat/membership row: the bot cannot linger as a
    // reconnectable runner or as a player in the room.
    expect(
      (ctx.db.prepare('SELECT COUNT(*) AS n FROM agent_grants WHERE bot_id = ?').get(botId) as {
        n: number;
      }).n,
    ).toBe(0);
    expect(
      ctx.db.prepare('SELECT 1 FROM room_players WHERE room_id = ? AND user_id = ?').get(room, userId),
    ).toBeUndefined();

    // Ledger history is untouched, and the account row stays so the room ledger
    // can still resolve who the entries belonged to.
    expect(
      (
        ctx.db
          .prepare('SELECT COALESCE(SUM(delta), 0) AS s FROM ledger WHERE room_id = ? AND user_id = ?')
          .get(room, userId) as { s: number }
      ).s,
    ).toBe(ledgerBefore);
    expect(ctx.db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)).toBeTruthy();

    // A repeated delete is a clean 404, never a 500.
    const again = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/rooms/${room}/bots/${botId}`,
      headers: auth(hostToken),
    });
    expect(again.statusCode).toBe(404);
    // The bot can no longer be started.
    expect((await startBot(botId)).statusCode).toBe(404);
  });

  it('deletes exactly once under concurrent DELETEs (winner 200, loser 404)', async () => {
    const created = (await createBot({ seat: 5 })).json();
    const url = `/api/rooms/${room}/bots/${created.bot.id}`;
    const [a, b] = await Promise.all([
      ctx.app.inject({ method: 'DELETE', url, headers: auth(hostToken) }),
      ctx.app.inject({ method: 'DELETE', url, headers: auth(hostToken) }),
    ]);
    // Exactly one request deletes the row; the other finds nothing.
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 404]);
    expect(getBot(ctx.db, room, created.bot.id)).toBeUndefined();
  });

  it('hides legacy removed rows and bots with a pending delete from the list', async () => {
    const legacy = (await createBot({ seat: 6 })).json();
    const pending = (await createBot({ seat: 7 })).json();
    const live = (await createBot({ seat: 8 })).json();
    // A zombie row from the old soft-delete era...
    ctx.db
      .prepare("UPDATE bot_accounts SET status = 'removed', updated_at = ? WHERE id = ?")
      .run(Date.now(), legacy.bot.id);
    // ...and a bot whose hard delete is still winding down.
    ctx.db
      .prepare("UPDATE bot_accounts SET status = 'stopping', delete_requested_at = ? WHERE id = ?")
      .run(Date.now(), pending.bot.id);

    const list = await ctx.app.inject({ url: `/api/rooms/${room}/bots`, headers: auth(hostToken) });
    const ids = list.json().bots.map((b: { id: string }) => b.id);
    expect(ids).toContain(live.bot.id);
    expect(ids).not.toContain(legacy.bot.id);
    expect(ids).not.toContain(pending.bot.id);
  });

  it('hides bots from non-members but allows members', async () => {
    const created = (await createBot({ seat: 1 })).json();
    const outsider = await ctx.app.inject({ url: `/api/rooms/${room}/bots`, headers: auth(outsiderToken) });
    expect(outsider.statusCode).toBe(403);

    const memberId = createUser(ctx.db, 'bot_member', '1'.repeat(64), '2'.repeat(64)).userId;
    const memberToken = createSession(ctx.db, memberId);
    ctx.db.prepare('INSERT INTO room_players (room_id, user_id) VALUES (?, ?)').run(room, memberId);
    const member = await ctx.app.inject({ url: `/api/rooms/${room}/bots`, headers: auth(memberToken) });
    expect(member.statusCode).toBe(200);
    expect(member.json().bots[0].id).toBe(created.bot.id);
  });
});

describe('remove / grant hardening', () => {
  it('cancels a pending buy on remove so a later approval cannot credit the bot', async () => {
    const bankerId = createUser(ctx.db, 'bot_banker2', '7'.repeat(64), '8'.repeat(64)).userId;
    const bankerToken = createSession(ctx.db, bankerId);
    ctx.db.prepare('UPDATE rooms SET banker_id = ? WHERE id = ?').run(bankerId, room);
    // A pending buy-in is the whole point of this case, so keep it pending.
    ctx.db.prepare('UPDATE rooms SET auto_approve_buys = 0 WHERE id = ?').run(room);

    const created = (await createBot({ seat: 1, initialBuyIn: 400 })).json();
    expect(created.bot.status).toBe('waiting_buy_approval');
    const requestId = created.buyRequest.id;

    await ctx.app.inject({
      method: 'DELETE',
      url: `/api/rooms/${room}/bots/${created.bot.id}`,
      headers: auth(hostToken),
    });
    const approve = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room}/approve`,
      headers: auth(bankerToken),
      payload: { requestId, approve: true },
    });
    expect(approve.statusCode).toBe(404);
    // The bot (and its seat row) is gone, so nothing can be credited to it, and
    // the never-approved buy left no ledger entry behind.
    expect(
      ctx.db.prepare('SELECT 1 FROM room_players WHERE room_id = ? AND user_id = ?').get(room, created.bot.userId),
    ).toBeUndefined();
    expect(
      (ctx.db.prepare('SELECT COUNT(*) AS n FROM ledger WHERE room_id = ? AND user_id = ?').get(room, created.bot.userId) as {
        n: number;
      }).n,
    ).toBe(0);
  });

  it('rejects a bot_runner grant whose user/room or bot status no longer matches', async () => {
    const created = (await createBot({ seat: 1 })).json();
    await startBot(created.bot.id);
    const claim = claimStartingBot(ctx.db, created.bot.id)!;

    ctx.db.prepare('UPDATE agent_grants SET user_id = ? WHERE bot_id = ?').run(outsiderId, created.bot.id);
    expect(resolveAgentGrant(ctx.db, claim.grantToken)).toBeNull();

    // restore user, then remove the bot -> grant rejected even if unrevoked
    ctx.db.prepare('UPDATE agent_grants SET user_id = ? WHERE bot_id = ?').run(created.bot.userId, created.bot.id);
    expect(resolveAgentGrant(ctx.db, claim.grantToken)).not.toBeNull();
    ctx.db.prepare("UPDATE bot_accounts SET status = 'removed' WHERE id = ?").run(created.bot.id);
    expect(resolveAgentGrant(ctx.db, claim.grantToken)).toBeNull();
  });
});

describe('review hardening: room / bot / seat edge cases', () => {
  it('rejects a bot_runner grant once the bot room no longer matches the grant scope', async () => {
    const created = (await createBot({ seat: 1 })).json();
    await startBot(created.bot.id);
    const claim = claimStartingBot(ctx.db, created.bot.id)!;
    expect(resolveAgentGrant(ctx.db, claim.grantToken)).not.toBeNull();

    // room_players still matches scope_id, but the bot moved room: grant must die.
    ctx.db.prepare('UPDATE bot_accounts SET room_id = ? WHERE id = ?').run('somewhere_else', created.bot.id);
    expect(resolveAgentGrant(ctx.db, claim.grantToken)).toBeNull();
  });

  it('rejects a bot_runner grant whose bot_id is missing or NULL', async () => {
    const created = (await createBot({ seat: 1 })).json();
    await startBot(created.bot.id);
    const claim = claimStartingBot(ctx.db, created.bot.id)!;

    ctx.db.prepare('UPDATE agent_grants SET bot_id = ? WHERE bot_id = ?').run('no-such-bot', created.bot.id);
    expect(resolveAgentGrant(ctx.db, claim.grantToken)).toBeNull();

    // scope membership, user and revocation are all still valid, so only the
    // NULL bot_id check can reject this one.
    ctx.db.prepare('UPDATE agent_grants SET bot_id = NULL WHERE bot_id = ?').run('no-such-bot');
    expect(resolveAgentGrant(ctx.db, claim.grantToken)).toBeNull();
  });

  it('refuses start on a deleted room and leaves the bot ready', async () => {
    const created = (await createBot({ seat: 1 })).json();
    ctx.db.prepare('UPDATE rooms SET deleted = 1 WHERE id = ?').run(room);
    const res = await startBot(created.bot.id);
    expect(res.statusCode).toBe(409);
    expect(botRow(created.bot.id).status).toBe('ready');
  });

  it('errors a starting bot when the room is deleted before claim', async () => {
    const created = (await createBot({ seat: 1 })).json();
    await startBot(created.bot.id);
    ctx.db.prepare('UPDATE rooms SET deleted = 1 WHERE id = ?').run(room);
    expect(claimStartingBot(ctx.db, created.bot.id)).toBeNull();
    expect(botRow(created.bot.id).status).toBe('error');
  });

  it('GET reports the runtime seat when room_players and bot_accounts disagree', async () => {
    const created = (await createBot({ seat: 1 })).json();
    ctx.db
      .prepare('UPDATE room_players SET seat = 5 WHERE room_id = ? AND user_id = ?')
      .run(room, created.bot.userId);
    const list = await ctx.app.inject({ url: `/api/rooms/${room}/bots`, headers: auth(hostToken) });
    const bot = list.json().bots.find((b: { id: string }) => b.id === created.bot.id);
    expect(bot.seat).toBe(5);
    expect(bot.configuredSeat).toBe(1);
  });
});

describe('shared buy service', () => {
  it('enforces the amount cap inside the service, not only the route', () => {
    expect(() => requestRoomBuy(ctx.db, { roomId: room, userId: hostId, amount: 0 })).toThrow(
      BuyServiceError,
    );
    expect(() =>
      requestRoomBuy(ctx.db, { roomId: room, userId: hostId, amount: 10 ** 15 }),
    ).toThrow(BuyServiceError);
  });

  it('keeps /buy behaviour: pending request, banker approval, ledger and stack', async () => {
    // The shared room defaults to auto-approval; this case is about the manual
    // request -> approval path, so turn it off first.
    ctx.db.prepare('UPDATE rooms SET auto_approve_buys = 0 WHERE id = ?').run(room);
    const buy = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room}/buy`,
      headers: auth(hostToken),
      payload: { amount: 1500 },
    });
    expect(buy.statusCode).toBe(200);
    expect(buy.json().status).toBe('pending');

    const requests = await ctx.app.inject({ url: `/api/rooms/${room}/requests`, headers: auth(hostToken) });
    expect(requests.json().requests).toHaveLength(1);

    const approve = await ctx.app.inject({
      method: 'POST',
      url: `/api/rooms/${room}/approve`,
      headers: auth(hostToken),
      payload: { requestId: buy.json().id, approve: true },
    });
    expect(approve.statusCode).toBe(200);
    expect(stackOf(hostId)).toBe(1500);
    const ledger = ctx.db
      .prepare("SELECT SUM(delta) AS s FROM ledger WHERE room_id = ? AND user_id = ? AND kind = 'purchase'")
      .get(room, hostId) as { s: number };
    expect(ledger.s).toBe(1500);
  });
});

describe('bot difficulty', () => {
  /**
   * A bare bot schema (current `medium` default) plus the migration's `meta`
   * marker table, so `migrateBots` can be driven directly without a full
   * `openDb`.
   */
  function botSchemaDb() {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE bot_accounts (
        id TEXT PRIMARY KEY, room_id TEXT NOT NULL, owner_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL UNIQUE, status TEXT NOT NULL, policy_kind TEXT NOT NULL,
        policy_json TEXT, difficulty TEXT NOT NULL DEFAULT 'medium', seat INTEGER,
        identity_ct TEXT, identity_nonce TEXT, identity_tag TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, stopped_at INTEGER,
        stop_requested_at INTEGER
      );
      CREATE TABLE agent_grants (
        id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, token_hash TEXT NOT NULL, label TEXT,
        scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL, can_play INTEGER NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    `);
    return db;
  }

  function difficultyOf(db: Database.Database, id: string): string {
    return (
      db.prepare('SELECT difficulty FROM bot_accounts WHERE id = ?').get(id) as {
        difficulty: string;
      }
    ).difficulty;
  }

  function insertBot(db: Database.Database, id: string, difficulty: string, userId: number): void {
    db.prepare(
      "INSERT INTO bot_accounts (id, room_id, owner_id, user_id, status, policy_kind, difficulty, created_at, updated_at) VALUES (?, 'r1', 1, ?, 'ready', 'scripted', ?, 0, 0)",
    ).run(id, userId, difficulty);
  }

  it('defaults to medium and persists it on create and GET', async () => {
    const created = (await createBot({ seat: 1 })).json();
    expect(created.bot.difficulty).toBe('medium');
    expect(botRow(created.bot.id).difficulty).toBe('medium');

    const list = await ctx.app.inject({ url: `/api/rooms/${room}/bots`, headers: auth(hostToken) });
    const listed = list.json().bots.find((b: { id: string }) => b.id === created.bot.id);
    expect(listed.difficulty).toBe('medium');
  });

  it('accepts low / medium and persists the value verbatim', async () => {
    for (const [i, difficulty] of (['low', 'medium'] as const).entries()) {
      const created = (await createBot({ seat: i + 1, difficulty })).json();
      expect(created.bot.difficulty).toBe(difficulty);
      expect(botRow(created.bot.id).difficulty).toBe(difficulty);
    }
  });

  it('rejects the withdrawn high tier with 400 and creates no bot', async () => {
    const res = await createBot({ seat: 1, difficulty: 'high' });
    expect(res.statusCode).toBe(400);
    expect((ctx.db.prepare('SELECT COUNT(*) AS n FROM bot_accounts').get() as { n: number }).n).toBe(0);
  });

  it('rejects an unknown difficulty with 400 and creates no bot', async () => {
    const res = await createBot({ seat: 1, difficulty: 'galaxy-brain' });
    expect(res.statusCode).toBe(400);
    expect((ctx.db.prepare('SELECT COUNT(*) AS n FROM bot_accounts').get() as { n: number }).n).toBe(0);
  });

  it('carries the difficulty through claimStartingBot to the runner', async () => {
    const created = (await createBot({ seat: 1, difficulty: 'medium' })).json();
    await startBot(created.bot.id);
    const claim = claimStartingBot(ctx.db, created.bot.id)!;
    expect(claim.difficulty).toBe('medium');
    expect(claim.policyKind).toBe('scripted');
  });

  it('migrates a pre-difficulty schema in place and stays idempotent', () => {
    const legacy = new Database(':memory:');
    try {
      // Fixture: the exact bot schema from before this lane (no `difficulty`),
      // plus an `agent_grants` table without the bot columns, so `migrateBots`
      // must add every new column to an existing, populated database.
      legacy.exec(`
        CREATE TABLE bot_accounts (
          id TEXT PRIMARY KEY, room_id TEXT NOT NULL, owner_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL UNIQUE, status TEXT NOT NULL, policy_kind TEXT NOT NULL,
          policy_json TEXT, seat INTEGER, identity_ct TEXT, identity_nonce TEXT, identity_tag TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, stopped_at INTEGER,
          stop_requested_at INTEGER
        );
        CREATE TABLE agent_grants (
          id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, token_hash TEXT NOT NULL, label TEXT,
          scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL, can_play INTEGER NOT NULL,
          created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
        );
      `);
      legacy
        .prepare(
          "INSERT INTO bot_accounts (id, room_id, owner_id, user_id, status, policy_kind, created_at, updated_at) VALUES ('legacy_bot', 'r1', 1, 2, 'ready', 'scripted', 0, 0)",
        )
        .run();

      migrateBots(legacy);

      const cols = legacy.pragma('table_info(bot_accounts)') as { name: string }[];
      expect(cols.some((col) => col.name === 'difficulty')).toBe(true);
      expect(
        (
          legacy.prepare("SELECT difficulty FROM bot_accounts WHERE id = 'legacy_bot'").get() as {
            difficulty: string;
          }
        ).difficulty,
      ).toBe('medium');

      // Re-running is a no-op (no duplicate-column error) and preserves data.
      expect(() => migrateBots(legacy)).not.toThrow();
      expect(
        (
          legacy.prepare("SELECT difficulty FROM bot_accounts WHERE id = 'legacy_bot'").get() as {
            difficulty: string;
          }
        ).difficulty,
      ).toBe('medium');
    } finally {
      legacy.close();
    }
  });

  it('upgrades legacy low (old default) and withdrawn high rows to medium, idempotently', () => {
    const legacy = new Database(':memory:');
    try {
      // An existing DB that already has `difficulty` with the OLD `low` default;
      // `ensureColumn` must not rewrite the column, so the boot migration is the
      // only thing that moves the stored rows.
      legacy.exec(`
        CREATE TABLE bot_accounts (
          id TEXT PRIMARY KEY, room_id TEXT NOT NULL, owner_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL UNIQUE, status TEXT NOT NULL, policy_kind TEXT NOT NULL,
          policy_json TEXT, difficulty TEXT NOT NULL DEFAULT 'low', seat INTEGER,
          identity_ct TEXT, identity_nonce TEXT, identity_tag TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, stopped_at INTEGER,
          stop_requested_at INTEGER
        );
        CREATE TABLE agent_grants (
          id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, token_hash TEXT NOT NULL, label TEXT,
          scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL, can_play INTEGER NOT NULL,
          created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
        );
      `);
      const ins = legacy.prepare(
        "INSERT INTO bot_accounts (id, room_id, owner_id, user_id, status, policy_kind, difficulty, created_at, updated_at) VALUES (?, 'r1', 1, ?, 'ready', 'scripted', ?, 0, 0)",
      );
      ins.run('old_low', 2, 'low');
      ins.run('old_high', 3, 'high');
      ins.run('already_medium', 4, 'medium');
      ins.run('odd_value', 5, 'martian');

      migrateBots(legacy);

      const difficultyOf = (id: string) =>
        (
          legacy.prepare('SELECT difficulty FROM bot_accounts WHERE id = ?').get(id) as {
            difficulty: string;
          }
        ).difficulty;
      expect(difficultyOf('old_low')).toBe('medium');
      expect(difficultyOf('old_high')).toBe('medium');
      expect(difficultyOf('already_medium')).toBe('medium');
      // Unknown values are left for the resolver's fallback, not rewritten here.
      expect(difficultyOf('odd_value')).toBe('martian');

      // Idempotent: a second boot changes nothing and never throws.
      expect(() => migrateBots(legacy)).not.toThrow();
      expect(difficultyOf('old_low')).toBe('medium');
      expect(difficultyOf('old_high')).toBe('medium');
      // The cut-over is now marked, so a later explicit `low` is never clobbered.
      expect(
        legacy.prepare("SELECT value FROM meta WHERE key = 'bot-difficulty-medium-1'").get(),
      ).toBeTruthy();
    } finally {
      legacy.close();
    }
  });

  it('keeps a user-chosen low across restarts once the marker is written', () => {
    const legacy = botSchemaDb();
    try {
      // First boot: the marker is written and there is nothing to cut over.
      migrateBots(legacy);
      expect(
        legacy.prepare("SELECT value FROM meta WHERE key = 'bot-difficulty-medium-1'").get(),
      ).toBeTruthy();

      // The user explicitly creates a `low` bot after the marker exists.
      insertBot(legacy, 'chosen_low', 'low', 9);

      // A restart must NOT re-run the cut-over: the deliberate `low` survives.
      migrateBots(legacy);
      expect(difficultyOf(legacy, 'chosen_low')).toBe('low');
    } finally {
      legacy.close();
    }
  });

  it('corrects a lingering high even when the marker already exists', () => {
    const legacy = botSchemaDb();
    try {
      migrateBots(legacy); // writes the one-shot marker
      // `high` is unwritable now, but a legacy value can still surface (an old
      // server writing during a rolling deploy, or a hand-edited DB).
      insertBot(legacy, 'late_high', 'high', 9);

      migrateBots(legacy);
      expect(difficultyOf(legacy, 'late_high')).toBe('medium');
    } finally {
      legacy.close();
    }
  });
});
