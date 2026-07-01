import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Env } from '../env';
import { updateSyncState } from '../db';
import { buildAuthUrl, exchangeCodeForToken } from '../strava';
import { runSync } from '../sync';

const STATE_COOKIE = 'strava_oauth_state';

export function authRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/strava/login', (c) => {
    if (!c.env.STRAVA_CLIENT_ID || !c.env.STRAVA_CLIENT_SECRET) {
      return c.text('Set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET first.', 400);
    }
    const state = crypto.randomUUID();
    setCookie(c, STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 600,
    });
    return c.redirect(buildAuthUrl(c.env, state));
  });

  app.get('/strava/callback', async (c) => {
    const error = c.req.query('error');
    if (error) {
      return c.text(`Strava authorization failed: ${error}`, 400);
    }
    const code = c.req.query('code');
    const state = c.req.query('state');
    const expectedState = getCookie(c, STATE_COOKIE);
    if (!code) {
      return c.text('Missing authorization code.', 400);
    }
    if (expectedState && state !== expectedState) {
      return c.text('OAuth state mismatch.', 400);
    }

    try {
      await exchangeCodeForToken(c.env, c.env.lydiard, code);
    } catch (exchangeError) {
      return c.text(exchangeError instanceof Error ? exchangeError.message : 'Token exchange failed.', 400);
    }

    // First sync in the background so the redirect is instant.
    c.executionCtx.waitUntil(
      runSync(c.env, c.env.lydiard, { force: true }).catch(async (syncError: unknown) => {
        await updateSyncState(c.env.lydiard, {
          last_error: syncError instanceof Error ? syncError.message : String(syncError),
        });
      }),
    );

    if (c.env.APP_ORIGIN) {
      return c.redirect(`${c.env.APP_ORIGIN}/?strava=connected`);
    }
    return c.text('Strava connected. Your first sync is running in the background — you can close this tab.');
  });

  return app;
}
