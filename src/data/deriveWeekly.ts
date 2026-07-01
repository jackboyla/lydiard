// Pure, runtime-agnostic training derivation.
//
// This module has NO browser or Node dependencies (no papaparse, no DOM, no fs)
// so it can run unchanged in the Cloudflare Worker AND the React frontend.
// The CSV/papaparse import path lives in ./importActivities and re-exports from here.

import type { DataSource, WeeklyRunBlock } from '../types';

export interface ImportedActivity {
  id: string;
  name: string;
  type: string;
  date: Date;
  distanceKm: number;
  movingTimeSec: number;
  elapsedTimeSec: number;
  averageHeartRate?: number;
  averageCadenceSpm?: number;
  elevationGainM: number;
  relativeEffort?: number;
  hrvMs?: number;
  sleepHours?: number;
  /**
   * True first-half/second-half HR-pace decoupling (%) derived from activity
   * streams. When present it replaces the summary aerobic-cost proxy in the
   * weekly rollup and flips dataCompleteness.streams to true for that week.
   */
  decouplingPct?: number;
}

export interface ImportedTrainingData {
  source: DataSource;
  fileName: string;
  importedAt: string;
  activityCount: number;
  runCount: number;
  weekCount: number;
  dateRangeLabel: string;
  warnings: string[];
  weeks: WeeklyRunBlock[];
}

interface WeekDraft extends Omit<WeeklyRunBlock, 'acuteLoad' | 'chronicLoad' | 'acRatio'> {
  trainingLoad: number;
}

export function buildImportedTrainingFromActivities(
  activities: ImportedActivity[],
  source: DataSource,
  fileName: string,
): ImportedTrainingData {
  const runs = activities.filter((activity) => isRunningActivity(activity));

  if (runs.length === 0) {
    throw new Error('No running activities were found in that file.');
  }

  const weeks = activitiesToWeeklyBlocks(runs, source, fileName);

  if (weeks.length < 4) {
    throw new Error('At least four running weeks are needed for personal-baseline analysis.');
  }

  const warnings = buildWarnings(runs, weeks);
  const sortedRuns = [...runs].sort((a, b) => a.date.getTime() - b.date.getTime());
  const firstDate = sortedRuns[0].date;
  const lastDate = sortedRuns[sortedRuns.length - 1].date;

  return {
    source,
    fileName,
    importedAt: new Date().toISOString(),
    activityCount: activities.length,
    runCount: runs.length,
    weekCount: weeks.length,
    dateRangeLabel: `${formatShortDate(firstDate)} - ${formatShortDate(lastDate)}`,
    warnings,
    weeks,
  };
}

function activitiesToWeeklyBlocks(
  activities: ImportedActivity[],
  source: DataSource,
  fileName: string,
): WeeklyRunBlock[] {
  const sorted = [...activities].sort((a, b) => a.date.getTime() - b.date.getTime());
  const grouped = new Map<string, ImportedActivity[]>();

  sorted.forEach((activity) => {
    const weekId = toWeekId(activity.date);
    const existing = grouped.get(weekId) ?? [];
    existing.push(activity);
    grouped.set(weekId, existing);
  });

  const allPaces = sorted.map(activityPace).filter(isFinitePositive);
  const allHeartRates = sorted.map((activity) => activity.averageHeartRate).filter(isUsefulHeartRate);
  const allCadences = sorted.map((activity) => activity.averageCadenceSpm).filter(isFinitePositive);
  const allLoads = sorted.map((activity) => activity.relativeEffort).filter(isFinitePositive);
  const medianHeartRate = percentile(allHeartRates, 0.5) ?? 140;
  const easyHeartRateCeiling = percentile(allHeartRates, 0.55) ?? medianHeartRate;
  const medianPace = percentile(allPaces, 0.5) ?? 300;
  const fastPaceCutoff = percentile(allPaces, 0.25) ?? medianPace * 0.92;
  const hardLoadCutoff = percentile(allLoads, 0.75);
  const hasHeartRate = allHeartRates.length >= Math.max(3, sorted.length * 0.25);
  const hasCadence = allCadences.length >= Math.max(3, sorted.length * 0.25);
  const hasRecovery = sorted.some((activity) => activity.hrvMs || activity.sleepHours);

  const drafts: WeekDraft[] = [...grouped.entries()].map(([weekId, weekActivities]) => {
    const totalDistance = sum(weekActivities.map((activity) => activity.distanceKm));
    const totalMovingTime = sum(weekActivities.map((activity) => activity.movingTimeSec));
    const easyActivities = chooseEasyActivities(weekActivities, hasHeartRate, easyHeartRateCeiling, medianPace);
    const easyPace = weightedPace(easyActivities.length > 0 ? easyActivities : weekActivities);
    const easyHeartRate = weightedAverage(
      easyActivities
        .filter((activity) => isUsefulHeartRate(activity.averageHeartRate))
        .map((activity) => [activity.averageHeartRate as number, activity.movingTimeSec] as const),
    ) ?? medianHeartRate;
    const cadenceSpm =
      weightedAverage(
        weekActivities
          .filter((activity) => isFinitePositive(activity.averageCadenceSpm))
          .map((activity) => [activity.averageCadenceSpm as number, activity.movingTimeSec] as const),
      ) ??
      percentile(allCadences, 0.5) ??
      180;
    const strideLengthCm = Math.round(6000000 / (easyPace * cadenceSpm));
    const qualitySessions = weekActivities.filter((activity) =>
      isQualitySession(activity, fastPaceCutoff, hardLoadCutoff),
    ).length;
    const relativeEffortLoad = sum(weekActivities.map((activity) => activity.relativeEffort ?? 0));
    const trainingLoad =
      relativeEffortLoad > 0
        ? Math.round(relativeEffortLoad)
        : Math.round(totalDistance * 4.8 + sum(weekActivities.map((activity) => activity.elevationGainM)) * 0.025 + qualitySessions * 35);
    const weekStart = parseWeekId(weekId);
    const thresholdPace = estimateThresholdPace(sorted, weekStart, fastPaceCutoff, easyPace);
    const hrvMs =
      weightedAverage(
        weekActivities
          .filter((activity) => isFinitePositive(activity.hrvMs))
          .map((activity) => [activity.hrvMs as number, 1] as const),
      ) ?? 70;
    const sleepHours =
      weightedAverage(
        weekActivities
          .filter((activity) => isFinitePositive(activity.sleepHours))
          .map((activity) => [activity.sleepHours as number, 1] as const),
      ) ?? 7;

    // Prefer true stream-derived decoupling (moving-time weighted) when available,
    // otherwise fall back to the summary aerobic-cost proxy (pace per heartbeat).
    const streamDecoupling = weightedAverage(
      weekActivities
        .filter((activity) => isFinitePositive(activity.decouplingPct))
        .map((activity) => [activity.decouplingPct as number, activity.movingTimeSec] as const),
    );
    const weekHasStreams = weekActivities.some((activity) => isFinitePositive(activity.decouplingPct));

    return {
      id: weekId,
      weekStart: weekId,
      label: formatWeekLabel(weekStart),
      year: weekStart.getFullYear(),
      distanceKm: Math.round(totalDistance),
      durationHours: Number((totalMovingTime / 3600).toFixed(1)),
      trainingLoad,
      easyPaceSecPerKm: Math.round(easyPace),
      easyHeartRate: Math.round(easyHeartRate),
      thresholdPaceSecPerKm: Math.round(thresholdPace),
      strideLengthCm,
      cadenceSpm: Math.round(cadenceSpm),
      hrPaceDecouplingPct:
        streamDecoupling !== undefined
          ? Number(streamDecoupling.toFixed(1))
          : Number(((easyPace / easyHeartRate) * 3).toFixed(1)),
      hrvMs: Math.round(hrvMs),
      sleepHours: Number(sleepHours.toFixed(1)),
      elevationGainM: Math.round(sum(weekActivities.map((activity) => activity.elevationGainM))),
      qualitySessions,
      longRunKm: Math.round(Math.max(...weekActivities.map((activity) => activity.distanceKm))),
      source,
      sourceDetail: fileName,
      activityCount: weekActivities.length,
      dataCompleteness: {
        heartRate: hasHeartRate,
        cadence: hasCadence,
        recovery: hasRecovery,
        streams: weekHasStreams,
      },
      notes: buildWeekNotes(hasHeartRate, hasCadence, hasRecovery),
    };
  });

  return drafts.map((draft, index) => {
    const acuteLoad = Math.round(mean(drafts.slice(Math.max(0, index - 3), index + 1).map((week) => week.trainingLoad)));
    const chronicLoad = Math.round(mean(drafts.slice(Math.max(0, index - 7), index + 1).map((week) => week.trainingLoad)));

    return {
      ...draft,
      acuteLoad,
      chronicLoad,
      acRatio: chronicLoad > 0 ? Number((acuteLoad / chronicLoad).toFixed(2)) : 1,
    };
  });
}

function chooseEasyActivities(
  activities: ImportedActivity[],
  hasHeartRate: boolean,
  heartRateCeiling: number,
  medianPace: number,
): ImportedActivity[] {
  const eligible = activities.filter((activity) => activity.distanceKm >= 3);

  if (hasHeartRate) {
    const heartRateFiltered = eligible.filter(
      (activity) => activity.averageHeartRate && activity.averageHeartRate <= heartRateCeiling + 4,
    );

    if (heartRateFiltered.length > 0) {
      return heartRateFiltered;
    }
  }

  return eligible.filter((activity) => activityPace(activity) >= medianPace).slice(0, Math.max(1, eligible.length));
}

function estimateThresholdPace(
  activities: ImportedActivity[],
  weekStart: Date,
  fastPaceCutoff: number,
  fallbackEasyPace: number,
): number {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const windowStart = new Date(weekStart);
  windowStart.setDate(windowStart.getDate() - 56);
  const recentPaces = activities
    .filter((activity) => activity.date >= windowStart && activity.date < weekEnd)
    .filter((activity) => activity.movingTimeSec >= 15 * 60 && activity.movingTimeSec <= 100 * 60)
    .map(activityPace)
    .filter(isFinitePositive);

  return percentile(recentPaces, 0.18) ?? fastPaceCutoff ?? fallbackEasyPace * 0.9;
}

function buildWarnings(activities: ImportedActivity[], weeks: WeeklyRunBlock[]): string[] {
  const warnings: string[] = [];
  const hasHeartRate = weeks.some((week) => week.dataCompleteness?.heartRate);
  const hasCadence = weeks.some((week) => week.dataCompleteness?.cadence);
  const hasRecovery = weeks.some((week) => week.dataCompleteness?.recovery);
  const hasStreams = weeks.some((week) => week.dataCompleteness?.streams);

  if (!hasHeartRate) {
    warnings.push('No heart-rate column was detected, so fixed-HR pace uses a pace-only proxy.');
  }

  if (!hasCadence) {
    warnings.push('No cadence column was detected, so stride length uses a neutral cadence estimate.');
  }

  if (!hasRecovery) {
    warnings.push('No HRV or sleep columns were detected, so recovery is held neutral.');
  }

  if (weeks.length < 8) {
    warnings.push('Fewer than eight running weeks were imported, so baselines will be jumpy.');
  }

  if (activities.length !== weeks.reduce((total, week) => total + (week.activityCount ?? 0), 0)) {
    warnings.push('Some activities were skipped because they had incomplete distance, time, or date fields.');
  }

  if (!hasStreams) {
    warnings.push('Summary data does not include true first-half/second-half stream decoupling.');
  }

  return warnings;
}

function buildWeekNotes(hasHeartRate: boolean, hasCadence: boolean, hasRecovery: boolean): string[] {
  const notes: string[] = [];

  if (!hasHeartRate) {
    notes.push('Heart-rate unavailable');
  }

  if (!hasCadence) {
    notes.push('Cadence unavailable');
  }

  if (!hasRecovery) {
    notes.push('Recovery unavailable');
  }

  return notes;
}

function isRunningActivity(activity: ImportedActivity): boolean {
  const text = `${activity.type} ${activity.name}`.toLowerCase();
  return text.includes('run') || text.includes('jog') || text.includes('race');
}

function isQualitySession(activity: ImportedActivity, fastPaceCutoff: number, hardLoadCutoff?: number): boolean {
  const name = activity.name.toLowerCase();
  const knownQuality = ['race', 'tempo', 'threshold', 'interval', 'workout', 'session', 'fartlek'].some((term) =>
    name.includes(term),
  );

  if (knownQuality) {
    return true;
  }

  if (hardLoadCutoff && activity.relativeEffort && activity.relativeEffort >= hardLoadCutoff) {
    return true;
  }

  return activity.distanceKm >= 3 && activityPace(activity) <= fastPaceCutoff;
}

export function isUsefulHeartRate(value?: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 80 && value <= 220;
}

export function isFinitePositive(value?: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function normalizeRunCadence(raw?: number): number | undefined {
  if (!isFinitePositive(raw)) {
    return undefined;
  }

  if (raw >= 60 && raw < 120) {
    return raw * 2;
  }

  if (raw >= 120 && raw <= 240) {
    return raw;
  }

  return undefined;
}

function activityPace(activity: ImportedActivity): number {
  return activity.movingTimeSec / activity.distanceKm;
}

function weightedPace(activities: ImportedActivity[]): number {
  const totalDistance = sum(activities.map((activity) => activity.distanceKm));
  const totalTime = sum(activities.map((activity) => activity.movingTimeSec));

  return totalDistance > 0 ? totalTime / totalDistance : 300;
}

function weightedAverage(values: ReadonlyArray<readonly [number, number]>): number | undefined {
  const totalWeight = sum(values.map(([, weight]) => weight));

  if (totalWeight === 0) {
    return undefined;
  }

  return sum(values.map(([value, weight]) => value * weight)) / totalWeight;
}

function percentile(values: Array<number | undefined>, ratio: number): number | undefined {
  const cleanValues = values.filter(isFinitePositive).sort((a, b) => a - b);

  if (cleanValues.length === 0) {
    return undefined;
  }

  const index = Math.min(cleanValues.length - 1, Math.max(0, Math.round((cleanValues.length - 1) * ratio)));
  return cleanValues[index];
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function mean(values: number[]): number {
  return values.length > 0 ? sum(values) / values.length : 0;
}

function toWeekId(date: Date): string {
  const weekStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const mondayOffset = (weekStart.getDay() + 6) % 7;
  weekStart.setDate(weekStart.getDate() - mondayOffset);

  return `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, '0')}-${String(weekStart.getDate()).padStart(2, '0')}`;
}

function parseWeekId(weekId: string): Date {
  const [year, month, day] = weekId.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function formatWeekLabel(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
  }).format(date);
}

function formatShortDate(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}
