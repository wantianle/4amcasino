/** Evidence for the five default quick-bet presets (33/50/75/100/150%).
 *
 *  Drives the Vite dev server with the same synthetic room + mocked transport
 *  as table-baseline.mjs, forces a my-turn preflop state with no stored
 *  `betRatios`, then asserts the action bar shows the five configured pills and
 *  records a screenshot. No real account or server state is touched.
 *
 *   PLAYWRIGHT_MODULE   path to a Playwright install (default 'playwright-core')
 *   BROWSER_EXECUTABLE  Chrome binary (default /usr/bin/google-chrome)
 *   BASE_URL            dev server (default http://localhost:5173)
 *   UAT_OUTPUT          output directory (default docs/qa/table-bet-presets)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const chromium = pw.chromium ?? pw.default?.chromium;
const base = process.env.BASE_URL || 'http://localhost:5173';
const out =
  process.env.UAT_OUTPUT ||
  fileURLToPath(new URL('../../../../docs/qa/table-bet-presets', import.meta.url));
await mkdir(out, { recursive: true });
const sharedPath = fileURLToPath(
  new URL('../../../../packages/shared/src/index.ts', import.meta.url),
);

const MY_USER = 2;
const EXPECTED = ['33%', '50%', '75%', '100%', '150%'];
const NAMES = ['Alex', 'Meera', 'Zoya', 'Ishaan', 'River', 'Jules', 'Mira', 'Sol', 'Sam'];

const COUNT = 9;
const MY_SEAT = 4;
const room = (() => ({
  t: 'room_state',
  room: {
    id: 'baseline',
    name: 'UI Baseline',
    joinCode: 'BASELN',
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
    meetLink: null,
    autoApproveBuys: false,
    tvReplays: false,
    commissionBps: 50,
  },
  players: Array.from({ length: COUNT }, (_, i) => ({
    seat: i,
    userId: i === MY_SEAT ? MY_USER : 100 + i,
    username: (i === MY_SEAT ? 'alex' : NAMES[i]).toLowerCase(),
    displayName: i === MY_SEAT ? 'Alex' : NAMES[i],
    stack: 2000 - i * 137,
    connected: true,
    sittingOut: false,
    totalBought: 2000,
    hasAvatar: false,
    avatarVersion: 0,
    pendingBuy: 0,
  })),
  handActive: true,
}))();

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/google-chrome',
  args: ['--no-sandbox'],
});

const errors = [];
try {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
  });
  await ctx.addInitScript(
    (uid) =>
      localStorage.setItem(
        '4am-auth',
        JSON.stringify({
          state: { auth: { token: 'baseline-fixture', userId: uid, username: 'alex', identity: null } },
          version: 0,
        }),
      ),
    MY_USER,
  );
  await ctx.addInitScript(() => {
    localStorage.setItem('4am-sounds', 'off');
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/**', (route) =>
    route.fulfill({
      json: {
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
        isPlatform: false,
        cardBack: 'crimson',
        fourColor: true,
        // deliberately no `betRatios`: the client keeps its five-slot default
      },
    }),
  );
  await page.routeWebSocket('**/*', (ws) =>
    ws.onMessage((data) => {
      const msg = JSON.parse(String(data));
      if (msg.t === 'join_room') {
        ws.send(JSON.stringify(room));
        const order = [
          ...new Set([
            0,
            1,
            MY_SEAT,
            ...room.players.map((p) => p.seat).filter((seat) => ![0, 1, MY_SEAT].includes(seat)),
          ]),
        ];
        setTimeout(
          () =>
            ws.send(
              JSON.stringify({
                t: 'betting_state',
                handId: 'baseline',
                actionSeq: 0,
                state: {
                  street: 'preflop',
                  seats: order.map((seat) => ({
                    seat,
                    stack: 2000 - seat * 137,
                    committed: seat === 0 ? 10 : seat === 1 ? 20 : 0,
                    total: seat === 0 ? 10 : seat === 1 ? 20 : 0,
                    folded: false,
                    allIn: false,
                    lastActedAt: null,
                  })),
                  buttonSeat: 0,
                  sb: 10,
                  bb: 20,
                  currentBet: 20,
                  lastRaiseSize: 20,
                  lastFullRaiseAt: 20,
                  toAct: MY_SEAT,
                  needToAct: [MY_SEAT, ...order.filter((seat) => seat !== MY_SEAT)],
                  winnerByFold: null,
                },
                board: [],
                deadline: Date.now() + 30000,
                baseDeadline: Date.now() + 30000,
              }),
            ),
          700,
        );
      }
    }),
  );

  await page.goto(`${base}/room/${room.room.id}`);
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Poker board"], .table-app-bg') !== null,
  );
  await page.waitForFunction(
    async ({ count }) => {
      const { useStore } = await import('/src/shared/store.ts');
      return useStore.getState().room?.players.length === count;
    },
    { count: COUNT },
  );
  await page.evaluate(
    async ({ path, count, mySeat, roomFixture }) => {
      const { useStore, emptyHand } = await import('/src/shared/store.ts');
      const { startHand } = await import('/@fs' + path);
      const { deriveIdentity } = await import('/src/shared/crypto.ts');

      const s = useStore.getState();
      s.setAuth({
        ...s.auth,
        token: 'baseline-fixture',
        userId: 2,
        username: 'alex',
        identity: deriveIdentity('alex', 'baseline'),
      });
      s.setRoom(roomFixture);

      const players = roomFixture.players;
      const meSeat = players.find((p) => p.userId === 2).seat;
      const others = players.map((p) => p.seat).filter((x) => x !== meSeat);
      const order = [others[0], others[1], meSeat, ...others.slice(2)];
      const betting = startHand(
        order.map((seat) => ({ seat, stack: 2000 })),
        order[0],
        10,
        20,
      );
      useStore.getState().resetHand({
        ...emptyHand,
        handId: 'baseline',
        seats: players,
        myCards: [0, 1],
        buttonSeat: (meSeat + 1) % count,
        betting,
        deadline: Date.now() + 30000,
        baseDeadline: Date.now() + 30000,
        lastActions: Object.fromEntries(order.slice(0, 2).map((seat) => [seat, { type: 'call' }])),
      });
      useStore.getState().setWsConnected(true);
      // keep the room-derived store honest for any panel that reads it
      const refreshed = useStore.getState();
      if (refreshed.room) refreshed.setRoom({ ...refreshed.room });
    },
    { path: sharedPath, count: COUNT, mySeat: MY_SEAT, roomFixture: room },
  );

  await page.evaluate(async () => {
    for (let i = 0; i < 8; i++) await new Promise(requestAnimationFrame);
  });
  await page.waitForFunction(
    async ({ mySeat }) => {
      const { useStore } = await import('/src/shared/store.ts');
      const hand = useStore.getState().hand;
      return hand.betting?.toAct === mySeat && hand.myCards.length >= 2;
    },
    { mySeat: MY_SEAT },
  );
  await page.waitForSelector('[data-testid="betting-panel"] button:not([disabled])');
  await page.waitForTimeout(600);

  const labels = (await page.locator('[data-testid="betting-panel"] .table-quick').allTextContents()).map(
    (s) => s.trim(),
  );
  if (JSON.stringify(labels) !== JSON.stringify(EXPECTED)) {
    throw new Error(`bet preset pills were ${JSON.stringify(labels)}, expected ${JSON.stringify(EXPECTED)}`);
  }
  const measured = await page.evaluate(() => {
    const pills = [...document.querySelectorAll('[data-testid="betting-panel"] .table-quick')];
    return pills.map((el) => {
      const r = el.getBoundingClientRect();
      return {
        label: el.textContent?.trim(),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    });
  });

  await page.screenshot({ path: `${out}/desktop-1440x900.png` });
  await page.locator('[data-testid="betting-panel"]').screenshot({
    path: `${out}/desktop-1440x900-betting.png`,
  });
  await writeFile(
    `${out}/browser-result.json`,
    JSON.stringify(
      {
        viewport: '1440x900',
        expected: EXPECTED,
        pills: measured,
        pageErrors: errors,
        generatedAt: new Date().toISOString(),
      },
      null,
      1,
    ),
  );
  console.log(`pills: ${labels.join(' ')}`);
  console.log(`shot: ${out}/desktop-1440x900.png`);
  await ctx.close();
} finally {
  await browser.close();
}
if (errors.length) {
  console.error(`PAGE ERRORS:\n${errors.join('\n')}`);
  process.exit(1);
}
console.log('no page errors');
