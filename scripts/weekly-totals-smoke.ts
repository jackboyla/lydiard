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

try {
  for (const mobile of [true, false]) {
    const label = mobile ? 'mobile' : 'desktop';
    const page = await browser.newPage({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      hasTouch: mobile,
    });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.addInitScript((siteKey) => localStorage.setItem('lydiard.siteKey', siteKey), readSiteKey());
    if (API_BASE_URL) {
      await page.route('**/api/**', async (route) => {
        const requestUrl = new URL(route.request().url());
        const proxyUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, API_BASE_URL);
        try {
          await route.fulfill({ response: await route.fetch({ url: proxyUrl.toString() }) });
        } catch {
          // The page can close with a proxied request still in flight; that is not a failure.
        }
      });
    }

    // `networkidle` never settles against production, so wait on the chart itself.
    await page.goto(`${BASE_URL}/?view=progress`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.weekly-totals-hit', { timeout: 45_000 });
    await page.waitForTimeout(500);

    const rollingDates = await page.evaluate(() => {
      const end = new Date();
      end.setHours(0, 0, 0, 0);
      const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 6);
      return {
        startDay: start.getDate(),
        startMonth: start.getMonth(),
        startYear: start.getFullYear(),
        endDay: end.getDate(),
        endMonth: end.getMonth(),
        endYear: end.getFullYear(),
      };
    });
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
    const expectedRollingRange = rollingDates.startYear !== rollingDates.endYear
      ? `${rollingDates.startDay} ${months[rollingDates.startMonth]} ${rollingDates.startYear}–${rollingDates.endDay} ${months[rollingDates.endMonth]} ${rollingDates.endYear}, inclusive`
      : rollingDates.startMonth === rollingDates.endMonth
        ? `${rollingDates.startDay}–${rollingDates.endDay} ${months[rollingDates.endMonth]} ${rollingDates.endYear}, inclusive`
        : `${rollingDates.startDay} ${months[rollingDates.startMonth]}–${rollingDates.endDay} ${months[rollingDates.endMonth]} ${rollingDates.endYear}, inclusive`;
    const rollingRange = (await page.locator('.progress-date-range').innerText()).trim();
    assert(
      rollingRange === expectedRollingRange,
      `${label}: rolling range is "${rollingRange}" instead of "${expectedRollingRange}".`,
    );

    const weekCount = await page.locator('.weekly-totals-hit').count();
    assert(weekCount > 4, `${label}: expected a week per point, got ${weekCount}.`);

    const readout = () => page.locator('.weekly-totals-summary h3').innerText();
    const surface = page.locator('.weekly-totals-surface');
    // Raw mouse/touch coordinates need the chart on screen; only clicks auto-scroll.
    await surface.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    const box = (await surface.boundingBox())!;
    assert(box && box.width > 100, `${label}: the scrub surface has no usable box.`);
    const atFraction = (fraction: number) => box.x + box.width * fraction;
    const midY = box.y + box.height / 2;

    // A pointer moving over the plot tracks the week under it.
    const before = await readout();
    await page.mouse.move(atFraction(0.15), midY);
    await page.waitForTimeout(250);
    const after = await readout();
    assert(after !== before, `${label}: moving over the chart left the readout on ${before}.`);

    // Sliding across the plot must sweep through weeks without opening one.
    const sweep = new Set<string>();
    await page.mouse.move(atFraction(0.1), midY);
    await page.mouse.down();
    for (let step = 1; step <= 8; step += 1) {
      await page.mouse.move(atFraction(0.1 + step * 0.1), midY);
      await page.waitForTimeout(80);
      sweep.add(await readout());
    }
    await page.mouse.up();
    await page.waitForTimeout(300);
    assert(sweep.size >= 3, `${label}: a slide across the chart only reached ${sweep.size} week(s).`);
    let view = new URL(page.url()).searchParams.get('view');
    assert(view === 'progress', `${label}: sliding across the chart navigated to ${view}.`);

    const stats = await page.locator('.weekly-totals-stats strong').allInnerTexts();
    assert(
      stats.length === 3 && stats.every((value) => value.trim().length > 0),
      `${label}: expected distance, time and elevation, got ${stats.join(' | ')}.`,
    );

    // Volume sits straight under the summary cards, with the rolling 7-day card after it.
    const order = await page.evaluate(() => [...document.querySelectorAll('.progress-view > *')].map((node) => node.className));
    const volumeAt = order.findIndex((name) => name.includes('weekly-totals-panel'));
    assert(
      volumeAt === order.findIndex((name) => name.includes('progress-summary-grid')) + 1
        && order[volumeAt + 1]?.includes('rolling-load-panel'),
      `${label}: unexpected Progress order ${order.join(' | ')}.`,
    );

    // The rolling readout tracks the day under the pointer and ends on today by default.
    const rolling = page.locator('.rolling-load-surface');
    const rollingReadout = () => page.locator('.rolling-load-summary h3').innerText();
    const rollingEnd = await rollingReadout();
    assert(rollingEnd.startsWith('7 days to '), `${label}: rolling readout reads "${rollingEnd}".`);
    await rolling.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const rollingBox = (await rolling.boundingBox())!;
    await page.mouse.move(rollingBox.x + rollingBox.width * 0.3, rollingBox.y + rollingBox.height / 2);
    await page.waitForTimeout(250);
    assert(await rollingReadout() !== rollingEnd, `${label}: the rolling chart ignored the pointer.`);
    const rollingStats = await page.locator('.rolling-load-stats strong').allInnerTexts();
    assert(rollingStats.length === 3, `${label}: expected rolling distance, time and runs, got ${rollingStats.join(' | ')}.`);
    await surface.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const tapBox = (await surface.boundingBox())!;
    const tapX = tapBox.x + tapBox.width * 0.5;
    const tapY = tapBox.y + tapBox.height / 2;

    // A tap in place opens the week; phones need the second tap to confirm.
    await page.mouse.click(tapX, tapY);
    if (mobile) {
      await page.waitForTimeout(300);
      await page.mouse.click(tapX, tapY);
    }
    await page.waitForTimeout(1500);
    view = new URL(page.url()).searchParams.get('view');
    assert(view === 'log', `${label}: tapping a week opened ${view} instead of Log.`);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(overflow <= 0, `${label}: the page overflows horizontally by ${overflow}px.`);

    assert(pageErrors.length === 0, `${label}: page errors — ${pageErrors.slice(0, 3).join(' | ')}`);
    console.log(`${label}: ${weekCount} weeks · slide swept ${sweep.size} · ${stats.join(' / ')}`);
    await page.close();
  }
} finally {
  await browser.close();
}
