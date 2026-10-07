#!/usr/bin/env node
// @ts-nocheck
/**
 * ev-harness.mjs — a reproducible **bb/100 EV bench** for the rules-v1 bots.
 *
 * This is a *balance*, not a tuning knob. It answers one question:
 *
 *     "Against a fixed, representative opponent, how many big blinds per 100
 *      hands does THIS strategy win or lose?"
 *
 * It is deliberately NOT "win rate" or "VPIP": the production bot is
 * net-losing (-34,899 chips in the live DB) against a very loose-aggressive
 * human (VPIP 53.8 / PFR 49.7 as measured by `decision-stats.mjs`), but under
 * rake a zero-sum game has a negative average, so the ONLY meaningful number
 * is the *cross-style* bb/100 versus a *fixed* opponent. Beating a loose
 * opponent may mean tightening, not loosening; only EV can tell.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS BUILT THIS WAY
 * ---------------------------------------------------------------------------
 * 1. FULL HANDS, REAL RULES. The betting engine is `@4am/shared`'s own pure
 *    `startHand` / `applyAction` / `legalActions` / `nextStreet` /
 *    `computePots` / `awardPots` / `evaluate7` — the exact code the live server
 *    uses. Rake is `commissionForPot` (0.5% floored per pot by default), and
 *    the showdown score / side pots / odd-chip rule are the server's. Nothing
 *    about the game rules is re-implemented here.
 * 2. REAL POLICIES. Every bot is built by the production resolver
 *    `resolvePolicyForDifficulty(kind, policyJson, difficulty, { seed })`, which
 *    selects the chart-based `RulePolicy` at `medium` (with the embedded Rust
 *    vs-open provider) — i.e. exactly what runs in prod.
 * 3. FIXED SEED, DETERMINISTIC. The deal RNG (`mulberry32`) is seeded from
 *    `(masterSeed, handIndex)` independently of the policies, so re-running the
 *    same command is byte-for-byte identical, AND every config in a sweep plays
 *    the SAME cards (paired comparison -> much lower variance).
 * 4. FIXED OPPONENT. A sweep changes only the hero spec; the villain spec,
 *    villain seed and the deals are held constant, so the delta is "did WE get
 *    stronger", not co-evolution.
 * 5. INFORMATION ISOLATED. A policy only ever receives the `DecisionView` built
 *    here: public board + its own two hole cards. It never sees an opponent's
 *    cards or the undealt deck. `--mode isolate` asserts this structurally.
 *
 * ---------------------------------------------------------------------------
 * USAGE
 * ---------------------------------------------------------------------------
 *   node --import tsx apps/server/scripts/ev-harness.mjs <mode> [options]
 *
 * Modes
 *   bench                 time N hands; report ms/hand + projected total time.
 *   matchup               one hero vs one villain, full bb/100 report + full
 *                         calibration 口径 (resolved params, node counts,
 *                         RFI by position, EV split, VPIP denominator).
 *   baseline              production hero vs every opponent archetype.
 *                         EXPLORATORY only: single seed, per-hand normal CI,
 *                         no multiple-comparison correction (see printBaseline).
 *   paired                N hero configs on IDENTICAL deals; prints the paired
 *                         A−B difference (mean / paired SD / paired 95% CI).
 *                         `--heroes "lag;lag:preflopScale=1"`.
 *   multiseed             independent master seeds, fixed hands each; seed-level
 *                         mean + bootstrap CI + block bootstrap + direction
 *                         stability. `--seeds 5` (or `--seed-list a,b,c`).
 *   sweep                 hold villain + deals fixed, vary hero rule params.
 *                         (Mechanism only; ⚠️ do NOT run a full grid.)
 *   isolate               information-set isolation structural self-test.
 *   hucheck               heads-up position/actor self-test (must PASS).
 *
 * Common options
 *   --hands N             hands per matchup           (default 5000)
 *   --seed S              master seed                 (default 20261007)
 *   --seats N             table size, 2..6            (default 2 = heads-up)
 *   --stack-bb N          starting stack in big blinds (default 100)
 *   --sb N --bb N         blinds                       (default 10 / 20 = prod)
 *   --rake-bps N          commission basis points      (default 50 = prod 0.5%)
 *   --rake-cap-bb N       per-pot rake cap in BB, 0 = none (default 0; prod has
 *                         NO cap — see the "RAKE" note in the report)
 *   --no-rake             shorthand for --rake-bps 0
 *   --hero <spec>         hero strategy spec name
 *   --villain <spec>      villain spec name; comma-separate for a lineup, e.g.
 *                         `--villain human-lag,cr,cr,cr,cr` (cycled across seats)
 *   --hero-params k=v,... rule-param overrides for the hero
 *   --heroes a;b:k=v,...  paired mode: configs separated by `;`, optional params
 *                         after `:`
 *   --seeds N             multiseed: number of independent master seeds
 *   --seed-list a,b,c     multiseed: explicit seed list
 *   --block N             multiseed block-bootstrap block size (default 50)
 *   --boot N              bootstrap reps (default 2000)
 *   --memory              enable production session memory (memoryEnabled=true,
 *                         the live default). Default OFF keeps the historical
 *                         empty-memory numbers comparable; the report states
 *                         which mode was used.
 *   --sweep-param NAME --sweep-values a,b,c   (mode sweep)
 *   --json                machine-readable JSON on stdout
 *   --stable              drop wall-clock metadata so a rerun is BYTE-IDENTICAL
 *   --out PATH            also write the JSON report to PATH
 *
 * ⚠️ SCOPE OF THE ISOLATION CHECK: `isolate` is a light *structural* check (the
 * DecisionView shape exposes only the actor's own two cards; no opponent cards
 * or deck reference). It is NOT a full sandbox proof and does not inspect the
 * policy's internals or the RNG — treat it as a regression guard, not a
 * security guarantee.
 *
 * RAKE: production is `commission_bps = 50` (0.5%) floored per pot, with NO cap
 * (verified in `@4am/shared` `commissionForPot` and the live `rooms` table). The
 * default models exactly that. To model a hypothetical "5% / cap 3bb" instead,
 * pass `--rake-bps 500 --rake-cap-bb 3`. Under rake all seats sum to -rake, so
 * compare RELATIVE bb/100 across opponents, never the absolute sign.
 *
 * ⚠️⚠️ DO NOT RUN `sweep` unless you have been explicitly asked. It re-runs a
 * full matchup per parameter value and saturates the box (it once pushed load
 * past 11 and starved the live server). The sweep MECHANISM exists so it is
 * ready when the owner picks a direction; until then use `matchup`/`baseline`/
 * `paired`/`multiseed`, single process, `--hands <= 500`.
 *
 * Specs (--hero/--villain)
 *   prod        constrained-random / medium (PRODUCTION config)
 *   cr          constrained-random / medium (same as prod)
 *   tag         tight-aggressive   / medium
 *   lag         loose-aggressive   / medium (preset)
 *   lag-max     loose-aggressive   / medium, preflopScale=threeBetScale=2
 *   lag-style   loose-aggressive   / LOW  (equity StylePolicy, raise-heavy)
 *   station     calling-station    / medium
 *   maniac      constrained-random / medium, preflopScale=2, threeBetScale=2
 *   human-lag   松凶真人画像 — a preflop-frequency opponent calibrated to the
 *               live human (DB user 2): VPIP≈54/PFR≈50. See HumanLagProfile.
 *
 * ⚠️ Import paths are RELATIVE (`../../../packages/...`) on purpose: in a git
 * worktree the workspace symlink `node_modules/@4am/agent-core` can point at
 * the *main* checkout, so a package-name import silently measures stale code.
 */

import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

// --- shared (pure game rules) : relative path, same reason as above ----------
import {
  startHand,
  applyAction,
  legalActions,
  nextStreet,
  streetClosed,
  activeNonAllIn,
  computePots,
  awardPots,
  evaluate7,
  commissionForPot,
} from '../../../packages/shared/src/index.ts';
// --- agent-core (production policies) : relative path ------------------------
import {
  resolvePolicyForDifficulty,
  mulberry32,
  RULE_PRESETS,
  handClassForCards,
  estimateEquity,
  parseRange,
  RFI_RANGES,
  RFI_MARGINAL,
  SessionTracker,
  derivePreflopContext,
  postflopActionOrder,
} from '../../../packages/agent-core/src/index.ts';

/** Stable per-seat userId for the synthetic table (memory keys on seats, not ids). */
const userIdOf = (seat) => 100 + seat;

/** Nominal (legacy-table) RFI width in combos, for the report's "range width". */
function rangeWidths() {
  const out = {};
  for (const [pos, spec] of Object.entries(RFI_RANGES)) {
    const base = spec ? parseRange(spec).combos : 0;
    const marginal = RFI_MARGINAL[pos] ? parseRange(RFI_MARGINAL[pos]).combos : 0;
    out[pos] = { baseCombos: base, marginalCombos: marginal, basePct: (100 * base) / 1326, basePlusMarginalPct: (100 * (base + marginal)) / 1326 };
  }
  return out;
}

// ===========================================================================
// CLI
// ===========================================================================

function parseArgs(argv) {
  const o = {
    mode: 'matchup',
    hands: 5000,
    seed: 20261007,
    seats: 2,
    stackBb: 100,
    sb: 10,
    bb: 20,
    rakeBps: 50,
    rakeCapBb: 0,
    hero: 'prod',
    villain: 'lag',
    heroParams: null,
    sweepParam: null,
    sweepValues: null,
    json: false,
    out: null,
    limit: null,
    memory: false,
    heroes: null,
    seeds: null,
    seedList: null,
    block: 50,
    boot: 2000,
  };
  const known = new Set([
    'bench', 'matchup', 'baseline', 'sweep', 'isolate', 'paired', 'multiseed', 'hucheck',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const num = (k) => Number(argv[++i]);
    if (known.has(a)) o.mode = a;
    else if (a === '--hands') o.hands = num();
    else if (a === '--seed') o.seed = num();
    else if (a === '--seats') o.seats = num();
    else if (a === '--stack-bb') o.stackBb = num();
    else if (a === '--sb') o.sb = num();
    else if (a === '--bb') o.bb = num();
    else if (a === '--rake-bps') o.rakeBps = num();
    else if (a === '--rake-cap-bb') o.rakeCapBb = num();
    else if (a === '--no-rake') o.rakeBps = 0;
    else if (a === '--hero') o.hero = argv[++i];
    else if (a === '--villain') o.villain = argv[++i];
    else if (a === '--hero-params') o.heroParams = argv[++i];
    else if (a === '--heroes') o.heroes = argv[++i];
    else if (a === '--seeds') o.seeds = num();
    else if (a === '--seed-list') o.seedList = argv[++i];
    else if (a === '--block') o.block = num();
    else if (a === '--boot') o.boot = num();
    else if (a === '--memory') o.memory = true;
    else if (a === '--sweep-param') o.sweepParam = argv[++i];
    else if (a === '--sweep-values') o.sweepValues = argv[++i];
    else if (a === '--json') o.json = true;
    else if (a === '--stable') o.stable = true;
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--limit') o.limit = num();
    else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  return o;
}

// ===========================================================================
// Strategy specs
// ===========================================================================

/** Parse `a=1,b=2` into `{a:1,b:2}` (numbers only; rule params are numeric). */
function parseParamList(raw) {
  const out = {};
  if (!raw) return out;
  for (const pair of raw.split(',')) {
    const [k, v] = pair.split('=').map((s) => s.trim());
    if (!k) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`bad param ${pair}`);
    out[k] = n;
  }
  return out;
}

const SPECS = {
  prod: { label: 'constrained-random/medium (PRODUCTION)', kind: 'constrained-random', difficulty: 'medium' },
  cr: { label: 'constrained-random/medium', kind: 'constrained-random', difficulty: 'medium' },
  tag: { label: 'tight-aggressive/medium', kind: 'tight-aggressive', difficulty: 'medium' },
  lag: { label: 'loose-aggressive/medium (preset)', kind: 'loose-aggressive', difficulty: 'medium' },
  'lag-max': {
    label: 'loose-aggressive/medium preflopScale=threeBetScale=2',
    kind: 'loose-aggressive',
    difficulty: 'medium',
    params: { preflopScale: 2, threeBetScale: 2, bluffScale: 2, valueBetScale: 1.5, multiwayBluffScale: 1, maxOverbetFrequency: 0.5 },
  },
  // Equity StylePolicy (low difficulty) tuned into a raise-heavy / call-light
  // shape. `preflopEntryEquity` low + `valueRaiseEquity` low + `callEquity` very
  // low makes it raise the hands it plays instead of flatting them, which is how
  // a VPIP≈PFR profile (VPIP-PFR small) is reachable at all.
  'lag-style': {
    label: 'loose-aggressive style/low (raise-heavy calibration)',
    kind: 'loose-aggressive',
    difficulty: 'low',
    style: { preflopEntryEquity: 0.34, callEquity: 0.06, valueRaiseEquity: 0.42, callMargin: -0.02, bluffFrequency: 0.22, valueRaiseFraction: 0.85, bluffRaiseFraction: 0.75, randomness: 0 },
  },
  station: { label: 'calling-station/medium', kind: 'calling-station', difficulty: 'medium' },
  maniac: {
    label: 'constrained-random/medium preflopScale=2 threeBetScale=2',
    kind: 'constrained-random',
    difficulty: 'medium',
    params: { preflopScale: 2, threeBetScale: 2, bluffScale: 2, valueBetScale: 1.2, multiwayBluffScale: 1, maxOverbetFrequency: 0.5 },
  },
  // "松凶真人画像": a harness-local opponent built from the PRODUCTION-MEASURED
  // frequencies of the live human (user 2), not from a preset. See
  // HumanLagProfile below. This is the only way to reach VPIP≈54/PFR≈50 —
  // rules-v1 presets cap around 24% VPIP at 6-max (measured, see README/report).
  'human-lag': { label: '松凶真人画像 (measured LAG, preflop-frequency)', kind: 'human-lag' },
};

function specByName(name) {
  const s = SPECS[name];
  if (!s) {
    console.error(`unknown spec "${name}". Known: ${Object.keys(SPECS).join(', ')}`);
    process.exit(2);
  }
  return { name, ...s };
}

/** Build a production-resolved policy for a spec (params override the preset). */
function makePolicy(spec, seed) {
  if (spec.kind === 'human-lag') return new HumanLagProfile(seed);
  const blob = spec.params ?? spec.style ?? null;
  const json = blob ? JSON.stringify(blob) : null;
  const resolved = resolvePolicyForDifficulty(spec.kind, json, spec.difficulty, { seed });
  return resolved.policy;
}

// ===========================================================================
// 松凶真人画像 — a preflop-frequency opponent calibrated to the live human
// ===========================================================================
//
// The live human (DB user 2, 421 dealt hands, 6–7 handed) measured by
// `decision-stats.mjs`:
//
//   VPIP 60.4% (235/389)   PFR 55.0% (214/389)
//   RFI  61.6% (127/206)   3-bet (facing open) 52.5% (73/139)
//   facing open: call 12.2% / fold 35.3%
//   by position RFI: UTG 47%, HJ 43%, CO ~80% (92% at n=39), BTN 74%, SB 75%
//
// No rules-v1 preset reaches that: the adaptive charts are solver-derived and
// top out near 24% VPIP at 6-max even at preflopScale=2. So this profile is
// built the only faithful way available from the data: **rank the 169 hand
// classes by preflop equity vs 5 random opponents once, then open / 3-bet /
// continue the top-X% of hands per node, with X taken from the human's own
// measured per-position frequencies**. Aggregate VPIP/PFR therefore match by
// construction, and hand selection is strength-ordered (a real loose-aggressive
// opens its best hands, not random ones).
//
// ⚠️ DOCUMENTED APPROXIMATION: POSTFLOP this profile delegates to the production
// `constrained-random/medium` rules-v1 engine. The human's postflop frequencies
// are NOT modelled (the projection has no per-hand cards to fit a postflop
// range from). The baseline's "vs 松凶" number is therefore a *preflop-faithful,
// postflop-production-proxy* opponent — stated again in the report.
//
// ⚠️ NOT A SWEEP: the numbers below are fixed constants from one read-only
// `decision-stats.mjs --player 2` run; nothing is searched at runtime.

const POSITIONS_BY_COUNT = {
  2: ['SB', 'BB'],
  3: ['SB', 'BB', 'BTN'],
  4: ['SB', 'BB', 'CO', 'BTN'],
  5: ['SB', 'BB', 'UTG', 'CO', 'BTN'],
  6: ['SB', 'BB', 'UTG', 'HJ', 'CO', 'BTN'],
  7: ['SB', 'BB', 'UTG', 'UTG1', 'HJ', 'CO', 'BTN'],
  8: ['SB', 'BB', 'UTG', 'UTG1', 'MP', 'HJ', 'CO', 'BTN'],
  9: ['SB', 'BB', 'UTG', 'UTG1', 'MP', 'LJ', 'HJ', 'CO', 'BTN'],
};

/** Human's measured RFI by position (fraction of first-in nodes raised). */
const HUMAN_RFI = { UTG: 0.47, UTG1: 0.47, MP: 0.47, LJ: 0.55, HJ: 0.43, CO: 0.8, BTN: 0.74, SB: 0.75 };
/** Human's measured behaviour facing exactly one open. */
const HUMAN_VS_OPEN = { threeBet: 0.525, call: 0.122 };
/** Approximate facing-3bet behaviour (not separately measured; conservative). */
const HUMAN_VS_3BET = { raise: 0.4, call: 0.3 };
/** BB unopened: the human raises ~30% and checks the rest. */
const HUMAN_BB_RAISE = 0.3;

/**
 * Static 169-class strength ranking (percentile 0 = strongest), computed once.
 *
 * ⚠️ NAMING: this is a **preflop strength-ranked frequency proxy**, NOT a
 * reproduction of a human's hand-selection policy. The reviewer's first critique
 * — 169 classes ranked equally — is fixed here: equity is averaged over every
 * concrete combo of the class (1326 combinations in total), so pairs / suited /
 * offsuit classes contribute in the correct proportion and card-removal / suit
 * effects are not ignored. It is still only a
 * *strength ordering*; the frequencies layered on top are the measured human
 * ones, not a fitted range.
 */
let classRankPercentile = null;
function classRanking() {
  if (classRankPercentile) return classRankPercentile;
  const combosByClass = new Map();
  for (let a = 0; a < 52; a++) {
    for (let b = a + 1; b < 52; b++) {
      const key = handClassForCards(a, b).key;
      if (!combosByClass.has(key)) combosByClass.set(key, []);
      combosByClass.get(key).push([a, b]);
    }
  }
  const ranked = [...combosByClass.entries()].map(([key, combos]) => {
    // Average equity over ALL concrete combos of the class (suit/blocker aware).
    let sum = 0;
    for (const cards of combos) {
      sum += estimateEquity({ hole: cards, opponents: 5, samples: 24, seed: 0x4a6d2b79 }).equity;
    }
    return { key, eq: sum / combos.length, combos: combos.length };
  });
  ranked.sort((x, y) => y.eq - x.eq); // strongest first
  classRankPercentile = new Map(ranked.map((e, i) => [e.key, i / ranked.length]));
  return classRankPercentile;
}

class HumanLagProfile {
  constructor(seed) {
    this.name = 'human-lag';
    this.seed = seed >>> 0;
    // Postflop delegate: production rules-v1 engine.
    this.postflop = resolvePolicyForDifficulty('constrained-random', null, 'medium', { seed }).policy;
  }

  /** Position name from the dealing-order seat list (mirrors preflopPolicy). */
  positionOf(view) {
    const order = view.seatOrder ?? [];
    const seat = view.hand?.mySeat ?? -1;
    const table = POSITIONS_BY_COUNT[order.length];
    const idx = order.indexOf(seat);
    if (table && idx >= 0 && idx < table.length) return table[idx];
    return idx === 0 ? 'SB' : idx === 1 ? 'BB' : 'BTN';
  }

  decide(view) {
    const h = view.hand;
    if (!h) throw new Error('human-lag: no hand');
    if (h.street !== 'preflop') return this.postflop.decide(view);
    const la = view.legalActions;
    if (!la) throw new Error('human-lag: no legal actions');

    const cards = h.myCards ?? [];
    const key = handClassForCards(cards[0] ?? 0, cards[1] ?? 1).key;
    const rank = classRanking().get(key) ?? 1; // 0 = strongest

    // Preflop node classification from public history.
    const pre = (view.actionHistory ?? []).filter((a) => a.street === 'preflop');
    const raises = pre.filter((a) => a.action.type === 'bet' || a.action.type === 'raise').length;
    const callers = pre.filter((a) => a.action.type === 'call').length;
    const position = this.positionOf(view);

    const raiseTo = (mult) => {
      const bb = view.room?.bb && view.room.bb > 0 ? view.room.bb : 1;
      const currentBet = h.currentBet ?? 0;
      const isOpen = currentBet <= bb;
      let target = isOpen ? (position === 'SB' ? bb * 3 : bb * 2.5) : currentBet * mult;
      target = Math.round(target);
      target = Math.min(Math.max(target, la.minRaiseTo), la.maxRaiseTo);
      return target;
    };

    if (raises === 0) {
      // Unopened / limped. BB (or anyone who can check with no bet) checks
      // unless raising its best hands.
      const canCheck = la.canCheck;
      const width = canCheck ? HUMAN_BB_RAISE : (HUMAN_RFI[position] ?? 0.5);
      if (rank < width && la.canRaise) return { action: { type: 'raise', amount: raiseTo(3) }, reason: `human-lag RFI top${(100 * width).toFixed(0)}%` };
      if (canCheck) return { action: { type: 'check' }, reason: 'human-lag check' };
      // The human essentially never limp-calls (facing-open call is only 12.2%;
      // open-limp frequency is not separately measured and is treated as ~0).
      return { action: { type: 'fold' }, reason: 'human-lag fold unopened' };
    }

    if (raises === 1) {
      // Facing a single open.
      if (rank < HUMAN_VS_OPEN.threeBet && la.canRaise) return { action: { type: 'raise', amount: raiseTo(3.5) }, reason: 'human-lag 3bet' };
      if (rank < HUMAN_VS_OPEN.threeBet + HUMAN_VS_OPEN.call && la.canCall) return { action: { type: 'call' }, reason: 'human-lag flat vs open' };
      return { action: { type: 'fold' }, reason: 'human-lag fold vs open' };
    }

    // Facing a 3-bet or more.
    if (rank < HUMAN_VS_3BET.raise && la.canRaise) return { action: { type: 'raise', amount: raiseTo(2.2) }, reason: 'human-lag 4bet' };
    if (rank < HUMAN_VS_3BET.raise + HUMAN_VS_3BET.call && la.canCall) return { action: { type: 'call' }, reason: 'human-lag call vs 3bet' };
    return { action: { type: 'fold' }, reason: 'human-lag fold vs 3bet' };
  }
}

// ===========================================================================
// Engine: deck, decision view, hand play, settlement
// ===========================================================================

/**
 * Dealing order == the `seats` array order `startHand` expects (seats[0]=SB,
 * seats[1]=BB). For 3+ players that is "first seat left of the button first,
 * button last" (SB, BB, ..., BTN). HEADS-UP IS DIFFERENT: the button IS the
 * small blind and acts first preflop, so the order is [button, other] — the
 * exact rule production uses (`apps/server/src/game.ts`:
 * `startIdx = eligible.length === 2 ? btnIdx : (btnIdx + 1) % seats.length`).
 * The previous `(button+k)%n` formula produced [other, button] for HU, which
 * left `seats[0]` a non-button seat while `buttonSeat` still named seat 0 — an
 * internally contradictory state that reversed the HU positions.
 */
function dealingOrder(n, button) {
  if (n === 2) return [button, (button + 1) % 2];
  const order = [];
  for (let k = 1; k <= n; k++) order.push((button + k) % n);
  return order;
}

function shuffledDeck(rand) {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) {    const j = Math.floor(rand() * (i + 1));
    const t = deck[i];
    deck[i] = deck[j];
    deck[j] = t;
  }
  return deck;
}

function boardForStreet(board, street) {  switch (street) {
    case 'preflop': return [];
    case 'flop': return board.slice(0, 3);
    case 'turn': return board.slice(0, 4);
    default: return board.slice(0, 5);
  }
}

/**
 * Build the exact `DecisionView` the real client would build
 * (`buildDecisionView` semantics), from public BettingState + the actor's own
 * two hole cards. NOTE: the view has no slot for opponent hole cards and no
 * reference to the deck, so a policy cannot cheat by construction.
 */
function buildDecisionView({ st, seat, hole, board, handId, history, actionSeq, room, sessionMemory }) {
  const seatOrder = st.seats.map((s) => s.seat); // dealing order, index 0 = SB (HU: button/SB)
  const pot = st.seats.reduce((sum, s) => sum + s.total, 0);
  const la = legalActions(st);
  const legal = {
    canCheck: la.canCheck,
    canCall: !la.canCheck && la.callAmount > 0,
    callAmount: la.callAmount,
    canBet: la.canRaise && st.currentBet === 0,
    canRaise: la.canRaise && st.currentBet > 0,
    minRaiseTo: la.minRaiseTo,
    maxRaiseTo: la.maxRaiseTo,
  };
  const call = legal.callAmount;
  const potOdds = {
    callAmount: call,
    pot,
    potOdds: call > 0 ? call / (pot + call) : 0,
    breakEvenEquity: call > 0 ? call / (pot + call) : 0,
  };
  // Stable per-seat userId: session memory is keyed by seat downstream
  // (`exploitMultiplier` maps `sessionMemory.opponents` by seat), so the ids
  // only need to be stable across hands, which `100+seat` is. `isMe` carries
  // the actor flag independently.
  const asSeat = (s, isMe) => ({
    seat: s.seat,
    userId: userIdOf(s.seat),
    displayName: isMe ? 'hero' : `v${s.seat}`,
    isMe,
    stack: s.stack,
    committed: s.committed,
    total: s.total,
    folded: s.folded,
    allIn: s.allIn,
    sittingOut: false,
    connected: true,
  });
  const meRaw = st.seats.find((s) => s.seat === seat);
  return {
    room,
    hand: {
      handId,
      street: st.street,
      buttonSeat: st.buttonSeat,
      board: boardForStreet(board, st.street),
      pot,
      currentBet: st.currentBet,
      toAct: seat,
      deadline: null,
      myCards: [...hole[seat]],
      mySeat: seat,
    },
    me: asSeat(meRaw, true),
    legalActions: legal,
    potOdds,
    actionHistory: history.map((h) => ({ ...h, action: { ...h.action } })),
    opponents: st.seats.filter((s) => s.seat !== seat).map((s) => asSeat(s, false)),
    sessionMemory: sessionMemory ?? { handsObserved: 0, netChips: null, recentHands: [], opponents: [] },
    historyComplete: true,
    seatOrder,
    actionSeq,
    needToActSeats: [...st.needToAct],
  };
}

/** Mirrors `applyAction`'s own preconditions, so we can fall back instead of throwing. */
function isLegalAction(action, st) {
  const la = legalActions(st);
  if (!la) return false;
  switch (action.type) {
    case 'check': return la.canCheck;
    case 'call': return la.callAmount > 0;
    case 'fold': return true;
    case 'bet':
    case 'raise': {
      if (!la.canRaise) return false;
      const amt = action.amount;
      if (typeof amt !== 'number' || !Number.isFinite(amt)) return false;
      if (action.type === 'bet' && st.currentBet !== 0) return false;
      if (action.type === 'raise' && st.currentBet === 0) return false;
      if (amt > la.maxRaiseTo) return false;
      const allInShort = amt === la.maxRaiseTo && amt < st.currentBet + st.lastRaiseSize;
      const minTo = st.currentBet === 0 ? st.bb : st.currentBet + st.lastRaiseSize;
      if (!allInShort && amt < minTo) return false;
      if (amt <= st.currentBet) return false;
      return true;
    }
    default:
      return false;
  }
}

function legalFallback(st) {
  const la = legalActions(st);
  if (la.canCheck) return { type: 'check' };
  if (la.callAmount > 0) return { type: 'call' };
  return { type: 'fold' };
}

function applyRake(pots, rakeBps, rakeCapChips) {
  let rake = 0;
  if (rakeBps <= 0) return rake;
  for (const p of pots) {
    let cut = commissionForPot(p.amount, rakeBps);
    if (rakeCapChips > 0) cut = Math.min(cut, rakeCapChips);
    cut = Math.min(cut, p.amount);
    p.amount -= cut;
    rake += cut;
  }
  return rake;
}

/**
 * Play one hand to completion. Deterministic in `handSeed` and the policies.
 * Returns { nets: Map<seat,chipDelta>, rake, showdown, decisions, vpipSeats,
 *           pfrSeats, endedStreet, history }.
 *
 * `trackers` (optional): a per-seat `SessionTracker` map. When supplied, each
 * actor's `DecisionView.sessionMemory` is the live seat-mapped snapshot — the
 * production `memoryEnabled=true` behaviour. When omitted the view carries the
 * empty memory the live server uses when memory is disabled.
 *
 * `diag` (optional): mutable aggregate collector; see `newDiagnostics`.
 */
function playHand({ handSeed, handIndex, handId, seatSpecs, policies, sb, bb, stackBb, rakeBps, rakeCapBb, roomBase, trackers, diag }) {
  const n = seatSpecs.length;
  const button = handIndex % n; // rotate the button every hand
  const order = dealingOrder(n, button);
  const posTable = POSITIONS_BY_COUNT[order.length];

  const rand = mulberry32(handSeed);
  const deck = shuffledDeck(rand);
  const hole = {};
  for (let k = 0; k < n; k++) {
    const s = order[k];
    hole[s] = [deck[2 * k], deck[2 * k + 1]];
  }
  const board = deck.slice(2 * n, 2 * n + 5);

  const stacks = {};
  for (let s = 0; s < n; s++) stacks[s] = Math.round(stackBb * bb);
  const stSeats = order.map((s) => ({ seat: s, stack: stacks[s] }));
  let st = startHand(stSeats, button, sb, bb);

  const room = { id: 'ev', name: 'ev', sb, bb, minSettleHands: 0, sevenDeuceBonus: 0 };
  const history = [];
  const vpipSeats = new Set();
  const pfrSeats = new Set();
  const actedPreflop = new Set();
  let actionSeq = 0;
  let decisions = 0;
  const MAX_DECISIONS = 500; // hard guard against a pathological policy loop

  while (true) {
    if (st.winnerByFold !== null) {
      return { ...settleFold({ st, stacks, rakeBps, rakeCapBb, showdown: false, decisions, vpipSeats, pfrSeats }), endedStreet: st.street, history, allIn: st.seats.some((s) => s.allIn) };
    }

    if (streetClosed(st)) {
      if (st.street === 'river' || activeNonAllIn(st) < 2) {
        return { ...settleShowdown({ st, hole, board, stacks, rakeBps, rakeCapBb, decisions, vpipSeats, pfrSeats }), endedStreet: st.street, history, allIn: st.seats.some((s) => s.allIn) };
      }
      st = nextStreet(st);
      continue;
    }

    if (decisions >= MAX_DECISIONS) throw new Error(`hand ${handId}: decision cap hit`);

    const seat = st.toAct;
    const memory = trackers && trackers[seat]
      ? trackers[seat].snapshot(userIdOf(seat), st.seats.map((s) => ({ seat: s.seat, userId: userIdOf(s.seat) })))
      : undefined;
    const view = buildDecisionView({ st, seat, hole, board, handId, history, actionSeq, room, sessionMemory: memory });
    const policy = policies[seat];

    let curPosition = null;
    let curNode = null;
    if (diag) {
      const bucket = diag.preflopNodes[seat] ?? (diag.preflopNodes[seat] = {});
      const posBucket = diag.preflopPos[seat] ?? (diag.preflopPos[seat] = {});
      const position = posTable && order.indexOf(seat) >= 0 ? posTable[order.indexOf(seat)] : `seat${seat}`;
      curPosition = position;
      if (st.street === 'preflop') {
        const raises = history.filter((h) => h.street === 'preflop' && (h.action.type === 'bet' || h.action.type === 'raise')).length;
        const node = raises === 0 ? 'unopened' : raises === 1 ? 'facingOpen' : raises === 2 ? 'facing3bet' : 'facingMore';
        curNode = node;
        bucket[node] = (bucket[node] ?? 0) + 1;
        posBucket[position] = (posBucket[position] ?? 0) + 1;
        if (!actedPreflop.has(seat)) {
          actedPreflop.add(seat);
          diag.preflopDecisionHands[seat] = (diag.preflopDecisionHands[seat] ?? 0) + 1;
        }
      } else {
        const post = diag.postflopActions[seat] ?? (diag.postflopActions[seat] = {});
        post.streetDecisions = (post.streetDecisions ?? 0) + 1;
      }
    }

    let decision;
    try {
      decision = policy.decide(view);
      if (decision && typeof decision.then === 'function') throw new Error('async policy unsupported');
    } catch {
      decision = { action: legalFallback(st), reason: 'harness fallback' };
    }
    let action = decision?.action ?? legalFallback(st);
    if (!isLegalAction(action, st)) action = legalFallback(st);
    decisions++;

    if (diag && curNode === 'unopened') {
      const pos = curPosition ?? `seat${seat}`;
      diag.rfiOpportunities[seat][pos] = (diag.rfiOpportunities[seat][pos] ?? 0) + 1;
      if (action.type === 'bet' || action.type === 'raise') {
        diag.rfiRaises[seat][pos] = (diag.rfiRaises[seat][pos] ?? 0) + 1;
      }
    }

    if (st.street === 'preflop') {
      if (action.type === 'call' || action.type === 'bet' || action.type === 'raise') vpipSeats.add(seat);
      if (action.type === 'bet' || action.type === 'raise') pfrSeats.add(seat);
    }
    if (diag && st.street !== 'preflop') {
      const post = diag.postflopActions[seat];
      if (post) post[action.type] = (post[action.type] ?? 0) + 1;
    }

    history.push({ actionSeq, street: st.street, seat, action: { ...action }, auto: false, ts: 0 });
    st = applyAction(st, seat, action);
    actionSeq++;
  }
}

function settleFold({ st, stacks, rakeBps, rakeCapBb, showdown, decisions, vpipSeats, pfrSeats }) {
  const winner = st.winnerByFold;
  const pots = computePots(st.seats);
  const rake = applyRake(pots, rakeBps, rakeCapBb);
  const awarded = pots.reduce((sum, p) => sum + p.amount, 0);
  const nets = new Map();
  for (const s of st.seats) {
    const award = s.seat === winner ? awarded : 0;
    nets.set(s.seat, s.stack + award - stacks[s.seat]);
  }
  return { nets, rake, showdown, decisions, vpipSeats, pfrSeats };
}

function settleShowdown({ st, hole, board, stacks, rakeBps, rakeCapBb, decisions, vpipSeats, pfrSeats }) {
  const pots = computePots(st.seats);
  const rake = applyRake(pots, rakeBps, rakeCapBb);
  const live = st.seats.filter((s) => !s.folded);
  const scores = new Map(live.map((s) => [s.seat, evaluate7([...hole[s.seat], ...board])]));
  const awards = awardPots(pots, scores, st.seats.map((s) => s.seat));
  const nets = new Map();
  for (const s of st.seats) {
    nets.set(s.seat, s.stack + (awards.get(s.seat) ?? 0) - stacks[s.seat]);
  }
  return { nets, rake, showdown: true, decisions, vpipSeats, pfrSeats };
}

// ===========================================================================
// Matchup runner + statistics
// ===========================================================================

function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
}
/** bb/100 with its standard error and 95% CI, from a per-hand chip-delta sample. */
function bb100(deltas, bb) {
  const n = deltas.length;
  const perHandBb = deltas.map((d) => d / bb);
  const m = mean(perHandBb);
  const sd = stdev(perHandBb);
  const se = n > 0 ? sd / Math.sqrt(n) : 0;
  return {
    hands: n,
    bbPer100: m * 100,
    se95: se * 100 * 1.96,
    sdPer100: sd * 100,
    totalChips: deltas.reduce((a, b) => a + b, 0),
  };
}

/** Conditional EV (bb/100) over a subsample (e.g. showdown hands only). */
function eb100(deltas, bb) {
  if (!deltas || deltas.length === 0) return { hands: 0, bbPer100: null, totalChips: 0 };
  return { hands: deltas.length, bbPer100: (100 * mean(deltas)) / bb, totalChips: deltas.reduce((a, b) => a + b, 0) };
}

/**
 * Paired A−B difference. Because both runs played the SAME deals (paired), the
 * per-hand difference variance is what matters, not the (much larger) per-config
 * variance: the "same-deal noise reduction" only shows up here.
 */
function pairedDiff(deltasA, deltasB, bb) {
  const n = Math.min(deltasA.length, deltasB.length);
  const d = [];
  for (let i = 0; i < n; i++) d.push((deltasA[i] - deltasB[i]) / bb);
  const m = mean(d);
  const sd = stdev(d);
  const se = n > 0 ? sd / Math.sqrt(n) : 0;
  return {
    hands: n,
    meanDiffBbPer100: m * 100,
    pairedSdPer100: sd * 100,
    pairedSe95: se * 100 * 1.96,
    // For interpretability, the fraction of hands where A beat B.
    aWinsPct: (100 * d.filter((x) => x > 0).length) / n,
    bWinsPct: (100 * d.filter((x) => x < 0).length) / n,
    tiesPct: (100 * d.filter((x) => x === 0).length) / n,
  };
}

/** t-ish 95% CI for a sample of per-seed means (small k uses a normal approx). */
function sampleCI(xs, z = 1.96) {
  const n = xs.length;
  if (n === 0) return { n: 0, mean: null, sd: null, ci95: null };
  const m = mean(xs);
  const sd = stdev(xs);
  const se = n > 0 ? sd / Math.sqrt(n) : 0;
  return { n, mean: m, sd, ci95: se * z };
}

/**
 * Resample the per-seed means with replacement (`--boot` reps, default 10000).
 * This is the "block bootstrap" at the seed level: each seed is an independent
 * block of `hands` hands, so resampling seeds captures between-seed variance
 * that a within-run per-hand CI cannot see.
 */
function seedBootstrapCI(seedMeans, reps = 10000, rand = mulberry32(0xb007)) {
  const n = seedMeans.length;
  if (n < 2) return { reps: 0, lo: null, hi: null };
  const means = [];
  for (let b = 0; b < reps; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += seedMeans[Math.floor(rand() * n)];
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor(0.025 * reps)];
  const hi = means[Math.floor(0.975 * reps)];
  return { reps, lo, hi };
}

/**
 * Block bootstrap over per-hand deltas: resample contiguous blocks of
 * `blockSize` hands with replacement. Used as a within-seed sanity check on the
 * per-hand normal-approx CI (hand-to-hand EV is autocorrelated, so i.i.d. blocks
 * understate the true variance slightly — report both).
 */
function blockBootstrapCI(deltas, bb, blockSize = 50, reps = 2000, rand = mulberry32(0x51ab1e)) {
  const n = deltas.length;
  if (n < blockSize * 2) return { reps: 0, lo: null, hi: null, blockSize };
  const perHand = deltas.map((d) => d / bb);
  const nBlocks = Math.ceil(n / blockSize);
  const means = [];
  for (let b = 0; b < reps; b++) {
    let sum = 0; let count = 0;
    for (let i = 0; i < nBlocks; i++) {
      const start = Math.floor(rand() * nBlocks) * blockSize;
      for (let j = 0; j < blockSize && start + j < n; j++) { sum += perHand[start + j]; count++; }
    }
    means.push((100 * sum) / count);
  }
  means.sort((a, b) => a - b);
  return { reps, blockSize, lo: means[Math.floor(0.025 * reps)], hi: means[Math.floor(0.975 * reps)] };
}

/**
 * Run `hands` hands of a fixed matchup. `heroSpec` plays seat 0; `villainSpec`
 * fills every other seat. Deals are seeded only by (seed, handIndex), so two
 * runs with different hero specs play identical cards (paired comparison).
 */
function newDiagnostics(seats) {
  const preflopNodes = {}; const preflopPos = {}; const preflopDecisionHands = {}; const postflopActions = {};
  const rfiOpportunities = {}; const rfiRaises = {};
  for (let s = 0; s < seats; s++) {
    preflopNodes[s] = {}; preflopPos[s] = {}; preflopDecisionHands[s] = 0; postflopActions[s] = {};
    rfiOpportunities[s] = {}; rfiRaises[s] = {};
  }
  return { preflopNodes, preflopPos, preflopDecisionHands, postflopActions, rfiOpportunities, rfiRaises };
}

/** Resolved rule params of a seat's policy, when it is a rules-v1 policy. */
function resolvedParamsOf(policy) {
  const p = policy?.params;
  if (!p || typeof p !== 'object') return null;
  return { ...p };
}

function runMatchup(o) {
  const {
    heroSpec, villainSpecs, seats, hands, seed, sb, bb, stackBb, rakeBps, rakeCapBb, collectMs,
    memoryEnabled, returnHandDeltas,
  } = o;
  const villainAt = (seat) => villainSpecs[(seat - 1) % villainSpecs.length];
  const policySeed = (s) => (seed ^ Math.imul(s + 1, 0x9e3779b9)) >>> 0;
  const policies = {};
  const specBySeat = [];
  for (let s = 0; s < seats; s++) {
    const spec = s === 0 ? heroSpec : villainAt(s);
    specBySeat[s] = spec;
    policies[s] = makePolicy(spec, policySeed(s));
  }
  const trackers = memoryEnabled
    ? Object.fromEntries(Array.from({ length: seats }, (_, s) => [s, new SessionTracker()]))
    : null;
  const diag = newDiagnostics(seats);
  const perSeat = {};
  const showdownDeltas = {};
  const nonShowdownDeltas = {};
  for (let s = 0; s < seats; s++) { perSeat[s] = []; showdownDeltas[s] = []; nonShowdownDeltas[s] = []; }
  const vpip = {}; const pfr = {};
  for (let s = 0; s < seats; s++) { vpip[s] = 0; pfr[s] = 0; }
  const participants = Array.from({ length: seats }, (_, s) => ({ seat: s, userId: userIdOf(s) }));
  let totalRake = 0; let showdowns = 0; let totalDecisions = 0; let maxDecisions = 0; let allInHands = 0;
  const t0 = collectMs ? process.hrtime.bigint() : 0n;

  for (let i = 0; i < hands; i++) {
    const handId = `h${seed}-${i}`;
    const handSeed = (seed ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0;
    const r = playHand({
      handSeed, handIndex: i, handId, seatSpecs: specBySeat, policies,
      sb, bb, stackBb, rakeBps, rakeCapBb, trackers, diag,
    });
    const anyAllIn = r.allIn;
    if (anyAllIn) allInHands++;
    for (let s = 0; s < seats; s++) {
      const d = r.nets.get(s);
      perSeat[s].push(d);
      (r.showdown ? showdownDeltas[s] : nonShowdownDeltas[s]).push(d);
    }
    for (const s of r.vpipSeats) vpip[s]++;
    for (const s of r.pfrSeats) pfr[s]++;
    totalRake += r.rake;
    if (r.showdown) showdowns++;
    totalDecisions += r.decisions;
    if (r.decisions > maxDecisions) maxDecisions = r.decisions;

    if (trackers) {
      const actions = r.history.map((h) => ({ seat: h.seat, street: h.street, type: h.action.type, auto: h.auto }));
      for (let s = 0; s < seats; s++) {
        trackers[s].observeHand({
          historyComplete: true,
          mySeat: s,
          myDelta: r.nets.get(s),
          endedStreet: r.endedStreet,
          showdown: r.showdown,
          participants,
          actions,
        });
      }
    }
  }
  const elapsedMs = collectMs ? Number(process.hrtime.bigint() - t0) / 1e6 : null;

  const seatsReport = [];
  for (let s = 0; s < seats; s++) {
    const resolved = resolvedParamsOf(policies[s]);
    const rfiByPosition = {};
    for (const [pos, opp] of Object.entries(diag.rfiOpportunities[s] ?? {})) {
      const raises = diag.rfiRaises[s]?.[pos] ?? 0;
      rfiByPosition[pos] = { opportunities: opp, raises, rfiPct: opp > 0 ? (100 * raises) / opp : null };
    }
    seatsReport.push({
      seat: s,
      role: s === 0 ? 'hero' : 'villain',
      spec: specBySeat[s].label,
      ...bb100(perSeat[s], bb),
      vpipPct: (100 * vpip[s]) / hands,
      pfrPct: (100 * pfr[s]) / hands,
      vpipDenominatorHands: hands,
      resolvedParams: resolved,
      adaptivePreflop: resolved ? resolved.adaptivePreflop : null,
      preflopDecisions: diag.preflopDecisionHands[s],
      preflopNodes: { ...diag.preflopNodes[s] },
      preflopPositions: { ...diag.preflopPos[s] },
      rfiByPosition,
      postflopActions: { ...diag.postflopActions[s] },
      showdownEv: eb100(showdownDeltas[s], bb),
      nonShowdownEv: eb100(nonShowdownDeltas[s], bb),
    });
  }
  return {
    seats: seatsReport,
    hands,
    memoryEnabled: !!memoryEnabled,
    rake: {
      bps: rakeBps,
      capBb: rakeCapBb,
      totalChips: totalRake,
      perHandChips: totalRake / hands,
      per100Bb: (100 * totalRake) / hands / bb,
    },
    totals: {
      showdownPct: (100 * showdowns) / hands,
      decisionsPerHand: totalDecisions / hands,
      maxDecisions,
      allInHandPct: (100 * allInHands) / hands,
    },
    rangeWidths: rangeWidths(),
    ...(returnHandDeltas ? { heroDeltas: perSeat[0] } : {}),
    elapsedMs,
  };
}

// ===========================================================================
// Isolation self-test
// ===========================================================================

/**
 * Structural proof that a policy cannot see hidden information:
 *  - for every decision, the view exposes exactly the actor's own two hole
 *    cards and no other player's cards (the view shape has no field for them);
 *  - `actionHistory` carries only actions, never cards;
 *  - the two players' myCards sets are disjoint and drawn from the deck.
 * We wrap each policy with a recording proxy and assert on the recorded views.
 */
function isolationSelfTest() {
  const problems = [];
  const recorded = [];
  const seats = 2;
  const policies = {};
  for (let s = 0; s < seats; s++) {
    const inner = makePolicy(specByName(s === 0 ? 'prod' : 'lag'), 1234 + s);
    policies[s] = {
      name: `wrap-${s}`,
      decide(view) {
        recorded.push({ seat: s, view });
        return inner.decide(view);
      },
    };
  }
  const specBySeat = [specByName('prod'), specByName('lag')];
  for (let i = 0; i < 40; i++) {
    playHand({
      handSeed: (999 ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0, handIndex: i, handId: `iso-${i}`,
      seatSpecs: specBySeat, policies, sb: 10, bb: 20, stackBb: 100, rakeBps: 50, rakeCapBb: 0,
    });
  }
  const seenHoleByHand = new Map();
  for (const rec of recorded) {
    const v = rec.view;
    const h = v.hand;
    if (!h) { problems.push('view without hand'); continue; }
    if (h.myCards.length !== 2) problems.push(`myCards length ${h.myCards.length}`);
    // No opponent object may carry cards.
    for (const o of v.opponents) {
      if ('cards' in o || 'holeCards' in o || 'myCards' in o) problems.push('opponent exposes cards');
    }
    // The board must never contain a card the actor holds.
    for (const c of h.board) if (h.myCards.includes(c)) problems.push('board overlaps own hole cards');
    // actionHistory must carry only actions.
    for (const a of v.actionHistory) {
      if ('cards' in a || 'holeCards' in a) problems.push('history exposes cards');
    }
    // Both players' hole cards for the same hand must be disjoint & 4 distinct.
    const key = h.handId;
    const cur = seenHoleByHand.get(key) ?? new Map();
    cur.set(rec.seat, h.myCards.join(','));
    seenHoleByHand.set(key, cur);
  }
  for (const [handId, bySeat] of seenHoleByHand) {
    if (bySeat.size === 2) {
      const [a, b] = [...bySeat.values()].map((s) => s.split(',').map(Number));
      const all = [...a, ...b];
      if (new Set(all).size !== 4) problems.push(`hand ${handId}: hole cards overlap between seats`);
    }
  }
  return { ok: problems.length === 0, problems: [...new Set(problems)], decisionsChecked: recorded.length };
}

/**
 * Heads-up position self-test. Plays the real `dealingOrder` + shared
 * `startHand`/`nextStreet` and reports, for both button rotations, who acts
 * first preflop and postflop, which seat is the button/SB/BB, and where seat 0
 * (the hero) sits. Expected production values (game.ts + preflopPolicy.ts):
 *   dealing order [button, other], preflop first = button/SB, postflop first = BB.
 */
function huCheck() {
  const rows = [];
  const problems = [];
  for (const button of [0, 1]) {
    const order = dealingOrder(2, button);
    const st0 = startHand(order.map((s) => ({ seat: s, stack: 2000 })), button, 10, 20);
    const preflopFirst = st0.toAct;
    let st = st0;
    // close preflop: the SB calls the blind (cannot check facing the BB), BB checks.
    for (let k = 0; k < 2 && streetClosed(st) === false; k++) {
      const la = legalActions(st);
      st = applyAction(st, st.toAct, la.canCheck ? { type: 'check' } : { type: 'call' });
    }
    st = nextStreet(st);
    const flopFirst = st.toAct;
    const seatLabel = (seat) => (seat === button ? 'button/SB' : 'BB');
    const row = {
      button,
      dealingOrder: order,
      heroSeat: 0,
      heroIsButton: 0 === button,
      preflopFirst,
      preflopFirstLabel: seatLabel(preflopFirst),
      postflopFirst: flopFirst,
      postflopFirstLabel: seatLabel(flopFirst),
    };
    rows.push(row);
    if (order[0] !== button) problems.push(`button ${button}: dealing order[0] is not the button`);
    if (preflopFirst !== button) problems.push(`button ${button}: preflop first is not the button/SB`);
    if (flopFirst === button) problems.push(`button ${button}: postflop first is the button (should be BB)`);
  }
  // Seat-order contract the policy reads (`seatsInDealingOrder`): index 0 = SB.
  const order0 = dealingOrder(2, 0);
  const stA = startHand(order0.map((s) => ({ seat: s, stack: 2000 })), 0, 10, 20);
  const heroOrderIdx = stA.seats.findIndex((s) => s.seat === 0);
  if (heroOrderIdx !== 0) problems.push('hero (seat 0) is not index 0 (SB/button) when button=0');

  // Policy-level alignment: capture the hero's real first DecisionView in two
  // HU hands (button 0 then 1) and ask the SAME production helpers the rules-v1
  // policy uses (`derivePreflopContext` -> positionForSeat; `postflopActionOrder`)
  // where the hero sits. This is the "hero position matches production" check.
  const captured = {};
  const heroInner = makePolicy(specByName('prod'), 1);
  const huPolicies = {
    0: { name: 'rec', decide(v) { if (!captured[v.hand.handId]) captured[v.hand.handId] = v; return heroInner.decide(v); } },
    1: makePolicy(specByName('cr'), 2),
  };
  const huSpecs = [specByName('prod'), specByName('cr')];
  for (let i = 0; i < 2; i++) {
    playHand({
      handSeed: (777 ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0, handIndex: i, handId: `huc-${i}`,
      seatSpecs: huSpecs, policies: huPolicies, sb: 10, bb: 20, stackBb: 100, rakeBps: 50, rakeCapBb: 0,
    });
  }
  for (let i = 0; i < 2; i++) {
    const v = captured[`huc-${i}`];
    if (!v) { problems.push(`huc-${i}: no hero decision captured`); continue; }
    const ctx = derivePreflopContext(v);
    const pfOrder = postflopActionOrder(v);
    const expectedPos = i === 0 ? 'SB' : 'BB'; // hand 0: button 0 = hero SB; hand 1: button 1 = hero BB
    rows[i].heroPosition = ctx.position;
    rows[i].postflopOrder = pfOrder;
    if (ctx.position !== expectedPos) problems.push(`huc-${i}: hero policy position ${ctx.position} != expected ${expectedPos}`);
    // Postflop the BB acts first; the hero is first only when hero is the BB.
    const heroFirstPostflop = pfOrder[0] === 0;
    if (heroFirstPostflop !== (expectedPos === 'BB')) problems.push(`huc-${i}: hero postflop-first ${heroFirstPostflop} inconsistent with position ${ctx.position}`);
  }
  return { ok: problems.length === 0, problems: [...new Set(problems)], rows };
}

// ===========================================================================
// Report formatting
// ===========================================================================
const VILLAINS = ['human-lag', 'cr', 'tag', 'station', 'lag'];

function fmtNum(x, d = 1) {
  if (!Number.isFinite(x)) return 'n/a';
  return x.toFixed(d);
}
function fmtSigned(x, d = 1) {
  if (!Number.isFinite(x)) return 'n/a';
  return `${x >= 0 ? '+' : ''}${x.toFixed(d)}`;
}

function printMatchup(rep, o) {
  const s0 = rep.seats[0];
  console.log(`matchup: hero=${o.heroSpec.label}`);
  console.log(`         vs  =${o.villainSpecs.map((s) => s.label).join(' | ')}`);
  console.log(`hands=${rep.hands} seats=${o.seats} sb/bb=${o.sb}/${o.bb} stack=${o.stackBb}bb seed=${o.seed}`);
  console.log(`rake: ${rep.rake.bps} bps (${(rep.rake.bps / 100).toFixed(2)}%) cap=${rep.rake.capBb === 0 ? 'none' : rep.rake.capBb + 'bb/pot'}  total=${rep.rake.totalChips} chips (${fmtNum(rep.rake.per100Bb, 2)} bb/100 removed)`);
  console.log(`showdown=${fmtNum(rep.totals.showdownPct, 1)}%  allInHands=${fmtNum(rep.totals.allInHandPct, 1)}%  decisions/hand=${fmtNum(rep.totals.decisionsPerHand, 2)}`);
  console.log(`sessionMemory=${rep.memoryEnabled ? 'ON (production default)' : 'OFF (empty)'}`);
  console.log('');
  console.log('  seat role    bb/100     ±95%CI    sd/100   totalChips   VPIP     PFR');
  for (const s of rep.seats) {
    console.log(
      `  ${String(s.seat).padEnd(4)} ${s.role.padEnd(7)} ` +
      `${fmtSigned(s.bbPer100).padStart(8)}  ±${fmtNum(s.se95, 1).padStart(6)}  ` +
      `${fmtNum(s.sdPer100, 0).padStart(6)}  ${String(s.totalChips).padStart(10)}  ` +
      `${fmtNum(s.vpipPct, 1).padStart(5)}%  ${fmtNum(s.pfrPct, 1).padStart(5)}%`,
    );
  }
  console.log('');
  console.log('sum of both bb/100 = the rake drag (they must add to ≈ 0 minus rake).');
  console.log('');
  printCalibration(rep, o);
  return s0;
}

/** Full calibration 口径 for the hero: enough to reproduce / audit any VPIP. */
function printCalibration(rep, o) {
  const h = rep.seats[0];
  console.log(`HERO calibration 口径 (seat 0 = ${h.spec})`);
  console.log(`  resolved params : ${h.resolvedParams ? JSON.stringify(h.resolvedParams) : 'n/a (non-rules policy)'}`);
  console.log(`  adaptivePreflop : ${h.adaptivePreflop === null ? 'n/a' : String(h.adaptivePreflop)}` + `  (env FOURAM_ADAPTIVE_PREFLOP=${process.env.FOURAM_ADAPTIVE_PREFLOP ?? '(unset)'})`);
  console.log(`  VPIP/PFR denominator : ${h.vpipDenominatorHands} hands dealt (production definition: dealt-in hands with complete history)`);
  console.log(`  VPIP=${fmtNum(h.vpipPct, 1)}%  PFR=${fmtNum(h.pfrPct, 1)}%  (voluntary actions / hands dealt, NOT a range width)`);
  console.log(`  preflop decision nodes : ${h.preflopDecisions} across ${rep.hands} hands`);
  console.log(`    unopened/facingOpen/facing3bet/facingMore = ${nodeList(h.preflopNodes)}`);
  console.log(`    by position            = ${jsonInline(h.preflopPositions)}`);
  console.log(`    RFI by position        = ${rfiList(h.rfiByPosition)}  (raises/unopened-opportunities)`);
  console.log(`  postflop decisions       = ${h.postflopActions?.streetDecisions ?? 0}  actions=${jsonInline(omitKey(h.postflopActions, 'streetDecisions'))}`);
  console.log(`  EV split: showdown=${fmtSigned(h.showdownEv.bbPer100)} bb/100 (n=${h.showdownEv.hands})  non-showdown=${fmtSigned(h.nonShowdownEv.bbPer100)} bb/100 (n=${h.nonShowdownEv.hands})`);
  if (o.seats >= 3) {
    const w = rep.rangeWidths ?? {};
    const posKeys = ['UTG', 'HJ', 'CO', 'BTN', 'SB'];
    console.log(`  nominal legacy RFI range width (combos/1326; adaptive charts are the live path):`);
    console.log(`    ${posKeys.map((p) => `${p}:${fmtNum(w[p]?.basePct ?? 0, 1)}%`).join('  ')}`);
  }
  console.log('  ⚠️ range width (a chart property) ≠ sample VPIP (an action frequency) ≠ seat opportunity mix.');
}

function nodeList(nodes) {
  const order = ['unopened', 'facingOpen', 'facing3bet', 'facingMore'];
  return order.map((k) => `${k}=${nodes?.[k] ?? 0}`).join('/');
}
function rfiList(rfi) {
  if (!rfi || Object.keys(rfi).length === 0) return 'n/a';
  return Object.entries(rfi)
    .map(([pos, v]) => `${pos}:${v.rfiPct === null ? 'n/a' : fmtNum(v.rfiPct, 0) + '%'}(${v.raises}/${v.opportunities})`)
    .join('  ');
}
function omitKey(obj, key) {
  if (!obj) return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (k !== key) out[k] = v;
  return out;
}
function jsonInline(obj) {
  if (!obj || Object.keys(obj).length === 0) return '{}';
  return Object.entries(obj).map(([k, v]) => `${k}:${v}`).join(' ');
}

function printBaseline(rows, o) {
  console.log(`EV baseline — hero=${o.heroSpec.label}  seats=${o.seats}  hands/matchup=${o.hands}`);
  console.log(`seed=${o.seed} sb/bb=${o.sb}/${o.bb} stack=${o.stackBb}bb rake=${o.rakeBps}bps cap=${o.rakeCapBb === 0 ? 'none' : o.rakeCapBb + 'bb'}  sessionMemory=${o.memory ? 'ON' : 'OFF'}`);
  console.log('');
  console.log('  opponent lineup                      hero bb/100   ±95%CI   hero VPIP/PFR   hero showdown%');
  for (const r of rows) {
    const hero = r.seats[0];
    console.log(
      `  ${r.villainLabel.padEnd(36)} ${fmtSigned(hero.bbPer100).padStart(10)}  ±${fmtNum(hero.se95, 1).padStart(6)}  ` +
      `${(fmtNum(hero.vpipPct, 1) + '/' + fmtNum(hero.pfrPct, 1)).padEnd(14)}  ${fmtNum(r.totals.showdownPct, 1)}%`,
    );
  }
  console.log('');
  console.log('⚠️ EXPLORATORY baseline: single seed, per-hand normal-approx CI, NO multiple-comparison');
  console.log('   correction, and NOT yet paired-difference / multi-seed / production-state verified.');
  console.log('   A row whose CI excludes 0 is a NOMINAL signal at best. Compare RELATIVE bb/100 (rake makes');
  console.log('   the sum of all seats negative), not the absolute sign.');
}

function printSweep(rows, o) {
  console.log(`EV sweep — hero base=${o.heroSpec.label} vs villain=${o.villainSpec.label}`);
  console.log(`sweeping ${o.sweepParam} over [${o.sweepValues.join(', ')}]  hands/config=${o.hands} seats=${o.seats} seed=${o.seed}`);
  console.log('');
  console.log(`  ${o.sweepParam.padEnd(22)} hero bb/100   ±95%CI   hero VPIP/PFR   villain bb/100`);
  for (const r of rows) {
    const hero = r.seats[0];
    const vil = r.seats[1] ?? r.seats[r.seats.length - 1];
    console.log(
      `  ${String(r.paramValue).padEnd(22)} ${fmtSigned(hero.bbPer100).padStart(9)}  ±${fmtNum(hero.se95, 1).padStart(6)}  ` +
      `${(fmtNum(hero.vpipPct, 1) + '/' + fmtNum(hero.pfrPct, 1)).padEnd(14)}  ${fmtSigned(vil.bbPer100).padStart(9)}`,
    );
  }
  // Paired differences vs the FIRST value. All rows played identical deals, so
  // A−B is the low-variance comparison ("same-deal denoising" lives here).
  if (rows.length > 1 && rows[0].heroDeltas) {
    console.log('');
    console.log(`paired A−B vs [${rows[0].paramValue}] (same deals):`);
    console.log('  config                 mean(A−B) bb/100   paired SD/100   paired ±95%CI');
    for (let i = 1; i < rows.length; i++) {
      const p = pairedDiff(rows[i].heroDeltas, rows[0].heroDeltas, o.bb);
      console.log(
        `  ${String(rows[i].paramValue).padEnd(22)} ${fmtSigned(p.meanDiffBbPer100).padStart(12)}  ` +
        `${fmtNum(p.pairedSdPer100, 0).padStart(12)}  ±${fmtNum(p.pairedSe95, 1).padStart(8)}`,
      );
    }
  }
}

function printPaired(rows, o) {
  console.log(`EV paired A−B — villain=${o.villainSpec.label} seats=${o.seats} hands/config=${o.hands} seed=${o.seed}`);
  console.log(`all configs play the SAME deals; memory=${o.memory ? 'ON' : 'OFF'}`);
  console.log('');
  console.log('  hero config                          bb/100     ±95%CI   VPIP/PFR');
  for (const r of rows) {
    const h = r.seats[0];
    console.log(
      `  ${r.heroLabel.padEnd(34)} ${fmtSigned(h.bbPer100).padStart(9)}  ±${fmtNum(h.se95, 1).padStart(6)}  ` +
      `${(fmtNum(h.vpipPct, 1) + '/' + fmtNum(h.pfrPct, 1)).padEnd(12)}`,
    );
  }
  if (rows.length > 1) {
    console.log('');
    console.log(`paired A−B vs [${rows[0].heroLabel}] (same deals, low variance):`);
    console.log('  config                               mean(A−B) bb/100   paired SD/100   paired ±95%CI   A>B');
    for (let i = 1; i < rows.length; i++) {
      const p = pairedDiff(rows[i].heroDeltas, rows[0].heroDeltas, o.bb);
      console.log(
        `  ${rows[i].heroLabel.padEnd(36)} ${fmtSigned(p.meanDiffBbPer100).padStart(12)}  ` +
        `${fmtNum(p.pairedSdPer100, 0).padStart(12)}  ±${fmtNum(p.pairedSe95, 1).padStart(8)}  ${fmtNum(p.aWinsPct, 0)}%`,
      );
    }
    console.log('');
    console.log('paired CI excludes 0 => the two configs differ at this seed; still needs multi-seed replication.');
  }
}

function printMultiseed(res, o) {
  console.log(`EV multiseed — hero=${o.heroSpec.label} vs villain=${o.villainSpec.label} seats=${o.seats} hands/seed=${o.hands}`);
  console.log(`seeds=${res.seeds.join(',')}`);
  console.log('');
  console.log('  seed         hero bb/100   hero VPIP/PFR   showdown%');
  for (const row of res.rows) {
    const h = row.seats[0];
    console.log(
      `  ${String(row.seed).padEnd(12)} ${fmtSigned(h.bbPer100).padStart(9)}  ` +
      `${(fmtNum(h.vpipPct, 1) + '/' + fmtNum(h.pfrPct, 1)).padEnd(14)}  ${fmtNum(row.totals.showdownPct, 1)}%`,
    );
  }
  const m = res.seedMean;
  console.log('');
  console.log(`seed-level mean = ${fmtSigned(m.mean)} bb/100  (n=${m.n} seeds, sd=${fmtNum(m.sd, 1)}, normal ±95%CI ±${fmtNum(m.ci95, 1)})`);
  if (res.bootstrap) console.log(`seed bootstrap 95% CI = [${fmtSigned(res.bootstrap.lo)}, ${fmtSigned(res.bootstrap.hi)}] (${res.bootstrap.reps} reps)`);
  if (res.blockBootstrap) console.log(`within-seed block bootstrap 95% CI (seed ${res.seeds[0]}, blocks of ${res.blockBootstrap.blockSize}) = [${fmtSigned(res.blockBootstrap.lo)}, ${fmtSigned(res.blockBootstrap.hi)}]`);
  console.log(`direction stability = ${fmtNum(100 * res.directionStability, 1)}% of seeds share the mean's sign (n=${res.seedMean.n}, sign=${m.mean >= 0 ? '+' : '-'})`);
  if (res.projection) {
    const p = res.projection;
    console.log(`measured ${fmtNum(p.msPerSeedHand, 2)} ms/hand; projected @${o.hands} hands/seed: 20 seeds ≈ ${fmtNum(p.per20SeedMs / 60000, 1)} min, 50 seeds ≈ ${fmtNum(p.per50SeedMs / 60000, 1)} min (single process)`);
  }
  console.log('');
  console.log('⚠️ A seed-level CI with few seeds is wide and approximate; block bootstrap over per-hand deltas is the within-seed cross-check.');
}

// ===========================================================================
// main
// ===========================================================================
const o = parseArgs(process.argv.slice(2));
o.rakeCapChips = o.rakeCapBb * o.bb;
o.memoryEnabled = o.memory; // runMatchup's option name
o.heroSpec = specByName(o.hero);
o.villainSpecs = o.villain.split(',').map((s) => specByName(s.trim()));
o.villainSpec = o.villainSpecs[0];

/** Apply a `k=v,k=v` override list to a spec, naming the variant in its label. */
function withParams(spec, rawParams) {
  if (!rawParams) return spec;
  const key = spec.style ? 'style' : 'params';
  const merged = { ...(spec[key] ?? {}), ...parseParamList(rawParams) };
  return { ...spec, [key]: merged, label: `${spec.label} ${rawParams}` };
}

if (o.heroParams) o.heroSpec = withParams(o.heroSpec, o.heroParams);

const report = { mode: o.mode, config: { ...o, heroSpec: o.heroSpec.label, villainSpec: o.villainSpec.label }, generatedAt: o.stable ? undefined : new Date().toISOString() };

if (o.mode === 'bench') {
  const benchHands = o.limit ?? Math.min(o.hands, 200);
  const r = runMatchup({ ...o, hands: benchHands, collectMs: true });
  const msPerHand = r.elapsedMs / benchHands;
  const fullMs = msPerHand * o.hands;
  report.bench = { benchHands, msPerHand, msPerDecision: r.elapsedMs / (benchHands * r.totals.decisionsPerHand), fullHands: o.hands, projectedMs: fullMs };
  console.log(`bench: ${benchHands} hands in ${fmtNum(r.elapsedMs, 0)} ms  ->  ${fmtNum(msPerHand, 2)} ms/hand, ${fmtNum(r.elapsedMs / (benchHands * r.totals.decisionsPerHand), 2)} ms/decision`);
  console.log(`projected: ${o.hands} hands ≈ ${fmtNum(fullMs / 1000, 1)} s (${fmtNum(fullMs / 60000, 1)} min) per matchup`);
} else if (o.mode === 'hucheck') {
  const res = huCheck();
  report.hu = res;
  console.log('HU position check (production rule: order=[button,other], preflop first=button/SB, postflop first=BB)');
  for (const row of res.rows) {
    console.log(`  button=${row.button} order=[${row.dealingOrder.join(',')}] heroSeat=${row.heroSeat} heroIsButton=${row.heroIsButton} heroPosition=${row.heroPosition}`);
    console.log(`    preflop first=${row.preflopFirst} (${row.preflopFirstLabel})   postflop first=${row.postflopFirst} (${row.postflopFirstLabel})   postflopOrder=[${(row.postflopOrder ?? []).join(',')}]`);
  }
  if (res.ok) console.log('HUCHECK: PASS');
  else { console.log('HUCHECK: FAIL'); for (const p of res.problems) console.log('  - ' + p); }
  process.exitCode = res.ok ? 0 : 1;
} else if (o.mode === 'isolate') {
  const res = isolationSelfTest();
  report.isolation = res;
  if (res.ok) console.log(`ISOLATION: PASS structurally (${res.decisionsChecked} decisions checked; view exposes no cross-seat / hidden-card info — NOT a full sandbox proof)`);
  else { console.log('ISOLATION: FAIL'); for (const p of res.problems) console.log('  - ' + p); }
  process.exitCode = res.ok ? 0 : 1;
} else if (o.mode === 'baseline') {
  // Fixed opponent lineups (NOT a parameter sweep): one full table of each
  // single archetype, plus a realistic mixed table (one live-human-profile seat
  // + four production bots).
  const LINEUPS = [
    ['human-lag'],
    ['cr'],
    ['tag'],
    ['station'],
    ['lag'],
    ['human-lag', 'cr', 'cr', 'cr', 'cr'],
  ];
  const rows = [];
  for (const names of LINEUPS) {
    const villainSpecs = names.map((n) => specByName(n));
    const r = runMatchup({ ...o, heroSpec: o.heroSpec, villainSpecs, seats: o.seats, collectMs: false });
    r.villainLabel = names.join('+');
    rows.push(r);
  }
  report.baseline = rows;
  printBaseline(rows, o);
} else if (o.mode === 'paired') {
  // A/B (or N-way) comparison on IDENTICAL deals: every hero config plays the
  // same (seed, handIndex) cards against the same fixed villain. The per-hand
  // hero deltas are kept so the report can print mean(A−B), paired SD and the
  // paired 95% CI — the low-variance comparison the old per-config CI missed.
  if (!o.heroes) { console.error('paired needs --heroes spec1;spec2[;...]  (each may be spec:k=v,k=v)'); process.exit(2); }
  const entries = o.heroes.split(';').map((s) => s.trim()).filter(Boolean);
  if (entries.length < 2) { console.error('paired needs at least two hero configs'); process.exit(2); }
  const rows = [];
  for (const entry of entries) {
    const colon = entry.indexOf(':');
    const name = colon >= 0 ? entry.slice(0, colon) : entry;
    const rawParams = colon >= 0 ? entry.slice(colon + 1) : null;
    const heroSpec = withParams(specByName(name), rawParams);
    const r = runMatchup({ ...o, heroSpec, villainSpecs: [o.villainSpec], collectMs: false, returnHandDeltas: true });
    r.heroLabel = heroSpec.label;
    rows.push(r);
  }
  report.paired = rows.map((r) => ({ heroLabel: r.heroLabel, seats: r.seats, hands: r.hands }));
  printPaired(rows, o);
} else if (o.mode === 'multiseed') {
  // Independent master seeds, fixed hands each. Reports the seed-level mean + CI
  // (normal and bootstrap), a within-seed block-bootstrap cross-check, and the
  // across-seed direction stability.
  const seeds = o.seedList
    ? o.seedList.split(',').map((s) => Number(s.trim()) >>> 0)
    : Array.from({ length: o.seeds ?? 5 }, (_, i) => (o.seed + i * 7919) >>> 0);
  if (seeds.length < 2) { console.error('multiseed needs --seeds N>=2 or --seed-list a,b,c'); process.exit(2); }
  const rows = [];
  let totalMs = 0;
  for (const seed of seeds) {
    const r = runMatchup({ ...o, seed, heroSpec: o.heroSpec, villainSpecs: [o.villainSpec], collectMs: true, returnHandDeltas: true });
    totalMs += r.elapsedMs;
    rows.push(r);
  }
  const seedMeans = rows.map((r) => r.seats[0].bbPer100);
  const seedMean = sampleCI(seedMeans);
  const bootstrap = seedBootstrapCI(seedMeans, o.boot);
  const blockBootstrap = blockBootstrapCI(rows[0].heroDeltas, o.bb, o.block, Math.min(o.boot, 2000));
  const dirSign = Math.sign(seedMean.mean);
  const directionStability = seedMeans.filter((x) => Math.sign(x) === dirSign || x === 0).length / seedMeans.length;
  const msPerSeedHand = totalMs / (seeds.length * o.hands);
  const projection = {
    msPerSeedHand,
    per20SeedMs: msPerSeedHand * o.hands * 20,
    per50SeedMs: msPerSeedHand * o.hands * 50,
  };
  const res = { seeds, rows: rows.map((r, i) => ({ seed: seeds[i], seats: r.seats, hands: r.hands, totals: r.totals })), seedMean, bootstrap, blockBootstrap, directionStability, projection };
  report.multiseed = res;
  printMultiseed(res, o);
} else if (o.mode === 'sweep') {
  if (!o.sweepParam || !o.sweepValues) {
    console.error('sweep needs --sweep-param and --sweep-values');
    process.exit(2);
  }
  const values = o.sweepValues.split(',').map((s) => Number(s.trim()));
  const rows = [];
  for (const val of values) {
    const heroSpec = { ...o.heroSpec, params: { ...(o.heroSpec.params ?? {}), [o.sweepParam]: val } };
    const r = runMatchup({ ...o, heroSpec, villainSpecs: [o.villainSpec], collectMs: false, returnHandDeltas: true });
    r.paramValue = val;
    rows.push(r);
  }
  report.sweep = { param: o.sweepParam, values, rows: rows.map((r) => ({ paramValue: r.paramValue, seats: r.seats, hands: r.hands })) };
  printSweep(rows, o);
} else {
  const r = runMatchup({ ...o, collectMs: !o.stable });
  report.matchup = r;
  report.heroLabel = o.heroSpec.label;
  report.villainLabel = o.villainSpecs.map((s) => s.label).join(' | ');
  report.seats = o.seats;
  report.sb = o.sb;
  report.bb = o.bb;
  report.stackBb = o.stackBb;
  if (o.json) console.log(JSON.stringify(report, null, 2));
  else printMatchup(r, o);
}

if (o.out) {
  writeFileSync(o.out, `${JSON.stringify(report, null, 2)}\n`);
  if (!o.json) console.log(`\nwrote ${o.out}`);
}