/**
 * L3 geometry gate runner. Reuses the real-product DOM setup and measurements
 * in table-overlap.mjs, then emits a small, reviewable pass/fail summary for
 * the two oracle-required portrait viewports.
 *
 * Run with Vite already serving apps/web:
 *   BASE_URL=http://127.0.0.1:5173 node apps/web/test/browser/table-geometry-gate.mjs
 *
 * This uses the synthetic room_state transport already used by the browser
 * evidence suite. It is real DOM measurement of the product page, not a hand
 * written fixture. A production-login run can use the same output contract
 * once the transport setup is replaced by the authenticated page.
 */
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const probe = fileURLToPath(new URL('./table-overlap.mjs', import.meta.url));
const output = process.env.UAT_OUTPUT || '/tmp/4am-table-geometry-gate';
const env = {
  ...process.env,
  VIEWS: 'phone',
  VIEWPORTS: '320x568,390x844',
  UAT_OUTPUT: output,
};

const child = spawn(process.execPath, [probe], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => {
  stdout += chunk;
  process.stdout.write(chunk);
});
child.stderr.on('data', (chunk) => {
  stderr += chunk;
  process.stderr.write(chunk);
});
const status = await new Promise((resolve) => child.on('close', resolve));
if (status !== 0) process.exit(status ?? 1);

const report = JSON.parse(await readFile(`${output}/overlap.json`, 'utf8'));
const failures = [];
for (const result of report.results) {
  const m = result.l3Metrics;
  const checks = {
    ninePods: result.pods === 9,
    kFloor: result.k !== null && result.k >= 0.55,
    rimRatio: m.rimRatio !== null && m.rimRatio >= 1.38,
    avatarPair: m.avatarPairPx === 0,
    textRectPair: m.textRectPairPx === 0,
    podPairContentPx2: result.podPairPx2 === 0,
    clusterOverPodContentPx2: result.semantic.clusterOverPodContentPx2 === 0,
    controlsUsable:
      result.scene.faces === 0 ||
      (result.semantic.controls.visible &&
        result.semantic.controls.clickableVisible > 0 &&
        result.semantic.controls.allVisible),
    boardCoverage: result.scene.faces === 0 || (result.boardCov !== null && result.boardCov >= 0.9),
    additionalRuns:
      result.scene.faces < 15 ||
      (result.semantic.runCoverage.length >= 3 &&
        result.semantic.runCoverage
          .slice(1)
          .every((run) => run.coverage !== null && run.coverage >= 0.9 && run.otherRunsPx2 === 0)),
    statusLayer:
      result.scene.faces < 15 ||
      (result.semantic.statusHits.length > 0 && result.semantic.statusCollisionPx2 === 0),
    heroBoard: result.heroBoardOverlapPx2 === 0,
    viewport: result.clusterVisible !== null && result.clusterVisible >= 0.99,
    hiddenShowdownHero: m.modes.hidden + m.modes.showdown + m.modes.hero === result.pods,
    fanEffectiveOverlap:
      m.modes.hidden === 0 ||
      (m.fanDiagnostics.length > 0 &&
        m.fanDiagnostics.every((entry) => entry.ratio !== null && entry.ratio >= 0.05)),
    showdownSafeZone:
      result.scene.faces === 0 ||
      (m.safeZoneOverlapPx2.length > 0 && m.safeZoneOverlapPx2.every((area) => area === 0)),
    preflopDeck:
      result.scene.faces === 0 &&
      m.preflopDeckPresent === true &&
      m.preflopDeckVisible === false &&
      m.preflopDeckLifecycle === 'present-hidden-source',
  };
  console.log(
    JSON.stringify(
      {
        scenario: result.scenario,
        viewport: result.vp,
        values: {
          pods: result.pods,
          k: result.k,
          textCov: result.textCov,
          boardCov: result.boardCov,
          podPairPx2: result.podPairPx2,
          avatarPairPx: m.avatarPairPx,
          textRectPairPx: m.textRectPairPx,
          rimRatio: m.rimRatio,
          modes: m.modes,
          fanAvatarOverlapRatios: m.fanAvatarOverlapRatios,
          fanDiagnostics: m.fanDiagnostics,
          safeZoneOverlapPx2: m.safeZoneOverlapPx2,
          heroBoardOverlapPx2: result.heroBoardOverlapPx2,
          semantic: result.semantic,
        },
        checks,
      },
      null,
      2,
    ),
  );
  for (const [name, pass] of Object.entries(checks))
    if (pass !== true) failures.push(`${result.scenario}@${result.vp} ${name}=FAIL (${pass})`);
}
console.log(`geometry-gate: ${failures.length ? 'FAIL' : 'PASS'}`);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
