import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createUser } from '../src/auth.js';
import { openDb, type DB } from '../src/db.js';
import { appendLedger } from '../src/ledger.js';
import { setPlatformUserId } from '../src/platform.js';
import { platformDues, platformDuesSql, platformDuesWithSql } from '../src/house.js';
import {
  gameNetLedgerDeltaSql,
  gameNetLedgerKindSql,
  ledgerHandIdSql,
  perHandNetSelect,
  settlementNotVoidedSql,
} from '../src/handProjection.js';

// ---------------------------------------------------------------------------
// Equivalence oracle for the platformDues SQL optimization.
//
// The ORIGINAL query text (pre-optimization, commit eb52e1c / 787ee1c family) is
// kept here verbatim as the oracle. Both texts are run through the SAME report
// assembler (`platformDuesWithSql`), so the comparison isolates the SQL change
// from the JS allocation logic. `toEqual` is a deep, field-by-field compare of
// the whole PlatformDuesReport (people, rooms, accrued/paid/outstanding/credit,
// totals, unallocated).
//
// The original text is rebuilt from the same helpers the production SQL uses, so
// it cannot silently drift from what shipped.
// ---------------------------------------------------------------------------
const LEGACY_SQL = `
    WITH commissions AS (
      SELECT l.room_id AS roomId, ${ledgerHandIdSql('l')} AS ref, SUM(l.delta) AS rake,
             r.name AS roomName, COALESCE(h.commission_bps, r.commission_bps) AS commissionBps
      FROM ledger l JOIN rooms r ON r.id = l.room_id
      LEFT JOIN hand_commission_rates h ON h.room_id = l.room_id AND h.ref = l.ref
      WHERE l.kind = 'commission' AND r.voided = 0 AND r.archived = 0 AND r.deleted = 0
        AND ${settlementNotVoidedSql('l')}
        AND (@userId IS NULL OR EXISTS (
          SELECT 1 FROM ledger m WHERE m.room_id = l.room_id
            AND ${ledgerHandIdSql('m')} = ${ledgerHandIdSql('l')}
            AND ${gameNetLedgerKindSql('m')} AND m.user_id = @userId))
      GROUP BY l.room_id, ${ledgerHandIdSql('l')} HAVING SUM(l.delta) > 0
    ), winners AS (
      ${perHandNetSelect('l', {
        perUser: true,
        userAlias: 'userId',
        excludeVoided: false,
        filter: '(@platformId IS NULL OR l.user_id != @platformId)',
        having: `SUM(${gameNetLedgerDeltaSql('l')}) > 0`,
      })}
    )
    SELECT c.*, w.userId, w.net FROM commissions c
    LEFT JOIN winners w ON w.room_id = c.roomId AND w.ref = c.ref
    ORDER BY c.roomId, c.ref, w.userId
  `;

describe('platformDues SQL equivalence (pre-fix oracle vs optimized)', () => {
  let ctx: ReturnType<typeof createApp>;
  let db: DB;
  const U: Record<string, number> = {};

  beforeEach(() => {
    ctx = createApp(':memory:');
    db = ctx.db;
    seed();
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  const mkUser = (name: string): number =>
    createUser(db, name, 'a'.repeat(64), 'b'.repeat(64)).userId;

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
      U.P!,
      U.P!,
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
  const transcript = (handId: string, head: string, roomId: string): void => {
    db.prepare(
      'INSERT INTO transcripts (hand_id, room_id, head, entries, ts) VALUES (?, ?, ?, ?, 1)',
    ).run(handId, roomId, head, '[]');
  };
  const leg = (roomId: string, userId: number, delta: number, kind: string, ref?: string): void => {
    appendLedger(db, ref === undefined ? { roomId, userId, delta, kind } : { roomId, userId, delta, kind, ref });
  };
  const rate = (roomId: string, ref: string, bps: number): void => {
    db.prepare(
      'INSERT OR REPLACE INTO hand_commission_rates (room_id, ref, commission_bps) VALUES (?, ?, ?)',
    ).run(roomId, ref, bps);
  };
  const payment = (userId: number, amount: number): void => {
    db.prepare('INSERT INTO house_payments (user_id, amount, note, ts) VALUES (?, ?, ?, 1)').run(
      userId,
      amount,
      'x',
    );
  };

  function seed(): void {
    for (const [name, key] of [
      ['eq_platform', 'P'],
      ['eq_alice', 'A'],
      ['eq_bob', 'B'],
      ['eq_carol', 'C'],
      ['eq_dave', 'D'],
    ] as const) {
      U[key] = mkUser(name);
    }
    setPlatformUserId(db, U.P!);

    mkRoom('rA', 500);
    mkRoom('rB', 200);
    mkRoom('rV', 100, { voided: 1 });
    mkRoom('rAr', 150, { archived: 1 });
    mkRoom('rDel', 250, { deleted: 1 });

    // ---- rA: marker priority, transcript fallback, both missing ----
    marker('handA1', 'headA1', 'rA');
    leg('rA', U.A!, 100, 'hand-settlement', 'headA1');
    leg('rA', U.B!, -100, 'hand-settlement', 'headA1');
    leg('rA', U.P!, 10, 'commission', 'headA1');

    transcript('handA2', 'headA2', 'rA'); // markerless -> transcript fallback
    leg('rA', U.A!, 50, 'hand-settlement', 'headA2');
    leg('rA', U.B!, -30, 'hand-settlement', 'headA2');
    leg('rA', U.C!, -20, 'hand-settlement', 'headA2');
    leg('rA', U.P!, 6, 'commission', 'headA2');

    leg('rA', U.A!, 40, 'hand-settlement', 'headA3raw'); // no marker, no transcript
    leg('rA', U.B!, -40, 'hand-settlement', 'headA3raw');
    leg('rA', U.P!, 4, 'commission', 'headA3raw');

    // ---- seven-deuce hand-id ref collapses onto the head-ref settlement ----
    marker('handA4', 'headA4', 'rA');
    leg('rA', U.A!, 5, 'seven-deuce', 'handA4');
    leg('rA', U.B!, -60, 'hand-settlement', 'headA4');
    leg('rA', U.C!, 55, 'hand-settlement', 'headA4');
    leg('rA', U.P!, 3, 'commission', 'headA4');

    // ---- zero rake (sum 0) and negative rake (sum < 0) are both dropped ----
    marker('handA5', 'headA5', 'rA');
    leg('rA', U.A!, 30, 'hand-settlement', 'headA5');
    leg('rA', U.B!, -30, 'hand-settlement', 'headA5');
    leg('rA', U.P!, 5, 'commission', 'headA5');
    leg('rA', U.P!, -5, 'commission', 'headA5');

    marker('handA5b', 'headA5b', 'rA');
    leg('rA', U.A!, 10, 'hand-settlement', 'headA5b');
    leg('rA', U.B!, -10, 'hand-settlement', 'headA5b');
    leg('rA', U.P!, -3, 'commission', 'headA5b');

    // ---- no net winner -> unallocated ----
    marker('handA6', 'headA6', 'rA');
    leg('rA', U.A!, -10, 'hand-settlement', 'headA6');
    leg('rA', U.B!, -5, 'hand-settlement', 'headA6');
    leg('rA', U.P!, 7, 'commission', 'headA6');

    // ---- NULL ref (game leg and commission) ----
    leg('rA', U.A!, 20, 'hand-settlement');
    leg('rA', U.P!, 2, 'commission');

    // ---- duplicate game legs must not amplify the commission SUM ----
    marker('handA8', 'headA8', 'rA');
    leg('rA', U.A!, 30, 'hand-settlement', 'headA8');
    leg('rA', U.A!, 25, 'hand-settlement', 'headA8');
    leg('rA', U.B!, -55, 'hand-settlement', 'headA8');
    leg('rA', U.P!, 5, 'commission', 'headA8');

    // ---- same raw ref string in another room must stay separate ----
    leg('rA', U.A!, 15, 'hand-settlement', 'crossHead');
    leg('rA', U.B!, -15, 'hand-settlement', 'crossHead');
    leg('rA', U.P!, 2, 'commission', 'crossHead');

    // ---- equal remainders -> tie-break by userId, odd chip once ----
    marker('handTie', 'headTie', 'rA');
    leg('rA', U.A!, 10, 'hand-settlement', 'headTie');
    leg('rA', U.B!, 10, 'hand-settlement', 'headTie');
    leg('rA', U.P!, 5, 'commission', 'headTie');

    // ---- void by RAW ref ----
    marker('handV1', 'voidHead1', 'rA');
    leg('rA', U.A!, 100, 'hand-settlement', 'voidHead1');
    leg('rA', U.B!, -100, 'hand-settlement', 'voidHead1');
    leg('rA', U.P!, 10, 'commission', 'voidHead1');
    leg('rA', U.A!, 0, 'void-hand', 'voidHead1');

    // ---- void by CANONICAL id (hand_id convention) ----
    marker('handV2', 'voidHead2', 'rA');
    leg('rA', U.A!, 100, 'hand-settlement', 'voidHead2');
    leg('rA', U.B!, -100, 'hand-settlement', 'voidHead2');
    leg('rA', U.P!, 10, 'commission', 'voidHead2');
    leg('rA', U.A!, 0, 'void-hand', 'handV2');

    // ---- void resolved through the markerless transcript fallback ----
    transcript('handV3', 'voidHead3', 'rA');
    leg('rA', U.A!, 100, 'hand-settlement', 'voidHead3');
    leg('rA', U.B!, -100, 'hand-settlement', 'voidHead3');
    leg('rA', U.P!, 10, 'commission', 'voidHead3');
    leg('rA', U.A!, 0, 'void-hand', 'handV3');

    // ---- platform account as the only "winner" is excluded -> unallocated ----
    marker('handP', 'headP', 'rA');
    leg('rA', U.P!, 100, 'hand-settlement', 'headP');
    leg('rA', U.A!, -100, 'hand-settlement', 'headP');
    leg('rA', U.P!, 10, 'commission', 'headP');

    // ---- historical-rate anomaly: two RAW refs, one canonical hand, two rates.
    // The pre-fix query already returned an ARBITRARY rate for such a group; this
    // fixture pins whether the optimized text happens to pick the same one. ----
    marker('handRate', 'rateHead', 'rA');
    rate('rA', 'rateHead', 300);
    rate('rA', 'handRate', 700);
    leg('rA', U.A!, 40, 'hand-settlement', 'rateHead');
    leg('rA', U.B!, -40, 'hand-settlement', 'rateHead');
    leg('rA', U.P!, 5, 'commission', 'rateHead');
    leg('rA', U.P!, 5, 'commission', 'handRate');

    // ---- rB: same raw ref string as rA, plus other winners ----
    leg('rB', U.A!, 25, 'hand-settlement', 'crossHead');
    leg('rB', U.B!, -25, 'hand-settlement', 'crossHead');
    leg('rB', U.P!, 3, 'commission', 'crossHead');

    marker('handB3', 'headB3', 'rB');
    leg('rB', U.A!, 20, 'hand-settlement', 'headB3');
    leg('rB', U.B!, -20, 'hand-settlement', 'headB3');
    leg('rB', U.P!, 2, 'commission', 'headB3');

    marker('handB4', 'headB4', 'rB');
    leg('rB', U.B!, 10, 'hand-settlement', 'headB4');
    leg('rB', U.C!, 30, 'hand-settlement', 'headB4');
    leg('rB', U.A!, -40, 'hand-settlement', 'headB4');
    leg('rB', U.P!, 4, 'commission', 'headB4');

    // ---- retired rooms: voided / archived / deleted all excluded ----
    for (const [room, ref] of [
      ['rV', 'vHead'],
      ['rAr', 'arHead'],
      ['rDel', 'delHead'],
    ] as const) {
      leg(room, U.A!, 100, 'hand-settlement', ref);
      leg(room, U.B!, -100, 'hand-settlement', ref);
      leg(room, U.P!, 50, 'commission', ref);
    }

    // ---- payment side: outstanding, credit, paid-without-accrual ----
    payment(U.A!, 3);
    payment(U.B!, 100000);
    payment(U.D!, 50);
  }

  /** The whole report must be deeply equal for old and new SQL, and the public
   *  entry point must agree too. */
  const expectEquivalent = (uid: number | null): void => {
    const oldReport = platformDuesWithSql(db, LEGACY_SQL, uid);
    const newReport = platformDuesWithSql(db, platformDuesSql(), uid);
    expect(newReport, `uid=${String(uid)}`).toEqual(oldReport);
    expect(platformDues(db, uid), `public uid=${String(uid)}`).toEqual(oldReport);
  };

  it('agrees field-by-field for every real user and the platform-wide report', () => {
    for (const uid of [null, U.A!, U.B!, U.C!, U.D!, U.P!]) expectEquivalent(uid);
  });

  it('actually exercises the boundary fixture (guards against an all-empty pass)', () => {
    const all = platformDuesWithSql(db, LEGACY_SQL, null);
    // people + allocation
    expect(all.people.length).toBeGreaterThanOrEqual(4);
    expect(all.totals.accrued).toBeGreaterThan(0);
    // no-winner hands (h6, hP) and the platform-only winner land in unallocated
    expect(all.totals.unallocated).toBeGreaterThan(0);
    // the voided/archived/deleted rooms contribute nothing
    expect(all.people.some((p) => p.rooms.some((r) => r.roomId === 'rV'))).toBe(false);
    expect(all.people.some((p) => p.rooms.some((r) => r.roomId === 'rAr'))).toBe(false);
    expect(all.people.some((p) => p.rooms.some((r) => r.roomId === 'rDel'))).toBe(false);
    // the platform account never appears
    expect(all.people.some((p) => p.userId === U.P)).toBe(false);

    // personal view is scoped to that user's hands
    const alice = platformDuesWithSql(db, LEGACY_SQL, U.A!);
    expect(alice.people.map((p) => p.userId)).toEqual([U.A]);
    expect(alice.people[0]!.accrued).toBeGreaterThan(0);
    // overpayment -> credit on Bob
    const bob = platformDuesWithSql(db, LEGACY_SQL, U.B!);
    expect(bob.people[0]!.credit).toBeGreaterThan(0);
    // paid without accrual still shows up for Dave
    const dave = platformDuesWithSql(db, LEGACY_SQL, U.D!);
    expect(dave.people[0]).toMatchObject({ userId: U.D, accrued: 0, paid: 50, credit: 50 });

    // cross-room same-ref: rA and rB both appear for Alice
    expect(new Set(alice.people[0]!.rooms.map((r) => r.roomId))).toEqual(
      new Set(['rA', 'rB']),
    );
  });
});

// ---------------------------------------------------------------------------
// Execution-plan lock (deterministic, machine-speed independent), in the spirit
// of profileRivals.test.ts. The old text re-derived the canonical hand id while
// comparing candidate rows and re-scanned a whole room's ledger for void rows on
// every commission row; these assertions fail if either regresses.
// ---------------------------------------------------------------------------
interface PlanRow {
  id: number;
  parent: number;
  detail: string;
}

/** `EXPLAIN QUERY PLAN` for platformDuesSql, binding its named parameters. */
function duesPlan(db: DB): PlanRow[] {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${platformDuesSql()}`)
    .all({ userId: 1, platformId: 1 }) as PlanRow[];
}

describe('platformDuesSql - execution plan (same family as 787ee1c)', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  it('materializes the per-row canonical id, the void set and the participant set', () => {
    const details = duesPlan(db).map((r) => r.detail);
    for (const cte of ['commission_legs', 'void_rows', 'participant_legs', 'winners']) {
      expect(details.some((d) => d === `MATERIALIZE ${cte}`), `missing MATERIALIZE ${cte}`).toBe(
        true,
      );
    }
  });

  it('resolves every canonical-id subquery during CTE materialization, never on a candidate path', () => {
    const rows = duesPlan(db);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const canonical = rows.filter((r) =>
      /SEARCH (hs|t) USING INDEX (idx_hand_settlements_room_head|idx_transcripts_room_head|sqlite_autoindex_hand_settlements_1|sqlite_autoindex_transcripts_1)/.test(
        r.detail,
      ),
    );
    // The canonical id is genuinely two correlated subqueries, so their presence
    // is expected and must NOT be asserted away.
    expect(canonical.length).toBeGreaterThan(0);

    const underMaterialize = (row: PlanRow): boolean => {
      const seen = new Set<number>();
      let cur = byId.get(row.parent);
      while (cur && !seen.has(cur.id)) {
        if (/^MATERIALIZE\b/.test(cur.detail)) return true;
        seen.add(cur.id);
        cur = byId.get(cur.parent);
      }
      return false;
    };
    for (const row of canonical) {
      expect(
        underMaterialize(row),
        `canonical subquery escaped a MATERIALIZED CTE: id=${row.id} -> ${row.detail}`,
      ).toBe(true);
    }
  });

  it('matches void and participant rows on plain indexed columns, not a room-ledger rescan', () => {
    const details = duesPlan(db).map((r) => r.detail);
    // participant EXISTS: plain (roomId, ref) lookup
    expect(details).toContain('SEARCH p USING AUTOMATIC COVERING INDEX (roomId=? AND ref=?)');
    // void exclusion: three plain (roomId, ref) probes over the pre-materialized
    // void set (the three keys: raw ref, canonical id, head).
    const voidProbes = details.filter(
      (d) => d === 'SEARCH v USING AUTOMATIC COVERING INDEX (roomId=? AND ref=?)',
    );
    expect(voidProbes.length).toBe(3);
    // the old shape sought the room's ledger for void rows on every commission
    // row; that node must not come back.
    expect(details.some((d) => /SEARCH v USING INDEX idx_ledger_room/.test(d))).toBe(false);
  });
});
