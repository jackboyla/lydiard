import { stat } from 'node:fs/promises';
import { sqliteJson, sqliteScalar } from './lib/sqlite';

interface CountRow {
  table_name: string;
  rows: number;
}

interface ActivityTypeRow {
  type: string;
  activities: number;
  km: number | null;
  first_day: string | null;
  last_day: string | null;
}

interface RunCoverageRow {
  runs: number;
  with_paths: number;
  with_ts: number;
  with_summary_hr: number;
  with_stream_hr: number;
  with_stream_power: number;
  first_day: string | null;
  last_day: string | null;
  latest_run_km: number | null;
}

interface EmptyHealthRow {
  table_name: string;
  rows: number;
}

const dbPath = process.env.GARMIN_DB_PATH ?? 'garmin_data.db';
const strictHealth = process.argv.includes('--strict-health');

const integrity = await sqliteScalar(dbPath, 'PRAGMA integrity_check;');
if (integrity !== 'ok') {
  throw new Error(`Garmin DB integrity check failed: ${integrity}`);
}

const foreignKeys = await sqliteJson<Record<string, unknown>>(dbPath, 'PRAGMA foreign_key_check;');
if (foreignKeys.length > 0) {
  throw new Error(`Garmin DB has ${foreignKeys.length} foreign-key issue(s).`);
}

const dbStats = await stat(dbPath);
const tableCounts = await sqliteJson<CountRow>(
  dbPath,
  `
  SELECT m.name AS table_name, COALESCE(s.rows, 0) AS rows
  FROM sqlite_master m
  LEFT JOIN (
    SELECT 'activity' table_name, COUNT(*) rows FROM activity UNION ALL
    SELECT 'activity_path', COUNT(*) FROM activity_path UNION ALL
    SELECT 'activity_ts_metric', COUNT(*) FROM activity_ts_metric UNION ALL
    SELECT 'running_agg_metrics', COUNT(*) FROM running_agg_metrics UNION ALL
    SELECT 'heart_rate', COUNT(*) FROM heart_rate UNION ALL
    SELECT 'steps', COUNT(*) FROM steps UNION ALL
    SELECT 'intensity_minutes', COUNT(*) FROM intensity_minutes UNION ALL
    SELECT 'sleep', COUNT(*) FROM sleep UNION ALL
    SELECT 'hrv', COUNT(*) FROM hrv UNION ALL
    SELECT 'stress', COUNT(*) FROM stress UNION ALL
    SELECT 'body_battery', COUNT(*) FROM body_battery UNION ALL
    SELECT 'training_load', COUNT(*) FROM training_load UNION ALL
    SELECT 'training_readiness', COUNT(*) FROM training_readiness UNION ALL
    SELECT 'vo2_max', COUNT(*) FROM vo2_max
  ) s ON s.table_name = m.name
  WHERE m.type = 'table'
  ORDER BY rows DESC, table_name ASC
  `,
);

const activityTypes = await sqliteJson<ActivityTypeRow>(
  dbPath,
  `
  SELECT
    activity_type_key AS type,
    COUNT(*) AS activities,
    ROUND(SUM(distance) / 1000.0, 1) AS km,
    MIN(date(start_ts, printf('%+f hours', timezone_offset_hours))) AS first_day,
    MAX(date(start_ts, printf('%+f hours', timezone_offset_hours))) AS last_day
  FROM activity
  GROUP BY activity_type_key
  ORDER BY activities DESC, type ASC
  `,
);

const [runCoverage] = await sqliteJson<RunCoverageRow>(
  dbPath,
  `
  WITH run_ids AS (
    SELECT activity_id, start_ts, timezone_offset_hours, distance, average_hr, ts_data_available
    FROM activity
    WHERE activity_type_key LIKE '%running%'
      AND distance > 0
      AND moving_duration > 0
  ),
  metric_flags AS (
    SELECT
      activity_id,
      MAX(CASE WHEN name = 'heart_rate' THEN 1 ELSE 0 END) AS has_stream_hr,
      MAX(CASE WHEN lower(name) = 'power' AND value > 0 THEN 1 ELSE 0 END) AS has_stream_power
    FROM activity_ts_metric
    GROUP BY activity_id
  )
  SELECT
    COUNT(*) AS runs,
    SUM(CASE WHEN p.activity_id IS NOT NULL THEN 1 ELSE 0 END) AS with_paths,
    SUM(CASE WHEN r.ts_data_available = 1 THEN 1 ELSE 0 END) AS with_ts,
    SUM(CASE WHEN r.average_hr BETWEEN 80 AND 220 THEN 1 ELSE 0 END) AS with_summary_hr,
    SUM(COALESCE(m.has_stream_hr, 0)) AS with_stream_hr,
    SUM(COALESCE(m.has_stream_power, 0)) AS with_stream_power,
    MIN(date(r.start_ts, printf('%+f hours', r.timezone_offset_hours))) AS first_day,
    MAX(date(r.start_ts, printf('%+f hours', r.timezone_offset_hours))) AS last_day,
    (
      SELECT ROUND(distance / 1000.0, 2)
      FROM run_ids
      ORDER BY start_ts DESC
      LIMIT 1
    ) AS latest_run_km
  FROM run_ids r
  LEFT JOIN activity_path p ON p.activity_id = r.activity_id
  LEFT JOIN metric_flags m ON m.activity_id = r.activity_id
  `,
);

const emptyHealth = await sqliteJson<EmptyHealthRow>(
  dbPath,
  `
  SELECT * FROM (
    SELECT 'sleep' table_name, COUNT(*) rows FROM sleep UNION ALL
    SELECT 'hrv', COUNT(*) FROM hrv UNION ALL
    SELECT 'stress', COUNT(*) FROM stress UNION ALL
    SELECT 'body_battery', COUNT(*) FROM body_battery UNION ALL
    SELECT 'training_readiness', COUNT(*) FROM training_readiness UNION ALL
    SELECT 'vo2_max', COUNT(*) FROM vo2_max
  )
  WHERE rows = 0
  ORDER BY table_name
  `,
);

const warnings: string[] = [];
if (!runCoverage || runCoverage.runs === 0) {
  throw new Error('No running activities found in Garmin DB.');
}
if (runCoverage.with_paths < runCoverage.runs) {
  warnings.push(`${runCoverage.runs - runCoverage.with_paths} run(s) do not have GPS paths.`);
}
if (runCoverage.with_ts < runCoverage.runs) {
  warnings.push(`${runCoverage.runs - runCoverage.with_ts} run(s) do not have FIT time-series data.`);
}
if (runCoverage.with_stream_hr < runCoverage.runs) {
  warnings.push(`${runCoverage.runs - runCoverage.with_stream_hr} run(s) do not have heart-rate stream data.`);
}
if (runCoverage.with_stream_power === 0) {
  warnings.push('No positive running power samples found.');
}
if (emptyHealth.length > 0) {
  warnings.push(`Empty health/recovery tables: ${emptyHealth.map((row) => row.table_name).join(', ')}.`);
}

if (strictHealth && emptyHealth.length > 0) {
  throw new Error(`Strict health audit failed: ${emptyHealth.map((row) => row.table_name).join(', ')} are empty.`);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      dbPath,
      dbSizeMb: Number((dbStats.size / 1024 / 1024).toFixed(1)),
      integrity,
      foreignKeyIssues: foreignKeys.length,
      activityTypes,
      runCoverage,
      emptyHealthTables: emptyHealth.map((row) => row.table_name),
      warnings,
      tableCounts: tableCounts.filter((row) => row.rows > 0),
    },
    null,
    2,
  ),
);
