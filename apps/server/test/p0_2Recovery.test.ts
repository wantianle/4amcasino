import { afterEach, describe, expect, it } from 'vitest';
import { computeHead, type TranscriptEntry } from '@4am/mental-poker';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDb, firstPendingHandLifecycle, type DB } from '../src/db.js';
import {
  abortPendingHandSettlement,
  applyPreparedHandSettlement,
  persistPreparedInput,
  settlementInputHash,
  PreparedInputError,
  realClock,
  type HandSettlementWrite,
} from '../src/game.js';
import { verifyLedger } from '../src/ledger.js';
import { createApp } from '../src/app.js';
import { attachHub } from '../src/hub.js';
import { setPlatformUserId } from '../src/platform.js';
import { TestClient } from './helpers/testClient.js';
import { setupRoom } from './helpers/testRoom.js';

// ---------------------------------------------------------------------------
// P0-2: durable prepared settlement input + quarantine + operator recovery.
//
// These tests exercise the DB-only writer boundary directly (fast and
// deterministic) plus the operator HTTP surface and the post-restart
// `hand_recovery` replay over a real socket.
// ---------------------------------------------------------------------------

type Entry = { seq: number; type: string; from: string; payload: unknown; sig: string };
const srv = (seq: number, type: string, payload: unknown): Entry => ({
  seq,
  type,
  from: 'server',
  payload,
  sig: 'sig',
});
const headOf = (entries: unknown[]): string => computeHead(entries as TranscriptEntry[]);

/** A minimal two-player showdown transcript; deltas net to zero with rake 0. */
function huEntries(): Entry[] {
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

function makeWrite(overrides: Partial<HandSettlementWrite> = {}): HandSettlementWrite {
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
function seed(db: DB, handId = 'h1'): void {
  const now = 1_700_000_000_000;
  for (const id of [1, 2]) {
    db.prepare(
      'INSERT INTO users (id, username, auth_hash, auth_salt, pubkey, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, `p02_u${id}`, 'h', 's', `pk${id}`, now + id);
    db.prepare(
      'INSERT INTO room_players (room_id, user_id, seat, stack) VALUES (?, ?, ?, ?)',
    ).run('r1', id, id - 1, 1000);
  }
  db.prepare(
    'INSERT INTO rooms (id, name, join_code, host_id, banker_id, sb, bb, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('r1', 'P02 Room', 'P02JOIN', 1, 1, 5, 10, now);
  db.prepare(
    'INSERT INTO hand_lifecycle (hand_id, room_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(handId, 'r1', 'running', now, now);
}

const lifecycle = (db: DB, handId = 'h1'): string =>
  (
    db.prepare('SELECT status FROM hand_lifecycle WHERE hand_id = ?').get(handId) as {
      status: string;
    }
  ).status;
const count = (db: DB, sql: string, ...args: unknown[]): number =>
  (db.prepare(sql).get(...args) as { n: number }).n;

describe('P0-2: durable prepared input survives a process exit', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('scenario 1: a committed prepared row round-trips EVERY field across a reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), '4am-p02-'));
    dirs.push(dir);
    const path = join(dir, 'game.db');
    let db = openDb(path);
    seed(db);
    const rich = makeWrite({
      rake: 5,
      rakeRecipientId: 2,
      sevenDeuce: {
        winnerUserId: 1,
        winnerSeat: 0,
        winnerAmount: 10,
        payerAmounts: [{ userId: 2, amount: 10 }],
      },
      timeBankEpoch: 7,
      timeBanks: [{ userId: 1, ms: 1234, hands: 2 }],
      triggerIds: [11, 22],
      bombRan: true,
    });
    const { hash, inserted } = persistPreparedInput(db, rich);
    expect(inserted).toBe(true);
    expect(lifecycle(db)).toBe('prepared');
    const row = db.prepare('SELECT * FROM hand_settlement_prepared WHERE hand_id = ?').get('h1') as {
      input_hash: string;
      input_json: string;
    };
    expect(row.input_hash).toBe(hash);
    expect(settlementInputHash(row.input_json)).toBe(hash);
    db.close();

    // "process exit": reopen the same file and read the frozen input back.
    db = openDb(path);
    const reopened = db
      .prepare('SELECT input_json, input_hash FROM hand_settlement_prepared WHERE hand_id = ?')
      .get('h1') as { input_json: string; input_hash: string };
    expect(reopened.input_hash).toBe(hash);
    const parsed = JSON.parse(reopened.input_json) as HandSettlementWrite;
    expect(parsed.handId).toBe('h1');
    expect(parsed.roomId).toBe('r1');
    expect(parsed.head).toBe(rich.head);
    expect(parsed.rake).toBe(5);
    expect(parsed.rakeRecipientId).toBe(2);
    expect(parsed.sevenDeuce).toEqual(rich.sevenDeuce);
    expect(parsed.timeBankEpoch).toBe(7);
    expect(parsed.timeBanks).toEqual([{ userId: 1, ms: 1234, hands: 2 }]);
    expect(parsed.triggerIds).toEqual([11, 22]);
    expect(parsed.bombRan).toBe(true);
    expect(parsed.stackDeltas).toEqual(rich.stackDeltas);
    expect(parsed.projectionPokerLedger).toEqual(rich.projectionPokerLedger);
    expect(lifecycle(db)).toBe('prepared');
    db.close();
  });

  it('scenario 2: a crash BEFORE prepare leaves `running`; retry is refused, abort resolves it', () => {
    const db = openDb(':memory:');
    seed(db);
    // A manual feature trigger this hand claimed, to prove abort releases it.
    db.prepare(
      `INSERT INTO room_feature_triggers (room_id, request_id, kind, source, status, claimed_hand_id, created_at)
       VALUES ('r1','req-1','squid','manual','claimed','h1',1)`,
    ).run();

    // No prepared input exists: a retry must never invent one.
    expect(() => applyPreparedHandSettlement(db, 'h1')).toThrow(/no prepared settlement input/);
    expect(lifecycle(db)).toBe('running');
    expect(count(db, 'SELECT COUNT(*) AS n FROM hand_settlements')).toBe(0);

    const result = abortPendingHandSettlement(db, 'h1', { resolvedBy: 9 });
    expect(result.status).toBe('aborted');
    expect(lifecycle(db)).toBe('aborted');
    expect(count(db, 'SELECT COUNT(*) AS n FROM hand_settlements')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM transcripts')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM ledger')).toBe(0);
    expect(firstPendingHandLifecycle(db, 'r1')).toBeNull();
    // The claimed manual trigger is put back so the next deal can pick it up.
    expect(
      (
        db.prepare('SELECT status FROM room_feature_triggers WHERE id = 1').get() as {
          status: string;
        }
      ).status,
    ).toBe('pending');
    db.close();
  });

  it('scenario 3+4+5: prepare, crash, operator retry settles once; repeated retry is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), '4am-p02-'));
    dirs.push(dir);
    const path = join(dir, 'game.db');
    let db = openDb(path);
    seed(db);
    const w = makeWrite();
    persistPreparedInput(db, w);
    // crash AFTER prepare, BEFORE the money transaction.
    db.close();

    db = openDb(path);
    // The participant rows are still there, so a DB-only retry settles it.
    const first = applyPreparedHandSettlement(db, 'h1', {
      resolvedBy: 9,
      resolution: 'operator_retry',
    });
    expect(first.status).toBe('applied');
    expect(first.outcome.gameDeltas.reduce((s, d) => s + d.delta, 0)).toBe(0);
    expect(lifecycle(db)).toBe('committed');
    expect(count(db, 'SELECT COUNT(*) AS n FROM hand_settlements WHERE hand_id = ?', 'h1')).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS n FROM transcripts WHERE hand_id = ?', 'h1')).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS n FROM hands WHERE hand_id = ?', 'h1')).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS n FROM hand_players WHERE hand_id = ?', 'h1')).toBe(2);
    const ledgerRows = count(db, 'SELECT COUNT(*) AS n FROM ledger');
    expect(ledgerRows).toBeGreaterThan(0);
    expect(verifyLedger(db, 'r1').ok).toBe(true);
    const prepared = db
      .prepare('SELECT resolved_by, resolution, resolved_at FROM hand_settlement_prepared WHERE hand_id = ?')
      .get('h1') as { resolved_by: number; resolution: string; resolved_at: number };
    expect(prepared.resolved_by).toBe(9);
    expect(prepared.resolution).toBe('operator_retry');
    expect(prepared.resolved_at).not.toBeNull();
    const stacksAfter = db
      .prepare('SELECT SUM(stack) AS s FROM room_players WHERE room_id = ?')
      .get('r1') as { s: number };
    expect(stacksAfter.s).toBe(2000);

    // Retry as many times as we like: exactly one set of books.
    for (let i = 0; i < 3; i++) {
      const again = applyPreparedHandSettlement(db, 'h1');
      expect(again.status).toBe('duplicate');
    }
    expect(count(db, 'SELECT COUNT(*) AS n FROM hand_settlements WHERE hand_id = ?', 'h1')).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS n FROM transcripts WHERE hand_id = ?', 'h1')).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS n FROM ledger')).toBe(ledgerRows);
    expect(count(db, 'SELECT COUNT(*) AS n FROM hands WHERE hand_id = ?', 'h1')).toBe(1);
    expect(lifecycle(db)).toBe('committed');
    expect(
      (db.prepare('SELECT SUM(stack) AS s FROM room_players WHERE room_id = ?').get('r1') as {
        s: number;
      }).s,
    ).toBe(2000);
    db.close();
  });

  it('scenario 6: a tampered prepared JSON quarantines the hand and keeps the room frozen', () => {
    const db = openDb(':memory:');
    seed(db);
    persistPreparedInput(db, makeWrite());
    // Tamper the frozen bytes without touching the hash: the hash check must
    // catch it before any money moves.
    db.prepare(
      "UPDATE hand_settlement_prepared SET input_json = REPLACE(input_json, '\"rake\":0', '\"rake\":5') WHERE hand_id = 'h1'",
    ).run();
    let thrown: unknown;
    try {
      applyPreparedHandSettlement(db, 'h1', { resolvedBy: 9 });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(PreparedInputError);
    expect((thrown as Error).message).toMatch(/hash mismatch/);
    expect(lifecycle(db)).toBe('quarantined');
    // still frozen: a quarantined row is a pending lifecycle state.
    expect(firstPendingHandLifecycle(db, 'r1')).toBe('h1');
    expect(count(db, 'SELECT COUNT(*) AS n FROM hand_settlements')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM ledger')).toBe(0);
    db.close();
  });

  it('scenario 7: operator abort of a prepared hand writes no marker/ledger/transcript', () => {
    const db = openDb(':memory:');
    seed(db);
    persistPreparedInput(db, makeWrite());
    const result = abortPendingHandSettlement(db, 'h1', { resolvedBy: 9 });
    expect(result.status).toBe('aborted');
    expect(lifecycle(db)).toBe('aborted');
    expect(count(db, 'SELECT COUNT(*) AS n FROM hand_settlements')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM transcripts')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM ledger')).toBe(0);
    expect(firstPendingHandLifecycle(db, 'r1')).toBeNull();
    const prepared = db
      .prepare('SELECT resolution, resolved_by FROM hand_settlement_prepared WHERE hand_id = ?')
      .get('h1') as { resolution: string; resolved_by: number };
    expect(prepared.resolution).toBe('aborted');
    expect(prepared.resolved_by).toBe(9);
    // A second abort is idempotent.
    expect(abortPendingHandSettlement(db, 'h1').status).toBe('already_aborted');
    db.close();
  });

  it('quarantines when a participant row vanished', () => {
    const db = openDb(':memory:');
    seed(db);
    persistPreparedInput(db, makeWrite());
    db.prepare('DELETE FROM room_players WHERE room_id = ? AND user_id = ?').run('r1', 2);
    expect(() => applyPreparedHandSettlement(db, 'h1')).toThrow(PreparedInputError);
    expect(lifecycle(db)).toBe('quarantined');
    db.close();
  });

  it('quarantines when the claimed feature trigger was re-claimed by another hand', () => {
    const db = openDb(':memory:');
    seed(db);
    db.prepare(
      `INSERT INTO room_feature_triggers (room_id, request_id, kind, source, status, claimed_hand_id, created_at)
       VALUES ('r1','req-1','squid','manual','claimed','h1',1)`,
    ).run();
    persistPreparedInput(db, makeWrite({ triggerIds: [1] }));
    // Another hand stole the trigger.
    db.prepare("UPDATE room_feature_triggers SET claimed_hand_id = 'h2' WHERE id = 1").run();
    expect(() => applyPreparedHandSettlement(db, 'h1')).toThrow(/not still claimed/);
    expect(lifecycle(db)).toBe('quarantined');
    db.close();
  });

  it('quarantines when ledger entries exist for the hand but no settlement marker', () => {
    const db = openDb(':memory:');
    seed(db);
    persistPreparedInput(db, makeWrite());
    db.prepare(
      `INSERT INTO ledger (room_id, user_id, delta, kind, note, ref, ts, prev_hash, entry_hash)
       VALUES ('r1', 1, 10, 'hand-settlement', NULL, ?, 1, '0', 'x')`,
    ).run(makeWrite().head);
    expect(() => applyPreparedHandSettlement(db, 'h1')).toThrow(/no settlement marker/);
    expect(lifecycle(db)).toBe('quarantined');
    db.close();
  });

  it('a mid-flight input change is refused (sealed input is frozen)', () => {
    const db = openDb(':memory:');
    seed(db);
    persistPreparedInput(db, makeWrite());
    const changed = makeWrite({ rake: 0, stackDeltas: [{ userId: 1, delta: 20 }, { userId: 2, delta: -20 }] });
    expect(() => persistPreparedInput(db, changed)).toThrow(PreparedInputError);
    expect(lifecycle(db)).toBe('quarantined');
    db.close();
  });

  it('scenario 7b: operator abort resolves a quarantined hand and preserves the failure evidence', () => {
    const db = openDb(':memory:');
    seed(db);
    // A manual trigger the hand claimed: abort must release it (fail-closed does
    // not mean dead-end).
    db.prepare(
      `INSERT INTO room_feature_triggers (room_id, request_id, kind, source, status, claimed_hand_id, created_at)
       VALUES ('r1','req-q','squid','manual','claimed','h1',1)`,
    ).run();
    persistPreparedInput(db, makeWrite({ triggerIds: [1] }));
    // Tamper the frozen bytes without touching the hash -> quarantine.
    db.prepare(
      "UPDATE hand_settlement_prepared SET input_json = REPLACE(input_json, '\"rake\":0', '\"rake\":5') WHERE hand_id = 'h1'",
    ).run();
    expect(() => applyPreparedHandSettlement(db, 'h1')).toThrow(PreparedInputError);
    expect(lifecycle(db)).toBe('quarantined');
    const reason = (
      db.prepare('SELECT last_error FROM hand_lifecycle WHERE hand_id = ?').get('h1') as {
        last_error: string;
      }
    ).last_error;
    expect(reason).toMatch(/hash mismatch/);

    const result = abortPendingHandSettlement(db, 'h1', { resolvedBy: 9 });
    expect(result.status).toBe('aborted');
    // The original failure evidence is returned and stays on the lifecycle row.
    expect(result.lastError).toBe(reason);
    expect(lifecycle(db)).toBe('aborted');
    expect(
      (db.prepare('SELECT last_error FROM hand_lifecycle WHERE hand_id = ?').get('h1') as {
        last_error: string;
      }).last_error,
    ).toBe(reason);
    // No money facts: no marker, no transcript, no ledger rows.
    expect(count(db, 'SELECT COUNT(*) AS n FROM hand_settlements')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM transcripts')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM ledger')).toBe(0);
    // The claimed trigger is released so the next deal can use it.
    expect(
      (
        db.prepare('SELECT status FROM room_feature_triggers WHERE id = 1').get() as {
          status: string;
        }
      ).status,
    ).toBe('pending');
    // The room is unfrozen at the durable layer.
    expect(firstPendingHandLifecycle(db, 'r1')).toBeNull();
    // The prepared row records the quarantine-specific resolution.
    const prep = db
      .prepare('SELECT resolution, resolved_by FROM hand_settlement_prepared WHERE hand_id = ?')
      .get('h1') as { resolution: string; resolved_by: number };
    expect(prep.resolution).toBe('aborted_quarantined');
    expect(prep.resolved_by).toBe(9);
    // Idempotent.
    expect(abortPendingHandSettlement(db, 'h1').status).toBe('already_aborted');
    db.close();
  });

  it('scenario 7c: a hash-correct but structurally wrong frozen input QUARANTINES (not a plain failure)', () => {
    const db = openDb(':memory:');
    seed(db);
    // The hash matches the bytes; only the STRUCTURE is wrong. Before the full
    // shape check this escaped as a bare TypeError and was retried forever.
    const bad = { ...makeWrite(), stackDeltas: 'not-an-array' } as unknown as HandSettlementWrite;
    const { hash } = persistPreparedInput(db, bad);
    expect(
      (
        db.prepare('SELECT input_hash FROM hand_settlement_prepared WHERE hand_id = ?').get('h1') as {
          input_hash: string;
        }
      ).input_hash,
    ).toBe(hash);
    let thrown: unknown;
    try {
      applyPreparedHandSettlement(db, 'h1');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(PreparedInputError);
    expect((thrown as Error).message).toMatch(/stackDeltas/);
    expect(lifecycle(db)).toBe('quarantined');
    db.close();
  });

  it('scenario 7d: absent optional fields are normalised before hashing (undefined equivalence is explicit)', () => {
    const db = openDb(':memory:');
    seed(db);
    const sparse = { ...makeWrite() } as Partial<HandSettlementWrite>;
    delete sparse.projectionPokerLedger;
    delete sparse.sevenDeuce;
    const { inserted } = persistPreparedInput(db, sparse as HandSettlementWrite);
    expect(inserted).toBe(true);
    const stored = (
      db.prepare('SELECT input_json FROM hand_settlement_prepared WHERE hand_id = ?').get('h1') as {
        input_json: string;
      }
    ).input_json;
    const parsed = JSON.parse(stored) as {
      projectionPokerLedger: unknown;
      sevenDeuce: unknown;
      transcriptlessReceipt: unknown;
    };
    // Every optional became an explicit value in the frozen JSON.
    expect(parsed.projectionPokerLedger).toEqual(makeWrite().pokerLedger);
    expect(parsed.sevenDeuce).toBeNull();
    expect(parsed.transcriptlessReceipt).toBe(false);
    // The explicit equivalents hash identically to the sparse write: the
    // undefined-vs-omitted equivalence is now by construction, not by accident.
    const explicit = persistPreparedInput(
      db,
      makeWrite({
        projectionPokerLedger: makeWrite().pokerLedger,
        sevenDeuce: null,
      }),
    );
    expect(explicit.inserted).toBe(false);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Operator HTTP recovery (platform admin, DB-only).
// ---------------------------------------------------------------------------

describe('P0-2: operator recovery API', () => {
  let ctx: ReturnType<typeof createApp>;
  afterEach(async () => {
    if (ctx) await ctx.app.close();
  });

  async function register(username: string) {
    const r = await ctx.app.inject({
      method: 'POST',
      url: '/api/register',
      payload: { username, authKey: 'a'.repeat(64), publicKey: 'b'.repeat(64) },
    });
    return { token: r.json().token as string, userId: r.json().userId as number };
  }
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  /** Seed the settlement fixture with explicit user ids that cannot collide
   *  with registered accounts, then move `h1` to `prepared`. */
  function seedPrepared(prepared = true) {
    const db = ctx.db;
    const now = 1_700_000_000_000;
    for (const id of [101, 102]) {
      db.prepare(
        'INSERT INTO users (id, username, auth_hash, auth_salt, pubkey, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, `p02_o${id}`, 'h', 's', `pk${id}`, now + id);
      db.prepare('INSERT INTO room_players (room_id, user_id, seat, stack) VALUES (?, ?, ?, ?)').run(
        'r1',
        id,
        id - 101,
        1000,
      );
    }
    db.prepare(
      'INSERT INTO rooms (id, name, join_code, host_id, banker_id, sb, bb, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('r1', 'P02 Op Room', 'P02OP', 101, 101, 5, 10, now);
    db.prepare(
      'INSERT INTO hand_lifecycle (hand_id, room_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('h1', 'r1', 'running', now, now);
    if (prepared) {
      const entries = huEntries().map((e) => {
        if (e.type === 'hand_start') {
          const p = e.payload as { seats: { seat: number; userId: number; stack: number }[] };
          return { ...e, payload: { ...p, seats: [{ seat: 0, userId: 101, stack: 1000 }, { seat: 1, userId: 102, stack: 1000 }] } };
        }
        return e;
      });
      persistPreparedInput(db, makeWrite({ entries, head: headOf(entries), roomId: 'r1', handId: 'h1', stackDeltas: [{ userId: 101, delta: 10 }, { userId: 102, delta: -10 }], pokerLedger: [{ userId: 101, delta: 10 }, { userId: 102, delta: -10 }], projectionPokerLedger: [{ userId: 101, delta: 10 }, { userId: 102, delta: -10 }], rakeRecipientId: 101 }));
    }
  }

  it('requires the platform account on every route', async () => {
    ctx = createApp(':memory:');
    const alice = await register('p02_alice');
    for (const [method, url] of [
      ['GET', '/api/admin/hands/pending'],
      ['POST', '/api/admin/hands/h1/retry'],
      ['POST', '/api/admin/hands/h1/abort'],
    ] as const) {
      const res = await ctx.app.inject({
        method,
        url,
        headers: auth(alice.token),
        payload: method === 'POST' ? { confirm: true } : undefined,
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('lists pending hands and retries a prepared one from DB input, auditing success', async () => {
    ctx = createApp(':memory:');
    const platform = await register('p02_platform');
    setPlatformUserId(ctx.db, platform.userId);
    seedPrepared(true);

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/hands/pending',
      headers: auth(platform.token),
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as {
      hands: { handId: string; status: string; hasPreparedInput: boolean; roomId: string }[];
    };
    expect(body.hands).toHaveLength(1);
    expect(body.hands[0]).toMatchObject({
      handId: 'h1',
      status: 'prepared',
      hasPreparedInput: true,
      roomId: 'r1',
    });

    const retry = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/hands/h1/retry',
      headers: auth(platform.token),
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ ok: true, status: 'applied' });
    expect(
      (ctx.db.prepare('SELECT status FROM hand_lifecycle WHERE hand_id = ?').get('h1') as {
        status: string;
      }).status,
    ).toBe('committed');
    const audit = ctx.db
      .prepare("SELECT action, target_type, target_id FROM admin_audit WHERE action = 'hand.retry'")
      .get() as { action: string; target_type: string; target_id: string };
    expect(audit).toMatchObject({ action: 'hand.retry', target_type: 'hand', target_id: 'h1' });

    // A retry of the now-committed hand is an idempotent no-op.
    const again = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/hands/h1/retry',
      headers: auth(platform.token),
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ ok: true, status: 'committed', already: true });
  });

  it('refuses to retry a running hand and only aborts it with explicit confirmation', async () => {
    ctx = createApp(':memory:');
    const platform = await register('p02_platform2');
    setPlatformUserId(ctx.db, platform.userId);
    seedPrepared(false); // running, no frozen input

    const retry = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/hands/h1/retry',
      headers: auth(platform.token),
    });
    expect(retry.statusCode).toBe(409);
    expect(
      (ctx.db.prepare('SELECT status FROM hand_lifecycle WHERE hand_id = ?').get('h1') as {
        status: string;
      }).status,
    ).toBe('running');

    const noConfirm = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/hands/h1/abort',
      headers: auth(platform.token),
      payload: {},
    });
    expect(noConfirm.statusCode).toBe(400);

    const abort = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/hands/h1/abort',
      headers: auth(platform.token),
      payload: { confirm: true },
    });
    expect(abort.statusCode).toBe(200);
    expect(abort.json()).toMatchObject({ ok: true, status: 'aborted' });
    expect(
      (ctx.db.prepare('SELECT status FROM hand_lifecycle WHERE hand_id = ?').get('h1') as {
        status: string;
      }).status,
    ).toBe('aborted');
    expect(
      (ctx.db.prepare('SELECT COUNT(*) AS n FROM hand_settlements').get() as { n: number }).n,
    ).toBe(0);
    expect(
      (
        ctx.db.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'hand.abort'").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
  });

  it('refuses retry for a quarantined hand', async () => {
    ctx = createApp(':memory:');
    const platform = await register('p02_platform3');
    setPlatformUserId(ctx.db, platform.userId);
    seedPrepared(true);
    ctx.db
      .prepare("UPDATE hand_lifecycle SET status = 'quarantined', last_error = 'tampered' WHERE hand_id = 'h1'")
      .run();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/hands/h1/retry',
      headers: auth(platform.token),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/quarantined/);
  });

  it('aborts a quarantined hand with confirmation, preserving last_error in the audit', async () => {
    ctx = createApp(':memory:');
    const platform = await register('p02_platform5');
    setPlatformUserId(ctx.db, platform.userId);
    seedPrepared(true);
    const reason = 'prepared input hash mismatch on hand h1';
    ctx.db
      .prepare("UPDATE hand_lifecycle SET status = 'quarantined', last_error = ? WHERE hand_id = 'h1'")
      .run(reason);

    // Non-platform accounts stay forbidden.
    const alice = await register('p02_alice5');
    const forbidden = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/hands/h1/abort',
      headers: auth(alice.token),
      payload: { confirm: true },
    });
    expect(forbidden.statusCode).toBe(403);

    // Confirmation is still mandatory.
    const noConfirm = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/hands/h1/abort',
      headers: auth(platform.token),
      payload: {},
    });
    expect(noConfirm.statusCode).toBe(400);
    expect(
      (ctx.db.prepare('SELECT status FROM hand_lifecycle WHERE hand_id = ?').get('h1') as {
        status: string;
      }).status,
    ).toBe('quarantined');

    const abort = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/hands/h1/abort',
      headers: auth(platform.token),
      payload: { confirm: true },
    });
    expect(abort.statusCode).toBe(200);
    expect(abort.json()).toMatchObject({ ok: true, status: 'aborted' });
    expect(
      (ctx.db.prepare('SELECT status FROM hand_lifecycle WHERE hand_id = ?').get('h1') as {
        status: string;
      }).status,
    ).toBe('aborted');
    expect(
      (ctx.db.prepare('SELECT COUNT(*) AS n FROM hand_settlements').get() as { n: number }).n,
    ).toBe(0);
    // The failure evidence outlives the resolution, in the audit detail.
    const audit = ctx.db
      .prepare("SELECT detail FROM admin_audit WHERE action = 'hand.abort' ORDER BY id DESC LIMIT 1")
      .get() as { detail: string };
    expect(JSON.parse(audit.detail)).toMatchObject({
      roomId: 'r1',
      status: 'aborted',
      lastError: reason,
    });
    // A second abort is an idempotent no-op, not a 409.
    const again = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/hands/h1/abort',
      headers: auth(platform.token),
      payload: { confirm: true },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ ok: true, status: 'already_aborted' });
  });

  it('keeps running/prepared abort behaviour unchanged (409 while live, abort when not)', async () => {
    ctx = createApp(':memory:');
    const platform = await register('p02_platform6');
    setPlatformUserId(ctx.db, platform.userId);
    seedPrepared(false); // running, no frozen input
    // No live GameRoom in this DB-only test: abort succeeds as before.
    const abort = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/hands/h1/abort',
      headers: auth(platform.token),
      payload: { confirm: true },
    });
    expect(abort.statusCode).toBe(200);
    expect(abort.json()).toMatchObject({ ok: true, status: 'aborted' });
    expect(
      (ctx.db.prepare('SELECT status FROM hand_lifecycle WHERE hand_id = ?').get('h1') as {
        status: string;
      }).status,
    ).toBe('aborted');
    // Committed stays un-abortable.
    ctx.db.prepare("UPDATE hand_lifecycle SET status = 'committed' WHERE hand_id = 'h1'").run();
    const committed = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/hands/h1/abort',
      headers: auth(platform.token),
      payload: { confirm: true },
    });
    expect(committed.statusCode).toBe(409);
  });

  it('404s an unknown hand', async () => {
    ctx = createApp(':memory:');
    const platform = await register('p02_platform4');
    setPlatformUserId(ctx.db, platform.userId);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/hands/nope/retry',
      headers: auth(platform.token),
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Scenario 8: post-restart participant reconnect gets the right hand_recovery.
// ---------------------------------------------------------------------------

describe('P0-2: durable hand_recovery across a restart', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('reports committed/aborted for terminal hands and unresolved for pending ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), '4am-p02-rec-'));
    dirs.push(dir);
    const dbPath = join(dir, 'game.db');

    // Phase 1: a live process creates the room and its membership.
    const first = createApp(dbPath);
    const firstHub = attachHub(first.app, first.db, {
      cryptoTimeoutMs: 1500,
      actionTimeoutMs: 1500,
      autoDealMs: 3_600_000,
      readyCheckMs: 1500,
      showdownHoldMs: 400,
      settleHoldMs: 0,
      clock: realClock,
    });
    await first.app.listen({ port: 0 });
    const addr1 = first.app.server.address() as AddressInfo;
    const client = new TestClient(`http://127.0.0.1:${addr1.port}`, 'p02_rec');
    await client.register();
    const room = (await client.api('/api/rooms', { name: 'Rec', sb: 10, bb: 20 })) as {
      id: string;
    };
    await client.connect(room.id);
    // Seed the lifecycle states a crash could have left behind.
    const now = Date.now();
    for (const [handId, status] of [
      ['h-committed', 'committed'],
      ['h-aborted', 'aborted'],
      ['h-running', 'running'],
      ['h-prepared', 'prepared'],
      ['h-quarantined', 'quarantined'],
    ] as const) {
      first.db
        .prepare(
          'INSERT INTO hand_lifecycle (hand_id, room_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(handId, room.id, status, now, now);
    }
    client.close();
    await first.app.close();
    void firstHub;

    // Phase 2: a fresh process on the same DB - no in-memory terminal frames.
    const second = createApp(dbPath);
    attachHub(second.app, second.db, {
      cryptoTimeoutMs: 1500,
      actionTimeoutMs: 1500,
      autoDealMs: 3_600_000,
      readyCheckMs: 1500,
      showdownHoldMs: 400,
      settleHoldMs: 0,
      clock: realClock,
    });
    await second.app.listen({ port: 0 });
    const addr2 = second.app.server.address() as AddressInfo;
    try {
      client.baseUrl = `http://127.0.0.1:${addr2.port}`;
      const expected: [string, string][] = [
        ['h-committed', 'committed'],
        ['h-aborted', 'aborted'],
        ['h-running', 'unresolved'],
        ['h-prepared', 'unresolved'],
        ['h-quarantined', 'unresolved'],
      ];
      for (const [handId, status] of expected) {
        client.handId = handId;
        client.handRecoveries.length = 0;
        await client.connect(room.id);
        await client.waitFor(() => client.handRecoveries.length > 0, 5000);
        expect(client.handRecoveries.at(-1)).toEqual({ handId, status });
      }
      client.close();
    } finally {
      await second.app.close();
    }
  }, 30000);
});

// ---------------------------------------------------------------------------
// The main blocker: a quarantined hand is a durable dead-end unless a DB-only
// operator abort can genuinely unfreeze the LIVE room (not just its DB row).
// ---------------------------------------------------------------------------

describe('P0-2: quarantine -> operator abort -> live room recovers', () => {
  it('a DB-only abort of a quarantined hand lets the live room deal again, no restart', async () => {
    const app = createApp(':memory:');
    let corruptNext = true;
    const hub = attachHub(app.app, app.db, {
      cryptoTimeoutMs: 1500,
      actionTimeoutMs: 1500,
      autoDealMs: 3_600_000,
      readyCheckMs: 1500,
      showdownHoldMs: 200,
      settleHoldMs: 0,
      clock: realClock,
      faultInjection: {
        persist: () => {
          if (!corruptNext) return;
          const running = app.db
            .prepare(
              "SELECT hand_id FROM hand_lifecycle WHERE status = 'running' ORDER BY rowid DESC LIMIT 1",
            )
            .get() as { hand_id: string } | undefined;
          if (!running) return;
          corruptNext = false;
          // Seed a conflicting frozen row for THIS hand: persistPreparedInput
          // sees a differing hash and quarantines, exactly like a tampered row.
          app.db
            .prepare(
              `INSERT INTO hand_settlement_prepared
                 (hand_id, room_id, head, input_json, input_hash, prepared_at, attempts, last_error, resolved_at, resolved_by, resolution)
               VALUES (?, 'corrupt-room', 'deadbeef', '{}', 'deadbeef', 0, 0, NULL, NULL, NULL, NULL)`,
            )
            .run(running.hand_id);
        },
      },
    });
    await app.app.listen({ port: 0 });
    const addr = app.app.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    const clients: TestClient[] = [];
    try {
      const { players, room, host } = await setupRoom(
        baseUrl,
        ['qra', 'qrb'],
        ['passive', 'passive'],
        clients,
      );
      const gameRoom = hub.rooms.get(room.id)!;
      expect(gameRoom).toBeDefined();

      host.send({ t: 'start_hand' });
      await host.waitFor(
        () =>
          !!app.db
            .prepare("SELECT 1 FROM hand_lifecycle WHERE room_id = ? AND status = 'quarantined'")
            .get(room.id),
        10000,
      );
      const handId = (
        app.db
          .prepare("SELECT hand_id FROM hand_lifecycle WHERE room_id = ? AND status = 'quarantined'")
          .get(room.id) as { hand_id: string }
      ).hand_id;
      // The live room is genuinely held, not just its row.
      expect(gameRoom.isUnhealthy()).toBe(true);

      host.errors = [];
      host.send({ t: 'start_hand' });
      await host.waitFor(
        () =>
          host.errors.some((e) =>
            /hand already running|frozen|never settled|held for an operator/i.test(e),
          ),
        3000,
      );

      // The operator resolves it over the DB-only HTTP API (never a GameRoom).
      const platform = new TestClient(baseUrl, 'qra_platform');
      clients.push(platform);
      await platform.register();
      setPlatformUserId(app.db, platform.userId);
      const res = await app.app.inject({
        method: 'POST',
        url: `/api/admin/hands/${handId}/abort`,
        headers: { authorization: `Bearer ${platform.token}` },
        payload: { confirm: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, status: 'aborted' });
      expect(
        (app.db.prepare('SELECT status FROM hand_lifecycle WHERE hand_id = ?').get(handId) as {
          status: string;
        }).status,
      ).toBe('aborted');

      // The next deal adopts the durable resolution and deals a NEW hand; the
      // table is usable again with no restart. The health mark must be clear.
      host.errors = [];
      host.send({ t: 'start_hand' });
      await host.waitFor(
        () => host.handId !== null && host.handId !== handId,
        10000,
      );
      expect(gameRoom.isUnhealthy()).toBe(false);
      await host.waitFor(
        () => host.handEnd !== null && host.handEnd.handId !== handId,
        15000,
      );
      expect(host.handAbort).toBeNull();

      // The quarantined hand left no money facts of its own.
      expect(
        (
          app.db
            .prepare('SELECT COUNT(*) AS n FROM hand_settlements WHERE hand_id = ?')
            .get(handId) as { n: number }
        ).n,
      ).toBe(0);
      // ...while the recovered room has now settled a fresh hand.
      expect(
        (
          app.db
            .prepare('SELECT COUNT(*) AS n FROM hand_settlements WHERE room_id = ?')
            .get(room.id) as { n: number }
        ).n,
      ).toBeGreaterThan(0);
      expect(players[0]!.handAbort).toBeNull();
    } finally {
      for (const c of clients) c.close();
      await app.app.close();
    }
  }, 30000);
});
