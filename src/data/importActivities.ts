// CSV import path (browser/Node). Uses papaparse, so it is NOT imported by the
// Cloudflare Worker. The pure weekly derivation lives in ./deriveWeekly and is
// re-exported here so existing import sites keep working unchanged.

import Papa from 'papaparse';
import type { DataSource } from '../types';
import {
  buildImportedTrainingFromActivities,
  isFinitePositive,
  isUsefulHeartRate,
  normalizeRunCadence,
  type ImportedActivity,
  type ImportedTrainingData,
} from './deriveWeekly';

export { buildImportedTrainingFromActivities };
export type { ImportedActivity, ImportedTrainingData };

interface SelectedValue {
  key: string;
  value: string;
}

const DATE_FIELDS = [
  'Activity Date',
  'Date',
  'Start Date',
  'Start Time',
  'Start Time Local',
  'Begin Timestamp',
  'Begin Time',
];
const TYPE_FIELDS = ['Activity Type', 'Sport Type', 'Sport', 'Type', 'Activity'];
const NAME_FIELDS = ['Activity Name', 'Title', 'Name', 'Workout Name'];
const DISTANCE_FIELDS = ['Distance', 'Distance (km)', 'Distance (mi)', 'Distance (m)', 'Kilometers', 'Miles'];
const MOVING_TIME_FIELDS = ['Moving Time', 'Moving Time (s)', 'Moving Time (sec)', 'Time', 'Duration'];
const ELAPSED_TIME_FIELDS = ['Elapsed Time', 'Elapsed Time (s)', 'Elapsed Time (sec)', 'Duration'];
const HEART_RATE_FIELDS = [
  'Average Heart Rate',
  'Average HR',
  'Avg HR',
  'Avg Heart Rate',
  'Avg Heart Rate (bpm)',
  'Average Heartrate',
  'Avg Heartrate',
];
const CADENCE_FIELDS = [
  'Average Cadence',
  'Average Run Cadence',
  'Avg Cadence',
  'Avg Run Cadence',
  'Run Cadence',
  'Cadence',
  'Average Cadence (spm)',
];
const ELEVATION_FIELDS = [
  'Elevation Gain',
  'Elevation Gain (m)',
  'Elevation Gain (ft)',
  'Total Elevation Gain',
  'Total Ascent',
  'Elev Gain',
];
const LOAD_FIELDS = ['Relative Effort', 'Suffer Score', 'Training Load', 'Exercise Load', 'TSS'];
const HRV_FIELDS = ['HRV', 'Average HRV', 'Nightly Average HRV', 'HRV (ms)'];
const SLEEP_FIELDS = ['Sleep', 'Sleep Hours', 'Sleep Duration', 'Sleep (hours)'];

export function parseActivityCsv(csvText: string, fileName: string): ImportedTrainingData {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim(),
  });

  if (parsed.errors.length > 0 && parsed.data.length === 0) {
    throw new Error(parsed.errors[0]?.message ?? 'The CSV could not be parsed.');
  }

  const rows = parsed.data.filter((row) => Object.values(row).some((value) => String(value ?? '').trim() !== ''));
  const headers = parsed.meta.fields ?? Object.keys(rows[0] ?? {});

  if (rows.length === 0 || headers.length === 0) {
    throw new Error('The file did not contain any activity rows.');
  }

  const source = detectSource(headers, fileName);
  const activities = rows
    .map((row, index) => parseActivityRow(row, index))
    .filter((activity): activity is ImportedActivity => activity !== null);

  return buildImportedTrainingFromActivities(activities, source, fileName);
}

function parseActivityRow(row: Record<string, string>, index: number): ImportedActivity | null {
  const dateValue = pick(row, DATE_FIELDS);
  const distanceValue = pick(row, DISTANCE_FIELDS);
  const movingTimeValue = pick(row, MOVING_TIME_FIELDS);
  const elapsedTimeValue = pick(row, ELAPSED_TIME_FIELDS);

  const date = dateValue ? parseDate(dateValue.value) : null;
  const distanceKm = distanceValue ? parseDistanceKm(distanceValue.value, distanceValue.key) : null;
  const movingTimeSec = movingTimeValue ? parseDurationSec(movingTimeValue.value, movingTimeValue.key) : null;
  const elapsedTimeSec = elapsedTimeValue ? parseDurationSec(elapsedTimeValue.value, elapsedTimeValue.key) : movingTimeSec;

  if (!date || !distanceKm || !movingTimeSec || distanceKm < 0.8 || movingTimeSec < 240) {
    return null;
  }

  const type = pick(row, TYPE_FIELDS)?.value.trim() || 'Run';
  const name = pick(row, NAME_FIELDS)?.value.trim() || type;
  const averageHeartRate = parseOptionalNumber(pick(row, HEART_RATE_FIELDS)?.value);
  const rawCadence = parseOptionalNumber(pick(row, CADENCE_FIELDS)?.value);
  const averageCadenceSpm = normalizeRunCadence(rawCadence);
  const elevation = pick(row, ELEVATION_FIELDS);
  const elevationGainM = elevation ? parseElevationM(elevation.value, elevation.key) : 0;
  const relativeEffort = parseOptionalNumber(pick(row, LOAD_FIELDS)?.value);
  const hrvMs = parseOptionalNumber(pick(row, HRV_FIELDS)?.value);
  const sleepHours = parseSleepHours(pick(row, SLEEP_FIELDS)?.value);

  return {
    id: `${date.toISOString()}-${index}`,
    name,
    type,
    date,
    distanceKm,
    movingTimeSec,
    elapsedTimeSec: elapsedTimeSec ?? movingTimeSec,
    averageHeartRate: isUsefulHeartRate(averageHeartRate) ? averageHeartRate : undefined,
    averageCadenceSpm,
    elevationGainM,
    relativeEffort: isFinitePositive(relativeEffort) ? relativeEffort : undefined,
    hrvMs: isFinitePositive(hrvMs) ? hrvMs : undefined,
    sleepHours: isFinitePositive(sleepHours) ? sleepHours : undefined,
  };
}

function pick(row: Record<string, string>, aliases: string[]): SelectedValue | null {
  const entries = Object.entries(row);
  const normalizedAliases = aliases.map(normalizeHeader);

  for (const alias of normalizedAliases) {
    const exact = entries.find(([key]) => normalizeHeader(key) === alias);

    if (exact && String(exact[1] ?? '').trim() !== '') {
      return { key: exact[0], value: String(exact[1]).trim() };
    }
  }

  for (const alias of normalizedAliases) {
    const loose = entries.find(([key]) => {
      const normalizedKey = normalizeHeader(key);
      return normalizedKey.includes(alias) || alias.includes(normalizedKey);
    });

    if (loose && String(loose[1] ?? '').trim() !== '') {
      return { key: loose[0], value: String(loose[1]).trim() };
    }
  }

  return null;
}

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function detectSource(headers: string[], fileName: string): DataSource {
  const text = `${fileName} ${headers.join(' ')}`.toLowerCase();

  if (text.includes('strava') || text.includes('relative effort') || text.includes('suffer score')) {
    return 'strava';
  }

  if (text.includes('garmin') || text.includes('avg run cadence') || text.includes('aerobic te')) {
    return 'garmin';
  }

  return 'csv';
}

function parseDate(raw: string): Date | null {
  const trimmed = raw.trim();
  const dayFirstMatch = trimmed.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?:[,\s]+(.+))?$/);

  if (dayFirstMatch) {
    const [, day, month, year, time = '00:00:00'] = dayFirstMatch;
    const fullYear = year.length === 2 ? `20${year}` : year;
    const parsed = new Date(`${fullYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${normalizeTime(time)}`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const direct = new Date(trimmed);

  if (!Number.isNaN(direct.getTime())) {
    return direct;
  }

  return null;
}

function normalizeTime(raw: string): string {
  if (/^\d{1,2}:\d{2}$/.test(raw)) {
    return `${raw}:00`;
  }

  if (/^\d{1,2}:\d{2}:\d{2}$/.test(raw)) {
    return raw;
  }

  return '00:00:00';
}

function parseDistanceKm(raw: string, key: string): number | null {
  const value = parseOptionalNumber(raw);

  if (!isFinitePositive(value)) {
    return null;
  }

  const normalizedKey = key.toLowerCase();

  if (normalizedKey.includes('mile') || normalizedKey.includes('(mi)')) {
    return value * 1.609344;
  }

  if (normalizedKey.includes('meter') || normalizedKey.includes('(m)') || value > 500) {
    return value / 1000;
  }

  return value;
}

function parseDurationSec(raw: string, key: string): number | null {
  const trimmed = raw.trim();
  const colonParts = trimmed.split(':').map((part) => Number(part));

  if (colonParts.length >= 2 && colonParts.every((part) => Number.isFinite(part))) {
    if (colonParts.length === 2) {
      return colonParts[0] * 60 + colonParts[1];
    }

    return colonParts[colonParts.length - 3] * 3600 + colonParts[colonParts.length - 2] * 60 + colonParts[colonParts.length - 1];
  }

  const textDuration = trimmed.match(/(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s)?/i);

  if (textDuration && (textDuration[1] || textDuration[2] || textDuration[3])) {
    return (
      Number(textDuration[1] ?? 0) * 3600 +
      Number(textDuration[2] ?? 0) * 60 +
      Number(textDuration[3] ?? 0)
    );
  }

  const value = parseOptionalNumber(trimmed);

  if (!isFinitePositive(value)) {
    return null;
  }

  const normalizedKey = key.toLowerCase();

  if (normalizedKey.includes('hour')) {
    return value * 3600;
  }

  if (normalizedKey.includes('min')) {
    return value * 60;
  }

  return value;
}

function parseElevationM(raw: string, key: string): number {
  const value = parseOptionalNumber(raw) ?? 0;

  if (key.toLowerCase().includes('ft')) {
    return value * 0.3048;
  }

  return value;
}

function parseSleepHours(raw?: string): number | undefined {
  if (!raw) {
    return undefined;
  }

  const duration = parseDurationSec(raw, 'hours');

  if (duration && duration > 60) {
    return duration / 3600;
  }

  return parseOptionalNumber(raw);
}

function parseOptionalNumber(raw?: string): number | undefined {
  if (!raw) {
    return undefined;
  }

  const trimmed = raw.trim();

  if (trimmed === '' || trimmed === '--') {
    return undefined;
  }

  const normalized =
    trimmed.includes(',') && !trimmed.includes('.')
      ? trimmed.replace(',', '.')
      : trimmed.replace(/,/g, '');
  const cleaned = normalized.replace(/[^0-9.+-]/g, '');
  const value = Number(cleaned);

  return Number.isFinite(value) ? value : undefined;
}
