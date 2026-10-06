import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { defaultGameOpts } from '../src/hub.js';
import {
  MAX_TIMER_MS,
  publicTunables,
  readTunable,
  resolveTunables,
  tunablesRevision,
} from '../src/tunables.js';

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
  'FOURAM_AUTO_DEAL_INTERVAL_MS',
  'FOURAM_AUTO_DEAL_READY_CHECK_MS',
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

  // Boundary coverage for the regression the review found: the first cut of the
  // table added an arbitrary 10000 cap on the think bounds, so a legitimate
  // `BOT_THINK_MIN_MS=20000` was silently replaced by the default.
  describe('bot think bounds (behavior-equivalence with the old parser)', () => {
    it('accepts 0 (meaningful for a non-negative bound) and large values', () => {
      expect(readTunable('botThinkMinMs', { BOT_THINK_MIN_MS: '0' })).toBe(0);
      expect(readTunable('botThinkMaxMs', { BOT_THINK_MAX_MS: '0' })).toBe(0);
      // No arbitrary upper cap: the configured value must take effect.
      expect(readTunable('botThinkMinMs', { BOT_THINK_MIN_MS: '20000' })).toBe(20_000);
      expect(readTunable('botThinkMaxMs', { BOT_THINK_MAX_MS: '20000' })).toBe(20_000);
    });

    it('falls back on empty/non-finite/negative and floors fractions', () => {
      for (const raw of ['', 'abc', 'Infinity', 'NaN', '-1']) {
        expect(readTunable('botThinkMinMs', { BOT_THINK_MIN_MS: raw })).toBe(150);
        expect(readTunable('botThinkMaxMs', { BOT_THINK_MAX_MS: raw })).toBe(450);
      }
      // Whitespace coerces to 0, which is in range for a non-negative bound -
      // identical to the pre-refactor `parseNonNegative`.
      expect(readTunable('botThinkMinMs', { BOT_THINK_MIN_MS: '  ' })).toBe(0);
      expect(readTunable('botThinkMinMs', { BOT_THINK_MIN_MS: '150.9' })).toBe(150);
    });
  });

  describe('bot hard-stop boundaries', () => {
    it('falls back on empty/whitespace/negative/non-finite', () => {
      for (const raw of ['', '  ', '-1', 'abc', 'NaN', 'Infinity']) {
        expect(readTunable('botHardStopMs', { FOURAM_BOT_HARD_STOP_MS: raw })).toBe(120_000);
      }
    });

    it('treats a positive sub-1 value as invalid (documented behavior change)', () => {
      // Old parser: Number.isFinite && > 0 then Math.floor -> `0.5` became 0,
      // an immediate hard abort. The table's `min: 1` fixes that by falling
      // back to the default. This is deliberate; keep it pinned.
      expect(readTunable('botHardStopMs', { FOURAM_BOT_HARD_STOP_MS: '0.5' })).toBe(120_000);
    });

    it('accepts a large value beyond the old 600000 cap', () => {
      expect(readTunable('botHardStopMs', { FOURAM_BOT_HARD_STOP_MS: '900000' })).toBe(900_000);
    });
  });

  describe('auto-deal cadence (moved into the table)', () => {
    it('defaults and honours env overrides', () => {
      expect(readTunable('autoDealIntervalMs', {})).toBe(3_500);
      expect(readTunable('autoDealReadyCheckMs', {})).toBe(1_500);
      expect(readTunable('autoDealIntervalMs', { FOURAM_AUTO_DEAL_INTERVAL_MS: '2000' })).toBe(
        2_000,
      );
      expect(
        readTunable('autoDealReadyCheckMs', { FOURAM_AUTO_DEAL_READY_CHECK_MS: '800' }),
      ).toBe(800);
    });

    it('is positive-only, matching the old hub positiveInt', () => {
      for (const raw of ['0', '-5', 'abc', 'Infinity']) {
        expect(readTunable('autoDealIntervalMs', { FOURAM_AUTO_DEAL_INTERVAL_MS: raw })).toBe(
          3_500,
        );
        expect(
          readTunable('autoDealReadyCheckMs', { FOURAM_AUTO_DEAL_READY_CHECK_MS: raw }),
        ).toBe(1_500);
      }
    });

    it('treats a positive sub-1 value as invalid (documented behavior change)', () => {
      // Old hub `positiveInt`: `Number.isFinite && > 0` then `Math.floor`, so
      // `0.5` became `0` - a cadence that deals as fast as the event loop allows.
      // The table's `min: 1` sends it to the default instead. Deliberate; pinned.
      expect(
        readTunable('autoDealIntervalMs', { FOURAM_AUTO_DEAL_INTERVAL_MS: '0.5' }),
      ).toBe(3_500);
      expect(
        readTunable('autoDealReadyCheckMs', { FOURAM_AUTO_DEAL_READY_CHECK_MS: '0.5' }),
      ).toBe(1_500);
    });

    it('falls back past the setTimeout ceiling (documented behavior change)', () => {
      // Old hub `positiveInt` accepted any finite positive number. The cadence is
      // scheduled with `setTimeout`, so a delay above 2^31-1 fires at 1ms with a
      // `TimeoutOverflowWarning`; the table's `max` rejects it. The ceiling value
      // itself is still legal.
      expect(
        readTunable('autoDealIntervalMs', {
          FOURAM_AUTO_DEAL_INTERVAL_MS: String(MAX_TIMER_MS + 1),
        }),
      ).toBe(3_500);
      expect(
        readTunable('autoDealReadyCheckMs', {
          FOURAM_AUTO_DEAL_READY_CHECK_MS: String(MAX_TIMER_MS + 1),
        }),
      ).toBe(1_500);
      expect(
        readTunable('autoDealIntervalMs', {
          FOURAM_AUTO_DEAL_INTERVAL_MS: String(MAX_TIMER_MS),
        }),
      ).toBe(MAX_TIMER_MS);
    });

    it('stays server-only (never published by /api/config)', () => {
      const pub = publicTunables({});
      expect(pub).not.toHaveProperty('autoDealIntervalMs');
      expect(pub).not.toHaveProperty('autoDealReadyCheckMs');
    });

    it('is the single parse point the hub reads from', () => {
      // `hub.ts` no longer parses these itself; it delegates to `readTunable`.
      expect(defaultGameOpts({})).toMatchObject({ autoDealMs: 3_500, readyCheckMs: 1_500 });
      expect(defaultGameOpts({ FOURAM_AUTO_DEAL_INTERVAL_MS: '2000' })).toMatchObject({
        autoDealMs: 2_000,
      });
      expect(defaultGameOpts({ FOURAM_AUTO_DEAL_READY_CHECK_MS: '800' })).toMatchObject({
        readyCheckMs: 800,
      });
    });
  });

  it('resolves every declared tunable and is stable across an empty env', () => {
    const all = resolveTunables({});
    expect(all.botThinkMinMs).toBe(150);
    expect(all.botThinkMaxMs).toBe(450);
    expect(all.botHardStopMs).toBe(120_000);
    expect(all.autoDealIntervalMs).toBe(3_500);
    expect(all.autoDealReadyCheckMs).toBe(1_500);
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
