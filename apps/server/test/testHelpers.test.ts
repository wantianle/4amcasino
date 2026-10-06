import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { appendLedger } from '../src/ledger.js';
import { waitFor } from './helpers/waitFor.js';
import {
  assertGameLegsOffsetCommission,
  assertLedgerConservation,
  assertRowsNetZero,
} from './helpers/ledgerAssertions.js';

/**
 * Self-test for the extracted server test helpers. It only exercises the pure
 * helpers (`waitFor` + `ledgerAssertions`); the WebSocket `TestClient` /
 * `setupRoom` scaffolding is covered end-to-end by the existing suites.
 */

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
});
afterEach(() => {
  db.close();
});

describe('waitFor', () => {
  it('resolves once the predicate flips true', async () => {
    let ready = false;
    setTimeout(() => (ready = true), 20);
    await expect(waitFor(() => ready, 500, 'flip')).resolves.toBeUndefined();
  });

  it('throws with the label when the deadline passes', async () => {
    await expect(waitFor(() => false, 30, 'never')).rejects.toThrow('waitFor timed out: never');
  });
});

describe('ledgerAssertions', () => {
  // A room whose ledger is zero-sum against buy-ins: u1 nets +45, u2 -50 and
  // the platform u3 takes a +5 commission, so the game legs (-5) offset it.
  function seedRoom(): void {
    for (const [userId, stack] of [
      [1, 1045],
      [2, 950],
      [3, 5],
    ] as const) {
      db.prepare('INSERT INTO room_players (room_id, user_id, seat, stack) VALUES (?, ?, ?, ?)').run(
        'r1',
        userId,
        userId - 1,
        stack,
      );
    }
    appendLedger(db, { roomId: 'r1', userId: 1, delta: 1000, kind: 'purchase' });
    appendLedger(db, { roomId: 'r1', userId: 2, delta: 1000, kind: 'purchase' });
    appendLedger(db, { roomId: 'r1', userId: 1, delta: 45, kind: 'hand-settlement' });
    appendLedger(db, { roomId: 'r1', userId: 2, delta: -50, kind: 'hand-settlement' });
    appendLedger(db, { roomId: 'r1', userId: 3, delta: 5, kind: 'commission' });
  }

  it('passes conservation for a zero-sum room and bites on a wrong stack', () => {
    seedRoom();
    expect(() => assertLedgerConservation(db, 'r1', { verified: { ok: true } })).not.toThrow();
    db.prepare('UPDATE room_players SET stack = 999 WHERE room_id = ? AND user_id = ?').run('r1', 1);
    expect(() => assertLedgerConservation(db, 'r1', { verified: { ok: true } })).toThrow();
  });

  it('asserts the game legs offset the commission leg', () => {
    seedRoom();
    expect(() => assertGameLegsOffsetCommission(db, { roomId: 'r1' })).not.toThrow();
    // a stray chip into the game legs must break the invariant
    appendLedger(db, { roomId: 'r1', userId: 1, delta: 1, kind: 'squid-game' });
    expect(() => assertGameLegsOffsetCommission(db, { roomId: 'r1' })).toThrow();
  });

  it('asserts a hand-correlated row set nets to zero per account', () => {
    seedRoom();
    // add the hand's reversals, then check originals + reversals conserve
    const originals = db
      .prepare(
        "SELECT user_id, delta FROM ledger WHERE room_id = ? AND kind IN ('hand-settlement','commission')",
      )
      .all('r1') as { user_id: number; delta: number }[];
    for (const o of originals) {
      appendLedger(db, { roomId: 'r1', userId: o.user_id, delta: -o.delta, kind: 'void-hand' });
    }
    const rows = db
      .prepare(
        "SELECT user_id, delta FROM ledger WHERE room_id = ? AND kind IN ('hand-settlement','commission','void-hand')",
      )
      .all('r1') as { user_id: number; delta: number }[];
    expect(() => assertRowsNetZero(rows)).not.toThrow();
    expect(() => assertRowsNetZero([...rows, { user_id: 3, delta: 1 }])).toThrow();
  });
});
