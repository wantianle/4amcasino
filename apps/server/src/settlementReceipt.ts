/**
 * Pure read-side settlement receipt / recovery helpers. Extracted mechanically
 * from `game.ts` (P1-5) - no semantic change. Reads only the DB and the sealed
 * transcript; it never depends on `GameRoom` or `Hand`.
 */
import { computeHead, type TranscriptEntry } from '@4am/mental-poker';
import type { ServerMsg } from '@4am/shared';
import type { DB } from './db.js';
import type { HandSettlementOutcome, HandSettlementWrite, UserDelta } from './gameTypes.js';

/** Strictly parse `hand_settlements.final_stacks`. Returns null on any
 *  deviation: malformed entry, non-integer/duplicate user, non-integer or
 *  negative stack. Recovery never substitutes a fabricated 0. */
function parseFinalStacksStrict(raw: unknown): { userId: number; stack: number }[] | null {
  if (!Array.isArray(raw)) return null;
  const out: { userId: number; stack: number }[] = [];
  const seen = new Set<number>();
  for (const f of raw as unknown[]) {
    if (!f || typeof f !== 'object') return null;
    const { userId, stack } = f as { userId?: unknown; stack?: unknown };
    if (typeof userId !== 'number' || !Number.isSafeInteger(userId)) return null;
    if (typeof stack !== 'number' || !Number.isSafeInteger(stack) || stack < 0) return null;
    if (seen.has(userId)) return null;
    seen.add(userId);
    out.push({ userId, stack });
  }
  return out;
}

function sumDeltaMap(rows: readonly UserDelta[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const r of rows) m.set(r.userId, (m.get(r.userId) ?? 0) + r.delta);
  return m;
}

function deltaMapsEqual(a: Map<number, number>, b: Map<number, number>): boolean {
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) if ((a.get(k) ?? 0) !== (b.get(k) ?? 0)) return false;
  return true;
}

/**
 * Sum the committed settlement-family ledger legs into per-user game deltas.
 * The poker/squid legs are keyed by the sealed `head`; the automatic bounty by
 * the hand id (a voluntarily-shown 7-2 after the hand uses a different kind and
 * is deliberately excluded). */
function ledgerGameDeltas(db: DB, roomId: string, head: string, handId: string): UserDelta[] {
  const rows = db
    .prepare(
      `SELECT user_id, SUM(delta) AS delta FROM ledger
        WHERE room_id = ? AND (
          (kind IN ('hand-settlement','squid-game') AND ref = ?)
          OR (kind = 'seven-deuce' AND ref = ?)
        ) GROUP BY user_id`,
    )
    .all(roomId, head, handId) as { user_id: number; delta: number }[];
  return rows.map((r) => ({ userId: r.user_id, delta: r.delta })).filter((d) => d.delta !== 0);
}

function ledgerCommissionDeltas(db: DB, roomId: string, head: string): UserDelta[] {
  const rows = db
    .prepare(
      `SELECT user_id, SUM(delta) AS delta FROM ledger
        WHERE room_id = ? AND kind = 'commission' AND ref = ? GROUP BY user_id`,
    )
    .all(roomId, head) as { user_id: number; delta: number }[];
  return rows.map((r) => ({ userId: r.user_id, delta: r.delta })).filter((d) => d.delta !== 0);
}

function ledgerSevenDeuce(db: DB, roomId: string, handId: string): UserDelta[] {
  const rows = db
    .prepare(
      `SELECT user_id, delta FROM ledger
        WHERE room_id = ? AND kind = 'seven-deuce' AND ref = ?`,
    )
    .all(roomId, handId) as { user_id: number; delta: number }[];
  return rows.map((r) => ({ userId: r.user_id, delta: r.delta }));
}

/**
 * Locate the single payload of `type` in a sealed transcript entry list.
 *
 * A durable transcript carries exactly one `hand_start` and one `settlement`.
 * Zero (missing) or duplicate occurrences are structural corruption: returning
 * the first match would let a corrupt transcript silently pick one of two
 * contradictory records, so this throws instead.
 */
function transcriptPayloadOf(
  entries: unknown[],
  type: string,
  handId: string,
): Record<string, unknown> {
  let found: Record<string, unknown> | null = null;
  for (const e of entries as { type?: unknown; payload?: unknown }[]) {
    if (e && typeof e === 'object' && e.type === type) {
      if (found !== null)
        throw new Error(
          `settlement identity conflict on hand ${handId}: duplicate ${type} entry`,
        );
      if (!e.payload || typeof e.payload !== 'object')
        throw new Error(
          `settlement identity conflict on hand ${handId}: malformed ${type} entry`,
        );
      found = e.payload as Record<string, unknown>;
    }
  }
  if (found === null)
    throw new Error(`settlement identity conflict on hand ${handId}: missing ${type} entry`);
  return found;
}

/**
 * Load and strictly validate the committed receipt for a hand whose marker
 * already exists.
 *
 * Sources: `hand_settlements` (identity + `final_stacks`), the sealed
 * transcript (head + seat map + seat-projected legs) and the ledger (the money
 * legs). It NEVER derives historical final stacks from the CURRENT
 * `room_players` balances: those may have moved on through a mid-hand buy, a
 * peek or the next hand. Any structural deviation or identity conflict throws,
 * so a `same handId, different hand` replay can never masquerade as a harmless
 * duplicate.
 */
export function loadSettledReceipt(db: DB, w: HandSettlementWrite): HandSettlementOutcome {
  const marker = db
    .prepare(
      'SELECT hand_id, room_id, head, rake, final_stacks FROM hand_settlements WHERE hand_id = ?',
    )
    .get(w.handId) as
    | { hand_id: string; room_id: string; head: string; rake: number; final_stacks: string }
    | undefined;
  if (!marker) throw new Error(`duplicate settlement has no marker on hand ${w.handId}`);
  if (marker.room_id !== w.roomId)
    throw new Error(
      `settlement identity conflict on hand ${w.handId}: room ${marker.room_id} != ${w.roomId}`,
    );
  if (marker.head !== w.head)
    throw new Error(
      `settlement identity conflict on hand ${w.handId}: head ${marker.head} != ${w.head}`,
    );
  if (!Number.isSafeInteger(marker.rake) || marker.rake < 0 || marker.rake !== w.rake)
    throw new Error(
      `settlement identity conflict on hand ${w.handId}: rake ${marker.rake} != ${w.rake}`,
    );

  let rawFinal: unknown;
  try {
    rawFinal = JSON.parse(marker.final_stacks);
  } catch {
    throw new Error(`duplicate settlement has unreadable final_stacks on hand ${w.handId}`);
  }
  const finalStacks = parseFinalStacksStrict(rawFinal);
  if (!finalStacks)
    throw new Error(`duplicate settlement has malformed final_stacks on hand ${w.handId}`);

  const t = db
    .prepare('SELECT head, entries FROM transcripts WHERE hand_id = ? AND room_id = ?')
    .get(w.handId, w.roomId) as { head: string; entries: string } | undefined;

  // The transcript is the sealed record. A PRODUCTION duplicate (a retry of a
  // marker written by `GameRoom`) must have one: the transcript is inserted in
  // the SAME transaction as the marker, so a marker without a transcript is
  // corruption. Only an explicit aux/test write (`transcriptlessReceipt`, never
  // set by GameRoom) may proceed without one.
  const seatUser = new Map<number, number>();
  let transcriptGame: UserDelta[] | null = null;
  let transcriptCommission: UserDelta[] | null = null;
  if (!w.transcriptlessReceipt) {
    if (!t)
      throw new Error(`duplicate settlement has no transcript on hand ${w.handId}`);
    if (t.head !== w.head)
      throw new Error(
        `settlement identity conflict on hand ${w.handId}: transcript head ${t.head} != ${w.head}`,
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(t.entries);
    } catch {
      throw new Error(`duplicate settlement has unreadable transcript on hand ${w.handId}`);
    }
    if (!Array.isArray(parsed))
      throw new Error(
        `settlement identity conflict on hand ${w.handId}: transcript is not an entry list`,
      );
    // Replay the hash chain: `head` is the commitment. Comparing against the
    // mutable `head` column alone would trust a value a corrupt row could
    // rewrite in place without touching the entries.
    if (computeHead(parsed as TranscriptEntry[]) !== t.head)
      throw new Error(
        `settlement identity conflict on hand ${w.handId}: transcript head does not match its entry chain`,
      );
    // Exactly one hand_start and one settlement (duplicates throw), and the
    // seat list must be present and non-empty: a corrupt/empty one must never
    // shrink the participant set to the candidate write's seats.
    const start = transcriptPayloadOf(parsed, 'hand_start', w.handId);
    const settle = transcriptPayloadOf(parsed, 'settlement', w.handId);
    if (!Array.isArray(start.seats) || start.seats.length === 0)
      throw new Error(
        `settlement identity conflict on hand ${w.handId}: hand_start seats missing or empty`,
      );
    const seats = new Set<number>();
    const users = new Set<number>();
    for (const s of start.seats as unknown[]) {
      if (!s || typeof s !== 'object')
        throw new Error(
          `settlement identity conflict on hand ${w.handId}: malformed hand_start seat`,
        );
      const { seat, userId } = s as { seat?: unknown; userId?: unknown };
      if (typeof seat !== 'number' || !Number.isSafeInteger(seat))
        throw new Error(
          `settlement identity conflict on hand ${w.handId}: malformed hand_start seat`,
        );
      if (typeof userId !== 'number' || !Number.isSafeInteger(userId))
        throw new Error(
          `settlement identity conflict on hand ${w.handId}: malformed hand_start seat user`,
        );
      if (seats.has(seat) || users.has(userId))
        throw new Error(
          `settlement identity conflict on hand ${w.handId}: duplicate hand_start seat or user`,
        );
      seats.add(seat);
      users.add(userId);
      seatUser.set(seat, userId);
    }
    const toUsers = (seatDeltas: { seat: number; delta: number }[]): UserDelta[] =>
      seatDeltas.map((d) => {
        const userId = seatUser.get(d.seat);
        if (userId === undefined)
          throw new Error(
            `settlement identity conflict on hand ${w.handId}: transcript delta for unknown seat ${d.seat}`,
          );
        return { userId, delta: d.delta };
      });
    const td = parseSeatDeltas(settle.deltas);
    if (!td)
      throw new Error(
        `settlement identity conflict on hand ${w.handId}: transcript deltas are malformed`,
      );
    transcriptGame = toUsers(td);
    // The transcript only carries the SEAT-PROJECTED commission leg, so it is
    // absent (or empty) for an out-of-hand rake recipient. Treat a missing
    // field as "not projected" rather than an authoritative empty leg; the
    // ledger holds the account-level truth.
    if (settle.commissionDeltas !== undefined) {
      const tc = parseSeatDeltas(settle.commissionDeltas);
      if (!tc)
        throw new Error(
          `settlement identity conflict on hand ${w.handId}: transcript commission is malformed`,
        );
      transcriptCommission = toUsers(tc);
    }
  } else if (t && t.head !== w.head) {
    // The aux path does not require or project a transcript, but an identity
    // mismatch on one that happens to exist is still a conflict.
    throw new Error(
      `settlement identity conflict on hand ${w.handId}: transcript head ${t.head} != ${w.head}`,
    );
  }

  // Every participant must have a committed final stack. Participants come from
  // the sealed transcript when present, else (aux-only, no transcript) the
  // candidate write's own seats. Extra final_stacks rows beyond the participants
  // are tolerated ONLY as the out-of-hand rake account leg (it has a stack but
  // no seat); they are never treated as participants.
  const participants = seatUser.size
    ? [...new Set(seatUser.values())]
    : [...new Set(w.stackDeltas.map((d) => d.userId))];
  const finalByUser = new Set(finalStacks.map((f) => f.userId));
  for (const uid of participants)
    if (!finalByUser.has(uid))
      throw new Error(
        `duplicate settlement final_stacks missing participant ${uid} on hand ${w.handId}`,
      );

  const ledgerGame = ledgerGameDeltas(db, w.roomId, marker.head, w.handId);
  const gameDeltas = transcriptGame ?? ledgerGame;
  if (!deltaMapsEqual(sumDeltaMap(gameDeltas), sumDeltaMap(w.stackDeltas)))
    throw new Error(
      `settlement identity conflict on hand ${w.handId}: game deltas differ from the committed receipt`,
    );
  if (!deltaMapsEqual(sumDeltaMap(gameDeltas), sumDeltaMap(ledgerGame)))
    throw new Error(
      `settlement identity conflict on hand ${w.handId}: transcript and ledger disagree on game deltas`,
    );
  const gameSum = gameDeltas.reduce((s, d) => s + d.delta, 0);
  if (gameSum !== -marker.rake)
    throw new Error(
      `duplicate settlement game deltas do not net to -rake on hand ${w.handId}`,
    );

  // The ledger is the account-level authority: it credits the recipient even
  // when that account is not a hand seat. The transcript only carries the
  // seat-projected view, so it is cross-checked when present but never used as
  // the receipt's commission leg.
  const ledgerCommission = ledgerCommissionDeltas(db, w.roomId, marker.head);
  const commissionDeltas = ledgerCommission;
  const expectedCommission: UserDelta[] =
    w.rake > 0 && w.rakeRecipientId !== null
      ? [{ userId: w.rakeRecipientId, delta: w.rake }]
      : [];
  if (!deltaMapsEqual(sumDeltaMap(commissionDeltas), sumDeltaMap(expectedCommission)))
    throw new Error(
      `settlement identity conflict on hand ${w.handId}: commission differs from the committed receipt`,
    );
  if (transcriptCommission !== null) {
    const inHandUsers = new Set(seatUser.values());
    const seatFiltered = commissionDeltas.filter((c) => inHandUsers.has(c.userId));
    if (!deltaMapsEqual(sumDeltaMap(transcriptCommission), sumDeltaMap(seatFiltered)))
      throw new Error(
        `settlement identity conflict on hand ${w.handId}: transcript and ledger disagree on commission`,
      );
  }
  const commissionSum = commissionDeltas.reduce((s, d) => s + d.delta, 0);
  if (w.rakeRecipientId !== null && commissionSum !== marker.rake)
    throw new Error(`duplicate settlement commission does not equal rake on hand ${w.handId}`);

  // The automatic 7-2 decision is durable in the ledger. Reconstruct it rather
  // than trusting the candidate Hand's in-memory bounty.
  const sevenRows = ledgerSevenDeuce(db, w.roomId, w.handId);
  let sevenDeuce: { seat: number; amount: number } | null = null;
  if (sevenRows.length) {
    const positives = sevenRows.filter((r) => r.delta > 0);
    if (positives.length !== 1)
      throw new Error(
        `duplicate settlement seven-deuce decision is not a single winner on hand ${w.handId}`,
      );
    if (sevenRows.reduce((s, r) => s + r.delta, 0) !== 0)
      throw new Error(`duplicate settlement seven-deuce is not zero-sum on hand ${w.handId}`);
    const winner = positives[0]!;
    let seat: number | undefined;
    for (const [s, uid] of seatUser) if (uid === winner.userId) seat = s;
    if (seat === undefined && w.sevenDeuce && w.sevenDeuce.winnerUserId === winner.userId)
      seat = w.sevenDeuce.winnerSeat;
    if (seat === undefined)
      throw new Error(
        `duplicate settlement cannot resolve the 7-2 winner seat on hand ${w.handId}`,
      );
    if (
      !w.sevenDeuce ||
      w.sevenDeuce.winnerUserId !== winner.userId ||
      w.sevenDeuce.winnerAmount !== winner.delta
    )
      throw new Error(
        `settlement identity conflict on hand ${w.handId}: seven-deuce decision differs from the committed receipt`,
      );
    sevenDeuce = { seat, amount: winner.delta };
  } else if (w.sevenDeuce) {
    throw new Error(
      `settlement identity conflict on hand ${w.handId}: unexpected seven-deuce decision`,
    );
  }

  return {
    status: 'duplicate',
    roomId: marker.room_id,
    handId: marker.hand_id,
    head: marker.head,
    rake: marker.rake,
    timeBankSkipped: [],
    finalStacks,
    gameDeltas,
    sevenDeuce,
    commissionDeltas,
  };
}
/**
 * Strictly parse one persisted seat->delta leg (`settlement.deltas` or
 * `settlement.commissionDeltas`).
 *
 * Returns null on ANY structural deviation: a malformed entry, a non-integer
 * seat, a non-finite delta, or a duplicated seat. Recovery must never paper
 * over a corrupt leg with a partial array - the rebuilt `hand_end` would then
 * disagree with the durable settlement it claims to replay, which is worse than
 * admitting the payload cannot be rebuilt.
 */
function parseSeatDeltas(raw: unknown): { seat: number; delta: number }[] | null {
  if (!Array.isArray(raw)) return null;
  const out: { seat: number; delta: number }[] = [];
  const seen = new Set<number>();
  for (const d of raw as unknown[]) {
    if (!d || typeof d !== 'object') return null;
    const { seat, delta } = d as { seat?: unknown; delta?: unknown };
    if (typeof seat !== 'number' || !Number.isSafeInteger(seat)) return null;
    if (typeof delta !== 'number' || !Number.isFinite(delta)) return null;
    if (seen.has(seat)) return null;
    seen.add(seat);
    out.push({ seat, delta });
  }
  return out;
}

/**
 * Rebuild a `hand_end` frame for an already-committed hand from durable data.
 *
 * After a restart the in-memory terminal frame is gone, but the settlement is
 * fully persisted: the transcript holds the `hand_start` seat map and the
 * `settlement` entry (the exact combined/poker/commission deltas the live
 * `hand_end` carried), and the `hand_settlements` marker holds the sealed head,
 * rake and final stacks. Rebuilding from those gives a reconnecting client the
 * same terminal the live broadcast would have carried.
 *
 * This is STRICT and never falls back. A missing/corrupt field returns null
 * (the caller then emits a status-only `hand_recovery: committed`) rather than
 * fabricating money: the `final_stacks` marker must cover every participant
 * exactly once (no hand-start-stack/0 substitution), the marker's `head` and
 * `rake` must agree with the transcript, `sum(deltas) === -rake`, and the
 * commission legs must be structurally intact. A half-rebuilt terminal that
 * merely claims success would tell the client a different story than the
 * durable settlement. Also returns null when `userId` was not a seat - a recap
 * is never replayed to someone who was not in the hand.
 *
 * Only ever called for a lifecycle row already read as `committed`; a
 * transcript with a `settlement` entry but no marker (the write rolled back)
 * must NOT be projected as a success.
 */
export function recoverHandEnd(
  db: DB,
  roomId: string,
  handId: string,
  userId: number,
): Extract<ServerMsg, { t: 'hand_end' }> | null {
  const t = db
    .prepare('SELECT head, entries FROM transcripts WHERE hand_id = ? AND room_id = ?')
    .get(handId, roomId) as { head: string; entries: string } | undefined;
  if (!t) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(t.entries);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  // Replay the hash chain: the `head` column alone is not trustworthy, and the
  // rebuilt terminal must be anchored to the sealed chain, not a rewrite.
  if (computeHead(parsed as TranscriptEntry[]) !== t.head) return null;
  const payloadOf = (type: string): Record<string, unknown> | null => {
    let found: Record<string, unknown> | null = null;
    for (const e of parsed as { type?: unknown; payload?: unknown }[]) {
      if (e && typeof e === 'object' && e.type === type) {
        // A duplicate hand_start/settlement is corruption: never pick the first.
        if (found !== null) return null;
        if (!e.payload || typeof e.payload !== 'object') return null;
        found = e.payload as Record<string, unknown>;
      }
    }
    return found;
  };
  const start = payloadOf('hand_start');
  const settle = payloadOf('settlement');
  if (!start || !settle || !Array.isArray(start.seats)) return null;
  // Parse the seat map strictly. A malformed or duplicated seat means the hand's
  // participant set is unknown, so no terminal can be reconstructed for it.
  const seatRows: { seat: number; userId: number }[] = [];
  const handSeats = new Set<number>();
  const seatUsers = new Set<number>();
  for (const s of start.seats as unknown[]) {
    if (!s || typeof s !== 'object') return null;
    const { seat, userId: uid } = s as { seat?: unknown; userId?: unknown };
    if (typeof seat !== 'number' || !Number.isSafeInteger(seat)) return null;
    if (typeof uid !== 'number' || !Number.isSafeInteger(uid)) return null;
    if (handSeats.has(seat) || seatUsers.has(uid)) return null;
    handSeats.add(seat);
    seatUsers.add(uid);
    seatRows.push({ seat, userId: uid });
  }
  if (seatRows.length === 0) return null;
  if (!seatUsers.has(userId)) return null;
  const marker = db
    .prepare(
      'SELECT head, rake, final_stacks FROM hand_settlements WHERE hand_id = ? AND room_id = ?',
    )
    .get(handId, roomId) as { head: string; rake: number; final_stacks: string } | undefined;
  if (!marker) return null;
  // The marker must vouch for THIS transcript chain, and its rake must be a
  // sane value before it can anchor the money legs.
  if (marker.head !== t.head) return null;
  if (!Number.isSafeInteger(marker.rake) || marker.rake < 0) return null;

  // `final_stacks` is the authoritative post-settlement stack per participant.
  // It must parse and cover EVERY participant exactly once; there is deliberately
  // no fallback to the deal-time stack, which would fabricate a chip movement
  // that may never have happened.
  let rawFinal: unknown;
  try {
    rawFinal = JSON.parse(marker.final_stacks);
  } catch {
    return null;
  }
  if (!Array.isArray(rawFinal)) return null;
  const finalByUser = new Map<number, number>();
  for (const f of rawFinal as unknown[]) {
    if (!f || typeof f !== 'object') return null;
    const { userId: uid, stack } = f as { userId?: unknown; stack?: unknown };
    if (typeof uid !== 'number' || !Number.isSafeInteger(uid)) return null;
    if (typeof stack !== 'number' || !Number.isSafeInteger(stack) || stack < 0) return null;
    if (finalByUser.has(uid)) return null; // duplicate participant row
    finalByUser.set(uid, stack);
  }
  for (const s of seatRows) {
    if (!finalByUser.has(s.userId)) return null; // participant without a final stack
  }

  // The game leg must be structurally intact and cover exactly the hand seats.
  // The documented contract `sum(deltas) === -rake` then pins it to the marker;
  // a mismatch means transcript and marker disagree, so rebuilding would lie.
  const deltas = parseSeatDeltas(settle.deltas);
  if (!deltas) return null;
  if (deltas.length !== seatRows.length) return null;
  for (const d of deltas) if (!handSeats.has(d.seat)) return null;
  if (deltas.reduce((sum, d) => sum + d.delta, 0) !== -marker.rake) return null;

  // The commission leg is seat-filtered: at most one entry, exactly the rake,
  // only for a hand seat, and absent iff the rake is zero. (A rake recipient
  // that is out of hand has no seat entry at all - the credit lives on the
  // external account's ledger row - so an empty leg is valid even when rake > 0.)
  const commissionDeltas = parseSeatDeltas(settle.commissionDeltas);
  if (!commissionDeltas) return null;
  if (commissionDeltas.length > 1) return null;
  for (const c of commissionDeltas) {
    if (c.delta !== marker.rake || !handSeats.has(c.seat)) return null;
  }
  if (marker.rake === 0 && commissionDeltas.length !== 0) return null;
  // The transcript's `commission` is only written when rake > 0; when present it
  // must equal the marker exactly. Never default a missing leg to 0.
  const commission = settle.commission;
  if (marker.rake === 0) {
    if (commission !== undefined && commission !== 0) return null;
  } else if (commission !== marker.rake) {
    return null;
  }

  return {
    t: 'hand_end',
    handId,
    head: marker.head,
    stacks: seatRows.map((s) => ({ seat: s.seat, stack: finalByUser.get(s.userId)! })),
    deltas,
    commissionDeltas,
    commission: marker.rake,
    ...(typeof start.commissionBps === 'number' && Number.isSafeInteger(start.commissionBps)
      ? { commissionBps: start.commissionBps }
      : {}),
  };
}
