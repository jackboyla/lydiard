// Generates local D1 seed SQL: an athlete, ~12 weeks of run activities with
// encoded route polylines, weekly_features derived by the REAL pipeline, and one
// streamed activity. Usage:
//   npx tsx scripts/seed-fixture.ts > scratch/seed.sql
//   npx wrangler d1 execute lydiard --local --file=scratch/seed.sql

import polyline from '@mapbox/polyline';
import { bestEffortsForActivity } from '../src/analysis/bestEfforts';
import { buildImportedTrainingFromActivities, type ImportedActivity } from '../src/data/deriveWeekly';
import type { ActivityLap, ActivitySummary } from '../src/types';
import { normalizeStreams } from '../worker/streams';

// Fixed by default so smoke runs stay reproducible. Set LYDIARD_FIXTURE_ANCHOR
// (an ISO date, or `today`) when the fixture should look like current training —
// the README screenshots do that so no week reads as empty.
const ANCHOR = resolveAnchor();

function resolveAnchor(): number {
  const requested = process.env.LYDIARD_FIXTURE_ANCHOR;
  if (!requested) return new Date('2026-06-28T08:00:00Z').getTime();
  if (requested === 'today') {
    const today = new Date();
    return Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 8, 0, 0);
  }
  const parsed = new Date(requested).getTime();
  if (Number.isNaN(parsed)) throw new Error(`LYDIARD_FIXTURE_ANCHOR is not a date: ${requested}`);
  return parsed;
}
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
const pulseDay = new Date(ANCHOR - DAY).toISOString().slice(0, 10);
const lines: string[] = [];
lines.push(
  'DELETE FROM activity_streams; DELETE FROM activity_feedback; DELETE FROM daily_checkins; DELETE FROM daily_recovery; DELETE FROM activities; DELETE FROM weekly_features; DELETE FROM athlete;',
);
lines.push(
  `INSERT INTO athlete (id, firstname, lastname, username, refresh_token, access_token, expires_at, scope, updated_at) ` +
    `VALUES (1, 'Test', 'Runner', 'testrunner', 'seed-refresh', 'seed-access', 9999999999, 'read,activity:read_all', ${q(now)});`,
);
lines.push(
  `INSERT INTO daily_checkins (day, energy, leg_freshness, motivation, pain_level, sleep_quality, note, source, created_at, updated_at) VALUES (` +
    `${q(pulseDay)}, 4, 4, 3, 0, 5, ${q('Legs settled after an easy morning.')}, 'platform', ${q(now)}, ${q(now)});`,
);

// ~100 nights of Fitbit sleep and HRV up to the anchor day, with an occasional
// missed night so the charts show their gaps.
for (let daysAgo = 99; daysAgo >= 0; daysAgo -= 1) {
  if (daysAgo % 23 === 11) continue;
  const day = new Date(ANCHOR - daysAgo * DAY).toISOString().slice(0, 10);
  const sleepMin = Math.round(425 + 38 * Math.sin(daysAgo / 2.3) + (daysAgo % 5) * 7);
  const hrvMs = Math.round((54 + 7 * Math.sin(daysAgo / 3.1) - (daysAgo % 4) * 1.5) * 10) / 10;
  lines.push(
    `INSERT INTO daily_recovery (day, source, sleep_duration_min, hrv_rmssd_ms, created_at, updated_at) VALUES (` +
      `${q(day)}, 'fitbit', ${sleepMin}, ${hrvMs}, ${q(now)}, ${q(now)});`,
  );
}

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

const byNewest = [...fixtures].sort((a, b) => b.summary.startDate.localeCompare(a.summary.startDate));

// One streamed activity (most recent) so the detail card shows decoupling + streams.
const latest = byNewest[0].summary;
const latestRoute = polyline.decode(latest.summaryPolyline as string);
const sampleCount = Math.ceil(latest.movingTimeSec / 3);
const time = Array.from({ length: sampleCount + 1 }, (_, i) => Math.round(i * latest.movingTimeSec / sampleCount));
const streams = normalizeStreams({
  latlng: latestRoute,
  time,
  distance: time.map((seconds) => seconds / latest.movingTimeSec * latest.distanceKm * 1000),
  heartrate: time.map((seconds) => Math.round(150 + 15 * seconds / latest.movingTimeSec)),
  power: time.map((_, i) => (latest.averageWatts ?? 220) + Math.round(8 * Math.sin(i / 10))),
  cadence: time.map(() => latest.averageCadenceSpm ?? 180),
  velocity_smooth: time.map(() => latest.distanceKm * 1000 / latest.movingTimeSec),
  altitude: time.map((_, i) => 30 + 5 * Math.sin(i / 20)),
});
const laps: ActivityLap[] = Array.from({ length: Math.ceil(latest.distanceKm / 2) }, (_, i) => {
  const distanceM = Math.min(2, latest.distanceKm - i * 2) * 1000;
  return {
    index: i + 1,
    distanceM,
    durationSec: distanceM / (latest.distanceKm * 1000) * latest.movingTimeSec,
    averageHeartRate: Math.round(150 + 15 * (i * 2 + distanceM / 2000) / latest.distanceKm),
    averagePower: latest.averageWatts ?? 220,
    averageSpeedMps: latest.distanceKm * 1000 / latest.movingTimeSec,
  };
});
lines.push(
  `UPDATE activities SET has_streams = 1, decoupling_pct = 6.4 WHERE id = ${q(latest.id)};`,
);
lines.push(
  `INSERT INTO activity_streams (activity_id, latlng, time_s, heartrate, cadence, power, velocity, altitude, distance_m, laps, point_count, fetched_at) VALUES (` +
    `${q(latest.id)}, ${q(JSON.stringify(streams.latlng))}, ${q(JSON.stringify(streams.timeSec))}, ${q(JSON.stringify(streams.heartrate))}, ` +
    `${q(JSON.stringify(streams.cadence))}, ${q(JSON.stringify(streams.power))}, ${q(JSON.stringify(streams.velocity))}, ${q(JSON.stringify(streams.altitude))}, ` +
    `${q(JSON.stringify(streams.distanceM))}, ${q(JSON.stringify(laps))}, ${streams.latlng?.length ?? time.length}, ${q(now)});`,
);
for (const group of bestEffortsForActivity({ ...latest, timeSec: streams.timeSec, distanceM: streams.distanceM })) {
  const effort = group.efforts[0];
  lines.push(
    `INSERT INTO activity_best_efforts (activity_id, distance_label, distance_km, seconds, pace_sec_per_km, source, segment_start_sec, segment_end_sec, computed_at) VALUES (` +
      `${q(latest.id)}, ${q(group.label)}, ${group.distanceKm}, ${effort.seconds}, ${effort.paceSecPerKm}, ${q(effort.source)}, ` +
      `${num(effort.segmentStartSec)}, ${num(effort.segmentEndSec)}, ${q(now)});`,
  );
}

// A few notes on recent runs, so the log shows the note surface in use.
const FIXTURE_NOTES = [
  'Legs came round after 3km. Held the effort honest on the second half.',
  'Windy out and back. Kept it conversational the whole way.',
  'Best session of the block—reps felt controlled rather than forced.',
];
FIXTURE_NOTES.forEach((note, offset) => {
  const target = byNewest[offset].summary;
  lines.push(
    `INSERT INTO activity_feedback (activity_id, note, created_at, updated_at) VALUES (` +
      `${q(target.id)}, ${q(note)}, ${q(now)}, ${q(now)});`,
  );
});

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
