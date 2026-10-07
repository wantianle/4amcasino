#!/usr/bin/env node
/**
 * Real-data browser acceptance for the /history page (战绩).
 *
 * Boots the REAL server in-process against an isolated temp DB file (never the
 * default 4amcasino.db), plays real hands between a real `HeadlessClient` human
 * and real server-driven bots over the real WS / mental-poker / ledger paths,
 * then voids one settled hand through the real banker API. Finally it drives a
 * headless Chrome against the built web app and asserts the /history list and
 * the per-room hand page render the same numbers the API reports - including
 * the void exclusion - and writes screenshots + a JSON report to
 * docs/qa/history/.
 *
 * The point is anti-mock: every asserted number comes from a hand that was
 * actually dealt and settled, and the voided hand is excluded by the real
 * shared void-correlation helper (handProjection), not by front-end filtering.
 *
 * Run:
 *   node --import tsx apps/server/test/historyE2E.mjs
 *   HANDS=3 OUT=docs/qa/history node --import tsx apps/server/test/historyE2E.mjs
 *
 * Config (env): HANDS (default 3), BOTS (default 2), OUT (default docs/qa/history),
 *   BROWSER_EXECUTABLE (default /usr/bin/google-chrome).
 */
import { randomBytes, scryptSync, createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { attachHub } from '../src/hub.js';
import { BotSupervisor } from '../src/botSupervisor.js';
import { HeadlessClient, buildDecisionView } from '@4am/agent-core';

const require = createRequire(import.meta.url);
const pw = require('playwright-core');
const chromium = pw.chromium ?? pw.default?.chromium;

const HANDS = Math.max(2, Number(process.env.HANDS || 3));
const BOTS = Math.max(1, Math.min(4, Number(process.env.BOTS || 2)));
const OUT = process.env.OUT || 'docs/qa/history';
const BASE_URL = process.env.BASE_URL || '';
const BROWSER = process.env.BROWSER_EXECUTABLE || '/usr/bin/google-chrome';

mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[history-e2e]', ...a);
const assert = (cond, msg) => {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
};

// ------------------------------------------------------------- crypto ------
// Mirror the web deriveIdentity so the browser can be handed the SAME account
// the HeadlessClient logs in as (token + ed25519 identity in localStorage).
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
function deriveCredentials(username, password) {
  const seed = scryptSync(password, `4am/id/${username}`, 32, SCRYPT);
  const authKey = scryptSync(password, `4am/auth/${username}`, 32, SCRYPT).toString('hex');
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return {
    authKey,
    publicKey: spki.subarray(spki.length - 32).toString('hex'),
    secretKey: seed.toString('hex'),
  };
}

const fmtNum = (n) => new Intl.NumberFormat('zh-CN').format(n);
const netLabel = (n) => (n === 0 ? '±0' : `${n > 0 ? '+' : '−'}${fmtNum(Math.abs(n))}`);

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(40);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

const botStatus = (db, botId) =>
  db.prepare('SELECT status FROM bot_accounts WHERE id = ?').get(botId)?.status ?? null;

// --------------------------------------------------------------- main ------
const dbPath = join(tmpdir(), `4am-history-${randomBytes(5).toString('hex')}.db`);
process.env.BOT_IDENTITY_KEY = 'cd'.repeat(32);
if (!process.env.BOT_THINK_ENABLED) process.env.BOT_THINK_ENABLED = '0';

const ctx = createApp(dbPath);
attachHub(ctx.app, ctx.db, {
  cryptoTimeoutMs: 2500,
  actionTimeoutMs: 4000,
  autoDealMs: 3_600_000,
  readyCheckMs: 2000,
});
const baseUrl = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
const supervisor = new BotSupervisor(ctx.db, {
  baseUrl,
  maxConcurrent: BOTS,
  runner: { graceMs: 8_000, pollMs: 25 },
  log: () => {},
});
ctx.botControl.hooks = supervisor;

const username = `hist${randomBytes(4).toString('hex')}`;
const password = randomBytes(12).toString('hex');
const creds = deriveCredentials(username, password);
const human = new HeadlessClient(baseUrl, username, password);

let browser = null;
let context = null;
let page = null;
const pageErrors = [];
const consoleErrors = [];
const shots = [];

try {
  await human.login();
  assert(human.token, 'human logged in with a token');
  assert(human.userId > 0, 'human has a userId');
  log(`registered ${username} (userId ${human.userId})`);

  const room = await human.api('/api/rooms', { name: 'History QA', sb: 10, bb: 20 }, 'POST');
  const roomId = room.id;
  await human.connect(roomId);
  human.send({ t: 'sit', seat: 0 });
  const buy = await human.api(`/api/rooms/${roomId}/buy`, { amount: 4000 });
  await human.api(`/api/rooms/${roomId}/approve`, { requestId: buy.id, approve: true });
  await waitFor(
    () => {
      const p = human.room?.players.find((x) => x.userId === human.userId);
      return p?.seat !== null && p?.seat !== undefined && p.stack > 0;
    },
    15_000,
    'human seated + funded',
  );

  const bots = [];
  for (let i = 0; i < BOTS; i++) {
    const created = await human.api(`/api/rooms/${roomId}/bots`, {
      seat: i + 1,
      initialBuyIn: 4000,
      policyKind: 'scripted',
      name: `HistBot${i + 1}`,
    });
    bots.push(created.bot);
  }
  for (const b of bots) await human.api(`/api/rooms/${roomId}/bots/${b.id}/start`, {});
  await waitFor(
    () =>
      bots.every((b) => {
        const p = human.room?.players.find((x) => x.userId === b.userId);
        return botStatus(ctx.db, b.id) === 'running' && !!p?.connected && p.stack > 0;
      }),
    20_000,
    'bots running + connected + funded',
  );
  log(`room ${roomId} ready with ${bots.length} bots`);

  const driveHuman = (prevHandId, maxMs) =>
    (async () => {
      const deadline = Date.now() + maxMs;
      const settled = () => (human.result && human.result.handId !== prevHandId) || human.abort;
      while (Date.now() < deadline && !settled()) {
        await human.waitForTurn(100);
        if (settled()) break;
        if (!human.isResynced) continue;
        if (!human.myTurn()) continue;
        const view = buildDecisionView(human);
        if (!view.legalActions) continue;
        try {
          human.act({ type: view.legalActions.canCheck ? 'check' : 'call' });
        } catch {
          // the table advanced between the check and the send
        }
      }
    })();

  for (let h = 0; h < HANDS; h++) {
    const prev = human.result?.handId ?? null;
    human.send({ t: 'start_hand' });
    const driver = driveHuman(prev, 90_000);
    try {
      await waitFor(
        () => (human.result && human.result.handId !== prev) || human.abort,
        90_000,
        `hand ${h + 1} settled`,
      );
    } catch (err) {
      log(
        `stuck: handId=${human.handId} myTurn=${human.myTurn()} resynced=${human.isResynced} ` +
          `players=${JSON.stringify((human.room?.players ?? []).map((p) => ({ u: p.userId, seat: p.seat, st: p.stack, c: p.connected })))}`,
      );
      throw err;
    }
    await driver;
    if (human.abort) throw new Error(`hand aborted: ${JSON.stringify(human.abort)}`);
    log(`hand ${h + 1} settled: ${human.result.handId}`);
  }

  // Real void path: the banker (the human) reverses the newest settled hand.
  // Its settlement ref is the transcript head, so this also proves the live
  // convention. (The hand_id-only convention is covered by the server unit
  // tests; the read model uses the same shared helper for both.)
  const beforeVoid = await human.api(`/api/rooms/${roomId}/hands`);
  const voidedHandId = beforeVoid.hands[0].handId;
  await human.api(`/api/rooms/${roomId}/void-hand`, { handId: voidedHandId });
  log(`voided ${voidedHandId}`);

  // ---- API truth (the numbers the page must render) ----------------------
  const meRooms = await human.api('/api/me/rooms');
  const roomRow = meRooms.rooms.find((r) => r.roomId === roomId);
  assert(roomRow, 'room appears in /api/me/rooms');
  const handsAfter = await human.api(`/api/rooms/${roomId}/hands`);
  const voidedRow = handsAfter.hands.find((h) => h.handId === voidedHandId);
  assert(voidedRow?.voided === true, 'voided hand is flagged voided by the API');
  assert(handsAfter.total === HANDS, `transcript total is ${HANDS}, got ${handsAfter.total}`);
  assert(roomRow.myHands === HANDS - 1, `myHands is ${HANDS - 1}, got ${roomRow.myHands}`);
  const expectedPageNet = handsAfter.hands
    .filter((h) => !h.voided)
    .reduce((s, h) => s + (h.myNet ?? 0), 0);
  log(
    `API truth: myHands=${roomRow.myHands} myNet=${roomRow.myNet} pageNet=${expectedPageNet} total=${handsAfter.total}`,
  );

  // ---- browser -----------------------------------------------------------
  browser = await chromium.launch({
    headless: true,
    executablePath: BROWSER,
    args: ['--no-sandbox'],
  });
  context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    reducedMotion: 'reduce',
  });
  await context.addInitScript(
    (blob) => {
      localStorage.setItem('4am-auth', JSON.stringify(blob));
      localStorage.setItem('4am-sounds', 'off');
      localStorage.setItem('4am.locale', JSON.stringify({ state: { locale: 'zh-CN' }, version: 0 }));
    },
    {
      state: {
        auth: {
          token: human.token,
          userId: human.userId,
          username,
          identity: { publicKey: creds.publicKey, secretKey: creds.secretKey },
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

  // /history: the room row must show the real hand count and net.
  await page.goto(`${baseUrl}/history`, { waitUntil: 'domcontentloaded' });
  const roomLink = page.locator(`a[href="/history/${roomId}"]`).first();
  await roomLink.waitFor({ timeout: 30_000 });
  await sleep(500);
  const rowText = await roomLink.evaluate((el) => el.parentElement?.textContent ?? '');
  assert(rowText.includes('History QA'), `history row shows room name; got "${rowText}"`);
  assert(
    rowText.includes(`${roomRow.myHands} 手`),
    `history row shows ${roomRow.myHands} hands; got "${rowText}"`,
  );
  assert(
    rowText.includes(netLabel(roomRow.myNet)),
    `history row shows net ${netLabel(roomRow.myNet)}; got "${rowText}"`,
  );
  await shot('01-history-list');

  // /history/:roomId: the voided hand is badged, and the page net excludes it.
  await roomLink.click();
  await page.waitForURL(`**/history/${roomId}`, { timeout: 20_000 });
  await page.getByText('作废').first().waitFor({ timeout: 20_000 });
  const bodyText = await page.locator('#app-content').innerText();
  assert(bodyText.includes(voidedHandId.slice(0, 8)), 'room page lists the voided hand id');
  assert(
    bodyText.includes(netLabel(expectedPageNet)),
    `room page net is ${netLabel(expectedPageNet)}; got "${bodyText.slice(0, 400)}"`,
  );
  await shot('02-history-room-voided');

  // ---- fixtures for pagination / tie-break / room-switch coverage ---------
  // A room with more hands than one page, and five transcripts sharing one
  // millisecond, written through the real schema into the same isolated DB.
  const insTranscript = ctx.db.prepare(
    'INSERT INTO transcripts (hand_id, room_id, head, entries, ts) VALUES (?, ?, ?, ?, ?)',
  );
  const pagedRoom = await human.api('/api/rooms', { name: 'Paged Room', sb: 5, bb: 10 }, 'POST');
  const PAGED_HANDS = 21;
  for (let i = 0; i < PAGED_HANDS; i++) {
    insTranscript.run(
      `paged-${String(i).padStart(3, '0')}`,
      pagedRoom.id,
      `phead${i}`,
      '[]',
      10_000 + i,
    );
  }
  const tieRoom = await human.api('/api/rooms', { name: 'Tie Room', sb: 5, bb: 10 }, 'POST');
  for (const id of ['t1', 't2', 't3', 't4', 't5']) {
    insTranscript.run(id, tieRoom.id, `thead_${id}`, '[]', 20_000);
  }

  // ---- same-ts hands sort stably by hand_id (no dup / no gap across pages) --
  const tiePage = async (offset) => {
    const r = await human.api(`/api/rooms/${tieRoom.id}/hands?limit=2&offset=${offset}`);
    return r.hands.map((h) => h.handId);
  };
  const tieP1 = await tiePage(0);
  const tieP2 = await tiePage(2);
  const tieP3 = await tiePage(4);
  assert(JSON.stringify(tieP1) === JSON.stringify(['t5', 't4']), `tie page 1: ${tieP1}`);
  assert(JSON.stringify(tieP2) === JSON.stringify(['t3', 't2']), `tie page 2: ${tieP2}`);
  assert(JSON.stringify(tieP3) === JSON.stringify(['t1']), `tie page 3: ${tieP3}`);
  assert(new Set([...tieP1, ...tieP2, ...tieP3]).size === 5, 'tie pages cover all hands, no dupes');
  log('same-ts ordering: t5,t4 | t3,t2 | t1');

  // ---- room switch resets the hand offset (no stale out-of-range page) -----
  const handsRequests = [];
  page.on('request', (req) => {
    if (/\/api\/rooms\/[^/]+\/hands\?/.test(req.url())) handsRequests.push(req.url());
  });
  await page.goto(`${baseUrl}/history/${pagedRoom.id}`, { waitUntil: 'domcontentloaded' });
  const olderBtn = page.getByRole('button', { name: '更早 →' });
  await olderBtn.waitFor({ timeout: 30_000 });
  await olderBtn.click();
  await page.getByText('2/2').first().waitFor({ timeout: 20_000 });
  // Switch to another room on the SAME route without remounting (pushState +
  // popstate is how React Router sees a param-only navigation).
  await page.evaluate((next) => {
    window.history.pushState(null, '', next);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, `/history/${roomId}`);
  await page.waitForFunction((expected) => location.pathname === expected, `/history/${roomId}`, {
    timeout: 10_000,
  });
  await page.getByText('作废').first().waitFor({ timeout: 20_000 });
  const switchedBody = await page.locator('#app-content').innerText();
  assert(
    !switchedBody.includes('这个房间还没有手牌'),
    'room switch reset offset: room B did not render the empty state',
  );
  assert(switchedBody.includes(voidedHandId.slice(0, 8)), 'room switch loaded room B hands');
  assert(
    handsRequests.some((u) => u.includes(`/api/rooms/${roomId}/hands?`) && u.includes('offset=0')),
    'room switch requested room B from offset 0',
  );
  await shot('03-history-room-switch');

  // ---- more rooms than one page, then server-side paging + filters --------
  const EXTRA_ROOMS = 22;
  for (let i = 0; i < EXTRA_ROOMS; i++) {
    await human.api('/api/rooms', { name: `Bulk ${String(i).padStart(2, '0')}`, sb: 5, bb: 10 }, 'POST');
  }
  // Close the main room so the archived filter has a deterministic row.
  await human.api(`/api/rooms/${roomId}/close`, {});

  const firstPage = await human.api('/api/me/rooms?limit=20&offset=0');
  const roomTotal = firstPage.total;
  assert(roomTotal >= EXTRA_ROOMS + 3, `room total spans pages: ${roomTotal}`);
  assert(firstPage.rooms.length === 20, `first room page holds 20, got ${firstPage.rooms.length}`);
  assert(firstPage.hasMore === true, 'first room page reports hasMore');
  const secondPage = await human.api('/api/me/rooms?limit=20&offset=20');
  assert(secondPage.hasMore === false, 'last room page reports hasMore=false');
  const firstIds = new Set(firstPage.rooms.map((r) => r.roomId));
  assert(
    secondPage.rooms.every((r) => !firstIds.has(r.roomId)),
    'room pages do not repeat rows',
  );
  const allIds = [...firstPage.rooms, ...secondPage.rooms].map((r) => r.roomId);
  assert(new Set(allIds).size === roomTotal, 'every room appears exactly once across pages');
  log(`room paging: total=${roomTotal} page1=20 page2=${secondPage.rooms.length}`);

  const meRoomsRequests = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/me/rooms')) meRoomsRequests.push(req.url());
  });
  await page.goto(`${baseUrl}/history`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '更早 →' }).waitFor({ timeout: 30_000 });
  const listHrefs = () =>
    page.locator('a[href^="/history/"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
  const LAST_PAGE_ROOMS = roomTotal - 20;
  // Wait for a settled page before harvesting links: a React commit can be
  // observed mid-flight by evaluateAll, yielding a torn snapshot.
  await page.waitForFunction(
    (n) => document.querySelectorAll('a[href^="/history/"]').length === n,
    20,
    { timeout: 20_000 },
  );
  const pageOne = await listHrefs();
  assert(pageOne.length === 20, `history page 1 lists 20 rooms, got ${pageOne.length}`);
  await page.getByRole('button', { name: '更早 →' }).click();
  await page.waitForFunction(
    ({ n, text }) =>
      document.body.innerText.includes(text) &&
      document.querySelectorAll('a[href^="/history/"]').length === n,
    { n: LAST_PAGE_ROOMS, text: '第 2/2 页' },
    { timeout: 20_000 },
  );
  const pageTwo = await listHrefs();
  assert(
    pageTwo.length === LAST_PAGE_ROOMS,
    `history page 2 lists ${LAST_PAGE_ROOMS} rooms, got ${pageTwo.length}`,
  );
  const overlap = pageTwo.filter((href) => pageOne.includes(href));
  assert(
    overlap.length === 0,
    `history page 2 has no overlap with page 1: overlap=${JSON.stringify(overlap)}`,
  );
  await shot('04-history-paged');

  // archived filter: the closed main room is the only archived room.
  await page.getByRole('button', { name: '已归档' }).click();
  await page.getByRole('link', { name: /查看「History QA」的战绩/ }).waitFor({ timeout: 20_000 });
  const archivedLinks = await listHrefs();
  assert(
    archivedLinks.length === 1 && archivedLinks[0] === `/history/${roomId}`,
    `archived filter shows only the closed room: ${JSON.stringify(archivedLinks)}`,
  );
  assert(
    meRoomsRequests.some((u) => u.includes('archived=true')),
    'archived filter is applied server-side',
  );
  await shot('05-history-archived-filter');

  // active filter: same server-side query, the archived room drops out.
  await page.getByRole('button', { name: '进行中' }).click();
  await page.waitForFunction(
    (selector) => document.querySelectorAll(selector).length === 0,
    `a[href="/history/${roomId}"]`,
    { timeout: 20_000 },
  );
  assert(
    meRoomsRequests.some((u) => u.includes('archived=false')),
    'active filter is applied server-side',
  );
  await shot('06-history-active-filter');

  assert(pageErrors.length === 0, `page errors: ${pageErrors.join(' | ')}`);
  assert(consoleErrors.length === 0, `console errors: ${consoleErrors.join(' | ')}`);

  const report = {
    runId: new Date().toISOString(),
    dbPath,
    baseUrl,
    roomId,
    voidedHandId,
    config: { HANDS, BOTS },
    api: {
      myHands: roomRow.myHands,
      myNet: roomRow.myNet,
      total: handsAfter.total,
      pageNet: expectedPageNet,
      voidedFlagged: voidedRow.voided,
      handCount: handsAfter.hands.length,
    },
    pagination: {
      roomTotal,
      firstPageCount: firstPage.rooms.length,
      firstPageHasMore: firstPage.hasMore,
      secondPageCount: secondPage.rooms.length,
      secondPageHasMore: secondPage.hasMore,
    },
    tieBreak: { page1: tieP1, page2: tieP2, page3: tieP3 },
    roomSwitchOffsetReset: true,
    filters: { archived: true, active: true },
    browser: { historyRowText: rowText, roomHasVoidBadge: true },
    screenshots: shots,
    pageErrors,
    consoleErrors,
  };
  writeFileSync(`${OUT}/history-e2e-report.json`, JSON.stringify(report, null, 2));
  log('PASS');
  log(`report: ${OUT}/history-e2e-report.json`);
} finally {
  await supervisor.stopAll().catch((e) => log(`stopAll failed: ${e.message}`));
  human.close();
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await ctx.app.close().catch(() => {});
}
