import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createUser } from '../src/auth.js';
import type { DB } from '../src/db.js';
import { ledgerHandIdSql, ledgerHeadSql } from '../src/handProjection.js';
import { appendLedger } from '../src/ledger.js';
import {
  commissionRateInvariantSql,
  findCommissionRateViolations,
} from '../scripts/check-commission-rate-invariant.mjs';

/**
 * Fixture for `check-commission-rate-invariant.mjs`.
 *
 * `platformDuesSql()` projects `commissionBps` as an un-aggregated column inside
 * a `(room_id, canonical ref)` GROUP BY, so SQLite may return any row's value
 * when one canonical hand has commissions under two raw refs with different
 * effective rates. The check must detect exactly that, and must NOT fire on a
 * group with a single rate or on a voided / retired room.
 */
describe('check-commission-rate-invariant', () => {
  let ctx: ReturnType<typeof createApp>;
  let db: DB;
  let userId: number;

  beforeEach(() => {
    ctx = createApp(':memory:');
    db = ctx.db;
    userId = createUser(db, 'inv_user', 'a'.repeat(64), 'b'.repeat(64)).userId;
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  const mkRoom = (
    id: string,
    bps: number,
    flags: { voided?: number; archived?: number; deleted?: number } = {},
  ): void => {
    db.prepare(
      `INSERT INTO rooms (id, name, join_code, host_id, banker_id, sb, bb, created_at,
                          commission_bps, voided, archived, deleted)
       VALUES (?, ?, ?, ?, ?, 5, 10, 1000, ?, ?, ?, ?)`,
    ).run(
      id,
      id,
      `C_${id}`,
      userId,
      userId,
      bps,
      flags.voided ?? 0,
      flags.archived ?? 0,
      flags.deleted ?? 0,
    );
  };
  const marker = (handId: string, head: string, roomId: string): void => {
    db.prepare(
      "INSERT INTO hand_settlements (hand_id, room_id, head, rake, final_stacks, applied_at) VALUES (?, ?, ?, 0, '[]', 1)",
    ).run(handId, roomId, head);
  };
  const rate = (roomId: string, ref: string, bps: number): void => {
    db.prepare(
      'INSERT OR REPLACE INTO hand_commission_rates (room_id, ref, commission_bps) VALUES (?, ?, ?)',
    ).run(roomId, ref, bps);
  };
  const leg = (roomId: string, delta: number, kind: string, ref: string): void => {
    appendLedger(db, { roomId, userId, delta, kind, ref });
  };

  it('embeds the same canonical-id / head expressions as handProjection', () => {
    const sql = commissionRateInvariantSql();
    // Drift guard: the script copies these fragments verbatim because it runs on
    // plain `node`; if the source helpers change, this fails.
    expect(sql).toContain(ledgerHandIdSql('l'));
    expect(sql).toContain(ledgerHeadSql('l'));
  });

  it('flags one canonical hand carrying two raw refs with two effective rates', () => {
    mkRoom('rInv', 100);
    marker('handX', 'headX', 'rInv');
    rate('rInv', 'headX', 300);
    rate('rInv', 'handX', 700);
    leg('rInv', 5, 'commission', 'headX');
    leg('rInv', 5, 'commission', 'handX');

    const violations = findCommissionRateViolations(db);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      roomId: 'rInv',
      canonicalRef: 'handX',
      rows: 2,
      rates: [300, 700],
      allocates: true,
    });
  });

  it('reports nothing when every group has a single effective rate', () => {
    mkRoom('rClean', 50);
    marker('handY', 'headY', 'rClean');
    leg('rClean', 3, 'commission', 'headY');
    leg('rClean', 4, 'commission', 'headY');
    expect(findCommissionRateViolations(db)).toEqual([]);
  });

  it('drops a group once any one of its three void keys is voided', () => {
    mkRoom('rVoid', 100);
    marker('handZ', 'headZ', 'rVoid');
    rate('rVoid', 'headZ', 300);
    rate('rVoid', 'handZ', 700);
    leg('rVoid', 5, 'commission', 'headZ');
    leg('rVoid', 5, 'commission', 'handZ');
    expect(findCommissionRateViolations(db)).toHaveLength(1); // ambiguous...

    leg('rVoid', 0, 'void-hand', 'handZ'); // ...until the canonical id is voided
    expect(findCommissionRateViolations(db)).toEqual([]);
  });

  it('ignores voided / archived / deleted rooms entirely', () => {
    for (const [rid, flags] of [
      ['rV', { voided: 1 }],
      ['rA', { archived: 1 }],
      ['rD', { deleted: 1 }],
    ] as const) {
      mkRoom(rid, 100, flags);
      marker(`h_${rid}`, `head_${rid}`, rid);
      rate(rid, `head_${rid}`, 300);
      rate(rid, `h_${rid}`, 700);
      leg(rid, 5, 'commission', `head_${rid}`);
      leg(rid, 5, 'commission', `h_${rid}`);
    }
    expect(findCommissionRateViolations(db)).toEqual([]);
  });
});
