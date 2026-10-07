#!/usr/bin/env node
// shot-design.mjs — 设计稿截图重生成（HTML 即唯一源；此脚本按 .screen 逐个截取 .stage）
// 用法: (cd docs/fixtures && python3 -m http.server 8123 & node shot-design.mjs \
//            http://localhost:8123/gg-replication-design.html gg-replication-screenshots)
// 输出: JPEG quality=85, deviceScaleFactor 1.5（桌面舞台 1770x1170 · 手机 600x1299）
// 校验: 结尾打印 EXTERNAL_REQUESTS（必须 none）与 ERRORS（必须 none）；
//       改 HTML 后请重新跑 audit-design.mjs（品牌词门禁）再跑本脚本。
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const EXE = '/usr/bin/google-chrome';
const URL = process.argv[2];
const OUT = process.argv[3];
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: EXE,
  args: ['--no-sandbox', '--disable-gpu', '--force-color-profile=srgb',
         '--font-render-hinting=none', '--hide-scrollbars'],
});
const ctx = await browser.newContext({ deviceScaleFactor: 1.5, viewport: { width: 1400, height: 1000 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text()); });
page.on('requestfailed', r => errors.push('REQFAIL ' + r.url()));
const external = [];
page.on('request', r => { if (!r.url().startsWith('http://localhost') && !r.url().startsWith('data:')) external.push(r.url()); });

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);

const screens = await page.$$('.screen');
console.log('screens:', screens.length);
for (const s of screens) {
  const id = await s.getAttribute('id');
  const stage = await s.$('.stage');
  await stage.screenshot({ type: 'jpeg', quality: 85, path: `${OUT}/${id}.jpg` });
  console.log('shot', id);
}
console.log('EXTERNAL_REQUESTS:', external.length ? external : 'none');
console.log('ERRORS:', errors.length ? errors : 'none');
await browser.close();
