import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { publicTunables, readTunable, resolveTunables, tunablesRevision } from '../src/tunables.js';

// ---------------------------------------------------------------------------
// `GET /api/config` wire contract.
//
// The endpoint exists so frontend animation timings can change with a restart
// instead of a rebuild. It is UNAUTHENTICATED, so the suite also pins the
// security boundary: only `public: true` tunables may appear, and credentials
// have no path into the response.
// ---------------------------------------------------------------------------

const PUBLIC_KEYS = [
  'stackLandMs',
  'tableDurDimMs',
  'tableDurGlowMs',
  'tableDurHighlightMs',
  'tableDurPulseMs',
  'winFxMs',
].sort();

const ENV_KEYS = [
  'BOT_THINK_MIN_MS',
  'BOT_THINK_MAX_MS',
  'FOURAM_BOT_HARD_STOP_MS',
  'TABLE_DUR_PULSE_MS',
  'TABLE_DUR_GLOW_MS',
  'TABLE_DUR_DIM_MS',
  'TABLE_DUR_HIGHLIGHT_MS',
  'WIN_FX_MS',
  'STACK_LAND_MS',
] as const;

let ctx: ReturnType<typeof createApp>;
let dir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), '4am-config-'));
  ctx = createApp(join(dir, 'test.db'));
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(async () => {
  await ctx.app.close();
  rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const getConfig = async () => ctx.app.inject({ method: 'GET', url: '/api/config' });

describe('GET /api/config', () => {
  it('publishes exactly the whitelisted public tunables at their defaults', async () => {
    const res = await getConfig();
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json() as { tunables: Record<string, number>; revision: string };
    expect(Object.keys(body.tunables).sort()).toEqual(PUBLIC_KEYS);
    expect(body.tunables).toMatchObject({
      tableDurPulseMs: 1600,
      tableDurGlowMs: 450,
      tableDurDimMs: 460,
      tableDurHighlightMs: 620,
      winFxMs: 3000,
      stackLandMs: 910,
    });
    expect(body.revision).toMatch(/^[0-9a-f]{12}$/);
  });

  it('reflects env overrides without a rebuild', async () => {
    process.env.TABLE_DUR_GLOW_MS = '777';
    process.env.WIN_FX_MS = '5000';
    const body = (await getConfig()).json() as { tunables: Record<string, number> };
    expect(body.tunables.tableDurGlowMs).toBe(777);
    expect(body.tunables.winFxMs).toBe(5000);
  });

  it('never exposes server-only tunables', async () => {
    const body = (await getConfig()).json() as { tunables: Record<string, number> };
    expect(body.tunables).not.toHaveProperty('botThinkMinMs');
    expect(body.tunables).not.toHaveProperty('botThinkMaxMs');
    expect(body.tunables).not.toHaveProperty('botHardStopMs');
  });

  it('never leaks credentials in the response body', async () => {
    process.env.LLM_API_KEY = 'sk-live-SECRET-abcdef0123456789';
    process.env.BOT_IDENTITY_KEY = 'deadbeef'.repeat(8);
    const raw = (await getConfig()).body;
    expect(raw).not.toContain('sk-');
    expect(raw).not.toContain('SECRET');
    expect(raw).not.toContain('deadbeef');
    expect(raw).not.toContain('LLM_API_KEY');
    expect(raw).not.toContain('BOT_IDENTITY_KEY');
  });

  it('changes the revision when a public value changes', async () => {
    const before = (await getConfig()).json() as { revision: string };
    process.env.TABLE_DUR_DIM_MS = '999';
    const after = (await getConfig()).json() as { revision: string };
    expect(after.revision).not.toBe(before.revision);
  });
});

describe('tunables parsing', () => {
  it('falls back to the default on invalid, empty, or out-of-range values', () => {
    expect(readTunable('tableDurGlowMs', {})).toBe(450);
    expect(readTunable('tableDurGlowMs', { TABLE_DUR_GLOW_MS: '' })).toBe(450);
    expect(readTunable('tableDurGlowMs', { TABLE_DUR_GLOW_MS: 'abc' })).toBe(450);
    expect(readTunable('tableDurGlowMs', { TABLE_DUR_GLOW_MS: '-1' })).toBe(450);
    expect(readTunable('tableDurGlowMs', { TABLE_DUR_GLOW_MS: '999999' })).toBe(450);
    expect(readTunable('tableDurGlowMs', { TABLE_DUR_GLOW_MS: '0' })).toBe(0);
  });

  it('keeps the bot hard-stop strictly positive', () => {
    expect(readTunable('botHardStopMs', { FOURAM_BOT_HARD_STOP_MS: '0' })).toBe(120_000);
    expect(readTunable('botHardStopMs', { FOURAM_BOT_HARD_STOP_MS: '5000' })).toBe(5000);
  });

  it('resolves every declared tunable and is stable across an empty env', () => {
    const all = resolveTunables({});
    expect(all.botThinkMinMs).toBe(150);
    expect(all.botThinkMaxMs).toBe(450);
    expect(all.botHardStopMs).toBe(120_000);
    const pub = publicTunables({});
    expect(pub).toEqual({
      tableDurPulseMs: 1600,
      tableDurGlowMs: 450,
      tableDurDimMs: 460,
      tableDurHighlightMs: 620,
      winFxMs: 3000,
      stackLandMs: 910,
    });
    expect(tunablesRevision(pub)).toBe(tunablesRevision(publicTunables({})));
  });
});
