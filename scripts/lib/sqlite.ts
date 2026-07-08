import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function sqliteJson<T>(
  dbPath: string,
  sql: string,
  options: { maxBuffer?: number } = {},
): Promise<T[]> {
  try {
    const { stdout } = await execFileAsync('sqlite3', ['-json', dbPath, sql], {
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    });
    const text = stdout.trim();
    return text ? (JSON.parse(text) as T[]) : [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`sqlite3 query failed: ${message}`);
  }
}

export async function sqliteScalar(dbPath: string, sql: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('sqlite3', [dbPath, sql], {
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`sqlite3 query failed: ${message}`);
  }
}
