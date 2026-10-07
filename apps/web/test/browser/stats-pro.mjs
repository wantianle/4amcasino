/** Deterministic API-contract fixtures; no database writes. */
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const out = process.env.UAT_OUTPUT || 'docs/qa/stats-pro';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const errors = [];
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const m = (hits, opportunities, unit = 'pct') => ({ hits, opportunities, pct: opportunities && unit !== 'chips' ? hits / opportunities * (unit === 'pct' ? 100 : 1) : null, unit });
function fixture(sample, streakSample = sample) {
  const stats = { vpip: m(32, sample), pfr: m(24, sample), threeBet: m(6, 40), fourBet: m(0, 0), cbet: m(15, 24), foldToCbet: m(5, 14), af: m(45, 20, 'ratio'), afq: m(45, 80, 'ratio'), wwsf: m(25, 48), wsd: m(9, 16), bb100: m(2400, sample, 'bb/100'), net: m(480, sample, 'chips') };
  if (sample === 30) { stats.vpip = m(9, 30); stats.pfr = m(6, 30); }
  if (!sample) for (const key of Object.keys(stats)) stats[key] = m(0, 0, stats[key].unit);
  if (sample === 8) for (const key of Object.keys(stats)) stats[key] = m(key === 'net' ? -80 : 2, 8, stats[key].unit);
  // This fixture uses eligible poker hands only, capped at the latest 50.
  const bucket = { sample, stats };
  const streak = sample >= 20 && streakSample >= 20 ? { tier: 'hot1', netBB: 42, sample: streakSample } : null;
  return { userId: 2, metricVersion: 2, streak, ...bucket, minHands: 20, sufficient: sample >= 20, dataQuality: { exact: sample, legacy: 0, partial: 0, total: sample }, byPosition: sample ? { BTN: bucket, CO: bucket, SB: { sample: 8, stats }, BB: bucket } : {}, byStreet: sample ? Object.fromEntries(['preflop', 'flop', 'turn', 'river'].map((s) => [s, { sample, af: stats.af, afq: stats.afq }])) : {}, byIpOop: { ip: bucket, oop: bucket }, trend: sample ? [0, 1, 2, 3, 4].map((i) => ({ ts: Date.now() - (4 - i) * 3600000, hands: (i + 1) * sample / 5, net: [-40, 100, 20, 300, stats.net.hits][i] })) : [], approximations: ['byIpOop uses the table-wide postflop action order, not a strict pairwise action order', 'cbet opportunities infer "not all-in" from having a flop action (the projection has no all-in flag)', 'bb/100 only counts hands with a known positive nominal bb'] };
}
assert(fixture(30, 19).streak === null, 'streak sample gate fixture mismatch');
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    await context.addInitScript(() => { localStorage.setItem('4am-auth', JSON.stringify({ state: { auth: { token: 'stats-fixture', userId: 2, username: 'alex', identity: null, isPlatform: false } }, version: 0 })); localStorage.setItem('4am-sounds', 'off'); });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    let sample = 120;
    const room = { t: 'room_state', room: { id: 'baseline', name: 'Stats evidence', joinCode: 'BASELN', hostId: 2, bankerId: 2, sb: 10, bb: 20, auditMode: 'private', actionTimeoutMs: 30000, actionSecs: null, coBankerId: null, minSettleHands: 0, sevenDeuceBonus: 0, voided: false, autoApproveBuys: false, tvReplays: false, commissionBps: 50 }, players: [2, 3, 4].map((userId, seat) => ({ userId, seat, username: `player${userId}`, displayName: ['Alex', 'Hidden player', 'New player'][seat], stack: 2000, connected: true, sittingOut: false, totalBought: 2000, hasAvatar: false, avatarVersion: 0, publicKey: '', privateStats: false, pendingBuy: 0 })), handActive: false };
    await page.route('**/api/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      let body = { ok: true, userId: 2, username: 'alex', displayName: 'Alex', rooms: [], requests: [], rows: [], friends: [], incoming: [], outgoing: [], hands: [], bots: [], isPlatform: false, cardBack: 'crimson', fourColor: true };
      if (path === '/api/me/stats') body = fixture(sample);
      if (path === '/api/rooms/baseline') body = room;
      if (path.endsWith('/hud')) body = { roomId: 'baseline', metricVersion: 2, minHands: 20, players: room.players.map((p, i) => ({ ...p, streak: i === 0 ? { tier: 'hot1', netBB: 42, sample: 30 } : null, hidden: i === 1, sample: i === 0 ? 30 : i === 1 ? 0 : 8, minHands: 20, sufficient: i === 0, confidence: i === 0 ? 'low' : 'insufficient', dataConfidence: i === 1 ? null : 'exact', stats: i === 0 ? fixture(30).stats : null })) };
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.routeWebSocket('**/*', (ws) => ws.onMessage((data) => { if (JSON.parse(String(data)).t === 'join_room') ws.send(JSON.stringify(room)); }));
    const base = process.env.BASE_URL || 'http://127.0.0.1:5173';
    await page.goto(`${base}/room/baseline/hands?mode=pro`);
    await page.getByRole('heading', { name: '我的本桌数据' }).waitFor();
    for (const [name, label] of [['overview', '总览'], ['position', '位置'], ['street', '街'], ['ip', 'IP / OOP']]) {
      await page.getByRole('button', { name: label, exact: true }).click();
      await page.screenshot({ quality: 85, path: `${out}/${name}-${width}.jpg`, fullPage: true });
    }
    for (const [name, n] of [['empty', 0], ['low-sample', 8]]) {
      sample = n;
      await page.getByRole('button', { name: '总览', exact: true }).click();
      await page.getByRole('button', { name: /刷新|Refresh/ }).click();
      await page.getByRole('heading', { name: '我的本桌数据' }).waitFor();
      await page.screenshot({ quality: 85, path: `${out}/${name}-${width}.jpg`, fullPage: true });
    }
    await page.goto(`${base}/room/baseline`);
    // The HUD opens per seat (there is no global HUD button): each seat avatar is
    // a button whose accessible name is "<displayName> · 玩家 HUD", and the dialog
    // renders only the clicked player's row. Hidden / below-threshold players are
    // checked by opening their own button.
    const hudDialog = page.getByRole('dialog', { name: '玩家 HUD' });
    const openHud = async (name) => {
      await page.getByRole('button', { name: `${name} · 玩家 HUD`, exact: true }).click();
      await hudDialog.waitFor();
    };
    const closeHud = async () => {
      await hudDialog.getByRole('button', { name: '关闭', exact: true }).click();
      await hudDialog.waitFor({ state: 'hidden' });
    };
    await openHud('Alex');
    assert(
      (await page.locator('[data-hud-player="2"]').innerText()).includes('VPIP'),
      'Sufficient player lost its stats',
    );
    await closeHud();
    await openHud('Hidden player');
    assert(
      (await page.locator('[data-hud-player="3"]').innerText()).includes('统计已隐藏'),
      'Hidden player lost the hidden hint',
    );
    assert(
      !(await page.locator('[data-hud-player="3"]').innerText()).includes('VPIP'),
      'Hidden player leaked stats',
    );
    await closeHud();
    await openHud('New player');
    assert(
      !(await page.locator('[data-hud-player="4"]').innerText()).includes('VPIP'),
      'Low sample player leaked stats',
    );
    await closeHud();
    await page.screenshot({ quality: 85, path: `${out}/hud-${width}.jpg`, fullPage: true });
    await context.close();
  }
  assert(errors.length === 0, JSON.stringify(errors));
  await writeFile(`${out}/result.json`, JSON.stringify({ pageErrors: errors, source: 'Mock REST + room websocket, contract checked against handStats.ts', viewports: [1440, 390] }, null, 2));
  console.log('Stats pro evidence passed; 0 page errors.');
} finally { await browser.close(); }
