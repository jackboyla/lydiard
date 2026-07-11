import type { Env } from './env';

interface WorkflowRun {
  id: number;
  status: string;
  html_url?: string;
}

interface WorkflowRunsResponse {
  workflow_runs?: WorkflowRun[];
  message?: string;
}

export interface GarminDispatchResult {
  alreadyRunning: boolean;
  runUrl?: string;
}

export class GarminDispatchConfigurationError extends Error {}
export class GarminDispatchUpstreamError extends Error {}

const GITHUB_API = 'https://api.github.com';

export async function dispatchGarminWorkflow(env: Env): Promise<GarminDispatchResult> {
  const token = env.GITHUB_SYNC_TOKEN?.trim();
  const repository = env.GITHUB_SYNC_REPOSITORY?.trim();
  const workflow = env.GITHUB_SYNC_WORKFLOW?.trim() || 'garmin-sync.yml';
  const ref = env.GITHUB_SYNC_REF?.trim() || 'main';

  if (!env.SITE_PASSWORD) {
    throw new GarminDispatchConfigurationError('Manual Garmin sync requires SITE_PASSWORD to be configured.');
  }
  if (!token || !repository || !/^[^/]+\/[^/]+$/.test(repository)) {
    throw new GarminDispatchConfigurationError(
      'Manual Garmin sync is not configured. Set GITHUB_SYNC_TOKEN and GITHUB_SYNC_REPOSITORY.',
    );
  }

  const workflowPath = `${GITHUB_API}/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'lydiard-worker',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  const runsResponse = await fetch(`${workflowPath}/runs?per_page=10`, { headers });
  const runsPayload = (await readJson(runsResponse)) as WorkflowRunsResponse | null;
  if (!runsResponse.ok) {
    throw new GarminDispatchUpstreamError(githubError('check Garmin workflow status', runsResponse, runsPayload));
  }

  const activeRun = (runsPayload?.workflow_runs ?? []).find(
    (run) => run.status === 'queued' || run.status === 'in_progress' || run.status === 'waiting' || run.status === 'pending',
  );
  if (activeRun) {
    return { alreadyRunning: true, runUrl: activeRun.html_url };
  }

  const dispatchResponse = await fetch(`${workflowPath}/dispatches`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref, inputs: { source: 'lydiard-web' } }),
  });
  if (!dispatchResponse.ok) {
    const payload = (await readJson(dispatchResponse)) as WorkflowRunsResponse | null;
    throw new GarminDispatchUpstreamError(githubError('queue Garmin sync', dispatchResponse, payload));
  }

  return { alreadyRunning: false };
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function githubError(action: string, response: Response, payload: WorkflowRunsResponse | null): string {
  const detail = typeof payload?.message === 'string' ? `: ${payload.message}` : '';
  return `Could not ${action} (GitHub ${response.status})${detail}`;
}
