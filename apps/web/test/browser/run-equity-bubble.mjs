/** Real-browser proof for the live all-in equity bubble.
 *
 * Drives the Vite dev server with a mocked websocket: a two-seat hand receives
 * `runout_reveal` and `equity_update` frames exactly as the server sends them,
 * and the harness asserts the order the user asked for - the cards flip FIRST
 * (runout_reveal) and only then does the bubble appear and refresh per street -
 * plus the <3%/<1% copy, the ~2s hidden gap between runs and the showdown wipe.
 *
 *   BASE_URL=http://127.0.0.1:5347 node apps/web/test/browser/run-equity-bubble.mjs
 *   PLAYWRIGHT_MODULE / BROWSER_EXECUTABLE / UAT_OUTPUT override the defaults.
 *
 * Screenshots land in docs/qa/run-equity as JPEG.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const base = process.env.BASE_URL || 'http://127.0.0.1:5347';
const out =
  process.env.UAT_OUTPUT ||
  fileURLToPath(new URL('../../../../docs/qa/run-equity/', import.meta.url));
await mkdir(out, { recursive: true });

const ME = 2;
const names = ['Alex', 'Meera'];
const room = {
  t: 'room_state',
  room: {
    id: 'run-equity-qa',
    name: 'Run equity bubble QA',
    joinCode: 'RUNEQU',
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
  handActive: true,
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
        state: {
          auth: { token: 'run-equity-fixture', userId: 2, username: 'alex', identity: null },
        },
        version: 0,
      }),
    );
    localStorage.setItem('4am.locale', JSON.stringify({ state: { locale: 'zh-CN' }, version: 0 }));
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
  // zh-CN is the product default: the host's start button reads 发牌.
  await page.getByRole('button', { name: '发牌', exact: true }).first().waitFor();
  await page.evaluate(async () => {
    const { useStore, emptyHand } = await import('/src/shared/store.ts');
    window.qaStore = useStore;
    window.qaEmpty = emptyHand;
  });

  const handId = 'run-equity-bubble';
  await page.evaluate(
    ({ handId }) => {
      const s = qaStore.getState();
      qaStore.getState().patchHand({
        handId,
        seats: s.room.players.map((p) => ({ seat: p.seat, userId: p.userId, stack: p.stack })),
      });
    },
    { handId },
  );

  const frames = () =>
    page.evaluate(async () => {
      for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
    });
  const send = (frame) => {
    sentOrder.push(frame.t);
    for (const ws of sockets) ws.send(JSON.stringify(frame));
  };
  const bubbles = () =>
    page.evaluate(() => {
      const read = (seat) => {
        const el = document.querySelector(`[data-seat-anchor="${seat}"] .table-equity-bubble`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const css = getComputedStyle(el);
        return {
          text: el.textContent,
          color: css.color,
          over: el.classList.contains('table-equity-bubble--over'),
          x: Math.round(r.x),
          y: Math.round(r.y),
        };
      };
      return {
        count: document.querySelectorAll('.table-equity-bubble').length,
        seat0: read(0),
        seat1: read(1),
      };
    });
  const shot = (name) => page.screenshot({ path: `${out}/${name}`, type: 'jpeg', quality: 82 });

  /** The order the server is expected to emit on an all-in runout. */
  const sentOrder = [];

  // ── all-in reveal: the cards flip BEFORE any equity bubble ──
  send({
    t: 'runout_reveal',
    handId,
    reveals: [
      { seat: 0, cards: [0, 1] },
      { seat: 1, cards: [2, 3] },
    ],
  });
  await frames();
  assert.deepEqual(
    (await bubbles()).count,
    0,
    'no equity bubble appears before the reveal + its first equity frame',
  );
  const opponentMode = await page.evaluate(() =>
    document.querySelector('[data-seat-anchor="1"]')?.getAttribute('data-seat-hand-mode'),
  );
  assert.equal(opponentMode, 'showdown', 'runout_reveal flips the opponent cards face-up first');
  // The screenshot is product evidence, so require the visual state itself,
  // not just the store: every seat pod rendered with a visible avatar, the
  // opponent's two hole cards face-up (data-card-face, not a back), and no
  // bubble yet. A blank/empty table can never be written as 00-reveal.jpg.
  const revealUi = await page.evaluate(() => {
    const geom = (el) => {
      const r = el.getBoundingClientRect();
      return {
        w: Math.round(r.width),
        h: Math.round(r.height),
        x: Math.round(r.x),
        y: Math.round(r.y),
      };
    };
    const vis = (sel) =>
      [...document.querySelectorAll(sel)].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0;
      });
    const opp = document.querySelector('[data-seat-anchor="1"]');
    return {
      anchors: [...document.querySelectorAll('[data-seat-anchor]')].map(geom),
      avatarRings: vis('[data-seat-anchor] .table-avatar-ring').map(geom),
      // data-card-face is emitted on both the card root and its inner face;
      // data-card-rank only on the rank-bearing inner face, so this is exactly
      // one element per visible hole card.
      oppFaces: opp ? opp.querySelectorAll('[data-card-rank]').length : -1,
      // The face-up reveal uses the side-by-side container; a hidden hand uses
      // the tilted fan. The back element itself stays in the DOM for the 3D
      // flip either way, so the container class is the reliable visual signal.
      oppSide: opp ? opp.querySelectorAll('.table-pod-holo--side').length : -1,
      oppFan: opp ? opp.querySelectorAll('.table-pod-holo--fan').length : -1,
      bubbles: document.querySelectorAll('.table-equity-bubble').length,
    };
  });
  assert.equal(revealUi.anchors.length, 2, 'both seats are laid out for the reveal shot');
  assert.ok(
    revealUi.anchors.every((a) => a.w > 0 && a.h > 0),
    'both seat pods occupy real space',
  );
  assert.equal(revealUi.avatarRings.length, 2, 'both participant avatars are visible');
  assert.equal(revealUi.oppFaces, 2, "the opponent's two hole cards are face-up (data-card-rank)");
  assert.equal(revealUi.oppSide, 1, 'the opponent cards use the face-up side-by-side container');
  assert.equal(revealUi.oppFan, 0, 'no face-down fan remains at the opponent seat');
  assert.equal(revealUi.bubbles, 0, 'still no bubble in the reveal shot');
  await shot('00-reveal.jpg');

  const equity = (run, runs, board, s0, s1) =>
    send({
      t: 'equity_update',
      handId,
      run,
      runs,
      board,
      equities: [
        { seat: 0, bps: s0 },
        { seat: 1, bps: s1 },
      ],
    });

  // ── flop: both bubbles appear, advantaged green / behind red ──
  equity(1, 2, [0, 1, 2], 8596, 1404);
  await frames();
  let b = await bubbles();
  assert.equal(b.count, 2, 'both seats get a bubble after the flop equity frame');
  assert.equal(b.seat0?.text, '85.96%', 'the ahead seat shows its exact percentage');
  assert.equal(b.seat1?.text, '14.04%', 'the behind seat shows its exact percentage');
  assert.equal(b.seat0?.over, true, 'the ahead seat is the green side');
  assert.equal(b.seat1?.over, false, 'the behind seat is the red side');
  assert.notEqual(b.seat0?.color, b.seat1?.color, 'the two bubbles use different colours');
  await shot('01-flop.jpg');

  // ── turn: the numbers refresh, the bubble is not re-created ──
  equity(1, 2, [0, 1, 2, 3], 9318, 682);
  await frames();
  b = await bubbles();
  assert.equal(b.count, 2, 'still exactly two bubbles after the turn');
  assert.equal(b.seat0?.text, '93.18%', 'the turn refresh changed the ahead number');
  assert.equal(b.seat1?.text, '6.82%', 'the turn refresh changed the behind number');
  await shot('02-turn.jpg');

  // ── sub-3% copy: 还有机会 / 听死牌 replace the numbers ──
  equity(1, 2, [0, 1, 2, 3, 4], 150, 50);
  await frames();
  b = await bubbles();
  assert.equal(b.seat0?.text, '还有机会', 'under 3% shows 还有机会, not a number');
  assert.equal(b.seat1?.text, '听死牌', 'under 1% shows 听死牌, not a number');
  await shot('03-low.jpg');

  // ── between two runs: hidden first, then the recomputed run-2 number ──
  equity(2, 2, [5, 6, 7], 7000, 3000);
  await frames();
  b = await bubbles();
  assert.equal(b.count, 0, 'the bubble disappears the moment the next run starts');
  await page.waitForTimeout(2300);
  await frames();
  b = await bubbles();
  assert.equal(b.count, 2, 'the run-2 bubble returns after the ~2s gap');
  assert.equal(b.seat0?.text, '70.00%', 'the run-2 bubble carries the recomputed value');
  await shot('04-run2.jpg');

  // ── showdown: bubbles are gone ──
  send({
    t: 'showdown',
    handId,
    reveals: [
      { seat: 0, cards: [0, 1], score: 100 },
      { seat: 1, cards: [2, 3], score: 50 },
    ],
    awards: [{ seat: 0, amount: 100 }],
  });
  await frames();
  b = await bubbles();
  assert.equal(b.count, 0, 'the bubble disappears at showdown');
  await shot('05-showdown.jpg');

  // the protocol order the UI was trained on: reveal first, then equity, then
  // the showdown wipe last.
  assert.equal(sentOrder[0], 'runout_reveal', 'the reveal frame is emitted first');
  assert.ok(
    sentOrder.indexOf('equity_update') > sentOrder.indexOf('runout_reveal'),
    'every equity frame follows the reveal',
  );
  assert.equal(sentOrder.at(-1), 'showdown', 'the showdown closes the sequence');

  assert.deepEqual(errors, [], 'no uncaught browser errors');
  console.log(
    `✓ reveal-before-equity + appear/refresh/low-copy/run-gap/disappear verified; shots in ${out}`,
  );
} finally {
  await browser.close();
}
