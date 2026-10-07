import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cardFromName, type CardId } from '@4am/shared';
import type {
  DecisionHand,
  DecisionLegalActions,
  DecisionSeat,
  DecisionView,
  OpponentStats,
  PublicAction,
} from '../src/decisionView.js';
import {
  DEFAULT_P2,
  PostflopPolicy,
  bluffBetProbability,
  blockerScore,
  chooseBetFraction,
  classifyTexture,
  evaluateHand,
  facingBetMargin,
  facingBetSamples,
  facingVillainModel,
  facingVillainRange,
  handPercentile,
  heroInPosition,
  heroWasAggressor,
  isExposedOverpair,
  madeHandSuppressedByBoard,
  opponentModelStats,
  rangeAdvantage,
  resolveFacingBetPrice,
  valueBetProbability,
  type P2Options,
  type PostflopTrace,
} from '../src/postflopPolicy.js';
import { estimateEquity } from '../src/equity.js';
import { deriveRulesSeed } from '../src/rulesSeed.js';
import { RULE_PRESETS } from '../src/ruleStyles.js';

/**
 * Postflop DECISION TRACE snapshot: the structural companion to
 * `postflopSignalSnapshot.test.ts`.
 *
 * The signal snapshot reconstructs every decision-relevant signal from the
 * module's exported pure helpers. That leaves a structural blind spot: if the
 * policy calls a helper internally with *different* arguments than the test's
 * reconstruction (e.g. a street-specific `chooseBetFraction`, the
 * `exposedOverpair`-discounted value probability, or the real `overbetRoll`),
 * the snapshot can stay green while the real decision drifts.
 *
 * This file closes that gap. It runs the SAME scenario matrix through the real
 * `PostflopPolicy.decide()` with `onTrace` installed, records the INTERNAL
 * values the engine actually computed, and then asserts them against the
 * reconstruction:
 *
 *   1. **snapshot** — the real trace + the reconstruction, frozen to
 *      `fixtures/postflopTrace.snapshot.json`; and
 *   2. **cross-assertions** — for every field the reconstruction claims to
 *      reproduce, `round6(trace.value) === reconstructed.value`; for the three
 *      known divergences (real `overbetRoll`, the masked value probability and
 *      the street-specific bet fraction) the test asserts the exact relation
 *      the trace exposes, so a future drift cannot hide.
 *
 * Regenerate with:
 *   UPDATE_SNAPSHOTS=1 npx vitest run packages/agent-core/test/postflopTrace.test.ts
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = join(HERE, 'fixtures', 'postflopTrace.snapshot.json');
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';

const c = (n: string) => cardFromName(n);
const SEED = 0x9e3779b9;
const PARAMS = { ...RULE_PRESETS['constrained-random'], adaptivePreflop: true };
const P2: P2Options = { ...DEFAULT_P2 };

// --- view builders (mirrors postflopSignalSnapshot.test.ts) -----------------

function la(over: Partial<DecisionLegalActions> = {}): DecisionLegalActions {
  return {
    canCheck: false,
    canCall: true,
    callAmount: 50,
    canBet: false,
    canRaise: true,
    minRaiseTo: 100,
    maxRaiseTo: 1000,
    ...over,
  };
}

function seat(over: Partial<DecisionSeat> = {}): DecisionSeat {
  return {
    seat: 1,
    userId: 2,
    displayName: 'hero',
    isMe: true,
    stack: 1000,
    committed: 0,
    total: 0,
    folded: false,
    allIn: false,
    sittingOut: false,
    connected: true,
    ...over,
  };
}

function emptyView(): DecisionView {
  return {
    room: { id: 'r', name: 'r', sb: 1, bb: 2, minSettleHands: 0, sevenDeuceBonus: 0 },
    hand: null,
    me: null,
    legalActions: null,
    potOdds: null,
    actionHistory: [],
    opponents: [],
    sessionMemory: { handsObserved: 0, netChips: null, recentHands: [], opponents: [] },
    historyComplete: true,
  };
}

function handOf(myCards: CardId[], board: CardId[], over: Partial<DecisionHand> = {}): DecisionHand {
  return {
    handId: 'trace-h1',
    street: board.length >= 5 ? 'river' : board.length === 4 ? 'turn' : 'flop',
    buttonSeat: 0,
    board,
    pot: 100,
    currentBet: 0,
    toAct: 0,
    deadline: null,
    myCards,
    mySeat: 0,
    ...over,
  };
}

type StatsKind = 'neutral' | 'station' | 'nit';

function opponentSeats(n: number): DecisionSeat[] {
  return Array.from({ length: n }, (_, i) =>
    seat({ seat: i + 1, userId: 10 + i, isMe: false, displayName: `v${i}` }),
  );
}

function statsFor(kind: StatsKind, opponents: DecisionSeat[]): OpponentStats[] {
  if (kind === 'neutral') return [];
  const vpipHands = kind === 'station' ? 30 : 8; // .60 / .16
  const pfrHands = kind === 'station' ? 5 : 6; // .10 / .12
  return opponents.map((o) => ({
    seat: o.seat,
    sampleHands: 50,
    vpipHands,
    pfrHands,
    postflopBetsRaises: kind === 'station' ? 5 : 8,
    postflopCalls: kind === 'station' ? 30 : 10,
  }));
}

function preflopHistory(heroAggressor: boolean): PublicAction[] {
  return heroAggressor
    ? [{ actionSeq: 0, street: 'preflop', seat: 0, action: { type: 'raise', amount: 6 }, auto: false, ts: 0 }]
    : [];
}

interface CommonOpts {
  opponents?: number;
  stats?: StatsKind;
  heroAggressor?: boolean;
}

function checkedToView(cards: CardId[], board: CardId[], o: CommonOpts = {}): DecisionView {
  const n = o.opponents ?? 1;
  const opponents = opponentSeats(n);
  return {
    ...emptyView(),
    hand: handOf(cards, board, { pot: 100, currentBet: 0, mySeat: 0, toAct: 0 }),
    me: seat({ seat: 0, userId: 1, isMe: true, committed: 0 }),
    opponents,
    legalActions: la({
      canCheck: true,
      canCall: false,
      callAmount: 0,
      canBet: true,
      canRaise: false,
      minRaiseTo: 2,
      maxRaiseTo: 1000,
    }),
    potOdds: { callAmount: 0, pot: 100, potOdds: 0, breakEvenEquity: 0 },
    seatOrder: [...opponents.map((x) => x.seat), 0],
    actionSeq: 0,
    actionHistory: preflopHistory(o.heroAggressor ?? false),
    sessionMemory: {
      handsObserved: 50,
      netChips: null,
      recentHands: [],
      opponents: statsFor(o.stats ?? 'neutral', opponents),
    },
  };
}

function facingView(cards: CardId[], board: CardId[], call: number, o: CommonOpts = {}): DecisionView {
  const n = o.opponents ?? 1;
  const potBefore = 100;
  const pot = potBefore + call;
  const opponents = opponentSeats(n).map((x) => ({ ...x, committed: call, total: call }));
  return {
    ...emptyView(),
    hand: handOf(cards, board, { pot, currentBet: call, mySeat: 0, toAct: 0 }),
    me: seat({ seat: 0, userId: 1, isMe: true, committed: call, total: call }),
    opponents,
    legalActions: la({
      canCheck: false,
      canCall: true,
      callAmount: call,
      canRaise: true,
      canBet: false,
      minRaiseTo: call * 2,
      maxRaiseTo: 1000,
    }),
    potOdds: {
      callAmount: call,
      pot,
      potOdds: call / (pot + call),
      breakEvenEquity: call / (pot + call),
    },
    seatOrder: [...opponents.map((x) => x.seat), 0],
    actionSeq: 0,
    actionHistory: preflopHistory(o.heroAggressor ?? false),
    sessionMemory: {
      handsObserved: 50,
      netChips: null,
      recentHands: [],
      opponents: statsFor(o.stats ?? 'neutral', opponents),
    },
  };
}

// --- reconstruction (same exported helpers the signal snapshot uses) --------

function sprOf(view: DecisionView): number {
  const pot = view.potOdds?.pot ?? 0;
  if (pot <= 0) return 10;
  const myStack = view.me?.stack ?? 0;
  const activeStacks = view.opponents.filter((o) => !o.folded && !o.allIn).map((o) => o.stack);
  const oppMax = activeStacks.length ? Math.max(...activeStacks) : 0;
  const effective = oppMax > 0 ? Math.min(myStack, oppMax) : myStack;
  return effective / pot;
}

function exploitMultiplierOf(view: DecisionView): number {
  const bySeat = new Map(view.sessionMemory.opponents.map((o) => [o.seat, o]));
  let vpip = 0;
  let pfr = 0;
  let n = 0;
  for (const o of view.opponents) {
    if (o.folded) continue;
    const s = bySeat.get(o.seat);
    if (!s || s.sampleHands < 10) continue;
    vpip += s.vpipHands / s.sampleHands;
    pfr += s.pfrHands / s.sampleHands;
    n++;
  }
  if (n === 0) return 1;
  const avgVpip = vpip / n;
  const avgPfr = pfr / n;
  let m = 1;
  if (avgVpip > 0.45 && avgPfr < 0.18) m *= 0.6;
  else if (avgVpip < 0.22) m *= 1.25;
  return Math.min(1.4, Math.max(0.4, m));
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

interface Recon {
  hand: {
    category: number;
    flushDraw: boolean;
    straightDraw: number;
    overcards: number;
    percentile: number;
  };
  texture: ReturnType<typeof classifyTexture>;
  position: { inPosition: boolean; wasAggressor: boolean };
  opponents: { count: number; model: ReturnType<typeof opponentModelStats> };
  blocker: number;
  madeHandSuppressed: boolean;
  exposedOverpair: boolean;
  rangeAdvantage: number;
  spr: number;
  exploitMultiplier: number;
  facing?: {
    call: number;
    price: { trusted: boolean; potBefore: number; requiredEquity: number; requiredMdf: number };
    equity: number;
    margin: number;
    villainModel: ReturnType<typeof facingVillainModel>;
    villainCombos: number;
    samples: number;
  };
  checkedTo?: {
    /** Explicit: this reference used `overbetRoll: 0`, not the production draw. */
    reconstructedWithOverbetRollZero: true;
    valueBetProbability: number;
    betFraction: number;
    bluffBetProbability: number;
  };
}

function reconstruct(view: DecisionView, node: 'checkedTo' | 'facingBet'): Recon {
  const hole = view.hand?.myCards ?? [];
  const board = view.hand?.board ?? [];
  const ev = evaluateHand(hole, board);
  const texture = classifyTexture(board);
  const inPosition = heroInPosition(view);
  const wasAggressor = heroWasAggressor(view);
  const adv = rangeAdvantage({ heroWasAggressor: wasAggressor, inPosition, texture });
  const active = Math.max(1, view.opponents.filter((o) => !o.folded).length);
  const blocker = blockerScore(hole, board);

  const recon: Recon = {
    hand: {
      category: ev.category,
      flushDraw: ev.flushDraw,
      straightDraw: ev.straightDraw,
      overcards: ev.overcards,
      percentile: round6(handPercentile(hole, board)),
    },
    texture,
    position: { inPosition, wasAggressor },
    opponents: { count: active, model: opponentModelStats(view) },
    blocker: round6(blocker),
    madeHandSuppressed: madeHandSuppressedByBoard(hole, board, ev, texture),
    exposedOverpair: isExposedOverpair(hole, board, ev),
    rangeAdvantage: round6(adv),
    spr: round6(sprOf(view)),
    exploitMultiplier: round6(exploitMultiplierOf(view)),
  };

  if (node === 'facingBet') {
    const call = view.legalActions?.callAmount ?? 0;
    const price = resolveFacingBetPrice(view.potOdds, call);
    const samples = facingBetSamples(active);
    let equity = price.requiredEquity;
    const villainRange = facingVillainRange(view, hole, price.potBefore, call, P2);
    try {
      const knownValid = new Set([...hole, ...board]).size === hole.length + board.length;
      if (knownValid) {
        const estimate = estimateEquity({
          hole,
          board,
          opponents: active,
          samples,
          seed: deriveRulesSeed(SEED, view),
          villainRange,
        });
        equity = Number.isFinite(estimate.equity) ? estimate.equity : 0;
      }
    } catch {
      // Mirror decide(): fall back to the price's required equity.
    }
    recon.facing = {
      call,
      price: {
        trusted: price.trusted,
        potBefore: price.potBefore,
        requiredEquity: round6(price.requiredEquity),
        requiredMdf: round6(price.requiredMdf),
      },
      equity: round6(equity),
      margin: round6(facingBetMargin(equity, samples)),
      villainModel: facingVillainModel(view, price.potBefore, call, P2),
      villainCombos: villainRange.combos?.length ?? 0,
      samples,
    };
  } else {
    // `overbetRoll` is fixed at 0 on purpose: the reconstruction cannot consume
    // the production draw. The trace records the real one.
    const sizingCtx = {
      spr: sprOf(view),
      inPosition,
      rangeAdvantage: adv,
      overbetRoll: 0,
      maxOverbetFrequency: PARAMS.maxOverbetFrequency,
    };
    const fraction = chooseBetFraction(texture, sizingCtx); // street-less => river grid
    recon.checkedTo = {
      reconstructedWithOverbetRollZero: true,
      valueBetProbability: round6(valueBetProbability(PARAMS, adv)),
      betFraction: fraction,
      bluffBetProbability: round6(
        bluffBetProbability(
          PARAMS,
          fraction,
          adv,
          blocker,
          active >= 2 ? PARAMS.multiwayBluffScale : 1,
          exploitMultiplierOf(view),
        ),
      ),
    };
  }
  return recon;
}

// --- scenario catalogue -----------------------------------------------------

const BOARDS: Record<'dry' | 'twoTone' | 'monotone' | 'dry4' | 'dry5', CardId[]> = {
  dry: [c('Ks'), c('7d'), c('2c')],
  twoTone: [c('9h'), c('8h'), c('2c')],
  monotone: [c('8s'), c('6s'), c('2s')],
  dry4: [c('Ks'), c('7d'), c('2c'), c('4h')],
  dry5: [c('Ks'), c('7d'), c('2c'), c('4h'), c('9s')],
};

interface Scenario {
  key: string;
  node: 'checkedTo' | 'facingBet';
  board: CardId[];
  hole: CardId[];
  call?: number;
  opponents?: number;
  stats?: StatsKind;
  heroAggressor?: boolean;
}

function buildScenarios(): Scenario[] {
  return [
    // --- checkedTo (hero can check or bet) --------------------------------
    { key: 'checkedTo/flop-dry-AA/value', node: 'checkedTo', board: BOARDS.dry, hole: [c('Ac'), c('Ad')] },
    { key: 'checkedTo/flop-dry-set77/value', node: 'checkedTo', board: BOARDS.dry, hole: [c('7h'), c('7s')] },
    { key: 'checkedTo/flop-dry-83o/air', node: 'checkedTo', board: BOARDS.dry, hole: [c('8d'), c('3c')] },
    {
      key: 'checkedTo/flop-twoTone-JTh/combo-draw',
      node: 'checkedTo',
      board: BOARDS.twoTone,
      hole: [c('Jh'), c('Th')],
    },
    {
      key: 'checkedTo/flop-monotone-AA/exposed-overpair',
      node: 'checkedTo',
      board: BOARDS.monotone,
      hole: [c('Ah'), c('Ad')],
    },
    {
      key: 'checkedTo/turn-dry-AA/aggressor-overbet',
      node: 'checkedTo',
      board: BOARDS.dry4,
      hole: [c('Ac'), c('Ad')],
      heroAggressor: true,
    },
    {
      key: 'checkedTo/river-dry-AA/aggressor-overbet',
      node: 'checkedTo',
      board: BOARDS.dry5,
      hole: [c('Ac'), c('Ad')],
      heroAggressor: true,
    },
    {
      key: 'checkedTo/turn-twoTone-JTh/combo-draw',
      node: 'checkedTo',
      board: [c('9h'), c('8h'), c('2c'), c('4d')],
      hole: [c('Jh'), c('Th')],
    },
    {
      key: 'checkedTo/flop-twoTone-JTh/draw-multiway',
      node: 'checkedTo',
      board: BOARDS.twoTone,
      hole: [c('Jh'), c('Th')],
      opponents: 2,
    },
    // --- facingBet --------------------------------------------------------
    { key: 'facingBet/flop-dry-KQ/half-pot', node: 'facingBet', board: BOARDS.dry, hole: [c('Kd'), c('Qh')], call: 50 },
    { key: 'facingBet/flop-dry-83o/half-pot', node: 'facingBet', board: BOARDS.dry, hole: [c('8d'), c('3c')], call: 50 },
    {
      key: 'facingBet/flop-twoTone-JTh/combo-draw',
      node: 'facingBet',
      board: BOARDS.twoTone,
      hole: [c('Jh'), c('Th')],
      call: 50,
    },
    {
      key: 'facingBet/flop-monotone-AA/half-pot',
      node: 'facingBet',
      board: BOARDS.monotone,
      hole: [c('Ah'), c('Ad')],
      call: 50,
    },
    {
      key: 'facingBet/turn-dry-AA/half-pot',
      node: 'facingBet',
      board: BOARDS.dry4,
      hole: [c('Ac'), c('Ad')],
      call: 50,
    },
    {
      key: 'facingBet/river-dry-KQ/half-pot',
      node: 'facingBet',
      board: BOARDS.dry5,
      hole: [c('Kd'), c('Qh')],
      call: 50,
    },
    {
      key: 'facingBet/flop-dry-83o/half-pot-station',
      node: 'facingBet',
      board: BOARDS.dry,
      hole: [c('8d'), c('3c')],
      call: 50,
      stats: 'station',
    },
  ];
}

// --- runner -----------------------------------------------------------------

interface ScenarioRun {
  key: string;
  node: 'checkedTo' | 'facingBet';
  view: DecisionView;
  action: { type: string; amount?: number };
  reason: string;
  trace: PostflopTrace;
  reconstructed: Recon;
}

function runScenario(scenario: Scenario): ScenarioRun {
  const view =
    scenario.node === 'facingBet'
      ? facingView(scenario.hole, scenario.board, scenario.call ?? 50, scenario)
      : checkedToView(scenario.hole, scenario.board, scenario);

  let captured: PostflopTrace | undefined;
  const policy = new PostflopPolicy({
    params: PARAMS,
    seed: SEED,
    p2: P2,
    onTrace: (trace) => {
      captured = trace;
    },
  });
  const decision = policy.decide(view);
  if (!captured) throw new Error(`no trace emitted for ${scenario.key}`);
  const action: { type: string; amount?: number } =
    decision.action.type === 'bet' || decision.action.type === 'raise'
      ? { type: decision.action.type, amount: decision.action.amount }
      : { type: decision.action.type };

  return {
    key: scenario.key,
    node: scenario.node,
    view,
    action,
    reason: decision.reason,
    trace: captured,
    reconstructed: reconstruct(view, scenario.node),
  };
}

// --- snapshot ---------------------------------------------------------------

interface SnapshotScenario {
  node: 'checkedTo' | 'facingBet';
  action: { type: string; amount?: number };
  reason: string;
  /** Values read from the live decision via `onTrace` (NOT reconstructed). */
  trace: PostflopTrace;
  /** Values rebuilt from exported helpers, exactly as the signal snapshot does. */
  reconstructed: Recon;
}

interface Snapshot {
  meta: {
    params: string;
    seed: number;
    p2: P2Options;
    note: string;
  };
  scenarios: Record<string, SnapshotScenario>;
  blindSpots: {
    covered: string[];
    stillUncovered: string[];
  };
}

const BLIND_SPOTS: Snapshot['blindSpots'] = {
  covered: [
    'real overbetRoll actually drawn in SizingContext (not the fixed 0 reference)',
    'real valueBet probability actually used, INCLUDING the exposedOverpair 0.6 discount that the reconstruction records unmasked',
    'the real bet fraction after the street-specific grid snap (the reconstruction is street-less and reads the river grid)',
    'intermediate booleans value / bluffCandidate / defend / strong and the exposedOverpair / madeHandSuppressed flags as computed',
    'selected branch (value-bet / bluff-bet / check / fold / call / value-raise / semibluff-raise)',
    'final sizing amount + all-in flag',
    'real equity / villain model / villain combos / price margin used facing a bet',
  ],
  stillUncovered: [
    'lastPreflopRaiserSeat / heroIsIPToOpener (preflop sizing only; not on the postflop path) - covered by rulePolicy.test.ts unit tests + preflop telemetry, not by this postflop trace',
    'difficultyPolicy.medium forced routing - covered by difficultyPolicy.test.ts, not by this postflop trace',
    'the engine-wide preflop decision trace (exists separately as onPreflopDecision)',
  ],
};

function serialise(run: ScenarioRun): SnapshotScenario {
  const { key: _key, view: _view, ...rest } = run;
  return rest;
}

function buildSnapshot(): Snapshot {
  const scenarios: Record<string, SnapshotScenario> = {};
  for (const scenario of buildScenarios()) {
    scenarios[scenario.key] = serialise(runScenario(scenario));
  }
  return {
    meta: {
      params: 'constrained-random',
      seed: SEED,
      p2: P2,
      note:
        'Live PostflopPolicy.decide() internal state (via onTrace) PLUS the ' +
        'exported-helper reconstruction, frozen side by side. Do not edit by ' +
        'hand; regenerate with UPDATE_SNAPSHOTS=1. Cross-assertions in ' +
        'postflopTrace.test.ts must hold for every entry.',
    },
    scenarios: Object.fromEntries(
      Object.keys(scenarios)
        .sort()
        .map((k) => [k, scenarios[k]!]),
    ),
    blindSpots: BLIND_SPOTS,
  };
}

// --- cross-assertions -------------------------------------------------------

function assertTraceMatchesReconstruction(run: ScenarioRun): void {
  const { trace, reconstructed: r, key } = run;

  // Hand evaluation + percentile: the real trace must equal the reconstruction.
  expect(trace.hand.category, key).toBe(r.hand.category);
  expect(trace.hand.flushDraw, key).toBe(r.hand.flushDraw);
  expect(trace.hand.straightDraw, key).toBe(r.hand.straightDraw);
  expect(trace.hand.overcards, key).toBe(r.hand.overcards);
  expect(round6(trace.hand.percentile), key).toBe(r.hand.percentile);
  expect(trace.texture, key).toEqual(r.texture);

  // Position / aggression / table reads.
  expect(trace.context.inPosition, key).toBe(r.position.inPosition);
  expect(trace.context.wasAggressor, key).toBe(r.position.wasAggressor);
  expect(round6(trace.context.spr), key).toBe(r.spr);
  expect(round6(trace.context.rangeAdvantage), key).toBe(r.rangeAdvantage);
  expect(round6(trace.context.exploitMultiplier), key).toBe(r.exploitMultiplier);
  expect(trace.opponentModel, key).toEqual(r.opponents.model);
  expect(trace.context.activeOpponents, key).toBe(r.opponents.count);

  // Derived flags.
  if (trace.blocker !== null) expect(round6(trace.blocker), key).toBe(r.blocker);
  expect(trace.madeHandSuppressed, key).toBe(r.madeHandSuppressed);
  expect(trace.exposedOverpair, key).toBe(r.exposedOverpair);

  if (trace.node === 'facingBet') {
    expect(trace.facing, key).not.toBeNull();
    const f = trace.facing!;
    expect(f.priceTrusted, key).toBe(r.facing!.price.trusted);
    expect(round6(f.potBefore), key).toBe(round6(r.facing!.price.potBefore));
    expect(round6(f.requiredEquity), key).toBe(r.facing!.price.requiredEquity);
    expect(round6(f.requiredMdf), key).toBe(r.facing!.price.requiredMdf);
    // The whole point: the REAL internal equity estimate equals the
    // reconstruction that calls the same exported helpers.
    expect(round6(f.equity), key).toBe(r.facing!.equity);
    expect(round6(f.margin), key).toBe(r.facing!.margin);
    expect(f.samples, key).toBe(r.facing!.samples);
    expect(f.villainModel, key).toBe(r.facing!.villainModel);
    expect(f.villainCombos, key).toBe(r.facing!.villainCombos);
  } else if (trace.node === 'unopened') {
    expect(trace.facing, key).toBeNull();
    // Divergence 1: the real value-bet threshold carries the exposedOverpair
    // 0.6 discount; the reconstruction records the raw probability.
    if (trace.probabilities.valueBet !== null) {
      expect(round6(trace.probabilities.valueBet), key).toBe(
        round6(r.checkedTo!.valueBetProbability * (trace.exposedOverpair ? 0.6 : 1)),
      );
    }
    // Divergence 2: the real overbetRoll is an actual seeded draw, not the
    // fixed 0 reference the reconstruction is forced to use.
    if (trace.sizing) {
      const roll = trace.rng.overbetRoll;
      expect(roll, key).not.toBeNull();
      expect(roll!, key).toBeGreaterThanOrEqual(0);
      expect(roll!, key).toBeLessThan(1);
      // Divergence 3: the real fraction is snapped on the street's own grid.
      if (trace.sizing.fraction !== null) {
        expect(trace.sizing.fraction, key).toBe(
          chooseBetFraction(
            trace.texture,
            {
              spr: trace.context.spr,
              inPosition: trace.context.inPosition,
              rangeAdvantage: trace.context.rangeAdvantage,
              overbetRoll: roll!,
              maxOverbetFrequency: trace.sizing.maxOverbetFrequency,
            },
            trace.street,
          ),
        );
      }
    }
  }
}

// --- tests ------------------------------------------------------------------

describe('postflop decision trace snapshot (internal-state baseline)', () => {
  it('covers both nodes, all three streets and a texture mix', () => {
    const scenarios = buildScenarios();
    const keys = new Set(scenarios.map((s) => s.key));
    expect(keys.size).toBe(scenarios.length);
    expect(scenarios.some((s) => s.node === 'checkedTo')).toBe(true);
    expect(scenarios.some((s) => s.node === 'facingBet')).toBe(true);
    const streets = new Set(scenarios.map((s) => s.board.length));
    expect(streets.has(3)).toBe(true); // flop
    expect(streets.has(4)).toBe(true); // turn
    expect(streets.has(5)).toBe(true); // river
  });

  it('trace records a branch and the real seeded draws for every scenario', () => {
    for (const scenario of buildScenarios()) {
      const run = runScenario(scenario);
      expect(run.trace.branch.length, scenario.key).toBeGreaterThan(0);
      expect(run.trace.action.type, scenario.key).toBe(run.action.type);
      // The overbetRoll is always drawn on a bet-capable node.
      if (run.trace.sizing) {
        expect(run.trace.rng.overbetRoll, scenario.key).not.toBeNull();
      }
    }
  });

  it('cross-asserts trace values against the exported-helper reconstruction', () => {
    for (const scenario of buildScenarios()) {
      assertTraceMatchesReconstruction(runScenario(scenario));
    }
  });

  it('exposes divergences the reconstruction cannot reproduce', () => {
    const runs = buildScenarios().map(runScenario);

    // At least one real overbetRoll differs from the reconstruction's fixed 0.
    const rolls = runs.map((r) => r.trace.rng.overbetRoll).filter((v): v is number => v !== null);
    expect(rolls.length).toBeGreaterThan(0);
    expect(rolls.some((v) => v !== 0)).toBe(true);

    // At least one flop unopened bet snaps to the flop grid (0.33) while the
    // street-less reconstruction reads the river grid (0.5).
    const flopBets = runs.filter(
      (r) =>
        r.trace.node === 'unopened' &&
        r.trace.street === 'flop' &&
        r.trace.sizing?.fraction !== null &&
        r.trace.sizing?.fraction !== undefined,
    );
    expect(flopBets.length).toBeGreaterThan(0);
    const divergent = flopBets.filter(
      (r) => r.trace.sizing!.fraction !== r.reconstructed.checkedTo!.betFraction,
    );
    expect(divergent.length).toBeGreaterThan(0);

    // The masked value probability is observed, not the raw helper output.
    const masked = runs.filter(
      (r) =>
        r.trace.exposedOverpair &&
        r.trace.probabilities.valueBet !== null &&
        r.reconstructed.checkedTo,
    );
    for (const r of masked) {
      expect(round6(r.trace.probabilities.valueBet!)).toBe(
        round6(r.reconstructed.checkedTo!.valueBetProbability * 0.6),
      );
    }
  });

  it('a throwing onTrace sink never changes the decision (fail-open)', () => {
    for (const scenario of buildScenarios()) {
      const view =
        scenario.node === 'facingBet'
          ? facingView(scenario.hole, scenario.board, scenario.call ?? 50, scenario)
          : checkedToView(scenario.hole, scenario.board, scenario);
      const silent = new PostflopPolicy({ params: PARAMS, seed: SEED, p2: P2 }).decide(view);
      const noisy = new PostflopPolicy({
        params: PARAMS,
        seed: SEED,
        p2: P2,
        onTrace: () => {
          throw new Error('sink exploded');
        },
      }).decide(view);
      expect(noisy.action, scenario.key).toEqual(silent.action);
      expect(noisy.reason, scenario.key).toBe(silent.reason);
    }
  });

  it('is deterministic: two independent builds are byte-identical', () => {
    const a = JSON.stringify(buildSnapshot());
    const b = JSON.stringify(buildSnapshot());
    expect(a).toBe(b);
  });

  it('matches the committed snapshot', () => {
    const actual = `${JSON.stringify(buildSnapshot(), null, 2)}\n`;
    if (UPDATE) {
      mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
      writeFileSync(SNAPSHOT_PATH, actual);
      return;
    }
    expect(actual).toBe(readFileSync(SNAPSHOT_PATH, 'utf8'));
  });
});
