import type { D1Database } from '@cloudflare/workers-types';
import type { ActivitySummary } from '../src/types';
import type { Env } from './env';
import { getAthlete, saveAthlete, updateAthleteTokens } from './db';
import type { RawStreams } from './streams';

const STRAVA_SCOPES = 'read,activity:read_all';

export interface StravaTokenResponse {
  token_type: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  expires_in: number;
  scope?: string;
  athlete?: {
    id: number;
    firstname?: string;
    lastname?: string;
    username?: string;
  };
}

export interface StravaActivity {
  id: number;
  name?: string;
  type?: string;
  sport_type?: string;
  start_date?: string;
  start_date_local?: string;
  distance?: number;
  moving_time?: number;
  elapsed_time?: number;
  average_heartrate?: number;
  max_heartrate?: number;
  average_cadence?: number;
  total_elevation_gain?: number;
  suffer_score?: number;
  average_speed?: number;
  start_latlng?: [number, number] | null;
  end_latlng?: [number, number] | null;
  map?: { summary_polyline?: string | null };
}

export interface RateLimit {
  shortUsage: number;
  shortLimit: number;
  dailyUsage: number;
  dailyLimit: number;
}

export function buildAuthUrl(env: Env, state: string): string {
  const url = new URL('https://www.strava.com/oauth/authorize');
  url.searchParams.set('client_id', env.STRAVA_CLIENT_ID);
  url.searchParams.set('redirect_uri', env.STRAVA_REDIRECT_URI ?? '');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('approval_prompt', 'auto');
  url.searchParams.set('scope', STRAVA_SCOPES);
  url.searchParams.set('state', state);
  return url.toString();
}

async function postToken(env: Env, params: Record<string, string>): Promise<StravaTokenResponse> {
  const response = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      ...params,
    }),
  });
  if (!response.ok) {
    throw new Error(`Strava token request failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as StravaTokenResponse;
}

export async function exchangeCodeForToken(env: Env, db: D1Database, code: string): Promise<StravaTokenResponse> {
  const token = await postToken(env, { code, grant_type: 'authorization_code' });
  if (!token.athlete?.id) {
    throw new Error('Strava did not return an athlete for this authorization.');
  }
  await saveAthlete(db, {
    id: token.athlete.id,
    firstname: token.athlete.firstname ?? null,
    lastname: token.athlete.lastname ?? null,
    username: token.athlete.username ?? null,
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: token.expires_at,
    scope: token.scope ?? STRAVA_SCOPES,
  });
  return token;
}

export async function ensureAccessToken(env: Env, db: D1Database): Promise<string> {
  const athlete = await getAthlete(db);
  if (!athlete?.refresh_token) {
    throw new Error('Strava is not connected. Visit /auth/strava/login to authorize.');
  }
  const now = Math.floor(Date.now() / 1000);
  if (athlete.access_token && athlete.expires_at && athlete.expires_at > now + 3600) {
    return athlete.access_token;
  }
  const refreshed = await postToken(env, {
    grant_type: 'refresh_token',
    refresh_token: athlete.refresh_token,
  });
  await updateAthleteTokens(db, {
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token,
    expires_at: refreshed.expires_at,
  });
  return refreshed.access_token;
}

export async function fetchActivities(accessToken: string, afterUnix: number, maxPages = 20): Promise<StravaActivity[]> {
  const activities: StravaActivity[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL('https://www.strava.com/api/v3/athlete/activities');
    url.searchParams.set('after', String(afterUnix));
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', '200');
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) {
      throw new Error(`Strava activity request failed: ${response.status} ${await response.text()}`);
    }
    const pageActivities = (await response.json()) as StravaActivity[];
    activities.push(...pageActivities);
    if (pageActivities.length < 200) {
      break;
    }
  }
  return activities;
}

export interface StreamFetchResult {
  streams: RawStreams | null;
  rateLimit: RateLimit | null;
  status: number;
}

export async function fetchStreams(accessToken: string, activityId: string): Promise<StreamFetchResult> {
  const url = new URL(`https://www.strava.com/api/v3/activities/${activityId}/streams`);
  url.searchParams.set('keys', 'time,latlng,heartrate,cadence,velocity_smooth,altitude,distance');
  url.searchParams.set('key_by_type', 'true');
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const rateLimit = parseRateLimit(response.headers.get('x-ratelimit-usage'), response.headers.get('x-ratelimit-limit'));

  if (response.status === 404) {
    return { streams: null, rateLimit, status: 404 };
  }
  if (!response.ok) {
    return { streams: null, rateLimit, status: response.status };
  }

  const body = (await response.json()) as Record<string, { data?: unknown } | undefined>;
  const streams: RawStreams = {
    time: asNumberArray(body.time?.data),
    latlng: asLatLngArray(body.latlng?.data),
    heartrate: asNumberArray(body.heartrate?.data),
    cadence: asNumberArray(body.cadence?.data),
    velocity_smooth: asNumberArray(body.velocity_smooth?.data),
    altitude: asNumberArray(body.altitude?.data),
    distance: asNumberArray(body.distance?.data),
  };
  return { streams, rateLimit, status: 200 };
}

export function mapActivityToSummary(activity: StravaActivity): ActivitySummary | null {
  const start = activity.start_date ?? activity.start_date_local;
  const date = start ? new Date(start) : null;
  const distanceKm = (activity.distance ?? 0) / 1000;
  const movingTimeSec = activity.moving_time ?? 0;
  if (!date || Number.isNaN(date.getTime()) || distanceKm < 0.8 || movingTimeSec < 240) {
    return null;
  }
  const sportType = activity.sport_type ?? activity.type ?? 'Run';
  const runLike = /run|jog|race/i.test(`${sportType} ${activity.name ?? ''}`);
  return {
    id: String(activity.id),
    name: activity.name ?? 'Strava activity',
    sportType,
    startDate: date.toISOString(),
    startDateLocal: activity.start_date_local ?? date.toISOString(),
    distanceKm,
    movingTimeSec,
    elapsedTimeSec: activity.elapsed_time ?? movingTimeSec,
    averageHeartRate: isUsefulHr(activity.average_heartrate) ? activity.average_heartrate : undefined,
    maxHeartRate: isUsefulHr(activity.max_heartrate) ? activity.max_heartrate : undefined,
    averageCadenceSpm: runLike ? normalizeRunCadence(activity.average_cadence) : activity.average_cadence,
    elevationGainM: activity.total_elevation_gain ?? 0,
    relativeEffort: activity.suffer_score,
    averageSpeed: activity.average_speed,
    startLat: activity.start_latlng?.[0],
    startLng: activity.start_latlng?.[1],
    endLat: activity.end_latlng?.[0],
    endLng: activity.end_latlng?.[1],
    summaryPolyline: activity.map?.summary_polyline ?? undefined,
    hasStreams: false,
  };
}

function normalizeRunCadence(value?: number): number | undefined {
  if (!value || !Number.isFinite(value)) {
    return undefined;
  }
  if (value >= 60 && value < 120) {
    return value * 2;
  }
  if (value >= 120 && value <= 240) {
    return value;
  }
  return undefined;
}

function isUsefulHr(value?: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 80 && value <= 230;
}

function parseRateLimit(usage: string | null, limit: string | null): RateLimit | null {
  if (!usage || !limit) {
    return null;
  }
  const [shortUsage, dailyUsage] = usage.split(',').map((n) => Number(n.trim()));
  const [shortLimit, dailyLimit] = limit.split(',').map((n) => Number(n.trim()));
  if ([shortUsage, dailyUsage, shortLimit, dailyLimit].some((n) => !Number.isFinite(n))) {
    return null;
  }
  return { shortUsage, dailyUsage, shortLimit, dailyLimit };
}

function asNumberArray(value: unknown): number[] | undefined {
  return Array.isArray(value) ? (value as number[]) : undefined;
}

function asLatLngArray(value: unknown): Array<[number, number]> | undefined {
  return Array.isArray(value) ? (value as Array<[number, number]>) : undefined;
}
