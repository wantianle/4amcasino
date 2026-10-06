import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const base = process.env.BASE_URL || 'http://localhost:5781';
const out = process.env.UAT_OUTPUT || '/tmp/4am-settlement-proof';
await mkdir(out, { recursive: true });
// 1x1 PNG - a real image the browser can decode inside the proof dialog.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
);
const states = [
  { name: 'not-started', marks: [], expected: '这笔结算还没有开始。' },
  { name: 'one-sided', marks: [{ userId: 2, name: 'Alex', note: '我已转账，备注在这里', hasProof: true, ts: 1 }], expected: 'River尚未填写。' },
  { name: 'both-sides', marks: [{ userId: 2, name: 'Alex', note: '我已转账，备注在这里', hasProof: true, ts: 1 }, { userId: 9, name: 'River', note: '对方确认了这笔钱', hasProof: false, ts: 2 }], expected: '对方确认了这笔钱' },
  { name: 'proof-empty', marks: [{ userId: 2, name: 'Alex', note: '备注没有凭证', hasProof: false, ts: 1 }, { userId: 9, name: 'River', note: '对方备注', hasProof: false, ts: 2 }], expected: '未上传转账凭证。' },
  // A stray third-party mark must not leak: no note shown, no proof button, and
  // crucially no request to that user's proof endpoint.
  { name: 'third-party', marks: [{ userId: 99, name: 'Mallory', note: '第三方备注 secret', hasProof: true, ts: 3 }], expected: 'River尚未填写。', forbid: ['第三方备注 secret', 'Mallory'], expectNoProofRequest: true },
  // A genuine proof: clicking must fetch the Blob and show it in the dialog.
  { name: 'proof-success', marks: [{ userId: 9, name: 'River', note: '对方的转账凭证', hasProof: true, ts: 4 }], expected: '对方的转账凭证', clickProof: 9 },
];
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
try {
  for (const state of states) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await context.addInitScript(() => localStorage.setItem('4am-auth', JSON.stringify({ state: { auth: { token: 'fixture', userId: 2, username: 'alex', identity: null } }, version: 0 })));
    const page = await context.newPage();
    const proofRequests = [];
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.includes('/proof/')) proofRequests.push(url.pathname);
      if (url.pathname === '/api/me') return route.fulfill({ json: { id: 2, userId: 2, username: 'alex', displayName: 'Alex', isPlatform: false } });
      if (url.pathname === '/api/me/settle') return route.fulfill({ json: { people: [{ otherUserId: 9, otherName: 'River', otherAvatarVersion: 0, net: 100, rooms: [{ roomId: 'room-1', roomName: 'Friday room', amount: 100, direction: 'owed', ...(state.name === 'not-started' ? {} : { settlementId: 42 }) }] }], redirects: [], totals: { owedToMe: 100, iOwe: 0, net: 100 }, settled: [], house: { accrued: 0, paid: 0, outstanding: 0, credit: 0, rooms: [] } } });
      if (url.pathname.endsWith('/marks')) return route.fulfill({ json: { marks: state.marks } });
      if (url.pathname.includes('/proof/')) {
        if (state.clickProof && url.pathname.endsWith(`/proof/${state.clickProof}`)) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
        return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'no photo' }) });
      }
      return route.fulfill({ json: {} });
    });
    await page.goto(`${base}/settle`);
    await page.waitForTimeout(2000);
    if (!(await page.locator('body').textContent()).includes('结账')) {
      console.log(`${state.name}: init body=${JSON.stringify((await page.locator('body').textContent()).slice(0, 500))}`);
      throw new Error(`${state.name}: page did not initialize`);
    }
    await page.getByText(state.expected).first().waitFor();
    let texts = await page.locator('body').textContent();
    if (!texts.includes(state.expected)) throw new Error(`${state.name}: expected text missing`);
    for (const forbidden of state.forbid ?? []) {
      if (texts.includes(forbidden)) throw new Error(`${state.name}: leaked forbidden text ${JSON.stringify(forbidden)}`);
    }
    if (state.expectNoProofRequest && proofRequests.length > 0) {
      throw new Error(`${state.name}: unexpected proof requests ${JSON.stringify(proofRequests)}`);
    }
    if (state.clickProof) {
      const button = page.getByRole('button', { name: '打开转账凭证' }).first();
      await button.click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor({ timeout: 5000 });
      const src = await dialog.locator('img').getAttribute('src');
      if (!src || !src.startsWith('blob:')) throw new Error(`${state.name}: proof image is not a blob URL (${src})`);
      if (!proofRequests.some((p) => p.endsWith(`/proof/${state.clickProof}`))) {
        throw new Error(`${state.name}: never requested /proof/${state.clickProof} (${JSON.stringify(proofRequests)})`);
      }
      await page.screenshot({ path: `${out}/${state.name}-dialog.png`, fullPage: true });
      console.log(`${state.name}: clicked proof button, dialog img src=${JSON.stringify(src)} requests=${JSON.stringify(proofRequests)} screenshot=${out}/${state.name}-dialog.png`);
    }
    const path = `${out}/${state.name}.png`;
    await page.screenshot({ path, fullPage: true });
    texts = await page.locator('body').textContent();
    console.log(`${state.name}: assertion=${JSON.stringify(state.expected)} textContent=${JSON.stringify(texts.match(new RegExp(state.expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))?.length ?? 0)} proofRequests=${JSON.stringify(proofRequests)} screenshot=${path}`);
    await context.close();
  }
  console.log('settlement-proof: all states passed');
} finally { await browser.close(); }
