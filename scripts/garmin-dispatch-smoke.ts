import assert from 'node:assert/strict';
import { dispatchFitbitWorkflow, dispatchGarminWorkflow, GarminDispatchUpstreamError } from '../worker/garminDispatch';
import type { Env } from '../worker/env';

const env = {
  SITE_PASSWORD: 'fixture',
  GITHUB_SYNC_TOKEN: 'fixture',
  GITHUB_SYNC_REPOSITORY: 'fixture/fixture',
} as Env;
const originalFetch = globalThis.fetch;
const calls: Array<{ url: string; init?: RequestInit }> = [];
let runs: Array<{ id: number; status: string; created_at?: string; html_url?: string }> = [];
let dispatchStatus = 204;
let jobsCount = 0;
let jobsStatus = 200;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  calls.push({ url, init });
  if (url.includes('/jobs?')) return Response.json({ total_count: jobsCount }, { status: jobsStatus });
  if (url.endsWith('/dispatches')) return new Response(null, { status: dispatchStatus });
  return Response.json({ workflow_runs: runs });
}) as typeof fetch;

try {
  for (const source of ['lydiard-web', 'lydiard-cron'] as const) {
    calls.length = 0;
    assert.deepEqual(await dispatchGarminWorkflow(env, source), { alreadyRunning: false });
    assert.equal(calls.length, 2);
    assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { ref: 'main', inputs: { source } });
  }
  for (const status of ['queued', 'in_progress', 'waiting', 'pending']) {
    calls.length = 0;
    runs = [{ id: 1, status, html_url: 'https://example.test/run/1' }];
    assert.deepEqual(await dispatchGarminWorkflow(env, 'lydiard-cron'), {
      alreadyRunning: true, runUrl: 'https://example.test/run/1',
    });
    assert.equal(calls.length, 1, `must not dispatch while ${status}`);
  }
  const oldQueuedRun = { id: 1, status: 'queued', created_at: new Date(Date.now() - 16 * 60_000).toISOString() };
  runs = [oldQueuedRun];
  calls.length = 0;
  assert.deepEqual(await dispatchGarminWorkflow(env), { alreadyRunning: false });
  assert.equal(calls.length, 3, 'an old queue entry without jobs must allow a replacement');

  jobsCount = 1;
  calls.length = 0;
  assert.equal((await dispatchGarminWorkflow(env)).alreadyRunning, true);
  assert.equal(calls.length, 2, 'a queued run with jobs must still block dispatch');

  jobsCount = 0;
  runs = [oldQueuedRun, { id: 2, status: 'in_progress' }];
  calls.length = 0;
  assert.equal((await dispatchGarminWorkflow(env)).alreadyRunning, true);
  assert.equal(calls.length, 2, 'ignoring a stuck run must not skip another active run');

  runs = [{ ...oldQueuedRun, created_at: new Date().toISOString() }];
  calls.length = 0;
  assert.equal((await dispatchGarminWorkflow(env)).alreadyRunning, true);
  assert.equal(calls.length, 1, 'a new queued run must have time to start');

  runs = [oldQueuedRun];
  jobsStatus = 403;
  await assert.rejects(dispatchGarminWorkflow(env), GarminDispatchUpstreamError);
  jobsStatus = 200;
  runs = [{ id: 1, status: 'completed' }];
  dispatchStatus = 403;
  await assert.rejects(dispatchGarminWorkflow(env, 'lydiard-cron'), GarminDispatchUpstreamError);

  // The hourly cron queues the Fitbit import only where a workflow is configured.
  dispatchStatus = 204;
  calls.length = 0;
  assert.equal(await dispatchFitbitWorkflow(env), null);
  assert.equal(calls.length, 0, 'an unconfigured deployment must not call GitHub');
  assert.deepEqual(await dispatchFitbitWorkflow({ ...env, FITBIT_SYNC_WORKFLOW: 'fitbit-recovery-sync.yml' }), { alreadyRunning: false });
  assert.match(calls[1].url, /\/workflows\/fitbit-recovery-sync\.yml\/dispatches$/);
  console.log('Garmin dispatch smoke passed (sources, active-run dedupe, stale queue recovery, upstream failure, Fitbit cron).');
} finally {
  globalThis.fetch = originalFetch;
}
