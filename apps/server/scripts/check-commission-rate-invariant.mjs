#!/usr/bin/env node
// @ts-nocheck
/**
 * check-commission-rate-invariant.mjs
 *
 * Offline, READ-ONLY audit of the `platformDues` commission-rate grouping.
 *
 * WHY THIS EXISTS
 * `platformDuesSql()` (apps/server/src/house.ts, commit 6c70780) groups
 * `commission_legs` by `(room_id, canonical ref)` but projects
 * `COALESCE(h.commission_bps, r.commission_bps)` as a BARE, un-aggregated
 * column. SQLite is free to pick ANY row of the group for a bare column, so
 * when one canonical hand carries commission legs under two raw refs whose
 * effective rates differ, the reported room rate is non-deterministic. The rate
 * only feeds the room breakdown / bucketing in `platformDuesWithSql`; it never
 * affects the rake total, the winner split or a user's overall accrued dues, so
 * production money is not at risk - but the displayed value should still be
 * well-defined.
 *
 * WHAT THIS CHECKS
 * Every valid `(room_id, canonical ref)` commission group (room active, every
 * void key excluded - exactly the `commissions` CTE's row set) must have exactly
 * ONE effective `commissionBps`. Violations are printed with the room, the
 * canonical ref, the observed rate set, the row count and whether the group's
 * rake is positive (i.e. whether it would actually surface in the report).
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *   - it does NOT touch `apps/server/src/**`: no `throw` on the request path, no
 *     SQL edit, no MIN()/MAX(), and it does NOT add `commissionBps` to the
 *     GROUP BY (that would change the allocation grouping, which must stay
 *     `(room, canonical ref)`).
 *
 * READ-ONLY: the DB is opened `{ readonly: true, fileMustExist: true }` with
 * `PRAGMA query_only = ON`; no migration, no write, no `-wal` checkpoint.
 *
 * Usage:
 *   node apps/server/scripts/check-commission-rate-invariant.mjs [dbPath] [--json]
 *
 *   dbPath  defaults to `apps/server/4amcasino.db` (the live server DB, which
 *           the server opens as `./4amcasino.db` from its own cwd).
 *   --json  machine-readable report on stdout.
 *
 * Exit code: 0 = invariant holds, 1 = at least one ambiguous group,
 *            2 = usage / DB-open error.
 *
 * NOTE ON DRIFT: the two `ledger*Sql` fragments below are copied verbatim from
 * `apps/server/src/handProjection.ts` because a plain `node` process cannot
 * import the TS source. `commissionRateInvariant.test.ts` pins the copy against
 * the real helpers (`ledgerHandIdSql('l')` / `ledgerHeadSql('l')` must be
 * substrings of the emitted SQL), so a source change turns that test red.
 */

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = resolve(HERE, '..', '4amcasino.db');

// --- verbatim mirror of handProjection.ts (see the drift note above) ---------
const SEVEN_DEUCE_KINDS_SQL = "('seven-deuce', 'seven-deuce-show')";

function ledgerHandIdSql(ledgerAlias) {
  const ref = `${ledgerAlias}.ref`;
  const room = `${ledgerAlias}.room_id`;
  return (
    `CASE WHEN ${ledgerAlias}.kind IN ${SEVEN_DEUCE_KINDS_SQL} THEN ${ref} ` +
    `ELSE COALESCE(` +
    `(SELECT hs.hand_id FROM hand_settlements hs WHERE hs.room_id = ${room} AND hs.head = ${ref}), ` +
    `(SELECT t.hand_id FROM transcripts t WHERE t.room_id = ${room} AND t.head = ${ref}), ` +
    `${ref}) END`
  );
}

function ledgerHeadSql(ledgerAlias) {
  const ref = `${ledgerAlias}.ref`;
  const room = `${ledgerAlias}.room_id`;
  return (
    `CASE WHEN ${ledgerAlias}.kind IN ${SEVEN_DEUCE_KINDS_SQL} THEN COALESCE(` +
    `(SELECT hs.head FROM hand_settlements hs WHERE hs.room_id = ${room} AND hs.hand_id = ${ref}), ` +
    `(SELECT t.head FROM transcripts t WHERE t.room_id = ${room} AND t.hand_id = ${ref})) ` +
    `ELSE ${ref} END`
  );
}
// -----------------------------------------------------------------------------

/**
 * The invariant query. Row set and void exclusion mirror the `commission_legs`
 * + `void_rows` + `commissions` CTEs of `platformDuesSql()`, but the outer
 * projection is grouped by `(roomId, ref)` and asks for the DISTINCT rate count
 * instead of an arbitrary rate. `commissionBps` is intentionally NOT added to
 * the GROUP BY.
 */
export function commissionRateInvariantSql() {
  return `
    WITH commission_legs AS MATERIALIZED (
      SELECT l.room_id AS roomId,
             l.ref AS rawRef,
             ${ledgerHandIdSql('l')} AS ref,
             ${ledgerHeadSql('l')} AS head,
             l.delta AS delta,
             COALESCE(h.commission_bps, r.commission_bps) AS commissionBps
      FROM ledger l JOIN rooms r ON r.id = l.room_id
      LEFT JOIN hand_commission_rates h ON h.room_id = l.room_id AND h.ref = l.ref
      WHERE l.kind = 'commission' AND r.voided = 0 AND r.archived = 0 AND r.deleted = 0
    ), void_rows AS MATERIALIZED (
      SELECT DISTINCT room_id AS roomId, ref AS ref
      FROM ledger WHERE kind = 'void-hand'
    )
    SELECT c.roomId AS roomId,
           c.ref AS ref,
           COUNT(*) AS rows,
           SUM(c.delta) AS totalDelta,
           COUNT(DISTINCT c.commissionBps) AS distinctRates,
           GROUP_CONCAT(DISTINCT c.commissionBps) AS rates
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
    GROUP BY c.roomId, c.ref
    ORDER BY rows DESC, c.roomId, c.ref
  `;
}

/** Every valid group with its distinct rate count (used as scan evidence). */
export function commissionRateGroups(db) {
  const rows = db.prepare(commissionRateInvariantSql()).all();
  return rows.map((r) => ({
    roomId: r.roomId,
    canonicalRef: r.ref,
    rows: Number(r.rows),
    distinctRates: Number(r.distinctRates),
    rates: String(r.rates)
      .split(',')
      .map((n) => Number(n))
      .sort((a, b) => a - b),
    totalDelta: Number(r.totalDelta),
    /** Positive rake groups are the ones the report actually buckets. */
    allocates: Number(r.totalDelta) > 0,
  }));
}

/** All ambiguous groups, as plain objects. `[]` means the invariant holds. */
export function findCommissionRateViolations(db) {
  return commissionRateGroups(db).filter((g) => g.distinctRates > 1);
}

/** Read-only handle: `mode=ro` + `query_only`; never migrates or writes. */
export function openReadonly(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  return db;
}

function renderHuman(dbPath, groups, violations) {
  const lines = [];
  lines.push(`commission-rate invariant: ${dbPath}`);
  lines.push(
    `mode: readonly + query_only  |  groups scanned: ${groups.length}  |  violations: ${violations.length}`,
  );
  if (violations.length === 0) {
    lines.push('OK: every valid (room, canonical ref) group has one commissionBps.');
    return lines.join('\n');
  }
  lines.push('');
  lines.push('AMBIGUOUS GROUPS (SQLite may pick any of these rates):');
  for (const v of violations) {
    lines.push(
      `  room=${v.roomId} canonicalRef=${v.canonicalRef} rows=${v.rows} ` +
        `rates={${v.rates.join(', ')}} totalDelta=${v.totalDelta} ` +
        `allocates=${v.allocates ? 'yes' : 'no'}`,
    );
  }
  return lines.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const positional = argv.filter((a) => !a.startsWith('--'));
  const dbPath = positional[0] ? resolve(positional[0]) : DEFAULT_DB;

  if (!existsSync(dbPath)) {
    console.error(`check-commission-rate-invariant: DB not found: ${dbPath}`);
    process.exit(2);
  }

  let db;
  try {
    db = openReadonly(dbPath);
  } catch (err) {
    console.error(`check-commission-rate-invariant: cannot open ${dbPath}: ${err.message}`);
    process.exit(2);
  }

  try {
    const groups = commissionRateGroups(db);
    const violations = groups.filter((g) => g.distinctRates > 1);
    if (json) {
      console.log(
        JSON.stringify({ dbPath, groupsScanned: groups.length, violations }, null, 2),
      );
    } else {
      console.log(renderHuman(dbPath, groups, violations));
    }
    process.exit(violations.length > 0 ? 1 : 0);
  } finally {
    db.close();
  }
}

const invokedDirectly =
  !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
