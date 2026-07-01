import 'dotenv/config';
import crypto from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { buildImportedTrainingFromActivities, type ImportedActivity } from '../src/data/importActivities';

interface StravaToken {
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

interface StravaActivity {
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
  average_cadence?: number;
  total_elevation_gain?: number;
  suffer_score?: number;
  relative_effort?: number;
}

const PORT = Number(process.env.STRAVA_SERVER_PORT ?? 8787);
const APP_ORIGIN = process.env.APP_ORIGIN ?? 'http://localhost:5173';
const CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const REDIRECT_URI = process.env.STRAVA_REDIRECT_URI ?? `http://localhost:${PORT}/api/strava/callback`;
const SCOPES = process.env.STRAVA_SCOPES ?? 'read,activity:read_all';
const FETCH_YEARS = Number(process.env.STRAVA_FETCH_YEARS ?? 3);
const MAX_PAGES = Number(process.env.STRAVA_MAX_PAGES ?? 20);
const TOKEN_DIR = path.resolve(process.cwd(), '.local');
const TOKEN_PATH = path.join(TOKEN_DIR, 'strava-token.json');

let pendingState = '';

const app = express();

app.use(express.json());
app.use((request, response, next) => {
  response.setHeader('Access-Control-Allow-Origin', APP_ORIGIN);
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (request.method === 'OPTIONS') {
    response.sendStatus(204);
    return;
  }

  next();
});

app.get('/api/strava/status', async (_request, response) => {
  const token = await readToken();

  response.json({
    configured: Boolean(CLIENT_ID && CLIENT_SECRET),
    connected: Boolean(token),
    athlete: token?.athlete ?? null,
    scope: token?.scope ?? null,
    expiresAt: token?.expires_at ?? null,
    redirectUri: REDIRECT_URI,
    fetchYears: FETCH_YEARS,
  });
});

app.get('/api/strava/auth-url', (_request, response) => {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    response.status(400).json({
      error: 'Set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET in .env, then restart npm run server.',
    });
    return;
  }

  pendingState = crypto.randomUUID();
  const authUrl = new URL('https://www.strava.com/oauth/authorize');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('approval_prompt', 'auto');
  authUrl.searchParams.set('scope', SCOPES);
  authUrl.searchParams.set('state', pendingState);

  response.json({ url: authUrl.toString() });
});

app.get('/api/strava/callback', async (request, response) => {
  const error = asString(request.query.error);
  const code = asString(request.query.code);
  const state = asString(request.query.state);

  if (error) {
    response.redirect(`${APP_ORIGIN}/?strava_error=${encodeURIComponent(error)}`);
    return;
  }

  if (!code) {
    response.redirect(`${APP_ORIGIN}/?strava_error=${encodeURIComponent('Missing authorization code')}`);
    return;
  }

  if (pendingState && state !== pendingState) {
    response.redirect(`${APP_ORIGIN}/?strava_error=${encodeURIComponent('OAuth state mismatch')}`);
    return;
  }

  try {
    const token = await exchangeCodeForToken(code);
    await writeToken(token);
    pendingState = '';
    response.redirect(`${APP_ORIGIN}/?strava=connected`);
  } catch (callbackError) {
    response.redirect(`${APP_ORIGIN}/?strava_error=${encodeURIComponent(errorMessage(callbackError))}`);
  }
});

app.get('/api/strava/training', async (_request, response) => {
  try {
    const token = await ensureAccessToken();
    const activities = await fetchStravaActivities(token.access_token);
    const importedActivities = activities.map(mapStravaActivity).filter((activity): activity is ImportedActivity => activity !== null);
    const training = buildImportedTrainingFromActivities(importedActivities, 'strava', 'Strava API');

    response.json({
      ...training,
      warnings: [
        ...training.warnings.filter((warning) => !warning.includes('Summary CSV')),
        'Strava login currently imports summary activities. Stream-level decoupling is the next connector step.',
      ],
    });
  } catch (trainingError) {
    response.status(400).json({ error: errorMessage(trainingError) });
  }
});

app.post('/api/strava/disconnect', async (_request, response) => {
  await rm(TOKEN_PATH, { force: true });
  response.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Strava OAuth server listening on http://localhost:${PORT}`);
  console.log(`Callback URL: ${REDIRECT_URI}`);
});

async function exchangeCodeForToken(code: string): Promise<StravaToken> {
  const response = await postStravaToken({
    client_id: CLIENT_ID ?? '',
    client_secret: CLIENT_SECRET ?? '',
    code,
    grant_type: 'authorization_code',
  });

  if (!scopeIncludes(response.scope, 'activity:read_all') && !scopeIncludes(response.scope, 'activity:read')) {
    throw new Error(`Strava granted scope "${response.scope ?? 'none'}"; activity read access is required.`);
  }

  return response;
}

async function ensureAccessToken(): Promise<StravaToken> {
  const token = await readToken();

  if (!token) {
    throw new Error('Connect Strava before syncing activities.');
  }

  if (token.expires_at > Math.floor(Date.now() / 1000) + 3600) {
    return token;
  }

  const refreshed = await postStravaToken({
    client_id: CLIENT_ID ?? '',
    client_secret: CLIENT_SECRET ?? '',
    grant_type: 'refresh_token',
    refresh_token: token.refresh_token,
  });
  const merged = {
    ...token,
    ...refreshed,
    athlete: refreshed.athlete ?? token.athlete,
    scope: refreshed.scope ?? token.scope,
  };
  await writeToken(merged);

  return merged;
}

async function postStravaToken(params: Record<string, string>): Promise<StravaToken> {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('Set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET in .env, then restart npm run server.');
  }

  const response = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  });

  if (!response.ok) {
    throw new Error(`Strava token request failed: ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as StravaToken;
}

async function fetchStravaActivities(accessToken: string): Promise<StravaActivity[]> {
  const activities: StravaActivity[] = [];
  const after = Math.floor(Date.now() / 1000 - FETCH_YEARS * 365.25 * 24 * 60 * 60);

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL('https://www.strava.com/api/v3/athlete/activities');
    url.searchParams.set('after', String(after));
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', '200');

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Strava activity request failed: ${response.status} ${await response.text()}`);
    }

    const pageActivities = (await response.json()) as StravaActivity[];

    if (pageActivities.length === 0) {
      break;
    }

    activities.push(...pageActivities);

    if (pageActivities.length < 200) {
      break;
    }
  }

  if (activities.length === 0) {
    throw new Error('Strava returned no activities for the configured date range.');
  }

  return activities;
}

function mapStravaActivity(activity: StravaActivity): ImportedActivity | null {
  const start = activity.start_date_local ?? activity.start_date;
  const date = start ? new Date(start) : null;
  const distanceKm = (activity.distance ?? 0) / 1000;
  const movingTimeSec = activity.moving_time ?? 0;

  if (!date || Number.isNaN(date.getTime()) || distanceKm < 0.8 || movingTimeSec < 240) {
    return null;
  }

  return {
    id: String(activity.id),
    name: activity.name ?? 'Strava activity',
    type: activity.sport_type ?? activity.type ?? 'Run',
    date,
    distanceKm,
    movingTimeSec,
    elapsedTimeSec: activity.elapsed_time ?? movingTimeSec,
    averageHeartRate: activity.average_heartrate,
    averageCadenceSpm: normalizeStravaRunCadence(activity.average_cadence),
    elevationGainM: activity.total_elevation_gain ?? 0,
    relativeEffort: activity.relative_effort ?? activity.suffer_score,
  };
}

function normalizeStravaRunCadence(value?: number): number | undefined {
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

async function readToken(): Promise<StravaToken | null> {
  try {
    return JSON.parse(await readFile(TOKEN_PATH, 'utf8')) as StravaToken;
  } catch {
    return null;
  }
}

async function writeToken(token: StravaToken): Promise<void> {
  await mkdir(TOKEN_DIR, { recursive: true });
  await writeFile(TOKEN_PATH, JSON.stringify(token, null, 2), { mode: 0o600 });
}

function scopeIncludes(scope: string | undefined, expected: string): boolean {
  return (scope ?? '')
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .includes(expected);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected Strava error';
}
