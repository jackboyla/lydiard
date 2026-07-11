// Imports the manual RUNMASTER Google Sheet CSV exports into Lydiard.
//
//   npm run plan:import -- --dry-run
//   LYDIARD_INGEST_KEY='...' npm run plan:import -- --validate
//   LYDIARD_INGEST_KEY='...' npm run plan:import
//
// Pass CSV paths explicitly or leave them out to read `tmp/RUNMASTER - *.csv`.
// `--validate` asks the Worker to match every legacy Actual duration against
// Garmin without writing. `--overwrite` intentionally replaces prior edits.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import Papa from 'papaparse';

interface PlanImportDay {
  date: string;
  plannedText: string;
  legacyActualText: string;
  notes: string;
  sourceFile: string;
}

interface PlanImportResponse {
  ok?: boolean;
  dryRun?: boolean;
  imported?: number;
  actualRows?: number;
  matchedRows?: number;
  matchedActivities?: number;
  maxDeltaMinutes?: number | null;
  unmatchedDates?: string[];
  [key: string]: unknown;
}

const rawArgs = process.argv.slice(2);
const dryRun = rawArgs.includes('--dry-run');
const validateOnly = rawArgs.includes('--validate');
const overwrite = rawArgs.includes('--overwrite');
const requireActualMatches = !rawArgs.includes('--allow-unmatched');
const fileArgs = rawArgs.filter((arg) => !arg.startsWith('--'));
const baseUrl = (process.env.LYDIARD_BASE_URL ?? 'https://lydiard.lydiard.workers.dev').replace(/\/$/, '');
const ingestKey = process.env.LYDIARD_INGEST_KEY ?? process.env.AGENT_API_KEY;

if (!dryRun && !ingestKey) {
  throw new Error('Set LYDIARD_INGEST_KEY or AGENT_API_KEY, or run with --dry-run.');
}

const files = fileArgs.length > 0 ? fileArgs : await defaultPlanFiles();
if (files.length === 0) {
  throw new Error('No plan CSV files found. Pass paths or place RUNMASTER exports in tmp/.');
}

const byDate = new Map<string, PlanImportDay>();
for (const file of files) {
  const parsed = await parsePlanFile(file);
  for (const day of parsed) {
    const existing = byDate.get(day.date);
    if (existing && !sameDay(existing, day)) {
      throw new Error(`Conflicting plan rows for ${day.date} in ${existing.sourceFile} and ${day.sourceFile}.`);
    }
    byDate.set(day.date, day);
  }
}

const calendarDays = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
const days = calendarDays.filter((day) => day.plannedText.length > 0 || day.legacyActualText.length > 0 || day.notes.length > 0);
const summary = {
  files: files.map((file) => path.basename(file)),
  calendarRows: calendarDays.length,
  meaningfulRows: days.length,
  plannedRows: days.filter((day) => day.plannedText.length > 0).length,
  actualRows: days.filter((day) => day.legacyActualText.length > 0).length,
  noteRows: days.filter((day) => day.notes.length > 0).length,
  first: days[0]?.date ?? null,
  last: days[days.length - 1]?.date ?? null,
};

if (dryRun) {
  console.log(JSON.stringify({ ok: true, dryRun: true, ...summary }, null, 2));
} else {
  const response = await postPlan(days, validateOnly);
  console.log(JSON.stringify({ ok: true, validateOnly, overwrite, requireActualMatches, ...summary, ...response }, null, 2));
}

async function defaultPlanFiles(): Promise<string[]> {
  const directory = path.resolve('tmp');
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }
  return entries
    .filter((name) => /^RUNMASTER - .+\.csv$/i.test(name))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => path.join(directory, name));
}

async function parsePlanFile(file: string): Promise<PlanImportDay[]> {
  const csv = await readFile(file, 'utf8');
  const result = Papa.parse<string[]>(csv, { skipEmptyLines: false });
  if (result.errors.length > 0) {
    const first = result.errors[0];
    throw new Error(`${path.basename(file)} CSV parse failed at row ${first.row ?? 'unknown'}: ${first.message}`);
  }

  const rows = result.data;
  const headerIndex = rows.findIndex(
    (row) =>
      (row[0] ?? '').trim() === 'Date' &&
      (row[1] ?? '').trim() === 'Planned' &&
      (row[2] ?? '').trim() === 'Actual' &&
      (row[3] ?? '').trim() === 'Notes',
  );
  if (headerIndex < 0) {
    throw new Error(`${path.basename(file)} does not contain the Date/Planned/Actual/Notes header.`);
  }

  const title = rows.slice(0, headerIndex).map((row) => row[0] ?? '').find((value) => /\b\d{4}\b/.test(value));
  const yearMatch = title?.match(/\b(\d{4})\b/);
  if (!yearMatch) {
    throw new Error(`${path.basename(file)} does not declare a year before the header.`);
  }
  const year = Number(yearMatch[1]);
  const sourceFile = path.basename(file);
  const days: PlanImportDay[] = [];

  for (const row of rows.slice(headerIndex + 1)) {
    const dateLabel = row[0] ?? '';
    const match = dateLabel.trim().match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2})\s+([A-Za-z]{3})$/);
    if (!match) {
      continue;
    }
    const date = toDateKey(year, match[3], Number(match[2]));
    validateWeekday(date, match[1], sourceFile);
    days.push({
      date,
      // Do not trim these cells. The migration promise is verbatim decoded text,
      // including intentional newlines and leading/trailing whitespace.
      plannedText: row[1] ?? '',
      legacyActualText: row[2] ?? '',
      notes: row[3] ?? '',
      sourceFile,
    });
  }
  return days;
}

function toDateKey(year: number, monthLabel: string, day: number): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months.findIndex((value) => value.toLowerCase() === monthLabel.toLowerCase());
  if (month < 0) {
    throw new Error(`Unknown month label: ${monthLabel}`);
  }
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) {
    throw new Error(`Invalid plan date: ${day} ${monthLabel} ${year}`);
  }
  return date.toISOString().slice(0, 10);
}

function validateWeekday(dateKey: string, expected: string, sourceFile: string): void {
  const actual = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' }).format(
    new Date(`${dateKey}T00:00:00Z`),
  );
  if (actual !== expected) {
    throw new Error(`${sourceFile} labels ${dateKey} as ${expected}, but it is ${actual}.`);
  }
}

function sameDay(a: PlanImportDay, b: PlanImportDay): boolean {
  return a.plannedText === b.plannedText && a.legacyActualText === b.legacyActualText && a.notes === b.notes;
}

async function postPlan(days: PlanImportDay[], serverDryRun: boolean): Promise<PlanImportResponse> {
  const body = JSON.stringify({
    source: 'legacy-google-sheet',
    overwrite,
    dryRun: serverDryRun,
    requireActualMatches,
    days,
  });
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/ingest/plan`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ingestKey}`, 'Content-Type': 'application/json' },
        body,
      });
      const text = await response.text();
      const payload = text ? (JSON.parse(text) as PlanImportResponse & { error?: string }) : {};
      if (response.ok) {
        return payload;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
        console.warn(`plan import attempt ${attempt} failed: ${response.status} ${payload.error ?? text}`);
        await sleep(Math.min(30_000, 2000 * 2 ** (attempt - 1)));
        continue;
      }
      throw new Error(`plan import failed: ${response.status} ${payload.error ?? text}`);
    } catch (error) {
      if (attempt === maxAttempts || (error instanceof Error && error.message.startsWith('plan import failed:'))) {
        throw error;
      }
      await sleep(Math.min(30_000, 2000 * 2 ** (attempt - 1)));
    }
  }
  throw new Error('plan import failed unexpectedly.');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
