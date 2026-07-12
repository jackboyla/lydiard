import { toWeekIdUtc } from '../data/mapRoutes';
import type { ActivitySummary, Severity } from '../types';

export interface LoadThresholds {
  thresholdPaceSecPerKm: number;
  thresholdSpeedMps: number;
  /** Latest caller-supplied, date-effective CP. Never inferred from average run power. */
  thresholdPower?: number;
  thresholdHeartRate?: number;
  maxHeartRate?: number;
}

/**
 * Optional stream-derived evidence for one activity. `totalStress`, when
 * supplied, is canonical and is passed through without blending it with pace
 * or HR. `averagePctCp` uses percentage points (75 = 75% of CP).
 *
 * A caller may instead provide only a trusted, date-effective `effectiveCp`.
 * In that case the summary average power is used as a lower-fidelity power
 * stress fallback. Without either form of trusted power evidence the model
 * falls back to pace plus elevation and labels that source explicitly.
 */
export interface CanonicalActivityMetric {
  activityId: string;
  totalStress?: number;
  hardStress?: number;
  averagePctCp?: number;
  effectiveCp?: number;
  hrCostResidualBpm?: number;
  latePowerChangePct?: number;
  source: string;
}

export type SessionLoadReliability =
  | 'canonical-stream'
  | 'trusted-power-cp'
  | 'pace-elevation-fallback';

export interface SessionLoad {
  activity: ActivitySummary;
  day: string;
  weekId: string;
  paceSecPerKm: number;
  /** Selected canonical/trusted/fallback external stress (the same source as `load`). */
  externalLoad: number;
  /** Diagnostic only: the summary pace/elevation estimate, even when a better source wins. */
  paceFallbackLoad: number;
  /** @deprecated Compatibility-only HR response index; it is excluded from `load`. */
  internalLoad?: number;
  powerLoad?: number;
  load: number;
  externalIntensityFactor: number;
  heartRateIntensityFactor?: number;
  powerIntensityFactor?: number;
  hardLoad: number;
  reliability: SessionLoadReliability;
  loadSource: string;
  effectiveCp?: number;
  averagePctCp?: number;
  hrCostResidualBpm?: number;
  latePowerChangePct?: number;
  /** @deprecated The former pace-vs-HR blended-cost percentage is no longer produced. */
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

export function buildTrainingLoadModel(
  activities: ActivitySummary[],
  canonicalMetrics: readonly CanonicalActivityMetric[] = [],
): TrainingLoadModel {
  const runs = activities
    .filter(isRunLike)
    .filter((activity) => activity.distanceKm > 0 && activity.movingTimeSec > 0)
    .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());

  const canonicalByActivity = new Map(canonicalMetrics.map((metric) => [metric.activityId, metric]));
  const thresholds = estimateThresholds(runs, canonicalByActivity);
  const sessions = runs.map((activity) => scoreSession(activity, thresholds, canonicalByActivity.get(activity.id)));
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

function scoreSession(
  activity: ActivitySummary,
  thresholds: LoadThresholds,
  canonical?: CanonicalActivityMetric,
): SessionLoad {
  const hours = activity.movingTimeSec / 3600;
  const paceSecPerKm = activity.movingTimeSec / activity.distanceKm;
  const speed = activity.averageSpeed && activity.averageSpeed > 0
    ? activity.averageSpeed
    : (activity.distanceKm * 1000) / activity.movingTimeSec;
  const elevationFactor = 1 + clamp((activity.elevationGainM / Math.max(activity.distanceKm * 1000, 1)) * 4, 0, 0.18);
  const gradeAdjustedSpeed = speed * elevationFactor;
  const externalIntensityFactor = clamp(gradeAdjustedSpeed / thresholds.thresholdSpeedMps, 0.35, 1.35);
  const paceFallbackLoad = hours * externalIntensityFactor ** 2 * 100;

  // HR is response evidence only. Keep the old index available for the current
  // detail UI, but never include it in total session stress.
  const heartRateIntensityFactor =
    activity.averageHeartRate && thresholds.thresholdHeartRate
      ? clamp(activity.averageHeartRate / thresholds.thresholdHeartRate, 0.35, 1.35)
      : undefined;
  const internalLoad = heartRateIntensityFactor === undefined ? undefined : hours * heartRateIntensityFactor ** 2 * 100;

  const canonicalStress = finiteNonNegative(canonical?.totalStress);
  const effectiveCp = finitePositive(canonical?.effectiveCp);
  const suppliedPctCp = finiteNonNegative(canonical?.averagePctCp);
  const trustedPowerIntensity = effectiveCp
    ? suppliedPctCp !== undefined
      ? clamp(suppliedPctCp / 100, 0.35, 1.35)
      : activity.averageWatts
        ? clamp(activity.averageWatts / effectiveCp, 0.35, 1.35)
        : undefined
    : undefined;
  const canonicalIsPower = Boolean(
    effectiveCp ||
      suppliedPctCp !== undefined ||
      (canonical?.source && /power|stryd|rss/i.test(canonical.source)),
  );

  let load: number;
  let hardLoad: number;
  let powerLoad: number | undefined;
  let powerIntensityFactor: number | undefined;
  let reliability: SessionLoadReliability;
  let loadSource: string;

  if (canonicalStress !== undefined) {
    // This is the only exact path: no pace/HR weighting or re-scaling.
    load = canonicalStress;
    powerLoad = canonicalIsPower ? canonicalStress : undefined;
    powerIntensityFactor = suppliedPctCp === undefined ? undefined : clamp(suppliedPctCp / 100, 0.35, 1.35);
    hardLoad = finiteNonNegative(canonical?.hardStress) ?? (powerIntensityFactor && powerIntensityFactor >= 0.88 ? load : 0);
    reliability = 'canonical-stream';
    loadSource = canonical?.source || 'canonical-stream';
  } else if (trustedPowerIntensity !== undefined) {
    // Lower-fidelity fallback for a caller that supplied the CP effective on the
    // activity date. We deliberately never infer CP from average run powers.
    powerIntensityFactor = trustedPowerIntensity;
    powerLoad = hours * trustedPowerIntensity ** 2 * 100;
    load = powerLoad;
    hardLoad = finiteNonNegative(canonical?.hardStress) ?? (trustedPowerIntensity >= 0.88 ? load : 0);
    reliability = 'trusted-power-cp';
    loadSource = canonical?.source || 'trusted-power-cp';
  } else {
    load = paceFallbackLoad;
    hardLoad = externalIntensityFactor >= 0.85 ? load : 0;
    reliability = 'pace-elevation-fallback';
    loadSource = 'pace-elevation-fallback';
  }

  const flags = buildSessionFlags({
    hardLoad,
    reliability,
    hrCostResidualBpm: finiteNumber(canonical?.hrCostResidualBpm),
    latePowerChangePct: finiteNumber(canonical?.latePowerChangePct),
    decouplingPct: activity.decouplingPct,
    hasPower: Boolean(activity.averageWatts),
  });

  const resolvedLoad = canonicalStress === undefined ? round1(load) : load;

  return {
    activity,
    day: dayIdFromActivity(activity),
    weekId: toWeekIdUtc(activity.startDate),
    paceSecPerKm,
    externalLoad: resolvedLoad,
    paceFallbackLoad: round1(paceFallbackLoad),
    internalLoad: internalLoad === undefined ? undefined : round1(internalLoad),
    powerLoad:
      powerLoad === undefined
        ? undefined
        : canonicalStress !== undefined
          ? powerLoad
          : round1(powerLoad),
    load: resolvedLoad,
    externalIntensityFactor: round2(externalIntensityFactor),
    heartRateIntensityFactor: heartRateIntensityFactor === undefined ? undefined : round2(heartRateIntensityFactor),
    powerIntensityFactor: powerIntensityFactor === undefined ? undefined : round2(powerIntensityFactor),
    hardLoad: canonicalStress !== undefined && canonical?.hardStress !== undefined ? hardLoad : round1(hardLoad),
    reliability,
    loadSource,
    effectiveCp,
    averagePctCp: suppliedPctCp,
    hrCostResidualBpm: finiteNumber(canonical?.hrCostResidualBpm),
    latePowerChangePct: finiteNumber(canonical?.latePowerChangePct),
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

function estimateThresholds(
  runs: ActivitySummary[],
  canonicalByActivity: ReadonlyMap<string, CanonicalActivityMetric>,
): LoadThresholds {
  const eligiblePaces = runs
    .filter((activity) => activity.distanceKm >= 3 && activity.movingTimeSec >= 12 * 60)
    .map((activity) => activity.movingTimeSec / activity.distanceKm)
    .filter(isFinitePositive)
    .sort((a, b) => a - b);
  const allPaces = runs.map((activity) => activity.movingTimeSec / activity.distanceKm).filter(isFinitePositive);
  const thresholdPaceSecPerKm = percentile(eligiblePaces, 0.18) ?? percentile(allPaces, 0.18) ?? 300;
  const thresholdSpeedMps = 1000 / thresholdPaceSecPerKm;

  const maxHeartRates = runs.map((activity) => activity.maxHeartRate).filter(isUsefulHeartRate);
  const averageHeartRates = runs.map((activity) => activity.averageHeartRate).filter(isUsefulHeartRate);
  const maxHeartRate = percentile(maxHeartRates, 0.9) ?? percentile(averageHeartRates, 0.95);
  const latestEffectiveCp = [...runs]
    .reverse()
    .map((activity) => finitePositive(canonicalByActivity.get(activity.id)?.effectiveCp))
    .find((value): value is number => value !== undefined);

  return {
    thresholdPaceSecPerKm: Math.round(thresholdPaceSecPerKm),
    thresholdSpeedMps,
    thresholdPower: latestEffectiveCp,
    maxHeartRate,
    thresholdHeartRate: maxHeartRate ? maxHeartRate * 0.9 : undefined,
  };
}

function buildSessionFlags(ctx: {
  hardLoad: number;
  reliability: SessionLoadReliability;
  hrCostResidualBpm?: number;
  latePowerChangePct?: number;
  decouplingPct?: number;
  hasPower: boolean;
}): string[] {
  const flags: string[] = [];
  if (ctx.hardLoad > 0) {
    flags.push('quality load');
  }
  if (ctx.hrCostResidualBpm !== undefined && ctx.hrCostResidualBpm >= 8) {
    flags.push('high HR cost vs expected power response');
  } else if (ctx.hrCostResidualBpm !== undefined && ctx.hrCostResidualBpm >= 5) {
    flags.push('elevated HR cost vs expected power response');
  }
  if (ctx.latePowerChangePct !== undefined && ctx.latePowerChangePct <= -8) {
    flags.push('late power fade');
  } else if (ctx.latePowerChangePct !== undefined && ctx.latePowerChangePct <= -5) {
    flags.push('late power decline');
  }
  if (ctx.decouplingPct !== undefined && ctx.decouplingPct > 8) {
    flags.push('HR drift');
  }
  if (ctx.reliability === 'pace-elevation-fallback') {
    flags.push('pace/elevation load fallback');
    if (ctx.hasPower) {
      flags.push('power present but CP not trusted');
    }
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

function finitePositive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
