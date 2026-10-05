/** Real-server evidence pass for the professional statistics page.
 *
 * Run after bot-live.mjs against the same isolated server. It creates two real
 * accounts, joins the already-played room, marks one private, then loads the
 * real REST/WS-backed page without route interception. The bot-live handoff is
 * intentionally local QA evidence and is not product data.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createPrivateKey, createPublicKey, randomBytes, scryptSync } from 'node:crypto';
const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const chromium = pw.chromium ?? pw.default?.chromium;
const BASE = (process.env.BASE_URL || 'http://localhost:8787').replace(/\/$/, '');
const OUT = process.env.OUT || 'docs/qa/stats-pro';
const handoff = JSON.parse(await readFile(process.env.BOT_LIVE_REPORT || 'docs/qa/stats-pro/bot-live-report.json', 'utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (ok, message) => { if (!ok) throw new Error(`ASSERT FAILED: ${message}`); };
const errors = [];
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
function credentials(username, password) {
  const seed = scryptSync(password, `4am/id/${username}`, 32, SCRYPT);
  const authKey = scryptSync(password, `4am/auth/${username}`, 32, SCRYPT).toString('hex');
  const privateKey = createPrivateKey({ key: Buffer.concat([PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return { authKey, publicKey: spki.subarray(spki.length - 32).toString('hex'), secretKey: seed.toString('hex') };
}
async function register() {
  for (;;) {
    const username = `qa${Date.now().toString(36)}${randomBytes(2).toString('hex')}`.slice(0, 24);
    const password = randomBytes(12).toString('hex');
    const c = credentials(username, password);
    const res = await fetch(`${BASE}/api/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, authKey: c.authKey, publicKey: c.publicKey }) });
    const json = await res.json();
    if (res.status === 409) continue;
    assert(res.ok, `register failed: ${JSON.stringify(json)}`);
    return { ...c, username, userId: json.userId, token: json.token };
  }
}
async function api(token, path, options = {}) {
  const res = await fetch(`${BASE}${path}`, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const json = await res.json().catch(() => ({}));
  assert(res.ok, `${options.method || 'GET'} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}
await mkdir(OUT, { recursive: true });
const main = handoff.account;
const low = await register();
const hidden = await register();
await api(low.token, '/api/rooms/join', { method: 'POST', body: { joinCode: handoff.roomId ? (await api(main.token, `/api/rooms/${handoff.roomId}`)).joinCode : '' } });
// The join code is deliberately fetched from the real room response; no DB
// shortcuts are used. Both accounts are now real room members.
const room = await api(main.token, `/api/rooms/${handoff.roomId}`);
// If the previous join was rejected because a server omits joinCode to a stale
// room, fail loudly rather than producing a false HUD pass.
if (!room.joinCode) throw new Error('real room did not expose a join code');
await api(hidden.token, '/api/rooms/join', { method: 'POST', body: { joinCode: room.joinCode } });
await api(hidden.token, '/api/profile', { method: 'PUT', body: { privateMode: true } });
// Re-read membership after the profile write so the real HUD roster is fresh.
await sleep(300);
const hud = await api(main.token, `/api/rooms/${handoff.roomId}/hud`);
const hudById = new Map(hud.players.map((p) => [p.userId, p]));
const mainStats = await api(main.token, `/api/me/stats?roomId=${encodeURIComponent(handoff.roomId)}&minHands=20`);
assert(mainStats.sample >= 20, `expected >=20 real hands, got ${mainStats.sample}`);
assert(mainStats.stats?.vpip?.opportunities > 0, 'real VPIP opportunities missing');
assert(mainStats.stats?.pfr?.opportunities > 0, 'real PFR opportunities missing');
assert(mainStats.byPosition && Object.keys(mainStats.byPosition).length > 0, 'real byPosition missing');
assert(mainStats.byStreet && Object.keys(mainStats.byStreet).length > 0, 'real byStreet missing');
assert(mainStats.byIpOop, 'real byIpOop missing');
assert(mainStats.trend?.length > 0 && mainStats.trend.at(-1).net !== undefined, 'real trend missing');
assert(mainStats.dataQuality?.total > 0, 'real dataQuality missing');
assert(hudById.get(main.userId)?.sufficient, 'HUD sufficient player missing');
assert(hudById.get(low.userId)?.confidence === 'insufficient', 'HUD low-sample player missing');
assert(hudById.get(hidden.userId)?.hidden === true, 'HUD hidden player missing');
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  await context.addInitScript((blob) => { localStorage.setItem('4am-auth', JSON.stringify(blob)); localStorage.setItem('4am-sounds', 'off'); }, { state: { auth: { token: main.token, userId: main.userId, username: main.username, identity: { publicKey: main.publicKey, secretKey: main.secretKey } } }, version: 0 });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.goto(`${BASE}/room/${handoff.roomId}/hands?mode=pro`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: '我的本桌数据' }).waitFor();
  assert(await page.getByText(String(mainStats.sample), { exact: true }).count() > 0, 'real sample not rendered');
  assert(await page.getByText('VPIP', { exact: true }).count() > 0, 'real VPIP not rendered');
  for (const [name, label] of [['overview', '总览'], ['position', '位置'], ['street', '街'], ['ip', 'IP / OOP']]) { await page.getByRole('button', { name: label, exact: true }).click(); await page.screenshot({ path: `${OUT}/real-${name}-1440.png`, fullPage: true }); }
  await page.goto(`${BASE}/room/${handoff.roomId}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'HUD', exact: true }).click();
  await page.getByText('统计已隐藏', { exact: true }).waitFor();
  await page.screenshot({ path: `${OUT}/real-hud-1440.png`, fullPage: true });
  assert(!(await page.locator(`[data-hud-player="${hidden.userId}"]`).innerText()).includes('VPIP'), 'hidden HUD stats leaked');
  await writeFile(`${OUT}/real-result.json`, JSON.stringify({ real: true, base: BASE, roomId: handoff.roomId, accounts: { main: main.userId, low: low.userId, hidden: hidden.userId }, apiAssertions: { sample: mainStats.sample, stats: { vpip: mainStats.stats.vpip, pfr: mainStats.stats.pfr }, byPosition: Object.keys(mainStats.byPosition), byStreet: Object.keys(mainStats.byStreet), byIpOop: Object.keys(mainStats.byIpOop), trendPoints: mainStats.trend.length, dataQuality: mainStats.dataQuality }, hud: hud.players.map((p) => ({ userId: p.userId, hidden: p.hidden, sample: p.sample, sufficient: p.sufficient, confidence: p.confidence })), pageErrors: errors, screenshots: ['real-overview-1440.png', 'real-position-1440.png', 'real-street-1440.png', 'real-ip-1440.png', 'real-hud-1440.png'] }, null, 2));
  assert(errors.length === 0, `page errors: ${errors.join(' | ')}`);
  await context.close();
} finally { await browser.close(); }
console.log(`Real stats evidence passed: ${mainStats.sample} hands, VPIP ${mainStats.stats.vpip.pct}%, HUD ${hud.players.length} players, 0 page errors.`);
