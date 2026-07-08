// Generates local D1 seed SQL: an athlete, ~12 weeks of run activities with
// encoded route polylines, weekly_features derived by the REAL pipeline, and one
// streamed activity. Usage:
//   npx tsx scripts/seed-fixture.ts > scratch/seed.sql
//   npx wrangler d1 execute lydiard --local --file=scratch/seed.sql

import polyline from '@mapbox/polyline';
import { buildImportedTrainingFromActivities, type ImportedActivity } from '../src/data/deriveWeekly';
import type { ActivitySummary } from '../src/types';

const ANCHOR = new Date('2026-06-28T08:00:00Z').getTime();
const DAY = 86400000;

// A base loop near Dublin; jittered per activity so routes differ on the map.
const BASE_LOOP: Array<[number, number]> = [
  [53.3498, -6.2603],
  [53.3555, -6.2495],
  [53.3602, -6.2586],
  [53.3571, -6.2721],
  [53.3489, -6.2758],
  [53.3432, -6.2662],
  [53.3498, -6.2603],
];

function jitterRoute(seed: number, scale: number): Array<[number, number]> {
  return BASE_LOOP.map(([lat, lng], i) => [
    lat + Math.sin(seed * 1.3 + i) * 0.004 * scale,
    lng + Math.cos(seed * 0.9 + i) * 0.006 * scale,
  ]) as Array<[number, number]>;
}

interface Fixture {
  summary: ActivitySummary;
  imported: ImportedActivity;
}

function makeActivity(index: number, daysAgo: number): Fixture {
  const date = new Date(ANCHOR - daysAgo * DAY);
  const isLong = index % 7 === 0;
  const isQuality = index % 5 === 0 && !isLong;
  const distanceKm = isLong ? 18 + (index % 3) * 2 : isQuality ? 10 : 8 + (index % 4);
  const basePace = isQuality ? 250 : 320 + (index % 5) * 6; // sec/km
  // Gentle fatigue trend in the most recent ~3 weeks: pace and HR drift up.
  const fatigue = daysAgo < 21 ? (21 - daysAgo) * 0.6 : 0;
  const pace = basePace + fatigue;
  const movingTimeSec = Math.round(distanceKm * pace);
  const hr = Math.round((isQuality ? 168 : 146) + fatigue * 0.4 + (index % 3));
  const cadence = 176 + (index % 6);
  const elevation = 30 + (index % 5) * 18;
  const watts = Math.round((isQuality ? 265 : 205) + distanceKm * 1.5 + fatigue * 0.8);
  const route = jitterRoute(index, isLong ? 1.6 : 1);
  const encoded = polyline.encode(route);

  const summary: ActivitySummary = {
    id: `fix-${index}`,
    name: isLong ? 'Long run' : isQuality ? 'Threshold session' : 'Easy run',
    sportType: 'Run',
    startDate: date.toISOString(),
    startDateLocal: date.toISOString(),
    distanceKm,
    movingTimeSec,
    elapsedTimeSec: movingTimeSec + 60,
    averageHeartRate: hr,
    maxHeartRate: hr + 12,
    averageCadenceSpm: cadence,
    elevationGainM: elevation,
    relativeEffort: Math.round(distanceKm * (isQuality ? 9 : 5)),
    averageWatts: index % 4 === 1 ? undefined : watts,
    averageSpeed: 1000 / pace,
    startLat: route[0][0],
    startLng: route[0][1],
    endLat: route[route.length - 1][0],
    endLng: route[route.length - 1][1],
    summaryPolyline: encoded,
    hasStreams: false,
  };

  const imported: ImportedActivity = {
    id: summary.id,
    name: summary.name,
    type: summary.sportType,
    date,
    distanceKm,
    movingTimeSec,
    elapsedTimeSec: summary.elapsedTimeSec,
    averageHeartRate: hr,
    averageCadenceSpm: cadence,
    elevationGainM: elevation,
    relativeEffort: summary.relativeEffort,
  };

  return { summary, imported };
}

function q(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function num(value: number | undefined): string {
  return value === undefined || Number.isNaN(value) ? 'NULL' : String(value);
}

const fixtures: Fixture[] = [];
let index = 0;
// ~12 weeks, 4 runs per week.
for (let week = 11; week >= 0; week -= 1) {
  const dayOffsets = [0, 2, 4, 6];
  for (const offset of dayOffsets) {
    const daysAgo = week * 7 + offset;
    fixtures.push(makeActivity(index, daysAgo));
    index += 1;
  }
}

const now = new Date(ANCHOR).toISOString();
const lines: string[] = [];
lines.push('DELETE FROM activity_streams; DELETE FROM activities; DELETE FROM weekly_features; DELETE FROM athlete;');
lines.push(
  `INSERT INTO athlete (id, firstname, lastname, username, refresh_token, access_token, expires_at, scope, updated_at) ` +
    `VALUES (1, 'Jack', 'Boylan', 'jack', 'seed-refresh', 'seed-access', 9999999999, 'read,activity:read_all', ${q(now)});`,
);

for (const { summary } of fixtures) {
  lines.push(
    `INSERT INTO activities (id, name, sport_type, start_date, start_date_local, distance_km, moving_time_s, elapsed_time_s, ` +
      `average_heartrate, max_heartrate, average_cadence_spm, elevation_gain_m, relative_effort, average_watts, average_speed, ` +
      `start_lat, start_lng, end_lat, end_lng, summary_polyline, has_streams, decoupling_pct, created_at, updated_at) VALUES (` +
      `${q(summary.id)}, ${q(summary.name)}, ${q(summary.sportType)}, ${q(summary.startDate)}, ${q(summary.startDateLocal)}, ` +
      `${num(summary.distanceKm)}, ${num(summary.movingTimeSec)}, ${num(summary.elapsedTimeSec)}, ${num(summary.averageHeartRate)}, ` +
      `${num(summary.maxHeartRate)}, ${num(summary.averageCadenceSpm)}, ${num(summary.elevationGainM)}, ${num(summary.relativeEffort)}, ` +
      `${num(summary.averageWatts)}, ${num(summary.averageSpeed)}, ${num(summary.startLat)}, ${num(summary.startLng)}, ${num(summary.endLat)}, ${num(summary.endLng)}, ` +
      `${q(summary.summaryPolyline as string)}, 0, NULL, ${q(now)}, ${q(now)});`,
  );
}

// One streamed activity (most recent) so the detail card shows decoupling + streams.
const latest = fixtures[fixtures.length - 1].summary;
const latestRoute = polyline.decode(latest.summaryPolyline as string);
const streamLatLng = JSON.stringify(latestRoute);
const timeArr = latestRoute.map((_, i) => i * 30);
const hrArr = latestRoute.map((_, i) => 150 + i);
const distArr = latestRoute.map((_, i) => i * 200);
lines.push(
  `UPDATE activities SET has_streams = 1, decoupling_pct = 6.4 WHERE id = ${q(latest.id)};`,
);
lines.push(
  `INSERT INTO activity_streams (activity_id, latlng, time_s, heartrate, distance_m, point_count, fetched_at) VALUES (` +
    `${q(latest.id)}, ${q(streamLatLng)}, ${q(JSON.stringify(timeArr))}, ${q(JSON.stringify(hrArr))}, ${q(JSON.stringify(distArr))}, ${latestRoute.length}, ${q(now)});`,
);

// Derive weekly_features with the real pipeline.
const training = buildImportedTrainingFromActivities(
  fixtures.map((f) => f.imported),
  'strava',
  'Strava API',
);
for (const week of training.weeks) {
  lines.push(
    `INSERT INTO weekly_features (week_start, year, data, computed_at) VALUES (` +
      `${q(week.weekStart)}, ${week.year}, ${q(JSON.stringify(week))}, ${q(now)});`,
  );
}
lines.push(
  `UPDATE sync_state SET last_sync_at = ${q(now)}, last_activity_date = ${q(latest.startDate)}, last_error = NULL WHERE id = 1;`,
);

process.stdout.write(lines.join('\n') + '\n');
