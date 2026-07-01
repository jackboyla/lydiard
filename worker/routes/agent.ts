import { Hono } from 'hono';
import type { Env } from '../env';
import { getActivities, getAthlete, getWeeklyFeatures } from '../db';
import { normalizeFrom, normalizeTo } from '../http';
import { buildPlanContext } from '../planContext';
import { runSync } from '../sync';
import { loadAnalyses } from './public';

function athleteName(firstname: string | null | undefined, lastname: string | null | undefined): string | null {
  const name = [firstname, lastname].filter(Boolean).join(' ').trim();
  return name || null;
}

export function agentRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // API-key guard for every agent endpoint. Accepts the key either as a Bearer
  // header (Custom GPT Actions, scripts) OR as a ?key= / ?token= query param, so a
  // plain ChatGPT chat — which can only fetch anonymous URLs — can reach it too.
  // Note: a key in the URL is logged in more places than a header; prefer the
  // header where possible and use a dedicated, rotatable key for URL access.
  app.use('*', async (c, next) => {
    const expected = c.env.AGENT_API_KEY;
    const header = c.req.header('Authorization') ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const queryKey = c.req.query('key') ?? c.req.query('token') ?? '';
    const provided = bearer || queryKey;
    if (!expected || provided !== expected) {
      return c.json({ error: 'Unauthorized. Provide the API key via Bearer header or ?key=.' }, 401);
    }
    await next();
  });

  app.get('/weeks', async (c) => {
    const weeks = await getWeeklyFeatures(c.env.lydiard, {
      from: normalizeFrom(c.req.query('from')),
      to: normalizeTo(c.req.query('to')),
    });
    return c.json({ weeks });
  });

  app.get('/activities', async (c) => {
    const activities = await getActivities(c.env.lydiard, {
      from: normalizeFrom(c.req.query('from')),
      to: normalizeTo(c.req.query('to')),
    });
    // Strip heavy polyline strings from the agent list; agents want metrics, not geometry.
    const trimmed = activities.map(({ summaryPolyline, ...rest }) => rest);
    return c.json({ activities: trimmed });
  });

  app.get('/risk', async (c) => {
    const analyses = await loadAnalyses(c.env);
    if (analyses.length === 0) {
      return c.json({ error: 'No analyzed weeks yet.' }, 404);
    }
    const asOf = normalizeTo(c.req.query('asOf'));
    const selected = asOf
      ? [...analyses].reverse().find((analysis) => analysis.week.weekStart <= asOf) ?? analyses[analyses.length - 1]
      : analyses[analyses.length - 1];
    return c.json(selected);
  });

  app.get('/plan-context', async (c) => {
    const [analyses, athlete] = await Promise.all([loadAnalyses(c.env), getAthlete(c.env.lydiard)]);
    const context = buildPlanContext(
      analyses,
      athlete ? athleteName(athlete.firstname, athlete.lastname) : null,
      normalizeFrom(c.req.query('from')) ?? null,
      normalizeTo(c.req.query('to')) ?? null,
      new Date().toISOString(),
    );
    return c.json(context);
  });

  app.post('/sync', async (c) => {
    // Kick off a sync in the background so the request returns promptly.
    c.executionCtx.waitUntil(
      runSync(c.env, c.env.lydiard).catch(async (error: unknown) => {
        const { updateSyncState } = await import('../db');
        await updateSyncState(c.env.lydiard, { last_error: error instanceof Error ? error.message : String(error) });
      }),
    );
    return c.json({ ok: true, message: 'Sync started.' }, 202);
  });

  return app;
}
