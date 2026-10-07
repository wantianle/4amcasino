/** Real-browser proof that the SETTLEMENT target point is visible.
 *
 * The settlement flight measures `[data-central-pot]` and flies the collected
 * pot there. If that element has no box, or is `opacity-0`, the chips fly to an
 * invisible point - the blocker this gate pins. `hand_end` itself does NOT clear
 * betting, but a committed terminal recovery lands with `betting: null`, so we
 * clear it here and assert the pill stays mounted, non-zero and opaque. A second
 * case pins the cross-hand scope: a later hand's recovery must not resurrect an
 * earlier hand's frozen total.
 *
 * Both `getBoundingClientRect()` and `getComputedStyle(...).opacity` are read
 * from the real Chromium layout - the unit test only pins the value rule
 * (`centralPot.test.ts`).
 *
 * Env:
 *   PLAYWRIGHT_MODULE   Playwright module (default 'playwright-core')
 *   BROWSER_EXECUTABLE  Chrome binary (default /usr/bin/google-chrome)
 *   BASE_URL            Vite dev server (default http://localhost:5174)
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const base = process.env.BASE_URL || 'http://localhost:5174';
const out = process.env.UAT_OUTPUT || '/tmp/4am-settlement-central-pot';
await mkdir(out, { recursive: true });

const ME = 2;
const names = ['Alex', 'Meera', 'Zoya'];
const POT = 300; // 3 seats × 100 committed
const room = {
  t: 'room_state',
  room: {
    id: 'settle-central-pot-qa',
    name: 'Settle central pot QA',
    joinCode: 'SETPOT',
    hostId: ME,
    bankerId: 99,
    sb: 10,
    bb: 20,
    auditMode: 'private',
    actionTimeoutMs: 30000,
    actionSecs: null,
    coBankerId: null,
    minSettleHands: 0,
    sevenDeuceBonus: 0,
    voided: false,
    autoApproveBuys: false,
    tvReplays: false,
    commissionBps: 0,
  },
  players: names.map((name, seat) => ({
    userId: seat + 2,
    username: name.toLowerCase(),
    displayName: name,
    seat,
    stack: 2000,
    connected: true,
    sittingOut: false,
    totalBought: 2000,
    hasAvatar: false,
    avatarVersion: 0,
    publicKey: '',
    privateStats: false,
    pendingBuy: 0,
  })),
  handActive: false,
};

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/google-chrome',
});
const errors = [];
try {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce', // deterministic: no flight timing to race
  });
  await ctx.addInitScript(() => {
    localStorage.setItem(
      '4am-auth',
      JSON.stringify({
        state: { auth: { token: 'settle-pot-fixture', userId: 2, username: 'alex', identity: null } },
        version: 0,
      }),
    );
    localStorage.setItem('4am.locale', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/**', (route) =>
    route.fulfill({
      json: {
        ok: true,
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
      },
    }),
  );

  const sockets = [];
  await page.routeWebSocket('**/*', (ws) => {
    sockets.push(ws);
    ws.onMessage((data) => {
      const msg = JSON.parse(String(data));
      if (msg.t === 'join_room') ws.send(JSON.stringify(room));
    });
  });

  await page.goto(`${base}/room/${room.room.id}`);
  await page.getByRole('button', { name: 'Deal hand', exact: true }).first().waitFor();
  await page.evaluate(async () => {
    const { useStore, emptyHand } = await import('/src/shared/store.ts');
    window.qaStore = useStore;
    window.qaEmpty = emptyHand;
  });
  const frames = () =>
    page.evaluate(async () => {
      for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
    });
  const send = (frame) => {
    for (const ws of sockets) ws.send(JSON.stringify(frame));
  };

  /** shape + geometry + opacity of the settlement target as the browser sees it */
  const measure = () =>
    page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('[data-central-pot]'));
      const el = els[0] ?? null;
      const rect = el ? el.getBoundingClientRect() : null;
      const css = el ? getComputedStyle(el) : null;
      return {
        count: els.length,
        text: el ? el.textContent ?? '' : null,
        width: rect ? rect.width : 0,
        height: rect ? rect.height : 0,
        opacity: css ? Number(css.opacity) : 0,
        visibility: css ? css.visibility : null,
        display: css ? css.display : null,
      };
    });

  const handId = 'settle-central-pot';
  const seats = room.players.map((p) => ({
    seat: p.seat,
    userId: p.userId,
    stack: p.stack,
    committed: 100,
    total: 100,
    folded: false,
    allIn: false,
    lastActedAt: null,
  }));
  await page.evaluate(
    ({ handId, seats }) => {
      const s = qaStore.getState();
      qaStore.getState().patchHand({
        handId,
        seats: s.room.players.map((p) => ({ seat: p.seat, userId: p.userId, stack: p.stack })),
        betting: {
          street: 'preflop',
          seats,
          buttonSeat: 0,
          sb: 10,
          bb: 20,
          currentBet: 20,
          lastRaiseSize: 20,
          lastFullRaiseAt: 0,
          toAct: 1,
          needToAct: [1],
          winnerByFold: null,
        },
      });
    },
    { handId, seats },
  );
  await frames();

  // 1. Live pot: the pill is up with the running total.
  {
    const live = await measure();
    assert.equal(live.count, 1, 'live hand: exactly one central pot target');
    assert.ok(live.width > 0 && live.height > 0, `live hand: target has a real box, got ${live.width}×${live.height}`);
    assert.ok(live.opacity > 0, `live hand: target is not transparent, opacity=${live.opacity}`);
    console.log(`live: pill ${live.width.toFixed(0)}×${live.height.toFixed(0)} opacity=${live.opacity}`);
  }

  // 2. Settlement: end the hand, then clear the betting snapshot - the state
  //    the review describes (`pot === 0` while the result window is up). The
  //    frozen total must keep the target mounted, non-zero and opaque.
  send({
    t: 'hand_end',
    handId,
    head: 'qa',
    commission: 0,
    stacks: room.players.map((p) => ({ seat: p.seat, stack: 2000 })),
    deltas: [
      { seat: 0, delta: POT },
      { seat: 1, delta: -150 },
      { seat: 2, delta: -150 },
    ],
  });
  await frames();
  const settled = await page.evaluate(() => !!qaStore.getState().hand.result);
  assert.ok(settled, 'hand_end put the result window up');
  await page.evaluate(() => qaStore.getState().patchHand({ betting: null }));
  await frames();

  {
    const result = await measure();
    assert.equal(result.count, 1, 'settlement: exactly one central pot target');
    assert.ok(
      result.width > 0 && result.height > 0,
      `settlement: target rect is non-zero, got ${result.width}×${result.height}`,
    );
    assert.ok(
      result.opacity > 0,
      `settlement: target computed opacity is not 0, got ${result.opacity}`,
    );
    assert.notEqual(result.visibility, 'hidden', 'settlement: target is not visibility:hidden');
    assert.notEqual(result.display, 'none', 'settlement: target is not display:none');
    console.log(
      `settlement: pill ${result.width.toFixed(0)}×${result.height.toFixed(0)} opacity=${result.opacity}`,
    );
    await page.screenshot({ quality: 85, path: `${out}/settlement.jpg` });
  }

  // 3. Cross-hand leak: hand B starts, then a committed recovery produces a
  //    result with `betting: null`. The freeze is scoped to A, so B must NOT
  //    resurrect A's total as a phantom pill.
  await page.evaluate(() => {
    qaStore.getState().patchHand({
      handId: 'settle-central-pot-B',
      result: null,
      abort: null,
      betting: null,
      seats: qaStore
        .getState()
        .room.players.map((p) => ({ seat: p.seat, userId: p.userId, stack: p.stack })),
    });
  });
  await frames();
  {
    const startB = await measure();
    assert.equal(startB.count, 0, 'hand B before any result: no pill');
  }
  await page.evaluate(() => {
    qaStore.getState().patchHand({
      result: {
        t: 'hand_end',
        handId: 'settle-central-pot-B',
        head: '',
        stacks: [],
        deltas: [],
      },
      betting: null,
    });
  });
  await frames();
  {
    const leak = await measure();
    assert.equal(
      leak.count,
      0,
      "hand B recovery result with empty betting: no pill (A's freeze must be dropped)",
    );
    await page.screenshot({ quality: 85, path: `${out}/cross-hand.jpg` });
    console.log('cross-hand: B recovery with betting:null shows no pill (A freeze dropped)');
  }

  // 4. Abort: a hand with a visible frozen total is aborted. The abort must not
  //    leave the frozen value on screen (the reducer keeps `result`, so only the
  //    abort guard in the render read hides it).
  await page.evaluate(() => {
    qaStore.getState().patchHand({
      handId: 'settle-central-pot-D',
      result: null,
      abort: null,
      seats: qaStore
        .getState()
        .room.players.map((p) => ({ seat: p.seat, userId: p.userId, stack: p.stack })),
      betting: {
        street: 'preflop',
        seats: qaStore.getState().room.players.map((p, i) => ({
          seat: p.seat,
          userId: p.userId,
          stack: p.stack,
          committed: 500,
          total: 500,
          folded: false,
          allIn: i === 2,
          lastActedAt: null,
        })),
        buttonSeat: 0,
        sb: 10,
        bb: 20,
        currentBet: 500,
        lastRaiseSize: 500,
        lastFullRaiseAt: 0,
        toAct: 1,
        needToAct: [1],
        winnerByFold: null,
      },
    });
  });
  await frames();
  {
    const liveD = await measure();
    assert.equal(liveD.count, 1, 'hand D live: pill is up before the abort');
  }
  // Freeze the total, then abort the same hand.
  await page.evaluate(() => {
    qaStore.getState().patchHand({
      result: { t: 'hand_end', handId: 'settle-central-pot-D', head: '', stacks: [], deltas: [] },
      betting: null,
    });
  });
  await frames();
  {
    const frozenD = await measure();
    assert.equal(frozenD.count, 1, 'hand D result: frozen total keeps the pill up before abort');
  }
  send({
    t: 'hand_abort',
    handId: 'settle-central-pot-D',
    reason: 'qa abort',
    blamedSeat: null,
  });
  await frames();
  {
    const aborted = await measure();
    assert.equal(aborted.count, 0, 'hand D abort: no stale pill value remains');
    await page.screenshot({ quality: 85, path: `${out}/abort.jpg` });
    console.log('abort: pill removed after hand_abort (no stale value)');
  }

  await ctx.close();
  assert.deepEqual(errors, [], 'No uncaught browser errors');
  console.log('settlement central pot target: visible, non-zero, opaque through hand_end');
} finally {
  await browser.close();
}
