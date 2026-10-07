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
import type {
  EquityJob,
  HeadsUpEquityResult,
  MultiwayEquityJob,
  MultiwayEquityResult,
} from './equityWorker.js';

export type { HeadsUpEquityResult, MultiwayEquityResult } from './equityWorker.js';

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

export interface MultiwayEquityArgs {
  /** Every live player's two hole cards, in seat order. */
  holes: [CardId, CardId][];
  /** 0 (preflop), 3 (flop), 4 (turn) or 5 (river) known board cards. */
  board: CardId[];
  /** Audit seed. */
  seed: string;
  /** Publicly-known dead cards removed from the runout deck. */
  dead?: CardId[];
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
  result?: HeadsUpEquityResult | MultiwayEquityResult;
  error?: string;
}

/** Start one worker for `job` and settle with its single reply (worker threads
 *  are one-shot here: a job is answered once, then the worker is terminated). */
function runEquityWorker<T>(
  job: EquityJob | MultiwayEquityJob,
  project: (reply: WorkerReply) => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let url: URL;
    try {
      url = resolveWorkerUrl();
    } catch (err) {
      reject(err instanceof EquityError ? err : new EquityError('equity worker script not found'));
      return;
    }

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
      if (reply?.ok && reply.result) resolve(project(reply));
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

export function computeHeadsUpEquity(args: HeadsUpEquityArgs): Promise<HeadsUpEquityResult> {
  return runEquityWorker(
    {
      holeA: args.holeA,
      holeB: args.holeB,
      board: args.board,
      seed: args.seed,
    },
    (reply) => reply.result as HeadsUpEquityResult,
  );
}

/** N-way known-hands equity for the live all-in bubble.
 *
 *  Unlike the one-shot offer worker, the bubble recomputes on every street of
 *  every run, so it keeps ONE long-lived worker alive (unref'd, so it never
 *  holds the process open) and posts jobs to it. Start-up is paid once per
 *  hand instead of once per card. */
interface PendingMultiway {
  resolve: (r: MultiwayEquityResult) => void;
  reject: (e: Error) => void;
  /** Compute timer, armed only once the job has actually been posted (after the
   *  worker's ready handshake), or null while it is still starting up. */
  timer: NodeJS.Timeout | null;
}

let multiwayWorker: Worker | null = null;
let multiwaySeq = 0;
// Resolves once the current worker has installed its message listener. Until
// then, posting a job can race the handler and lose the message (hanging the
// hand until the timeout), so every job awaits this first.
let multiwayReady: Promise<void> | null = null;
let multiwayReadyResolve: (() => void) | null = null;
const multiwayPending = new Map<number, PendingMultiway>();

function resetMultiwayWorker(reason: string): void {
  const w = multiwayWorker;
  multiwayWorker = null;
  multiwayReady = null;
  multiwayReadyResolve = null;
  if (w) void w.terminate();
  for (const pending of multiwayPending.values()) {
    if (pending.timer) clearTimeout(pending.timer);
    pending.reject(new EquityError(reason));
  }
  multiwayPending.clear();
}

function getMultiwayWorker(): Worker {
  if (multiwayWorker) return multiwayWorker;
  const url = resolveWorkerUrl();
  const isTypeScript = url.pathname.endsWith('.ts');
  const worker = new Worker(url, {
    workerData: { persistent: true },
    ...(isTypeScript ? { execArgv: ['--import', 'tsx'] } : {}),
  });
  // A bubble worker must never be the reason the server process stays alive.
  worker.unref();
  multiwayReady = new Promise<void>((resolve) => {
    multiwayReadyResolve = resolve;
  });
  worker.on(
    'message',
    (reply: {
      id?: number;
      ready?: boolean;
      ok?: boolean;
      result?: MultiwayEquityResult;
      error?: string;
    }) => {
      if (reply.ready) {
        multiwayReadyResolve?.();
        multiwayReadyResolve = null;
        return;
      }
      const pending = multiwayPending.get(reply.id!);
      if (!pending) return;
      multiwayPending.delete(reply.id!);
      if (pending.timer) clearTimeout(pending.timer);
      if (reply.ok && reply.result) pending.resolve(reply.result);
      else pending.reject(new EquityError(reply.error ?? 'equity worker failed'));
    },
  );
  worker.on('error', () => resetMultiwayWorker('equity worker errored'));
  worker.on('exit', () => {
    if (multiwayWorker === worker) resetMultiwayWorker('equity worker exited');
  });
  multiwayWorker = worker;
  return worker;
}

export function computeMultiwayEquity(args: MultiwayEquityArgs): Promise<MultiwayEquityResult> {
  return new Promise<MultiwayEquityResult>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = getMultiwayWorker();
    } catch {
      reject(new EquityError('equity worker script not found'));
      return;
    }
    const id = ++multiwaySeq;
    const bail = (): void => {
      multiwayPending.delete(id);
      reject(new EquityError('equity computation timed out'));
      // The persistent worker runs jobs in arrival order on one thread, so a
      // job that timed out would keep computing and delay every later street
      // into its own timeout. Tear the worker down; the next call rebuilds it.
      // (resetMultiwayWorker also rejects any jobs queued behind this one.)
      resetMultiwayWorker('equity computation timed out');
    };
    // The compute budget must measure the job, not worker start-up: on a loaded
    // machine (or with tsx) booting the thread can itself take seconds, and a
    // timeout there would kill a perfectly healthy worker and starve the hand.
    // So the real timer is armed only after the ready handshake; a generous
    // watchdog still bounds a worker that never comes up.
    const startupTimer = setTimeout(
      () => {
        if (multiwayPending.has(id)) bail();
      },
      Math.max(timeoutMs(), 10_000),
    );
    const pending: PendingMultiway = { resolve, reject, timer: null };
    multiwayPending.set(id, pending);
    const ready = multiwayReady ?? Promise.resolve();
    void ready.then(() => {
      clearTimeout(startupTimer);
      if (!multiwayPending.has(id)) return; // timed out (or reset) while waiting
      pending.timer = setTimeout(bail, timeoutMs());
      worker.postMessage({
        id,
        job: {
          holes: args.holes,
          board: args.board,
          seed: args.seed,
          ...(args.dead && args.dead.length > 0 ? { dead: args.dead } : {}),
        },
      });
    });
  });
}
