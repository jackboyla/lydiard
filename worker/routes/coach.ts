import { Hono, type Context } from 'hono';
import {
  buildLydiardBlock,
  buildLydiardWeek,
  evaluatePlannedVsActual,
  type AthleteFeedback,
  type IntensityTarget,
  type LydiardPhase,
  type PlannedSession as EnginePlannedSession,
  type PlannedSessionType,
  type PostRunEvaluation,
  type ProposedSessionPatch,
  type SessionStressAssessment,
  type WorkoutComponent,
  type ZoneRange,
} from '../../src/analysis/coachEngine';
import { buildCoachContext, loadCoachRuntime } from '../coachContext';
import {
  CoachProfileConflictError,
  getActivity,
  getActivityFeedback,
  getCoachDecision,
  getCoachDecisionByRequestId,
  getCoachDecisions,
  getCoachProfile,
  getCriticalPowerHistory,
  getPlannedActivityLinks,
  getPlannedSession,
  getPlannedSessions,
  patchPlannedSession,
  PlannedSessionConflictError,
  updateCoachDecisionStatus,
  updateCoachProfile,
  upsertActivityCoachMetrics,
  upsertActivityFeedback,
  upsertCoachDecision,
  upsertCriticalPowerRecord,
  upsertPhysiologyEstimate,
  upsertPlannedActivityLink,
  upsertPlannedSession,
  upsertPlannedSessions,
  type ActivityFeedbackInput,
  type CoachDecision,
  type CoachProfilePatch,
  type CriticalPowerInput,
  type PlannedSession,
  type PlannedSessionInput,
  type PlannedSessionStatus,
} from '../db';
import type { Env } from '../env';

const MODEL_VERSION = 'coach-engine-v1';

export function coachRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.use('*', async (c, next) => {
    const expected = c.env.SITE_PASSWORD;
    if (expected && c.req.header('X-Lydiard-Key') !== expected) {
      return c.json({ error: 'This training data is private. Enter the site password.' }, 401);
    }
    await next();
  });

  app.get('/context', async (c) => {
    try {
      const context = await buildCoachContext(c.env.lydiard, {
        asOf: c.req.query('asOf'),
        lookbackDays: optionalInteger(c.req.query('lookbackDays')),
        weekStart: c.req.query('weekStart'),
      });
      return c.json(context);
    } catch (error) {
      return inputError(c, error);
    }
  });

  app.patch('/profile', async (c) => {
    const body = await objectBody(c);
    if (!body) return c.json({ error: 'Request body must be a JSON object.' }, 400);
    const expectedVersion = integer(body.expectedVersion);
    if (!expectedVersion || expectedVersion < 1) {
      return c.json({ error: 'expectedVersion must be a positive integer.' }, 400);
    }
    const patchSource = isRecord(body.patch) ? body.patch : body;
    const patch = parseProfilePatch(patchSource);
    if (patch instanceof Error) return c.json({ error: patch.message }, 400);
    try {
      const profile = await updateCoachProfile(c.env.lydiard, patch, expectedVersion);
      return c.json({ profile });
    } catch (error) {
      if (error instanceof CoachProfileConflictError) {
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }
  });

  app.post('/critical-power', async (c) => {
    const body = await objectBody(c);
    if (!body) return c.json({ error: 'Request body must be a JSON object.' }, 400);
    const parsed = parseCriticalPower(body);
    if (parsed instanceof Error) return c.json({ error: parsed.message }, 400);

    const sameEffectiveDate = (await getCriticalPowerHistory(c.env.lydiard, {
      from: parsed.effectiveFrom,
      to: parsed.effectiveFrom,
      device: parsed.device,
    }))[0];
    if (sameEffectiveDate) {
      if (Math.abs(sameEffectiveDate.criticalPowerWatts - parsed.criticalPowerWatts) > 0.01) {
        return c.json({ error: 'A different Critical Power already exists for this device and effective time.' }, 409);
      }
      return c.json({ record: sameEffectiveDate, idempotent: true });
    }
    const record = await upsertCriticalPowerRecord(c.env.lydiard, parsed);
    return c.json({ record, idempotent: false }, 201);
  });

  app.post('/week/propose', async (c) => {
    const body = await objectBody(c);
    if (!body) return c.json({ error: 'Request body must be a JSON object.' }, 400);
    const requestId = nonEmptyString(body.requestId);
    const weekStart = dateString(body.weekStart);
    if (!requestId || requestId.length > 200) return c.json({ error: 'requestId is required and must be at most 200 characters.' }, 400);
    if (!weekStart || !isMonday(weekStart)) return c.json({ error: 'weekStart must be a Monday in YYYY-MM-DD form.' }, 400);
    const existing = await getCoachDecisionByRequestId(c.env.lydiard, requestId);
    if (existing) {
      if (existing.decisionType !== 'weekly_plan') return c.json({ error: 'requestId is already used by another decision.' }, 409);
      return c.json({ decision: existing, sessions: await sessionsForDecision(c.env.lydiard, existing), idempotent: true });
    }

    const runtime = await loadCoachRuntime(c.env.lydiard, {
      asOf: optionalString(body.asOf),
      weekStart,
      lookbackDays: optionalInteger(body.lookbackDays),
    });
    const plan = buildLydiardWeek({ ...runtime.planningInput, weekStart });
    const decisionId = crypto.randomUUID();
    const persistedPlan = namespacePlan(plan, decisionId);
    const dbSessions = persistedPlan.days.flatMap((day) =>
      day.sessions.map((session, sequence) => engineSessionToDb(session, decisionId, sequence)),
    );
    const decision: Parameters<typeof upsertCoachDecision>[1] = {
      id: decisionId,
      decisionType: 'weekly_plan',
      asOf: runtime.context.asOf,
      weekStart,
      status: 'proposed',
      requestId,
      stateVersionBefore: runtime.context.profile.version,
      policyVersion: runtime.context.profile.policyVersion,
      modelVersion: MODEL_VERSION,
      summary: `${persistedPlan.phase}: ${persistedPlan.totalRunningMinutes} running minutes, ${persistedPlan.qualitySessionCount} consequential quality session(s).`,
      reasoning: [persistedPlan.currentStateExplanation, ...persistedPlan.decisions].join(' '),
      evidence: {
        physiology: compactPhysiology(runtime.physiology),
        backgroundLoad: runtime.context.backgroundLoad,
        observedState: runtime.context.observedState,
        recentWeeks: runtime.context.recentWeeks,
      },
      planPatch: { kind: 'weekly_plan', week: persistedPlan },
      stateBefore: runtime.context.profile as unknown as Record<string, unknown>,
      stateAfter: runtime.context.profile as unknown as Record<string, unknown>,
      appliedAt: undefined,
    };
    await upsertCoachDecision(c.env.lydiard, decision);
    try {
      await upsertPlannedSessions(c.env.lydiard, dbSessions);
    } catch (error) {
      await updateCoachDecisionStatus(c.env.lydiard, decisionId, 'rejected');
      throw error;
    }
    // A cached snapshot is an optimization/audit aid; it must never invalidate
    // an otherwise sound, explicitly proposed week.
    await cachePhysiology(c.env.lydiard, decisionId, runtime).catch(() => undefined);
    const storedDecision = await getCoachDecision(c.env.lydiard, decisionId);
    return c.json({
      decision: storedDecision,
      plan: persistedPlan,
      sessions: storedDecision ? await sessionsForDecision(c.env.lydiard, storedDecision) : dbSessions,
    }, 201);
  });

  app.post('/block/propose', async (c) => {
    const body = await objectBody(c);
    if (!body) return c.json({ error: 'Request body must be a JSON object.' }, 400);
    const requestId = nonEmptyString(body.requestId);
    const startWeek = dateString(body.startWeek ?? body.weekStart);
    const weekCount = integer(body.weekCount);
    if (!requestId || requestId.length > 200) return c.json({ error: 'requestId is required and must be at most 200 characters.' }, 400);
    if (!startWeek || !isMonday(startWeek)) return c.json({ error: 'startWeek must be a Monday in YYYY-MM-DD form.' }, 400);
    if (!weekCount || weekCount < 1 || weekCount > 3) return c.json({ error: 'weekCount must be 1, 2, or 3.' }, 400);
    const existing = await getCoachDecisionByRequestId(c.env.lydiard, requestId);
    if (existing) {
      if (existing.decisionType !== 'training_block') return c.json({ error: 'requestId is already used by another decision.' }, 409);
      return c.json({
        decision: existing,
        block: blockFromDecision(existing),
        sessions: await sessionsForDecision(c.env.lydiard, existing),
        idempotent: true,
      });
    }

    const runtime = await loadCoachRuntime(c.env.lydiard, {
      asOf: optionalString(body.asOf),
      weekStart: startWeek,
      lookbackDays: optionalInteger(body.lookbackDays),
    });
    const block = buildLydiardBlock({
      ...runtime.planningInput,
      weekStart: startWeek,
      weekCount: weekCount as 1 | 2 | 3,
    });
    const decisionId = crypto.randomUUID();
    const persistedBlock = {
      ...block,
      weeks: block.weeks.map((week) => namespacePlan(week, decisionId)),
    };
    const dbSessions = persistedBlock.weeks.flatMap((week) =>
      week.days.flatMap((day) =>
        day.sessions.map((session, sequence) => engineSessionToDb(session, decisionId, sequence)),
      ),
    );
    const decision = await upsertCoachDecision(c.env.lydiard, {
      id: decisionId,
      decisionType: 'training_block',
      asOf: runtime.context.asOf,
      weekStart: startWeek,
      status: 'proposed',
      requestId,
      stateVersionBefore: runtime.context.profile.version,
      policyVersion: runtime.context.profile.policyVersion,
      modelVersion: MODEL_VERSION,
      summary: `${weekCount}-week ${persistedBlock.phase.replaceAll('_', ' ')} block: ${persistedBlock.totalRunningMinutes} running minutes.`,
      reasoning: persistedBlock.explanation,
      evidence: {
        physiology: compactPhysiology(runtime.physiology),
        backgroundLoad: runtime.context.backgroundLoad,
        observedState: runtime.context.observedState,
        recentWeeks: runtime.context.recentWeeks,
      },
      planPatch: { kind: 'training_block', block: persistedBlock },
      stateBefore: runtime.context.profile as unknown as Record<string, unknown>,
      stateAfter: runtime.context.profile as unknown as Record<string, unknown>,
      appliedAt: undefined,
    });
    try {
      await upsertPlannedSessions(c.env.lydiard, dbSessions);
      await cachePhysiology(c.env.lydiard, decisionId, runtime);
    } catch (error) {
      await updateCoachDecisionStatus(c.env.lydiard, decisionId, 'rejected');
      throw error;
    }
    return c.json({ decision, block: persistedBlock, sessions: dbSessions, idempotent: false }, 201);
  });

  app.post('/week/accept', async (c) => {
    const body = await objectBody(c);
    if (!body) return c.json({ error: 'Request body must be a JSON object.' }, 400);
    const decisionId = nonEmptyString(body.decisionId);
    if (!decisionId) return c.json({ error: 'decisionId is required.' }, 400);
    try {
      const result = await acceptWeekDecision(c.env.lydiard, decisionId, optionalInteger(body.expectedProfileVersion));
      return c.json(result);
    } catch (error) {
      return decisionError(c, error);
    }
  });

  app.post('/block/accept', async (c) => {
    const body = await objectBody(c);
    if (!body) return c.json({ error: 'Request body must be a JSON object.' }, 400);
    const decisionId = nonEmptyString(body.decisionId);
    if (!decisionId) return c.json({ error: 'decisionId is required.' }, 400);
    try {
      const result = await acceptPlanDecision(c.env.lydiard, decisionId, optionalInteger(body.expectedProfileVersion));
      return c.json(result);
    } catch (error) {
      return decisionError(c, error);
    }
  });

  app.post('/activities/:id/feedback', async (c) => {
    const activityId = c.req.param('id');
    const activity = await getActivity(c.env.lydiard, activityId);
    if (!activity) return c.json({ error: 'Activity not found.' }, 404);
    const body = await objectBody(c);
    if (!body) return c.json({ error: 'Request body must be a JSON object.' }, 400);
    const feedback = parseFeedback(activityId, body);
    if (feedback instanceof Error) return c.json({ error: feedback.message }, 400);
    if (feedback.plannedSessionId) {
      const planned = await getPlannedSession(c.env.lydiard, feedback.plannedSessionId);
      if (!planned) return c.json({ error: 'plannedSessionId does not identify a stored session.' }, 400);
    }
    const saved = await upsertActivityFeedback(c.env.lydiard, feedback);
    if (saved.plannedSessionId) {
      await upsertPlannedActivityLink(c.env.lydiard, {
        plannedSessionId: saved.plannedSessionId,
        activityId,
        matchMethod: 'feedback',
        matchConfidence: 1,
        completionStatus: 'completed',
      });
    }
    return c.json({ feedback: saved });
  });

  app.post('/activities/:id/evaluate', async (c) => {
    const activityId = c.req.param('id');
    const activity = await getActivity(c.env.lydiard, activityId);
    if (!activity) return c.json({ error: 'Activity not found.' }, 404);
    const body = await objectBody(c);
    if (!body) return c.json({ error: 'Request body must be a JSON object.' }, 400);
    const requestId = nonEmptyString(body.requestId);
    if (!requestId || requestId.length > 200) return c.json({ error: 'requestId is required and must be at most 200 characters.' }, 400);
    const existing = await getCoachDecisionByRequestId(c.env.lydiard, requestId);
    if (existing) {
      if (existing.triggerActivityId !== activityId) return c.json({ error: 'requestId is already used by another activity.' }, 409);
      return c.json({ decision: existing, evaluation: evaluationFromDecision(existing), idempotent: true });
    }
    const activityDay = (activity.startDateLocal || activity.startDate).slice(0, 10);
    const weekStart = mondayOf(activityDay);
    const runtime = await loadCoachRuntime(c.env.lydiard, {
      asOf: activity.startDate,
      weekStart,
      excludeActivityFromHrBaseline: activityId,
    });
    const actual = runtime.assessmentsByActivityId.get(activityId);
    const engineActivity = runtime.activitiesById.get(activityId);
    if (!actual || !engineActivity) return c.json({ error: 'The activity does not have enough stored data for evaluation.' }, 422);
    const planned = await resolvePlannedSession(c.env.lydiard, activityId, activityDay, optionalString(body.plannedSessionId));
    if (!planned) return c.json({ error: 'No active planned session could be linked to this activity.' }, 409);
    const feedbackRecord = await getActivityFeedback(c.env.lydiard, activityId);
    const feedback = feedbackRecord ? feedbackForEngine(feedbackRecord, activityDay) : undefined;
    const futureStored = (await getPlannedSessions(c.env.lydiard, { from: activityDay, to: addDays(weekStart, 6) }))
      .filter((session) => session.id !== planned.id)
      .filter((session) => session.status === 'accepted' || session.status === 'planned');
    const recentEvaluations = runtime.context.recentDecisions
      .filter((decision) => decision.decisionType === 'post_run_evaluation')
      .map((decision) => evaluationFromDecision(decision))
      .filter((evaluation): evaluation is PostRunEvaluation => Boolean(evaluation))
      .map((evaluation) => ({ verdict: evaluation.verdict, date: activityDay }));
    const evaluation = evaluatePlannedVsActual({
      planned: dbSessionToEngine(planned),
      actual,
      activity: engineActivity,
      feedback,
      futureSessions: futureStored.map(dbSessionToEngine),
      recentEvaluations,
    });
    await upsertActivityCoachMetrics(c.env.lydiard, assessmentToCache(actual));
    await upsertPlannedActivityLink(c.env.lydiard, {
      plannedSessionId: planned.id,
      activityId,
      matchMethod: optionalString(body.plannedSessionId) ? 'manual' : 'date_and_type',
      matchConfidence: optionalString(body.plannedSessionId) ? 1 : 0.7,
      completionStatus: 'completed',
    });
    const profile = runtime.context.profile;
    const decisionId = crypto.randomUUID();
    const requiresPatchApproval = evaluation.proposedPatches.length > 0;
    const decision = await upsertCoachDecision(c.env.lydiard, {
      id: decisionId,
      decisionType: 'post_run_evaluation',
      asOf: activity.startDate,
      triggerActivityId: activityId,
      weekStart,
      status: requiresPatchApproval ? 'proposed' : 'applied',
      requestId,
      stateVersionBefore: profile.version,
      stateVersionAfter: requiresPatchApproval ? undefined : profile.version,
      policyVersion: profile.policyVersion,
      modelVersion: MODEL_VERSION,
      summary: `${evaluation.verdict.replaceAll('_', ' ')}: ${evaluation.remainingWeekEffect}`,
      reasoning: evaluation.evidence.join(' '),
      evidence: { evaluation, actual },
      planPatch: { kind: 'post_run_adaptation', patches: evaluation.proposedPatches },
      stateBefore: profile as unknown as Record<string, unknown>,
      stateAfter: profile as unknown as Record<string, unknown>,
      appliedAt: requiresPatchApproval ? undefined : new Date().toISOString(),
    });
    return c.json({ decision, evaluation, idempotent: false }, 201);
  });

  app.post('/decisions/:id/apply', async (c) => {
    const body = (await objectBody(c)) ?? {};
    try {
      const result = await applyDecision(c.env.lydiard, c.req.param('id'), optionalInteger(body.expectedProfileVersion));
      return c.json(result);
    } catch (error) {
      return decisionError(c, error);
    }
  });

  app.post('/decisions/:id/reject', async (c) => {
    const decision = await getCoachDecision(c.env.lydiard, c.req.param('id'));
    if (!decision) return c.json({ error: 'Coach decision not found.' }, 404);
    if (decision.status === 'rejected') return c.json({ decision, idempotent: true });
    if (decision.status === 'applied') return c.json({ error: 'An applied decision cannot be rejected.' }, 409);
    if (decision.decisionType === 'weekly_plan' || decision.decisionType === 'training_block') {
      const sessions = await sessionsForDecision(c.env.lydiard, decision);
      for (const session of sessions) {
        if (session.status === 'proposed') await setStoredSessionStatus(c.env.lydiard, session, 'cancelled');
      }
    }
    const rejected = await updateCoachDecisionStatus(c.env.lydiard, decision.id, 'rejected');
    return c.json({ decision: rejected, idempotent: false });
  });

  return app;
}

async function acceptWeekDecision(db: Env['lydiard'], decisionId: string, expectedProfileVersion?: number) {
  const decision = await getCoachDecision(db, decisionId);
  if (!decision) throw new HttpProblem(404, 'Coach decision not found.');
  if (decision.decisionType !== 'weekly_plan') throw new HttpProblem(409, 'This decision is not a weekly plan.');
  const selected = await sessionsForDecision(db, decision);
  if (decision.status === 'applied') return { decision, sessions: selected, idempotent: true };
  if (decision.status !== 'proposed') throw new HttpProblem(409, `Decision is ${decision.status}, not proposed.`);
  const profile = await getCoachProfile(db);
  if (!profile) throw new HttpProblem(503, 'Coach profile is unavailable.');
  const requiredVersion = expectedProfileVersion ?? decision.stateVersionBefore;
  if (requiredVersion !== undefined && profile.version !== requiredVersion) {
    throw new HttpProblem(409, 'Coach profile changed after this week was proposed; generate a new proposal.');
  }
  if (!decision.weekStart || selected.length === 0) throw new HttpProblem(409, 'The proposed week has no stored sessions.');
  const weekEnd = addDays(decision.weekStart, 6);
  const allWeekSessions = await getPlannedSessions(db, { from: decision.weekStart, to: weekEnd });
  for (const session of allWeekSessions) {
    if (session.coachDecisionId === decision.id) continue;
    if (session.status === 'accepted' || session.status === 'planned' || session.status === 'proposed') {
      await setStoredSessionStatus(db, session, 'superseded', decision.id);
    }
  }
  for (const session of selected) await setStoredSessionStatus(db, session, 'accepted', decision.id);
  const priorDecisions = await getCoachDecisions(db, { weekStart: decision.weekStart, limit: 30 });
  for (const prior of priorDecisions) {
    if (prior.id !== decision.id && (prior.status === 'applied' || prior.status === 'proposed')) {
      await updateCoachDecisionStatus(db, prior.id, 'superseded');
    }
  }
  const applied = await updateCoachDecisionStatus(db, decision.id, 'applied', {
    stateVersionAfter: profile.version,
    appliedAt: new Date().toISOString(),
  });
  return { decision: applied, sessions: await sessionsForDecision(db, applied), idempotent: false };
}

async function acceptPlanDecision(db: Env['lydiard'], decisionId: string, expectedProfileVersion?: number) {
  const decision = await getCoachDecision(db, decisionId);
  if (!decision) throw new HttpProblem(404, 'Coach decision not found.');
  if (decision.decisionType === 'weekly_plan') return acceptWeekDecision(db, decisionId, expectedProfileVersion);
  if (decision.decisionType !== 'training_block') throw new HttpProblem(409, 'This decision is not a training plan.');
  const selected = await sessionsForDecision(db, decision);
  if (decision.status === 'applied') return { decision, sessions: selected, idempotent: true };
  if (decision.status !== 'proposed') throw new HttpProblem(409, `Decision is ${decision.status}, not proposed.`);
  const profile = await getCoachProfile(db);
  if (!profile) throw new HttpProblem(503, 'Coach profile is unavailable.');
  const requiredVersion = expectedProfileVersion ?? decision.stateVersionBefore;
  if (requiredVersion !== undefined && profile.version !== requiredVersion) {
    throw new HttpProblem(409, 'Coach profile changed after this block was proposed; generate a new proposal.');
  }
  if (!decision.weekStart || selected.length === 0) throw new HttpProblem(409, 'The proposed block has no stored sessions.');
  const end = decisionWeekEnd(decision);
  const allSessions = await getPlannedSessions(db, { from: decision.weekStart, to: end });
  const supersededDecisionIds = new Set<string>();
  for (const session of allSessions) {
    if (session.coachDecisionId === decision.id) continue;
    if (session.status === 'accepted' || session.status === 'planned' || session.status === 'proposed') {
      if (session.coachDecisionId) supersededDecisionIds.add(session.coachDecisionId);
      await setStoredSessionStatus(db, session, 'superseded', decision.id);
    }
  }
  for (const session of selected) await setStoredSessionStatus(db, session, 'accepted', decision.id);
  for (const priorId of supersededDecisionIds) {
    const prior = await getCoachDecision(db, priorId);
    if (prior && (prior.status === 'applied' || prior.status === 'proposed')) {
      await updateCoachDecisionStatus(db, prior.id, 'superseded');
    }
  }
  const applied = await updateCoachDecisionStatus(db, decision.id, 'applied', {
    stateVersionAfter: profile.version,
    appliedAt: new Date().toISOString(),
  });
  return { decision: applied, sessions: await sessionsForDecision(db, applied), idempotent: false };
}

async function applyDecision(db: Env['lydiard'], id: string, expectedProfileVersion?: number) {
  const decision = await getCoachDecision(db, id);
  if (!decision) throw new HttpProblem(404, 'Coach decision not found.');
  if (decision.decisionType === 'weekly_plan' || decision.decisionType === 'training_block') {
    return acceptPlanDecision(db, id, expectedProfileVersion);
  }
  if (decision.status === 'applied') return { decision, sessions: [], idempotent: true };
  if (decision.status !== 'proposed') throw new HttpProblem(409, `Decision is ${decision.status}, not proposed.`);
  const profile = await getCoachProfile(db);
  if (!profile) throw new HttpProblem(503, 'Coach profile is unavailable.');
  const requiredVersion = expectedProfileVersion ?? decision.stateVersionBefore;
  if (requiredVersion !== undefined && profile.version !== requiredVersion) {
    throw new HttpProblem(409, 'Coach state changed after this adaptation was proposed; evaluate again.');
  }
  const payload = decision.planPatch;
  const patches = Array.isArray(payload.patches) ? payload.patches as unknown as ProposedSessionPatch[] : [];
  const saved: PlannedSession[] = [];
  for (const proposed of patches) {
    const current = await getPlannedSession(db, proposed.sessionId);
    if (!current) throw new HttpProblem(409, `Planned session ${proposed.sessionId} no longer exists.`);
    if (current.status === 'completed' || current.status === 'cancelled' || current.status === 'superseded') {
      throw new HttpProblem(409, `Planned session ${current.id} can no longer be adapted.`);
    }
    const engine = applyEnginePatch(dbSessionToEngine(current), proposed);
    saved.push(await upsertPlannedSession(db, engineSessionToDb(engine, decision.id, current.sequence)));
  }
  const applied = await updateCoachDecisionStatus(db, decision.id, 'applied', {
    stateVersionAfter: profile.version,
    appliedAt: new Date().toISOString(),
  });
  return { decision: applied, sessions: saved, idempotent: false };
}

async function resolvePlannedSession(
  db: Env['lydiard'],
  activityId: string,
  day: string,
  requestedId?: string,
): Promise<PlannedSession | null> {
  if (requestedId) return getPlannedSession(db, requestedId);
  const links = await getPlannedActivityLinks(db, { activityId });
  for (const link of links) {
    const session = await getPlannedSession(db, link.plannedSessionId);
    if (session) return session;
  }
  const sameDay = await getPlannedSessions(db, { from: day, to: day });
  const active = sameDay.filter((session) =>
    session.status !== 'proposed' && session.status !== 'cancelled' && session.status !== 'superseded',
  );
  // An off-plan run on a rest day still needs a planned-versus-actual review.
  // Prefer the intended run, then the explicit rest prescription; strength is
  // unrelated to the running dose and remains the last possible match.
  return active.find((session) => session.sessionType !== 'rest' && session.sessionType !== 'strength')
    ?? active.find((session) => session.sessionType === 'rest')
    ?? active[0]
    ?? null;
}

async function sessionsForDecision(db: Env['lydiard'], decision: CoachDecision): Promise<PlannedSession[]> {
  if (!decision.weekStart) return [];
  return (await getPlannedSessions(db, { from: decision.weekStart, to: decisionWeekEnd(decision) }))
    .filter((session) => session.coachDecisionId === decision.id);
}

function decisionWeekEnd(decision: CoachDecision): string {
  const block = blockFromDecision(decision);
  const weeks = block && typeof block.weekCount === 'number' ? Math.max(1, Math.min(3, Math.round(block.weekCount))) : 1;
  return addDays(decision.weekStart as string, weeks * 7 - 1);
}

function blockFromDecision(decision: CoachDecision): Record<string, unknown> | undefined {
  const value = decision.planPatch.block;
  return isRecord(value) ? value : undefined;
}

function engineSessionToDb(session: EnginePlannedSession, decisionId: string, sequence: number): PlannedSessionInput {
  const distance = session.approximateDistanceKm;
  const pct = session.target.powerPctCp;
  const durationHours = session.targetDurationMin / 60;
  const midpoint = pct ? midpointRange(pct) : undefined;
  return {
    id: session.id,
    plannedDate: session.plannedDate,
    sequence,
    title: session.title,
    sessionType: session.sessionType,
    trainingPhase: session.phase,
    priority: session.priority,
    plannedDurationSec: Math.round(session.targetDurationMin * 60),
    plannedDistanceKm: distance ? midpointRange(distance) : undefined,
    plannedPowerStress: midpoint === undefined ? undefined : round(durationHours * midpoint ** 2 * 100, 1),
    targetPowerLowW: session.target.powerWatts?.low,
    targetPowerHighW: session.target.powerWatts?.high,
    targetPowerLowPctCp: pct?.low,
    targetPowerHighPctCp: pct?.high,
    targetHrLow: session.target.heartRateBpm?.low,
    targetHrHigh: session.target.heartRateBpm?.high,
    targetHrCeiling: session.target.heartRateCeiling,
    targetGapLowSecPerKm: session.target.gapPace?.fastSecPerKm,
    targetGapHighSecPerKm: session.target.gapPace?.slowSecPerKm,
    workoutStructure: {
      target: session.target,
      components: session.structure,
      approximateDistanceKm: session.approximateDistanceKm,
    },
    purpose: session.purpose,
    fallbackPlan: session.fallbackPlan,
    coachReasoning: session.coachReasoning,
    status: session.status,
    source: 'coach',
    coachDecisionId: decisionId,
  };
}

function dbSessionToEngine(session: PlannedSession): EnginePlannedSession {
  const stored = session.workoutStructure;
  const target = isRecord(stored.target)
    ? stored.target as unknown as IntensityTarget
    : fallbackTarget(session);
  const structure = Array.isArray(stored.components)
    ? stored.components as unknown as WorkoutComponent[]
    : [];
  const approximateDistanceKm = isRecord(stored.approximateDistanceKm)
    ? stored.approximateDistanceKm as unknown as ZoneRange
    : session.plannedDistanceKm !== undefined
      ? { low: session.plannedDistanceKm, high: session.plannedDistanceKm }
      : undefined;
  return {
    id: session.id,
    plannedDate: session.plannedDate,
    title: session.title,
    sessionType: sessionType(session.sessionType),
    phase: phase(session.trainingPhase),
    priority: priority(session.priority),
    targetDurationMin: Math.round((session.plannedDurationSec ?? 0) / 60),
    approximateDistanceKm,
    target,
    structure,
    purpose: session.purpose,
    fallbackPlan: session.fallbackPlan,
    coachReasoning: session.coachReasoning,
    status: session.status,
  };
}

function applyEnginePatch(session: EnginePlannedSession, patch: ProposedSessionPatch): EnginePlannedSession {
  const next = { ...session };
  for (const change of patch.changes) {
    if (change.field === 'sessionType') next.sessionType = sessionType(String(change.after));
    else if (change.field === 'title') next.title = String(change.after);
    else if (change.field === 'targetDurationMin') next.targetDurationMin = Number(change.after);
    else if (change.field === 'target') next.target = change.after as IntensityTarget;
    else if (change.field === 'structure') next.structure = change.after as WorkoutComponent[];
    else if (change.field === 'fallbackPlan') next.fallbackPlan = String(change.after);
    else if (change.field === 'status') next.status = plannedStatus(String(change.after));
  }
  return next;
}

async function setStoredSessionStatus(
  db: Env['lydiard'],
  session: PlannedSession,
  status: PlannedSessionStatus,
  _decisionId?: string,
): Promise<PlannedSession> {
  try {
    return await patchPlannedSession(db, session.id, { status }, session.revision);
  } catch (error) {
    if (error instanceof PlannedSessionConflictError) throw new HttpProblem(409, error.message);
    throw error;
  }
}

function assessmentToCache(assessment: SessionStressAssessment): Parameters<typeof upsertActivityCoachMetrics>[1] {
  return {
    activityId: assessment.activityId,
    modelVersion: MODEL_VERSION,
    effectiveCriticalPowerId: undefined,
    criticalPowerWattsUsed: assessment.effectiveCriticalPower?.criticalPowerWatts,
    powerSource: assessment.externalStress.source,
    heartRateSource: assessment.heartRateCost.observedHeartRate === undefined ? undefined : 'chest_strap_or_imported',
    powerStress: assessment.lydiardPowerStress ?? assessment.externalStress.totalStress,
    averagePctCp: assessment.averagePctCp,
    weightedPctCp: assessment.weightedPctCp,
    hardPowerStress: assessment.hardPowerStress ?? assessment.externalStress.hardStress,
    powerZoneSeconds: Object.fromEntries(assessment.powerZoneTime.map((zone) => [zone.zone, zone.seconds])),
    peakPower: Object.fromEntries(assessment.peaks.filter((peak) => peak.watts !== undefined).map((peak) => [`${peak.durationSec}s`, peak.watts as number])),
    expectedHeartRate: assessment.heartRateCost.expectedHeartRate,
    observedHeartRate: assessment.heartRateCost.observedHeartRate,
    heartRateCostResidual: assessment.heartRateCost.residualBpm,
    heartRatePowerDecouplingPct: assessment.powerHrDecouplingPct,
    latePowerDropPct: assessment.latePowerChangePct,
    sensorQuality: { coverage: assessment.dataCoverage, warnings: assessment.warnings },
    confidence: confidenceScore(assessment.externalStress.reliability),
  };
}

async function cachePhysiology(db: Env['lydiard'], decisionId: string, runtime: Awaited<ReturnType<typeof loadCoachRuntime>>) {
  const physiology = runtime.physiology;
  await upsertPhysiologyEstimate(db, {
    id: `${decisionId}:physiology`,
    effectiveFrom: runtime.context.asOf,
    criticalSpeedMps: physiology.criticalSpeed?.estimate,
    criticalSpeedLowMps: physiology.criticalSpeed?.low,
    criticalSpeedHighMps: physiology.criticalSpeed?.high,
    dPrimeM: physiology.criticalSpeed?.finiteCapacity,
    lt1HrLow: physiology.lt1HeartRate?.low,
    lt1HrHigh: physiology.lt1HeartRate?.high,
    lt2HrLow: physiology.lt2HeartRate?.low,
    lt2HrHigh: physiology.lt2HeartRate?.high,
    confidence: physiology.criticalSpeed?.confidenceScore ?? physiology.canonicalCriticalPower?.confidenceScore ?? 0,
    confidenceDetail: compactPhysiology(physiology),
    evidence: { limitations: physiology.limitations },
    source: 'platform_estimate',
    modelVersion: MODEL_VERSION,
  });
}

function namespacePlan<T extends ReturnType<typeof buildLydiardWeek>>(plan: T, decisionId: string): T {
  return {
    ...plan,
    days: plan.days.map((day) => ({
      ...day,
      sessions: day.sessions.map((session) => ({ ...session, id: `${decisionId}:${session.id}` })),
    })),
  } as T;
}

function fallbackTarget(session: PlannedSession): IntensityTarget {
  return {
    primaryControl: session.sessionType === 'rest' ? 'recovery' : 'feel_hr',
    powerPctCp: range(session.targetPowerLowPctCp, session.targetPowerHighPctCp),
    powerWatts: range(session.targetPowerLowW, session.targetPowerHighW),
    heartRateBpm: range(session.targetHrLow, session.targetHrHigh),
    heartRateCeiling: session.targetHrCeiling,
    gapPace: session.targetGapLowSecPerKm !== undefined || session.targetGapHighSecPerKm !== undefined
      ? { fastSecPerKm: session.targetGapLowSecPerKm, slowSecPerKm: session.targetGapHighSecPerKm }
      : undefined,
    guidance: session.coachReasoning || session.purpose,
  };
}

function parseProfilePatch(body: Record<string, unknown>): CoachProfilePatch | Error {
  const allowed = new Set([
    'primaryGoal', 'secondaryGoal', 'goal5kSeconds', 'goal10kSeconds', 'currentPhase',
    'phaseStartedOn', 'targetRaceDate', 'sustainableWeeklyDurationMin', 'targetWeeklyDurationMin',
    'longRunToleranceMin', 'maxQualitySessions', 'strengthSessionsTarget', 'constraints',
    'learnedResponse', 'policyVersion', 'nextDecisionAt',
  ]);
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === 'expectedVersion' || key === 'patch') continue;
    if (!allowed.has(key)) return new Error(`Unknown coach-profile field: ${key}.`);
    patch[key] = value;
  }
  if (Object.keys(patch).length === 0) return new Error('Provide at least one coach-profile field.');
  if (patch.currentPhase !== undefined && !isPhase(patch.currentPhase)) return new Error('currentPhase is not a supported Lydiard phase.');
  for (const key of ['goal5kSeconds', 'goal10kSeconds', 'sustainableWeeklyDurationMin', 'targetWeeklyDurationMin', 'longRunToleranceMin', 'maxQualitySessions', 'strengthSessionsTarget']) {
    if (patch[key] !== undefined && (typeof patch[key] !== 'number' || !Number.isFinite(patch[key]) || (patch[key] as number) < 0)) {
      return new Error(`${key} must be a non-negative number.`);
    }
  }
  for (const key of ['constraints', 'learnedResponse']) if (patch[key] !== undefined && !isRecord(patch[key])) return new Error(`${key} must be an object.`);
  for (const key of ['primaryGoal', 'secondaryGoal', 'phaseStartedOn', 'targetRaceDate', 'policyVersion', 'nextDecisionAt']) {
    if (patch[key] !== undefined && typeof patch[key] !== 'string') return new Error(`${key} must be a string.`);
  }
  return patch as CoachProfilePatch;
}

function parseCriticalPower(body: Record<string, unknown>): CriticalPowerInput | Error {
  const effectiveFrom = isoTimestamp(body.effectiveFrom);
  const watts = number(body.criticalPowerWatts);
  const source = optionalString(body.source) ?? 'stryd_manual';
  const sources = ['stryd_auto', 'stryd_test', 'stryd_manual', 'platform_estimate', 'manual', 'imported'] as const;
  if (!effectiveFrom) return new Error('effectiveFrom must be an ISO date or timestamp.');
  if (!watts || watts <= 0 || watts > 1000) return new Error('criticalPowerWatts must be between 1 and 1000.');
  if (!sources.includes(source as typeof sources[number])) return new Error('source is not supported.');
  const confidence = body.confidence === undefined ? 0.9 : number(body.confidence);
  if (confidence === undefined || confidence < 0 || confidence > 1) return new Error('confidence must be between 0 and 1.');
  const device = optionalString(body.device) ?? 'Stryd';
  const activities = Array.isArray(body.supportingActivityIds)
    ? body.supportingActivityIds.filter((item): item is string => typeof item === 'string')
    : [];
  return {
    id: optionalString(body.id) ?? `cp-${simpleHash(`${device}|${effectiveFrom}`)}`,
    effectiveFrom,
    criticalPowerWatts: watts,
    source: source as CriticalPowerInput['source'],
    device,
    algorithm: optionalString(body.algorithm),
    confidence,
    supportingActivityIds: activities,
    notes: optionalString(body.notes) ?? '',
  };
}

function parseFeedback(activityId: string, body: Record<string, unknown>): ActivityFeedbackInput | Error {
  const rpe = optionalInteger(body.perceivedEffort ?? body.rpe);
  const painDuring = optionalInteger(body.painDuring);
  const painAfter = optionalInteger(body.painAfter);
  const energy = energyNumber(body.energy);
  if (rpe !== undefined && (rpe < 1 || rpe > 10)) return new Error('perceivedEffort must be 1–10.');
  if (painDuring !== undefined && (painDuring < 0 || painDuring > 10)) return new Error('painDuring must be 0–10.');
  if (painAfter !== undefined && (painAfter < 0 || painAfter > 10)) return new Error('painAfter must be 0–10.');
  const sessionFeel = optionalString(body.sessionFeel);
  if (sessionFeel && !['easier', 'as_expected', 'harder'].includes(sessionFeel)) return new Error('sessionFeel must be easier, as_expected, or harder.');
  return {
    activityId,
    plannedSessionId: optionalString(body.plannedSessionId),
    perceivedEffort: rpe,
    perceivedCost: optionalString(body.perceivedCost),
    sessionFeel: sessionFeel as ActivityFeedbackInput['sessionFeel'],
    energy,
    legCondition: optionalString(body.legCondition ?? body.legs),
    breathingCondition: optionalString(body.breathingCondition ?? body.breathing),
    painDuring,
    painAfter,
    painLocation: optionalString(body.painLocation),
    alteredGait: body.alteredGait === true,
    sessionVerdict: optionalString(body.sessionVerdict),
    note: typeof body.note === 'string' ? body.note : '',
  };
}

function feedbackForEngine(feedback: Awaited<ReturnType<typeof getActivityFeedback>>, date: string): AthleteFeedback | undefined {
  if (!feedback) return undefined;
  return {
    activityId: feedback.activityId,
    date,
    energy: feedback.energy === undefined ? undefined : feedback.energy >= 4 ? 'good' : feedback.energy >= 3 ? 'okay' : 'poor',
    legs: enumValue(feedback.legCondition, ['fresh', 'normal', 'heavy', 'dead']),
    sessionFeel: feedback.sessionFeel,
    perceivedCost: enumValue(feedback.perceivedCost, ['low', 'expected', 'high', 'extreme']),
    rpe: feedback.perceivedEffort,
    breathing: enumValue(feedback.breathingCondition, ['controlled', 'labored', 'abnormal']),
    painDuring: feedback.painDuring,
    painAfter: feedback.painAfter,
    painLocation: feedback.painLocation,
    alteredGait: feedback.alteredGait,
    note: feedback.note,
  };
}

function evaluationFromDecision(decision: CoachDecision): PostRunEvaluation | null {
  const value = decision.evidence.evaluation;
  return isRecord(value) && typeof value.verdict === 'string' ? value as unknown as PostRunEvaluation : null;
}

function compactPhysiology(value: Awaited<ReturnType<typeof loadCoachRuntime>>['physiology']): Record<string, unknown> {
  return {
    criticalSpeed: value.criticalSpeed,
    canonicalCriticalPower: value.canonicalCriticalPower,
    lt1HeartRate: value.lt1HeartRate,
    lt2HeartRate: value.lt2HeartRate,
    raceEquivalents: value.raceEquivalents,
    limitations: value.limitations,
  };
}

function phase(value: string): LydiardPhase {
  return isPhase(value) ? value : 'aerobic_conditioning';
}

function isPhase(value: unknown): value is LydiardPhase {
  return typeof value === 'string' && ['aerobic_conditioning', 'hill_resistance', 'anaerobic_development', 'coordination', 'recovery_regeneration'].includes(value);
}

function sessionType(value: string): PlannedSessionType {
  const values: PlannedSessionType[] = ['rest', 'strength', 'recovery', 'aerobic', 'medium_long', 'long_aerobic', 'steady', 'strides', 'hill_sprints', 'hill_circuit', 'threshold', 'vo2', 'race_specific', 'coordination'];
  return values.includes(value as PlannedSessionType) ? value as PlannedSessionType : 'aerobic';
}

function priority(value: string): EnginePlannedSession['priority'] {
  return value === 'key' || value === 'optional' ? value : 'supporting';
}

function plannedStatus(value: string): EnginePlannedSession['status'] {
  const statuses: PlannedSessionStatus[] = ['proposed', 'accepted', 'planned', 'completed', 'partial', 'skipped', 'cancelled', 'superseded'];
  return statuses.includes(value as PlannedSessionStatus) ? value as EnginePlannedSession['status'] : 'planned';
}

function range(low?: number, high?: number): ZoneRange | undefined {
  return low === undefined && high === undefined ? undefined : { low, high };
}

function midpointRange(value: ZoneRange): number {
  if (value.low !== undefined && value.high !== undefined) return (value.low + value.high) / 2;
  return value.low ?? value.high ?? 0;
}

function confidenceScore(value: 'low' | 'medium' | 'high'): number {
  return value === 'high' ? 0.9 : value === 'medium' ? 0.65 : 0.35;
}

function dateString(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : undefined;
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const timestamp = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function isMonday(day: string): boolean {
  return new Date(`${day}T00:00:00Z`).getUTCDay() === 1;
}

function mondayOf(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function addDays(day: string, amount: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + amount * 86_400_000).toISOString().slice(0, 10);
}

function energyNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (value === 'good') return 5;
  if (value === 'okay') return 3;
  if (value === 'poor') return 1;
  return undefined;
}

function optionalInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : undefined;
  return parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return optionalString(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function enumValue<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  return value && allowed.includes(value as T) ? value as T : undefined;
}

async function objectBody(c: Context<{ Bindings: Env }>): Promise<Record<string, unknown> | null> {
  try {
    const value = await c.req.json();
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function inputError(c: Context<{ Bindings: Env }>, error: unknown) {
  return c.json({ error: error instanceof Error ? error.message : 'Invalid coaching context request.' }, 400);
}

function decisionError(c: Context<{ Bindings: Env }>, error: unknown) {
  if (error instanceof HttpProblem) return c.json({ error: error.message }, error.status);
  if (error instanceof PlannedSessionConflictError || error instanceof CoachProfileConflictError) return c.json({ error: error.message }, 409);
  throw error;
}

class HttpProblem extends Error {
  constructor(public readonly status: 400 | 404 | 409 | 422 | 503, message: string) {
    super(message);
    this.name = 'HttpProblem';
  }
}

function simpleHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function round(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}
