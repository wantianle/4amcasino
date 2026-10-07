// Bet-sizing snapshot generator (added 2026-10-07 for the `omos/bet-sizes` lane
// audit; committed so the snapshot stays reproducible and auditable — the
// audit's original /tmp dump alone did not meet that bar).
//
// Baseline for the audit diff: committed HEAD `d01bd4d` — the pre-change
// `postflopPolicy.ts`. The engine under test is whatever working tree this runs
// against. Audit config: preset `tight-aggressive`, seed 7, 10,000-chip stacks,
// 100 bb. The audit's residual 140 decision diffs (32 plain-bet / 2
// overbet-bet / 86 plain-raise / 19 overbet-raise / 1 bluff bet->check) were
// classified by parsing its `after` dump; the corpus below drives the same
// decision paths.
//
// Run (never writes a committed fixture by default):
//   npx tsx packages/agent-core/test/tools/betSizingSnapshot.ts
//   npx tsx packages/agent-core/test/tools/betSizingSnapshot.ts --out /tmp/snap.json
//
// Import `buildBetSizingCorpus()` for the deterministic view corpus. This tool
// must NOT be used to mint the official snapshot while `bet-sizes` and
// `strategy-layer1` are still separate: regenerate it on the integrated code.

import { cardFromName, type CardId } from '@4am/shared';
import { writeFileSync } from 'node:fs';
import type {
  DecisionHand,
  DecisionLegalActions,
  DecisionSeat,
  DecisionView,
  PublicAction,
} from '../../src/decisionView.js';
import { mulberry32 } from '../../src/equity.js';
import { deriveRulesSeed } from '../../src/rulesSeed.js';
import { PostflopPolicy } from '../../src/postflopPolicy.js';
import { RULE_PRESETS } from '../../src/ruleStyles.js';

const c = (n: string): CardId => cardFromName(n);

/** Fixed audit configuration. Changing any field invalidates prior snapshots. */
export const SNAPSHOT_CONFIG = {
  baselineRef: 'd01bd4d',
  preset: 'tight-aggressive',
  seed: 7,
  stack: 10_000,
  bb: 100,
  sb: 50,
} as const;

type GridStreet = 'flop' | 'turn' | 'river';
export const STREETS: readonly GridStreet[] = ['flop', 'turn', 'river'];

/** Six texture archetypes (3-card flops). */
export const BOARDS: Readonly<Record<string, readonly CardId[]>> = {
  dryRainbow: [c('Jh'), c('7d'), c('2c')],
  dryKingHigh: [c('Kd'), c('7h'), c('2c')],
  wetConnected: [c('Th'), c('9h'), c('8h')],
  monotone: [c('Ks'), c('Js'), c('9s')],
  paired: [c('8c'), c('8d'), c('3h')],
  lowConnected: [c('6c'), c('5d'), c('4h')],
};

/** Six hand archetypes; some intentionally collide with a board (malformed). */
export const HOLES: Readonly<Record<string, readonly CardId[]>> = {
  overpair: [c('Ah'), c('Ad')],
  topPair: [c('Kd'), c('Qc')],
  set: [c('2d'), c('2s')],
  flushDraw: [c('Ah'), c('Kh')],
  straightDraw: [c('Qd'), c('Jc')],
  air: [c('9c'), c('4d')],
};

/** Extra cards used to extend a flop into a turn / river, first non-colliding. */
const EXTRA = [c('Qs'), c('Tc'), c('3d'), c('6s'), c('Jd'), c('4s')];

/** Fixed action scenarios: unopened pots and observed bets as pot fractions. */
export const SCENARIOS: readonly { tag: string; potBase: number; frac: number | null }[] = [
  { tag: 'unopened-small', potBase: 60, frac: null },
  { tag: 'unopened-big', potBase: 300, frac: null },
  { tag: 'facing-half', potBase: 100, frac: 0.5 },
  { tag: 'facing-overbet', potBase: 100, frac: 1.25 },
];

/** One corpus entry; `malformed` flags a hole/board card collision. */
export interface CorpusEntry {
  id: string;
  tag: string;
  street: GridStreet;
  malformed: boolean;
  view: DecisionView;
}

export interface Corpus {
  legal: CorpusEntry[];
  malformed: CorpusEntry[];
}

function extendBoard(flop: readonly CardId[], street: GridStreet): CardId[] {
  const board = [...flop];
  while (board.length < (street === 'flop' ? 3 : street === 'turn' ? 4 : 5)) {
    const next = EXTRA.find((card) => !board.includes(card));
    if (next === undefined) throw new Error('ran out of extension cards');
    board.push(next);
  }
  return board;
}

function overlaps(hole: readonly CardId[], board: readonly CardId[]): boolean {
  return hole.some((card) => board.includes(card));
}

function makeSeat(seat: number, over: Partial<DecisionSeat> = {}): DecisionSeat {
  return {
    seat,
    userId: seat + 1,
    displayName: `s${seat}`,
    isMe: false,
    stack: SNAPSHOT_CONFIG.stack,
    committed: 0,
    total: 0,
    folded: false,
    allIn: false,
    sittingOut: false,
    connected: true,
    ...over,
  };
}

function preflopRaise(seat: number, amount: number, actionSeq: number): PublicAction {
  return {
    actionSeq,
    street: 'preflop',
    seat,
    action: { type: 'raise', amount },
    auto: false,
    ts: 0,
  };
}

/** Build one HU view: seat 0 is the button/SB, seat 1 the BB. */
function huView(opts: {
  heroSeat: 0 | 1;
  hole: readonly CardId[];
  board: readonly CardId[];
  street: GridStreet;
  pot: number;
  call: number;
  actionSeq: number;
  actionHistory?: PublicAction[];
}): DecisionView {
  const { heroSeat, hole, board, street, pot, call } = opts;
  const villainSeat = heroSeat === 0 ? 1 : 0;
  const facing = call > 0;
  const legalActions: DecisionLegalActions = facing
    ? {
        canCheck: false,
        canCall: true,
        callAmount: call,
        canBet: false,
        canRaise: true,
        minRaiseTo: call * 2,
        maxRaiseTo: SNAPSHOT_CONFIG.stack,
      }
    : {
        canCheck: true,
        canCall: false,
        callAmount: 0,
        canBet: true,
        canRaise: true,
        minRaiseTo: SNAPSHOT_CONFIG.bb,
        maxRaiseTo: SNAPSHOT_CONFIG.stack,
      };
  const hand: DecisionHand = {
    handId: 'snap',
    street,
    buttonSeat: 0,
    board: [...board],
    pot,
    currentBet: call,
    toAct: heroSeat,
    deadline: null,
    myCards: [...hole],
    mySeat: heroSeat,
  };
  const hero = makeSeat(heroSeat, {
    userId: 1,
    isMe: true,
    committed: heroSeat === 1 ? SNAPSHOT_CONFIG.bb : 0,
    total: heroSeat === 1 ? SNAPSHOT_CONFIG.bb : 0,
  });
  const villain = makeSeat(villainSeat, {
    committed: call || (villainSeat === 1 ? SNAPSHOT_CONFIG.bb : 0),
    total: call || (villainSeat === 1 ? SNAPSHOT_CONFIG.bb : 0),
  });
  return {
    room: {
      id: 'snap',
      name: 'snap',
      sb: SNAPSHOT_CONFIG.sb,
      bb: SNAPSHOT_CONFIG.bb,
      minSettleHands: 0,
      sevenDeuceBonus: 0,
    },
    hand,
    me: hero,
    legalActions,
    potOdds: facing
      ? {
          callAmount: call,
          pot: pot + call,
          potOdds: call / (pot + call),
          breakEvenEquity: call / (pot + call),
        }
      : { callAmount: 0, pot, potOdds: 0, breakEvenEquity: 0 },
    actionHistory: opts.actionHistory ?? [],
    opponents: [villain],
    sessionMemory: { handsObserved: 0, netChips: null, recentHands: [], opponents: [] },
    historyComplete: true,
    seatOrder: [0, 1],
    actionSeq: opts.actionSeq,
  };
}

/**
 * HU flop/turn/river views over every board x hole x scenario, for **both**
 * hero seats (button and BB), so IP and OOP are represented. Hole/board card
 * collisions are returned under `malformed`, never silently mixed into `legal`.
 */
function baseCorpus(): Corpus {
  const legal: CorpusEntry[] = [];
  const malformed: CorpusEntry[] = [];
  for (const street of STREETS) {
    for (const [boardName, flop] of Object.entries(BOARDS)) {
      const board = extendBoard(flop, street);
      for (const [holeName, hole] of Object.entries(HOLES)) {
        for (const sc of SCENARIOS) {
          for (const heroSeat of [0, 1] as const) {
            const call = sc.frac === null ? 0 : Math.round(sc.potBase * sc.frac);
            const id = `${street}:${boardName}:${holeName}:${sc.tag}:hero${heroSeat}`;
            const view = huView({
              heroSeat,
              hole,
              board,
              street,
              pot: sc.potBase,
              call,
              actionSeq: 0,
            });
            const entry: CorpusEntry = {
              id,
              tag: sc.frac === null ? 'unopened' : 'facing',
              street,
              malformed: overlaps(hole, board),
              view,
            };
            (entry.malformed ? malformed : legal).push(entry);
          }
        }
      }
    }
  }
  return { legal, malformed };
}

/**
 * A value hand on a dry board where hero raised preflop and is in position, so
 * `rangeAdvantage >= 0.4` and `spr >= 4` hold. `actionSeq` is scanned for the
 * first roll that lands under `maxOverbetFrequency`, forcing the turn/river
 * overbet branch that the base corpus does not reach. These are the "specially
 * constructed" overbet probes.
 */
function overbetProbes(): CorpusEntry[] {
  const maxFreq = RULE_PRESETS[SNAPSHOT_CONFIG.preset].maxOverbetFrequency;
  const probes: CorpusEntry[] = [];
  for (const street of ['turn', 'river'] as const) {
    const board = extendBoard(BOARDS.dryKingHigh!, street);
    const hole = HOLES.overpair!;
    for (let seq = 0; seq < 1000; seq++) {
      const view = huView({
        heroSeat: 0,
        hole,
        board,
        street,
        pot: 600,
        call: 0,
        actionSeq: seq,
        actionHistory: [preflopRaise(0, 300, 0)],
      });
      const roll = mulberry32(deriveRulesSeed(SNAPSHOT_CONFIG.seed, view))();
      if (roll < maxFreq) {
        probes.push({
          id: `overbet-probe:${street}:seq${seq}`,
          tag: 'overbet-probe',
          street,
          malformed: false,
          view,
        });
        break;
      }
    }
  }
  return probes;
}

/** Deterministic corpus: legal and malformed inputs kept strictly separate. */
export function buildBetSizingCorpus(): Corpus {
  const base = baseCorpus();
  const probes = overbetProbes();
  return { legal: [...base.legal, ...probes], malformed: base.malformed };
}

export interface SnapshotRow {
  id: string;
  tag: string;
  street: GridStreet;
  malformed: boolean;
  decision: ReturnType<PostflopPolicy['decide']>;
}

/** Decide every corpus view with the current engine. */
export function runSnapshot(corpus: Corpus = buildBetSizingCorpus()): {
  config: typeof SNAPSHOT_CONFIG;
  corpus: { legal: number; malformed: number };
  rows: SnapshotRow[];
} {
  const policy = new PostflopPolicy({
    params: RULE_PRESETS[SNAPSHOT_CONFIG.preset],
    seed: SNAPSHOT_CONFIG.seed,
  });
  const rows: SnapshotRow[] = [...corpus.legal, ...corpus.malformed].map((entry) => ({
    id: entry.id,
    tag: entry.tag,
    street: entry.street,
    malformed: entry.malformed,
    decision: policy.decide(entry.view),
  }));
  return {
    config: SNAPSHOT_CONFIG,
    corpus: { legal: corpus.legal.length, malformed: corpus.malformed.length },
    rows,
  };
}

function main(): void {
  const outIdx = process.argv.indexOf('--out');
  const out = outIdx >= 0 ? process.argv[outIdx + 1] : null;
  const result = runSnapshot();
  const json = JSON.stringify(result, null, 2);
  if (out) {
    process.stdout.write(`writing ${result.rows.length} rows to ${out}\n`);
    writeFileSync(out, json);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

const isMain = process.argv[1] !== undefined;
if (isMain && process.argv[1]!.endsWith('betSizingSnapshot.ts')) main();
