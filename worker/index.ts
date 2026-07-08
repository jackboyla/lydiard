import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
import type { Env } from './env';
import { updateSyncState } from './db';
import { runSync } from './sync';
import { buildOpenApiDocument } from './openapi';
import { publicRoutes } from './routes/public';
import { agentRoutes } from './routes/agent';
import { authRoutes } from './routes/auth';
import { ingestRoutes } from './routes/ingest';

const app = new Hono<{ Bindings: Env }>();

// Browser CORS for the Pages frontend. Agent calls are server-to-server (CORS-exempt).
app.use('/api/*', (c, next) => {
  const origin = c.env.APP_ORIGIN || '*';
  return cors({
    origin,
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Lydiard-Key'],
  })(c, next);
});

app.get('/', (c) => c.json({ name: 'lydiard', ok: true }));
app.get('/openapi.json', (c) => c.json(buildOpenApiDocument(new URL(c.req.url).origin) as object));

app.route('/auth', authRoutes());
app.route('/api/agent', agentRoutes());
app.route('/api/ingest', ingestRoutes());
app.route('/api', publicRoutes());

app.onError((error, c) => {
  return c.json({ error: error instanceof Error ? error.message : 'Unexpected error' }, 500);
});

export default {
  fetch: app.fetch,

  // Cloud cron — keeps the store fresh with no local machine.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runSync(env, env.lydiard).catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        // Strava is legacy; Garmin data is synced via GitHub Actions. Don't record
        // the "Strava is not connected" noise as a sync error the UI would surface.
        if (/strava is not connected/i.test(message)) {
          return;
        }
        await updateSyncState(env.lydiard, { last_error: message });
      }),
    );
  },
};
