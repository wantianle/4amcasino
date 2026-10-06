/** Real Settings-page evidence for the three appearance axes.
 *
 * For every option it asserts four independent things:
 *   1. the picker button reports `aria-pressed="true"` (and exactly one per axis);
 *   2. the live zustand store (persisted `4am-auth`) holds the picked value;
 *   3. the `PUT /api/profile` payload actually carried the value;
 *   4. after a full page reload the picker and store still hold it.
 *
 * Usage: BASE_URL=http://127.0.0.1:<free-port> UAT_OUTPUT=/abs/path node this-file
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const base = process.env.BASE_URL || 'http://127.0.0.1:5173';
const out = process.env.UAT_OUTPUT || '/tmp/4am-table-appearance';
await mkdir(out, { recursive: true });

const AXES = [
  {
    key: 'cardBack',
    attr: 'data-card-back',
    values: [
      'indigo', 'crimson', 'emerald', 'slate', 'wine-lattice', 'black-gold',
      'classic-red-blue', 'geometry', 'deep-blue-silver',
    ],
  },
  {
    key: 'cardFace',
    attr: 'data-card-face',
    values: ['gg-four-color', 'gg-solid', 'classic-large', 'jumbo-accessible', 'minimal'],
  },
  {
    key: 'tableSkin',
    attr: 'data-table-skin',
    values: ['gg-green', 'sapphire', 'burgundy', 'classic-casino'],
  },
];

// The server's authoritative copy, updated by each PUT and echoed on GET.
const persisted = { cardBack: 'crimson', cardFace: 'gg-four-color', tableSkin: 'gg-green' };
const putLog = [];
const profilePayload = () => ({
  userId: 7,
  username: 'alice',
  displayName: 'Alice',
  bio: '',
  hasAvatar: false,
  avatarVersion: 0,
  ...persisted,
  fourColor: persisted.cardFace === 'gg-four-color',
  quickPhrases: [],
  privateMode: false,
  autoJoinInvites: false,
  autoReady: true,
  pokerHotkeys: { enabled: false, bindings: {} },
});

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/google-chrome',
  args: ['--no-sandbox'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => {
  localStorage.setItem('4am-auth', JSON.stringify({
    state: { auth: { token: 'appearance-fixture', userId: 7, username: 'alice', identity: null } },
    version: 0,
  }));
  localStorage.setItem('4am-sounds', 'off');
});
const page = await context.newPage();
page.setDefaultTimeout(30000);

// Register the generic catch-all FIRST: Playwright checks routes in reverse
// registration order, so the specific /api/profile route below wins. (With the
// old order the blanket /api/** masked the profile mock entirely.)
await page.route('**/api/**', (route) =>
  route.fulfill({ json: { ok: true, userId: 7, ...persisted } }),
);
await page.route(/\/api\/profile(?:\?|$)/, async (route) => {
  if (route.request().method() === 'PUT') {
    const body = route.request().postDataJSON();
    putLog.push(body);
    Object.assign(persisted, body);
  }
  await route.fulfill({ json: profilePayload() });
});

const storePrefs = () =>
  page.evaluate(() => JSON.parse(localStorage.getItem('4am-auth') || '{}')?.state?.prefs ?? null);

const buttonFor = (attr, value) =>
  page.locator('button', { has: page.locator(`[${attr}="${value}"]`) }).first();

async function waitFor(fn, what) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function assertHolds(axis, value, phase) {
  const { attr, key } = axis;
  const button = buttonFor(attr, value);
  await button.waitFor();
  // 1. aria-pressed on the target, and exactly one pressed in its own grid.
  //    (A face-up preview also carries `data-card-back`, so a whole-page count
  //    would pick up the face grid as well — scope to the sibling grid.)
  await page.waitForFunction(
    ([a, v]) => {
      const target = [...document.querySelectorAll('button')].find((b) =>
        b.querySelector(`[${a}="${v}"]`),
      );
      return target?.getAttribute('aria-pressed') === 'true';
    },
    [attr, value],
  );
  assert.equal(await button.getAttribute('aria-pressed'), 'true', `${phase}: aria-pressed`);
  const pressedInGrid = await button
    .locator('xpath=..')
    .locator('button[aria-pressed="true"]')
    .count();
  assert.equal(pressedInGrid, 1, `${phase}: expected exactly one pressed ${attr}`);

  // 2. live store value
  await waitFor(async () => (await storePrefs())?.[key] === value, `${phase} store ${key}=${value}`);
  assert.equal((await storePrefs())[key], value, `${phase}: store ${key}`);

  // 3. server-persisted value from the PUT payload
  assert.equal(persisted[key], value, `${phase}: PUT persisted ${key}`);
  assert.ok(
    putLog.some((p) => p[key] === value),
    `${phase}: no PUT carried ${key}=${value}`,
  );
}

const results = [];
const screenshots = [];

try {
  await page.goto(`${base}/settings`);
  await page.getByRole('heading', { name: '牌桌与对战' }).waitFor();

  for (const axis of AXES) {
    for (const value of axis.values) {
      await buttonFor(axis.attr, value).click();
      await assertHolds(axis, value, 'after click');

      // 4. survives a full reload (store rehydrates + profile GET re-syncs)
      await page.reload();
      await page.getByRole('heading', { name: '牌桌与对战' }).waitFor();
      await assertHolds(axis, value, 'after reload');

      results.push({ axis: axis.key, value, ok: true });
      console.log(`ok ${axis.key}=${value} (aria-pressed + store + PUT + reload)`);
    }
    const shot = `${out}/${axis.key}-last.png`;
    await page.screenshot({ path: shot, fullPage: true });
    screenshots.push(shot);
  }

  console.log(JSON.stringify({ results, screenshots }, null, 2));
} finally {
  await browser.close();
}
