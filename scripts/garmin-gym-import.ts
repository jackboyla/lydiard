// Imports Garmin gym / strength sessions into Lydiard's separate gym_sessions
// store via POST /api/ingest/gym. These never enter the running load model.
//
//   npm run garmin:import-gym -- [--no-replace] [--dry-run] [--allow-empty]
//
// Env: LYDIARD_INGEST_KEY (or AGENT_API_KEY), LYDIARD_BASE_URL, GARMIN_DB_PATH,
//      GARMIN_GYM_ACTIVITY_TYPES (default "strength_training,fitness_equipment").
import type { GymSession } from '../src/types';
import { sqliteJson } from './lib/sqlite';

interface GymRow {
  activity_id: number;
  activity_name: string | null;
  activity_type_key: string;
  start_ts: string;
  timezone_offset_hours: number;
  duration: number | null;
  elapsed_duration: number | null;
  moving_duration: number | null;
  average_hr: number | null;
  calories: number | null;
}

const dbPath = process.env.GARMIN_DB_PATH ?? 'garmin_data.db';
const baseUrl = (process.env.LYDIARD_BASE_URL ?? 'https://lydiard.lydiard.workers.dev').replace(/\/$/, '');
const ingestKey = process.env.LYDIARD_INGEST_KEY ?? process.env.AGENT_API_KEY;
const dryRun = process.argv.includes('--dry-run');
const allowEmpty = process.argv.includes('--allow-empty');
const replace = !process.argv.includes('--no-replace');
const types = (process.env.GARMIN_GYM_ACTIVITY_TYPES ?? 'strength_training,fitness_equipment')
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);

if (!ingestKey && !dryRun) {
  throw new Error('Set LYDIARD_INGEST_KEY or AGENT_API_KEY, or run with --dry-run.');
}

const typeList = types.map((type) => `'${type.replace(/'/g, "''")}'`).join(',');
const rows = await sqliteJson<GymRow>(
  dbPath,
  `SELECT activity_id, activity_name, activity_type_key, start_ts, timezone_offset_hours,
     duration, elapsed_duration, moving_duration, average_hr, calories
   FROM activity
   WHERE lower(activity_type_key) IN (${typeList})
   ORDER BY start_ts ASC`,
  { maxBuffer: 64 * 1024 * 1024 },
);

const sessions: GymSession[] = rows.map((row) => ({
  id: `garmin-${row.activity_id}`,
  name: row.activity_name || 'Gym',
  sportType: row.activity_type_key,
  startDate: new Date(`${row.start_ts.replace(' ', 'T')}Z`).toISOString(),
  startDateLocal: new Date(new Date(`${row.start_ts.replace(' ', 'T')}Z`).getTime() + row.timezone_offset_hours * 3600000)
    .toISOString()
    .replace(/\.\d{3}Z$/, ''),
  durationSec: Math.round(pos(row.duration) ?? pos(row.elapsed_duration) ?? pos(row.moving_duration) ?? 0),
  averageHeartRate: hr(row.average_hr),
  calories: pos(row.calories),
}));

if (sessions.length === 0) {
  if (allowEmpty) {
    console.log(JSON.stringify({ ok: true, skipped: true, dbPath, replace, types, matched: 0 }, null, 2));
    process.exit(0);
  }
  throw new Error(`No Garmin gym activities matched types: ${types.join(', ')}`);
}

const withDuration = sessions.filter((session) => session.durationSec > 0).length;
const withHr = sessions.filter((session) => session.averageHeartRate).length;
const summary = {
  matched: sessions.length,
  withDuration,
  withHr,
  first: sessions[0].startDateLocal,
  last: sessions[sessions.length - 1].startDateLocal,
};

if (dryRun) {
  console.log(JSON.stringify({ dryRun: true, dbPath, replace, types, ...summary }, null, 2));
} else {
  const response = await postGym(sessions);
  console.log(JSON.stringify({ ok: true, replace, types, ...summary, ...response }, null, 2));
}

async function postGym(items: GymSession[]): Promise<Record<string, unknown>> {
  const body = JSON.stringify({ source: 'garmin-health-data', replace, sessions: items });
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/ingest/gym`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ingestKey}`, 'Content-Type': 'application/json' },
        body,
      });
      const text = await response.text();
      if (response.ok) {
        return JSON.parse(text) as Record<string, unknown>;
      }
      if ((response.status === 401 || response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
        console.warn(`gym ingest attempt ${attempt} failed: ${response.status} ${text}`);
        await sleep(2000 * 2 ** (attempt - 1));
        continue;
      }
      throw new Error(`gym ingest failed: ${response.status} ${text}`);
    } catch (error) {
      if (attempt === maxAttempts) {
        throw new Error(`gym ingest failed after ${attempt} attempts: ${String(error)}`);
      }
      await sleep(2000 * 2 ** (attempt - 1));
    }
  }
  throw new Error('gym ingest failed unexpectedly.');
}

function pos(value: number | null): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
function hr(value: number | null): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 60 && value <= 220 ? value : undefined;
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
