#!/usr/bin/env node
/**
 * Combine one or more `evalAbRun.mjs` outputs (JSON and/or `.replicas.jsonl`)
 * into a single replica-level aggregate. Harness-only.
 *
 * Every input contributes `{seed, samples}` replicas; duplicates by seed are
 * dropped (a resumed/overlapping worker must not double-count a deck). The
 * aggregate is the equal-weight replica cluster bootstrap from `evalDesign.mjs`.
 *
 * Run:
 *   node --import tsx apps/server/test/helpers/evalAbCombine.mjs \
 *     --inputs=/tmp/bot-ab/pilot_h50_0.json,/tmp/bot-ab/pilot_h50_1.json,... \
 *     --out=/tmp/bot-ab/pilot_combined.json
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  aggregateReplicaSamples,
  requiredReplicas,
  sampleSizeFor,
  verdictFor,
} from './evalDesign.mjs';

function cliValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}
function cfg(name, fallback) {
  const raw = cliValue(name);
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
const INPUTS = (cliValue('inputs') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const OUT = cliValue('out') ?? '';
const MDE = cfg('mde', 5);
const ALPHA = cfg('alpha', 0.05);
const COMPARISONS = Math.max(1, Math.floor(cfg('comparisons', 1)));
const ITERS = Math.max(100, Math.floor(cfg('bootstrap-iters', 10_000)));
const MIN_BLOCK = Math.max(1, Math.floor(cfg('min-block-length', 10)));

if (INPUTS.length === 0) throw new Error('evalAbCombine: --inputs is required');

const bySeed = new Map();
const meta = { arm: null, reference: null, hands: null };
for (const path of INPUTS) {
  if (!existsSync(path)) throw new Error(`evalAbCombine: missing input ${path}`);
  const text = readFileSync(path, 'utf8');
  let rows;
  if (path.endsWith('.jsonl')) {
    rows = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } else {
    const j = JSON.parse(text);
    if (j.arm) meta.arm = meta.arm ?? j.arm;
    if (j.reference) meta.reference = meta.reference ?? j.reference;
    if (j.hands) meta.hands = meta.hands ?? j.hands;
    // `replicas_detail` carries the clean gate that the older `rawSamples` rows
    // omitted; re-attach it by seed so the combined validity gate is real.
    const cleanBySeed = new Map((j.replicas_detail ?? []).map((d) => [d.seed, d.clean]));
    rows = (j.rawSamples ?? []).map((r) => ({
      ...r,
      clean: r.clean ?? cleanBySeed.get(r.seed),
      hands: r.hands ?? j.hands,
      bb100: r.bb100 ?? j.replicas_detail?.find((d) => d.seed === r.seed)?.bb100,
    }));
  }
  for (const r of rows) {
    if (!Array.isArray(r.samples) || r.samples.length === 0) continue;
    if (r.arm) meta.arm = meta.arm ?? r.arm;
    if (r.reference) meta.reference = meta.reference ?? r.reference;
    if (!bySeed.has(r.seed)) bySeed.set(r.seed, r);
  }
}

const replicas = [...bySeed.values()].sort((a, b) => a.seed - b.seed);
if (replicas.length === 0) throw new Error('evalAbCombine: no replicas found');
const clusterInput = replicas.map((r) => r.samples);

const agg = aggregateReplicaSamples(clusterInput, {
  bootstrapIters: ITERS,
  confidence: 1 - ALPHA / COMPARISONS,
  minBlockLength: MIN_BLOCK,
});

const requiredForMde = {};
const iidHandsForMde = {};
for (const mde of [1, 2, 3, 5]) {
  requiredForMde[mde] =
    agg.betweenSd > 0
      ? requiredReplicas({
          replicaMeanSd: agg.betweenSd,
          mde,
          alpha: ALPHA / COMPARISONS,
          power: 0.8,
        })
      : null;
  iidHandsForMde[mde] =
    agg.withinSd > 0
      ? sampleSizeFor({ sd: agg.withinSd, mde, alpha: ALPHA / COMPARISONS, power: 0.8 })
      : null;
}

const allClean = replicas.every((r) => r.clean === true);
const verdict = verdictFor({
  bb100: agg.replicaMean,
  ci95: agg.cluster.ci95,
  mde: MDE,
  alpha: ALPHA,
  comparisons: COMPARISONS,
  clean: allClean,
});

const report = {
  kind: 'bot-ab-combined',
  arm: meta.arm,
  reference: meta.reference,
  handsPerReplica: meta.hands,
  replicas: replicas.length,
  totalHands: agg.n,
  mde: MDE,
  alpha: ALPHA,
  comparisons: COMPARISONS,
  confidence: agg.cluster.confidence,
  allClean,
  inputs: INPUTS,
  replicaSeeds: replicas.map((r) => r.seed),
  replicaMeans: agg.replicaMeans,
  estimators: { pooledMean: agg.pooledMean, replicaMean: agg.replicaMean, iid: agg.iid, block: agg.block, cluster: agg.cluster },
  variance: {
    betweenSdObserved: agg.betweenSd,
    betweenSdPure: agg.betweenSdPure,
    withinSd: agg.withinSd,
  },
  requiredForMde,
  iidHandsForMde,
  verdict,
};

if (OUT) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));
}

const f = (x, d = 3) => (typeof x === 'number' ? x.toFixed(d) : String(x));
console.log(`\n=== combined: ${meta.arm} vs ${meta.reference} ===`);
console.log(`replicas=${replicas.length} H=${meta.hands} totalHands=${agg.n} allClean=${allClean}`);
console.log(`pooledMean=${f(agg.pooledMean)}  replicaMean=${f(agg.replicaMean)} bb/100`);
console.log(`iid     ${f(agg.iid.mean)}  [${f(agg.iid.ci95[0])}, ${f(agg.iid.ci95[1])}] width=${f(agg.iid.width)}`);
console.log(`block   ${f(agg.block.mean)}  [${f(agg.block.ci95[0])}, ${f(agg.block.ci95[1])}] width=${f(agg.block.width)} L=${agg.block.blockLength}`);
console.log(`cluster ${f(agg.cluster.mean)}  [${f(agg.cluster.ci95[0])}, ${f(agg.cluster.ci95[1])}] width=${f(agg.cluster.width)} R=${agg.cluster.clusters}`);
console.log(`betweenSd(obs)=${f(agg.betweenSd)}  betweenSdPure=${f(agg.betweenSdPure)}  withinSd=${f(agg.withinSd)}`);
console.log(`verdict=${verdict.status} bb100=${f(verdict.bb100)} ci=[${f(verdict.ci95[0])}, ${f(verdict.ci95[1])}] mde=${MDE}`);
console.log(`required R for mde: ${JSON.stringify(requiredForMde)}`);
console.log(`iid hands for mde: ${JSON.stringify(iidHandsForMde)}`);
if (OUT) console.log(`report: ${OUT}`);
