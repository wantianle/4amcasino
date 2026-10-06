/** Browser evidence for the two pending-wiring entry points (player stats, account devices). */
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const base = process.env.BASE_URL || 'http://127.0.0.1:5183';
const out = process.env.UAT_OUTPUT || '/tmp/4am-pending-wiring-evidence';
await mkdir(out, { recursive: true });
const assert = (ok, message) => { if (!ok) throw new Error(`ASSERTION FAILED: ${message}`); };
const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

const metric = (hits, opportunities) => ({ hits, opportunities, pct: hits / opportunities * 100, unit: 'pct' });
const stats = {
  userId: 7, metricVersion: 2, sample: 42, minHands: 20, sufficient: true,
  stats: { vpip: metric(18, 42), pfr: metric(12, 42), threeBet: metric(4, 30), fourBet: metric(1, 8), cbet: metric(11, 18), foldToCbet: metric(3, 10), af: metric(24, 12), afq: metric(30, 42), wwsf: metric(20, 42), wsd: metric(8, 16), bb100: { hits: 850, opportunities: 42, pct: 20.2, unit: 'bb/100' }, net: { hits: 340, opportunities: 42, pct: 340, unit: 'chips' } },
  dataQuality: { exact: 42, legacy: 0, partial: 0, total: 42 },
  byPosition: {}, byStreet: {}, byIpOop: { ip: { sample: 42, stats: {} }, oop: { sample: 42, stats: {} } }, trend: [], approximations: [],
};
for (const p of ['BTN', 'CO', 'SB', 'BB']) stats.byPosition[p] = { sample: 42, stats: stats.stats };
stats.stats.af = { hits: 24, opportunities: 12, pct: 2, unit: 'ratio' };
for (const p of ['ip', 'oop']) stats.byIpOop[p].stats = stats.stats;
for (const p of ['preflop', 'flop', 'turn', 'river']) stats.byStreet[p] = { sample: 42, af: metric(24, 12), afq: metric(30, 42) };

const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    localStorage.setItem('4am-auth', JSON.stringify({ state: { auth: { token: 'evidence-fixture', userId: 2, username: 'alex', identity: null, isPlatform: false } }, version: 0 }));
    localStorage.setItem('4am.locale', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => { errors.push(e.message); console.error('PAGE ERROR', e.message); });
  let statsMode = 'full';
  let sessionsMode = 'list';
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/users/7/profile') return route.fulfill(json({ userId: 7, username: 'river', displayName: 'River', createdAt: 1700000000000, joinNumber: 7, memberCount: 20, rivals: [], transactions: [], stats: null }));
    if (path.endsWith('/best-hand')) return route.fulfill(json({ hand: null }));
    if (path === '/api/friends') return route.fulfill(json({ friends: [], incoming: [], outgoing: [] }));
    if (path.endsWith('/shared-rooms')) return route.fulfill(json({ rooms: [] }));
    if (path === '/api/me/profile' || path === '/api/profile') return route.fulfill(json({ username: 'alex', displayName: 'Alex', bio: '', avatar: null }));
    if (path === '/api/me/preferences') return route.fulfill(json({ preferences: {} }));
    if (path === '/api/me/sessions') return route.fulfill(json({ sessions: sessionsMode === 'list' ? [{ id: 'current-device', createdAt: 1700000000000, current: true }, { id: 'laptop-session', createdAt: 1700000100000, current: false }] : [] }));
    if (path === '/api/me/sessions/revoke-others') { sessionsMode = 'empty'; return route.fulfill(json({ revoked: 1 })); }
    if (path === '/api/users/7/stats') return route.fulfill(json(statsMode === 'full' ? stats : statsMode === 'empty' ? { ...stats, sample: 0 } : { hidden: true, userId: 7 }));
    if (path === '/api/me') return route.fulfill(json({ userId: 7, username: 'alex', displayName: 'Alex', rooms: [], requests: [], friends: [], isPlatform: false }));
    return route.fulfill(json({ ok: true }));
  });

  await page.goto(`${base}/players/7`);
  await page.getByText('Detailed hand statistics').waitFor();
  const fullText = await page.locator('body').textContent();
  assert(/VPIP/.test(fullText) && /PFR/.test(fullText) && fullText.includes('42.86%') && fullText.includes('28.57%') && /42 public hands/.test(fullText), 'full player stats render VPIP/PFR values and sample');
  console.log('PLAYER full: PASS — textContent contains VPIP 42.86%, PFR 28.57%, 42 public hands');
  await page.screenshot({ path: `${out}/player-full-stats.png`, fullPage: true });
  statsMode = 'hidden'; await page.reload(); await page.getByText('This player has not made detailed statistics public.').waitFor();
  assert((await page.locator('body').textContent()).includes('This player has not made detailed statistics public.'), 'hidden player state');
  assert(!(await page.locator('body').textContent()).includes('VPIP'), 'hidden stats do not leak metrics');
  console.log('PLAYER hidden: PASS — hidden-state friendly text rendered');
  await page.screenshot({ path: `${out}/player-hidden-stats.png`, fullPage: true });
  statsMode = 'empty'; await page.reload(); await page.getByText('There is not enough public hand data yet.').waitFor();
  assert((await page.locator('body').textContent()).includes('There is not enough public hand data yet.'), 'no-sample state');
  console.log('PLAYER empty: PASS — no-sample text rendered');
  await page.screenshot({ path: `${out}/player-empty-stats.png`, fullPage: true });

  await page.goto(`${base}/settings#account`);
  await page.getByText('Signed-in devices').waitFor();
  console.log('DEVICES DOM:', (await page.locator('body').textContent()).match(/current-device|laptop-session|Sign out everywhere else|Could not load signed-in devices\./g));
  assert((await page.locator('body').textContent()).includes('current-device') && (await page.locator('body').textContent()).includes('laptop-session') && (await page.locator('body').textContent()).includes('Sign out everywhere else'), 'session list and revoke control');
  console.log('DEVICES list: PASS — current-device, laptop-session, Sign out everywhere else');
  await page.screenshot({ path: `${out}/settings-devices-list.png`, fullPage: true });
  await page.getByRole('button', { name: 'Sign out everywhere else' }).click();
  await page.getByText('Signed out 1 other session(s).').waitFor();
  assert(!(await page.locator('body').textContent()).includes('laptop-session'), 'other sessions removed after revoke');
  console.log('DEVICES revoke: PASS — other session removed and confirmation rendered');
  sessionsMode = 'empty'; await page.reload(); await page.getByText('No signed-in devices found.').waitFor();
  assert((await page.locator('body').textContent()).includes('No signed-in devices found.'), 'empty devices state');
  console.log('DEVICES empty: PASS — empty-state text rendered');
  await page.screenshot({ path: `${out}/settings-devices-empty.png`, fullPage: true });
  assert(errors.length === 0, `page errors: ${JSON.stringify(errors)}`);
  console.log('PAGE ERRORS: 0');
} finally { await browser.close(); }
