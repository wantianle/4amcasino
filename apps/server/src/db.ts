import Database from 'better-sqlite3';
import { computeHead } from '@4am/mental-poker';
import { SEVEN_DEUCE_SHOW_KIND } from './handProjection.js';
import { verifyLedger } from './ledger.js';
import { runMigrations } from './migrations/index.js';
import { tableExists } from './migrations/util.js';

export type DB = Database.Database;

// The standalone migrations and shared migration helpers now live under
// ./migrations/*. They are re-exported here so the long-standing
// `from './db.js'` import surface stays unchanged for every existing caller.
export { migrate, recoverOrphanedFeatureTriggers, SESSION_TTL_MS } from './migrations/base.js';
export { migrateBetRatios } from './migrations/betRatios.js';
export { migrateBots } from './migrations/bots.js';
export { migrateSettlementPrepared } from './migrations/settlementPrepared.js';
export { migrateAdminAudit } from './migrations/adminAudit.js';

export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Give a competing writer (another server process opening the same file at
  // the same time) room to finish before SQLITE_BUSY is raised. The one-time
  // migrations below take an immediate write lock; without this wait the loser
  // of a startup race would fail outright instead of waiting its turn.
  db.pragma('busy_timeout = 10000');
  try {
    runMigrations(db);
  } catch (err) {
    // A step that throws may have committed earlier steps, so the file can be
    // left half-migrated; the process is about to abort, but the SQLite handle
    // must not leak. Close it before rethrowing the original error. The chain
    // is deliberately NOT wrapped in one transaction: the per-step DDL and the
    // `:memory:` path both rely on the current commit semantics.
    db.close();
    throw err;
  }
  return db;
}

/**
 * Appends one row to the admin audit trail. This is a plain synchronous INSERT
 * on whatever connection the caller passes, so a call made from inside a
 * `db.transaction(...)` body commits (or rolls back) with the business change
 * it records - the intended usage. Kept in db.ts rather than admin.ts so the
 * admin and settings routes can all share it without an
 * import cycle. `detail` is JSON-encoded only when provided.
 */
export function writeAdminAudit(
  db: DB,
  operatorUserId: number,
  action: string,
  targetType: string | null,
  targetId: string | null,
  detail?: unknown,
): void {
  db.prepare(
    `INSERT INTO admin_audit (operator_user_id, action, target_type, target_id, detail, ts)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    operatorUserId,
    action,
    targetType,
    targetId,
    detail === undefined ? null : JSON.stringify(detail),
    Date.now(),
  );
}


/**
 * Strict, time-independent reconciliation of the transcripts that predate (or
 * otherwise escaped) the atomic lifecycle protocol.
 *
 * A `hand_settlements` marker, when it agrees with the transcript and the room,
 * is proof the hand committed. A transcript WITHOUT a marker cannot be assumed
 * settled - it may be an old non-atomic finalize that wrote the transcript and
 * then crashed before the marker - so every money leg it implies must be present
 * and close exactly against the stats projection and the ledger hash chain. All
 * checks pass -> `committed` (recorded with `last_error = 'legacy reconciled'`
 * for auditability); any check fails -> `quarantined` (gates dealing).
 *
 * This intentionally does NOT use the previous `ts < cutoff -> legacy` rule: a
 * process wall-clock cutoff is not a protocol boundary, so a half-settled hand,
 * a skewed/rewound clock or an unparsable cutoff could all be whitelisted. The
 * reconciliation also re-runs on every open, so a markerless transcript can
 * never slip past the deal-time gate.
 *
 * NOTE (residual gap, out of scope this round): the reconciliation proves the
 * transcript, ledger and stats projection agree with each other. It does NOT
 * anchor to the wallet history - it does not rebuild each account's balance in
 * ledger order nor check `room_players.stack`. A hand that wrote
 * transcript/ledger/projection and then crashed BEFORE the stack update would
 * still reconcile to `committed`. Wallet anchoring is tracked separately.
 */

/** A single transcript's reconciliation verdict. */
export interface TranscriptReconcile {
  ok: boolean;
  reason: string;
}

/** Read-only audit of the reconciliation an upgrade would perform. */
export interface MarkerlessAudit {
  /** Total transcripts examined. */
  transcripts: number;
  /** Transcripts with no `hand_settlements` marker. */
  markerless: number;
  /** Markerless transcripts whose legs close exactly -> would be `committed`. */
  reconciled: number;
  /** Transcripts whose lifecycle row a consistent marker moved to `committed`
   *  (including overriding a stale running/quarantined/legacy/aborted row). */
  committedFromMarker: number;
  /** Markers that disagree with the transcript/room -> would be `quarantined`. */
  markerConflicts: { handId: string; roomId: string; reason: string }[];
  /** Markerless transcripts that fail a check -> would be `quarantined`. */
  quarantined: { handId: string; roomId: string; reason: string }[];
  /** Transcripts that already carry a terminal lifecycle row (skipped). */
  alreadyClassified: number;
}

function failReconcile(reason: string): TranscriptReconcile {
  return { ok: false, reason };
}

interface ParsedSettlement {
  entries: unknown[];
  rake: number;
}

/** Parse a transcript's single `settlement` entry and its non-negative integer
 *  rake. Returns a string reason when the transcript is not trustworthy enough
 *  to reconcile. Rake is treated as an untrusted data boundary: a present but
 *  non-integer/negative commission rejects the whole transcript. */
function parseSettlementEntry(entriesJson: string): ParsedSettlement | string {
  let entries: unknown;
  try {
    entries = JSON.parse(entriesJson);
  } catch {
    return 'transcript entries are not valid JSON';
  }
  if (!Array.isArray(entries)) return 'transcript entries are not an array';
  const settlements = (entries as { type?: unknown }[]).filter(
    (e) => e !== null && typeof e === 'object' && (e as { type?: unknown }).type === 'settlement',
  );
  if (settlements.length !== 1)
    return `expected exactly one settlement entry, found ${settlements.length}`;
  const payload = (settlements[0] as { payload?: unknown }).payload;
  if (!payload || typeof payload !== 'object') return 'settlement entry has no payload';
  const commission = (payload as { commission?: unknown }).commission;
  if (commission === undefined) return { entries: entries as unknown[], rake: 0 };
  if (typeof commission !== 'number' || !Number.isInteger(commission) || commission < 0)
    return `settlement commission is not a non-negative integer (${String(commission)})`;
  return { entries: entries as unknown[], rake: commission };
}

/**
 * The strict per-transcript check. Read-only. A transcript is trusted only when
 * its transcript chain, its settlement legs, its stats projection and its room
 * all agree.
 *
 * Conditions (all required):
 *  1. one `settlement` entry whose entries' hash chain reproduces the stored
 *     `head`, with a non-negative integer rake;
 *  2. the only ledger kinds are hand-settlement / squid-game / commission on the
 *     head and seven-deuce (automatic bounty) / seven-deuce-show (voluntary
 *     post-settlement show) on the hand id, no duplicate leg on either key. The
 *     voluntary show is NOT reconciled against the transcript/projection: it is
 *     a post-settlement transfer outside `net_delta`, so it is tolerated on the
 *     hand-id ref but excluded from every leg check below;
 *  3. every hand-settlement / squid-game / seven-deuce user is a seat in the
 *     hand's `hand_players` (commission is the sole out-of-hand leg);
 *  4. rake > 0 -> exactly one commission leg, credited to a real room account;
 *     rake === 0 -> no commission leg;
 *  5. seven-deuce is a well-formed zero-sum bounty: one positive winner leg,
 *     >=1 payer, payers exactly fund the winner;
 *  6. a trusted stats projection exists for the SAME room, anchored to the same
 *     head, `projection_status = 'ok'`, non-negative integer rake matching;
 *  7. per player `net_delta` equals the ledger legs, `poker_delta` equals
 *     hand-settlement + seven-deuce, and
 *     `ending_stack - starting_stack === net_delta + commission`;
 *  8. `sum(net_delta) === -rake` and the room ledger hash chain is valid.
 *
 * Mid-hand buys are an intervening account delta: a markerless hand that was
 * bought into mid-hand fails (7) and is quarantined rather than guessed at.
 */
export function reconcileTranscript(
  db: DB,
  t: { hand_id: string; room_id: string; head: string; entries: string },
): TranscriptReconcile {
  if (!tableExists(db, 'hands') || !tableExists(db, 'hand_players'))
    return failReconcile('stats projection tables are missing');

  const parsed = parseSettlementEntry(t.entries);
  if (typeof parsed === 'string') return failReconcile(parsed);
  const { entries, rake } = parsed;
  if (computeHead(entries as never) !== t.head)
    return failReconcile('transcript head does not match its entry chain');

  // (2) ref-domain isolation: the settlement-head ref may carry ONLY the three
  // settlement kinds, and the hand-id ref may carry ONLY the bounty kinds
  // (automatic `seven-deuce` and the voluntary `seven-deuce-show`). Any other
  // kind on either key is an unexplained money leg (or a kind smuggled under the
  // wrong ref, e.g. `commission` with `ref = hand_id`) and quarantines the hand.
  const badKind = db
    .prepare(
      `SELECT kind FROM ledger WHERE room_id = ? AND ref = ?
        AND kind NOT IN ('hand-settlement','squid-game','commission') LIMIT 1`,
    )
    .get(t.room_id, t.head) as { kind: string } | undefined;
  if (badKind) return failReconcile(`unexpected ledger kind '${badKind.kind}' on the settlement head`);
  const badHandRef = db
    .prepare(
      `SELECT kind FROM ledger WHERE room_id = ? AND ref = ? AND kind NOT IN ('seven-deuce', ?) LIMIT 1`,
    )
    .get(t.room_id, t.hand_id, SEVEN_DEUCE_SHOW_KIND) as { kind: string } | undefined;
  if (badHandRef)
    return failReconcile(`unexpected ledger kind '${badHandRef.kind}' on the hand-id ref`);
  const dup = db
    .prepare(
      `SELECT user_id, kind, COUNT(*) AS c FROM ledger
        WHERE room_id = ? AND (ref = ? OR (kind = 'seven-deuce' AND ref = ?))
        GROUP BY user_id, kind HAVING c > 1 LIMIT 1`,
    )
    .get(t.room_id, t.head, t.hand_id) as { user_id: number; kind: string } | undefined;
  if (dup) return failReconcile(`duplicate ${dup.kind} leg for user ${dup.user_id}`);

  const legs = db
    .prepare(
      `SELECT user_id, kind, delta FROM ledger
        WHERE room_id = ? AND (ref = ? OR (kind = 'seven-deuce' AND ref = ?))`,
    )
    .all(t.room_id, t.head, t.hand_id) as { user_id: number; kind: string; delta: number }[];
  const sumKind = (kind: string) => legs.reduce((s, l) => (l.kind === kind ? s + l.delta : s), 0);
  const hs = sumKind('hand-settlement');
  const sq = sumKind('squid-game');
  const comm = sumKind('commission');
  const sd = sumKind('seven-deuce');

  // (6) trusted stats projection, scoped to the SAME room
  const hand = db
    .prepare(
      'SELECT room_id, source_head, rake, projection_status FROM hands WHERE hand_id = ?',
    )
    .get(t.hand_id) as
    | { room_id: string; source_head: string; rake: number; projection_status: string }
    | undefined;
  if (!hand) return failReconcile('no stats projection for the hand');
  if (hand.room_id !== t.room_id)
    return failReconcile(`projection room_id ${hand.room_id} != transcript room_id ${t.room_id}`);
  if (hand.source_head !== t.head) return failReconcile('projection source_head != transcript head');
  if (hand.projection_status !== 'ok')
    return failReconcile(`projection status '${hand.projection_status}' is not trustworthy`);
  if (!Number.isInteger(hand.rake) || hand.rake < 0)
    return failReconcile(`projection rake ${hand.rake} is not a non-negative integer`);
  if (hand.rake !== rake) return failReconcile(`projection rake ${hand.rake} != transcript rake ${rake}`);

  const players = db
    .prepare(
      'SELECT user_id, starting_stack, ending_stack, poker_delta, net_delta FROM hand_players WHERE hand_id = ?',
    )
    .all(t.hand_id) as {
    user_id: number;
    starting_stack: number | null;
    ending_stack: number | null;
    poker_delta: number;
    net_delta: number;
  }[];
  if (players.length === 0) return failReconcile('no hand_players projection rows');
  const playerIds = new Set(players.map((p) => p.user_id));

  // (3) every non-commission leg must belong to a seat in THIS hand.
  for (const l of legs) {
    if (l.kind === 'commission') continue;
    if (!playerIds.has(l.user_id))
      return failReconcile(`${l.kind} leg for user ${l.user_id} is not a seat in this hand`);
  }

  // (4) commission: exactly one real room account, only when a rake was taken.
  const commLegs = legs.filter((l) => l.kind === 'commission');
  if (rake > 0) {
    if (commLegs.length !== 1)
      return failReconcile(`expected exactly one commission leg, found ${commLegs.length}`);
    const recipient = commLegs[0]!.user_id;
    const account = db
      .prepare('SELECT 1 FROM room_players WHERE room_id = ? AND user_id = ?')
      .get(t.room_id, recipient);
    if (!account)
      return failReconcile(`commission recipient ${recipient} is not a room account`);
  } else if (commLegs.length > 0) {
    return failReconcile('no rake but a commission leg is present');
  }

  // (5) seven-deuce: a well-formed zero-sum bounty.
  const sdLegs = legs.filter((l) => l.kind === 'seven-deuce');
  if (sdLegs.length > 0) {
    const winners = sdLegs.filter((l) => l.delta > 0);
    const payers = sdLegs.filter((l) => l.delta < 0);
    if (winners.length !== 1)
      return failReconcile(`seven-deuce must have exactly one winner leg, found ${winners.length}`);
    if (payers.length === 0) return failReconcile('seven-deuce has a winner but no payer leg');
    const paid = payers.reduce((s, l) => s - l.delta, 0);
    if (paid !== winners[0]!.delta)
      return failReconcile(`seven-deuce payers ${paid} != winner ${winners[0]!.delta}`);
  }

  // (4b) leg closure
  if (hs !== -rake) return failReconcile(`hand-settlement legs sum ${hs} != -rake ${-rake}`);
  if (sq !== 0) return failReconcile(`squid-game legs sum ${sq} != 0`);
  if (comm !== rake) return failReconcile(`commission legs sum ${comm} != rake ${rake}`);
  if (sd !== 0) return failReconcile(`seven-deuce legs sum ${sd} != 0`);

  const legFor = (kind: string, userId: number) =>
    legs.reduce((s, l) => (l.kind === kind && l.user_id === userId ? s + l.delta : s), 0);
  let netSum = 0;
  for (const p of players) {
    // (7) per-player ledger closure, poker/bounty split and stack closure
    const netExpected =
      legFor('hand-settlement', p.user_id) +
      legFor('squid-game', p.user_id) +
      legFor('seven-deuce', p.user_id);
    if (p.net_delta !== netExpected)
      return failReconcile(`user ${p.user_id} net_delta ${p.net_delta} != ledger legs ${netExpected}`);
    const pokerExpected =
      legFor('hand-settlement', p.user_id) + legFor('seven-deuce', p.user_id);
    if (p.poker_delta !== pokerExpected)
      return failReconcile(
        `user ${p.user_id} poker_delta ${p.poker_delta} != hand-settlement + seven-deuce ${pokerExpected}`,
      );
    if (p.starting_stack === null || p.ending_stack === null)
      return failReconcile(`user ${p.user_id} projection has no stacks`);
    if (p.ending_stack - p.starting_stack !== p.net_delta + legFor('commission', p.user_id))
      return failReconcile(
        `user ${p.user_id} ending-starting != net_delta + commission (mid-hand buy or corruption)`,
      );
    netSum += p.net_delta;
  }
  // (8) table-level conservation and ledger hash chain
  if (netSum !== -rake) return failReconcile(`sum(net_delta) ${netSum} != -rake ${-rake}`);
  const chain = verifyLedger(db, t.room_id);
  if (!chain.ok) return failReconcile(`ledger hash chain invalid at id ${chain.badId}`);
  return { ok: true, reason: 'legacy reconciled' };
}

/**
 * Bring `hand_lifecycle` in line with the transcripts. Idempotent and safe to
 * run on every open:
 *
 *  - marker present and CONSISTENT with the transcript/room -> `committed`,
 *    overriding a stale `running` / `prepared` / `quarantined` / `legacy` row,
 *    and also an `aborted` row: the marker proves the settlement transaction
 *    committed, so an `aborted` row is a contradiction and the only safe
 *    resolution is `committed` (freeze) - never re-deal over a settled hand.
 *    An inconsistent marker is corruption and is quarantined, not trusted.
 *  - no marker and no lifecycle row, or a stale `legacy` row -> run the strict
 *    reconciliation and record `committed` / `quarantined`;
 *  - a terminal non-committed row with no marker -> leave it alone.
 *
 * `dryRun` performs every check but writes nothing, for the operator diagnostic.
 */
export function reconcileMissingSettlements(db: DB, opts: { dryRun?: boolean } = {}): MarkerlessAudit {
  const dryRun = opts.dryRun ?? false;
  const transcripts = db
    .prepare('SELECT hand_id, room_id, head, entries FROM transcripts')
    .all() as { hand_id: string; room_id: string; head: string; entries: string }[];
  const markers = new Map(
    (
      db
        .prepare('SELECT hand_id, room_id, head, rake FROM hand_settlements')
        .all() as { hand_id: string; room_id: string; head: string; rake: number }[]
    ).map((r) => [r.hand_id, r]),
  );
  const existing = new Map(
    (tableExists(db, 'hand_lifecycle')
      ? (db.prepare('SELECT hand_id, status FROM hand_lifecycle').all() as {
          hand_id: string;
          status: string;
        }[])
      : []
    ).map((r) => [r.hand_id, r.status]),
  );

  const audit: MarkerlessAudit = {
    transcripts: transcripts.length,
    markerless: 0,
    reconciled: 0,
    committedFromMarker: 0,
    markerConflicts: [],
    quarantined: [],
    alreadyClassified: 0,
  };
  const now = Date.now();
  const setCommitted = (handId: string, roomId: string, note: string | null) => {
    if (dryRun) return;
    db.prepare(
      `INSERT INTO hand_lifecycle (hand_id, room_id, status, created_at, updated_at, resolved_at, last_error)
       VALUES (?, ?, 'committed', ?, ?, ?, ?)
       ON CONFLICT(hand_id) DO UPDATE SET status = 'committed',
         updated_at = excluded.updated_at, resolved_at = excluded.resolved_at,
         last_error = excluded.last_error`,
    ).run(handId, roomId, now, now, now, note);
  };
  const setQuarantined = (handId: string, roomId: string, reason: string) => {
    if (dryRun) return;
    db.prepare(
      `INSERT INTO hand_lifecycle (hand_id, room_id, status, created_at, updated_at, resolved_at, last_error)
       VALUES (?, ?, 'quarantined', ?, ?, NULL, ?)
       ON CONFLICT(hand_id) DO UPDATE SET status = 'quarantined',
         updated_at = excluded.updated_at, resolved_at = NULL,
         last_error = excluded.last_error`,
    ).run(handId, roomId, now, now, reason);
  };
  const work = () => {
    for (const t of transcripts) {
      const marker = markers.get(t.hand_id);
      if (marker) {
        // The marker is proof ONLY when it agrees with the transcript and the
        // room; never trust it by hand_id alone.
        const parsed = parseSettlementEntry(t.entries);
        const consistent =
          typeof parsed !== 'string' &&
          marker.room_id === t.room_id &&
          marker.head === t.head &&
          marker.rake === parsed.rake &&
          Number.isInteger(marker.rake) &&
          marker.rake >= 0 &&
          computeHead(parsed.entries as never) === t.head;
        if (!consistent) {
          const reason = 'settlement marker disagrees with transcript/room';
          audit.markerConflicts.push({ handId: t.hand_id, roomId: t.room_id, reason });
          setQuarantined(t.hand_id, t.room_id, reason);
          continue;
        }
        const status = existing.get(t.hand_id);
        if (status === 'committed') {
          audit.alreadyClassified++;
        } else {
          audit.committedFromMarker++;
          setCommitted(t.hand_id, t.room_id, null);
        }
        continue;
      }
      audit.markerless++;
      const status = existing.get(t.hand_id);
      if (status !== undefined && status !== 'legacy') {
        audit.alreadyClassified++;
        continue;
      }
      const verdict = reconcileTranscript(db, t);
      if (verdict.ok) {
        audit.reconciled++;
        setCommitted(t.hand_id, t.room_id, 'legacy reconciled');
      } else {
        audit.quarantined.push({ handId: t.hand_id, roomId: t.room_id, reason: verdict.reason });
        setQuarantined(t.hand_id, t.room_id, verdict.reason);
      }
    }
  };
  if (dryRun) work();
  else db.transaction(work).immediate();
  return audit;
}

/** Read-only operator diagnostic: what the reconciliation would decide, without
 *  changing the database. Used to size an upgrade before running it. */
export function auditMarkerlessTranscripts(db: DB): MarkerlessAudit {
  return reconcileMissingSettlements(db, { dryRun: true });
}

/** The oldest hand in `roomId` dealt but never reaching a terminal lifecycle
 *  state (`running` / `prepared` / `quarantined`). Null when the room is safe
 *  to deal. This is the authoritative startup/deal-time guard. */
export function firstPendingHandLifecycle(db: DB, roomId: string): string | null {
  const row = db
    .prepare(
      `SELECT hand_id AS handId FROM hand_lifecycle
        WHERE room_id = ? AND status IN ('running','prepared','quarantined')
        ORDER BY created_at, rowid LIMIT 1`,
    )
    .get(roomId) as { handId: string } | undefined;
  return row?.handId ?? null;
}
