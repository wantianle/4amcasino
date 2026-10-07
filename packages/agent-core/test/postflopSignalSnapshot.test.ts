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
  facingBetSamples,
  facingVillainModel,
  facingVillainRange,
  handBucket,
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
} from '../src/postflopPolicy.js';
import { estimateEquity } from '../src/equity.js';
import { deriveRulesSeed } from '../src/rulesSeed.js';
import { RULE_PRESETS } from '../src/ruleStyles.js';

/**
 * Postflop decision-signal snapshot (phase 0 of the "A plan").
 *
 * `PostflopPolicy.decide()` is a monolith whose only outward signal is
 * `{ action, reason }`. This file pins, for a fixed matrix of scenarios, BOTH:
 *
 *   1. the final action (type + amount + reason) the engine returns, exactly as
 *      it would in production (`new PostflopPolicy({ params, seed, p2 })`), and
 *   2. every decision-relevant signal that can be *reconstructed* from the
 *      module's exported pure helpers: hand evaluation, 24-bucket class, board
 *      texture, position, aggressor flag, opponent model, blocker score,
 *      board-suppression, exposed-overpair, range advantage, SPR, the facing-bet
 *      price, the reconstructed equity estimate and the villain range size.
 *
 * It deliberately does NOT change `PostflopPolicy`'s signature. What still
 * cannot be observed is recorded in `cannotObserve` below: the current API does
 * not expose the real decision-time RNG draw trace (so the snapshot alone cannot
 * PROVE the recomputation consumed the same draws), nor the intermediate
 * booleans the reason string only hints at. Exposing those is phase 5 (a
 * first-class decision trace).
 *
 * Regenerate with: `UPDATE_SNAPSHOTS=1 npx vitest run packages/agent-core/test/postflopSignalSnapshot.test.ts`
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = join(HERE, 'fixtures', 'postflopSignalSnapshot.snapshot.json');
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';

const c = (n: string) => cardFromName(n);
const SEED = 0x9e3779b9;
const PARAMS = { ...RULE_PRESETS['constrained-random'], adaptivePreflop: true };
const P2: P2Options = { ...DEFAULT_P2 };

// --- view builders ---------------------------------------------------------

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
    handId: 'snap-h1',
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

/** One opponent per `seat`, all with a usable (>=10 hand) sample if stats given. */
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

/** Hero (seat 0, in position) is checked to: can check or bet. */
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

/** Hero (seat 0) faces a bet of `call` into a pot whose total (after the bet) is `pot`. */
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

// --- signal reconstruction ------------------------------------------------

/**
 * Private `PostflopPolicy.spr` reproduced from the public view. Exact.
 * (Documented as reconstructed, not observed: the method is private.)
 */
function sprOf(view: DecisionView): number {
  const pot = view.potOdds?.pot ?? 0;
  if (pot <= 0) return 10;
  const myStack = view.me?.stack ?? 0;
  const activeStacks = view.opponents.filter((o) => !o.folded && !o.allIn).map((o) => o.stack);
  const oppMax = activeStacks.length ? Math.max(...activeStacks) : 0;
  const effective = oppMax > 0 ? Math.min(myStack, oppMax) : myStack;
  return effective / pot;
}

/**
 * Private `PostflopPolicy.exploitMultiplier` reproduced from public opponent
 * stats. Exact, given the same `sessionMemory`.
 */
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

interface Signals {
  hand: {
    category: number;
    flushDraw: boolean;
    straightDraw: number;
    overcards: number;
    percentile: number;
    madeBucket: string;
    drawBucket: string;
    bucketId: string;
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
    price: {
      trusted: boolean;
      potBefore: number;
      requiredEquity: number;
      requiredMdf: number;
    };
    equity: number;
    villainModel: string;
    villainCombos: number;
    samples: number;
  };
  checkedTo?: {
    /**
     * Always `true`: these probabilities were recomputed with `overbetRoll: 0`,
     * a fixed reference, not the production RNG draw. The flag makes that
     * explicit at the point of use.
     */
    reconstructedWithOverbetRollZero: true;
    valueBetProbability: number;
    betFraction: number;
    bluffBetProbability: number;
  };
}

function reconstructSignals(view: DecisionView, node: 'checkedTo' | 'facingBet'): Signals {
  const hole = view.hand?.myCards ?? [];
  const board = view.hand?.board ?? [];
  const ev = evaluateHand(hole, board);
  const bucket = handBucket(hole, board);
  const texture = classifyTexture(board);
  const inPosition = heroInPosition(view);
  const wasAggressor = heroWasAggressor(view);
  const adv = rangeAdvantage({ heroWasAggressor: wasAggressor, inPosition, texture });
  const opponentList = view.opponents.filter((o) => !o.folded);
  const active = Math.max(1, opponentList.length);
  const blocker = blockerScore(hole, board);

  const signals: Signals = {
    hand: {
      category: ev.category,
      flushDraw: ev.flushDraw,
      straightDraw: ev.straightDraw,
      overcards: ev.overcards,
      percentile: round6(handPercentile(hole, board)),
      madeBucket: bucket.made,
      drawBucket: bucket.draw,
      bucketId: bucket.id,
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
    signals.facing = {
      call,
      price: {
        trusted: price.trusted,
        potBefore: price.potBefore,
        requiredEquity: round6(price.requiredEquity),
        requiredMdf: round6(price.requiredMdf),
      },
      equity: round6(equity),
      villainModel: facingVillainModel(view, price.potBefore, call, P2),
      villainCombos: villainRange.combos?.length ?? 0,
      samples,
    };
  } else {
    // `overbetRoll` is NOT the production draw: it is a fixed 0 reference used
    // only to recompute `chooseBetFraction`/bluff probabilities outside the
    // policy. The real decision consumes an RNG roll we cannot observe (see
    // `cannotObserve`), so `checkedTo` signals below are explicitly tagged
    // `reconstructedWithOverbetRollZero`.
    const sizingCtx = {
      spr: sprOf(view),
      inPosition,
      rangeAdvantage: adv,
      overbetRoll: 0,
      maxOverbetFrequency: PARAMS.maxOverbetFrequency,
    };
    const fraction = chooseBetFraction(texture, sizingCtx);
    signals.checkedTo = {
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
  return signals;
}

// --- scenario catalogue ----------------------------------------------------

const BOARDS: Record<'dry' | 'twoTone' | 'monotone' | 'paired', CardId[]> = {
  dry: [c('Ks'), c('7d'), c('2c')],
  twoTone: [c('9h'), c('8h'), c('2c')],
  monotone: [c('8s'), c('6s'), c('2s')],
  paired: [c('Kc'), c('Kd'), c('7s')],
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
    { key: 'checkedTo/dry-AA/value', node: 'checkedTo', board: BOARDS.dry, hole: [c('Ac'), c('Ad')] },
    { key: 'checkedTo/dry-set77/value', node: 'checkedTo', board: BOARDS.dry, hole: [c('7h'), c('7s')] },
    { key: 'checkedTo/dry-KQ-top-pair', node: 'checkedTo', board: BOARDS.dry, hole: [c('Kd'), c('Qh')] },
    { key: 'checkedTo/dry-83o/air', node: 'checkedTo', board: BOARDS.dry, hole: [c('8d'), c('3c')] },
    {
      key: 'checkedTo/twoTone-JTh/combo-draw',
      node: 'checkedTo',
      board: BOARDS.twoTone,
      hole: [c('Jh'), c('Th')],
    },
    {
      key: 'checkedTo/monotone-AA-no-suit/exposed-overpair',
      node: 'checkedTo',
      board: BOARDS.monotone,
      hole: [c('Ah'), c('Ad')],
    },
    {
      key: 'checkedTo/twoTone-JTh/draw-station',
      node: 'checkedTo',
      board: BOARDS.twoTone,
      hole: [c('Jh'), c('Th')],
      stats: 'station',
    },
    {
      key: 'checkedTo/twoTone-JTh/draw-nit',
      node: 'checkedTo',
      board: BOARDS.twoTone,
      hole: [c('Jh'), c('Th')],
      stats: 'nit',
    },
    {
      key: 'checkedTo/twoTone-JTh/draw-multiway',
      node: 'checkedTo',
      board: BOARDS.twoTone,
      hole: [c('Jh'), c('Th')],
      opponents: 2,
    },
    {
      key: 'checkedTo/dry-AA/as-preflop-aggressor',
      node: 'checkedTo',
      board: BOARDS.dry,
      hole: [c('Ac'), c('Ad')],
      heroAggressor: true,
    },
    // --- facingBet --------------------------------------------------------
    { key: 'facingBet/dry-KQ/half-pot', node: 'facingBet', board: BOARDS.dry, hole: [c('Kd'), c('Qh')], call: 50 },
    { key: 'facingBet/dry-83o/half-pot', node: 'facingBet', board: BOARDS.dry, hole: [c('8d'), c('3c')], call: 50 },
    {
      key: 'facingBet/twoTone-JTh/combo-draw',
      node: 'facingBet',
      board: BOARDS.twoTone,
      hole: [c('Jh'), c('Th')],
      call: 50,
    },
    { key: 'facingBet/dry-set77/half-pot', node: 'facingBet', board: BOARDS.dry, hole: [c('7h'), c('7s')], call: 50 },
    {
      key: 'facingBet/monotone-AA-no-suit/half-pot',
      node: 'facingBet',
      board: BOARDS.monotone,
      hole: [c('Ah'), c('Ad')],
      call: 50,
    },
    {
      key: 'facingBet/dry-83o/half-pot-station',
      node: 'facingBet',
      board: BOARDS.dry,
      hole: [c('8d'), c('3c')],
      call: 50,
      stats: 'station',
    },
    {
      key: 'facingBet/twoTone-JTh/combo-draw-multiway',
      node: 'facingBet',
      board: BOARDS.twoTone,
      hole: [c('Jh'), c('Th')],
      call: 50,
      opponents: 2,
    },
    {
      key: 'facingBet/paired-KQ/half-pot',
      node: 'facingBet',
      board: BOARDS.paired,
      hole: [c('Kh'), c('Qh')],
      call: 50,
    },
    {
      key: 'facingBet/dry-AA/half-pot-aggressor',
      node: 'facingBet',
      board: BOARDS.dry,
      hole: [c('Ac'), c('Ad')],
      call: 50,
      heroAggressor: true,
    },
  ];
}

// --- snapshot --------------------------------------------------------------

interface ScenarioSnapshot {
  node: 'checkedTo' | 'facingBet';
  action: { type: string; amount?: number };
  reason: string;
  signals: Signals;
}

interface Snapshot {
  meta: {
    params: string;
    seed: number;
    p2: P2Options;
    note: string;
  };
  scenarios: Record<string, ScenarioSnapshot>;
  cannotObserve: {
    summary: string;
    reconstructedNotObserved: string[];
    notReachable: string[];
    toExposeForPhase5: string[];
  };
}

const CANNOT_OBSERVE: Snapshot['cannotObserve'] = {
  summary:
    'PostflopPolicy.decide() returns only { action, reason }. The signals below are reconstructed from exported pure helpers against the same view; they are not read from the live decision. Their agreement with the internal decision is asserted only indirectly (same inputs, same exported functions), never observed.',
  reconstructedNotObserved: [
    'sprOf (private PostflopPolicy.spr) - reproduced from potOdds/me/opponents',
    'exploitMultiplierOf (private PostflopPolicy.exploitMultiplier) - reproduced from sessionMemory',
    'facingBet equity estimate - reproduced by calling the exported estimateEquity/facingVillainRange with the same seed, samples and price',
    'checkedTo value/bluff probabilities - reproduced with exported valueBetProbability/bluffBetProbability; the bluff value uses the reconstructed exploit multiplier, and overbetRoll is a FIXED REFERENCE 0, not a production draw (the tag `reconstructedWithOverbetRollZero` marks every checkedTo signal)',
  ],
  notReachable: [
    'the current API does not expose the real decision-time RNG draw trace (how many mulberry32 rolls decide() consumed and which branch consumed each); from the snapshot alone one cannot PROVE that the recomputation consumed the same draws as the internal path',
    'SizingContext.overbetRoll actually used and whether the overbet branch fired (the recomputation fixes it at 0 as a reference)',
    'the intermediate booleans value / bluffCandidate / defend / priceTrusted / strong / exposedOverpair as the policy computed them (only inferable from the reason string)',
    'the per-branch decision order (which branch was evaluated first and short-circuited)',
  ],
  toExposeForPhase5: [
    'a PostflopTrace return object (or an onTrace option on PostflopOptions) carrying: node, ev, bucket, percentile, texture, inPosition, wasAggressor, opponentModel, blocker, boardSuppressed, exposedOverpair, rangeAdvantage, spr, price, equity estimate, the value/bluff/defend probabilities, and the draw index of each rng() call',
    'the resolved SizingContext (fraction + overbetRoll + allIn) actually used for a bet/raise',
    'an explicit list of considered branches with the threshold each was compared against',
  ],
};

function serialise(snapshot: Snapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

function runScenario(scenario: Scenario): ScenarioSnapshot {
  const view =
    scenario.node === 'facingBet'
      ? facingView(scenario.hole, scenario.board, scenario.call ?? 50, scenario)
      : checkedToView(scenario.hole, scenario.board, scenario);
  const decision = new PostflopPolicy({ params: PARAMS, seed: SEED, p2: P2 }).decide(view);
  const action: { type: string; amount?: number } =
    decision.action.type === 'bet' || decision.action.type === 'raise'
      ? { type: decision.action.type, amount: decision.action.amount }
      : { type: decision.action.type };
  return {
    node: scenario.node,
    action,
    reason: decision.reason,
    signals: reconstructSignals(view, scenario.node),
  };
}

function buildSnapshot(): Snapshot {
  const scenarios: Record<string, ScenarioSnapshot> = {};
  for (const scenario of buildScenarios()) {
    scenarios[scenario.key] = runScenario(scenario);
  }
  return {
    meta: {
      params: 'constrained-random',
      seed: SEED,
      p2: P2,
      note: 'Frozen postflop decision + reconstructed signals. Do not edit by hand; regenerate with UPDATE_SNAPSHOTS=1.',
    },
    scenarios: Object.fromEntries(
      Object.keys(scenarios)
        .sort()
        .map((k) => [k, scenarios[k]!]),
    ),
    cannotObserve: CANNOT_OBSERVE,
  };
}

// --- tests -----------------------------------------------------------------

describe('postflop signal snapshot (regression baseline)', () => {
  it('covers checkedTo/facingBet, HU/multiway, textures and opponent types', () => {
    const scenarios = buildScenarios();
    const keys = new Set(scenarios.map((s) => s.key));
    expect(keys.size).toBe(scenarios.length);
    expect(scenarios.some((s) => s.node === 'checkedTo')).toBe(true);
    expect(scenarios.some((s) => s.node === 'facingBet')).toBe(true);
    expect(scenarios.some((s) => (s.opponents ?? 1) >= 2)).toBe(true);
    expect(scenarios.some((s) => s.stats === 'station')).toBe(true);
    expect(scenarios.some((s) => s.stats === 'nit')).toBe(true);
    expect(scenarios.some((s) => s.heroAggressor === true)).toBe(true);
    // four distinct board textures present across the matrix.
    expect(new Set(scenarios.map((s) => s.board.join(','))).size).toBeGreaterThanOrEqual(3);
  });

  it('records a legal action with a non-empty reason for every scenario', () => {
    const snapshot = buildSnapshot();
    for (const [key, snap] of Object.entries(snapshot.scenarios)) {
      expect(['bet', 'check', 'call', 'fold', 'raise'], key).toContain(snap.action.type);
      expect(snap.reason.length, key).toBeGreaterThan(0);
      if (snap.node === 'facingBet') {
        expect(snap.signals.facing, key).toBeDefined();
        expect(snap.signals.checkedTo, key).toBeUndefined();
      } else {
        expect(snap.signals.checkedTo, key).toBeDefined();
        expect(snap.signals.facing, key).toBeUndefined();
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
    expect(actual).toBe(readFileSync(SNAPSHOT_PATH, 'utf8'));
  });
});
