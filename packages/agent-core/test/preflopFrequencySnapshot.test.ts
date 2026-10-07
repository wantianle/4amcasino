import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cardFromName, type CardId, type PlayerAction } from '@4am/shared';
import type { DecisionSeat, DecisionView, PublicAction } from '../src/decisionView.js';
import { preflopActionOrder } from '../src/preflopCharts/index.js';
import {
  choosePreflopIntent,
  derivePreflopContext,
  adaptivePreflopAvailable,
} from '../src/preflopPolicy.js';
import { RULE_PRESETS, type RuleParams } from '../src/ruleStyles.js';
import { allHandClasses, handClassForCards, type ActionMix } from '../src/rangeParser.js';

/**
 * Preflop behaviour snapshot (phase 0 of the "A plan": baseline before tuning).
 *
 * This file does NOT test a property of the policy. It freezes the *entire*
 * preflop action distribution the rules-v1 engine produces today, so a later
 * refactor / parameter change can be diffed against it byte-for-byte.
 *
 * Method: for every spot we enumerate all 1326 concrete two-card combos, look up
 * the policy's effective raise/call probability for that combo's hand class, and
 * combo-weight the result into one action distribution over 1326. The policy
 * frequencies are exact (no RNG roll): `choosePreflopIntent(...).frequencies` is
 * the probability vector the seeded roll samples from, and two combos of the
 * same hand class always get the same vector (asserted below) because the view
 * differs only in `myCards`. Using the exact vector instead of one sampled roll
 * makes the snapshot deterministic and independent of the RNG implementation -
 * a refactor that does not change behaviour cannot change it - while still
 * covering all 1326 combos.
 *
 * Per-class coverage is COMPLETE: the snapshot stores the exact raise and call
 * probability for ALL 169 classes as two dense arrays parallel to the top-level
 * `classOrder` (4-decimal rounded, serialised inline). A regression in any
 * single class is therefore caught, not just in a curated watch-list. Because
 * the arrays are inlined, the file is smaller than the earlier 27-class version
 * despite the wider coverage.
 *
 * Regenerate with: `UPDATE_SNAPSHOTS=1 npx vitest run packages/agent-core/test/preflopFrequencySnapshot.test.ts`
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = join(HERE, 'fixtures', 'preflopFrequencySnapshot.snapshot.json');
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';

const c = (n: string) => cardFromName(n);

/** Every unordered two-card combo, index-stable: [0,1], [0,2], ..., [50,51]. */
const COMBOS: [CardId, CardId][] = (() => {
  const out: [CardId, CardId][] = [];
  for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) out.push([a, b]);
  return out;
})();
expect(COMBOS).toHaveLength(1326);

/** Combo -> its 169-class key, computed once. */
const COMBO_CLASS: string[] = COMBOS.map(([a, b]) => handClassForCards(a, b).key);

/**
 * All 169 hand classes in a stable canonical order (pairs, suited, offsuit).
 * The snapshot stores the exact raise/call probability for EVERY class, as two
 * dense arrays parallel to this order, so a regression in any single class is
 * caught - not just in a curated watch-list. The class order is written into the
 * snapshot's top-level `classOrder`.
 */
const CLASS_ORDER: string[] = allHandClasses().map((h) => h.key);
expect(CLASS_ORDER).toHaveLength(169);
expect(new Set(CLASS_ORDER).size).toBe(169);

interface SpotSpec {
  /** Stable, human-readable id: `<format>/<spot>/<position>[/opener]/b<behind>`. */
  key: string;
  format: '6max' | '9max' | 'partial';
  n: number;
  heroSeat: number;
  history: PublicAction[];
  currentBet: number;
  behind: number;
  historyComplete: boolean;
}

// --- view construction -----------------------------------------------------

function seat(over: Partial<DecisionSeat> = {}): DecisionSeat {
  return {
    seat: 0,
    userId: 1,
    displayName: 'p',
    isMe: false,
    stack: 10_000,
    committed: 0,
    total: 0,
    folded: false,
    allIn: false,
    sittingOut: false,
    connected: true,
    ...over,
  };
}

function act(seatNo: number, type: PlayerAction['type'], amount?: number): PublicAction {
  return {
    actionSeq: 0,
    street: 'preflop',
    seat: seatNo,
    action: { type, ...(amount === undefined ? {} : { amount }) },
    auto: false,
    ts: 0,
  };
}

/** 0-based dealing order [0..n-1]; seat 0 = SB. */
function seatOrderOf(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

/**
 * Build an unopened preflop view whose `needToActSeats` is the hero plus the
 * next `behind` active seats in action order, so `derivePreflopContext` reports
 * exactly that `behindUnacted` (and `actorSlot`).
 */
function makeView(spec: {
  n: number;
  heroSeat: number;
  /** Placeholder hole cards; the enumeration overwrites these per combo. */
  cards?: CardId[];
  history: PublicAction[];
  currentBet: number;
  behind: number;
  historyComplete: boolean;
}): DecisionView {
  const seatOrder = seatOrderOf(spec.n);
  const order = preflopActionOrder(seatOrder);
  const cards = spec.cards ?? [c('Ac'), c('Kd')];
  const heroIdx = order.indexOf(spec.heroSeat);
  const pending = [spec.heroSeat, ...order.slice(heroIdx + 1, heroIdx + 1 + spec.behind)];
  const me = seat({ seat: spec.heroSeat, userId: 1, displayName: 'hero', isMe: true });
  const opponents = seatOrder
    .filter((s) => s !== spec.heroSeat)
    .map((s) => seat({ seat: s, userId: 100 + s, displayName: `v${s}` }));
  return {
    room: { id: 'r', name: 'r', sb: 50, bb: 100, minSettleHands: 0, sevenDeuceBonus: 0 },
    hand: {
      handId: 'h',
      street: 'preflop',
      buttonSeat: spec.n === 2 ? 0 : spec.n - 1,
      board: [],
      pot: 150,
      currentBet: spec.currentBet,
      toAct: spec.heroSeat,
      deadline: null,
      myCards: cards,
      mySeat: spec.heroSeat,
    },
    me,
    legalActions: null,
    potOdds: null,
    actionHistory: spec.history,
    opponents,
    sessionMemory: { handsObserved: 0, netChips: null, recentHands: [], opponents: [] },
    historyComplete: spec.historyComplete,
    seatOrder,
    actionSeq: 0,
    needToActSeats: pending,
  };
}

// --- spot catalogue --------------------------------------------------------

/**
 * Position seating for the two formats:
 *   6-max: 0 SB, 1 BB, 2 UTG, 3 HJ, 4 CO, 5 BTN
 *   9-max: 0 SB, 1 BB, 2 UTG, 3 UTG1, 4 MP, 5 LJ, 6 HJ, 7 CO, 8 BTN
 */
const SIX = { SB: 0, BB: 1, UTG: 2, HJ: 3, CO: 4, BTN: 5 } as const;
const NINE = { SB: 0, BB: 1, UTG: 2, UTG1: 3, MP: 4, LJ: 5, HJ: 6, CO: 7, BTN: 8 } as const;

const REQ_BEHIND = [0, 2, 4, 6, 8];

/** Reachable behind-unacted counts for a hero seat at an n-handed table. */
function reachableBehind(n: number, heroSeat: number): number[] {
  const order = preflopActionOrder(seatOrderOf(n));
  const natural = order.indexOf(heroSeat) < 0 ? 0 : order.length - 1 - order.indexOf(heroSeat);
  return REQ_BEHIND.filter((b) => b <= natural);
}

/** Position label from the dealing-order table, for report readability only. */
const POSITIONS_BY_COUNT: Record<number, string[]> = {
  6: ['SB', 'BB', 'UTG', 'HJ', 'CO', 'BTN'],
  9: ['SB', 'BB', 'UTG', 'UTG1', 'MP', 'LJ', 'HJ', 'CO', 'BTN'],
};
function label(n: number, seatNo: number): string {
  return POSITIONS_BY_COUNT[n]?.[seatNo] ?? `s${seatNo}`;
}

function buildSpots(): SpotSpec[] {
  const spots: SpotSpec[] = [];
  const push = (s: SpotSpec) => spots.push(s);

  // 1. RFI (unopened) -------------------------------------------------------
  const rfiByFormat: Array<{ tag: '6max' | '9max'; n: number; seats: number[] }> = [
    { tag: '6max', n: 6, seats: [SIX.UTG, SIX.HJ, SIX.CO, SIX.BTN, SIX.SB] },
    { tag: '9max', n: 9, seats: [NINE.UTG, NINE.MP, NINE.CO, NINE.BTN, NINE.SB] },
  ];
  for (const { tag, n, seats } of rfiByFormat) {
    for (const hero of seats) {
      for (const b of reachableBehind(n, hero)) {
        push({
          key: `${tag}/unopened/${label(n, hero)}/b${b}`,
          format: tag,
          n,
          heroSeat: hero,
          history: [],
          currentBet: 100,
          behind: b,
          historyComplete: true,
        });
      }
    }
  }

  // 2. facingOpen, non-BB ---------------------------------------------------
  // [hero, opener] pairs; hero must act after the opener in preflop order.
  const openNonBB: Array<{ tag: '6max' | '9max'; n: number; hero: number; opener: number }> = [
    { tag: '6max', n: 6, hero: SIX.HJ, opener: SIX.UTG },
    { tag: '6max', n: 6, hero: SIX.CO, opener: SIX.UTG },
    { tag: '6max', n: 6, hero: SIX.BTN, opener: SIX.UTG },
    { tag: '6max', n: 6, hero: SIX.BTN, opener: SIX.HJ },
    { tag: '6max', n: 6, hero: SIX.SB, opener: SIX.UTG },
    { tag: '6max', n: 6, hero: SIX.SB, opener: SIX.BTN },
    { tag: '9max', n: 9, hero: NINE.MP, opener: NINE.UTG },
    { tag: '9max', n: 9, hero: NINE.CO, opener: NINE.UTG },
    { tag: '9max', n: 9, hero: NINE.BTN, opener: NINE.UTG },
    { tag: '9max', n: 9, hero: NINE.BTN, opener: NINE.MP },
    { tag: '9max', n: 9, hero: NINE.SB, opener: NINE.BTN },
  ];
  for (const { tag, n, hero, opener } of openNonBB) {
    for (const b of REQ_BEHIND.filter((x) => x <= 4).filter((x) => x <= reachableMax(n, hero))) {
      push({
        key: `${tag}/facingOpen/${label(n, hero)}-vs-${label(n, opener)}/b${b}`,
        format: tag,
        n,
        heroSeat: hero,
        history: [act(opener, 'raise', 250)],
        currentBet: 250,
        behind: b,
        historyComplete: true,
      });
    }
  }

  // 3. facingOpen, hero = BB ------------------------------------------------
  const bbOpeners: Array<{ tag: '6max' | '9max'; n: number; opener: number }> = [
    { tag: '6max', n: 6, opener: SIX.UTG },
    { tag: '6max', n: 6, opener: SIX.HJ },
    { tag: '6max', n: 6, opener: SIX.CO },
    { tag: '6max', n: 6, opener: SIX.BTN },
    { tag: '6max', n: 6, opener: SIX.SB },
    { tag: '9max', n: 9, opener: NINE.UTG },
    { tag: '9max', n: 9, opener: NINE.MP },
    { tag: '9max', n: 9, opener: NINE.CO },
    { tag: '9max', n: 9, opener: NINE.BTN },
    { tag: '9max', n: 9, opener: NINE.SB },
  ];
  for (const { tag, n, opener } of bbOpeners) {
    const b = 0; // the BB always closes the preflop action: nobody is behind it.
    const heroSeat = tag === '6max' ? SIX.BB : NINE.BB;
    push({
      key: `${tag}/facingOpen/BB-vs-${label(n, opener)}/b${b}`,
      format: tag,
      n,
      heroSeat,
      history: [act(opener, 'raise', 250)],
      currentBet: 250,
      behind: b,
      historyComplete: true,
    });
  }

  // 4. facing3Bet (hero opened, now faces a 3-bet) --------------------------
  const f3: Array<{ tag: '6max' | '9max'; n: number; hero: number; villain: number }> = [
    { tag: '6max', n: 6, hero: SIX.UTG, villain: SIX.BTN },
    { tag: '6max', n: 6, hero: SIX.CO, villain: SIX.BTN },
    { tag: '6max', n: 6, hero: SIX.BTN, villain: SIX.SB },
    { tag: '9max', n: 9, hero: NINE.MP, villain: NINE.BTN },
    { tag: '9max', n: 9, hero: NINE.CO, villain: NINE.BTN },
  ];
  for (const { tag, n, hero, villain } of f3) {
    for (const b of [0, 2, 4].filter((x) => x <= reachableMax(n, hero))) {
      push({
        key: `${tag}/facing3Bet/${label(n, hero)}-opened-vs-${label(n, villain)}/b${b}`,
        format: tag,
        n,
        heroSeat: hero,
        history: [act(hero, 'raise', 250), act(villain, 'raise', 750)],
        currentBet: 750,
        behind: b,
        historyComplete: true,
      });
    }
  }

  // 5. facing3BetCold (hero has not acted) ----------------------------------
  const cold: Array<{ tag: '6max' | '9max'; n: number; hero: number; opener: number; villain: number }> = [
    { tag: '6max', n: 6, hero: SIX.CO, opener: SIX.UTG, villain: SIX.BTN },
    { tag: '9max', n: 9, hero: NINE.MP, opener: NINE.UTG, villain: NINE.BTN },
  ];
  for (const { tag, n, hero, opener, villain } of cold) {
    for (const b of [0, 2].filter((x) => x <= reachableMax(n, hero))) {
      push({
        key: `${tag}/facing3BetCold/${label(n, hero)}/b${b}`,
        format: tag,
        n,
        heroSeat: hero,
        history: [act(opener, 'raise', 250), act(villain, 'raise', 750)],
        currentBet: 750,
        behind: b,
        historyComplete: true,
      });
    }
  }

  // 6. facing4BetPlus -------------------------------------------------------
  const f4: Array<{ tag: '6max' | '9max'; n: number; hero: number; r1: number; r2: number; r3: number }> = [
    { tag: '6max', n: 6, hero: SIX.UTG, r1: SIX.UTG, r2: SIX.BTN, r3: SIX.SB },
    { tag: '9max', n: 9, hero: NINE.MP, r1: NINE.MP, r2: NINE.BTN, r3: NINE.SB },
  ];
  for (const { tag, n, hero, r1, r2, r3 } of f4) {
    for (const b of [0, 2].filter((x) => x <= reachableMax(n, hero))) {
      push({
        key: `${tag}/facing4BetPlus/${label(n, hero)}/b${b}`,
        format: tag,
        n,
        heroSeat: hero,
        history: [act(r1, 'raise', 250), act(r2, 'raise', 750), act(r3, 'raise', 2000)],
        currentBet: 2000,
        behind: b,
        historyComplete: true,
      });
    }
  }

  // 7. partial history -> legacy route -------------------------------------
  // `historyComplete=false` with a raise forces the conservative cold/4-bet
  // branch; with no raise it stays unopened but the adaptive route is refused.
  push({
    key: 'partial/unopened/6max-UTG/b4',
    format: 'partial',
    n: 6,
    heroSeat: SIX.UTG,
    history: [],
    currentBet: 100,
    behind: 4,
    historyComplete: false,
  });
  push({
    key: 'partial/facingOpen-6max-BB/b0',
    format: 'partial',
    n: 6,
    heroSeat: SIX.BB,
    history: [act(SIX.UTG, 'raise', 250)],
    currentBet: 250,
    behind: 0,
    historyComplete: false,
  });
  push({
    key: 'partial/facing3Bet-6max-UTG/b2',
    format: 'partial',
    n: 6,
    heroSeat: SIX.UTG,
    history: [act(SIX.UTG, 'raise', 250), act(SIX.BTN, 'raise', 750)],
    currentBet: 750,
    behind: 2,
    historyComplete: false,
  });
  push({
    key: 'partial/unopened/9max-MP/b6',
    format: 'partial',
    n: 9,
    heroSeat: NINE.MP,
    history: [],
    currentBet: 100,
    behind: 6,
    historyComplete: false,
  });
  push({
    key: 'partial/facingOpen-9max-BB/b0',
    format: 'partial',
    n: 9,
    heroSeat: NINE.BB,
    history: [act(NINE.UTG, 'raise', 250)],
    currentBet: 250,
    behind: 0,
    historyComplete: false,
  });
  push({
    key: 'partial/facing3Bet-9max-CO/b2',
    format: 'partial',
    n: 9,
    heroSeat: NINE.CO,
    history: [act(NINE.CO, 'raise', 250), act(NINE.BTN, 'raise', 750)],
    currentBet: 750,
    behind: 2,
    historyComplete: false,
  });

  return spots;
}

/** Natural behind count for the hero (order length - 1 - index). */
function reachableMax(n: number, heroSeat: number): number {
  const order = preflopActionOrder(seatOrderOf(n));
  const idx = order.indexOf(heroSeat);
  return idx < 0 ? 0 : order.length - 1 - idx;
}

// --- enumeration + serialisation ------------------------------------------

interface SpotSnapshot {
  context: {
    spot: string;
    situation: string;
    position: string;
    actorSlot: number;
    behindUnacted: number;
    route: 'adaptive' | 'legacy';
  };
  shares: { raise: number; call: number; fold: number };
  /**
   * Exact raise/call probability for all 169 classes, parallel to the
   * top-level `classOrder`. Rounded to 4 decimals (a real parameter/behaviour
   * change moves frequencies far more than 1e-4) and serialised as inline
   * arrays so the fixture stays reviewable.
   */
  classRaise: number[];
  classCall: number[];
}

interface Snapshot {
  /** Canonical order of the 169 classes the two arrays are parallel to. */
  classOrder: string[];
  classCount: number;
  params: Record<string, Record<string, SpotSnapshot>>;
}

class ActionMixCache {
  private readonly cache = new Map<string, ActionMix>();
  constructor(
    private readonly view: DecisionView,
    private readonly params: RuleParams,
  ) {}
  forClass(key: string): ActionMix {
    let f = this.cache.get(key);
    if (!f) {
      // Use the first combo of this class; the policy only reads the class.
      const idx = COMBO_CLASS.indexOf(key);
      const [a, b] = COMBOS[idx]!;
      const v: DecisionView = { ...this.view, hand: { ...this.view.hand!, myCards: [a, b] } };
      f = choosePreflopIntent(v, this.params, () => 0).frequencies;
      this.cache.set(key, f);
    }
    return f;
  }
}

function enumerate(view: DecisionView, params: RuleParams): SpotSnapshot {
  const ctx = derivePreflopContext(view);
  const cache = new ActionMixCache(view, params);
  let raise = 0;
  let call = 0;
  let fold = 0;
  for (const cls of COMBO_CLASS) {
    const f = cache.forClass(cls);
    raise += f.raise;
    call += f.call;
    fold += 1 - f.raise - f.call;
  }
  const n = COMBOS.length;
  const classRaise: number[] = [];
  const classCall: number[] = [];
  for (const key of CLASS_ORDER) {
    const f = cache.forClass(key);
    classRaise.push(round4(f.raise));
    classCall.push(round4(f.call));
  }
  return {
    context: {
      spot: ctx.spot,
      situation: ctx.situation,
      position: ctx.position,
      actorSlot: ctx.actorSlot,
      behindUnacted: ctx.behindUnacted,
      route: adaptivePreflopAvailable(ctx, params) ? 'adaptive' : 'legacy',
    },
    shares: { raise: round6(raise / n), call: round6(call / n), fold: round6(fold / n) },
    classRaise,
    classCall,
  };
}

function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/**
 * Snapshot params. `adaptivePreflop` is pinned `true` so the snapshot cannot
 * drift because of the `FOURAM_ADAPTIVE_PREFLOP` env rollback. Values are read
 * from `RULE_PRESETS` (never re-typed here) - the preset regression test below
 * pins the numbers so a preset edit is caught explicitly.
 */
function buildParams(): Record<string, RuleParams> {
  return {
    'constrained-random': { ...RULE_PRESETS['constrained-random'], adaptivePreflop: true },
    'tight-aggressive': { ...RULE_PRESETS['tight-aggressive'], adaptivePreflop: true },
  };
}

function buildSnapshot(): Snapshot {
  const paramsByName = buildParams();
  const spots = buildSpots();
  const params: Snapshot['params'] = {};
  for (const [name, ruleParams] of Object.entries(paramsByName)) {
    const perSpot: Record<string, SpotSnapshot> = {};
    for (const spec of spots) {
      const view = makeView(spec);
      perSpot[spec.key] = enumerate(view, ruleParams);
    }
    params[name] = Object.fromEntries(
      Object.keys(perSpot)
        .sort()
        .map((k) => [k, perSpot[k]!]),
    );
  }
  return { classOrder: CLASS_ORDER, classCount: CLASS_ORDER.length, params };
}

/**
 * Pretty-prints objects but inlines arrays of numbers, so the 169-wide class
 * arrays stay on one line each and the fixture remains reviewable/diffable.
 */
function stringify(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === 'number')) return `[${value.join(',')}]`;
    return `[${value.map((v) => stringify(v, indent)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return '{}';
    const body = keys
      .map(
        (k) =>
          `${'  '.repeat(indent + 1)}${JSON.stringify(k)}: ${stringify(obj[k], indent + 1)}`,
      )
      .join(',\n');
    return `{\n${body}\n${pad}}`;
  }
  return JSON.stringify(value);
}

function serialise(snapshot: Snapshot): string {
  return `${stringify(snapshot)}\n`;
}

// --- tests -----------------------------------------------------------------

describe('preflop frequency snapshot (regression baseline)', () => {
  const spots = buildSpots();

  it('covers every promised spot category and the requested behind counts', () => {
    const keys = spots.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length); // unique keys
    expect(spots.some((s) => s.key.includes('/unopened/'))).toBe(true);
    expect(spots.some((s) => s.key.includes('/facingOpen/BB-'))).toBe(true);
    expect(spots.some((s) => s.key.includes('facingOpen') && !s.key.includes('BB-'))).toBe(true);
    expect(spots.some((s) => s.key.includes('/facing3Bet/'))).toBe(true);
    expect(spots.some((s) => s.key.includes('/facing3BetCold/'))).toBe(true);
    expect(spots.some((s) => s.key.includes('/facing4BetPlus/'))).toBe(true);
    expect(spots.some((s) => s.key.startsWith('partial/'))).toBe(true);
    expect(spots.some((s) => s.format === '6max')).toBe(true);
    expect(spots.some((s) => s.format === '9max')).toBe(true);
    // behindUnacted reaches 4/6/8 across the catalogue, 0 always present.
    const behinds = new Set(
      spots.map((s) => derivePreflopContext(makeView(s)).behindUnacted),
    );
    expect(behinds.has(0)).toBe(true);
    expect(behinds.has(4)).toBe(true);
    expect(behinds.has(6)).toBe(true);
    expect(behinds.has(8)).toBe(true);
  });

  it('pins the constrained-random and tight-aggressive preset numbers', () => {
    // These are the production `constrained-random` knobs the baseline (and all
    // later tuning) is measured against. A change here must be intentional.
    expect(RULE_PRESETS['constrained-random']).toMatchObject({
      preflopScale: 1.1,
      threeBetScale: 1,
      bluffScale: 1.2,
      multiwayBluffScale: 0.7,
      valueBetScale: 1,
    });
    expect(RULE_PRESETS['tight-aggressive']).toMatchObject({
      preflopScale: 1,
      threeBetScale: 1,
      bluffScale: 1,
      multiwayBluffScale: 0.5,
      valueBetScale: 1,
    });
  });

  it('class sharing is exact: every combo of a class gives the same vector', () => {
    // Guards the memoisation the enumeration relies on: the policy output may
    // depend on the hand class but not on the specific suits/ranks within it.
    const spec = spots.find((s) => s.key === '6max/facingOpen/BTN-vs-UTG/b2')!;
    const view = makeView(spec);
    const params = { ...RULE_PRESETS['constrained-random'], adaptivePreflop: true };
    for (const key of ['AKs', 'A5s', '76s', 'KQo'] as const) {
      const combos = COMBOS.filter((_, i) => COMBO_CLASS[i] === key).slice(0, 3);
      const vectors = combos.map(([a, b]) => {
        const v: DecisionView = { ...view, hand: { ...view.hand!, myCards: [a, b] } };
        return choosePreflopIntent(v, params, () => 0).frequencies;
      });
      for (const vec of vectors) {
        expect(vec.raise).toBeCloseTo(vectors[0]!.raise, 12);
        expect(vec.call).toBeCloseTo(vectors[0]!.call, 12);
      }
    }
  });

  it('produces valid, combo-weighted action shares for all 169 classes', () => {
    const snapshot = buildSnapshot();
    expect(snapshot.classCount).toBe(169);
    expect(snapshot.classOrder).toHaveLength(169);
    for (const [paramName, perSpot] of Object.entries(snapshot.params)) {
      expect(Object.keys(perSpot).length).toBe(spots.length);
      for (const [spotKey, snap] of Object.entries(perSpot)) {
        const { raise, call, fold } = snap.shares;
        for (const [name, v] of Object.entries({ raise, call, fold })) {
          expect(Number.isFinite(v), `${paramName} ${spotKey} ${name}`).toBe(true);
          expect(v, `${paramName} ${spotKey} ${name}`).toBeGreaterThanOrEqual(0);
          expect(v, `${paramName} ${spotKey} ${name}`).toBeLessThanOrEqual(1);
        }
        // Rounding each share to 6dp can leave a tiny residual, never more.
        expect(Math.abs(raise + call + fold - 1)).toBeLessThanOrEqual(3e-6);
        // Every one of the 169 classes carries a raise AND call probability.
        expect(snap.classRaise, `${paramName} ${spotKey} raise len`).toHaveLength(169);
        expect(snap.classCall, `${paramName} ${spotKey} call len`).toHaveLength(169);
        for (let i = 0; i < 169; i++) {
          for (const [name, v] of [
            ['classRaise', snap.classRaise[i]!],
            ['classCall', snap.classCall[i]!],
          ] as const) {
            expect(Number.isFinite(v), `${paramName} ${spotKey} ${name}[${i}]`).toBe(true);
            expect(v, `${paramName} ${spotKey} ${name}[${i}]`).toBeGreaterThanOrEqual(0);
            expect(v, `${paramName} ${spotKey} ${name}[${i}]`).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it('is deterministic: two independent builds are byte-identical', () => {
    expect(serialise(buildSnapshot())).toBe(serialise(buildSnapshot()));
  });

  it('matches the committed snapshot', () => {
    const actual = serialise(buildSnapshot());
    if (UPDATE) {
      mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
      writeFileSync(SNAPSHOT_PATH, actual);
      return;
    }
    const expected = readFileSync(SNAPSHOT_PATH, 'utf8');
    expect(actual).toBe(expected);
  });
});
