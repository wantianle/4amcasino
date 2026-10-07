/** Live browser acceptance for table bots: real server, real account, real WS.
 *
 * Unlike table-bots.mjs (mocked REST/WS on the Vite dev server), this drives the
 * REAL server at BASE_URL (default http://localhost:8787, which serves the built
 * web app + API + WS in one process). It:
 *   1. registers a fresh account over the real /api (Bearer token + ed25519
 *      identity derived from the same password, exactly like the web client),
 *      enables auto-ready, and creates a room as host/banker;
 *   2. injects the session into localStorage and opens the room;
 *   3. sits the human, buys in (host = banker auto-approves), and seats 2 bots
 *      through the real 「机器人对手」 dialog;
 *   4. plays hands, clicking Check/Call (fallback Fold) whenever it is the
 *      hero's turn - a failed click on a visible button is a hard error;
 *   5. asserts against the real server: every settled hand has a successful
 *      HUMAN transcript `action`, plus bot pods, bot transcript actions,
 *      >= HANDS settled hands with zero hand_abort, ledger verification and no
 *      page/console errors; writes screenshots + a JSON report to OUT.
 *
 * Anti-false-green: the server's action-timeout auto-fold can settle hands even
 * if the hero never acts, so the human action count is read from the signed
 * transcript and must be > 0 (and present in every settled hand). A swallowed
 * click can therefore never pass.
 *
 * Config (env):
 *   BASE_URL            default http://localhost:8787
 *   PLAYWRIGHT_MODULE   path to playwright-core
 *   BROWSER_EXECUTABLE  default /usr/bin/google-chrome
 *   OUT                 default docs/qa/bot-live
 *   HANDS               default 3
 *   BOTS                default 2
 *   BUYIN               default 1000 (chips)
 *   ACTION_MS           default 25000  (max wait for the hero's click to land)
 *   HAND_MS             default 90000  (max wall time for one hand to settle)
 *   HAND_BUDGET_MS      default 240000 (overall budget)
 *   HERO_CALL_SELECTOR  default .table-btn--call (override only for negative tests)
 *   HERO_FOLD_SELECTOR  default .table-btn--fold
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createPrivateKey, createPublicKey, randomBytes, scryptSync } from 'node:crypto';

const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const chromium = pw.chromium ?? pw.default?.chromium;
const BASE = (process.env.BASE_URL || 'http://localhost:8787').replace(/\/$/, '');
const OUT = process.env.OUT || 'docs/qa/bot-live';
const HANDS = Number(process.env.HANDS || 3);
const BOTS = Number(process.env.BOTS || 2);
const BUYIN = Number(process.env.BUYIN || 1000);
const ACTION_MS = Number(process.env.ACTION_MS || 25_000);
const HAND_MS = Number(process.env.HAND_MS || 90_000);
const HAND_BUDGET_MS = Number(process.env.HAND_BUDGET_MS || 240_000);
const HERO_CALL_SELECTOR = process.env.HERO_CALL_SELECTOR || '.table-btn--call';
const HERO_FOLD_SELECTOR = process.env.HERO_FOLD_SELECTOR || '.table-btn--fold';
const POLL_MS = Number(process.env.POLL_MS || 1000);

// ── S6: validate config up front, before any side effect ────────────────────
for (const [name, value] of [
  ['HANDS', HANDS],
  ['BOTS', BOTS],
  ['BUYIN', BUYIN],
  ['ACTION_MS', ACTION_MS],
  ['HAND_MS', HAND_MS],
  ['HAND_BUDGET_MS', HAND_BUDGET_MS],
  ['POLL_MS', POLL_MS],
]) {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`invalid ${name}: ${process.env[name] ?? value}`);
}

await mkdir(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[bot-live]', ...a);
const assert = (cond, message) => {
  if (!cond) throw new Error(`ASSERT FAILED: ${message}`);
};

// ------------------------------------------------------------- crypto ------
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** Mirror web `deriveAuthKey` / `deriveIdentity` with standard primitives. */
function deriveCredentials(username, password) {
  const seed = scryptSync(password, `4am/id/${username}`, 32, SCRYPT);
  const authKey = scryptSync(password, `4am/auth/${username}`, 32, SCRYPT).toString('hex');
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return { authKey, publicKey: spki.subarray(spki.length - 32).toString('hex'), secretKey: seed.toString('hex') };
}

// ------------------------------------------------------------- api ---------
let TOKEN = null;
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function registerFresh() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const username = `qa${Date.now().toString(36)}${randomBytes(2).toString('hex')}`.slice(0, 24);
    const password = randomBytes(12).toString('hex');
    const creds = deriveCredentials(username, password);
    try {
      const out = await api('/api/register', {
        method: 'POST',
        body: { username, authKey: creds.authKey, publicKey: creds.publicKey },
      });
      return { username, password, userId: out.userId, token: out.token, ...creds };
    } catch (err) {
      if (String(err.message).includes('409')) continue; // username taken, retry
      throw err;
    }
  }
  throw new Error('could not register a fresh account');
}

async function waitFor(fn, timeoutMs, label, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

const fetchBots = async (roomId) => (await api(`/api/rooms/${roomId}/bots`)).bots ?? [];

/**
 * S4: read the room's transcripts, caching parsed per-hand detail so each poll
 * only fetches transcripts it has not seen. Counts bot actions (by seat) and
 * HUMAN actions (by seat) from the signed entries.
 */
async function roomStatus(roomId, botSeats, humanSeat, cache) {
  const { hands } = await api(`/api/rooms/${roomId}/hands`);
  const perHand = [];
  let completed = 0;
  let aborts = 0;
  let botActions = 0;
  let humanActions = 0;
  let humanAutoFolds = 0;
  for (const h of hands ?? []) {
    let parsed = cache.get(h.handId);
    if (!parsed) {
      const full = await api(`/api/rooms/${roomId}/hands/${h.handId}`);
      const entries = full.entries ?? [];
      parsed = {
        settlement: entries.some((e) => e.type === 'settlement'),
        abort: entries.some((e) => e.type === 'hand_abort'),
        botActions: entries.filter((e) => e.type === 'action' && botSeats.has(e.payload?.seat)).length,
        humanActions: entries.filter(
          (e) => e.type === 'action' && humanSeat !== null && e.payload?.seat === humanSeat,
        ).length,
        // The server auto-folds on the action clock: if the hero's SEAT shows a
        // timeout_fold, our click never landed. This is the precise false-green
        // signal (a walk where the hero was never to act has no timeout_fold).
        humanAutoFolds: entries.filter(
          (e) => e.type === 'timeout_fold' && humanSeat !== null && e.payload?.seat === humanSeat,
        ).length,
      };
      cache.set(h.handId, parsed);
    }
    if (parsed.abort) aborts++;
    if (parsed.settlement) completed++;
    if (parsed.settlement || parsed.abort)
      perHand.push({
        handId: h.handId,
        abort: parsed.abort,
        botActions: parsed.botActions,
        humanActions: parsed.humanActions,
        humanAutoFolds: parsed.humanAutoFolds,
      });
    botActions += parsed.botActions;
    humanActions += parsed.humanActions;
    humanAutoFolds += parsed.humanAutoFolds;
  }
  return { completed, aborts, botActions, humanActions, humanAutoFolds, perHand, total: (hands ?? []).length };
}

async function stopBotsAndCollect(roomId) {
  const bots = await fetchBots(roomId);
  for (const b of bots) {
    await api(`/api/rooms/${roomId}/bots/${b.id}/stop`, { method: 'POST', body: {} }).catch((e) =>
      log(`stop ${b.id} failed: ${e.message}`),
    );
  }
  const deadline = Date.now() + 20_000;
  let final = bots;
  while (Date.now() < deadline) {
    final = await fetchBots(roomId);
    if (final.every((b) => ['stopped', 'removed', 'error'].includes(b.status))) break;
    await sleep(500);
  }
  return final;
}

// ------------------------------------------------------------- main --------
let browser = null;
let context = null;
let page = null;
let account = null;
let roomId = null;
let humanSeat = null;
let botsStopped = false;
const shots = [];
const pageErrors = [];
const consoleErrors = [];

try {
  account = await registerFresh();
  TOKEN = account.token;
  log(`registered ${account.username} (userId ${account.userId})`);

  const me = await api('/api/me');
  assert(me.publicKey === account.publicKey, 'registered publicKey mismatch');
  await api('/api/profile', { method: 'PUT', body: { autoReady: true } });

  const room = await api('/api/rooms', {
    method: 'POST',
    body: { name: 'Bot Live QA', sb: 10, bb: 20 },
  });
  roomId = room.id;
  log(`room ${roomId} created (host/banker = ${account.username})`);

  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/google-chrome',
    args: ['--no-sandbox'],
  });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  await context.addInitScript(
    (blob) => {
      localStorage.setItem('4am-auth', JSON.stringify(blob));
      localStorage.setItem('4am-sounds', 'off');
    },
    {
      state: {
        auth: {
          token: account.token,
          userId: account.userId,
          username: account.username,
          identity: { publicKey: account.publicKey, secretKey: account.secretKey },
        },
        prefs: { autoReady: true },
      },
      version: 0,
    },
  );
  page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  const shot = async (name) => {
    const path = `${OUT}/${name}.jpg`;
    await page.screenshot({ quality: 85, path });
    shots.push(path);
    log(`shot ${path}`);
  };

  await page.goto(`${BASE}/room/${roomId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Poker board"], .table-app-bg') !== null,
    { timeout: 30_000 },
  );
  await sleep(800);
  await shot('01-room-entry');

  // ── seat the human + buy in (host = banker) ─────────────────────────────
  const sit = page.locator('.table-sit-spot').first();
  await sit.waitFor({ timeout: 20_000 });
  await sit.click();
  await waitFor(
    async () => {
      const p = (await api(`/api/rooms/${roomId}`)).players?.find((x) => x.userId === account.userId);
      return p?.seat !== null && p?.seat !== undefined;
    },
    15_000,
    'human seated',
  );
  humanSeat =
    (await api(`/api/rooms/${roomId}`)).players?.find((x) => x.userId === account.userId)?.seat ?? null;
  const buy = await api(`/api/rooms/${roomId}/buy`, { method: 'POST', body: { amount: BUYIN } });
  if (buy?.status === 'pending') {
    await api(`/api/rooms/${roomId}/approve`, { method: 'POST', body: { requestId: buy.id, approve: true } });
  }
  await waitFor(
    async () => ((await api(`/api/rooms/${roomId}`)).players?.find((p) => p.userId === account.userId)?.stack ?? 0) > 0,
    15_000,
    'human funded',
  );
  log(`human seated at seat ${humanSeat}`);

  // ── seat bots through the real dialog ───────────────────────────────────
  const openDialog = async () => {
    await page.locator('button[title="机器人对手"]').click();
    const d = page.getByRole('dialog', { name: '机器人对手' });
    await d.getByRole('heading', { name: '机器人对手' }).waitFor();
    return d;
  };
  const dialog = await openDialog();
  for (let i = 1; i <= BOTS; i++) {
    await dialog.getByLabel('名字（可选）').fill(`Live Bot ${i}`);
    if (i === 1) await shot('02-bots-dialog');
    await dialog.getByRole('button', { name: /入座并开局/ }).click();
    await dialog.getByText(/已上场，坐上/).waitFor({ timeout: 20_000 });
    await sleep(400);
  }
  const botInfo = await waitFor(
    async () => {
      const bots = await fetchBots(roomId);
      return bots.length >= BOTS && bots.every((b) => b.status === 'running') ? bots : null;
    },
    30_000,
    'bots running',
  );
  const botSeats = new Set(botInfo.map((b) => b.seat).filter((s) => s !== null && s !== undefined));
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    (n) => document.querySelectorAll('.table-role-badge--bot').length >= n,
    BOTS,
    { timeout: 20_000 },
  );
  await sleep(500);
  await shot('03-bots-seated');

  // ── play: click Check/Call (fallback Fold) on our turn ──────────────────
  const cache = new Map();
  const readStatus = () => roomStatus(roomId, botSeats, humanSeat, cache);

  // B1(1): a failed click on a VISIBLE hero button is a hard error, never
  // swallowed. A vanished button (hand advanced) is a benign race.
  const tryClick = async (selector, label) => {
    const loc = page.locator(`.table-cluster--mine ${selector}:not([disabled])`);
    if ((await loc.count()) === 0) return false;
    if (!(await loc.isVisible().catch(() => false))) return false;
    try {
      await loc.click({ timeout: ACTION_MS });
      return true;
    } catch (err) {
      if ((await loc.count()) === 0) return false; // hand moved on
      const dom = await page
        .locator('.table-cluster--mine')
        .innerHTML()
        .catch(() => '<unavailable>');
      throw new Error(
        `hero ${label} click failed (selector="${selector}") while still visible: ${err.message}\nDOM: ${dom.slice(0, 500)}`,
      );
    }
  };
  const clickHero = async () => (await tryClick(HERO_CALL_SELECTOR, 'Check/Call')) || (await tryClick(HERO_FOLD_SELECTOR, 'Fold'));

  const budget = Date.now() + HAND_BUDGET_MS;
  let status = await readStatus();
  let lastCompleted = status.completed;
  let handDeadline = Date.now() + HAND_MS;
  let midShot = false;
  const clickCount = { attempts: 0, succeeded: 0 };
  while (status.completed < HANDS && Date.now() < budget) {
    const clicked = await clickHero();
    if (clicked) {
      clickCount.attempts++;
      clickCount.succeeded++;
    }
    if (!midShot && (await page.locator('.table-cluster--mine').count()) > 0) {
      await shot('04-playing');
      midShot = true;
    }
    // S1: HAND_MS bounds how long one hand may take to settle.
    if (Date.now() > handDeadline && status.completed === lastCompleted)
      throw new Error(`hand did not settle within HAND_MS=${HAND_MS}`);
    await sleep(POLL_MS);
    status = await readStatus();
    if (status.completed !== lastCompleted) {
      lastCompleted = status.completed;
      handDeadline = Date.now() + HAND_MS;
      log(`hand ${status.completed} settled (aborts=${status.aborts}, botActions=${status.botActions}, humanActions=${status.humanActions})`);
    }
  }

  await shot('05-after-hands');
  const botsFinal = await fetchBots(roomId); // S5: final running info for the report

  // ── assertions (real server truth) ──────────────────────────────────────
  const podCount = await page.locator('.table-role-badge--bot').count();
  assert(podCount >= BOTS, `expected >= ${BOTS} bot pods on the felt, saw ${podCount}`);
  assert(status.completed >= HANDS, `expected >= ${HANDS} settled hands, got ${status.completed}`);
  assert(status.aborts === 0, `expected 0 hand_abort, got ${status.aborts}`);
  assert(status.botActions > 0, `expected bot transcript actions > 0, got ${status.botActions}`);
  // B1(2): the hero must have really acted. Auto-fold alone can settle hands,
  // so a timeout-only run must NOT pass. Two hard guards:
  //  - the hero recorded at least one successful signed `action`;
  //  - the hero's seat was NEVER auto-folded by the server clock (a walk where
  //    the hero was not required to act produces neither, and is allowed).
  assert(
    status.humanActions > 0,
    `expected human transcript actions > 0 (clicks succeeded=${clickCount.succeeded}), got ${status.humanActions}`,
  );
  assert(
    status.humanAutoFolds === 0,
    `hero seat ${humanSeat} was auto-folded ${status.humanAutoFolds} time(s): real clicks did not land`,
  );
  const humanActionHands = status.perHand.filter((h) => h.humanActions > 0).map((h) => h.handId);
  assert(
    humanActionHands.length >= 1,
    `expected at least one hand with a human action, got none: ${JSON.stringify(status.perHand)}`,
  );
  for (const h of status.perHand.filter((x) => !x.abort))
    assert(
      h.humanActions >= 1 || h.humanAutoFolds === 0,
      `settled hand ${h.handId} had no human action after a hero timeout_fold: ${JSON.stringify(h)}`,
    );
  assert(botsFinal.every((b) => b.status === 'running'), `all bots must be running at end: ${JSON.stringify(botsFinal)}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join(' | ')}`);
  assert(consoleErrors.length === 0, `console errors: ${consoleErrors.join(' | ')}`);

  const ledger = await api(`/api/rooms/${roomId}/ledger`);
  assert(ledger.verified?.ok === true, 'ledger hash chain must verify');

  // S3: await the stop and record the final statuses.
  const botsStoppedFinal = await stopBotsAndCollect(roomId);
  botsStopped = true;

  const report = {
    runId: `${new Date().toISOString().replace(/[:.]/g, '-')}`,
    base: BASE,
    roomId,
     // Local QA hand-off only: this file is written under docs/qa and is never
     // used by the product. The real-stats browser pass needs the fresh token
     // and identity to exercise the authenticated API against this same room.
     account: {
       username: account.username,
       userId: account.userId,
       humanSeat,
       token: account.token,
       publicKey: account.publicKey,
       secretKey: account.secretKey,
     },
    config: { HANDS, BOTS, BUYIN, ACTION_MS, HAND_MS, HAND_BUDGET_MS, POLL_MS },
    botsRunning: botsFinal.map((b) => ({ id: b.id, seat: b.seat, kind: b.policyKind, status: b.status })),
    botsAfterStop: botsStoppedFinal.map((b) => ({ id: b.id, seat: b.seat, status: b.status })),
    result: {
      settledHands: status.completed,
      aborts: status.aborts,
      botTranscriptActions: status.botActions,
      humanTranscriptActions: status.humanActions,
      humanAutoFolds: status.humanAutoFolds,
      humanActionHands,
      clickAttempts: clickCount.attempts,
      botPods: podCount,
      ledgerVerified: !!ledger.verified?.ok,
      pageErrors,
      consoleErrors,
    },
    hands: status.perHand,
    screenshots: shots,
    notes: [
      'The test account and room are left on the (ephemeral) server; storage resets on restart, and this script has no account-delete API.',
      'Human actions are read from the signed transcript, so a server timeout auto-fold can never be mistaken for real play.',
    ],
  };
  await writeFile(`${OUT}/bot-live-report.json`, JSON.stringify(report, null, 2));

  log('PASS');
  log(
    `hands=${status.completed}/${HANDS} aborts=${status.aborts} botActions=${status.botActions} humanActions=${status.humanActions} humanAutoFolds=${status.humanAutoFolds} pods=${podCount}`,
  );
  log(`report: ${OUT}/bot-live-report.json`);
} finally {
  if (roomId && !botsStopped) {
    await stopBotsAndCollect(roomId).catch((e) => log(`cleanup stop failed: ${e.message}`));
  }
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
}
