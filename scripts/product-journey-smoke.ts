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
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
const pageErrors: string[] = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
await page.addInitScript((value) => {
  localStorage.setItem('lydiard.siteKey', value);
}, siteKey);

let editedActivityId = '';
let originalNote = '';
let bestEffortGroupCount = 0;
let runBestEffortCount = 0;
let dayNoteRoundTrip = false;
let syncTickShown = false;
let gymRestore: { path: string; sets: unknown[] } | null = null;
const gymExercise = 'Smoke check exercise';
async function gymRequest(path: string, body?: unknown) {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(siteKey ? { 'X-Lydiard-Key': siteKey } : {}) },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  });
  assert(response.ok, `Gym API failed: ${response.status}`);
  return response.json() as Promise<{ sets: Record<string, unknown>[]; version: string }>;
}

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
  assert(await page.locator('.log-history-hero').count() === 0, 'Log still renders the removed almanac card.');
  assert(await page.getByRole('group', { name: 'Training range' }).count() === 0, 'Log still exposes time-period filters.');
  assert(await page.locator('.training-inline-jump').count() === 0, 'Log still renders an inline month jump above the calendar.');
  await page.getByRole('button', { name: 'Open settings' }).click();
  assert(await page.getByLabel('Jump to month').isVisible(), 'The month jump is not available in the open top menu.');
  await page.getByRole('button', { name: 'Close settings' }).click();
  const garminSyncRoute = '**/api/garmin/sync';
  await page.route(garminSyncRoute, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ message: 'Garmin sync queued in GitHub Actions.', alreadyRunning: false }),
  }));
  assert(await page.locator('.topbar-sync-button').isVisible(), 'Sync is not reachable in one tap from Log.');
  await page.getByRole('button', { name: 'Sync now' }).click();
  await page.waitForSelector('.topbar-sync-button.synced');
  assert(await page.locator('.app-banner').count() === 0, 'Queueing a sync still raises a banner to dismiss.');
  syncTickShown = true;
  await page.unroute(garminSyncRoute);
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
  const mobileCalendarOrder = await page.locator('.week-calendar-grid').first().evaluate((calendar) => ({
    direction: getComputedStyle(calendar).flexDirection,
    visualDayIndexes: [...calendar.children]
      .map((day, index) => ({ index, top: day.getBoundingClientRect().top }))
      .sort((a, b) => a.top - b.top)
      .map((day) => day.index),
  }));
  assert(
    mobileCalendarOrder.direction === 'column-reverse' &&
      JSON.stringify(mobileCalendarOrder.visualDayIndexes) === JSON.stringify([6, 5, 4, 3, 2, 1, 0]),
    `Mobile calendar days are not descending: ${mobileCalendarOrder.visualDayIndexes.join(', ')}.`,
  );
  const calendarPulse = page.locator('.calendar-daily-pulse').first();
  assert(await calendarPulse.isVisible(), 'A saved daily pulse is missing from its Log day.');
  const calendarPulseGeometry = await calendarPulse.evaluate((pulse) => {
    const rect = pulse.getBoundingClientRect();
    return {
      height: rect.height,
      readingCount: pulse.querySelectorAll('.calendar-daily-pulse-readings > span').length,
      overflows: pulse.scrollWidth > pulse.clientWidth,
    };
  });
  assert(calendarPulseGeometry.height <= 80, `The mobile daily pulse is too tall (${calendarPulseGeometry.height}px).`);
  assert(calendarPulseGeometry.readingCount === 4, 'The Log daily pulse does not show all four compact readings.');
  assert(!calendarPulseGeometry.overflows, 'The Log daily pulse overflows its day column.');
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

  const gymResponse = page.waitForResponse(response => /\/api\/gym\/[^/]+\/sets$/.test(response.url()));
  await page.locator('.calendar-gym-pill').first().click();
  const initialGymResponse = await gymResponse;
  const initialGym = await initialGymResponse.json() as { sets: Record<string, unknown>[]; version: string };
  gymRestore = { path: new URL(initialGymResponse.url()).pathname, sets: initialGym.sets };
  await page.getByRole('button', { name: 'Add exercise', exact: true }).click();
  const gymRow = page.locator('.gym-exercise-card').last();
  await gymRow.getByRole('combobox').fill(gymExercise);
  await gymRow.getByLabel('Sets', { exact: true }).fill('3');
  await gymRow.getByLabel('Reps', { exact: true }).fill('8');
  await gymRow.getByLabel('Weight', { exact: false }).fill('12.5');
  await page.getByRole('button', { name: 'Add exercise', exact: true }).click();
  const nameOnlyRow = page.locator('.gym-exercise-card').last();
  await nameOnlyRow.getByRole('combobox').fill('Name-only exercise');
  for (const label of ['Sets', 'Reps', 'Weight']) {
    const input = nameOnlyRow.getByLabel(label, { exact: label !== 'Weight' });
    assert(!(await input.evaluate(node => (node as HTMLInputElement).required)), `${label} should be optional.`);
    await input.fill('');
  }
  assert(!(await page.getByRole('dialog').evaluate(node => node.scrollWidth > node.clientWidth)), 'Gym editor overflows on mobile.');
  await page.getByRole('button', { name: 'Save session', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const savedGym = await gymRequest(gymRestore.path);
  assert(savedGym.sets.filter(set => set.exercise === gymExercise).length === 3, 'Gym did not save all three sets.');
  const nameOnlySet = savedGym.sets.filter(set => set.exercise === 'Name-only exercise');
  assert(nameOnlySet.length === 1 && nameOnlySet[0].setNumber == null && nameOnlySet[0].reps == null && nameOnlySet[0].weightKg == null, 'Name-only exercise was lost or gained invented details.');
  const details = (sets: Record<string, unknown>[]) => sets.map(({ id: _id, createdAt: _created, updatedAt: _updated, setNumber, ...set }) => ({ ...set, knownCount: setNumber != null })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assert(JSON.stringify(details(savedGym.sets.filter(set => set.exercise !== gymExercise && set.exercise !== 'Name-only exercise'))) === JSON.stringify(details(initialGym.sets)), 'Editing a session changed existing exercise details or unknown counts.');
  await page.locator('.calendar-gym-pill').first().click();
  const exerciseInput = page.locator(`input[value="${gymExercise}"]`);
  await exerciseInput.waitFor();
  const savedCard = page.locator('.gym-exercise-card').filter({ has: exerciseInput });
  const reopenedNameOnly = page.locator('.gym-exercise-card').filter({ has: page.locator('input[value="Name-only exercise"]') });
  assert(await reopenedNameOnly.getByLabel('Sets', { exact: true }).inputValue() === '', 'Unknown set count did not remain blank on reopen.');
  assert(await savedCard.getByLabel('Sets', { exact: true }).inputValue() === '3', 'Matching gym sets did not group after reopening.');
  await savedCard.getByRole('button', { name: 'View exercise history' }).click();
  await page.getByRole('heading', { name: gymExercise, exact: true }).waitFor();
  assert((await page.locator('.strength-timeline').innerText()).includes('12.5 kg'), 'Session exercise history is missing weight.');
  await page.getByRole('button', { name: 'Back to session' }).click();
  for (const label of ['Sets', 'Reps', 'Weight']) {
    await savedCard.getByLabel(label, { exact: label !== 'Weight' }).fill('');
  }
  await page.getByRole('button', { name: 'Save session', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const clearedGym = (await gymRequest(gymRestore.path)).sets.filter(set => set.exercise === gymExercise);
  assert(clearedGym.length === 1 && clearedGym[0].setNumber == null && clearedGym[0].reps == null && clearedGym[0].weightKg == null, 'Clearing existing optional fields did not save unknown values.');
  await page.locator('.training-view').evaluate(node => { node.scrollTop = 0; });

  const restDay = page.locator('.week-day-cell:not(.has-run)').first();
  const dayNoteTrigger = restDay.locator('.calendar-day-note-trigger');
  assert(await dayNoteTrigger.isVisible(), 'A rest day does not expose its day-note editor.');
  await dayNoteTrigger.click();
  const dayNoteEditor = restDay.locator('.calendar-day-note-editor textarea');
  const dayNoteFontSize = await dayNoteEditor.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
  assert(dayNoteFontSize >= 16, `Mobile day-note text is ${dayNoteFontSize}px; Safari may zoom the field.`);
  const originalDayNote = await dayNoteEditor.inputValue();
  const dayNoteMarker = `Rest-day smoke ${new Date().toISOString()}`;
  await dayNoteEditor.fill(dayNoteMarker);
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
    return {
      gap: map && overview ? overview.top - map.bottom : Number.POSITIVE_INFINITY,
      visibleReads: visibleReads.length,
      metrics: document.querySelectorAll('.activity-mobile-overview .preview-primary-stats .compact-metric').length,
    };
  });
  assert(mobileOverviewGeometry.gap >= 0 && mobileOverviewGeometry.gap <= 16, `Mobile run overview is not directly below the map (${mobileOverviewGeometry.gap}px).`);
  assert(mobileOverviewGeometry.visibleReads === 1, `Expected one visible mobile Run Read, found ${mobileOverviewGeometry.visibleReads}.`);
  assert(mobileOverviewGeometry.metrics === 6, `Expected six mobile general metrics, found ${mobileOverviewGeometry.metrics}.`);
  assert(await page.locator('.splits-preview').count() === 0, 'The redundant Pace over time chart is still rendered.');
  assert(await page.locator('.lap-split-table th', { hasText: 'HR avg' }).first().isVisible(), 'Average HR split column is missing.');
  assert(await page.locator('.lap-split-table th', { hasText: 'Zone' }).first().isVisible(), 'Split zone column is missing.');
  for (const label of ['HR max', 'Elev Δ', 'W']) {
    const column = page.locator('.lap-split-table th').filter({ hasText: new RegExp(`^${label}$`) }).first();
    assert(await column.count() === 1, `${label} split column is missing.`);
    assert(await column.isHidden(), `${label} split column should be hidden on mobile.`);
  }
  assert(await page.getByRole('region', { name: 'Device-recorded laps' }).isVisible(), 'Device-recorded lap table is missing.');
  assert(await page.getByRole('region', { name: 'Kilometre splits' }).isVisible(), 'Independent kilometre split table is missing.');
  assert(await page.locator('.activity-analysis-panel details').count() === 0, 'Activity analysis is still hidden in a disclosure.');
  const activityParam = new URL(page.url()).searchParams.get('activity');
  assert(activityParam, 'Opening a run did not create an activity deep link.');
  editedActivityId = activityParam;
  const noteEditor = page.locator('.activity-note-editor textarea');
  const activityNoteFontSize = await noteEditor.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
  assert(activityNoteFontSize >= 16, `Mobile activity-note text is ${activityNoteFontSize}px; Safari may zoom the field.`);
  await noteEditor.scrollIntoViewIfNeeded();
  await noteEditor.focus();
  await page.screenshot({ path: 'progress/screenshots/mobile-log-note-editing.png', fullPage: false });
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
  const progressRead = (await page.locator('.progress-snapshot-read strong').textContent())?.trim();
  const progressTab = (name: string) => page.getByRole('tablist', { name: 'Progress sections' }).getByRole('tab', { name });
  await progressTab('Gym').click();
  await page.getByRole('button', { name: new RegExp(gymExercise) }).click();
  await page.getByRole('heading', { name: gymExercise, exact: true }).waitFor();
  await page.getByLabel('Progress metric').selectOption('reps');
  assert((await page.locator('.strength-timeline').innerText()).includes('Details not recorded'), 'Name-only exercise is missing from Progress history.');
  await progressTab('Load').click();
  await progressTab('Bests').click();
  assert(new URL(page.url()).searchParams.get('tab') === 'bests', 'Progress section was not recorded in the URL.');
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
  await progressTab('Fitness').click();
  await page.waitForSelector('.aerobic-efficiency-card');
  await page.waitForSelector('.heart-rate-pace-card');
  assert(await page.locator('.analysis-chart-stack').isVisible(), 'Fitness charts are missing from Progress.');
  assert(await page.locator('.heart-rate-pace-card .recharts-area-area').count() >= 2, 'Continuous heart-rate range bands are missing.');
  assert(await page.locator('.heart-rate-pace-card .heart-rate-pace-points.recharts-symbols').count() > 0, 'Exact-pace run observations are missing.');
  await progressTab('Zones').click();
  assert(await page.locator('.training-zone-panel').isVisible(), 'Training zones are missing from Progress.');
  assert(await page.locator('.zone-calibration-status').isVisible(), 'Adaptive-zone review status is missing from Progress.');
  assert((await page.locator('.zone-calibration-status').innerText()).includes('next routine review'), 'Adaptive-zone status does not explain the review cadence.');
  assert(await page.locator('.progress-zone-ledger').isVisible(), 'Range-scoped zone ledger is missing from Progress.');
  assert(await page.locator('.progress-zone-row').count() === 5, 'Progress zone ledger does not expose all five zones.');
  await page.getByRole('heading', { name: 'Bakken Golden Zone', exact: true }).waitFor();
  await progressTab('Load').click();
  const progressResolution = page.getByRole('group', { name: 'Progress block size' });
  assert(await progressResolution.getByRole('button').count() === 4, 'Progress block resolutions are incomplete.');
  assert(await progressResolution.getByRole('button', { name: '3m' }).getAttribute('class') === 'active', 'The default Progress block is not 3 months / 12 weeks.');
  const initialProgressRange = (await page.locator('.weekly-totals-caption').textContent())?.trim();
  const olderBlock = page.getByRole('button', { name: 'View previous 3-month block' });
  assert(await olderBlock.isEnabled(), 'The older 12-week Progress block is not reachable.');
  await olderBlock.click();
  await page.waitForFunction((range) => document.querySelector('.weekly-totals-caption')?.textContent?.trim() !== range, initialProgressRange);
  const olderWeekCount = await page.locator('.weekly-totals-hit').count();
  assert(olderWeekCount > 0 && olderWeekCount <= 12, 'The older Progress page exceeds its 12-week range or lost its available weeks.');
  assert(await page.getByRole('button', { name: 'View next 3-month block' }).isEnabled(), 'The newer Progress block is not reachable after paging back.');
  await page.getByRole('button', { name: 'View next 3-month block' }).click();
  await page.waitForFunction((range) => document.querySelector('.weekly-totals-caption')?.textContent?.trim() === range, initialProgressRange);
  await progressResolution.getByRole('button', { name: '1m' }).click();
  assert(await page.locator('.weekly-totals-hit').count() === 4, 'The 1-month resolution does not show four weekly points.');
  await progressResolution.getByRole('button', { name: '6m' }).click();
  const sixMonthWeeks = await page.locator('.weekly-totals-hit').count();
  assert(sixMonthWeeks >= 12 && sixMonthWeeks <= 26, 'The 6-month resolution does not include the available weeks within its range.');
  await progressResolution.getByRole('button', { name: '12m' }).click();
  const twelveMonthWeeks = await page.locator('.weekly-totals-hit').count();
  assert(twelveMonthWeeks >= sixMonthWeeks && twelveMonthWeeks <= 52, 'The 12-month resolution does not include the available weeks within its range.');
  await progressResolution.getByRole('button', { name: '3m' }).click();
  assert(await page.locator('.weekly-totals-hit').count() === 12, 'The 3-month resolution did not restore 12 weekly points.');
  await page.getByRole('button', { name: 'View previous 3-month block' }).click();
  await page.waitForFunction((range) => document.querySelector('.weekly-totals-caption')?.textContent?.trim() !== range, initialProgressRange);
  const preservedProgressRange = (await page.locator('.weekly-totals-caption').textContent())?.trim();
  const progressWeekBar = page.locator('.weekly-totals-hit').first();
  await progressWeekBar.focus();
  const progressScrollBeforeJump = await page.locator('.progress-view').evaluate((node) => node.scrollTop);
  await progressWeekBar.press('Enter');
  const progressWeek = new URL(page.url()).searchParams.get('week');
  assert(progressWeek, 'Selecting a Progress week did not create a Log week deep link.');
  await page.waitForFunction((weekId) => {
    const root = document.querySelector('.training-view');
    const target = document.querySelector(`[data-week="${weekId}"]`);
    if (!root || !target) return false;
    return Math.abs(target.getBoundingClientRect().top - root.getBoundingClientRect().top) < 80;
  }, progressWeek);
  await page.locator('.mobile-bottom-nav button').filter({ hasText: 'Progress' }).click();
  await page.waitForSelector('.progress-view');
  await page.waitForTimeout(350);
  assert((await page.locator('.weekly-totals-caption').textContent())?.trim() === preservedProgressRange, 'Progress did not preserve its historical block after visiting Log.');
  assert(await progressResolution.getByRole('button', { name: '3m' }).getAttribute('class') === 'active', 'Progress did not preserve its resolution after visiting Log.');
  const restoredProgressScroll = await page.locator('.progress-view').evaluate((node) => node.scrollTop);
  assert(Math.abs(restoredProgressScroll - progressScrollBeforeJump) <= 2, `Progress scroll state was not restored (${progressScrollBeforeJump} vs ${restoredProgressScroll}).`);
  await page.locator('.mobile-bottom-nav button').filter({ hasText: 'Log' }).click();
  await page.waitForSelector(`.training-view [data-week="${progressWeek}"]`);
  await page.waitForFunction((weekId) => {
    const root = document.querySelector('.training-view');
    const target = document.querySelector(`[data-week="${weekId}"]`);
    if (!root || !target) return false;
    return Math.abs(target.getBoundingClientRect().top - root.getBoundingClientRect().top) < 80;
  }, progressWeek);
  await page.locator('.mobile-bottom-nav button').filter({ hasText: 'Progress' }).click();
  await page.waitForSelector('.progress-view');

  await page.locator('.mobile-bottom-nav button').filter({ hasText: 'Plan' }).click();
  await page.waitForSelector('.coach-mission-card', { timeout: 10_000 });
  assert(new URL(page.url()).searchParams.get('view') === 'plan', 'Plan URL state was not updated.');
  const planRead = (await page.locator('.coach-mission-card').textContent())?.trim() ?? '';
  assert(planRead.includes(progressRead ?? ''), `Progress status is missing from the Plan mission: ${progressRead} vs ${planRead}`);
  assert(await page.locator('.coach-bucket').count() === 8, 'The Scullion systems read does not expose all eight training buckets.');
  const planTab = (name: string) => page.getByRole('tablist', { name: 'Plan sections' }).getByRole('tab', { name });
  await planTab('Goal & block').click();
  assert(!(await page.locator('.coach-goal-form').isVisible()), 'Goal controls should stay folded until asked for.');
  await page.getByText('Change goal').click();
  assert(await page.locator('.coach-goal-form').isVisible(), 'Goal distance/time controls are missing from Plan.');
  assert(await page.locator('.coach-block-planner').isVisible(), 'Future-plan action is missing.');
  await planTab('More').click();
  assert(await page.locator('.coach-responses').isVisible(), 'Post-run feedback is missing from Plan.');
  assert(!(await page.locator('.coach-advanced-settings').evaluate((node) => (node as HTMLDetailsElement).open)), 'Advanced coach settings should start closed.');
  assert(!(await page.locator('.plan-legacy-editor').evaluate((node) => (node as HTMLDetailsElement).open)), 'Legacy plan editor should start closed.');

  await page.goBack();
  await page.waitForSelector('.progress-view');
  assert(new URL(page.url()).searchParams.get('view') === 'progress', 'Browser Back did not restore Progress.');

  const rolloverContext = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Europe/London' });
  const rolloverPage = await rolloverContext.newPage();
  await rolloverPage.addInitScript((value) => localStorage.setItem('lydiard.siteKey', value), siteKey);
  const rollover = await rolloverPage.evaluate(() => {
    const nextMonday = new Date();
    nextMonday.setHours(0, 0, 0, 0);
    nextMonday.setDate(nextMonday.getDate() + 7 - (nextMonday.getDay() + 6) % 7);
    const midnight = nextMonday.getTime();
    const nextWeek = nextMonday.toLocaleDateString('en-CA');
    nextMonday.setDate(nextMonday.getDate() - 7);
    return { midnight, nextWeek, previousWeek: nextMonday.toLocaleDateString('en-CA') };
  });
  await rolloverPage.clock.install({ time: new Date(rollover.midnight - 300_000) });
  await rolloverPage.goto(`${BASE_URL}/?view=log`, { waitUntil: 'networkidle' });
  await rolloverPage.clock.pauseAt(new Date(rollover.midnight - 100));
  const preMidnightWeek = await rolloverPage.locator('[data-week]').first().getAttribute('data-week');
  assert(
    preMidnightWeek === rollover.previousWeek,
    `Pre-midnight Log week is incorrect: ${preMidnightWeek}.`,
  );
  await rolloverPage.clock.runFor(100);
  await rolloverPage.waitForFunction((week) => document.querySelector('[data-week]')?.getAttribute('data-week') === week, rollover.nextWeek);
  await rolloverContext.close();

  assert(pageErrors.length === 0, `Browser errors: ${pageErrors.join(' | ')}`);
  console.log(JSON.stringify({
    navigation: navLabels,
    historyWeeksRevealed: `${initialVisibleWeeks}→${expandedVisibleWeeks}`,
    continuousWeeks: true,
    mobileCalendarOrder: 'Sunday→Monday, newest→oldest',
    automaticMondayRollover: true,
    totalsUnderDate: true,
    activityDeepLink: true,
    activityReturnPosition: 'mobile + desktop',
    noteRoundTrip: true,
    dayNoteRoundTrip,
    syncTickShown,
    runStreamCharts: true,
    splitColumnInspection: 'hover + focus + tap',
    mobileRunOverview: 'directly below map',
    runBestEfforts: runBestEffortCount,
    progressZoneLedger: true,
    adaptiveZones: true,
    bestEffortGroups: bestEffortGroupCount,
    canonicalRead: progressRead,
    weeklyTotals: 'distance + time + elevation',
    progressBlocks: '1/3/6/12 months + older/newer',
    progressWeekToLog: true,
    progressWeekKeyboardActivation: true,
    persistentLogProgressState: true,
    progressSections: 'load + fitness + bests + zones + gym',
    gymSession: 'save + reopen + preserved history + session/Progress history',
    planSections: 'week + goal + more',
    scullionBuckets: 8,
    goalControls: true,
    browserBack: true,
    browserErrors: pageErrors.length,
  }, null, 2));
} finally {
  if (gymRestore) {
    const current = await gymRequest(gymRestore.path);
    await gymRequest(gymRestore.path, { sets: gymRestore.sets, expectedVersion: current.version });
  }
  if (editedActivityId) await restoreNote(editedActivityId, originalNote, siteKey);
  await browser.close();
}
