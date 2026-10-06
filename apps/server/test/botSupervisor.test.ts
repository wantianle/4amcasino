import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeadlessClient, type Policy } from '@4am/agent-core';
import { identityFromSeed } from '@4am/mental-poker';
import type { DB } from '../src/db.js';
import { openDb } from '../src/db.js';
import { createUser } from '../src/auth.js';
import { encryptBotSeed } from '../src/botIdentity.js';
import { completeBotStop, type BotStatus } from '../src/botRoutes.js';
import { BotRunner } from '../src/botRunner.js';
import { BotSupervisor } from '../src/botSupervisor.js';
import { archiveRoom, archiveRoomTx, roomEvents } from '../src/rooms.js';
import { FakeClient, sleep } from './helpers/fakeBotClient.js';

/**
 * Unit tests for the supervisor orchestration. A fake `runnerFactory` keeps the
 * real WS out of the picture; the DB is a real in-memory instance so the claim
 * contract (status -> running + fresh grant) is genuinely exercised. The
 * start/stop-race and fatal-release tests use a real `BotRunner` with a fake
 * client to drive the actual lifecycle.
 */

const KEY = 'ab'.repeat(32);
const ORIGINAL_KEY = process.env.BOT_IDENTITY_KEY;
let seq = 0;

async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(10);
  }
  throw new Error('waitFor timed out');
}

function seedBot(db: DB, status: BotStatus = 'starting') {
  const seed = randomBytes(32);
  const identity = identityFromSeed(seed);
  const enc = encryptBotSeed(seed.toString('hex'));
  const { userId } = createUser(
    db,
    `bot_u_${seq++}_${randomBytes(3).toString('hex')}`,
    randomBytes(32).toString('hex'),
    identity.publicKey,
  );
  const roomId = randomBytes(6).toString('hex');
  db.prepare(
    'INSERT INTO rooms(id,name,join_code,host_id,banker_id,sb,bb,created_at) VALUES(?,?,?,?,?,?,?,?)',
  ).run(roomId, 'Room', randomBytes(4).toString('hex').toUpperCase(), userId, userId, 10, 20, Date.now());
  db.prepare('INSERT INTO room_players(room_id,user_id,seat,stack) VALUES(?,?,?,?)').run(
    roomId,
    userId,
    0,
    1000,
  );
  const botId = randomBytes(6).toString('hex');
  db.prepare(
    `INSERT INTO bot_accounts
       (id, room_id, owner_id, user_id, status, policy_kind, policy_json, seat,
        identity_ct, identity_nonce, identity_tag, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'scripted', NULL, 0, ?, ?, ?, ?, ?)`,
  ).run(botId, roomId, userId, userId, status, enc.ct, enc.nonce, enc.tag, Date.now(), Date.now());
  return { botId, userId, roomId };
}

/**
 * Add another bot to an existing room (distinct user + seat), so per-room pool
 * tests can put several bots in one room. Returned shape matches `seedBot`.
 */
function addBotToRoom(db: DB, room: { roomId: string; userId: number }, seat: number, status: BotStatus = 'starting') {
  const seed = randomBytes(32);
  const identity = identityFromSeed(seed);
  const enc = encryptBotSeed(seed.toString('hex'));
  const { userId } = createUser(
    db,
    `bot_u_${seq++}_${randomBytes(3).toString('hex')}`,
    randomBytes(32).toString('hex'),
    identity.publicKey,
  );
  db.prepare('INSERT INTO room_players(room_id,user_id,seat,stack) VALUES(?,?,?,?)').run(
    room.roomId,
    userId,
    seat,
    1000,
  );
  const botId = randomBytes(6).toString('hex');
  db.prepare(
    `INSERT INTO bot_accounts
       (id, room_id, owner_id, user_id, status, policy_kind, policy_json, seat,
        identity_ct, identity_nonce, identity_tag, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'scripted', NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(
    botId,
    room.roomId,
    room.userId,
    userId,
    status,
    seat,
    enc.ct,
    enc.nonce,
    enc.tag,
    Date.now(),
    Date.now(),
  );
  return { botId, userId, roomId: room.roomId };
}

function insertGrant(db: DB, id: string, botId: string, userId: number, roomId: string): void {
  db.prepare(
    `INSERT INTO agent_grants(id,user_id,token_hash,label,scope_kind,scope_id,can_play,created_at,expires_at,grant_kind,bot_id)
     VALUES(?, ?, ?, 'stale', 'room', ?, 1, 0, ?, 'bot_runner', ?)`,
  ).run(id, userId, id, roomId, Date.now() + 100000, botId);
}

function statusOf(db: DB, botId: string): string {
  return (db.prepare('SELECT status FROM bot_accounts WHERE id = ?').get(botId) as { status: string })
    .status;
}

function activeGrants(db: DB, botId: string): number {
  return (
    db
      .prepare('SELECT COUNT(*) AS n FROM agent_grants WHERE bot_id = ? AND revoked_at IS NULL')
      .get(botId) as { n: number }
  ).n;
}

function fakeRunner(onStop?: () => void) {
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {
      onStop?.();
      resolveDone();
    }),
    done,
  };
}

beforeEach(() => {
  process.env.BOT_IDENTITY_KEY = KEY;
});
afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.BOT_IDENTITY_KEY;
  else process.env.BOT_IDENTITY_KEY = ORIGINAL_KEY;
});

describe('BotSupervisor', () => {
  it('claims a starting bot, launches a runner, then stops and revokes', async () => {
    const db = openDb(':memory:');
    const { botId } = seedBot(db, 'starting');
    const runner = fakeRunner();
    const sup = new BotSupervisor(db, {
      baseUrl: 'http://127.0.0.1:1',
      maxConcurrent: 2,
      runnerFactory: () => runner,
    });

    sup.startBot(botId);
    // Claim is synchronous: the state flips and the grant lands before we return.
    expect(statusOf(db, botId)).toBe('running');
    expect(activeGrants(db, botId)).toBe(1);
    expect(sup.hasRunner(botId)).toBe(true);
    expect(sup.runningCount()).toBe(1);
    expect(runner.start).toHaveBeenCalledTimes(1);

    await sup.stopBot(botId);
    expect(runner.stop).toHaveBeenCalledTimes(1);
    expect(statusOf(db, botId)).toBe('stopped');
    expect(activeGrants(db, botId)).toBe(0);
    expect(sup.hasRunner(botId)).toBe(false);
  });

  it('queues a start beyond the budget, then drains it when a slot frees', async () => {
    const db = openDb(':memory:');
    const first = seedBot(db, 'starting');
    const second = seedBot(db, 'starting');
    const sup = new BotSupervisor(db, {
      baseUrl: 'http://127.0.0.1:1',
      maxConcurrent: 1,
      runnerFactory: () => fakeRunner(),
    });

    sup.startBot(first.botId);
    expect(sup.canStart()).toBe(false);
    sup.startBot(second.botId);

    expect(statusOf(db, first.botId)).toBe('running');
    // Queued, not claimed: it must not be stranded or double-run.
    expect(statusOf(db, second.botId)).toBe('starting');
    expect(sup.hasRunner(second.botId)).toBe(false);
    expect(sup.pendingCount()).toBe(1);
    expect(activeGrants(db, second.botId)).toBe(0);

    // Freeing the slot starts the queued bot.
    await sup.stopBot(first.botId);
    await waitFor(() => statusOf(db, second.botId) === 'running');
    expect(sup.hasRunner(second.botId)).toBe(true);
    await sup.stopBot(second.botId);
  });

  it('releases the concurrency slot when a runner fatals', async () => {
    const db = openDb(':memory:');
    const a = seedBot(db, 'starting');
    const b = seedBot(db, 'starting');
    const client = new FakeClient();
    const throwing: Policy = {
      name: 'boom',
      decide: async () => {
        throw new Error('boom');
      },
    };
    const sup = new BotSupervisor(db, {
      baseUrl: 'http://127.0.0.1:1',
      maxConcurrent: 1,
      runnerFactory: (_db, claim, opts) =>
        claim.bot.id === a.botId
          ? new BotRunner(_db, claim, {
              ...opts,
              clientFactory: () => client as unknown as HeadlessClient,
              policy: throwing,
              pollMs: 1,
            })
          : fakeRunner(),
    });

    sup.startBot(a.botId);
    expect(sup.runningCount()).toBe(1);
    await waitFor(() => statusOf(db, a.botId) === 'error');
    // The slot is freed only once the runner has fully exited.
    await waitFor(() => !sup.hasRunner(a.botId));
    expect(sup.runningCount()).toBe(0);
    expect(sup.canStart()).toBe(true);

    // And the freed capacity is genuinely reusable.
    sup.startBot(b.botId);
    expect(statusOf(db, b.botId)).toBe('running');
    expect(sup.hasRunner(b.botId)).toBe(true);
    await sup.stopBot(b.botId);
  });

  it('start/stop race cancels startup, closes the socket and releases the slot', async () => {
    const db = openDb(':memory:');
    const { botId } = seedBot(db, 'starting');
    const client = new FakeClient();
    client.live = false; // no hand: a cancelled startup should close cleanly
    let releaseLogin!: () => void;
    client.loginBlock = new Promise<void>((resolve) => {
      releaseLogin = resolve;
    });
    const sup = new BotSupervisor(db, {
      baseUrl: 'http://127.0.0.1:1',
      maxConcurrent: 2,
      runnerFactory: (_db, claim, opts) =>
        new BotRunner(_db, claim, {
          ...opts,
          clientFactory: () => client as unknown as HeadlessClient,
          pollMs: 1,
          settleMs: 25,
        }),
    });

    sup.startBot(botId);
    // stop lands while loginWithGrant is still blocked; it must wait, not
    // return early, and must leave no live socket behind.
    const stopping = sup.stopBot(botId);
    releaseLogin();
    await stopping;

    expect(client.closed).toBe(true);
    expect(sup.hasRunner(botId)).toBe(false);
    expect(statusOf(db, botId)).toBe('stopped');
    expect(activeGrants(db, botId)).toBe(0);
  });

  it('recover re-claims a bot left running by a previous process with a fresh grant', () => {
    const db = openDb(':memory:');
    const { botId, userId, roomId } = seedBot(db, 'running');
    insertGrant(db, 'stale', botId, userId, roomId);
    expect(activeGrants(db, botId)).toBe(1);

    const runner = fakeRunner();
    const sup = new BotSupervisor(db, {
      baseUrl: 'http://127.0.0.1:1',
      maxConcurrent: 2,
      runnerFactory: () => runner,
    });
    sup.recover();

    expect(statusOf(db, botId)).toBe('running');
    expect(sup.hasRunner(botId)).toBe(true);
    // The old grant was revoked in the running->starting transaction and the
    // claim issued exactly one fresh grant.
    expect(activeGrants(db, botId)).toBe(1);
    expect(
      (db.prepare("SELECT revoked_at FROM agent_grants WHERE id = 'stale'").get() as {
        revoked_at: number | null;
      }).revoked_at,
    ).not.toBeNull();
  });

  it('recover finalizes a bot left stopping, leaving no runner and no live grant', () => {
    const db = openDb(':memory:');
    const { botId, userId, roomId } = seedBot(db, 'stopping');
    insertGrant(db, 'live', botId, userId, roomId);
    expect(activeGrants(db, botId)).toBe(1);

    const sup = new BotSupervisor(db, {
      baseUrl: 'http://127.0.0.1:1',
      maxConcurrent: 2,
      runnerFactory: () => fakeRunner(),
    });
    sup.recover();

    expect(statusOf(db, botId)).toBe('stopped');
    expect(activeGrants(db, botId)).toBe(0);
    expect(sup.hasRunner(botId)).toBe(false);
  });

  it('recover finishes a hard delete interrupted by a restart', () => {
    const db = openDb(':memory:');
    const { botId, userId, roomId } = seedBot(db, 'stopping');
    insertGrant(db, 'stale', botId, userId, roomId);
    db.prepare('UPDATE bot_accounts SET delete_requested_at = ? WHERE id = ?').run(Date.now(), botId);

    const sup = new BotSupervisor(db, {
      baseUrl: 'http://127.0.0.1:1',
      maxConcurrent: 2,
      runnerFactory: () => fakeRunner(),
    });
    sup.recover();

    // The delete intent survived the restart and was finished, rather than the
    // bot being turned back into a live `stopped` row.
    expect(db.prepare('SELECT 1 FROM bot_accounts WHERE id = ?').get(botId)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM agent_grants WHERE bot_id = ?').get(botId)).toBeUndefined();
    expect(
      db.prepare('SELECT 1 FROM room_players WHERE room_id = ? AND user_id = ?').get(roomId, userId),
    ).toBeUndefined();
    expect(sup.hasRunner(botId)).toBe(false);
  });

  it('completeBotStop refuses an illegal source without revoking the grant', () => {
    const db = openDb(':memory:');
    const { botId, userId, roomId } = seedBot(db, 'running');
    insertGrant(db, 'live', botId, userId, roomId);
    expect(activeGrants(db, botId)).toBe(1);

    // `running` is not a legal finalize source: must not revoke (that would
    // leave the bot running with no usable token).
    expect(completeBotStop(db, botId)).toBe(false);
    expect(statusOf(db, botId)).toBe('running');
    expect(activeGrants(db, botId)).toBe(1);

    // From `stopping` it finalizes and revokes.
    db.prepare("UPDATE bot_accounts SET status = 'stopping' WHERE id = ?").run(botId);
    expect(completeBotStop(db, botId)).toBe(true);
    expect(statusOf(db, botId)).toBe('stopped');
    expect(activeGrants(db, botId)).toBe(0);
  });

  it('marks the bot error when runner construction throws (never running without a runner)', () => {
    const db = openDb(':memory:');
    const { botId } = seedBot(db, 'starting');
    const sup = new BotSupervisor(db, {
      baseUrl: 'http://127.0.0.1:1',
      maxConcurrent: 2,
      runnerFactory: () => {
        throw new Error('constructor boom');
      },
    });

    sup.startBot(botId);

    // The claim flipped it to `running`; the throw must be caught and errored.
    expect(statusOf(db, botId)).toBe('error');
    expect(sup.hasRunner(botId)).toBe(false);
    expect(activeGrants(db, botId)).toBe(0);
  });

  it('finalizes stop and remove even when the runner rejects', async () => {
    const db = openDb(':memory:');
    const scenario = (stop: 'stop' | 'remove') => {
      const { botId } = seedBot(db, 'starting');
      const sup = new BotSupervisor(db, {
        baseUrl: 'http://127.0.0.1:1',
        maxConcurrent: 2,
        runnerFactory: () => ({
          start: vi.fn(async () => {}),
          stop: vi.fn(async () => {
            throw new Error(`${stop} boom`);
          }),
          done: new Promise<void>(() => {}), // never resolves
        }),
      });
      sup.startBot(botId);
      expect(activeGrants(db, botId)).toBe(1);
      return { sup, botId };
    };

    const stopped = scenario('stop');
    await stopped.sup.stopBot(stopped.botId); // must not reject
    expect(statusOf(db, stopped.botId)).toBe('stopped');
    expect(activeGrants(db, stopped.botId)).toBe(0);
    expect(stopped.sup.hasRunner(stopped.botId)).toBe(false);

    const removed = scenario('remove');
    await removed.sup.removeBot(removed.botId); // must not reject
    // Removal hard-deletes the row (the old soft-delete `removed` flag is gone).
    expect(
      db.prepare('SELECT 1 FROM bot_accounts WHERE id = ?').get(removed.botId),
    ).toBeUndefined();
    expect(activeGrants(db, removed.botId)).toBe(0);
    expect(removed.sup.hasRunner(removed.botId)).toBe(false);
  });

  it('refuses new starts once stopAll has begun (shutdown gate)', async () => {
    const db = openDb(':memory:');
    const a = seedBot(db, 'starting');
    const b = seedBot(db, 'starting');
    let releaseStop!: () => void;
    const gated = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const sup = new BotSupervisor(db, {
      baseUrl: 'http://127.0.0.1:1',
      maxConcurrent: 2,
      runnerFactory: (_db, claim) => ({
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {
          if (claim.bot.id === a.botId) await gated;
        }),
        done: new Promise<void>(() => {}),
      }),
    });
    sup.startBot(a.botId); // running
    const shutdown = sup.stopAll(); // sets the gate, then blocks on a's stop

    expect(sup.isShuttingDown()).toBe(true);
    expect(sup.canStart()).toBe(false);
    sup.startBot(b.botId); // must be refused: no claim, no enqueue, no grant
    expect(sup.hasRunner(b.botId)).toBe(false);
    expect(sup.pendingCount()).toBe(0);
    expect(statusOf(db, b.botId)).toBe('starting');
    expect(activeGrants(db, b.botId)).toBe(0);

    releaseStop();
    await shutdown;
    expect(statusOf(db, a.botId)).toBe('stopped');
    expect(activeGrants(db, a.botId)).toBe(0);
  });

  it('stopAll runs once and concurrent callers share the same completion', async () => {
    const db = openDb(':memory:');
    const { botId } = seedBot(db, 'starting');
    const stop = vi.fn(async () => {});
    const sup = new BotSupervisor(db, {
      baseUrl: 'http://127.0.0.1:1',
      maxConcurrent: 2,
      runnerFactory: () => ({
        start: vi.fn(async () => {}),
        stop,
        done: new Promise<void>(() => {}),
      }),
    });
    sup.startBot(botId);
    await Promise.all([sup.stopAll(), sup.stopAll(), sup.stopAll()]);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(statusOf(db, botId)).toBe('stopped');
  });

  it('finalizeAllRuntimeBots forces runtime bots to stopped and revokes grants', () => {
    const db = openDb(':memory:');
    const a = seedBot(db, 'running');
    const b = seedBot(db, 'stopping');
    const c = seedBot(db, 'starting');
    insertGrant(db, `${a.botId}-g`, a.botId, a.userId, a.roomId);
    insertGrant(db, `${b.botId}-g`, b.botId, b.userId, b.roomId);
    insertGrant(db, `${c.botId}-g`, c.botId, c.userId, c.roomId);

    const sup = new BotSupervisor(db, {
      baseUrl: 'http://127.0.0.1:1',
      runnerFactory: () => fakeRunner(),
    });
    expect(sup.finalizeAllRuntimeBots()).toBe(3);
    for (const x of [a, b, c]) {
      expect(statusOf(db, x.botId)).toBe('stopped');
      expect(activeGrants(db, x.botId)).toBe(0);
    }
  });

  it('stopAll finalizes queued starting bots too', async () => {
    const db = openDb(':memory:');
    const a = seedBot(db, 'starting');
    const b = seedBot(db, 'starting');
    const sup = new BotSupervisor(db, {
      baseUrl: 'http://127.0.0.1:1',
      maxConcurrent: 1,
      runnerFactory: () => fakeRunner(),
    });
    sup.startBot(a.botId); // running
    sup.startBot(b.botId); // queued (starting, never claimed)
    expect(sup.pendingCount()).toBe(1);
    expect(statusOf(db, b.botId)).toBe('starting');

    await sup.stopAll();

    // Neither a running nor a queued bot is left behind without a runner.
    expect(statusOf(db, a.botId)).toBe('stopped');
    expect(statusOf(db, b.botId)).toBe('stopped');
    expect(sup.runningCount()).toBe(0);
    expect(sup.pendingCount()).toBe(0);
  });

  it('stopAll still finalizes when a runner rejects on stop', async () => {
    const db = openDb(':memory:');
    const { botId } = seedBot(db, 'starting');
    const sup = new BotSupervisor(db, {
      baseUrl: 'http://127.0.0.1:1',
      maxConcurrent: 2,
      runnerFactory: () => ({
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {
          throw new Error('stopAll boom');
        }),
        done: new Promise<void>(() => {}),
      }),
    });
    sup.startBot(botId);
    expect(activeGrants(db, botId)).toBe(1);

    await sup.stopAll(); // allSettled swallows the rejection, finalize still runs

    expect(statusOf(db, botId)).toBe('stopped');
    expect(activeGrants(db, botId)).toBe(0);
  });

  it('stopAll stops every runner and persists stopped + revokes grants', async () => {
    const db = openDb(':memory:');
    const a = seedBot(db, 'starting');
    const b = seedBot(db, 'starting');
    const stopped: string[] = [];
    const sup = new BotSupervisor(db, {
      baseUrl: 'http://127.0.0.1:1',
      maxConcurrent: 2,
      runnerFactory: (_db, claim) => fakeRunner(() => stopped.push(claim.bot.id)),
    });
    sup.startBot(a.botId);
    sup.startBot(b.botId);
    expect(activeGrants(db, a.botId)).toBe(1);
    expect(activeGrants(db, b.botId)).toBe(1);

    await sup.stopAll();

    expect(stopped.sort()).toEqual([a.botId, b.botId].sort());
    expect(sup.runningCount()).toBe(0);
    // Clean shutdown leaves no `running` bot with a live grant behind.
    for (const id of [a.botId, b.botId]) {
      expect(statusOf(db, id)).toBe('stopped');
      expect(activeGrants(db, id)).toBe(0);
    }
  });

  it('caps a single room at the default 8 runners and queues its ninth', () => {
    const db = openDb(':memory:');
    const base = seedBot(db, 'starting');
    // Nine bots in the SAME room; the old model shared the budget across rooms.
    const bots = [base, ...Array.from({ length: 8 }, (_, i) => addBotToRoom(db, base, i + 1))];
    const sup = new BotSupervisor(db, {
      baseUrl: 'http://127.0.0.1:1',
      runnerFactory: () => fakeRunner(),
    });

    for (const b of bots.slice(0, 8)) sup.startBot(b.botId);
    expect(sup.runningCount(base.roomId)).toBe(8);
    expect(sup.canStart(base.roomId)).toBe(false);

    // The ninth start is queued, not dropped and not over-launched.
    sup.startBot(bots[8]!.botId);
    expect(sup.pendingCount()).toBe(1);
    expect(statusOf(db, bots[8]!.botId)).toBe('starting');
    expect(sup.runningCount(base.roomId)).toBe(8);
  });

  it('keeps room pools independent: a full room never blocks another room', async () => {
    const db = openDb(':memory:');
    const roomA = seedBot(db, 'starting');
    const a2 = addBotToRoom(db, roomA, 1); // same room A
    const roomB = seedBot(db, 'starting'); // its own room
    const sup = new BotSupervisor(db, {
      baseUrl: 'http://127.0.0.1:1',
      maxPerRoom: 1,
      runnerFactory: () => fakeRunner(),
    });

    sup.startBot(roomA.botId);
    expect(sup.canStart(roomA.roomId)).toBe(false);
    // Room B is completely unaffected by A being full.
    expect(sup.canStart(roomB.roomId)).toBe(true);

    sup.startBot(a2.botId); // room A full -> queued
    sup.startBot(roomB.botId); // room B -> runs immediately
    expect(statusOf(db, roomB.botId)).toBe('running');
    expect(sup.hasRunner(roomB.botId)).toBe(true);
    expect(sup.pendingCount()).toBe(1);
    expect(sup.hasRunner(a2.botId)).toBe(false);

    // Freeing A's slot drains A's queue only, leaving B's runner untouched.
    await sup.stopBot(roomA.botId);
    await waitFor(() => statusOf(db, a2.botId) === 'running');
    expect(sup.hasRunner(roomB.botId)).toBe(true);
    await sup.stopBot(a2.botId);
    await sup.stopBot(roomB.botId);
  });

  it('releases a room runner + its queued bots when the room is archived (/close)', async () => {
    const db = openDb(':memory:');
    const base = seedBot(db, 'starting');
    const queued = addBotToRoom(db, base, 1);
    const runner = fakeRunner();
    const sup = new BotSupervisor(db, {
      baseUrl: 'http://127.0.0.1:1',
      maxPerRoom: 1,
      runnerFactory: () => runner,
    });
    sup.subscribeRoomEvents();
    try {
      sup.startBot(base.botId);
      sup.startBot(queued.botId);
      expect(statusOf(db, base.botId)).toBe('running');
      expect(sup.pendingCount()).toBe(1);

      archiveRoom(db, base.roomId);
      roomEvents.emit('changed', base.roomId);

      await waitFor(() => statusOf(db, base.botId) === 'stopped');
      // The running runner was genuinely stopped (not just its seat cleared).
      expect(runner.stop).toHaveBeenCalledTimes(1);
      expect(sup.hasRunner(base.botId)).toBe(false);
      expect(activeGrants(db, base.botId)).toBe(0);
      // The queued `starting` bot is dequeued and finalized too: no dangling.
      expect(sup.pendingCount()).toBe(0);
      expect(statusOf(db, queued.botId)).toBe('stopped');
      expect(activeGrants(db, queued.botId)).toBe(0);
    } finally {
      sup.detachRoomEvents();
    }
  });

  it('releases the runner when archived (archiveRoomTx + event)', async () => {
    const db = openDb(':memory:');
    const { botId, roomId } = seedBot(db, 'starting');
    const runner = fakeRunner();
    const sup = new BotSupervisor(db, {
      baseUrl: 'http://127.0.0.1:1',
      runnerFactory: () => runner,
    });
    sup.subscribeRoomEvents();
    try {
      sup.startBot(botId);
      // Mirrors /close: archiveRoomTx then the room change event.
      db.transaction(() => archiveRoomTx(db, roomId))();
      roomEvents.emit('changed', roomId);

      await waitFor(() => statusOf(db, botId) === 'stopped');
      expect(sup.hasRunner(botId)).toBe(false);
      expect(activeGrants(db, botId)).toBe(0);
    } finally {
      sup.detachRoomEvents();
    }
  });

  it('releases the runner when the room is deleted', async () => {
    const db = openDb(':memory:');
    const { botId, roomId } = seedBot(db, 'starting');
    const sup = new BotSupervisor(db, {
      baseUrl: 'http://127.0.0.1:1',
      runnerFactory: () => fakeRunner(),
    });
    sup.subscribeRoomEvents();
    try {
      sup.startBot(botId);
      // Mirrors admin direct delete: raw UPDATE then `changed`.
      db.prepare('UPDATE rooms SET deleted = 1, deleted_at = ? WHERE id = ?').run(Date.now(), roomId);
      roomEvents.emit('changed', roomId);

      await waitFor(() => statusOf(db, botId) === 'stopped');
      expect(sup.hasRunner(botId)).toBe(false);
      expect(activeGrants(db, botId)).toBe(0);
    } finally {
      sup.detachRoomEvents();
    }
  });

  it('recover never resurrects runners for an archived/deleted room', () => {
    const db = openDb(':memory:');
    const retired = seedBot(db, 'running');
    const live = seedBot(db, 'running');
    db.prepare('UPDATE rooms SET archived = 1, archived_at = ? WHERE id = ?').run(
      Date.now(),
      retired.roomId,
    );

    const sup = new BotSupervisor(db, {
      baseUrl: 'http://127.0.0.1:1',
      runnerFactory: () => fakeRunner(),
    });
    sup.recover();

    // The retired room's bot is finalized, not re-claimed into a ghost slot.
    expect(statusOf(db, retired.botId)).toBe('stopped');
    expect(activeGrants(db, retired.botId)).toBe(0);
    expect(sup.hasRunner(retired.botId)).toBe(false);
    // The active room still recovers normally.
    expect(statusOf(db, live.botId)).toBe('running');
    expect(sup.hasRunner(live.botId)).toBe(true);
  });

  it('honours a BOT_MAX_CONCURRENT-style override above the default', () => {
    const prev = process.env.BOT_MAX_CONCURRENT;
    try {
      // Mirrors the `index.ts` wiring: the env value is parsed and passed through.
      process.env.BOT_MAX_CONCURRENT = '9';
      const db = openDb(':memory:');
      const bots = Array.from({ length: 9 }, () => seedBot(db, 'starting'));
      const sup = new BotSupervisor(db, {
        baseUrl: 'http://127.0.0.1:1',
        maxConcurrent: Number(process.env.BOT_MAX_CONCURRENT ?? 8),
        runnerFactory: () => fakeRunner(),
      });

      for (const b of bots) sup.startBot(b.botId);
      expect(sup.runningCount()).toBe(9);
      expect(sup.canStart()).toBe(false);
      expect(sup.pendingCount()).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.BOT_MAX_CONCURRENT;
      else process.env.BOT_MAX_CONCURRENT = prev;
    }
  });

  it('honours a BOT_MAX_CONCURRENT-style override below the default', () => {
    const prev = process.env.BOT_MAX_CONCURRENT;
    try {
      process.env.BOT_MAX_CONCURRENT = '2';
      const db = openDb(':memory:');
      const bots = Array.from({ length: 3 }, () => seedBot(db, 'starting'));
      const sup = new BotSupervisor(db, {
        baseUrl: 'http://127.0.0.1:1',
        maxConcurrent: Number(process.env.BOT_MAX_CONCURRENT ?? 8),
        runnerFactory: () => fakeRunner(),
      });

      for (const b of bots.slice(0, 2)) sup.startBot(b.botId);
      expect(sup.runningCount()).toBe(2);
      expect(sup.canStart()).toBe(false);
      sup.startBot(bots[2]!.botId);
      expect(sup.pendingCount()).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.BOT_MAX_CONCURRENT;
      else process.env.BOT_MAX_CONCURRENT = prev;
    }
  });

  it.each([0, -3, Number.NaN, Number.POSITIVE_INFINITY])(
    'falls back to a wide server valve for an illegal maxConcurrent (%s)',
    (illegal) => {
      const db = openDb(':memory:');
      const bots = Array.from({ length: 9 }, () => seedBot(db, 'starting'));
      const sup = new BotSupervisor(db, {
        baseUrl: 'http://127.0.0.1:1',
        maxConcurrent: illegal,
        runnerFactory: () => fakeRunner(),
      });

      for (const b of bots) sup.startBot(b.botId);
      expect(sup.runningCount()).toBe(9);
    },
  );

  it.each([0, -3, Number.NaN, Number.POSITIVE_INFINITY])(
    'falls back to 8 per room for an illegal maxPerRoom (%s)',
    (illegal) => {
      const db = openDb(':memory:');
      const base = seedBot(db, 'starting');
      const bots = [base, ...Array.from({ length: 8 }, (_, i) => addBotToRoom(db, base, i + 1))];
      const sup = new BotSupervisor(db, {
        baseUrl: 'http://127.0.0.1:1',
        maxPerRoom: illegal,
        runnerFactory: () => fakeRunner(),
      });

      for (const b of bots.slice(0, 8)) sup.startBot(b.botId);
      expect(sup.runningCount(base.roomId)).toBe(8);
      expect(sup.canStart(base.roomId)).toBe(false);

      sup.startBot(bots[8]!.botId);
      expect(sup.pendingCount()).toBe(1);
    },
  );

  it('finalizes a wedged removeBot within the supervisor stop timeout', async () => {
    const db = openDb(':memory:');
    const { botId } = seedBot(db, 'starting');
    const sup = new BotSupervisor(db, {
      baseUrl: 'http://127.0.0.1:1',
      maxConcurrent: 2,
      stopTimeoutMs: 40,
      runnerFactory: () => ({
        start: vi.fn(async () => {}),
        stop: vi.fn(() => new Promise<void>(() => {})), // a stop() that never settles
        done: new Promise<void>(() => {}),
      }),
    });
    sup.startBot(botId);
    expect(activeGrants(db, botId)).toBe(1);

    const began = Date.now();
    await sup.removeBot(botId); // must not hang on the wedged runner
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(db.prepare('SELECT 1 FROM bot_accounts WHERE id = ?').get(botId)).toBeUndefined();
    expect(activeGrants(db, botId)).toBe(0);
    expect(sup.hasRunner(botId)).toBe(false);
  });

  it('finalizes a wedged stopBot to stopped within the supervisor stop timeout', async () => {
    const db = openDb(':memory:');
    const { botId } = seedBot(db, 'starting');
    const sup = new BotSupervisor(db, {
      baseUrl: 'http://127.0.0.1:1',
      maxConcurrent: 2,
      stopTimeoutMs: 40,
      runnerFactory: () => ({
        start: vi.fn(async () => {}),
        stop: vi.fn(() => new Promise<void>(() => {})),
        done: new Promise<void>(() => {}),
      }),
    });
    sup.startBot(botId);
    expect(statusOf(db, botId)).toBe('running');

    const began = Date.now();
    await sup.stopBot(botId); // must not hang on the wedged runner
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(statusOf(db, botId)).toBe('stopped');
    expect(activeGrants(db, botId)).toBe(0);
    expect(sup.hasRunner(botId)).toBe(false);
  });
});
