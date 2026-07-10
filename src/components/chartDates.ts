const DAY_MS = 86_400_000;

export function utcDayTimestamp(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

export function chartSpanDays(timestamps: number[]): number {
  if (timestamps.length < 2) {
    return 0;
  }
  return (timestamps[timestamps.length - 1] - timestamps[0]) / DAY_MS;
}

export function formatChartTick(timestamp: number, spanDays: number): string {
  if (!Number.isFinite(timestamp)) {
    return '';
  }

  const date = new Date(timestamp);
  if (spanDays > 730) {
    return new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
  }
  if (spanDays > 180) {
    return new Intl.DateTimeFormat('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(date);
  }
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(date);
}

export function formatChartDate(timestamp: number): string {
  if (!Number.isFinite(timestamp)) {
    return '';
  }
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(timestamp));
}
