/** Local SQLite cost regression. Never connects to D1. Requires python3. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { publicRoutes } from '../worker/routes/public';
import { recentEffortRange } from '../src/analysis/bakken';
import { BEST_EFFORT_TARGETS } from '../src/analysis/bestEfforts';

const queries: { query: string; binds: string[] }[] = [];
const db = { prepare(query: string) { return { bind(...binds: string[]) { return {
  async all() { queries.push({ query, binds }); return { results: [] }; },
}; } }; } };
await publicRoutes().request('http://localhost/best-efforts/recent', {}, { lydiard: db } as never);
const recent = queries.splice(0);
await publicRoutes().request('http://localhost/best-efforts', {}, { lydiard: db } as never);
const alltime = queries.splice(0);
assert.equal(recent.length, 1);
const columns = recent[0].query.split('FROM activities')[0].replace(/^SELECT /, '');
const oldQuery = (where: string) => `SELECT * FROM (
  SELECT ${columns}, ROW_NUMBER() OVER (
    PARTITION BY e.distance_label ORDER BY e.seconds ASC, a.start_date DESC, e.activity_id ASC
  ) AS effort_rank
  FROM activity_best_efforts e JOIN activities a ON a.id = e.activity_id
  WHERE NOT EXISTS (SELECT 1 FROM best_effort_rejections r
    WHERE r.distance_label = e.distance_label AND r.activity_id = e.activity_id) ${where}
) ranked WHERE effort_rank <= 5 ORDER BY distance_label, effort_rank`;
const now = new Date();
const oldRecent = [30, 60, 90].map((days) => ({
  query: oldQuery("AND e.source = 'stream' AND julianday(a.start_date) <= julianday(?1) AND substr(a.start_date, 1, 10) >= ?2 AND substr(a.start_date, 1, 10) <= ?3"),
  binds: [now.toISOString(), recentEffortRange(days, now).from, recentEffortRange(days, now).to],
}));
const python = `
import datetime,json,sqlite3,sys,time
p=json.load(sys.stdin)
db=sqlite3.connect(':memory:')
db.row_factory=sqlite3.Row
db.executescript('''
CREATE TABLE activities(id TEXT PRIMARY KEY,name TEXT,start_date TEXT,start_date_local TEXT);
CREATE INDEX idx_activities_start ON activities(start_date);
CREATE TABLE activity_best_efforts(activity_id TEXT,distance_label TEXT,distance_km REAL,seconds REAL,pace_sec_per_km REAL,source TEXT,segment_start_sec REAL,segment_end_sec REAL,PRIMARY KEY(activity_id,distance_label));
CREATE INDEX idx_activity_best_efforts_distance_time ON activity_best_efforts(distance_label,seconds,activity_id);
CREATE TABLE best_effort_rejections(distance_label TEXT,activity_id TEXT,PRIMARY KEY(distance_label,activity_id));
''')
today=datetime.date.fromisoformat(p['today'])
for i in range(10000):
 id=str(i)
 date=(today-datetime.timedelta(days=(9999-i)//2)).isoformat()+'T00:00:00Z'
 db.execute('INSERT INTO activities VALUES (?,?,?,?)',(id,id,date,date))
 for j,target in enumerate(p['targets']):
  seconds=target['distanceKm']*(210+(i*31%190))
  db.execute('INSERT INTO activity_best_efforts VALUES (?,?,?,?,?,?,?,?)',(id,target['label'],target['distanceKm'],seconds,seconds/target['distanceKm'],'stream',0,seconds))
db.execute("INSERT INTO best_effort_rejections VALUES ('5K','9950')")
db.execute('ANALYZE')
def measure(queries):
 steps=0
 def progress():
  nonlocal steps
  steps+=100
  return 0
 plans=[]
 rows=0
 values=[]
 begin=time.perf_counter()
 for item in queries:
  binds={str(i+1):v for i,v in enumerate(item['binds'])}
  plans.append([r[3] for r in db.execute('EXPLAIN QUERY PLAN '+item['query'],binds)])
  db.set_progress_handler(progress,100)
  batch=[dict(r) for r in db.execute(item['query'],binds)]
  values.extend(batch)
  rows+=len(batch)
  db.set_progress_handler(None,0)
 return dict(vmStepsApprox=steps,resultRows=rows,elapsedMs=round((time.perf_counter()-begin)*1000,2),plans=plans,values=values)
result={key:measure(p[key]) for key in ['oldRecent','recent','oldAlltime','alltime']}
def canonical(rows):
 return sorted(json.dumps({k:v for k,v in row.items() if k!='effort_rank'},sort_keys=True) for row in rows)
assert canonical(result['oldAlltime']['values'])==canonical(result['alltime']['values']), 'All-time winners changed'
recent_rows=result['recent']['values']
recent_winners=[]
for lookback in [30,60,90]:
 start=(today-datetime.timedelta(days=lookback-1)).isoformat()+'T00:00:00'
 for target in p['targets']:
  candidates=[row for row in recent_rows if row['start_date']>=start and row['distance_label']==target['label']]
  candidates.sort(key=lambda r:r['activity_id'])
  candidates.sort(key=lambda r:r['start_date'],reverse=True)
  candidates.sort(key=lambda r:r['seconds'])
  recent_winners.extend(candidates[:5])
assert canonical(result['oldRecent']['values'])==canonical(recent_winners), 'Recent winners changed'
for value in result.values(): del value['values']
result['equivalence']='All-time and each rolling window return identical winners'
result['fixture']={'activities':10000,'efforts':110000,'recent90dActivities':180}
print(json.dumps(result,indent=2))
`;
const result = JSON.parse(execFileSync('python3', ['-c', python], {
  input: JSON.stringify({ today: now.toISOString().slice(0, 10), targets: BEST_EFFORT_TARGETS, oldRecent, recent, oldAlltime: [{ query: oldQuery(''), binds: [] }], alltime }), encoding: 'utf8',
})) as Record<string, { vmStepsApprox: number }>;
assert(result.recent.vmStepsApprox < result.oldRecent.vmStepsApprox / 10, 'Recent effort reads must scale with recent activities');
assert(result.alltime.vmStepsApprox < result.oldAlltime.vmStepsApprox / 100, 'All-time top-five must stop at indexed winners');
console.log(JSON.stringify(result, null, 2));
