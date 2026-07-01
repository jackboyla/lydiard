import type { ImportedTrainingData } from './importActivities';

export interface StravaStatus {
  configured: boolean;
  connected: boolean;
  athlete: {
    id: number;
    firstname?: string;
    lastname?: string;
    username?: string;
  } | null;
  scope: string | null;
  expiresAt: number | null;
  redirectUri: string;
  fetchYears: number;
}

export async function getStravaStatus(): Promise<StravaStatus> {
  return apiRequest<StravaStatus>('/api/strava/status');
}

export async function getStravaAuthUrl(): Promise<string> {
  const response = await apiRequest<{ url: string }>('/api/strava/auth-url');
  return response.url;
}

export async function syncStravaTraining(): Promise<ImportedTrainingData> {
  return apiRequest<ImportedTrainingData>('/api/strava/training');
}

export async function disconnectStrava(): Promise<void> {
  await apiRequest<{ ok: boolean }>('/api/strava/disconnect', {
    method: 'POST',
  });
}

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}
