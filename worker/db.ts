import type { D1Database } from '@cloudflare/workers-types';
import type { ActivityStreams, ActivitySummary, GymSession, WeeklyRunBlock } from '../src/types';

export interface AthleteRow {
  id: number;
  firstname: string | null;
  lastname: string | null;
  username: string | null;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: number | null;
  scope: string | null;
}

export interface StoredActivity extends ActivitySummary {}

export interface SyncStateRow {
  last_sync_at: string | null;
  last_activity_date: string | null;
  last_result: string | null;
  last_error: string | null;
  rate_limit: string | null;
}

export async function getAthlete(db: D1Database): Promise<AthleteRow | null> {
  return db.prepare('SELECT * FROM athlete LIMIT 1').first<AthleteRow>();
}

export async function saveAthlete(
  db: D1Database,
  athlete: {
    id: number;
    firstname?: string | null;
    lastname?: string | null;
    username?: string | null;
    access_token: string;
    refresh_token: string;
    expires_at: number;
    scope?: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO athlete (id, firstname, lastname, username, access_token, refresh_token, expires_at, scope, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT(id) DO UPDATE SET
         firstname=excluded.firstname, lastname=excluded.lastname, username=excluded.username,
         access_token=excluded.access_token, refresh_token=excluded.refresh_token,
         expires_at=excluded.expires_at, scope=excluded.scope, updated_at=excluded.updated_at`,
    )
    .bind(
      athlete.id,
      athlete.firstname ?? null,
      athlete.lastname ?? null,
      athlete.username ?? null,
      athlete.access_token,
      athlete.refresh_token,
      athlete.expires_at,
      athlete.scope ?? null,
      new Date().toISOString(),
    )
    .run();
}

export async function updateAthleteTokens(
  db: D1Database,
  tokens: { access_token: string; refresh_token: string; expires_at: number },
): Promise<void> {
  await db
    .prepare('UPDATE athlete SET access_token=?1, refresh_token=?2, expires_at=?3, updated_at=?4')
    .bind(tokens.access_token, tokens.refresh_token, tokens.expires_at, new Date().toISOString())
    .run();
}

export async function deleteAthlete(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM athlete'),
    db.prepare('DELETE FROM activity_streams'),
    db.prepare('DELETE FROM activities'),
    db.prepare('DELETE FROM weekly_features'),
    db.prepare('UPDATE sync_state SET last_sync_at=NULL, last_activity_date=NULL, last_result=NULL, last_error=NULL WHERE id=1'),
  ]);
}

export async function clearAthleteConnection(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM athlete'),
    db.prepare('UPDATE sync_state SET last_error=NULL, rate_limit=NULL WHERE id=1'),
  ]);
}

export async function replaceTrainingData(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM athlete'),
    db.prepare('DELETE FROM activity_streams'),
    db.prepare('DELETE FROM activities'),
    db.prepare('DELETE FROM weekly_features'),
    db.prepare(
      'UPDATE sync_state SET last_sync_at=NULL, last_activity_date=NULL, last_result=NULL, last_error=NULL, rate_limit=NULL WHERE id=1',
    ),
  ]);
}

export async function upsertActivities(db: D1Database, activities: ActivitySummary[]): Promise<void> {
  if (activities.length === 0) {
    return;
  }
  const now = new Date().toISOString();
  const statements = activities.map((activity) =>
    db
      .prepare(
        `INSERT INTO activities (
           id, name, sport_type, start_date, start_date_local, distance_km, moving_time_s, elapsed_time_s,
           average_heartrate, max_heartrate, average_cadence_spm, elevation_gain_m, relative_effort, average_watts, average_speed,
           start_lat, start_lng, end_lat, end_lng, summary_polyline, created_at, updated_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, sport_type=excluded.sport_type, start_date=excluded.start_date,
           start_date_local=excluded.start_date_local, distance_km=excluded.distance_km,
           moving_time_s=excluded.moving_time_s, elapsed_time_s=excluded.elapsed_time_s,
           average_heartrate=excluded.average_heartrate, max_heartrate=excluded.max_heartrate,
           average_cadence_spm=excluded.average_cadence_spm, elevation_gain_m=excluded.elevation_gain_m,
           relative_effort=excluded.relative_effort, average_watts=excluded.average_watts, average_speed=excluded.average_speed,
           start_lat=excluded.start_lat, start_lng=excluded.start_lng, end_lat=excluded.end_lat, end_lng=excluded.end_lng,
           summary_polyline=excluded.summary_polyline, updated_at=excluded.updated_at`,
      )
      .bind(
        activity.id,
        activity.name,
        activity.sportType,
        activity.startDate,
        activity.startDateLocal,
        activity.distanceKm,
        activity.movingTimeSec,
        activity.elapsedTimeSec,
        activity.averageHeartRate ?? null,
        activity.maxHeartRate ?? null,
        activity.averageCadenceSpm ?? null,
        activity.elevationGainM,
        activity.relativeEffort ?? null,
        activity.averageWatts ?? null,
        activity.averageSpeed ?? null,
        activity.startLat ?? null,
        activity.startLng ?? null,
        activity.endLat ?? null,
        activity.endLng ?? null,
        activity.summaryPolyline ?? null,
        now,
        now,
      ),
  );
  await db.batch(statements);
}

interface ActivityRow {
  id: string;
  name: string;
  sport_type: string;
  start_date: string;
  start_date_local: string;
  distance_km: number;
  moving_time_s: number;
  elapsed_time_s: number;
  average_heartrate: number | null;
  max_heartrate: number | null;
  average_cadence_spm: number | null;
  elevation_gain_m: number;
  relative_effort: number | null;
  average_watts: number | null;
  average_speed: number | null;
  start_lat: number | null;
  start_lng: number | null;
  end_lat: number | null;
  end_lng: number | null;
  summary_polyline: string | null;
  has_streams: number;
  decoupling_pct: number | null;
}

function rowToActivity(row: ActivityRow): StoredActivity {
  return {
    id: row.id,
    name: row.name,
    sportType: row.sport_type,
    startDate: row.start_date,
    startDateLocal: row.start_date_local,
    distanceKm: row.distance_km,
    movingTimeSec: row.moving_time_s,
    elapsedTimeSec: row.elapsed_time_s,
    averageHeartRate: row.average_heartrate ?? undefined,
    maxHeartRate: row.max_heartrate ?? undefined,
    averageCadenceSpm: row.average_cadence_spm ?? undefined,
    elevationGainM: row.elevation_gain_m,
    relativeEffort: row.relative_effort ?? undefined,
    averageWatts: row.average_watts ?? undefined,
    averageSpeed: row.average_speed ?? undefined,
    startLat: row.start_lat ?? undefined,
    startLng: row.start_lng ?? undefined,
    endLat: row.end_lat ?? undefined,
    endLng: row.end_lng ?? undefined,
    summaryPolyline: row.summary_polyline ?? undefined,
    hasStreams: row.has_streams === 1,
    decouplingPct: row.decoupling_pct ?? undefined,
  };
}

export async function getActivities(
  db: D1Database,
  opts: { from?: string; to?: string } = {},
): Promise<StoredActivity[]> {
  const clauses: string[] = [];
  const binds: string[] = [];
  if (opts.from) {
    binds.push(opts.from);
    clauses.push(`start_date >= ?${binds.length}`);
  }
  if (opts.to) {
    binds.push(opts.to);
    clauses.push(`start_date <= ?${binds.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await db
    .prepare(`SELECT * FROM activities ${where} ORDER BY start_date ASC`)
    .bind(...binds)
    .all<ActivityRow>();
  return (result.results ?? []).map(rowToActivity);
}

export async function getActivity(db: D1Database, id: string): Promise<StoredActivity | null> {
  const row = await db.prepare('SELECT * FROM activities WHERE id = ?1').bind(id).first<ActivityRow>();
  return row ? rowToActivity(row) : null;
}

interface GymRow {
  id: string;
  name: string;
  sport_type: string;
  start_date: string;
  start_date_local: string;
  duration_s: number;
  average_heartrate: number | null;
  calories: number | null;
}

function rowToGym(row: GymRow): GymSession {
  return {
    id: row.id,
    name: row.name,
    sportType: row.sport_type,
    startDate: row.start_date,
    startDateLocal: row.start_date_local,
    durationSec: row.duration_s,
    averageHeartRate: row.average_heartrate ?? undefined,
    calories: row.calories ?? undefined,
  };
}

export async function getGymSessions(
  db: D1Database,
  opts: { from?: string; to?: string } = {},
): Promise<GymSession[]> {
  const clauses: string[] = [];
  const binds: string[] = [];
  if (opts.from) {
    binds.push(opts.from);
    clauses.push(`start_date >= ?${binds.length}`);
  }
  if (opts.to) {
    binds.push(opts.to);
    clauses.push(`start_date <= ?${binds.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await db
    .prepare(`SELECT * FROM gym_sessions ${where} ORDER BY start_date ASC`)
    .bind(...binds)
    .all<GymRow>();
  return (result.results ?? []).map(rowToGym);
}

export async function replaceGymSessions(db: D1Database): Promise<void> {
  await db.prepare('DELETE FROM gym_sessions').run();
}

export async function upsertGymSessions(db: D1Database, sessions: GymSession[]): Promise<void> {
  if (sessions.length === 0) {
    return;
  }
  const now = new Date().toISOString();
  const statements = sessions.map((session) =>
    db
      .prepare(
        `INSERT INTO gym_sessions (
           id, name, sport_type, start_date, start_date_local, duration_s, average_heartrate, calories, created_at, updated_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, sport_type=excluded.sport_type, start_date=excluded.start_date,
           start_date_local=excluded.start_date_local, duration_s=excluded.duration_s,
           average_heartrate=excluded.average_heartrate, calories=excluded.calories, updated_at=excluded.updated_at`,
      )
      .bind(
        session.id,
        session.name,
        session.sportType,
        session.startDate,
        session.startDateLocal,
        Math.round(session.durationSec) || 0,
        session.averageHeartRate ?? null,
        session.calories ?? null,
        now,
        now,
      ),
  );
  await db.batch(statements);
}

export async function getActivitiesNeedingStreams(db: D1Database, limit: number): Promise<StoredActivity[]> {
  const result = await db
    .prepare(
      `SELECT * FROM activities
       WHERE has_streams = 0 AND summary_polyline IS NOT NULL AND summary_polyline != ''
       ORDER BY start_date DESC LIMIT ?1`,
    )
    .bind(limit)
    .all<ActivityRow>();
  return (result.results ?? []).map(rowToActivity);
}

export async function saveStreams(
  db: D1Database,
  activityId: string,
  streams: ActivityStreams,
  decouplingPct: number | undefined,
): Promise<void> {
  const pointCount = streams.latlng?.length ?? streams.timeSec?.length ?? 0;
  await db.batch([
    db
      .prepare(
        `INSERT INTO activity_streams (activity_id, latlng, time_s, heartrate, cadence, power, velocity, altitude, distance_m, point_count, fetched_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
         ON CONFLICT(activity_id) DO UPDATE SET
           latlng=excluded.latlng, time_s=excluded.time_s, heartrate=excluded.heartrate, cadence=excluded.cadence,
           power=excluded.power, velocity=excluded.velocity, altitude=excluded.altitude, distance_m=excluded.distance_m,
           point_count=excluded.point_count, fetched_at=excluded.fetched_at`,
      )
      .bind(
        activityId,
        jsonOrNull(streams.latlng),
        jsonOrNull(streams.timeSec),
        jsonOrNull(streams.heartrate),
        jsonOrNull(streams.cadence),
        jsonOrNull(streams.power),
        jsonOrNull(streams.velocity),
        jsonOrNull(streams.altitude),
        jsonOrNull(streams.distanceM),
        pointCount,
        new Date().toISOString(),
      ),
    db
      .prepare('UPDATE activities SET has_streams = 1, decoupling_pct = ?2, updated_at = ?3 WHERE id = ?1')
      .bind(activityId, decouplingPct ?? null, new Date().toISOString()),
  ]);
}

export async function getStreams(db: D1Database, activityId: string): Promise<ActivityStreams | null> {
  const row = await db
    .prepare('SELECT * FROM activity_streams WHERE activity_id = ?1')
    .bind(activityId)
    .first<Record<string, string | null>>();
  if (!row) {
    return null;
  }
  return {
    latlng: parseJson(row.latlng),
    timeSec: parseJson(row.time_s),
    heartrate: parseJson(row.heartrate),
    cadence: parseJson(row.cadence),
    power: parseJson(row.power),
    velocity: parseJson(row.velocity),
    altitude: parseJson(row.altitude),
    distanceM: parseJson(row.distance_m),
  };
}

export async function replaceWeeklyFeatures(db: D1Database, weeks: WeeklyRunBlock[]): Promise<void> {
  const now = new Date().toISOString();
  const statements = [
    db.prepare('DELETE FROM weekly_features'),
    ...weeks.map((week) =>
      db
        .prepare('INSERT INTO weekly_features (week_start, year, data, computed_at) VALUES (?1,?2,?3,?4)')
        .bind(week.weekStart, week.year, JSON.stringify(week), now),
    ),
  ];
  await db.batch(statements);
}

export async function getWeeklyFeatures(
  db: D1Database,
  opts: { from?: string; to?: string } = {},
): Promise<WeeklyRunBlock[]> {
  const clauses: string[] = [];
  const binds: string[] = [];
  if (opts.from) {
    binds.push(opts.from);
    clauses.push(`week_start >= ?${binds.length}`);
  }
  if (opts.to) {
    binds.push(opts.to);
    clauses.push(`week_start <= ?${binds.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await db
    .prepare(`SELECT data FROM weekly_features ${where} ORDER BY week_start ASC`)
    .bind(...binds)
    .all<{ data: string }>();
  return (result.results ?? []).map((row) => JSON.parse(row.data) as WeeklyRunBlock);
}

export async function getSyncState(db: D1Database): Promise<SyncStateRow> {
  const row = await db.prepare('SELECT * FROM sync_state WHERE id = 1').first<SyncStateRow>();
  return (
    row ?? { last_sync_at: null, last_activity_date: null, last_result: null, last_error: null, rate_limit: null }
  );
}

export async function updateSyncState(
  db: D1Database,
  patch: Partial<{
    last_sync_at: string;
    last_activity_date: string;
    last_result: string;
    last_error: string | null;
    rate_limit: string;
  }>,
): Promise<void> {
  const fields = Object.keys(patch);
  if (fields.length === 0) {
    return;
  }
  const assignments = fields.map((field, index) => `${field} = ?${index + 1}`).join(', ');
  const binds = fields.map((field) => (patch as Record<string, unknown>)[field] ?? null);
  await db.prepare(`UPDATE sync_state SET ${assignments} WHERE id = 1`).bind(...binds).run();
}

export async function getCounts(db: D1Database): Promise<{ activities: number; streamed: number; weeks: number }> {
  const [activities, streamed, weeks] = await db.batch<{ n: number }>([
    db.prepare('SELECT COUNT(*) AS n FROM activities'),
    db.prepare('SELECT COUNT(*) AS n FROM activities WHERE has_streams = 1'),
    db.prepare('SELECT COUNT(*) AS n FROM weekly_features'),
  ]);
  return {
    activities: activities.results?.[0]?.n ?? 0,
    streamed: streamed.results?.[0]?.n ?? 0,
    weeks: weeks.results?.[0]?.n ?? 0,
  };
}

export async function getDateRange(db: D1Database): Promise<{ first: string | null; last: string | null }> {
  const row = await db
    .prepare('SELECT MIN(start_date) AS first, MAX(start_date) AS last FROM activities')
    .first<{ first: string | null; last: string | null }>();
  return { first: row?.first ?? null, last: row?.last ?? null };
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function parseJson<T>(value: string | null): T | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}
