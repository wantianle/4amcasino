import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scryptSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { checkLogin, createUser } from '../src/auth.js';
import {
  armRecoveryCode,
  deriveRecoveryAuthKey,
  generateRecoveryCode,
} from '../src/account.js';
import { DISPLAY_NAME_MAX_WIDTH, displayNameError, displayNameWidth } from '../src/profile.js';

let ctx: ReturnType<typeof createApp>;
beforeEach(() => {
  ctx = createApp(':memory:');
});
afterEach(async () => {
  await ctx.app.close();
});

interface Registered {
  userId: number;
  token: string;
  recoveryCode: string;
}

async function register(name: string): Promise<Registered> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/register',
    payload: { username: name, authKey: 'a'.repeat(64), publicKey: 'b'.repeat(64) },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { userId: number; token: string; recoveryCode: string };
  return { userId: body.userId, token: body.token, recoveryCode: body.recoveryCode };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

const putName = (token: string, displayName: string) =>
  ctx.app.inject({
    method: 'PUT',
    url: '/api/profile',
    headers: auth(token),
    payload: { displayName },
  });

const getName = async (token: string) =>
  (await ctx.app.inject({ method: 'GET', url: '/api/profile', headers: auth(token) })).json() as {
    username: string;
    displayName: string;
  };

/** Independent re-implementation of the browser's deriveRecoveryAuthKey
 *  (apps/web/src/shared/crypto.ts) so the test proves the wire contract, not
 *  the server's own helper. */
function clientDeriveRecoveryAuthKey(code: string): string {
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return scryptSync(normalized, '4am/recover', 32, {
    N: 2 ** 15,
    r: 8,
    p: 1,
    maxmem: 128 * 1024 * 1024,
  }).toString('hex');
}

describe('nickname width', () => {
  it('counts Chinese/full-width as 2 and Latin/digits as 1', () => {
    expect(displayNameWidth('中')).toBe(2);
    expect(displayNameWidth('中文')).toBe(4);
    expect(displayNameWidth('ab12')).toBe(4);
    expect(displayNameWidth('ＡＢ')).toBe(4); // fullwidth Latin
    expect(displayNameWidth('')).toBe(0);
  });

  it('measures grapheme clusters, so emoji and combining marks cannot bypass the cap', () => {
    expect(displayNameWidth('😀')).toBe(2);
    expect(displayNameWidth('e\u0301')).toBe(1); // é as base + combining acute
    expect(displayNameWidth('👨‍👩‍👧')).toBe(2); // one ZWJ family cluster
  });

  it('allows the punctuation set _ @ - · and refuses spaces', () => {
    expect(displayNameError('a_@-·')).toBeNull();
    expect(displayNameError('a b')).not.toBeNull();
    expect(displayNameError('a\u3000b')).not.toBeNull(); // ideographic space
    expect(displayNameError('a\u200bb')).not.toBeNull(); // zero-width space
  });

  it('allows only the true empty string to clear; whitespace is never trimmed away', () => {
    expect(displayNameError('')).toBeNull(); // real empty -> clears the nickname
    expect(displayNameError('   ')).not.toBeNull(); // whitespace-only is not empty
    expect(displayNameError(' abc')).not.toBeNull(); // leading space
    expect(displayNameError('abc ')).not.toBeNull(); // trailing space
    expect(displayNameError('\tabc')).not.toBeNull();
    expect(displayNameError('ab c')).not.toBeNull();
  });

  it('rejects scripts and symbols outside the allowlist', () => {
    expect(displayNameError('Ж')).not.toBeNull(); // Cyrillic
    expect(displayNameError('Аbc')).not.toBeNull(); // Cyrillic А
    expect(displayNameError('∑')).not.toBeNull(); // math symbol
    expect(displayNameError('©')).not.toBeNull(); // letterlike symbol (Extended_Pictographic)
  });

  it('allows a combining mark attached to an allowed base, never on its own', () => {
    expect(displayNameError('e\u0301')).toBeNull(); // é as base + combining acute
    expect(displayNameError('\u0301')).not.toBeNull(); // a bare diacritic
  });

  it('rejects malformed joiner / modifier / variation-selector sequences', () => {
    expect(displayNameError('😀\u200d')).not.toBeNull(); // trailing ZWJ
    expect(displayNameError('a\u200db')).not.toBeNull(); // ZWJ between Latin letters
    expect(displayNameError('a\u0301\u200d')).not.toBeNull(); // ZWJ after a mark, no emoji base
    expect(displayNameError('\u200d😀')).not.toBeNull(); // leading ZWJ
    expect(displayNameError('🏽')).not.toBeNull(); // bare Emoji_Modifier
    expect(displayNameError('🏽a')).not.toBeNull(); // modifier used as the base
    expect(displayNameError('\ufe0f')).not.toBeNull(); // lone variation selector
    expect(displayNameError('a\ufe0f')).not.toBeNull(); // VS on plain Latin
    expect(displayNameError('😀\u200d🏽')).not.toBeNull(); // ZWJ must point at an emoji base
  });

  it('keeps valid emoji ZWJ / modifier / combining sequences', () => {
    expect(displayNameError('😀')).toBeNull();
    expect(displayNameError('👍🏽')).toBeNull();
    expect(displayNameError('👨\u200d👩\u200d👧')).toBeNull();
    expect(displayNameError('e\u0301')).toBeNull();
    expect(displayNameError('😀😀')).toBeNull();
  });

  it('allows an empty nickname and enforces the 16-wide boundary', () => {
    expect(displayNameError('x'.repeat(DISPLAY_NAME_MAX_WIDTH))).toBeNull();
    expect(displayNameError('x'.repeat(DISPLAY_NAME_MAX_WIDTH + 1))).not.toBeNull();
    expect(displayNameError('中'.repeat(8))).toBeNull(); // width 16
    expect(displayNameError('中'.repeat(9))).not.toBeNull(); // width 18
    expect(displayNameError('😀'.repeat(8))).toBeNull();
    expect(displayNameError('😀'.repeat(9))).not.toBeNull();
  });

  it('uses the real East_Asian_Width W/F table at the awkward boundaries', () => {
    expect(displayNameWidth('\u3248')).toBe(1); // ㉈ EAW=A - the old range list wrongly said 2
    expect(displayNameWidth('\u2329')).toBe(2); // 〈 EAW=W - the old range list missed it
    expect(displayNameWidth('\u232A')).toBe(2); // 〉 EAW=W
  });
});

describe('nickname writes are server-authoritative', () => {
  it('accepts a valid nickname and returns it', async () => {
    const alice = await register('nick_ok');
    expect((await putName(alice.token, 'Ace中_@-·')).statusCode).toBe(200);
    expect((await getName(alice.token)).displayName).toBe('Ace中_@-·');
  });

  it('rejects an over-wide nickname and a nickname with a space', async () => {
    const alice = await register('nick_bad');
    expect((await putName(alice.token, 'x'.repeat(17))).statusCode).toBe(400);
    expect((await putName(alice.token, '中'.repeat(9))).statusCode).toBe(400);
    expect((await putName(alice.token, 'Ace Alice')).statusCode).toBe(400);
    // a rejected write must not have mutated the stored name
    expect((await getName(alice.token)).displayName).toBe('nick_bad');
  });

  it('does not trim a whitespace-padded nickname into a valid one', async () => {
    const alice = await register('nick_space');
    expect((await putName(alice.token, ' ace')).statusCode).toBe(400);
    expect((await putName(alice.token, 'ace ')).statusCode).toBe(400);
    expect((await putName(alice.token, '   ')).statusCode).toBe(400);
    // a rejected write must not have mutated the stored name
    expect((await getName(alice.token)).displayName).toBe('nick_space');
  });

  it('rejects scripts and symbols outside the allowlist', async () => {
    const alice = await register('nick_script');
    expect((await putName(alice.token, 'Ж')).statusCode).toBe(400);
    expect((await putName(alice.token, '∑')).statusCode).toBe(400);
    expect((await putName(alice.token, '©')).statusCode).toBe(400);
    expect((await getName(alice.token)).displayName).toBe('nick_script');
  });

  it('clears the nickname with an empty string and falls back to the username', async () => {
    const alice = await register('nick_clear');
    await putName(alice.token, 'Ace');
    expect((await getName(alice.token)).displayName).toBe('Ace');
    expect((await putName(alice.token, '')).statusCode).toBe(200);
    expect((await getName(alice.token)).displayName).toBe('nick_clear');
  });
});

describe('recovery code at registration', () => {
  it('returns a code once, stores only its hash, and matches the browser shape', async () => {
    const alice = await register('rec_shape');
    expect(alice.recoveryCode).toMatch(/^[A-HJ-NP-Z2-9]{6}(-[A-HJ-NP-Z2-9]{6}){3}$/);
    const row = ctx.db
      .prepare('SELECT recovery_hash, recovery_salt FROM users WHERE id = ?')
      .get(alice.userId) as { recovery_hash: string | null; recovery_salt: string | null };
    expect(row.recovery_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.recovery_salt).toMatch(/^[0-9a-f]{32}$/);
    // the clear code is never stored
    expect(JSON.stringify(row)).not.toContain(alice.recoveryCode);
  });

  it('reports the code as on-file but never returns it again', async () => {
    const alice = await register('rec_status');
    const status = (
      await ctx.app.inject({ method: 'GET', url: '/api/me/recovery', headers: auth(alice.token) })
    ).json() as { enabled: boolean; setAt: number | null };
    expect(status.enabled).toBe(true);
    expect(status.setAt).toBeGreaterThan(0);
    expect(JSON.stringify(status)).not.toContain(alice.recoveryCode);
  });

  it('can be redeemed exactly once and issues a working new key set', async () => {
    const alice = await register('rec_redeem');
    const recoveryAuthKey = clientDeriveRecoveryAuthKey(alice.recoveryCode);
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/recover',
      payload: {
        username: 'rec_redeem',
        recoveryAuthKey,
        newAuthKey: 'c'.repeat(64),
        newPublicKey: 'd'.repeat(64),
      },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().token).toEqual(expect.any(String));

    // the new auth key logs in, the old one does not
    const good = await ctx.app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'rec_redeem', authKey: 'c'.repeat(64) },
    });
    expect(good.statusCode).toBe(200);
    const old = await ctx.app.inject({
      method: 'POST',
      url: '/api/login',
      payload: { username: 'rec_redeem', authKey: 'a'.repeat(64) },
    });
    expect(old.statusCode).toBe(401);

    // the code is burned
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/recover',
      payload: {
        username: 'rec_redeem',
        recoveryAuthKey,
        newAuthKey: 'e'.repeat(64),
        newPublicKey: 'f'.repeat(64),
      },
    });
    expect(second.statusCode).toBe(403);
  });

  it('refuses the self-serve re-arm route', async () => {
    const alice = await register('rec_locked');
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/me/recovery',
      headers: auth(alice.token),
      payload: { currentAuthKey: 'a'.repeat(64), recoveryAuthKey: 'b'.repeat(64) },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('recovery redemption is one-shot under a concurrent race', () => {
  const ACCOUNT_URL = new URL('../src/account.ts', import.meta.url).href;
  const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));

  /** Two real OS processes (better-sqlite3 is synchronous, so two connections
   *  in one process cannot actually race) each redeem the same code, using the
   *  exact transactional primitive the route calls. */
  function redeemInChild(env: Record<string, string>): Promise<{ kind: string; stderr: string }> {
    const script = `
      import Database from 'better-sqlite3';
      import { consumeRecoveryCode } from ${JSON.stringify(ACCOUNT_URL)};
      const db = new Database(process.env.RACE_DB);
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 10000');
      const r = consumeRecoveryCode(
        db,
        process.env.RACE_USER,
        process.env.RACE_CODE,
        process.env.RACE_NEW,
        process.env.RACE_PUB,
      );
      process.stdout.write(JSON.stringify(r));
      db.close();
    `;
    return new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', script],
        { cwd: SERVER_DIR, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      child.on('error', (e) => resolve({ kind: 'spawn-error', stderr: String(e) }));
      child.on('exit', () => {
        try {
          resolve({ kind: (JSON.parse(stdout) as { kind: string }).kind, stderr });
        } catch {
          resolve({ kind: `unparsed:${stdout}`, stderr });
        }
      });
    });
  }

  it('lets exactly one of two simultaneous redemptions win', async () => {
    const dir = mkdtempSync(join(tmpdir(), '4am-recover-race-'));
    const path = join(dir, 'race.sqlite');
    try {
      const setup = openDb(path);
      const { userId } = createUser(setup, 'racer', 'a'.repeat(64), 'b'.repeat(64));
      const code = generateRecoveryCode();
      armRecoveryCode(setup, userId, code);
      const recoveryAuthKey = deriveRecoveryAuthKey(code);
      const armed = setup
        .prepare('SELECT recovery_hash FROM users WHERE id = ?')
        .get(userId) as { recovery_hash: string | null };
      expect(armed.recovery_hash).toMatch(/^[0-9a-f]{64}$/);
      setup.close();

      const env = {
        RACE_DB: path,
        RACE_USER: 'racer',
        RACE_CODE: recoveryAuthKey,
        RACE_NEW: 'c'.repeat(64),
        RACE_PUB: 'd'.repeat(64),
      };
      const [a, b] = await Promise.all([redeemInChild(env), redeemInChild(env)]);
      const results = [a, b];
      expect(results.map((r) => r.kind).filter((k) => k === 'ok')).toHaveLength(1);
      // exactly one winner; the loser sees the burned code (invalid) or, if it
      // ever raced the burn itself, the conditional-update guard (used)
      const loser = results.find((r) => r.kind !== 'ok')!;
      expect(['invalid', 'used']).toContain(loser.kind);
      if (loser.kind === 'unparsed:' || loser.kind === 'spawn-error') {
        throw new Error(`redeem child failed: ${loser.stderr}`);
      }

      const after = openDb(path);
      try {
        const row = after
          .prepare('SELECT recovery_hash FROM users WHERE id = ?')
          .get(userId) as { recovery_hash: string | null };
        expect(row.recovery_hash).toBeNull();
        // the single winner's new key works; the old one is dead
        expect(checkLogin(after, 'racer', 'c'.repeat(64))).not.toBeNull();
        expect(checkLogin(after, 'racer', 'a'.repeat(64))).toBeNull();
      } finally {
        after.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describe('registration arms the recovery code atomically', () => {
  it('rolls the user INSERT back when arming fails', async () => {
    // sanity: the happy path arms a code
    const alice = await register('atomic_ok');
    expect(alice.recoveryCode).toMatch(/^[A-HJ-NP-Z2-9]{6}(-[A-HJ-NP-Z2-9]{6}){3}$/);

    // A trigger aborts the arming UPDATE. If createUser() and armRecoveryCode()
    // were not one transaction, the user row would survive with no code.
    ctx.db.exec(`CREATE TRIGGER block_arm BEFORE UPDATE OF recovery_hash ON users
      WHEN NEW.recovery_hash IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'arm failed'); END`);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/register',
      payload: { username: 'atomic_fail', authKey: 'a'.repeat(64), publicKey: 'b'.repeat(64) },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(ctx.db.prepare('SELECT 1 FROM users WHERE username = ?').get('atomic_fail')).toBeUndefined();
  });
});
