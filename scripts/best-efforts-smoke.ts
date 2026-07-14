import assert from 'node:assert/strict';
import { BEST_EFFORT_TARGETS, streamBestEffortsForActivity } from '../src/analysis/bestEfforts';

const timeSec = [0];
const distanceM = [0];

// A 16K run sampled every 100m: 3K at 6:00/km, 10K at 4:00/km,
// then another 3K at 6:00/km. The middle block must be its fastest 10K.
for (let index = 1; index <= 160; index += 1) {
  const midpointKm = (index - 0.5) / 10;
  const paceSecPerKm = midpointKm >= 3 && midpointKm < 13 ? 240 : 360;
  timeSec.push(timeSec[timeSec.length - 1] + paceSecPerKm / 10);
  distanceM.push(index * 100);
}

const activity = {
  id: 'run-16k',
  name: '16K progression',
  startDate: '2026-07-13T00:00:00Z',
  startDateLocal: '2026-07-13T00:00:00Z',
  distanceKm: 16,
  movingTimeSec: timeSec[timeSec.length - 1],
  timeSec,
  distanceM,
};

assert.deepEqual(
  BEST_EFFORT_TARGETS.map((target) => target.label),
  ['200m', '400m', '800m', '1K', 'Mile', '3K', '5K', '10K', '15K', 'Half', 'Marathon'],
);

const groups = streamBestEffortsForActivity(activity);
for (const label of ['200m', '400m', '800m']) {
  assert(groups.some((group) => group.label === label), `${label} run effort is missing`);
}

const fastest10K = groups.find((group) => group.label === '10K')?.efforts[0];
assert(fastest10K, '10K effort is missing from a 16K run');
assert.equal(fastest10K.seconds, 2400);
assert.equal(fastest10K.paceSecPerKm, 240);
assert.equal(fastest10K.segmentStartSec, 1080);
assert.equal(fastest10K.segmentEndSec, 3480);

assert.deepEqual(
  streamBestEffortsForActivity({ ...activity, timeSec: undefined, distanceM: undefined }),
  [],
  'Per-run efforts without a continuous stream must not be projected from average pace',
);

console.log(JSON.stringify({
  targets: BEST_EFFORT_TARGETS.length,
  runEfforts: groups.length,
  fastest10K,
}, null, 2));
