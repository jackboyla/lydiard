import { Hono } from 'hono';
import type { ActivityLap, ActivityStreams, ActivitySummary, GymSession } from '../../src/types';
import type { Env } from '../env';
import {
  getActivitiesByLocalDateRange,
  getTrainingPlanDays,
  importTrainingPlanDays,
  replaceTrainingData,
  upsertActivities,
  saveStreams,
  updateSyncState,
  replaceGymSessions,
  saveActivityLaps,
  upsertGymSessions,
  type TrainingPlanImportInput,
} from '../db';
import { matchPlanActualDurations } from '../../src/data/planMatching';
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

interface GymIngestPayload {
  source?: string;
  replace?: boolean;
  sessions?: GymSession[];
}

interface LapIngestPayload {
  activities?: Array<{
    activityId: string;
    laps: ActivityLap[];
  }>;
}

interface PlanIngestPayload {
  source?: unknown;
  overwrite?: unknown;
  dryRun?: unknown;
  requireActualMatches?: unknown;
  days?: unknown;
}

interface PlanMatchReport {
  date: string;
  expectedActivities: number;
  candidateActivities: number;
  matchedActivities: number;
  matched: boolean;
  maxDeltaMinutes: number | null;
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

  // Historical device laps can be backfilled without replacing summaries or
  // high-resolution streams. The activity must already exist (enforced by D1).
  app.post('/laps', async (c) => {
    let payload: LapIngestPayload;
    try {
      payload = (await c.req.json()) as LapIngestPayload;
    } catch {
      return c.json({ error: 'Request body must be JSON.' }, 400);
    }

    const activities = payload.activities ?? [];
    if (activities.length === 0 || activities.length > 100) {
      return c.json({ error: 'Provide between 1 and 100 activities.' }, 400);
    }
    for (const activity of activities) {
      if (!activity.activityId?.trim()) return c.json({ error: 'Every activity requires an activityId.' }, 400);
      if (!Array.isArray(activity.laps) || activity.laps.length === 0 || activity.laps.length > 500) {
        return c.json({ error: `${activity.activityId} must contain between 1 and 500 laps.` }, 400);
      }
      const invalidLap = activity.laps.find((lap) => !validActivityLap(lap));
      if (invalidLap) return c.json({ error: `${activity.activityId} contains an invalid lap.` }, 400);
    }

    for (const activity of activities) {
      await saveActivityLaps(c.env.lydiard, activity.activityId, activity.laps);
    }
    return c.json({ ok: true, activitiesUpdated: activities.length, finishedAt: new Date().toISOString() });
  });

  // Gym / strength sessions live in a separate table and never touch the run
  // load model. This endpoint only writes gym_sessions.
  app.post('/gym', async (c) => {
    let payload: GymIngestPayload;
    try {
      payload = (await c.req.json()) as GymIngestPayload;
    } catch {
      return c.json({ error: 'Request body must be JSON.' }, 400);
    }

    const sessions = payload.sessions ?? [];
    if (sessions.length === 0) {
      return c.json({ error: 'No gym sessions provided.' }, 400);
    }

    const clean: GymSession[] = [];
    for (const session of sessions) {
      const error = validateGymSession(session);
      if (error) {
        return c.json({ error }, 400);
      }
      clean.push(session);
    }

    if (payload.replace) {
      await replaceGymSessions(c.env.lydiard);
    }
    await upsertGymSessions(c.env.lydiard, clean);

    return c.json({
      ok: true,
      source: payload.source ?? 'external',
      replace: Boolean(payload.replace),
      upserted: clean.length,
      finishedAt: new Date().toISOString(),
    });
  });

  app.post('/plan', async (c) => {
    let payload: PlanIngestPayload;
    try {
      payload = (await c.req.json()) as PlanIngestPayload;
    } catch {
      return c.json({ error: 'Request body must be JSON.' }, 400);
    }

    const payloadError = validatePlanPayload(payload);
    if (payloadError) {
      return c.json({ error: payloadError }, 400);
    }

    const source = typeof payload.source === 'string' ? payload.source.trim() : 'legacy-google-sheet';
    const overwrite = payload.overwrite === true;
    const dryRun = payload.dryRun === true;
    const requireActualMatches = payload.requireActualMatches === true;
    const rawDays = payload.days as Array<Record<string, unknown>>;
    const cleanDays: TrainingPlanImportInput[] = rawDays.map((raw) => ({
      date: (raw.date as string).trim(),
      plannedText: raw.plannedText as string,
      legacyActualText: raw.legacyActualText as string,
      notes: raw.notes as string,
      sourceFile: (raw.sourceFile as string).trim(),
    }));

    const firstDate = cleanDays.reduce((lowest, day) => (day.date < lowest ? day.date : lowest), cleanDays[0].date);
    const lastDate = cleanDays.reduce((highest, day) => (day.date > highest ? day.date : highest), cleanDays[0].date);
    const [activities, storedDays] = await Promise.all([
      getActivitiesByLocalDateRange(c.env.lydiard, { from: firstDate, to: lastDate }),
      getTrainingPlanDays(c.env.lydiard, { from: firstDate, to: lastDate }),
    ]);
    const storedDates = new Set(storedDays.map((day) => day.date));
    // A safe no-overwrite rerun validates only rows it could insert. Existing
    // rows may refer to older Garmin history that is no longer in the query
    // window, and must not make an otherwise no-op rerun fail preflight.
    const daysToImport = overwrite ? cleanDays : cleanDays.filter((day) => !storedDates.has(day.date));
    const activitiesByDate = new Map<string, typeof activities>();
    for (const activity of activities) {
      const date = (activity.startDateLocal || activity.startDate).slice(0, 10);
      const bucket = activitiesByDate.get(date);
      if (bucket) {
        bucket.push(activity);
      } else {
        activitiesByDate.set(date, [activity]);
      }
    }

    const reports: PlanMatchReport[] = [];
    let actualRows = 0;
    let matchedRows = 0;
    let matchedActivities = 0;
    let maxDeltaMinutes: number | null = null;
    const unmatchedDates: string[] = [];
    for (const day of daysToImport) {
      const candidates = activitiesByDate.get(day.date) ?? [];
      const match = matchPlanActualDurations(day.legacyActualText, candidates);
      if (match.expectedMinutes.length === 0) {
        if (day.legacyActualText.trim().length > 0) {
          actualRows += 1;
          unmatchedDates.push(day.date);
          reports.push({
            date: day.date,
            expectedActivities: 0,
            candidateActivities: match.actualMinutes.length,
            matchedActivities: 0,
            matched: false,
            maxDeltaMinutes: null,
          });
        }
        continue;
      }
      actualRows += 1;
      matchedActivities += match.pairs.length;
      if (match.matched) {
        matchedRows += 1;
      } else {
        unmatchedDates.push(day.date);
      }
      if (match.maxDeltaMinutes !== null) {
        maxDeltaMinutes = maxDeltaMinutes === null
          ? match.maxDeltaMinutes
          : Math.max(maxDeltaMinutes, match.maxDeltaMinutes);
      }
      reports.push({
        date: day.date,
        expectedActivities: match.expectedMinutes.length,
        candidateActivities: match.actualMinutes.length,
        matchedActivities: match.pairs.length,
        matched: match.matched,
        maxDeltaMinutes: roundedDelta(match.maxDeltaMinutes),
      });
    }

    const wouldImport = daysToImport.length;
    const summary = {
      source,
      overwrite,
      dryRun,
      requireActualMatches,
      imported: 0,
      wouldImport,
      actualRows,
      matchedRows,
      matchedActivities,
      maxDeltaMinutes: roundedDelta(maxDeltaMinutes),
      unmatchedDates,
      reports,
    };

    if (requireActualMatches && unmatchedDates.length > 0) {
      return c.json(
        {
          ok: false,
          error: 'Plan import preflight found Actual rows without parseable, matching same-date Garmin durations.',
          ...summary,
        },
        409,
      );
    }

    if (dryRun) {
      return c.json({ ok: true, ...summary });
    }

    const imported = await importTrainingPlanDays(c.env.lydiard, daysToImport, { source, overwrite });
    return c.json({
      ok: true,
      ...summary,
      imported,
      finishedAt: new Date().toISOString(),
    });
  });

  return app;
}

function validActivityLap(lap: ActivityLap): boolean {
  if (!lap || !Number.isInteger(lap.index) || lap.index < 1) return false;
  if (!finiteInRange(lap.distanceM, 0, 1_000_000) || !finiteInRange(lap.durationSec, 0, 604_800)) return false;
  return [lap.elapsedSec, lap.averageHeartRate, lap.maxHeartRate, lap.averagePower, lap.maxPower, lap.averageSpeedMps]
    .every((value) => value === undefined || (Number.isFinite(value) && value >= 0));
}

function finiteInRange(value: number, minExclusive: number, maxInclusive: number): boolean {
  return Number.isFinite(value) && value > minExclusive && value <= maxInclusive;
}

function validateGymSession(session: GymSession | undefined): string | null {
  if (!session) {
    return 'Gym session is missing.';
  }
  if (!session.id || !session.name || !session.sportType) {
    return 'Gym session must include id, name, and sportType.';
  }
  if (!Number.isFinite(new Date(session.startDate).getTime())) {
    return `Gym session ${session.id} has an invalid startDate.`;
  }
  if (!Number.isFinite(session.durationSec) || session.durationSec < 0) {
    return `Gym session ${session.id} has an invalid durationSec.`;
  }
  return null;
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

function validatePlanPayload(payload: PlanIngestPayload): string | null {
  if (!payload || typeof payload !== 'object') {
    return 'Request body must be an object.';
  }
  if (payload.source !== undefined) {
    if (typeof payload.source !== 'string' || payload.source.trim() === '' || payload.source.length > 100) {
      return 'source must be a non-empty string of at most 100 characters.';
    }
  }
  for (const field of ['overwrite', 'dryRun', 'requireActualMatches'] as const) {
    if (payload[field] !== undefined && typeof payload[field] !== 'boolean') {
      return `${field} must be a boolean.`;
    }
  }
  if (!Array.isArray(payload.days) || payload.days.length === 0) {
    return 'days must be a non-empty array.';
  }
  if (payload.days.length > 1000) {
    return 'A plan import is limited to 1000 days.';
  }
  if (payload.dryRun !== true && payload.days.length > 40) {
    return 'A plan write is limited to 40 days; split larger imports into smaller files or batches.';
  }

  const seenDates = new Set<string>();
  for (const [index, value] of payload.days.entries()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return `days[${index}] must be an object.`;
    }
    const day = value as Record<string, unknown>;
    if (typeof day.date !== 'string' || !validPlanDate(day.date.trim())) {
      return `days[${index}].date must use YYYY-MM-DD.`;
    }
    const date = day.date.trim();
    if (seenDates.has(date)) {
      return `Duplicate plan date: ${date}.`;
    }
    seenDates.add(date);
    if (typeof day.plannedText !== 'string') {
      return `days[${index}].plannedText must be a string.`;
    }
    if (day.plannedText.length > 20_000) {
      return `days[${index}].plannedText must not exceed 20000 characters.`;
    }
    if (typeof day.legacyActualText !== 'string') {
      return `days[${index}].legacyActualText must be a string.`;
    }
    if (day.legacyActualText.length > 20_000) {
      return `days[${index}].legacyActualText must not exceed 20000 characters.`;
    }
    if (typeof day.notes !== 'string') {
      return `days[${index}].notes must be a string.`;
    }
    if (day.notes.length > 100_000) {
      return `days[${index}].notes must not exceed 100000 characters.`;
    }
    if (
      typeof day.sourceFile !== 'string' ||
      day.sourceFile.trim() === '' ||
      day.sourceFile.trim().length > 500 ||
      day.sourceFile.includes('\0')
    ) {
      return `days[${index}].sourceFile must be a non-empty filename of at most 500 characters.`;
    }
  }
  return null;
}

function validPlanDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function roundedDelta(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(3));
}
