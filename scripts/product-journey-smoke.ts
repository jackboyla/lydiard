import fs from 'node:fs';
import { chromium } from 'playwright';

const BASE_URL = process.env.LYDIARD_BASE_URL ?? 'http://127.0.0.1:8787';

function readSiteKey(): string {
  if (process.env.LYDIARD_SITE_KEY) return process.env.LYDIARD_SITE_KEY;
  if (!fs.existsSync('.dev.vars')) return '';
  const line = fs.readFileSync('.dev.vars', 'utf8').split(/\r?\n/).find((item) => /^SITE_PASSWORD\s*=/.test(item));
  return line?.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '') ?? '';
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function restoreNote(activityId: string, note: string, siteKey: string): Promise<void> {
  const response = await fetch(`${BASE_URL}/api/activities/${encodeURIComponent(activityId)}/note`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(siteKey ? { 'X-Lydiard-Key': siteKey } : {}) },
    body: JSON.stringify({ note }),
  });
  if (!response.ok) throw new Error(`Could not restore activity note: ${response.status}`);
}

const siteKey = readSiteKey();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const pageErrors: string[] = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
await page.addInitScript((value) => localStorage.setItem('lydiard.siteKey', value), siteKey);

let editedActivityId = '';
let originalNote = '';
let bestEffortGroupCount = 0;

try {
  await page.goto(`${BASE_URL}/?view=log`, { waitUntil: 'networkidle' });
  const navLabels = (await page.locator('.mobile-bottom-nav button').allTextContents()).map((label) => label.trim());
  assert(JSON.stringify(navLabels) === JSON.stringify(['Log', 'Progress', 'Plan']), `Unexpected navigation: ${navLabels.join(', ')}`);
  assert(await page.getByRole('heading', { name: 'Your runs and notes' }).isVisible(), 'Log heading is missing.');
  assert(!(await page.locator('.training-advanced-summary').evaluate((node) => (node as HTMLDetailsElement).open)), 'Log advanced summary should start closed.');

  const firstRun = page.locator('.calendar-run-card').first();
  assert(await firstRun.isVisible(), 'No run card is visible in the default three-month Log.');
  await firstRun.click();
  await page.waitForSelector('.activity-note-editor textarea');
  const activityParam = new URL(page.url()).searchParams.get('activity');
  assert(activityParam, 'Opening a run did not create an activity deep link.');
  editedActivityId = activityParam;
  const noteEditor = page.locator('.activity-note-editor textarea');
  originalNote = await noteEditor.inputValue();
  const marker = `Product journey smoke ${new Date().toISOString()}`;
  await noteEditor.fill(marker);
  await page.getByRole('button', { name: 'Save note' }).click();
  await page.waitForFunction((value) => document.querySelector<HTMLTextAreaElement>('.activity-note-editor textarea')?.value === value, marker);
  await noteEditor.fill(originalNote);
  await page.getByRole('button', { name: 'Save note' }).click();
  await page.goBack();
  await page.waitForFunction(() => !document.querySelector('.activity-note-editor'));
  assert(new URL(page.url()).searchParams.get('view') === 'log', 'Browser Back did not close activity detail into Log.');

  await page.locator('.mobile-bottom-nav button').filter({ hasText: 'Progress' }).click();
  await page.waitForSelector('.progress-view');
  assert(new URL(page.url()).searchParams.get('view') === 'progress', 'Progress URL state was not updated.');
  const progressRead = (await page.locator('.progress-read-card h3').textContent())?.trim();
  await page.waitForFunction(() => document.querySelectorAll('.best-effort-group').length >= 8, undefined, { timeout: 20_000 });
  bestEffortGroupCount = await page.locator('.best-effort-group').count();
  assert(await page.getByRole('button', { name: 'All time' }).getAttribute('class') === 'active', 'All-time PB scope should be the default.');
  assert(!(await page.locator('.progress-advanced-analysis').evaluate((node) => (node as HTMLDetailsElement).open)), 'Advanced analysis should start closed.');

  await page.locator('.mobile-bottom-nav button').filter({ hasText: 'Plan' }).click();
  await page.waitForSelector('.coach-block-planner', { timeout: 10_000 });
  assert(new URL(page.url()).searchParams.get('view') === 'plan', 'Plan URL state was not updated.');
  const planRead = (await page.locator('.coach-hero h2').textContent())?.trim();
  assert(progressRead === planRead, `Progress and Plan disagree: ${progressRead} vs ${planRead}`);
  const plannerTop = await page.locator('.coach-block-planner').evaluate((node) => node.getBoundingClientRect().top);
  assert(plannerTop < 700, `Future-plan action is buried below the first screen (${plannerTop}px).`);
  assert(!(await page.locator('.coach-advanced-settings').evaluate((node) => (node as HTMLDetailsElement).open)), 'Advanced coach settings should start closed.');
  assert(!(await page.locator('.plan-legacy-editor').evaluate((node) => (node as HTMLDetailsElement).open)), 'Legacy plan editor should start closed.');

  await page.goBack();
  await page.waitForSelector('.progress-view');
  assert(new URL(page.url()).searchParams.get('view') === 'progress', 'Browser Back did not restore Progress.');

  assert(pageErrors.length === 0, `Browser errors: ${pageErrors.join(' | ')}`);
  console.log(JSON.stringify({
    navigation: navLabels,
    activityDeepLink: true,
    noteRoundTrip: true,
    bestEffortGroups: bestEffortGroupCount,
    canonicalRead: progressRead,
    plannerTopPx: Math.round(plannerTop),
    browserBack: true,
    browserErrors: pageErrors.length,
  }, null, 2));
} finally {
  if (editedActivityId) await restoreNote(editedActivityId, originalNote, siteKey);
  await browser.close();
}
