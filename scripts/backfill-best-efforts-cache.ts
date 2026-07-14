import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { bestEffortsForActivity } from '../src/analysis/bestEfforts';

interface BackfillRow {
  id: string;
  name: string;
  start_date: string;
  start_date_local: string;
  distance_km: number;
  moving_time_s: number;
  time_s: string | null;
  distance_m: string | null;
}

const input = process.argv[2];
const output = process.argv[3];
if (!input || !output) {
  throw new Error('Usage: tsx scripts/backfill-best-efforts-cache.ts <D1 export.sql> <output.sql>');
}

const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync(input, 'utf8'));
const rows = db.prepare(
  `SELECT a.id, a.name, a.start_date, a.start_date_local, a.distance_km, a.moving_time_s,
          s.time_s, s.distance_m
     FROM activities a
     LEFT JOIN activity_streams s ON s.activity_id = a.id
    ORDER BY a.id`,
).all() as unknown as BackfillRow[];

const values: string[] = [];
const computedAt = new Date().toISOString();
for (const row of rows) {
  const groups = bestEffortsForActivity({
    id: row.id,
    name: row.name,
    startDate: row.start_date,
    startDateLocal: row.start_date_local,
    distanceKm: row.distance_km,
    movingTimeSec: row.moving_time_s,
    timeSec: parseArray(row.time_s),
    distanceM: parseArray(row.distance_m),
  });
  for (const group of groups) {
    const effort = group.efforts[0];
    values.push(`(${[
      sql(row.id),
      sql(group.label),
      group.distanceKm,
      effort.seconds,
      effort.paceSecPerKm,
      sql(effort.source),
      effort.segmentStartSec ?? 'NULL',
      effort.segmentEndSec ?? 'NULL',
      sql(computedAt),
    ].join(',')})`);
  }
}

const statements = ['DELETE FROM activity_best_efforts;'];
for (let index = 0; index < values.length; index += 100) {
  statements.push(
    `INSERT INTO activity_best_efforts (
       activity_id, distance_label, distance_km, seconds, pace_sec_per_km,
       source, segment_start_sec, segment_end_sec, computed_at
     ) VALUES\n${values.slice(index, index + 100).join(',\n')};`,
  );
}
fs.writeFileSync(output, `${statements.join('\n')}\n`);
console.log(JSON.stringify({ activities: rows.length, efforts: values.length, output }, null, 2));

function parseArray(value: string | null): number[] | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed)
    ? parsed.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
    : undefined;
}

function sql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
