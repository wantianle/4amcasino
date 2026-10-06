import { computeHead, type TranscriptEntry } from '@4am/mental-poker';
import type { DB } from '../../src/db.js';
import type { HandSettlementWrite } from '../../src/game.js';

/**
 * Shared minimal settlement fixture for the P0-3 fault-injection suite.
 *
 * A deterministic two-player showdown transcript whose deltas net to
 * `-rake` (the pot is raked), plus the seed rows (`users`, `room_players`,
 * `rooms`, a `running` `hand_lifecycle`, one non-zero `room_gameplay_state`)
 * the writer needs. Kept here (a NEW file) so the P0-3 tests do not have to
 * reach into `p0_2Recovery.test.ts`, which they must not touch.
 *
 * The default rake is deliberately NON-ZERO: with rake 0 `settleRake` is a
 * no-op, so the `settlement_after_commission` boundary would have no commission
 * write to roll back and the "complete rollback" assertion there would be
 * vacuous.
 */

export type Entry = { seq: number; type: string; from: string; payload: unknown; sig: string };

/** Non-zero default rake, so the commission leg always executes. */
export const DEFAULT_RAKE = 5;

/** The time-bank epoch seeded into `room_players`; a frozen write must carry
 *  this exact epoch for `applyHandSettlement` to apply the time-bank snapshot. */
export const SEED_TIME_BANK_EPOCH = 7;

export const srv = (seq: number, type: string, payload: unknown): Entry => ({
  seq,
  type,
  from: 'server',
  payload,
  sig: 'sig',
});

export const headOf = (entries: unknown[]): string => computeHead(entries as TranscriptEntry[]);

/** A minimal two-player showdown transcript; the pot is raked by `opts.rake`
 *  (default {@link DEFAULT_RAKE}), so deltas net to `-rake`. */
export function huEntries(opts: { rake?: number } = {}): Entry[] {
  const rake = opts.rake ?? DEFAULT_RAKE;
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
      commission: rake,
      awards: [{ seat: 0, amount: 20 - rake }],
      deltas: [
        { seat: 0, delta: 10 - rake },
        { seat: 1, delta: -10 },
      ],
      pokerDeltas: [
        { seat: 0, delta: 10 - rake },
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
  const rake = overrides.rake ?? DEFAULT_RAKE;
  const entries = (overrides.entries ?? huEntries({ rake })) as unknown[];
  const gameDeltas = [
    { userId: 1, delta: 10 - rake },
    { userId: 2, delta: -10 },
  ];
  return {
    handId: 'h1',
    roomId: 'r1',
    head: overrides.head ?? headOf(entries),
    entries,
    rake,
    commissionBps: 50,
    stackDeltas: gameDeltas,
    pokerLedger: gameDeltas,
    projectionPokerLedger: gameDeltas,
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

/** Seed two users, a room, their seats (with a non-zero time bank at
 *  {@link SEED_TIME_BANK_EPOCH}), a `running` lifecycle row and one non-zero
 *  `room_gameplay_state` row. The non-zero rows matter: they make the
 *  "unchanged after rollback" assertions non-vacuous (a missing row would
 *  compare `undefined`/0 on both sides). */
export function seed(db: DB, handId = 'h1'): void {
  const now = 1_700_000_000_000;
  for (const id of [1, 2]) {
    db.prepare(
      'INSERT INTO users (id, username, auth_hash, auth_salt, pubkey, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, `p03_u${id}`, 'h', 's', `pk${id}`, now + id);
    db.prepare(
      `INSERT INTO room_players
         (room_id, user_id, seat, stack, time_bank_ms, time_bank_hands, time_bank_epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('r1', id, id - 1, 1000, 30_000 + id, 3 + id, SEED_TIME_BANK_EPOCH);
  }
  db.prepare(
    'INSERT INTO rooms (id, name, join_code, host_id, banker_id, sb, bb, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('r1', 'P03 Room', 'P03JOIN', 1, 1, 5, 10, now);
  db.prepare(
    'INSERT INTO hand_lifecycle (hand_id, room_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(handId, 'r1', 'running', now, now);
  db.prepare(
    `INSERT INTO room_gameplay_state
       (room_id, completed_hands, last_bomb_completed_hands, last_bomb_at, schedule_reset_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('r1', 7, 2, 1111, 2222);
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
