/** Settlement-failure recovery banner evidence (host vs non-host) across a
 *  REAL page refresh and a REAL client `join_room`.
 *
 * The WS transport is mocked, but it behaves like the real server: it answers
 * each `join_room` with `room_state`, and after the refresh it re-asserts the
 * frozen settlement in the exact server order - `settlement_failed` FIRST, then
 * `hand_start` (GameRoom.resendPending). No frame is injected by hand: the
 * banner must appear from the refresh's own join/replay, which is precisely the
 * ordering that used to wipe the failure via `resetHand()`.
 *
 * A full real-server run is not used here because the durable-write failure is
 * only reachable through `attachHub({ faultInjection })`, a test-only option
 * that production does not expose; the real-WS ordering is instead pinned by
 * the server integration test "a reconnect re-asserts a frozen settlement
 * failure".
 *
 *   BASE_URL=http://127.0.0.1:5699
 *   SETTLE_OUTPUT=/tmp/4am-settlement-failed
 */
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const chromium = pw.chromium ?? pw.default?.chromium;
const base = process.env.BASE_URL || 'http://127.0.0.1:5699';
const out = process.env.SETTLE_OUTPUT || '/tmp/4am-settlement-failed';
await mkdir(out, { recursive: true });

const HOST_USER = 2;
const GUEST_USER = 3;
const HAND = 'settle-evidence-hand';

function makeRoom() {
  const players = [HOST_USER, GUEST_USER, 4, 5].map((userId, seat) => ({
    seat,
    userId,
    username: `player${seat}`,
    displayName: seat === 0 ? '房主' : `玩家${seat + 1}`,
    stack: 2000,
    connected: true,
    sittingOut: false,
    totalBought: 2000,
    privateStats: false,
    avatarVersion: 0,
    publicKey: '',
    pendingBuy: 0,
  }));
  return {
    t: 'room_state',
    room: {
      id: 'settle-evidence',
      name: 'Settlement evidence',
      joinCode: 'SETL01',
      hostId: HOST_USER,
      bankerId: HOST_USER,
      sb: 10,
      bb: 20,
      auditMode: 'private',
      actionTimeoutMs: 45000,
      actionSecs: 45,
      coBankerId: null,
      minSettleHands: 0,
      sevenDeuceBonus: 0,
      voided: false,
      meetLink: null,
      autoApproveBuys: false,
      tvReplays: false,
      commissionBps: 0,
    },
    players,
    handActive: true,
  };
}

/** The server's replay on a reconnect: the frozen settlement before hand_start. */
const FAILURE = {
  t: 'settlement_failed',
  handId: HAND,
  reason: 'SQLITE_BUSY: database is locked',
  attempt: 1,
  retrying: false,
};

const HAND_START = {
  t: 'hand_start',
  handId: HAND,
  // Two OTHER seats: the fixture has no signing identity, and a seated client
  // would try to sign a key_commit. A spectator still receives the public
  // hand_start, which is all this ordering test needs (the failure is stored
  // before the spectator short-circuit).
  seats: [
    { seat: 0, userId: 4, username: 'player0', publicKey: '', stack: 2000 },
    { seat: 1, userId: 5, username: 'player1', publicKey: '', stack: 2000 },
  ],
  buttonSeat: 0,
  sb: 10,
  bb: 20,
  auditMode: 'private',
};

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/google-chrome',
  args: ['--no-sandbox'],
});

async function run(view, userId, { expectRetry }) {
  const room = makeRoom();
  const outgoing = [];
  // Count joins so the failure replay only happens on the post-refresh connect,
  // exactly like a real client that has state to reconcile.
  let joins = 0;
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
  });
  await ctx.addInitScript(
    (uid) =>
      localStorage.setItem(
        '4am-auth',
        JSON.stringify({
          state: { auth: { token: 'settle-fixture', userId: uid, username: 'me', identity: null } },
          version: 0,
        }),
      ),
    userId,
  );
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (e) => console.log(`${view} pageerror`, e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`${view} console`, m.text());
  });
  await page.route('**/api/**', (route) =>
    route.fulfill({ json: { features: null, requests: [] } }),
  );
  await page.routeWebSocket('**/*', (ws) => {
    ws.onMessage((data) => {
      // Record every frame the page emits so the test can prove the retry click
      // actually reaches the wire, not just changes a button label.
      const msg = JSON.parse(String(data));
      outgoing.push(msg);
      if (msg.t !== 'join_room') return;
      joins += 1;
      ws.send(JSON.stringify(room));
      if (joins >= 2) {
        // The (re)connect after the refresh: re-assert the frozen settlement
        // BEFORE the hand context, in the server's resendPending order.
        ws.send(JSON.stringify(FAILURE));
        ws.send(JSON.stringify(HAND_START));
      }
    });
  });
  await page.goto(`${base}/room/${room.room.id}`);
  await page.waitForSelector('.table-app-bg');
  // The host gate requires a live socket; wait for the transport to settle
  // (React StrictMode briefly mounts/closes a first connection).
  const wsLive = async () =>
    page.waitForFunction(async () => {
      const { useStore } = await import('/src/shared/store.ts');
      return useStore.getState().wsConnected;
    });
  await wsLive();
  await page.waitForTimeout(500);
  await wsLive();

  // A REAL refresh: a brand-new client with no hand state in memory.
  await page.reload();
  await page.waitForSelector('.table-app-bg');
  // Let React StrictMode's mount/unmount/mount churn settle before trusting
  // `wsConnected`; otherwise the click races a closing first socket and the
  // host gate correctly (but unhelpfully for the test) refuses to send.
  await page.waitForTimeout(800);
  await wsLive();
  await page.waitForSelector('[data-testid="settlement-failed-banner"]');
  const retryButtons = await page.locator('[data-testid="settlement-retry-button"]').count();
  const waiting = await page.locator('[data-testid="settlement-waiting-host"]').count();
  const title = await page
    .locator('[data-testid="settlement-failed-banner"] p')
    .first()
    .innerText();
  console.log(
    `${view}: afterRefresh title=${JSON.stringify(title)} retryButton=${retryButtons} waitingHost=${waiting} joins=${joins}`,
  );
  if (retryButtons + waiting < 1) {
    throw new Error(`${view}: refresh must surface the settlement banner`);
  }

  if (expectRetry) {
    if (retryButtons !== 1) throw new Error(`${view}: host must see exactly one retry button`);
    if (waiting !== 0) throw new Error(`${view}: host must not see the waiting-for-host line`);
    // REAL click: the host's recovery control must emit `retry_settlement`.
    await page.locator('[data-testid="settlement-retry-button"]').click();
    // The click's handler updates the store in the same tick it sends; waiting
    // for the in-flight render guarantees the frame has already left.
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="settlement-retry-button"]'),
    );
    const sends = outgoing.filter((m) => m.t === 'retry_settlement');
    if (sends.length !== 1) {
      throw new Error(`${view}: click must emit exactly one retry_settlement, got ${sends.length}`);
    }
    if (Object.keys(sends[0]).length !== 1) {
      throw new Error(
        `${view}: retry_settlement must carry no payload: ${JSON.stringify(sends[0])}`,
      );
    }
    const afterTitle = await page
      .locator('[data-testid="settlement-failed-banner"] p')
      .first()
      .innerText();
    console.log(
      `${view}: afterClick retry_settlement=${sends.length} title=${JSON.stringify(afterTitle)}`,
    );
  } else {
    if (retryButtons !== 0) throw new Error(`${view}: non-host must not see a retry button`);
    if (waiting !== 1) throw new Error(`${view}: non-host must see the waiting-for-host line`);
    // Even a direct call from the page must be gated: no frame leaves.
    await page.evaluate(async () => {
      const { retrySettlement } = await import('/src/shared/gameClient.ts');
      retrySettlement();
    });
    await page.waitForTimeout(250);
    const sends = outgoing.filter((m) => m.t === 'retry_settlement');
    if (sends.length !== 0) {
      throw new Error(`${view}: non-host must never emit retry_settlement, got ${sends.length}`);
    }
    console.log(`${view}: direct retrySettlement() gated, retry_settlement=${sends.length}`);
  }
  const allOutgoing = outgoing.map((m) => m.t).join(',');
  console.log(`${view}: outgoing=[${allOutgoing}]`);
  const path = `${out}/${view}.png`;
  await page.screenshot({ path, fullPage: true });
  await ctx.close();
  return path;
}

try {
  const host = await run('host', HOST_USER, { expectRetry: true });
  const guest = await run('non-host', GUEST_USER, { expectRetry: false });
  console.log(`host screenshot: ${host}`);
  console.log(`non-host screenshot: ${guest}`);
} finally {
  await browser.close();
}
