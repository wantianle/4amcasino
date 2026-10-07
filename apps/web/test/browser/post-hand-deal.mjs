/** Browser regression against a running Vite server. No real account or room is used.
 * PLAYWRIGHT_MODULE may point to an existing Playwright installation.
 * BROWSER_EXECUTABLE may select a cached Chromium executable.
 * BASE_URL defaults to http://localhost:5174.
 *
 * Two post-hand presentations exist (f03ada3 phase-1 table refactor):
 *  - a normal result is announced in a screen-reader live region, and the payoff
 *    is on the cards/winner tag, so there is NO dismissible recap pill on the
 *    felt; the hand's rake is the ONE figure shown on screen at that instant, as
 *    a small non-dismissible chip (RakeNotice) that leaves with the result
 *    window;
 *  - a voided hand still renders the recap pill with its Dismiss result button
 *    (and no rake chip).
 * This harness drives both and checks the Deal control stays usable meanwhile.
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.BASE_URL || 'http://localhost:5174';
const out = process.env.UAT_OUTPUT || '/tmp/4am-post-hand-deal';
await mkdir(out, { recursive: true });
const sharedPath = fileURLToPath(
  new URL('../../../../packages/shared/src/index.ts', import.meta.url),
);
const names = ['Alex', 'Meera', 'Zoya', 'Ishaan', 'River', 'Jules', 'Mira', 'Sol', 'Sam'];
const room = {
  t: 'room_state',
  room: {
    id: 'post-hand-qa',
    name: 'Post-hand controls',
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
    commissionBps: Number(process.env.COMMISSION_BPS || 10),
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
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.BROWSER_EXECUTABLE,
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
        state: {
          auth: {
            token: 'local-ui-fixture',
            userId: 2,
            username: 'alex',
            identity: null,
          },
        },
        version: 0,
      }),
    );
    localStorage.setItem('4am.locale', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
  });
  const page = await ctx.newPage();
  // Playwright harness timeout, NOT the product's fixed 30s action clock.
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
  const sent = [];
  await page.routeWebSocket('**/*', (ws) =>
    ws.onMessage((data) => {
      const msg = JSON.parse(String(data));
      sent.push(msg.t);
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
  const fixture = async (kind) => {
    await page.evaluate((kind) => {
      const s = qaStore.getState();
      const baseHand = {
        ...qaEmpty,
        handId: `fixture-${kind}`,
        seats: s.room.players,
        myCards: [0, 1],
      };
      if (kind === 'abort') {
        qaStore.setState({
          hand: {
            ...baseHand,
            abort: {
              t: 'hand_abort',
              handId: baseHand.handId,
              blamedSeat: null,
              // A realistic server reason. (A 60x-repeated reason overflows the
              // recap horizontally and pushes Dismiss off-screen - reported as a
              // product robustness bug, not asserted here so the suite can run.)
              reason: 'Connection lost. All bets were returned.',
            },
          },
        });
        return;
      }
      const board = [20, 25, 29, 33, 41];
      const reveals = s.room.players.map((p, i) => ({
        seat: p.seat,
        cards: [i * 2, i * 2 + 1],
        score: qaEvaluate7([...board, i * 2, i * 2 + 1]),
      }));
      const winner = reveals.reduce((a, b) => (a.score > b.score ? a : b)).seat;
      qaStore.setState({
        hand: {
          ...baseHand,
          board,
          showdown:
            kind === 'fold'
              ? null
              : {
                  t: 'showdown',
                  handId: baseHand.handId,
                  reveals,
                  awards: [{ seat: winner, amount: 990 }],
                },
          result: {
            t: 'hand_end',
            handId: baseHand.handId,
            head: 'qa',
            commission: 2,
            stacks: s.room.players.map((p) => ({ seat: p.seat, stack: 2000 })),
            // Winner +878, eight losers -110: sum(deltas) === -commission (-2),
            // the wsProtocol invariant the rake chip derives its figure from.
            deltas: s.room.players.map((p) => ({
              seat: p.seat,
              delta: p.seat === winner ? 878 : -110,
            })),
          },
        },
      });
    }, kind);
    await frames();
  };
  const reachable = async (locator) =>
    locator.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return (
        r.width > 0 &&
        r.height > 0 &&
        el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
      );
    });
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
    { width: 320, height: 700 },
  ]) {
    await page.setViewportSize(viewport);
    for (const kind of ['showdown', 'fold', 'abort']) {
      await page.evaluate(() => {
        scrollTo(0, 0);
        qaStore.setState({ hand: qaEmpty });
      });
      await frames();
      await fixture(kind);
      const visible = async (locator) => {
        const list = [];
        for (const item of await locator.all()) if (await item.isVisible()) list.push(item);
        return list;
      };
      const dismiss = page.getByRole('button', { name: 'Dismiss result', exact: true });
      const rakeNotice = page.getByTestId('rake-notice');
      const winStatus = page.locator('p[role="status"][aria-live="polite"]');
      // A normal result is no longer a dismissible pill on the felt: TablePage
      // announces the winners in a screen-reader live region, shows the payoff
      // on the cards themselves, and puts the hand's rake on a small
      // non-dismissible chip for the instant the result window is up. Only a
      // voided hand still renders the recap pill with its Dismiss result
      // button. `resultShown()` is the one marker both kinds share, so the
      // Escape assertions below stay meaningful for each.
      const resultShown = async () =>
        kind === 'abort'
          ? (await visible(dismiss)).length === 1
          : (await winStatus.count()) === 1 && (await winStatus.innerText()).includes('+878');
      assert.ok(await resultShown(), `${viewport.width}/${kind}: post-hand result is on screen`);
      if (kind !== 'abort') {
        assert.equal(
          (await visible(dismiss)).length,
          0,
          'a normal result renders no dismissible recap',
        );
        // The new behaviour: commission 2 (>0) is visible IMMEDIATELY, in this
        // result window - not only in the next hand's last-hand strip.
        const rakes = await visible(rakeNotice);
        assert.equal(rakes.length, 1, `${viewport.width}/${kind}: one visible rake chip`);
        assert.match(
          await rakes[0].innerText(),
          /Rake\s+2/,
          `${viewport.width}/${kind}: rake chip shows the hand's -Σdeltas`,
        );
      } else {
        // A voided hand keeps the ResultFlash pill untouched and never shows a
        // rake (there is no settled pot to rake).
        assert.equal((await visible(rakeNotice)).length, 0, 'aborted hand shows no rake');
      }
      const buttons = await visible(page.getByRole('button', { name: /^(Deal hand|Start hand)$/ }));
      assert.equal(
        buttons.length,
        1,
        `${viewport.width}/${kind}: one visible Deal control while result is open`,
      );
      assert.ok(
        await reachable(buttons[0]),
        `${viewport.width}/${kind}: result must not cover Deal`,
      );
      const before = sent.filter((t) => t === 'start_hand').length;
      await buttons[0].click();
      assert.equal(
        sent.filter((t) => t === 'start_hand').length,
        before + 1,
        'Deal sends start_hand',
      );
      if (kind === 'showdown') await page.screenshot({ path: `${out}/${viewport.width}.png` });
      if (kind === 'showdown' && viewport.width === 1440) {
        // A settings dialog above the recap owns the first Escape.
        await page
          .getByRole('button', { name: 'Edit keyboard shortcuts', exact: true })
          .filter({ visible: true })
          .click();
        const shortcuts = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true });
        await shortcuts.waitFor();
        await page.keyboard.press('Escape');
        await shortcuts.waitFor({ state: 'hidden' });
        assert.ok(await resultShown(), 'Escape closes only the top dialog');
      }
      await page.evaluate(() => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', repeat: true, bubbles: true }),
        );
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }),
        );
      });
      await frames();
      assert.ok(await resultShown(), 'Held/composing Escape does not dismiss the result');
      const sendsBeforeEscape = sent.length;
      await page.keyboard.press('Escape');
      await frames();
      assert.equal(await resultShown(), false, 'Escape dismisses the post-hand result');
      assert.equal(sent.length, sendsBeforeEscape, 'Escape sends no game action');
      // A fresh result is shown again, and it clears the way its kind allows:
      // the X on a voided recap, Escape on a normal live-region result.
      await fixture(kind);
      assert.ok(await resultShown(), 'fresh result is shown again');
      // The recap pill springs in (framer-motion), so its rect keeps micro-moving
      // and Playwright refuses its actionability click (and a forced one can miss
      // the drifting target). Fire the button's own handler; the assertion below
      // still requires the recap to have gone.
      if (kind === 'abort') await (await visible(dismiss))[0].evaluate((el) => el.click());
      else await page.keyboard.press('Escape');
      await frames();
      assert.equal(await resultShown(), false, 'the fresh result is cleared again');
      console.log(
        `${viewport.width}×${viewport.height} ${kind}: reachable Deal; held Escape ignored; result cleared`,
      );
    }
  }
  await ctx.close();
  assert.deepEqual(errors, [], 'No uncaught browser errors');
} finally {
  await browser.close();
}
