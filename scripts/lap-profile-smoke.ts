// Smoke test for the calendar mini lap-profile pipeline:
//   compactLapProfile (worker feed)  ->  buildLapProfileFromCompact (client zones)
// Run: npm run lap-profile:smoke

import assert from 'node:assert/strict';
import { compactLapProfile } from '../worker/db';
import {
  buildActivityLaps,
  buildKilometreSplitsWithinLap,
  buildLapProfileFromCompact,
  intensitySecondsFromLapProfile,
} from '../src/data/activityLaps';
import type { ActivityDetail, ActivityLap } from '../src/types';

// --- compactLapProfile: steady 1 km auto-lap run (flat profile) ---
const steadyLaps: ActivityLap[] = Array.from({ length: 6 }, (_, i) => ({
  index: i + 1,
  distanceM: 1000,
  durationSec: 300, // 5:00 /km
  averageSpeedMps: 1000 / 300,
}));
const steady = compactLapProfile(JSON.stringify(steadyLaps));
assert.ok(steady, 'steady run should yield a profile');
assert.equal(steady.length, 6);
assert.ok(steady.every((p) => p.paceSecPerKm === 300), 'steady paces all 5:00 /km');
assert.ok(steady.every((p) => p.distanceKm === 1), 'steady lap distances 1.0 km');

// --- compactLapProfile: interval workout (jagged profile) ---
const workoutLaps: ActivityLap[] = [
  { index: 1, distanceM: 2000, durationSec: 660, averageSpeedMps: 2000 / 660 }, // ~5:30 warmup
  { index: 2, distanceM: 400, durationSec: 84, averageSpeedMps: 400 / 84 },     // 3:30 rep
  { index: 3, distanceM: 200, durationSec: 66, averageSpeedMps: 200 / 66 },     // ~5:30 recovery
  { index: 4, distanceM: 400, durationSec: 84, averageSpeedMps: 400 / 84 },     // 3:30 rep
  { index: 5, distanceM: 200, durationSec: 66, averageSpeedMps: 200 / 66 },     // recovery
  { index: 6, distanceM: 1500, durationSec: 495, averageSpeedMps: 1500 / 495 }, // ~5:30 cooldown
];
const workout = compactLapProfile(JSON.stringify(workoutLaps));
assert.ok(workout, 'workout should yield a profile');
assert.equal(workout.length, 6);
const paces = workout.map((p) => p.paceSecPerKm);
assert.ok(Math.max(...paces) - Math.min(...paces) > 90, 'workout should have a clear pace spread');

// --- guards: nothing to draw ---
assert.equal(compactLapProfile(null), undefined, 'null laps -> undefined');
assert.equal(compactLapProfile('[]'), undefined, 'empty laps -> undefined');
assert.equal(compactLapProfile('not json'), undefined, 'malformed json -> undefined');
assert.equal(compactLapProfile(JSON.stringify([steadyLaps[0]])), undefined, 'single lap -> undefined');
// A file where only one lap survives validation is not worth drawing.
const mostlyInvalid: ActivityLap[] = [
  { index: 1, distanceM: 0, durationSec: 300 },
  { index: 2, distanceM: 1000, durationSec: 0 },
  { index: 3, distanceM: 1000, durationSec: 300 },
];
assert.equal(compactLapProfile(JSON.stringify(mostlyInvalid)), undefined, 'only one valid lap -> undefined');

// --- buildLapProfileFromCompact: zones derived from the runner's threshold ---
const thresholdPaceSecPerKm = 240; // 4:00 /km
const views = buildLapProfileFromCompact(workout, thresholdPaceSecPerKm, 330);
assert.equal(views.length, workout.length, 'one view per compact lap');
assert.ok(
  ['threshold', 'high-intensity'].includes(views[1].zone.key),
  `3:30 rep should be a hard zone, got ${views[1].zone.key}`,
);
assert.ok(
  ['recovery', 'easy', 'steady'].includes(views[0].zone.key),
  `5:30 warmup should be an aerobic zone, got ${views[0].zone.key}`,
);
assert.equal(
  intensitySecondsFromLapProfile(workout, thresholdPaceSecPerKm, 330),
  168,
  'only the two 84-second threshold-or-faster reps should count as intensity time',
);
assert.equal(intensitySecondsFromLapProfile(undefined, thresholdPaceSecPerKm), 0);

// --- selected recorded lap: derive split-relative kilometres, not run-wide kilometres ---
const detail: ActivityDetail = {
  id: 'lap-drill-down',
  name: 'Lap drill-down fixture',
  sportType: 'Run',
  startDate: '2026-08-18T08:00:00Z',
  startDateLocal: '2026-08-18T08:00:00Z',
  distanceKm: 3,
  movingTimeSec: 900,
  elapsedTimeSec: 900,
  elevationGainM: 6,
  hasStreams: true,
  streams: {
    distanceM: [0, 500, 1000, 1500, 2000, 2500, 3000],
    timeSec: [0, 150, 300, 450, 600, 750, 900],
    heartrate: [130, 132, 134, 136, 138, 140, 142],
    altitude: [10, 11, 12, 13, 14, 15, 16],
    laps: [
      { index: 1, distanceM: 500, durationSec: 150 },
      { index: 2, distanceM: 2500, durationSec: 750 },
    ],
  },
};
const recordedViews = buildActivityLaps(detail, thresholdPaceSecPerKm);
const innerKilometres = buildKilometreSplitsWithinLap(detail, recordedViews[1], thresholdPaceSecPerKm);
assert.deepEqual(innerKilometres.map((split) => split.distanceKm), [1, 1, 0.5]);
assert.deepEqual(innerKilometres.map((split) => split.durationSec), [300, 300, 150]);
assert.deepEqual(innerKilometres.map((split) => split.startDistanceM), [500, 1500, 2500]);
assert.deepEqual(innerKilometres.map((split) => split.endDistanceM), [1500, 2500, 3000]);

console.log('lap-profile smoke: OK');
console.log('  steady paces :', steady.map((p) => p.paceSecPerKm).join(', '));
console.log('  workout      :', workout.map((p) => `${p.paceSecPerKm}s/${p.distanceKm}km`).join('  '));
console.log('  workout zones:', views.map((v) => v.zone.key).join(', '));
