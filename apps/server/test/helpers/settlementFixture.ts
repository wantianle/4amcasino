import { computeHead, type TranscriptEntry } from '@4am/mental-poker';
import type { DB } from '../../src/db.js';
import type { HandSettlementWrite } from '../../src/game.js';

/**
 * Shared minimal settlement fixture for the P0-3 fault-injection suite.
 *
 * A deterministic two-player showdown transcript whose deltas net to zero with
 * rake 0, plus the seed rows (`users`, `room_players`, `rooms`, a `running`
 * `hand_lifecycle`) the writer needs. Kept here (a NEW file) so the P0-3 tests
 * do not have to reach into `p0_2Recovery.test.ts`, which they must not touch.
 */

export type Entry = { seq: number; type: string; from: string; payload: unknown; sig: string };

export const srv = (seq: number, type: string, payload: unknown): Entry => ({
  seq,
  type,
  from: 'server',
  payload,
  sig: 'sig',
});

export const headOf = (entries: unknown[]): string => computeHead(entries as TranscriptEntry[]);

/** A minimal two-player showdown transcript; deltas net to zero with rake 0. */
export function huEntries(): Entry[] {
  return [
    srv(0, 'hand_start', {
      schemaVersion: 2,
      startedAt: 1,
      gameKind: 'normal',
      seats: [
        { seat: 0, userId: 1, stack: 1000 },
        { seat: 1, userId: 2, stack: 1000 },
      ],
      buttonSeat: 0,
      sb: 5,
      bb: 10,
      commissionBps: 50,
    }),
    srv(1, 'blind_post', {
      posts: [
        { seat: 0, userId: 1, kind: 'sb', nominal: 5, amount: 5, stackAfter: 995, allIn: false },
        { seat: 1, userId: 2, kind: 'bb', nominal: 10, amount: 10, stackAfter: 990, allIn: false },
      ],
      ts: 2,
    }),
    srv(2, 'betting_start', { street: 'preflop' }),
    srv(3, 'action', {
      action: { type: 'call' },
      seat: 0,
      actionSeq: 0,
      street: 'preflop',
      amountAdded: 5,
      potBefore: 15,
      potAfter: 20,
      ts: 3,
    }),
    srv(4, 'action', {
      action: { type: 'check' },
      seat: 1,
      actionSeq: 1,
      street: 'preflop',
      amountAdded: 0,
      potBefore: 20,
      potAfter: 20,
      ts: 4,
    }),
    srv(5, 'street', { street: 'flop', streetIndex: 1, potAfter: 20, ts: 5 }),
    srv(6, 'action', {
      action: { type: 'check' },
      seat: 0,
      actionSeq: 2,
      street: 'flop',
      amountAdded: 0,
      potBefore: 20,
      potAfter: 20,
      ts: 6,
    }),
    srv(7, 'action', {
      action: { type: 'check' },
      seat: 1,
      actionSeq: 3,
      street: 'flop',
      amountAdded: 0,
      potBefore: 20,
      potAfter: 20,
      ts: 7,
    }),
    srv(8, 'settlement', {
      board: [0, 5, 9],
      commission: 0,
      awards: [{ seat: 0, amount: 20 }],
      deltas: [
        { seat: 0, delta: 10 },
        { seat: 1, delta: -10 },
      ],
      pokerDeltas: [
        { seat: 0, delta: 10 },
        { seat: 1, delta: -10 },
      ],
      runCount: 1,
      grossPot: 20,
      showdown: true,
      reveals: [
        { seat: 0, cards: [0, 5] },
        { seat: 1, cards: [1, 6] },
      ],
      ts: 9,
    }),
  ];
}

export function makeWrite(overrides: Partial<HandSettlementWrite> = {}): HandSettlementWrite {
  const entries = huEntries();
  return {
    handId: 'h1',
    roomId: 'r1',
    head: headOf(entries),
    entries,
    rake: 0,
    commissionBps: 50,
    stackDeltas: [
      { userId: 1, delta: 10 },
      { userId: 2, delta: -10 },
    ],
    pokerLedger: [
      { userId: 1, delta: 10 },
      { userId: 2, delta: -10 },
    ],
    projectionPokerLedger: [
      { userId: 1, delta: 10 },
      { userId: 2, delta: -10 },
    ],
    squidLedger: [],
    squidNote: 'Squid Game penalty/payout',
    timeBanks: [],
    timeBankEpoch: null,
    triggerIds: [],
    bombRan: false,
    rakeRecipientId: 1,
    sevenDeuce: null,
    now: 100,
    ...overrides,
  };
}

/** Seed two users, a room, their seats and a `running` lifecycle row. */
export function seed(db: DB, handId = 'h1'): void {
  const now = 1_700_000_000_000;
  for (const id of [1, 2]) {
    db.prepare(
      'INSERT INTO users (id, username, auth_hash, auth_salt, pubkey, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, `p03_u${id}`, 'h', 's', `pk${id}`, now + id);
    db.prepare(
      'INSERT INTO room_players (room_id, user_id, seat, stack) VALUES (?, ?, ?, ?)',
    ).run('r1', id, id - 1, 1000);
  }
  db.prepare(
    'INSERT INTO rooms (id, name, join_code, host_id, banker_id, sb, bb, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('r1', 'P03 Room', 'P03JOIN', 1, 1, 5, 10, now);
  db.prepare(
    'INSERT INTO hand_lifecycle (hand_id, room_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(handId, 'r1', 'running', now, now);
}

/** A `running` hand that has claimed one manual feature trigger. */
export function seedClaimedTrigger(db: DB, handId = 'h1'): void {
  db.prepare(
    `INSERT INTO room_feature_triggers (room_id, request_id, kind, source, status, claimed_hand_id, created_at)
     VALUES ('r1','req-1','squid','manual','claimed',?,1)`,
  ).run(handId);
}

export const lifecycle = (db: DB, handId = 'h1'): string =>
  (
    db.prepare('SELECT status FROM hand_lifecycle WHERE hand_id = ?').get(handId) as {
      status: string;
    }
  ).status;

export const count = (db: DB, sql: string, ...args: unknown[]): number =>
  (db.prepare(sql).get(...args) as { n: number }).n;

/** An error coded as a transient SQLite failure: rolls back but stays retryable. */
export function transientFault(message = 'injected transient settlement fault'): Error {
  return Object.assign(new Error(message), { code: 'SQLITE_BUSY' });
}
