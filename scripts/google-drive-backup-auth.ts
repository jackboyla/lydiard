import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const TIMEOUT_MS = 10 * 60 * 1000;

const clientId = process.env.GOOGLE_DRIVE_BACKUP_CLIENT_ID ?? process.env.GOOGLE_HEALTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_DRIVE_BACKUP_CLIENT_SECRET ?? process.env.GOOGLE_HEALTH_CLIENT_SECRET;
const port = Number(argValue('--port') ?? '8919');
const redirectUri = `http://localhost:${port}/oauth2callback`;
if (!clientId || !clientSecret) throw new Error('Set GOOGLE_DRIVE_BACKUP_CLIENT_ID/SECRET or GOOGLE_HEALTH_CLIENT_ID/SECRET.');
if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('--port must be a valid TCP port.');

const state = randomBytes(24).toString('hex');
const consentUrl = new URL(AUTH_URL);
consentUrl.searchParams.set('client_id', clientId);
consentUrl.searchParams.set('redirect_uri', redirectUri);
consentUrl.searchParams.set('response_type', 'code');
consentUrl.searchParams.set('scope', DRIVE_SCOPE);
consentUrl.searchParams.set('access_type', 'offline');
consentUrl.searchParams.set('prompt', 'consent');
consentUrl.searchParams.set('include_granted_scopes', 'false');
consentUrl.searchParams.set('state', state);

let settled = false;
const timer = setTimeout(() => fail(new Error('Timed out waiting for Google Drive consent.')), TIMEOUT_MS);
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  if (url.pathname !== '/oauth2callback') return respond(res, 404, 'Not found.');
  void handleCallback(url, res);
});

server.on('error', fail);
server.listen(port, () => {
  console.log(`Register this redirect URI on the Google OAuth client if needed:\n  ${redirectUri}\n`);
  console.log(`Open this URL and allow Lydiard to manage only the Drive files it creates:\n\n${consentUrl}\n`);
  console.log('Waiting for Google to return to the local callback...');
  tryOpenBrowser(String(consentUrl));
});

async function handleCallback(url: URL, res: ServerResponse): Promise<void> {
  try {
    if (url.searchParams.get('state') !== state) throw new Error('OAuth state mismatch.');
    if (url.searchParams.get('error')) throw new Error(`Google consent failed: ${url.searchParams.get('error')}`);
    const code = url.searchParams.get('code');
    if (!code) throw new Error('Google did not return an authorization code.');
    const tokens = await exchangeCode(code);
    if (!tokens.refresh_token || !tokens.access_token) throw new Error('Google did not return both access and refresh tokens.');
    const folder = await findOrCreateArchiveFolder(tokens.access_token);
    setGitHubSecret('GOOGLE_DRIVE_BACKUP_CLIENT_ID', clientId as string);
    setGitHubSecret('GOOGLE_DRIVE_BACKUP_CLIENT_SECRET', clientSecret as string);
    setGitHubSecret('GOOGLE_DRIVE_BACKUP_REFRESH_TOKEN', tokens.refresh_token);
    setGitHubVariable('GOOGLE_DRIVE_BACKUP_FOLDER_ID', folder.id);
    respond(res, 200, 'Drive backup access is ready. You can close this tab.');
    console.log(JSON.stringify({
      ok: true,
      scope: DRIVE_SCOPE,
      folderId: folder.id,
      folderUrl: `https://drive.google.com/drive/folders/${folder.id}`,
      github: { secretsSet: 3, variableSet: 'GOOGLE_DRIVE_BACKUP_FOLDER_ID' },
    }, null, 2));
    done(0);
  } catch (error) {
    respond(res, 500, 'Drive backup setup failed. Check the terminal.');
    fail(error instanceof Error ? error : new Error(String(error)));
  }
}

async function exchangeCode(code: string): Promise<{ access_token?: string; refresh_token?: string }> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId as string, client_secret: clientSecret as string, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });
  const body = await response.json() as { access_token?: string; refresh_token?: string; error_description?: string };
  if (!response.ok) throw new Error(`Google token exchange failed: ${body.error_description ?? response.status}`);
  return body;
}

async function findOrCreateArchiveFolder(accessToken: string): Promise<{ id: string }> {
  const q = `mimeType = '${FOLDER_MIME}' and trashed = false and appProperties has { key='lydiardBackupFolder' and value='true' }`;
  const list = await fetch(`${DRIVE_API}/files?q=${encodeURIComponent(q)}&spaces=drive&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!list.ok) throw new Error(`Could not search Drive folders: ${list.status} ${await list.text()}`);
  const existing = (await list.json() as { files: Array<{ id: string }> }).files[0];
  if (existing) return existing;

  const create = await fetch(`${DRIVE_API}/files?fields=id,name`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'archives', mimeType: FOLDER_MIME, appProperties: { lydiardBackupFolder: 'true' } }),
  });
  if (!create.ok) throw new Error(`Could not create Drive archive folder: ${create.status} ${await create.text()}`);
  return await create.json() as { id: string };
}

function setGitHubSecret(name: string, value: string): void {
  const result = spawnSync('gh', ['secret', 'set', name], { input: value, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`Could not set GitHub secret ${name}: ${String(result.stderr).trim()}`);
}

function setGitHubVariable(name: string, value: string): void {
  const result = spawnSync('gh', ['variable', 'set', name, '--body', value], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`Could not set GitHub variable ${name}: ${String(result.stderr).trim()}`);
}

function respond(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;line-height:1.5"><h2>Lydiard Drive backup</h2><p>${message}</p></body>`);
}

function tryOpenBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch { /* printed URL is the fallback */ }
}

function done(code: number): void {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  server.close(() => process.exit(code));
}

function fail(error: Error): void {
  if (settled) return;
  console.error(error.message);
  done(1);
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
