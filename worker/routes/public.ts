import { Hono } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import type { ActivityDetail, BestEffortDistance, BestEffortEntry, SyncStatus, WeeklyAnalysis } from '../../src/types';
import { analyzeWeeks } from '../../src/analysis/fatigue';
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
  getWeeklyFeatures,
} from '../db';
import { normalizeFrom, normalizeTo } from '../http';
import {
  dispatchGarminWorkflow,
  GarminDispatchConfigurationError,
  GarminDispatchUpstreamError,
} from '../garminDispatch';

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

  app.get('/activities/:id', async (c) => {
    const activity = await getActivity(c.env.lydiard, c.req.param('id'));
    if (!activity) {
      return c.json({ error: 'Activity not found' }, 404);
    }
    const streams = await getStreams(c.env.lydiard, activity.id);
    const detail: ActivityDetail = { ...activity, streams: streams ?? undefined };
    return c.json(detail);
  });

  app.get('/gym', async (c) => {
    const sessions = await getGymSessions(c.env.lydiard, {
      from: normalizeFrom(c.req.query('from')),
      to: normalizeTo(c.req.query('to')),
    });
    return c.json({ sessions });
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

const BEST_EFFORT_TARGETS = [
  { label: '5K', distanceKm: 5 },
  { label: '10K', distanceKm: 10 },
  { label: '15K', distanceKm: 15 },
  { label: 'Half', distanceKm: 21.0975 },
  { label: 'Marathon', distanceKm: 42.195 },
];

interface BestEffortRow {
  id: string;
  name: string;
  start_date: string;
  start_date_local: string;
  distance_km: number;
  moving_time_s: number;
  time_s: string | null;
  distance_m: string | null;
}

async function computeBestEfforts(
  db: D1Database,
  opts: { from?: string; to?: string },
): Promise<BestEffortDistance[]> {
  const clauses = ['a.distance_km >= ?1'];
  const binds: Array<string | number> = [Math.min(...BEST_EFFORT_TARGETS.map((target) => target.distanceKm)) * 0.98];
  if (opts.from) {
    binds.push(opts.from);
    clauses.push(`a.start_date >= ?${binds.length}`);
  }
  if (opts.to) {
    binds.push(opts.to);
    clauses.push(`a.start_date <= ?${binds.length}`);
  }

  const rows = await db
    .prepare(
      `SELECT a.id, a.name, a.start_date, a.start_date_local, a.distance_km, a.moving_time_s,
              s.time_s, s.distance_m
         FROM activities a
         LEFT JOIN activity_streams s ON s.activity_id = a.id
        WHERE ${clauses.join(' AND ')}
        ORDER BY a.start_date DESC`,
    )
    .bind(...binds)
    .all<BestEffortRow>();
  const activities = rows.results ?? [];

  return BEST_EFFORT_TARGETS.map((target) => {
    const efforts = activities
      .map((row) => effortForTarget(row, target.distanceKm))
      .filter((effort): effort is Omit<BestEffortEntry, 'rank'> => Boolean(effort))
      .sort((a, b) => a.seconds - b.seconds)
      .slice(0, 5)
      .map((effort, index) => ({ ...effort, rank: index + 1 }));
    return { ...target, efforts };
  });
}

function effortForTarget(row: BestEffortRow, distanceKm: number): Omit<BestEffortEntry, 'rank'> | null {
  if (row.distance_km < distanceKm * 0.98 || row.moving_time_s <= 0) {
    return null;
  }
  const targetM = distanceKm * 1000;
  const streamEffort = fastestStreamSegment(parseNumberArray(row.time_s), parseNumberArray(row.distance_m), targetM);
  const seconds = streamEffort?.seconds ?? (row.moving_time_s * distanceKm) / Math.max(row.distance_km, 0.001);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return {
    activityId: row.id,
    activityName: row.name,
    startDate: row.start_date,
    startDateLocal: row.start_date_local,
    seconds,
    paceSecPerKm: seconds / distanceKm,
    source: streamEffort ? 'stream' : 'whole_run',
    segmentStartSec: streamEffort?.startSec,
    segmentEndSec: streamEffort?.endSec,
  };
}

function fastestStreamSegment(
  timeValues: number[] | undefined,
  distanceValues: number[] | undefined,
  targetM: number,
): { seconds: number; startSec: number; endSec: number } | null {
  if (!timeValues || !distanceValues) {
    return null;
  }
  const n = Math.min(timeValues.length, distanceValues.length);
  if (n < 2) {
    return null;
  }

  const points: Array<{ time: number; distance: number }> = [];
  let lastTime = -Infinity;
  let lastDistance = -Infinity;
  for (let index = 0; index < n; index += 1) {
    const time = timeValues[index];
    const distance = distanceValues[index];
    if (!Number.isFinite(time) || !Number.isFinite(distance) || time <= lastTime || distance < lastDistance) {
      continue;
    }
    points.push({ time, distance });
    lastTime = time;
    lastDistance = distance;
  }
  if (points.length < 2 || points[points.length - 1].distance - points[0].distance < targetM * 0.98) {
    return null;
  }

  let best: { seconds: number; startSec: number; endSec: number } | null = null;
  let end = 1;
  for (let start = 0; start < points.length - 1; start += 1) {
    if (end <= start) {
      end = start + 1;
    }
    const targetDistance = points[start].distance + targetM;
    while (end < points.length && points[end].distance < targetDistance) {
      end += 1;
    }
    if (end >= points.length) {
      break;
    }
    const previous = points[Math.max(start, end - 1)];
    const current = points[end];
    const distanceDelta = current.distance - previous.distance;
    const ratio = distanceDelta > 0 ? (targetDistance - previous.distance) / distanceDelta : 0;
    const endSec = previous.time + Math.max(0, Math.min(1, ratio)) * (current.time - previous.time);
    const seconds = endSec - points[start].time;
    if (seconds > 0 && (!best || seconds < best.seconds)) {
      best = { seconds, startSec: points[start].time, endSec };
    }
  }
  return best;
}

function parseNumberArray(value: string | null): number[] | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is number => typeof item === 'number' && Number.isFinite(item)) : undefined;
  } catch {
    return undefined;
  }
}
