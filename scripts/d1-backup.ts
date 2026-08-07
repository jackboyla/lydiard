import { spawn } from 'node:child_process';
import { createGzip } from 'node:zlib';
import { mkdtemp, mkdir, copyFile, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { sha256File, validateD1Export } from './lib/d1Backup';

const database = argValue('--database') ?? process.env.LYDIARD_D1_DATABASE ?? 'lydiard';
const outputDir = resolve(argValue('--output-dir') ?? process.env.BACKUP_OUTPUT_DIR ?? 'progress/backups');
const resultFile = argValue('--result-file');
const sourceSql = argValue('--source-sql');
// The public key is deployment-specific and never committed. Supply it as armored text in
// LYDIARD_BACKUP_PUBLIC_KEY (how CI does it) or as a local file path. See config.example/README.md.
const publicKeyArmored = process.env.LYDIARD_BACKUP_PUBLIC_KEY;
const publicKeyPath = resolve(
  argValue('--public-key') ?? process.env.LYDIARD_BACKUP_PUBLIC_KEY_FILE ?? 'config/lydiard-backup-public.asc',
);
const minimumActivities = numberArg('--min-activities', sourceSql ? 1 : 1000);
const minimumStreams = numberArg('--min-streams', sourceSql ? 1 : 1000);
const createdAt = new Date().toISOString();
const stamp = createdAt.replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
const tempDir = await mkdtemp(join(tmpdir(), 'lydiard-d1-backup-'));
const sqlPath = join(tempDir, 'lydiard.sql');
const restoredPath = join(tempDir, 'restore-check.sqlite');
const compressedPath = join(tempDir, 'lydiard.sql.gz');
const gpgHome = join(tempDir, 'gnupg');
const archivePath = join(outputDir, `lydiard-d1-${stamp}.sql.gz.gpg`);
const manifestPath = join(outputDir, `lydiard-d1-${stamp}.manifest.json`);

try {
  await mkdir(outputDir, { recursive: true });
  if (sourceSql) {
    await copyFile(resolve(sourceSql), sqlPath);
  } else {
    await run('npx', ['wrangler', 'd1', 'export', database, '--remote', '--skip-confirmation', '--output', sqlPath]);
  }

  const validation = await validateD1Export(sqlPath, restoredPath, minimumActivities, minimumStreams);
  await pipeline(createReadStream(sqlPath), createGzip({ level: 9 }), createWriteStream(compressedPath, { mode: 0o600 }));

  await mkdir(gpgHome, { mode: 0o700 });
  const keyFile = await resolvePublicKey();
  await run('gpg', ['--batch', '--homedir', gpgHome, '--import', keyFile]);
  const fingerprint = await publicKeyFingerprint(keyFile, gpgHome);
  await run('gpg', [
    '--batch',
    '--yes',
    '--homedir',
    gpgHome,
    '--trust-model',
    'always',
    '--recipient',
    fingerprint,
    '--output',
    archivePath,
    '--encrypt',
    compressedPath,
  ]);

  const archiveStat = await stat(archivePath);
  const compressedStat = await stat(compressedPath);
  const manifest = {
    formatVersion: 1,
    createdAt,
    database,
    gitCommit: await gitCommit(),
    publicKeyFingerprint: fingerprint,
    archiveFile: basename(archivePath),
    archiveBytes: archiveStat.size,
    archiveSha256: await sha256File(archivePath),
    compressedBytes: compressedStat.size,
    validation,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

  const result = { archivePath, manifestPath, manifest };
  if (resultFile) await writeFile(resolve(resultFile), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

// Writes the armored key to the run's temp dir when it arrives by environment variable, so CI
// never needs a checked-in key file. Falls back to a local path for manual runs.
async function resolvePublicKey(): Promise<string> {
  if (publicKeyArmored?.trim()) {
    const written = join(tempDir, 'backup-public-key.asc');
    await writeFile(written, publicKeyArmored.trim() + '\n', { mode: 0o600 });
    return written;
  }
  try {
    await stat(publicKeyPath);
  } catch {
    throw new Error(
      `No backup public key. Set LYDIARD_BACKUP_PUBLIC_KEY to the armored key, or put the key at ` +
        `${publicKeyPath} (see config.example/README.md).`,
    );
  }
  return publicKeyPath;
}

async function publicKeyFingerprint(keyPath: string, home: string): Promise<string> {
  const output = await capture('gpg', [
    '--batch',
    '--homedir',
    home,
    '--with-colons',
    '--import-options',
    'show-only',
    '--dry-run',
    '--import',
    keyPath,
  ]);
  const fingerprint = output.split('\n').find((line) => line.startsWith('fpr:'))?.split(':')[9];
  if (!fingerprint) throw new Error('Could not read the backup public-key fingerprint.');
  return fingerprint;
}

async function gitCommit(): Promise<string> {
  try {
    return (await capture('git', ['rev-parse', 'HEAD'])).trim();
  } catch {
    return 'unknown';
  }
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${code ?? 'no status'}.`)));
  });
}

async function capture(command: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolvePromise(stdout) : reject(new Error(`${command} exited with ${code ?? 'no status'}: ${stderr.trim()}`)));
  });
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function numberArg(name: string, fallback: number): number {
  const raw = argValue(name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
  return value;
}
