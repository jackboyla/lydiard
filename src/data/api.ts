// Client for the Lydiard Worker API. The Worker (backed by D1) is the single
// source of truth for the map, dashboard, and agent — replacing localStorage.

import type {
  ActivityDetail,
  BestEffortDistance,
  ActivitySummary,
  GymSession,
  SyncStatus,
  TrainingPlanDay,
  WeeklyAnalysis,
  WeeklyRunBlock,
} from '../types';

const BASE = ((import.meta.env.VITE_API_BASE as string | undefined) ?? '').replace(/\/$/, '');

const SITE_KEY_STORAGE = 'lydiard.siteKey';

/** Thrown when the site password is required or wrong (HTTP 401). */
export class SiteUnauthorizedError extends Error {
  constructor() {
    super('This training data is private. Enter the site password.');
    this.name = 'SiteUnauthorizedError';
  }
}

export class PlanSaveConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanSaveConflictError';
  }
}

export function getSiteKey(): string {
  try {
    return window.localStorage.getItem(SITE_KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

export function setSiteKey(key: string): void {
  try {
    window.localStorage.setItem(SITE_KEY_STORAGE, key);
  } catch {
    /* ignore */
  }
}

function siteHeaders(): Record<string, string> {
  const key = getSiteKey();
  return key ? { 'X-Lydiard-Key': key } : {};
}

export interface DateRange {
  from?: string;
  to?: string;
}

function rangeQuery(range?: DateRange): string {
  const params = new URLSearchParams();
  if (range?.from) {
    params.set('from', range.from);
  }
  if (range?.to) {
    params.set('to', range.to);
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`, { headers: siteHeaders() });
  if (response.status === 401) {
    throw new SiteUnauthorizedError();
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Request failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

export function getSyncStatus(): Promise<SyncStatus> {
  return getJson<SyncStatus>('/api/status');
}

export async function getActivities(range?: DateRange): Promise<ActivitySummary[]> {
  const data = await getJson<{ activities: ActivitySummary[] }>(`/api/activities${rangeQuery(range)}`);
  return data.activities;
}

export function getActivity(id: string): Promise<ActivityDetail> {
  return getJson<ActivityDetail>(`/api/activities/${encodeURIComponent(id)}`);
}

export async function getBestEfforts(range?: DateRange): Promise<BestEffortDistance[]> {
  const data = await getJson<{ distances: BestEffortDistance[] }>(`/api/best-efforts${rangeQuery(range)}`);
  return data.distances;
}

export async function getGymSessions(range?: DateRange): Promise<GymSession[]> {
  const data = await getJson<{ sessions: GymSession[] }>(`/api/gym${rangeQuery(range)}`);
  return data.sessions;
}

export async function getPlanDays(range?: DateRange): Promise<TrainingPlanDay[]> {
  const data = await getJson<{ days: TrainingPlanDay[] }>(`/api/plan${rangeQuery(range)}`);
  return data.days;
}

export async function savePlanDay(
  date: string,
  patch: { plannedText?: string; notes?: string; expectedUpdatedAt: string | null },
): Promise<TrainingPlanDay> {
  const response = await fetch(`${BASE}/api/plan/${encodeURIComponent(date)}`, {
    method: 'PATCH',
    headers: { ...siteHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (response.status === 401) {
    throw new SiteUnauthorizedError();
  }
  const payload = (await response.json().catch(() => null)) as { day?: TrainingPlanDay; error?: string } | null;
  if (response.status === 409) {
    throw new PlanSaveConflictError(payload?.error ?? 'This plan day changed elsewhere.');
  }
  if (!response.ok || !payload?.day) {
    throw new Error(payload?.error ?? `Plan save failed: ${response.status}`);
  }
  return payload.day;
}

export async function getWeeks(range?: DateRange): Promise<WeeklyRunBlock[]> {
  const data = await getJson<{ weeks: WeeklyRunBlock[] }>(`/api/weeks${rangeQuery(range)}`);
  return data.weeks;
}

export function getAnalysis(): Promise<{ analyses: WeeklyAnalysis[]; latest: WeeklyAnalysis | null }> {
  return getJson<{ analyses: WeeklyAnalysis[]; latest: WeeklyAnalysis | null }>('/api/analysis');
}

/** URL the browser navigates to for the one-time Strava OAuth bootstrap. */
export function stravaLoginUrl(): string {
  return `${BASE}/auth/strava/login`;
}

/** Trigger a background Strava sync (owner-only, single-athlete app). */
export async function triggerSync(): Promise<void> {
  const response = await fetch(`${BASE}/api/sync`, { method: 'POST', headers: siteHeaders() });
  if (response.status === 401) {
    throw new SiteUnauthorizedError();
  }
  if (!response.ok && response.status !== 202) {
    throw new Error(`Sync request failed: ${response.status}`);
  }
}

export interface GarminSyncDispatch {
  message: string;
  alreadyRunning: boolean;
  runUrl?: string;
}

/** Queue the cached Garmin extractor workflow in GitHub Actions. */
export async function triggerGarminSync(): Promise<GarminSyncDispatch> {
  const response = await fetch(`${BASE}/api/garmin/sync`, { method: 'POST', headers: siteHeaders() });
  if (response.status === 401) {
    throw new SiteUnauthorizedError();
  }
  const payload = (await response.json().catch(() => null)) as
    | { error?: string; message?: string; alreadyRunning?: boolean; runUrl?: string }
    | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? `Garmin sync request failed: ${response.status}`);
  }
  return {
    message: payload?.message ?? 'Garmin sync queued.',
    alreadyRunning: Boolean(payload?.alreadyRunning),
    runUrl: payload?.runUrl,
  };
}

export async function disconnectStrava(): Promise<void> {
  const response = await fetch(`${BASE}/api/strava/disconnect`, { method: 'POST', headers: siteHeaders() });
  if (response.status === 401) {
    throw new SiteUnauthorizedError();
  }
  if (!response.ok) {
    throw new Error(`Disconnect request failed: ${response.status}`);
  }
}
