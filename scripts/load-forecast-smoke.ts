import fs from 'node:fs';
import { chromium, type Page } from 'playwright';

const BASE_URL = process.env.LYDIARD_BASE_URL ?? 'http://127.0.0.1:8787';
const ARTIFACT_PREFIX = process.env.LYDIARD_FORECAST_ARTIFACT ?? 'load-forecast-local';

function readSiteKey(): string {
  if (process.env.LYDIARD_SITE_KEY) return process.env.LYDIARD_SITE_KEY;
  if (!fs.existsSync('.dev.vars')) return '';
  const line = fs.readFileSync('.dev.vars', 'utf8').split(/\r?\n/).find((item) => /^SITE_PASSWORD\s*=/.test(item));
  return line?.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '') ?? '';
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Load forecast smoke failed: ${message}`);
}

async function inspect(page: Page, viewport: 'desktop' | 'mobile') {
  await page.goto(`${BASE_URL}/?view=plan`, { waitUntil: 'networkidle' });
  const forecast = page.locator('.coach-load-forecast');
  await forecast.waitFor({ state: 'visible', timeout: 30_000 });
  const summaryCount = await forecast.locator('.coach-forecast-summary article').count();
  const weekCount = await forecast.locator('.coach-forecast-weeks article').count();
  const methodology = ((await forecast.locator('.coach-forecast-method').textContent()) ?? '').toLowerCase();
  const geometry = await forecast.evaluate((node) => {
    const svg = node.querySelector('svg')?.getBoundingClientRect();
    return {
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      forecastOverflow: node.scrollWidth - node.clientWidth,
      chartWidth: svg?.width ?? 0,
      chartHeight: svg?.height ?? 0,
    };
  });
  assert(summaryCount === 4, `${viewport} summary has ${summaryCount} metrics instead of four`);
  assert(weekCount >= 3, `${viewport} forecast has fewer than three weekly summaries`);
  assert(await forecast.locator('svg polyline').count() === 1, `${viewport} projection line is missing`);
  assert((await forecast.getByText('Projected peak', { exact: true }).count()) === 1, `${viewport} peak readout is missing`);
  assert(methodology.includes('not an injury probability'), `${viewport} medical limitation is missing`);
  assert(methodology.includes('edit a session'), `${viewport} edit/recalculation guidance is missing`);
  assert(geometry.pageOverflow <= 1 && geometry.forecastOverflow <= 1, `${viewport} overflows horizontally (${JSON.stringify(geometry)})`);
  assert(geometry.chartWidth > 250 && geometry.chartHeight >= 180, `${viewport} chart is not legible (${JSON.stringify(geometry)})`);
  if (viewport === 'mobile') {
    // Keep the captured artifact focused on the tall card; fixed app chrome is
    // already included in the geometry/interaction checks above.
    await page.addStyleTag({ content: '.topbar, .mobile-bottom-nav { display: none !important; }' });
  }
  await forecast.screenshot({ path: `progress/screenshots/${ARTIFACT_PREFIX}-${viewport}.png` });
  return { summaryCount, weekCount, geometry };
}

fs.mkdirSync('progress/screenshots', { recursive: true });
const browser = await chromium.launch({ headless: true });
const pageErrors: string[] = [];
const siteKey = readSiteKey();
const desktop = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
desktop.on('pageerror', (error) => pageErrors.push(`desktop: ${String(error)}`));
await desktop.addInitScript((value) => localStorage.setItem('lydiard.siteKey', value), siteKey);
const desktopResult = await inspect(desktop, 'desktop');
await desktop.close();

const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
mobile.on('pageerror', (error) => pageErrors.push(`mobile: ${String(error)}`));
await mobile.addInitScript((value) => localStorage.setItem('lydiard.siteKey', value), siteKey);
const mobileResult = await inspect(mobile, 'mobile');
await mobile.close();
await browser.close();

assert(pageErrors.length === 0, `browser errors: ${pageErrors.join(' | ')}`);
console.log(JSON.stringify({ baseUrl: BASE_URL, desktop: desktopResult, mobile: mobileResult, pageErrors }, null, 2));
