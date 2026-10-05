/** Screenshot the dedicated React card gallery. */
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const chromium = pw.chromium ?? pw.default?.chromium;
const base = process.env.BASE_URL || 'http://127.0.0.1:5194';
const out = process.env.UAT_OUTPUT || 'docs/qa/table-faces';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 }, reducedMotion: 'reduce' });
  await page.goto(base);
  await page.waitForSelector('#card-preset-gallery .playing-card-court', { state: 'attached' });
  const evidence = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#card-preset-gallery [data-card-size]')];
    const boxes = cards.map((card) => {
      const box = card.getBoundingClientRect();
      return { size: card.getAttribute('data-card-size'), width: box.width, height: box.height };
    });
    const undersized = boxes.filter((box) => box.width < 36 || box.height < 50);
    const courts = [...document.querySelectorAll('#card-preset-gallery .playing-card-court')];
    const courtPaths = courts.flatMap((court) => [...court.querySelectorAll('path')])
      .filter((path) => (path.getAttribute('d') || '').trim().length > 0);
    const courtLabels = courts.map((court) => court.closest('[role="img"]')?.getAttribute('aria-label'));
    return {
      cards: boxes.length,
      boxes,
      undersized,
      courts: courts.length,
      courtPaths: courtPaths.length,
      courtLabels,
    };
  });
  if (evidence.undersized.length > 0) {
    throw new Error(`card evidence has undersized targets: ${JSON.stringify(evidence.undersized)}`);
  }
  if (evidence.cards < 23) {
    throw new Error(`card evidence missing face/back targets: expected at least 23, got ${evidence.cards}`);
  }
  if (evidence.courts < 3 || evidence.courtPaths < 3) {
    throw new Error(`court evidence incomplete: ${JSON.stringify(evidence)}`);
  }
  for (const rank of ['J', 'Q', 'K']) {
    if (!evidence.courtLabels.some((label) => label?.startsWith(rank))) {
      throw new Error(`court evidence missing real ${rank}`);
    }
  }
  console.log(`card evidence: ${evidence.cards} cards, ${evidence.courts} courts, ${evidence.courtPaths} paths`);
  await page.screenshot({ path: `${out}/all-presets-pod-board.png`, fullPage: true });
} finally { await browser.close(); }
