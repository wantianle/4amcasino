/** Focused paid-peek UI evidence.
 * Uses the real TablePage/RoundTable components and injects a completed-hand
 * store snapshot plus mock server frames through the page. No real WS/server
 * state is used; the only mocked frames are room_state and the store's
 * peek_offer/peek_result-equivalent state.
 *
 *   BASE_URL=http://127.0.0.1:5357
 *   PEEK_OUTPUT=/tmp/4am-table-peek
 */
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const chromium = pw.chromium ?? pw.default?.chromium;
const base = process.env.BASE_URL || 'http://127.0.0.1:5357';
const out = process.env.PEEK_OUTPUT || '/tmp/4am-table-peek';
await mkdir(out, { recursive: true });

function makeRoom(mode = 'primary') {
  const players = Array.from({ length: 4 }, (_, seat) => ({
    seat: mode === 'spectator' && seat === 0 ? null : seat,
    userId: seat === 0 ? 2 : mode === 'seat-reuse' && seat === 1 ? 901 : 100 + seat,
    username: `player${seat}`,
    displayName: seat === 0 ? '我' : `玩家${seat + 1}`,
    stack: 2000, connected: true, sittingOut: false, totalBought: 2000,
    privateStats: false, avatarVersion: 0, publicKey: '', pendingBuy: 0,
  }));
  return {
  t: 'room_state',
  room: {
    id: 'peek-evidence', name: 'Peek evidence', joinCode: 'PEEK01', hostId: 2,
    bankerId: 2, sb: 10, bb: 20, auditMode: 'private', actionTimeoutMs: 30000,
    actionSecs: null, coBankerId: null, minSettleHands: 0, sevenDeuceBonus: 0,
    voided: false, autoApproveBuys: false, tvReplays: false,
    commissionBps: 0,
  },
  players,
  handActive: false,
  };
}

function makeHand(room, mode = 'primary') {
  const participants = mode === 'nonparticipant' ? room.players.slice(1) : room.players;
  const seats = participants
    .filter((p) => p.seat !== null)
    .map((p) => ({ seat: p.seat, userId: p.userId === 901 ? 101 : p.userId, username: p.username, publicKey: '', stack: p.stack }));
  return {
  t: 'hand_end', handId: 'peek-hand', head: 'peek-head',
  stacks: room.players.filter((p) => p.seat !== null).map((p) => ({ seat: p.seat, stack: p.stack })),
  deltas: room.players.filter((p) => p.seat !== null).map((p) => ({ seat: p.seat, delta: p.seat === 0 ? 60 : -20 })),
  seats,
  };
}

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/google-chrome',
  args: ['--no-sandbox'],
});

function rectOf(box) {
  return { left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height };
}

function intersects(a, b) {
  const ar = rectOf(a);
  const br = rectOf(b);
  return ar.left < br.right && ar.right > br.left && ar.top < br.bottom && ar.bottom > br.top;
}

async function run(view, width, height, mode = 'primary', capture = true) {
  const room = makeRoom(mode === 'seat-reuse' ? 'primary' : mode);
  const result = makeHand(room, mode);
  const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
  await ctx.addInitScript((uid) => localStorage.setItem('4am-auth', JSON.stringify({
    state: { auth: { token: 'peek-fixture', userId: uid, username: 'me', identity: null } }, version: 0,
  })), 2);
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (error) => console.log(`${view} pageerror`, error.message));
  page.on('console', (message) => { if (message.type() === 'error') console.log(`${view} console`, message.text()); });
  await page.route('**/api/**', (route) => route.fulfill({ json: { features: null, requests: [] } }));
  await page.routeWebSocket('**/*', (ws) => ws.onMessage((data) => {
    if (JSON.parse(String(data)).t === 'join_room') ws.send(JSON.stringify(room));
  }));
  await page.goto(`${base}/room/${room.room.id}`);
  await page.waitForSelector('.table-app-bg');
  await page.evaluate(async ({ room, result }) => {
    const { useStore, emptyHand } = await import('/src/shared/store.ts');
    const seats = result.seats;
    useStore.getState().setAuth({
      token: 'peek-fixture', userId: 2, username: 'me',
      identity: { publicKey: '', secretKey: '' },
    });
    useStore.getState().setRoom(room);
    useStore.getState().resetHand({
      ...emptyHand, handId: 'peek-hand', seats, myCards: [0, 1],
      myCardPoints: [{ deckIndex: 0, point: '00' }, { deckIndex: 1, point: '01' }],
      result, shown: {}, peekOffers: [], peekResults: {},
    });
    useStore.getState().setWsConnected(true);
  }, { room, result });

  console.log(`${view}/${mode} state`, await page.evaluate(async () => {
    const { useStore } = await import('/src/shared/store.ts');
    const s = useStore.getState();
    return { user: s.auth.userId, room: s.room?.players.map((p) => [p.userId, p.seat]), hand: { id: s.hand.handId, result: !!s.hand.result, seats: s.hand.seats.length } };
  }));
  await page.waitForTimeout(500);
  const eyeSeats = await page.locator('[data-testid^="peek-eye-"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')));
  if (mode === 'spectator') {
    if (eyeSeats.length !== 0) throw new Error(`${view}/${mode}: spectator rendered peek eyes`);
    await page.evaluate(() => import('/src/shared/gameClient.ts').then(({ handle }) => handle({ t: 'peek_result', offerId: 'spectator', handId: 'peek-hand', targetSeat: 1, status: 'accepted', amount: 20, cards: [12, 13] })));
    const leaked = await page.evaluate(async () => (await import('/src/shared/store.ts')).useStore.getState().hand.peekResults);
    if (Object.keys(leaked).length !== 0) throw new Error(`${view}/${mode}: spectator retained private cards`);
    await ctx.close();
    return;
  }
  const expectedSeats = ['peek-eye-1', 'peek-eye-2', 'peek-eye-3'];
  for (const expected of expectedSeats) if (!eyeSeats.includes(expected)) throw new Error(`${view}/${mode}: missing ${expected}`);
  const boxes = [];
  for (const testid of expectedSeats) {
    const eyeLocator = page.locator(`[data-testid="${testid}"]`);
    const eye = await eyeLocator.boundingBox();
    const cards = await eyeLocator.locator('xpath=ancestor::div[contains(@class,"table-pod-visual")]').locator('.table-pod-holo').boundingBox();
    if (!eye || !cards) throw new Error(`${view}/${mode}: missing ${testid} rectangles`);
    if (intersects(eye, cards) || eye.y + eye.height > cards.y + 1) throw new Error(`${view}/${mode}: ${testid} overlaps or is below hand cards`);
    boxes.push({ testid, eye, cards });
  }
  if (capture) await page.screenshot({ path: `${out}/${view}-eye.png`, fullPage: true });

  const offers = (n) => Array.from({ length: n }, (_, i) => ({
    offerId: `offer-${i}`, fromUserId: 200 + i, fromName: `请求者${i + 1}`, amount: 20,
  }));
  for (const n of [1, 3]) {
    await page.evaluate((frames) => Promise.all([
      import('/src/shared/store.ts'),
      import('/src/shared/gameClient.ts'),
    ]).then(([{ useStore }, { handle }]) => {
      useStore.getState().patchHand({ peekOffers: [] });
      for (const frame of frames) handle({ t: 'peek_offer', ...frame });
    }), offers(n).map((offer) => ({ ...offer, handId: 'peek-hand', targetSeat: 0 })));
    await page.locator('[data-testid="peek-incoming-banner"] summary').waitFor();
    const banner = page.locator('[data-testid="peek-incoming-banner"]');
    const collapsed = await banner.boundingBox();
    const table = await page.locator('.table-canvas').boundingBox();
    if (!collapsed || !table) throw new Error(`${view}: missing banner/table rectangle`);
    await banner.locator('summary').click();
    const expanded = await banner.boundingBox();
    const center = await page.locator('.table-center-col').boundingBox();
    if (!expanded || !center) throw new Error(`${view}: missing expanded/banner rectangles`);
    if (expanded.height > 144) throw new Error(`${view}: banner exceeded max height`);
    if (intersects(expanded, center)) throw new Error(`${view}: banner overlaps center table column`);
    if (capture) await page.screenshot({ path: `${out}/${view}-offers-${n}.png`, fullPage: true });
    await banner.locator('summary').click();
  }

  await page.evaluate(() => import('/src/shared/gameClient.ts').then(({ handle }) => handle({
    t: 'peek_result', offerId: 'offer-0', handId: 'peek-hand', targetSeat: 1,
    status: 'accepted', amount: 20, cards: [12, 13],
  })));
  await page.waitForTimeout(100);
  const stored = await page.evaluate(async () => (await import('/src/shared/store.ts')).useStore.getState().hand.peekResults);
  assert.deepEqual(stored[1], { targetSeat: 1, targetUserId: 101, targetName: '玩家2', cards: [12, 13] });
  assert.equal(await page.locator('[data-testid="seat-pod-1"] .table-pod-holo [role="img"][data-card-face]').count(), 2);
  if (mode === 'nonparticipant') {
    console.log(`${view}/nonparticipant: direct state assertion passed`, JSON.stringify(stored[1]));
    await page.screenshot({ path: `${out}/${view}-nonparticipant-state.png`, fullPage: true });
  }
  if (mode === 'seat-reuse') {
    await page.screenshot({ path: `${out}/${view}-seat-reuse-before.png`, fullPage: true });
    await page.evaluate(async (room) => {
      const { handle } = await import('/src/shared/gameClient.ts');
      handle({ ...room, players: room.players.map((p) => p.seat === 1
        ? { ...p, userId: 901, username: 'replacement', displayName: '新占座者' } : p) });
    }, room);
    await page.waitForFunction(() => document.querySelector('[data-testid="seat-pod-1"]')?.textContent.includes('新占座者'));
    assert.equal(await page.locator('[data-testid="seat-pod-1"] .table-pod-holo [role="img"][data-card-face]').count(), 0, 'replacement must not render old private cards');
    assert.equal(await page.locator('[data-testid="peek-eye-1"]').count(), 0);
    assert.equal(await page.locator('.table-peek-body b').innerText(), '玩家2', 'drawer must retain the original owner name');
    await page.screenshot({ path: `${out}/${view}-seat-reuse-after.png`, fullPage: true });
    console.log(`${view}/seat-reuse: pre-reuse faces=2; replacement faces=0; drawer owner=玩家2`);
  }
  const revealed = await page.locator('[data-testid="peek-eye-1"]').count();
  if (revealed !== 0) throw new Error(`${view}: eye remained after private reveal`);
  if (capture) await page.screenshot({ path: `${out}/${view}-result.png`, fullPage: true });
  console.log(`${view}/${mode}: targets=${JSON.stringify(boxes)} offers=1,3 bannerMax=144px centerOverlap=0 resultEyeCount=${revealed}`);
  await ctx.close();
}

try {
  await run('desktop', 1440, 900);
  await run('phone', 390, 844);
  await run('desktop', 1440, 900, 'nonparticipant', false);
  await run('desktop', 1440, 900, 'seat-reuse', false);
  await run('desktop', 1440, 900, 'spectator', false);
  await run('phone', 390, 844, 'nonparticipant', false);
  await run('phone', 390, 844, 'seat-reuse', false);
} finally {
  await browser.close();
}
