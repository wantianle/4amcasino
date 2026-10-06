/** Browser evidence for the room close/archive lifecycle.
 *
 * Three assertions, all against a REAL render (Vite dev server + mocked
 * transport), because the copy and the "app disappears from the listings"
 * behaviour are exactly what the user asked for:
 *
 *   1. host close is an in-app Dialog (never window.confirm), whose copy says
 *      "关闭并归档（不删除任何数据）", and confirming POSTs /close then leaves
 *      for /lobby;
 *   2. a member viewing an archived room gets the explicit "房主已关闭并归档
 *      本房间" notice and a way back to the lobby;
 *   3. the sidebar "你的牌桌" and the lobby's live grid hide the archived room,
 *      while the lobby's explicit "Archived tables" section still reaches it.
 *
 *   PLAYWRIGHT_MODULE   path to a Playwright install (default 'playwright-core')
 *   BROWSER_EXECUTABLE  Chrome binary (default /usr/bin/google-chrome)
 *   BASE_URL            dev server (default http://localhost:5173)
 *   UAT_OUTPUT          screenshot directory (default /tmp/4am-room-close)
 */
import { mkdir, writeFile } from 'node:fs/promises';

const require = (await import('node:module')).createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const chromium = pw.chromium ?? pw.default?.chromium;
const base = process.env.BASE_URL || 'http://localhost:5173';
const out = process.env.UAT_OUTPUT || '/tmp/4am-room-close';
await mkdir(out, { recursive: true });

const MY_USER = 2;
const ROOM = 'ROOMLIVE';

function roomState(archived) {
  return {
    t: 'room_state',
    room: {
      id: ROOM,
      name: 'Evidence Table',
      joinCode: 'EVID01',
      hostId: MY_USER,
      bankerId: MY_USER,
      sb: 10,
      bb: 20,
      auditMode: 'private',
      actionTimeoutMs: 45000,
      actionSecs: 45,
      coBankerId: null,
      minSettleHands: 0,
      sevenDeuceBonus: 0,
      voided: false,
      autoApproveBuys: true,
      tvReplays: false,
      commissionBps: 50,
      archived,
      archivedAt: archived ? Date.now() : null,
    },
    players: [
      {
        seat: 0,
        userId: MY_USER,
        username: 'alex',
        displayName: 'Alex',
        avatarVersion: 0,
        publicKey: 'b'.repeat(64),
        stack: 2000,
        sittingOut: false,
        connected: true,
        totalBought: 2000,
        privateStats: false,
        pendingBuy: 0,
      },
      {
        seat: 1,
        userId: 101,
        username: 'bob',
        displayName: 'Bob',
        avatarVersion: 0,
        publicKey: 'b'.repeat(64),
        stack: 1500,
        sittingOut: false,
        connected: true,
        totalBought: 1500,
        privateStats: false,
        pendingBuy: 0,
      },
    ],
    handActive: false,
  };
}

const results = { dialogs: [], nativeDialogs: [], closeCalls: 0, notes: [] };
const errors = [];

async function newPage(browser, { onWsJoin, myRoomsBody }) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
  });
  await ctx.addInitScript((uid) => {
    localStorage.setItem('4am.locale', JSON.stringify({ state: { locale: 'zh-CN' }, version: 0 }));
    localStorage.setItem(
      '4am-auth',
      JSON.stringify({
        state: { auth: { token: 'room-close-fixture', userId: uid, username: 'alex', identity: null } },
        version: 0,
      }),
    );
    localStorage.setItem('4am-sounds', 'off');
  }, MY_USER);
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => {
    results.nativeDialogs.push(d.type());
    void d.dismiss().catch(() => {});
  });
  await page.route('**/api/**', (route) => {
    const url = route.request().url();
    const method = route.request().method();
    if (url.includes('/api/my-rooms')) {
      return route.fulfill({ json: myRoomsBody });
    }
    if (url.includes('/api/rooms/') && url.endsWith('/close') && method === 'POST') {
      results.closeCalls++;
      return route.fulfill({
        json: { ok: true, roomId: ROOM, archived: true, closedAt: Date.now(), alreadyClosed: false, handActive: false },
      });
    }
    return route.fulfill({
      json: {
        ok: true,
        userId: MY_USER,
        username: 'alex',
        displayName: 'Alex',
        isPlatform: false,
        rooms: [],
        requests: [],
        rows: [],
        friends: [],
        incoming: [],
        outgoing: [],
        invites: [],
        hands: [],
        points: [],
        stats: { net: 0, handsPlayed: 0, biggestWin: 0 },
      },
    });
  });
  await page.routeWebSocket('**/*', (ws) =>
    ws.onMessage((data) => {
      const msg = JSON.parse(String(data));
      if (msg.t === 'join_room') ws.send(JSON.stringify(onWsJoin()));
    }),
  );
  return { ctx, page };
}

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/google-chrome',
  args: ['--no-sandbox'],
});

try {
  // ── 1. Host close: in-app Dialog, not window.confirm ────────────────────
  {
    const { ctx, page } = await newPage(browser, {
      onWsJoin: () => roomState(false),
      myRoomsBody: { rooms: [] },
    });
    await page.goto(`${base}/room/${ROOM}`);
    await page.waitForSelector('[data-testid="table-more"]');
    await page.click('[data-testid="table-more"]');
    await page.click('[data-testid="table-close-room"]');
    const dialog = page.locator('[role="dialog"]', { hasText: '关闭并归档' });
    await dialog.waitFor({ state: 'visible' });
    const dialogText = await dialog.innerText();
    results.dialogs.push(dialogText);
    if (!dialogText.includes('不删除任何数据')) throw new Error('close dialog missing "不删除任何数据"');
    await page.screenshot({ path: `${out}/01-close-dialog.png` });
    await page.click('[data-testid="table-close-confirm"]');
    await page.waitForURL('**/lobby', { timeout: 15000 });
    results.notes.push('close confirm navigated to /lobby');
    if (results.nativeDialogs.length) throw new Error('native confirm fired');
    if (results.closeCalls !== 1) throw new Error(`close route called ${results.closeCalls} times`);
    await ctx.close();
  }

  // ── 2. Member sees the "closed and archived" notice ────────────────────
  {
    const { ctx, page } = await newPage(browser, {
      onWsJoin: () => roomState(true),
      myRoomsBody: { rooms: [] },
    });
    await page.goto(`${base}/room/${ROOM}`);
    const notice = page.locator('[role="dialog"]', { hasText: '房主已关闭并归档本房间' });
    await notice.waitFor({ state: 'visible' });
    const noticeText = await notice.innerText();
    results.dialogs.push(noticeText);
    if (!noticeText.includes('没有删除任何数据')) throw new Error('archive notice missing "没有删除任何数据"');
    await page.screenshot({ path: `${out}/02-archive-notice.png` });
    await page.click('[data-testid="table-archive-back"]');
    await page.waitForURL('**/lobby', { timeout: 15000 });
    results.notes.push('archive notice navigated to /lobby');
    await ctx.close();
  }

  // ── 3. Sidebar + lobby hide the archived room; explicit section keeps it ─
  {
    const { ctx, page } = await newPage(browser, {
      onWsJoin: () => roomState(false),
      myRoomsBody: {
        rooms: [
          { id: 'ROOMLIVE', name: 'Active Table', joinCode: 'LIVE01', sb: 10, bb: 20, archived: 0, playerCount: 2 },
          { id: 'ROOMDEAD', name: 'Closed Table', joinCode: 'DEAD01', sb: 10, bb: 20, archived: 1, playerCount: 2 },
        ],
      },
    });
    await page.goto(`${base}/lobby`);
    await page.waitForSelector('aside.zeus-sidebar');
    // The sidebar defaults to rail mode, and in rail mode the "your tables"
    // links are not mounted until the rail trigger opens the drawer. Expand it
    // (waiting for the trigger also proves the my-rooms fetch has landed).
    const tableTrigger = page.locator('aside.zeus-sidebar .zeus-table-trigger');
    await tableTrigger.waitFor({ state: 'visible' });
    await tableTrigger.click();
    await page.waitForSelector('aside.zeus-sidebar #rail-table-links', { state: 'visible' });
    const sideLive = await page.locator('aside.zeus-sidebar a[href="/room/ROOMLIVE"]').count();
    const sideDead = await page.locator('aside.zeus-sidebar a[href="/room/ROOMDEAD"]').count();
    if (sideLive !== 1) throw new Error(`sidebar missing live room (${sideLive})`);
    if (sideDead !== 0) throw new Error(`sidebar leaked archived room (${sideDead})`);
    const lobbyLive = await page.locator('a[href="/room/ROOMLIVE"]').count();
    const lobbyDead = await page.locator('a[href="/room/ROOMDEAD"]').count();
    const archivedExplicit = await page.locator('a[href="/room/ROOMDEAD/ledger"]').count();
    if (lobbyLive < 1) throw new Error('lobby missing live room');
    if (lobbyDead !== 0) throw new Error('lobby live grid leaked archived room');
    if (archivedExplicit < 1) throw new Error('explicit archived section missing');
    results.notes.push(`sidebar live=${sideLive} archived=${sideDead}; lobby live=${lobbyLive} archived=${lobbyDead} explicit=${archivedExplicit}`);
    await page.screenshot({ path: `${out}/03-lobby-hides-archived.png`, fullPage: true });
    await ctx.close();
  }
} finally {
  await browser.close();
}

await writeFile(`${out}/result.json`, JSON.stringify({ ...results, errors, out }, null, 2));
if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
console.log(JSON.stringify({ ...results, errors, out }, null, 2));
