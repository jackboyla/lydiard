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
let runs: Array<{ id: number; status: string; html_url?: string }> = [];
let dispatchStatus = 204;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  calls.push({ url, init });
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
  console.log('Garmin dispatch smoke passed (sources, active-run dedupe, upstream failure, Fitbit cron).');
} finally {
  globalThis.fetch = originalFetch;
}
