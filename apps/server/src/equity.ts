/** Live heads-up equity for the multi-run all-in feature.
 *
 *  Given two known hands and a partial board, `computeHeadsUpEquity` returns
 *  each player's share of the pot in basis points (ties split half, so the two
 *  always sum to 10000). River/turn/flop are enumerated exactly; preflop runs a
 *  deterministic, seed-derived Monte Carlo so the number is reproducible.
 *
 *  The work runs on a worker thread: a preflop all-in must not stall the
 *  server's event loop. A hard timeout (default 2s, `EQUITY_TIMEOUT_MS`) turns
 *  a stuck or failed worker into a rejected promise carrying the
 *  `equity_failed` code the caller can handle.
 */
import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import type { CardId } from '@4am/shared';
import type { EquityJob, HeadsUpEquityResult } from './equityWorker.js';

export type { HeadsUpEquityResult } from './equityWorker.js';

export const EQUITY_FAILED = 'equity_failed';

export class EquityError extends Error {
  readonly code = EQUITY_FAILED;
  constructor(message: string) {
    super(message);
    this.name = 'EquityError';
  }
}

export interface HeadsUpEquityArgs {
  holeA: [CardId, CardId];
  holeB: [CardId, CardId];
  /** 0 (preflop), 3 (flop), 4 (turn) or 5 (river) known board cards. */
  board: CardId[];
  /** Audit seed; the same seed always yields the same preflop result. */
  seed: string;
}

const DEFAULT_TIMEOUT_MS = 2000;

function timeoutMs(): number {
  const raw = Number(process.env.EQUITY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/** Locate the worker on disk. `import.meta.url` is `src/equity.ts` in dev and
 *  tests, but `dist/index.js` once bundled — so fall back to the source path. */
function resolveWorkerUrl(): URL {
  const candidates = [
    new URL('./equityWorker.js', import.meta.url),
    new URL('./equityWorker.ts', import.meta.url),
    new URL('../src/equityWorker.ts', import.meta.url),
  ];
  for (const url of candidates) {
    if (existsSync(url)) return url;
  }
  throw new EquityError('equity worker script not found');
}

interface WorkerReply {
  ok: boolean;
  result?: HeadsUpEquityResult;
  error?: string;
}

export function computeHeadsUpEquity(args: HeadsUpEquityArgs): Promise<HeadsUpEquityResult> {
  return new Promise<HeadsUpEquityResult>((resolve, reject) => {
    let url: URL;
    try {
      url = resolveWorkerUrl();
    } catch (err) {
      reject(err instanceof EquityError ? err : new EquityError('equity worker script not found'));
      return;
    }

    const job: EquityJob = {
      holeA: args.holeA,
      holeB: args.holeB,
      board: args.board,
      seed: args.seed,
    };
    const isTypeScript = url.pathname.endsWith('.ts');

    let worker: Worker;
    try {
      worker = new Worker(url, {
        workerData: job,
        ...(isTypeScript ? { execArgv: ['--import', 'tsx'] } : {}),
      });
    } catch {
      reject(new EquityError('failed to start equity worker'));
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(new EquityError('equity computation timed out'));
    }, timeoutMs());

    worker.once('message', (reply: WorkerReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (reply?.ok && reply.result) resolve(reply.result);
      else reject(new EquityError(reply?.error ?? 'equity worker failed'));
    });
    worker.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new EquityError('equity worker errored'));
    });
    worker.once('exit', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new EquityError('equity worker exited early'));
    });
  });
}
