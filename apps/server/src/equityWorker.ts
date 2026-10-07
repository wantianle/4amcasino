/** Known-hands equity core + worker-thread entry point.
 *
 *  The heavy lifting lives here so it can run inside a `node:worker_threads`
 *  worker (a preflop all-in must never block the server's event loop). The
 *  pure `runEquityJob` is exported too, so tests can exercise the math
 *  synchronously without paying worker start-up.
 *
 *  Only the known hands, the board and any explicitly dead cards take part: the
 *  deck a runout is drawn from is the 52 cards minus those, so folded or
 *  unknown hole cards never influence the result.
 *
 *  The core is N-way (`runMultiwayEquityJob`); the heads-up `runEquityJob` is a
 *  two-hand call into it, so the all-in multi-run offer and the per-street
 *  bubble share one implementation.
 */
import { parentPort, isMainThread, workerData } from 'node:worker_threads';
import { ALL_CARDS, evaluate7, type CardId } from '@4am/shared';

export interface EquityJob {
  holeA: [CardId, CardId];
  holeB: [CardId, CardId];
  board: CardId[];
  seed: string;
  /** Overrides the deterministic preflop sample count (tests / tuning). */
  samples?: number;
}

export interface HeadsUpEquityResult {
  /** Win shares in basis points; always sums to 10000, ties split half each. */
  equitiesBps: [number, number];
  method: 'exact' | 'monte-carlo';
  /** Outcomes enumerated (exact) or runouts sampled (monte-carlo). */
  samples: number;
}

/** N-way known-hands equity (the live all-in bubble, HU and multiway). */
export interface MultiwayEquityJob {
  /** Every live player's two hole cards, in seat order. */
  holes: [CardId, CardId][];
  board: CardId[];
  seed: string;
  samples?: number;
  /** Publicly-known dead cards (e.g. an earlier run's board) removed from the
   *  runout deck. */
  dead?: CardId[];
}

export interface MultiwayEquityResult {
  /** Pot share per hole in basis points; sums to 10000, ties split evenly. */
  equitiesBps: number[];
  method: 'exact' | 'monte-carlo';
  samples: number;
}

/** Deterministic preflop sample count — reproducible from the audit seed. */
export const PREFLOP_SAMPLES = 25_000;

/** Boards we can settle exactly. Anything else (a partial street) is rejected. */
const EXACT_BOARD_LENGTHS = new Set([3, 4, 5]);

function validateMulti(job: MultiwayEquityJob): CardId[] {
  if (!Array.isArray(job.holes) || job.holes.length < 2) {
    throw new Error('at least two hands are required');
  }
  for (const h of job.holes) {
    if (h?.length !== 2) throw new Error('each hand needs exactly two hole cards');
  }
  if (!Array.isArray(job.board)) throw new Error('board must be an array');
  if (job.board.length !== 0 && !EXACT_BOARD_LENGTHS.has(job.board.length)) {
    throw new Error(`unsupported board length: ${job.board.length}`);
  }
  const dead = job.dead ?? [];
  if (!Array.isArray(dead)) throw new Error('dead must be an array');
  const known = [...job.holes.flat(), ...job.board, ...dead];
  for (const c of known) {
    if (!Number.isInteger(c) || c < 0 || c > 51) throw new Error(`bad card id: ${c}`);
  }
  if (new Set(known).size !== known.length)
    throw new Error('duplicate card across hands/board/dead');
  const used = new Set(known);
  return ALL_CARDS.filter((c) => !used.has(c));
}

function validate(job: EquityJob): CardId[] {
  return validateMulti({
    holes: [job.holeA, job.holeB],
    board: job.board,
    seed: job.seed,
    samples: job.samples,
  });
}

/** FNV-1a 32-bit — turns the audit seed into RNG state, stable across runs. */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: tiny, fast, and fully determined by the seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Convert fractional win shares to integer basis points that sum to 10000.
 *  Largest-remainder rounding, which reproduces the heads-up `[a, 10000-a]`
 *  split exactly for two players. */
function toBps(wins: number[], n: number): number[] {
  const raw = wins.map((w) => (w * 10000) / n);
  const out = raw.map(Math.floor);
  const rem = 10000 - out.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < rem; k++) out[order[k % order.length]!.i]!++;
  return out;
}

function best(hole: readonly [CardId, CardId], fullBoard: readonly CardId[]): number {
  return evaluate7([
    hole[0],
    hole[1],
    fullBoard[0]!,
    fullBoard[1]!,
    fullBoard[2]!,
    fullBoard[3]!,
    fullBoard[4]!,
  ]);
}

function tally(holes: MultiwayEquityJob['holes'], fullBoard: CardId[], wins: number[]): void {
  let bestScore = -1;
  let winners: number[] = [];
  for (let i = 0; i < holes.length; i++) {
    const score = best(holes[i]!, fullBoard);
    if (score > bestScore) {
      bestScore = score;
      winners = [i];
    } else if (score === bestScore) {
      winners.push(i);
    }
  }
  const share = 1 / winners.length;
  for (const i of winners) wins[i]! += share;
}

function runExactMulti(job: MultiwayEquityJob, unseen: CardId[]): MultiwayEquityResult {
  const need = 5 - job.board.length;
  const wins = new Array<number>(job.holes.length).fill(0);
  let n = 0;
  const tallyBoard = (fullBoard: CardId[]): void => {
    tally(job.holes, fullBoard, wins);
    n++;
  };

  if (need === 0) {
    tallyBoard(job.board.slice());
  } else if (need === 1) {
    for (const c of unseen) tallyBoard([...job.board, c]);
  } else {
    for (let i = 0; i < unseen.length; i++) {
      for (let j = i + 1; j < unseen.length; j++) {
        tallyBoard([...job.board, unseen[i]!, unseen[j]!]);
      }
    }
  }
  return { equitiesBps: toBps(wins, n), method: 'exact', samples: n };
}

function runMonteCarloMulti(
  job: MultiwayEquityJob,
  unseen: CardId[],
  samples: number,
): MultiwayEquityResult {
  const rand = mulberry32(hashSeed(job.seed));
  const deck = unseen.slice();
  const wins = new Array<number>(job.holes.length).fill(0);
  for (let s = 0; s < samples; s++) {
    // Partial Fisher-Yates: draw five distinct runout cards uniformly.
    for (let i = 0; i < 5; i++) {
      const j = i + Math.floor(rand() * (deck.length - i));
      const tmp = deck[i]!;
      deck[i] = deck[j]!;
      deck[j] = tmp;
    }
    tally(job.holes, [deck[0]!, deck[1]!, deck[2]!, deck[3]!, deck[4]!], wins);
  }
  return { equitiesBps: toBps(wins, samples), method: 'monte-carlo', samples };
}

/** Deterministically settle N known hands against the supplied board. */
export function runMultiwayEquityJob(job: MultiwayEquityJob): MultiwayEquityResult {
  const unseen = validateMulti(job);
  if (job.board.length === 0) {
    return runMonteCarloMulti(job, unseen, job.samples ?? PREFLOP_SAMPLES);
  }
  return runExactMulti(job, unseen);
}

/** Deterministically settle two known hands against the supplied board. */
export function runEquityJob(job: EquityJob): HeadsUpEquityResult {
  const r = runMultiwayEquityJob({
    holes: [job.holeA, job.holeB],
    board: job.board,
    seed: job.seed,
    samples: job.samples,
  });
  return {
    equitiesBps: [r.equitiesBps[0]!, r.equitiesBps[1]!],
    method: r.method,
    samples: r.samples,
  };
}

// ---- worker bootstrap -----------------------------------------------------

interface WorkerReply {
  ok: boolean;
  result?: HeadsUpEquityResult | MultiwayEquityResult;
  error?: string;
}

const port = parentPort;
if (!isMainThread && port) {
  const post = (reply: WorkerReply): void => port.postMessage(reply);
  const data = workerData as (EquityJob | MultiwayEquityJob) & { persistent?: boolean };
  const run = (job: EquityJob | MultiwayEquityJob): WorkerReply => {
    try {
      return {
        ok: true,
        result: 'holes' in job ? runMultiwayEquityJob(job) : runEquityJob(job as EquityJob),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
  if (data?.persistent) {
    // Long-lived worker: one job per message, reused for every bubble street so
    // the per-street cost is the compute, not another thread start-up.
    port.on('message', (m: { id: number; job: EquityJob | MultiwayEquityJob }) => {
      port.postMessage({ id: m.id, ...run(m.job) });
    });
    // Handshake: a message posted to a port whose handler is not installed yet
    // can be lost, which would hang a whole street until the parent timeout.
    // Announce the listener so the parent only posts after this is on the wire.
    port.postMessage({ ready: true });
  } else {
    post(run(data));
  }
}
