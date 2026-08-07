import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const TOKEN_URL = process.env.GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token';
const DRIVE_API = process.env.GOOGLE_DRIVE_API_URL ?? 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = process.env.GOOGLE_DRIVE_UPLOAD_URL ?? 'https://www.googleapis.com/upload/drive/v3';
const DAILY_KEEP = 35;
const MONTHLY_KEEP = 12;

const archivePath = resolve(requiredArg('--archive'));
const manifestPath = resolve(requiredArg('--manifest'));
const clientId = requiredEnv('GOOGLE_DRIVE_BACKUP_CLIENT_ID');
const clientSecret = requiredEnv('GOOGLE_DRIVE_BACKUP_CLIENT_SECRET');
const refreshToken = requiredEnv('GOOGLE_DRIVE_BACKUP_REFRESH_TOKEN');
const folderId = requiredEnv('GOOGLE_DRIVE_BACKUP_FOLDER_ID');
const forceMonthly = process.argv.includes('--force-monthly');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { createdAt: string; archiveSha256: string };
const snapshotId = manifest.createdAt;
const stamp = snapshotId.replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
const accessToken = await exchangeRefreshToken();

await assertFolder();
const uploads: DriveFile[] = [];
uploads.push(...await uploadSnapshot('daily'));
if (forceMonthly || new Date(snapshotId).getUTCDate() === 1) uploads.push(...await uploadSnapshot('monthly'));

const deleted = [
  ...await pruneCadence('daily', DAILY_KEEP),
  ...await pruneCadence('monthly', MONTHLY_KEEP),
];

console.log(JSON.stringify({
  ok: true,
  folderId,
  folderUrl: `https://drive.google.com/drive/folders/${folderId}`,
  snapshotId,
  uploads: uploads.map(({ id, name, size, md5Checksum }) => ({ id, name, size, md5Checksum })),
  deleted,
}, null, 2));

async function uploadSnapshot(cadence: 'daily' | 'monthly'): Promise<DriveFile[]> {
  const prefix = `lydiard-d1-${cadence}-${stamp}`;
  return [
    await uploadVerified(archivePath, `${prefix}.sql.gz.gpg`, 'application/pgp-encrypted', cadence, 'archive'),
    await uploadVerified(manifestPath, `${prefix}.manifest.json`, 'application/json', cadence, 'manifest'),
  ];
}

async function uploadVerified(
  localPath: string,
  name: string,
  mimeType: string,
  cadence: 'daily' | 'monthly',
  kind: 'archive' | 'manifest',
): Promise<DriveFile> {
  const bytes = await readFile(localPath);
  const md5 = createHash('md5').update(bytes).digest('hex');
  const existing = await findByName(name);
  if (existing) {
    if (existing.md5Checksum !== md5 || Number(existing.size) !== bytes.length) {
      throw new Error(`Drive already has ${name}, but its checksum or size differs.`);
    }
    return existing;
  }

  const start = await fetch(`${DRIVE_UPLOAD}/files?uploadType=resumable&fields=id,name,size,md5Checksum,parents,createdTime,appProperties`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mimeType,
      'X-Upload-Content-Length': String(bytes.length),
    },
    body: JSON.stringify({
      name,
      mimeType,
      parents: [folderId],
      appProperties: {
        lydiardBackup: 'true',
        cadence,
        kind,
        snapshotId,
        archiveSha256: manifest.archiveSha256,
      },
    }),
  });
  if (!start.ok) throw new Error(`Could not start Drive upload for ${name}: ${start.status} ${await start.text()}`);
  const location = start.headers.get('location');
  if (!location) throw new Error(`Drive did not return an upload URL for ${name}.`);

  const finish = await fetch(location, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType, 'Content-Length': String(bytes.length) },
    body: bytes,
  });
  if (!finish.ok) throw new Error(`Drive upload failed for ${name}: ${finish.status} ${await finish.text()}`);
  const uploaded = await finish.json() as DriveFile;
  if (uploaded.md5Checksum !== md5 || Number(uploaded.size) !== bytes.length) {
    throw new Error(`Drive checksum or size verification failed for ${name}.`);
  }
  return uploaded;
}

async function pruneCadence(cadence: 'daily' | 'monthly', keep: number): Promise<string[]> {
  const files = await listFiles();
  const archives = files
    .filter((file) => file.appProperties?.lydiardBackup === 'true' && file.appProperties?.cadence === cadence && file.appProperties?.kind === 'archive')
    .sort((a, b) => String(b.appProperties?.snapshotId).localeCompare(String(a.appProperties?.snapshotId)));
  const staleSnapshots = new Set(archives.slice(keep).map((file) => file.appProperties?.snapshotId).filter(Boolean));
  const staleFiles = files.filter((file) =>
    file.appProperties?.cadence === cadence && staleSnapshots.has(file.appProperties?.snapshotId),
  );
  for (const file of staleFiles) {
    const response = await fetch(`${DRIVE_API}/files/${encodeURIComponent(file.id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error(`Could not delete stale Drive backup ${file.name}: ${response.status} ${await response.text()}`);
  }
  return staleFiles.map((file) => file.name);
}

async function assertFolder(): Promise<void> {
  const response = await fetch(`${DRIVE_API}/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType,trashed`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Drive backup folder is not available to this OAuth token: ${response.status} ${await response.text()}`);
  const folder = await response.json() as { name: string; mimeType: string; trashed?: boolean };
  if (folder.trashed || folder.mimeType !== 'application/vnd.google-apps.folder') {
    throw new Error(`Drive target ${folder.name} is not an active folder.`);
  }
}

async function findByName(name: string): Promise<DriveFile | undefined> {
  const files = await listFiles(`name = '${escapeDriveQuery(name)}'`);
  return files[0];
}

async function listFiles(extraQuery?: string): Promise<DriveFile[]> {
  const all: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const query = [`'${escapeDriveQuery(folderId)}' in parents`, 'trashed = false', extraQuery].filter(Boolean).join(' and ');
    const params = new URLSearchParams({
      q: query,
      spaces: 'drive',
      pageSize: '1000',
      fields: 'nextPageToken,files(id,name,size,md5Checksum,parents,createdTime,appProperties)',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const response = await fetch(`${DRIVE_API}/files?${params}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw new Error(`Could not list Drive backups: ${response.status} ${await response.text()}`);
    const page = await response.json() as { files: DriveFile[]; nextPageToken?: string };
    all.push(...page.files);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return all;
}

async function exchangeRefreshToken(): Promise<string> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
  });
  const body = await response.json() as { access_token?: string; error?: string; error_description?: string };
  if (!response.ok || !body.access_token) throw new Error(`Google token refresh failed: ${body.error_description ?? body.error ?? response.status}`);
  return body.access_token;
}

function requiredArg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
}

function escapeDriveQuery(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

interface DriveFile {
  id: string;
  name: string;
  size?: string;
  md5Checksum?: string;
  parents?: string[];
  createdTime?: string;
  appProperties?: Record<string, string>;
}
