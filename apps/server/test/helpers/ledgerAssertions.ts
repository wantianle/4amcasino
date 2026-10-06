import { expect } from 'vitest';
import type { DB } from '../../src/db.js';

/**
 * Reusable ledger-conservation assertions for the server suite. Each mirrors an
 * invariant already asserted inline in the existing tests; they are collected
 * here so new suites can lean on the same checks instead of re-deriving them.
 */

/**
 * Ledger verifies and every stack equals the sum of that player's ledger deltas;
 * the room total equals its purchases, because settlement is zero-sum against
 * buy-ins. Copied from `botRunnerReconnectE2E.test.ts:139-169`; the `/ledger`
 * HTTP fetch was lifted into the `ledger` argument so the check is independent
 * of transport.
 *
 * @param ledger  The parsed `GET /api/rooms/:id/ledger` response.
 */
export function assertLedgerConservation(
  db: DB,
  roomId: string,
  ledger: { verified: { ok: boolean } },
): void {
  expect(ledger.verified.ok).toBe(true);

  const roster = db
    .prepare('SELECT user_id, stack FROM room_players WHERE room_id = ?')
    .all(roomId) as { user_id: number; stack: number }[];
  for (const p of roster) {
    const sum = (
      db
        .prepare('SELECT COALESCE(SUM(delta),0) AS s FROM ledger WHERE room_id = ? AND user_id = ?')
        .get(roomId, p.user_id) as { s: number }
    ).s;
    expect(p.stack).toBe(sum);
  }
  const total = (
    db
      .prepare('SELECT COALESCE(SUM(delta),0) AS s FROM ledger WHERE room_id = ?')
      .get(roomId) as { s: number }
  ).s;
  const purchased = (
    db
      .prepare(
        "SELECT COALESCE(SUM(delta),0) AS s FROM ledger WHERE room_id = ? AND kind = 'purchase'",
      )
      .get(roomId) as { s: number }
  ).s;
  expect(total).toBe(purchased); // settlement is zero-sum against buy-ins
}

/**
 * Settlement invariant: a hand's game legs (settlement + squid + 7-2) net to
 * exactly minus its commission leg. Copied from
 * `readModelNetDelta.test.ts:244-254`, where `sumGame` is expected to be
 * `-10` and `sumCommission` `+10`.
 *
 * @param where  Optional `roomId` and/or `ref` filter (both default to all rows).
 */
export function assertGameLegsOffsetCommission(
  db: DB,
  where: { roomId?: string; ref?: string } = {},
): void {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (where.roomId !== undefined) {
    clauses.push('room_id = ?');
    params.push(where.roomId);
  }
  if (where.ref !== undefined) {
    clauses.push('ref = ?');
    params.push(where.ref);
  }
  const whereSql = clauses.length ? ` AND ${clauses.join(' AND ')}` : '';
  const sum = (kindSql: string) =>
    (
      db
        .prepare(`SELECT COALESCE(SUM(delta),0) AS n FROM ledger WHERE 1=1${whereSql}${kindSql}`)
        .get(...params) as { n: number }
    ).n;
  const game = sum(" AND kind IN ('hand-settlement','squid-game','seven-deuce')");
  const commission = sum(" AND kind = 'commission'");
  expect(game).toBe(-commission);
}

/**
 * Whole-hand conservation: every correlated money row (originals and any
 * reversals) nets to zero, both in total and per account. Copied from
 * `voidHandFullRefund.test.ts:249-252` and `readModelNetDelta.test.ts:898-900`.
 */
export function assertRowsNetZero(rows: { user_id: number; delta: number }[]): void {
  expect(rows.reduce((s, r) => s + r.delta, 0)).toBe(0);
  for (const u of new Set(rows.map((r) => r.user_id))) {
    expect(rows.filter((r) => r.user_id === u).reduce((s, r) => s + r.delta, 0)).toBe(0);
  }
}
