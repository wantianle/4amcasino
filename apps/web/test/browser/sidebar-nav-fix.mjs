import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const base = process.env.BASE_URL || 'http://localhost:5173';
const out = process.env.UAT_OUTPUT || '/tmp/4am-sidebar-nav-fix';
await mkdir(out, { recursive: true });

const viewports = [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 1440, height: 800 },
  { width: 1440, height: 640 },
];
const mobileViewport = { width: 390, height: 844 };
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/google-chrome',
  args: ['--no-sandbox'],
});
const results = [];
async function waitForNav(page) {
  await page.waitForSelector('.zeus-sidebar');
  await page.waitForTimeout(250);
}
async function openTables(page) {
  const trigger = page.locator('.zeus-table-trigger');
  if ((await trigger.getAttribute('aria-expanded')) === 'true') await trigger.click();
  await trigger.click();
  await page.locator('#rail-table-links a').first().waitFor();
}
async function visibleAndUncovered(page, locator, label) {
  const box = await locator.boundingBox();
  const bottom = box && box.y + box.height;
  if (!box || bottom > page.viewportSize().height || box.y < 0) {
    throw new Error(`${label} is outside viewport: ${JSON.stringify(box)}`);
  }
  const uncovered = await locator.evaluate((target, { x, y }) => {
    const element = document.elementFromPoint(x, y);
    return !!element && (element === target || target.contains(element));
  }, { x: box.x + Math.min(box.width / 2, 40), y: box.y + box.height / 2 });
  if (!uncovered) throw new Error(`${label} is covered at its center`);
}
async function clickTableLink(page, index, roomCount) {
  const links = page.locator('#rail-table-links a');
  const link = links.nth(index);
  await link.scrollIntoViewIfNeeded();
  await visibleAndUncovered(page, link, `table ${index + 1}`);
  const href = await link.getAttribute('href');
  await link.click();
  await page.waitForURL(new RegExp(`${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  return href;
}
async function clickAndAssertRoute(page, locator, label) {
  await locator.scrollIntoViewIfNeeded();
  await visibleAndUncovered(page, locator, label);
  const href = await locator.getAttribute('href');
  if (!href) throw new Error(`${label} has no href`);
  await locator.click();
  await page.waitForURL(new RegExp(`${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  return href;
}
try {
  for (const viewport of viewports) {
    for (const roomCount of [0, 1, 12]) {
      for (const waiting of [0, 1]) {
        const context = await browser.newContext({ viewport });
        await context.addInitScript(({ roomCount, waiting }) => {
          localStorage.setItem('4am-auth', JSON.stringify({ state: {
             auth: { token: 'peek-fixture', userId: 2, username: 'probe', identity: null },
            prefs: { displayName: 'Probe' },
          }, version: 0 }));
          localStorage.setItem('4am-sidebar', 'rail');
          window.__sidebarProbe = { roomCount, waiting };
        }, { roomCount, waiting });
        const page = await context.newPage();
        await page.route('**/api/**', async (route) => {
          const url = new URL(route.request().url());
          if (url.pathname.endsWith('/my-rooms')) {
            await route.fulfill({ json: { rooms: Array.from({ length: roomCount }, (_, i) => ({ id: `room-${i}`, name: `Table ${i + 1}`, playerCount: 2 })) } });
          } else if (url.pathname.endsWith('/me/pending')) {
            await route.fulfill({ json: { invites: waiting, friendRequests: 0, settlementsAwaitingMe: 0, openDebts: 0, iOweCount: 0, houseOutstanding: 0 } });
          } else if (url.pathname.endsWith('/public-rooms')) {
            await route.fulfill({ json: { rooms: [] } });
          } else if (url.pathname.endsWith('/timeline')) {
            await route.fulfill({ json: { points: [] } });
          } else if (url.pathname.includes('/users/')) {
            await route.fulfill({ json: { stats: { net: 0, handsPlayed: 0, biggestWin: 0 } } });
          } else {
            await route.fulfill({ json: { ok: true, userId: 2, username: 'probe', displayName: 'Probe', isPlatform: false } });
          }
        });
        await page.goto(`${base}/settings`);
        if (process.env.BASELINE === '1' && roomCount > 0 && viewport.width >= 768) {
          await page.addStyleTag({ content: '.zeus-table-panel { top: 0 !important; bottom: auto !important; }' });
        }
        if (process.env.BASELINE_LOGOUT === '1' && viewport.width >= 768) {
          await page.addStyleTag({ content: '.zeus-sidebar.rail-mode .zeus-sidebar-bottom { bottom: -80px !important; }' });
        }
        await waitForNav(page);
        if (waiting) {
        await page.waitForTimeout(300);
        }
        await page.waitForTimeout(150);
        const metrics = await page.locator('.zeus-sidebar').evaluate((sidebar) => {
          const nav = sidebar.querySelector('.zeus-nav-list');
          const logout = sidebar.querySelector('button[aria-label="退出登录"], button[aria-label="Log out"]');
           const links = [...sidebar.querySelectorAll('.zeus-nav-list > a')];
           const allLinks = [...sidebar.querySelectorAll('a[href]')];
          const sidebarBox = sidebar.getBoundingClientRect();
          const logoutBox = logout?.getBoundingClientRect();
          return {
            navScrollHeight: nav?.scrollHeight,
            navClientHeight: nav?.clientHeight,
             fixedLinks: links.length,
             fixedLinksClickable: links.every((link) => {
               const box = link.getBoundingClientRect();
                return box.width > 0 && box.height > 0 && box.top >= 0 && box.bottom <= window.innerHeight;
             }),
             allSidebarLinksClickable: allLinks.every((link) => {
               const box = link.getBoundingClientRect();
               return box.width > 0 && box.height > 0 && box.top >= 0 && box.bottom <= window.innerHeight;
             }),
            lastLinkBottom: links.at(-1)?.getBoundingClientRect().bottom,
            navBottom: nav?.getBoundingClientRect().bottom,
            sidebarTop: sidebarBox.top,
            sidebarBottom: sidebarBox.bottom,
            logoutTop: logoutBox?.top,
            logoutBottom: logoutBox?.bottom,
            viewportHeight: window.innerHeight,
            logoutComplete: !!logoutBox && logoutBox.bottom <= sidebarBox.bottom && logoutBox.bottom <= window.innerHeight,
          };
        });
        const screenshot = waiting && viewport.height === 640 && roomCount === 12
          ? `${out}/sidebar-1440x640-waiting-${roomCount}.png`
          : undefined;
        if (screenshot) await page.screenshot({ path: screenshot });
        if (viewport.width >= 768 && metrics.navScrollHeight !== metrics.navClientHeight) {
          throw new Error(`main nav scrolls at ${viewport.width}x${viewport.height}, rooms=${roomCount}, waiting=${waiting}`);
        }
        if (viewport.width >= 768 && !metrics.logoutComplete) {
          throw new Error(`logout is clipped at ${viewport.width}x${viewport.height}, rooms=${roomCount}, waiting=${waiting}`);
        }
        // Exercise each fixed entry once in the richest desktop fixture; the
        // complete viewport/room/waiting matrix above still checks geometry.
        if (viewport.width === 1440 && viewport.height === 900 && roomCount === 12 && waiting === 1) {
          const fixedLinks = page.locator('.zeus-sidebar .zeus-nav-list > a');
          for (let index = 0; index < await fixedLinks.count(); index += 1) {
            await clickAndAssertRoute(page, fixedLinks.nth(index), `desktop main link ${index + 1}`);
            await page.goto(`${base}/settings`);
            await waitForNav(page);
          }
        }
        if (roomCount > 0 && viewport.width >= 768) {
          await page.locator('.zeus-table-trigger').click();
          const panelLinks = page.locator('#rail-table-links a');
           const panelLinkCount = await panelLinks.count();
          if (panelLinkCount !== roomCount) {
            throw new Error(`table drawer has ${panelLinkCount} links, expected ${roomCount}`);
          }
           const panel = page.locator('#rail-table-links');
           const panelBox = await panel.boundingBox();
           if (process.env.BASELINE === '1' && viewport.width === 1440 && viewport.height === 640 && roomCount === 12) {
             const panelBottom = panelBox && panelBox.y + panelBox.height;
             if (!panelBox || panelBottom <= viewport.height) {
                throw new Error(`baseline did not reproduce clipped table drawer: ${JSON.stringify(panelBox)}`);
             }
             throw new Error(`BASELINE_REPRODUCED_BLOCKER_A: table drawer bottom=${panelBottom} > viewport=${viewport.height}`);
           }
           const panelBottom = panelBox && panelBox.y + panelBox.height;
           if (!panelBox || panelBox.y < 0 || panelBottom > viewport.height) {
             throw new Error(`table drawer is outside viewport at ${viewport.width}x${viewport.height}`);
           }
           await page.keyboard.press('Tab');
           const focused = await page.evaluate(() => document.activeElement?.getAttribute('href'));
           if (!focused?.startsWith('/room/')) throw new Error(`Tab did not focus a table link: ${focused}`);
           for (const index of [0, Math.floor((roomCount - 1) / 2), roomCount - 1]) {
             await openTables(page);
             await clickTableLink(page, index, roomCount);
             await page.goto(`${base}/settings`);
             await waitForNav(page);
           }
           if (screenshot) {
             await openTables(page);
             await panelLinks.last().scrollIntoViewIfNeeded();
             await page.screenshot({ path: screenshot });
           }
         }
        results.push({ width: viewport.width, height: viewport.height, roomCount, waiting, ...metrics, screenshot });
        await context.close();
      }
    }
  }
  // Mobile Dialog: full navigation must remain in normal flow and every
  // terminal destination must be reachable, not merely present in the DOM.
  {
    const context = await browser.newContext({ viewport: mobileViewport });
    await context.addInitScript(() => {
      localStorage.setItem('4am-auth', JSON.stringify({ state: {
        auth: { token: 'peek-fixture', userId: 2, username: 'probe', identity: null },
        prefs: { displayName: 'Probe' },
      }, version: 0 }));
      localStorage.setItem('4am-sidebar', 'rail');
    });
    const page = await context.newPage();
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/my-rooms')) {
        await route.fulfill({ json: { rooms: Array.from({ length: 12 }, (_, i) => ({ id: `room-${i}`, name: `Table ${i + 1}`, playerCount: 2 })) } });
      } else if (url.pathname.endsWith('/me/pending')) {
        await route.fulfill({ json: { invites: 1, friendRequests: 0, settlementsAwaitingMe: 0, openDebts: 0, iOweCount: 0, houseOutstanding: 0 } });
      } else if (url.pathname.endsWith('/public-rooms')) {
        await route.fulfill({ json: { rooms: [] } });
      } else if (url.pathname.endsWith('/timeline')) {
        await route.fulfill({ json: { points: [] } });
      } else if (url.pathname.includes('/users/')) {
        await route.fulfill({ json: { stats: { net: 0, handsPlayed: 0, biggestWin: 0 } } });
      } else {
        await route.fulfill({ json: { ok: true, userId: 2, username: 'probe', displayName: 'Probe', isPlatform: false } });
      }
    });
    await page.goto(`${base}/settings`);
    if (process.env.BASELINE === '1') {
      await page.addStyleTag({ content: '.zeus-app-shell.rail-mode .zeus-sidebar-bottom { position: absolute !important; bottom: 12px !important; max-height: calc(100% - 24px) !important; overflow-y: auto !important; }' });
    }
    const mobileMenu = () => page.locator('.zeus-page-header > button').first();
    await mobileMenu().waitFor();
    for (const index of [3, 7, 11]) {
      await mobileMenu().click();
      const mobile = page.locator('[data-ui-dialog]').last();
      await page.waitForTimeout(300);
      await mobile.locator('a[href^="/room/"]').first().waitFor();
      if (index === 0) await page.screenshot({ path: `${out}/sidebar-390x844-rooms-12-waiting-1.png` });
      await mobile.locator('a[href^="/room/"]').nth(index).scrollIntoViewIfNeeded();
      await visibleAndUncovered(page, mobile.locator('a[href^="/room/"]').nth(index), `mobile table ${index + 1}`);
      await mobile.locator('a[href^="/room/"]').nth(index).click();
      await page.waitForURL(new RegExp(`/room/room-${index}$`));
      await page.goto(`${base}/settings`);
      await mobileMenu().waitFor();
    }
    for (const href of ['/settings', '/fair', '/players/2']) {
      await mobileMenu().click();
      const mobile = page.locator('[data-ui-dialog]').last();
      const link = href === '/players/2'
        ? mobile.locator('a[aria-label="个人资料"], a[aria-label="Your profile"]').first()
        : mobile.locator(`a[href="${href}"]`);
      await link.scrollIntoViewIfNeeded();
      await visibleAndUncovered(page, link, `mobile ${href}`);
      await link.click();
      await page.waitForURL(new RegExp(`${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
      await page.goto(`${base}/settings`);
      await mobileMenu().waitFor();
    }
    await mobileMenu().click();
    const mobileLogout = page.locator('[data-ui-dialog] button[aria-label="退出登录"], [data-ui-dialog] button[aria-label="Log out"]');
    await mobileLogout.scrollIntoViewIfNeeded();
    await visibleAndUncovered(page, mobileLogout, 'mobile logout');
    await mobileLogout.click();
    await page.waitForURL(/\/login$/);
    results.push({ mobile: mobileViewport, rooms: 12, waiting: 1, terminalLinks: 'clicked' });
    await context.close();
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
