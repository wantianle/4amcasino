import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The extraction script itself is exercised end-to-end (spawned with node) so
// the raw container shape, precision and mode checks are covered as shipped.
const SCRIPT = fileURLToPath(new URL('../scripts/extract-rust-vs-open.mjs', import.meta.url));

const SPOTS = [
  'MP-vs-open-UTG',
  'CO-vs-open-UTG',
  'BTN-vs-open-UTG',
  'SB-vs-open-UTG',
  'CO-vs-open-MP',
  'BTN-vs-open-MP',
  'SB-vs-open-MP',
  'BTN-vs-open-CO',
  'SB-vs-open-CO',
  'SB-vs-open-BTN',
];

const dir = mkdtempSync(join(tmpdir(), 'rustvsopen-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Same cells in every spot, so the assertions are spot-independent. */
const RAW_CELLS = {
  '22': { fold: 1.0 },
  A5s: { fold: 0.123456789, call: 0.234567891, raise: 0.345678912, allin: 0.296296408 },
  '55': { reach: 0.00005, raise: 0.9, fold: 0.1 }, // reach < 1e-4 -> omitted
  '66': { reach: 0.5, fold: 1.0 }, // reachable pure fold -> kept
  '77': { raise: 0.9999999 }, // full precision
};

/** The real raw container: `main.rs:1843-1855` writes `{meta, providers.solver}`. */
function writeRaw(name: string, cells: Record<string, unknown> = RAW_CELLS): string {
  const solver: Record<string, unknown> = {};
  for (const spot of SPOTS) solver[spot] = JSON.parse(JSON.stringify(cells));
  const p = join(dir, name);
  writeFileSync(p, `${JSON.stringify({ meta: { format: 2, table: '6-max', stakes: '100bb' }, providers: { solver } })}\n`);
  return p;
}

/** The round3 display container: `{meta, charts}`. */
function writeRound3(name: string, cells: Record<string, unknown>): string {
  const charts: Record<string, unknown> = {};
  for (const spot of SPOTS) charts[spot] = JSON.parse(JSON.stringify(cells));
  const p = join(dir, name);
  writeFileSync(p, `${JSON.stringify({ meta: { format: 2, table: '6-max', stakes: '100bb' }, charts })}\n`);
  return p;
}

function run(args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('extract-rust-vs-open', () => {
  it('raw container ({meta, providers.solver}) parses and keeps full precision', () => {
    const input = writeRaw('raw-valid.json');
    const out = join(dir, 'raw-valid.ts');
    const r = run(['--mode', 'raw', '--in', input, '--ref', 'raw-valid.json', '--out', out]);

    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');

    const text = readFileSync(out, 'utf8');
    // allin folded into raise, full precision (not truncated to 3 decimals)
    expect(text).toContain('"A5s": [0.64197532, 0.234567891, 0.123456789],');
    expect(text).toContain('"77": [0.9999999, 0, 0],');
    expect(text).toContain('"22": [0, 0, 1],');
    expect(text).toContain('"66": [0, 0, 1],'); // reach 0.5 -> kept as pure fold
    // reach < 1e-4 -> omitted entirely (never written as a fold)
    expect(text).not.toContain('"55":');
    // no 3-decimal truncation of the source
    expect(text).not.toContain('0.642,');
    expect(text).not.toContain('"na"');
  });

  it('raw mode: --strict rejects a round3 `na` marker and writes nothing', () => {
    const input = writeRaw('raw-na.json', { '77': { na: 1 }, A5s: { fold: 0.1, call: 0.2, raise: 0.7 } });
    const out = join(dir, 'raw-na-strict.ts');
    const strict = run(['--mode', 'raw', '--in', input, '--ref', 'raw-na.json', '--out', out, '--strict']);
    expect(strict.status).toBe(1);
    expect(strict.stderr).toContain('round3 marker');
    // `na` already proves the mode is wrong; the "no raw signature" soft check
    // must not pile on a second, redundant message.
    expect(strict.stderr).not.toContain('no raw signature');
    expect(existsSync(out)).toBe(false);

    const looseOut = join(dir, 'raw-na-loose.ts');
    const loose = run(['--mode', 'raw', '--in', input, '--ref', 'raw-na.json', '--out', looseOut]);
    expect(loose.status).toBe(0);
    expect(loose.stderr).toContain('warning:');
    expect(loose.stderr).not.toContain('no raw signature');
    expect(existsSync(looseOut)).toBe(true);
  });

  it('raw mode: an all-3-decimal snapshot with no raw signature is warned about but NOT blocked by --strict', () => {
    // A legitimate raw snapshot can have every action at exactly three decimals,
    // no `reach`, no `allin`, no `na` — indistinguishable from a round3 chart by
    // value shape. "Cannot confirm raw" must not be escalated to "confirmed wrong".
    const input = writeRaw('raw-unsigned.json', {
      '22': { raise: 0.625, call: 0.125, fold: 0.25 },
      A5s: { raise: 0.5, call: 0.25, fold: 0.25 },
      '77': { raise: 0.125, call: 0.125, fold: 0.75 },
    });
    const out = join(dir, 'raw-unsigned-strict.ts');
    const r = run(['--mode', 'raw', '--in', input, '--ref', 'raw-unsigned.json', '--out', out, '--strict']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('warning:');
    expect(r.stderr).toContain('no raw signature');
    expect(r.stderr).not.toContain('error:');
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, 'utf8')).toContain('"22": [0.625, 0.125, 0.25],');
  });

  it('round3 mode: --strict rejects raw markers (reach / allin / >3-decimal)', () => {
    const input = writeRaw('raw-for-round3.json');
    const out = join(dir, 'raw-as-round3.ts');
    const r = run(['--mode', 'round3', '--in', input, '--out', out, '--strict']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('`reach`');
    expect(r.stderr).toContain('`allin`');
    expect(r.stderr).toContain('>3-decimal');
    expect(existsSync(out)).toBe(false);
  });

  it('round3 mode emits the 3-decimal display form', () => {
    const input = writeRound3('round3.json', {
      '22': { fold: 1.0 },
      A5s: { raise: 0.5, call: 0.25, fold: 0.25 },
      '77': { raise: 0.995 },
    });
    const out = join(dir, 'round3.ts');
    const r = run(['--mode', 'round3', '--in', input, '--out', out]);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    const text = readFileSync(out, 'utf8');
    expect(text).toContain('"A5s": [0.5, 0.25, 0.25],');
    expect(text).toContain('"77": [0.995, 0.0, 0.0],');
    expect(text).toContain('"22": [0.0, 0.0, 1.0],');
  });
});
