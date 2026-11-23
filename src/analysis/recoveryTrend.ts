import type { RecoveryNight, RecoveryObservation } from '../types';

export type RecoveryMetric = 'sleep' | 'hrv';

/** Nights averaged for the comparison line, as in Garmin's and Whoop's 7-day HRV views. */
export const AVERAGE_NIGHTS = 7;
/** Fewer nights than this in the window gives no average rather than a noisy one. */
const MIN_AVERAGE_NIGHTS = 3;

/** Seven recent calendar days and the 84 days immediately before them. */
export const HRV_LOOKBACK_DAYS = 90;

export interface HrvTrend {
  asOf: string;
  source?: string;
  status: 'insufficient' | 'below_range' | 'below_midpoint' | 'at_or_above_midpoint';
  acuteNights: number;
  baselineNights: number;
  acuteMs?: number;
  midpointMs?: number;
  lowerMs?: number;
  upperMs?: number;
}

/** Input has one observation per wake date, as stored by the recovery importer. */
export function computeHrvTrend(observations: readonly RecoveryObservation[], asOf: string): HrvTrend {
  const start = addDays(asOf, -HRV_LOOKBACK_DAYS);
  const weekStart = addDays(asOf, 1 - AVERAGE_NIGHTS);
  const readings = observations.filter((night): night is RecoveryObservation & { hrvRmssdMs: number } =>
    night.day >= start && night.day <= asOf && night.hrvRmssdMs !== undefined &&
    Number.isFinite(night.hrvRmssdMs) && night.hrvRmssdMs > 0,
  );
  const latest = readings.reduce<RecoveryObservation | undefined>(
    (last, night) => !last || night.day > last.day ? night : last, undefined,
  );
  const acute: number[] = [];
  const baseline: number[] = [];
  for (const night of readings) {
    if (night.source !== latest?.source) continue;
    const window = night.day >= weekStart ? acute : baseline;
    window.push(night.hrvRmssdMs);
  }
  const trend: HrvTrend = {
    asOf, source: latest?.source, status: 'insufficient', acuteNights: acute.length, baselineNights: baseline.length,
  };
  if (acute.length >= 5) trend.acuteMs = meanHrv(acute);
  if (baseline.length < 60) return trend;

  const midpoint = meanHrv(baseline);
  const sd = Math.sqrt(baseline.reduce((sum, ms) => sum + (ms - midpoint) ** 2, 0) / (baseline.length - 1));
  trend.midpointMs = midpoint;
  trend.lowerMs = midpoint - 0.5 * sd;
  trend.upperMs = midpoint + 0.5 * sd;
  if (trend.acuteMs !== undefined) {
    trend.status = trend.acuteMs < trend.lowerMs ? 'below_range'
      : trend.acuteMs < midpoint ? 'below_midpoint' : 'at_or_above_midpoint';
  }
  return trend;
}

// Centering keeps a flat decimal-valued series exactly at its midpoint.
function meanHrv(values: number[]): number {
  const origin = values[0];
  return origin + values.reduce((sum, ms) => sum + (ms - origin), 0) / values.length;
}

export function hrvLoadGuidance(status?: HrvTrend['status']): string | undefined {
  if (status === 'below_range') {
    return 'Hold training load. Review recent intensity, sleep, illness symptoms, travel and life stress before deciding whether to ease off.';
  }
  if (status === 'below_midpoint') return 'Hold training load until the weekly HRV average returns to your midpoint.';
  return undefined;
}

export function nightValue(night: RecoveryNight | undefined, metric: RecoveryMetric): number | undefined {
  return metric === 'sleep' ? night?.sleepMin : night?.hrvMs;
}

/**
 * Mean of the metric over the seven nights before `day`, excluding `day` itself,
 * so a night is compared with what came before it rather than with itself.
 */
export function averageBefore(
  byDay: ReadonlyMap<string, RecoveryNight>,
  day: string,
  metric: RecoveryMetric,
): number | undefined {
  const source = byDay.get(day)?.source;
  const values: number[] = [];
  for (let offset = 1; offset <= AVERAGE_NIGHTS; offset += 1) {
    const night = byDay.get(addDays(day, -offset));
    if (metric === 'hrv' && (!source || source !== night?.source)) continue;
    const value = nightValue(night, metric);
    if (value !== undefined) values.push(value);
  }
  return values.length >= MIN_AVERAGE_NIGHTS ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** "7h 05m" */
export function formatSleep(minutes: number): string {
  const rounded = Math.round(minutes);
  return `${Math.floor(rounded / 60)}h ${String(rounded % 60).padStart(2, '0')}m`;
}

/** Sleep difference in minutes, HRV difference in percent, as each is usually read. */
export function formatVersusAverage(value: number, average: number | undefined, metric: RecoveryMetric): string {
  if (average === undefined) return 'no 7-night average yet';
  if (metric === 'sleep') {
    const minutes = Math.round(value - average);
    if (minutes === 0) return 'level with 7-night avg';
    return `${minutes > 0 ? '+' : '−'}${formatSleepDelta(Math.abs(minutes))} vs 7-night avg`;
  }
  const percent = Math.round(((value - average) / average) * 100);
  if (percent === 0) return 'level with 7-night avg';
  return `${percent > 0 ? '+' : '−'}${Math.abs(percent)}% vs 7-night avg`;
}

function formatSleepDelta(minutes: number): string {
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes} min`;
}
