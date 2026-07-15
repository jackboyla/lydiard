import type { GymSession } from '../types';
import type { CoachContextData, CoachPhase, CoachProfileRecord } from '../data/coachTypes';

const DAY_MS = 86_400_000;

export interface ScullionGoal {
  distanceKm: number;
  timeSeconds: number;
  targetDate?: string;
}

export type ScullionBucketStatus = 'covered' | 'building' | 'needs_attention' | 'planned_later';

export interface ScullionBucket {
  key: 'volume' | 'recovery' | 'steady' | 'threshold' | 'vo2' | 'long_run' | 'strength' | 'specificity';
  label: string;
  actual: number;
  target: number;
  unit: 'km' | 'min' | 'days' | 'sessions';
  progress: number;
  status: ScullionBucketStatus;
  evidence: string;
  nextStep: string;
}

export interface ScullionPlanRead {
  goal: ScullionGoal;
  goalLabel: string;
  goalPaceSecPerKm: number;
  currentEquivalentSeconds?: number;
  currentEquivalentConfidence?: string;
  currentEquivalentCaveat?: string;
  paceGapSecPerKm?: number;
  daysToGoal?: number;
  weeklyTargetKm: number;
  currentWeekKm: number;
  currentWeekSessions: number;
  fourWeekKm: number;
  absorbedWeeks: number;
  mission: string;
  missionConfidence: 'low' | 'moderate' | 'high';
  overallStatus: 'on_track' | 'work_to_do' | 'protect_recovery';
  buckets: ScullionBucket[];
}

export function scullionGoalFromProfile(profile: CoachProfileRecord): ScullionGoal {
  const stored = profile.constraints.scullionGoal;
  if (isRecord(stored)) {
    const distanceKm = finiteNumber(stored.distanceKm);
    const timeSeconds = finiteNumber(stored.timeSeconds);
    const targetDate = typeof stored.targetDate === 'string' && stored.targetDate ? stored.targetDate : undefined;
    if (distanceKm && distanceKm > 0 && timeSeconds && timeSeconds > 0) {
      return { distanceKm, timeSeconds, targetDate };
    }
  }
  return {
    distanceKm: 5,
    timeSeconds: profile.goal5kSeconds,
    targetDate: profile.targetRaceDate,
  };
}

export function buildScullionPlanRead(
  context: CoachContextData,
  gymSessions: GymSession[],
  goal: ScullionGoal = scullionGoalFromProfile(context.profile),
): ScullionPlanRead {
  const asOfMs = Date.parse(context.asOf);
  const cutoffMs = asOfMs - 28 * DAY_MS;
  const recentRuns = context.recentRuns.filter((run) => {
    const time = Date.parse(run.startDateLocal ?? run.startDate);
    return Number.isFinite(time) && time >= cutoffMs && time <= asOfMs;
  });
  const recentRunIds = new Set(recentRuns.map((run) => run.id));
  const assessments = context.recentSessions.filter((session) => recentRunIds.has(session.activityId));
  const assessmentById = new Map(assessments.map((session) => [session.activityId, session]));
  const fourWeeks = context.recentWeeks.slice(-4);
  const completedWeekKm = fourWeeks.filter((week) => week.distanceKm > 0).map((week) => week.distanceKm);
  const recentWeeklyKm = mean(completedWeekKm) || recentRuns.reduce((sum, run) => sum + run.distanceKm, 0) / 4;
  const totalRecentMinutes = recentRuns.reduce((sum, run) => sum + run.movingTimeSec / 60, 0);
  const recentPace = recentRuns.reduce((sum, run) => sum + run.distanceKm, 0) > 0
    ? recentRuns.reduce((sum, run) => sum + run.movingTimeSec, 0) / recentRuns.reduce((sum, run) => sum + run.distanceKm, 0)
    : 360;
  const explicitWeeklyKm = context.profile.targetWeeklyDurationMin
    ? context.profile.targetWeeklyDurationMin * 60 / recentPace
    : undefined;
  const eventCeiling = eventWeeklyCeiling(goal.distanceKm);
  const progressionCap = recentWeeklyKm > 0
    ? recentWeeklyKm * (context.observedState.state === 'green' ? 1.06 : context.observedState.state === 'amber' ? 1 : 0.82)
    : Math.min(eventCeiling, Math.max(20, goal.distanceKm * 3));
  const desiredCurrentDose = explicitWeeklyKm ?? eventCeiling;
  const weeklyTargetKm = round(Math.max(1, Math.min(desiredCurrentDose, progressionCap)), 1);
  const fourWeekKm = round(recentRuns.reduce((sum, run) => sum + run.distanceKm, 0), 1);
  const goalPaceSecPerKm = goal.timeSeconds / goal.distanceKm;
  const phase = context.profile.currentPhase;
  const zones = zoneMinutes(recentRuns, assessmentById);
  const hardDates = hardSessionDates(recentRuns, assessmentById);
  const protectedRecoveryDays = countProtectedRecoveryDays(hardDates, recentRuns, assessmentById, asOfMs);
  const recentGym = gymSessions.filter((session) => {
    const time = Date.parse(session.startDateLocal ?? session.startDate);
    return Number.isFinite(time) && time >= cutoffMs && time <= asOfMs;
  });
  const longestRunMin = Math.max(0, ...recentRuns.map((run) => run.movingTimeSec / 60));
  const longRunTargetMin = currentLongRunTarget(goal.distanceKm, context.profile.longRunToleranceMin, longestRunMin);
  const raceSpecificMinutes = recentRuns.reduce((sum, run) => {
    if (run.distanceKm <= 0 || run.movingTimeSec < 10 * 60) return sum;
    const pace = run.movingTimeSec / run.distanceKm;
    return Math.abs(pace - goalPaceSecPerKm) / goalPaceSecPerKm <= 0.06 ? sum + run.movingTimeSec / 60 : sum;
  }, 0);
  const currentWeekRuns = recentRuns.filter((run) => {
    const day = (run.startDateLocal ?? run.startDate).slice(0, 10);
    return day >= context.currentWeek.weekStart && day <= context.currentWeek.weekEnd;
  });
  const activePlanned = context.currentWeek.sessions.filter((session) =>
    !['rest', 'strength', 'cancelled', 'superseded'].includes(session.sessionType) &&
    !['cancelled', 'superseded'].includes(session.status),
  );
  const currentWeekKm = round(currentWeekRuns.reduce((sum, run) => sum + run.distanceKm, 0), 1);
  const currentWeekSessions = activePlanned.length || currentWeekRuns.length;
  const absorbedWeeks = fourWeeks.filter((week) => week.absorbed).length;

  const steadyTarget = phaseTarget(phase, { aerobic_conditioning: 90, hill_resistance: 60, anaerobic_development: 45, coordination: 30, recovery_regeneration: 0 });
  const thresholdTarget = phaseTarget(phase, { aerobic_conditioning: 55, hill_resistance: 45, anaerobic_development: 100, coordination: 55, recovery_regeneration: 0 });
  const vo2Target = phaseTarget(phase, { aerobic_conditioning: 20, hill_resistance: 20, anaerobic_development: 40, coordination: 24, recovery_regeneration: 0 });
  const specificityActive = phase === 'anaerobic_development' || phase === 'coordination';
  const specificityTarget = specificityActive ? raceSpecificTarget(goal.distanceKm) : 0;
  const recoveryTarget = hardDates.length;

  const buckets: ScullionBucket[] = [
    bucket(
      'volume',
      'Aerobic volume',
      fourWeekKm,
      weeklyTargetKm * 4,
      'km',
      `Last 28 days contain ${fourWeekKm.toFixed(1)} km; the current safe block target is ${weeklyTargetKm.toFixed(1)} km per week.`,
      recentWeeklyKm > 0 && eventCeiling > progressionCap
        ? `Hold near ${weeklyTargetKm.toFixed(1)} km first. Build the floor before chasing event-volume folklore.`
        : 'Keep the ordinary week repeatable; change only one major stressor at a time.',
    ),
    recoveryTarget === 0
      ? { key: 'recovery', label: 'Recovery after stress', actual: 0, target: 0, unit: 'days', progress: 1, status: 'covered', evidence: 'No consequential hard session created a recovery debt in this window.', nextStep: 'Keep at least two genuinely easy or non-running days in the weekly structure.' }
      : bucket(
          'recovery',
          'Recovery after stress',
          protectedRecoveryDays,
          recoveryTarget,
          'days',
          `${protectedRecoveryDays} of ${recoveryTarget} hard exposures were followed by a rest day or genuinely low-intensity running.`,
          'Protect the day after every threshold, VO₂, race-specific, or hard long-run exposure.',
        ),
    bucket('steady', 'Steady / LT1', zones.steady, steadyTarget, 'min', `${Math.round(zones.steady)} minutes of controlled steady/LT1 work were detected.`, 'Add steady work inside an aerobic run before turning whole days into medium-hard training.'),
    thresholdTarget === 0
      ? plannedLater('threshold', 'Threshold / LT2', zones.threshold, 'min', 'Threshold is intentionally suppressed during recovery and regeneration.', 'Reintroduce only after normal energy, mechanics, and recovery return.')
      : bucket('threshold', 'Threshold / LT2', zones.threshold, thresholdTarget, 'min', `${Math.round(zones.threshold)} minutes near the threshold domain were detected.`, 'Keep it repeatable: controlled breathing, stable reps, and enough reserve for one more.'),
    phase === 'recovery_regeneration'
      ? plannedLater('vo2', 'Speed / VO₂ access', zones.vo2, 'min', 'High-intensity work is intentionally absent while recovery overrides performance.', 'Resume with relaxed strides or short hills before a full VO₂ session.')
      : bucket('vo2', 'Speed / VO₂ access', zones.vo2, vo2Target, 'min', `${Math.round(zones.vo2)} minutes in the severe/VO₂ domain were detected. Short strides without stream evidence may be under-counted.`, phase === 'aerobic_conditioning' || phase === 'hill_resistance' ? 'Retain access with strides or short hills; a VO₂ block must replace, not join, another hard stimulus.' : 'Use an even, bounded injection every 7–10 days; stop before pace or posture deteriorates.'),
    bucket('long_run', 'Long run / durability', longestRunMin, longRunTargetMin, 'min', `The longest run in the window was ${Math.round(longestRunMin)} minutes; this block's earned durability target is ${Math.round(longRunTargetMin)} minutes.`, 'Extend duration before adding progression or goal-pace complexity.'),
    bucket('strength', 'Strength / chassis', recentGym.length, Math.max(1, context.profile.strengthSessionsTarget * 4), 'sessions', `${recentGym.length} strength sessions were recorded in the last 28 days.`, 'Prefer short, frequent work for calf/soleus, posterior chain, single-leg control, and trunk.'),
    specificityActive
      ? bucket('specificity', 'Goal-pace specificity', raceSpecificMinutes, specificityTarget, 'min', `${Math.round(raceSpecificMinutes)} minutes had a whole-run average within 6% of goal pace; interval-level work may be under-counted.`, 'Practise exact rhythm in controlled repetitions. Earn longer continuous blocks only when mechanics and recovery hold.')
      : plannedLater('specificity', 'Goal-pace specificity', raceSpecificMinutes, 'min', 'Race-specific work comes after the aerobic floor and durability are stable.', 'Keep building general capacity; goal pace becomes a priority in the final specific phase.'),
  ];

  const equivalent = currentEquivalent(context, goal);
  const needs = buckets.filter((item) => item.status === 'needs_attention');
  const building = buckets.filter((item) => item.status === 'building');
  const overallStatus = context.observedState.state !== 'green'
    ? 'protect_recovery'
    : needs.length > 0
      ? 'work_to_do'
      : 'on_track';
  const mission = missionCopy(context, needs, building);
  const evidenceCount = assessments.filter((assessment) => assessment.externalStress.reliability !== 'low').length;

  return {
    goal,
    goalLabel: eventLabel(goal.distanceKm),
    goalPaceSecPerKm,
    currentEquivalentSeconds: equivalent?.seconds,
    currentEquivalentConfidence: equivalent?.confidence,
    currentEquivalentCaveat: equivalent?.caveat,
    paceGapSecPerKm: equivalent ? equivalent.seconds / goal.distanceKm - goalPaceSecPerKm : undefined,
    daysToGoal: goal.targetDate ? Math.ceil((Date.parse(`${goal.targetDate}T23:59:59Z`) - asOfMs) / DAY_MS) : undefined,
    weeklyTargetKm,
    currentWeekKm,
    currentWeekSessions,
    fourWeekKm,
    absorbedWeeks,
    mission,
    missionConfidence: evidenceCount >= 16 ? 'high' : evidenceCount >= 7 ? 'moderate' : 'low',
    overallStatus,
    buckets,
  };
}

function zoneMinutes(
  runs: CoachContextData['recentRuns'],
  assessmentById: Map<string, CoachContextData['recentSessions'][number]>,
): { recovery: number; aerobic: number; steady: number; threshold: number; vo2: number } {
  const totals = { recovery: 0, aerobic: 0, steady: 0, threshold: 0, vo2: 0 };
  for (const run of runs) {
    const assessment = assessmentById.get(run.id);
    const zoneTotal = assessment?.powerZoneTime.reduce((sum, zone) => sum + zone.seconds, 0) ?? 0;
    if (assessment && zoneTotal >= assessment.durationSec * 0.5) {
      for (const zone of assessment.powerZoneTime) {
        const minutes = zone.seconds / 60;
        if (zone.zone === 'recovery') totals.recovery += minutes;
        else if (zone.zone === 'aerobic') totals.aerobic += minutes;
        else if (zone.zone === 'steady') totals.steady += minutes;
        else if (zone.zone === 'threshold') totals.threshold += minutes;
        else if (zone.zone === 'vo2_anaerobic') totals.vo2 += minutes;
      }
      continue;
    }
    const minutes = run.movingTimeSec / 60;
    const intensity = assessment?.externalStress.intensityFactor;
    if (intensity === undefined || intensity < 0.68) totals.recovery += minutes;
    else if (intensity < 0.78) totals.aerobic += minutes;
    else if (intensity < 0.88) totals.steady += minutes;
    else if (intensity < 1.02) totals.threshold += minutes;
    else totals.vo2 += minutes;
  }
  return totals;
}

function hardSessionDates(
  runs: CoachContextData['recentRuns'],
  assessmentById: Map<string, CoachContextData['recentSessions'][number]>,
): string[] {
  return runs.flatMap((run) => {
    const assessment = assessmentById.get(run.id);
    const hardSeconds = assessment?.powerZoneTime
      .filter((zone) => zone.zone === 'threshold' || zone.zone === 'vo2_anaerobic')
      .reduce((sum, zone) => sum + zone.seconds, 0) ?? 0;
    const hard = hardSeconds >= 8 * 60 || (assessment?.externalStress.intensityFactor ?? 0) >= 0.88 || (assessment?.externalStress.hardStress ?? 0) > 0;
    return hard ? [(run.startDateLocal ?? run.startDate).slice(0, 10)] : [];
  });
}

function countProtectedRecoveryDays(
  hardDates: string[],
  runs: CoachContextData['recentRuns'],
  assessmentById: Map<string, CoachContextData['recentSessions'][number]>,
  asOfMs: number,
): number {
  const runsByDay = new Map<string, CoachContextData['recentRuns']>();
  for (const run of runs) {
    const day = (run.startDateLocal ?? run.startDate).slice(0, 10);
    runsByDay.set(day, [...(runsByDay.get(day) ?? []), run]);
  }
  return hardDates.filter((day) => {
    const next = addDays(day, 1);
    if (Date.parse(`${next}T12:00:00Z`) > asOfMs) return false;
    const nextRuns = runsByDay.get(next) ?? [];
    if (nextRuns.length === 0) return true;
    return nextRuns.every((run) => (assessmentById.get(run.id)?.externalStress.intensityFactor ?? 0) < 0.78);
  }).length;
}

function currentEquivalent(context: CoachContextData, goal: ScullionGoal): { seconds: number; confidence: string; caveat: string } | undefined {
  const evidence = context.physiology.raceEquivalents
    .slice()
    .sort((a, b) => Math.abs(a.distanceM / 1000 - goal.distanceKm) - Math.abs(b.distanceM / 1000 - goal.distanceKm))[0];
  if (!evidence) return undefined;
  const seconds = evidence.predictedSec * (goal.distanceKm / (evidence.distanceM / 1000)) ** 1.06;
  return {
    seconds: Math.round(seconds),
    confidence: goal.distanceKm > 12 ? 'low' : evidence.confidence,
    caveat: goal.distanceKm > 12
      ? 'Long-distance equivalent extrapolated from critical-speed evidence; durability, fueling, terrain, and race specificity can materially change it.'
      : evidence.caveat,
  };
}

function bucket(
  key: ScullionBucket['key'],
  label: string,
  actual: number,
  target: number,
  unit: ScullionBucket['unit'],
  evidence: string,
  nextStep: string,
): ScullionBucket {
  const progress = target <= 0 ? 1 : clamp(actual / target, 0, 1);
  return {
    key,
    label,
    actual: round(actual, unit === 'km' ? 1 : 0),
    target: round(target, unit === 'km' ? 1 : 0),
    unit,
    progress,
    status: progress >= 0.85 ? 'covered' : progress >= 0.45 ? 'building' : 'needs_attention',
    evidence,
    nextStep,
  };
}

function plannedLater(
  key: ScullionBucket['key'],
  label: string,
  actual: number,
  unit: ScullionBucket['unit'],
  evidence: string,
  nextStep: string,
): ScullionBucket {
  return { key, label, actual: round(actual, 0), target: 0, unit, progress: 0, status: 'planned_later', evidence, nextStep };
}

function missionCopy(
  context: CoachContextData,
  needs: ScullionBucket[],
  building: ScullionBucket[],
): string {
  if (context.observedState.state === 'red') return 'Pause performance work, restore normal health and mechanics, and let recovery become the training.';
  if (context.observedState.state === 'amber') return 'Hold the aerobic rhythm, protect the next recovery decision, and do not add a second major stressor.';
  const priorities = [...needs, ...building].slice(0, 2).map((item) => item.label.toLowerCase());
  if (priorities.length === 0) return 'Keep stacking repeatable B+ weeks and preserve the balance that is already working.';
  return `Build ${priorities.join(' and ')}, while keeping every hard day absorbable enough to stack another good week.`;
}

function currentLongRunTarget(distanceKm: number, storedTolerance: number | undefined, currentLongest: number): number {
  const eventTarget = distanceKm <= 6 ? 75 : distanceKm <= 12 ? 90 : distanceKm <= 25 ? 110 : 135;
  const earned = storedTolerance ?? (currentLongest > 0 ? currentLongest * 1.08 : 60);
  return Math.min(eventTarget, Math.max(45, earned));
}

function raceSpecificTarget(distanceKm: number): number {
  if (distanceKm <= 6) return 50;
  if (distanceKm <= 12) return 75;
  if (distanceKm <= 25) return 120;
  return 160;
}

function eventWeeklyCeiling(distanceKm: number): number {
  if (distanceKm <= 6) return 55;
  if (distanceKm <= 12) return 65;
  if (distanceKm <= 25) return 80;
  return 95;
}

function eventLabel(distanceKm: number): string {
  if (Math.abs(distanceKm - 5) < 0.05) return '5K';
  if (Math.abs(distanceKm - 10) < 0.05) return '10K';
  if (Math.abs(distanceKm - 21.0975) < 0.1) return 'Half marathon';
  if (Math.abs(distanceKm - 42.195) < 0.1) return 'Marathon';
  return `${round(distanceKm, 1)} km`;
}

function phaseTarget(phase: CoachPhase, targets: Record<CoachPhase, number>): number {
  return targets[phase];
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}
