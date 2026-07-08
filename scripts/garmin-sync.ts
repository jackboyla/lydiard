import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import polyline from '@mapbox/polyline';
import FitParser from 'fit-file-parser';
import { GarminConnect } from 'garmin-connect';
import type { ActivityStreams, ActivitySummary } from '../src/types';

interface GarminActivity {
  activityId: number;
  activityName?: string;
  startTimeLocal?: string;
  startTimeGMT?: string;
  activityType?: { typeKey?: string };
  distance?: number;
  duration?: number;
  movingDuration?: number;
  elapsedDuration?: number;
  elevationGain?: number;
  averageHR?: number;
  maxHR?: number;
  averageRunningCadenceInStepsPerMinute?: number;
  avgPower?: unknown;
  activityTrainingLoad?: unknown;
  averageSpeed?: number;
  startLatitude?: number;
  startLongitude?: number;
  endLatitude?: number;
  endLongitude?: number;
}

type FitRecord = Record<string, unknown>;

interface IngestActivity {
  summary: ActivitySummary;
  streams?: ActivityStreams;
}

class GarminRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GarminRateLimitError';
  }
}

const username = requiredEnv('GARMIN_USERNAME');
const password = requiredEnv('GARMIN_PASSWORD');
const baseUrl = (process.env.LYDIARD_BASE_URL ?? 'https://lydiard.lydiard.workers.dev').replace(/\/$/, '');
const ingestKey = process.env.LYDIARD_INGEST_KEY ?? process.env.AGENT_API_KEY;
const days = numberEnv('GARMIN_SYNC_DAYS', 365);
const limit = numberEnv('GARMIN_LIMIT', 200);
const dryRun = process.argv.includes('--dry-run');
const retryAttempts = numberEnv('GARMIN_RETRY_ATTEMPTS', process.env.GITHUB_ACTIONS ? 4 : 3);
const retryBaseMs = numberEnv('GARMIN_RETRY_BASE_MS', process.env.GITHUB_ACTIONS ? 60000 : 10000);
const softFailRateLimit = process.env.GARMIN_SOFT_FAIL_RATE_LIMIT !== 'false';

if (!ingestKey && !dryRun) {
  throw new Error('Set LYDIARD_INGEST_KEY or AGENT_API_KEY, or run with --dry-run.');
}

const sinceMs = Date.now() - days * 86400000;
const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lydiard-garmin-'));

try {
  const client = new GarminConnect({ username, password });
  const tokenDir = process.env.GARMIN_TOKEN_DIR;
  let loggedIn = false;
  if (tokenDir) {
    try {
      client.loadTokenByFile(tokenDir);
      loggedIn = true;
    } catch {
      loggedIn = false;
    }
  }
  if (!loggedIn) {
    await withGarminRetry('Garmin login', () => client.login());
    if (tokenDir) {
      await fs.mkdir(tokenDir, { recursive: true });
      client.exportTokenToFile(tokenDir);
    }
  }

  const all = (await withGarminRetry('Garmin activity list', () => client.getActivities(0, limit))) as GarminActivity[];
  const candidates = all
    .filter(isRunLike)
    .filter((activity) => new Date(startDateUtc(activity)).getTime() >= sinceMs)
    .sort((a, b) => new Date(a.startTimeGMT ?? '').getTime() - new Date(b.startTimeGMT ?? '').getTime());

  const ingestActivities: IngestActivity[] = [];
  let hitRateLimit = false;
  for (const activity of candidates) {
    try {
      const fitBuffer = await downloadFit(client, activity, workDir);
      const parsed = await parseFit(fitBuffer);
      ingestActivities.push(toIngestActivity(activity, parsed));
      console.log(`prepared garmin-${activity.activityId} ${activity.activityName ?? 'Run'}`);
    } catch (error) {
      if (error instanceof GarminRateLimitError) {
        hitRateLimit = true;
        console.warn(error.message);
        break;
      }
      console.warn(`skipped garmin-${activity.activityId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (hitRateLimit && ingestActivities.length === 0 && softFailRateLimit) {
    console.warn('Garmin rate-limited this run before any activities were prepared. Exiting successfully; the next schedule can retry.');
    process.exitCode = 0;
  } else if (ingestActivities.length === 0) {
    console.log(JSON.stringify({ ok: true, activities: 0, message: 'No Garmin activities to ingest.' }, null, 2));
  } else if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, activities: ingestActivities.length }, null, 2));
  } else {
    const response = await fetch(`${baseUrl}/api/ingest/activities`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ingestKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ source: 'garmin-connect-script', activities: ingestActivities }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Ingest failed: ${response.status} ${text}`);
    }
    console.log(text);
  }
} catch (error) {
  if (error instanceof GarminRateLimitError && softFailRateLimit) {
    console.warn(`${error.message}. Exiting successfully; the next schedule can retry.`);
    process.exitCode = 0;
  } else {
    throw error;
  }
} finally {
  await fs.rm(workDir, { recursive: true, force: true });
}

async function downloadFit(client: GarminConnect, activity: GarminActivity, dir: string): Promise<Buffer> {
  await withGarminRetry(`Garmin original activity download ${activity.activityId}`, () =>
    client.downloadOriginalActivityData({ activityId: activity.activityId }, dir, 'zip'),
  );
  const zipPath = path.join(dir, `${activity.activityId}.zip`);
  const zip = new AdmZip(zipPath);
  const fitEntry = zip
    .getEntries()
    .find((entry) => !entry.isDirectory && entry.entryName.toLowerCase().endsWith('.fit'));
  if (!fitEntry) {
    throw new Error('original activity ZIP did not contain a FIT file');
  }
  return fitEntry.getData();
}

async function parseFit(buffer: Buffer): Promise<{ records: FitRecord[]; sessions: FitRecord[] }> {
  const parser = new FitParser({
    force: true,
    mode: 'list',
    lengthUnit: 'm',
    speedUnit: 'm/s',
    elapsedRecordField: true,
  });
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  const parsed = (await parser.parseAsync(arrayBuffer) as unknown) as Record<string, unknown>;
  return {
    records: Array.isArray(parsed.records) ? (parsed.records as FitRecord[]) : [],
    sessions: Array.isArray(parsed.sessions) ? (parsed.sessions as FitRecord[]) : [],
  };
}

function toIngestActivity(
  activity: GarminActivity,
  fit: { records: FitRecord[]; sessions: FitRecord[] },
): IngestActivity {
  const records = fit.records;
  const latlng = records.map(recordLatLng).filter((point): point is [number, number] => Boolean(point));
  const timeSec = timesFromRecords(records);
  const distanceM = records.map((record) => num(record.distance)).filter(isFiniteNumber);
  const heartrate = records.map((record) => num(record.heart_rate)).filter(isFiniteNumber);
  const cadence = records.map((record) => num(record.cadence)).filter(isFiniteNumber);
  const power = records.map((record) => num(record.power)).filter(isFiniteNumber);
  const velocity = records.map(recordVelocity).filter(isFiniteNumber);
  const altitude = records.map((record) => num(record.altitude ?? record.enhanced_altitude)).filter(isFiniteNumber);

  const streams: ActivityStreams = {
    latlng: latlng.length > 1 ? latlng : undefined,
    timeSec: aligned(timeSec, records.length),
    heartrate: aligned(heartrate, records.length),
    cadence: aligned(cadence, records.length),
    velocity: aligned(velocity, records.length),
    altitude: aligned(altitude, records.length),
    distanceM: aligned(distanceM, records.length),
  };

  const movingTimeSec = Math.round(
    activity.movingDuration ?? activity.duration ?? durationFromRecords(timeSec) ?? 0,
  );
  const elapsedTimeSec = Math.round(activity.elapsedDuration ?? activity.duration ?? movingTimeSec);
  const distanceKm = (activity.distance ?? last(distanceM) ?? 0) / 1000;
  const avgPower = firstNumber(activity.avgPower, average(power));
  const summary: ActivitySummary = {
    id: `garmin-${activity.activityId}`,
    name: activity.activityName ?? 'Garmin run',
    sportType: activity.activityType?.typeKey ?? 'running',
    startDate: startDateUtc(activity),
    startDateLocal: localDate(activity),
    distanceKm: Number(distanceKm.toFixed(3)),
    movingTimeSec,
    elapsedTimeSec,
    averageHeartRate: usefulHr(activity.averageHR) ?? usefulHr(average(heartrate)),
    maxHeartRate: usefulHr(activity.maxHR) ?? usefulHr(max(heartrate)),
    averageCadenceSpm: firstNumber(activity.averageRunningCadenceInStepsPerMinute, average(cadence)),
    elevationGainM: activity.elevationGain ?? 0,
    relativeEffort: firstNumber(activity.activityTrainingLoad),
    averageWatts: avgPower && avgPower > 0 ? avgPower : undefined,
    averageSpeed: activity.averageSpeed ?? (distanceKm > 0 && movingTimeSec > 0 ? (distanceKm * 1000) / movingTimeSec : undefined),
    startLat: activity.startLatitude ?? latlng[0]?.[0],
    startLng: activity.startLongitude ?? latlng[0]?.[1],
    endLat: activity.endLatitude ?? latlng[latlng.length - 1]?.[0],
    endLng: activity.endLongitude ?? latlng[latlng.length - 1]?.[1],
    summaryPolyline: latlng.length > 1 ? polyline.encode(latlng) : undefined,
    hasStreams: true,
  };

  return { summary, streams };
}

function isRunLike(activity: GarminActivity): boolean {
  const text = `${activity.activityName ?? ''} ${activity.activityType?.typeKey ?? ''}`.toLowerCase();
  return text.includes('run') || text.includes('running') || text.includes('jog') || text.includes('race');
}

function startDateUtc(activity: GarminActivity): string {
  const raw = activity.startTimeGMT ?? activity.startTimeLocal;
  if (!raw) {
    throw new Error(`activity ${activity.activityId} is missing a start time`);
  }
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const withZone = /Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`;
  return new Date(withZone).toISOString();
}

function localDate(activity: GarminActivity): string {
  const raw = activity.startTimeLocal ?? activity.startTimeGMT;
  if (!raw) {
    return startDateUtc(activity);
  }
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T');
  return /Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`;
}

function recordLatLng(record: FitRecord): [number, number] | undefined {
  const lat = coordinate(record.position_lat ?? record.enhanced_position_lat);
  const lng = coordinate(record.position_long ?? record.position_lng ?? record.enhanced_position_long);
  return lat === undefined || lng === undefined ? undefined : [lat, lng];
}

function coordinate(value: unknown): number | undefined {
  const n = num(value);
  if (n === undefined) {
    return undefined;
  }
  if (Math.abs(n) <= 180) {
    return n;
  }
  return (n * 180) / 2147483648;
}

function recordVelocity(record: FitRecord): number | undefined {
  return num(record.enhanced_speed ?? record.speed);
}

function timesFromRecords(records: FitRecord[]): number[] {
  const elapsed = records.map((record) => num(record.elapsed_time ?? record.timer_time));
  if (elapsed.filter(isFiniteNumber).length >= Math.max(2, records.length * 0.5)) {
    return elapsed.filter(isFiniteNumber);
  }

  const timestamps = records.map((record) => timestampMs(record.timestamp));
  const valid = timestamps.filter(isFiniteNumber);
  if (valid.length < Math.max(2, records.length * 0.5)) {
    return [];
  }
  const start = valid[0];
  return valid.map((value) => (value - start) / 1000);
}

function timestampMs(value: unknown): number | undefined {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function aligned(values: number[], recordCount: number): number[] | undefined {
  return values.length >= Math.max(2, recordCount * 0.5) ? values : values.length > 1 ? values : undefined;
}

function durationFromRecords(timeSec: number[]): number | undefined {
  if (timeSec.length < 2) {
    return undefined;
  }
  return timeSec[timeSec.length - 1] - timeSec[0];
}

function num(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : undefined;
  return n !== undefined && Number.isFinite(n) ? n : undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const n = num(value);
    if (n !== undefined) {
      return n;
    }
  }
  return undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function average(values: number[]): number | undefined {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : undefined;
}

function max(values: number[]): number | undefined {
  return values.length ? Math.max(...values) : undefined;
}

function last(values: number[]): number | undefined {
  return values.length ? values[values.length - 1] : undefined;
}

function usefulHr(value: unknown): number | undefined {
  const n = num(value);
  return n !== undefined && n >= 80 && n <= 230 ? n : undefined;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Set ${name}.`);
  }
  return value;
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function withGarminRetry<T>(label: string, operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= retryAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRateLimitError(error) || attempt === retryAttempts) {
        if (isRateLimitError(error)) {
          throw new GarminRateLimitError(`${label} was rate-limited after ${attempt} attempt${attempt === 1 ? '' : 's'}`);
        }
        throw error;
      }
      const delayMs = retryBaseMs * 2 ** (attempt - 1);
      console.warn(`${label} rate-limited; retrying in ${Math.round(delayMs / 1000)}s (${attempt}/${retryAttempts})`);
      await sleep(delayMs);
    }
  }
  throw new GarminRateLimitError(`${label} was rate-limited.`);
}

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /429|too many requests|rate limited/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
