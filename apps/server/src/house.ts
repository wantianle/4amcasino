import type { HouseDues, HouseRoom, PlatformDuesReport, PlatformDuesUser } from '@4am/shared';
import type { DB } from './db.js';
import { platformUserId } from './platform.js';
import {
  gameNetLedgerDeltaSql,
  gameNetLedgerKindSql,
  ledgerHandIdSql,
  ledgerHeadSql,
  perHandNetSelect,
} from './handProjection.js';

/**
 * SQL behind {@link platformDues}. AVAILABILITY-CRITICAL (same family as commit
 * 787ee1c): `ledgerHandIdSql` (two correlated subqueries over
 * `hand_settlements` / `transcripts`) must be resolved ONCE per source row in a
 * MATERIALIZED CTE, never inline on a join/candidate path, because
 * better-sqlite3 is synchronous and a per-candidate re-evaluation wedges the
 * whole server's event loop.
 *
 * Three costs are removed vs. the pre-fix text:
 *   1. commission rows carry their canonical id (and head) computed per row in
 *      `commission_legs AS MATERIALIZED`, instead of re-deriving it while the
 *      outer join and the per-room EXISTS ran;
 *   2. `void_rows AS MATERIALIZED` is the set of void keys, so void exclusion
 *      no longer scans every ledger row of the room for each commission row;
 *   3. `participant_legs AS MATERIALIZED` holds the target user's game-net legs
 *      with their canonical id, so the personal EXISTS compares two plain
 *      columns `(roomId, ref)` instead of re-resolving `ledgerHandIdSql` on both
 *      sides for every candidate pair.
 *
 * Semantics are preserved verbatim: the personal filter stays an EXISTS (never a
 * JOIN, so duplicate game legs cannot amplify `SUM(delta)`); commission keeps its
 * RAW `l.ref` for the rate lookup (`hand_commission_rates` is keyed by raw ref);
 * void exclusion still matches all THREE keys (raw ref, canonical id, head); and
 * the winners aggregate keeps its own no-void-exclusion shape.
 */
export function platformDuesSql(): string {
  return `
    WITH commission_legs AS MATERIALIZED (
      SELECT l.room_id AS roomId,
             l.ref AS rawRef,
             ${ledgerHandIdSql('l')} AS ref,
             ${ledgerHeadSql('l')} AS head,
             l.delta AS delta,
             r.name AS roomName,
             COALESCE(h.commission_bps, r.commission_bps) AS commissionBps
      FROM ledger l JOIN rooms r ON r.id = l.room_id
      LEFT JOIN hand_commission_rates h ON h.room_id = l.room_id AND h.ref = l.ref
      WHERE l.kind = 'commission' AND r.voided = 0 AND r.archived = 0 AND r.deleted = 0
    ), void_rows AS MATERIALIZED (
      SELECT DISTINCT room_id AS roomId, ref AS ref
      FROM ledger WHERE kind = 'void-hand'
    ), participant_legs AS MATERIALIZED (
      SELECT DISTINCT l.room_id AS roomId, ${ledgerHandIdSql('l')} AS ref
      FROM ledger l
      WHERE ${gameNetLedgerKindSql('l')} AND l.user_id = @userId
    ), commissions AS (
      SELECT c.roomId AS roomId, c.ref AS ref, SUM(c.delta) AS rake,
             c.roomName AS roomName, c.commissionBps AS commissionBps
      FROM commission_legs c
      WHERE NOT EXISTS (
          SELECT 1 FROM void_rows v
          WHERE v.roomId = c.roomId AND v.ref = c.rawRef)
        AND NOT EXISTS (
          SELECT 1 FROM void_rows v
          WHERE v.roomId = c.roomId AND v.ref = c.ref)
        AND NOT EXISTS (
          SELECT 1 FROM void_rows v
          WHERE v.roomId = c.roomId AND v.ref = c.head)
        AND (@userId IS NULL OR EXISTS (
          SELECT 1 FROM participant_legs p
          WHERE p.roomId = c.roomId AND p.ref = c.ref))
      GROUP BY c.roomId, c.ref HAVING SUM(c.delta) > 0
    ), winners AS MATERIALIZED (
      ${perHandNetSelect('l', {
        perUser: true,
        userAlias: 'userId',
        // No void exclusion here on purpose: the outer query only ever reads
        // winners through the void-excluded `commissions` CTE, so a voided
        // hand's winners never surface. Behaviour preserved verbatim.
        excludeVoided: false,
        filter: '(@platformId IS NULL OR l.user_id != @platformId)',
        having: `SUM(${gameNetLedgerDeltaSql('l')}) > 0`,
      })}
    )
    SELECT c.*, w.userId, w.net FROM commissions c
    LEFT JOIN winners w ON w.room_id = c.roomId AND w.ref = c.ref
    ORDER BY c.roomId, c.ref, w.userId
  `;
}

/** One source for personal dues and the platform's receivables. Allocation keeps
 * the established rule (net winners share each hand's commission), but assigns
 * each odd chip once, instead of rounding each person's share independently.
 * Retired rooms and voided hands follow the existing settle-up exclusions. */
export function platformDues(db: DB, onlyUserId: number | null = null): PlatformDuesReport {
  return platformDuesWithSql(db, platformDuesSql(), onlyUserId);
}

/**
 * Runs an arbitrary dues query through the ONE shared report assembler. The
 * equivalence test passes the pre-optimization SQL text so both versions are
 * compared field-by-field through the exact same JS allocation logic (the
 * allocation rule itself is not under test here).
 */
export function platformDuesWithSql(
  db: DB,
  sql: string,
  onlyUserId: number | null = null,
): PlatformDuesReport {
  const platformId = platformUserId(db);
  const rows = db
    .prepare(sql)
    .all({ userId: onlyUserId, platformId }) as {
    roomId: string;
    roomName: string;
    commissionBps: number;
    ref: string | null;
    rake: number;
    userId: number | null;
    net: number | null;
  }[];
  const hands = new Map<
    string,
    { room: HouseRoom; rake: number; winners: { userId: number; net: number }[] }
  >();
  for (const row of rows) {
    const key = JSON.stringify([row.roomId, row.ref]);
    let hand = hands.get(key);
    if (!hand) {
      hand = {
        room: {
          roomId: row.roomId,
          roomName: row.roomName,
          commissionBps: row.commissionBps,
          accrued: 0,
        },
        rake: row.rake,
        winners: [],
      };
      hands.set(key, hand);
    }
    if (row.userId !== null && row.net !== null)
      hand.winners.push({ userId: row.userId, net: row.net });
  }
  const roomsByUser = new Map<number, Map<string, HouseRoom>>();
  let unallocated = 0;
  for (const hand of hands.values()) {
    const total = hand.winners.reduce((sum, w) => sum + BigInt(w.net), 0n);
    if (total === 0n) {
      unallocated += hand.rake;
      continue;
    }
    const shares = hand.winners
      .map((w) => {
        const numerator = BigInt(hand.rake) * BigInt(w.net);
        return {
          userId: w.userId,
          amount: Number(numerator / total),
          remainder: numerator % total,
        };
      })
      .sort((a, b) =>
        a.remainder === b.remainder ? a.userId - b.userId : a.remainder > b.remainder ? -1 : 1,
      );
    let remaining = hand.rake - shares.reduce((sum, s) => sum + s.amount, 0);
    for (const share of shares) {
      if (remaining > 0) {
        share.amount++;
        remaining--;
      }
      if (share.amount === 0 || (onlyUserId !== null && share.userId !== onlyUserId)) continue;
      let rooms = roomsByUser.get(share.userId);
      if (!rooms) {
        rooms = new Map();
        roomsByUser.set(share.userId, rooms);
      }
      const roomKey = JSON.stringify([hand.room.roomId, hand.room.commissionBps]);
      const room = rooms.get(roomKey) ?? { ...hand.room };
      room.accrued += share.amount;
      rooms.set(roomKey, room);
    }
  }
  const payments = db
    .prepare(
      `SELECT user_id AS userId, SUM(amount) AS paid FROM house_payments
    WHERE (@userId IS NULL OR user_id = @userId) GROUP BY user_id`,
    )
    .all({ userId: onlyUserId }) as { userId: number; paid: number }[];
  const paidByUser = new Map(payments.map((p) => [p.userId, p.paid]));
  const users = db
    .prepare(
      `SELECT id AS userId, username, COALESCE(display_name, username) AS displayName,
    avatar_version AS avatarVersion FROM users WHERE (@userId IS NULL OR id = @userId)
    AND (@platformId IS NULL OR id != @platformId)`,
    )
    .all({ userId: onlyUserId, platformId }) as {
    userId: number;
    username: string;
    displayName: string;
    avatarVersion: number;
  }[];
  const people: PlatformDuesUser[] = [];
  for (const user of users) {
    const rooms = [...(roomsByUser.get(user.userId)?.values() ?? [])].sort(
      (a, b) => b.accrued - a.accrued || a.roomName.localeCompare(b.roomName),
    );
    const accrued = rooms.reduce((sum, room) => sum + room.accrued, 0);
    const paid = paidByUser.get(user.userId) ?? 0;
    if (!accrued && !paid) continue;
    people.push({
      ...user,
      rooms,
      accrued,
      paid,
      outstanding: Math.max(0, accrued - paid),
      credit: Math.max(0, paid - accrued),
    });
  }
  people.sort(
    (a, b) =>
      b.outstanding - a.outstanding ||
      a.displayName.localeCompare(b.displayName) ||
      a.userId - b.userId,
  );
  const totals = people.reduce(
    (sum, user) => ({
      accrued: sum.accrued + user.accrued,
      paid: sum.paid + user.paid,
      outstanding: sum.outstanding + user.outstanding,
      credit: sum.credit + user.credit,
      usersOwing: sum.usersOwing + (user.outstanding > 0 ? 1 : 0),
      unallocated: sum.unallocated,
    }),
    { accrued: 0, paid: 0, outstanding: 0, credit: 0, usersOwing: 0, unallocated },
  );
  return { people, totals };
}

export function houseDues(db: DB, userId: number): HouseDues {
  const person = platformDues(db, userId).people[0];
  if (!person) return { accrued: 0, paid: 0, outstanding: 0, credit: 0, rooms: [] };
  const { accrued, paid, outstanding, credit, rooms } = person;
  return { accrued, paid, outstanding, credit, rooms };
}
