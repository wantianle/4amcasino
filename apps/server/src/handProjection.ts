import { computeHead, type TranscriptEntry } from '@4am/mental-poker';
import type { DB } from './db.js';

/**
 * Normalized projection of a hand into `hands` / `hand_players` / `hand_actions`.
 *
 * `transcripts` stays the immutable audit source; these tables are a derived,
 * queryable projection used by the stats layer. The projection is written in the
 * SAME SQLite transaction as `applyHandSettlement()` (see game.ts) so a hand can
 * never be settled without its projection, and a failed projection rolls the
 * whole settlement back. Backfill of historical transcripts is a separate,
 * idempotent pass that never touches the original records.
 *
 * Privacy: unrevealed hole cards never enter these tables. Only cards the
 * transcript already made public (showdown reveals / voluntary `hole_cards`)
 * are stored in `hand_players.revealed_cards_json`.
 */

export const HAND_PARSER_VERSION = 1;

/**
 * RUNNING CONSTRAINT (void semantics, spec §7/P3): a `void-hand` ledger row only
 * reverses money - it does NOT delete the projection written at settlement.
 * Every stats/read query MUST therefore exclude voided hands.
 *
 * Canonical correlation: a settlement ledger row's `ref` is the transcript
 * `head` (see `applyHandSettlement`, game.ts), and the live client voids with
 * that same `head`. Some callers/docs use the `hand_id` instead, and the two are
 * NOT equal. A hand is voided when a `void-hand` row references EITHER key, so
 * the helper takes both column expressions from the caller's `hands` row:
 * `hand_id` and the settlement/head (`source_head` in the `hands` table, `head`
 * in `transcripts`). This is the single place the mapping lives; do not
 * re-derive it inline elsewhere.
 */
export function voidHandExistsSql(args: {
  roomExpr: string;
  handIdExpr: string;
  headExpr: string;
}): string {
  return `EXISTS (SELECT 1 FROM ledger v WHERE v.room_id = ${args.roomExpr} AND v.kind = 'void-hand' AND (v.ref = ${args.handIdExpr} OR v.ref = ${args.headExpr}))`;
}

/** Inverse of {@link voidHandExistsSql}, for `WHERE` clauses. */
export function voidHandExclusionSql(args: {
  roomExpr: string;
  handIdExpr: string;
  headExpr: string;
}): string {
  return `NOT ${voidHandExistsSql(args)}`;
}

/** The `hands`-aliased exclusion fragment used by the stats/HUD query layer. */
export const VOIDED_HAND_EXCLUSION_SQL = voidHandExclusionSql({
  roomExpr: 'hands.room_id',
  handIdExpr: 'hands.hand_id',
  headExpr: 'hands.source_head',
});

/**
 * Exclusion for a settled `ledger` row aliased `ledgerAlias`, matching a
 * `void-hand` row against ALL THREE keys the row can be correlated by:
 *
 *   1. the row's OWN `ref` - a head-ref settlement/squid/commission leg, or a
 *      hand-id-ref bounty leg;
 *   2. the canonical `hand_id` derived from the row (see
 *      {@link ledgerHandIdSql}); and
 *   3. the transcript `head` derived from the row (see {@link ledgerHeadSql}).
 *
 * Why all three: the void writer's convention changed over time. The CURRENT
 * route mirrors both refs (it reverses a leg under that leg's own key), but the
 * OLD route only reversed head-ref rows, so a bounty leg - which always carries
 * the hand id - could survive a void that recorded only the head. A bounty row
 * cannot see its head through its own `ref`, so `hand_settlements` / the
 * `transcripts` projection must supply it; likewise a head-ref row cannot see
 * the hand id without the marker/transcript. Matching the row's own ref alone
 * therefore leaves historical head-only voids unmatched on bounty legs. Used by
 * `myHands` in rooms.ts, the stats reads and the timeline so every caller agrees
 * with {@link VOIDED_HAND_EXCLUSION_SQL}.
 */
export function settlementNotVoidedSql(ledgerAlias: string): string {
  return (
    `NOT EXISTS (SELECT 1 FROM ledger v WHERE v.room_id = ${ledgerAlias}.room_id ` +
    `AND v.kind = 'void-hand' ` +
    `AND (v.ref = ${ledgerAlias}.ref ` +
    `OR v.ref = ${ledgerHandIdSql(ledgerAlias)} ` +
    `OR v.ref = ${ledgerHeadSql(ledgerAlias)}))`
  );
}

// ---------------------------------------------------------------------------
// Authoritative per-hand, per-account "net change"
//
// DESIGN.md ("Commission (rake) legs and stack reconciliation") freezes the
// domain split:
//
//   gameDelta(u)        = poker + squid + automatic 7-2 bounty  // = projection net_delta
//   commissionDelta(u)  = +rake when u is the rake recipient, else 0
//   ending - starting   = gameDelta(u) + commissionDelta(u)     // (no mid-hand buy)
//
// Every read model that reports "what did this account win or lose on this
// hand" MUST use this game leg, NOT its own `kind IN (...)` whitelist and NOT
// `ending_stack - starting_stack` (a mid-hand buy, rake credit or later
// transfer makes those differ; DESIGN.md says "a consumer that wants the
// hand-only result must read net_delta, not a stack difference").
//
// The three ledger kinds are also written under two DIFFERENT refs - the
// head-ref kinds (`hand-settlement` / `squid-game` / `commission`) carry the
// transcript head, while `seven-deuce` carries the hand id - so they cannot be
// summed by `ref` alone. {@link ledgerHandIdSql} collapses every leg onto one
// canonical hand id; {@link gameNetLedgerDeltaSql} isolates the game leg.
// `commission` (rake credit) and `peek` (an independent post-hand transfer)
// are deliberately excluded.
// ---------------------------------------------------------------------------

/**
 * Ledger kind for a fold winner's post-settlement VOLUNTARY 7-2 show (written by
 * `GameRoom.trySevenDeuce` / `recordShow`, AFTER `applyHandSettlement`).
 *
 * It is deliberately NOT in {@link GAME_NET_LEDGER_KINDS}: the voluntary show is
 * outside the immutable transcript and the `hand_players` projection, so it is
 * not part of `hand_end.deltas` / `net_delta` and must stay out of every
 * hand-only game-net read model (else those reads would exceed the authoritative
 * projection). The AUTOMATIC showdown bounty keeps the plain `seven-deuce` kind
 * because it is written inside the settlement transaction and folded into
 * `net_delta`.
 *
 * Backward compatibility: historical voluntary legs were written as
 * `seven-deuce` and are indistinguishable from automatic ones without a
 * timestamp (forbidden) or a projection cross-check, so they keep the old
 * classification (see the report); only newly written voluntary legs carry this
 * kind.
 */
export const SEVEN_DEUCE_SHOW_KIND = 'seven-deuce-show';

/** Ledger kinds that make up the game net: poker + squid + automatic 7-2 bounty. */
export const GAME_NET_LEDGER_KINDS = ['hand-settlement', 'squid-game', 'seven-deuce'] as const;

/** SQL `IN` list literal for {@link GAME_NET_LEDGER_KINDS}. */
export const GAME_NET_LEDGER_KINDS_SQL = `(${GAME_NET_LEDGER_KINDS.map((k) => `'${k}'`).join(', ')})`;

/** The two kinds whose `ref` is already the canonical hand id (not the head). */
export const SEVEN_DEUCE_KINDS_SQL = `('seven-deuce', '${SEVEN_DEUCE_SHOW_KIND}')`;

/** Predicate: the `ledger` row aliased `ledgerAlias` is part of the game net. */
export function gameNetLedgerKindSql(ledgerAlias: string): string {
  return `${ledgerAlias}.kind IN ${GAME_NET_LEDGER_KINDS_SQL}`;
}

/** SQL expression: the row's signed contribution to the game net (0 otherwise). */
export function gameNetLedgerDeltaSql(ledgerAlias: string): string {
  return `CASE WHEN ${gameNetLedgerKindSql(ledgerAlias)} THEN ${ledgerAlias}.delta ELSE 0 END`;
}

/**
 * Canonical hand id for a `ledger` row aliased `ledgerAlias`, so every leg of one
 * hand groups under one key despite the two ref conventions: the head-ref kinds
 * carry the transcript head, while `seven-deuce` (automatic bounty) and
 * `seven-deuce-show` (voluntary show) already carry the hand id.
 *
 * For a head-ref row the hand id is resolved in this order:
 *   1. the `hand_settlements` marker (head -> hand_id); then
 *   2. the `transcripts` projection ((room_id, head) -> hand_id). This is the
 *      load-bearing fallback: the 7-2 bounty shipped BEFORE the durable marker,
 *      so an old hand can have a transcript + ledger but no marker, and simple
 *      `COALESCE(marker, ref)` would split it into TWO groups (head-ref
 *      settlement vs hand-id-ref bounty). The unique `idx_transcripts_room_head`
 *      handles the lookup.
 *   3. finally the row's own `ref` - the explicit "cannot normalize" case.
 *
 * Step 3 is deliberately the bare ref rather than a fabricated key: with no
 * marker AND no transcript there is nothing that links the head-ref legs to a
 * hand-id-ref bounty, so the row is genuinely unnormalizable. Keeping the ref
 * (the pre-change behaviour) means we never silently MERGE it into the wrong
 * hand, and never break downstream lookups that expect a real id. This residual
 * only occurs on truncated/corrupt history; a real markerless hand always has a
 * transcript, so the (very common) legacy case is covered by step 2.
 */
export function ledgerHandIdSql(ledgerAlias: string): string {
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

/**
 * Transcript head (the settlement correlation key) for a `ledger` row aliased
 * `ledgerAlias`. A head-ref row carries it in `ref`; a bounty row carries the
 * hand id in `ref`, so its head is resolved through `hand_settlements` (or the
 * `transcripts` projection for markerless history). NULL when neither table can
 * resolve the hand id - a bounty on a completely unknown hand has no head to
 * correlate, so the void match simply has nothing to hit.
 */
export function ledgerHeadSql(ledgerAlias: string): string {
  const ref = `${ledgerAlias}.ref`;
  const room = `${ledgerAlias}.room_id`;
  return (
    `CASE WHEN ${ledgerAlias}.kind IN ${SEVEN_DEUCE_KINDS_SQL} THEN COALESCE(` +
    `(SELECT hs.head FROM hand_settlements hs WHERE hs.room_id = ${room} AND hs.hand_id = ${ref}), ` +
    `(SELECT t.head FROM transcripts t WHERE t.room_id = ${room} AND t.hand_id = ${ref})) ` +
    `ELSE ${ref} END`
  );
}

// ---------------------------------------------------------------------------
// Shared per-hand game-net aggregate
//
// The four expressions above (`ledgerHandIdSql`, `gameNetLedgerDeltaSql`,
// `gameNetLedgerKindSql`, `settlementNotVoidedSql`) are already the single
// source for each INDIVIDUAL piece. What used to be hand-copied at every read
// model was their ARRANGEMENT: project the canonical hand id, sum the game-net
// delta, drop voided hands, and group by `(room, hand id[, user])`. Six-plus
// copies of that arrangement is what let the read models drift apart.
//
// `perHandNetSelect` freezes the arrangement. Callers own everything that
// genuinely differs between them - the `FROM`/`JOIN`, their extra `WHERE`
// predicates, extra projected columns and `HAVING` - so a site whose semantics
// are NOT the same aggregate (a hand COUNT, a commission-only leg, a raw
// per-ledger timeline, a per-user balance total) never gets folded in by
// accident. `excludeVoided` defaults to true: every game-net read model MUST
// exclude voided hands (spec §7/P3). The two deliberate exceptions pass false
// explicitly and say why at the call site.
// ---------------------------------------------------------------------------

export interface PerHandNetWhereOptions {
  /**
   * Caller-owned predicates ANDed in after the game-kind filter (the same
   * filter `gameNetLedgerDeltaSql` sums over) and before the void exclusion.
   * Used for the site's own scoping: user, room, `ref IS NOT NULL`, room
   * lifecycle, platform-account exclusion.
   */
  filter?: string;
  /**
   * Apply {@link settlementNotVoidedSql}. Default true (mandatory for a
   * game-net read model). Pass false only where the query's own join already
   * drops voided hands, or where voided hands are shown deliberately.
   */
  excludeVoided?: boolean;
}

/**
 * `WHERE` body for a per-hand game-net aggregate over `ledger` aliased `alias`:
 * the game-kind filter, the caller's extra predicates, then the void exclusion.
 * The kind filter is required so non-game legs (commission, peek, ...) cannot
 * form a group; `gameNetLedgerDeltaSql` already zeroes them, but the group
 * itself must not exist.
 */
export function perHandNetWhere(alias: string, opts: PerHandNetWhereOptions = {}): string {
  return (
    `${gameNetLedgerKindSql(alias)}` +
    (opts.filter ? ` AND ${opts.filter}` : '') +
    ((opts.excludeVoided ?? true) ? ` AND ${settlementNotVoidedSql(alias)}` : '')
  );
}

export interface PerHandNetSelectOptions extends PerHandNetWhereOptions {
  /** Projection alias for `alias.room_id`. Default `room_id`. */
  roomAlias?: string;
  /** Projection alias for {@link ledgerHandIdSql}. Default `ref`. */
  refAlias?: string;
  /** Projection alias for `SUM(`{@link gameNetLedgerDeltaSql}`)`. Default `net`. */
  netAlias?: string;
  /** Projection alias for `alias.user_id` when {@link perUser}. Default `user_id`. */
  userAlias?: string;
  /** Also project and group by `alias.user_id`. Default false. */
  perUser?: boolean;
  /** Also project `MAX(...) AS settled`, for settled-hand counting. Default false. */
  settledMarker?: boolean;
  /** Extra `JOIN ...` text inserted right after `FROM ledger <alias>`. */
  joins?: string;
  /** Extra projected column list appended after the net/settled columns. */
  extraColumns?: string;
  /** `HAVING` body (without the keyword). */
  having?: string;
}

/**
 * Complete per-hand game-net aggregate over `ledger <alias>`:
 *
 *   SELECT <room>, <canonical hand id>[, user][, net][, settled]
 *   FROM ledger <alias> [joins]
 *   WHERE <game kind>[ AND <filter>][ AND <void exclusion>]
 *   GROUP BY <room>, <canonical hand id>[, user]
 *   [HAVING <having>]
 *
 * Canonical key is `(room, canonical hand id[, user])`. The room stays in the
 * GROUP BY because {@link ledgerHandIdSql} falls back to the raw `ref`, which is
 * only room-unique - so `(room, hand id)` is the safe grouping key even though
 * a resolved `hands.hand_id` is globally unique.
 */
export function perHandNetSelect(alias: string, opts: PerHandNetSelectOptions = {}): string {
  const roomAlias = opts.roomAlias ?? 'room_id';
  const refAlias = opts.refAlias ?? 'ref';
  const netAlias = opts.netAlias ?? 'net';
  const userAlias = opts.userAlias ?? 'user_id';
  const columns = [
    `${alias}.room_id AS ${roomAlias}`,
    `${ledgerHandIdSql(alias)} AS ${refAlias}`,
    ...(opts.perUser ? [`${alias}.user_id AS ${userAlias}`] : []),
    `SUM(${gameNetLedgerDeltaSql(alias)}) AS ${netAlias}`,
    ...(opts.settledMarker
      ? [`MAX(CASE WHEN ${alias}.kind = 'hand-settlement' THEN 1 ELSE 0 END) AS settled`]
      : []),
    ...(opts.extraColumns ? [opts.extraColumns] : []),
  ].join(', ');
  const groupBy = [
    `${alias}.room_id`,
    ledgerHandIdSql(alias),
    ...(opts.perUser ? [`${alias}.user_id`] : []),
  ].join(', ');
  return (
    `SELECT ${columns} FROM ledger ${alias}` +
    (opts.joins ? ` ${opts.joins}` : '') +
    ` WHERE ${perHandNetWhere(alias, { filter: opts.filter, excludeVoided: opts.excludeVoided })}` +
    ` GROUP BY ${groupBy}` +
    (opts.having ? ` HAVING ${opts.having}` : '')
  );
}

/**
 * The rivals "other legs" scan behind `GET /api/users/:id/profile`: every
 * game-net ledger leg that is NOT the profile user's, carrying its canonical
 * hand id so the caller can join it against the user's own per-hand rows.
 *
 * AVAILABILITY-CRITICAL (commit 787ee1c). `ledgerHandIdSql` is two correlated
 * subqueries (`hand_settlements` / `transcripts`). Written straight into a
 * JOIN's `ON` clause, SQLite re-evaluates it once per candidate pair
 * (`mine x ledger-in-room`, ~1.5M pairs on live data); better-sqlite3 is a
 * synchronous call, so the event loop wedges for minutes and the whole server
 * dies (CPU 90%+, every request times out, SIGTERM unanswered). Both sides are
 * therefore MATERIALIZED CTEs that resolve the canonical id ONCE per row, and
 * the outer join matches plain columns. Do NOT inline the canonical-id
 * expression back into the join condition.
 *
 * Bind order is `(mineUserId, otherUserId)` - the `mine` CTE's `?` is first.
 */
export function rivalsOtherLegsSql(): string {
  return `WITH mine AS MATERIALIZED (
             ${perHandNetSelect('m', { filter: 'm.user_id = ? AND m.ref IS NOT NULL' })}
           ),
           other_legs AS MATERIALIZED (
             SELECT l.user_id AS userId, l.room_id AS roomId, ${ledgerHandIdSql('l')} AS ref
             FROM ledger l
             WHERE ${perHandNetWhere('l', { filter: 'l.user_id != ?' })}
           )
           SELECT DISTINCT o.userId, o.roomId, o.ref
           FROM other_legs o
           JOIN mine ON mine.room_id = o.roomId AND mine.ref = o.ref`;
}

export interface ProjectHandArgs {
  handId: string;
  roomId: string;
  head: string;
  entries: unknown;
  transcriptTs: number;
  /** True when a `void-hand` ledger row already exists for this hand. */
  voided?: boolean;
  now?: number;
  /**
   * Live settlement is strict: a non-empty transcript that cannot be projected
   * (no `hand_start`, <2 seats, malformed entries, duplicate/unknown seat
   * deltas, hash-head mismatch) throws and rolls the settlement back. Backfill
   * leaves this off so legacy/partial transcripts are recorded rather than
   * aborting the run.
   */
  strict?: boolean;
  /** Recompute the transcript hash chain and require it to equal `head`. */
  verifyHead?: boolean;
  /** Actual poker ledger rows this hand wrote, for per-hand reconciliation. */
  pokerLedger?: { userId: number; delta: number }[];
  /** Actual squid ledger rows this hand wrote, for per-hand reconciliation. */
  squidLedger?: { userId: number; delta: number }[];
  /** Commission (already deducted from the pot), for reconciliation. */
  rake?: number;
  /**
   * Final room stacks after the settlement, for an exact `ending_stack`. May
   * include a non-participant rake recipient, so it is NOT an equivalent set to
   * `hand_players` (P2/P3 must not treat them as one).
   */
  finalStacks?: { userId: number; stack: number }[];
  /** Actual combined stack deltas applied (poker + squid), for reconciliation. */
  stackDeltas?: { userId: number; delta: number }[];
}

export interface PositionAssignment {
  position: string;
  positionIndex: number;
  dealingIndex: number;
  preflopOrder: number;
  postflopOrder: number;
}

/** position names from the button round, in action order (BTN first). */
const POSITION_NAMES: Record<number, string[]> = {
  2: ['BTN', 'BB'],
  3: ['BTN', 'SB', 'BB'],
  4: ['BTN', 'SB', 'BB', 'CO'],
  5: ['BTN', 'SB', 'BB', 'HJ', 'CO'],
  6: ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO'],
  7: ['BTN', 'SB', 'BB', 'UTG', 'LJ', 'HJ', 'CO'],
  8: ['BTN', 'SB', 'BB', 'UTG', 'MP', 'LJ', 'HJ', 'CO'],
  9: ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'MP', 'LJ', 'HJ', 'CO'],
};

/**
 * Position table generated from the occupied seats and the hand's button, per
 * spec §5: only dealt seats are labelled, the button decides every label, and
 * the result does not change as players fold. `positionIndex` is the index in
 * the button-start action ring; `preflopOrder` / `postflopOrder` are 0-based
 * action indices within their street.
 */
export function positionAssignments(
  seats: { seat: number }[],
  buttonSeat: number,
): Map<number, PositionAssignment> {
  const out = new Map<number, PositionAssignment>();
  const n = seats.length;
  if (n < 2 || n > 9) return out;
  const names = POSITION_NAMES[n];
  if (!names) return out;
  const dealingOrder = seats.map((s) => s.seat);
  const sorted = [...dealingOrder].sort((a, b) => a - b);
  const btnIdx = sorted.indexOf(buttonSeat);
  if (btnIdx < 0) return out;
  for (let i = 0; i < n; i++) {
    const seat = sorted[(btnIdx + i) % n]!;
    // A hand is only ever two positions (HU): button posts the small blind, the
    // other seat is the big blind. 3+ handed preflop action starts three seats
    // after the button (UTG), so the button itself is last-but-two.
    const preflopOrder = n === 2 ? i : (i - 3 + n) % n;
    const postflopOrder = (i - 1 + n) % n;
    out.set(seat, {
      position: names[i]!,
      positionIndex: i,
      dealingIndex: dealingOrder.indexOf(seat),
      preflopOrder,
      postflopOrder,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

export function migrateHandStats(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hands (
      hand_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      source_head TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      game_kind TEXT NOT NULL,
      button_seat INTEGER,
      sb INTEGER,
      bb INTEGER,
      bomb_ante INTEGER,
      run_count INTEGER NOT NULL DEFAULT 1,
      gross_pot INTEGER NOT NULL DEFAULT 0,
      rake INTEGER NOT NULL DEFAULT 0,
      commission_bps INTEGER,
      board_json TEXT,
      boards_json TEXT,
      started_at INTEGER,
      settled_at INTEGER,
      transcript_ts INTEGER NOT NULL,
      parser_version INTEGER NOT NULL,
      projection_status TEXT NOT NULL,
      projection_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_hands_room_settled ON hands(room_id, settled_at DESC);
    CREATE INDEX IF NOT EXISTS idx_hands_status_settled ON hands(status, settled_at DESC);

    CREATE TABLE IF NOT EXISTS hand_players (
      hand_id TEXT NOT NULL,
      seat INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      position TEXT,
      position_index INTEGER,
      preflop_order INTEGER,
      postflop_order INTEGER,
      starting_stack INTEGER,
      ending_stack INTEGER,
      blind_role TEXT NOT NULL DEFAULT 'none',
      nominal_blind INTEGER NOT NULL DEFAULT 0,
      forced_post INTEGER NOT NULL DEFAULT 0,
      invested INTEGER NOT NULL DEFAULT 0,
      poker_award INTEGER NOT NULL DEFAULT 0,
      poker_delta INTEGER NOT NULL DEFAULT 0,
      squid_delta INTEGER NOT NULL DEFAULT 0,
      net_delta INTEGER NOT NULL DEFAULT 0,
      folded INTEGER NOT NULL DEFAULT 0,
      fold_street TEXT,
      saw_flop INTEGER NOT NULL DEFAULT 0,
      went_to_showdown INTEGER NOT NULL DEFAULT 0,
      won_poker INTEGER NOT NULL DEFAULT 0,
      revealed_cards_json TEXT,
      data_confidence TEXT NOT NULL DEFAULT 'exact',
      PRIMARY KEY (hand_id, seat),
      UNIQUE (hand_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_hp_user ON hand_players(user_id, hand_id);
    CREATE INDEX IF NOT EXISTS idx_hp_user_pos ON hand_players(user_id, position, hand_id);
    CREATE INDEX IF NOT EXISTS idx_hp_hand_user ON hand_players(hand_id, user_id);

    CREATE TABLE IF NOT EXISTS hand_actions (
      hand_id TEXT NOT NULL,
      action_no INTEGER NOT NULL,
      source_seq INTEGER,
      engine_action_seq INTEGER,
      seat INTEGER,
      user_id INTEGER,
      street TEXT NOT NULL,
      action_type TEXT NOT NULL,
      amount_to INTEGER,
      amount_added INTEGER NOT NULL DEFAULT 0,
      pot_before INTEGER,
      pot_after INTEGER,
      is_forced INTEGER NOT NULL DEFAULT 0,
      is_auto INTEGER NOT NULL DEFAULT 0,
      event_ts INTEGER,
      raw_json TEXT,
      PRIMARY KEY (hand_id, action_no)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ha_source
      ON hand_actions(hand_id, source_seq) WHERE source_seq IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_ha_street ON hand_actions(hand_id, street, action_no);
    CREATE INDEX IF NOT EXISTS idx_ha_user_street_action
      ON hand_actions(user_id, street, action_type, hand_id);
    CREATE INDEX IF NOT EXISTS idx_ha_user_action ON hand_actions(user_id, action_type, hand_id);

    CREATE TABLE IF NOT EXISTS hand_projection_errors (
      hand_id TEXT PRIMARY KEY,
      source_head TEXT,
      parser_version INTEGER NOT NULL,
      error_code TEXT NOT NULL,
      error_message TEXT,
      attempts INTEGER NOT NULL DEFAULT 1,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );

  `);

  // Invariant the void OR-correlation relies on: within a room a transcript
  // head identifies at most one hand, and a settlement maps one head to one
  // hand_id. Preflight the duplicate rows BEFORE asking SQLite for the unique
  // index, so a legacy duplicate produces a precise diagnostic instead of a
  // bare "UNIQUE constraint failed" - and audit data is never auto-deduped.
  // The indexes themselves are the migration marker: once both exist this scan
  // is skipped on every later startup.
  const hasIndex = (name: string): boolean =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name);
  if (
    !hasIndex('idx_transcripts_room_head') ||
    !hasIndex('idx_hand_settlements_room_head')
  ) {
    assertUniqueRoomHead(db);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_transcripts_room_head ON transcripts(room_id, head);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_hand_settlements_room_head ON hand_settlements(room_id, head);
    `);
  }
}

/**
 * Fail-closed preflight for the `(room_id, head)` uniqueness the void
 * correlation assumes. Raises the offending groups (room, head, row count) so
 * an operator can reconcile the audit data; it never deletes or rewrites rows.
 */
export function assertUniqueRoomHead(db: DB): void {
  for (const table of ['transcripts', 'hand_settlements'] as const) {
    const dupes = db
      .prepare(
        `SELECT room_id AS roomId, head, COUNT(*) AS n
         FROM ${table}
         GROUP BY room_id, head HAVING COUNT(*) > 1
         ORDER BY n DESC, room_id, head`,
      )
      .all() as { roomId: string; head: string; n: number }[];
    if (dupes.length > 0) {
      const shown = dupes.slice(0, 20);
      const detail = shown
        .map((d) => `room=${d.roomId} head=${d.head} rows=${d.n}`)
        .join('; ');
      throw new Error(
        `migrateHandStats: ${table} has ${dupes.length} duplicate (room_id, head) group(s); ` +
          'void-hand correlation is ambiguous and the audit rows must be reconciled (never auto-deduped). ' +
          `First ${shown.length}: ${detail}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface Entry {
  seq: number;
  type: string;
  from: string;
  payload: Record<string, unknown>;
}

export interface HandPlayerRow {
  seat: number;
  userId: number;
  position: string | null;
  positionIndex: number | null;
  preflopOrder: number | null;
  postflopOrder: number | null;
  startingStack: number | null;
  endingStack: number | null;
  blindRole: string;
  nominalBlind: number;
  forcedPost: number;
  invested: number;
  pokerAward: number;
  pokerDelta: number;
  squidDelta: number;
  netDelta: number;
  folded: number;
  foldStreet: string | null;
  sawFlop: number;
  wentToShowdown: number;
  wonPoker: number;
  revealedCardsJson: string | null;
  dataConfidence: string;
}

export interface HandActionRow {
  actionNo: number;
  sourceSeq: number | null;
  engineActionSeq: number | null;
  seat: number | null;
  userId: number | null;
  street: string;
  actionType: string;
  amountTo: number | null;
  amountAdded: number;
  potBefore: number | null;
  potAfter: number | null;
  isForced: number;
  isAuto: number;
  eventTs: number | null;
  rawJson: string;
}

export interface HandsRow {
  handId: string;
  roomId: string;
  sourceHead: string;
  status: string;
  gameKind: string;
  buttonSeat: number | null;
  sb: number | null;
  bb: number | null;
  bombAnte: number | null;
  runCount: number;
  grossPot: number;
  rake: number;
  commissionBps: number | null;
  boardJson: string | null;
  boardsJson: string | null;
  startedAt: number | null;
  settledAt: number | null;
  transcriptTs: number;
  parserVersion: number;
  projectionStatus: string;
  projectionError: string | null;
}

export interface ParsedHand {
  hands: HandsRow;
  players: HandPlayerRow[];
  actions: HandActionRow[];
}

export class HandProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandProjectionError';
  }
}

/** Parse the raw JSON/array envelope. Strict mode refuses malformed outer shapes. */
function rawEntriesArray(entries: unknown, strict: boolean): unknown[] | null {
  let raw: unknown = entries;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      if (strict)
        throw new HandProjectionError('transcript entries is not valid JSON');
      return null;
    }
  }
  if (!Array.isArray(raw)) {
    if (strict) throw new HandProjectionError('transcript entries is not an array');
    return null;
  }
  return raw;
}

function asEntries(raw: unknown[], strict: boolean): Entry[] {
  const out: Entry[] = [];
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i];
    if (!e || typeof e !== 'object') {
      if (strict) throw new HandProjectionError(`transcript entry ${i} is not an object`);
      continue;
    }
    const r = e as Record<string, unknown>;
    if (typeof r.type !== 'string') {
      if (strict) throw new HandProjectionError(`transcript entry ${i} has no type`);
      continue;
    }
    if (strict && typeof r.seq !== 'number')
      throw new HandProjectionError(`transcript entry ${i} has no seq`);
    const payload =
      r.payload && typeof r.payload === 'object' && !Array.isArray(r.payload)
        ? (r.payload as Record<string, unknown>)
        : null;
    if (strict && payload === null)
      throw new HandProjectionError(`transcript entry ${i} has no payload object`);
    out.push({
      seq: typeof r.seq === 'number' ? r.seq : out.length,
      type: r.type,
      from: typeof r.from === 'string' ? r.from : '',
      payload: payload ?? {},
    });
  }
  return out;
}

/**
 * Require the raw entries to be a contiguous, hash-consistent chain ending at
 * `head`. Online this throws (rolling the settlement back); backfill turns it
 * into a projection error. An empty transcript has no chain to verify.
 */
function verifyTranscriptHead(raw: unknown[], head: string, handId: string): void {
  if (raw.length === 0) return;
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i] as TranscriptEntry | undefined;
    if (!e || typeof e !== 'object' || e.seq !== i)
      throw new HandProjectionError(`transcript seq not contiguous at ${i} on hand ${handId}`);
  }
  const computed = computeHead(raw as TranscriptEntry[]);
  if (computed !== head)
    throw new HandProjectionError(`transcript head mismatch on hand ${handId}`);
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

const ACTION_TYPE_MAP: Record<string, string> = {
  fold: 'fold',
  check: 'check',
  call: 'call',
  bet: 'bet',
  raise: 'raise',
};

function streetFromIndex(i: number): string {
  return ['preflop', 'flop', 'turn', 'river'][i] ?? 'preflop';
}

/**
 * Parse one transcript into projection rows. Returns `null` when the entries do
 * not describe a dealt hand (empty/legacy stub) - that is not an error, there is
 * simply nothing to project. A structurally impossible hand (claims to have
 * settled but has no usable deltas) throws so the settlement transaction rolls
 * back rather than persisting a half-truth.
 */
export function parseHandEntries(entries: unknown, args: ProjectHandArgs): ParsedHand | null {
  const strict = !!args.strict;
  const raw = rawEntriesArray(entries, strict);
  if (!raw || raw.length === 0) return null;
  if (args.verifyHead) verifyTranscriptHead(raw, args.head, args.handId);
  const list = asEntries(raw, strict);
  if (list.length === 0) return null;
  const start = list.find((e) => e.type === 'hand_start');
  if (!start) {
    if (strict)
      throw new HandProjectionError(`hand ${args.handId} transcript has no hand_start`);
    return null;
  }

  const rawSeats = arr(start.payload.seats);
  const seatInfos: {
    seat: number;
    userId: number;
    stack: number | null;
    position?: string;
    positionIndex?: number;
    preflopOrder?: number;
    postflopOrder?: number;
    dealingIndex?: number;
  }[] = [];
  for (const s of rawSeats) {
    const o = obj(s);
    const seat = num(o?.seat);
    const userId = num(o?.userId);
    if (seat === null || userId === null) {
      if (strict) throw new HandProjectionError(`malformed seat on hand ${args.handId}`);
      continue;
    }
    seatInfos.push({
      seat,
      userId,
      stack: num(o?.stack),
      position: typeof o?.position === 'string' ? o.position : undefined,
      positionIndex: num(o?.positionIndex) ?? undefined,
      preflopOrder: num(o?.preflopOrder) ?? undefined,
      postflopOrder: num(o?.postflopOrder) ?? undefined,
      dealingIndex: num(o?.dealingIndex) ?? undefined,
    });
  }
  if (seatInfos.length < 2) {
    if (strict) throw new HandProjectionError(`hand ${args.handId} has fewer than 2 seats`);
    return null;
  }
  if (strict) {
    const seats = new Set<number>();
    const users = new Set<number>();
    for (const s of seatInfos) {
      if (seats.has(s.seat))
        throw new HandProjectionError(`duplicate seat ${s.seat} on hand ${args.handId}`);
      if (users.has(s.userId))
        throw new HandProjectionError(`duplicate user ${s.userId} on hand ${args.handId}`);
      seats.add(s.seat);
      users.add(s.userId);
    }
  }

  const buttonSeat = num(start.payload.buttonSeat);
  const sb = num(start.payload.sb);
  const bb = num(start.payload.bb);
  const commissionBps = num(start.payload.commissionBps);
  const schemaVersion = num(start.payload.schemaVersion) ?? 1;

  // Prefer the position fields the engine wrote; fall back to the spec table for
  // legacy hands (and mark them legacy rather than pretending they were exact).
  const fallback =
    buttonSeat !== null ? positionAssignments(seatInfos, buttonSeat) : new Map<number, PositionAssignment>();

  const settlement = list.find((e) => e.type === 'settlement');
  const bombStart = list.find((e) => e.type === 'bomb_pot_start');
  const isBomb = !!bombStart || start.payload.gameKind === 'bomb_pot';
  const abort = list.find((e) => e.type === 'hand_abort');
  const status = settlement ? (args.voided ? 'voided' : 'settled') : abort ? 'aborted' : 'invalid';

  // ---- settlement facts ----
  const awards = new Map<number, number>();
  const reveals = new Map<number, number[]>();
  const combinedDeltas = new Map<number, number>();
  const pokerDeltas = new Map<number, number>();
  const squidDeltas = new Map<number, number>();
  let board: number[] | null = null;
  let boards: number[][] | null = null;
  let runCount = 1;
  let showdown = false;
  let rake = 0;
  let grossPot: number | null = null;

  const knownSeats = new Set(seatInfos.map((s) => s.seat));
  const addSeatDelta = (map: Map<number, number>, label: string, entries: unknown[]): void => {
    for (const d of entries) {
      const o = obj(d);
      const seat = num(o?.seat);
      const delta = num(o?.delta ?? o?.net);
      if (seat === null || delta === null) {
        if (strict) throw new HandProjectionError(`malformed ${label} on hand ${args.handId}`);
        continue;
      }
      if (strict) {
        if (!knownSeats.has(seat))
          throw new HandProjectionError(`unknown seat ${seat} in ${label} on hand ${args.handId}`);
        if (map.has(seat))
          throw new HandProjectionError(`duplicate seat ${seat} in ${label} on hand ${args.handId}`);
      }
      map.set(seat, delta);
    }
  };

  if (settlement) {
    const p = settlement.payload;
    if (p.deltas !== undefined && !Array.isArray(p.deltas)) {
      throw new HandProjectionError(`settlement deltas not an array on hand ${args.handId}`);
    }
    addSeatDelta(combinedDeltas, 'deltas', arr(p.deltas));
    addSeatDelta(pokerDeltas, 'pokerDeltas', arr(p.pokerDeltas));
    const squid = obj(p.squid);
    addSeatDelta(squidDeltas, 'squid.netBySeat', arr(squid?.netBySeat));
    for (const a of arr(p.awards)) {
      const o = obj(a);
      const seat = num(o?.seat);
      const amount = num(o?.amount);
      if (seat === null || amount === null) {
        if (strict) throw new HandProjectionError(`malformed awards on hand ${args.handId}`);
        continue;
      }
      if (strict && !knownSeats.has(seat))
        throw new HandProjectionError(`unknown seat ${seat} in awards on hand ${args.handId}`);
      awards.set(seat, amount);
    }
    for (const r of arr(p.reveals)) {
      const o = obj(r);
      const seat = num(o?.seat);
      const cards = arr(o?.cards).filter((c): c is number => typeof c === 'number');
      if (seat === null || cards.length === 0) {
        if (strict) throw new HandProjectionError(`malformed reveals on hand ${args.handId}`);
        continue;
      }
      if (strict && !knownSeats.has(seat))
        throw new HandProjectionError(`unknown seat ${seat} in reveals on hand ${args.handId}`);
      reveals.set(seat, cards);
    }
    const b = arr(p.board).filter((c): c is number => typeof c === 'number');
    board = b.length ? b : null;
    const bs = arr(p.boards)
      .map((run) => arr(run).filter((c): c is number => typeof c === 'number'))
      .filter((run) => run.length);
    boards = bs.length ? bs : null;
    runCount = num(p.runCount) ?? boards?.length ?? 1;
    if (strict && (!Number.isInteger(runCount) || runCount < 1))
      throw new HandProjectionError(`bad runCount on hand ${args.handId}`);
    showdown = typeof p.showdown === 'boolean' ? p.showdown : reveals.size > 0;
    rake = num(p.commission) ?? 0;
    if (strict && (!Number.isInteger(rake) || rake < 0))
      throw new HandProjectionError(`invalid rake ${rake} on hand ${args.handId}`);
    if (
      strict &&
      args.rake !== undefined &&
      (!Number.isInteger(args.rake) || args.rake < 0 || rake !== args.rake)
    )
      throw new HandProjectionError(
        `rake mismatch on hand ${args.handId}: transcript=${rake} settlement=${args.rake}`,
      );
    grossPot = num(p.grossPot);
  } else if (strict) {
    throw new HandProjectionError(`hand ${args.handId} transcript has no settlement`);
  }

  if (settlement && combinedDeltas.size === 0 && pokerDeltas.size === 0) {
    throw new HandProjectionError(`settled hand ${args.handId} has no deltas`);
  }

  // ---- actions ----
  const actions: HandActionRow[] = [];
  const consumedBySeat = new Map<number, number>();
  const forcedBySeat = new Map<number, number>();
  const foldStreetBySeat = new Map<number, string>();
  const blindRoleBySeat = new Map<number, string>();
  const nominalBlindBySeat = new Map<number, number>();
  let hasBlindRecord = false;
  let allAmountsExact = true;

  const seatUser = new Map<number, number>();
  for (const s of seatInfos) seatUser.set(s.seat, s.userId);

  const pushAction = (row: Omit<HandActionRow, 'actionNo'>): void => {
    actions.push({ actionNo: actions.length, ...row });
    if (row.seat !== null) {
      consumedBySeat.set(row.seat, (consumedBySeat.get(row.seat) ?? 0) + row.amountAdded);
      if (row.isForced) forcedBySeat.set(row.seat, (forcedBySeat.get(row.seat) ?? 0) + row.amountAdded);
      // a timeout fold is still a fold for VPIP/PFR/WTSD: keep the richer action
      // type but mark the seat folded at that street.
      if (
        (row.actionType === 'fold' || row.actionType === 'timeout_fold') &&
        !foldStreetBySeat.has(row.seat)
      )
        foldStreetBySeat.set(row.seat, row.street);
    }
  };

  let street = 'preflop';
  let streetIndex = 0;
  // Running pot total, used to fill potBefore/potAfter for entries that expanded
  // into several actions (blind_post/ante_post) or predate the enriched fields.
  let runningPot = 0;
  // Cards the transcript already made public via audit/TV replay `hole_cards`.
  const publicCards = new Map<number, number[]>();

  for (const e of list) {
    const p = e.payload;
    switch (e.type) {
      case 'betting_start': {
        street = typeof p.street === 'string' ? p.street : 'preflop';
        break;
      }
      case 'blind_post': {
        hasBlindRecord = true;
        const seenBlind = new Set<number>();
        for (const post of arr(p.posts)) {
          const o = obj(post);
          const seat = num(o?.seat);
          if (seat === null) {
            if (strict) throw new HandProjectionError(`malformed blind_post on hand ${args.handId}`);
            continue;
          }
          if (strict && !knownSeats.has(seat))
            throw new HandProjectionError(`unknown blind_post seat ${seat} on hand ${args.handId}`);
          const rawKind = o?.kind;
          if (strict && typeof rawKind !== 'string')
            throw new HandProjectionError(`blind_post missing kind on hand ${args.handId}`);
          const kind = typeof rawKind === 'string' ? rawKind : 'sb';
          if (strict && kind !== 'sb' && kind !== 'bb')
            throw new HandProjectionError(`bad blind kind '${kind}' on hand ${args.handId}`);
          if (strict && seenBlind.has(seat))
            throw new HandProjectionError(`duplicate blind_post seat ${seat} on hand ${args.handId}`);
          seenBlind.add(seat);
          const nominalRaw = num(o?.nominal);
          const amountRaw = num(o?.amount);
          if (
            strict &&
            (nominalRaw === null ||
              nominalRaw < 0 ||
              !Number.isInteger(nominalRaw) ||
              amountRaw === null ||
              amountRaw < 0 ||
              !Number.isInteger(amountRaw))
          )
            throw new HandProjectionError(`blind_post missing/invalid amount on hand ${args.handId}`);
          const nominal = nominalRaw ?? 0;
          const amount = amountRaw ?? 0;
          const potBefore = num(o?.potBefore) ?? runningPot;
          const potAfter = num(o?.potAfter) ?? potBefore + amount;
          runningPot = potAfter;
          blindRoleBySeat.set(seat, kind);
          nominalBlindBySeat.set(seat, nominal);
          pushAction({
            sourceSeq: null,
            engineActionSeq: null,
            seat,
            userId: seatUser.get(seat) ?? null,
            street: 'preflop',
            actionType: kind === 'bb' ? 'post_bb' : 'post_sb',
            amountTo: null,
            amountAdded: amount,
            potBefore,
            potAfter,
            isForced: 1,
            isAuto: 1,
            eventTs: num(p.ts),
            rawJson: JSON.stringify(post),
          });
        }
        break;
      }
      case 'ante_post': {
        hasBlindRecord = true;
        const seenAnte = new Set<number>();
        for (const post of arr(p.posts)) {
          const o = obj(post);
          const seat = num(o?.seat);
          if (seat === null) {
            if (strict) throw new HandProjectionError(`malformed ante_post on hand ${args.handId}`);
            continue;
          }
          if (strict && !knownSeats.has(seat))
            throw new HandProjectionError(`unknown ante_post seat ${seat} on hand ${args.handId}`);
          if (strict && o?.kind !== 'ante')
            throw new HandProjectionError(`bad ante kind '${String(o?.kind)}' on hand ${args.handId}`);
          if (strict && seenAnte.has(seat))
            throw new HandProjectionError(`duplicate ante_post seat ${seat} on hand ${args.handId}`);
          seenAnte.add(seat);
          const amountRaw = num(o?.amount);
          const nominalRaw = num(o?.nominal);
          if (
            strict &&
            (amountRaw === null ||
              nominalRaw === null ||
              amountRaw < 0 ||
              nominalRaw < 0 ||
              !Number.isInteger(amountRaw) ||
              !Number.isInteger(nominalRaw))
          )
            throw new HandProjectionError(`ante_post missing/invalid amount on hand ${args.handId}`);
          const amount = amountRaw ?? 0;
          const potBefore = num(o?.potBefore) ?? runningPot;
          const potAfter = num(o?.potAfter) ?? potBefore + amount;
          runningPot = potAfter;
          blindRoleBySeat.set(seat, 'ante');
          nominalBlindBySeat.set(seat, nominalRaw ?? 0);
          pushAction({
            sourceSeq: null,
            engineActionSeq: null,
            seat,
            userId: seatUser.get(seat) ?? null,
            street: 'preflop',
            actionType: 'post_ante',
            amountTo: null,
            amountAdded: amount,
            potBefore,
            potAfter,
            isForced: 1,
            isAuto: 1,
            eventTs: num(p.ts),
            rawJson: JSON.stringify(post),
          });
        }
        break;
      }
      case 'street': {
        if (typeof p.street === 'string') street = p.street;
        else {
          streetIndex += 1;
          street = streetFromIndex(streetIndex);
        }
        if (typeof p.streetIndex === 'number') streetIndex = p.streetIndex;
        break;
      }
      case 'action': {
        const a = obj(p.action);
        const type = typeof a?.type === 'string' ? ACTION_TYPE_MAP[a.type] ?? a.type : null;
        if (!type) {
          if (strict) throw new HandProjectionError(`unknown action on hand ${args.handId}`);
          break;
        }
        const seat = num(p.seat);
        if (strict && (seat === null || !knownSeats.has(seat)))
          throw new HandProjectionError(`unknown action seat on hand ${args.handId}`);
        const amountAdded = num(p.amountAdded);
        if (amountAdded === null) allAmountsExact = false;
        const added = amountAdded ?? 0;
        const potBefore = num(p.potBefore) ?? runningPot;
        const potAfter = num(p.potAfter) ?? potBefore + added;
        runningPot = potAfter;
        pushAction({
          sourceSeq: e.seq,
          engineActionSeq: num(p.actionSeq),
          seat,
          userId: seat !== null ? seatUser.get(seat) ?? null : null,
          street: typeof p.street === 'string' ? p.street : street,
          actionType: type,
          amountTo: num(a?.amount),
          amountAdded: added,
          potBefore,
          potAfter,
          isForced: 0,
          isAuto: 0,
          eventTs: num(p.ts),
          rawJson: JSON.stringify(p),
        });
        break;
      }
      case 'timeout_fold': {
        const seat = num(p.seat);
        if (strict && (seat === null || !knownSeats.has(seat)))
          throw new HandProjectionError(`unknown timeout_fold seat on hand ${args.handId}`);
        const added = num(p.amountAdded) ?? 0;
        const potBefore = num(p.potBefore) ?? runningPot;
        const potAfter = num(p.potAfter) ?? potBefore + added;
        runningPot = potAfter;
        pushAction({
          sourceSeq: e.seq,
          engineActionSeq: num(p.actionSeq),
          seat,
          userId: seat !== null ? seatUser.get(seat) ?? null : null,
          street: typeof p.street === 'string' ? p.street : street,
          actionType: 'timeout_fold',
          amountTo: null,
          amountAdded: added,
          potBefore,
          potAfter,
          isForced: 0,
          isAuto: 1,
          eventTs: num(p.ts),
          rawJson: JSON.stringify(p),
        });
        break;
      }
      case 'board_open': {
        // Only used as a board fallback when the settlement did not carry one.
        const card = num(p.card);
        if (card === null) break;
        if (board === null) board = [];
        const run = num(p.run) ?? 1;
        if (run === 1 && !board.includes(card)) board.push(card);
        break;
      }
      case 'hole_cards': {
        // An audit/TV replay put plaintext cards in the transcript: they are
        // public, so they may fill revealed_cards_json. This never sets
        // went_to_showdown - that still requires a settlement reveal.
        const seat = num(p.seat);
        const cards = arr(p.cards).filter((c): c is number => typeof c === 'number');
        if (seat !== null && cards.length) publicCards.set(seat, cards);
        break;
      }
      default:
        break;
    }
  }

  const boardLen = board?.length ?? 0;
  const players: HandPlayerRow[] = [];
  const hasEnhanced = schemaVersion >= 2 && hasBlindRecord;

  let gross = grossPot;
  if (gross === null) gross = [...awards.values()].reduce((s, a) => s + a, 0) + rake;

  for (const s of seatInfos) {
    const generated = fallback.get(s.seat);
    // Prefer the fields the engine wrote; fall back to the spec position table
    // for legacy hands.
    const position = s.position ?? generated?.position ?? null;
    const positionIndex = s.positionIndex ?? generated?.positionIndex ?? null;
    const preflopOrder = s.preflopOrder ?? generated?.preflopOrder ?? null;
    const postflopOrder = s.postflopOrder ?? generated?.postflopOrder ?? null;
    const combined = combinedDeltas.get(s.seat);
    const squid = squidDeltas.get(s.seat) ?? 0;
    const poker = pokerDeltas.has(s.seat)
      ? pokerDeltas.get(s.seat)!
      : combined !== undefined
        ? combined - squid
        : 0;
    const net = combined !== undefined ? combined : poker + squid;
    const award = awards.get(s.seat) ?? 0;
    const foldStreet = foldStreetBySeat.get(s.seat) ?? null;
    const folded = foldStreet !== null;
    const blindRole = blindRoleBySeat.get(s.seat) ?? (isBomb ? 'ante' : blindRoleFor(position ?? undefined));
    const nominalBlind =
      nominalBlindBySeat.get(s.seat) ??
      (isBomb ? (bombAnteNominal(list) ?? 0) : blindNominal(blindRole, sb, bb));
    const forced = forcedBySeat.get(s.seat) ?? (hasBlindRecord ? 0 : Math.min(s.stack ?? 0, nominalBlind));
    const showdownCards = reveals.get(s.seat) ?? null;
    const cards = showdownCards ?? publicCards.get(s.seat) ?? null;
    const finalStack = args.finalStacks?.find((f) => f.userId === s.userId)?.stack;
    const sawFlop = boardLen >= 3 && foldStreet !== 'preflop';

    players.push({
      seat: s.seat,
      userId: s.userId,
      position,
      positionIndex,
      preflopOrder,
      postflopOrder,
      startingStack: s.stack,
      endingStack: finalStack ?? (s.stack !== null ? s.stack + net : null),
      blindRole,
      nominalBlind,
      forcedPost: forced,
      invested: consumedBySeat.get(s.seat) ?? 0,
      pokerAward: award,
      pokerDelta: poker,
      squidDelta: squid,
      netDelta: net,
      folded: folded ? 1 : 0,
      foldStreet,
      sawFlop: sawFlop ? 1 : 0,
      wentToShowdown: showdownCards ? 1 : 0,
      wonPoker: award > 0 ? 1 : 0,
      revealedCardsJson: cards ? JSON.stringify(cards) : null,
      dataConfidence: dataConfidenceFor({
        settlement: !!settlement,
        hasEnhanced,
        allAmountsExact,
        hasFinalStack: finalStack !== undefined,
      }),
    });
  }

  const hands: HandsRow = {
    handId: args.handId,
    roomId: args.roomId,
    sourceHead: args.head,
    status,
    gameKind: isBomb ? 'bomb_pot' : 'normal',
    buttonSeat: buttonSeat ?? null,
    sb,
    bb,
    bombAnte: bombAnteNominal(list),
    runCount: Math.max(1, runCount),
    grossPot: gross,
    rake,
    commissionBps,
    boardJson: board ? JSON.stringify(board) : null,
    boardsJson: JSON.stringify(boards ?? (board ? [board] : [])),
    startedAt: num(start.payload.startedAt) ?? args.transcriptTs,
    settledAt: settlement ? num(settlement.payload.ts) ?? args.transcriptTs : null,
    transcriptTs: args.transcriptTs,
    parserVersion: HAND_PARSER_VERSION,
    projectionStatus: players.every((p) => p.dataConfidence === 'exact') ? 'ok' : 'legacy',
    projectionError: null,
  };

  return { hands, players, actions };
}

function blindRoleFor(position: string | undefined): string {
  switch (position) {
    case 'SB':
      return 'sb';
    case 'BB':
      return 'bb';
    case 'BTN':
      // heads-up only: the button *is* the small blind
      return 'sb';
    default:
      return 'none';
  }
}

function blindNominal(role: string, sb: number | null, bb: number | null): number {
  if (role === 'sb') return sb ?? 0;
  if (role === 'bb') return bb ?? 0;
  return 0;
}

function bombAnteNominal(list: Entry[]): number | null {
  const bomb = list.find((e) => e.type === 'bomb_pot_start');
  if (bomb) {
    const ante = num(bomb.payload.ante);
    if (ante !== null) return ante;
  }
  const antePost = list.find((e) => e.type === 'ante_post');
  if (antePost) {
    for (const post of arr(antePost.payload.posts)) {
      const nominal = num(obj(post)?.nominal);
      if (nominal !== null) return nominal;
    }
  }
  return null;
}

function dataConfidenceFor(opts: {
  settlement: boolean;
  hasEnhanced: boolean;
  allAmountsExact: boolean;
  hasFinalStack: boolean;
}): string {
  if (!opts.settlement) return 'partial';
  // Without a trusted final stack we cannot claim exact even when the enriched
  // record fields are present: ending_stack would be a derived approximation.
  if (opts.hasFinalStack && opts.hasEnhanced && opts.allAmountsExact) return 'exact';
  return 'legacy';
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Upsert parsed rows. MUST be called inside an open transaction (the settlement
 * transaction, or a backfill transaction). Deletes this hand's player/action
 * rows first so a re-run with a newer parser replaces them wholesale.
 */
export function writeParsedHand(db: DB, parsed: ParsedHand): void {
  const h = parsed.hands;
  db.prepare('DELETE FROM hand_players WHERE hand_id = ?').run(h.handId);
  db.prepare('DELETE FROM hand_actions WHERE hand_id = ?').run(h.handId);
  db.prepare(
    `INSERT INTO hands (
       hand_id, room_id, source_head, status, game_kind, button_seat, sb, bb, bomb_ante,
       run_count, gross_pot, rake, commission_bps, board_json, boards_json, started_at,
       settled_at, transcript_ts, parser_version, projection_status, projection_error
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(hand_id) DO UPDATE SET
       room_id = excluded.room_id,
       source_head = excluded.source_head,
       status = excluded.status,
       game_kind = excluded.game_kind,
       button_seat = excluded.button_seat,
       sb = excluded.sb,
       bb = excluded.bb,
       bomb_ante = excluded.bomb_ante,
       run_count = excluded.run_count,
       gross_pot = excluded.gross_pot,
       rake = excluded.rake,
       commission_bps = excluded.commission_bps,
       board_json = excluded.board_json,
       boards_json = excluded.boards_json,
       started_at = excluded.started_at,
       settled_at = excluded.settled_at,
       transcript_ts = excluded.transcript_ts,
       parser_version = excluded.parser_version,
       projection_status = excluded.projection_status,
       projection_error = excluded.projection_error`,
  ).run(
    h.handId,
    h.roomId,
    h.sourceHead,
    h.status,
    h.gameKind,
    h.buttonSeat,
    h.sb,
    h.bb,
    h.bombAnte,
    h.runCount,
    h.grossPot,
    h.rake,
    h.commissionBps,
    h.boardJson,
    h.boardsJson,
    h.startedAt,
    h.settledAt,
    h.transcriptTs,
    h.parserVersion,
    h.projectionStatus,
    h.projectionError,
  );

  const insertPlayer = db.prepare(
    `INSERT INTO hand_players (
       hand_id, seat, user_id, position, position_index, preflop_order, postflop_order,
       starting_stack, ending_stack, blind_role, nominal_blind, forced_post, invested,
       poker_award, poker_delta, squid_delta, net_delta, folded, fold_street, saw_flop,
       went_to_showdown, won_poker, revealed_cards_json, data_confidence
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const p of parsed.players) {
    insertPlayer.run(
      h.handId,
      p.seat,
      p.userId,
      p.position,
      p.positionIndex,
      p.preflopOrder,
      p.postflopOrder,
      p.startingStack,
      p.endingStack,
      p.blindRole,
      p.nominalBlind,
      p.forcedPost,
      p.invested,
      p.pokerAward,
      p.pokerDelta,
      p.squidDelta,
      p.netDelta,
      p.folded,
      p.foldStreet,
      p.sawFlop,
      p.wentToShowdown,
      p.wonPoker,
      p.revealedCardsJson,
      p.dataConfidence,
    );
  }

  const insertAction = db.prepare(
    `INSERT INTO hand_actions (
       hand_id, action_no, source_seq, engine_action_seq, seat, user_id, street, action_type,
       amount_to, amount_added, pot_before, pot_after, is_forced, is_auto, event_ts, raw_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const a of parsed.actions) {
    insertAction.run(
      h.handId,
      a.actionNo,
      a.sourceSeq,
      a.engineActionSeq,
      a.seat,
      a.userId,
      a.street,
      a.actionType,
      a.amountTo,
      a.amountAdded,
      a.potBefore,
      a.potAfter,
      a.isForced,
      a.isAuto,
      a.eventTs,
      a.rawJson,
    );
  }
}

/** Materialize one hand inside the caller's open transaction. */
export function materializeHandProjection(db: DB, args: ProjectHandArgs): { projectable: boolean } {
  const parsed = parseHandEntries(args.entries, args);
  if (!parsed) {
    // Live settlement must not commit a hand with no projection. Only a truly
    // empty transcript (nothing to project at all) is tolerated; anything with
    // content that cannot be projected is a structural error.
    if (args.strict && hasTranscriptContent(args.entries))
      throw new HandProjectionError(
        `hand ${args.handId} could not be projected (no hand_start / too few seats)`,
      );
    return { projectable: false };
  }
  parsed.hands.transcriptTs = args.transcriptTs;
  parsed.hands.parserVersion = HAND_PARSER_VERSION;
  parsed.hands.projectionError = null;
  if (args.voided) parsed.hands.status = 'voided';
  if (args.pokerLedger || args.squidLedger) reconcileProjection(parsed, args);
  writeParsedHand(db, parsed);
  return { projectable: true };
}

function hasTranscriptContent(entries: unknown): boolean {
  if (Array.isArray(entries)) return entries.length > 0;
  if (typeof entries === 'string') {
    try {
      const v = JSON.parse(entries);
      return Array.isArray(v) && v.length > 0;
    } catch {
      return true; // non-empty but unparseable is still content
    }
  }
  return false;
}

/**
 * Reconcile the parsed projection against the ledger rows the settlement
 * actually wrote (spec §2). A mismatch is a programming/consistency error and
 * must abort the whole settlement transaction.
 */
function reconcileProjection(parsed: ParsedHand, args: ProjectHandArgs): void {
  const handId = parsed.hands.handId;
  const byUser = new Map<number, HandPlayerRow>();
  for (const p of parsed.players) {
    if (byUser.has(p.userId))
      throw new HandProjectionError(`duplicate user ${p.userId} in projection on hand ${handId}`);
    byUser.set(p.userId, p);
  }

  const check = (
    ledger: { userId: number; delta: number }[] | undefined,
    field: 'pokerDelta' | 'squidDelta',
    label: string,
  ): void => {
    if (!ledger) return;
    const want = new Map<number, number>();
    for (const l of ledger) want.set(l.userId, (want.get(l.userId) ?? 0) + l.delta);
    for (const uid of want.keys()) {
      if (!byUser.has(uid))
        throw new HandProjectionError(`${label} references unknown user ${uid} on hand ${handId}`);
    }
    for (const p of parsed.players) {
      const expected = want.get(p.userId) ?? 0;
      if (p[field] !== expected)
        throw new HandProjectionError(
          `${label} mismatch for user ${p.userId} on hand ${handId}: projection=${p[field]} ledger=${expected}`,
        );
    }
  };
  check(args.pokerLedger, 'pokerDelta', 'poker ledger');
  check(args.squidLedger, 'squidDelta', 'squid ledger');

  const sumPoker = parsed.players.reduce((s, p) => s + p.pokerDelta, 0);
  const sumSquid = parsed.players.reduce((s, p) => s + p.squidDelta, 0);
  if (args.rake !== undefined && sumPoker !== -args.rake)
    throw new HandProjectionError(
      `sum(poker_delta)=${sumPoker} != -rake=${-args.rake} on hand ${handId}`,
    );
  if (sumSquid !== 0)
    throw new HandProjectionError(`sum(squid_delta)=${sumSquid} != 0 on hand ${handId}`);
  for (const p of parsed.players) {
    if (p.netDelta !== p.pokerDelta + p.squidDelta)
      throw new HandProjectionError(
        `net_delta != poker+squid for user ${p.userId} on hand ${handId}`,
      );
  }

  // The actual stack update used `stackDeltas`; it must agree with the
  // projection and with poker+squid per user, with no unknown or duplicate user.
  if (args.stackDeltas) {
    const want = new Map<number, number>();
    for (const d of args.stackDeltas) {
      if (want.has(d.userId))
        throw new HandProjectionError(`duplicate stack delta for user ${d.userId} on hand ${handId}`);
      want.set(d.userId, d.delta);
    }
    for (const uid of want.keys()) {
      if (!byUser.has(uid))
        throw new HandProjectionError(`stack delta references unknown user ${uid} on hand ${handId}`);
    }
    for (const p of parsed.players) {
      const expected = want.get(p.userId) ?? 0;
      if (p.netDelta !== expected)
        throw new HandProjectionError(
          `stack delta mismatch for user ${p.userId} on hand ${handId}: projection=${p.netDelta} stackDelta=${expected}`,
        );
      if (p.pokerDelta + p.squidDelta !== expected)
        throw new HandProjectionError(
          `stack delta != poker+squid for user ${p.userId} on hand ${handId}`,
        );
    }
  }
}

/**
 * Remove one hand's projection atomically. Void cleanup and backfill re-runs
 * call this so a failure can never leave a half-deleted hand (some tables
 * cleared, others not).
 */
export function deleteHandProjection(db: DB, handId: string): void {
  db.transaction(() => {
    db.prepare('DELETE FROM hand_players WHERE hand_id = ?').run(handId);
    db.prepare('DELETE FROM hand_actions WHERE hand_id = ?').run(handId);
    db.prepare('DELETE FROM hands WHERE hand_id = ?').run(handId);
    db.prepare('DELETE FROM hand_projection_errors WHERE hand_id = ?').run(handId);
  })();
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

export interface BackfillReport {
  scanned: number;
  projected: number;
  skipped: number;
  voided: number;
  errors: number;
}

interface BackfillRow {
  hand_id: string;
  room_id: string;
  head: string;
  entries: string;
  ts: number;
  voided: number;
  existing_version: number | null;
  existing_status: string | null;
  existing_head: string | null;
  final_stacks: string | null;
}

/** Parse a `hand_settlements.final_stacks` JSON blob, if it is usable. */
function parseFinalStacks(
  raw: string | null | undefined,
): { userId: number; stack: number }[] | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v) || v.length === 0) return undefined;
    const out: { userId: number; stack: number }[] = [];
    for (const e of v) {
      if (!e || typeof e !== 'object') continue;
      const r = e as Record<string, unknown>;
      if (typeof r.userId === 'number' && typeof r.stack === 'number')
        out.push({ userId: r.userId, stack: r.stack });
    }
    return out.length ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Project historical transcripts into the three tables. Idempotent: a hand
 * already projected by the current parser version is skipped, voided hands are
 * removed from the projection, and every write replaces the hand's rows. The
 * original transcript / ledger / stack are never modified.
 *
 * Candidates are limited to hands with a `hand_settlements` marker (a finished,
 * confirmed hand) per spec §0/§7; aborted or never-settled transcripts are not
 * poker stats.
 */
export function backfillHandStats(db: DB, opts: { force?: boolean } = {}): BackfillReport {
  const rows = db
    .prepare(
      `SELECT t.hand_id, t.room_id, t.head, t.entries, t.ts,
              s.final_stacks AS final_stacks,
              ${voidHandExistsSql({ roomExpr: 't.room_id', handIdExpr: 't.hand_id', headExpr: 't.head' })} AS voided,
              (SELECT h.parser_version FROM hands h WHERE h.hand_id = t.hand_id) AS existing_version,
              (SELECT h.status FROM hands h WHERE h.hand_id = t.hand_id) AS existing_status,
              (SELECT h.source_head FROM hands h WHERE h.hand_id = t.hand_id) AS existing_head
         FROM transcripts t
         JOIN hand_settlements s ON s.hand_id = t.hand_id
        ORDER BY t.ts ASC`,
    )
    .all() as BackfillRow[];

  const report: BackfillReport = { scanned: rows.length, projected: 0, skipped: 0, voided: 0, errors: 0 };
  const now = Date.now();

  for (const row of rows) {
    try {
      if (row.voided) {
        // not a stats hand: make sure a previous backfill left nothing behind
        deleteHandProjection(db, row.hand_id);
        report.voided++;
        continue;
      }
      // A different transcript already occupies this hand_id's projection.
      // Never overwrite it, not even with --force.
      if (row.existing_head !== null && row.existing_head !== row.head) {
        db.transaction(() =>
          recordProjectionError(db, {
            handId: row.hand_id,
            sourceHead: row.head,
            code: 'head_mismatch',
            message: `hand_id already projected from source_head ${row.existing_head}`,
            now,
          }),
        )();
        report.errors++;
        continue;
      }
      if (
        !opts.force &&
        row.existing_version === HAND_PARSER_VERSION &&
        row.existing_status === 'settled'
      ) {
        report.skipped++;
        continue;
      }
      const parsed = parseHandEntries(row.entries, {
        handId: row.hand_id,
        roomId: row.room_id,
        head: row.head,
        entries: row.entries,
        transcriptTs: row.ts,
        voided: false,
        now,
        verifyHead: true,
        // The settlement marker's final stacks are the authoritative ending
        // balances. Without them the projection falls back to
        // starting_stack + net_delta and is flagged legacy, never exact.
        finalStacks: parseFinalStacks(row.final_stacks),
      });
      if (!parsed) {
        db.transaction(() =>
          recordProjectionError(db, {
            handId: row.hand_id,
            sourceHead: row.head,
            code: 'no_hand_start',
            message: 'transcript has no hand_start entry',
            now,
          }),
        )();
        report.errors++;
        continue;
      }
      // One transaction per hand: the write and the error-table cleanup land
      // together, or neither does.
      db.transaction(() => {
        writeParsedHand(db, parsed);
        db.prepare('DELETE FROM hand_projection_errors WHERE hand_id = ?').run(row.hand_id);
      })();
      report.projected++;
    } catch (err) {
      db.transaction(() =>
        recordProjectionError(db, {
          handId: row.hand_id,
          sourceHead: row.head,
          code: err instanceof HandProjectionError ? 'parse_error' : 'internal_error',
          message: err instanceof Error ? err.message : String(err),
          now,
        }),
      )();
      report.errors++;
    }
  }
  return report;
}

function recordProjectionError(
  db: DB,
  e: { handId: string; sourceHead: string | null; code: string; message: string; now: number },
): void {
  const existing = db
    .prepare('SELECT attempts, first_seen_at FROM hand_projection_errors WHERE hand_id = ?')
    .get(e.handId) as { attempts: number; first_seen_at: number } | undefined;
  db.prepare(
    `INSERT INTO hand_projection_errors
       (hand_id, source_head, parser_version, error_code, error_message, attempts, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(hand_id) DO UPDATE SET
       source_head = excluded.source_head,
       parser_version = excluded.parser_version,
       error_code = excluded.error_code,
       error_message = excluded.error_message,
       attempts = excluded.attempts,
       last_seen_at = excluded.last_seen_at`,
  ).run(
    e.handId,
    e.sourceHead,
    HAND_PARSER_VERSION,
    e.code,
    e.message,
    (existing?.attempts ?? 0) + 1,
    existing?.first_seen_at ?? e.now,
    e.now,
  );
}
