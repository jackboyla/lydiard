// Renders the README screenshots at phone and desktop sizes.
//
// It never points at production: the caller must give it a Worker whose D1 holds
// the fixture seed, so no real training data or route reaches the repository.
//   npm run screenshots
// See README "Screenshots" for the full local recipe.

import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';

const BASE_URL = process.env.LYDIARD_BASE_URL ?? 'http://127.0.0.1:8798';
const OUT_DIR = process.env.LYDIARD_SHOT_DIR ?? 'docs/screenshots';

function readSiteKey(): string {
  if (process.env.LYDIARD_SITE_KEY) return process.env.LYDIARD_SITE_KEY;
  if (!fs.existsSync('.dev.vars')) return '';
  const line = fs.readFileSync('.dev.vars', 'utf8').split(/\r?\n/).find((item) => /^SITE_PASSWORD\s*=/.test(item));
  return line?.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '') ?? '';
}

interface Shot {
  name: string;
  url: string;
  waitFor: string;
  /** Extra settle time for maps and charts that animate in. */
  settleMs?: number;
  /** Scroll this into view first, when the interesting part sits below the hero. */
  scrollTo?: string;
}

const SHOTS: Shot[] = [
  { name: 'log', url: '/?view=log', waitFor: '.training-week-block-wrap', settleMs: 1200 },
  // fix-44 is the newest seeded run: it carries streams and a note.
  { name: 'activity', url: '/?view=log&activity=fix-44', waitFor: '.activity-detail-page', settleMs: 3000 },
  { name: 'progress', url: '/?view=progress', waitFor: '.weekly-totals-hit', settleMs: 1500, scrollTo: '.weekly-totals-surface' },
  { name: 'plan', url: '/?view=plan', waitFor: '.plan-view', settleMs: 1500 },
];

// A phone shot is small enough to keep at 2x; a 2x desktop shot costs megabytes
// in the repository for detail the README never shows.
const DEVICES = [
  { label: 'mobile', viewport: { width: 390, height: 844 }, scale: 2, touch: true },
  { label: 'desktop', viewport: { width: 1440, height: 900 }, scale: 1, touch: false },
];

async function capture(browser: Browser, device: (typeof DEVICES)[number], shot: Shot) {
  const page = await browser.newPage({
    viewport: device.viewport,
    deviceScaleFactor: device.scale,
    hasTouch: device.touch,
    isMobile: device.touch,
  });
  await page.addInitScript((siteKey) => localStorage.setItem('lydiard.siteKey', siteKey), readSiteKey());
  await page.goto(`${BASE_URL}${shot.url}`, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForSelector(shot.waitFor, { timeout: 30_000 });
  } catch {
    console.warn(`${device.label}/${shot.name}: "${shot.waitFor}" never appeared; capturing anyway.`);
  }
  if (shot.scrollTo) {
    await page.locator(shot.scrollTo).first().scrollIntoViewIfNeeded();
  }
  await page.waitForTimeout(shot.settleMs ?? 800);

  const file = path.join(OUT_DIR, `${shot.name}-${device.label}.png`);
  await page.screenshot({ path: file });
  console.log(`wrote ${file}`);
  await page.close();
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const device of DEVICES) {
    for (const shot of SHOTS) await capture(browser, device, shot);
  }
} finally {
  await browser.close();
}
