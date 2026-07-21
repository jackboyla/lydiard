// Pull Fitbit sleep/recovery from the Google Health API (the successor to the
// legacy Fitbit Web API, which is decommissioned Sept 2026) and POST it to the
// platform's source-agnostic recovery ingest endpoint as `source: 'fitbit'`.
//
// Mirrors scripts/garmin-health-import.ts: read auth + config from env, fetch a
// date window, map to the RecoveryObservation shape, POST in one batch.
//
// Auth: Google OAuth 2.0. You obtain a refresh token once (Google Cloud OAuth
// client, consent to the `sleep` and `health_metrics_and_measurements` scopes),
// then this script exchanges it for a short-lived access token per run.
//
//   GOOGLE_HEALTH_CLIENT_ID       OAuth client id
//   GOOGLE_HEALTH_CLIENT_SECRET   OAuth client secret
//   GOOGLE_HEALTH_REFRESH_TOKEN   consented refresh token
//   GOOGLE_HEALTH_ACCESS_TOKEN    optional — use this token directly, skip refresh
//   GOOGLE_HEALTH_USER            optional — API user id (default 'me')
//   LYDIARD_BASE_URL              default https://lydiard.lydiard.workers.dev
//   LYDIARD_INGEST_KEY | AGENT_API_KEY   ingest bearer token
//
// Field paths below are taken from the Google Health API v4 discovery document
// (health.googleapis.com/$discovery/rest?version=v4). Because this cannot be
// tested without live credentials, run `--print-raw` first to dump one real
// dataPoint per type and confirm the shapes before a full import.
//
// Usage:
//   npm run fitbit:import -- --from 2026-06-01 --to 2026-07-20
//   npm run fitbit:import -- --print-raw        # dump raw JSON, no ingest
//   npm run fitbit:import -- --dry-run          # map + summarize, no POST

import { readFileSync } from 'node:fs';
import type { RecoveryObservation } from '../src/types';

const API_BASE = 'https://health.googleapis.com/v4';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DAY_MS = 86_400_000;

const baseUrl = (process.env.LYDIARD_BASE_URL ?? 'https://lydiard.lydiard.workers.dev').replace(/\/$/, '');
const ingestKey = process.env.LYDIARD_INGEST_KEY ?? process.env.AGENT_API_KEY;
const ghUser = process.env.GOOGLE_HEALTH_USER ?? 'me';
const dryRun = process.argv.includes('--dry-run');
const printRaw = process.argv.includes('--print-raw');
const replace = process.argv.includes('--replace');
const quiet = process.argv.includes('--quiet');

const to = dateArg('--to') ?? isoDay(new Date());
const from = dateArg('--from') ?? isoDay(new Date(Date.parse(`${to}T00:00:00Z`) - 35 * DAY_MS));

if (!ingestKey && !dryRun && !printRaw) {
  throw new Error('Set LYDIARD_INGEST_KEY or AGENT_API_KEY (or use --dry-run/--print-raw).');
}

// data type id (kebab-case for the endpoint) → snake_case name used in filters.
type Category = 'session' | 'sample' | 'daily';
interface TypeSpec {
  id: string; // endpoint path segment (kebab-case)
  category: Category;
}
const TYPES: Record<string, TypeSpec> = {
  sleep: { id: 'sleep', category: 'session' },
  hrv: { id: 'heart-rate-variability', category: 'sample' },
  restingHr: { id: 'daily-resting-heart-rate', category: 'daily' },
  respiratoryRate: { id: 'daily-respiratory-rate', category: 'daily' },
  spo2: { id: 'daily-oxygen-saturation', category: 'daily' },
  skinTemp: { id: 'daily-sleep-temperature-derivations', category: 'daily' },
};

async function main(): Promise<void> {
  const raw: Record<string, GHDataPoint[]> = {};
  const fromFile = argValue('--from-file');
  if (fromFile) {
    // Offline mode: map a saved dump of raw dataPoints (arrays keyed by the
    // TYPES keys, e.g. { "sleep": [...], "hrv": [...] }). Lets you validate the
    // field mapping against a real --print-raw capture without live auth.
    const parsed = obj(JSON.parse(readFileSync(fromFile, 'utf8'))) ?? {};
    for (const key of Object.keys(TYPES)) raw[key] = arr(parsed[key]).map((p) => p as GHDataPoint);
  } else {
    const token = await accessToken();
    for (const [key, spec] of Object.entries(TYPES)) {
      // Fetch each type independently so one unsupported filter surfaces a
      // warning instead of aborting the whole import.
      try {
        raw[key] = await fetchDataPoints(token, spec, from, to);
        if (!quiet) console.log(`fetched ${raw[key].length} ${spec.id} dataPoints`);
      } catch (error) {
        raw[key] = [];
        console.error(`WARN ${spec.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (printRaw) {
    for (const [key, points] of Object.entries(raw)) {
      console.log(`\n===== ${TYPES[key].id} (first dataPoint) =====`);
      console.log(JSON.stringify(points[0] ?? null, null, 2));
    }
    return;
  }

  const byDay = new Map<string, RecoveryObservation>();
  const ensure = (day: string): RecoveryObservation => {
    let record = byDay.get(day);
    if (!record) {
      record = { day, source: 'fitbit' };
      byDay.set(day, record);
    }
    return record;
  };

  mapSleep(raw.sleep, ensure);
  mapHrv(raw.hrv, ensure);
  mapDaily(raw.restingHr, 'dailyRestingHeartRate', ensure, (v, r) => (r.restingHrBpm = num(v.beatsPerMinute)));
  mapDaily(raw.respiratoryRate, 'dailyRespiratoryRate', ensure, (v, r) => {
    r.respiratoryRate = num(v.breathsPerMinute) ?? num(v.breathsPerMinuteAvg);
  });
  mapDaily(raw.spo2, 'dailyOxygenSaturation', ensure, (v, r) => {
    r.spo2Avg = num(v.averagePercentage) ?? num(v.percentageAvg);
    r.spo2Low = num(v.lowerBoundPercentage) ?? num(v.percentageMin);
  });
  mapDaily(raw.skinTemp, 'dailySleepTemperatureDerivations', ensure, (v, r) => {
    const nightly = num(v.nightlyTemperatureCelsius);
    const baseline = num(v.baselineTemperatureCelsius); // often "NaN" until Fitbit has ~30 nights
    // Store the deviation from Fitbit's personal baseline (what the recovery
    // model treats as skin-temp elevation). When Fitbit has no baseline yet the
    // value stays unset rather than mixing absolute temps into the series.
    if (nightly !== undefined && baseline !== undefined) r.skinTempDeltaC = round(nightly - baseline, 2);
  });

  const records = [...byDay.values()]
    .filter((r) => r.day >= from && r.day <= to && hasSignal(r))
    .sort((a, b) => (a.day < b.day ? -1 : 1));

  if (records.length === 0) {
    console.log(JSON.stringify({ ok: true, from, to, records: 0, note: 'No Fitbit recovery data in range.' }, null, 2));
    return;
  }

  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, from, to, records: records.length, sample: records.slice(-3) }, null, 2));
    return;
  }

  const result = await postRecords(records);
  console.log(JSON.stringify({ ok: true, from, to, ...result }, null, 2));
}

// --- Google Health fetch -----------------------------------------------------

async function accessToken(): Promise<string> {
  const direct = process.env.GOOGLE_HEALTH_ACCESS_TOKEN;
  if (direct) return direct;
  const clientId = process.env.GOOGLE_HEALTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_HEALTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_HEALTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Set GOOGLE_HEALTH_CLIENT_ID, GOOGLE_HEALTH_CLIENT_SECRET, and GOOGLE_HEALTH_REFRESH_TOKEN (or GOOGLE_HEALTH_ACCESS_TOKEN).');
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_URL, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Google OAuth token refresh failed: ${res.status} ${text}`);
  const token = str((JSON.parse(text) as Record<string, unknown>).access_token);
  if (!token) throw new Error('Google OAuth response had no access_token.');
  return token;
}

async function fetchDataPoints(token: string, spec: TypeSpec, start: string, end: string): Promise<GHDataPoint[]> {
  const filter = buildFilter(spec, start, end);
  const points: GHDataPoint[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ pageSize: '1440', filter });
    if (pageToken) params.set('pageToken', pageToken);
    const url = `${API_BASE}/users/${encodeURIComponent(ghUser)}/dataTypes/${spec.id}/dataPoints?${params.toString()}`;
    const json = await getJson(url, token, spec.id);
    for (const dp of arr(json.dataPoints)) points.push(dp as GHDataPoint);
    pageToken = str(json.nextPageToken);
  } while (pageToken);
  return points;
}

// filter grammar (Google Health API v4): a SNAKE_CASE data-type prefix (the
// endpoint id with hyphens as underscores) plus a per-category member. Sleep is
// a SESSION type filterable only by END time — which is how a night is
// attributed to its wake day.
//   daily summary : <snake>.date                        (ISO-8601 date)
//   session/sleep : <snake>.interval.civil_end_time     (ISO-8601 date)
//   sample        : <snake>.sample_time.physical_time   (RFC-3339)
function buildFilter(spec: TypeSpec, start: string, end: string): string {
  const endExclusive = isoDay(new Date(Date.parse(`${end}T00:00:00Z`) + DAY_MS));
  const p = spec.id.replace(/-/g, '_');
  if (spec.category === 'daily') {
    return `${p}.date >= "${start}" AND ${p}.date < "${endExclusive}"`;
  }
  if (spec.category === 'session') {
    return `${p}.interval.civil_end_time >= "${start}" AND ${p}.interval.civil_end_time < "${endExclusive}"`;
  }
  return `${p}.sample_time.physical_time >= "${start}T00:00:00Z" AND ${p}.sample_time.physical_time < "${endExclusive}T00:00:00Z"`;
}

async function getJson(url: string, token: string, label: string): Promise<GHListResponse> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch (error) {
      if (attempt === 5) throw new Error(`${label} request failed: ${String(error)}`);
      await sleep(backoff(attempt));
      continue;
    }
    const text = await res.text();
    if (res.ok) return JSON.parse(text) as GHListResponse;
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await sleep(backoff(attempt));
      continue;
    }
    throw new Error(describeError(label, res.status, text));
  }
  throw new Error(`${label} fetch failed unexpectedly.`);
}

// Surface the API's fieldViolation descriptions (e.g. "Member 'x' is not
// supported for filtering") so a bad filter is diagnosable in one line.
function describeError(label: string, status: number, text: string): string {
  try {
    const body = JSON.parse(text) as {
      error?: { message?: string; details?: Array<{ fieldViolations?: Array<{ description?: string }> }> };
    };
    const violations = (body.error?.details ?? [])
      .flatMap((detail) => detail.fieldViolations ?? [])
      .map((violation) => violation.description)
      .filter((description): description is string => Boolean(description));
    const suffix = violations.length > 0 ? ` [${violations.join(' | ')}]` : '';
    return `${label} fetch failed: ${status} ${body.error?.message ?? ''}${suffix}`.trim();
  } catch {
    return `${label} fetch failed: ${status} ${text.replace(/\s+/g, ' ').slice(0, 300)}`;
  }
}

// --- mappers (Google Health value shapes -> RecoveryObservation) -------------

function mapSleep(points: GHDataPoint[], ensure: (day: string) => RecoveryObservation): void {
  // Keep the longest session per wake-day (the main sleep, not naps).
  const mainByDay = new Map<string, { durMin: number; value: Record<string, unknown> }>();
  for (const dp of points) {
    const value = obj(dp.sleep);
    const interval = value ? obj(value.interval) : undefined;
    if (!value || !interval) continue;
    const startMs = ts(interval.startTime);
    const endMs = ts(interval.endTime);
    if (startMs === undefined || endMs === undefined) continue;
    const offsetSec = durationSec(interval.endUtcOffset) ?? durationSec(interval.startUtcOffset) ?? 0;
    const wakeDay = isoDay(new Date(endMs + offsetSec * 1000)); // local wake date
    const durMin = (endMs - startMs) / 60000;
    const existing = mainByDay.get(wakeDay);
    if (!existing || durMin > existing.durMin) mainByDay.set(wakeDay, { durMin, value });
  }

  for (const [day, { value }] of mainByDay) {
    const interval = obj(value.interval) ?? {};
    const startMs = ts(interval.startTime);
    const endMs = ts(interval.endTime);
    const record = ensure(day);
    if (startMs !== undefined) record.sleepStart = new Date(startMs).toISOString();
    if (endMs !== undefined) record.sleepEnd = new Date(endMs).toISOString();

    const stage = { deep: 0, rem: 0, light: 0, awake: 0 };
    let haveStages = false;
    const summary = obj(value.summary);
    if (summary) {
      // Device-provided aggregate (minutes are strings, e.g. "324").
      for (const rawStage of arr(summary.stagesSummary)) {
        const s = obj(rawStage);
        const min = s ? num(s.minutes) : undefined;
        if (!s || min === undefined) continue;
        addStage(stage, String(s.type ?? ''), min);
        haveStages = true;
      }
      const asleep = num(summary.minutesAsleep);
      const period = num(summary.minutesInSleepPeriod);
      const awake = num(summary.minutesAwake);
      if (asleep !== undefined) record.sleepDurationMin = Math.round(asleep);
      if (period !== undefined) record.timeInBedMin = Math.round(period);
      if (awake !== undefined) record.awakeMin = Math.round(awake);
    }
    if (!haveStages) {
      // No summary (e.g. CLASSIC sleep): sum stage segments by their intervals.
      for (const rawStage of arr(value.stages)) {
        const s = obj(rawStage);
        const startStage = s ? ts(s.startTime) : undefined;
        const endStage = s ? ts(s.endTime) : undefined;
        if (!s || startStage === undefined || endStage === undefined) continue;
        addStage(stage, String(s.type ?? ''), (endStage - startStage) / 60000);
        haveStages = true;
      }
    }

    if (haveStages) {
      record.deepSleepMin = Math.round(stage.deep);
      record.remSleepMin = Math.round(stage.rem);
      record.lightSleepMin = Math.round(stage.light);
      if (record.awakeMin === undefined) record.awakeMin = Math.round(stage.awake);
      if (record.sleepDurationMin === undefined) record.sleepDurationMin = Math.round(stage.deep + stage.rem + stage.light);
    }
    if (record.timeInBedMin === undefined && startMs !== undefined && endMs !== undefined) {
      record.timeInBedMin = Math.round((endMs - startMs) / 60000);
    }
    if (record.sleepDurationMin !== undefined && record.timeInBedMin && record.timeInBedMin > 0) {
      record.sleepEfficiency = round((record.sleepDurationMin / record.timeInBedMin) * 100, 1);
    }
  }
}

function addStage(acc: { deep: number; rem: number; light: number; awake: number }, type: string, minutes: number): void {
  const t = type.toUpperCase();
  if (t.includes('DEEP')) acc.deep += minutes;
  else if (t.includes('REM')) acc.rem += minutes;
  else if (t.includes('LIGHT')) acc.light += minutes;
  else if (t.includes('AWAKE') || t.includes('WAKE')) acc.awake += minutes;
}

function mapHrv(points: GHDataPoint[], ensure: (day: string) => RecoveryObservation): void {
  // heart-rate-variability is a sample type; average the nightly RMSSD samples
  // per local day into one overnight value.
  const byDay = new Map<string, number[]>();
  for (const dp of points) {
    const value = obj(dp.heartRateVariability);
    if (!value) continue;
    const rmssd = num(value.rootMeanSquareOfSuccessiveDifferencesMilliseconds);
    const when = sampleDay(value.sampleTime);
    if (rmssd === undefined || !when) continue;
    const list = byDay.get(when) ?? [];
    list.push(rmssd);
    byDay.set(when, list);
  }
  for (const [day, values] of byDay) {
    ensure(day).hrvRmssdMs = round(values.reduce((t, v) => t + v, 0) / values.length, 1);
  }
}

function mapDaily(
  points: GHDataPoint[],
  field: string,
  ensure: (day: string) => RecoveryObservation,
  apply: (value: Record<string, unknown>, record: RecoveryObservation) => void,
): void {
  for (const dp of points) {
    const value = obj((dp as Record<string, unknown>)[field]);
    if (!value) continue;
    const day = googleDate(value.date);
    if (!day) continue;
    apply(value, ensure(day));
  }
}

// --- ingest ------------------------------------------------------------------

async function postRecords(records: RecoveryObservation[]): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/api/ingest/daily-recovery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ingestKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'fitbit', replace, records }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Ingest failed: ${res.status} ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

// --- Google Health JSON shapes (loose; confirm with --print-raw) -------------

interface GHDataPoint {
  name?: string;
  dataSource?: unknown;
  [key: string]: unknown;
}
interface GHListResponse {
  dataPoints?: unknown;
  nextPageToken?: unknown;
}

// --- helpers -----------------------------------------------------------------

function googleDate(value: unknown): string | undefined {
  const d = obj(value);
  if (!d) return undefined;
  const y = num(d.year);
  const m = num(d.month);
  const day = num(d.day);
  if (y === undefined || m === undefined || day === undefined) return undefined;
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function sampleDay(sampleTime: unknown): string | undefined {
  const st = obj(sampleTime);
  if (st) {
    // Prefer the local civil date ({ civilTime: { date: {year,month,day} } }).
    const civil = obj(st.civilTime);
    const civilDate = civil ? googleDate(civil.date) : undefined;
    if (civilDate) return civilDate;
    const physical = ts(st.physicalTime);
    if (physical !== undefined) return isoDay(new Date(physical));
  }
  const direct = ts(sampleTime);
  return direct === undefined ? undefined : isoDay(new Date(direct));
}

function ts(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : undefined;
  }
  const o = obj(value);
  if (o && typeof o.seconds !== 'undefined') {
    const s = num(o.seconds);
    return s === undefined ? undefined : s * 1000;
  }
  return undefined;
}

function durationSec(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const m = value.match(/^(-?\d+(?:\.\d+)?)s$/); // proto Duration JSON, e.g. "1800s"
    return m ? Number(m[1]) : undefined;
  }
  const o = obj(value);
  if (o && typeof o.seconds !== 'undefined') return num(o.seconds);
  return undefined;
}

function hasSignal(record: RecoveryObservation): boolean {
  return Object.entries(record).some(
    ([key, value]) => key !== 'day' && key !== 'source' && value !== undefined,
  );
}

function num(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : undefined;
  return n !== undefined && Number.isFinite(n) ? n : undefined;
}
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function obj(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function round(value: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
function dateArg(name: string): string | undefined {
  const value = argValue(name);
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${name} must be YYYY-MM-DD.`);
  return value;
}
function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function backoff(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** (attempt - 1));
}

await main();
