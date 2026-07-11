import { DatabaseSync } from 'node:sqlite';

export async function sqliteJson<T>(
  dbPath: string,
  sql: string,
  _options: { maxBuffer?: number } = {},
): Promise<T[]> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all() as T[];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SQLite query failed: ${message}`);
  } finally {
    db.close();
  }
}

export async function sqliteScalar(dbPath: string, sql: string): Promise<string> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
    const value = row ? Object.values(row)[0] : undefined;
    return value === undefined || value === null ? '' : String(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SQLite query failed: ${message}`);
  } finally {
    db.close();
  }
}
