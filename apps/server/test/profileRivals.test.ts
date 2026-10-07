import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb, type DB } from '../src/db.js';
import { appendLedger } from '../src/ledger.js';
import { rivalsOtherLegsSql } from '../src/handProjection.js';

// ---------------------------------------------------------------------------
// Regression tests for the production outage fixed in 787ee1c.
//
// `GET /api/users/:id/profile` built the rivals "other legs" scan with
// `ledgerHandIdSql('l')` (itself two correlated subqueries over
// hand_settlements / transcripts) written straight into the JOIN's ON clause.
// SQLite then re-evaluated that expression once per (mine x ledger-in-room)
// candidate pair - ~1.5M times on live data. better-sqlite3 is synchronous, so
// the event loop wedged for minutes: CPU 90%+, every request timed out, even
// SIGTERM went unanswered.
//
// The fix resolves the canonical id once per row in MATERIALIZED CTEs and joins
// on the plain columns. These assertions lock THAT structure - not wall time -
// so they are deterministic and machine-speed independent.
// ---------------------------------------------------------------------------

interface PlanRow {
  id: number;
  parent: number;
  detail: string;
}

/** `EXPLAIN QUERY PLAN` for the builder, binding its own `?` count with dummies. */
function plan(db: DB, sql: string): PlanRow[] {
  const n = (sql.match(/\?/g) ?? []).length;
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array<number>(n).fill(1)) as PlanRow[];
}

describe('rivalsOtherLegsSql - execution plan (787ee1c)', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  it('materializes both sides of the join', () => {
    const details = plan(db, rivalsOtherLegsSql()).map((r) => r.detail);
    // The old SQL has no MATERIALIZE node at all (it inlined the canonical id
    // into the ON clause), so these fail if the regression is reintroduced.
    expect(details.some((d) => /^MATERIALIZE mine\b/.test(d))).toBe(true);
    expect(details.some((d) => /^MATERIALIZE other_legs\b/.test(d))).toBe(true);
  });

  it('resolves every canonical-id correlated subquery during CTE materialization, never on the join path', () => {
    const rows = plan(db, rivalsOtherLegsSql());
    const byId = new Map(rows.map((r) => [r.id, r]));

    // The canonical id (ledgerHandIdSql) is genuinely a correlated subquery, so
    // its presence is expected and must NOT be asserted away.
    const correlated = rows.filter((r) => /^CORRELATED SCALAR SUBQUERY\b/.test(r.detail));
    expect(correlated.length).toBeGreaterThan(0);

    // Each one must have a MATERIALIZE ancestor: that is the whole point of the
    // fix - the subquery runs once while the CTE is built, not once per
    // candidate pair in the outer join. With the old SQL these hang off the
    // outer query (`parent=0`) and have no MATERIALIZE ancestor.
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
    for (const row of correlated) {
      expect(
        underMaterialize(row),
        `correlated subquery escaped the CTE stage: id=${row.id} parent=${row.parent} -> ${row.detail}`,
      ).toBe(true);
    }
  });
});

describe('rivalsOtherLegsSql - SQL structure', () => {
  const sql = rivalsOtherLegsSql();

  it('spells out both MATERIALIZED CTEs', () => {
    expect(sql).toMatch(/WITH mine AS MATERIALIZED \(/);
    expect(sql).toMatch(/other_legs AS MATERIALIZED \(/);
  });

  it('keeps the canonical-id resolution out of the outer join clause', () => {
    const outerStart = sql.indexOf('SELECT DISTINCT o.userId');
    // The old buggy shape selected `l.user_id` in the outer query, so this
    // marker is absent and the test fails on a revert.
    expect(outerStart).toBeGreaterThan(-1);
    const outer = sql.slice(outerStart);
    expect(outer).toContain('JOIN mine ON mine.room_id = o.roomId AND mine.ref = o.ref');
    // No correlated lookup may sit in the join condition.
    expect(outer).not.toMatch(/hand_settlements|transcripts|COALESCE/);
  });

  it('keeps the (mine, other) bind order with exactly two placeholders', () => {
    expect((sql.match(/\?/g) ?? []).length).toBe(2);
    const mineCte = sql.slice(sql.indexOf('WITH mine'), sql.indexOf('other_legs AS MATERIALIZED'));
    const otherCte = sql.slice(
      sql.indexOf('other_legs AS MATERIALIZED'),
      sql.indexOf('SELECT DISTINCT'),
    );
    expect(mineCte).toContain('m.user_id = ?');
    expect(otherCte).toContain('l.user_id != ?');
    // mine's `?` comes first, matching the handler's `.all(id, id)`.
    expect(sql.indexOf('?')).toBeLessThan(sql.lastIndexOf('?'));
  });
});

// ---------------------------------------------------------------------------
// Data-level regression through the real route. Builds a mixed-ref world so the
// canonical id is resolved by BOTH correlated subqueries (a durable
// hand_settlements marker and the transcripts fallback) and by the direct
// hand-id path (seven-deuce bounty), and includes a voided hand that must count
// for neither side. Expectations are hand-computed (the independent reference).
// ---------------------------------------------------------------------------
describe('profile rivals - mixed refs, transcript fallback and void', () => {
  let ctx: ReturnType<typeof createApp>;
  beforeEach(() => {
    ctx = createApp(':memory:');
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  async function user(name: string) {
    const r = await ctx.app.inject({
      method: 'POST',
      url: '/api/register',
      payload: { username: name, authKey: 'a'.repeat(64), publicKey: 'b'.repeat(64) },
    });
    return { token: r.json().token as string, userId: r.json().userId as number };
  }
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  it('joins head-ref, hand-id-ref and markerless legs on the canonical hand id, and drops voids', async () => {
    const a = await user('rva');
    const b = await user('rvb');
    const c = await user('rvc');
    const room = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/rooms',
        headers: auth(a.token),
        payload: { name: 'rv', sb: 1, bb: 2 },
      })
    ).json();
    const headMarker = (handId: string, head: string) =>
      ctx.db
        .prepare(
          "INSERT INTO hand_settlements (hand_id, room_id, head, rake, final_stacks, applied_at) VALUES (?, ?, ?, 0, '[]', 1)",
        )
        .run(handId, room.id, head);
    const ledger = (userId: number, delta: number, kind: string, ref: string) =>
      appendLedger(ctx.db, { roomId: room.id, userId, delta, kind, ref });

    // h1: ordinary head-ref settlement, canonicalised by the marker.
    headMarker('h1', 'head1');
    ledger(a.userId, 100, 'hand-settlement', 'head1');
    ledger(b.userId, -100, 'hand-settlement', 'head1');

    // h2: A wins an automatic 7-2 bounty (hand-id ref) while B/C settle under
    // the head ref - the two conventions must collapse onto one hand.
    headMarker('h2', 'head2');
    ledger(a.userId, 5, 'seven-deuce', 'h2');
    ledger(b.userId, -60, 'hand-settlement', 'head2');
    ledger(c.userId, 55, 'hand-settlement', 'head2');

    // h3: no marker at all; the transcripts projection must resolve the head.
    ctx.db
      .prepare(
        'INSERT INTO transcripts (hand_id, room_id, head, entries, ts) VALUES (?, ?, ?, ?, 1)',
      )
      .run('h3', room.id, 'head3only', '[]');
    ledger(a.userId, 7, 'hand-settlement', 'head3only');
    ledger(b.userId, -7, 'hand-settlement', 'head3only');

    // h4: settled then voided - must count for neither side.
    headMarker('h4', 'head4');
    ledger(a.userId, 100, 'hand-settlement', 'head4');
    ledger(b.userId, -100, 'hand-settlement', 'head4');
    ctx.db
      .prepare(
        "INSERT INTO ledger (room_id, user_id, delta, kind, ref, ts, prev_hash, entry_hash) VALUES (?, ?, 0, 'void-hand', ?, 1, 'p', 'e')",
      )
      .run(room.id, a.userId, 'head4');

    // a non-game leg is never part of the rivals net.
    ledger(a.userId, 500, 'purchase', 'p1');

    const p = (
      await ctx.app.inject({
        method: 'GET',
        url: `/api/users/${a.userId}/profile`,
        headers: auth(b.token),
      })
    ).json();

    // A's per-hand net: 100 (h1) + 5 (h2 bounty) + 7 (h3); h4 voided. handsPlayed
    // counts settled game markers only, so the markerless-net h2 does not add one.
    expect(p.stats).toMatchObject({ net: 112, handsPlayed: 2, biggestWin: 100 });

    // B shares h1+h2+h3 (netVs = 100+5+7); C shares only h2 (netVs = 5).
    expect(p.rivals).toHaveLength(2);
    expect(p.rivals[0]).toMatchObject({ username: 'rvb', handsTogether: 3, netVs: 112 });
    expect(p.rivals[1]).toMatchObject({ username: 'rvc', handsTogether: 1, netVs: 5 });
  });
});
