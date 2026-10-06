/**
 * Atomic settlement writer plus the P0-2 durable prepared-input persistence and
 * recovery path. Extracted mechanically from `game.ts` (P1-5) - no semantic
 * change: transaction boundaries, the canonical-input hash contract and every
 * fault-injection point are byte-for-byte the same. Depends on the DB, ledger,
 * rake and projection layers and the read-side receipt helpers; it never
 * depends on `Hand`.
 */
import { createHash } from 'node:crypto';
import { materializeHandProjection } from './handProjection.js';
import { appendLedger } from './ledger.js';
import { settleRake } from './rake.js';
import type { DB } from './db.js';
import {
  isTransientTransferError,
  type HandSettlementOutcome,
  type HandSettlementWrite,
  type SettlementPhaseHook,
} from './gameTypes.js';
import { loadSettledReceipt } from './settlementReceipt.js';

/**
 * Apply one hand's settlement atomically, exactly once.
 *
 * Idempotency: a durable `hand_settlements` row is inserted first (same
 * transaction); if it already exists the call is a no-op and reports
 * `duplicate`. Conservation: after applying the deltas the writer re-reads the
 * rows, rejects any negative stack, and asserts
 * `sum(finalStacks) + rake === sum(stacksBefore)`. Any violation throws and the
 * whole transaction (including the marker) rolls back, so a corrupted settle
 * can never be half-applied.
 */
export function applyHandSettlement(
  db: DB,
  w: HandSettlementWrite,
  /** Test-only: called at each transaction boundary; a throw rolls back. */
  phase?: SettlementPhaseHook,
): HandSettlementOutcome {
  if (!Number.isInteger(w.rake) || w.rake < 0)
    throw new Error(`invalid rake ${w.rake} on hand ${w.handId}`);
  const write = db.transaction((): HandSettlementOutcome => {
    const claim = db
      .prepare(
        `INSERT INTO hand_settlements (hand_id, room_id, head, rake, final_stacks, applied_at)
         VALUES (?, ?, ?, ?, '[]', ?)
         ON CONFLICT(hand_id) DO NOTHING`,
      )
      .run(w.handId, w.roomId, w.head, w.rake, w.now);
    if (claim.changes === 0) {
      // already settled by an earlier (committed) call - apply nothing, but
      // load and validate the FIRST submission's full receipt. The marker is
      // proof the whole hand committed, so reconcile the lifecycle to
      // `committed` too (a marker without a committed row can only come from
      // pre-lifecycle history or an operator-copied DB).
      db.prepare(
        `INSERT INTO hand_lifecycle (hand_id, room_id, status, created_at, updated_at, resolved_at)
         VALUES (?, ?, 'committed', ?, ?, ?)
         ON CONFLICT(hand_id) DO UPDATE SET status = 'committed',
           updated_at = excluded.updated_at, resolved_at = excluded.resolved_at`,
      ).run(w.handId, w.roomId, w.now, w.now, w.now);
      return loadSettledReceipt(db, w);
    }

    phase?.('settlement_after_marker');

    // A participant may not appear twice: stack deltas are applied additively,
    // so a duplicate user would silently double-move chips while the
    // conservation check sums only one row.
    const stackUsersSeen = new Set<number>();
    for (const d of w.stackDeltas) {
      if (!Number.isSafeInteger(d.delta))
        throw new Error(`invalid stack delta ${d.delta} on hand ${w.handId}`);
      if (stackUsersSeen.has(d.userId))
        throw new Error(`settlement has duplicate participant user ${d.userId} on hand ${w.handId}`);
      stackUsersSeen.add(d.userId);
    }
    const userIds = [...stackUsersSeen];
    const placeholders = userIds.map(() => '?').join(',');
    const stackRows = userIds.length
      ? (db
          .prepare(
            `SELECT user_id, stack FROM room_players WHERE room_id = ? AND user_id IN (${placeholders})`,
          )
          .all(w.roomId, ...userIds) as { user_id: number; stack: number }[])
      : [];
    const sumBefore = stackRows.reduce((s, r) => s + r.stack, 0);

    for (const d of w.stackDeltas) {
      if (d.delta === 0) continue;
      db.prepare('UPDATE room_players SET stack = stack + ? WHERE room_id = ? AND user_id = ?').run(
        d.delta,
        w.roomId,
        d.userId,
      );
    }

    const afterRows = userIds.length
      ? (db
          .prepare(
            `SELECT user_id, stack FROM room_players WHERE room_id = ? AND user_id IN (${placeholders})`,
          )
          .all(w.roomId, ...userIds) as { user_id: number; stack: number }[])
      : [];
    const finalByUser = new Map(afterRows.map((r) => [r.user_id, r.stack]));
    // A participant without a room_players row must fail the whole settlement:
    // settling against a fabricated 0 balance would silently corrupt money.
    for (const uid of userIds)
      if (!finalByUser.has(uid))
        throw new Error(
          `settlement missing participant row for user ${uid} on hand ${w.handId}`,
        );
    for (const d of w.stackDeltas) {
      const finalStack = finalByUser.get(d.userId) ?? 0;
      if (finalStack < 0)
        throw new Error(
          `settlement would drive user ${d.userId} negative (${finalStack}) on hand ${w.handId}`,
        );
    }
    const sumAfter = afterRows.reduce((s, r) => s + r.stack, 0);
    if (sumAfter + w.rake !== sumBefore)
      throw new Error(
        `settlement not conserving on hand ${w.handId}: before=${sumBefore} after=${sumAfter} rake=${w.rake}`,
      );

    phase?.('settlement_after_stack');

    for (const l of w.pokerLedger) {
      if (l.delta === 0) continue;
      appendLedger(db, {
        roomId: w.roomId,
        userId: l.userId,
        delta: l.delta,
        kind: 'hand-settlement',
        ref: w.head,
      });
    }
    phase?.('settlement_after_poker_ledger');
    for (const l of w.squidLedger) {
      if (l.delta === 0) continue;
      appendLedger(db, {
        roomId: w.roomId,
        userId: l.userId,
        delta: l.delta,
        kind: 'squid-game',
        ref: w.head,
        note: w.squidNote,
      });
    }
    phase?.('settlement_after_squid_ledger');
    if (w.rake > 0 && w.rakeRecipientId !== null) {
      settleRake(db, {
        roomId: w.roomId,
        recipientId: w.rakeRecipientId,
        rake: w.rake,
        ref: w.head,
        commissionBps: w.commissionBps,
      });
    }

    phase?.('settlement_after_commission');

    // Automatic showdown 7-2 bounty, in the SAME transaction. It is a zero-sum
    // transfer among the hand's seats, so it cannot break conservation; it is
    // applied after the pot/rake (matching the old post-settlement order) and
    // before `finalStacks` is read so `room_players.stack`,
    // `hand_settlements.final_stacks` and the stats projection all agree.
    let sevenDeuce: { seat: number; amount: number } | null = null;
    if (w.sevenDeuce && w.sevenDeuce.winnerAmount > 0) {
      // The stack movement already rode `stackDeltas` (the bounty is folded
      // into the combined deltas), so this only records the ledger legs.
      for (const payer of w.sevenDeuce.payerAmounts) {
        if (payer.amount <= 0) continue;
        appendLedger(db, {
          roomId: w.roomId,
          userId: payer.userId,
          delta: -payer.amount,
          kind: 'seven-deuce',
          ref: w.handId,
          note: 'paid the 7-2 offsuit bounty',
        });
      }
      appendLedger(db, {
        roomId: w.roomId,
        userId: w.sevenDeuce.winnerUserId,
        delta: w.sevenDeuce.winnerAmount,
        kind: 'seven-deuce',
        ref: w.handId,
        note: 'won with 7-2 offsuit',
      });
      sevenDeuce = { seat: w.sevenDeuce.winnerSeat, amount: w.sevenDeuce.winnerAmount };
    }

    phase?.('settlement_after_seven_deuce');

    // `afterRows` above is the pre-rake stack and is only used for the
    // conservation check. settleRake credits the rake recipient, which may be a
    // player in this hand, so re-read the TRUE final stacks after every money
    // move. The projection and hand_settlements.final_stacks must equal
    // room_players.stack (spec: ending_stack = post-settlement actual stack).
    const finalUserIds = [
      ...new Set([...userIds, ...(w.rakeRecipientId !== null ? [w.rakeRecipientId] : [])]),
    ];
    const finalPlaceholders = finalUserIds.map(() => '?').join(',');
    const resultStacks = finalUserIds.length
      ? (
          db
            .prepare(
              `SELECT user_id, stack FROM room_players WHERE room_id = ? AND user_id IN (${finalPlaceholders})`,
            )
            .all(w.roomId, ...finalUserIds) as { user_id: number; stack: number }[]
        ).map((r) => ({ userId: r.user_id, stack: r.stack }))
      : [];

    const timeBankSkipped: number[] = [];
    if (w.timeBankEpoch !== null) {
      for (const tb of w.timeBanks) {
        const row = db
          .prepare(
            'SELECT time_bank_epoch FROM room_players WHERE room_id = ? AND user_id = ?',
          )
          .get(w.roomId, tb.userId) as { time_bank_epoch: number } | undefined;
        if (!row || row.time_bank_epoch !== w.timeBankEpoch) {
          // a config change reset the bank mid-hand: do NOT overwrite the reset
          // with a stale snapshot, and report it so the caller can audit it
          timeBankSkipped.push(tb.userId);
          continue;
        }
        db.prepare(
          'UPDATE room_players SET time_bank_ms = ?, time_bank_hands = ?, time_bank_epoch = ? WHERE room_id = ? AND user_id = ? AND time_bank_epoch = ?',
        ).run(tb.ms, tb.hands, w.timeBankEpoch, w.roomId, tb.userId, w.timeBankEpoch);
      }
    }

    for (const id of w.triggerIds) {
      if (!id) continue;
      db.prepare(
        "UPDATE room_feature_triggers SET status = 'applied', resolved_at = ? WHERE id = ? AND status = 'claimed'",
      ).run(w.now, id);
    }

    db.prepare(
      'INSERT INTO transcripts (hand_id, room_id, head, entries, ts) VALUES (?, ?, ?, ?, ?)',
    ).run(w.handId, w.roomId, w.head, JSON.stringify(w.entries), w.now);

    phase?.('settlement_after_transcript');

    // Normalized stats projection, in the SAME transaction as the settlement.
    // A structurally impossible hand throws here and rolls the whole settlement
    // back (spec §2). Invariant: `applyHandSettlement` is only called for a hand
    // that actually started, so a real transcript is always present; the sole
    // tolerated no-op is an empty `entries` (test/aux callers with no
    // transcript) - any non-empty transcript must project or the hand rolls back.
    materializeHandProjection(db, {
      handId: w.handId,
      roomId: w.roomId,
      head: w.head,
      entries: w.entries,
      transcriptTs: w.now,
      now: w.now,
      // Live settlement is strict: malformed/mismatched transcripts roll back.
      strict: true,
      verifyHead: true,
      // The projection compares `net_delta` (= poker + squid) against these
      // poker deltas: the bounty is folded into the projection view so
      // `net_delta === ending_stack - starting_stack`.
      pokerLedger: w.projectionPokerLedger ?? w.pokerLedger,
      squidLedger: w.squidLedger,
      stackDeltas: w.stackDeltas,
      rake: w.rake,
      finalStacks: resultStacks,
    });

    phase?.('settlement_after_projection');

    const gs = db
      .prepare(
        `SELECT completed_hands, last_bomb_completed_hands, last_bomb_at, schedule_reset_at
         FROM room_gameplay_state WHERE room_id = ?`,
      )
      .get(w.roomId) as
      | {
          completed_hands: number;
          last_bomb_completed_hands: number;
          last_bomb_at: number | null;
          schedule_reset_at: number | null;
        }
      | undefined;
    const completed = (gs?.completed_hands ?? 0) + 1;
    const lastBombHands = w.bombRan ? completed : (gs?.last_bomb_completed_hands ?? 0);
    const lastBombAt = w.bombRan ? w.now : (gs?.last_bomb_at ?? null);
    db.prepare(
      `INSERT INTO room_gameplay_state
         (room_id, completed_hands, last_bomb_completed_hands, last_bomb_at, schedule_reset_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(room_id) DO UPDATE SET
         completed_hands = excluded.completed_hands,
         last_bomb_completed_hands = excluded.last_bomb_completed_hands,
         last_bomb_at = excluded.last_bomb_at,
         schedule_reset_at = excluded.schedule_reset_at`,
    ).run(w.roomId, completed, lastBombHands, lastBombAt, gs?.schedule_reset_at ?? null);

    phase?.('settlement_after_gameplay_state');

    const finalStacks = resultStacks;
    db.prepare('UPDATE hand_settlements SET final_stacks = ? WHERE hand_id = ?').run(
      JSON.stringify(finalStacks),
      w.handId,
    );
    phase?.('settlement_after_final_stacks');
    // Mark the durable lifecycle terminal in the SAME transaction. A crash
    // after this commit leaves a `committed` row and the marker; a rollback
    // leaves the `running` row written at deal time, which is exactly what the
    // restart scan needs to see.
    db.prepare(
      `INSERT INTO hand_lifecycle (hand_id, room_id, status, created_at, updated_at, resolved_at)
       VALUES (?, ?, 'committed', ?, ?, ?)
       ON CONFLICT(hand_id) DO UPDATE SET status = 'committed',
         updated_at = excluded.updated_at, resolved_at = excluded.resolved_at`,
    ).run(w.handId, w.roomId, w.now, w.now, w.now);
    phase?.('settlement_after_lifecycle');
    // The explicit commission recipient leg. `stackDeltas` is the game leg
    // (poker + squid + bounty); this leg is the rake credit. Consumers must add
    // the two to reconcile a seat's stack change; neither alone is the whole
    // story when the recipient is in the hand.
    const commissionDeltas =
      w.rake > 0 && w.rakeRecipientId !== null
        ? [{ userId: w.rakeRecipientId, delta: w.rake }]
        : [];
    phase?.('settlement_before_commit');
    return {
      status: 'applied',
      roomId: w.roomId,
      handId: w.handId,
      head: w.head,
      rake: w.rake,
      timeBankSkipped,
      finalStacks,
      gameDeltas: w.stackDeltas.map((d) => ({ userId: d.userId, delta: d.delta })),
      sevenDeuce,
      commissionDeltas,
    };
  });
  return write();
}

// ---------------------------------------------------------------------------
// P0-2 durable prepared settlement input
//
// The `Hand` freezes its whole settlement input (transcript + every money leg)
// into `hand_settlement_prepared` in its OWN committed transaction, then runs
// the money transaction from that DB row. A process crash between the two
// leaves a complete input a restarted server (or an operator) can settle
// without rebuilding anything from mutable room state - the current
// `room_players.stack` may have been moved by a mid-hand buy/peek/next action.
// ---------------------------------------------------------------------------

/** Canonical (key-order-stable) JSON for a frozen settlement input, so equal
 *  inputs hash equally regardless of object construction order.
 *
 *  NOTE the `undefined`-dropping rule below is only ever reached for the
 *  `entries` blob (whose own JSON round-trip also drops `undefined`); every
 *  optional top-level field is materialised to an explicit value by
 *  `normalizePreparedWrite` BEFORE this runs, so `{ sevenDeuce: undefined }` and
 *  `{ sevenDeuce: null }` both canonicalise to `"sevenDeuce":null`. That
 *  equivalence is intentional and safe: under `HandSettlementWrite` an absent
 *  optional means "use the default", which is exactly what explicit `null`/
 *  derived-default means. Normalising first makes the equivalence explicit and
 *  guarantees the frozen row always carries a complete structure. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Materialise every optional field to its explicit value so the frozen JSON is
 *  a complete `HandSettlementWrite` (see the `canonicalJson` note above). The
 *  derived defaults mirror what `applyHandSettlement` already does with an
 *  absent field, so normalisation never changes the settled numbers. */
function normalizePreparedWrite(w: HandSettlementWrite): HandSettlementWrite {
  return {
    ...w,
    projectionPokerLedger: w.projectionPokerLedger ?? w.pokerLedger,
    sevenDeuce: w.sevenDeuce ?? null,
    transcriptlessReceipt: w.transcriptlessReceipt ?? false,
  };
}

/** SHA-256 of a canonical prepared input, stored beside it and re-checked on
 *  every read so a tampered/truncated row fails closed. */
export function settlementInputHash(json: string): string {
  return createHash('sha256').update(json).digest('hex');
}

function isSafeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v);
}

/** Every `{userId,delta}` leg must be a well-formed safe-integer pair. */
function isUserDeltaArray(v: unknown): boolean {
  if (!Array.isArray(v)) return false;
  return v.every((d) => {
    if (!d || typeof d !== 'object') return false;
    const { userId, delta } = d as { userId?: unknown; delta?: unknown };
    return isSafeInt(userId) && isSafeInt(delta);
  });
}

/**
 * Full structural check of a frozen `HandSettlementWrite`. This is the
 * fail-closed boundary: a malformed frozen JSON (right hash, wrong shape) must
 * be classified as a `PreparedInputError` and quarantine the hand, never
 * escape as a plain `TypeError` that `onPersistFailed` would treat as a
 * retryable failure. Returns a quarantine reason, or null when the shape is
 * intact. The optional fields are accepted absent (legacy rows) because
 * `normalizePreparedWrite` supplies their defaults on read.
 */
function validateWriteShape(w: HandSettlementWrite): string | null {
  if (typeof w.handId !== 'string' || typeof w.roomId !== 'string' || typeof w.head !== 'string')
    return 'prepared input has a non-string identity field';
  if (!Array.isArray(w.entries)) return 'prepared input entries is not an array';
  if (!isSafeInt(w.rake) || w.rake < 0) return 'prepared input rake is invalid';
  if (typeof w.commissionBps !== 'number' || !Number.isFinite(w.commissionBps))
    return 'prepared input commissionBps is invalid';
  if (!isUserDeltaArray(w.stackDeltas)) return 'prepared input stackDeltas is malformed';
  if (!isUserDeltaArray(w.pokerLedger)) return 'prepared input pokerLedger is malformed';
  if (w.projectionPokerLedger !== undefined && !isUserDeltaArray(w.projectionPokerLedger))
    return 'prepared input projectionPokerLedger is malformed';
  if (!isUserDeltaArray(w.squidLedger)) return 'prepared input squidLedger is malformed';
  if (typeof w.squidNote !== 'string') return 'prepared input squidNote is invalid';
  if (!Array.isArray(w.timeBanks)) return 'prepared input timeBanks is not an array';
  for (const tb of w.timeBanks) {
    if (!tb || typeof tb !== 'object') return 'prepared input has a malformed time-bank entry';
    const { userId, ms, hands } = tb as { userId?: unknown; ms?: unknown; hands?: unknown };
    if (!isSafeInt(userId) || !isSafeInt(ms) || !isSafeInt(hands))
      return 'prepared input has a malformed time-bank entry';
  }
  if (w.timeBankEpoch !== null && !isSafeInt(w.timeBankEpoch))
    return 'prepared input timeBankEpoch is invalid';
  if (!Array.isArray(w.triggerIds) || !w.triggerIds.every((id) => id === null || isSafeInt(id)))
    return 'prepared input triggerIds is malformed';
  if (typeof w.bombRan !== 'boolean') return 'prepared input bombRan is invalid';
  if (w.rakeRecipientId !== null && !isSafeInt(w.rakeRecipientId))
    return 'prepared input rakeRecipientId is invalid';
  if (w.sevenDeuce !== undefined && w.sevenDeuce !== null) {
    const s = w.sevenDeuce;
    if (!isSafeInt(s.winnerUserId) || !isSafeInt(s.winnerSeat) || !isSafeInt(s.winnerAmount))
      return 'prepared input sevenDeuce is malformed';
    if (!Array.isArray(s.payerAmounts)) return 'prepared input sevenDeuce payerAmounts is missing';
    for (const p of s.payerAmounts) {
      if (!p || typeof p !== 'object') return 'prepared input sevenDeuce payerAmounts is malformed';
      const { userId, amount } = p as { userId?: unknown; amount?: unknown };
      if (!isSafeInt(userId) || !isSafeInt(amount))
        return 'prepared input sevenDeuce payerAmounts is malformed';
    }
  }
  if (w.transcriptlessReceipt !== undefined && typeof w.transcriptlessReceipt !== 'boolean')
    return 'prepared input transcriptlessReceipt is invalid';
  if (!isSafeInt(w.now)) return 'prepared input now is invalid';
  return null;
}

/** A prepared input that must NOT be silently applied (hash/identity/DB
 *  inconsistency). The hand is quarantined and the room stays frozen until an
 *  operator resolves it; callers must not retry it as if it were transient. */
export class PreparedInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreparedInputError';
  }
}

interface PreparedSettlementRow {
  hand_id: string;
  room_id: string;
  head: string;
  input_json: string;
  input_hash: string;
  prepared_at: number;
  attempts: number;
  last_error: string | null;
  resolved_at: number | null;
  resolved_by: number | null;
  resolution: string | null;
}

/** Fail closed: a hand whose frozen input cannot be trusted is quarantined, not
 *  aborted. `running`/`prepared`/`quarantined` all mean "money facts unknown";
 *  only an operator may resolve it. A hand that already committed/aborted is
 *  left alone (its history is settled). */
function quarantineHand(db: DB, handId: string, reason: string, now = Date.now()): void {
  db.transaction(() => {
    db.prepare(
      `UPDATE hand_lifecycle SET status = 'quarantined', updated_at = ?, resolved_at = NULL, last_error = ?
        WHERE hand_id = ? AND status IN ('running','prepared','quarantined')`,
    ).run(now, reason, handId);
    db.prepare('UPDATE hand_settlement_prepared SET last_error = ? WHERE hand_id = ?').run(
      reason,
      handId,
    );
  }).immediate();
}

/** Freeze a hand's whole settlement input in its OWN committed transaction and
 *  move `hand_lifecycle` running -> prepared. Idempotent for the in-process
 *  retry path: a second call must carry the identical input (the sealed write
 *  is frozen in memory), and a differing input is corruption that quarantines
 *  the hand rather than silently settling the wrong numbers. */
export function persistPreparedInput(
  db: DB,
  w: HandSettlementWrite,
): { hash: string; inserted: boolean } {
  const json = canonicalJson(normalizePreparedWrite(w));
  const hash = settlementInputHash(json);
  const now = Date.now();
  const work = db.transaction((): { hash: string; inserted: boolean } | { conflict: string } => {
    const existing = db
      .prepare('SELECT input_hash FROM hand_settlement_prepared WHERE hand_id = ?')
      .get(w.handId) as { input_hash: string } | undefined;
    if (existing) {
      if (existing.input_hash !== hash)
        return { conflict: `prepared settlement input changed for hand ${w.handId}` };
      return { hash, inserted: false };
    }
    const lc = db
      .prepare(
        `UPDATE hand_lifecycle SET status = 'prepared', updated_at = ?, last_error = NULL
          WHERE hand_id = ? AND room_id = ? AND status IN ('running','prepared')`,
      )
      .run(now, w.handId, w.roomId);
    if (lc.changes === 0) {
      const row = db.prepare('SELECT status FROM hand_lifecycle WHERE hand_id = ?').get(w.handId) as
        | { status: string }
        | undefined;
      // Already fully settled: nothing to prepare (the caller will see the
      // marker and report a duplicate).
      if (row?.status === 'committed') return { hash, inserted: false };
      return {
        conflict: `cannot prepare hand ${w.handId}: lifecycle is ${row?.status ?? 'missing'}`,
      };
    }
    db.prepare(
      `INSERT INTO hand_settlement_prepared
         (hand_id, room_id, head, input_json, input_hash, prepared_at, attempts, last_error, resolved_at, resolved_by, resolution)
       VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL)`,
    ).run(w.handId, w.roomId, w.head, json, hash, now);
    return { hash, inserted: true };
  });
  const result = work.immediate();
  if ('conflict' in result) {
    quarantineHand(db, w.handId, result.conflict, now);
    throw new PreparedInputError(result.conflict);
  }
  return result;
}

/** Parse + identity-check + hash-check + full structural-check a prepared row.
 *  Returns a quarantine reason instead of throwing so the caller can persist it.
 *  The check is deliberately exhaustive: a hash-correct but structurally wrong
 *  JSON must quarantine, never throw a bare `TypeError` into the transient
 *  retry path. */
function parsePreparedWrite(
  row: PreparedSettlementRow,
): { write: HandSettlementWrite } | { reason: string } {
  if (settlementInputHash(row.input_json) !== row.input_hash)
    return { reason: `prepared input hash mismatch on hand ${row.hand_id}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.input_json);
  } catch {
    return { reason: `prepared input is not valid JSON on hand ${row.hand_id}` };
  }
  if (!parsed || typeof parsed !== 'object')
    return { reason: `prepared input is not an object on hand ${row.hand_id}` };
  const w = parsed as HandSettlementWrite;
  if (w.handId !== row.hand_id)
    return { reason: `prepared input hand_id ${String(w.handId)} != ${row.hand_id}` };
  if (w.roomId !== row.room_id)
    return { reason: `prepared input room_id ${String(w.roomId)} != ${row.room_id}` };
  if (w.head !== row.head)
    return { reason: `prepared input head ${String(w.head)} != ${row.head}` };
  const shape = validateWriteShape(w);
  if (shape) return { reason: `${shape} on hand ${row.hand_id}` };
  return { write: normalizePreparedWrite(w) };
}

/** Cross-check a frozen input against current durable state. Any mismatch means
 *  the room moved under a hand whose money was already frozen, so a blind
 *  apply would corrupt accounting/counters. Returns a quarantine reason or
 *  null when the input is safe to apply. */
function validatePreparedAgainstDb(db: DB, w: HandSettlementWrite): string | null {
  // A `hand_settlements` marker means this hand already COMMITTED, and the
  // marker is the authority that the money moved exactly once. Every check
  // below validates the live state a *pending* apply needs (participant rows,
  // feature-trigger ownership, transcript head); a room that legitimately moved
  // on after commit must never turn a harmless duplicate retry into a
  // quarantine, so the marker short-circuits them. The one thing still worth
  // checking is that the marker describes the SAME hand/room/head/rake - a
  // marker for a different settlement is corruption and stays fail-closed. A
  // consistent marker returns null and `applyHandSettlement` loads the full
  // validated receipt via `loadSettledReceipt` (identical identity semantics).
  const marker = db
    .prepare('SELECT room_id, head, rake FROM hand_settlements WHERE hand_id = ?')
    .get(w.handId) as { room_id: string; head: string; rake: number } | undefined;
  if (marker) {
    if (marker.room_id !== w.roomId)
      return `settlement identity conflict on hand ${w.handId}: room ${marker.room_id} != ${w.roomId}`;
    if (marker.head !== w.head)
      return `settlement identity conflict on hand ${w.handId}: head ${marker.head} != ${w.head}`;
    if (!Number.isSafeInteger(marker.rake) || marker.rake < 0 || marker.rake !== w.rake)
      return `settlement identity conflict on hand ${w.handId}: rake ${marker.rake} != ${w.rake}`;
    return null;
  }

  // A transcript can only exist for a hand whose settlement already committed;
  // if one exists, it must describe the same sealed head.
  const t = db.prepare('SELECT head FROM transcripts WHERE hand_id = ?').get(w.handId) as
    | { head: string }
    | undefined;
  if (t && t.head !== w.head)
    return `transcript head disagrees with prepared input on hand ${w.handId}`;

  // Every participant the input moves chips for must still hold a room row.
  // A vanished row is a mid-hand change we must not guess about: settling would
  // fabricate a zero balance.
  const seen = new Set<number>();
  for (const d of w.stackDeltas) {
    if (seen.has(d.userId)) return `prepared input has duplicate participant ${d.userId}`;
    seen.add(d.userId);
    const rp = db
      .prepare('SELECT 1 FROM room_players WHERE room_id = ? AND user_id = ?')
      .get(w.roomId, d.userId);
    if (!rp)
      return `prepared participant ${d.userId} has no room_players row on hand ${w.handId}`;
  }

  // A feature trigger the hand claimed must still be owned by it. If another
  // hand has re-claimed it, applying this settlement would mis-account the
  // trigger that other hand now owns.
  for (const id of w.triggerIds) {
    if (!id) continue;
    const tr = db
      .prepare('SELECT status, claimed_hand_id FROM room_feature_triggers WHERE id = ?')
      .get(id) as { status: string; claimed_hand_id: string | null } | undefined;
    if (!tr || tr.status !== 'claimed' || tr.claimed_hand_id !== w.handId)
      return `feature trigger ${id} is not still claimed by hand ${w.handId}`;
  }

  // No marker exists here (a present one returned above), but ledger legs for
  // this hand already do: a partially applied settlement. Never layer a full
  // settlement over it.
  const partial = db
    .prepare(
      `SELECT 1 FROM ledger WHERE room_id = ? AND (ref = ? OR (kind = 'seven-deuce' AND ref = ?)) LIMIT 1`,
    )
    .get(w.roomId, w.head, w.handId);
  if (partial) return `ledger has entries for hand ${w.handId} but no settlement marker`;
  return null;
}

export interface ApplyPreparedResult {
  status: 'applied' | 'duplicate';
  outcome: HandSettlementOutcome;
}

/**
 * Reconstruct and apply a hand's settlement purely from its durable prepared
 * input - never from a live `GameRoom` or current room state.
 *
 * Every identity/hash/DB mismatch quarantines the hand (fail closed) and
 * throws `PreparedInputError`. A transient DB failure (lock/interrupt) is
 * rethrown so the caller may retry it. On success the prepared row is marked
 * resolved IN THE SAME transaction as the money move, so the frozen input and
 * its disposition can never disagree.
 */
export function applyPreparedHandSettlement(
  db: DB,
  handId: string,
  opts: {
    resolvedBy?: number | null;
    resolution?: string;
    /** Test-only fault hook, forwarded to the money transaction. */
    phase?: SettlementPhaseHook;
  } = {},
): ApplyPreparedResult {
  const row = db
    .prepare('SELECT * FROM hand_settlement_prepared WHERE hand_id = ?')
    .get(handId) as PreparedSettlementRow | undefined;
  if (!row) throw new PreparedInputError(`no prepared settlement input for hand ${handId}`);

  const lifecycle = db
    .prepare('SELECT status FROM hand_lifecycle WHERE hand_id = ?')
    .get(handId) as { status: string } | undefined;
  if (lifecycle?.status === 'aborted')
    throw new PreparedInputError(`hand ${handId} is aborted; settlement refused`);
  // A quarantined hand has a proven-bad frozen input: the only way out is an
  // explicit operator abort, never a re-apply. Refuse here (mirroring the HTTP
  // operator-retry route and `retrySettlement`) so a direct caller cannot settle
  // it, and classify as `PreparedInputError` so the transient retry machinery
  // does NOT treat it as auto-retryable.
  if (lifecycle?.status === 'quarantined')
    throw new PreparedInputError(
      `hand ${handId} is quarantined; settlement refused pending operator review`,
    );

  db.prepare('UPDATE hand_settlement_prepared SET attempts = attempts + 1 WHERE hand_id = ?').run(
    handId,
  );

  const parsed = parsePreparedWrite(row);
  if ('reason' in parsed) {
    quarantineHand(db, handId, parsed.reason);
    throw new PreparedInputError(parsed.reason);
  }
  const w = parsed.write;
  // `validatePreparedAgainstDb` iterates the frozen structure, so a shape
  // deviation it did not expect would surface here as a plain TypeError. Wrap
  // it so ANY validation error is still classified fail-closed (quarantine),
  // never a recoverable transient failure.
  let dbReason: string | null;
  try {
    dbReason = validatePreparedAgainstDb(db, w);
  } catch (err) {
    dbReason = `prepared input validation error: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (dbReason) {
    quarantineHand(db, handId, dbReason);
    throw new PreparedInputError(dbReason);
  }

  try {
    opts.phase?.('settlement_before_transaction');
    const outcome = db.transaction((): HandSettlementOutcome => {
      const o = applyHandSettlement(db, w, opts.phase);
      db.prepare(
        `UPDATE hand_settlement_prepared
           SET resolved_at = ?, resolved_by = ?, resolution = ?, last_error = NULL
         WHERE hand_id = ?`,
      ).run(Date.now(), opts.resolvedBy ?? null, opts.resolution ?? 'settlement', handId);
      return o;
    })();
    return { status: outcome.status, outcome };
  } catch (err) {
    if (isTransientTransferError(err)) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (!(err instanceof PreparedInputError)) quarantineHand(db, handId, message);
    throw new PreparedInputError(message);
  }
}

export interface OperatorAbortResult {
  status: 'aborted' | 'already_aborted';
  /** The failure evidence recorded before the abort (`hand_lifecycle.last_error`),
   *  preserved so the HTTP layer can copy it into the admin audit trail after
   *  the lifecycle row has been overwritten. */
  lastError?: string | null;
}

/**
 * Operator abort of a hand that was dealt but never settled, using only durable
 * data. A `running` hand has no frozen input (crash before prepare); a
 * `prepared` hand has one but must not be guessed into a settlement; a
 * `quarantined` hand has a proven-bad frozen input that can NEVER be applied, so
 * abort is its only exit. None moves chips/ledger/transcript, so the operator
 * marks the hand `aborted` explicitly and releases the feature triggers it still
 * claims, letting the room deal again.
 *
 * The original `last_error` is deliberately preserved (COALESCE, not an
 * overwrite) so the failure evidence survives the resolution.
 */
export function abortPendingHandSettlement(
  db: DB,
  handId: string,
  opts: { resolvedBy?: number | null } = {},
): OperatorAbortResult {
  const row = db
    .prepare('SELECT status, last_error FROM hand_lifecycle WHERE hand_id = ?')
    .get(handId) as { status: string; last_error: string | null } | undefined;
  if (!row) throw new PreparedInputError(`unknown hand ${handId}`);
  if (row.status === 'aborted') return { status: 'already_aborted', lastError: row.last_error };
  if (row.status !== 'running' && row.status !== 'prepared' && row.status !== 'quarantined')
    throw new PreparedInputError(
      `hand ${handId} is ${row.status}; only running/prepared/quarantined can be aborted`,
    );
  const now = Date.now();
  return db.transaction((): OperatorAbortResult => {
    db.prepare(
      `UPDATE hand_lifecycle
          SET status = 'aborted', updated_at = ?, resolved_at = ?,
              last_error = COALESCE(last_error, 'operator abort')
        WHERE hand_id = ? AND status IN ('running','prepared','quarantined')`,
    ).run(now, now, handId);
    const triggers = db
      .prepare(
        "SELECT id, source FROM room_feature_triggers WHERE claimed_hand_id = ? AND status = 'claimed'",
      )
      .all(handId) as { id: number; source: string }[];
    for (const t of triggers) {
      if (t.source === 'manual')
        db.prepare(
          "UPDATE room_feature_triggers SET status = 'pending', claimed_hand_id = NULL, resolved_at = NULL WHERE id = ? AND status = 'claimed'",
        ).run(t.id);
      else
        db.prepare(
          "UPDATE room_feature_triggers SET status = 'cancelled', resolved_at = ? WHERE id = ? AND status = 'claimed'",
        ).run(now, t.id);
    }
    db.prepare(
      `UPDATE hand_settlement_prepared SET resolved_at = ?, resolved_by = ?, resolution = ?
        WHERE hand_id = ?`,
    ).run(
      now,
      opts.resolvedBy ?? null,
      row.status === 'quarantined' ? 'aborted_quarantined' : 'aborted',
      handId,
    );
    return { status: 'aborted', lastError: row.last_error };
  }).immediate();
}
