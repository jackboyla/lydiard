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
import type {
  CoachBlockMutation,
  CoachContextData,
  CoachDecisionRecord,
  CoachEvaluationMutation,
  CoachFeedbackDraft,
  CoachFeedbackRecord,
  CoachGoalDraft,
  CoachPhase,
  CoachProfileRecord,
  CriticalPowerDraft,
  StoredPlannedSession,
} from './coachTypes';

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

class ApiResponseError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiResponseError';
    this.status = status;
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
    throw new ApiResponseError(payload?.error ?? `Request failed: ${response.status}`, response.status);
  }
  return (await response.json()) as T;
}

async function mutationJson<T>(path: string, method: 'POST' | 'PATCH', body?: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...siteHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (response.status === 401) {
    throw new SiteUnauthorizedError();
  }
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || !payload) {
    throw new Error(payload?.error ?? `Request failed: ${response.status}`);
  }
  return payload;
}

function requestId(prefix: string): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
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

export async function saveActivityNote(id: string, note: string): Promise<{ note: string; updatedAt: string }> {
  return mutationJson<{ note: string; updatedAt: string }>(
    `/api/activities/${encodeURIComponent(id)}/note`,
    'PATCH',
    { note },
  );
}

export async function getBestEfforts(range?: DateRange): Promise<BestEffortDistance[]> {
  const data = await getJson<{ distances: BestEffortDistance[] }>(`/api/best-efforts${rangeQuery(range)}`);
  return data.distances;
}

export function setBestEffortRejection(input: {
  distanceLabel: string;
  activityId: string;
  rejected: boolean;
  reason?: string;
}): Promise<{ distanceLabel: string; activityId: string; rejected: boolean }> {
  return mutationJson('/api/best-efforts/rejections', 'PATCH', input);
}

export async function getGymSessions(range?: DateRange): Promise<GymSession[]> {
  const data = await getJson<{ sessions: GymSession[] }>(`/api/gym${rangeQuery(range)}`);
  return data.sessions;
}

export async function getCoachContext(opts: { weekStart?: string; asOf?: string; horizonWeeks?: number } = {}): Promise<CoachContextData> {
  const params = new URLSearchParams();
  if (opts.weekStart) params.set('weekStart', opts.weekStart);
  if (opts.asOf) params.set('asOf', opts.asOf);
  if (opts.horizonWeeks) params.set('horizonWeeks', String(opts.horizonWeeks));
  const query = params.toString();
  const path = `/api/coach/context${query ? `?${query}` : ''}`;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await getJson<CoachContextData>(path);
    } catch (error) {
      lastError = error;
      const transientResponse = error instanceof ApiResponseError && [429, 500, 502, 503, 504].includes(error.status);
      const transientNetworkFailure = error instanceof TypeError;
      if (attempt === 2 || (!transientResponse && !transientNetworkFailure)) throw error;
      await new Promise((resolve) => window.setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError;
}

export async function saveCoachPhase(
  currentPhase: CoachPhase,
  expectedVersion: number,
): Promise<CoachProfileRecord> {
  const payload = await mutationJson<{ profile: CoachProfileRecord }>('/api/coach/profile', 'PATCH', {
    expectedVersion,
    patch: { currentPhase, phaseStartedOn: new Date().toISOString().slice(0, 10) },
  });
  return payload.profile;
}

export async function saveCoachGoal(
  goal: CoachGoalDraft,
  constraints: Record<string, unknown>,
  expectedVersion: number,
): Promise<CoachProfileRecord> {
  const patch: Record<string, unknown> = {
    constraints: { ...constraints, scullionGoal: goal },
    targetRaceDate: goal.targetDate ?? '',
  };
  if (Math.abs(goal.distanceKm - 5) < 0.05) patch.goal5kSeconds = goal.timeSeconds;
  if (Math.abs(goal.distanceKm - 10) < 0.05) patch.goal10kSeconds = goal.timeSeconds;
  const payload = await mutationJson<{ profile: CoachProfileRecord }>('/api/coach/profile', 'PATCH', {
    expectedVersion,
    patch,
  });
  return payload.profile;
}

export async function addCoachCriticalPower(input: CriticalPowerDraft): Promise<void> {
  await mutationJson('/api/coach/critical-power', 'POST', input);
}

export function proposeCoachBlock(startWeek: string, weekCount: 1 | 2 | 3): Promise<CoachBlockMutation> {
  return mutationJson<CoachBlockMutation>('/api/coach/block/propose', 'POST', {
    startWeek,
    weekCount,
    requestId: requestId(`block-${startWeek}-${weekCount}`),
  });
}

export function acceptCoachBlock(decisionId: string, expectedProfileVersion: number): Promise<CoachBlockMutation> {
  return mutationJson<CoachBlockMutation>('/api/coach/block/accept', 'POST', {
    decisionId,
    expectedProfileVersion,
  });
}

export async function updateCoachSession(
  id: string,
  patch: { plannedDate?: string; title?: string; plannedDurationMin?: number; purpose?: string },
  expectedRevision: number,
): Promise<StoredPlannedSession> {
  const payload = await mutationJson<{ session: StoredPlannedSession }>(
    `/api/coach/sessions/${encodeURIComponent(id)}`,
    'PATCH',
    { ...patch, expectedRevision },
  );
  return payload.session;
}

export async function saveCoachFeedback(activityId: string, draft: CoachFeedbackDraft): Promise<CoachFeedbackRecord> {
  const pain = draft.pain === 'none' ? 0 : draft.pain === 'mild' ? 3 : 6;
  const payload = await mutationJson<{ feedback: CoachFeedbackRecord }>(
    `/api/coach/activities/${encodeURIComponent(activityId)}/feedback`,
    'POST',
    {
      plannedSessionId: draft.plannedSessionId,
      energy: draft.energy,
      legCondition: draft.legCondition,
      sessionFeel: draft.sessionFeel,
      perceivedCost: draft.sessionFeel === 'harder' ? 'high' : draft.sessionFeel === 'easier' ? 'low' : 'expected',
      painDuring: pain,
      painAfter: pain,
      painLocation: draft.painLocation,
      alteredGait: draft.alteredGait,
      note: draft.note ?? '',
    },
  );
  return payload.feedback;
}

export function evaluateCoachActivity(activityId: string, plannedSessionId?: string): Promise<CoachEvaluationMutation> {
  return mutationJson<CoachEvaluationMutation>(
    `/api/coach/activities/${encodeURIComponent(activityId)}/evaluate`,
    'POST',
    { plannedSessionId, requestId: requestId(`evaluation-${activityId}`) },
  );
}

export function applyCoachDecision(decisionId: string, expectedProfileVersion: number): Promise<{ decision: CoachDecisionRecord }> {
  return mutationJson(`/api/coach/decisions/${encodeURIComponent(decisionId)}/apply`, 'POST', {
    expectedProfileVersion,
  });
}

export function rejectCoachDecision(decisionId: string): Promise<{ decision: CoachDecisionRecord }> {
  return mutationJson(`/api/coach/decisions/${encodeURIComponent(decisionId)}/reject`, 'POST');
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
