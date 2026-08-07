import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

export interface D1ValidationReport {
  exportBytes: number;
  integrity: string;
  foreignKeyIssues: number;
  tableCounts: Record<string, number>;
}

const REQUIRED_TABLES = [
  'activities',
  'activity_streams',
  'athlete',
  'sync_state',
  'training_plan_days',
  'planned_sessions',
  'coach_profile',
];

export async function validateD1Export(
  sqlPath: string,
  sqlitePath: string,
  minimumActivities: number,
  minimumStreams: number,
): Promise<D1ValidationReport> {
  const exportStat = await stat(sqlPath);
  if (exportStat.size < 256) throw new Error(`D1 export is too small (${exportStat.size} bytes).`);

  const sql = await readFile(sqlPath, 'utf8');
  const db = new DatabaseSync(sqlitePath);
  try {
    db.exec(sql);
    const integrityRows = db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>;
    const integrity = String(Object.values(integrityRows[0] ?? {})[0] ?? 'missing');
    if (integrity !== 'ok') throw new Error(`Restored SQLite integrity check failed: ${integrity}`);

    const foreignKeyIssues = db.prepare('PRAGMA foreign_key_check').all().length;
    if (foreignKeyIssues !== 0) throw new Error(`Restored SQLite has ${foreignKeyIssues} foreign-key issue(s).`);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = new Set(tables.map((row) => row.name));
    const missing = REQUIRED_TABLES.filter((name) => !names.has(name));
    if (missing.length) throw new Error(`D1 export is missing required table(s): ${missing.join(', ')}`);

    const tableCounts: Record<string, number> = {};
    for (const { name } of tables) {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`).get() as { count: number | bigint };
      tableCounts[name] = Number(row.count);
    }
    if ((tableCounts.activities ?? 0) < minimumActivities) {
      throw new Error(`D1 export has ${tableCounts.activities ?? 0} activities; expected at least ${minimumActivities}.`);
    }
    if ((tableCounts.activity_streams ?? 0) < minimumStreams) {
      throw new Error(`D1 export has ${tableCounts.activity_streams ?? 0} streams; expected at least ${minimumStreams}.`);
    }

    return { exportBytes: exportStat.size, integrity, foreignKeyIssues, tableCounts };
  } finally {
    db.close();
  }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
