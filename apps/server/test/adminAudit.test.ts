import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { setPlatformUserId } from '../src/platform.js';
import { derivePlatformCredentials } from '../src/platform-crypto.js';

// ---------------------------------------------------------------------------
// The three admin additions: reversible disable (enable), the server-side
// "reset to initial password 123456", and the admin_audit trail every admin
// action now writes to.
// ---------------------------------------------------------------------------

let ctx: ReturnType<typeof createApp>;
beforeEach(() => {
  ctx = createApp(':memory:');
});
afterEach(async () => {
  await ctx.app.close();
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function register(name: string, authKey = 'a'.repeat(64)) {
  const r = await ctx.app.inject({
    method: 'POST',
    url: '/api/register',
    payload: { username: name, authKey, publicKey: 'b'.repeat(64) },
  });
  return { token: r.json().token as string, userId: r.json().userId as number };
}

async function platformUser(name = 'ad_platform') {
  const p = await register(name);
  setPlatformUserId(ctx.db, p.userId);
  return p;
}

describe('admin enable', () => {
  it('is idempotent, flips disabled back to 0 and restores login', async () => {
    const alice = await register('en_alice');
    const platform = await platformUser();

    const disable = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/users/${alice.userId}/disable`,
      headers: auth(platform.token),
    });
    expect(disable.statusCode).toBe(200);

    const first = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/users/${alice.userId}/enable`,
      headers: auth(platform.token),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ ok: true, changed: true });
    expect(
      (ctx.db.prepare('SELECT disabled FROM users WHERE id = ?').get(alice.userId) as {
        disabled: number;
      }).disabled,
    ).toBe(0);

    // second enable changes nothing
    const second = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/users/${alice.userId}/enable`,
      headers: auth(platform.token),
    });
    expect(second.json()).toMatchObject({ ok: true, changed: false });

    // enabling does not resurrect the old session, but a fresh login works
    expect(
      (
        await ctx.app.inject({ method: 'GET', url: '/api/me', headers: auth(alice.token) })
      ).statusCode,
    ).toBe(401);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'en_alice', authKey: 'a'.repeat(64) },
    });
    expect(login.statusCode).toBe(200);
  });

  it('404s an unknown user and 400s a non-integer id', async () => {
    const platform = await platformUser();
    const missing = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/users/999999/enable',
      headers: auth(platform.token),
    });
    expect(missing.statusCode).toBe(404);
    const bad = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/users/not-a-number/enable',
      headers: auth(platform.token),
    });
    expect(bad.statusCode).toBe(400);
  });

  it('is platform-only', async () => {
    const alice = await register('en_stranger');
    const platform = await platformUser();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/users/${platform.userId}/enable`,
      headers: auth(alice.token),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('admin reset-initial', () => {
  it('refuses while the target is seated', async () => {
    const alice = await register('ri_seated');
    const platform = await platformUser('ri_platform_seated');
    ctx.db
      .prepare(
        `INSERT INTO rooms (id, name, join_code, host_id, banker_id, sb, bb, audit_mode, created_at)
         VALUES ('ri_room', 'RI', 'RISEAT', ?, ?, 1, 2, 'private', ?)`,
      )
      .run(alice.userId, alice.userId, Date.now());
    ctx.db
      .prepare('INSERT INTO room_players (room_id, user_id, seat, stack) VALUES (?, ?, 1, 500)')
      .run('ri_room', alice.userId);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/users/${alice.userId}/reset-initial`,
      headers: auth(platform.token),
    });
    expect(res.statusCode).toBe(409);
    // unchanged: the original session still checks out
    expect(
      (
        await ctx.app.inject({ method: 'GET', url: '/api/me', headers: auth(alice.token) })
      ).statusCode,
    ).toBe(200);
  }, 20_000);

  it('re-keys to 123456, drops every session, and lets the new password in', async () => {
    const alice = await register('ri_alice');
    const platform = await platformUser('ri_platform');
    const { authKey, publicKey } = derivePlatformCredentials('ri_alice', '123456');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/users/${alice.userId}/reset-initial`,
      headers: auth(platform.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });

    const before = ctx.db
      .prepare('SELECT pubkey FROM users WHERE id = ?')
      .get(alice.userId) as { pubkey: string };
    expect(before.pubkey).toBe(publicKey);

    // old session is dead and the old password no longer works
    expect(
      (
        await ctx.app.inject({ method: 'GET', url: '/api/me', headers: auth(alice.token) })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/api/login',
          payload: { username: 'ri_alice', authKey: 'a'.repeat(64) },
        })
      ).statusCode,
    ).toBe(401);

    // the initial password logs in and returns the initial public key
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'ri_alice', authKey },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ userId: alice.userId, publicKey });

    // repeating it is allowed (idempotent re-key), not a 409
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/users/${alice.userId}/reset-initial`,
      headers: auth(platform.token),
    });
    expect(again.statusCode).toBe(200);
  }, 30_000);

  it('is platform-only', async () => {
    const alice = await register('ri_stranger');
    const platform = await platformUser('ri_platform2');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/users/${platform.userId}/reset-initial`,
      headers: auth(alice.token),
    });
    expect(res.statusCode).toBe(403);
  });
});

interface AuditRow {
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: string | null;
}

function auditRows(): AuditRow[] {
  return ctx.db
    .prepare(
      'SELECT action, target_type AS targetType, target_id AS targetId, detail FROM admin_audit ORDER BY id',
    )
    .all() as AuditRow[];
}

describe('admin audit trail', () => {
  it('records user disable/enable/password-reset and reset-initial', async () => {
    const alice = await register('au_user');
    const platform = await platformUser('au_platform');
    const call = (path: string, payload?: Record<string, unknown>) =>
      ctx.app.inject({
        method: 'POST',
        url: path,
        headers: auth(platform.token),
        ...(payload === undefined ? {} : { payload }),
      });

    await call(`/api/admin/users/${alice.userId}/disable`);
    await call(`/api/admin/users/${alice.userId}/enable`);
    await call(`/api/admin/users/${alice.userId}/password`, {
      newAuthKey: 'c'.repeat(64),
      newPublicKey: 'd'.repeat(64),
    });
    await call(`/api/admin/users/${alice.userId}/reset-initial`);

    const rows = auditRows();
    expect(rows.map((r) => r.action)).toEqual([
      'user.disable',
      'user.enable',
      'user.password-reset',
      'user.password-reset',
    ]);
    for (const r of rows) {
      expect(r.targetType).toBe('user');
      expect(r.targetId).toBe(String(alice.userId));
    }
    expect(JSON.parse(rows[2]!.detail!)).toEqual({ mode: 'custom' });
    expect(JSON.parse(rows[3]!.detail!)).toEqual({ mode: 'initial' });
  }, 30_000);

  it('records room and merge actions', async () => {
    const host = await register('au_host');
    const from = await register('au_from');
    const into = await register('au_into');
    const platform = await platformUser('au_platform2');
    const call = (path: string, payload?: Record<string, unknown>) =>
      ctx.app.inject({
        method: 'POST',
        url: path,
        headers: auth(platform.token),
        ...(payload === undefined ? {} : { payload }),
      });

    async function createRoom(name: string) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/api/rooms',
        headers: auth(host.token),
        payload: { name, sb: 10, bb: 20 },
      });
      return res.json() as { id: string };
    }

    // direct room archive/unarchive/delete
    const room = await createRoom('Audit Room');
    await call(`/api/admin/rooms/${room.id}/archive`, { archived: true });
    await call(`/api/admin/rooms/${room.id}/archive`, { archived: false });
    await call(`/api/admin/rooms/${room.id}/delete`);

    // file a merge request and reject it, then merge directly, skipping the queue
    const reqA = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/me/merge-request',
        headers: auth(from.token),
        payload: { fromUsername: 'au_from', intoUsername: 'au_into' },
      })
    ).json() as { requestId: number };
    await call(`/api/admin/merges/${reqA.requestId}`, { approve: false });
    await call('/api/admin/merge', { fromUsername: 'au_from', intoUsername: 'au_into' });

    const actions = auditRows().map((r) => r.action);
    expect(actions).toEqual([
      'room.archive',
      'room.unarchive',
      'room.delete',
      'merge.reject',
      'merge.create',
    ]);

    const byAction = new Map(auditRows().map((r) => [r.action, r]));
    expect(JSON.parse(byAction.get('room.archive')!.detail!)).toMatchObject({
      archived: true,
      changed: true,
    });
    expect(JSON.parse(byAction.get('room.delete')!.detail!)).toMatchObject({ changed: true });
    expect(byAction.get('room.delete')!.targetType).toBe('room');
    expect(byAction.get('room.delete')!.targetId).toBe(room.id);
    expect(byAction.get('merge.create')!.targetType).toBe('merge');
  });
});

describe('GET /api/admin/audit', () => {
  it('is platform-only and rejects bad pagination', async () => {
    const alice = await register('ga_alice');
    const platform = await platformUser('ga_platform');

    expect(
      (
        await ctx.app.inject({ method: 'GET', url: '/api/admin/audit' })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/api/admin/audit',
          headers: auth(alice.token),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/api/admin/audit?limit=0',
          headers: auth(platform.token),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/api/admin/audit?limit=9999',
          headers: auth(platform.token),
        })
      ).statusCode,
    ).toBe(400);
  });

  it('pages newest-first and filters by action and targetId', async () => {
    const platform = await platformUser('ga_platform2');
    const users = [await register('ga_u1'), await register('ga_u2'), await register('ga_u3')];
    for (const u of users) {
      await ctx.app.inject({
        method: 'POST',
        url: `/api/admin/users/${u.userId}/disable`,
        headers: auth(platform.token),
      });
    }

    const first = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/audit?limit=2&offset=0',
      headers: auth(platform.token),
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as {
      entries: { id: number; action: string; targetId: string; operatorUserId: number }[];
      total: number;
      offset: number;
      hasMore: boolean;
    };
    expect(firstBody.entries).toHaveLength(2);
    expect(firstBody.total).toBeGreaterThanOrEqual(3);
    expect(firstBody.hasMore).toBe(true);
    // newest first
    expect(firstBody.entries[0]!.id).toBeGreaterThan(firstBody.entries[1]!.id);
    expect(firstBody.entries[0]!.targetId).toBe(String(users[2]!.userId));

    const filtered = await ctx.app.inject({
      method: 'GET',
      url: `/api/admin/audit?action=user.disable&targetId=${users[0]!.userId}`,
      headers: auth(platform.token),
    });
    const body = filtered.json() as {
      entries: { action: string; targetId: string; detail: unknown; operatorName: string }[];
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]!.action).toBe('user.disable');
    expect(body.entries[0]!.targetId).toBe(String(users[0]!.userId));
    expect(body.entries[0]!.detail).toMatchObject({ changed: true });

    const noMatch = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/audit?action=does.not.exist',
      headers: auth(platform.token),
    });
    expect((noMatch.json() as { total: number }).total).toBe(0);
  });
});

describe('login refuses disabled and merge-retired accounts', () => {
  it('does not mint a session for a disabled user', async () => {
    const alice = await register('lg_alice');
    const platform = await platformUser('lg_platform');
    await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/users/${alice.userId}/disable`,
      headers: auth(platform.token),
    });

    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'lg_alice', authKey: 'a'.repeat(64) },
    });
    expect(login.statusCode).toBe(401);
    const { n } = ctx.db
      .prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?')
      .get(alice.userId) as { n: number };
    expect(n).toBe(0);
  });

  it('does not mint a session for a merge-retired account even with the old password', async () => {
    const from = await register('lg_merged_from');
    const into = await register('lg_merged_into');
    const platform = await platformUser('lg_merged_platform');
    const merge = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/merge',
      headers: auth(platform.token),
      payload: { fromUsername: 'lg_merged_from', intoUsername: 'lg_merged_into' },
    });
    expect(merge.statusCode).toBe(200);

    // The merged `from` row keeps its original credentials so the old password
    // still matches; the disabled/merged status is what must deny the login.
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'lg_merged_from', authKey: 'a'.repeat(64) },
    });
    expect(login.statusCode).toBe(401);
    const { n } = ctx.db
      .prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?')
      .get(from.userId) as { n: number };
    expect(n).toBe(0);
  }, 30_000);
});

describe('enable / reset refuse merge-retired accounts', () => {
  it('409s enable, custom reset and reset-initial for a merged account', async () => {
    const from = await register('mr_from');
    const into = await register('mr_into');
    const platform = await platformUser('mr_platform');

    const merge = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/merge',
      headers: auth(platform.token),
      payload: { fromUsername: 'mr_from', intoUsername: 'mr_into' },
    });
    expect(merge.statusCode).toBe(200);
    const row = ctx.db
      .prepare('SELECT disabled, merged_into AS mergedInto FROM users WHERE id = ?')
      .get(from.userId) as { disabled: number; mergedInto: number | null };
    expect(row.disabled).toBe(1);
    expect(row.mergedInto).toBe(into.userId);

    const enable = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/users/${from.userId}/enable`,
      headers: auth(platform.token),
    });
    expect(enable.statusCode).toBe(409);

    const reset = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/users/${from.userId}/password`,
      headers: auth(platform.token),
      payload: { newAuthKey: 'c'.repeat(64), newPublicKey: 'd'.repeat(64) },
    });
    expect(reset.statusCode).toBe(409);

    const initial = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/users/${from.userId}/reset-initial`,
      headers: auth(platform.token),
    });
    expect(initial.statusCode).toBe(409);

    const after = ctx.db
      .prepare('SELECT disabled, merged_into AS mergedInto FROM users WHERE id = ?')
      .get(from.userId) as { disabled: number; mergedInto: number | null };
    expect(after).toEqual(row);
  }, 30_000);

  it('leaves a merged account’s credentials untouched (in-transaction UPDATE guard)', async () => {
    const from = await register('rg_from');
    const into = await register('rg_into');
    const platform = await platformUser('rg_platform');
    const merge = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/merge',
      headers: auth(platform.token),
      payload: { fromUsername: 'rg_from', intoUsername: 'rg_into' },
    });
    expect(merge.statusCode).toBe(200);

    const before = ctx.db
      .prepare('SELECT auth_hash AS authHash, pubkey, merged_into AS mergedInto FROM users WHERE id = ?')
      .get(from.userId);
    // The merged check now lives inside the write transaction (the conditional
    // `UPDATE ... WHERE merged_into IS NULL` changes 0 rows), so both resets are
    // rejected before rekey() can touch a retired identity.
    const custom = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/users/${from.userId}/password`,
      headers: auth(platform.token),
      payload: { newAuthKey: 'c'.repeat(64), newPublicKey: 'd'.repeat(64) },
    });
    expect(custom.statusCode).toBe(409);
    const initial = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/users/${from.userId}/reset-initial`,
      headers: auth(platform.token),
    });
    expect(initial.statusCode).toBe(409);

    const after = ctx.db
      .prepare('SELECT auth_hash AS authHash, pubkey, merged_into AS mergedInto FROM users WHERE id = ?')
      .get(from.userId);
    expect(after).toEqual(before);
  }, 30_000);
});

describe('enable clears surviving sessions', () => {
  it('deletes any session row when it actually flips the account back on', async () => {
    const alice = await register('es_alice');
    const platform = await platformUser('es_platform');
    await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/users/${alice.userId}/disable`,
      headers: auth(platform.token),
    });
    const now = Date.now();
    ctx.db
      .prepare(
        'INSERT INTO sessions (token, user_id, created_at, last_used, expires_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('dirty-session-token', alice.userId, now, now, now + 60_000);

    const enable = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/users/${alice.userId}/enable`,
      headers: auth(platform.token),
    });
    expect(enable.json()).toMatchObject({ ok: true, changed: true });
    const { n } = ctx.db
      .prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?')
      .get(alice.userId) as { n: number };
    expect(n).toBe(0);
  });
});

describe('disable is a conditional update', () => {
  it('reports changed:true once then changed:false, and audits both', async () => {
    const alice = await register('cd_alice');
    const platform = await platformUser('cd_platform');
    const first = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/users/${alice.userId}/disable`,
      headers: auth(platform.token),
    });
    expect(first.json()).toMatchObject({ ok: true, changed: true });
    const second = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/users/${alice.userId}/disable`,
      headers: auth(platform.token),
    });
    expect(second.json()).toMatchObject({ ok: true, changed: false });

    const rows = auditRows().filter((r) => r.action === 'user.disable');
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0]!.detail!)).toEqual({ changed: true });
    expect(JSON.parse(rows[1]!.detail!)).toEqual({ changed: false });
  });
});

const campaignBody = (extra: Record<string, unknown> = {}) => {
  const now = Date.now();
  return {
    tournamentId: null,
    name: 'Audit Sponsor',
    headline: 'Headline',
    description: 'Description',
    destinationUrl: 'https://example.com/sponsor',
    placement: 'directory',
    startsAt: now,
    endsAt: now + 86_400_000,
    active: true,
    bookedAmount: 1000,
    note: '',
    ...extra,
  };
};

describe('audit covers settings, sponsor and tournament admin writes', () => {
  it('records commission, sponsor campaign/receipt, and tournament review/media', async () => {
    const platform = await platformUser('ac_platform');
    const host = await register('ac_host');

    // settings.commission
    const settings = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/settings',
      headers: auth(platform.token),
    });
    const revision = (settings.json() as { revision: number }).revision;
    const commission = await ctx.app.inject({
      method: 'PUT',
      url: '/api/admin/settings/commission',
      headers: auth(platform.token),
      payload: { commissionBps: 137, scope: 'new_rooms', revision },
    });
    expect(commission.statusCode).toBe(200);

    // sponsor create -> update -> delete
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/sponsors',
      headers: auth(platform.token),
      payload: campaignBody(),
    });
    expect(created.statusCode).toBe(201);
    const createdCampaign = created.json() as { id: string; revision: number };
    const updated = await ctx.app.inject({
      method: 'PUT',
      url: `/api/admin/sponsors/${createdCampaign.id}`,
      headers: auth(platform.token),
      payload: campaignBody({ revision: createdCampaign.revision, name: 'Audit Sponsor 2' }),
    });
    expect(updated.statusCode).toBe(200);
    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/admin/sponsors/${createdCampaign.id}`,
      headers: auth(platform.token),
      payload: { revision: (updated.json() as { revision: number }).revision },
    });
    expect(deleted.statusCode).toBe(200);

    // sponsor receipt on a second campaign
    const created2 = await ctx.app.inject({
      method: 'POST',
      url: '/api/admin/sponsors',
      headers: auth(platform.token),
      payload: campaignBody({ name: 'Receipt Sponsor' }),
    });
    expect(created2.statusCode).toBe(201);
    const receipt = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/sponsors/${(created2.json() as { id: string }).id}/receipts`,
      headers: auth(platform.token),
      payload: {
        requestId: 'receipt-1',
        amount: 100,
        prizeContribution: 0,
        tournamentId: null,
        note: 'audit receipt',
      },
    });
    expect(receipt.statusCode).toBe(201);

    // tournament review + media
    const tournament = await ctx.app.inject({
      method: 'POST',
      url: '/api/tournaments',
      headers: auth(host.token),
      payload: {
        name: 'Audit Cup',
        handLimit: 10,
        capacity: 2,
        startingStack: 2000,
        sb: 10,
        bb: 20,
        actionSeconds: 60,
        policy: { houseBps: 0, prizeBps: 0 },
      },
    });
    expect(tournament.statusCode).toBe(200);
    const tid = (tournament.json() as { id: string }).id;
    const review = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/tournaments/${tid}/review`,
      headers: auth(platform.token),
      payload: { approve: true, revision: 1, note: 'audited' },
    });
    expect(review.statusCode).toBe(200);
    const media = await ctx.app.inject({
      method: 'PUT',
      url: `/api/tournaments/${tid}/media`,
      headers: auth(platform.token),
      payload: {
        streamUrl: 'https://www.youtube.com/watch?v=abc12345678',
        meetUrl: 'https://meet.google.com/abc-defg-hij',
      },
    });
    expect(media.statusCode).toBe(200);

    const rows = auditRows();
    expect(rows.map((r) => r.action)).toEqual([
      'settings.commission',
      'sponsor.create',
      'sponsor.update',
      'sponsor.delete',
      'sponsor.create',
      'sponsor.receipt',
      'tournament.review.approve',
      'tournament.media',
    ]);
    const byAction = (action: string) => rows.filter((r) => r.action === action);
    expect(JSON.parse(byAction('settings.commission')[0]!.detail!)).toMatchObject({
      commissionBps: 137,
      scope: 'new_rooms',
      affectedRooms: 0,
    });
    expect(JSON.parse(byAction('sponsor.create')[0]!.detail!)).toEqual({ name: 'Audit Sponsor' });
    expect(JSON.parse(byAction('sponsor.update')[0]!.detail!)).toMatchObject({ revision: 2 });
    expect(JSON.parse(byAction('sponsor.receipt')[0]!.detail!)).toMatchObject({ amount: 100 });
    expect(byAction('tournament.media')[0]!.targetType).toBe('tournament');
    expect(byAction('tournament.media')[0]!.targetId).toBe(tid);
    expect(JSON.parse(byAction('tournament.review.approve')[0]!.detail!)).toMatchObject({
      approved: true,
      revision: 1,
    });
  }, 30_000);
});

describe('audit durability and read shape', () => {
  it('creates the paging and filter indexes', () => {
    const names = (
      ctx.db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='admin_audit'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'idx_admin_audit_ts_id',
        'idx_admin_audit_target_id',
        'idx_admin_audit_action_ts',
      ]),
    );
  });

  it('sends no-store on the audit endpoint', async () => {
    const platform = await platformUser('ns_platform');
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/audit',
      headers: auth(platform.token),
    });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('rolls the business change back when the audit insert fails', async () => {
    const alice = await register('tx_alice');
    const platform = await platformUser('tx_platform');
    // Force the audit INSERT to fail: the disable transaction must roll back
    // with it, leaving the account enabled and its session intact.
    ctx.db.exec('DROP TABLE admin_audit');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/users/${alice.userId}/disable`,
      headers: auth(platform.token),
    });
    expect(res.statusCode).toBe(500);
    const row = ctx.db.prepare('SELECT disabled FROM users WHERE id = ?').get(alice.userId) as {
      disabled: number;
    };
    expect(row.disabled).toBe(0);
    const { n } = ctx.db
      .prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?')
      .get(alice.userId) as { n: number };
    expect(n).toBe(1);
  });
});

describe('platform tournament terms and control audit', () => {
  async function createTournament(token: string, name: string) {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/tournaments',
      headers: auth(token),
      payload: {
        name,
        handLimit: 10,
        capacity: 2,
        startingStack: 2000,
        sb: 10,
        bb: 20,
        actionSeconds: 60,
        policy: { houseBps: 0, prizeBps: 0 },
      },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { id: string }).id;
  }

  it('audits a platform publish/control but not an organizer’s own action', async () => {
    const host = await register('tc_host');
    const platform = await platformUser('tc_platform');

    const termsId = await createTournament(host.token, 'Terms Cup');
    const platformTerms = await ctx.app.inject({
      method: 'PUT',
      url: `/api/tournaments/${termsId}/terms`,
      headers: auth(platform.token),
      payload: { revision: 1, name: 'Terms Cup v2' },
    });
    expect(platformTerms.statusCode).toBe(200);
    expect(platformTerms.json()).toMatchObject({ ok: true, revision: 2 });

    const controlId = await createTournament(host.token, 'Control Cup');
    const platformControl = await ctx.app.inject({
      method: 'POST',
      url: `/api/tournaments/${controlId}/control`,
      headers: auth(platform.token),
      payload: { action: 'cancel' },
    });
    expect(platformControl.statusCode).toBe(200);

    // Organizer edits/cancels their own tournaments: not a platform admin
    // action, so neither shows up on the platform audit trail.
    const ownTermsId = await createTournament(host.token, 'Own Terms Cup');
    const hostTerms = await ctx.app.inject({
      method: 'PUT',
      url: `/api/tournaments/${ownTermsId}/terms`,
      headers: auth(host.token),
      payload: { revision: 1, name: 'Own Terms Cup v2' },
    });
    expect(hostTerms.statusCode).toBe(200);
    const ownControlId = await createTournament(host.token, 'Own Control Cup');
    const hostControl = await ctx.app.inject({
      method: 'POST',
      url: `/api/tournaments/${ownControlId}/control`,
      headers: auth(host.token),
      payload: { action: 'cancel' },
    });
    expect(hostControl.statusCode).toBe(200);

    const rows = auditRows();
    expect(rows.map((r) => r.action)).toEqual(['tournament.terms', 'tournament.control']);
    const terms = rows.find((r) => r.action === 'tournament.terms')!;
    expect(terms.targetType).toBe('tournament');
    expect(terms.targetId).toBe(termsId);
    expect(JSON.parse(terms.detail!)).toEqual({ revision: 2, approvalStatus: 'approved' });
    const control = rows.find((r) => r.action === 'tournament.control')!;
    expect(control.targetType).toBe('tournament');
    expect(control.targetId).toBe(controlId);
    expect(JSON.parse(control.detail!)).toEqual({ action: 'cancel', status: 'cancelled' });
  }, 30_000);
});

describe('cross-module audit rollback', () => {
  it('rolls a tournament review back and emits no event when the audit insert fails', async () => {
    const host = await register('txr_host');
    const platform = await platformUser('txr_platform');
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/tournaments',
      headers: auth(host.token),
      payload: {
        name: 'Rollback Cup',
        handLimit: 10,
        capacity: 2,
        startingStack: 2000,
        sb: 10,
        bb: 20,
        actionSeconds: 60,
        policy: { houseBps: 0, prizeBps: 0 },
      },
    });
    const tid = (created.json() as { id: string }).id;

    // Force the audit INSERT to fail. The review transaction must roll back
    // with it, and the reviewed event (now published after commit) must not
    // have escaped.
    ctx.db.exec('DROP TABLE admin_audit');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/admin/tournaments/${tid}/review`,
      headers: auth(platform.token),
      payload: { approve: true, revision: 1, note: 'rollback' },
    });
    expect(res.statusCode).toBe(500);

    const t = ctx.db
      .prepare('SELECT status, approval_status AS approvalStatus FROM tournaments WHERE id = ?')
      .get(tid);
    expect(t).toMatchObject({ status: 'pending', approvalStatus: 'pending' });

    const { n } = ctx.db
      .prepare(
        "SELECT COUNT(*) AS n FROM agent_events WHERE scope_kind = 'tournament' AND scope_id = ? AND type = 'tournament.reviewed'",
      )
      .get(tid) as { n: number };
    expect(n).toBe(0);
  }, 30_000);
});
