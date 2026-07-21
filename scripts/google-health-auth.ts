// One-time OAuth 2.0 bootstrap for the Google Health API (Fitbit recovery).
//
// The Health API rejects API keys — it needs a user-consented OAuth token. This
// runs the standard loopback authorization-code flow: it opens Google's consent
// screen, captures the redirect on a local port, exchanges the code, and prints
// a refresh token to save as GOOGLE_HEALTH_REFRESH_TOKEN. The feeder
// (scripts/fitbit-recovery-import.ts) then exchanges that for access tokens.
//
// Prerequisites (Google Cloud console, project with the Health API enabled):
//   - an OAuth 2.0 client (Web application) whose Authorized redirect URIs
//     include the redirect this prints (default http://localhost:8919/oauth2callback);
//   - the OAuth consent screen configured with the scopes you pass below.
//
// Env:
//   GOOGLE_HEALTH_CLIENT_ID       OAuth client id (required)
//   GOOGLE_HEALTH_CLIENT_SECRET   OAuth client secret (required)
//   GOOGLE_HEALTH_SCOPES          space-separated scopes
//                                 (default: "sleep health_metrics_and_measurements")
//   GOOGLE_HEALTH_AUTH_PORT       loopback port (default 8919)
//
// Usage:
//   npm run google-health:auth
//   npm run google-health:auth -- --port 8920 --scopes "sleep health_metrics_and_measurements"

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TIMEOUT_MS = 5 * 60 * 1000;

const clientId = process.env.GOOGLE_HEALTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_HEALTH_CLIENT_SECRET;
const port = Number(argValue('--port') ?? process.env.GOOGLE_HEALTH_AUTH_PORT ?? '8919');
const scopes = (argValue('--scopes') ?? process.env.GOOGLE_HEALTH_SCOPES ?? 'sleep health_metrics_and_measurements').trim();
const redirectUri = `http://localhost:${port}/oauth2callback`;

if (!clientId || !clientSecret) {
  throw new Error('Set GOOGLE_HEALTH_CLIENT_ID and GOOGLE_HEALTH_CLIENT_SECRET (e.g. source ~/.config/secrets.sh).');
}
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error('--port / GOOGLE_HEALTH_AUTH_PORT must be a valid TCP port.');
}

const state = randomBytes(16).toString('hex');
const consentUrl = new URL(AUTH_URL);
consentUrl.searchParams.set('client_id', clientId);
consentUrl.searchParams.set('redirect_uri', redirectUri);
consentUrl.searchParams.set('response_type', 'code');
consentUrl.searchParams.set('scope', scopes);
consentUrl.searchParams.set('access_type', 'offline'); // ask for a refresh token
consentUrl.searchParams.set('prompt', 'consent'); // force refresh_token issuance every run
consentUrl.searchParams.set('include_granted_scopes', 'true');
consentUrl.searchParams.set('state', state);

let settled = false;
const timer = setTimeout(() => fail(new Error('Timed out waiting for consent (5 min).')), TIMEOUT_MS);

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  if (url.pathname !== '/oauth2callback') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  void handleCallback(url, res);
});

server.on('error', (error) => fail(error));
server.listen(port, () => {
  console.log(`\nAuthorize the Google Health API (scopes: ${scopes}).`);
  console.log(`Make sure this redirect URI is registered on your OAuth client:\n  ${redirectUri}\n`);
  console.log('Open this URL in a browser (attempting to open it for you):\n');
  console.log(`${consentUrl.toString()}\n`);
  console.log(`Waiting for the redirect back to ${redirectUri} ...`);
  tryOpenBrowser(consentUrl.toString());
});

async function handleCallback(url: URL, res: ServerResponse): Promise<void> {
  const error = url.searchParams.get('error');
  if (error) {
    respond(res, 400, `Consent was denied or failed: ${error}. You can close this tab.`);
    fail(new Error(`Authorization failed: ${error}`));
    return;
  }
  if (url.searchParams.get('state') !== state) {
    respond(res, 400, 'State mismatch — possible CSRF. You can close this tab.');
    fail(new Error('OAuth state mismatch.'));
    return;
  }
  const code = url.searchParams.get('code');
  if (!code) {
    respond(res, 400, 'No authorization code returned. You can close this tab.');
    fail(new Error('No authorization code in the redirect.'));
    return;
  }
  try {
    const tokens = await exchangeCode(code);
    respond(res, 200, 'Success! Google Health API authorized. Return to your terminal for the refresh token.');
    printTokens(tokens);
    done(0);
  } catch (exchangeError) {
    respond(res, 500, 'Token exchange failed. Check the terminal.');
    fail(exchangeError instanceof Error ? exchangeError : new Error(String(exchangeError)));
  }
}

async function exchangeCode(code: string): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({
    code,
    client_id: clientId as string,
    client_secret: clientSecret as string,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

function printTokens(tokens: Record<string, unknown>): void {
  const refresh = typeof tokens.refresh_token === 'string' ? tokens.refresh_token : undefined;
  console.log('\n===== SUCCESS =====');
  if (refresh) {
    console.log('\nSave this (e.g. append to ~/.config/secrets.sh):\n');
    console.log(`export GOOGLE_HEALTH_REFRESH_TOKEN='${refresh}'`);
  } else {
    console.log(
      '\nNo refresh_token was returned. Google only issues one with access_type=offline and prompt=consent ' +
        '(both are set here). If it is still missing, revoke prior access at https://myaccount.google.com/permissions and re-run.',
    );
  }
  const expires = typeof tokens.expires_in === 'number' ? tokens.expires_in : undefined;
  if (typeof tokens.access_token === 'string') {
    console.log(`\n(an access token was also issued${expires ? `, expires in ${expires}s` : ''}.)`);
  }
  console.log('\nNext: source your secrets, then  npm run fitbit:import -- --print-raw');
}

function respond(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;line-height:1.5"><h2>Lydiard × Google Health</h2><p>${message}</p></body>`);
}

function tryOpenBrowser(url: string): void {
  const platform = process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
      /* headless / no browser — the printed URL is the fallback */
    });
    child.unref();
  } catch {
    /* ignore — the URL is printed above */
  }
}

function done(code: number): void {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  server.close(() => process.exit(code));
}

function fail(error: Error): void {
  if (settled) return;
  console.error(`\n${error.message}`);
  done(1);
}

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}
