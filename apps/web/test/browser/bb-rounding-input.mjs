/** Real-interaction evidence for the BB rounding / bet-input semantics
 *  (review issues 1 + 2). Drives the Vite dev server with the same synthetic
 *  room + mocked transport as table-bet-presets.mjs, forces a my-turn preflop
 *  state on a SHORT stack so `maxRaiseTo` is the all-in (123 chips at bb 20 →
 *  the input labels it "6.5 BB"), and captures the exact `action` frame the
 *  client sends.
 *
 *  Prefs are seeded through the persisted `4am-auth` snapshot (the same store
 *  the app rehydrates), never by importing the store from the page — a dev
 *  dynamic import can resolve a second module instance.
 *
 *  Cases (one fresh page each — a send latches the panel):
 *    1. typed 6.5 BB + click Raise  → sends 123 (exact all-in), not 130
 *    2. All-in pill + click Raise   → sends 123 (same number)
 *    3. typed 6.5 BB + Enter        → sends 123 (same number)
 *    4. typed 6.01 BB on a deep stack + Enter → sends 130 (the full product
 *       must reach the small-blind ceil; a pre-round would drop it to 120)
 *    5. no send: blur / slider arrow / slider wheel wiring stays on the
 *       small-blind grid (rounds UP, never down) and captures zero action frames
 *
 *   PLAYWRIGHT_MODULE   path to a Playwright install (default 'playwright-core')
 *   BROWSER_EXECUTABLE  Chrome binary (default /usr/bin/google-chrome)
 *   BASE_URL            dev server (default http://localhost:5173)
 *   UAT_OUTPUT          output directory (default docs/qa/bb-rounding-input)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const chromium = pw.chromium ?? pw.default?.chromium;
// A real ed25519 identity: `act()` signs the action frame, so auth.identity must
// be present (the production app derives it from the password).
const { ed25519 } = require('@noble/curves/ed25519');
const { bytesToHex } = require('@noble/hashes/utils');
const IDENTITY = (() => {
  const seed = new Uint8Array(32).fill(7);
  return { publicKey: bytesToHex(ed25519.getPublicKey(seed)), secretKey: bytesToHex(seed) };
})();
const base = process.env.BASE_URL || 'http://localhost:5173';
const out =
  process.env.UAT_OUTPUT ||
  fileURLToPath(new URL('../../../../docs/qa/bb-rounding-input', import.meta.url));
await mkdir(out, { recursive: true });

const MY_USER = 2;
const MY_SEAT = 4;
const COUNT = 9;
const SB = 10;
const BB = 20;
const NAMES = ['Alex', 'Meera', 'Zoya', 'Ishaan', 'River', 'Jules', 'Mira', 'Sol', 'Sam'];
const SHORT_STACK = 123; // all-in maxRaiseTo = 0 committed + 123
const DEEP_STACK = 500; // no clamp: 122 → 130 proves the blur up-snap

const room = {
  t: 'room_state',
  room: {
    id: 'bbrounding',
    name: 'BB Rounding',
    joinCode: 'BBRND',
    hostId: MY_USER,
    bankerId: MY_USER,
    sb: SB,
    bb: BB,
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
  players: Array.from({ length: COUNT }, (_, i) => ({
    seat: i,
    userId: i === MY_SEAT ? MY_USER : 100 + i,
    username: (i === MY_SEAT ? 'alex' : NAMES[i]).toLowerCase(),
    displayName: i === MY_SEAT ? 'Alex' : NAMES[i],
    stack: i === MY_SEAT ? SHORT_STACK : 2000,
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
  args: ['--no-sandbox'],
});

const pageErrors = [];
const results = {};

const numInput = '[data-testid="betting-panel"] input[type=number]';
const rangeInput = '[data-testid="betting-panel"] input[type=range]';
const raiseBtn = '[data-testid="betting-panel"] .table-btn--raise';

/** Fresh, my-turn page on `stack`; prefs (unit + all-in pill) seeded through
 *  the persisted store snapshot so the app rehydrates them itself. */
async function openCase(stack, unit) {
  const captured = [];
  const seen = [];
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
  });
  await ctx.addInitScript(
    ({ uid, stackUnit, identity }) => {
      localStorage.setItem('4am-sounds', 'off');
      localStorage.setItem('4am-stack-unit', stackUnit === 'bb' ? 'bb' : 'chips');
      localStorage.setItem(
        '4am-auth',
        JSON.stringify({
          state: {
            auth: { token: 'bb-fixture', userId: uid, username: 'alex', identity },
            // five slots, all-in included, so pill == typed max is comparison-ready
            prefs: { stackUnit, betRatios: [-1, 1 / 3, 0.5, 0.75, 1.5] },
          },
          version: 0,
        }),
      );
    },
    { uid: MY_USER, stackUnit: unit, identity: IDENTITY },
  );
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (e) => pageErrors.push(e.message));
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
        // no betRatios: loadPrefs keeps the seeded local list
      },
    }),
  );
  await page.routeWebSocket('**/*', (ws) =>
    ws.onMessage((data) => {
      const msg = JSON.parse(String(data));
      seen.push(msg.t);
      if (msg.t === 'action') captured.push(msg);
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
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              t: 'hand_start',
              handId: 'bbrounding',
              seats: room.players.map((p) => ({
                seat: p.seat,
                userId: p.userId,
                username: p.username,
                publicKey: p.publicKey,
                stack: p.seat === MY_SEAT ? stack : 2000,
              })),
              buttonSeat: 0,
              sb: SB,
              bb: BB,
              auditMode: 'private',
            }),
          );
          ws.send(
            JSON.stringify({
              t: 'betting_state',
              handId: 'bbrounding',
              actionSeq: 0,
              state: {
                street: 'preflop',
                seats: order.map((seat) => ({
                  seat,
                  stack: seat === MY_SEAT ? stack : 2000,
                  committed: seat === 0 ? SB : seat === 1 ? BB : 0,
                  total: seat === 0 ? SB : seat === 1 ? BB : 0,
                  folded: false,
                  allIn: false,
                  lastActedAt: null,
                })),
                buttonSeat: 0,
                sb: SB,
                bb: BB,
                currentBet: BB,
                lastRaiseSize: BB,
                lastFullRaiseAt: BB,
                toAct: MY_SEAT,
                needToAct: [MY_SEAT, ...order.filter((s) => s !== MY_SEAT)],
                winnerByFold: null,
              },
              board: [],
              deadline: Date.now() + 30000,
              baseDeadline: Date.now() + 30000,
            }),
          );
        }, 700);
      }
    }),
  );

  await page.goto(`${base}/room/${room.room.id}`);
  await page.waitForSelector(numInput, { state: 'visible' });
  // the raise CTA only enables on my turn with a legal, valid amount
  await page.waitForFunction(() => {
    const b = document.querySelector(
      '[data-testid="betting-panel"] .table-btn--raise',
    );
    return b && !b.disabled;
  });
  await page.waitForTimeout(250);
  return { ctx, page, captured, seen };
}

async function waitForAction(page, captured) {
  for (let i = 0; i < 40 && captured.length === 0; i++) await page.waitForTimeout(100);
  return captured;
}

try {
  // ── Case 1: typed 6.5 BB + click Raise → exact all-in 123 ────────────────
  {
    const { ctx, page, captured, seen } = await openCase(SHORT_STACK, 'bb');
    const maxAttr = await page.getAttribute(numInput, 'max');
    await page.fill(numInput, '6.5');
    await page.waitForTimeout(150);
    await page.click(raiseBtn);
    await waitForAction(page, captured);
    results.typedClick = { maxAttr, seen: [...seen], sent: captured[0]?.action ?? null };
    await ctx.close();
  }

  // ── Case 2: All-in pill + click Raise → 123 (same number) ────────────────
  {
    const { ctx, page, captured } = await openCase(SHORT_STACK, 'bb');
    await page.click('[data-testid="betting-panel"] .table-quick--allin');
    await page.waitForTimeout(150);
    await page.click(raiseBtn);
    await waitForAction(page, captured);
    results.allinPill = { sent: captured[0]?.action ?? null };
    await ctx.close();
  }

  // ── Case 3: typed 6.5 BB + Enter → 123 (same number) ─────────────────────
  {
    const { ctx, page, captured } = await openCase(SHORT_STACK, 'bb');
    await page.fill(numInput, '6.5');
    await page.locator(numInput).press('Enter');
    await waitForAction(page, captured);
    results.enter = { sent: captured[0]?.action ?? null };
    await ctx.close();
  }

  // ── Case 4: typed 6.01 BB on a deep stack + Enter → 130 (no pre-round) ───
  {
    const { ctx, page, captured } = await openCase(DEEP_STACK, 'bb');
    await page.fill(numInput, '6.01');
    await page.waitForTimeout(150);
    // Display rounds the 120.2-chip target UP to the 0.5 BB grid → 6.5 BB.
    const shown = await page.inputValue(numInput);
    await page.locator(numInput).press('Enter');
    await waitForAction(page, captured);
    results.deepFractional = { shown, sent: captured[0]?.action ?? null };
    await ctx.close();
  }

  // ── Case 5: wiring only (no send) — blur / arrow / wheel ─────────────────
  {
    const { ctx, page, captured } = await openCase(DEEP_STACK, 'chips');

    await page.fill(numInput, '122');
    await page.locator(numInput).blur();
    await page.waitForTimeout(120);
    const afterBlur = await page.inputValue(numInput);

    await page.fill(numInput, '50');
    await page.locator(numInput).blur();
    await page.waitForTimeout(120);
    const beforeArrow = await page.inputValue(numInput);
    await page.locator(rangeInput).focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(120);
    const afterArrow = await page.inputValue(numInput);

    await page.locator(rangeInput).hover();
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(120);
    const afterWheel = await page.inputValue(numInput);

    // The "no send" claim is explicit: none of the edits above may emit an
    // action frame (a captured empty list is the assertion, not just a comment).
    results.wiring = { afterBlur, beforeArrow, afterArrow, afterWheel, capturedCount: captured.length };
    await ctx.close();
  }

  await writeFile(
    `${out}/browser-result.json`,
    JSON.stringify({ results, pageErrors, generatedAt: new Date().toISOString() }, null, 1),
  );
  console.log(JSON.stringify(results, null, 1));

  const ok =
    results.typedClick.sent?.amount === 123 &&
    results.typedClick.sent?.type === 'raise' &&
    results.allinPill.sent?.amount === 123 &&
    results.enter.sent?.amount === 123 &&
    results.deepFractional.sent?.amount === 130 &&
    results.deepFractional.sent?.type === 'raise' &&
    results.deepFractional.shown === '6.5' &&
    results.typedClick.maxAttr === '6.5' &&
    results.wiring.afterBlur === '130' &&
    results.wiring.afterArrow === '60' &&
    results.wiring.afterWheel === '70' &&
    results.wiring.capturedCount === 0;
  if (!ok) throw new Error(`bb-rounding-input mismatches: ${JSON.stringify(results)}`);
  console.log('bb-rounding-input: all cases passed');
} finally {
  await browser.close();
}
if (pageErrors.length) {
  console.error(`PAGE ERRORS:\n${pageErrors.join('\n')}`);
  process.exit(1);
}
console.log('no page errors');
