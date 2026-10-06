import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commissionForPot, NEW_ROOM_COMMISSION_BPS } from '@4am/shared';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { appendLedger, verifyLedger } from '../src/ledger.js';
import { ROOM_FEATURE_DEFAULTS } from '../src/gameplaySettings.js';

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

describe('default-on room policy', () => {
  it('creates a room with every new-gameplay feature and the watch/TV toggles on', async () => {
    const host = await user('on_host');
    const room = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/rooms',
        headers: { authorization: `Bearer ${host.token}` },
        payload: { name: 'r', sb: 1, bb: 2 },
      })
    ).json();
    expect(room.features).toEqual(ROOM_FEATURE_DEFAULTS);
    expect(room.features.squid.enabled).toBe(true);
    expect(room.features.timeBank.enabled).toBe(true);
    expect(room.features.bombPot.enabled).toBe(true);
    expect(room.features.multiRun.enabled).toBe(true);
    expect(room.allowSpectators).toBe(true);
    expect(room.tvReplays).toBe(true);
    // The point of this route: every one of these is written explicitly by the
    // INSERT, so the stored row carries the default-on values regardless of the
    // column DEFAULT. Asserting the row (not only the schema) matters because
    // the create route used to write `autoApproveBuys ? 1 : 0` and store 0 when
    // the field was omitted.
    const stored = ctx.db
      .prepare(
        `SELECT auto_approve_buys AS autoApproveBuys, allow_spectators AS allowSpectators,
                tv_replays AS tvReplays, squid_enabled AS squid, time_bank_enabled AS timeBank,
                bomb_pot_enabled AS bombPot, multi_run_enabled AS multiRun
         FROM rooms WHERE id = ?`,
      )
      .get(room.id);
    expect(stored).toEqual({
      autoApproveBuys: 1,
      allowSpectators: 1,
      tvReplays: 1,
      squid: 1,
      timeBank: 1,
      bombPot: 1,
      multiRun: 1,
    });
    // `false` must still be expressible now that the schema defaults to true.
    const offRoom = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/rooms',
        headers: { authorization: `Bearer ${host.token}` },
        payload: { name: 'r-off', sb: 1, bb: 2, autoApproveBuys: false },
      })
    ).json();
    expect(offRoom.autoApproveBuys).toBe(false);
    expect(
      ctx.db.prepare('SELECT auto_approve_buys AS v FROM rooms WHERE id = ?').get(offRoom.id),
    ).toEqual({ v: 0 });
    // And the fresh-database column default itself is the new policy.
    const dflt = ctx.db
      .prepare("SELECT dflt_value AS v FROM pragma_table_info('rooms') WHERE name = 'auto_approve_buys'")
      .get() as { v: string };
    expect(dflt.v).toBe('1');
  });

  it('keeps a host able to turn a feature back off', async () => {
    const host = await user('off_host');
    const room = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/rooms',
        headers: { authorization: `Bearer ${host.token}` },
        payload: { name: 'r', sb: 1, bb: 2 },
      })
    ).json();
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/rooms/${room.id}/settings`,
      headers: { authorization: `Bearer ${host.token}` },
      payload: { features: { squid: { enabled: false } } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().features.squid.enabled).toBe(false);
  });
});

describe('one-time upgrade of existing rooms', () => {
  it('flips old rooms on, re-rates them to 0.5%, and is idempotent across restarts', () => {
    const dir = mkdtempSync(join(tmpdir(), '4am-room-defaults-'));
    const path = join(dir, 'test.db');
    let db = openDb(path);
    try {
      // Seed a room exactly as the old default-off policy stored it.
      db.prepare(
        `INSERT INTO rooms
           (id, name, join_code, host_id, banker_id, sb, bb, created_at, commission_bps,
            allow_spectators, tv_replays, auto_approve_buys,
            squid_enabled, time_bank_enabled, bomb_pot_enabled, multi_run_enabled)
         VALUES ('old', 'Old table', 'OLD001', 1, 1, 10, 20, 1, 100, 0, 0, 0, 0, 0, 0, 0)`,
      ).run();
      db.prepare(
        'INSERT INTO room_players (room_id, user_id, time_bank_ms, time_bank_hands, time_bank_epoch) VALUES (?, ?, 0, 0, 0)',
      ).run('old', 1);
      appendLedger(db, {
        roomId: 'old',
        userId: 1,
        delta: 20,
        kind: 'commission',
        ref: 'old-hand',
        note: '1% table commission',
      });
      const ledger = db.prepare('SELECT * FROM ledger').all();
      // Drop the markers so the next open looks like a pre-migration install.
      db.prepare("DELETE FROM meta WHERE key IN ('room-defaults-on-1','commission-0.5-1')").run();
      db.close();

      db = openDb(path);
      const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get('old') as Record<
        string,
        number
      >;
      // 1) toggles on
      expect(room.allow_spectators).toBe(1);
      expect(room.tv_replays).toBe(1);
      expect(room.auto_approve_buys).toBe(1);
      // 2) every gameplay feature on
      expect(room.squid_enabled).toBe(1);
      expect(room.time_bank_enabled).toBe(1);
      expect(room.bomb_pot_enabled).toBe(1);
      expect(room.multi_run_enabled).toBe(1);
      // enabling the time bank also seeds the per-player bank via applyRoomFeatures
      expect(
        db
          .prepare('SELECT time_bank_ms AS ms, time_bank_hands AS h FROM room_players WHERE room_id = ?')
          .get('old'),
      ).toEqual({ ms: 30_000, h: 0 });
      // 3) re-rated to 0.5%, historical ledger untouched
      expect(room.commission_bps).toBe(NEW_ROOM_COMMISSION_BPS);
      expect(
        db
          .prepare('SELECT commission_bps FROM hand_commission_rates WHERE room_id = ? AND ref = ?')
          .get('old', 'old-hand'),
      ).toEqual({ commission_bps: 100 });
      expect(db.prepare('SELECT * FROM ledger').all()).toEqual(ledger);
      expect(verifyLedger(db, 'old').ok).toBe(true);
      // the migrated rate is what a future settlement computes with
      expect(commissionForPot(4000, room.commission_bps!)).toBe(20); // 0.5%; the old 1% was 40
      db.close();

      // Idempotency: a deliberate host opt-out after the migration survives a restart.
      db = openDb(path);
      db.prepare('UPDATE rooms SET squid_enabled = 0 WHERE id = ?').run('old');
      db.close();
      db = openDb(path);
      expect(db.prepare('SELECT squid_enabled FROM rooms WHERE id = ?').get('old')).toEqual({
        squid_enabled: 0,
      });
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key IN ('room-defaults-on-1','commission-0.5-1')").get(),
      ).toEqual({ n: 2 });
      expect(db.prepare('SELECT * FROM ledger').all()).toEqual(ledger);
    } finally {
      if (db.open) db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizes a legacy time-bank config to the fixed 5-card package once', () => {
    const dir = mkdtempSync(join(tmpdir(), '4am-tb-fixed-'));
    const path = join(dir, 'test.db');
    let db = openDb(path);
    try {
      // A room stored under the old tunable rules: bank off, 5s start,
      // refill-every-30-hands, 60s refill, and a player with a huge balance.
      db.prepare(
        `INSERT INTO rooms
           (id, name, join_code, host_id, banker_id, sb, bb, created_at, commission_bps,
            time_bank_enabled, time_bank_initial_secs, time_bank_refill_every_hands,
            time_bank_refill_secs)
         VALUES ('legacy', 'Legacy', 'LEG001', 1, 1, 10, 20, 1, 50, 0, 5, 30, 60)`,
      ).run();
      db.prepare(
        `INSERT INTO room_players
           (room_id, user_id, time_bank_ms, time_bank_hands, time_bank_epoch)
         VALUES ('legacy', 7, 999999999, 4, 3)`,
      ).run();
      // Look like a pre-upgrade install: neither migration has run yet.
      db.prepare(
        "DELETE FROM meta WHERE key IN ('room-defaults-on-1','time-bank-fixed-1')",
      ).run();
      db.close();

      db = openDb(path);
      const room = db
        .prepare(
          `SELECT time_bank_enabled AS enabled, time_bank_initial_secs AS init,
                  time_bank_refill_every_hands AS every, time_bank_refill_secs AS refill,
                  time_bank_epoch AS epoch
           FROM rooms WHERE id = ?`,
        )
        .get('legacy') as {
        enabled: number;
        init: number;
        every: number;
        refill: number;
        epoch: number;
      };
      expect(room).toMatchObject({ enabled: 1, init: 30, every: 20, refill: 30 });
      const player = db
        .prepare(
          `SELECT time_bank_ms AS ms, time_bank_hands AS hands, time_bank_epoch AS epoch
           FROM room_players WHERE room_id = ? AND user_id = ?`,
        )
        .get('legacy', 7) as { ms: number; hands: number; epoch: number };
      // reset to a single starting card, on the room's new epoch
      expect(player).toEqual({ ms: 30_000, hands: 0, epoch: room.epoch });
      db.close();
    } finally {
      if (db.open) db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Rewrites the `rooms` table so the seven default-on columns keep the OLD
 * `DEFAULT 0`, exactly as a database created before the default-on policy does.
 * `ensureColumn` never rewrites an existing column, so reopening such a file
 * leaves those defaults stale - the same condition the create route must not
 * depend on.
 */
function rebuildRoomsWithOldDefaults(db: ReturnType<typeof openDb>): void {
  const { sql } = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'rooms'")
    .get() as { sql: string };
  let ddl = sql;
  const columns = [
    'auto_approve_buys',
    'allow_spectators',
    'tv_replays',
    'squid_enabled',
    'time_bank_enabled',
    'bomb_pot_enabled',
    'multi_run_enabled',
  ];
  for (const column of columns) {
    const re = new RegExp(`(${column}\\s+[^,]*?)DEFAULT 1\\b`, 'i');
    if (!re.test(ddl)) throw new Error(`could not find a DEFAULT 1 for ${column} to lower`);
    ddl = ddl.replace(re, '$1DEFAULT 0');
  }
  db.exec('DROP TABLE rooms');
  db.exec(ddl);
  for (const column of columns) {
    const dflt = db
      .prepare("SELECT dflt_value AS v FROM pragma_table_info('rooms') WHERE name = ?")
      .get(column) as { v: string };
    expect(dflt.v).toBe('0');
  }
}

describe('API creation on a schema with the old column defaults', () => {
  it('writes the default-on values explicitly instead of inheriting the stale DEFAULTs', async () => {
    const dir = mkdtempSync(join(tmpdir(), '4am-room-oldcols-'));
    const path = join(dir, 'test.db');
    try {
      // Build a file whose `rooms` columns still default to 0, then reopen it
      // (createApp runs the boot migrations) and create a room through the API.
      const boot = openDb(path);
      rebuildRoomsWithOldDefaults(boot);
      boot.prepare("DELETE FROM meta WHERE key = 'room-defaults-on-1'").run();
      boot.close();

      const app = createApp(path);
      try {
        const reg = await app.app.inject({
          method: 'POST',
          url: '/api/register',
          payload: { username: 'oldcols_host', authKey: 'a'.repeat(64), publicKey: 'b'.repeat(64) },
        });
        const token = reg.json().token as string;

        const created = await app.app.inject({
          method: 'POST',
          url: '/api/rooms',
          headers: { authorization: `Bearer ${token}` },
          payload: { name: 'old-defaults', sb: 1, bb: 2 },
        });
        expect(created.statusCode).toBe(200);
        const room = created.json();
        expect(room.features).toEqual(ROOM_FEATURE_DEFAULTS);
        expect(room.autoApproveBuys).toBe(true);
        expect(room.allowSpectators).toBe(true);
        expect(room.tvReplays).toBe(true);

        expect(
          app.db
            .prepare(
              `SELECT auto_approve_buys AS autoApproveBuys, allow_spectators AS allowSpectators,
                      tv_replays AS tvReplays, squid_enabled AS squid, time_bank_enabled AS timeBank,
                      bomb_pot_enabled AS bombPot, multi_run_enabled AS multiRun
               FROM rooms WHERE id = ?`,
            )
            .get(room.id),
        ).toEqual({
          autoApproveBuys: 1,
          allowSpectators: 1,
          tvReplays: 1,
          squid: 1,
          timeBank: 1,
          bombPot: 1,
          multiRun: 1,
        });

        // Explicitly off is still honoured on the same stale-default schema.
        const off = await app.app.inject({
          method: 'POST',
          url: '/api/rooms',
          headers: { authorization: `Bearer ${token}` },
          payload: { name: 'off', sb: 1, bb: 2, autoApproveBuys: false },
        });
        expect(off.json().autoApproveBuys).toBe(false);
        expect(
          app.db
            .prepare('SELECT auto_approve_buys AS v FROM rooms WHERE id = ?')
            .get(off.json().id),
        ).toEqual({ v: 0 });
      } finally {
        await app.app.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
