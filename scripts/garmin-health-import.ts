import polyline from '@mapbox/polyline';
import { normalizeStreams, simplifyLatLng } from '../worker/streams';
import type { ActivityStreams, ActivitySummary } from '../src/types';
import { sqliteJson } from './lib/sqlite';

interface GarminActivityRow {
  activity_id: number;
  activity_name: string | null;
  activity_type_key: string;
  start_ts: string;
  end_ts: string;
  timezone_offset_hours: number;
  duration: number | null;
  elapsed_duration: number | null;
  moving_duration: number | null;
  distance: number | null;
  average_speed: number | null;
  start_latitude: number | null;
  start_longitude: number | null;
  end_latitude: number | null;
  end_longitude: number | null;
  average_hr: number | null;
  max_hr: number | null;
  activity_training_load: number | null;
  elevation_gain: number | null;
  avg_running_cadence: number | null;
  running_avg_power: number | null;
  stream_avg_power: number | null;
  path_json: string | null;
  point_count: number | null;
}

interface MetricRow {
  timestamp: string;
  position_lat: number | null;
  position_long: number | null;
  heart_rate: number | null;
  cadence: number | null;
  enhanced_speed: number | null;
  speed: number | null;
  enhanced_altitude: number | null;
  altitude: number | null;
  distance_m: number | null;
  power: number | null;
}

interface IngestActivity {
  summary: ActivitySummary;
  streams?: ActivityStreams;
}

const dbPath = process.env.GARMIN_DB_PATH ?? 'garmin_data.db';
const baseUrl = (process.env.LYDIARD_BASE_URL ?? 'https://lydiard.lydiard.workers.dev').replace(/\/$/, '');
const ingestKey = process.env.LYDIARD_INGEST_KEY ?? process.env.AGENT_API_KEY;
const dryRun = process.argv.includes('--dry-run');
const replace = !process.argv.includes('--no-replace');
const quiet = process.argv.includes('--quiet');
const batchSize = positiveInteger(readArg('--batch-size') ?? process.env.GARMIN_IMPORT_BATCH_SIZE) ?? 25;
const offset = nonNegativeInteger(readArg('--offset') ?? process.env.GARMIN_IMPORT_OFFSET) ?? 0;
const limit = positiveInteger(readArg('--limit') ?? process.env.GARMIN_IMPORT_LIMIT);
const includeTypes = (process.env.GARMIN_IMPORT_ACTIVITY_TYPES ?? 'running')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

if (!ingestKey && !dryRun) {
  throw new Error('Set LYDIARD_INGEST_KEY or AGENT_API_KEY, or run with --dry-run.');
}

const rows = await sqliteJson<GarminActivityRow>(
  dbPath,
  `
  SELECT
    a.activity_id,
    a.activity_name,
    a.activity_type_key,
    a.start_ts,
    a.end_ts,
    a.timezone_offset_hours,
    a.duration,
    a.elapsed_duration,
    a.moving_duration,
    a.distance,
    a.average_speed,
    a.start_latitude,
    a.start_longitude,
    a.end_latitude,
    a.end_longitude,
    a.average_hr,
    a.max_hr,
    a.activity_training_load,
    r.elevation_gain AS elevation_gain,
    r.avg_running_cadence,
    r.avg_power AS running_avg_power,
    NULL AS stream_avg_power,
    p.path_json,
    p.point_count
  FROM activity a
  LEFT JOIN running_agg_metrics r ON r.activity_id = a.activity_id
  LEFT JOIN activity_path p ON p.activity_id = a.activity_id
  WHERE a.distance > 0
    AND COALESCE(a.moving_duration, a.duration, a.elapsed_duration) > 0
  ORDER BY a.start_ts ASC
  `,
  { maxBuffer: 512 * 1024 * 1024 },
);

const allCandidates = rows.filter((row) => isIncludedType(row));
const candidates = allCandidates.slice(offset, limit ? offset + limit : undefined);
if (candidates.length === 0) {
  throw new Error(`No Garmin activities matched import types/window: ${includeTypes.join(', ')} offset=${offset} limit=${limit ?? 'all'}`);
}

const stats = {
  activities: 0,
  withHr: 0,
  withPower: 0,
  withStreams: 0,
  first: undefined as string | undefined,
  last: undefined as string | undefined,
  batches: 0,
  upserted: 0,
  streamsSaved: 0,
  finalWeekCount: undefined as number | null | undefined,
};

let batch: IngestActivity[] = [];
let sentAnyBatch = false;
for (const [index, row] of candidates.entries()) {
  const streams = await loadStreams(row.activity_id);
  const activity = toIngestActivity(row, streams);
  recordActivityStats(activity);
  batch.push(activity);
  if (!quiet) {
    console.log(`prepared garmin-${row.activity_id} ${row.activity_type_key} ${localDate(row.start_ts, row.timezone_offset_hours)}`);
  }

  const isFinalActivity = index === candidates.length - 1;
  if (!dryRun && (batch.length >= batchSize || isFinalActivity)) {
    const batchNumber = stats.batches + 1;
    const response = await postBatch(batch, {
      batchNumber,
      replace: replace && !sentAnyBatch,
      recomputeWeeks: isFinalActivity,
    });
    stats.batches = batchNumber;
    stats.upserted += response.upserted;
    stats.streamsSaved += response.streamsSaved;
    stats.finalWeekCount = response.weekCount;
    sentAnyBatch = true;
    batch = [];
  }
}

if (dryRun) {
  console.log(
    JSON.stringify(
      {
        dryRun: true,
        dbPath,
        replace,
        batchSize,
        offset,
        limit: limit ?? null,
        matchedActivities: allCandidates.length,
        estimatedBatches: Math.ceil(candidates.length / batchSize),
        activities: stats.activities,
        withHr: stats.withHr,
        withPower: stats.withPower,
        withStreams: stats.withStreams,
        first: stats.first,
        last: stats.last,
      },
      null,
      2,
    ),
  );
} else {
  console.log(
    JSON.stringify(
      {
        ok: true,
        source: 'garmin-health-data',
        replace,
        batchSize,
        offset,
        limit: limit ?? null,
        matchedActivities: allCandidates.length,
        batches: stats.batches,
        activities: stats.activities,
        withHr: stats.withHr,
        withPower: stats.withPower,
        withStreams: stats.withStreams,
        upserted: stats.upserted,
        streamsSaved: stats.streamsSaved,
        weekCount: stats.finalWeekCount,
        first: stats.first,
        last: stats.last,
      },
      null,
      2,
    ),
  );
}

interface BatchResponse {
  ok: boolean;
  upserted: number;
  streamsSaved: number;
  weekCount: number | null;
}

async function postBatch(
  activities: IngestActivity[],
  opts: { batchNumber: number; replace: boolean; recomputeWeeks: boolean },
): Promise<BatchResponse> {
  const body = JSON.stringify({
    source: 'garmin-health-data',
    replace: opts.replace,
    recomputeWeeks: opts.recomputeWeeks,
    activities,
  });
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/ingest/activities`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ingestKey}`,
          'Content-Type': 'application/json',
        },
        body,
      });
    } catch (error) {
      if (attempt === maxAttempts) {
        throw new Error(`Ingest batch ${opts.batchNumber} request failed after ${attempt} attempts: ${String(error)}`);
      }
      await sleep(backoffMs(attempt));
      continue;
    }

    const text = await response.text();
    if (response.ok) {
      const parsed = JSON.parse(text) as BatchResponse;
      console.log(
        `uploaded batch ${opts.batchNumber}: ${parsed.upserted} activities, ${parsed.streamsSaved} streams, recomputeWeeks=${opts.recomputeWeeks}`,
      );
      return parsed;
    }
    if ((response.status === 401 || response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
      console.warn(`Ingest batch ${opts.batchNumber} attempt ${attempt} failed: ${response.status} ${text}`);
      await sleep(backoffMs(attempt));
      continue;
    }
    throw new Error(`Ingest batch ${opts.batchNumber} failed: ${response.status} ${text}`);
  }
  throw new Error(`Ingest batch ${opts.batchNumber} failed unexpectedly.`);
}

function recordActivityStats(activity: IngestActivity): void {
  stats.activities += 1;
  stats.withHr += activity.summary.averageHeartRate ? 1 : 0;
  stats.withPower += activity.summary.averageWatts ? 1 : 0;
  stats.withStreams += activity.streams?.timeSec?.length ? 1 : 0;
  stats.first ??= activity.summary.startDateLocal;
  stats.last = activity.summary.startDateLocal;
}

async function loadStreams(activityId: number): Promise<ActivityStreams | undefined> {
  const metrics = await sqliteJson<MetricRow>(
    dbPath,
    `
    SELECT
      timestamp,
      MAX(CASE WHEN name = 'position_lat' THEN value END) AS position_lat,
      MAX(CASE WHEN name = 'position_long' THEN value END) AS position_long,
      MAX(CASE WHEN name = 'heart_rate' THEN value END) AS heart_rate,
      MAX(CASE WHEN lower(name) = 'cadence' THEN value END) AS cadence,
      MAX(CASE WHEN name = 'enhanced_speed' THEN value END) AS enhanced_speed,
      MAX(CASE WHEN name = 'speed' THEN value END) AS speed,
      MAX(CASE WHEN name = 'enhanced_altitude' THEN value END) AS enhanced_altitude,
      MAX(CASE WHEN name = 'altitude' THEN value END) AS altitude,
      MAX(CASE WHEN name = 'distance' THEN value END) AS distance_m,
      MAX(CASE WHEN lower(name) = 'power' THEN value END) AS power
    FROM activity_ts_metric
    WHERE activity_id = ${activityId}
    GROUP BY timestamp
    ORDER BY timestamp ASC
    `,
    { maxBuffer: 96 * 1024 * 1024 },
  );

  if (metrics.length < 2) {
    return undefined;
  }

  const startMs = timestampMs(metrics[0].timestamp);
  const time = metrics.map((row) => (timestampMs(row.timestamp) - startMs) / 1000);
  const latlng = metrics
    .map((row) => {
      const lat = coordinate(row.position_lat);
      const lng = coordinate(row.position_long);
      return lat === undefined || lng === undefined ? undefined : ([lat, lng] as [number, number]);
    })
    .filter((point): point is [number, number] => Boolean(point));

  return normalizeStreams({
    time,
    latlng,
    heartrate: filledSeries(metrics.map((row) => usefulHr(row.heart_rate))),
    cadence: filledSeries(metrics.map((row) => finiteNumber(row.cadence))),
    velocity_smooth: filledSeries(metrics.map((row) => finiteNumber(row.enhanced_speed ?? row.speed))),
    altitude: filledSeries(metrics.map((row) => finiteNumber(row.enhanced_altitude ?? row.altitude))),
    distance: filledSeries(metrics.map((row) => finiteNumber(row.distance_m))),
    power: filledSeries(metrics.map((row) => positiveNumber(row.power))),
  });
}

function toIngestActivity(row: GarminActivityRow, streams?: ActivityStreams): IngestActivity {
  const path = parsePath(row.path_json);
  const summaryPath = simplifyLatLng(path.length > 1 ? path : streams?.latlng, 0.00003, 800);
  const streamPowerAverage = average(streams?.power?.filter((value) => value > 0) ?? []);
  const averageWatts = positiveNumber(row.stream_avg_power) ?? positiveNumber(row.running_avg_power) ?? streamPowerAverage;
  const movingTimeSec = Math.round(row.moving_duration ?? row.duration ?? 0);
  const elapsedTimeSec = Math.round(row.elapsed_duration ?? row.duration ?? movingTimeSec);
  const distanceKm = (row.distance ?? last(streams?.distanceM) ?? 0) / 1000;

  const summary: ActivitySummary = {
    id: `garmin-${row.activity_id}`,
    name: row.activity_name ?? 'Garmin run',
    sportType: row.activity_type_key,
    startDate: utcIso(row.start_ts),
    startDateLocal: localDate(row.start_ts, row.timezone_offset_hours),
    distanceKm: Number(distanceKm.toFixed(3)),
    movingTimeSec,
    elapsedTimeSec,
    averageHeartRate: usefulHr(row.average_hr) ?? average(streams?.heartrate),
    maxHeartRate: usefulHr(row.max_hr) ?? max(streams?.heartrate),
    averageCadenceSpm: positiveNumber(row.avg_running_cadence) ?? average(streams?.cadence),
    elevationGainM: row.elevation_gain ?? 0,
    relativeEffort: positiveNumber(row.activity_training_load),
    averageWatts,
    averageSpeed:
      finiteNumber(row.average_speed) ??
      (distanceKm > 0 && movingTimeSec > 0 ? (distanceKm * 1000) / movingTimeSec : undefined),
    startLat: finiteNumber(row.start_latitude) ?? summaryPath?.[0]?.[0],
    startLng: finiteNumber(row.start_longitude) ?? summaryPath?.[0]?.[1],
    endLat: finiteNumber(row.end_latitude) ?? summaryPath?.[summaryPath.length - 1]?.[0],
    endLng: finiteNumber(row.end_longitude) ?? summaryPath?.[summaryPath.length - 1]?.[1],
    summaryPolyline: summaryPath && summaryPath.length > 1 ? polyline.encode(summaryPath) : undefined,
    hasStreams: Boolean(streams?.timeSec?.length || streams?.latlng?.length),
  };

  return { summary, streams };
}

function isIncludedType(row: GarminActivityRow): boolean {
  const text = `${row.activity_type_key} ${row.activity_name ?? ''}`.toLowerCase();
  return includeTypes.some((type) => text.includes(type));
}

function parsePath(value: string | null): Array<[number, number]> {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((point) => {
        if (!Array.isArray(point) || point.length < 2) {
          return undefined;
        }
        const lng = finiteNumber(point[0]);
        const lat = finiteNumber(point[1]);
        return lat === undefined || lng === undefined ? undefined : ([lat, lng] as [number, number]);
      })
      .filter((point): point is [number, number] => Boolean(point));
  } catch {
    return [];
  }
}

function coordinate(value: number | null): number | undefined {
  const n = finiteNumber(value);
  if (n === undefined) {
    return undefined;
  }
  return Math.abs(n) <= 180 ? n : (n * 180) / 2147483648;
}

function filledSeries(values: Array<number | undefined>): number[] | undefined {
  if (values.filter((value) => value !== undefined).length < Math.max(2, values.length * 0.4)) {
    return undefined;
  }

  const next: Array<number | undefined> = new Array(values.length);
  let upcoming: number | undefined;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] !== undefined) {
      upcoming = values[index];
    }
    next[index] = upcoming;
  }

  let previous = next[0] ?? 0;
  return values.map((value, index) => {
    if (value !== undefined) {
      previous = value;
      return value;
    }
    previous = next[index] ?? previous;
    return previous;
  });
}

function utcIso(value: string): string {
  return new Date(`${value.replace(' ', 'T')}Z`).toISOString();
}

function localDate(value: string, offsetHours: number): string {
  const utcMs = new Date(`${value.replace(' ', 'T')}Z`).getTime();
  const local = new Date(utcMs + offsetHours * 3600000);
  return local.toISOString().replace(/\.\d{3}Z$/, '');
}

function timestampMs(value: string): number {
  return new Date(`${value.replace(' ', 'T')}Z`).getTime();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  return Math.min(30_000, 2000 * 2 ** (attempt - 1));
}

function readArg(name: string): string | undefined {
  const exact = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (exact) {
    return exact.slice(name.length + 1);
  }
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : undefined;
  return n !== undefined && Number.isFinite(n) ? n : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const n = finiteNumber(value);
  return n !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const n = finiteNumber(value);
  return n !== undefined && Number.isInteger(n) && n >= 0 ? n : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const n = finiteNumber(value);
  return n !== undefined && n > 0 ? n : undefined;
}

function usefulHr(value: unknown): number | undefined {
  const n = finiteNumber(value);
  return n !== undefined && n >= 80 && n <= 220 ? n : undefined;
}

function average(values: number[] | undefined): number | undefined {
  return values?.length ? values.reduce((total, value) => total + value, 0) / values.length : undefined;
}

function max(values: number[] | undefined): number | undefined {
  return values?.length ? Math.max(...values) : undefined;
}

function last(values: number[] | undefined): number | undefined {
  return values?.length ? values[values.length - 1] : undefined;
}
