import type { RangeEntry } from './rangeParser.js';

/**
 * Rules-v1 baseline preflop range charts (9-max, 100BB).
 *
 * SOURCE: these are hand-built approximations of widely published, modern
 * "standard" 9-max cash-game range charts (open-raising / 3-bet / cold-call /
 * big-blind defence). They are a *baseline*, not the output of a solver or a
 * GTO computation: the specs are simplified, intentionally readable, and meant
 * to be tuned by the style presets in `ruleStyles.ts`. Where a chart gives a
 * mixed frequency the entry carries an explicit weight (see `compileRangeMix`).
 *
 * Depth: the charts are the >=80BB baseline. `preflopPolicy.ts` applies the
 * documented tightening for shallower effective stacks; 3-bet/4-bet jams at
 * <40BB fall out of the same ranges once the raise is priced against the stack.
 */

export type Position = 'UTG' | 'UTG1' | 'MP' | 'LJ' | 'HJ' | 'CO' | 'BTN' | 'SB' | 'BB';

/** Coarse position buckets used to key the vs-open / defence charts. */
export type PositionGroup = 'EP' | 'MP' | 'LP' | 'SB' | 'BB';

export function positionGroup(pos: Position): PositionGroup {
  switch (pos) {
    case 'UTG':
    case 'UTG1':
      return 'EP';
    case 'MP':
    case 'LJ':
      return 'MP';
    case 'HJ':
    case 'CO':
    case 'BTN':
      return 'LP';
    default:
      return pos;
  }
}

/** Human label + rough combo share, for the report / telemetry. */
export const POSITION_GROUPS: readonly PositionGroup[] = ['EP', 'MP', 'LP', 'SB', 'BB'];

/**
 * Raise-first-in ranges by opening position. `BB` never opens (it closes the
 * action), so its entry is empty; `SB` is a raise-or-fold chart (no limping).
 *
 * Actual combo shares of the table below (hand-built approximation, NOT a
 * solver; `combo` / 1326):
 *   UTG 10.26%  UTG1 10.86%  MP 14.78%  LJ 16.29%  HJ 18.55%
 *   CO  22.93%  BTN  42.38%  SB 39.67%
 * CO sits just under the 24–30% nominal band on purpose (the chart is the
 * literal token list, not hand-tuned to hit the label); the frequency regression
 * test allows ±2.5pt and an exact-count test pins these true values.
 */
export const RFI_RANGES: Record<Position, string> = {
  UTG: '77+, AJs+, A5s-A3s, KTs+, QJs, AJo+, KQo',
  UTG1: '77+, AJs+, A5s-A3s, KTs+, QJs, 99, KJs, QTs, T9s, AJo+, KQo',
  MP: '55+, A9s+, A5s-A2s, KTs+, QTs+, JTs, T9s, ATo+, KJo+',
  LJ: '55+, A8s+, A5s-A2s, K9s+, Q9s+, JTs, T9s, 98s, 87s, ATo+, KJo+',
  HJ: '44+, A7s+, A5s-A2s, K9s+, Q9s+, J9s+, T8s+, 98s, 87s, ATo+, KJo+, QJo',
  CO: '33+, A2s+, K8s+, Q8s+, J8s+, T8s+, 97s+, 86s+, 75s+, 65s, 54s, ATo+, KJo+, QJo, JTo',
  BTN: '22+, A2s+, K2s+, Q5s+, J7s+, T7s+, 96s+, 85s+, 74s+, 64s+, 53s+, 43s, 32s, A2o+, K8o+, Q9o+, J9o+, T9o',
  SB: '22+, A2s+, K4s+, Q6s+, J7s+, T7s+, 96s+, 85s+, 74s+, 64s+, 54s, A2o+, K9o+, Q9o+, J9o+, T9o',
  BB: '',
};

/**
 * Edge hands beyond `RFI_RANGES` that only wider styles open. They are compiled
 * with role `marginal` and raised at `preflopScale - 1` per combo, so the
 * `tight-aggressive` preset (scale 1) never plays them while
 * `loose-aggressive` (1.5) opens half of them and `calling-station` (1.15) a
 * sixth. This is what makes the four styles' RFI widths actually differ.
 */
export const RFI_MARGINAL: Record<Position, string> = {
  UTG: '55, 66, A9s, K9s, KJs, QTs, JTs, T9s, 98s',
  UTG1: '55, 66, A9s, K9s, KJs, QTs, JTs, T9s, 98s',
  MP: '22, 33, 44, A8s, K9s, Q9s, J9s, 98s, 87s, 76s, 65s',
  LJ: '22, 33, 44, A7s, K8s, Q8s, J8s, T8s, 76s, 65s, 54s',
  HJ: '22, 33, A6s, K8s, Q8s, J8s, T7s, 97s, 76s, 65s, 54s',
  CO: '22, K7s, Q7s, J7s, T7s, 96s, 87s, 76s',
  BTN: 'Q4s, J6s, T6s, 95s, 84s, 74s, 63s, 52s, Q8o, J8o, T8o, 98o',
  SB: 'K3s, Q5s, J6s, T6s, 95s, 84s, 73s, 63s, A8o, K8o',
  BB: '',
};

/**
 * Isolation-raise ranges for a limped pot (no raises yet, at least one caller).
 * Keyed by the hero's own group; the BB can also check, so it isolates tightest.
 * Hand-built baseline, not a solver.
 */
export const ISO_RANGES: Record<PositionGroup, string> = {
  EP: '99+, AJs+, KQs, AJo+, KQo',
  MP: '77+, ATs+, KJs+, QJs, JTs, ATo+, KJo+',
  LP: '55+, A9s+, KTs+, QTs+, JTs, T9s, ATo+, KJo+',
  SB: '66+, ATs+, KQs, AJo+, KQo',
  BB: '77+, ATs+, KQs, AJo+, KQo',
};

/**
 * Short-stack (<20BB) open-jam ranges, keyed by the hero's own group. This is
 * a **separate semantic** from the 100BB `RFI_RANGES`: a hand opening at 100BB
 * does not imply it should open-shove at 19BB. Speculative small pairs, suited
 * connectors and weak suited aces (e.g. `22`, `98s`, `A2s`) are deliberately
 * absent; premiums (AA/KK/QQ/AKs) are present everywhere. Hand-built baseline,
 * not a solver.
 */
export const SHORT_JAM_RANGES: Record<PositionGroup, string> = {
  EP: '88+, AJs+, AQo+, AKs, AKo, KQs',
  MP: '66+, ATs+, AJo+, AQo+, AKo, KQs',
  LP: '55+, A9s+, KTs+, QTs+, JTs, ATo+, KJo+',
  SB: '55+, A9s+, ATo+, KQs, AQo+, AKo',
  BB: '55+, A9s+, ATo+, KQs, AQo+, AKo',
};

/**
 * Cold 3-bet value ranges keyed by the *opener's* position group: tighter
 * against early opens, wider against late ones.
 */
export const COLD_3BET_VALUE: Record<PositionGroup, string> = {
  EP: 'QQ+, AKs, AKo',
  MP: 'JJ+, AQs+, AKo',
  LP: 'TT+, AQs+, AKo',
  SB: '99+, AQs+, AKo',
  BB: '99+, AQs+, AKo',
};

/**
 * Cold 3-bet "blocker" bluffs keyed by the opener's group. Played at a blended
 * frequency (weight < 1) so the same chart yields a mixed strategy.
 */
export const COLD_3BET_BLUFF: Record<PositionGroup, string> = {
  EP: 'A5s-A4s, KQs',
  MP: 'A5s-A3s, KQs, KJs',
  LP: 'A5s-A2s, KTs+, QJs, AJo',
  SB: 'A5s-A2s, KTs+, QJs, ATo+, KJo',
  BB: 'A5s-A2s, KTs+, QJs, ATo+, KJo',
};

/** Default bluff weight applied to `COLD_3BET_BLUFF` (the rest folds). */
export const COLD_3BET_BLUFF_WEIGHT = 0.55;

/**
 * Range when the hero has NOT acted yet and faces an open + a 3-bet (cold).
 * Deliberately much tighter than the "hero opened, now faces a 3-bet" charts.
 */
export const COLD_3BET_COLD: RangeEntry[] = [
  { range: 'QQ+, AKs, AKo', action: 'raise', weight: 1 },
  { range: 'JJ, AQs, KQs', action: 'call', weight: 1 },
];

/**
 * Flat-call ranges versus a single open, keyed by the hero's own group. Empty
 * only for `BB`, which is handled by `BB_DEFEND`.
 *
 * `EP` is the earliest non-blind defender (in a 9-max game only UTG1 can face
 * an open, since UTG acts first). It used to be empty — a data hole that made
 * the engine "3-bet or fold" versus every early open. It is now a deliberate
 * *subset* of the `MP` flat range, tightened because the hero still has the
 * whole field behind:
 *
 *   - basis: the Rust `MP-vs-open-UTG` solve (`charts_rust_gg.json`), the
 *     closest positional analog (2nd-earliest 6-max seat). Its meaningful flats
 *     are `55`, `KJs`, `AJo`, `AQo`; `66-99`/`AQo+` it mostly 3-bets, but our
 *     `COLD_3BET_VALUE.EP` bracket is only `QQ+`/`AK`, so the medium pairs and
 *     `ATs+` are carried as flats instead of being folded outright.
 *   - it drops `KQs` (that class is our `COLD_3BET_BLUFF.EP` anchor) and the
 *     `JTs`/`T9s` tail of `MP`, so it stays strictly tighter than `MP`.
 */
export const CALL_VS_OPEN: Record<PositionGroup, string> = {
  EP: '55-JJ, ATs+, KJs, QJs, AJo, AQo',
  MP: '55-JJ, ATs+, KQs, KJs, QJs, JTs, T9s, AQo',
  LP: '22-JJ, A2s+, KTs+, QTs+, JTs, T9s, 98s, AQo+, KJo+',
  SB: '22-JJ, A2s+, KTs+, QTs+, JTs, T9s, 98s, AQo+',
  BB: '',
};

/**
 * Big-blind defence versus a single open, keyed by the opener's group. Actual
 * combo shares of these tables (hand-built approximation, NOT a solver; the
 * spec's 28–58% band is the intent, the tables land a little tighter):
 *   vs EP 23.4%  vs MP 28.5%  vs LP 42.4%  vs SB 49.6%
 * The exact shares are pinned by the range regression test.
 */
export const BB_DEFEND: Record<PositionGroup, RangeEntry[]> = {
  EP: [
    { range: '22-99, A2s+, K8s+, Q8s+, J8s+, T8s+, 98s, 87s, ATo+, KTo+, QTo+, JTo', action: 'call', weight: 1 },
    { range: 'TT+, AQs+, AKo, A5s-A4s', action: 'raise', weight: 1 },
  ],
  MP: [
    {
      range: '22-99, A2s+, K5s+, Q6s+, J7s+, T7s+, 96s+, 86s+, 75s+, 65s, 54s, A9o+, KTo+, QTo+, JTo',
      action: 'call',
      weight: 1,
    },
    { range: 'TT+, AJs+, AQo+, A5s-A2s, KQs', action: 'raise', weight: 1 },
  ],
  LP: [
    {
      range: '22-99, A2s+, K2s+, Q4s+, J6s+, T6s+, 95s+, 85s+, 74s+, 64s+, 53s+, 43s, A2o+, K9o+, Q9o+, J9o+, T9o',
      action: 'call',
      weight: 1,
    },
    { range: 'TT+, AJs+, AQo+, A5s-A2s, KQs, KJs', action: 'raise', weight: 1 },
  ],
  SB: [
    {
      range: '22-99, A2s+, K2s+, Q2s+, J4s+, T6s+, 95s+, 84s+, 74s+, 63s+, 53s+, 43s, A2o+, K7o+, Q8o+, J8o+, T8o+, 98o',
      action: 'call',
      weight: 1,
    },
    { range: 'TT+, AJs+, AQo+, A5s-A2s, KQs, KJs', action: 'raise', weight: 1 },
  ],
  // A BB can never face a BB open; present for type completeness.
  BB: [],
};

/** 4-bet value + blocker bluffs versus a 3-bet (hero already opened). */
export const FACING_3BET_4BET: RangeEntry[] = [
  { range: 'KK+, AKs, AKo', action: 'raise', weight: 1 },
  { range: 'A5s-A2s, KQs, AQs', action: 'raise', weight: 0.4 },
];

/** Flat-call range versus a 3-bet (hero already opened). */
export const FACING_3BET_CALL: RangeEntry[] = [
  { range: '88-QQ, AJs+, ATs, KQs, KJs, QJs, JTs, T9s, AQo', action: 'call', weight: 1 },
];

/**
 * Fourth-and-beyond raise (4-bet/5-bet) spot: only the absolute top continues,
 * as a value raise (with the residual value continuing as a call). No bluffs.
 */
export const FACING_4BET_PLUS: RangeEntry[] = [
  { range: 'KK+, AKs, AKo', action: 'raise', weight: 1 },
];
