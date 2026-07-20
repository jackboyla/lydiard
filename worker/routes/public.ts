import { Hono } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import type { ActivityDetail, BestEffortDistance, BestEffortEntry, SyncStatus, WeeklyAnalysis } from '../../src/types';
import { analyzeWeeks } from '../../src/analysis/fatigue';
import { BEST_EFFORT_TARGETS } from '../../src/analysis/bestEfforts';
import type { Env } from '../env';
import {
  clearAthleteConnection,
  getActivities,
  getActivity,
  getAthlete,
  getCounts,
  getDateRange,
  getGymSessions,
  getStreams,
  getSyncState,
  getTrainingPlanDay,
  getTrainingPlanDays,
  getWeeklyFeatures,
  patchTrainingPlanDay,
  patchActivityNote,
  setBestEffortRejection,
  TrainingPlanConflictError,
} from '../db';
import { normalizeFrom, normalizeTo } from '../http';
import {
  dispatchGarminWorkflow,
  GarminDispatchConfigurationError,
  GarminDispatchUpstreamError,
} from '../garminDispatch';
import {
  ActivityLocationUnavailableError,
  getHistoricalWeather,
  HistoricalWeatherUnavailableError,
} from '../weather';

export async function loadAnalyses(env: Env): Promise<WeeklyAnalysis[]> {
  // Always analyze the full history so personal baselines are correct.
  const weeks = await getWeeklyFeatures(env.lydiard);
  return analyzeWeeks(weeks);
}

export function publicRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // Site-password gate for the human-facing read API. Only active when
  // SITE_PASSWORD is set (so the app keeps working until you turn it on). The
  // agent API (/api/agent/*) is a separate sub-app and is unaffected.
  app.use('*', async (c, next) => {
    const expected = c.env.SITE_PASSWORD;
    if (expected) {
      const provided = c.req.header('X-Lydiard-Key') ?? '';
      if (provided !== expected) {
        return c.json({ error: 'This training data is private. Enter the site password.' }, 401);
      }
    }
    await next();
  });

  app.get('/status', async (c) => {
    const [athlete, counts, state, range] = await Promise.all([
      getAthlete(c.env.lydiard),
      getCounts(c.env.lydiard),
      getSyncState(c.env.lydiard),
      getDateRange(c.env.lydiard),
    ]);
    const source = syncSource(state.last_result);
    const status: SyncStatus = {
      connected: Boolean(athlete?.refresh_token),
      athlete: athlete
        ? {
            id: athlete.id,
            firstname: athlete.firstname ?? undefined,
            lastname: athlete.lastname ?? undefined,
            username: athlete.username ?? undefined,
          }
        : null,
      activityCount: counts.activities,
      streamedCount: counts.streamed,
      weekCount: counts.weeks,
      lastSyncAt: state.last_sync_at,
      lastActivityDate: state.last_activity_date,
      lastError: state.last_error,
      source,
      dateRange: range,
    };
    return c.json(status);
  });

  app.get('/activities', async (c) => {
    const activities = await getActivities(c.env.lydiard, {
      from: normalizeFrom(c.req.query('from')),
      to: normalizeTo(c.req.query('to')),
    });
    return c.json({ activities });
  });

  app.get('/best-efforts', async (c) => {
    const distances = await computeBestEfforts(c.env.lydiard, {
      from: normalizeFrom(c.req.query('from')),
      to: normalizeTo(c.req.query('to')),
    });
    return c.json({ distances });
  });

  app.patch('/best-efforts/rejections', async (c) => {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: 'Request body must be JSON.' }, 400);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return c.json({ error: 'Request body must be an object.' }, 400);
    }
    const body = payload as Record<string, unknown>;
    const distanceLabel = body.distanceLabel;
    const activityId = body.activityId;
    const rejected = body.rejected;
    const reason = body.reason ?? '';
    if (typeof distanceLabel !== 'string' || !BEST_EFFORT_TARGETS.some((target) => target.label === distanceLabel)) {
      return c.json({ error: 'distanceLabel must be a supported best-effort distance.' }, 400);
    }
    if (typeof activityId !== 'string' || activityId.length === 0 || typeof rejected !== 'boolean') {
      return c.json({ error: 'activityId and rejected are required.' }, 400);
    }
    if (typeof reason !== 'string' || reason.length > 500) {
      return c.json({ error: 'reason must be a string no longer than 500 characters.' }, 400);
    }
    if (rejected && !(await getActivity(c.env.lydiard, activityId))) {
      return c.json({ error: 'Activity not found' }, 404);
    }
    await setBestEffortRejection(c.env.lydiard, { distanceLabel, activityId, rejected, reason });
    return c.json({ distanceLabel, activityId, rejected });
  });

  app.get('/activities/:id', async (c) => {
    const activity = await getActivity(c.env.lydiard, c.req.param('id'));
    if (!activity) {
      return c.json({ error: 'Activity not found' }, 404);
    }
    const localDate = (activity.startDateLocal || activity.startDate).slice(0, 10);
    const [streams, planDay] = await Promise.all([
      getStreams(c.env.lydiard, activity.id),
      getTrainingPlanDay(c.env.lydiard, localDate),
    ]);
    const detail: ActivityDetail = {
      ...activity,
      streams: streams ?? undefined,
      planDay: planDay ?? undefined,
    };
    return c.json(detail);
  });

  app.get('/activities/:id/weather', async (c) => {
    const activity = await getActivity(c.env.lydiard, c.req.param('id'));
    if (!activity) {
      return c.json({ error: 'Activity not found' }, 404);
    }
    try {
      const weather = await getHistoricalWeather(activity);
      c.header('Cache-Control', 'private, max-age=604800');
      return c.json(weather);
    } catch (error) {
      if (error instanceof ActivityLocationUnavailableError) {
        return c.json({ error: error.message }, 422);
      }
      if (error instanceof HistoricalWeatherUnavailableError) {
        return c.json({ error: error.message }, 502);
      }
      throw error;
    }
  });

  app.patch('/activities/:id/note', async (c) => {
    const activity = await getActivity(c.env.lydiard, c.req.param('id'));
    if (!activity) {
      return c.json({ error: 'Activity not found' }, 404);
    }
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: 'Request body must be JSON.' }, 400);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return c.json({ error: 'Request body must be an object.' }, 400);
    }
    const note = (payload as Record<string, unknown>).note;
    if (typeof note !== 'string') {
      return c.json({ error: 'note must be a string.' }, 400);
    }
    if (note.length > 100_000) {
      return c.json({ error: 'note must not exceed 100000 characters.' }, 400);
    }
    const feedback = await patchActivityNote(c.env.lydiard, activity.id, note);
    return c.json({ note: feedback.note, updatedAt: feedback.updatedAt });
  });

  app.get('/gym', async (c) => {
    const sessions = await getGymSessions(c.env.lydiard, {
      from: normalizeFrom(c.req.query('from')),
      to: normalizeTo(c.req.query('to')),
    });
    return c.json({ sessions });
  });

  app.get('/plan', async (c) => {
    const from = optionalPlanDate(c.req.query('from'));
    const to = optionalPlanDate(c.req.query('to'));
    if (from === null || to === null) {
      return c.json({ error: 'Plan from/to must use YYYY-MM-DD.' }, 400);
    }
    if (from && to && from > to) {
      return c.json({ error: 'Plan from must not be after to.' }, 400);
    }
    const days = await getTrainingPlanDays(c.env.lydiard, {
      from: from ?? undefined,
      to: to ?? undefined,
    });
    return c.json({ days });
  });

  app.patch('/plan/:date', async (c) => {
    const date = requiredPlanDate(c.req.param('date'));
    if (!date) {
      return c.json({ error: 'Plan date must use YYYY-MM-DD.' }, 400);
    }

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: 'Request body must be JSON.' }, 400);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return c.json({ error: 'Request body must be an object.' }, 400);
    }
    const body = payload as Record<string, unknown>;
    const hasPlannedText = Object.prototype.hasOwnProperty.call(body, 'plannedText');
    const hasNotes = Object.prototype.hasOwnProperty.call(body, 'notes');
    const hasExpectedUpdatedAt = Object.prototype.hasOwnProperty.call(body, 'expectedUpdatedAt');
    if (!hasPlannedText && !hasNotes) {
      return c.json({ error: 'Provide plannedText and/or notes.' }, 400);
    }
    if (!hasExpectedUpdatedAt) {
      return c.json({ error: 'expectedUpdatedAt is required (use null when the day did not exist).' }, 400);
    }
    if ((hasPlannedText && typeof body.plannedText !== 'string') || (hasNotes && typeof body.notes !== 'string')) {
      return c.json({ error: 'plannedText and notes must be strings.' }, 400);
    }
    if (
      body.expectedUpdatedAt !== null &&
      (typeof body.expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(body.expectedUpdatedAt)))
    ) {
      return c.json({ error: 'expectedUpdatedAt must be an ISO timestamp.' }, 400);
    }
    if (hasPlannedText && (body.plannedText as string).length > 20_000) {
      return c.json({ error: 'plannedText must not exceed 20000 characters.' }, 400);
    }
    if (hasNotes && (body.notes as string).length > 100_000) {
      return c.json({ error: 'notes must not exceed 100000 characters.' }, 400);
    }

    // Values are bound exactly as supplied. In particular, do not trim notes:
    // imported/manual line breaks and leading whitespace are meaningful.
    try {
      const day = await patchTrainingPlanDay(c.env.lydiard, date, {
        plannedText: hasPlannedText ? (body.plannedText as string) : undefined,
        notes: hasNotes ? (body.notes as string) : undefined,
        expectedUpdatedAt: body.expectedUpdatedAt as string | null,
      });
      return c.json({ day });
    } catch (error) {
      if (error instanceof TrainingPlanConflictError) {
        return c.json({ error: 'This plan day changed elsewhere. Reload the Plan before saving.' }, 409);
      }
      throw error;
    }
  });

  app.get('/weeks', async (c) => {
    const weeks = await getWeeklyFeatures(c.env.lydiard, {
      from: normalizeFrom(c.req.query('from')),
      to: normalizeTo(c.req.query('to')),
    });
    return c.json({ weeks });
  });

  app.get('/analysis', async (c) => {
    const analyses = await loadAnalyses(c.env);
    return c.json({ analyses, latest: analyses[analyses.length - 1] ?? null });
  });

  // Owner-triggered background refresh (single-athlete app). Returns immediately.
  app.post('/sync', async (c) => {
    const { runSync } = await import('../sync');
    const { updateSyncState } = await import('../db');
    c.executionCtx.waitUntil(
      runSync(c.env, c.env.lydiard).catch(async (error: unknown) => {
        await updateSyncState(c.env.lydiard, { last_error: error instanceof Error ? error.message : String(error) });
      }),
    );
    return c.json({ ok: true, message: 'Sync started.' }, 202);
  });

  // Garmin extraction runs in GitHub Actions because it needs Python, SQLite,
  // cached OAuth tokens, and FIT files. This owner-only endpoint dispatches the
  // same workflow used by the hourly schedule.
  app.post('/garmin/sync', async (c) => {
    try {
      const result = await dispatchGarminWorkflow(c.env);
      return c.json(
        {
          ok: true,
          alreadyRunning: result.alreadyRunning,
          runUrl: result.runUrl,
          message: result.alreadyRunning
            ? 'A Garmin sync is already queued or running.'
            : 'Garmin sync queued in GitHub Actions.',
        },
        202,
      );
    } catch (error) {
      if (error instanceof GarminDispatchConfigurationError) {
        return c.json({ error: error.message }, 503);
      }
      if (error instanceof GarminDispatchUpstreamError) {
        return c.json({ error: error.message }, 502);
      }
      throw error;
    }
  });

  app.post('/strava/disconnect', async (c) => {
    await clearAthleteConnection(c.env.lydiard);
    return c.json({ ok: true, message: 'Strava connection cleared. Existing training rows were kept.' });
  });

  return app;
}

function syncSource(lastResult: string | null): string | undefined {
  if (!lastResult) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(lastResult) as { source?: unknown };
    return typeof parsed.source === 'string' ? parsed.source : undefined;
  } catch {
    return undefined;
  }
}

function optionalPlanDate(value: string | undefined): string | undefined | null {
  if (value === undefined || value === '') {
    return undefined;
  }
  return requiredPlanDate(value) ?? null;
}

function requiredPlanDate(value: string): string | undefined {
  const date = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return undefined;
  }
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : undefined;
}

interface StoredBestEffortRow {
  distance_label: string;
  distance_km: number;
  activity_id: string;
  activity_name: string;
  start_date: string;
  start_date_local: string;
  seconds: number;
  pace_sec_per_km: number;
  source: BestEffortEntry['source'];
  segment_start_sec: number | null;
  segment_end_sec: number | null;
  effort_rank: number;
}

async function computeBestEfforts(
  db: D1Database,
  opts: { from?: string; to?: string },
): Promise<BestEffortDistance[]> {
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
  const where = clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : '';
  const rows = await db
    .prepare(
      `SELECT * FROM (
         SELECT e.distance_label, e.distance_km, e.activity_id, a.name AS activity_name,
                a.start_date, a.start_date_local, e.seconds, e.pace_sec_per_km, e.source,
                e.segment_start_sec, e.segment_end_sec,
                ROW_NUMBER() OVER (
                  PARTITION BY e.distance_label
                  ORDER BY e.seconds ASC, a.start_date DESC, e.activity_id ASC
                ) AS effort_rank
           FROM activity_best_efforts e
           JOIN activities a ON a.id = e.activity_id
          WHERE NOT EXISTS (
                  SELECT 1 FROM best_effort_rejections r
                   WHERE r.distance_label = e.distance_label AND r.activity_id = e.activity_id
                )
                ${where}
       ) ranked
       WHERE effort_rank <= 5
       ORDER BY distance_label, effort_rank`,
    )
    .bind(...binds)
    .all<StoredBestEffortRow>();
  const byLabel = new Map<string, BestEffortEntry[]>();
  for (const row of rows.results ?? []) {
    const efforts = byLabel.get(row.distance_label) ?? [];
    efforts.push({
      rank: row.effort_rank,
      activityId: row.activity_id,
      activityName: row.activity_name,
      startDate: row.start_date,
      startDateLocal: row.start_date_local,
      seconds: row.seconds,
      paceSecPerKm: row.pace_sec_per_km,
      source: row.source,
      segmentStartSec: row.segment_start_sec ?? undefined,
      segmentEndSec: row.segment_end_sec ?? undefined,
    });
    byLabel.set(row.distance_label, efforts);
  }
  return BEST_EFFORT_TARGETS.map((target) => ({ ...target, efforts: byLabel.get(target.label) ?? [] }));
}
