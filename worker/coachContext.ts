import type { D1Database } from '@cloudflare/workers-types';
import {
  buildHrCostBaseline,
  buildPowerDurationCurve,
  estimatePhysiology,
  scoreLydiardSession,
  type AthleteFeedback,
  type CoachActivitySummary,
  type CoachProfile as EngineCoachProfile,
  type CriticalPowerHistoryRecord,
  type HrCostBaseline,
  type PhysiologyEstimate as EnginePhysiologyEstimate,
  type PlanningStateInput,
  type PowerDurationPoint,
  type RecentTrainingWeek,
  type SessionStressAssessment,
} from '../src/analysis/coachEngine';
import {
  getActivityFeedbackBatch,
  getCoachDecisions,
  getCoachProfile,
  getCriticalPowerHistory,
  getDailyCheckins,
  getPlannedActivityLinks,
  getPlannedSessions,
  type ActivityFeedback,
  type CoachDecision,
  type CoachProfile,
  type DailyCheckin,
  type PlannedActivityLink,
  type PlannedSession,
} from './db';

const DAY_MS = 86_400_000;
const DEFAULT_LOOKBACK_DAYS = 365;

interface CoachActivityRow {
  id: string;
  name: string;
  sport_type: string;
  start_date: string;
  start_date_local: string;
  distance_km: number;
  moving_time_s: number;
  elapsed_time_s: number;
  average_heartrate: number | null;
  max_heartrate: number | null;
  average_watts: number | null;
  average_speed: number | null;
  elevation_gain_m: number | null;
  decoupling_pct: number | null;
  time_s: string | null;
  heartrate: string | null;
  cadence: string | null;
  power: string | null;
  velocity: string | null;
  altitude: string | null;
  distance_m: string | null;
}

export interface CoachBackgroundLoad {
  sevenDayStress: number;
  fortyTwoDayStress: number;
  stressBalance: number;
  sevenToFortyTwoRatio: number | null;
  sevenDayHardStress: number;
  explanation: string;
}

export interface CoachObservedState {
  state: 'green' | 'amber' | 'red';
  reasons: string[];
  elevatedHeartRateCostRuns: number;
  deterioratingRuns: number;
  maxRecentPain: number;
  alteredGait: boolean;
  illnessSuspected: boolean;
}

export interface CoachContextBundle {
  generatedAt: string;
  asOf: string;
  lookbackDays: number;
  policyVersion: string;
  goals: {
    firstMilestone: { distance: '5k'; targetSeconds: number; target: string };
    laterMilestone: { distance: '10k'; targetSeconds: number; target: string };
  };
  profile: CoachProfile;
  physiology: EnginePhysiologyEstimate;
  heartRateCostBaseline: HrCostBaseline;
  backgroundLoad: CoachBackgroundLoad;
  observedState: CoachObservedState;
  currentWeek: {
    weekStart: string;
    weekEnd: string;
    sessions: PlannedSession[];
    activityLinks: PlannedActivityLink[];
    accepted: boolean;
    pendingProposal: boolean;
  };
  upcomingPlan: {
    from: string;
    to: string;
    sessions: PlannedSession[];
    activityLinks: PlannedActivityLink[];
    proposedDecisionIds: string[];
    acceptedDecisionIds: string[];
  };
  recentWeeks: RecentTrainingWeek[];
  recentRuns: Array<{
    id: string;
    name: string;
    startDate: string;
    startDateLocal?: string;
    distanceKm: number;
    movingTimeSec: number;
    averageHeartRate?: number;
    averageWatts?: number;
    assessment: SessionStressAssessment;
    feedback?: ActivityFeedback;
    plannedSessionIds: string[];
    verdict?: string;
  }>;
  recentSessions: SessionStressAssessment[];
  powerDuration: PowerDurationPoint[];
  recentFeedback: ActivityFeedback[];
  recentCheckins: DailyCheckin[];
  recentDecisions: CoachDecision[];
  limitations: string[];
}

export interface CoachRuntime {
  context: CoachContextBundle;
  activities: CoachActivitySummary[];
  activitiesById: Map<string, CoachActivitySummary>;
  criticalPowerHistory: CriticalPowerHistoryRecord[];
  engineProfile: EngineCoachProfile;
  engineFeedback: AthleteFeedback[];
  physiology: EnginePhysiologyEstimate;
  heartRateCostBaseline: HrCostBaseline;
  sessionAssessments: SessionStressAssessment[];
  assessmentsByActivityId: Map<string, SessionStressAssessment>;
  planningInput: PlanningStateInput;
}

export async function buildCoachContext(
  db: D1Database,
  opts: { asOf?: string; lookbackDays?: number; weekStart?: string; horizonWeeks?: number; excludeActivityFromHrBaseline?: string } = {},
): Promise<CoachContextBundle> {
  return (await loadCoachRuntime(db, opts)).context;
}

export async function loadCoachRuntime(
  db: D1Database,
  opts: { asOf?: string; lookbackDays?: number; weekStart?: string; horizonWeeks?: number; excludeActivityFromHrBaseline?: string } = {},
): Promise<CoachRuntime> {
  const asOf = normalizeAsOf(opts.asOf);
  const lookbackDays = clamp(Math.floor(opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS), 30, DEFAULT_LOOKBACK_DAYS);
  const from = new Date(Date.parse(asOf) - lookbackDays * DAY_MS).toISOString();
  const weekStart = opts.weekStart ? normalizeDay(opts.weekStart) : mondayOf((asOf || new Date().toISOString()).slice(0, 10));
  const weekEnd = addDays(weekStart, 6);
  // Keep the accepted GPT horizon visible; deterministic blocks remain one to
  // three weeks, while the conversational planner can publish up to twelve.
  const horizonWeeks = clamp(Math.floor(opts.horizonWeeks ?? 4), 1, 12);
  const planningHorizonEnd = addDays(weekStart, horizonWeeks * 7 - 1);

  const [profile, cpRows, activities, plannedSessions, checkins, decisions] = await Promise.all([
    getCoachProfile(db),
    getCriticalPowerHistory(db, { to: asOf }),
    getCoachActivitiesWithStreams(db, from, asOf),
    getPlannedSessions(db, { from: weekStart, to: planningHorizonEnd }),
    getDailyCheckins(db, { from: from.slice(0, 10), to: asOf.slice(0, 10) }),
    getCoachDecisions(db, { to: asOf, limit: 30 }),
  ]);
  if (!profile) {
    throw new Error('Coach profile is unavailable. Apply the stateful-coach migration first.');
  }

  const activityIds = activities.map((activity) => activity.id);
  const feedback = await getFeedbackInChunks(db, activityIds);
  const links = await getLinksForSessions(db, plannedSessions);
  const currentWeekSessions = plannedSessions.filter((session) => session.plannedDate <= weekEnd);
  const currentWeekSessionIds = new Set(currentWeekSessions.map((session) => session.id));
  const recentActivities = activities.slice(-28);
  const recentActivityLinks = await getLinksForActivities(db, recentActivities.map((activity) => activity.id));
  const criticalPowerHistory: CriticalPowerHistoryRecord[] = cpRows.map((record) => ({
    effectiveFrom: record.effectiveFrom,
    criticalPowerWatts: record.criticalPowerWatts,
    source: record.source,
    confidence: record.confidence,
    supportingActivityIds: record.supportingActivityIds,
    device: record.device,
  }));
  const physiology = estimatePhysiology({ activities, criticalPowerHistory, asOf, lookbackDays });
  const heartRateCostBaseline = buildHrCostBaseline({
    activities,
    criticalPowerHistory,
    asOf,
    lookbackDays,
    excludeActivityId: opts.excludeActivityFromHrBaseline,
  });
  const sessionAssessments = activities.map((activity) =>
    scoreLydiardSession({ activity, criticalPowerHistory, physiology, hrCostBaseline: heartRateCostBaseline }),
  );
  const assessmentsByActivityId = new Map(sessionAssessments.map((assessment) => [assessment.activityId, assessment]));
  const feedbackByActivity = new Map(feedback.map((item) => [item.activityId, item]));
  const engineFeedback = [
    ...feedback.map((item) => feedbackToEngine(item, activities.find((activity) => activity.id === item.activityId))),
    ...checkins.map(checkinToEngine),
  ];
  const recentWeeks = buildRecentWeeks(activities, sessionAssessments, feedbackByActivity, asOf);
  const backgroundLoad = buildBackgroundLoad(sessionAssessments, asOf, lookbackDays);
  const observedState = buildObservedState(sessionAssessments, feedback, checkins, asOf);
  const engineProfile = profileToEngine(profile, activities, recentWeeks, checkins);
  const planningInput: PlanningStateInput = {
    weekStart,
    profile: engineProfile,
    physiology,
    recentWeeks,
    recentSessions: sessionAssessments.slice(-28),
    recentFeedback: engineFeedback,
    sevenDayStress: backgroundLoad.sevenDayStress,
    fortyTwoDayStress: backgroundLoad.fortyTwoDayStress,
  };
  const recentActivityIds = new Set(activities.slice(-42).map((activity) => activity.id));
  const recentFeedback = feedback.filter((item) => recentActivityIds.has(item.activityId));
  const feedbackMap = new Map(feedback.map((item) => [item.activityId, item]));
  const verdictMap = new Map(
    decisions
      .filter((decision) => decision.triggerActivityId)
      .map((decision) => [decision.triggerActivityId as string, decisionVerdict(decision)]),
  );
  const recentRuns = recentActivities.map((activity) => ({
    id: activity.id,
    name: activity.name,
    startDate: activity.startDate,
    startDateLocal: activity.startDateLocal,
    distanceKm: activity.distanceKm,
    movingTimeSec: activity.movingTimeSec,
    averageHeartRate: activity.averageHeartRate,
    averageWatts: activity.averageWatts,
    assessment: assessmentsByActivityId.get(activity.id) as SessionStressAssessment,
    feedback: feedbackMap.get(activity.id),
    plannedSessionIds: recentActivityLinks
      .filter((link) => link.activityId === activity.id)
      .map((link) => link.plannedSessionId),
    verdict: verdictMap.get(activity.id),
  }));
  const limitations = [...physiology.limitations];
  if (criticalPowerHistory.length === 0) {
    limitations.push('No dated Stryd Critical Power is stored; power load is withheld or clearly falls back to GAP/pace.');
  }
  if (activities.some((activity) => activity.streams?.powerWatts) && !cpRows.some((record) => /stryd/i.test(record.device))) {
    limitations.push('Power streams exist, but the producing device is not confirmed as Stryd in stored metadata.');
  }
  limitations.push('Stored D1 streams are decimated; exact per-second stress should be calculated before import when full FIT data are available.');

  return {
    context: {
      generatedAt: new Date().toISOString(),
      asOf,
      lookbackDays,
      policyVersion: profile.policyVersion,
      goals: {
        firstMilestone: { distance: '5k', targetSeconds: profile.goal5kSeconds, target: formatRaceTime(profile.goal5kSeconds) },
        laterMilestone: { distance: '10k', targetSeconds: profile.goal10kSeconds, target: formatRaceTime(profile.goal10kSeconds) },
      },
      profile,
      physiology,
      heartRateCostBaseline,
      backgroundLoad,
      observedState,
      currentWeek: {
        weekStart,
        weekEnd,
        sessions: currentWeekSessions,
        activityLinks: links.filter((link) => currentWeekSessionIds.has(link.plannedSessionId)),
        accepted: currentWeekSessions.some((session) => session.status === 'accepted' || session.status === 'planned'),
        pendingProposal: currentWeekSessions.some((session) => session.status === 'proposed'),
      },
      upcomingPlan: {
        from: weekStart,
        to: planningHorizonEnd,
        sessions: plannedSessions,
        activityLinks: links,
        proposedDecisionIds: [...new Set(
          plannedSessions
            .filter((session) => session.status === 'proposed' && session.coachDecisionId)
            .map((session) => session.coachDecisionId as string),
        )],
        acceptedDecisionIds: [...new Set(
          plannedSessions
            .filter((session) => (session.status === 'accepted' || session.status === 'planned') && session.coachDecisionId)
            .map((session) => session.coachDecisionId as string),
        )],
      },
      recentWeeks,
      recentRuns,
      recentSessions: sessionAssessments.slice(-28),
      powerDuration: buildPowerDurationCurve(sessionAssessments, asOf),
      recentFeedback,
      recentCheckins: checkins.slice(-42),
      recentDecisions: decisions,
      limitations: [...new Set(limitations)],
    },
    activities,
    activitiesById: new Map(activities.map((activity) => [activity.id, activity])),
    criticalPowerHistory,
    engineProfile,
    engineFeedback,
    physiology,
    heartRateCostBaseline,
    sessionAssessments,
    assessmentsByActivityId,
    planningInput,
  };
}

async function getCoachActivitiesWithStreams(
  db: D1Database,
  from: string,
  to: string,
): Promise<CoachActivitySummary[]> {
  const result = await db
    .prepare(
      `SELECT a.id, a.name, a.sport_type, a.start_date, a.start_date_local,
              a.distance_km, a.moving_time_s, a.elapsed_time_s,
              a.average_heartrate, a.max_heartrate, a.average_watts,
              a.average_speed, a.elevation_gain_m, a.decoupling_pct,
              s.time_s, s.heartrate, s.cadence, s.power, s.velocity,
              s.altitude, s.distance_m
       FROM activities a
       LEFT JOIN activity_streams s ON s.activity_id = a.id
       WHERE a.start_date >= ?1 AND a.start_date <= ?2
       ORDER BY a.start_date ASC`,
    )
    .bind(from, to)
    .all<CoachActivityRow>();
  return (result.results ?? []).map(rowToCoachActivity);
}

function rowToCoachActivity(row: CoachActivityRow): CoachActivitySummary {
  const evidence = inferEvidence(row.name, row.sport_type);
  return {
    id: row.id,
    name: row.name,
    sportType: row.sport_type,
    startDate: row.start_date,
    startDateLocal: row.start_date_local,
    distanceKm: row.distance_km,
    movingTimeSec: row.moving_time_s,
    elapsedTimeSec: row.elapsed_time_s,
    averageHeartRate: row.average_heartrate ?? undefined,
    maxHeartRate: row.max_heartrate ?? undefined,
    averageWatts: row.average_watts ?? undefined,
    averageSpeed: row.average_speed ?? undefined,
    elevationGainM: row.elevation_gain_m ?? undefined,
    decouplingPct: row.decoupling_pct ?? undefined,
    effortKind: evidence.kind,
    evidenceQuality: evidence.quality,
    streams: {
      timeSec: parseNumberArray(row.time_s),
      distanceM: parseNumberArray(row.distance_m),
      velocityMps: parseNumberArray(row.velocity),
      powerWatts: parseNumberArray(row.power),
      heartRateBpm: parseNumberArray(row.heartrate),
      altitudeM: parseNumberArray(row.altitude),
      cadenceSpm: parseNumberArray(row.cadence),
    },
  };
}

async function getFeedbackInChunks(db: D1Database, activityIds: string[]): Promise<ActivityFeedback[]> {
  const chunks: string[][] = [];
  for (let index = 0; index < activityIds.length; index += 80) {
    chunks.push(activityIds.slice(index, index + 80));
  }
  const results = await Promise.all(chunks.map((chunk) => getActivityFeedbackBatch(db, chunk)));
  return results.flat();
}

async function getLinksForSessions(db: D1Database, sessions: PlannedSession[]): Promise<PlannedActivityLink[]> {
  const results = await Promise.all(
    sessions.map((session) => getPlannedActivityLinks(db, { plannedSessionId: session.id })),
  );
  return results.flat();
}

async function getLinksForActivities(db: D1Database, activityIds: string[]): Promise<PlannedActivityLink[]> {
  const results = await Promise.all(
    activityIds.map((activityId) => getPlannedActivityLinks(db, { activityId })),
  );
  return results.flat();
}

function decisionVerdict(decision: CoachDecision): string | undefined {
  const evaluation = decision.evidence.evaluation;
  return evaluation && typeof evaluation === 'object' && 'verdict' in evaluation && typeof evaluation.verdict === 'string'
    ? evaluation.verdict
    : undefined;
}

function profileToEngine(
  profile: CoachProfile,
  activities: CoachActivitySummary[],
  weeks: RecentTrainingWeek[],
  checkins: DailyCheckin[],
): EngineCoachProfile {
  const constraints = profile.constraints;
  const recentMinutes = weeks.slice(-4).filter((week) => week.runningMinutes > 0).map((week) => week.runningMinutes);
  const sustainable = profile.sustainableWeeklyDurationMin ?? Math.round(median(recentMinutes) || 300);
  const paces = activities
    .slice(-28)
    .map((activity) => activity.distanceKm > 0 ? activity.movingTimeSec / activity.distanceKm : 0)
    .filter((pace) => pace > 0);
  const goalEvent = goalEventFromConstraints(constraints);
  return {
    currentPhase: profile.currentPhase,
    goals: [
      { distance: '5k', targetTimeSec: profile.goal5kSeconds, priority: 1, targetDate: profile.targetRaceDate },
      { distance: '10k', targetTimeSec: profile.goal10kSeconds, priority: 2 },
    ],
    goalEvent,
    sustainableWeeklyMinutes: sustainable,
    maximumWeeklyMinutes: numberValue(constraints.maximumWeeklyMinutes),
    longRunToleranceMinutes: profile.longRunToleranceMin ?? inferLongRunTolerance(activities),
    runningDaysPerWeek: numberValue(constraints.runningDaysPerWeek) ?? inferRunningDays(activities),
    maxQualitySessions: profile.maxQualitySessions,
    strengthSessionsPerWeek: profile.strengthSessionsTarget,
    recentEasyPaceSecPerKm: median(paces) || undefined,
    weekInLoadCycle: loadCycleValue(constraints.weekInLoadCycle),
    allowControlledSteadyInBase: constraints.allowControlledSteadyInBase === true,
    kneeHistory: constraints.kneeHistory !== false || checkins.some((checkin) => (checkin.leftKneePain ?? 0) > 0 || (checkin.rightKneePain ?? 0) > 0),
    achillesHistory: constraints.achillesHistory !== false || checkins.some((checkin) => (checkin.leftAchillesPain ?? 0) > 0 || (checkin.rightAchillesPain ?? 0) > 0),
  };
}

function goalEventFromConstraints(constraints: Record<string, unknown>): EngineCoachProfile['goalEvent'] {
  const raw = constraints.scullionGoal;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const goal = raw as Record<string, unknown>;
  const distanceKm = numberValue(goal.distanceKm);
  const targetTimeSec = numberValue(goal.timeSeconds);
  if (!distanceKm || !targetTimeSec || distanceKm < 1 || distanceKm > 100 || targetTimeSec < 180) return undefined;
  return {
    distanceKm,
    targetTimeSec,
    targetDate: typeof goal.targetDate === 'string' && goal.targetDate ? goal.targetDate : undefined,
  };
}

function buildRecentWeeks(
  activities: CoachActivitySummary[],
  assessments: SessionStressAssessment[],
  feedbackByActivity: Map<string, ActivityFeedback>,
  asOf: string,
): RecentTrainingWeek[] {
  const assessmentById = new Map(assessments.map((assessment) => [assessment.activityId, assessment]));
  const groups = new Map<string, CoachActivitySummary[]>();
  for (const activity of activities) {
    const week = mondayOf((activity.startDateLocal || activity.startDate).slice(0, 10));
    const bucket = groups.get(week) ?? [];
    bucket.push(activity);
    groups.set(week, bucket);
  }
  const currentWeek = mondayOf(asOf.slice(0, 10));
  return [...groups.entries()]
    .filter(([week]) => week < currentWeek)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-12)
    .map(([weekStart, weekActivities]) => {
      const weekAssessments = weekActivities.map((activity) => assessmentById.get(activity.id)).filter(isDefined);
      const weekFeedback = weekActivities.map((activity) => feedbackByActivity.get(activity.id)).filter(isDefined);
      const maxPain = weekFeedback.reduce((max, item) => Math.max(max, item.painDuring ?? 0, item.painAfter ?? 0), 0);
      const adverseResponses = weekAssessments.filter((assessment) =>
        assessment.heartRateCost.status === 'very_elevated' ||
        (assessment.latePowerChangePct ?? 0) <= -8 ||
        (assessment.powerHrDecouplingPct ?? 0) >= 8,
      ).length;
      return {
        weekStart,
        runningMinutes: Math.round(sum(weekActivities.map((activity) => activity.movingTimeSec)) / 60),
        distanceKm: round(sum(weekActivities.map((activity) => activity.distanceKm)), 1),
        stress: round(sum(weekAssessments.map((assessment) => assessment.externalStress.totalStress ?? 0)), 1),
        hardStress: round(sum(weekAssessments.map((assessment) => assessment.externalStress.hardStress ?? 0)), 1),
        longRunMinutes: Math.round(Math.max(0, ...weekActivities.map((activity) => activity.movingTimeSec)) / 60),
        absorbed: maxPain < 3 && !weekFeedback.some((item) => item.alteredGait) && adverseResponses < 2,
        emergencyReduction: weekFeedback.some((item) => /emergency|cut short|aborted/i.test(item.note)),
      };
    });
}

function buildBackgroundLoad(
  assessments: SessionStressAssessment[],
  asOf: string,
  lookbackDays: number,
): CoachBackgroundLoad {
  const byDay = new Map<string, { stress: number; hard: number }>();
  for (const assessment of assessments) {
    const day = assessment.activityDate.slice(0, 10);
    const current = byDay.get(day) ?? { stress: 0, hard: 0 };
    current.stress += assessment.externalStress.totalStress ?? 0;
    current.hard += assessment.externalStress.hardStress ?? 0;
    byDay.set(day, current);
  }
  let sevenDayStress = 0;
  let fortyTwoDayStress = 0;
  let sevenDayHardStress = 0;
  const asOfDay = Date.parse(`${asOf.slice(0, 10)}T00:00:00Z`);
  const start = asOfDay - (lookbackDays - 1) * DAY_MS;
  for (let ms = start; ms <= asOfDay; ms += DAY_MS) {
    const day = new Date(ms).toISOString().slice(0, 10);
    const load = byDay.get(day) ?? { stress: 0, hard: 0 };
    sevenDayStress += (load.stress - sevenDayStress) / 7;
    fortyTwoDayStress += (load.stress - fortyTwoDayStress) / 42;
    sevenDayHardStress += (load.hard - sevenDayHardStress) / 7;
  }
  const ratio = fortyTwoDayStress > 0 ? sevenDayStress / fortyTwoDayStress : null;
  return {
    sevenDayStress: round(sevenDayStress, 1),
    fortyTwoDayStress: round(fortyTwoDayStress, 1),
    stressBalance: round(fortyTwoDayStress - sevenDayStress, 1),
    sevenToFortyTwoRatio: ratio === null ? null : round(ratio, 2),
    sevenDayHardStress: round(sevenDayHardStress, 1),
    explanation: 'Seven-day and 42-day values are exponentially weighted power-first stress backgrounds. They describe accumulated load, not complete fitness or readiness.',
  };
}

function buildObservedState(
  assessments: SessionStressAssessment[],
  feedback: ActivityFeedback[],
  checkins: DailyCheckin[],
  asOf: string,
): CoachObservedState {
  const cutoff = Date.parse(asOf) - 10 * DAY_MS;
  const recentAssessments = assessments.filter((assessment) => Date.parse(assessment.activityDate) >= cutoff);
  const recentFeedback = feedback.filter((item) => {
    const assessment = assessments.find((candidate) => candidate.activityId === item.activityId);
    return assessment ? Date.parse(assessment.activityDate) >= cutoff : false;
  });
  const recentCheckins = checkins.filter((checkin) => Date.parse(`${checkin.day}T00:00:00Z`) >= cutoff);
  const elevated = recentAssessments.filter((assessment) =>
    assessment.heartRateCost.status === 'elevated' || assessment.heartRateCost.status === 'very_elevated',
  ).length;
  const deteriorating = recentAssessments.filter((assessment) =>
    (assessment.latePowerChangePct ?? 0) <= -6 || (assessment.powerHrDecouplingPct ?? 0) >= 7,
  ).length;
  const maxPain = Math.max(
    0,
    ...recentFeedback.flatMap((item) => [item.painDuring ?? 0, item.painAfter ?? 0]),
    ...recentCheckins.flatMap((item) => [
      item.leftKneePain ?? 0,
      item.rightKneePain ?? 0,
      item.leftAchillesPain ?? 0,
      item.rightAchillesPain ?? 0,
    ]),
  );
  const alteredGait = recentFeedback.some((item) => item.alteredGait) || recentCheckins.some((item) => item.painAlteredGait);
  const illnessSuspected = recentCheckins.some((item) => item.illnessSuspected);
  const reasons: string[] = [];
  if (alteredGait) reasons.push('pain altered gait');
  if (maxPain >= 5) reasons.push(`pain reached ${maxPain}/10`);
  if (illnessSuspected) reasons.push('illness is suspected');
  if (elevated >= 2) reasons.push(`${elevated} recent runs had elevated HR cost for power`);
  if (deteriorating >= 2) reasons.push(`${deteriorating} recent runs showed late deterioration`);
  const state = alteredGait || maxPain >= 5 || illnessSuspected
    ? 'red'
    : maxPain >= 3 || elevated >= 2 || deteriorating >= 2
      ? 'amber'
      : 'green';
  return { state, reasons, elevatedHeartRateCostRuns: elevated, deterioratingRuns: deteriorating, maxRecentPain: maxPain, alteredGait, illnessSuspected };
}

function feedbackToEngine(feedback: ActivityFeedback, activity?: CoachActivitySummary): AthleteFeedback {
  return {
    activityId: feedback.activityId,
    date: (activity?.startDateLocal || activity?.startDate || feedback.updatedAt).slice(0, 10),
    energy: energyLabel(feedback.energy),
    legs: legLabel(feedback.legCondition),
    sessionFeel: feedback.sessionFeel,
    perceivedCost: costLabel(feedback.perceivedCost),
    rpe: feedback.perceivedEffort,
    breathing: breathingLabel(feedback.breathingCondition),
    painDuring: feedback.painDuring,
    painAfter: feedback.painAfter,
    painLocation: feedback.painLocation,
    alteredGait: feedback.alteredGait,
    note: feedback.note,
  };
}

function checkinToEngine(checkin: DailyCheckin): AthleteFeedback {
  const painValues = [checkin.leftKneePain, checkin.rightKneePain, checkin.leftAchillesPain, checkin.rightAchillesPain]
    .filter((value): value is number => value !== undefined);
  return {
    date: checkin.day,
    energy: energyLabel(checkin.energy),
    legs: freshnessLabel(checkin.legFreshness),
    painAfter: painValues.length > 0 ? Math.max(...painValues) : undefined,
    painLocation: painLocation(checkin),
    alteredGait: checkin.painAlteredGait,
    illnessSuspected: checkin.illnessSuspected,
    sleepQuality: checkin.sleepQuality,
    motivation: checkin.motivation,
    note: checkin.note,
  };
}

function inferEvidence(name: string, sportType: string): { kind: CoachActivitySummary['effortKind']; quality: number } {
  const text = `${name} ${sportType}`.toLowerCase();
  if (/race|parkrun|championship/.test(text)) return { kind: 'race', quality: 0.95 };
  if (/time trial|\btt\b|test/.test(text)) return { kind: 'time_trial', quality: 0.9 };
  if (/interval|threshold|tempo|repetition|vo2|track|session/.test(text)) return { kind: 'workout', quality: 0.72 };
  return { kind: 'training', quality: 0.45 };
}

function parseNumberArray(value: string | null): number[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    const values = parsed.map((item) => typeof item === 'number' ? item : Number.NaN);
    return values.every(Number.isFinite) ? values : undefined;
  } catch {
    return undefined;
  }
}

function normalizeAsOf(value?: string): string {
  if (!value) return new Date().toISOString();
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value);
  if (!Number.isFinite(parsed)) throw new Error('asOf must be an ISO date or timestamp.');
  return new Date(parsed).toISOString();
}

function normalizeDay(value: string): string {
  const day = value.slice(0, 10);
  const parsed = new Date(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) {
    throw new Error('Date must use YYYY-MM-DD.');
  }
  return day;
}

function mondayOf(day: string): string {
  const date = new Date(`${normalizeDay(day)}T00:00:00Z`);
  const offset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

function addDays(day: string, amount: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + amount * DAY_MS).toISOString().slice(0, 10);
}

function inferLongRunTolerance(activities: CoachActivitySummary[]): number {
  const recent = activities.slice(-84).map((activity) => activity.movingTimeSec / 60).filter((value) => value > 0);
  return Math.max(60, Math.min(180, Math.round(percentile(recent, 0.9) || 90)));
}

function inferRunningDays(activities: CoachActivitySummary[]): number {
  const recent = activities.slice(-84);
  if (recent.length === 0) return 5;
  const first = Date.parse(recent[0].startDate);
  const last = Date.parse(recent[recent.length - 1].startDate);
  const weeks = Math.max(1, (last - first) / (7 * DAY_MS));
  return clamp(Math.round(recent.length / weeks), 3, 7);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function loadCycleValue(value: unknown): 1 | 2 | 3 | undefined {
  return value === 1 || value === 2 || value === 3 ? value : undefined;
}

function energyLabel(value?: number): AthleteFeedback['energy'] {
  return value === undefined ? undefined : value >= 4 ? 'good' : value >= 3 ? 'okay' : 'poor';
}

function freshnessLabel(value?: number): AthleteFeedback['legs'] {
  return value === undefined ? undefined : value >= 5 ? 'fresh' : value >= 3 ? 'normal' : value >= 2 ? 'heavy' : 'dead';
}

function legLabel(value?: string): AthleteFeedback['legs'] {
  const normalized = value?.toLowerCase().replace(/\s+/g, '_');
  return normalized === 'fresh' || normalized === 'normal' || normalized === 'heavy' || normalized === 'dead'
    ? normalized
    : undefined;
}

function costLabel(value?: string): AthleteFeedback['perceivedCost'] {
  const normalized = value?.toLowerCase().replace(/\s+/g, '_');
  return normalized === 'low' || normalized === 'expected' || normalized === 'high' || normalized === 'extreme'
    ? normalized
    : undefined;
}

function breathingLabel(value?: string): AthleteFeedback['breathing'] {
  const normalized = value?.toLowerCase().replace(/\s+/g, '_');
  return normalized === 'controlled' || normalized === 'labored' || normalized === 'abnormal'
    ? normalized
    : undefined;
}

function painLocation(checkin: DailyCheckin): string | undefined {
  const locations: string[] = [];
  if ((checkin.leftKneePain ?? 0) > 0) locations.push('left knee');
  if ((checkin.rightKneePain ?? 0) > 0) locations.push('right knee');
  if ((checkin.leftAchillesPain ?? 0) > 0) locations.push('left Achilles');
  if ((checkin.rightAchillesPain ?? 0) > 0) locations.push('right Achilles');
  return locations.length > 0 ? locations.join(', ') : undefined;
}

function formatRaceTime(seconds: number): string {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)));
  return sorted[index];
}

function median(values: number[]): number {
  return percentile(values, 0.5);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function round(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
