/** Real-browser proof that the hand's rake is visible the INSTANT the hand
 * ends - inside the result window, before any next hand exists.
 *
 * Contrast `last-hand-rake.mjs`, which proves the durable `Rake N` line in the
 * last-hand strip only once the NEXT hand is on the table. This harness sends
 * real terminal frames through the mocked WebSocket and asserts the chip:
 *  - hand_end with commission > 0    -> visible "Rake N" (N === -sum(deltas));
 *  - hand_end with commission === 0  -> NO chip at all (no phantom "Rake 0");
 *  - hand_abort                      -> ResultFlash pill unchanged, no chip.
 * It also pins that the chip is transient: it leaves when the result window
 * auto-dismisses.
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
const out = process.env.UAT_OUTPUT || '/tmp/4am-hand-end-rake';
await mkdir(out, { recursive: true });

const ME = 2;
const names = ['Alex', 'Meera', 'Zoya'];
const room = {
  t: 'room_state',
  room: {
    id: 'end-rake-qa',
    name: 'End rake QA',
    joinCode: 'ENDRAKE',
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
    commissionBps: 50,
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
    reducedMotion: 'reduce',
  });
  await ctx.addInitScript(() => {
    localStorage.setItem(
      '4am-auth',
      JSON.stringify({
        state: { auth: { token: 'end-rake-fixture', userId: 2, username: 'alex', identity: null } },
        version: 0,
      }),
    );
    localStorage.setItem('4am.locale', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
    // The durable strip stays shut so the ONLY `Rake` on screen is the chip.
    localStorage.setItem('4am-last-hand', 'off');
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
  const visible = async (locator) => {
    const list = [];
    for (const item of await locator.all()) if (await item.isVisible()) list.push(item);
    return list;
  };
  const rakeNotice = page.getByTestId('rake-notice');
  const winStatus = page.locator('p[role="status"][aria-live="polite"]');

  const startLive = async (handId) => {
    await page.evaluate((handId) => {
      const s = qaStore.getState();
      qaStore.setState({
        hand: {
          ...qaEmpty,
          handId,
          seats: s.room.players.map((p) => ({ seat: p.seat, userId: p.userId, stack: p.stack })),
        },
      });
    }, handId);
    await frames();
  };
  const send = (frame) => {
    for (const ws of sockets) ws.send(JSON.stringify(frame));
  };
  const reset = async () => {
    await page.evaluate(() => qaStore.setState({ hand: qaEmpty }));
    await frames();
  };

  // ── 1. Raked hand: chip visible right away, and transient ────────────────
  {
    const handId = 'end-rake-raked';
    await startLive(handId);
    // Winner +108, two losers -55: sum = -2 => commission 2 (the invariant).
    const deltas = [
      { seat: 0, delta: 108 },
      { seat: 1, delta: -55 },
      { seat: 2, delta: -55 },
    ];
    send({
      t: 'hand_end',
      handId,
      head: 'qa',
      commission: 2,
      stacks: room.players.map((p) => ({ seat: p.seat, stack: 2000 })),
      deltas,
    });
    await frames();
    // Settled from the real frame: hand.result is set, so the result window is up.
    const result = await page.evaluate(() => qaStore.getState().hand.result);
    assert.ok(result && result.handId === handId, 'hand_end settles the live hand');
    assert.equal(
      deltas.reduce((s, d) => s + d.delta, 0),
      -result.commission,
      'fixture obeys sum(deltas) === -commission',
    );

    await rakeNotice.first().waitFor({ state: 'visible' });
    const shown = await visible(rakeNotice);
    assert.equal(shown.length, 1, 'raked hand: exactly one rake chip while the result window is up');
    assert.match(await shown[0].innerText(), /^Rake\s+2$/, 'raked hand: chip shows -Σdeltas');
    // The winner announcement is still the screen-reader line (no recap pill).
    assert.ok((await winStatus.innerText()).includes('+108'), 'winner still announced sr-only');
    assert.equal(
      (await visible(page.getByRole('button', { name: 'Dismiss result', exact: true }))).length,
      0,
      'no dismissible recap was brought back',
    );
    await page.screenshot({ quality: 85, path: `${out}/raked.jpg` });
    // Transient: the result window steps aside on its own and takes the chip.
    await rakeNotice.first().waitFor({ state: 'hidden', timeout: 6000 });
    await reset();
    console.log('raked: commission=2 -> "Rake 2" visible at hand end, gone with the result window');
  }

  // ── 2. Unraked hand: no chip, but the result did render ──────────────────
  {
    const handId = 'end-rake-unraked';
    await startLive(handId);
    send({
      t: 'hand_end',
      handId,
      head: 'qa',
      commission: 0,
      stacks: room.players.map((p) => ({ seat: p.seat, stack: 2000 })),
      deltas: [
        { seat: 0, delta: 110 },
        { seat: 1, delta: -55 },
        { seat: 2, delta: -55 },
      ],
    });
    await frames();
    // Prove the negative is NOT vacuous: the result window really is up.
    assert.ok(
      (await winStatus.innerText()).includes('+110'),
      'unraked hand: result window is up (so the absence below is meaningful)',
    );
    assert.equal((await visible(rakeNotice)).length, 0, 'unraked hand: no rake chip');
    assert.equal(await page.getByText('Rake 0', { exact: true }).count(), 0, 'no phantom "Rake 0"');
    await reset();
    console.log('unraked: commission=0 -> no chip (no phantom "Rake 0")');
  }

  // ── 3. Abort: ResultFlash pill unchanged, never a rake ───────────────────
  {
    const handId = 'end-rake-abort';
    await startLive(handId);
    send({
      t: 'hand_abort',
      handId,
      reason: 'Connection lost. All bets were returned.',
      blamedSeat: null,
    });
    await frames();
    const dismiss = page.getByRole('button', { name: 'Dismiss result', exact: true });
    await dismiss.first().waitFor({ state: 'visible' });
    assert.equal((await visible(dismiss)).length, 1, 'abort: ResultFlash pill still renders');
    assert.equal((await visible(rakeNotice)).length, 0, 'abort: no rake chip');
    await reset();
    console.log('abort: ResultFlash pill unchanged, no rake chip');
  }

  await ctx.close();
  assert.deepEqual(errors, [], 'No uncaught browser errors');
} finally {
  await browser.close();
}
