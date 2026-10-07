#!/usr/bin/env node
/**
 * Preflop self-play harness — reproducible evidence for the Rust vs-open
 * cold-3-bet integration.
 *
 * It plays the actual `choosePreflopIntent` policy against itself with a FIXED
 * SEED and measures one thing: **how often a non-BB player 3-bets when first
 * facing a single open**.
 *
 * Denominator (explicit, this is the contract):
 *   "a non-BB seat acting for the first time in the preflop round, facing
 *    exactly one raise and no intervening caller" — i.e. the `facingOpen` spot.
 *   Once a caller enters the pot the spot becomes `facingOpenMultiway`, and once
 *   a 3-bet goes in it is no longer a single open; both are excluded.
 * Numerator: those decision points where the sampled intent is `raise`.
 * The "all hands" denominator (raise per non-BB player-hand) is also printed.
 *
 * THREE arms, so the delta is properly attributed (this is NOT a Rust-only A/B
 * unless you subtract the middle arm):
 *   legacy              = adaptivePreflop:false  (legacy tables, pre-adaptive)
 *   adaptive, Rust off  = adaptivePreflop:true,  Rust provider disabled
 *   adaptive + Rust     = adaptivePreflop:true,  shipped default
 *
 *   legacy -> "Rust off"   isolates the *adaptive headcount routing* change
 *   "Rust off" -> "+Rust"  isolates the *Rust provider* change
 *
 * The Rust-off arm is produced in a child process that empties the embedded
 * `RUST_VS_OPEN.spots` before running, so the provider maps no spot. Each arm
 * runs in its own process so the module-level mix cache cannot leak between
 * arms. The harness replays the SAME deals in every arm (the deal RNG is
 * seeded independently of the decision RNG).
 *
 * ⚠️ INPUT CAVEAT: this harness replays the same embedded `RUST_VS_OPEN` data
 * as production — the `round3=true` display chart from `charts_rust_gg.json`
 * (proxy leaves + mean-field CFR + finite iterations, approximate EV). It is
 * NOT a GTO baseline: round3 trims actions <= 0.5 %, rounds to 3 decimals, and
 * marks `reach < 1e-4` hands `na`. The numbers below measure behaviour on that
 * approximate data, not a benchmark. Details: the provider header in
 * packages/agent-core/src/preflopCharts/rustVsOpen.ts.
 *
 * Run:
 *   node --import tsx apps/server/scripts/preflop-selfplay.mjs
 *   SEED=123 TRIALS=20000 node --import tsx apps/server/scripts/preflop-selfplay.mjs
 */
// Import the policy SOURCE by path, not the `@4am/agent-core` package name: in a
// git worktree the workspace symlink `node_modules/@4am/agent-core` can point at
// the *main* checkout, so a package-name import silently measures stale code.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  choosePreflopIntent,
  preflopActionOrder,
  RULE_PRESETS,
} from '../../../packages/agent-core/src/index.ts';
import { RUST_VS_OPEN } from '../../../packages/agent-core/src/preflopCharts/data/rustVsOpen.ts';
import { rustVsOpenSpotKey } from '../../../packages/agent-core/src/preflopCharts/rustVsOpen.ts';

const SEED = Number(process.env.SEED ?? 987654321);
const TRIALS = Number(process.env.TRIALS ?? 20000);

const POSITIONS = {
  6: ['SB', 'BB', 'UTG', 'HJ', 'CO', 'BTN'],
  9: ['SB', 'BB', 'UTG', 'UTG1', 'MP', 'LJ', 'HJ', 'CO', 'BTN'],
};

const ARMS = ['legacy', 'norust', 'rust'];
const PARAMS = {
  legacy: { ...RULE_PRESETS['tight-aggressive'], adaptivePreflop: false },
  norust: { ...RULE_PRESETS['tight-aggressive'], adaptivePreflop: true },
  rust: { ...RULE_PRESETS['tight-aggressive'], adaptivePreflop: true },
};

/** mulberry32: tiny, seedable, deterministic. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffledDeck(rand) {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function act(seat, type, amount) {
  return {
    actionSeq: 0,
    street: 'preflop',
    seat,
    action: amount === undefined ? { type } : { type, amount },
    auto: false,
    ts: 0,
  };
}

function seatState(seat, { isMe, folded }) {
  return {
    seat,
    userId: isMe ? 1 : 100 + seat,
    displayName: isMe ? 'hero' : `v${seat}`,
    isMe: !!isMe,
    stack: 10_000,
    committed: 0,
    total: 0,
    folded: folded.has(seat),
    allIn: false,
    sittingOut: false,
    connected: true,
  };
}

/** Build the DecisionView the policy reads for one decision point. */
function buildView({ n, seat, hole, folded, history, currentBet, orderAfter }) {
  const seatOrder = Array.from({ length: n }, (_, i) => i);
  const pending = [seat, ...orderAfter.filter((s) => !folded.has(s))];
  return {
    room: { id: 'sim', name: 'sim', sb: 50, bb: 100, minSettleHands: 0, sevenDeuceBonus: 0 },
    hand: {
      handId: 'sim',
      street: 'preflop',
      buttonSeat: n - 1,
      board: [],
      pot: 150,
      currentBet,
      toAct: seat,
      deadline: null,
      myCards: hole[seat],
      mySeat: seat,
    },
    me: seatState(seat, { isMe: true, folded }),
    legalActions: null,
    potOdds: null,
    actionHistory: history,
    opponents: seatOrder
      .filter((s) => s !== seat)
      .map((s) => seatState(s, { isMe: false, folded })),
    sessionMemory: { handsObserved: 0, netChips: null, recentHands: [], opponents: [] },
    historyComplete: true,
    seatOrder,
    actionSeq: 0,
    needToActSeats: pending,
  };
}

/**
 * One arm: `trials` hands at an `n`-handed table, playing to the first raise
 * and stopping there (a 3-bet / multiway pot is outside the metric).
 */
function simulate({ n, trials, params, dealSeed, decisionSeed }) {
  const actionOrder = preflopActionOrder(Array.from({ length: n }, (_, i) => i));
  const bbSeat = 1;
  const dealRng = mulberry32(dealSeed);
  const decisionRng = mulberry32(decisionSeed);
  const positions = POSITIONS[n];
  const stats = {
    denom: 0,
    threeBet: 0,
    nonBbHands: trials * (n - 2),
    byPosition: Object.fromEntries(positions.map((p) => [p, { denom: 0, threeBet: 0 }])),
  };

  for (let t = 0; t < trials; t++) {
    const deck = shuffledDeck(dealRng);
    const hole = {};
    for (let s = 0; s < n; s++) hole[s] = [deck[2 * s], deck[2 * s + 1]];

    const folded = new Set();
    const history = [];
    let currentBet = 100;
    let raises = 0;
    let opener = null;
    let callers = 0;

    for (let oi = 0; oi < actionOrder.length; oi++) {
      const seat = actionOrder[oi];
      if (folded.has(seat)) continue;

      // Outside the metric: a 3-bet is on the table, or the BB (non-BB metric),
      // or a caller turned the pot multiway. The BB with no raise also just
      // checks its option, so it is skipped rather than allowed to "open".
      if (raises >= 2) break;
      if (raises === 1 && seat === bbSeat) break;
      if (raises === 1 && callers >= 1) break;
      if (raises === 0 && seat === bbSeat) continue;

      const orderAfter = actionOrder.slice(oi + 1);
      const view = buildView({ n, seat, hole, folded, history, currentBet, orderAfter });
      const { intent } = choosePreflopIntent(view, params, decisionRng);

      if (raises === 0) {
        if (intent === 'raise') {
          opener = seat;
          raises = 1;
          currentBet = 250;
          history.push(act(seat, 'raise', 250));
        } else if (intent === 'call') {
          callers++;
          history.push(act(seat, 'call'));
        } else {
          folded.add(seat);
          history.push(act(seat, 'fold'));
        }
        continue;
      }

      // raises === 1, clean single open, non-BB, first time acting.
      const pos = positions[seat];
      stats.denom++;
      stats.byPosition[pos].denom++;
      if (intent === 'raise') {
        stats.threeBet++;
        stats.byPosition[pos].threeBet++;
        break; // a 3-bet closes the metric for this hand
      }
      if (intent === 'call') {
        callers++;
        break; // multiway from here on
      }
      folded.add(seat);
      history.push(act(seat, 'fold'));
    }
  }
  return stats;
}

// --- child mode ------------------------------------------------------------
if (process.env.SELFPLAY_CHILD === '1') {
  const arm = process.env.SELFPLAY_ARM;
  const n = Number(process.env.SELFPLAY_N);
  if (arm === 'norust') {
    // Disable the Rust provider for this process: empty the embedded spots so
    // `rustVsOpenSpotKey` maps nothing. Safe because each arm is a fresh
    // process (no mix/table cache carries over).
    RUST_VS_OPEN.spots = {};
    if (rustVsOpenSpotKey(2, 5) !== null) {
      throw new Error('Rust-off arm failed to disable the provider');
    }
  }
  const stats = simulate({
    n,
    trials: TRIALS,
    params: PARAMS[arm],
    dealSeed: SEED,
    decisionSeed: SEED + n,
  });
  process.stdout.write(`__SELFPLAY__${JSON.stringify({ arm, n, stats })}\n`);
} else {
  // --- parent mode: run every arm in its own process ------------------------
  const scriptPath = fileURLToPath(import.meta.url);
  function runArm(arm, n) {
    const raw = execFileSync(process.execPath, ['--import', 'tsx', scriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        SELFPLAY_CHILD: '1',
        SELFPLAY_ARM: arm,
        SELFPLAY_N: String(n),
      },
    });
    const line = raw.split('\n').find((l) => l.startsWith('__SELFPLAY__'));
    if (!line) throw new Error(`no result from arm ${arm} (n=${n})`);
    return JSON.parse(line.slice('__SELFPLAY__'.length)).stats;
  }

  const out = [];
  out.push('preflop self-play harness (3-arm attribution)');
  out.push(`seed=${SEED} trials=${TRIALS} params=tight-aggressive`);
  out.push(
    'denominator = non-BB first action facing exactly one raise with no caller (the facingOpen spot)',
  );
  out.push('arms: legacy(adaptivePreflop:false) | norust(adaptive, Rust provider disabled) | rust(adaptive + Rust)');

  const pct = (x, d) => (d === 0 ? 'n/a' : `${((100 * x) / d).toFixed(2)}%`);
  for (const n of [6, 9]) {
    const s = { legacy: runArm('legacy', n), norust: runArm('norust', n), rust: runArm('rust', n) };
    out.push('');
    out.push(`${n}-max`);
    for (const arm of ARMS) {
      const v = s[arm];
      out.push(
        `  ${arm.padEnd(7)}: facing-open 3bet = ${v.threeBet}/${v.denom} = ${pct(v.threeBet, v.denom)}` +
          `   (per non-BB player-hand: ${pct(v.threeBet, v.nonBbHands)})`,
      );
      const per = Object.entries(v.byPosition)
        .filter(([, x]) => x.denom > 0)
        .map(([pos, x]) => `${pos} ${pct(x.threeBet, x.denom)}`)
        .join('  ');
      out.push(`           by position: ${per}`);
    }
    const r = (a, b) => `${((100 * (s[b].threeBet / s[b].denom - s[a].threeBet / s[a].denom))).toFixed(2)}pt`;
    out.push(`  attribution: adaptive routing (legacy -> norust) = ${r('legacy', 'norust')}; Rust provider (norust -> rust) = ${r('norust', 'rust')}`);
  }

  const text = `${out.join('\n')}\n`;
  process.stdout.write(text);
}
