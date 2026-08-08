import { spawnSync } from 'node:child_process';
import type { ActivityLap } from '../src/types';
import { sqliteJson } from './lib/sqlite';

interface LapRow {
  activity_id: number;
  lap_idx: number;
  distance_m: number | null;
  duration_sec: number | null;
  elapsed_sec: number | null;
  average_hr: number | null;
  max_hr: number | null;
  average_power: number | null;
  max_power: number | null;
  average_speed_mps: number | null;
}

interface LapActivity {
  activityId: string;
  laps: ActivityLap[];
}

const dbPath = process.env.GARMIN_DB_PATH ?? 'garmin_data.db';
const baseUrl = (process.env.LYDIARD_BASE_URL ?? '').replace(/\/$/, '');
if (!baseUrl) throw new Error('Set LYDIARD_BASE_URL to your Worker origin, e.g. https://lydiard.<subdomain>.workers.dev');
const ingestKey = process.env.LYDIARD_INGEST_KEY ?? process.env.AGENT_API_KEY;
const dryRun = process.argv.includes('--dry-run');
const remoteD1 = process.argv.includes('--remote-d1');
const batchSize = positiveInteger(readArg('--batch-size') ?? process.env.GARMIN_LAP_BATCH_SIZE) ?? 50;
if (batchSize > 100) throw new Error('--batch-size cannot exceed 100.');
if (!ingestKey && !dryRun && !remoteD1) throw new Error('Set LYDIARD_INGEST_KEY or AGENT_API_KEY, use --remote-d1, or run with --dry-run.');

const rows = await sqliteJson<LapRow>(
  dbPath,
  `
  SELECT
    l.activity_id,
    l.lap_idx,
    MAX(CASE WHEN l.name = 'total_distance' THEN l.value END) AS distance_m,
    MAX(CASE WHEN l.name = 'total_timer_time' THEN l.value END) AS duration_sec,
    MAX(CASE WHEN l.name = 'total_elapsed_time' THEN l.value END) AS elapsed_sec,
    MAX(CASE WHEN l.name = 'avg_heart_rate' THEN l.value END) AS average_hr,
    MAX(CASE WHEN l.name = 'max_heart_rate' THEN l.value END) AS max_hr,
    COALESCE(
      MAX(CASE WHEN l.name = 'Lap Power' THEN l.value END),
      MAX(CASE WHEN l.name = 'avg_power' THEN l.value END)
    ) AS average_power,
    MAX(CASE WHEN l.name = 'max_power' THEN l.value END) AS max_power,
    COALESCE(
      MAX(CASE WHEN l.name = 'enhanced_avg_speed' THEN l.value END),
      MAX(CASE WHEN l.name = 'avg_speed' THEN l.value END)
    ) AS average_speed_mps
  FROM activity_lap_metric l
  JOIN activity a ON a.activity_id = l.activity_id
  WHERE a.distance > 0
    AND COALESCE(a.moving_duration, a.duration, a.elapsed_duration) > 0
    AND (LOWER(a.activity_type_key) LIKE '%running%' OR LOWER(COALESCE(a.activity_name, '')) LIKE '%running%')
  GROUP BY l.activity_id, l.lap_idx
  ORDER BY l.activity_id, l.lap_idx
  `,
  { maxBuffer: 256 * 1024 * 1024 },
);

const grouped = new Map<number, ActivityLap[]>();
for (const row of rows) {
  const distanceM = positiveNumber(row.distance_m);
  const durationSec = positiveNumber(row.duration_sec);
  if (!distanceM || !durationSec) continue;
  const lap: ActivityLap = {
    index: positiveInteger(row.lap_idx) ?? (grouped.get(row.activity_id)?.length ?? 0) + 1,
    distanceM,
    durationSec,
    elapsedSec: positiveNumber(row.elapsed_sec),
    averageHeartRate: heartRate(row.average_hr),
    maxHeartRate: heartRate(row.max_hr),
    averagePower: positiveNumber(row.average_power),
    maxPower: positiveNumber(row.max_power),
    averageSpeedMps: positiveNumber(row.average_speed_mps),
  };
  const laps = grouped.get(row.activity_id) ?? [];
  laps.push(lap);
  grouped.set(row.activity_id, laps);
}

const activities: LapActivity[] = [...grouped.entries()].map(([activityId, laps]) => ({
  activityId: `garmin-${activityId}`,
  laps,
}));
const lapCount = activities.reduce((total, activity) => total + activity.laps.length, 0);

if (dryRun) {
  console.log(JSON.stringify({ dryRun: true, dbPath, activities: activities.length, laps: lapCount, batches: Math.ceil(activities.length / batchSize) }, null, 2));
  process.exit(0);
}

if (remoteD1) {
  const updated = backfillRemoteD1(activities, batchSize);
  console.log(JSON.stringify({ ok: true, mode: 'remote-d1', activitiesUpdated: updated, laps: lapCount, batches: Math.ceil(activities.length / batchSize) }, null, 2));
  process.exit(0);
}

let updated = 0;
for (let offset = 0; offset < activities.length; offset += batchSize) {
  const batch = activities.slice(offset, offset + batchSize);
  const batchNumber = Math.floor(offset / batchSize) + 1;
  const response = await postBatch(batch, batchNumber);
  updated += response.activitiesUpdated;
  console.log(`uploaded lap batch ${batchNumber}/${Math.ceil(activities.length / batchSize)}: ${response.activitiesUpdated} activities`);
}

console.log(JSON.stringify({ ok: true, activitiesUpdated: updated, laps: lapCount, batches: Math.ceil(activities.length / batchSize) }, null, 2));

function backfillRemoteD1(items: LapActivity[], size: number): number {
  let updated = 0;
  for (let offset = 0; offset < items.length; offset += size) {
    const batch = items.slice(offset, offset + size);
    const fetchedAt = new Date().toISOString();
    const sql = batch.map((activity) => `
      INSERT INTO activity_streams (activity_id, laps, point_count, fetched_at)
      SELECT '${activity.activityId}', '${JSON.stringify(activity.laps)}', 0, '${fetchedAt}'
      WHERE EXISTS (SELECT 1 FROM activities WHERE id = '${activity.activityId}')
      ON CONFLICT(activity_id) DO UPDATE SET laps=excluded.laps, fetched_at=excluded.fetched_at;
    `).join('\n');
    const result = spawnSync(
      'node_modules/.bin/wrangler',
      ['d1', 'execute', 'lydiard', '--remote', '--command', sql],
      { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    if (result.status !== 0) {
      throw new Error(`Remote D1 lap batch ${Math.floor(offset / size) + 1} failed: ${result.error ? String(result.error) : result.stderr || result.stdout}`);
    }
    updated += batch.length;
    console.log(`uploaded D1 lap batch ${Math.floor(offset / size) + 1}/${Math.ceil(items.length / size)}: ${batch.length} candidate activities`);
  }
  return updated;
}

async function postBatch(batch: LapActivity[], batchNumber: number): Promise<{ activitiesUpdated: number }> {
  const body = JSON.stringify({ activities: batch });
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/ingest/laps`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ingestKey}`, 'Content-Type': 'application/json' },
        body,
      });
      const text = await response.text();
      if (response.ok) return JSON.parse(text) as { activitiesUpdated: number };
      if (response.status !== 429 && response.status < 500) throw new Error(`${response.status} ${text}`);
      if (attempt === 5) throw new Error(`${response.status} ${text}`);
    } catch (error) {
      if (attempt === 5) throw new Error(`Lap batch ${batchNumber} failed after ${attempt} attempts: ${String(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 2000 * 2 ** (attempt - 1))));
  }
  throw new Error(`Lap batch ${batchNumber} failed unexpectedly.`);
}

function readArg(name: string): string | undefined {
  const exact = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : undefined;
  return number !== undefined && Number.isFinite(number) ? number : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number > 0 ? number : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && Number.isInteger(number) && number > 0 ? number : undefined;
}

function heartRate(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number >= 40 && number <= 240 ? number : undefined;
}
