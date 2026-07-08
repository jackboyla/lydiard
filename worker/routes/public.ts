import { Hono } from 'hono';
import type { ActivityDetail, SyncStatus, WeeklyAnalysis } from '../../src/types';
import { analyzeWeeks } from '../../src/analysis/fatigue';
import type { Env } from '../env';
import {
  clearAthleteConnection,
  getActivities,
  getActivity,
  getAthlete,
  getCounts,
  getDateRange,
  getStreams,
  getSyncState,
  getWeeklyFeatures,
} from '../db';
import { normalizeFrom, normalizeTo } from '../http';

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

  app.get('/activities/:id', async (c) => {
    const activity = await getActivity(c.env.lydiard, c.req.param('id'));
    if (!activity) {
      return c.json({ error: 'Activity not found' }, 404);
    }
    const streams = await getStreams(c.env.lydiard, activity.id);
    const detail: ActivityDetail = { ...activity, streams: streams ?? undefined };
    return c.json(detail);
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

  app.post('/strava/disconnect', async (c) => {
    await clearAthleteConnection(c.env.lydiard);
    return c.json({ ok: true, message: 'Strava connection cleared. Existing training rows were kept.' });
  });

  return app;
}
