import type { D1Database } from '@cloudflare/workers-types';
import type { ActivitySummary } from '../src/types';
import { buildImportedTrainingFromActivities } from '../src/data/deriveWeekly';
import type { Env } from './env';
import { fetchYears, streamsPerRun } from './env';
import {
  getActivitiesForWeeklyFeatures,
  getActivitiesNeedingStreams,
  getSyncState,
  replaceWeeklyFeatures,
  saveStreams,
  updateSyncState,
  upsertActivities,
  type StoredActivity,
} from './db';
import {
  ensureAccessToken,
  fetchActivities,
  fetchStreams,
  mapActivityToSummary,
  type RateLimit,
} from './strava';
import { computeDecoupling, normalizeStreams } from './streams';

export interface SyncResult {
  fetched: number;
  upserted: number;
  streamsFetched: number;
  weekCount: number;
  rateLimitedStop: boolean;
  startedAt: string;
  finishedAt: string;
}

const OVERLAP_MS = 2 * 24 * 60 * 60 * 1000; // re-fetch a 2-day window to catch edits

export async function runSync(env: Env, db: D1Database, options: { force?: boolean } = {}): Promise<SyncResult> {
  const startedAt = new Date().toISOString();
  const accessToken = await ensureAccessToken(env, db);
  const state = await getSyncState(db);

  const afterUnix = computeAfter(state.last_activity_date, options.force ?? false, fetchYears(env));
  const rawActivities = await fetchActivities(accessToken, afterUnix);
  const summaries = rawActivities
    .map(mapActivityToSummary)
    .filter((activity): activity is ActivitySummary => activity !== null);

  await upsertActivities(db, summaries);

  const latestDate = summaries.reduce<string | null>((latest, activity) => {
    return !latest || activity.startDate > latest ? activity.startDate : latest;
  }, state.last_activity_date ?? null);

  // Backfill streams for activities that don't have them yet (rate-limit aware).
  const pending = await getActivitiesNeedingStreams(db, streamsPerRun(env));
  let streamsFetched = 0;
  let rateLimitedStop = false;
  let lastRateLimit: RateLimit | null = null;

  for (const activity of pending) {
    if (lastRateLimit && lastRateLimit.shortUsage >= lastRateLimit.shortLimit - 5) {
      rateLimitedStop = true;
      break;
    }
    const result = await fetchStreams(accessToken, activity.id);
    lastRateLimit = result.rateLimit ?? lastRateLimit;

    if (result.status === 429) {
      rateLimitedStop = true;
      break;
    }
    if (result.status === 404 || !result.streams) {
      // No stream data (e.g. manual entry). Mark as processed so we don't retry forever.
      await saveStreams(db, activity.id, {}, undefined);
      continue;
    }

    const normalized = normalizeStreams(result.streams);
    const decoupling = isRunLike(activity) ? computeDecoupling(normalized) : undefined;
    await saveStreams(db, activity.id, normalized, decoupling);
    streamsFetched += 1;
  }

  // Recompute weekly features from the full stored history.
  const weekCount = await recomputeWeeklyFeatures(db);

  const finishedAt = new Date().toISOString();
  const result: SyncResult = {
    fetched: rawActivities.length,
    upserted: summaries.length,
    streamsFetched,
    weekCount,
    rateLimitedStop,
    startedAt,
    finishedAt,
  };

  await updateSyncState(db, {
    last_sync_at: finishedAt,
    last_activity_date: latestDate ?? undefined,
    last_result: JSON.stringify(result),
    last_error: null,
    rate_limit: lastRateLimit ? JSON.stringify(lastRateLimit) : undefined,
  });

  return result;
}

export async function recomputeWeeklyFeatures(db: D1Database): Promise<number> {
  const activities = await getActivitiesForWeeklyFeatures(db);
  const hasGarmin = activities.some((activity) => activity.id.startsWith('garmin-'));
  const source = hasGarmin ? 'garmin' : 'strava';
  try {
    const training = buildImportedTrainingFromActivities(
      activities,
      source,
      hasGarmin ? 'garmin-health-data SQLite' : 'Strava API',
    );
    await replaceWeeklyFeatures(db, training.weeks);
    return training.weeks.length;
  } catch {
    // Not enough running weeks yet (needs >= 4). Leave existing features in place.
    return 0;
  }
}

function isRunLike(activity: StoredActivity): boolean {
  return /run|jog|race/i.test(`${activity.sportType} ${activity.name}`);
}

function computeAfter(lastActivityDate: string | null, force: boolean, years: number): number {
  if (!force && lastActivityDate) {
    const last = new Date(lastActivityDate).getTime();
    if (Number.isFinite(last)) {
      return Math.floor((last - OVERLAP_MS) / 1000);
    }
  }
  return Math.floor((Date.now() - years * 365.25 * 24 * 60 * 60 * 1000) / 1000);
}
