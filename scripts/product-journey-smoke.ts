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
let runBestEffortCount = 0;
let dayNoteRoundTrip = false;

try {
  await page.goto(`${BASE_URL}/?view=log`, { waitUntil: 'networkidle' });
  const currentLocalWeek = await page.evaluate(() => {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  });
  assert(
    await page.locator('[data-week]').first().getAttribute('data-week') === currentLocalWeek,
    'Log does not begin with the current local calendar week.',
  );
  const navLabels = (await page.locator('.mobile-bottom-nav button').allTextContents()).map((label) => label.trim());
  assert(JSON.stringify(navLabels) === JSON.stringify(['Log', 'Progress', 'Plan']), `Unexpected navigation: ${navLabels.join(', ')}`);
  assert(await page.getByRole('heading', { name: 'The running year' }).isVisible(), 'Log almanac heading is missing.');
  assert(await page.locator('.log-history-totals').isVisible(), 'All-history totals are missing from Log.');
  assert(await page.getByRole('group', { name: 'Training range' }).count() === 0, 'Log still exposes time-period filters.');
  const duplicateDayNotePreviews = await page.locator('.week-day-cell.has-run.has-note').evaluateAll((days) => days.filter((day) => {
    const dayPreview = day.querySelector('.calendar-day-note-trigger.has-note span')?.textContent?.trim();
    if (!dayPreview) return false;
    return [...day.querySelectorAll('.calendar-run-note:not(.calendar-run-note-empty)')]
      .some((runNote) => runNote.textContent?.trim() === dayPreview);
  }).length);
  assert(duplicateDayNotePreviews === 0, `${duplicateDayNotePreviews} day-note previews are duplicated inside run cards.`);

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
  assert(await page.locator('.activity-best-efforts').isVisible(), 'Per-run best efforts are missing.');
  const runBestEffortLabels = await page.locator('.activity-best-efforts article > span').allTextContents();
  runBestEffortCount = runBestEffortLabels.length;
  for (const label of ['200m', '400m', '800m']) {
    assert(runBestEffortLabels.includes(label), `${label} per-run best effort is missing.`);
  }
  assert(await page.locator('.activity-best-efforts article > em').count() === runBestEffortCount, 'Per-run effort boundaries are missing.');
  assert(await page.locator('.activity-lap-profile .lap-profile-bar').count() > 0, 'Lap profile bars are missing.');
  const splitColumns = page.locator('.activity-lap-profile .lap-profile-column');
  assert(await splitColumns.count() > 0, 'Interactive split columns are missing.');
  await splitColumns.first().click();
  const splitReadout = page.locator('.activity-lap-profile .lap-profile-detail');
  assert(await splitReadout.isVisible(), 'Tapping a split column did not expose its readout.');
  const splitReadoutText = (await splitReadout.textContent()) ?? '';
  for (const label of ['Selected split', 'Distance', 'Time', 'Pace', 'Avg HR', 'Avg power', 'Elev change']) {
    assert(splitReadoutText.includes(label), `Split readout is missing ${label}.`);
  }
  const mobileOverview = page.locator('.activity-mobile-overview');
  assert(await mobileOverview.isVisible(), 'Run Read and general metrics are not visible in the mobile overview.');
  const mobileOverviewGeometry = await page.evaluate(() => {
    const map = document.querySelector('.activity-route-panel')?.getBoundingClientRect();
    const overview = document.querySelector('.activity-mobile-overview')?.getBoundingClientRect();
    const visibleReads = [...document.querySelectorAll<HTMLElement>('.activity-run-read')].filter((node) => getComputedStyle(node).display !== 'none');
    const readStyle = visibleReads[0] ? getComputedStyle(visibleReads[0]) : undefined;
    return {
      gap: map && overview ? overview.top - map.bottom : Number.POSITIVE_INFINITY,
      visibleReads: visibleReads.length,
      background: readStyle?.backgroundImage ?? '',
      color: readStyle?.color ?? '',
      metrics: document.querySelectorAll('.activity-mobile-overview .preview-primary-stats .compact-metric').length,
    };
  });
  assert(mobileOverviewGeometry.gap >= 0 && mobileOverviewGeometry.gap <= 16, `Mobile run overview is not directly below the map (${mobileOverviewGeometry.gap}px).`);
  assert(mobileOverviewGeometry.visibleReads === 1, `Expected one visible mobile Run Read, found ${mobileOverviewGeometry.visibleReads}.`);
  assert(mobileOverviewGeometry.metrics === 6, `Expected six mobile general metrics, found ${mobileOverviewGeometry.metrics}.`);
  assert(mobileOverviewGeometry.background.includes('24, 75, 56'), `Run Read did not restore the forest background: ${mobileOverviewGeometry.background}.`);
  assert(mobileOverviewGeometry.color.includes('248, 245, 236'), `Run Read foreground is not the readable warm white: ${mobileOverviewGeometry.color}.`);
  assert(await page.locator('.splits-preview').count() === 0, 'The redundant Pace over time chart is still rendered.');
  assert(await page.locator('.lap-split-table th', { hasText: 'HR avg' }).first().isVisible(), 'Average HR split column is missing.');
  assert(await page.locator('.lap-split-table th', { hasText: 'HR max' }).first().isVisible(), 'Maximum HR split column is missing.');
  assert(await page.locator('.lap-split-table th', { hasText: 'Zone' }).first().isVisible(), 'Split zone column is missing.');
  assert(await page.locator('.lap-split-table th', { hasText: 'Elev Δ' }).first().isVisible(), 'Split elevation-change column is missing.');
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
  await page.getByRole('button', { name: 'Back to your log' }).click();
  await page.waitForFunction(() => !document.querySelector('.activity-note-editor'));
  assert(new URL(page.url()).searchParams.get('view') === 'log', 'Back to your log did not close activity detail into Log.');
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
    'Back to your log did not restore the opened run to the same visual position on mobile.',
  );
  assert(restoredLogPosition.left === (savedLogPosition?.logScrollLeft ?? 0), 'Back to your log did not restore horizontal Log position.');

  await page.setViewportSize({ width: 1440, height: 1000 });
  const desktopRun = page.locator('.calendar-run-card').nth(Math.min(12, await page.locator('.calendar-run-card').count() - 1));
  await desktopRun.scrollIntoViewIfNeeded();
  await desktopRun.click();
  const savedDesktopPosition = await page.evaluate(() => history.state as { logAnchorOffset?: number } | null);
  await page.getByRole('button', { name: 'Back to your log' }).click();
  await page.waitForFunction(() => !document.querySelector('.activity-detail-page'));
  const restoredDesktopOffset = await page.locator('.training-view').evaluate((node) => {
    const state = history.state as { logAnchorId?: string } | null;
    const anchor = state?.logAnchorId
      ? node.querySelector<HTMLElement>(`[data-activity-id="${CSS.escape(state.logAnchorId)}"]`)
      : null;
    return anchor ? anchor.getBoundingClientRect().top - node.getBoundingClientRect().top : null;
  });
  assert(
    restoredDesktopOffset !== null && Math.abs(restoredDesktopOffset - (savedDesktopPosition?.logAnchorOffset ?? 0)) <= 1,
    'Back to your log did not restore the opened run on desktop.',
  );
  await page.setViewportSize({ width: 390, height: 844 });

  await page.locator('.mobile-bottom-nav button').filter({ hasText: 'Progress' }).click();
  await page.waitForSelector('.progress-view');
  assert(new URL(page.url()).searchParams.get('view') === 'progress', 'Progress URL state was not updated.');
  const progressRead = (await page.locator('.progress-read-card h3').textContent())?.trim();
  await page.waitForFunction(() => document.querySelectorAll('.best-effort-group').length >= 11, undefined, { timeout: 20_000 });
  bestEffortGroupCount = await page.locator('.best-effort-group').count();
  const bestEffortLabels = await page.locator('.best-effort-group > header > span').allTextContents();
  for (const label of ['200m', '400m', '800m']) {
    assert(bestEffortLabels.includes(label), `${label} best-effort section is missing.`);
  }
  assert(await page.locator('.best-effort-reject').count() > 0, 'PB rejection controls are missing.');
  assert(await page.getByRole('button', { name: 'All time' }).getAttribute('class') === 'active', 'All-time PB scope should be the default.');
  const groupsBeforeFailedRefresh = await page.locator('.best-effort-group').count();
  const bestEffortRoute = '**/api/best-efforts**';
  await page.route(bestEffortRoute, (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Synthetic best-effort refresh failure.' }),
  }));
  const failedRefresh = page.waitForResponse((response) => response.url().includes('/api/best-efforts') && response.status() === 503);
  await page.getByRole('button', { name: 'Season' }).click();
  await failedRefresh;
  await page.waitForTimeout(50);
  assert(
    await page.locator('.best-effort-group').count() === groupsBeforeFailedRefresh,
    'A failed best-effort refresh cleared previously loaded groups.',
  );
  await page.unroute(bestEffortRoute);
  const restoredRefresh = page.waitForResponse((response) => response.url().includes('/api/best-efforts') && response.status() === 200);
  await page.getByRole('button', { name: 'All time' }).click();
  await restoredRefresh;
  await page.waitForSelector('.aerobic-efficiency-card');
  await page.waitForSelector('.heart-rate-pace-card');
  assert(await page.locator('.training-zone-panel').isVisible(), 'Training zones are missing from Progress.');
  assert(await page.locator('.progress-zone-ledger').isVisible(), 'Range-scoped zone ledger is missing from Progress.');
  assert(await page.locator('.progress-zone-row').count() === 5, 'Progress zone ledger does not expose all five zones.');
  assert((await page.locator('.progress-load-panel .mini-load-y-title').textContent())?.trim() === 'Training time', 'The 12-week y axis is not labelled.');
  assert((await page.locator('.progress-load-panel .mini-load-x-title').textContent())?.trim() === 'Week starting', 'The 12-week x axis is not labelled.');
  assert(await page.locator('.progress-load-panel .mini-load-y-ticks span').count() === 3, 'The 12-week y axis is missing numeric ticks.');
  assert(await page.locator('.progress-load-panel .mini-load-x-ticks span').count() === 12, 'The 12-week x axis is missing week ticks.');
  assert(await page.locator('.analysis-chart-stack').isVisible(), 'Progress charts are not always visible.');
  assert(await page.locator('.heart-rate-pace-card .recharts-area-area').count() >= 2, 'Continuous heart-rate range bands are missing.');
  assert(await page.locator('.heart-rate-pace-card .heart-rate-pace-points.recharts-symbols').count() > 0, 'Exact-pace run observations are missing.');
  assert(await page.getByRole('group', { name: 'Progress chart range' }).getByRole('button').count() === 5, 'Progress chart ranges are incomplete.');

  await page.locator('.mobile-bottom-nav button').filter({ hasText: 'Plan' }).click();
  await page.waitForSelector('.coach-block-planner', { timeout: 10_000 });
  assert(new URL(page.url()).searchParams.get('view') === 'plan', 'Plan URL state was not updated.');
  const planRead = (await page.locator('.coach-mission-card').textContent())?.trim() ?? '';
  assert(planRead.includes(progressRead ?? ''), `Progress status is missing from the Plan mission: ${progressRead} vs ${planRead}`);
  assert(await page.locator('.coach-goal-form').isVisible(), 'Goal distance/time controls are missing from Plan.');
  assert(await page.locator('.coach-bucket').count() === 8, 'The Scullion systems read does not expose all eight training buckets.');
  assert(await page.locator('.coach-block-planner').isVisible(), 'Future-plan action is missing.');
  assert(!(await page.locator('.coach-advanced-settings').evaluate((node) => (node as HTMLDetailsElement).open)), 'Advanced coach settings should start closed.');
  assert(!(await page.locator('.plan-legacy-editor').evaluate((node) => (node as HTMLDetailsElement).open)), 'Legacy plan editor should start closed.');

  await page.goBack();
  await page.waitForSelector('.progress-view');
  assert(new URL(page.url()).searchParams.get('view') === 'progress', 'Browser Back did not restore Progress.');

  const rolloverContext = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Europe/London' });
  const rolloverPage = await rolloverContext.newPage();
  await rolloverPage.addInitScript((value) => localStorage.setItem('lydiard.siteKey', value), siteKey);
  await rolloverPage.clock.install({ time: new Date('2026-07-19T22:55:00.000Z') });
  await rolloverPage.goto(`${BASE_URL}/?view=log`, { waitUntil: 'networkidle' });
  await rolloverPage.clock.pauseAt(new Date('2026-07-19T22:59:59.900Z'));
  const preMidnightWeek = await rolloverPage.locator('[data-week]').first().getAttribute('data-week');
  assert(
    preMidnightWeek === '2026-07-13',
    `Pre-midnight Log week is incorrect: ${preMidnightWeek}.`,
  );
  await rolloverPage.clock.runFor(100);
  await rolloverPage.waitForFunction(() => document.querySelector('[data-week]')?.getAttribute('data-week') === '2026-07-20');
  await rolloverContext.close();

  assert(pageErrors.length === 0, `Browser errors: ${pageErrors.join(' | ')}`);
  console.log(JSON.stringify({
    navigation: navLabels,
    historyWeeksRevealed: `${initialVisibleWeeks}→${expandedVisibleWeeks}`,
    continuousWeeks: true,
    automaticMondayRollover: true,
    totalsUnderDate: true,
    activityDeepLink: true,
    activityReturnPosition: 'mobile + desktop',
    noteRoundTrip: true,
    dayNoteRoundTrip,
    runStreamCharts: true,
    splitColumnInspection: 'hover + focus + tap',
    mobileRunOverview: 'directly below map',
    runBestEfforts: runBestEffortCount,
    progressZoneLedger: true,
    bestEffortGroups: bestEffortGroupCount,
    canonicalRead: progressRead,
    progressAxes: 'labelled x + y',
    scullionBuckets: 8,
    goalControls: true,
    browserBack: true,
    browserErrors: pageErrors.length,
  }, null, 2));
} finally {
  if (editedActivityId) await restoreNote(editedActivityId, originalNote, siteKey);
  await browser.close();
}
