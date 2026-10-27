import { Hono } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import type { ActivityDetail, BestEffortDistance, BestEffortEntry, RecoveryNight, SyncStatus, WeeklyAnalysis } from '../../src/types';
import { analyzeWeeks } from '../../src/analysis/fatigue';
import { BEST_EFFORT_TARGETS } from '../../src/analysis/bestEfforts';
import { inferGoldenZone, recentEffortRange, RECENT_EFFORT_WINDOWS } from '../../src/analysis/bakken';
import type { Env } from '../env';
import {
  clearAthleteConnection,
  getActivities,
  getActivity,
  getAthlete,
  getCounts,
  getDateRange,
  getDailyCheckins,
  getDailyRecoveries,
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
import { parsePulse, savePulse } from '../checkins';
import {
  hasPushSubscription,
  parsePushSubscription,
  removePushSubscription,
  savePushSubscription,
  sendPushNotification,
  webPushConfigured,
} from '../webPush';
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

  app.get('/checkins', async (c) => {
    const checkins = await getDailyCheckins(c.env.lydiard, {
      from: normalizeFrom(c.req.query('from')),
      to: normalizeTo(c.req.query('to')),
    });
    return c.json({ checkins });
  });

  app.get('/recovery', async (c) => {
    const recoveries = await getDailyRecoveries(c.env.lydiard, {
      from: normalizeFrom(c.req.query('from')),
      to: normalizeTo(c.req.query('to')),
    });
    const nights: RecoveryNight[] = recoveries
      .filter((night) => night.sleepDurationMin !== undefined || night.hrvRmssdMs !== undefined)
      .map((night) => ({ day: night.day, sleepMin: night.sleepDurationMin, hrvMs: night.hrvRmssdMs }));
    return c.json({ nights });
  });

  app.post('/checkins', async (c) => {
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
    const day = typeof body.day === 'string' ? body.day : '';
    const timestamp = Date.parse(`${day}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== day) {
      return c.json({ error: 'day must be a real date in YYYY-MM-DD form.' }, 400);
    }
    const pulse = parsePulse(body);
    if (pulse instanceof Error) return c.json({ error: pulse.message }, 400);
    const checkin = await savePulse(c.env.lydiard, day, pulse, 'platform');
    return c.json({ checkin }, 201);
  });

  app.get('/push/config', async (c) => c.json({
    enabled: webPushConfigured(c.env),
    publicKey: webPushConfigured(c.env) ? c.env.VAPID_PUBLIC_KEY : null,
    subscribed: c.req.query('endpoint')
      ? await hasPushSubscription(c.env.lydiard, c.req.query('endpoint')!)
      : false,
  }));

  app.post('/push/subscribe', async (c) => {
    if (!webPushConfigured(c.env)) return c.json({ error: 'Phone reminders are not configured yet.' }, 503);
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: 'Request body must be JSON.' }, 400);
    }
    const subscription = parsePushSubscription(payload);
    if (subscription instanceof Error) return c.json({ error: subscription.message }, 400);
    const endpointHash = await savePushSubscription(c.env.lydiard, subscription, c.req.header('User-Agent') ?? '');
    const delivered = await sendPushNotification(c.env, { ...subscription, endpointHash }, {
      title: 'Lydiard reminders are on',
      body: 'You’ll get one short daily pulse. Tap it to check in.',
      url: `${c.env.CHECKIN_BASE_URL?.replace(/\/$/, '') ?? new URL(c.req.url).origin}/?view=log`,
      tag: 'lydiard-reminders-ready',
    }, 'reminders-ready');
    return c.json({ subscribed: await hasPushSubscription(c.env.lydiard, subscription.endpoint), delivered }, 201);
  });

  app.post('/push/unsubscribe', async (c) => {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: 'Request body must be JSON.' }, 400);
    }
    const endpoint = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).endpoint
      : undefined;
    if (typeof endpoint !== 'string' || !endpoint.startsWith('https://')) {
      return c.json({ error: 'A valid subscription endpoint is required.' }, 400);
    }
    await removePushSubscription(c.env.lydiard, endpoint);
    return c.json({ subscribed: false });
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

  app.get('/best-efforts/recent', async (c) => {
    const now = new Date();
    // One indexed 90-day read serves every window; do not scan all history
    // three times with date functions or SQL window rankings.
    const oldest = recentEffortRange(90, now).from;
    const rows = await loadBestEffortRows(c.env.lydiard, {
      from: `${oldest}T00:00:00`, to: now.toISOString(), streamOnly: true,
    });
    const windows = RECENT_EFFORT_WINDOWS.map((days) => {
      const range = recentEffortRange(days, now);
      const distances = rankBestEfforts(rows.filter((row) => row.start_date >= `${range.from}T00:00:00`));
      return { days, ...range, distances, goldenZone: inferGoldenZone(distances) };
    });
    return c.json({ asOf: now.toISOString(), windows });
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
}

const BEST_EFFORT_COLUMNS = `e.distance_label, e.distance_km, e.activity_id, a.name AS activity_name,
  a.start_date, a.start_date_local, e.seconds, e.pace_sec_per_km, e.source,
  e.segment_start_sec, e.segment_end_sec`;
const ACCEPTED_BEST_EFFORT = `NOT EXISTS (
  SELECT 1 FROM best_effort_rejections r
  WHERE r.distance_label = e.distance_label AND r.activity_id = e.activity_id
)`;

async function loadBestEffortRows(
  db: D1Database,
  opts: { from?: string; to?: string; streamOnly?: boolean },
): Promise<StoredBestEffortRow[]> {
  const clauses = [ACCEPTED_BEST_EFFORT];
  const binds: string[] = [];
  if (opts.streamOnly) clauses.push("e.source = 'stream'");
  if (opts.from) {
    binds.push(opts.from);
    clauses.push(`a.start_date >= ?${binds.length}`);
  }
  if (opts.to) {
    binds.push(opts.to);
    clauses.push(`a.start_date <= ?${binds.length}`);
  }
  // CROSS JOIN keeps the small, date-indexed activities range on the outer
  // loop. The efforts primary key then looks up each activity's distances.
  const rows = await db.prepare(`SELECT ${BEST_EFFORT_COLUMNS}
    FROM activities a INDEXED BY idx_activities_start
    CROSS JOIN activity_best_efforts e ON e.activity_id = a.id
    WHERE ${clauses.join(' AND ')}`).bind(...binds).all<StoredBestEffortRow>();
  return rows.results ?? [];
}

async function computeBestEfforts(
  db: D1Database,
  opts: { from?: string; to?: string },
): Promise<BestEffortDistance[]> {
  if (opts.from || opts.to) return rankBestEfforts(await loadBestEffortRows(db, opts));
  // Seek directly to each distance's fastest efforts and stop at five.
  // This avoids ranking every persisted effort for the all-time panel.
  const groups = await Promise.all(BEST_EFFORT_TARGETS.map(async (target) => {
    const rows = await db.prepare(`SELECT ${BEST_EFFORT_COLUMNS}
      FROM activity_best_efforts e INDEXED BY idx_activity_best_efforts_distance_time
      CROSS JOIN activities a ON a.id = e.activity_id
      WHERE e.distance_label = ?1 AND ${ACCEPTED_BEST_EFFORT}
      ORDER BY e.seconds ASC, a.start_date DESC, e.activity_id ASC LIMIT 5`)
      .bind(target.label).all<StoredBestEffortRow>();
    return rows.results ?? [];
  }));
  return rankBestEfforts(groups.flat());
}

function rankBestEfforts(rows: StoredBestEffortRow[]): BestEffortDistance[] {
  const sorted = [...rows].sort((a, b) => a.seconds - b.seconds
    || (a.start_date > b.start_date ? -1 : a.start_date < b.start_date ? 1 : 0)
    || (a.activity_id < b.activity_id ? -1 : a.activity_id > b.activity_id ? 1 : 0));
  const byLabel = new Map<string, BestEffortEntry[]>();
  for (const row of sorted) {
    const efforts = byLabel.get(row.distance_label) ?? [];
    if (efforts.length >= 5) continue;
    efforts.push({
      rank: efforts.length + 1,
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
