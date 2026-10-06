/** Evidence run for the two user-reported interaction fixes + bb-default amounts.
 *
 *  A - backdrop drag-selection (problem B): the old Dialog closed on any click
 *      whose event path touched the overlay. A text-selection drag that
 *      *starts* in a field and *releases* over the backdrop dispatches its
 *      `click` on the common ancestor (the overlay), and closed the dialog.
 *      Here we reproduce exactly that gesture with raw mouse events and assert
 *      the dialog stays open (the selection is checked at the drag peak, since
 *      Chrome itself collapses single-line selections once the pointer leaves
 *      the field's band) - and that a real
 *      backdrop click (press AND release on the overlay) still closes it, and
 *      Escape still closes it (keyboard path untouched).
 *  B - buy dialog opens at 100 BB (room bb=20 -> 2000), re-seeded per open.
 *  C - bots "Add chips" row expands prefilled with 100*bb and its 100 BB
 *      preset reads as selected (aria-pressed), presets still override.
 *  D - broke buy-in dialog defaults to 100 BB too.
 *
 *  Harness: Vite dev server (BASE_URL) + mocked REST/websocket, same driving
 *  style as table-bots.mjs. bb is deliberately pushed as 40 in scenario D to
 *  prove the default follows the CURRENT table, not the mount-time room.
 *
 *  PLAYWRIGHT_MODULE   path to a Playwright install (default 'playwright-core')
 *  BROWSER_EXECUTABLE  Chrome binary (default /usr/bin/google-chrome)
 *  UAT_OUTPUT          output directory (default /tmp/4am-ui-fixes)
 */
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const chromium = pw.chromium ?? pw.default?.chromium;
const base = process.env.BASE_URL || 'http://localhost:5173';
const out = process.env.UAT_OUTPUT || '/tmp/4am-ui-fixes';
await mkdir(out, { recursive: true });

const MY_USER = 2;
const BOT_A = {
  id: 'boteventeen',
  userId: 2100,
  username: 'bot_eventeen',
  displayName: 'River Bot',
  seat: 3,
  configuredSeat: 3,
  status: 'running',
  policyKind: 'scripted',
  difficulty: 'low',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  stoppedAt: null,
  stopRequestedAt: null,
  identityRecoverable: true,
};

function human(seat, userId, name, stack, extra = {}) {
  return {
    seat,
    userId,
    username: name.toLowerCase(),
    displayName: name,
    stack,
    connected: true,
    sittingOut: false,
    totalBought: 2000,
    hasAvatar: false,
    avatarVersion: 0,
    pendingBuy: 0,
    ...extra,
  };
}

function makeRoom(bb = 20, myStack = 2000) {
  return {
    t: 'room_state',
    room: {
      id: 'baseline',
      name: 'UI Fixes Evidence',
      joinCode: 'BASELN',
      hostId: MY_USER,
      bankerId: MY_USER,
      sb: bb / 2,
      bb,
      auditMode: 'private',
      actionTimeoutMs: 45000,
      actionSecs: 45,
      coBankerId: null,
      minSettleHands: 0,
      sevenDeuceBonus: 0,
      voided: false,
      autoApproveBuys: false,
      tvReplays: false,
      commissionBps: 50,
    },
    players: [
      human(0, MY_USER, 'Alex', myStack),
      human(1, 101, 'Meera', 1863),
      human(2, 102, 'Zoya', 1726),
      human(3, BOT_A.userId, BOT_A.displayName, 2000),
    ],
    handActive: false,
  };
}

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/google-chrome',
  args: ['--no-sandbox'],
});

const failures = [];
const assert = (cond, message) => {
  if (cond) console.log(`  ok - ${message}`);
  else failures.push(message), console.log(`  FAIL - ${message}`);
};

/** Fresh page on the table with a mocked room/bots. */
async function openTable({ bb = 20, myStack = 2000 } = {}) {
  const room = makeRoom(bb, myStack);
  const sockets = new Set();
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
  });
  await ctx.addInitScript(
    (uid) =>
      localStorage.setItem(
        '4am-auth',
        JSON.stringify({
          state: { auth: { token: 'ui-fixes', userId: uid, username: 'alex', identity: null } },
          version: 0,
        }),
      ),
    MY_USER,
  );
  await ctx.addInitScript(() => localStorage.setItem('4am-sounds', 'off'));
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (e) => failures.push(`pageerror: ${e.message}`));
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/rooms/baseline/bots') return json({ bots: [{ ...BOT_A }] });
    return json({
      ok: true,
      userId: MY_USER,
      username: 'alex',
      displayName: 'Alex',
      rooms: [],
      requests: [],
      rows: [],
      friends: [],
      incoming: [],
      outgoing: [],
      hands: [],
      bots: [],
      isPlatform: false,
      cardBack: 'crimson',
      fourColor: true,
    });
  });
  await page.routeWebSocket('**/*', (ws) => {
    sockets.add(ws);
    ws.onMessage((data) => {
      const msg = JSON.parse(String(data));
      if (msg.t === 'join_room') ws.send(JSON.stringify(room));
    });
  });
  await page.goto(`${base}/room/baseline`);
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Poker board"], .table-app-bg') !== null,
  );
  await page.evaluate(async () => {
    const { useStore } = await import('/src/shared/store.ts');
    const { deriveIdentity } = await import('/src/shared/crypto.ts');
    const s = useStore.getState();
    useStore.setState({
      auth: { ...s.auth, identity: deriveIdentity('alex', 'uifixes') },
      wsConnected: true,
    });
  });
  await page.waitForTimeout(600);
  return { page, ctx, room, pushRoom: () => sockets.forEach((ws) => ws.send(JSON.stringify(room))) };
}

/** Mouse-gesture helpers: these dispatch real pointer/mouse events, the only
 *  way to reproduce the LCA-click behaviour of press-in-A-release-in-B.
 *  Returns the selection measured at the DRAG PEAK, while the pointer is still
 *  inside the field: once the pointer leaves a single-line field's vertical
 *  band Chrome collapses the selection itself (verified identical on a bare
 *  page), so a post-release selection check would assert browser behaviour,
 *  not app behaviour. The product claim lives in the dialog-stays-open
 *  assertions after release. */
async function dragSelectThenReleaseOnBackdrop(page, input, backdropPoint) {
  const box = await input.boundingBox();
  // press at the first character, drag across the value ...
  await page.mouse.move(box.x + 6, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 6, box.y + box.height / 2, { steps: 8 });
  const peak = await selection(page);
  // ... continue out of the panel onto the backdrop (the exact user gesture),
  // and release there.
  await page.mouse.move(backdropPoint.x, backdropPoint.y, { steps: 8 });
  await page.mouse.up();
  return peak;
}
const selection = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return el && typeof el.selectionStart === 'number'
      ? { start: el.selectionStart, end: el.selectionEnd }
      : { start: -1, end: -1 };
  });

// ── A + B: buy dialog, backdrop gesture, 100 BB default ────────────────────
console.log('A/B — buy-chips dialog: drag-select off-panel does NOT close; backdrop click does');
{
  const { page, ctx } = await openTable();
  const dialog = page.getByRole('dialog', { name: '向银行买点数' });
  const amount = page.getByLabel('金额');
  const backdrop = { x: 40, y: 40 }; // overlay area far from the centred panel

  await page.locator('[data-testid="chips-trigger"]').click();
  await page.getByRole('menuitem', { name: '买点数' }).click();
  await dialog.getByRole('heading', { name: '向银行买点数' }).waitFor();

  // B: opens at 100 BB of the current table (bb=20 -> 2000), not the old 500
  assert((await amount.inputValue()) === '2000', `buy dialog opens at 100 BB (got ${await amount.inputValue()})`);
  await page.screenshot({ path: `${out}/01-buy-open-100bb.png` });

  // A: reproduce the reported gesture on the amount field (a number input:
  // assert the dialog survives; selection itself is asserted on the text field).
  await dragSelectThenReleaseOnBackdrop(page, amount, backdrop);
  assert(await dialog.isVisible(), 'dialog stays open after drag-select on the NUMBER field released on the backdrop');
  assert((await amount.inputValue()) === '2000', 'the off-panel drag did not alter the amount');

  // same gesture starting in the free-text note field, this time proving a
  // real selection existed at the drag peak before the off-panel release
  const note = page.getByPlaceholder('通过 UPI 付的');
  await note.fill('paid via UPI');
  const peak = await dragSelectThenReleaseOnBackdrop(page, note, backdrop);
  assert(await dialog.isVisible(), 'note-field drag also does not close the dialog');
  assert(peak.end > peak.start, `text was really selected during the drag (start=${peak.start} end=${peak.end})`);
  await page.screenshot({ path: `${out}/02-drag-off-panel-stays-open.png` });

  // ... and a REAL backdrop click (press and release both on the overlay) closes
  await page.mouse.move(backdrop.x, backdrop.y);
  await page.mouse.down();
  await page.mouse.up();
  await dialog.waitFor({ state: 'hidden' });
  assert(!(await dialog.isVisible()), 'backdrop click (press+release on overlay) still closes');
  await page.screenshot({ path: `${out}/03-backdrop-click-closes.png` });

  // keyboard path intact: Esc closes
  await page.locator('[data-testid="chips-trigger"]').click();
  await page.getByRole('menuitem', { name: '买点数' }).click();
  await dialog.getByRole('heading', { name: '向银行买点数' }).waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert(!(await dialog.isVisible()), 'Escape still closes the dialog');

  // re-seed on reopen: edit to 7, close via ✕, reopen -> back to 2000 (the
  // layout-timed reset in BankControls means the first paint already reads 2000)
  await page.locator('[data-testid="chips-trigger"]').click();
  await page.getByRole('menuitem', { name: '买点数' }).click();
  await dialog.getByRole('heading', { name: '向银行买点数' }).waitFor();
  await amount.fill('7');
  await dialog.getByRole('button', { name: '关闭' }).click();
  await page.locator('[data-testid="chips-trigger"]').click();
  await page.getByRole('menuitem', { name: '买点数' }).click();
  await dialog.getByRole('heading', { name: '向银行买点数' }).waitFor();
  assert((await amount.inputValue()) === '2000', 'reopen re-seeds to 100 BB after an edit');
  await ctx.close();
}

// ── C: bots add-chips row prefills 100*bb with the 100 BB preset selected ───
console.log('C — bots add-chips row: prefilled 100 BB, preset selected, presets still override');
{
  const { page, ctx } = await openTable();
  await page.locator('button[title="机器人对手"]').click();
  const botsDialog = page.getByRole('dialog', { name: '机器人对手' });
  await botsDialog.getByRole('heading', { name: '机器人对手' }).waitFor();

  await page.locator('button[title="给这个机器人补码"]').click();
  const chipsInput = page.getByLabel('给 River Bot 补多少筹码');
  assert(
    (await chipsInput.inputValue()) === '2000',
    `add-chips row prefills 100*bb (got ${await chipsInput.inputValue()})`,
  );
  const preset100 = botsDialog.getByRole('button', { name: '100 BB' }).first();
  assert(
    (await preset100.getAttribute('aria-pressed')) === 'true',
    '100 BB preset shows selected state on the prefilled row',
  );
  await page.screenshot({ path: `${out}/04-bots-buyrow-100bb-selected.png` });

  // presets still override, and the pressed state follows the value
  await botsDialog.getByRole('button', { name: '50 BB' }).first().click();
  assert((await chipsInput.inputValue()) === '1000', '50 BB preset overrides the default');
  assert(
    (await botsDialog.getByRole('button', { name: '50 BB' }).first().getAttribute('aria-pressed')) ===
      'true' && (await preset100.getAttribute('aria-pressed')) === 'false',
    'preset selection follows the current amount',
  );
  await chipsInput.fill('1234');
  assert(
    (await preset100.getAttribute('aria-pressed')) === 'false',
    'free-typed amount deselects every preset',
  );

  // delete copy (pending backend hard-delete)
  const del = botsDialog.getByRole('button', { name: '删除', exact: true });
  assert((await del.count()) === 1, 'bot row button reads 删除 (Delete), not 移除');
  assert((await del.getAttribute('title')) === '永久删除这个机器人', 'delete button title is 永久删除');
  await del.click();
  assert(
    (await botsDialog.getByRole('button', { name: '确认永久删除？' }).count()) === 1,
    'second tap arms the honest 确认永久删除？ confirmation',
  );
  await page.screenshot({ path: `${out}/05-bots-delete-wording.png` });
  await ctx.close();
}

// ── D: broke dialog defaults to 100 BB of the CURRENT table (bb pushed to 40)
console.log('D — broke buy-in dialog: 100 BB default, follows a late-arriving bb');
{
  // mount with NO room (bb unknown), then push bb=40: the open-time reset must
  // use the live bb, not a mount-time guess
  const room = makeRoom(40, 0); // Alex seated with stack 0 -> broke prompt
  const sockets = new Set();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(
    (uid) =>
      localStorage.setItem(
        '4am-auth',
        JSON.stringify({
          state: { auth: { token: 'ui-fixes', userId: uid, username: 'alex', identity: null } },
          version: 0,
        }),
      ),
    MY_USER,
  );
  await ctx.addInitScript(() => localStorage.setItem('4am-sounds', 'off'));
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (e) => failures.push(`pageerror(D): ${e.message}`));
  await page.route('**/api/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        userId: MY_USER,
        username: 'alex',
        displayName: 'Alex',
        rooms: [],
        requests: [],
        rows: [],
        friends: [],
        incoming: [],
        outgoing: [],
        hands: [],
        bots: [],
        isPlatform: false,
        cardBack: 'crimson',
        fourColor: true,
      }),
    }),
  );
  await page.routeWebSocket('**/*', (ws) => {
    sockets.add(ws);
    ws.onMessage((data) => {
      const msg = JSON.parse(String(data));
      if (msg.t === 'join_room') ws.send(JSON.stringify(room));
    });
  });
  await page.goto(`${base}/room/baseline`);
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Poker board"], .table-app-bg') !== null,
  );
  const broke = page.getByRole('dialog', { name: '你的筹码打光了' });
  await broke.getByRole('heading', { name: '你的筹码打光了' }).waitFor();
  const amount = broke.getByLabel('买入金额');
  assert(
    (await amount.inputValue()) === '4000',
    `broke dialog defaults to 100*bb of the live table, bb=40 -> 4000 (got ${await amount.inputValue()})`,
  );
  await page.screenshot({ path: `${out}/06-broke-dialog-100bb.png` });
  await ctx.close();
}

await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} FAILURE(S):\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
console.log(`\nALL PASS — screenshots in ${out}`);
