/** Real-browser proof for the ResultFlash overflow fix.
 *
 * A voided hand renders the recap pill with a server-supplied abort reason. When
 * that reason was long the pill's `detail` was `shrink-0`, so the pill overflowed
 * `max-w-full` and pushed the Dismiss button far off the right edge (measured at
 * x ≈ 13230 at width 1440). This harness plants a long reason in the store and
 * measures the real Chromium geometry: the Dismiss button must sit inside both
 * the viewport and the pill, and the detail span must ellipsize instead of
 * pushing the row.
 *
 * PLAYWRIGHT_MODULE may point to an existing Playwright installation.
 * BROWSER_EXECUTABLE may select a cached Chromium executable.
 * BASE_URL defaults to http://localhost:5183.
 *
 * Every observation is printed as one JSON line tagged `RESULTFLASH_BBOX ` so a
 * before/after run can be diffed directly.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const base = process.env.BASE_URL || 'http://localhost:5183';

const REASON = `Connection lost. ${'All bets were returned. '.repeat(24)}`.trim();
const VIEWPORT = { width: 1440, height: 900 };

const names = ['Alex', 'Meera', 'Zoya', 'Ishaan', 'River', 'Jules', 'Mira', 'Sol', 'Sam'];
const room = {
  t: 'room_state',
  room: {
    id: 'result-flash-qa',
    name: 'ResultFlash overflow',
    joinCode: 'QATEST',
    hostId: 2,
    bankerId: 2,
    sb: 10,
    bb: 20,
    auditMode: 'strict',
    actionTimeoutMs: 30000,
    actionSecs: null,
    coBankerId: null,
    minSettleHands: 0,
    sevenDeuceBonus: 0,
    voided: false,
    autoApproveBuys: false,
    tvReplays: false,
    commissionBps: 10,
  },
  players: names.map((name, i) => ({
    userId: i + 2,
    username: name.toLowerCase(),
    displayName: name,
    seat: (i + 4) % 9,
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

const sharedPath = fileURLToPath(
  new URL('../../../../packages/shared/src/index.ts', import.meta.url),
);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.BROWSER_EXECUTABLE,
});
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: VIEWPORT, reducedMotion: 'reduce' });
  await ctx.addInitScript(() => {
    localStorage.setItem(
      '4am-auth',
      JSON.stringify({
        state: { auth: { token: 'local-ui-fixture', userId: 2, username: 'alex', identity: null } },
        version: 0,
      }),
    );
    localStorage.setItem('4am.locale', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(45000);
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
  await page.routeWebSocket('**/*', (ws) =>
    ws.onMessage((data) => {
      const msg = JSON.parse(String(data));
      if (msg.t === 'join_room') ws.send(JSON.stringify(room));
    }),
  );
  await page.goto(`${base}/room/${room.room.id}`);
  await page.getByRole('button', { name: 'Deal hand', exact: true }).first().waitFor();
  await page.evaluate(async (path) => {
    const { useStore, emptyHand } = await import('/src/shared/store.ts');
    const { evaluate7 } = await import('/@fs' + path);
    window.qaStore = useStore;
    window.qaEmpty = emptyHand;
    window.qaEvaluate7 = evaluate7;
  }, sharedPath);

  const frames = () =>
    page.evaluate(async () => {
      for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
    });

  await page.evaluate((reason) => {
    const s = qaStore.getState();
    const baseHand = { ...qaEmpty, handId: 'fixture-abort-long', seats: s.room.players, myCards: [0, 1] };
    qaStore.setState({
      hand: {
        ...baseHand,
        abort: { t: 'hand_abort', handId: baseHand.handId, blamedSeat: null, reason },
      },
    });
  }, REASON);
  await frames();
  await frames();

  const dismiss = page.getByRole('button', { name: 'Dismiss result', exact: true });
  await dismiss.waitFor();
  const share = page.getByRole('button', { name: 'Share', exact: true });
  assert.equal(await share.count(), 0, 'a voided hand offers no share button');

  const geometry = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const dismissEl = btns.find((b) => b.getAttribute('aria-label') === 'Dismiss result');
    const pill = dismissEl?.closest('[role="status"]');
    const detailEl = [...(pill?.querySelectorAll('span') ?? [])].find((s) =>
      (s.textContent || '').includes('All bets were returned.'),
    );
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, right: r.right, width: r.width, height: r.height };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      dismiss: rect(dismissEl),
      pill: rect(pill),
      detail: detailEl
        ? {
            ...rect(detailEl),
            scrollWidth: detailEl.scrollWidth,
            clientWidth: detailEl.clientWidth,
            truncated: detailEl.scrollWidth > detailEl.clientWidth + 1,
          }
        : null,
      dismissReachable:
        dismissEl.contains(
          document.elementFromPoint(
            dismissEl.getBoundingClientRect().x + dismissEl.getBoundingClientRect().width / 2,
            dismissEl.getBoundingClientRect().y + dismissEl.getBoundingClientRect().height / 2,
          ),
        ) ?? false,
    };
  });

  console.log(`RESULTFLASH_BBOX ${JSON.stringify(geometry)}`);

  assert.ok(
    geometry.dismiss.x >= 0 && geometry.dismiss.right <= geometry.viewport.width,
    `Dismiss button must be inside the viewport, got { x: ${geometry.dismiss.x}, right: ${geometry.dismiss.right} } vs width ${geometry.viewport.width}`,
  );
  assert.ok(
    geometry.dismiss.right <= geometry.pill.right + 0.5,
    `Dismiss button must sit inside the pill, got dismiss.right ${geometry.dismiss.right} > pill.right ${geometry.pill.right}`,
  );
  assert.ok(geometry.dismissReachable, 'Dismiss button must be hit-testable at its centre');
  assert.ok(geometry.detail, 'the long abort reason must render as the pill detail');
  assert.ok(
    geometry.detail.truncated,
    `the detail must ellipsize (scrollWidth ${geometry.detail.scrollWidth} > clientWidth ${geometry.detail.clientWidth}) rather than overflow`,
  );
  assert.ok(
    geometry.detail.width < geometry.viewport.width,
    'the detail span must be bounded, not wider than the viewport',
  );
  assert.deepEqual(errors, [], 'No uncaught browser errors');
  console.log(`✓ ResultFlash overflow holds at ${VIEWPORT.width}px with a ${REASON.length}-char reason`);
} finally {
  await browser.close();
}
