import fs from 'node:fs';
import { chromium } from 'playwright';

const BASE_URL = process.env.LYDIARD_BASE_URL ?? 'http://127.0.0.1:8787';
const API_BASE_URL = process.env.LYDIARD_API_BASE_URL;

function readSiteKey(): string {
  if (process.env.LYDIARD_SITE_KEY) return process.env.LYDIARD_SITE_KEY;
  if (!fs.existsSync('.dev.vars')) return '';
  const line = fs.readFileSync('.dev.vars', 'utf8').split(/\r?\n/).find((item) => /^SITE_PASSWORD\s*=/.test(item));
  return line?.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '') ?? '';
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
const pageErrors: string[] = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
await page.addInitScript((siteKey) => localStorage.setItem('lydiard.siteKey', siteKey), readSiteKey());
if (API_BASE_URL) {
  await page.route('**/api/**', async (route) => {
    const requestUrl = new URL(route.request().url());
    const proxyUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, API_BASE_URL);
    const response = await route.fetch({ url: proxyUrl.toString() });
    await route.fulfill({ response });
  });
}

try {
  await page.goto(`${BASE_URL}/?view=log`, { waitUntil: 'networkidle' });

  const dayNoteTrigger = page.locator('.calendar-day-note-trigger').first();
  assert(await dayNoteTrigger.isVisible(), 'No day-note control is visible in Log.');
  await dayNoteTrigger.click();
  const dayNote = page.locator('.calendar-day-note-editor textarea').first();
  const dayNoteFontSize = await dayNote.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
  assert(dayNoteFontSize >= 16, `Mobile day-note text is ${dayNoteFontSize}px; Safari may zoom the field.`);
  await page.locator('.calendar-day-note-editor').first().getByRole('button', { name: 'Cancel' }).click();

  const runCard = page.locator('.calendar-run-card').first();
  assert(await runCard.isVisible(), 'No run is visible in Log.');
  await runCard.click();
  const activityNote = page.locator('.activity-note-editor textarea');
  await activityNote.waitFor({ state: 'visible' });
  const activityNoteFontSize = await activityNote.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
  assert(activityNoteFontSize >= 16, `Mobile activity-note text is ${activityNoteFontSize}px; Safari may zoom the field.`);
  await activityNote.scrollIntoViewIfNeeded();
  await activityNote.focus();

  const viewport = await page.evaluate(() => ({
    scale: window.visualViewport?.scale ?? 1,
    pageWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }));
  assert(viewport.scale === 1, `The focused note changed the test viewport scale to ${viewport.scale}.`);
  assert(viewport.pageWidth <= viewport.viewportWidth, `The note page overflows by ${viewport.pageWidth - viewport.viewportWidth}px.`);
  assert(pageErrors.length === 0, `Browser errors: ${pageErrors.join(' | ')}`);

  await page.screenshot({ path: 'progress/screenshots/mobile-log-note-editing.png', fullPage: false });
  await page.waitForLoadState('networkidle');
  console.log(JSON.stringify({ dayNoteFontSize, activityNoteFontSize, ...viewport }, null, 2));
} finally {
  await browser.close();
}
