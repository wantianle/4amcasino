import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../src/db.js';
import {
  applyPreparedHandSettlement,
  persistPreparedInput,
  realClock,
  type GameOpts,
  type SettlementFaultPoint,
} from '../src/game.js';
import { verifyLedger } from '../src/ledger.js';
import { createApp } from '../src/app.js';
import { attachHub } from '../src/hub.js';
import { activeHands } from '../src/liveHands.js';
import { TestClient } from './helpers/testClient.js';
import { setupRoom, awaitHandEnd } from './helpers/testRoom.js';
import {
  SEED_TIME_BANK_EPOCH,
  count,
  lifecycle,
  makeWrite,
  seed,
  seedClaimedTrigger,
  transientFault,
} from './helpers/settlementFixture.js';

// ---------------------------------------------------------------------------
// P0-3: settlement fault injection.
//
// Two layers, because the durability boundary has two halves:
//
//   * the DB-only writer (`persistPreparedInput` -> `applyPreparedHandSettlement`
//     -> `applyHandSettlement`) is exercised directly. THAT is where "inside the
//     transaction" can be hit at a precise statement, and where a throw must be
//     a COMPLETE rollback (marker + stack + every ledger leg + transcript +
//     projection + gameplay state + lifecycle).
//   * the live room drives `GameOpts.faultInjection.phase` at the prepare and
//     broadcast boundaries, where the failure is a frozen-but-recoverable room
//     or a lost notification that must never undo committed money.
//
// The iron rule this suite is built around: a throw INSIDE `db.transaction` is
// NOT "a crash after commit". It rolls back. "Committed, then the process died"
// is modelled by letting the transaction RETURN and only then refusing to
// broadcast - never by throwing from within the transaction.
// ---------------------------------------------------------------------------

/** Every point inside the money transaction. A throw at ANY of them must leave
 *  the exact same terminal: nothing applied, a complete rollback. */
const SETTLEMENT_POINTS: SettlementFaultPoint[] = [
  'settlement_before_transaction',
  'settlement_after_marker',
  'settlement_after_stack',
  'settlement_after_poker_ledger',
  'settlement_after_squid_ledger',
  'settlement_after_commission',
  'settlement_after_seven_deuce',
  'settlement_after_transcript',
  'settlement_after_projection',
  'settlement_after_gameplay_state',
  'settlement_after_final_stacks',
  'settlement_after_lifecycle',
  'settlement_before_commit',
];

const ONE = (db: DB, sql: string, ...args: unknown[]): number => count(db, sql, ...args);

/** Prepared-row columns a rollback must leave byte-identical.
 *
 *  `attempts` is DELIBERATELY absent: `applyPreparedHandSettlement` bumps it
 *  BEFORE the money transaction (game.ts:1578-1580), so a rolled-back attempt
 *  still advances it. It is asserted separately via `preparedAttempts()`. */
function preparedState(db: DB, handId = 'h1'): {
  room_id: string;
  head: string;
  input_json: string;
  input_hash: string;
  resolved_at: number | null;
  resolved_by: number | null;
  resolution: string | null;
  last_error: string | null;
} {
  return db
    .prepare(
      `SELECT room_id, head, input_json, input_hash, resolved_at, resolved_by, resolution, last_error
       FROM hand_settlement_prepared WHERE hand_id = ?`,
    )
    .get(handId) as {
    room_id: string;
    head: string;
    input_json: string;
    input_hash: string;
    resolved_at: number | null;
    resolved_by: number | null;
    resolution: string | null;
    last_error: string | null;
  };
}

/** `attempts` lives OUTSIDE the money transaction, so it is EXPECTED to grow. */
function preparedAttempts(db: DB, handId = 'h1'): number {
  return (
    db.prepare('SELECT attempts FROM hand_settlement_prepared WHERE hand_id = ?').get(handId) as {
      attempts: number;
    }
  ).attempts;
}

/** Every money/audit fact the settlement transaction could write, EXCEPT the
 *  out-of-transaction `attempts` counter.
 *
 *  This is the "must not change on rollback" set: marker + transcript + every
 *  ledger leg (poker, squid, commission, 7-2) + stats projection + the full
 *  gameplay counters + per-player stacks AND the time-bank snapshot +
 *  commission-rate rows + the frozen prepared row's resolved state. */
function moneyState(db: DB) {
  return {
    settlements: ONE(db, 'SELECT COUNT(*) AS n FROM hand_settlements'),
    transcripts: ONE(db, 'SELECT COUNT(*) AS n FROM transcripts'),
    ledger: ONE(db, 'SELECT COUNT(*) AS n FROM ledger'),
    commissionRates: ONE(db, 'SELECT COUNT(*) AS n FROM hand_commission_rates'),
    hands: ONE(db, 'SELECT COUNT(*) AS n FROM hands'),
    handPlayers: ONE(db, 'SELECT COUNT(*) AS n FROM hand_players'),
    // Full gameplay counters, not just the row count: the writer increments
    // `completed_hands` and may stamp `last_bomb_*` in the same transaction.
    gameplay: db
      .prepare(
        `SELECT completed_hands, last_bomb_completed_hands, last_bomb_at, schedule_reset_at
         FROM room_gameplay_state WHERE room_id = ?`,
      )
      .all('r1'),
    // Stacks plus the per-player time-bank snapshot the same transaction writes.
    stacks: db
      .prepare(
        `SELECT user_id, stack, time_bank_ms, time_bank_hands, time_bank_epoch
         FROM room_players WHERE room_id = ? ORDER BY user_id`,
      )
      .all('r1'),
    triggers: db
      .prepare('SELECT id, status, claimed_hand_id FROM room_feature_triggers ORDER BY id')
      .all(),
    prepared: preparedState(db),
  };
}

/** Ledger rows written by the SETTLEMENT path only (buys are `purchase`). */
function settlementLedgerCount(db: DB, roomId: string): number {
  return count(
    db,
    "SELECT COUNT(*) AS n FROM ledger WHERE room_id = ? AND kind IN ('hand-settlement','squid-game','commission','seven-deuce')",
    roomId,
  );
}

describe('P0-3 B: a throw inside the money transaction is a COMPLETE rollback', () => {
  // Dry-run proof that the loop below is not vacuous: each point must actually
  // be reached (otherwise the injected error would surface as "not thrown").
  it('reaches every point (a hook that records the points it sees)', () => {
    const db = openDb(':memory:');
    seed(db);
    seedClaimedTrigger(db);
    persistPreparedInput(
      db,
      makeWrite({
        triggerIds: [1],
        timeBankEpoch: SEED_TIME_BANK_EPOCH,
        timeBanks: [
          { userId: 1, ms: 111, hands: 1 },
          { userId: 2, ms: 222, hands: 2 },
        ],
      }),
    );
    const seen: SettlementFaultPoint[] = [];
    const result = applyPreparedHandSettlement(db, 'h1', { phase: (p) => seen.push(p) });
    expect(result.status).toBe('applied');
    // Every transaction point is on the success path, in order.
    for (const p of SETTLEMENT_POINTS) expect(seen).toContain(p);
    expect(seen.indexOf('settlement_after_marker')).toBeLessThan(
      seen.indexOf('settlement_after_transcript'),
    );
    expect(seen.indexOf('settlement_after_transcript')).toBeLessThan(
      seen.indexOf('settlement_before_commit'),
    );
    expect(seen.indexOf('settlement_before_transaction')).toBe(
      seen.lastIndexOf('settlement_before_transaction'),
    );
    // Proof the new rollback targets are NOT vacuous on the success path:
    // a non-zero rake really wrote the commission leg...
    expect(ONE(db, 'SELECT COUNT(*) AS n FROM hand_commission_rates')).toBe(1);
    expect(
      ONE(db, "SELECT COUNT(*) AS n FROM ledger WHERE room_id = 'r1' AND kind = 'commission'"),
    ).toBe(1);
    // ...the time-bank snapshot really moved...
    expect(
      db
        .prepare(
          'SELECT time_bank_ms, time_bank_hands, time_bank_epoch FROM room_players WHERE room_id = ? AND user_id = ?',
        )
        .get('r1', 1),
    ).toEqual({ time_bank_ms: 111, time_bank_hands: 1, time_bank_epoch: SEED_TIME_BANK_EPOCH });
    // ...and the gameplay counters really advanced from the seeded row.
    expect(
      db
        .prepare(
          'SELECT completed_hands, last_bomb_completed_hands, last_bomb_at, schedule_reset_at FROM room_gameplay_state WHERE room_id = ?',
        )
        .get('r1'),
    ).toEqual({
      completed_hands: 8,
      last_bomb_completed_hands: 2,
      last_bomb_at: 1111,
      schedule_reset_at: 2222,
    });
    db.close();
  });

  it.each(SETTLEMENT_POINTS)(
    '%s rolls back EVERY fact and retries with the same input_hash',
    (point) => {
      const db = openDb(':memory:');
      seed(db);
      seedClaimedTrigger(db);
      const { hash } = persistPreparedInput(
        db,
        makeWrite({
          triggerIds: [1],
          timeBankEpoch: SEED_TIME_BANK_EPOCH,
          timeBanks: [
            { userId: 1, ms: 111, hands: 1 },
            { userId: 2, ms: 222, hands: 2 },
          ],
        }),
      );
      const before = moneyState(db);
      const attemptsBefore = preparedAttempts(db);

      let thrown: unknown;
      try {
        applyPreparedHandSettlement(db, 'h1', {
          phase: (p) => {
            if (p === point) throw transientFault(`injected at ${p}`);
          },
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      // A transient-coded fault is NOT a quarantine: it stays retryable.
      expect((thrown as Error).name).not.toBe('PreparedInputError');

      // ---- complete rollback: not just the marker ----
      expect(lifecycle(db)).toBe('prepared');
      // Everything durable the transaction touches is byte-identical.
      expect(moneyState(db)).toEqual(before);
      // `attempts` is bumped OUTSIDE the transaction, so it must MOVE even
      // though the money rolled back. Asserting it separately keeps the
      // equality above honest (it could never pass if attempts were included).
      expect(preparedAttempts(db)).toBe(attemptsBefore + 1);

      // The frozen input itself is untouched and unresolved.
      const prep = db
        .prepare('SELECT input_hash, resolved_at FROM hand_settlement_prepared WHERE hand_id = ?')
        .get('h1') as { input_hash: string; resolved_at: number | null };
      expect(prep.input_hash).toBe(hash);
      expect(prep.resolved_at).toBeNull();

      // ---- retry reads the SAME frozen input and settles once ----
      const retry = applyPreparedHandSettlement(db, 'h1', {
        resolvedBy: 9,
        resolution: 'operator_retry',
      });
      expect(retry.status).toBe('applied');
      expect(lifecycle(db)).toBe('committed');
      expect(ONE(db, 'SELECT COUNT(*) AS n FROM hand_settlements WHERE hand_id = ?', 'h1')).toBe(1);
      expect(ONE(db, 'SELECT COUNT(*) AS n FROM transcripts WHERE hand_id = ?', 'h1')).toBe(1);
      expect(ONE(db, 'SELECT COUNT(*) AS n FROM hands WHERE hand_id = ?', 'h1')).toBe(1);
      expect(ONE(db, 'SELECT COUNT(*) AS n FROM hand_players WHERE hand_id = ?', 'h1')).toBe(2);
      expect(verifyLedger(db, 'r1').ok).toBe(true);
      expect(
        (
          db
            .prepare('SELECT input_hash FROM hand_settlement_prepared WHERE hand_id = ?')
            .get('h1') as { input_hash: string }
        ).input_hash,
      ).toBe(hash);

      const ledgerRows = ONE(db, 'SELECT COUNT(*) AS n FROM ledger');
      expect(ledgerRows).toBeGreaterThan(0);
      // conservation held through the retry
      expect(
        (
          db
            .prepare('SELECT COALESCE(SUM(stack), 0) AS n FROM room_players WHERE room_id = ?')
            .get('r1') as { n: number }
        ).n,
      ).toBe(2000);

      // Exactly one set of books from the retry.
      expect(ONE(db, 'SELECT COUNT(*) AS n FROM ledger')).toBe(ledgerRows);
      expect(ONE(db, 'SELECT COUNT(*) AS n FROM hand_settlements WHERE hand_id = ?', 'h1')).toBe(1);
      db.close();
    },
  );

  it('a plain (unexpected) error inside the transaction is fail-closed: quarantine, no money', () => {
    const db = openDb(':memory:');
    seed(db);
    const { hash } = persistPreparedInput(db, makeWrite());
    const before = moneyState(db);
    const attemptsBefore = preparedAttempts(db);
    expect(() =>
      applyPreparedHandSettlement(db, 'h1', {
        phase: (p) => {
          // Not transient-coded: this is a programming error, not contention.
          if (p === 'settlement_after_marker') throw new Error('injected programming error');
        },
      }),
    ).toThrow(/injected programming error/);
    expect(lifecycle(db)).toBe('quarantined');
    // Nothing on the books moved.
    const after = moneyState(db);
    const { prepared: beforePrepared, ...beforeBooks } = before;
    const { prepared: afterPrepared, ...afterBooks } = after;
    expect(afterBooks).toEqual(beforeBooks);
    // The frozen input is still byte-identical; quarantine only stamps the
    // failure evidence onto the prepared row's `last_error`.
    expect(afterPrepared).toEqual({
      ...beforePrepared,
      last_error: 'injected programming error',
    });
    // `attempts` still moved, because it is bumped outside the transaction.
    expect(preparedAttempts(db)).toBe(attemptsBefore + 1);
    expect(
      (
        db
          .prepare('SELECT input_hash FROM hand_settlement_prepared WHERE hand_id = ?')
          .get('h1') as { input_hash: string }
      ).input_hash,
    ).toBe(hash);
    db.close();
  });

  it('a retry of an already-settled hand is an idempotent duplicate', () => {
    const db = openDb(':memory:');
    seed(db);
    persistPreparedInput(db, makeWrite());
    expect(applyPreparedHandSettlement(db, 'h1').status).toBe('applied');
    const ledgerRows = ONE(db, 'SELECT COUNT(*) AS n FROM ledger');
    for (let i = 0; i < 3; i++)
      expect(applyPreparedHandSettlement(db, 'h1').status).toBe('duplicate');
    expect(ONE(db, 'SELECT COUNT(*) AS n FROM ledger')).toBe(ledgerRows);
    expect(ONE(db, 'SELECT COUNT(*) AS n FROM hand_settlements')).toBe(1);
    expect(ONE(db, 'SELECT COUNT(*) AS n FROM transcripts')).toBe(1);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Restart validation: prepare -> process exit -> operator retry from the SAME
// file DB. The frozen input must settle exactly once, never twice.
// ---------------------------------------------------------------------------

describe('P0-3: prepare -> restart -> retry settles exactly once', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('a committed prepared row reopens and settles one set of books', () => {
    const dir = mkdtempSync(join(tmpdir(), '4am-p03-'));
    dirs.push(dir);
    const path = join(dir, 'game.db');
    let db = openDb(path);
    seed(db);
    const { hash } = persistPreparedInput(db, makeWrite());
    expect(lifecycle(db)).toBe('prepared');
    // "process exit" between prepare and settle.
    db.close();

    db = openDb(path);
    expect(
      (
        db
          .prepare('SELECT input_hash FROM hand_settlement_prepared WHERE hand_id = ?')
          .get('h1') as { input_hash: string }
      ).input_hash,
    ).toBe(hash);
    // Operator retry from the durable input only.
    const first = applyPreparedHandSettlement(db, 'h1', {
      resolvedBy: 9,
      resolution: 'operator_retry',
    });
    expect(first.status).toBe('applied');
    expect(lifecycle(db)).toBe('committed');
    expect(ONE(db, 'SELECT COUNT(*) AS n FROM hand_settlements WHERE hand_id = ?', 'h1')).toBe(1);
    expect(ONE(db, 'SELECT COUNT(*) AS n FROM transcripts WHERE hand_id = ?', 'h1')).toBe(1);
    expect(ONE(db, 'SELECT COUNT(*) AS n FROM hands WHERE hand_id = ?', 'h1')).toBe(1);
    const ledgerRows = ONE(db, 'SELECT COUNT(*) AS n FROM ledger');
    expect(ledgerRows).toBeGreaterThan(0);
    expect(verifyLedger(db, 'r1').ok).toBe(true);
    expect(
      (
        db
          .prepare('SELECT COALESCE(SUM(stack), 0) AS n FROM room_players WHERE room_id = ?')
          .get('r1') as { n: number }
      ).n,
    ).toBe(2000);
    // Repeated retries never add books.
    for (let i = 0; i < 3; i++)
      expect(applyPreparedHandSettlement(db, 'h1').status).toBe('duplicate');
    expect(ONE(db, 'SELECT COUNT(*) AS n FROM ledger')).toBe(ledgerRows);
    expect(ONE(db, 'SELECT COUNT(*) AS n FROM hand_settlements WHERE hand_id = ?', 'h1')).toBe(1);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Live room: the hook wires through GameOpts and every boundary behaves.
// ---------------------------------------------------------------------------

type Live = { ctx: ReturnType<typeof createApp>; hub: ReturnType<typeof attachHub>; baseUrl: string };

async function startLive(onPhase: (p: SettlementFaultPoint) => void): Promise<Live> {
  const ctx = createApp(':memory:');
  const opts: Partial<GameOpts> = {
    cryptoTimeoutMs: 1500,
    actionTimeoutMs: 1500,
    autoDealMs: 3_600_000,
    readyCheckMs: 1500,
    showdownHoldMs: 200,
    settleHoldMs: 0,
    ritVoteMs: 1500,
    clock: realClock,
    faultInjection: { phase: onPhase },
  };
  const hub = attachHub(ctx.app, ctx.db, opts);
  await ctx.app.listen({ port: 0 });
  const addr = ctx.app.server.address() as AddressInfo;
  return { ctx, hub, baseUrl: `http://127.0.0.1:${addr.port}` };
}

/** The single hand id a room currently holds in a pending lifecycle state. */
function pendingHandId(ctx: ReturnType<typeof createApp>, roomId: string): string {
  const row = ctx.db
    .prepare(
      "SELECT hand_id FROM hand_lifecycle WHERE room_id = ? AND status IN ('running','prepared','quarantined') ORDER BY rowid DESC LIMIT 1",
    )
    .get(roomId) as { hand_id: string } | undefined;
  if (!row) throw new Error(`no pending hand for room ${roomId}`);
  return row.hand_id;
}

describe('P0-3 A (live): prepare boundary faults', () => {
  it('prepare_before leaves `running`, writes nothing, and freezes the room', async () => {
    const { ctx, hub, baseUrl } = await startLive((p) => {
      if (p === 'prepare_before') throw new Error('injected prepare_before failure');
    });
    const clients: TestClient[] = [];
    try {
      const { room, host } = await setupRoom(
        baseUrl,
        ['pba', 'pbb'],
        ['passive', 'passive'],
        clients,
      );
      const gameRoom = hub.rooms.get(room.id)!;
      host.send({ t: 'start_hand' });
      await host.waitFor(() => gameRoom.isUnhealthy(), 15000);
      const handId = pendingHandId(ctx, room.id);
      expect(lifecycle(ctx.db, handId)).toBe('running');
      expect(
        ONE(ctx.db, 'SELECT COUNT(*) AS n FROM hand_settlement_prepared WHERE hand_id = ?', handId),
      ).toBe(0);
      expect(
        ONE(ctx.db, 'SELECT COUNT(*) AS n FROM hand_settlements WHERE hand_id = ?', handId),
      ).toBe(0);
      expect(ONE(ctx.db, 'SELECT COUNT(*) AS n FROM transcripts WHERE hand_id = ?', handId)).toBe(
        0,
      );
      expect(settlementLedgerCount(ctx.db, room.id)).toBe(0);
      // Frozen: the next deal is refused while the pending hand is unresolved.
      host.errors = [];
      host.send({ t: 'start_hand' });
      await host.waitFor(
        () => host.errors.some((e) => /hand already running|held for an operator|frozen/i.test(e)),
        3000,
      );
    } finally {
      for (const c of clients) c.close();
      await ctx.app.close();
    }
  }, 30000);

  it('prepare_after leaves `prepared` with the frozen row but no money facts', async () => {
    const { ctx, hub, baseUrl } = await startLive((p) => {
      if (p === 'prepare_after') throw new Error('injected prepare_after failure');
    });
    const clients: TestClient[] = [];
    try {
      const { room, host } = await setupRoom(
        baseUrl,
        ['pca', 'pcb'],
        ['passive', 'passive'],
        clients,
      );
      const gameRoom = hub.rooms.get(room.id)!;
      host.send({ t: 'start_hand' });
      await host.waitFor(() => gameRoom.isUnhealthy(), 15000);
      const handId = pendingHandId(ctx, room.id);
      expect(lifecycle(ctx.db, handId)).toBe('prepared');
      expect(
        ONE(ctx.db, 'SELECT COUNT(*) AS n FROM hand_settlement_prepared WHERE hand_id = ?', handId),
      ).toBe(1);
      expect(
        ONE(ctx.db, 'SELECT COUNT(*) AS n FROM hand_settlements WHERE hand_id = ?', handId),
      ).toBe(0);
      expect(ONE(ctx.db, 'SELECT COUNT(*) AS n FROM transcripts WHERE hand_id = ?', handId)).toBe(
        0,
      );
      expect(settlementLedgerCount(ctx.db, room.id)).toBe(0);
      expect(ONE(ctx.db, 'SELECT COUNT(*) AS n FROM hand_players WHERE hand_id = ?', handId)).toBe(
        0,
      );
      // A restart could retry from this frozen row; the point is it exists.
      const prep = ctx.db
        .prepare('SELECT input_hash FROM hand_settlement_prepared WHERE hand_id = ?')
        .get(handId) as { input_hash: string };
      expect(prep.input_hash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      for (const c of clients) c.close();
      await ctx.app.close();
    }
  }, 30000);
});

describe('P0-3 B (live): the mid-transaction fault freezes then retries once', () => {
  it('a transient fault at settlement_after_marker rolls back, freezes, then retries with the same hash', async () => {
    let arm = true;
    const { ctx, hub, baseUrl } = await startLive((p) => {
      if (arm && p === 'settlement_after_marker')
        throw transientFault('injected mid-transaction fault');
    });
    const clients: TestClient[] = [];
    try {
      const { room, host } = await setupRoom(
        baseUrl,
        ['mta', 'mtb'],
        ['passive', 'passive'],
        clients,
      );
      const gameRoom = hub.rooms.get(room.id)!;
      host.send({ t: 'start_hand' });
      await host.waitFor(() => gameRoom.isUnhealthy(), 15000);
      const handId = pendingHandId(ctx, room.id);
      expect(lifecycle(ctx.db, handId)).toBe('prepared');
      // Full rollback at the live boundary too: no marker/transcript/ledger.
      expect(
        ONE(ctx.db, 'SELECT COUNT(*) AS n FROM hand_settlements WHERE hand_id = ?', handId),
      ).toBe(0);
      expect(ONE(ctx.db, 'SELECT COUNT(*) AS n FROM transcripts WHERE hand_id = ?', handId)).toBe(
        0,
      );
      expect(settlementLedgerCount(ctx.db, room.id)).toBe(0);
      expect(ONE(ctx.db, 'SELECT COUNT(*) AS n FROM hand_players WHERE hand_id = ?', handId)).toBe(
        0,
      );
      const prep = ctx.db
        .prepare(
          'SELECT input_hash, resolved_at, attempts FROM hand_settlement_prepared WHERE hand_id = ?',
        )
        .get(handId) as { input_hash: string; resolved_at: number | null; attempts: number };
      expect(prep.resolved_at).toBeNull();
      expect(prep.attempts).toBeGreaterThan(0);

      // Disarm the fault and let the host retry: same frozen input, one settlement.
      arm = false;
      host.send({ t: 'retry_settlement' });
      await host.waitFor(
        () =>
          ONE(
            ctx.db,
            'SELECT COUNT(*) AS n FROM hand_settlements WHERE hand_id = ?',
            handId,
          ) === 1,
        10000,
      );
      await host.waitFor(() => host.handEnd?.handId === handId, 8000);
      expect(gameRoom.isUnhealthy()).toBe(false);
      expect(ONE(ctx.db, 'SELECT COUNT(*) AS n FROM transcripts WHERE hand_id = ?', handId)).toBe(1);
      const prepAfter = ctx.db
        .prepare('SELECT input_hash, resolved_at FROM hand_settlement_prepared WHERE hand_id = ?')
        .get(handId) as { input_hash: string; resolved_at: number | null };
      expect(prepAfter.input_hash).toBe(prep.input_hash);
      expect(prepAfter.resolved_at).not.toBeNull();
      expect(verifyLedger(ctx.db, room.id).ok).toBe(true);
      expect(
        ONE(ctx.db, 'SELECT COUNT(*) AS n FROM hand_settlements WHERE hand_id = ?', handId),
      ).toBe(1);
    } finally {
      for (const c of clients) c.close();
      await ctx.app.close();
    }
  }, 30000);
});

describe('P0-3 C/D (live): a lost broadcast after commit never undoes money', () => {
  it('broadcast_before_showdown: money durable, hand_end still runs, reconnect recovers', async () => {
    const { ctx, hub, baseUrl } = await startLive((p) => {
      if (p === 'broadcast_before_showdown') throw new Error('injected lost showdown frame');
    });
    const clients: TestClient[] = [];
    try {
      const { room, host, players } = await setupRoom(
        baseUrl,
        ['cda', 'cdb'],
        ['passive', 'passive'],
        clients,
      );
      const gameRoom = hub.rooms.get(room.id)!;
      host.send({ t: 'start_hand' });
      await awaitHandEnd(players, 15000);
      const handId = host.handEnd!.handId;
      expect(lifecycle(ctx.db, handId)).toBe('committed');
      expect(
        ONE(ctx.db, 'SELECT COUNT(*) AS n FROM hand_settlements WHERE hand_id = ?', handId),
      ).toBe(1);
      expect(ONE(ctx.db, 'SELECT COUNT(*) AS n FROM transcripts WHERE hand_id = ?', handId)).toBe(1);
      expect(ONE(ctx.db, 'SELECT COUNT(*) AS n FROM ledger WHERE room_id = ?', room.id)).toBeGreaterThan(
        0,
      );
      expect(ONE(ctx.db, 'SELECT COUNT(*) AS n FROM hand_players WHERE hand_id = ?', handId)).toBe(2);
      // The showdown frame was lost by design; the committed settlement was not.
      expect(host.sawShowdown).toBe(false);
      expect(gameRoom.isUnhealthy()).toBe(false);

      // Reconnect: the retained terminal / durable recovery still answers.
      const endsBefore = host.handEndCount;
      host.disconnect();
      await host.connect(room.id);
      await host.waitFor(
        () => host.handEndCount > endsBefore || host.handRecoveries.some((r) => r.handId === handId),
        5000,
      );
      expect(
        (host.handEndCount > endsBefore && host.handEnd?.handId === handId) ||
          host.handRecoveries.find((r) => r.handId === handId)?.status === 'committed',
      ).toBe(true);
    } finally {
      for (const c of clients) c.close();
      await ctx.app.close();
    }
  }, 30000);

  it('broadcast_after_showdown: the reveal was delivered and the throw is swallowed', async () => {
    const { ctx, hub, baseUrl } = await startLive((p) => {
      if (p === 'broadcast_after_showdown') throw new Error('injected post-showdown throw');
    });
    const clients: TestClient[] = [];
    try {
      const { room, host, players } = await setupRoom(
        baseUrl,
        ['cea', 'ceb'],
        ['passive', 'passive'],
        clients,
      );
      const gameRoom = hub.rooms.get(room.id)!;
      host.send({ t: 'start_hand' });
      await awaitHandEnd(players, 15000);
      const handId = host.handEnd!.handId;
      expect(players[0]!.sawShowdown).toBe(true);
      expect(lifecycle(ctx.db, handId)).toBe('committed');
      expect(
        ONE(ctx.db, 'SELECT COUNT(*) AS n FROM hand_settlements WHERE hand_id = ?', handId),
      ).toBe(1);
      expect(gameRoom.isUnhealthy()).toBe(false);
    } finally {
      for (const c of clients) c.close();
      await ctx.app.close();
    }
  }, 30000);

  it('broadcast_before_squid: the squid leg stays committed, hand_end still runs', async () => {
    const { ctx, hub, baseUrl } = await startLive((p) => {
      if (p === 'broadcast_before_squid') throw new Error('injected lost squid frame');
    });
    const clients: TestClient[] = [];
    try {
      const { room, host, players } = await setupRoom(
        baseUrl,
        ['cfa', 'cfb'],
        ['fold-first', 'passive'],
        clients,
      );
      await host.api(
        `/api/rooms/${room.id}/settings`,
        { features: { squid: { enabled: true, penaltyBb: 1, minPlayers: 2 } } },
        'PUT',
      );
      await host.api(`/api/rooms/${room.id}/feature-triggers`, {
        feature: 'squid',
        requestId: 'p03-sq-1',
      });
      const gameRoom = hub.rooms.get(room.id)!;
      host.send({ t: 'start_hand' });
      await awaitHandEnd(players, 15000);
      const handId = host.handEnd!.handId;
      expect(lifecycle(ctx.db, handId)).toBe('committed');
      expect(
        ONE(
          ctx.db,
          "SELECT COUNT(*) AS n FROM ledger WHERE room_id = ? AND kind = 'squid-game'",
          room.id,
        ),
      ).toBe(2);
      expect(host.handEnd!.squidDeltas!.reduce((s, d) => s + d.delta, 0)).toBe(0);
      // The frame really was lost: the phase hook threw before room.broadcast,
      // so no client ever saw `squid_result`. This is the direct proof that
      // "lost notification" (not just "money committed") is what happened.
      expect(host.squidResult).toBeNull();
      expect(players[1]!.squidResult).toBeNull();
      expect(gameRoom.isUnhealthy()).toBe(false);
    } finally {
      for (const c of clients) c.close();
      await ctx.app.close();
    }
  }, 30000);

  it('broadcast_before_seven_deuce: the bounty is already durable and stays paid', async () => {
    const { ctx, hub, baseUrl } = await startLive((p) => {
      if (p === 'broadcast_before_seven_deuce') throw new Error('injected lost 7-2 frame');
    });
    const clients: TestClient[] = [];
    try {
      const { room, host, players } = await setupRoom(
        baseUrl,
        ['cga', 'cgb'],
        ['passive', 'passive'],
        clients,
      );
      ctx.db.prepare('UPDATE rooms SET seven_deuce_bonus = ? WHERE id = ?').run(25, room.id);
      // Deterministic deal: seat 0 holds 7-2 offsuit and wins at showdown.
      const identity = Array.from({ length: 52 }, (_, i) => i);
      const wanted = [0, 4, 21, 8, 20, 22, 23, 31, 47];
      const seen = new Set(wanted);
      const q = [...wanted, ...identity.filter((i) => !seen.has(i))];
      host.forcedShufflePerm = identity;
      players[1]!.forcedShufflePerm = q;

      const gameRoom = hub.rooms.get(room.id)!;
      host.send({ t: 'start_hand' });
      await awaitHandEnd(players, 15000);
      const handId = host.handEnd!.handId;
      expect(lifecycle(ctx.db, handId)).toBe('committed');
      const bounty = ctx.db
        .prepare("SELECT delta FROM ledger WHERE room_id = ? AND kind = 'seven-deuce'")
        .all(room.id) as { delta: number }[];
      expect(bounty).toHaveLength(2);
      expect(bounty.reduce((s, r) => s + r.delta, 0)).toBe(0);
      expect(bounty.find((r) => r.delta === 25)).toBeTruthy();
      // The `seven_deuce` frame really was lost: the phase hook threw before
      // room.broadcast, so no client ever saw it even though the bounty is
      // durably in the ledger.
      expect(host.sevenDeuceResult).toBeNull();
      expect(players[1]!.sevenDeuceResult).toBeNull();
      expect(gameRoom.isUnhealthy()).toBe(false);
    } finally {
      for (const c of clients) c.close();
      await ctx.app.close();
    }
  }, 30000);
});

describe('P0-3 E (live): a lost hand_end is still remembered and recoverable', () => {
  it('broadcast_before_hand_end: money durable, onDone runs, next hand starts, reconnect gets hand_end', async () => {
    let arm = true;
    const { ctx, hub, baseUrl } = await startLive((p) => {
      if (arm && p === 'broadcast_before_hand_end') throw new Error('injected lost hand_end frame');
    });
    const clients: TestClient[] = [];
    try {
      const { room, host, players } = await setupRoom(
        baseUrl,
        ['eha', 'ehb'],
        ['passive', 'passive'],
        clients,
      );
      const gameRoom = hub.rooms.get(room.id)!;
      host.send({ t: 'start_hand' });
      // The frame was lost: synchronise on the durable commit + room release.
      await host.waitFor(
        () =>
          ONE(
            ctx.db,
            "SELECT COUNT(*) AS n FROM hand_settlements s JOIN hand_lifecycle l ON l.hand_id = s.hand_id WHERE l.room_id = ? AND l.status = 'committed'",
            room.id,
          ) === 1,
        15000,
      );
      const handId = (
        ctx.db
          .prepare(
            "SELECT hand_id FROM hand_lifecycle WHERE room_id = ? AND status = 'committed' ORDER BY rowid DESC LIMIT 1",
          )
          .get(room.id) as { hand_id: string }
      ).hand_id;
      await host.waitIdle(room.id, 8000);
      expect(host.handEnd).toBeNull(); // lost live
      expect(
        ONE(ctx.db, 'SELECT COUNT(*) AS n FROM hand_settlements WHERE hand_id = ?', handId),
      ).toBe(1);
      expect(gameRoom.isUnhealthy()).toBe(false);

      // Reconnect: the terminal frame was remembered, so it is replayed.
      arm = false;
      host.disconnect();
      await host.connect(room.id);
      await host.waitFor(() => host.handEnd?.handId === handId, 5000);

      // onDone ran, so the next hand can be dealt.
      host.errors = [];
      host.send({ t: 'start_hand' });
      await host.waitFor(() => host.handId !== null && host.handId !== handId, 10000);
      expect(activeHands.has(room.id)).toBe(true);
    } finally {
      for (const c of clients) c.close();
      await ctx.app.close();
    }
  }, 30000);

  it('broadcast_after_hand_end: the frame was delivered and the throw is swallowed', async () => {
    let arm = true;
    const { ctx, hub, baseUrl } = await startLive((p) => {
      if (arm && p === 'broadcast_after_hand_end') throw new Error('injected post-hand_end throw');
    });
    const clients: TestClient[] = [];
    try {
      const { room, host, players } = await setupRoom(
        baseUrl,
        ['eia', 'eib'],
        ['passive', 'passive'],
        clients,
      );
      const gameRoom = hub.rooms.get(room.id)!;
      host.send({ t: 'start_hand' });
      await awaitHandEnd(players, 15000);
      const handId = host.handEnd!.handId;
      expect(lifecycle(ctx.db, handId)).toBe('committed');
      expect(
        ONE(ctx.db, 'SELECT COUNT(*) AS n FROM hand_settlements WHERE hand_id = ?', handId),
      ).toBe(1);
      expect(gameRoom.isUnhealthy()).toBe(false);
      // onDone ran despite the swallowed throw, so the next hand can be dealt.
      await host.waitIdle(room.id, 8000);
      arm = false;
      host.errors = [];
      host.send({ t: 'start_hand' });
      await host.waitFor(() => host.handId !== null && host.handId !== handId, 10000);
    } finally {
      for (const c of clients) c.close();
      await ctx.app.close();
    }
  }, 30000);
});
