#!/usr/bin/env node
/**
 * Extract `packages/agent-core/src/preflopCharts/data/rustVsOpen.ts` from a
 * gto-trainer preflop export.
 *
 * The source lives in another repository (`~/dev/gto-trainer`), so the input
 * path is a parameter — never hard-coded to one machine's checkout.
 *
 *   node packages/agent-core/scripts/extract-rust-vs-open.mjs \
 *     [--in <path>] [--mode round3|raw] [--out <path>] \
 *     [--emit-watchlist <path>] [--check] [--strict] [--ref <s>] [--captured <s>] [--commit <s>]
 *
 * Defaults: --in ~/dev/gto-trainer/data/preflop/charts_rust_gg.json, --mode round3,
 * --out this package's src/preflopCharts/data/rustVsOpen.ts.
 *
 * ## Containers the input may use
 *
 *   - raw snapshot (`main.rs:1843-1855`): `{ meta, providers: { solver: { <spot>: ... } } }`
 *   - round3 display export:              `{ meta, charts: { <spot>: ... } }`
 *   - a bare top-level spot map (accepted as a last resort)
 *
 * ## Why an explicit `--mode` instead of schema sniffing
 *
 * The two inputs have genuinely different semantics, not just a different field
 * name: `round3` is the *display* chart (actions <= 0.5 % dropped, 3-decimal
 * rounding, `reach < 1e-4` written as `{"na": 1}`) while `raw` is the untrimmed
 * `round3=false` snapshot (all four actions, full precision, no `na`). Sniffing
 * cannot tell "a hand the solver folded 100%" from "a hand trimmed to nothing"
 * from "a hand that never reaches this node" — exactly the ambiguity the
 * conversion must not paper over. The operator knows which file they hold, so
 * they say so, and the mode drives the documented parser.
 *
 * To keep that choice from silently misparsing, the ten in-scope spots are
 * shape-checked against the requested mode (`modeProblems`): a `na` marker in
 * raw, or `reach`/`allin`/full-precision values in round3, are *hard* markers
 * of the other mode. Without `--strict` they are warnings; with `--strict` they
 * are fatal (no file written). The one soft check is "raw mode but no raw
 * signature": a fully-3-decimal raw snapshot with no `reach`/`allin` is
 * indistinguishable from a round3 chart, so that is a warning that never blocks
 * the write, even under `--strict` — strict blocks wrong input, not input it
 * merely cannot positively confirm.
 *
 * ## Precision
 *
 * Full precision is preserved on both sides of a raw run: the input is read at
 * full precision and the emitted action frequencies are full precision too
 * (`String(v)`); round3 mode emits the 3-decimal display form. The residual
 * diagnostics are derived quantities and always use the 3-decimal formatter.
 *
 * ## Named dict, not positional
 *
 * Every cell is a *named* action dict: `{"66":{"raise":1.0}}`. Actions are read
 * by name (`fold`/`call`/`raise`/`allin`, `main.rs:1442/1452`) — never by array
 * index, which would silently scramble the strategy.
 *
 * ## `na` / `reach` semantics (do not "fix" this by reading zeros as folds)
 *
 * `na` means `reach[hand] < 1e-4`: the hand can practically not reach this node,
 * so it has no meaningful strategy here. It is **not** a fold and **not**
 * "unsolved"; it means "out of range at this node". This generator emits such
 * hands **by omission** from the spot map, so the provider's `normalizeRustTriple`
 * returns `null` and the caller falls back to the legacy raise.
 *
 * An absent/`na` hand and a legitimate all-zero cell (a class dealt here that
 * genuinely does not act) are indistinguishable from a `[raise, call, fold]`
 * triple. In `raw` mode, when a per-hand `reach` field is present we use it to
 * drop `reach < 1e-4` hands; when it is absent we cannot tell the two apart and
 * we say so in the run report instead of inventing a distinction.
 *
 * ## Scope (plan C)
 *
 * Only the ten non-BB `X-vs-open-Y` spots are extracted. RFI / BB defence /
 * vs-3bet / vs-4bet are deliberately out of scope.
 *
 * ## Determinism
 *
 * Output is byte-for-byte reproducible from (input, mode): spot order is the
 * fixed `SPOTS` list, hand order is the canonical `allHandClasses()` order
 * (mirrored below) and every number goes through `fmt(_, mode)`. Re-running over
 * the current input reproduces the committed `data/rustVsOpen.ts` (the
 * declaration header is emitted here too, so it survives regeneration).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// --- arguments --------------------------------------------------------------

const DEFAULT_IN = '~/dev/gto-trainer/data/preflop/charts_rust_gg.json';
const OUT_DEFAULT = fileURLToPath(
  new URL('../src/preflopCharts/data/rustVsOpen.ts', import.meta.url),
);

function parseArgs(argv) {
  const o = { in: DEFAULT_IN, mode: 'round3', out: OUT_DEFAULT, emitWatchlist: null, check: false, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    if (a === '--in') o.in = next();
    else if (a === '--mode') o.mode = next();
    else if (a === '--out') o.out = next();
    else if (a === '--emit-watchlist') o.emitWatchlist = next();
    else if (a === '--ref') o.ref = next();
    else if (a === '--captured') o.captured = next();
    else if (a === '--commit') o.commit = next();
    else if (a === '--check') o.check = true;
    else if (a === '--strict') o.strict = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (o.mode !== 'round3' && o.mode !== 'raw') {
    throw new Error(`--mode must be "round3" or "raw" (got "${o.mode}")`);
  }
  return o;
}

function expandHome(p) {
  return p === '~' || p.startsWith('~/') ? p.replace(/^~/, homedir()) : p;
}

// --- canonical hand order (mirrors rangeParser.allHandClasses()) ------------

const RANK_CHARS = '23456789TJQKA';
/** All 169 classes in the same order as `rangeParser.allHandClasses()`. */
function allHandKeys() {
  const out = [];
  for (let high = 0; high < 13; high++) {
    for (let low = 0; low <= high; low++) {
      out.push(RANK_CHARS[high] + RANK_CHARS[low] + (high === low ? '' : 's'));
      if (high !== low) out.push(RANK_CHARS[high] + RANK_CHARS[low] + 'o');
    }
  }
  return out;
}

// --- scope + watch-list definition (plan C) ---------------------------------

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

const WATCHLIST_THRESHOLD = 0.99;
const PREMIUM_EXCLUDED = ['AA', 'KK', 'QQ', 'JJ', 'TT', 'AKs', 'AKo', 'AQs', 'AQo'];

// --- number formatting ------------------------------------------------------

/**
 * Round3 display formatter: 3 decimals, drop trailing zeros, keep >= 1 decimal.
 * Used for the round3 emission and for the (derived) residual diagnostics.
 */
function fmt3(v) {
  const s = Number(v).toFixed(3).replace(/0+$/, '');
  return s.endsWith('.') ? `${s}0` : s;
}

/**
 * Action-frequency formatter.
 *   - raw: emit the value at full precision (`String` is the shortest
 *     round-tripping decimal for a double) — the raw snapshot is not rounded;
 *   - round3: emit the 3-decimal display form.
 * Note the residual diagnostics always use `fmt3` (they are derived, not source
 * precision), so "full precision" refers to the emitted action frequencies.
 */
function fmt(v, mode) {
  return mode === 'raw' ? String(v) : fmt3(v);
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** True when a value carries more precision than the round3 3-decimal display. */
function isFullPrecision(v) {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v * 1000 - Math.round(v * 1000)) > 1e-9;
}

// --- parsing ----------------------------------------------------------------

/**
 * Locate the chart map. The raw snapshot (`main.rs:1843-1855`) nests it under
 * `providers.solver`; the round3 display export uses `charts`. A bare top-level
 * map is accepted as a last resort (minus the `meta`/`providers` envelopes).
 */
function extractChartMap(doc) {
  if (doc?.providers?.solver && typeof doc.providers.solver === 'object') {
    return doc.providers.solver;
  }
  if (doc?.charts && typeof doc.charts === 'object') {
    return doc.charts;
  }
  const out = {};
  for (const [k, v] of Object.entries(doc ?? {})) {
    if (k !== 'meta' && k !== 'providers') out[k] = v;
  }
  return out;
}

/**
 * Cheap shape signature of one named cell, used to detect a `--mode` mismatch.
 * Only the ten in-scope spots are scanned, so round3's out-of-scope `na` cells
 * (vs-3bet / vs-4bet) cannot trigger a false positive.
 */
function cellSignature(cell, sig) {
  if (!cell || typeof cell !== 'object') return;
  if ('na' in cell) sig.na++;
  if ('reach' in cell) sig.reach++;
  if ('allin' in cell) sig.allin++;
  for (const [k, v] of Object.entries(cell)) {
    if (k === 'na' || k === 'reach') continue;
    if (isFullPrecision(v)) sig.fullPrecision++;
  }
}

/**
 * Compare the observed cell-shape signatures against the requested mode.
 *
 * Two severities:
 *   - `error`   — the input carries a marker that is *positively* impossible
 *     in the requested mode (`na`/`reach`/`allin`/full-precision value). Fatal
 *     under `--strict`.
 *   - `warning` — the input merely fails to *positively confirm* raw shape (no
 *     `reach`, no `allin`, no >3-decimal value). A legitimate raw snapshot with
 *     every action at exactly three decimals and no `reach` looks identical, so
 *     this is "unconfirmed", not "confirmed wrong". It is never fatal, even
 *     under `--strict`: strict blocks wrong input, not input it cannot prove.
 *
 * The two raw problems are mutually exclusive: once `na` (a definite round3
 * marker) is found, the absence of a raw signature is redundant information.
 */
function modeProblems(mode, sig) {
  const problems = [];
  if (mode === 'raw') {
    if (sig.na > 0) {
      problems.push({
        severity: 'error',
        message: `--mode raw but the input has ${sig.na} \`na\` cell(s) — a round3 marker; raw snapshots do not write \`na\`.`,
      });
    } else if (sig.reach === 0 && sig.allin === 0 && sig.fullPrecision === 0) {
      problems.push({
        severity: 'warning',
        message:
          '--mode raw but the input shows no raw signature (no `reach`, no `allin`, no >3-decimal value); it could be a round3 display chart or a fully-3-decimal raw snapshot — verify the source.',
      });
    }
  } else {
    if (sig.reach > 0) {
      problems.push({
        severity: 'error',
        message: `--mode round3 but the input has ${sig.reach} \`reach\` cell(s) — a raw marker.`,
      });
    }
    if (sig.allin > 0) {
      problems.push({
        severity: 'error',
        message: `--mode round3 but the input has ${sig.allin} \`allin\` cell(s); round3 display has no fourth action.`,
      });
    }
    if (sig.fullPrecision > 0) {
      problems.push({
        severity: 'error',
        message: `--mode round3 but the input has ${sig.fullPrecision} >3-decimal value(s); round3 display is 3-decimal.`,
      });
    }
  }
  return problems;
}

/**
 * Classify one named cell.
 *   - `null`          -> hand absent from the spot (no data)
 *   - `{ unreachable: true }` -> `na` / `reach < 1e-4` (out of range here)
 *   - `{ triple }`    -> [raise, call, fold] with allin folded into raise
 * `residual` is |1 - sum(all named actions)| for the spot-level max/count.
 */
function parseCell(cell) {
  if (cell === null || cell === undefined) return null;
  if (typeof cell !== 'object') {
    throw new Error(`malformed cell (expected named dict): ${JSON.stringify(cell)}`);
  }
  if ('na' in cell) return { unreachable: true };
  if (typeof cell.reach === 'number' && cell.reach < 1e-4) return { unreachable: true };
  // `allin` is folded into `raise`: the provider wants the aggressive
  // (3-bet / jam) frequency, and a 4-component triple does not exist.
  const allin = num(cell.allin);
  const raise = num(cell.raise) + allin;
  const call = num(cell.call);
  const fold = num(cell.fold);
  let total = 0;
  for (const [k, v] of Object.entries(cell)) {
    if (k === 'reach' || k === 'na') continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`non-numeric action "${k}": ${JSON.stringify(v)}`);
    }
    total += v;
  }
  return { triple: [raise, call, fold], residual: Math.abs(1 - total), total };
}

function build(opt) {
  const inputDisplay = opt.in;
  const doc = JSON.parse(readFileSync(expandHome(opt.in), 'utf8'));
  const charts = extractChartMap(doc);
  const meta = doc && typeof doc.meta === 'object' ? doc.meta : {};

  const report = { unreachable: 0, ambiguousEmpty: 0, spots: 0, hands: 0 };
  const sig = { na: 0, reach: 0, allin: 0, fullPrecision: 0 };
  const spotBlocks = [];
  const residualMaxBySpot = [];
  const residualCountBySpot = [];
  const spotTriples = new Map(); // spotKey -> Map<hand, triple>

  for (const spotKey of SPOTS) {
    const spot = charts[spotKey];
    if (!spot || typeof spot !== 'object') {
      throw new Error(`spot "${spotKey}" missing from input`);
    }
    report.spots++;
    const rows = [];
    const triples = new Map();
    let residualMax = 0;
    let residualCount = 0;
    for (const hand of allHandKeys()) {
      cellSignature(spot[hand], sig);
      const parsed = parseCell(spot[hand]);
      if (parsed === null) continue; // absent -> no data (provider falls back)
      if (parsed.unreachable) {
        report.unreachable++;
        continue; // omit: "out of range here", never a fold
      }
      const [r, c, f] = parsed.triple;
      // A cell with no positive action mass may be a legitimate all-zero cell
      // or (when `reach` is absent) an unreachable hand we cannot recognise.
      if (parsed.total === 0) report.ambiguousEmpty++;
      rows.push(`      "${hand}": [${fmt(r, opt.mode)}, ${fmt(c, opt.mode)}, ${fmt(f, opt.mode)}],`);
      report.hands++;
      if (parsed.residual > residualMax) residualMax = parsed.residual;
      if (parsed.residual > 1e-9) residualCount++;
      triples.set(hand, parsed.triple);
    }
    spotTriples.set(spotKey, triples);
    residualMaxBySpot.push([spotKey, residualMax]);
    residualCountBySpot.push([spotKey, residualCount]);
    spotBlocks.push(`    "${spotKey}": {\n${rows.join('\n')}\n    },`);
  }

  const problems = modeProblems(opt.mode, sig);
  report.signature = sig;
  report.problems = problems;

  // The round3 note is kept verbatim so regenerating over the current input
  // reproduces the committed data byte-for-byte (header aside).
  const note =
    opt.mode === 'raw'
      ? 'GGPoker rake-aware 6-max 100bb non-BB vs-open subset from the round3=false raw snapshot; raise is normalised on read and the raw residual is recorded per spot.'
      : 'GGPoker rake-aware 6-max 100bb non-BB vs-open subset; raise is normalised on read and the raw residual is recorded per spot.';

  const provenance = [
    ['provider', '"gto-trainer-rust-cfr-gg"'],
    ['url', '"internal://~/dev/gto-trainer"'],
    ['commit', JSON.stringify(opt.commit ?? 'frozen-2026-10-06')],
    ['ref', JSON.stringify(opt.ref ?? basename(expandHome(opt.in)))],
    ['license', '"self-written Rust CFR+ (internal)"'],
    ['capturedAt', JSON.stringify(opt.captured ?? '2026-10-06T00:00:00Z')],
    ['sourceFile', JSON.stringify(inputDisplay)],
    ['note', JSON.stringify(note)],
  ];

  const watchlist = buildWatchlist(spotTriples);
  const header = renderHeader({
    sourceFile: inputDisplay,
    format: meta.format,
    table: meta.table,
    stakes: meta.stakes,
    mode: opt.mode,
    extreme: watchlist.entries.length,
  });

  const lines = [];
  lines.push(header);
  lines.push("import type { RawProvenance } from '../types.js';");
  lines.push('');
  lines.push('/** `[raise, call, fold]` raw action frequencies for one hand class. */');
  lines.push('export type RustVsOpenTriple = readonly [number, number, number];');
  lines.push('export type RustVsOpenSpot = Record<string, RustVsOpenTriple>;');
  lines.push('');
  lines.push('export interface RustVsOpenFile {');
  lines.push('  provenance: RawProvenance & {');
  lines.push('    /** Worst |1 - sum(actions)| per spot, measured on the export before normalisation. */');
  lines.push('    residualMaxBySpot: Record<string, number>;');
  lines.push('    /** Hand classes per spot whose raw sum deviated from 1 by more than 1e-9. */');
  lines.push('    residualCountBySpot: Record<string, number>;');
  lines.push('  };');
  lines.push('  spots: Record<string, RustVsOpenSpot>;');
  lines.push('}');
  lines.push('');
  lines.push('export const RUST_VS_OPEN: RustVsOpenFile = {');
  lines.push('  provenance: {');
  for (const [k, v] of provenance) lines.push(`    ${k}: ${v},`);
  lines.push('    residualMaxBySpot: {');
  for (const [k, v] of residualMaxBySpot) lines.push(`      "${k}": ${fmt3(v)},`);
  lines.push('    },');
  lines.push('    residualCountBySpot: {');
  for (const [k, v] of residualCountBySpot) lines.push(`      "${k}": ${v},`);
  lines.push('    },');
  lines.push('  },');
  lines.push('  spots: {');
  lines.push(...spotBlocks);
  lines.push('  },');
  lines.push('};');
  lines.push('');
  return { text: lines.join('\n'), report, watchlist };
}

// --- declaration header (emitted, so regeneration cannot drop it) -----------

function renderHeader({ sourceFile, format, table, stakes, mode, extreme }) {
  const modeLine =
    mode === 'raw'
      ? '//   --mode raw read the round3=false RAW snapshot (all actions, full precision, no `na`).'
      : '//   --mode round3 read the round3=true DISPLAY chart; the untrimmed round3=false';
  return [
    '// AUTO-GENERATED by packages/agent-core/scripts/extract-rust-vs-open.mjs — DO NOT EDIT.',
    '// Regenerate: node packages/agent-core/scripts/extract-rust-vs-open.mjs [--in <path>] [--mode round3|raw]',
    modeLine,
    mode === 'round3'
      ? '//   raw snapshot (`raw_<k>.json`, `outer_loop.py:445-470`) is NOT embedded.'
      : '//   (Solver path: `main.rs:1741 PREFLOP_RANGE_SNAPSHOT` -> `outer_loop.py:445-470`.)',
    '//',
    '// ⚠️ APPROXIMATION DISCLAIMER — this is NOT a GTO baseline.',
    '//',
    `// Source: ${sourceFile} (format ${format ?? '?'}, ${table ?? '?'}, ${stakes ?? '?'}).`,
    ...(mode === 'raw'
      ? [
          '// Source format: round3=false RAW snapshot. Input: all four actions at full precision,',
          '//   no `na`. Output: action frequencies are emitted at full precision (`String(v)`), not',
          '//   rounded; no round3 display clipping is applied. Residual diagnostics stay at 3 decimals.',
        ]
      : [
          '// Round3 clipping (accepted cost): actions <= 0.5 % dropped (`main.rs:1454`), 3-decimal',
          '//   rounding (a displayed 1.0 can be 0.995-1.0), `reach < 1e-4` written `na` (`main.rs:1437`).',
        ]),
    '// Solver: proxy leaves (`builtin_proxy_fill`), mean-field CFR, 2000 iterations, approximate',
    '//   EV -> approximate, NOT equilibrium (full note in the provider header).',
    '// Calibration: gamma = 1.70 / erf = 0.16 were calibrated at rake = 0 but used at rake 0.05;',
    '//   leaves are proxy ranges (IP 53 classes / OOP 57 classes).',
    '// `na` semantics: `reach[hand] < 1e-4` means the hand practically cannot reach this node,',
    '//   so its strategy is meaningless. It is NOT a fold and NOT "unsolved" — treat it as out of',
    '//   range here. An `na` hand and a legitimate all-zero cell (a class dealt here that genuinely',
    '//   does not act) are indistinguishable from a `[raise, call, fold]` triple, so a future',
    '//   raw-snapshot conversion must preserve the source `reach`/`na` semantics rather than trying',
    '//   to recover them from `[0,0,0]`. This generator drops `na`/`reach<1e-4` hands from the spot',
    '//   map, so the provider falls back to legacy for them; an absent hand means "no data", never fold.',
    '// Scope (plan C): only the non-BB cold-3bet `raise` is taken from this export; RFI / BB defence',
    '//   / vs-3bet / vs-4bet are untouched, the legacy baseline is not replaced, no old table is',
    '//   spliced in, and `call` stays legacy.',
    `// Known extreme values: ${extreme} non-premium > ${WATCHLIST_THRESHOLD} frequencies across the ${SPOTS.length} non-BB vs-open spots`,
    '//   (normalised raise; premium = ' + PREMIUM_EXCLUDED.join(',') + ') are a symptom of this approximation,',
    '//   passed through verbatim (no filtering/smoothing); watch-list in',
    '//   `packages/agent-core/test/fixtures/rustVsOpenExtremeFrequencies.json`.',
    '// Planned fix: real leaves + converged iterations, then swap the data source.',
    '//',
    '// ONLY the non-BB `X-vs-open-Y` spots are embedded: the BB faces an open through the FRLA',
    '// anchor, and RFI / vs-3bet / vs-4bet stay on their existing providers. Per hand class the',
    '// triple is [raise, call, fold]; the provider normalises the raise probability on read and',
    '// never folds the raw residual away.',
  ].join('\n');
}

// --- watch-list (derived; emitted only on request) --------------------------

function buildWatchlist(spotTriples) {
  const entries = [];
  for (const spot of [...SPOTS].sort()) {
    const triples = spotTriples.get(spot) ?? new Map();
    const rows = [];
    for (const [hand, [r, c, f]] of triples) {
      if (PREMIUM_EXCLUDED.includes(hand)) continue;
      const total = r + c + f;
      if (!(total > 0)) continue;
      const p = Math.min(1, Math.max(0, r / total));
      if (p > WATCHLIST_THRESHOLD) rows.push({ hand, raise: Math.round(p * 1000) / 1000 });
    }
    rows.sort((a, b) => (a.hand < b.hand ? -1 : a.hand > b.hand ? 1 : 0));
    for (const row of rows) entries.push({ spot, hand: row.hand, raise: row.raise });
  }
  return {
    threshold: WATCHLIST_THRESHOLD,
    premiumExcluded: PREMIUM_EXCLUDED,
    entries,
  };
}

// --- main -------------------------------------------------------------------

function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help) {
    process.stdout.write(
      'usage: extract-rust-vs-open.mjs [--in <path>] [--mode round3|raw] [--out <path>]\n' +
        '         [--emit-watchlist <path>] [--check] [--strict] [--ref <s>] [--captured <s>] [--commit <s>]\n',
    );
    return;
  }
  const { text, report, watchlist } = build(opt);

  if (report.problems.length > 0) {
    const errors = report.problems.filter((p) => p.severity === 'error');
    for (const p of report.problems) {
      // A hard problem is only escalated to `error` under --strict; a soft
      // ("unconfirmed") one stays a warning even there.
      const label = p.severity === 'warning' ? 'warning' : opt.strict ? 'error' : 'warning';
      process.stderr.write(`${label}: ${p.message}\n`);
    }
    if (opt.strict && errors.length > 0) {
      process.stderr.write('strict: refusing to write; fix --mode/--in or drop --strict\n');
      process.exitCode = 1;
      return;
    }
  }

  if (opt.check) {
    let current;
    try {
      current = readFileSync(opt.out, 'utf8');
    } catch (err) {
      process.stderr.write(`check: cannot read ${opt.out}: ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    if (current === text) {
      process.stdout.write(`check: OK — ${opt.out} matches the script output\n`);
    } else {
      process.stderr.write(
        `check: MISMATCH — ${opt.out} differs from the script output (regenerate it)\n`,
      );
      process.exitCode = 1;
    }
    return;
  }

  writeFileSync(opt.out, text);
  if (opt.emitWatchlist) {
    writeFileSync(opt.emitWatchlist, `${JSON.stringify(watchlist, null, 2)}\n`);
  }
  const s = report.signature;
  process.stdout.write(
    `wrote ${opt.out}\n` +
      `  mode=${opt.mode} spots=${report.spots} hands=${report.hands}` +
      ` precision=${opt.mode === 'raw' ? 'full' : '3-decimal'}\n` +
      `  signatures: na=${s.na} reach=${s.reach} allin=${s.allin} >3dp-values=${s.fullPrecision}\n` +
      `  unreachable omitted (na / reach<1e-4)=${report.unreachable}` +
      (opt.mode === 'raw'
        ? `, all-zero cells kept=${report.ambiguousEmpty} (reach absent => cannot be distinguished from unreachable)\n`
        : '\n') +
      (opt.emitWatchlist ? `  watch-list entries=${watchlist.entries.length} -> ${opt.emitWatchlist}\n` : ''),
  );
}

main();
