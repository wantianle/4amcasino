import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RUST_VS_OPEN,
  normalizeRustTriple,
  parseRange,
  preflopActionOrder,
  RFI_RANGES,
  rustVsOpenSpotKey,
  type Position,
} from '../src/index.js';

/**
 * CI-level sanity surface for the Rust vs-open export. Two jobs:
 *
 *  1. **Extreme-frequency watch-list.** The Rust CFR+ export is approximate
 *     ("approximate leaves"), so it legitimately contains hand classes the
 *     solver raises at ~100% that a hand-built range would never treat as a
 *     pure 3-bet (e.g. `66`, `JTs`, `A5s` vs a UTG open). The task is to PASS
 *     THEM THROUGH unchanged and make them *visible*: this test lists every
 *     non-premium class the export raises above `THRESHOLD` and freezes the
 *     list, so a future export change that adds or removes one fails CI and
 *     gets an intentional review. It never filters or smooths a value.
 *
 *  2. **9-max coverage quantification.** Only seats whose preflop action-order
 *     suffix matches a 6-max seat map onto Rust (see `rustVsOpen.ts`). In 9-max
 *     the early seats UTG/UTG1/MP do NOT map, and UTG is the most common opener,
 *     so the real lift is far below the 6-max number. This test computes the
 *     mapped share of vs-open decision points, weighted by the RFI width of the
 *     opener's position, and pins it.
 *
 * Regenerate the watch-list with:
 *   UPDATE_SNAPSHOTS=1 npx vitest run packages/agent-core/test/rustVsOpenSanity.test.ts
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WATCHLIST_PATH = join(HERE, 'fixtures', 'rustVsOpenExtremeFrequencies.json');
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';
const THRESHOLD = 0.99;

/**
 * The classes an owner would NOT be surprised to see raised near 100% by a
 * solver: the strongest pairs / broadway aces. Everything else above the
 * threshold is surfaced for manual confirmation.
 */
const PREMIUM = new Set(['AA', 'KK', 'QQ', 'JJ', 'TT', 'AKs', 'AKo', 'AQs', 'AQo']);

interface ExtremeEntry {
  spot: string;
  hand: string;
  raise: number;
}

/** Sorted, fully enumerated non-premium raise frequencies above `THRESHOLD`. */
function extremeNonPremium(threshold: number): ExtremeEntry[] {
  const out: ExtremeEntry[] = [];
  for (const spot of Object.keys(RUST_VS_OPEN.spots)) {
    const hands = RUST_VS_OPEN.spots[spot]!;
    for (const hand of Object.keys(hands)) {
      const p = normalizeRustTriple(hands[hand]);
      if (p !== null && p > threshold && !PREMIUM.has(hand)) {
        out.push({ spot, hand, raise: Number(p.toFixed(6)) });
      }
    }
  }
  out.sort((a, b) => (a.spot < b.spot ? -1 : a.spot > b.spot ? 1 : a.hand < b.hand ? -1 : 1));
  return out;
}

// --- coverage model --------------------------------------------------------

const POSITIONS: Record<'6max' | '9max', readonly Position[]> = {
  '6max': ['SB', 'BB', 'UTG', 'HJ', 'CO', 'BTN'],
  '9max': ['SB', 'BB', 'UTG', 'UTG1', 'MP', 'LJ', 'HJ', 'CO', 'BTN'],
};

/** Action-order suffix length (players still to act) for a seat. */
function behindCount(pos: Position, table: readonly Position[]): number {
  const order = preflopActionOrder(Array.from({ length: table.length }, (_, i) => i));
  const idx = order.indexOf(table.indexOf(pos));
  return idx < 0 ? -1 : order.length - 1 - idx;
}

interface Coverage {
  /**
   * `openerCoverage`: mapped opener positions weighted by their RFI width /
   * all opener weight. This is "what share of opens come from a mapped seat".
   * 6-max 70.35%, 9-max 57.00%.
   */
  openerCoverage: number;
  /**
   * `vsOpenDecisionPointCoverage`: mapped (opener, eligible-hero) decision
   * points / all such points, where each pair is weighted by the opener's RFI
   * width and the eligible hero seats (every non-BB seat acting after the
   * opener) are treated uniformly. This is NOT the opener-weighted opener
   * coverage above — it is strictly the vs-open decision-point coverage.
   * Intervening folds are not modelled, so it OVER-counts far heroes and is an
   * upper bound. 6-max 100.00%, 9-max 49.78%.
   */
  vsOpenDecisionPointCoverage: number;
  byPosition: Array<{ pos: Position; behind: number; rfiShare: number; mapped: boolean }>;
}

function coverageFor(table: readonly Position[]): Coverage {
  const width: Partial<Record<Position, number>> = {};
  let total = 0;
  for (const pos of table) {
    const combos = RFI_RANGES[pos] ? parseRange(RFI_RANGES[pos]).combos : 0;
    width[pos] = combos;
    total += combos;
  }
  let mappedOpenWeight = 0;
  for (const pos of table) {
    const b = behindCount(pos, table);
    if (b >= 2 && b <= 5) mappedOpenWeight += width[pos]!;
  }
  const order = preflopActionOrder(Array.from({ length: table.length }, (_, i) => i));
  let dpTotal = 0;
  let dpMapped = 0;
  for (let oi = 0; oi < order.length; oi++) {
    const opener = table[order[oi]!]!;
    const openerBehind = behindCount(opener, table);
    for (let hi = oi + 1; hi < order.length; hi++) {
      const hero = table[order[hi]!]!;
      if (hero === 'BB') continue;
      const w = width[opener]!;
      dpTotal += w;
      if (rustVsOpenSpotKey(behindCount(hero, table), openerBehind) !== null) dpMapped += w;
    }
  }
  const byPosition = table.map((pos) => ({
    pos,
    behind: behindCount(pos, table),
    rfiShare: Number((width[pos]! / total).toFixed(4)),
    mapped: behindCount(pos, table) >= 2 && behindCount(pos, table) <= 5,
  }));
  return {
    openerCoverage: Number((mappedOpenWeight / total).toFixed(4)),
    vsOpenDecisionPointCoverage: Number((dpMapped / dpTotal).toFixed(4)),
    byPosition,
  };
}

describe('rustVsOpen: extreme-frequency watch-list', () => {
  it('serialises the non-premium >99% classes, sorted and unfiltered', () => {
    const actual = extremeNonPremium(THRESHOLD);
    if (UPDATE) {
      mkdirSync(dirname(WATCHLIST_PATH), { recursive: true });
      writeFileSync(
        WATCHLIST_PATH,
        `${JSON.stringify({ threshold: THRESHOLD, premiumExcluded: [...PREMIUM], entries: actual }, null, 2)}\n`,
      );
      return;
    }
    const fixture = JSON.parse(readFileSync(WATCHLIST_PATH, 'utf8')) as {
      threshold: number;
      premiumExcluded: string[];
      entries: ExtremeEntry[];
    };
    expect(fixture.threshold).toBe(THRESHOLD);
    expect(fixture.entries).toEqual(actual);
  });

  it('reports the per-spot counts and top extreme classes (informational)', () => {
    const all = extremeNonPremium(0); // all raises, for the top-N report
    const lines: string[] = [];
    let totalOver = 0;
    for (const spot of Object.keys(RUST_VS_OPEN.spots)) {
      const vals = all
        .filter((e) => e.spot === spot)
        .sort((a, b) => b.raise - a.raise);
      const over = vals.filter((e) => e.raise > THRESHOLD && !PREMIUM.has(e.hand));
      totalOver += over.length;
      lines.push(
        `${spot.padEnd(20)} top5=[${vals
          .slice(0, 5)
          .map((e) => `${e.hand}:${e.raise.toFixed(4)}`)
          .join(' ')}]  nonPremium>99%=${over.length}`,
      );
    }
    lines.push(`TOTAL non-premium > ${THRESHOLD}: ${totalOver}`);
    // Printed so a run always surfaces the current anomalies in CI logs.
    console.log(`\n[rustVsOpen extreme frequencies]\n${lines.join('\n')}\n`);
    // The count is pinned by the watch-list fixture above; here we only require
    // the report to be non-empty and finite, never that the values are "sane".
    expect(totalOver).toBeGreaterThan(0);
    for (const e of all) {
      expect(Number.isFinite(e.raise)).toBe(true);
      expect(e.raise).toBeGreaterThanOrEqual(0);
      expect(e.raise).toBeLessThanOrEqual(1);
    }
  });

  it('every spot carries a complete, in-range 169-class table', () => {
    expect(Object.keys(RUST_VS_OPEN.spots)).toHaveLength(10);
    for (const [spot, hands] of Object.entries(RUST_VS_OPEN.spots)) {
      expect(Object.keys(hands), spot).toHaveLength(169);
      for (const [hand, triple] of Object.entries(hands)) {
        expect(triple, `${spot} ${hand}`).toHaveLength(3);
        const p = normalizeRustTriple(triple);
        expect(p === null || (p >= 0 && p <= 1), `${spot} ${hand}`).toBe(true);
      }
    }
  });
});

describe('rustVsOpen: 9-max coverage is far below 6-max', () => {
  it('quantifies opener coverage and vs-open decision-point coverage (9-max vs 6-max)', () => {
    const nine = coverageFor(POSITIONS['9max']);
    const six = coverageFor(POSITIONS['6max']);
    console.log(
      [
        '\n[rustVsOpen mapped coverage]',
        `6max openerCoverage(opener-weighted)=${(100 * six.openerCoverage).toFixed(2)}%`,
        `6max vsOpenDecisionPointCoverage=${(100 * six.vsOpenDecisionPointCoverage).toFixed(2)}%`,
        `9max openerCoverage(opener-weighted)=${(100 * nine.openerCoverage).toFixed(2)}%`,
        `9max vsOpenDecisionPointCoverage=${(100 * nine.vsOpenDecisionPointCoverage).toFixed(2)}%`,
        '9max opener distribution:',
        ...nine.byPosition.map(
          (p) => `  ${p.pos.padEnd(5)} behind=${p.behind} rfiShare=${(100 * p.rfiShare).toFixed(1)}% ${p.mapped ? 'mapped' : 'UNMAPPED'}`,
        ),
        '',
      ].join('\n'),
    );

    // Pinned numbers (RFI width weighted). A change to the RFI tables or to the
    // position mapping moves these; that must be intentional.
    // openerCoverage: share of opens from a mapped seat.
    expect(six.openerCoverage).toBeCloseTo(0.7035, 4);
    expect(nine.openerCoverage).toBeCloseTo(0.57, 4);
    // vsOpenDecisionPointCoverage: share of (opener, eligible non-BB hero)
    // decision points that reach Rust. This is the "how much of the vs-open
    // traffic is covered" number, NOT openerCoverage.
    expect(six.vsOpenDecisionPointCoverage).toBeCloseTo(1, 4);
    expect(nine.vsOpenDecisionPointCoverage).toBeCloseTo(0.4978, 4);
    // The headline: in 9-max barely half the vs-open decision points reach Rust,
    // because UTG/UTG1/MP (the earliest and most common opens) do not map.
    // 6-max maps every non-BB vs-open decision point.
    expect(nine.vsOpenDecisionPointCoverage).toBeLessThan(six.vsOpenDecisionPointCoverage);
  });
});
