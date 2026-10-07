#!/usr/bin/env node
// shot-design.mjs — 设计稿截图重生成 + 硬门禁（HTML 即唯一源；按 .screen 逐个截取 .stage）
// 用法: (cd docs/fixtures && python3 -m http.server 8123 &) ; \
//        node docs/fixtures/shot-design.mjs http://localhost:8123/gg-replication-design.html \
//             docs/fixtures/gg-replication-screenshots
// 输出: JPEG quality=85, deviceScaleFactor 1.5（桌面舞台 1770x1170 · 手机 600x1299）
// 门禁（任一不满足即 exit 1，参数非法 exit 2）:
//   - 参数必须齐且 URL 必须是 localhost http（自包含要求，拒绝 file:// 之外的远程源）
//   - screens 数量必须等于 21
//   - 每张截图必须落盘且非空
//   - EXTERNAL_REQUESTS 必须为空；page/console/requestfailed 错误必须为空
// 改 HTML 后请重新跑 audit-design.mjs（品牌词门禁）再跑本脚本。
import { chromium } from 'playwright-core';
import { mkdirSync, existsSync, statSync } from 'node:fs';

const EXE = '/usr/bin/google-chrome';
const [URL, OUT] = process.argv.slice(2);
const EXPECT_SCREENS = 21;

if (!URL || !OUT) {
  console.error('usage: node docs/fixtures/shot-design.mjs <http://localhost/...html> <out-dir>');
  process.exit(2);
}
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL)) {
  console.error(`REFUSE: URL must be a localhost http(s) URL, got: ${URL}`);
  process.exit(2);
}
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
page.on('request', r => { const u = r.url(); if (!/^(https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/|data:)/.test(u)) external.push(u); });

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);

let bad = 0;
const screens = await page.$$('.screen');
console.log('screens:', screens.length);
if (screens.length !== EXPECT_SCREENS) {
  console.error(`FAIL: screens=${screens.length} want ${EXPECT_SCREENS}`);
  bad++;
}
for (const s of screens) {
  const id = await s.getAttribute('id');
  const stage = await s.$('.stage');
  if (!id || !stage) { console.error(`FAIL: screen missing id or .stage`); bad++; continue; }
  const path = `${OUT}/${id}.jpg`;
  await stage.screenshot({ type: 'jpeg', quality: 85, path });
  if (!existsSync(path) || statSync(path).size < 1024) {
    console.error(`FAIL: screenshot missing or suspiciously small: ${path}`);
    bad++;
  } else {
    console.log('shot', id, statSync(path).size, 'bytes');
  }
}
if (external.length) { console.error('FAIL EXTERNAL_REQUESTS:', external); bad++; }
else console.log('EXTERNAL_REQUESTS: none');
if (errors.length) { console.error('FAIL ERRORS:', errors); bad++; }
else console.log('ERRORS: none');
await browser.close();
console.log(bad ? `RESULT: FAIL (${bad} problem(s))` : 'RESULT: PASS');
process.exit(bad ? 1 : 0);
