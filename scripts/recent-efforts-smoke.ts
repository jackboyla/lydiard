import assert from 'node:assert/strict';
import { calculateVDOT, inferGoldenZone, recentEffortRange } from '../src/analysis/bakken';
import type { BestEffortDistance } from '../src/types';

const now = new Date('2026-09-15T23:59:59Z');
assert.deepEqual(recentEffortRange(30, now), { from: '2026-08-17', to: '2026-09-15' });
assert.deepEqual(recentEffortRange(60, now), { from: '2026-07-18', to: '2026-09-15' });
assert.deepEqual(recentEffortRange(90, now), { from: '2026-06-18', to: '2026-09-15' });
assert.deepEqual(recentEffortRange(30, new Date('2024-03-01T00:00:00Z')), { from: '2024-02-01', to: '2024-03-01' });
const groups: BestEffortDistance[] = [{ label: '5K', distanceKm: 5, efforts: [{ rank: 1, activityId: 'run', activityName: 'Run', startDate: '2026-09-15', startDateLocal: '2026-09-15', seconds: 1200, paceSecPerKm: 240, source: 'stream' }] }];
const result = inferGoldenZone(groups)!;
// Independently evaluated Bakken example: 20-minute 5K gives VDOT 49.8062, threshold 4:16.001/km.
assert(Math.abs(result.vdot - 49.806233) < 0.0001);
assert(Math.abs(result.thresholdPaceSecPerKm - 256.000588) < 0.01);
assert.equal(result.intervals[0].fastPaceSecPerKm, result.thresholdPaceSecPerKm * 0.99);
assert.equal(result.intervals[3].slowPaceSecPerKm, result.thresholdPaceSecPerKm * 1.09);
assert.equal(inferGoldenZone([{ ...groups[0], efforts: [{ ...groups[0].efforts[0], source: 'whole_run' }] }]), null);
assert.equal(inferGoldenZone([{ ...groups[0], distanceKm: 1 }]), null);
assert.equal(inferGoldenZone([]), null);
assert.equal(calculateVDOT(5000, 0), null);
assert.equal(calculateVDOT(5000, Number.NaN), null);
const faster10K: BestEffortDistance = { label: '10K', distanceKm: 10, efforts: [{ ...groups[0].efforts[0], seconds: 2300 }] };
assert.equal(inferGoldenZone([...groups, faster10K])?.distanceLabel, '10K');
console.log('Recent effort date boundaries, race-equivalent selection and Bakken formulas passed.');

// Execute the route's real SQL against SQLite: whole-run estimates must not
// crowd measured efforts out of the ranking; rejected and future rows stay out.
const { execFileSync } = await import('node:child_process');
const { publicRoutes } = await import('../worker/routes/public');
const fixtureNow = new Date();
const boundary = recentEffortRange(30, fixtureNow).from;
const fixtureDate = recentEffortRange(30, fixtureNow).to;
const sqlite = `
import json, sqlite3, sys
payload=json.load(sys.stdin)
db=sqlite3.connect(':memory:')
db.row_factory=sqlite3.Row
db.executescript('''
CREATE TABLE activities(id TEXT PRIMARY KEY, name TEXT, start_date TEXT, start_date_local TEXT);
CREATE TABLE activity_best_efforts(distance_label TEXT, distance_km REAL, activity_id TEXT, seconds REAL, pace_sec_per_km REAL, source TEXT, segment_start_sec REAL, segment_end_sec REAL, PRIMARY KEY(activity_id, distance_label));
CREATE TABLE best_effort_rejections(distance_label TEXT, activity_id TEXT, PRIMARY KEY(distance_label, activity_id));
CREATE INDEX idx_activities_start ON activities(start_date);
CREATE INDEX idx_activity_best_efforts_distance_time ON activity_best_efforts(distance_label, seconds, activity_id);
''')
for id, date, seconds, source in payload['fixtures']:
 db.execute('INSERT INTO activities VALUES (?,?,?,?)',(id,id,date,date))
 db.execute('INSERT INTO activity_best_efforts VALUES (?,?,?,?,?,?,?,?)',('5K',5,id,seconds,seconds/5,source,0,seconds))
db.execute("INSERT INTO best_effort_rejections VALUES ('5K','rejected')")
print(json.dumps([dict(r) for r in db.execute(payload['query'],{str(i+1): v for i,v in enumerate(payload['binds'])})]))
`;
const fixtures = [
  ['boundary', `${boundary}T00:00:00Z`, 1200, 'stream'],
  ['old', new Date(new Date(`${boundary}T00:00:00Z`).getTime() - 1000).toISOString(), 1100, 'stream'],
  ['rejected', `${fixtureDate}T00:00:00Z`, 900, 'stream'],
  ['future', '2099-01-01T00:00:00Z', 800, 'stream'],
  ...Array.from({ length: 6 }, (_, i) => [`estimated-${i}`, `${fixtureDate}T00:00:00Z`, 950 + i, 'whole_run']),
];
const queries: { query: string; binds: string[] }[] = [];
const db = { prepare(query: string) { return { bind(...binds: string[]) { return {
  async all() { queries.push({ query, binds }); return { results: JSON.parse(execFileSync('python3', ['-c', sqlite], { input: JSON.stringify({ query, binds, fixtures }), encoding: 'utf8' })) }; },
}; } }; } };
const response = await publicRoutes().request('http://localhost/best-efforts/recent', {}, { lydiard: db } as never);
assert.equal(response.status, 200);
const payload = await response.json() as import('../src/analysis/bakken').RecentEffortsResponse;
assert.equal(payload.windows[0].distances.find((group) => group.label === '5K')?.efforts[0]?.activityId, 'boundary');
assert.equal(payload.windows[0].distances.find((group) => group.label === '5K')?.efforts.length, 1);
assert.equal(payload.windows[1].goldenZone?.effort.activityId, 'old');
assert.equal(payload.windows[2].goldenZone?.effort.activityId, 'old');
console.log('Rolling API SQL: inclusive boundary, exclusions, measured ranking and 60/90-day expansion passed.');

assert.equal(queries.length, 1, 'All recent windows must share one indexed read');
const allTimeResponse = await publicRoutes().request('http://localhost/best-efforts', {}, { lydiard: db } as never);
assert.equal(allTimeResponse.status, 200);
const allTime = await allTimeResponse.json() as { distances: BestEffortDistance[] };
assert.equal(allTime.distances.find((group) => group.label === '5K')?.efforts.length, 5);
assert.equal(allTime.distances.find((group) => group.label === '5K')?.efforts[0].activityId, 'future', 'Existing all-time behavior is preserved');
assert(!allTime.distances.flatMap((group) => group.efforts).some((effort) => effort.activityId === 'rejected'));
console.log('Single recent read and indexed all-time top-five queries passed.');
