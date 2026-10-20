import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
import type { Env } from './env';
import { buildOpenApiDocument } from './openapi';
import { publicRoutes } from './routes/public';
import { agentRoutes } from './routes/agent';
import { authRoutes } from './routes/auth';
import { ingestRoutes } from './routes/ingest';
import { coachRoutes } from './routes/coach';
import { refreshAdaptiveZones } from './maintenance';
import { checkinPageRoutes, sendDailyCheckinIfDue, whatsappWebhookRoutes } from './checkins';

const app = new Hono<{ Bindings: Env }>();

// Browser CORS for the Pages frontend. Agent calls are server-to-server (CORS-exempt).
app.use('/api/*', (c, next) => {
  const origin = c.env.APP_ORIGIN || '*';
  return cors({
    origin,
    allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Lydiard-Key'],
  })(c, next);
});

app.get('/openapi.json', (c) => c.json(buildOpenApiDocument(new URL(c.req.url).origin) as object));

app.route('/auth', authRoutes());
app.route('/check-in', checkinPageRoutes());
app.route('/api/whatsapp/webhook', whatsappWebhookRoutes());
app.route('/api/agent', agentRoutes());
app.route('/api/ingest', ingestRoutes());
app.route('/api/coach', coachRoutes());
app.route('/api', publicRoutes());

app.onError((error, c) => {
  return c.json({ error: error instanceof Error ? error.message : 'Unexpected error' }, 500);
});

export default {
  fetch: app.fetch,

  // Cloud cron is the backstop for date-based work. Garmin activity sync runs
  // in GitHub Actions and also asks for this refresh after each final batch.
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const tasks: Promise<unknown>[] = [sendDailyCheckinIfDue(env)];
    // Keep the prior once-daily maintenance cadence even though outreach needs
    // an hourly tick to follow the configured local hour through DST.
    if (new Date(controller.scheduledTime).getUTCHours() === 0) {
      tasks.push(refreshAdaptiveZones(env.lydiard));
    }
    ctx.waitUntil(Promise.all(tasks).then(() => undefined));
  },
};
