import { Hono } from 'hono';
import type { ActivityStreams, ActivitySummary } from '../../src/types';
import type { Env } from '../env';
import { replaceTrainingData, upsertActivities, saveStreams, updateSyncState } from '../db';
import { computeDecoupling } from '../streams';
import { recomputeWeeklyFeatures } from '../sync';

interface IngestActivity {
  summary: ActivitySummary;
  streams?: ActivityStreams;
}

interface IngestPayload {
  source?: string;
  replace?: boolean;
  recomputeWeeks?: boolean;
  activities?: IngestActivity[];
}

export function ingestRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.use('*', async (c, next) => {
    const expected = c.env.INGEST_API_KEY || c.env.AGENT_API_KEY;
    const header = c.req.header('Authorization') ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!expected || bearer !== expected) {
      return c.json({ error: 'Unauthorized. Provide the ingest key via Bearer header.' }, 401);
    }
    await next();
  });

  app.post('/activities', async (c) => {
    let payload: IngestPayload;
    try {
      payload = (await c.req.json()) as IngestPayload;
    } catch {
      return c.json({ error: 'Request body must be JSON.' }, 400);
    }

    const activities = payload.activities ?? [];
    if (activities.length === 0) {
      return c.json({ error: 'No activities provided.' }, 400);
    }

    const summaries: ActivitySummary[] = [];
    for (const activity of activities) {
      const error = validateSummary(activity.summary);
      if (error) {
        return c.json({ error }, 400);
      }
      summaries.push({
        ...activity.summary,
        hasStreams: Boolean(activity.streams?.timeSec?.length || activity.streams?.latlng?.length),
      });
    }

    if (payload.replace) {
      await replaceTrainingData(c.env.lydiard);
    }

    await upsertActivities(c.env.lydiard, summaries);

    let streamsSaved = 0;
    for (const activity of activities) {
      if (activity.streams) {
        await saveStreams(c.env.lydiard, activity.summary.id, activity.streams, computeDecoupling(activity.streams));
        streamsSaved += 1;
      }
    }

    const recomputeWeeks = payload.recomputeWeeks !== false;
    const weekCount = recomputeWeeks ? await recomputeWeeklyFeatures(c.env.lydiard) : null;
    const latestDate = summaries.reduce<string | null>((latest, activity) => {
      return !latest || activity.startDate > latest ? activity.startDate : latest;
    }, null);
    const result = {
      source: payload.source ?? 'external',
      replace: Boolean(payload.replace),
      recomputeWeeks,
      upserted: summaries.length,
      streamsSaved,
      weekCount,
      finishedAt: new Date().toISOString(),
    };

    if (recomputeWeeks) {
      await updateSyncState(c.env.lydiard, {
        last_sync_at: result.finishedAt,
        last_activity_date: latestDate ?? undefined,
        last_result: JSON.stringify(result),
        last_error: null,
      });
    }

    return c.json({ ok: true, ...result });
  });

  return app;
}

function validateSummary(summary: ActivitySummary | undefined): string | null {
  if (!summary) {
    return 'Activity is missing summary.';
  }
  if (!summary.id || !summary.name || !summary.sportType) {
    return 'Activity summary must include id, name, and sportType.';
  }
  if (!Number.isFinite(new Date(summary.startDate).getTime())) {
    return `Activity ${summary.id} has an invalid startDate.`;
  }
  if (!Number.isFinite(summary.distanceKm) || summary.distanceKm <= 0) {
    return `Activity ${summary.id} has an invalid distanceKm.`;
  }
  if (!Number.isFinite(summary.movingTimeSec) || summary.movingTimeSec <= 0) {
    return `Activity ${summary.id} has an invalid movingTimeSec.`;
  }
  return null;
}
