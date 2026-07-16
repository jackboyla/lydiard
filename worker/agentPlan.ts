import type { D1Database } from '@cloudflare/workers-types';
import {
  getCoachDecisionByRequestId,
  getCoachProfile,
  getPlannedSessions,
  patchPlannedSession,
  upsertCoachDecision,
  upsertPlannedSessions,
  PlannedSessionConflictError,
  type PlannedSession,
  type PlannedSessionInput,
} from './db';

type ExpertWisdomSourceId = 'scullion' | 'magness';

const MAX_PLAN_WEEKS = 12;
const ACTIVE_PLAN_STATUSES = new Set(['proposed', 'accepted', 'planned']);
const SESSION_TYPES = [
  'rest', 'strength', 'recovery', 'aerobic', 'medium_long', 'long_aerobic', 'steady', 'strides',
  'hill_sprints', 'hill_circuit', 'threshold', 'vo2', 'race_specific', 'coordination',
] as const;
const TRAINING_PHASES = [
  'aerobic_conditioning', 'hill_resistance', 'anaerobic_development', 'coordination', 'recovery_regeneration',
] as const;
const PRIORITIES = ['key', 'supporting', 'optional'] as const;
const STEP_KINDS = ['warmup', 'continuous', 'repetitions', 'recovery', 'strides', 'cooldown'] as const;
const EXPERT_SOURCES = ['scullion', 'magness'] as const;

type SessionType = typeof SESSION_TYPES[number];
type TrainingPhase = typeof TRAINING_PHASES[number];
type Priority = typeof PRIORITIES[number];
type StepKind = typeof STEP_KINDS[number];

interface Range {
  low: number;
  high: number;
}

interface PaceRange {
  fastSecPerKm: number;
  slowSecPerKm: number;
}

interface AgentPlanTargets {
  powerWatts?: Range;
  powerPctCriticalPower?: Range;
  heartRateBpm?: Range;
  heartRateCeiling?: number;
  paceSecPerKm?: PaceRange;
}

interface AgentWorkoutStep {
  kind: StepKind;
  durationMin?: number;
  count?: number;
  repetitionDurationSec?: number;
  recoveryDurationSec?: number;
  distanceM?: number;
  note: string;
}

interface AgentPlanSession {
  plannedDate: string;
  title: string;
  sessionType: SessionType;
  trainingPhase: TrainingPhase;
  priority: Priority;
  plannedDurationMin: number;
  plannedDistanceKm?: number;
  targets: AgentPlanTargets;
  workoutSteps: AgentWorkoutStep[];
  purpose: string;
  fallbackPlan: string;
  coachReasoning: string;
  adaptationGuidance: string;
}

export interface AgentPlanSubmission {
  requestId: string;
  expectedProfileVersion: number;
  contextGeneratedAt?: string;
  title: string;
  goal: string;
  summary: string;
  startDate: string;
  numberOfWeeks: number;
  expertSources: ExpertWisdomSourceId[];
  sessions: AgentPlanSession[];
}

export class AgentPlanInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentPlanInputError';
  }
}

export class AgentPlanConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentPlanConflictError';
  }
}

export function parseAgentPlanSubmission(value: unknown): AgentPlanSubmission {
  if (!isRecord(value)) throw new AgentPlanInputError('Request body must be a JSON object.');
  const requestId = requiredText(value.requestId, 'requestId', 200);
  const expectedProfileVersion = integer(value.expectedProfileVersion);
  if (!expectedProfileVersion || expectedProfileVersion < 1) {
    throw new AgentPlanInputError('expectedProfileVersion must be the positive profile version returned by getCoachContext.');
  }
  const contextGeneratedAt = optionalText(value.contextGeneratedAt, 'contextGeneratedAt', 80);
  if (contextGeneratedAt && !Number.isFinite(Date.parse(contextGeneratedAt))) {
    throw new AgentPlanInputError('contextGeneratedAt must be an ISO date-time when provided.');
  }
  const title = requiredText(value.title, 'title', 160);
  const goal = requiredText(value.goal, 'goal', 1000);
  const summary = requiredText(value.summary, 'summary', 3000);
  const startDate = validDate(value.startDate, 'startDate');
  const numberOfWeeks = integer(value.numberOfWeeks);
  if (!numberOfWeeks || numberOfWeeks < 1 || numberOfWeeks > MAX_PLAN_WEEKS) {
    throw new AgentPlanInputError(`numberOfWeeks must be between 1 and ${MAX_PLAN_WEEKS}.`);
  }
  if (!Array.isArray(value.expertSources) || value.expertSources.length === 0) {
    throw new AgentPlanInputError('expertSources must name at least one expert-wisdom source used in the plan.');
  }
  const expertSources = [...new Set(value.expertSources.map((item) => enumValue(item, EXPERT_SOURCES, 'expertSources')))] as ExpertWisdomSourceId[];
  if (!Array.isArray(value.sessions) || value.sessions.length === 0) {
    throw new AgentPlanInputError('sessions must contain at least one detailed planned session.');
  }
  if (value.sessions.length > numberOfWeeks * 14) {
    throw new AgentPlanInputError('sessions cannot exceed 14 entries per planned week.');
  }
  const planEnd = addDays(startDate, numberOfWeeks * 7 - 1);
  const sessions = value.sessions.map((item, index) => parseSession(item, index, startDate, planEnd));
  return {
    requestId,
    expectedProfileVersion,
    contextGeneratedAt,
    title,
    goal,
    summary,
    startDate,
    numberOfWeeks,
    expertSources,
    sessions,
  };
}

export async function publishAgentPlan(db: D1Database, submission: AgentPlanSubmission) {
  const existingDecision = await getCoachDecisionByRequestId(db, submission.requestId);
  if (existingDecision) {
    if (existingDecision.decisionType !== 'gpt_training_plan') {
      throw new AgentPlanConflictError('requestId is already used by another coaching decision.');
    }
    const storedStartDate = typeof existingDecision.planPatch.startDate === 'string'
      ? existingDecision.planPatch.startDate
      : submission.startDate;
    const storedWeeks = typeof existingDecision.planPatch.numberOfWeeks === 'number'
      ? existingDecision.planPatch.numberOfWeeks
      : submission.numberOfWeeks;
    const storedEndDate = typeof existingDecision.planPatch.endDate === 'string'
      ? existingDecision.planPatch.endDate
      : addDays(storedStartDate, storedWeeks * 7 - 1);
    return {
      planId: existingDecision.id,
      status: existingDecision.status,
      startDate: storedStartDate,
      endDate: storedEndDate,
      numberOfWeeks: storedWeeks,
      sessions: (await sessionsForDecision(db, existingDecision.id)).map(compactPublishedSession),
      supersededSessionIds: [],
      idempotent: true,
    };
  }

  const profile = await getCoachProfile(db);
  if (!profile) throw new AgentPlanConflictError('Coach profile is unavailable.');
  if (profile.version !== submission.expectedProfileVersion) {
    throw new AgentPlanConflictError(
      'The athlete profile changed after this plan was discussed. Call getCoachContext again and revise the plan before publishing.',
    );
  }

  const endDate = addDays(submission.startDate, submission.numberOfWeeks * 7 - 1);
  const decisionId = `gpt-plan-${crypto.randomUUID()}`;
  const sequenceByDate = new Map<string, number>();
  const sessions: PlannedSessionInput[] = submission.sessions.map((session, index) => {
    const sequence = sequenceByDate.get(session.plannedDate) ?? 0;
    sequenceByDate.set(session.plannedDate, sequence + 1);
    return toStoredSession(session, decisionId, index, sequence);
  });
  const existingSessions = await getPlannedSessions(db, { from: submission.startDate, to: endDate });
  const toSupersede = existingSessions.filter((session) => ACTIVE_PLAN_STATUSES.has(session.status));

  await upsertCoachDecision(db, {
    id: decisionId,
    decisionType: 'gpt_training_plan',
    asOf: new Date().toISOString(),
    weekStart: submission.startDate,
    status: 'applied',
    requestId: submission.requestId,
    stateVersionBefore: profile.version,
    stateVersionAfter: profile.version,
    policyVersion: profile.policyVersion,
    modelVersion: 'custom-gpt-plan-v1',
    summary: submission.title,
    reasoning: submission.summary,
    evidence: {
      goal: submission.goal,
      expertSources: submission.expertSources,
      contextGeneratedAt: submission.contextGeneratedAt,
      profileVersion: profile.version,
    },
    planPatch: {
      kind: 'gpt_training_plan',
      startDate: submission.startDate,
      endDate,
      numberOfWeeks: submission.numberOfWeeks,
      sessionIds: sessions.map((session) => session.id),
    },
    stateBefore: profile as unknown as Record<string, unknown>,
    stateAfter: profile as unknown as Record<string, unknown>,
    appliedAt: new Date().toISOString(),
  });
  await upsertPlannedSessions(db, sessions);

  const supersededSessionIds: string[] = [];
  for (const session of toSupersede) {
    try {
      await patchPlannedSession(db, session.id, { status: 'superseded' }, session.revision);
      supersededSessionIds.push(session.id);
    } catch (error) {
      if (error instanceof PlannedSessionConflictError) {
        throw new AgentPlanConflictError(error.message);
      }
      throw error;
    }
  }

  return {
    planId: decisionId,
    status: 'applied' as const,
    startDate: submission.startDate,
    endDate,
    numberOfWeeks: submission.numberOfWeeks,
    sessions: (await sessionsForDecision(db, decisionId)).map(compactPublishedSession),
    supersededSessionIds,
    idempotent: false,
  };
}

function parseSession(value: unknown, index: number, startDate: string, endDate: string): AgentPlanSession {
  const label = `sessions[${index}]`;
  if (!isRecord(value)) throw new AgentPlanInputError(`${label} must be an object.`);
  const plannedDate = validDate(value.plannedDate, `${label}.plannedDate`);
  if (plannedDate < startDate || plannedDate > endDate) {
    throw new AgentPlanInputError(`${label}.plannedDate must fall between ${startDate} and ${endDate}.`);
  }
  const plannedDurationMin = finiteNumber(value.plannedDurationMin);
  if (plannedDurationMin === undefined || plannedDurationMin < 0 || plannedDurationMin > 600) {
    throw new AgentPlanInputError(`${label}.plannedDurationMin must be between 0 and 600.`);
  }
  const plannedDistanceKm = optionalBoundedNumber(value.plannedDistanceKm, `${label}.plannedDistanceKm`, 0, 200);
  const targets = parseTargets(value.targets, `${label}.targets`);
  if (!Array.isArray(value.workoutSteps) || value.workoutSteps.length > 20) {
    throw new AgentPlanInputError(`${label}.workoutSteps must be an array with at most 20 steps.`);
  }
  const workoutSteps = value.workoutSteps.map((step, stepIndex) => parseWorkoutStep(step, `${label}.workoutSteps[${stepIndex}]`));
  return {
    plannedDate,
    title: requiredText(value.title, `${label}.title`, 160),
    sessionType: enumValue(value.sessionType, SESSION_TYPES, `${label}.sessionType`),
    trainingPhase: enumValue(value.trainingPhase, TRAINING_PHASES, `${label}.trainingPhase`),
    priority: enumValue(value.priority, PRIORITIES, `${label}.priority`),
    plannedDurationMin,
    plannedDistanceKm,
    targets,
    workoutSteps,
    purpose: requiredText(value.purpose, `${label}.purpose`, 2000),
    fallbackPlan: requiredText(value.fallbackPlan, `${label}.fallbackPlan`, 2000),
    coachReasoning: requiredText(value.coachReasoning, `${label}.coachReasoning`, 3000),
    adaptationGuidance: requiredText(value.adaptationGuidance, `${label}.adaptationGuidance`, 2000),
  };
}

function parseTargets(value: unknown, label: string): AgentPlanTargets {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new AgentPlanInputError(`${label} must be an object.`);
  const powerWatts = optionalRange(value.powerWatts, `${label}.powerWatts`, 0, 1500);
  const powerPctCriticalPower = optionalRange(value.powerPctCriticalPower, `${label}.powerPctCriticalPower`, 0, 3);
  const heartRateBpm = optionalRange(value.heartRateBpm, `${label}.heartRateBpm`, 20, 260);
  const heartRateCeiling = optionalBoundedNumber(value.heartRateCeiling, `${label}.heartRateCeiling`, 20, 260);
  let paceSecPerKm: PaceRange | undefined;
  if (value.paceSecPerKm !== undefined) {
    if (!isRecord(value.paceSecPerKm)) throw new AgentPlanInputError(`${label}.paceSecPerKm must be an object.`);
    const fastSecPerKm = optionalBoundedNumber(value.paceSecPerKm.fastSecPerKm, `${label}.paceSecPerKm.fastSecPerKm`, 120, 1800);
    const slowSecPerKm = optionalBoundedNumber(value.paceSecPerKm.slowSecPerKm, `${label}.paceSecPerKm.slowSecPerKm`, 120, 1800);
    if (fastSecPerKm === undefined || slowSecPerKm === undefined || fastSecPerKm > slowSecPerKm) {
      throw new AgentPlanInputError(`${label}.paceSecPerKm requires fastSecPerKm <= slowSecPerKm.`);
    }
    paceSecPerKm = { fastSecPerKm, slowSecPerKm };
  }
  return { powerWatts, powerPctCriticalPower, heartRateBpm, heartRateCeiling, paceSecPerKm };
}

function parseWorkoutStep(value: unknown, label: string): AgentWorkoutStep {
  if (!isRecord(value)) throw new AgentPlanInputError(`${label} must be an object.`);
  return {
    kind: enumValue(value.kind, STEP_KINDS, `${label}.kind`),
    durationMin: optionalBoundedNumber(value.durationMin, `${label}.durationMin`, 0, 600),
    count: optionalInteger(value.count, `${label}.count`, 1, 100),
    repetitionDurationSec: optionalBoundedNumber(value.repetitionDurationSec, `${label}.repetitionDurationSec`, 1, 21600),
    recoveryDurationSec: optionalBoundedNumber(value.recoveryDurationSec, `${label}.recoveryDurationSec`, 0, 3600),
    distanceM: optionalBoundedNumber(value.distanceM, `${label}.distanceM`, 1, 100000),
    note: requiredText(value.note, `${label}.note`, 1200),
  };
}

function toStoredSession(
  session: AgentPlanSession,
  decisionId: string,
  index: number,
  sequence: number,
): PlannedSessionInput {
  return {
    id: `${decisionId}-session-${index + 1}`,
    plannedDate: session.plannedDate,
    sequence,
    title: session.title,
    sessionType: session.sessionType,
    trainingPhase: session.trainingPhase,
    priority: session.priority,
    plannedDurationSec: Math.round(session.plannedDurationMin * 60),
    plannedDistanceKm: session.plannedDistanceKm,
    targetPowerLowW: session.targets.powerWatts?.low,
    targetPowerHighW: session.targets.powerWatts?.high,
    targetPowerLowPctCp: session.targets.powerPctCriticalPower?.low,
    targetPowerHighPctCp: session.targets.powerPctCriticalPower?.high,
    targetHrLow: session.targets.heartRateBpm?.low,
    targetHrHigh: session.targets.heartRateBpm?.high,
    targetHrCeiling: session.targets.heartRateCeiling,
    targetGapLowSecPerKm: session.targets.paceSecPerKm?.fastSecPerKm,
    targetGapHighSecPerKm: session.targets.paceSecPerKm?.slowSecPerKm,
    workoutStructure: {
      components: session.workoutSteps,
      adaptationGuidance: session.adaptationGuidance,
    },
    purpose: session.purpose,
    fallbackPlan: session.fallbackPlan,
    coachReasoning: session.coachReasoning,
    status: 'accepted',
    source: 'custom_gpt',
    coachDecisionId: decisionId,
  };
}

async function sessionsForDecision(db: D1Database, decisionId: string): Promise<PlannedSession[]> {
  const all = await getPlannedSessions(db);
  return all.filter((session) => session.coachDecisionId === decisionId);
}

function compactPublishedSession(session: PlannedSession) {
  return {
    id: session.id,
    plannedDate: session.plannedDate,
    title: session.title,
    status: session.status,
    revision: session.revision,
  };
}

function optionalRange(value: unknown, label: string, min: number, max: number): Range | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new AgentPlanInputError(`${label} must be an object.`);
  const low = optionalBoundedNumber(value.low, `${label}.low`, min, max);
  const high = optionalBoundedNumber(value.high, `${label}.high`, min, max);
  if (low === undefined || high === undefined || low > high) {
    throw new AgentPlanInputError(`${label} requires low <= high.`);
  }
  return { low, high };
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new AgentPlanInputError(`${label} is required.`);
  const text = value.trim();
  if (text.length > maxLength) throw new AgentPlanInputError(`${label} must be at most ${maxLength} characters.`);
  return text;
}

function optionalText(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new AgentPlanInputError(`${label} must be a string.`);
  if (value.length > maxLength) throw new AgentPlanInputError(`${label} must be at most ${maxLength} characters.`);
  return value;
}

function enumValue<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new AgentPlanInputError(`${label} must be one of: ${values.join(', ')}.`);
  }
  return value as T[number];
}

function validDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AgentPlanInputError(`${label} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new AgentPlanInputError(`${label} is not a valid calendar date.`);
  }
  return value;
}

function optionalBoundedNumber(value: unknown, label: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = finiteNumber(value);
  if (parsed === undefined || parsed < min || parsed > max) {
    throw new AgentPlanInputError(`${label} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function optionalInteger(value: unknown, label: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = integer(value);
  if (parsed === undefined || parsed < min || parsed > max) {
    throw new AgentPlanInputError(`${label} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function addDays(day: string, count: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
