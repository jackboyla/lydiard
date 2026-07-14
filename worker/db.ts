import type { D1Database } from '@cloudflare/workers-types';
import type {
  ActivityLap,
  ActivityStreams,
  ActivitySummary,
  GymSession,
  TrainingPlanDay,
  WeeklyRunBlock,
} from '../src/types';
import { bestEffortsForActivity } from '../src/analysis/bestEfforts';

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

export interface BestEffortRejection {
  distanceLabel: string;
  activityId: string;
  reason: string;
  createdAt: string;
  updatedAt: string;
}

interface BestEffortRejectionRow {
  distance_label: string;
  activity_id: string;
  reason: string;
  created_at: string;
  updated_at: string;
}

export async function getBestEffortRejections(db: D1Database): Promise<BestEffortRejection[]> {
  const result = await db
    .prepare('SELECT * FROM best_effort_rejections ORDER BY created_at DESC')
    .all<BestEffortRejectionRow>();
  return (result.results ?? []).map((row) => ({
    distanceLabel: row.distance_label,
    activityId: row.activity_id,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function setBestEffortRejection(
  db: D1Database,
  input: { distanceLabel: string; activityId: string; rejected: boolean; reason?: string },
): Promise<void> {
  if (!input.rejected) {
    await db
      .prepare('DELETE FROM best_effort_rejections WHERE distance_label = ?1 AND activity_id = ?2')
      .bind(input.distanceLabel, input.activityId)
      .run();
    return;
  }
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO best_effort_rejections (distance_label, activity_id, reason, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4)
       ON CONFLICT(distance_label, activity_id) DO UPDATE SET
         reason=excluded.reason, updated_at=excluded.updated_at`,
    )
    .bind(input.distanceLabel, input.activityId, input.reason ?? '', now)
    .run();
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
  activity_note?: string | null;
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
    activityNote: row.activity_note || undefined,
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
    clauses.push(`a.start_date >= ?${binds.length}`);
  }
  if (opts.to) {
    binds.push(opts.to);
    clauses.push(`a.start_date <= ?${binds.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await db
    .prepare(
      `SELECT a.*, NULLIF(f.note, '') AS activity_note
       FROM activities a
       LEFT JOIN activity_feedback f ON f.activity_id = a.id
       ${where}
       ORDER BY a.start_date ASC`,
    )
    .bind(...binds)
    .all<ActivityRow>();
  return (result.results ?? []).map(rowToActivity);
}

export async function getActivity(db: D1Database, id: string): Promise<StoredActivity | null> {
  const row = await db
    .prepare(
      `SELECT a.*, NULLIF(f.note, '') AS activity_note
       FROM activities a
       LEFT JOIN activity_feedback f ON f.activity_id = a.id
       WHERE a.id = ?1`,
    )
    .bind(id)
    .first<ActivityRow>();
  return row ? rowToActivity(row) : null;
}

/** Read activities by runner-local calendar date for plan Actual matching. */
export async function getActivitiesByLocalDateRange(
  db: D1Database,
  opts: { from: string; to: string },
): Promise<StoredActivity[]> {
  const result = await db
    .prepare(
      `SELECT * FROM activities
       WHERE substr(start_date_local, 1, 10) >= ?1
         AND substr(start_date_local, 1, 10) <= ?2
       ORDER BY start_date_local ASC`,
    )
    .bind(opts.from, opts.to)
    .all<ActivityRow>();
  return (result.results ?? []).map(rowToActivity);
}

interface TrainingPlanDayRow {
  plan_date: string;
  planned_text: string;
  legacy_planned_text: string;
  legacy_actual_text: string;
  notes: string;
  source: string;
  source_file: string | null;
  imported_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TrainingPlanImportInput {
  date: string;
  plannedText: string;
  legacyActualText: string;
  notes: string;
  sourceFile: string;
}

export class TrainingPlanConflictError extends Error {
  constructor(date: string) {
    super(`Training plan day ${date} changed after it was loaded.`);
    this.name = 'TrainingPlanConflictError';
  }
}

function rowToTrainingPlanDay(row: TrainingPlanDayRow): TrainingPlanDay {
  return {
    date: row.plan_date,
    plannedText: row.planned_text,
    legacyPlannedText: row.legacy_planned_text,
    legacyActualText: row.legacy_actual_text,
    notes: row.notes,
    source: row.source,
    sourceFile: row.source_file ?? undefined,
    importedAt: row.imported_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getTrainingPlanDays(
  db: D1Database,
  opts: { from?: string; to?: string } = {},
): Promise<TrainingPlanDay[]> {
  const clauses: string[] = [];
  const binds: string[] = [];
  if (opts.from) {
    binds.push(opts.from);
    clauses.push(`plan_date >= ?${binds.length}`);
  }
  if (opts.to) {
    binds.push(opts.to);
    clauses.push(`plan_date <= ?${binds.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await db
    .prepare(`SELECT * FROM training_plan_days ${where} ORDER BY plan_date ASC`)
    .bind(...binds)
    .all<TrainingPlanDayRow>();
  return (result.results ?? []).map(rowToTrainingPlanDay);
}

export async function getTrainingPlanDay(db: D1Database, date: string): Promise<TrainingPlanDay | null> {
  const row = await db
    .prepare('SELECT * FROM training_plan_days WHERE plan_date = ?1')
    .bind(date)
    .first<TrainingPlanDayRow>();
  return row ? rowToTrainingPlanDay(row) : null;
}

/** Public owner edit. Legacy/source/import metadata is intentionally untouched. */
export async function patchTrainingPlanDay(
  db: D1Database,
  date: string,
  patch: { plannedText?: string; notes?: string; expectedUpdatedAt: string | null },
): Promise<TrainingPlanDay> {
  const existing = await getTrainingPlanDay(db, date);
  const wallClockNow = new Date().toISOString();
  // Keep the concurrency token strictly increasing even when two edits land
  // inside the same millisecond (or a worker clock trails the stored value).
  const now = existing && wallClockNow <= existing.updatedAt
    ? new Date(Date.parse(existing.updatedAt) + 1).toISOString()
    : wallClockNow;
  if (existing) {
    const expectedUpdatedAt = patch.expectedUpdatedAt;
    if (expectedUpdatedAt === null) {
      throw new TrainingPlanConflictError(date);
    }
    const result = await db
      .prepare(
        `UPDATE training_plan_days
         SET planned_text = ?2, notes = ?3, updated_at = ?4
         WHERE plan_date = ?1 AND updated_at = ?5`,
      )
      .bind(
        date,
        patch.plannedText ?? existing.plannedText,
        patch.notes ?? existing.notes,
        now,
        expectedUpdatedAt,
      )
      .run();
    if ((result.meta.changes ?? 0) === 0) {
      throw new TrainingPlanConflictError(date);
    }
  } else {
    if (patch.expectedUpdatedAt !== null) {
      throw new TrainingPlanConflictError(date);
    }
    const result = await db
      .prepare(
        `INSERT INTO training_plan_days (
           plan_date, planned_text, legacy_planned_text, legacy_actual_text, notes,
           source, source_file, imported_at, created_at, updated_at
         ) VALUES (?1, ?2, '', '', ?3, 'manual', NULL, NULL, ?4, ?4)
         ON CONFLICT(plan_date) DO NOTHING`,
      )
      .bind(date, patch.plannedText ?? '', patch.notes ?? '', now)
      .run();
    if ((result.meta.changes ?? 0) === 0) {
      throw new TrainingPlanConflictError(date);
    }
  }

  const saved = await getTrainingPlanDay(db, date);
  if (!saved) {
    throw new Error(`Training plan day ${date} was not saved.`);
  }
  return saved;
}

/**
 * Import original sheet rows. `legacy_planned_text` is set only on INSERT and
 * is deliberately omitted from the overwrite clause so provenance is immutable.
 */
export async function importTrainingPlanDays(
  db: D1Database,
  days: TrainingPlanImportInput[],
  opts: { source: string; overwrite: boolean },
): Promise<number> {
  if (days.length === 0) {
    return 0;
  }

  const existing = new Set(
    (await getTrainingPlanDays(db, {
      from: days.reduce((lowest, day) => (day.date < lowest ? day.date : lowest), days[0].date),
      to: days.reduce((highest, day) => (day.date > highest ? day.date : highest), days[0].date),
    })).map((day) => day.date),
  );
  const now = new Date().toISOString();
  const conflict = opts.overwrite
    ? `DO UPDATE SET
         planned_text=excluded.planned_text,
         legacy_actual_text=excluded.legacy_actual_text,
         notes=excluded.notes,
         source=excluded.source,
         source_file=excluded.source_file,
         imported_at=excluded.imported_at,
         updated_at=excluded.updated_at`
    : 'DO NOTHING';
  const statements = days.map((day) =>
    db
      .prepare(
        `INSERT INTO training_plan_days (
           plan_date, planned_text, legacy_planned_text, legacy_actual_text, notes,
           source, source_file, imported_at, created_at, updated_at
         ) VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?7)
         ON CONFLICT(plan_date) ${conflict}`,
      )
      .bind(day.date, day.plannedText, day.legacyActualText, day.notes, opts.source, day.sourceFile, now),
  );
  await db.batch(statements);
  return opts.overwrite ? days.length : days.filter((day) => !existing.has(day.date)).length;
}

// ---------------------------------------------------------------------------
// Stateful coach persistence
// ---------------------------------------------------------------------------

export type CoachPhase =
  | 'aerobic_conditioning'
  | 'hill_resistance'
  | 'anaerobic_development'
  | 'coordination'
  | 'recovery_regeneration';

export interface CoachProfile {
  primaryGoal: string;
  secondaryGoal: string;
  goal5kSeconds: number;
  goal10kSeconds: number;
  currentPhase: CoachPhase;
  phaseStartedOn?: string;
  targetRaceDate?: string;
  sustainableWeeklyDurationMin?: number;
  targetWeeklyDurationMin?: number;
  longRunToleranceMin?: number;
  maxQualitySessions: number;
  strengthSessionsTarget: number;
  constraints: Record<string, unknown>;
  learnedResponse: Record<string, unknown>;
  policyVersion: string;
  nextDecisionAt?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type CoachProfilePatch = Partial<
  Omit<CoachProfile, 'version' | 'createdAt' | 'updatedAt'>
>;

interface CoachProfileRow {
  primary_goal: string;
  secondary_goal: string;
  goal_5k_seconds: number;
  goal_10k_seconds: number;
  current_phase: CoachPhase;
  phase_started_on: string | null;
  target_race_date: string | null;
  sustainable_weekly_duration_min: number | null;
  target_weekly_duration_min: number | null;
  long_run_tolerance_min: number | null;
  max_quality_sessions: number;
  strength_sessions_target: number;
  constraints_json: string;
  learned_response_json: string;
  policy_version: string;
  next_decision_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export class CoachProfileConflictError extends Error {
  constructor() {
    super('The coach profile changed after it was loaded.');
    this.name = 'CoachProfileConflictError';
  }
}

function rowToCoachProfile(row: CoachProfileRow): CoachProfile {
  return {
    primaryGoal: row.primary_goal,
    secondaryGoal: row.secondary_goal,
    goal5kSeconds: row.goal_5k_seconds,
    goal10kSeconds: row.goal_10k_seconds,
    currentPhase: row.current_phase,
    phaseStartedOn: row.phase_started_on ?? undefined,
    targetRaceDate: row.target_race_date ?? undefined,
    sustainableWeeklyDurationMin: row.sustainable_weekly_duration_min ?? undefined,
    targetWeeklyDurationMin: row.target_weekly_duration_min ?? undefined,
    longRunToleranceMin: row.long_run_tolerance_min ?? undefined,
    maxQualitySessions: row.max_quality_sessions,
    strengthSessionsTarget: row.strength_sessions_target,
    constraints: parseJson<Record<string, unknown>>(row.constraints_json) ?? {},
    learnedResponse: parseJson<Record<string, unknown>>(row.learned_response_json) ?? {},
    policyVersion: row.policy_version,
    nextDecisionAt: row.next_decision_at ?? undefined,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getCoachProfile(db: D1Database): Promise<CoachProfile | null> {
  const row = await db.prepare('SELECT * FROM coach_profile WHERE id = 1').first<CoachProfileRow>();
  return row ? rowToCoachProfile(row) : null;
}

export async function updateCoachProfile(
  db: D1Database,
  patch: CoachProfilePatch,
  expectedVersion: number,
): Promise<CoachProfile> {
  const existing = await getCoachProfile(db);
  if (!existing || existing.version !== expectedVersion) {
    throw new CoachProfileConflictError();
  }
  const next = { ...existing, ...patch };
  const now = monotonicIso(existing.updatedAt);
  const result = await db
    .prepare(
      `UPDATE coach_profile SET
         primary_goal=?1, secondary_goal=?2, goal_5k_seconds=?3, goal_10k_seconds=?4,
         current_phase=?5, phase_started_on=?6, target_race_date=?7,
         sustainable_weekly_duration_min=?8, target_weekly_duration_min=?9,
         long_run_tolerance_min=?10, max_quality_sessions=?11, strength_sessions_target=?12,
         constraints_json=?13, learned_response_json=?14, policy_version=?15,
         next_decision_at=?16, version=version+1, updated_at=?17
       WHERE id=1 AND version=?18`,
    )
    .bind(
      next.primaryGoal,
      next.secondaryGoal,
      next.goal5kSeconds,
      next.goal10kSeconds,
      next.currentPhase,
      next.phaseStartedOn ?? null,
      next.targetRaceDate ?? null,
      next.sustainableWeeklyDurationMin ?? null,
      next.targetWeeklyDurationMin ?? null,
      next.longRunToleranceMin ?? null,
      next.maxQualitySessions,
      next.strengthSessionsTarget,
      JSON.stringify(next.constraints),
      JSON.stringify(next.learnedResponse),
      next.policyVersion,
      next.nextDecisionAt ?? null,
      now,
      expectedVersion,
    )
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    throw new CoachProfileConflictError();
  }
  const saved = await getCoachProfile(db);
  if (!saved) {
    throw new Error('Coach profile was not saved.');
  }
  return saved;
}

export async function deleteCoachProfile(db: D1Database): Promise<void> {
  await db.prepare('DELETE FROM coach_profile WHERE id = 1').run();
}

export interface CriticalPowerRecord {
  id: string;
  effectiveFrom: string;
  criticalPowerWatts: number;
  source: 'stryd_auto' | 'stryd_test' | 'stryd_manual' | 'platform_estimate' | 'manual' | 'imported';
  device: string;
  algorithm?: string;
  confidence: number;
  supportingActivityIds: string[];
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export type CriticalPowerInput = Omit<CriticalPowerRecord, 'createdAt' | 'updatedAt'>;

interface CriticalPowerRow {
  id: string;
  effective_from: string;
  critical_power_watts: number;
  source: CriticalPowerRecord['source'];
  device: string;
  algorithm: string | null;
  confidence: number;
  supporting_activity_ids: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

function rowToCriticalPower(row: CriticalPowerRow): CriticalPowerRecord {
  return {
    id: row.id,
    effectiveFrom: row.effective_from,
    criticalPowerWatts: row.critical_power_watts,
    source: row.source,
    device: row.device,
    algorithm: row.algorithm ?? undefined,
    confidence: row.confidence,
    supportingActivityIds: parseJson<string[]>(row.supporting_activity_ids) ?? [],
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getCriticalPowerRecord(db: D1Database, id: string): Promise<CriticalPowerRecord | null> {
  const row = await db
    .prepare('SELECT * FROM critical_power_history WHERE id = ?1')
    .bind(id)
    .first<CriticalPowerRow>();
  return row ? rowToCriticalPower(row) : null;
}

export async function getCriticalPowerHistory(
  db: D1Database,
  opts: { from?: string; to?: string; device?: string } = {},
): Promise<CriticalPowerRecord[]> {
  const clauses: string[] = [];
  const binds: string[] = [];
  if (opts.from) {
    binds.push(opts.from);
    clauses.push(`effective_from >= ?${binds.length}`);
  }
  if (opts.to) {
    binds.push(opts.to);
    clauses.push(`effective_from <= ?${binds.length}`);
  }
  if (opts.device) {
    binds.push(opts.device);
    clauses.push(`device = ?${binds.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await db
    .prepare(`SELECT * FROM critical_power_history ${where} ORDER BY effective_from ASC, created_at ASC`)
    .bind(...binds)
    .all<CriticalPowerRow>();
  return (result.results ?? []).map(rowToCriticalPower);
}

export async function getCriticalPowerAsOf(
  db: D1Database,
  asOf: string,
  device?: string,
): Promise<CriticalPowerRecord | null> {
  const row = device
    ? await db
        .prepare(
          `SELECT * FROM critical_power_history
           WHERE effective_from <= ?1 AND device = ?2
           ORDER BY effective_from DESC, created_at DESC LIMIT 1`,
        )
        .bind(asOf, device)
        .first<CriticalPowerRow>()
    : await db
        .prepare(
          `SELECT * FROM critical_power_history
           WHERE effective_from <= ?1
           ORDER BY effective_from DESC, created_at DESC LIMIT 1`,
        )
        .bind(asOf)
        .first<CriticalPowerRow>();
  return row ? rowToCriticalPower(row) : null;
}

export async function upsertCriticalPowerRecord(
  db: D1Database,
  record: CriticalPowerInput,
): Promise<CriticalPowerRecord> {
  const existing = await getCriticalPowerRecord(db, record.id);
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO critical_power_history (
         id, effective_from, critical_power_watts, source, device, algorithm,
         confidence, supporting_activity_ids, notes, created_at, updated_at
       ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
       ON CONFLICT(id) DO UPDATE SET
         effective_from=excluded.effective_from, critical_power_watts=excluded.critical_power_watts,
         source=excluded.source, device=excluded.device, algorithm=excluded.algorithm,
         confidence=excluded.confidence, supporting_activity_ids=excluded.supporting_activity_ids,
         notes=excluded.notes, updated_at=excluded.updated_at`,
    )
    .bind(
      record.id,
      record.effectiveFrom,
      record.criticalPowerWatts,
      record.source,
      record.device,
      record.algorithm ?? null,
      record.confidence,
      JSON.stringify(record.supportingActivityIds),
      record.notes,
      existing?.createdAt ?? now,
      now,
    )
    .run();
  const saved = await getCriticalPowerRecord(db, record.id);
  if (!saved) {
    throw new Error(`Critical-power record ${record.id} was not saved.`);
  }
  return saved;
}

export async function deleteCriticalPowerRecord(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM critical_power_history WHERE id = ?1').bind(id).run();
}

export interface PhysiologyEstimate {
  id: string;
  effectiveFrom: string;
  criticalPowerId?: string;
  criticalSpeedMps?: number;
  criticalSpeedLowMps?: number;
  criticalSpeedHighMps?: number;
  dPrimeM?: number;
  lt1HrLow?: number;
  lt1HrHigh?: number;
  lt2HrLow?: number;
  lt2HrHigh?: number;
  confidence: number;
  confidenceDetail: Record<string, unknown>;
  evidence: Record<string, unknown>;
  source: string;
  modelVersion: string;
  createdAt: string;
}

export type PhysiologyEstimateInput = Omit<PhysiologyEstimate, 'createdAt'>;

interface PhysiologyEstimateRow {
  id: string;
  effective_from: string;
  critical_power_id: string | null;
  critical_speed_mps: number | null;
  critical_speed_low_mps: number | null;
  critical_speed_high_mps: number | null;
  d_prime_m: number | null;
  lt1_hr_low: number | null;
  lt1_hr_high: number | null;
  lt2_hr_low: number | null;
  lt2_hr_high: number | null;
  confidence: number;
  confidence_json: string;
  evidence_json: string;
  source: string;
  model_version: string;
  created_at: string;
}

function rowToPhysiologyEstimate(row: PhysiologyEstimateRow): PhysiologyEstimate {
  return {
    id: row.id,
    effectiveFrom: row.effective_from,
    criticalPowerId: row.critical_power_id ?? undefined,
    criticalSpeedMps: row.critical_speed_mps ?? undefined,
    criticalSpeedLowMps: row.critical_speed_low_mps ?? undefined,
    criticalSpeedHighMps: row.critical_speed_high_mps ?? undefined,
    dPrimeM: row.d_prime_m ?? undefined,
    lt1HrLow: row.lt1_hr_low ?? undefined,
    lt1HrHigh: row.lt1_hr_high ?? undefined,
    lt2HrLow: row.lt2_hr_low ?? undefined,
    lt2HrHigh: row.lt2_hr_high ?? undefined,
    confidence: row.confidence,
    confidenceDetail: parseJson<Record<string, unknown>>(row.confidence_json) ?? {},
    evidence: parseJson<Record<string, unknown>>(row.evidence_json) ?? {},
    source: row.source,
    modelVersion: row.model_version,
    createdAt: row.created_at,
  };
}

export async function getPhysiologyEstimate(db: D1Database, id: string): Promise<PhysiologyEstimate | null> {
  const row = await db.prepare('SELECT * FROM physiology_estimates WHERE id=?1').bind(id).first<PhysiologyEstimateRow>();
  return row ? rowToPhysiologyEstimate(row) : null;
}

export async function getPhysiologyEstimates(
  db: D1Database,
  opts: { from?: string; to?: string } = {},
): Promise<PhysiologyEstimate[]> {
  const clauses: string[] = [];
  const binds: string[] = [];
  if (opts.from) {
    binds.push(opts.from);
    clauses.push(`effective_from >= ?${binds.length}`);
  }
  if (opts.to) {
    binds.push(opts.to);
    clauses.push(`effective_from <= ?${binds.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await db
    .prepare(`SELECT * FROM physiology_estimates ${where} ORDER BY effective_from ASC, created_at ASC`)
    .bind(...binds)
    .all<PhysiologyEstimateRow>();
  return (result.results ?? []).map(rowToPhysiologyEstimate);
}

export async function getPhysiologyEstimateAsOf(
  db: D1Database,
  asOf: string,
): Promise<PhysiologyEstimate | null> {
  const row = await db
    .prepare(
      `SELECT * FROM physiology_estimates WHERE effective_from <= ?1
       ORDER BY effective_from DESC, created_at DESC LIMIT 1`,
    )
    .bind(asOf)
    .first<PhysiologyEstimateRow>();
  return row ? rowToPhysiologyEstimate(row) : null;
}

export async function upsertPhysiologyEstimate(
  db: D1Database,
  estimate: PhysiologyEstimateInput,
): Promise<PhysiologyEstimate> {
  const existing = await getPhysiologyEstimate(db, estimate.id);
  const createdAt = existing?.createdAt ?? new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO physiology_estimates (
         id, effective_from, critical_power_id, critical_speed_mps, critical_speed_low_mps,
         critical_speed_high_mps, d_prime_m, lt1_hr_low, lt1_hr_high, lt2_hr_low, lt2_hr_high,
         confidence, confidence_json, evidence_json, source, model_version, created_at
       ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
       ON CONFLICT(id) DO UPDATE SET
         effective_from=excluded.effective_from, critical_power_id=excluded.critical_power_id,
         critical_speed_mps=excluded.critical_speed_mps, critical_speed_low_mps=excluded.critical_speed_low_mps,
         critical_speed_high_mps=excluded.critical_speed_high_mps, d_prime_m=excluded.d_prime_m,
         lt1_hr_low=excluded.lt1_hr_low, lt1_hr_high=excluded.lt1_hr_high,
         lt2_hr_low=excluded.lt2_hr_low, lt2_hr_high=excluded.lt2_hr_high,
         confidence=excluded.confidence, confidence_json=excluded.confidence_json,
         evidence_json=excluded.evidence_json, source=excluded.source, model_version=excluded.model_version`,
    )
    .bind(
      estimate.id,
      estimate.effectiveFrom,
      estimate.criticalPowerId ?? null,
      estimate.criticalSpeedMps ?? null,
      estimate.criticalSpeedLowMps ?? null,
      estimate.criticalSpeedHighMps ?? null,
      estimate.dPrimeM ?? null,
      estimate.lt1HrLow ?? null,
      estimate.lt1HrHigh ?? null,
      estimate.lt2HrLow ?? null,
      estimate.lt2HrHigh ?? null,
      estimate.confidence,
      JSON.stringify(estimate.confidenceDetail),
      JSON.stringify(estimate.evidence),
      estimate.source,
      estimate.modelVersion,
      createdAt,
    )
    .run();
  const saved = await getPhysiologyEstimate(db, estimate.id);
  if (!saved) {
    throw new Error(`Physiology estimate ${estimate.id} was not saved.`);
  }
  return saved;
}

export async function deletePhysiologyEstimate(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM physiology_estimates WHERE id=?1').bind(id).run();
}

export type PlannedSessionStatus =
  | 'proposed'
  | 'accepted'
  | 'planned'
  | 'completed'
  | 'partial'
  | 'skipped'
  | 'cancelled'
  | 'superseded';

export interface PlannedSession {
  id: string;
  plannedDate: string;
  sequence: number;
  title: string;
  sessionType: string;
  trainingPhase: string;
  priority: string;
  plannedDurationSec?: number;
  plannedDistanceKm?: number;
  plannedPowerStress?: number;
  targetCriticalPowerId?: string;
  targetPowerLowW?: number;
  targetPowerHighW?: number;
  targetPowerLowPctCp?: number;
  targetPowerHighPctCp?: number;
  targetHrLow?: number;
  targetHrHigh?: number;
  targetHrCeiling?: number;
  targetGapLowSecPerKm?: number;
  targetGapHighSecPerKm?: number;
  workoutStructure: Record<string, unknown>;
  purpose: string;
  fallbackPlan: string;
  coachReasoning: string;
  status: PlannedSessionStatus;
  source: string;
  sourcePlanDate?: string;
  coachDecisionId?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type PlannedSessionInput = Omit<PlannedSession, 'revision' | 'createdAt' | 'updatedAt'>;
export type PlannedSessionPatch = Partial<Omit<PlannedSessionInput, 'id'>>;

interface PlannedSessionRow {
  id: string;
  planned_date: string;
  sequence: number;
  title: string;
  session_type: string;
  training_phase: string;
  priority: string;
  planned_duration_s: number | null;
  planned_distance_km: number | null;
  planned_power_stress: number | null;
  target_cp_history_id: string | null;
  target_power_low_w: number | null;
  target_power_high_w: number | null;
  target_power_low_pct_cp: number | null;
  target_power_high_pct_cp: number | null;
  target_hr_low: number | null;
  target_hr_high: number | null;
  target_hr_ceiling: number | null;
  target_gap_low_sec_km: number | null;
  target_gap_high_sec_km: number | null;
  workout_structure_json: string;
  purpose: string;
  fallback_plan: string;
  coach_reasoning: string;
  status: PlannedSessionStatus;
  source: string;
  source_plan_date: string | null;
  coach_decision_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

function rowToPlannedSession(row: PlannedSessionRow): PlannedSession {
  return {
    id: row.id,
    plannedDate: row.planned_date,
    sequence: row.sequence,
    title: row.title,
    sessionType: row.session_type,
    trainingPhase: row.training_phase,
    priority: row.priority,
    plannedDurationSec: row.planned_duration_s ?? undefined,
    plannedDistanceKm: row.planned_distance_km ?? undefined,
    plannedPowerStress: row.planned_power_stress ?? undefined,
    targetCriticalPowerId: row.target_cp_history_id ?? undefined,
    targetPowerLowW: row.target_power_low_w ?? undefined,
    targetPowerHighW: row.target_power_high_w ?? undefined,
    targetPowerLowPctCp: row.target_power_low_pct_cp ?? undefined,
    targetPowerHighPctCp: row.target_power_high_pct_cp ?? undefined,
    targetHrLow: row.target_hr_low ?? undefined,
    targetHrHigh: row.target_hr_high ?? undefined,
    targetHrCeiling: row.target_hr_ceiling ?? undefined,
    targetGapLowSecPerKm: row.target_gap_low_sec_km ?? undefined,
    targetGapHighSecPerKm: row.target_gap_high_sec_km ?? undefined,
    workoutStructure: parseJson<Record<string, unknown>>(row.workout_structure_json) ?? {},
    purpose: row.purpose,
    fallbackPlan: row.fallback_plan,
    coachReasoning: row.coach_reasoning,
    status: row.status,
    source: row.source,
    sourcePlanDate: row.source_plan_date ?? undefined,
    coachDecisionId: row.coach_decision_id ?? undefined,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PlannedSessionConflictError extends Error {
  constructor(id: string) {
    super(`Planned session ${id} changed after it was loaded.`);
    this.name = 'PlannedSessionConflictError';
  }
}

export async function getPlannedSession(db: D1Database, id: string): Promise<PlannedSession | null> {
  const row = await db.prepare('SELECT * FROM planned_sessions WHERE id=?1').bind(id).first<PlannedSessionRow>();
  return row ? rowToPlannedSession(row) : null;
}

export async function getPlannedSessions(
  db: D1Database,
  opts: { from?: string; to?: string; status?: PlannedSessionStatus } = {},
): Promise<PlannedSession[]> {
  const clauses: string[] = [];
  const binds: string[] = [];
  if (opts.from) {
    binds.push(opts.from);
    clauses.push(`planned_date >= ?${binds.length}`);
  }
  if (opts.to) {
    binds.push(opts.to);
    clauses.push(`planned_date <= ?${binds.length}`);
  }
  if (opts.status) {
    binds.push(opts.status);
    clauses.push(`status = ?${binds.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await db
    .prepare(`SELECT * FROM planned_sessions ${where} ORDER BY planned_date ASC, sequence ASC, created_at ASC`)
    .bind(...binds)
    .all<PlannedSessionRow>();
  return (result.results ?? []).map(rowToPlannedSession);
}

function plannedSessionStatement(db: D1Database, session: PlannedSessionInput, now: string) {
  return db
    .prepare(
      `INSERT INTO planned_sessions (
         id, planned_date, sequence, title, session_type, training_phase, priority,
         planned_duration_s, planned_distance_km, planned_power_stress, target_cp_history_id,
         target_power_low_w, target_power_high_w, target_power_low_pct_cp, target_power_high_pct_cp,
         target_hr_low, target_hr_high, target_hr_ceiling, target_gap_low_sec_km, target_gap_high_sec_km,
         workout_structure_json, purpose, fallback_plan, coach_reasoning, status, source,
         source_plan_date, coach_decision_id, revision, created_at, updated_at
       ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,
                 ?21,?22,?23,?24,?25,?26,?27,?28,1,?29,?29)
       ON CONFLICT(id) DO UPDATE SET
         planned_date=excluded.planned_date, sequence=excluded.sequence, title=excluded.title,
         session_type=excluded.session_type, training_phase=excluded.training_phase, priority=excluded.priority,
         planned_duration_s=excluded.planned_duration_s, planned_distance_km=excluded.planned_distance_km,
         planned_power_stress=excluded.planned_power_stress, target_cp_history_id=excluded.target_cp_history_id,
         target_power_low_w=excluded.target_power_low_w, target_power_high_w=excluded.target_power_high_w,
         target_power_low_pct_cp=excluded.target_power_low_pct_cp,
         target_power_high_pct_cp=excluded.target_power_high_pct_cp, target_hr_low=excluded.target_hr_low,
         target_hr_high=excluded.target_hr_high, target_hr_ceiling=excluded.target_hr_ceiling,
         target_gap_low_sec_km=excluded.target_gap_low_sec_km,
         target_gap_high_sec_km=excluded.target_gap_high_sec_km,
         workout_structure_json=excluded.workout_structure_json, purpose=excluded.purpose,
         fallback_plan=excluded.fallback_plan, coach_reasoning=excluded.coach_reasoning,
         status=excluded.status, source=excluded.source, source_plan_date=excluded.source_plan_date,
         coach_decision_id=excluded.coach_decision_id, revision=planned_sessions.revision+1,
         updated_at=excluded.updated_at`,
    )
    .bind(
      session.id,
      session.plannedDate,
      session.sequence,
      session.title,
      session.sessionType,
      session.trainingPhase,
      session.priority,
      session.plannedDurationSec ?? null,
      session.plannedDistanceKm ?? null,
      session.plannedPowerStress ?? null,
      session.targetCriticalPowerId ?? null,
      session.targetPowerLowW ?? null,
      session.targetPowerHighW ?? null,
      session.targetPowerLowPctCp ?? null,
      session.targetPowerHighPctCp ?? null,
      session.targetHrLow ?? null,
      session.targetHrHigh ?? null,
      session.targetHrCeiling ?? null,
      session.targetGapLowSecPerKm ?? null,
      session.targetGapHighSecPerKm ?? null,
      JSON.stringify(session.workoutStructure),
      session.purpose,
      session.fallbackPlan,
      session.coachReasoning,
      session.status,
      session.source,
      session.sourcePlanDate ?? null,
      session.coachDecisionId ?? null,
      now,
    );
}

export async function upsertPlannedSessions(db: D1Database, sessions: PlannedSessionInput[]): Promise<void> {
  if (sessions.length === 0) {
    return;
  }
  const now = new Date().toISOString();
  await db.batch(sessions.map((session) => plannedSessionStatement(db, session, now)));
}

export async function upsertPlannedSession(db: D1Database, session: PlannedSessionInput): Promise<PlannedSession> {
  await plannedSessionStatement(db, session, new Date().toISOString()).run();
  const saved = await getPlannedSession(db, session.id);
  if (!saved) {
    throw new Error(`Planned session ${session.id} was not saved.`);
  }
  return saved;
}

export async function patchPlannedSession(
  db: D1Database,
  id: string,
  patch: PlannedSessionPatch,
  expectedRevision: number,
): Promise<PlannedSession> {
  const existing = await getPlannedSession(db, id);
  if (!existing || existing.revision !== expectedRevision) {
    throw new PlannedSessionConflictError(id);
  }
  const next: PlannedSessionInput = {
    id,
    plannedDate: patch.plannedDate ?? existing.plannedDate,
    sequence: patch.sequence ?? existing.sequence,
    title: patch.title ?? existing.title,
    sessionType: patch.sessionType ?? existing.sessionType,
    trainingPhase: patch.trainingPhase ?? existing.trainingPhase,
    priority: patch.priority ?? existing.priority,
    plannedDurationSec: patch.plannedDurationSec ?? existing.plannedDurationSec,
    plannedDistanceKm: patch.plannedDistanceKm ?? existing.plannedDistanceKm,
    plannedPowerStress: patch.plannedPowerStress ?? existing.plannedPowerStress,
    targetCriticalPowerId: patch.targetCriticalPowerId ?? existing.targetCriticalPowerId,
    targetPowerLowW: patch.targetPowerLowW ?? existing.targetPowerLowW,
    targetPowerHighW: patch.targetPowerHighW ?? existing.targetPowerHighW,
    targetPowerLowPctCp: patch.targetPowerLowPctCp ?? existing.targetPowerLowPctCp,
    targetPowerHighPctCp: patch.targetPowerHighPctCp ?? existing.targetPowerHighPctCp,
    targetHrLow: patch.targetHrLow ?? existing.targetHrLow,
    targetHrHigh: patch.targetHrHigh ?? existing.targetHrHigh,
    targetHrCeiling: patch.targetHrCeiling ?? existing.targetHrCeiling,
    targetGapLowSecPerKm: patch.targetGapLowSecPerKm ?? existing.targetGapLowSecPerKm,
    targetGapHighSecPerKm: patch.targetGapHighSecPerKm ?? existing.targetGapHighSecPerKm,
    workoutStructure: patch.workoutStructure ?? existing.workoutStructure,
    purpose: patch.purpose ?? existing.purpose,
    fallbackPlan: patch.fallbackPlan ?? existing.fallbackPlan,
    coachReasoning: patch.coachReasoning ?? existing.coachReasoning,
    status: patch.status ?? existing.status,
    source: patch.source ?? existing.source,
    sourcePlanDate: patch.sourcePlanDate ?? existing.sourcePlanDate,
    coachDecisionId: patch.coachDecisionId ?? existing.coachDecisionId,
  };
  const now = monotonicIso(existing.updatedAt);
  const statement = plannedSessionUpdateStatement(db, next, now, expectedRevision);
  const result = await statement.run();
  if ((result.meta.changes ?? 0) === 0) {
    throw new PlannedSessionConflictError(id);
  }
  const saved = await getPlannedSession(db, id);
  if (!saved) {
    throw new Error(`Planned session ${id} was not saved.`);
  }
  return saved;
}

function plannedSessionUpdateStatement(
  db: D1Database,
  session: PlannedSessionInput,
  now: string,
  expectedRevision: number,
) {
  return db
    .prepare(
      `UPDATE planned_sessions SET
         planned_date=?2, sequence=?3, title=?4, session_type=?5, training_phase=?6, priority=?7,
         planned_duration_s=?8, planned_distance_km=?9, planned_power_stress=?10,
         target_cp_history_id=?11, target_power_low_w=?12, target_power_high_w=?13,
         target_power_low_pct_cp=?14, target_power_high_pct_cp=?15, target_hr_low=?16,
         target_hr_high=?17, target_hr_ceiling=?18, target_gap_low_sec_km=?19,
         target_gap_high_sec_km=?20, workout_structure_json=?21, purpose=?22,
         fallback_plan=?23, coach_reasoning=?24, status=?25, source=?26,
         source_plan_date=?27, coach_decision_id=?28, revision=revision+1, updated_at=?29
       WHERE id=?1 AND revision=?30`,
    )
    .bind(
      session.id,
      session.plannedDate,
      session.sequence,
      session.title,
      session.sessionType,
      session.trainingPhase,
      session.priority,
      session.plannedDurationSec ?? null,
      session.plannedDistanceKm ?? null,
      session.plannedPowerStress ?? null,
      session.targetCriticalPowerId ?? null,
      session.targetPowerLowW ?? null,
      session.targetPowerHighW ?? null,
      session.targetPowerLowPctCp ?? null,
      session.targetPowerHighPctCp ?? null,
      session.targetHrLow ?? null,
      session.targetHrHigh ?? null,
      session.targetHrCeiling ?? null,
      session.targetGapLowSecPerKm ?? null,
      session.targetGapHighSecPerKm ?? null,
      JSON.stringify(session.workoutStructure),
      session.purpose,
      session.fallbackPlan,
      session.coachReasoning,
      session.status,
      session.source,
      session.sourcePlanDate ?? null,
      session.coachDecisionId ?? null,
      now,
      expectedRevision,
    );
}

export async function deletePlannedSession(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM planned_sessions WHERE id=?1').bind(id).run();
}

export interface PlannedActivityLink {
  plannedSessionId: string;
  activityId: string;
  matchMethod: string;
  matchConfidence: number;
  completionStatus: string;
  linkedAt: string;
  updatedAt: string;
}

export type PlannedActivityLinkInput = Omit<PlannedActivityLink, 'linkedAt' | 'updatedAt'>;

interface PlannedActivityLinkRow {
  planned_session_id: string;
  activity_id: string;
  match_method: string;
  match_confidence: number;
  completion_status: string;
  linked_at: string;
  updated_at: string;
}

function rowToPlannedActivityLink(row: PlannedActivityLinkRow): PlannedActivityLink {
  return {
    plannedSessionId: row.planned_session_id,
    activityId: row.activity_id,
    matchMethod: row.match_method,
    matchConfidence: row.match_confidence,
    completionStatus: row.completion_status,
    linkedAt: row.linked_at,
    updatedAt: row.updated_at,
  };
}

export async function getPlannedActivityLinks(
  db: D1Database,
  opts: { plannedSessionId?: string; activityId?: string } = {},
): Promise<PlannedActivityLink[]> {
  const clauses: string[] = [];
  const binds: string[] = [];
  if (opts.plannedSessionId) {
    binds.push(opts.plannedSessionId);
    clauses.push(`planned_session_id=?${binds.length}`);
  }
  if (opts.activityId) {
    binds.push(opts.activityId);
    clauses.push(`activity_id=?${binds.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await db
    .prepare(`SELECT * FROM planned_activity_links ${where} ORDER BY linked_at ASC`)
    .bind(...binds)
    .all<PlannedActivityLinkRow>();
  return (result.results ?? []).map(rowToPlannedActivityLink);
}

export async function upsertPlannedActivityLink(
  db: D1Database,
  link: PlannedActivityLinkInput,
): Promise<PlannedActivityLink> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO planned_activity_links (
         planned_session_id, activity_id, match_method, match_confidence,
         completion_status, linked_at, updated_at
       ) VALUES (?1,?2,?3,?4,?5,?6,?6)
       ON CONFLICT(planned_session_id, activity_id) DO UPDATE SET
         match_method=excluded.match_method, match_confidence=excluded.match_confidence,
         completion_status=excluded.completion_status, updated_at=excluded.updated_at`,
    )
    .bind(
      link.plannedSessionId,
      link.activityId,
      link.matchMethod,
      link.matchConfidence,
      link.completionStatus,
      now,
    )
    .run();
  const saved = (await getPlannedActivityLinks(db, link))[0];
  if (!saved) {
    throw new Error(`Plan/activity link ${link.plannedSessionId}/${link.activityId} was not saved.`);
  }
  return saved;
}

export async function deletePlannedActivityLink(
  db: D1Database,
  plannedSessionId: string,
  activityId: string,
): Promise<void> {
  await db
    .prepare('DELETE FROM planned_activity_links WHERE planned_session_id=?1 AND activity_id=?2')
    .bind(plannedSessionId, activityId)
    .run();
}

export interface DailyCheckin {
  day: string;
  energy?: number;
  legFreshness?: number;
  motivation?: number;
  generalFatigue?: number;
  lifeStress?: number;
  leftKneePain?: number;
  rightKneePain?: number;
  leftAchillesPain?: number;
  rightAchillesPain?: number;
  painAlteredGait: boolean;
  illnessSuspected: boolean;
  sleepQuality?: number;
  bodyweightKg?: number;
  note: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type DailyCheckinInput = Omit<DailyCheckin, 'version' | 'createdAt' | 'updatedAt'>;

interface DailyCheckinRow {
  day: string;
  energy: number | null;
  leg_freshness: number | null;
  motivation: number | null;
  general_fatigue: number | null;
  life_stress: number | null;
  left_knee_pain: number | null;
  right_knee_pain: number | null;
  left_achilles_pain: number | null;
  right_achilles_pain: number | null;
  pain_altered_gait: number;
  illness_suspected: number;
  sleep_quality: number | null;
  bodyweight_kg: number | null;
  note: string;
  version: number;
  created_at: string;
  updated_at: string;
}

function rowToDailyCheckin(row: DailyCheckinRow): DailyCheckin {
  return {
    day: row.day,
    energy: row.energy ?? undefined,
    legFreshness: row.leg_freshness ?? undefined,
    motivation: row.motivation ?? undefined,
    generalFatigue: row.general_fatigue ?? undefined,
    lifeStress: row.life_stress ?? undefined,
    leftKneePain: row.left_knee_pain ?? undefined,
    rightKneePain: row.right_knee_pain ?? undefined,
    leftAchillesPain: row.left_achilles_pain ?? undefined,
    rightAchillesPain: row.right_achilles_pain ?? undefined,
    painAlteredGait: row.pain_altered_gait === 1,
    illnessSuspected: row.illness_suspected === 1,
    sleepQuality: row.sleep_quality ?? undefined,
    bodyweightKg: row.bodyweight_kg ?? undefined,
    note: row.note,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getDailyCheckin(db: D1Database, day: string): Promise<DailyCheckin | null> {
  const row = await db.prepare('SELECT * FROM daily_checkins WHERE day=?1').bind(day).first<DailyCheckinRow>();
  return row ? rowToDailyCheckin(row) : null;
}

export async function getDailyCheckins(
  db: D1Database,
  opts: { from?: string; to?: string } = {},
): Promise<DailyCheckin[]> {
  const clauses: string[] = [];
  const binds: string[] = [];
  if (opts.from) {
    binds.push(opts.from);
    clauses.push(`day >= ?${binds.length}`);
  }
  if (opts.to) {
    binds.push(opts.to);
    clauses.push(`day <= ?${binds.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await db
    .prepare(`SELECT * FROM daily_checkins ${where} ORDER BY day ASC`)
    .bind(...binds)
    .all<DailyCheckinRow>();
  return (result.results ?? []).map(rowToDailyCheckin);
}

export async function upsertDailyCheckin(db: D1Database, checkin: DailyCheckinInput): Promise<DailyCheckin> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO daily_checkins (
         day, energy, leg_freshness, motivation, general_fatigue, life_stress,
         left_knee_pain, right_knee_pain, left_achilles_pain, right_achilles_pain,
         pain_altered_gait, illness_suspected, sleep_quality, bodyweight_kg, note,
         version, created_at, updated_at
       ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,1,?16,?16)
       ON CONFLICT(day) DO UPDATE SET
         energy=excluded.energy, leg_freshness=excluded.leg_freshness,
         motivation=excluded.motivation, general_fatigue=excluded.general_fatigue,
         life_stress=excluded.life_stress, left_knee_pain=excluded.left_knee_pain,
         right_knee_pain=excluded.right_knee_pain, left_achilles_pain=excluded.left_achilles_pain,
         right_achilles_pain=excluded.right_achilles_pain,
         pain_altered_gait=excluded.pain_altered_gait, illness_suspected=excluded.illness_suspected,
         sleep_quality=excluded.sleep_quality, bodyweight_kg=excluded.bodyweight_kg,
         note=excluded.note, version=daily_checkins.version+1, updated_at=excluded.updated_at`,
    )
    .bind(
      checkin.day,
      checkin.energy ?? null,
      checkin.legFreshness ?? null,
      checkin.motivation ?? null,
      checkin.generalFatigue ?? null,
      checkin.lifeStress ?? null,
      checkin.leftKneePain ?? null,
      checkin.rightKneePain ?? null,
      checkin.leftAchillesPain ?? null,
      checkin.rightAchillesPain ?? null,
      checkin.painAlteredGait ? 1 : 0,
      checkin.illnessSuspected ? 1 : 0,
      checkin.sleepQuality ?? null,
      checkin.bodyweightKg ?? null,
      checkin.note,
      now,
    )
    .run();
  const saved = await getDailyCheckin(db, checkin.day);
  if (!saved) {
    throw new Error(`Daily check-in ${checkin.day} was not saved.`);
  }
  return saved;
}

export async function deleteDailyCheckin(db: D1Database, day: string): Promise<void> {
  await db.prepare('DELETE FROM daily_checkins WHERE day=?1').bind(day).run();
}

export type SessionFeel = 'easier' | 'as_expected' | 'harder';

export interface ActivityFeedback {
  activityId: string;
  plannedSessionId?: string;
  perceivedEffort?: number;
  perceivedCost?: string;
  sessionFeel?: SessionFeel;
  energy?: number;
  legCondition?: string;
  breathingCondition?: string;
  painDuring?: number;
  painAfter?: number;
  painLocation?: string;
  alteredGait: boolean;
  sessionVerdict?: string;
  note: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type ActivityFeedbackInput = Omit<ActivityFeedback, 'version' | 'createdAt' | 'updatedAt'>;

interface ActivityFeedbackRow {
  activity_id: string;
  planned_session_id: string | null;
  perceived_effort: number | null;
  perceived_cost: string | null;
  session_feel: SessionFeel | null;
  energy: number | null;
  leg_condition: string | null;
  breathing_condition: string | null;
  pain_during: number | null;
  pain_after: number | null;
  pain_location: string | null;
  altered_gait: number;
  session_verdict: string | null;
  note: string;
  version: number;
  created_at: string;
  updated_at: string;
}

function rowToActivityFeedback(row: ActivityFeedbackRow): ActivityFeedback {
  return {
    activityId: row.activity_id,
    plannedSessionId: row.planned_session_id ?? undefined,
    perceivedEffort: row.perceived_effort ?? undefined,
    perceivedCost: row.perceived_cost ?? undefined,
    sessionFeel: row.session_feel ?? undefined,
    energy: row.energy ?? undefined,
    legCondition: row.leg_condition ?? undefined,
    breathingCondition: row.breathing_condition ?? undefined,
    painDuring: row.pain_during ?? undefined,
    painAfter: row.pain_after ?? undefined,
    painLocation: row.pain_location ?? undefined,
    alteredGait: row.altered_gait === 1,
    sessionVerdict: row.session_verdict ?? undefined,
    note: row.note,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getActivityFeedback(db: D1Database, activityId: string): Promise<ActivityFeedback | null> {
  const row = await db
    .prepare('SELECT * FROM activity_feedback WHERE activity_id=?1')
    .bind(activityId)
    .first<ActivityFeedbackRow>();
  return row ? rowToActivityFeedback(row) : null;
}

/** Update only the runner's ordinary activity note without disturbing coach feedback fields. */
export async function patchActivityNote(db: D1Database, activityId: string, note: string): Promise<ActivityFeedback> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO activity_feedback (
         activity_id, altered_gait, note, version, created_at, updated_at
       ) VALUES (?1, 0, ?2, 1, ?3, ?3)
       ON CONFLICT(activity_id) DO UPDATE SET
         note=excluded.note,
         version=activity_feedback.version+1,
         updated_at=excluded.updated_at`,
    )
    .bind(activityId, note, now)
    .run();
  const saved = await getActivityFeedback(db, activityId);
  if (!saved) {
    throw new Error(`Activity note ${activityId} was not saved.`);
  }
  return saved;
}

export async function getActivityFeedbackBatch(
  db: D1Database,
  activityIds: string[],
): Promise<ActivityFeedback[]> {
  if (activityIds.length === 0) {
    return [];
  }
  const placeholders = activityIds.map((_, index) => `?${index + 1}`).join(',');
  const result = await db
    .prepare(`SELECT * FROM activity_feedback WHERE activity_id IN (${placeholders}) ORDER BY updated_at ASC`)
    .bind(...activityIds)
    .all<ActivityFeedbackRow>();
  return (result.results ?? []).map(rowToActivityFeedback);
}

export async function upsertActivityFeedback(
  db: D1Database,
  feedback: ActivityFeedbackInput,
): Promise<ActivityFeedback> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO activity_feedback (
         activity_id, planned_session_id, perceived_effort, perceived_cost, session_feel,
         energy, leg_condition, breathing_condition, pain_during, pain_after, pain_location,
         altered_gait, session_verdict, note, version, created_at, updated_at
       ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,1,?15,?15)
       ON CONFLICT(activity_id) DO UPDATE SET
         planned_session_id=excluded.planned_session_id, perceived_effort=excluded.perceived_effort,
         perceived_cost=excluded.perceived_cost, session_feel=excluded.session_feel,
         energy=excluded.energy, leg_condition=excluded.leg_condition,
         breathing_condition=excluded.breathing_condition, pain_during=excluded.pain_during,
         pain_after=excluded.pain_after, pain_location=excluded.pain_location,
         altered_gait=excluded.altered_gait, session_verdict=excluded.session_verdict,
         note=excluded.note,
         version=activity_feedback.version+1, updated_at=excluded.updated_at`,
    )
    .bind(
      feedback.activityId,
      feedback.plannedSessionId ?? null,
      feedback.perceivedEffort ?? null,
      feedback.perceivedCost ?? null,
      feedback.sessionFeel ?? null,
      feedback.energy ?? null,
      feedback.legCondition ?? null,
      feedback.breathingCondition ?? null,
      feedback.painDuring ?? null,
      feedback.painAfter ?? null,
      feedback.painLocation ?? null,
      feedback.alteredGait ? 1 : 0,
      feedback.sessionVerdict ?? null,
      feedback.note,
      now,
    )
    .run();
  const saved = await getActivityFeedback(db, feedback.activityId);
  if (!saved) {
    throw new Error(`Activity feedback ${feedback.activityId} was not saved.`);
  }
  return saved;
}

export async function deleteActivityFeedback(db: D1Database, activityId: string): Promise<void> {
  await db.prepare('DELETE FROM activity_feedback WHERE activity_id=?1').bind(activityId).run();
}

export type CoachDecisionStatus = 'proposed' | 'applied' | 'rejected' | 'superseded';

export interface CoachDecision {
  id: string;
  decisionType: string;
  asOf: string;
  triggerActivityId?: string;
  weekStart?: string;
  status: CoachDecisionStatus;
  requestId?: string;
  stateVersionBefore?: number;
  stateVersionAfter?: number;
  policyVersion: string;
  modelVersion: string;
  summary: string;
  reasoning: string;
  evidence: Record<string, unknown>;
  planPatch: Record<string, unknown>;
  stateBefore: Record<string, unknown>;
  stateAfter: Record<string, unknown>;
  createdAt: string;
  appliedAt?: string;
  updatedAt: string;
}

export type CoachDecisionInput = Omit<CoachDecision, 'createdAt' | 'updatedAt'>;

interface CoachDecisionRow {
  id: string;
  decision_type: string;
  as_of: string;
  trigger_activity_id: string | null;
  week_start: string | null;
  status: CoachDecisionStatus;
  request_id: string | null;
  state_version_before: number | null;
  state_version_after: number | null;
  policy_version: string;
  model_version: string;
  summary: string;
  reasoning: string;
  evidence_json: string;
  plan_patch_json: string;
  state_before_json: string;
  state_after_json: string;
  created_at: string;
  applied_at: string | null;
  updated_at: string;
}

function rowToCoachDecision(row: CoachDecisionRow): CoachDecision {
  return {
    id: row.id,
    decisionType: row.decision_type,
    asOf: row.as_of,
    triggerActivityId: row.trigger_activity_id ?? undefined,
    weekStart: row.week_start ?? undefined,
    status: row.status,
    requestId: row.request_id ?? undefined,
    stateVersionBefore: row.state_version_before ?? undefined,
    stateVersionAfter: row.state_version_after ?? undefined,
    policyVersion: row.policy_version,
    modelVersion: row.model_version,
    summary: row.summary,
    reasoning: row.reasoning,
    evidence: parseJson<Record<string, unknown>>(row.evidence_json) ?? {},
    planPatch: parseJson<Record<string, unknown>>(row.plan_patch_json) ?? {},
    stateBefore: parseJson<Record<string, unknown>>(row.state_before_json) ?? {},
    stateAfter: parseJson<Record<string, unknown>>(row.state_after_json) ?? {},
    createdAt: row.created_at,
    appliedAt: row.applied_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

export async function getCoachDecision(db: D1Database, id: string): Promise<CoachDecision | null> {
  const row = await db.prepare('SELECT * FROM coach_decisions WHERE id=?1').bind(id).first<CoachDecisionRow>();
  return row ? rowToCoachDecision(row) : null;
}

export async function getCoachDecisionByRequestId(
  db: D1Database,
  requestId: string,
): Promise<CoachDecision | null> {
  const row = await db
    .prepare('SELECT * FROM coach_decisions WHERE request_id=?1')
    .bind(requestId)
    .first<CoachDecisionRow>();
  return row ? rowToCoachDecision(row) : null;
}

export async function getCoachDecisions(
  db: D1Database,
  opts: {
    from?: string;
    to?: string;
    status?: CoachDecisionStatus;
    triggerActivityId?: string;
    weekStart?: string;
    limit?: number;
  } = {},
): Promise<CoachDecision[]> {
  const clauses: string[] = [];
  const binds: Array<string | number> = [];
  if (opts.from) {
    binds.push(opts.from);
    clauses.push(`as_of >= ?${binds.length}`);
  }
  if (opts.to) {
    binds.push(opts.to);
    clauses.push(`as_of <= ?${binds.length}`);
  }
  if (opts.status) {
    binds.push(opts.status);
    clauses.push(`status = ?${binds.length}`);
  }
  if (opts.triggerActivityId) {
    binds.push(opts.triggerActivityId);
    clauses.push(`trigger_activity_id = ?${binds.length}`);
  }
  if (opts.weekStart) {
    binds.push(opts.weekStart);
    clauses.push(`week_start = ?${binds.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));
  binds.push(limit);
  const result = await db
    .prepare(
      `SELECT * FROM coach_decisions ${where}
       ORDER BY as_of DESC, created_at DESC LIMIT ?${binds.length}`,
    )
    .bind(...binds)
    .all<CoachDecisionRow>();
  return (result.results ?? []).map(rowToCoachDecision);
}

export async function upsertCoachDecision(db: D1Database, decision: CoachDecisionInput): Promise<CoachDecision> {
  const existing = await getCoachDecision(db, decision.id);
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO coach_decisions (
         id, decision_type, as_of, trigger_activity_id, week_start, status, request_id,
         state_version_before, state_version_after, policy_version, model_version,
         summary, reasoning, evidence_json, plan_patch_json, state_before_json,
         state_after_json, created_at, applied_at, updated_at
       ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)
       ON CONFLICT(id) DO UPDATE SET
         decision_type=excluded.decision_type, as_of=excluded.as_of,
         trigger_activity_id=excluded.trigger_activity_id, week_start=excluded.week_start,
         status=excluded.status, request_id=excluded.request_id,
         state_version_before=excluded.state_version_before,
         state_version_after=excluded.state_version_after, policy_version=excluded.policy_version,
         model_version=excluded.model_version, summary=excluded.summary, reasoning=excluded.reasoning,
         evidence_json=excluded.evidence_json, plan_patch_json=excluded.plan_patch_json,
         state_before_json=excluded.state_before_json, state_after_json=excluded.state_after_json,
         applied_at=excluded.applied_at, updated_at=excluded.updated_at`,
    )
    .bind(
      decision.id,
      decision.decisionType,
      decision.asOf,
      decision.triggerActivityId ?? null,
      decision.weekStart ?? null,
      decision.status,
      decision.requestId ?? null,
      decision.stateVersionBefore ?? null,
      decision.stateVersionAfter ?? null,
      decision.policyVersion,
      decision.modelVersion,
      decision.summary,
      decision.reasoning,
      JSON.stringify(decision.evidence),
      JSON.stringify(decision.planPatch),
      JSON.stringify(decision.stateBefore),
      JSON.stringify(decision.stateAfter),
      existing?.createdAt ?? now,
      decision.appliedAt ?? null,
      now,
    )
    .run();
  const saved = await getCoachDecision(db, decision.id);
  if (!saved) {
    throw new Error(`Coach decision ${decision.id} was not saved.`);
  }
  return saved;
}

export async function updateCoachDecisionStatus(
  db: D1Database,
  id: string,
  status: CoachDecisionStatus,
  opts: { stateVersionAfter?: number; appliedAt?: string } = {},
): Promise<CoachDecision> {
  const existing = await getCoachDecision(db, id);
  if (!existing) {
    throw new Error(`Coach decision ${id} was not found.`);
  }
  const now = monotonicIso(existing.updatedAt);
  await db
    .prepare(
      `UPDATE coach_decisions SET status=?2, state_version_after=?3,
         applied_at=?4, updated_at=?5 WHERE id=?1`,
    )
    .bind(
      id,
      status,
      opts.stateVersionAfter ?? existing.stateVersionAfter ?? null,
      opts.appliedAt ?? (status === 'applied' ? now : existing.appliedAt ?? null),
      now,
    )
    .run();
  const saved = await getCoachDecision(db, id);
  if (!saved) {
    throw new Error(`Coach decision ${id} was not saved.`);
  }
  return saved;
}

export async function deleteCoachDecision(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM coach_decisions WHERE id=?1').bind(id).run();
}

export interface ActivityCoachMetrics {
  activityId: string;
  modelVersion: string;
  effectiveCriticalPowerId?: string;
  criticalPowerWattsUsed?: number;
  powerSource?: string;
  heartRateSource?: string;
  powerStress?: number;
  averagePctCp?: number;
  weightedPctCp?: number;
  hardPowerStress?: number;
  powerZoneSeconds: Record<string, number>;
  peakPower: Record<string, number>;
  expectedHeartRate?: number;
  observedHeartRate?: number;
  heartRateCostResidual?: number;
  heartRatePowerDecouplingPct?: number;
  gapSecPerKm?: number;
  latePowerDropPct?: number;
  lateGapDropPct?: number;
  sensorQuality: Record<string, unknown>;
  confidence: number;
  computedAt: string;
}

export type ActivityCoachMetricsInput = Omit<ActivityCoachMetrics, 'computedAt'> & { computedAt?: string };

interface ActivityCoachMetricsRow {
  activity_id: string;
  model_version: string;
  effective_cp_id: string | null;
  cp_watts_used: number | null;
  power_source: string | null;
  heart_rate_source: string | null;
  power_stress: number | null;
  average_pct_cp: number | null;
  weighted_pct_cp: number | null;
  hard_power_stress: number | null;
  power_zone_seconds_json: string;
  peak_power_json: string;
  expected_hr: number | null;
  observed_hr: number | null;
  hr_cost_residual: number | null;
  hr_power_decoupling_pct: number | null;
  gap_sec_per_km: number | null;
  late_power_drop_pct: number | null;
  late_gap_drop_pct: number | null;
  sensor_quality_json: string;
  confidence: number;
  computed_at: string;
}

function rowToActivityCoachMetrics(row: ActivityCoachMetricsRow): ActivityCoachMetrics {
  return {
    activityId: row.activity_id,
    modelVersion: row.model_version,
    effectiveCriticalPowerId: row.effective_cp_id ?? undefined,
    criticalPowerWattsUsed: row.cp_watts_used ?? undefined,
    powerSource: row.power_source ?? undefined,
    heartRateSource: row.heart_rate_source ?? undefined,
    powerStress: row.power_stress ?? undefined,
    averagePctCp: row.average_pct_cp ?? undefined,
    weightedPctCp: row.weighted_pct_cp ?? undefined,
    hardPowerStress: row.hard_power_stress ?? undefined,
    powerZoneSeconds: parseJson<Record<string, number>>(row.power_zone_seconds_json) ?? {},
    peakPower: parseJson<Record<string, number>>(row.peak_power_json) ?? {},
    expectedHeartRate: row.expected_hr ?? undefined,
    observedHeartRate: row.observed_hr ?? undefined,
    heartRateCostResidual: row.hr_cost_residual ?? undefined,
    heartRatePowerDecouplingPct: row.hr_power_decoupling_pct ?? undefined,
    gapSecPerKm: row.gap_sec_per_km ?? undefined,
    latePowerDropPct: row.late_power_drop_pct ?? undefined,
    lateGapDropPct: row.late_gap_drop_pct ?? undefined,
    sensorQuality: parseJson<Record<string, unknown>>(row.sensor_quality_json) ?? {},
    confidence: row.confidence,
    computedAt: row.computed_at,
  };
}

export async function getActivityCoachMetrics(
  db: D1Database,
  activityId: string,
  modelVersion?: string,
): Promise<ActivityCoachMetrics | null> {
  const row = modelVersion
    ? await db
        .prepare('SELECT * FROM activity_coach_metrics WHERE activity_id=?1 AND model_version=?2')
        .bind(activityId, modelVersion)
        .first<ActivityCoachMetricsRow>()
    : await db
        .prepare(
          `SELECT * FROM activity_coach_metrics WHERE activity_id=?1
           ORDER BY computed_at DESC LIMIT 1`,
        )
        .bind(activityId)
        .first<ActivityCoachMetricsRow>();
  return row ? rowToActivityCoachMetrics(row) : null;
}

export async function getActivityCoachMetricsBatch(
  db: D1Database,
  activityIds: string[],
  modelVersion?: string,
): Promise<ActivityCoachMetrics[]> {
  if (activityIds.length === 0) {
    return [];
  }
  const binds: string[] = [...activityIds];
  const placeholders = activityIds.map((_, index) => `?${index + 1}`).join(',');
  const versionClause = modelVersion ? ` AND model_version=?${binds.push(modelVersion)}` : '';
  const result = await db
    .prepare(
      `SELECT * FROM activity_coach_metrics
       WHERE activity_id IN (${placeholders})${versionClause}
       ORDER BY activity_id ASC, computed_at DESC`,
    )
    .bind(...binds)
    .all<ActivityCoachMetricsRow>();
  return (result.results ?? []).map(rowToActivityCoachMetrics);
}

export async function upsertActivityCoachMetrics(
  db: D1Database,
  metrics: ActivityCoachMetricsInput,
): Promise<ActivityCoachMetrics> {
  const computedAt = metrics.computedAt ?? new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO activity_coach_metrics (
         activity_id, model_version, effective_cp_id, cp_watts_used, power_source,
         heart_rate_source, power_stress, average_pct_cp, weighted_pct_cp,
         hard_power_stress, power_zone_seconds_json, peak_power_json, expected_hr,
         observed_hr, hr_cost_residual, hr_power_decoupling_pct, gap_sec_per_km,
         late_power_drop_pct, late_gap_drop_pct, sensor_quality_json, confidence, computed_at
       ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)
       ON CONFLICT(activity_id, model_version) DO UPDATE SET
         effective_cp_id=excluded.effective_cp_id, cp_watts_used=excluded.cp_watts_used,
         power_source=excluded.power_source, heart_rate_source=excluded.heart_rate_source,
         power_stress=excluded.power_stress, average_pct_cp=excluded.average_pct_cp,
         weighted_pct_cp=excluded.weighted_pct_cp, hard_power_stress=excluded.hard_power_stress,
         power_zone_seconds_json=excluded.power_zone_seconds_json, peak_power_json=excluded.peak_power_json,
         expected_hr=excluded.expected_hr, observed_hr=excluded.observed_hr,
         hr_cost_residual=excluded.hr_cost_residual,
         hr_power_decoupling_pct=excluded.hr_power_decoupling_pct,
         gap_sec_per_km=excluded.gap_sec_per_km, late_power_drop_pct=excluded.late_power_drop_pct,
         late_gap_drop_pct=excluded.late_gap_drop_pct, sensor_quality_json=excluded.sensor_quality_json,
         confidence=excluded.confidence, computed_at=excluded.computed_at`,
    )
    .bind(
      metrics.activityId,
      metrics.modelVersion,
      metrics.effectiveCriticalPowerId ?? null,
      metrics.criticalPowerWattsUsed ?? null,
      metrics.powerSource ?? null,
      metrics.heartRateSource ?? null,
      metrics.powerStress ?? null,
      metrics.averagePctCp ?? null,
      metrics.weightedPctCp ?? null,
      metrics.hardPowerStress ?? null,
      JSON.stringify(metrics.powerZoneSeconds),
      JSON.stringify(metrics.peakPower),
      metrics.expectedHeartRate ?? null,
      metrics.observedHeartRate ?? null,
      metrics.heartRateCostResidual ?? null,
      metrics.heartRatePowerDecouplingPct ?? null,
      metrics.gapSecPerKm ?? null,
      metrics.latePowerDropPct ?? null,
      metrics.lateGapDropPct ?? null,
      JSON.stringify(metrics.sensorQuality),
      metrics.confidence,
      computedAt,
    )
    .run();
  const saved = await getActivityCoachMetrics(db, metrics.activityId, metrics.modelVersion);
  if (!saved) {
    throw new Error(`Coach metrics ${metrics.activityId}/${metrics.modelVersion} were not saved.`);
  }
  return saved;
}

export async function deleteActivityCoachMetrics(
  db: D1Database,
  activityId: string,
  modelVersion?: string,
): Promise<void> {
  if (modelVersion) {
    await db
      .prepare('DELETE FROM activity_coach_metrics WHERE activity_id=?1 AND model_version=?2')
      .bind(activityId, modelVersion)
      .run();
  } else {
    await db.prepare('DELETE FROM activity_coach_metrics WHERE activity_id=?1').bind(activityId).run();
  }
}

export interface StrengthSet {
  id: string;
  gymSessionId: string;
  exercise: string;
  setNumber?: number;
  weightKg?: number;
  reps?: number;
  distanceM?: number;
  durationSec?: number;
  rir?: number;
  rawText: string;
  note: string;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export type StrengthSetInput = Omit<StrengthSet, 'createdAt' | 'updatedAt'>;

interface StrengthSetRow {
  id: string;
  gym_session_id: string;
  exercise: string;
  set_number: number | null;
  weight_kg: number | null;
  reps: number | null;
  distance_m: number | null;
  duration_s: number | null;
  rir: number | null;
  raw_text: string;
  note: string;
  source: string;
  created_at: string;
  updated_at: string;
}

function rowToStrengthSet(row: StrengthSetRow): StrengthSet {
  return {
    id: row.id,
    gymSessionId: row.gym_session_id,
    exercise: row.exercise,
    setNumber: row.set_number ?? undefined,
    weightKg: row.weight_kg ?? undefined,
    reps: row.reps ?? undefined,
    distanceM: row.distance_m ?? undefined,
    durationSec: row.duration_s ?? undefined,
    rir: row.rir ?? undefined,
    rawText: row.raw_text,
    note: row.note,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getStrengthSet(db: D1Database, id: string): Promise<StrengthSet | null> {
  const row = await db.prepare('SELECT * FROM strength_sets WHERE id=?1').bind(id).first<StrengthSetRow>();
  return row ? rowToStrengthSet(row) : null;
}

export async function getStrengthSets(db: D1Database, gymSessionId?: string): Promise<StrengthSet[]> {
  const result = gymSessionId
    ? await db
        .prepare(
          `SELECT * FROM strength_sets WHERE gym_session_id=?1
           ORDER BY set_number ASC, created_at ASC`,
        )
        .bind(gymSessionId)
        .all<StrengthSetRow>()
    : await db
        .prepare('SELECT * FROM strength_sets ORDER BY created_at ASC')
        .all<StrengthSetRow>();
  return (result.results ?? []).map(rowToStrengthSet);
}

function strengthSetStatement(db: D1Database, set: StrengthSetInput, now: string) {
  return db
    .prepare(
      `INSERT INTO strength_sets (
         id, gym_session_id, exercise, set_number, weight_kg, reps, distance_m,
         duration_s, rir, raw_text, note, source, created_at, updated_at
       ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13)
       ON CONFLICT(id) DO UPDATE SET
         gym_session_id=excluded.gym_session_id, exercise=excluded.exercise,
         set_number=excluded.set_number, weight_kg=excluded.weight_kg, reps=excluded.reps,
         distance_m=excluded.distance_m, duration_s=excluded.duration_s, rir=excluded.rir,
         raw_text=excluded.raw_text, note=excluded.note, source=excluded.source,
         updated_at=excluded.updated_at`,
    )
    .bind(
      set.id,
      set.gymSessionId,
      set.exercise,
      set.setNumber ?? null,
      set.weightKg ?? null,
      set.reps ?? null,
      set.distanceM ?? null,
      set.durationSec ?? null,
      set.rir ?? null,
      set.rawText,
      set.note,
      set.source,
      now,
    );
}

export async function upsertStrengthSets(db: D1Database, sets: StrengthSetInput[]): Promise<void> {
  if (sets.length === 0) {
    return;
  }
  const now = new Date().toISOString();
  await db.batch(sets.map((set) => strengthSetStatement(db, set, now)));
}

export async function upsertStrengthSet(db: D1Database, set: StrengthSetInput): Promise<StrengthSet> {
  await strengthSetStatement(db, set, new Date().toISOString()).run();
  const saved = await getStrengthSet(db, set.id);
  if (!saved) {
    throw new Error(`Strength set ${set.id} was not saved.`);
  }
  return saved;
}

export async function deleteStrengthSet(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM strength_sets WHERE id=?1').bind(id).run();
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
        `INSERT INTO activity_streams (activity_id, latlng, time_s, heartrate, cadence, power, velocity, altitude, distance_m, laps, point_count, fetched_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
         ON CONFLICT(activity_id) DO UPDATE SET
           latlng=excluded.latlng, time_s=excluded.time_s, heartrate=excluded.heartrate, cadence=excluded.cadence,
           power=excluded.power, velocity=excluded.velocity, altitude=excluded.altitude, distance_m=excluded.distance_m,
           laps=COALESCE(excluded.laps, activity_streams.laps),
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
        jsonOrNull(streams.laps),
        pointCount,
        new Date().toISOString(),
      ),
    db
      .prepare('UPDATE activities SET has_streams = 1, decoupling_pct = ?2, updated_at = ?3 WHERE id = ?1')
      .bind(activityId, decouplingPct ?? null, new Date().toISOString()),
  ]);
  const activity = await getActivity(db, activityId);
  if (activity) {
    await replaceActivityBestEfforts(db, activity, streams);
  }
}

async function replaceActivityBestEfforts(
  db: D1Database,
  activity: ActivitySummary,
  streams: ActivityStreams,
): Promise<void> {
  const groups = bestEffortsForActivity({
    id: activity.id,
    name: activity.name,
    startDate: activity.startDate,
    startDateLocal: activity.startDateLocal,
    distanceKm: activity.distanceKm,
    movingTimeSec: activity.movingTimeSec,
    timeSec: streams.timeSec,
    distanceM: streams.distanceM,
  });
  const computedAt = new Date().toISOString();
  await db.batch([
    db.prepare('DELETE FROM activity_best_efforts WHERE activity_id = ?1').bind(activity.id),
    ...groups.map((group) => {
      const effort = group.efforts[0];
      return db
        .prepare(
          `INSERT INTO activity_best_efforts (
             activity_id, distance_label, distance_km, seconds, pace_sec_per_km,
             source, segment_start_sec, segment_end_sec, computed_at
           ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
        )
        .bind(
          activity.id,
          group.label,
          group.distanceKm,
          effort.seconds,
          effort.paceSecPerKm,
          effort.source,
          effort.segmentStartSec ?? null,
          effort.segmentEndSec ?? null,
          computedAt,
        );
    }),
  ]);
}

export async function saveActivityLaps(db: D1Database, activityId: string, laps: ActivityLap[]): Promise<void> {
  await db
    .prepare(
      `INSERT INTO activity_streams (activity_id, laps, point_count, fetched_at)
       VALUES (?1, ?2, 0, ?3)
       ON CONFLICT(activity_id) DO UPDATE SET laps=excluded.laps, fetched_at=excluded.fetched_at`,
    )
    .bind(activityId, JSON.stringify(laps), new Date().toISOString())
    .run();
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
    laps: parseJson(row.laps),
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

function monotonicIso(previous: string): string {
  const wallClockNow = new Date().toISOString();
  return wallClockNow <= previous ? new Date(Date.parse(previous) + 1).toISOString() : wallClockNow;
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
