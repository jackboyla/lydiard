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
let dayNoteRoundTrip = false;

try {
  await page.goto(`${BASE_URL}/?view=log`, { waitUntil: 'networkidle' });
  const navLabels = (await page.locator('.mobile-bottom-nav button').allTextContents()).map((label) => label.trim());
  assert(JSON.stringify(navLabels) === JSON.stringify(['Log', 'Progress', 'Plan']), `Unexpected navigation: ${navLabels.join(', ')}`);
  assert(await page.getByRole('heading', { name: 'Your runs and notes' }).isVisible(), 'Log heading is missing.');
  assert(await page.locator('.log-history-totals').isVisible(), 'All-history totals are missing from Log.');
  assert(await page.getByRole('group', { name: 'Training range' }).count() === 0, 'Log still exposes time-period filters.');

  const initialVisibleWeeks = await page.locator('[data-week]').count();
  for (let attempt = 0; attempt < 8 && await page.locator('[data-week]').count() <= initialVisibleWeeks; attempt += 1) {
    await page.locator('.training-view').evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await page.waitForTimeout(100);
  }
  const expandedVisibleWeeks = await page.locator('[data-week]').count();
  assert(expandedVisibleWeeks > initialVisibleWeeks, 'Log did not reveal older weeks when scrolled to the end.');
  const visibleWeekIds = await page.locator('[data-week]').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-week') ?? ''),
  );
  assert(
    visibleWeekIds.slice(1).every((weekId, index) =>
      new Date(`${visibleWeekIds[index]}T00:00:00Z`).getTime() - new Date(`${weekId}T00:00:00Z`).getTime() === 7 * 86_400_000,
    ),
    'Log skipped one or more empty calendar weeks.',
  );
  const weekHeaderGeometry = await page.locator('.training-week-head').first().evaluate((header) => {
    const date = header.querySelector('p')?.getBoundingClientRect();
    const totals = header.querySelector('.week-total-readout')?.getBoundingClientRect();
    return date && totals ? {
      sameLeftEdge: Math.abs(date.left - totals.left) <= 1,
      totalsBelowDate: totals.top >= date.bottom,
    } : null;
  });
  assert(
    weekHeaderGeometry?.sameLeftEdge && weekHeaderGeometry.totalsBelowDate,
    'Weekly totals are not positioned directly beneath the week date.',
  );
  await page.locator('.training-view').evaluate((node) => { node.scrollTop = 0; });

  const restDay = page.locator('.week-day-cell:not(.has-run)').first();
  const dayNoteTrigger = restDay.locator('.calendar-day-note-trigger');
  assert(await dayNoteTrigger.isVisible(), 'A rest day does not expose its day-note editor.');
  await dayNoteTrigger.click();
  const originalDayNote = await restDay.locator('.calendar-day-note-editor textarea').inputValue();
  const dayNoteMarker = `Rest-day smoke ${new Date().toISOString()}`;
  await restDay.locator('.calendar-day-note-editor textarea').fill(dayNoteMarker);
  await restDay.locator('.calendar-day-note-editor').getByRole('button', { name: 'Save' }).click();
  await page.waitForFunction((value) => document.querySelector('.week-day-cell:not(.has-run) .calendar-day-note-trigger')?.textContent?.includes(value), dayNoteMarker);
  await restDay.locator('.calendar-day-note-trigger').click();
  await restDay.locator('.calendar-day-note-editor textarea').fill(originalDayNote);
  await restDay.locator('.calendar-day-note-editor').getByRole('button', { name: 'Save' }).click();
  await page.waitForFunction(() => !document.querySelector('.week-day-cell:not(.has-run) .calendar-day-note-editor'));
  dayNoteRoundTrip = true;

  const firstRun = page.locator('.calendar-run-card').first();
  assert(await firstRun.isVisible(), 'No run card is visible in the default three-month Log.');
  await firstRun.click();
  assert(await page.locator('.activity-detail-page').isVisible(), 'Run did not open as a full activity page.');
  assert(await page.locator('.training-floating-preview').count() === 0, 'Legacy activity popup is still rendered.');
  const savedLogPosition = await page.evaluate(() => history.state as {
    logScrollTop?: number;
    logScrollLeft?: number;
    logAnchorId?: string;
    logAnchorOffset?: number;
  } | null);
  await page.waitForSelector('.activity-note-editor textarea');
  await page.waitForSelector('.activity-distance-hr-chart .recharts-line-curve');
  assert(await page.getByRole('heading', { name: 'Recorded lap profile' }).isVisible(), 'Recorded lap profile is missing.');
  assert(await page.getByRole('heading', { name: 'Heart rate over distance' }).isVisible(), 'Distance-aligned heart-rate chart is missing.');
  assert(await page.getByRole('heading', { name: 'Power over distance' }).isVisible(), 'Distance-aligned power chart is missing.');
  assert(await page.locator('.activity-distance-hr-chart .activity-chart-summary').isVisible(), 'HR average/maximum summary is missing.');
  assert(await page.locator('.activity-distance-power-chart .activity-chart-summary').isVisible(), 'Power average/maximum summary is missing.');
  assert(await page.locator('.activity-lap-profile .lap-profile-bar').count() > 0, 'Lap profile bars are missing.');
  assert(await page.locator('.splits-preview').count() === 0, 'The redundant Pace over time chart is still rendered.');
  assert(await page.locator('.lap-split-table th', { hasText: 'HR avg' }).first().isVisible(), 'Average HR split column is missing.');
  assert(await page.locator('.lap-split-table th', { hasText: 'HR max' }).first().isVisible(), 'Maximum HR split column is missing.');
  assert(await page.locator('.lap-split-table th', { hasText: 'Zone' }).first().isVisible(), 'Split zone column is missing.');
  assert(await page.getByRole('region', { name: 'Device-recorded laps' }).isVisible(), 'Device-recorded lap table is missing.');
  assert(await page.getByRole('region', { name: 'Kilometre splits' }).isVisible(), 'Independent kilometre split table is missing.');
  assert(await page.locator('.activity-analysis-panel details').count() === 0, 'Activity analysis is still hidden in a disclosure.');
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
  const restoredLogPosition = await page.locator('.training-view').evaluate((node) => ({
    top: node.scrollTop,
    left: node.querySelector<HTMLElement>('.training-week-list')?.scrollLeft ?? 0,
    anchorOffset: (() => {
      const state = history.state as { logAnchorId?: string } | null;
      const anchor = state?.logAnchorId
        ? node.querySelector<HTMLElement>(`[data-activity-id="${CSS.escape(state.logAnchorId)}"]`)
        : null;
      return anchor ? anchor.getBoundingClientRect().top - node.getBoundingClientRect().top : null;
    })(),
  }));
  assert(
    restoredLogPosition.anchorOffset !== null &&
      Math.abs(restoredLogPosition.anchorOffset - (savedLogPosition?.logAnchorOffset ?? 0)) <= 1,
    'Browser Back did not restore the opened run to the same visual position.',
  );
  assert(restoredLogPosition.left === (savedLogPosition?.logScrollLeft ?? 0), 'Browser Back did not restore horizontal Log position.');

  await page.locator('.mobile-bottom-nav button').filter({ hasText: 'Progress' }).click();
  await page.waitForSelector('.progress-view');
  assert(new URL(page.url()).searchParams.get('view') === 'progress', 'Progress URL state was not updated.');
  const progressRead = (await page.locator('.progress-read-card h3').textContent())?.trim();
  await page.waitForFunction(() => document.querySelectorAll('.best-effort-group').length >= 8, undefined, { timeout: 20_000 });
  bestEffortGroupCount = await page.locator('.best-effort-group').count();
  assert(await page.locator('.best-effort-reject').count() > 0, 'PB rejection controls are missing.');
  assert(await page.getByRole('button', { name: 'All time' }).getAttribute('class') === 'active', 'All-time PB scope should be the default.');
  await page.waitForSelector('.aerobic-efficiency-card');
  await page.waitForSelector('.heart-rate-pace-card');
  assert(await page.locator('.training-zone-panel').isVisible(), 'Training zones are missing from Progress.');
  assert(await page.locator('.progress-zone-ledger').isVisible(), 'Range-scoped zone ledger is missing from Progress.');
  assert(await page.locator('.progress-zone-row').count() === 5, 'Progress zone ledger does not expose all five zones.');
  assert(await page.locator('.analysis-chart-stack').isVisible(), 'Progress charts are not always visible.');
  assert(await page.locator('.heart-rate-pace-card .recharts-area-area').count() >= 2, 'Continuous heart-rate range bands are missing.');
  assert(await page.locator('.heart-rate-pace-card .heart-rate-pace-points.recharts-symbols').count() > 0, 'Exact-pace run observations are missing.');
  assert(await page.getByRole('group', { name: 'Progress chart range' }).getByRole('button').count() === 5, 'Progress chart ranges are incomplete.');

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
    historyWeeksRevealed: `${initialVisibleWeeks}→${expandedVisibleWeeks}`,
    continuousWeeks: true,
    totalsUnderDate: true,
    activityDeepLink: true,
    noteRoundTrip: true,
    dayNoteRoundTrip,
    runStreamCharts: true,
    progressZoneLedger: true,
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
