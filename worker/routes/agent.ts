import { Hono } from 'hono';
import type { Env } from '../env';
import { getActivities, getActivity, getActivityLaps, getAthlete, getDailyRecoveries, getPlannedSessions, getWeeklyFeatures } from '../db';
import { normalizeFrom, normalizeTo } from '../http';
import { buildPlanContext } from '../planContext';
import { runSync } from '../sync';
import { loadAnalyses } from './public';
import { buildCoachContext } from '../coachContext';
import { AgentPlanConflictError, AgentPlanInputError, parseAgentPlanSubmission, publishAgentPlan } from '../agentPlan';
import { EXPERT_WISDOM_SOURCES, getExpertWisdom } from '../expertWisdom';
import { compactAgentCoachContext } from '../agentCoachContext';
import { analyzeRecovery, summarizeRecovery } from '../../src/analysis/recovery';

function athleteName(firstname: string | null | undefined, lastname: string | null | undefined): string | null {
  const name = [firstname, lastname].filter(Boolean).join(' ').trim();
  return name || null;
}

const RECOVERY_INSTRUCTIONS =
  "Overnight recovery normalized to THIS runner's own 28-night rolling baseline (median + MAD), not population norms. " +
  '`summary.state` is the actionable latent recovery state; a single off-baseline night is deliberately held at ' +
  '"slightly_suppressed" — only multi-day agreement or a systemic illness pattern (skin-temp + respiration + autonomic) ' +
  'escalates it to suppressed/high_stress. Use this as the recovery + illness layer alongside training load and ' +
  'performance response; treat readiness (readinessCrossCheck) as a cross-check only, never as an independent input.';

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

  app.get('/activities/:id', async (c) => {
    const activity = await getActivity(c.env.lydiard, c.req.param('id'));
    if (!activity) {
      return c.json({ error: 'Activity not found.' }, 404);
    }
    const laps = await getActivityLaps(c.env.lydiard, activity.id);
    const { summaryPolyline, ...summary } = activity;
    return c.json({
      ...summary,
      lapDataStatus: laps.length > 0 ? 'recorded' as const : 'unavailable' as const,
      laps,
    });
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

  app.get('/daily-recovery', async (c) => {
    const from = normalizeFrom(c.req.query('from'));
    const to = normalizeTo(c.req.query('to'));
    // Analyze the full history so personal baselines are correct, then scope the
    // returned rows (mirrors loadAnalyses for the weekly risk endpoint).
    const analyzed = analyzeRecovery(await getDailyRecoveries(c.env.lydiard));
    const summary = summarizeRecovery(to ? analyzed.filter((day) => day.day <= to) : analyzed);
    const inRange = analyzed.filter((day) => (!from || day.day >= from) && (!to || day.day <= to));
    const scoped = from || to ? inRange : analyzed.slice(-35);
    return c.json({
      generatedAt: new Date().toISOString(),
      asOf: summary.asOf,
      range: { from: from ?? null, to: to ?? null, days: scoped.length },
      summary,
      records: scoped,
      instructions: RECOVERY_INSTRUCTIONS,
    });
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

  app.get('/planned-sessions', async (c) => {
    const from = agentDate(c.req.query('from'));
    const to = agentDate(c.req.query('to'));
    if (!from || !to) return c.json({ error: 'from and to are required in YYYY-MM-DD form.' }, 400);
    const fromTime = Date.parse(`${from}T00:00:00Z`);
    const toTime = Date.parse(`${to}T00:00:00Z`);
    if (toTime < fromTime || toTime - fromTime > 6 * 86_400_000) {
      return c.json({ error: 'Request one calendar week at a time: to must be from through at most from + 6 days.' }, 400);
    }
    return c.json({ from, to, sessions: await getPlannedSessions(c.env.lydiard, { from, to }) });
  });

  app.get('/coach-context', async (c) => {
    const rawLookback = c.req.query('lookbackDays');
    const lookbackDays = rawLookback && /^\d+$/.test(rawLookback) ? Number(rawLookback) : undefined;
    const rawHorizon = c.req.query('horizonWeeks');
    const horizonWeeks = rawHorizon && /^\d+$/.test(rawHorizon) ? Number(rawHorizon) : undefined;
    const context = await buildCoachContext(c.env.lydiard, {
      asOf: c.req.query('asOf'),
      weekStart: c.req.query('weekStart'),
      lookbackDays,
      horizonWeeks,
    });
    return c.json(compactAgentCoachContext(context));
  });

  app.get('/expert-wisdom', (c) => {
    const source = c.req.query('source') ?? 'all';
    if (source !== 'all' && !EXPERT_WISDOM_SOURCES.some((item) => item.id === source)) {
      return c.json({ error: 'source must be all, scullion, or magness.' }, 400);
    }
    return c.json(getExpertWisdom(source));
  });

  app.post('/plans', async (c) => {
    try {
      const body = await c.req.json<unknown>();
      const submission = parseAgentPlanSubmission(body);
      const result = await publishAgentPlan(c.env.lydiard, submission);
      return c.json(result, result.idempotent ? 200 : 201);
    } catch (error) {
      if (error instanceof AgentPlanInputError) return c.json({ error: error.message }, 400);
      if (error instanceof AgentPlanConflictError) return c.json({ error: error.message }, 409);
      if (error instanceof SyntaxError) return c.json({ error: 'Request body must be valid JSON.' }, 400);
      throw error;
    }
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

function agentDate(value: string | undefined): string | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : undefined;
}
