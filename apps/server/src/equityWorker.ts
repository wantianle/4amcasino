/** Head-up equity core + worker-thread entry point.
 *
 *  The heavy lifting lives here so it can run inside a `node:worker_threads`
 *  worker (a preflop all-in must never block the server's event loop). The
 *  pure `runEquityJob` is exported too, so tests can exercise the math
 *  synchronously without paying worker start-up.
 *
 *  Only the two known hands and the board take part: the deck a runout is
 *  drawn from is the 52 cards minus those known cards, so folded or unknown
 *  hole cards never influence the result.
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

/** Deterministic preflop sample count — reproducible from the audit seed. */
export const PREFLOP_SAMPLES = 25_000;

/** Boards we can settle exactly. Anything else (a partial street) is rejected. */
const EXACT_BOARD_LENGTHS = new Set([3, 4, 5]);

function validate(job: EquityJob): CardId[] {
  if (job.holeA?.length !== 2 || job.holeB?.length !== 2) {
    throw new Error('each hand needs exactly two hole cards');
  }
  if (!Array.isArray(job.board)) throw new Error('board must be an array');
  if (job.board.length !== 0 && !EXACT_BOARD_LENGTHS.has(job.board.length)) {
    throw new Error(`unsupported board length: ${job.board.length}`);
  }
  const known = [...job.holeA, ...job.holeB, ...job.board];
  for (const c of known) {
    if (!Number.isInteger(c) || c < 0 || c > 51) throw new Error(`bad card id: ${c}`);
  }
  if (new Set(known).size !== known.length) throw new Error('duplicate card across hands/board');
  const used = new Set(known);
  return ALL_CARDS.filter((c) => !used.has(c));
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

/** A win is 2 half-units, a tie 1 — keeps the bps conversion in integers. */
function bpsFromCounts(winsA: number, ties: number, n: number): [number, number] {
  const a = Math.round(((winsA * 2 + ties) * 10000) / (2 * n));
  return [a, 10000 - a];
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

function runExact(job: EquityJob, unseen: CardId[]): HeadsUpEquityResult {
  const need = 5 - job.board.length;
  let winsA = 0;
  let ties = 0;
  let n = 0;
  const tally = (fullBoard: CardId[]): void => {
    const sa = best(job.holeA, fullBoard);
    const sb = best(job.holeB, fullBoard);
    if (sa > sb) winsA++;
    else if (sa === sb) ties++;
    n++;
  };

  if (need === 0) {
    tally(job.board.slice());
  } else if (need === 1) {
    for (const c of unseen) tally([...job.board, c]);
  } else {
    for (let i = 0; i < unseen.length; i++) {
      for (let j = i + 1; j < unseen.length; j++) {
        tally([...job.board, unseen[i]!, unseen[j]!]);
      }
    }
  }
  return { equitiesBps: bpsFromCounts(winsA, ties, n), method: 'exact', samples: n };
}

function runMonteCarlo(job: EquityJob, unseen: CardId[], samples: number): HeadsUpEquityResult {
  const rand = mulberry32(hashSeed(job.seed));
  const deck = unseen.slice();
  let winsA = 0;
  let ties = 0;
  for (let s = 0; s < samples; s++) {
    // Partial Fisher-Yates: draw five distinct runout cards uniformly.
    for (let i = 0; i < 5; i++) {
      const j = i + Math.floor(rand() * (deck.length - i));
      const tmp = deck[i]!;
      deck[i] = deck[j]!;
      deck[j] = tmp;
    }
    const runout = [deck[0]!, deck[1]!, deck[2]!, deck[3]!, deck[4]!];
    const sa = best(job.holeA, runout);
    const sb = best(job.holeB, runout);
    if (sa > sb) winsA++;
    else if (sa === sb) ties++;
  }
  return { equitiesBps: bpsFromCounts(winsA, ties, samples), method: 'monte-carlo', samples };
}

/** Deterministically settle two known hands against the supplied board. */
export function runEquityJob(job: EquityJob): HeadsUpEquityResult {
  const unseen = validate(job);
  if (job.board.length === 0) {
    return runMonteCarlo(job, unseen, job.samples ?? PREFLOP_SAMPLES);
  }
  return runExact(job, unseen);
}

// ---- worker bootstrap -----------------------------------------------------

interface WorkerReply {
  ok: boolean;
  result?: HeadsUpEquityResult;
  error?: string;
}

const port = parentPort;
if (!isMainThread && port) {
  const post = (reply: WorkerReply): void => port.postMessage(reply);
  try {
    post({ ok: true, result: runEquityJob(workerData as EquityJob) });
  } catch (err) {
    post({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
