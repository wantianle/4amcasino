import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { genIdentity } from '@4am/mental-poker';
import type { ServerMsg } from '@4am/shared';
import { createApp } from '../src/app.js';
import type { DB } from '../src/db.js';
import { GameRoom } from '../src/game.js';
import { runMigrations } from '../src/migrations/index.js';

/**
 * Blocker B regression: the consecutive-action-timeout streak used to live in an
 * in-memory `Map` on `GameRoom`, so a process restart between the first and
 * second timeout reset it and let a stalling player sit forever. It is now
 * persisted on `room_players.consecutive_action_timeouts`; the defining test is
 * the cross-restart one below (a fresh `GameRoom` over the same DB must still
 * count the earlier timeout).
 */

let ctx: ReturnType<typeof createApp>;
beforeEach(() => {
  ctx = createApp(':memory:');
});
afterEach(async () => {
  await ctx.app.close();
});

const OPTS = { cryptoTimeoutMs: 60_000, actionTimeoutMs: 30_000, shutdownDrainMs: 50 };

/** Users 1 and 2, a room, and one seated `room_players` row each. */
function seedRoom(db: DB, seat1: number | null = 0, seat2: number | null = 1): void {
  const now = 1_700_000_000_000;
  for (const id of [1, 2]) {
    db.prepare(
      'INSERT INTO users (id, username, auth_hash, auth_salt, pubkey, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, `ct_u${id}`, 'h', 's', `pk${id}`, now + id);
  }
  db.prepare('INSERT INTO room_players (room_id, user_id, seat, stack) VALUES (?, ?, ?, ?)').run(
    'r1',
    1,
    seat1,
    1000,
  );
  db.prepare('INSERT INTO room_players (room_id, user_id, seat, stack) VALUES (?, ?, ?, ?)').run(
    'r1',
    2,
    seat2,
    1000,
  );
  db.prepare(
    'INSERT INTO rooms (id, name, join_code, host_id, banker_id, sb, bb, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('r1', 'CT', 'CTJOIN', 1, 1, 5, 10, now);
}

const streakOf = (db: DB, userId: number): number =>
  (
    db
      .prepare(
        'SELECT consecutive_action_timeouts AS s FROM room_players WHERE room_id = ? AND user_id = ?',
      )
      .get('r1', userId) as { s: number }
  ).s;

const seatOf = (db: DB, userId: number): number | null =>
  (
    db.prepare('SELECT seat FROM room_players WHERE room_id = ? AND user_id = ?').get('r1', userId) as {
      seat: number | null;
    }
  ).seat;

/** The private hand-boundary hook the engine calls from `onDone`. */
const applyForcedLeaves = (game: GameRoom): void =>
  (game as unknown as { applyPendingForcedLeaves(): void }).applyPendingForcedLeaves();

function fakeSocket(): WebSocket {
  return {
    send: (raw: string) => void (JSON.parse(raw) as ServerMsg),
  } as unknown as WebSocket;
}

describe('consecutive action timeouts persist across a restart', () => {
  it('a fresh GameRoom still counts the first timeout: the second stands the player up', () => {
    const db = ctx.db;
    seedRoom(db);
    let game = new GameRoom(db, 'r1', genIdentity(), OPTS);
    expect(game.noteTimeout(1)).toBe(false);
    expect(streakOf(db, 1)).toBe(1);
    expect(seatOf(db, 1)).toBe(0);

    // Simulated restart: every in-memory field (the old Map included) is gone,
    // only the database is carried over.
    game = new GameRoom(db, 'r1', genIdentity(), OPTS);
    expect(game.noteTimeout(1)).toBe(true);
    // the streak is cleared the moment the forced leave is triggered...
    expect(streakOf(db, 1)).toBe(0);
    // ...and the seat is released at the hand boundary.
    applyForcedLeaves(game);
    expect(seatOf(db, 1)).toBeNull();
  });

  it('a voluntary action clears the persisted streak (no removal)', () => {
    const db = ctx.db;
    seedRoom(db);
    const game = new GameRoom(db, 'r1', genIdentity(), OPTS);
    expect(game.noteTimeout(1)).toBe(false);
    expect(streakOf(db, 1)).toBe(1);

    game.noteVoluntaryAction(1);
    expect(streakOf(db, 1)).toBe(0);
    // the next timeout is streak 1 again, so it does NOT stand the player up
    expect(game.noteTimeout(1)).toBe(false);
    applyForcedLeaves(game);
    expect(seatOf(db, 1)).toBe(0);
  });

  it('re-sitting clears the persisted streak', () => {
    const db = ctx.db;
    seedRoom(db, null, 0); // user 1 has no seat yet
    const game = new GameRoom(db, 'r1', genIdentity(), OPTS);
    game.join(1, fakeSocket());
    expect(game.noteTimeout(1)).toBe(false);
    expect(streakOf(db, 1)).toBe(1);

    game.handleMessage(1, { t: 'sit', seat: 1 });
    expect(seatOf(db, 1)).toBe(1);
    expect(streakOf(db, 1)).toBe(0);
    // the following timeout is streak 1, not 2
    expect(game.noteTimeout(1)).toBe(false);
  });

  it('a voluntary leave clears the persisted streak', () => {
    const db = ctx.db;
    seedRoom(db);
    const game = new GameRoom(db, 'r1', genIdentity(), OPTS);
    game.join(1, fakeSocket());
    expect(game.noteTimeout(1)).toBe(false);
    expect(streakOf(db, 1)).toBe(1);

    game.handleMessage(1, { t: 'leave_seat' });
    expect(seatOf(db, 1)).toBeNull();
    expect(streakOf(db, 1)).toBe(0);
  });

  it('the migration is idempotent (boot runs it on every open)', () => {
    const db = ctx.db;
    const cols = (): string[] =>
      (db.pragma('table_info(room_players)') as { name: string }[]).map((c) => c.name);
    expect(cols()).toContain('consecutive_action_timeouts');
    runMigrations(db); // a second boot over the same schema
    expect(cols()).toContain('consecutive_action_timeouts');
    expect(cols().filter((c) => c === 'consecutive_action_timeouts')).toHaveLength(1);
  });
});
