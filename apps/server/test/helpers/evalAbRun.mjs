#!/usr/bin/env node
/**
 * CLI driver for the replicated bot A/B evaluation (`runReplicatedComparison`
 * in `evalDesign.mjs`). Harness-only; never touches product code.
 *
 * Run:
 *   node --import tsx apps/server/test/helpers/evalAbRun.mjs \
 *     --arm=p2:all --ref=rules-v1 --seed-start=1000 --replicas=20 --hands=200 \
 *     --out=/tmp/bot-ab/pilot.json
 *
 * Emits one JSON object with the per-replica samples, the pooled/iid/block/
 * cluster aggregates, the variance components, the required R for the target
 * MDE, and the `verdictFor` decision. Deterministic given the seeds.
 */
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  runReplicatedComparison,
  requiredReplicas,
  sampleSizeFor,
  aggregateReplicaSamples,
} from './evalDesign.mjs';

function cliValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}
function cfg(name, envName, fallback) {
  const raw = cliValue(name) ?? process.env[envName];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
function cfgStr(name, envName, fallback) {
  return cliValue(name) ?? process.env[envName] ?? fallback;
}

const ARM = cfgStr('arm', 'ARM', 'p2:all');
const REF = cfgStr('ref', 'REF', 'rules-v1');
const SEED_START = Math.floor(cfg('seed-start', 'SEED_START', 1000));
const REPLICAS = Math.max(1, Math.floor(cfg('replicas', 'REPLICAS', 5)));
const HANDS = Math.max(1, Math.floor(cfg('hands', 'HANDS', 50)));
const MDE = cfg('mde', 'MDE', 5);
const ALPHA = cfg('alpha', 'ALPHA', 0.05);
const COMPARISONS = Math.max(1, Math.floor(cfg('comparisons', 'COMPARISONS', 1)));
const ITERS = Math.max(100, Math.floor(cfg('bootstrap-iters', 'BOOTSTRAP_ITERS', 10_000)));
const OUT = cfgStr('out', 'OUT', '');
const SEED_STEP = Math.max(1, Math.floor(cfg('seed-step', 'SEED_STEP', 1)));
const BLOCK_LENGTH = cliValue('block-length') ? Math.floor(cfg('block-length', 'BLOCK_LENGTH', 0)) : null;

const seeds = Array.from({ length: REPLICAS }, (_, i) => SEED_START + i * SEED_STEP);

const startedAt = Date.now();
if (OUT) mkdirSync(dirname(OUT), { recursive: true });
const jsonlPath = OUT ? `${OUT}.replicas.jsonl` : null;
const perReplicaMs = [];
let last = startedAt;
const result = await runReplicatedComparison(ARM, REF, {
  seeds,
  hands: HANDS,
  memory: true,
  bootstrapIters: ITERS,
  mde: MDE,
  alpha: ALPHA,
  comparisons: COMPARISONS,
  blockLength: BLOCK_LENGTH,
  onReplica: (r) => {
    const now = Date.now();
    const latencyMs = now - last;
    last = now;
    perReplicaMs.push({ seed: r.seed, clean: r.clean, hands: r.hands, bb100: r.bb100, ms: latencyMs });
    // Incremental durable record: a killed long run still leaves every finished
    // replica on disk, so the pilot is never lost to a timeout.
    if (jsonlPath) {
      appendFileSync(
        jsonlPath,
        JSON.stringify({
          arm: ARM,
          reference: REF,
          seed: r.seed,
          clean: r.clean,
          hands: r.hands,
          bb100: r.bb100,
          iidCi95: r.iidCi95,
          samples: r.samples,
        }) + '\n',
      );
    }
    console.error(
      `[replica ${perReplicaMs.length}/${REPLICAS}] seed=${r.seed} hands=${r.hands} ` +
        `bb100=${r.bb100} clean=${r.clean} (${(latencyMs / 1000).toFixed(1)}s)`,
    );
  },
});

// Variance-component summaries (bb/100 units). Re-aggregate the raw replica
// samples to recover the debiased pure between-seed SD (`betweenSdPure`),
// which `runReplicatedComparison` does not surface.
const agg = aggregateReplicaSamples(
  result.replicas.map((r) => r.samples),
  { bootstrapIters: 200, confidence: result.confidence, blockLength: BLOCK_LENGTH },
);
const repMeans = result.replicas.map((r) => r.bb100);
const requiredForMde = {};
for (const mde of [1, 2, 3, 5]) {
  requiredForMde[mde] =
    result.betweenSd > 0
      ? requiredReplicas({
          replicaMeanSd: result.betweenSd,
          mde,
          alpha: ALPHA / COMPARISONS,
          power: 0.8,
        })
      : null; // R < 2 has no between-replica dispersion to estimate from
}
const iidHandsForMde = {};
for (const mde of [1, 2, 3, 5]) {
  iidHandsForMde[mde] =
    result.withinSd > 0
      ? sampleSizeFor({
          sd: result.withinSd,
          mde,
          alpha: ALPHA / COMPARISONS,
          power: 0.8,
        })
      : null;
}

const report = {
  kind: 'bot-ab-replicated-run',
  arm: ARM,
  reference: REF,
  seedStart: SEED_START,
  seedStep: SEED_STEP,
  replicas: REPLICAS,
  hands: HANDS,
  memory: true,
  mde: MDE,
  alpha: ALPHA,
  comparisons: COMPARISONS,
  confidence: result.confidence,
  blockLength: result.blockLength,
  startedAt: new Date(startedAt).toISOString(),
  durationMs: Date.now() - startedAt,
  perReplicaMs,
  allClean: result.allClean,
  replicaSeeds: seeds,
  replicaMeans: repMeans,
  estimators: {
    pooledMean: result.pooledMean,
    replicaMean: result.replicaMean,
    iid: result.iid,
    block: result.block,
    cluster: result.cluster,
  },
  variance: {
    betweenSdObserved: result.betweenSd,
    betweenSdPureReported: agg.betweenSdPure,
    withinSd: result.withinSd,
  },
  requiredForMde,
  iidHandsForMde,
  verdict: result.verdict,
  replicas_detail: result.replicas.map((r) => ({
    seed: r.seed,
    clean: r.clean,
    hands: r.hands,
    bb100: r.bb100,
    iidCi95: r.iidCi95,
    sampleCount: r.samples.length,
    sampleMean: r.samples.length ? r.samples.reduce((a, b) => a + b, 0) / r.samples.length : null,
  })),
  rawSamples: result.replicas.map((r) => ({
    seed: r.seed,
    clean: r.clean,
    hands: r.hands,
    bb100: r.bb100,
    samples: r.samples,
  })),
};

if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
}

// Console summary (compact).
const f = (x, d = 3) => (typeof x === 'number' ? x.toFixed(d) : String(x));
console.log(`\n=== bot A/B: ${ARM} vs ${REF} ===`);
console.log(`seeds ${seeds[0]}..${seeds[seeds.length - 1]} (${REPLICAS}), H=${HANDS}, memory=on, iters=${ITERS}`);
console.log(`duration ${(report.durationMs / 1000).toFixed(1)}s (${(report.durationMs / 1000 / REPLICAS).toFixed(1)}s/replica)`);
console.log(`allClean=${result.allClean}`);
console.log(`pooledMean=${f(result.pooledMean)}  replicaMean=${f(result.replicaMean)}  bb/100`);
console.log(`iid     mean=${f(result.iid.mean)} ci=[${f(result.iid.ci95[0])}, ${f(result.iid.ci95[1])}] width=${f(result.iid.width)}`);
console.log(`block   mean=${f(result.block.mean)} ci=[${f(result.block.ci95[0])}, ${f(result.block.ci95[1])}] width=${f(result.block.width)} L=${result.block.blockLength}`);
console.log(`cluster mean=${f(result.cluster.mean)} ci=[${f(result.cluster.ci95[0])}, ${f(result.cluster.ci95[1])}] width=${f(result.cluster.width)} R=${result.cluster.clusters}`);
console.log(`betweenSd(obs)=${f(result.betweenSd)}  withinSd=${f(result.withinSd)}`);
console.log(`verdict=${result.verdict.status} (bb100=${f(result.verdict.bb100)}, ci=[${f(result.verdict.ci95[0])}, ${f(result.verdict.ci95[1])}], mde=${MDE})`);
console.log(`required R (observed replicaMeanSd) for mde: ` + JSON.stringify(requiredForMde));
console.log(`iid hands for mde: ` + JSON.stringify(iidHandsForMde));
if (OUT) console.log(`report: ${OUT}`);
