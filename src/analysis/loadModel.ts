import { toWeekIdUtc } from '../data/mapRoutes';
import type { ActivitySummary, Severity } from '../types';

export interface LoadThresholds {
  thresholdPaceSecPerKm: number;
  thresholdSpeedMps: number;
  thresholdPower?: number;
  thresholdHeartRate?: number;
  maxHeartRate?: number;
}

export interface SessionLoad {
  activity: ActivitySummary;
  day: string;
  weekId: string;
  paceSecPerKm: number;
  externalLoad: number;
  internalLoad?: number;
  powerLoad?: number;
  load: number;
  externalIntensityFactor: number;
  heartRateIntensityFactor?: number;
  powerIntensityFactor?: number;
  hardLoad: number;
  reliability: 'external-only' | 'external-hr' | 'external-power' | 'external-hr-power';
  hiddenCostPct?: number;
  powerHrRatio?: number;
  flags: string[];
}

export interface DailyLoadPoint {
  day: string;
  load: number;
  fitness: number;
  fatigue: number;
  freshness: number;
  acwr: number;
}

export interface WeekLoadSummary {
  weekId: string;
  label: string;
  activityCount: number;
  distanceKm: number;
  durationHours: number;
  load: number;
  hardLoad: number;
  hardShare: number;
  longestRunLoad: number;
  longRunShare: number;
  monotony: number;
  strain: number;
  rampRatio: number;
  fitness: number;
  fatigue: number;
  freshness: number;
  acwr: number;
  severity: Severity;
  status: string;
  flags: string[];
  sessions: SessionLoad[];
}

export interface TrainingLoadModel {
  thresholds: LoadThresholds;
  sessions: SessionLoad[];
  sessionsById: Map<string, SessionLoad>;
  daily: DailyLoadPoint[];
  dailyByDay: Map<string, DailyLoadPoint>;
  weeks: WeekLoadSummary[];
  weeksById: Map<string, WeekLoadSummary>;
}

const DAY_MS = 86400000;

export function buildTrainingLoadModel(activities: ActivitySummary[]): TrainingLoadModel {
  const runs = activities
    .filter(isRunLike)
    .filter((activity) => activity.distanceKm > 0 && activity.movingTimeSec > 0)
    .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());

  const thresholds = estimateThresholds(runs);
  const sessions = runs.map((activity) => scoreSession(activity, thresholds));
  const daily = buildDailyLoad(sessions);
  const weeks = buildWeeklySummaries(sessions, daily);

  return {
    thresholds,
    sessions,
    sessionsById: new Map(sessions.map((session) => [session.activity.id, session])),
    daily,
    dailyByDay: new Map(daily.map((point) => [point.day, point])),
    weeks,
    weeksById: new Map(weeks.map((week) => [week.weekId, week])),
  };
}

export function dayIdFromActivity(activity: ActivitySummary): string {
  const source = activity.startDateLocal || activity.startDate;
  return source.slice(0, 10);
}

function scoreSession(activity: ActivitySummary, thresholds: LoadThresholds): SessionLoad {
  const hours = activity.movingTimeSec / 3600;
  const paceSecPerKm = activity.movingTimeSec / activity.distanceKm;
  const speed = activity.averageSpeed && activity.averageSpeed > 0
    ? activity.averageSpeed
    : (activity.distanceKm * 1000) / activity.movingTimeSec;
  const elevationFactor = 1 + clamp((activity.elevationGainM / Math.max(activity.distanceKm * 1000, 1)) * 4, 0, 0.18);
  const gradeAdjustedSpeed = speed * elevationFactor;
  const externalIntensityFactor = clamp(gradeAdjustedSpeed / thresholds.thresholdSpeedMps, 0.35, 1.35);
  const externalLoad = hours * externalIntensityFactor ** 2 * 100;

  const heartRateIntensityFactor =
    activity.averageHeartRate && thresholds.thresholdHeartRate
      ? clamp(activity.averageHeartRate / thresholds.thresholdHeartRate, 0.35, 1.35)
      : undefined;
  const internalLoad = heartRateIntensityFactor === undefined ? undefined : hours * heartRateIntensityFactor ** 2 * 100;

  const powerIntensityFactor =
    activity.averageWatts && thresholds.thresholdPower
      ? clamp(activity.averageWatts / thresholds.thresholdPower, 0.35, 1.35)
      : undefined;
  const powerLoad = powerIntensityFactor === undefined ? undefined : hours * powerIntensityFactor ** 2 * 100;

  const weighted = [
    [externalLoad, 0.5] as const,
    ...(internalLoad === undefined ? [] : ([[internalLoad, 0.3] as const])),
    ...(powerLoad === undefined ? [] : ([[powerLoad, 0.2] as const])),
  ];
  const weightTotal = weighted.reduce((total, [, weight]) => total + weight, 0);
  const load = weighted.reduce((total, [value, weight]) => total + value * weight, 0) / weightTotal;
  const hard =
    externalIntensityFactor >= 0.85 ||
    (heartRateIntensityFactor ?? 0) >= 0.92 ||
    (powerIntensityFactor ?? 0) >= 0.88;
  const hiddenCostPct = internalLoad === undefined ? undefined : ((internalLoad - externalLoad) / externalLoad) * 100;
  const flags = buildSessionFlags({
    externalIntensityFactor,
    hiddenCostPct,
    decouplingPct: activity.decouplingPct,
    hasHeartRate: Boolean(activity.averageHeartRate),
    hasPower: Boolean(activity.averageWatts),
  });

  return {
    activity,
    day: dayIdFromActivity(activity),
    weekId: toWeekIdUtc(activity.startDate),
    paceSecPerKm,
    externalLoad: round1(externalLoad),
    internalLoad: internalLoad === undefined ? undefined : round1(internalLoad),
    powerLoad: powerLoad === undefined ? undefined : round1(powerLoad),
    load: round1(load),
    externalIntensityFactor: round2(externalIntensityFactor),
    heartRateIntensityFactor: heartRateIntensityFactor === undefined ? undefined : round2(heartRateIntensityFactor),
    powerIntensityFactor: powerIntensityFactor === undefined ? undefined : round2(powerIntensityFactor),
    hardLoad: hard ? round1(load) : 0,
    reliability:
      internalLoad !== undefined && powerLoad !== undefined
        ? 'external-hr-power'
        : internalLoad !== undefined
          ? 'external-hr'
          : powerLoad !== undefined
            ? 'external-power'
            : 'external-only',
    hiddenCostPct: hiddenCostPct === undefined ? undefined : round1(hiddenCostPct),
    powerHrRatio:
      activity.averageWatts && activity.averageHeartRate
        ? round2(activity.averageWatts / activity.averageHeartRate)
        : undefined,
    flags,
  };
}

function buildDailyLoad(sessions: SessionLoad[]): DailyLoadPoint[] {
  if (sessions.length === 0) {
    return [];
  }

  const byDay = new Map<string, number>();
  for (const session of sessions) {
    byDay.set(session.day, (byDay.get(session.day) ?? 0) + session.load);
  }

  const start = parseDay(sessions[0].day);
  const end = parseDay(sessions[sessions.length - 1].day);
  let fitness = 0;
  let fatigue = 0;
  const out: DailyLoadPoint[] = [];

  for (let ms = start.getTime(); ms <= end.getTime(); ms += DAY_MS) {
    const day = formatDay(new Date(ms));
    const load = byDay.get(day) ?? 0;
    fatigue += (load - fatigue) / 7;
    fitness += (load - fitness) / 42;
    const acwr = fitness > 1 ? fatigue / fitness : load > 0 ? 1 : 0;
    out.push({
      day,
      load: round1(load),
      fitness: round1(fitness),
      fatigue: round1(fatigue),
      freshness: round1(fitness - fatigue),
      acwr: round2(acwr),
    });
  }

  return out;
}

function buildWeeklySummaries(sessions: SessionLoad[], daily: DailyLoadPoint[]): WeekLoadSummary[] {
  const grouped = new Map<string, SessionLoad[]>();
  for (const session of sessions) {
    const existing = grouped.get(session.weekId) ?? [];
    existing.push(session);
    grouped.set(session.weekId, existing);
  }

  const dailyByDay = new Map(daily.map((point) => [point.day, point]));
  const drafts = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekId, weekSessions]) => {
      const sortedSessions = [...weekSessions].sort(
        (a, b) => new Date(a.activity.startDate).getTime() - new Date(b.activity.startDate).getTime(),
      );
      const dayLoads = daysInWeek(weekId).map((day) => dailyByDay.get(day)?.load ?? 0);
      const load = sum(sortedSessions.map((session) => session.load));
      const hardLoad = sum(sortedSessions.map((session) => session.hardLoad));
      const longestRunLoad = Math.max(...sortedSessions.map((session) => session.load));
      const endPoint = lastDefined(daysInWeek(weekId).map((day) => dailyByDay.get(day)));
      const monotony = weeklyMonotony(dayLoads);

      return {
        weekId,
        label: formatWeekLabel(weekId),
        activityCount: sortedSessions.length,
        distanceKm: round1(sum(sortedSessions.map((session) => session.activity.distanceKm))),
        durationHours: round1(sum(sortedSessions.map((session) => session.activity.movingTimeSec)) / 3600),
        load: round1(load),
        hardLoad: round1(hardLoad),
        hardShare: load > 0 ? round2(hardLoad / load) : 0,
        longestRunLoad: round1(longestRunLoad),
        longRunShare: load > 0 ? round2(longestRunLoad / load) : 0,
        monotony: round2(monotony),
        strain: round1(load * monotony),
        rampRatio: 1,
        fitness: endPoint?.fitness ?? 0,
        fatigue: endPoint?.fatigue ?? 0,
        freshness: endPoint?.freshness ?? 0,
        acwr: endPoint?.acwr ?? 0,
        severity: 'steady' as Severity,
        status: 'Normal training fatigue',
        flags: [] as string[],
        sessions: sortedSessions,
      };
    });

  return drafts.map((week, index) => {
    const priorFour = drafts.slice(Math.max(0, index - 4), index);
    const priorAverage = mean(priorFour.map((item) => item.load).filter((value) => value > 0));
    const rampRatio = priorAverage > 0 ? week.load / priorAverage : 1;
    const flags = buildWeekFlags({ ...week, rampRatio });
    return {
      ...week,
      rampRatio: round2(rampRatio),
      flags,
      severity: weekSeverity(flags, week.acwr),
      status: weekStatus(flags, week.freshness, week.acwr),
    };
  });
}

function estimateThresholds(runs: ActivitySummary[]): LoadThresholds {
  const eligiblePaces = runs
    .filter((activity) => activity.distanceKm >= 3 && activity.movingTimeSec >= 12 * 60)
    .map((activity) => activity.movingTimeSec / activity.distanceKm)
    .filter(isFinitePositive)
    .sort((a, b) => a - b);
  const allPaces = runs.map((activity) => activity.movingTimeSec / activity.distanceKm).filter(isFinitePositive);
  const thresholdPaceSecPerKm = percentile(eligiblePaces, 0.18) ?? percentile(allPaces, 0.18) ?? 300;
  const thresholdSpeedMps = 1000 / thresholdPaceSecPerKm;

  const powers = runs
    .filter((activity) => activity.averageWatts && activity.movingTimeSec >= 15 * 60)
    .map((activity) => activity.averageWatts as number)
    .sort((a, b) => a - b);
  const maxHeartRates = runs.map((activity) => activity.maxHeartRate).filter(isUsefulHeartRate);
  const averageHeartRates = runs.map((activity) => activity.averageHeartRate).filter(isUsefulHeartRate);
  const maxHeartRate = percentile(maxHeartRates, 0.9) ?? percentile(averageHeartRates, 0.95);

  return {
    thresholdPaceSecPerKm: Math.round(thresholdPaceSecPerKm),
    thresholdSpeedMps,
    thresholdPower: percentile(powers, 0.85),
    maxHeartRate,
    thresholdHeartRate: maxHeartRate ? maxHeartRate * 0.9 : undefined,
  };
}

function buildSessionFlags(ctx: {
  externalIntensityFactor: number;
  hiddenCostPct?: number;
  decouplingPct?: number;
  hasHeartRate: boolean;
  hasPower: boolean;
}): string[] {
  const flags: string[] = [];
  if (ctx.externalIntensityFactor >= 0.9) {
    flags.push('quality load');
  }
  if (ctx.hiddenCostPct !== undefined && ctx.hiddenCostPct > 18) {
    flags.push('high HR cost');
  }
  if (ctx.decouplingPct !== undefined && ctx.decouplingPct > 8) {
    flags.push('HR drift');
  }
  if (!ctx.hasHeartRate) {
    flags.push('HR estimated');
  }
  if (!ctx.hasPower) {
    flags.push('power estimated');
  }
  return flags;
}

function buildWeekFlags(week: WeekLoadSummary): string[] {
  const flags: string[] = [];
  if (week.acwr > 1.5) {
    flags.push('acute spike');
  } else if (week.acwr > 1.3) {
    flags.push('high ramp');
  }
  if (week.rampRatio > 1.15) {
    flags.push('weekly load jump');
  }
  if (week.longRunShare > 0.35) {
    flags.push('long-run dominance');
  }
  if (week.hardShare > 0.25) {
    flags.push('high intensity density');
  }
  if (week.monotony > 2 && week.load > 0) {
    flags.push('high monotony');
  }
  return flags;
}

function weekSeverity(flags: string[], acwr: number): Severity {
  if (acwr > 1.5 || flags.length >= 3) {
    return 'high';
  }
  if (acwr > 1.3 || flags.length > 0) {
    return 'watch';
  }
  return 'steady';
}

function weekStatus(flags: string[], freshness: number, acwr: number): string {
  if (acwr > 1.5 || flags.includes('acute spike')) {
    return 'Back off';
  }
  if (flags.length > 0) {
    return 'Caution';
  }
  if (freshness > 8) {
    return 'Fresh';
  }
  if (freshness < -10) {
    return 'Productive overload';
  }
  return 'Normal training fatigue';
}

function isRunLike(activity: ActivitySummary): boolean {
  return /run|jog|race/i.test(`${activity.sportType} ${activity.name}`);
}

function isUsefulHeartRate(value?: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 80 && value <= 220;
}

function isFinitePositive(value?: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function weeklyMonotony(dayLoads: number[]): number {
  const activeOrAll = dayLoads.some((value) => value > 0) ? dayLoads : [];
  if (activeOrAll.length === 0) {
    return 0;
  }
  const avg = mean(activeOrAll);
  const sd = standardDeviation(activeOrAll);
  return sd > 0 ? avg / sd : avg > 0 ? 7 : 0;
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const avg = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - avg) ** 2)));
}

function daysInWeek(weekId: string): string[] {
  const start = parseDay(weekId);
  return Array.from({ length: 7 }, (_, index) => formatDay(new Date(start.getTime() + index * DAY_MS)));
}

function parseDay(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatWeekLabel(weekId: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(parseDay(weekId));
}

function lastDefined<T>(values: Array<T | undefined>): T | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] !== undefined) {
      return values[index];
    }
  }
  return undefined;
}

function percentile(values: Array<number | undefined>, ratio: number): number | undefined {
  const clean = values.filter(isFinitePositive).sort((a, b) => a - b);
  if (clean.length === 0) {
    return undefined;
  }
  const index = Math.min(clean.length - 1, Math.max(0, Math.round((clean.length - 1) * ratio)));
  return clean[index];
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function mean(values: number[]): number {
  return values.length ? sum(values) / values.length : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round1(value: number): number {
  return Number(value.toFixed(1));
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}
