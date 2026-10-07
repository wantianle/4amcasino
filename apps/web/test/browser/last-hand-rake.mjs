/** Real-browser proof that the per-hand rake is rendered for NORMAL hands
 * (showdown + fold), with the value coming from a real `hand_end` frame.
 *
 * Before this lane the only visible result for a normal hand was an sr-only
 * live region; the recap branch that carried "… · Rake N" was unreachable. The
 * rake now lives in the last-hand strip (LastHandStrip), derived from the
 * frozen seat leg via `sum(deltas) === -commission`. This harness sends actual
 * `hand_end` frames through the mocked WebSocket, lets gameClient freeze the
 * recap, then asserts the strip's visible text is exactly `Rake <commission>` -
 * including when NO `commissionDeltas` are sent (recipient not seated), the
 * case the old "Rake received" line could never show.
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
const out = process.env.UAT_OUTPUT || '/tmp/4am-last-hand-rake';
await mkdir(out, { recursive: true });

const ME = 2;
const names = ['Alex', 'Meera', 'Zoya'];
const room = {
  t: 'room_state',
  room: {
    id: 'rake-qa',
    name: 'Rake QA',
    joinCode: 'RAKEQA',
    hostId: ME,
    // The rake recipient is an OUTSIDE platform account (not a seat), so the
    // server sends no `commissionDeltas` and the payer never sees a recipient
    // line. The total must still render.
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

// One showdown (recipient outside) and one fold (recipient seated, to prove the
// total also renders when commissionDeltas IS present). The seat legs sum to
// -commission in both, matching the wsProtocol invariant.
const cases = [
  {
    kind: 'showdown',
    commission: 2,
    deltas: [
      { seat: 0, delta: 108 },
      { seat: 1, delta: -55 },
      { seat: 2, delta: -55 },
    ],
    commissionDeltas: undefined,
  },
  {
    kind: 'fold',
    commission: 3,
    deltas: [
      { seat: 0, delta: 87 },
      { seat: 1, delta: -45 },
      { seat: 2, delta: -45 },
    ],
    commissionDeltas: [{ seat: 1, delta: 3 }],
  },
];

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/google-chrome',
});
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  await ctx.addInitScript(() => {
    localStorage.setItem(
      '4am-auth',
      JSON.stringify({
        state: { auth: { token: 'rake-fixture', userId: 2, username: 'alex', identity: null } },
        version: 0,
      }),
    );
    localStorage.setItem('4am.locale', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
    // Open the last-hand recap so the rake line (inside the body) is on screen.
    localStorage.setItem('4am-last-hand', 'on');
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/**', (route) =>
    route.fulfill({ json: { ok: true, rooms: [], requests: [], rows: [], friends: [], incoming: [], outgoing: [], hands: [], isPlatform: false, cardBack: 'crimson', fourColor: true } }),
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
  const frames = () => page.evaluate(async () => { for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame); });

  for (const c of cases) {
    const handId = `rake-${c.kind}`;
    // A live hand with that id, as the server would have started it: the recap
    // freeze is gated on the current hand matching the terminal frame.
    await page.evaluate(({ handId }) => {
      const s = qaStore.getState();
      qaStore.setState({
        hand: {
          ...qaEmpty,
          handId,
          seats: s.room.players.map((p) => ({ seat: p.seat, userId: p.userId, stack: p.stack })),
        },
      });
    }, { handId });
    await frames();

    const frame = {
      t: 'hand_end',
      handId,
      head: 'qa',
      commission: c.commission,
      stacks: room.players.map((p) => ({ seat: p.seat, stack: 2000 })),
      deltas: c.deltas,
      ...(c.commissionDeltas ? { commissionDeltas: c.commissionDeltas } : {}),
    };
    for (const ws of sockets) ws.send(JSON.stringify(frame));
    await frames();
    await page.waitForTimeout(50);

    // The recap was frozen by the real reducer from the real frame.
    const snap = await page.evaluate(() => qaStore.getState().lastHand);
    assert.ok(snap && snap.handId === handId, `${c.kind}: hand_end froze the recap`);
    const seatSum = snap.deltas.reduce((s, d) => s + d.delta, 0);
    assert.equal(-seatSum, c.commission, `${c.kind}: seat leg sums to -commission`);
    assert.deepEqual(snap.commissionDeltas ?? [], c.commissionDeltas ?? [], `${c.kind}: commissionDeltas frozen`);

    // Reveal the strip: no current hand (between hands).
    await page.evaluate(() => qaStore.setState({ hand: qaEmpty }));
    await frames();

    const rake = page.getByText(`Rake ${c.commission}`, { exact: true });
    await rake.first().waitFor({ state: 'visible' });
    assert.equal(await rake.count(), 1, `${c.kind}: exactly one rake line`);
    assert.ok(await rake.first().isVisible(), `${c.kind}: rake line is visible`);
    await page.screenshot({ quality: 85, path: `${out}/${c.kind}.jpg` });
    console.log(
      `${c.kind}: commission=${c.commission}, commissionDeltas=${JSON.stringify(c.commissionDeltas ?? [])} -> strip shows "Rake ${c.commission}"`,
    );
  }

  await ctx.close();
  assert.deepEqual(errors, [], 'No uncaught browser errors');
} finally {
  await browser.close();
}
