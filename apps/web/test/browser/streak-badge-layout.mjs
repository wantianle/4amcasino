/** Real table streak-badge layout probe.
 *
 *   BASE_URL=http://localhost:5173 ASSERT=1 node streak-badge-layout.mjs
 *   VIEWS=both UAT_OUTPUT=/tmp/4am-streak-badge ASSERT=1 node streak-badge-layout.mjs
 *
 * The HUD is intercepted at the API boundary; the table, seat pods, and badge
 * DOM remain the production route and production components.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const chromium = pw.chromium ?? pw.default?.chromium;
const base = process.env.BASE_URL || 'http://localhost:5173';
const out = process.env.UAT_OUTPUT || '/tmp/4am-streak-badge';
const ASSERT = process.env.ASSERT === '1';
const LOCALE = process.env.LOCALE || 'en-US';
const MIN_GAP = Number(process.env.MIN_GAP || 0);
const SELF_PATH = fileURLToPath(import.meta.url);
const probeHash = createHash('sha256').update(await readFile(SELF_PATH)).digest('hex').slice(0, 12);
const gitHash = process.env.GIT_HASH || null;
const MY_USER = 2;
const sharedPath = fileURLToPath(new URL('../../../../packages/shared/src/index.ts', import.meta.url));
await mkdir(out, { recursive: true });

const VIEWPORTS = process.env.VIEWS === 'phone'
  ? [{ width: 390, height: 844 }]
  : process.env.VIEWS === 'desktop'
    ? [{ width: 1440, height: 900 }]
    : [{ width: 1440, height: 900 }, { width: 390, height: 844 }];

function makeRoom() {
  const names = ['Maximilian-Long-Name ♨♨♨', 'Meera', 'Zoya', 'Ishaan', 'River', 'Jules', 'Mira', 'Sol', 'Sam'];
  return {
    t: 'room_state',
    room: { id: 'baseline', name: 'UI Baseline', joinCode: 'BASELN', hostId: MY_USER, bankerId: MY_USER,
      sb: 10, bb: 20, auditMode: 'private', actionTimeoutMs: 45000, actionSecs: 45, coBankerId: null,
      minSettleHands: 0, sevenDeuceBonus: 0, voided: false, meetLink: null, autoApproveBuys: false,
      tvReplays: false, commissionBps: 50 },
    players: names.map((displayName, seat) => ({ seat, userId: seat === 0 ? MY_USER : 100 + seat,
      username: displayName.toLowerCase().replace(/[^a-z0-9]/g, '-'), displayName, stack: 2000 - seat * 137,
      connected: true, sittingOut: false, totalBought: 2000, hasAvatar: false, avatarVersion: 0, pendingBuy: 0 })),
    handActive: true,
  };
}

function metric(pct) { return { hits: pct == null ? 0 : pct, opportunities: 100, pct, unit: 'pct' }; }
function makeHud() {
  const tiers = ['hot2', 'hot1', 'cold1', 'cold2', 'hot1', 'cold2', 'hot2', 'cold1', 'cold2'];
  return { roomId: 'baseline', metricVersion: 1, minHands: 20, players: tiers.map((tier, seat) => ({
    userId: seat === 0 ? MY_USER : 100 + seat, username: `player-${seat}`, displayName: seat === 0 ? 'Maximilian-Long-Name ♨♨♨' : `Player ${seat}`,
    hidden: seat === 7, sample: seat === 8 ? 2 : 50, minHands: 20, sufficient: seat !== 8,
    confidence: seat === 8 ? 'insufficient' : 'ok', dataConfidence: seat === 8 ? null : 'exact',
    // Seat 0 deliberately has pct:null: streak must still render independently.
    stats: { vpip: metric(seat === 0 ? null : 24), pfr: metric(18), threeBet: metric(7) },
    streak: { tier, netBB: tier.startsWith('hot') ? 12 : -12, sample: 10 },
  })) };
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const results = [];
const errors = [];
try {
  for (const vp of VIEWPORTS) {
    const room = makeRoom();
    const hud = makeHud();
    const ctx = await browser.newContext({ viewport: vp, locale: LOCALE, reducedMotion: 'reduce' });
    await ctx.addInitScript((uid) => localStorage.setItem('4am-auth', JSON.stringify({ state: { auth: { token: 'badge-fixture', userId: uid, username: 'alex', identity: null } }, version: 0 })), MY_USER);
    await ctx.addInitScript(() => localStorage.setItem('4am-sounds', 'off'));
    const page = await ctx.newPage();
    page.setDefaultTimeout(30000);
    page.on('pageerror', (e) => errors.push(`${vp.width}x${vp.height}: ${e.message}`));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(`${vp.width}x${vp.height} console: ${message.text()}`); });
    await page.route('**/api/**', (route) => {
      if (new URL(route.request().url()).pathname.endsWith('/hud')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(hud) });
      return route.fulfill({ json: { ok: true, userId: MY_USER, username: 'alex', displayName: 'Alex', rooms: [], requests: [], rows: [], friends: [], incoming: [], outgoing: [], hands: [], isPlatform: false, cardBack: 'crimson', fourColor: true, features: { squid: { enabled: true, penaltyBb: 100, minPlayers: 2 }, timeBank: { enabled: true, initialSeconds: 30, refillEveryHands: 30, refillSeconds: 30 }, bombPot: { enabled: true, anteBb: 3, schedule: { mode: 'hands', value: 10 } }, multiRun: { enabled: true, maxRuns: 3 } } } });
    });
    await page.routeWebSocket('**/*', (ws) => ws.onMessage((data) => {
      if (JSON.parse(String(data)).t === 'join_room') ws.send(JSON.stringify(room));
    }));
    await page.goto(`${base}/room/baseline`);
    await page.waitForFunction(async ({ count }) => {
      const { useStore } = await import('/src/shared/store.ts');
      return useStore.getState().room?.players.length === count;
    }, { count: 9 });
    await page.evaluate(async ({ path, roomFixture }) => {
      const { useStore, emptyHand } = await import('/src/shared/store.ts');
      const { startHand } = await import('/@fs' + path);
      useStore.getState().setRoom(roomFixture);
      const seats = roomFixture.players.map((p) => p.seat);
      useStore.getState().resetHand({ ...emptyHand, handId: 'badge-probe', seats: roomFixture.players, myCards: [0, 1],
        betting: startHand(seats.map((seat) => ({ seat, stack: 2000 })), 0, 10, 20) });
      useStore.getState().setWsConnected(true);
    }, { path: sharedPath, roomFixture: room });
    await page.waitForSelector('button[aria-haspopup="dialog"]', { timeout: 5000 }).catch(async (e) => { console.error('URL', page.url(), 'BODY', (await page.locator('body').innerText()).slice(0, 2000), 'ERRORS', errors); throw e; });
    await page.locator('button[aria-haspopup="dialog"]').nth(1).click();
    await page.waitForTimeout(500);
    await page.waitForSelector('[data-streak-tier="hot2"]', { timeout: 5000 }).catch(async (e) => { console.error('HUD BODY', (await page.locator('body').innerText()).slice(-1000), 'ERRORS', errors); throw e; });
    await page.waitForFunction(() => document.querySelectorAll('[data-streak-tier]').length === 7);
    const data = await page.evaluate(() => {
      const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
      const rows = [...document.querySelectorAll('.table-pod-name-row')].map((row) => ({
        // Narrow canvas intentionally uses display:contents for this wrapper;
        // use the nearest positioned pod as the same local container there.
        row: rect(row).width ? rect(row) : rect(row.closest('[class*="absolute"]')), name: rect(row.querySelector('.table-pname')), badges: rect(row.querySelector('.table-seat-badges')), tier: row.querySelector('[data-streak-tier]')?.getAttribute('data-streak-tier') || null,
      }));
      return { viewport: `${innerWidth}x${innerHeight}`, rows, badgeCount: document.querySelectorAll('[data-streak-tier]').length,
        fontsReady: document.fonts.status === 'loaded', visibleTiers: [...document.querySelectorAll('[data-streak-tier]')].map((e) => e.getAttribute('data-streak-tier')) };
    });
    const measured = data.rows.filter((r) => r.badges).map((r) => ({ ...r, nameGap: r.badges.left - r.name.right, containerGap: r.row.right - r.badges.right }));
    const failures = measured.flatMap((r, i) => [
      (vp.width === 1440 && r.name.right > r.badges.left + 1) ? `row${i} name overlaps badge (${r.name.right} > ${r.badges.left})` : null,
      r.badges.right > r.row.right + 1 ? `row${i} badge overflows row (${r.badges.right} > ${r.row.right})` : null,
      (vp.width === 1440 && r.nameGap < MIN_GAP) ? `row${i} nameGap ${r.nameGap} < ${MIN_GAP}` : null,
    ].filter(Boolean));
    if (data.badgeCount !== 7) failures.push(`badgeCount=${data.badgeCount}, expected 7 (hidden/low-sample seats excluded)`);
    if (!data.visibleTiers.includes('hot2') || !data.visibleTiers.includes('cold2')) failures.push('wide glyph tiers are missing');
    results.push({ vp: data.viewport, badgeCount: data.badgeCount, visibleTiers: data.visibleTiers, fontsReady: data.fontsReady, measured, failures });
    console.log(`${data.viewport}: badges=${data.badgeCount} ${measured.map((r) => `gap=${r.nameGap.toFixed(2)}px/room=${r.containerGap.toFixed(2)}px`).join(' ')}`);
    await page.screenshot({ path: `${out}/streak-badge-${vp.width}x${vp.height}.png` });
    await ctx.close();
  }
} finally { await browser.close(); }

const report = { meta: { gitHash, probeHash, locale: LOCALE, fontsReady: results.every((r) => r.fontsReady), generatedAt: new Date().toISOString() }, results };
await writeFile(`${out}/streak-badge-layout.json`, JSON.stringify(report, null, 2));
console.log(`meta: git=${gitHash ?? 'n/a'} probe=${probeHash} locale=${LOCALE} fontsReady=${report.meta.fontsReady}`);
if (errors.length) { console.error(`PAGE ERRORS:\n${errors.join('\n')}`); process.exitCode = 1; }
const failures = results.flatMap((r) => r.failures.map((f) => `${r.vp}: ${f}`));
if (ASSERT && failures.length) { console.error(`ASSERT FAIL (${failures.length}):\n${failures.join('\n')}`); process.exitCode = 1; }
if (ASSERT && !failures.length) console.log('assertions: PASS');
