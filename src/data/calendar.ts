const MONDAY = 1;

/** Return the browser-local Monday that contains the supplied instant. */
export function localWeekId(value: Date = new Date()): string {
  const monday = new Date(value.getFullYear(), value.getMonth(), value.getDate(), 12);
  const mondayOffset = (monday.getDay() + 6) % 7;
  monday.setDate(monday.getDate() - mondayOffset);
  return localDayId(monday);
}

/** Milliseconds until the next browser-local Monday at 00:00. */
export function millisecondsUntilNextLocalWeek(value: Date = new Date()): number {
  const daysUntilMonday = (MONDAY - value.getDay() + 7) % 7 || 7;
  const nextMonday = new Date(value);
  nextMonday.setDate(value.getDate() + daysUntilMonday);
  nextMonday.setHours(0, 0, 0, 0);
  return Math.max(1, nextMonday.getTime() - value.getTime());
}

function localDayId(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}
