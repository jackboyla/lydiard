import { createGunzip } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { sha256File, validateD1Export } from './lib/d1Backup';

const archivePath = resolve(process.argv[2] ?? '');
const manifestPath = resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
  throw new Error('Usage: npm run backup:verify -- <archive.sql.gz.gpg> <manifest.json>');
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
  archiveBytes: number;
  archiveSha256: string;
  validation: { tableCounts: Record<string, number> };
};
const archiveStat = await stat(archivePath);
if (archiveStat.size !== manifest.archiveBytes) throw new Error('Archive size does not match its manifest.');
if (await sha256File(archivePath) !== manifest.archiveSha256) throw new Error('Archive SHA-256 does not match its manifest.');

// Defaults sit under the owner's private config dir; both are overridable for other machines.
const secretsDir = process.env.LYDIARD_BACKUP_DIR
  ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'lydiard-backup');
const home = process.env.LYDIARD_BACKUP_GNUPGHOME ?? join(secretsDir, 'gnupg');
const passphraseFile = process.env.LYDIARD_BACKUP_PASSPHRASE_FILE ?? join(secretsDir, 'recovery-passphrase.txt');
const tempDir = await mkdtemp(join(tmpdir(), 'lydiard-d1-verify-'));
const gzipPath = join(tempDir, 'backup.sql.gz');
const sqlPath = join(tempDir, 'backup.sql');
const sqlitePath = join(tempDir, 'restore-check.sqlite');

try {
  await run('gpg', [
    '--batch',
    '--yes',
    '--homedir',
    home,
    '--pinentry-mode',
    'loopback',
    '--passphrase-file',
    passphraseFile,
    '--output',
    gzipPath,
    '--decrypt',
    archivePath,
  ]);
  await pipeline(createReadStream(gzipPath), createGunzip(), createWriteStream(sqlPath, { mode: 0o600 }));
  const report = await validateD1Export(sqlPath, sqlitePath, 1, 1);
  if (JSON.stringify(report.tableCounts) !== JSON.stringify(manifest.validation.tableCounts)) {
    throw new Error('Restored table counts do not match the manifest.');
  }
  console.log(JSON.stringify({ ok: true, archivePath, integrity: report.integrity, foreignKeyIssues: report.foreignKeyIssues, tableCounts: report.tableCounts }, null, 2));
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${code ?? 'no status'}.`)));
  });
}
