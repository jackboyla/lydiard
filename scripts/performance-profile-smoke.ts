import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.LYDIARD_BASE_URL ?? 'http://127.0.0.1:8895';
const apiBase = process.env.LYDIARD_API_BASE_URL;
const keyLine = fs.readFileSync('.dev.vars', 'utf8').split(/\r?\n/).find(line => /^SITE_PASSWORD\s*=/.test(line));
const key = process.env.LYDIARD_SITE_KEY ?? keyLine?.slice(keyLine.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '') ?? '';
const browser = await chromium.launch();
try {
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width === 390 });
    const errors: string[] = [];
    const effortRequests = { recent: 0, allTime: 0 };
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (path === '/api/best-efforts/recent') effortRequests.recent++;
      if (path === '/api/best-efforts') effortRequests.allTime++;
    });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(value => localStorage.setItem('lydiard.siteKey', value), key);
    if (apiBase) await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      const response = await route.fetch({ url: new URL(url.pathname + url.search, apiBase).toString() });
      await route.fulfill({ response });
    });
    await page.goto(`${base}/?view=progress`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Heart rate duration curve', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Recent best efforts', exact: true }).waitFor();
    const bests = page.locator('.recent-best-efforts');
    await bests.locator('.recent-effort-card').first().waitFor();
    for (const days of [60, 90, 30]) {
      await bests.getByRole('button', { name: `${days} days`, exact: true }).click();
      assert.equal(await bests.getByRole('button', { name: `${days} days`, exact: true }).getAttribute('aria-pressed'), 'true');
    }
    const hr = page.locator('.heart-rate-duration-card');
    const hrPoints = hr.locator('.power-duration-point');
    if (process.env.LYDIARD_REQUIRE_PERFORMANCE_DATA === '1') {
      await hrPoints.first().waitFor({ state: 'attached', timeout: 60_000 });
      assert(await hrPoints.count() > 0, 'Expected measured HR curve');
      assert(await bests.locator('.recent-effort-card button').count() > 0, 'Expected measured best efforts');
      assert(await bests.locator('.bakken-intervals article').count() === 4, 'Expected four Bakken interval ranges');
    }
    if (process.env.LYDIARD_EXPECT_HR_PEAK) {
      const expectedPeak = `${process.env.LYDIARD_EXPECT_HR_PEAK} bpm`;
      assert.equal(
        (await hr.locator('.power-duration-cp strong').textContent())?.trim(),
        expectedPeak,
        `Expected recent supported HR peak ${expectedPeak}`,
      );
    }
    if (await hrPoints.count()) {
      await hr.getByRole('button', { name: 'Last 60 days', exact: true }).click();
      await hrPoints.first().focus();
      await page.keyboard.press('Enter');
      assert(await hr.locator('.power-duration-detail').getByRole('button', { name: 'View run' }).count() === 1);
      await hr.getByRole('button', { name: 'All periods', exact: true }).click();
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Page overflows horizontally');
    assert.deepEqual(errors, []);
    assert.equal(effortRequests.recent, 1, 'Recent efforts should not reload when coach context arrives');
    assert.equal(effortRequests.allTime, 1, 'All-time efforts should load once per Progress visit');
    fs.mkdirSync('progress/screenshots', { recursive: true });
    await page.getByRole('heading', { name: 'Heart rate duration curve', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `progress/screenshots/performance-hr-${width}.png` });
    await page.getByRole('heading', { name: 'Recent best efforts', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `progress/screenshots/performance-bests-${width}.png` });
    console.log(JSON.stringify({ base, apiBase, width, errors, effortRequests }));
    await page.unrouteAll({ behavior: 'wait' });
    await page.close();
  }
} finally { await browser.close(); }
