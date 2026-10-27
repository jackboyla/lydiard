import type { RecoveryNight } from '../types';

export type RecoveryMetric = 'sleep' | 'hrv';

/** Nights averaged for the comparison line, as in Garmin's and Whoop's 7-day HRV views. */
export const AVERAGE_NIGHTS = 7;
/** Fewer nights than this in the window gives no average rather than a noisy one. */
const MIN_AVERAGE_NIGHTS = 3;

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
  const values: number[] = [];
  for (let offset = 1; offset <= AVERAGE_NIGHTS; offset += 1) {
    const value = nightValue(byDay.get(addDays(day, -offset)), metric);
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
