import type { StoredPlannedSession } from '../data/coachTypes';

export type ForecastLoadZone = 'recovery' | 'balanced' | 'building' | 'spike';
export type PlannedStressSource = 'stored-power' | 'target-power' | 'session-estimate';

export interface LoadForecastPoint {
  day: string;
  plannedStress: number;
  shortLoad: number;
  backgroundLoad: number;
  ratio: number;
  zone: ForecastLoadZone;
  sessionIds: string[];
}

export interface LoadForecastWeek {
  weekStart: string;
  weekEnd: string;
  plannedStress: number;
  endRatio: number;
  peakRatio: number;
  zone: ForecastLoadZone;
  sessionCount: number;
}

export interface LoadForecast {
  asOf: string;
  currentRatio: number;
  points: LoadForecastPoint[];
  weeks: LoadForecastWeek[];
  peak: LoadForecastPoint;
  sources: Record<PlannedStressSource, number>;
}

interface ForecastInput {
  asOf: string;
  sevenDayStress: number;
  fortyTwoDayStress: number;
  sessions: StoredPlannedSession[];
  through?: string;
  horizonDays?: number;
}

const DAY_MS = 86_400_000;
const ACTIVE_STATUSES = new Set(['proposed', 'accepted', 'planned']);

/**
 * Projects the coach's existing exponentially weighted 7-day and 42-day load
 * states through future structured sessions. This is a load-change signal, not
 * an injury probability: it intentionally does not blend symptoms, sleep,
 * biomechanics, or clinical history into a false single-number diagnosis.
 */
export function buildLoadForecast(input: ForecastInput): LoadForecast {
  const asOf = dayKey(input.asOf);
  const horizonEnd = addDays(asOf, Math.max(1, input.horizonDays ?? 21) - 1);
  const end = input.through && input.through >= asOf && input.through < horizonEnd ? input.through : horizonEnd;
  const eligible = input.sessions
    .filter((session) => ACTIVE_STATUSES.has(session.status))
    .filter((session) => session.plannedDate >= asOf)
    .filter((session) => session.plannedDate <= end)
    .filter((session) => !['rest', 'strength'].includes(session.sessionType));
  const sessionsByDay = new Map<string, StoredPlannedSession[]>();
  for (const session of eligible) {
    const bucket = sessionsByDay.get(session.plannedDate) ?? [];
    bucket.push(session);
    sessionsByDay.set(session.plannedDate, bucket);
  }

  const sources: Record<PlannedStressSource, number> = {
    'stored-power': 0,
    'target-power': 0,
    'session-estimate': 0,
  };
  let shortLoad = finiteNonNegative(input.sevenDayStress);
  let backgroundLoad = finiteNonNegative(input.fortyTwoDayStress);
  const currentRatio = safeRatio(shortLoad, backgroundLoad);
  const points: LoadForecastPoint[] = [];

  for (let day = asOf; day <= end; day = addDays(day, 1)) {
    const sessions = sessionsByDay.get(day) ?? [];
    const plannedStress = sessions.reduce((total, session) => {
      const estimate = estimatePlannedStress(session);
      sources[estimate.source] += 1;
      return total + estimate.stress;
    }, 0);
    shortLoad += (plannedStress - shortLoad) / 7;
    backgroundLoad += (plannedStress - backgroundLoad) / 42;
    const ratio = safeRatio(shortLoad, backgroundLoad);
    points.push({
      day,
      plannedStress: round1(plannedStress),
      shortLoad: round1(shortLoad),
      backgroundLoad: round1(backgroundLoad),
      ratio: round2(ratio),
      zone: loadForecastZone(ratio),
      sessionIds: sessions.map((session) => session.id),
    });
  }

  const peak = points.reduce((highest, point) => point.ratio > highest.ratio ? point : highest, points[0]);
  return {
    asOf,
    currentRatio: round2(currentRatio),
    points,
    weeks: summarizeForecastWeeks(points),
    peak,
    sources,
  };
}

export function loadForecastZone(ratio: number): ForecastLoadZone {
  if (ratio > 1.5) return 'spike';
  if (ratio > 1.3) return 'building';
  if (ratio < 0.8) return 'recovery';
  return 'balanced';
}

export function estimatePlannedStress(session: StoredPlannedSession): { stress: number; source: PlannedStressSource } {
  if (Number.isFinite(session.plannedPowerStress) && (session.plannedPowerStress ?? -1) >= 0) {
    return { stress: round1(session.plannedPowerStress as number), source: 'stored-power' };
  }

  const durationHours = Math.max(0, session.plannedDurationSec ?? 0) / 3600;
  const low = finitePositive(session.targetPowerLowPctCp);
  const high = finitePositive(session.targetPowerHighPctCp);
  if (durationHours > 0 && (low !== undefined || high !== undefined)) {
    const intensity = clamp(((low ?? high as number) + (high ?? low as number)) / 2, 0.35, 1.25);
    return { stress: round1(durationHours * intensity ** 2 * 100), source: 'target-power' };
  }

  const intensity = SESSION_INTENSITY[session.sessionType] ?? 0.72;
  return { stress: round1(durationHours * intensity ** 2 * 100), source: 'session-estimate' };
}

const SESSION_INTENSITY: Record<string, number> = {
  recovery: 0.6,
  aerobic: 0.7,
  medium_long: 0.72,
  long_aerobic: 0.72,
  steady: 0.8,
  strides: 0.74,
  hill_sprints: 0.78,
  hill_circuit: 0.84,
  threshold: 0.9,
  vo2: 0.94,
  race_specific: 0.9,
  coordination: 0.82,
};

function summarizeForecastWeeks(points: LoadForecastPoint[]): LoadForecastWeek[] {
  const grouped = new Map<string, LoadForecastPoint[]>();
  for (const point of points) {
    const weekStart = mondayOf(point.day);
    const bucket = grouped.get(weekStart) ?? [];
    bucket.push(point);
    grouped.set(weekStart, bucket);
  }
  return [...grouped.entries()].map(([weekStart, weekPoints]) => {
    const peakRatio = Math.max(...weekPoints.map((point) => point.ratio));
    const last = weekPoints[weekPoints.length - 1];
    return {
      weekStart,
      weekEnd: addDays(weekStart, 6),
      plannedStress: round1(weekPoints.reduce((total, point) => total + point.plannedStress, 0)),
      endRatio: last.ratio,
      peakRatio: round2(peakRatio),
      zone: loadForecastZone(peakRatio),
      sessionCount: weekPoints.reduce((total, point) => total + point.sessionIds.length, 0),
    };
  });
}

function mondayOf(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  const offset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

function dayKey(value: string): string {
  const parsed = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
}

function addDays(day: string, amount: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + amount * DAY_MS).toISOString().slice(0, 10);
}

function safeRatio(shortLoad: number, backgroundLoad: number): number {
  return backgroundLoad > 0.1 ? shortLoad / backgroundLoad : shortLoad > 0.1 ? 1 : 0;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function finitePositive(value?: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
