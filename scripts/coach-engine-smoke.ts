import {
  buildHrCostBaseline,
  buildLydiardBlock,
  buildLydiardWeek,
  buildPowerDurationCurve,
  estimatePhysiology,
  evaluatePlannedVsActual,
  scoreLydiardSession,
  type AthleteFeedback,
  type CoachActivitySummary,
  type CriticalPowerHistoryRecord,
} from '../src/analysis/coachEngine';

const CP = 300;
const CS = 4.5;
const D_PRIME = 200;
const W_PRIME = 15_000;
const asOf = '2026-07-11T00:00:00.000Z';
const cpHistory: CriticalPowerHistoryRecord[] = [{
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  criticalPowerWatts: CP,
  source: 'stryd_auto',
  confidence: 0.9,
  device: 'Stryd',
}];

const efforts = [300, 600, 900, 1800, 2400].map((duration, index) => {
  const speed = (CS * duration + D_PRIME) / duration;
  const power = (CP * duration + W_PRIME) / duration;
  return constantRun(`effort-${duration}`, `2026-0${index + 2}-10T08:00:00.000Z`, duration, speed, power, duration >= 900 ? 176 : 170, 'time_trial');
});
const aerobic = [0, 1, 2, 3].map((index) => constantRun(
  `aerobic-${index}`,
  `2026-06-${String(5 + index * 5).padStart(2, '0')}T08:00:00.000Z`,
  2700,
  CS * 0.79,
  CP * 0.75,
  148 + index % 2,
  'training',
));
const history = [...efforts, ...aerobic];
const physiology = estimatePhysiology({ activities: history, criticalPowerHistory: cpHistory, asOf });

assert(physiology.criticalSpeed, 'critical speed should be estimated');
assert(Math.abs(physiology.criticalSpeed.estimate - CS) < 0.2, `critical speed should recover ${CS} m/s`);
assert(physiology.platformCriticalPower, 'platform CP should be estimated');
assert(Math.abs(physiology.platformCriticalPower.estimate - CP) < 15, `platform CP should recover ${CP} W`);
assert(physiology.zones.length === 5, 'five practical zones should be emitted');

const baseline = buildHrCostBaseline({ activities: aerobic, criticalPowerHistory: cpHistory, asOf });
assert(baseline.bins.length > 0, 'HR-cost baseline should have a personal %CP bin');

const cpHour = constantRun('cp-hour', '2026-07-10T08:00:00.000Z', 3600, CS, CP, 176, 'workout');
const stress = scoreLydiardSession({ activity: cpHour, criticalPowerHistory: cpHistory, physiology, hrCostBaseline: baseline });
assert(stress.lydiardPowerStress !== undefined && Math.abs(stress.lydiardPowerStress - 100) < 0.2, 'one hour at CP should equal 100 Lydiard Power Stress');
assert(stress.externalStress.source === 'power', 'valid Stryd power must exclusively anchor external stress');

const periodAssessments = [
  constantRun('power-recent', '2026-07-01T08:00:00.000Z', 3600, CS, 320, 170, 'workout'),
  constantRun('power-building', '2026-05-20T08:00:00.000Z', 3600, CS, 310, 168, 'workout'),
  constantRun('power-historic', '2026-03-01T08:00:00.000Z', 3600, CS, 300, 166, 'workout'),
].map((activity) => scoreLydiardSession({ activity, criticalPowerHistory: cpHistory, physiology, hrCostBaseline: baseline }));
const periodCurve = buildPowerDurationCurve(periodAssessments, asOf);
for (const [freshness, watts] of [['recent', 320], ['building', 310], ['historic', 300]] as const) {
  const series = periodCurve.filter((point) => point.freshness === freshness);
  assert(series.length === 9, `${freshness} power-duration series should include all nine durations`);
  assert(series.every((point) => point.watts === watts), `${freshness} power-duration series should use its own period maximum`);
}

const plan = buildLydiardWeek({
  weekStart: '2026-07-13',
  profile: {
    currentPhase: 'aerobic_conditioning',
    goals: [
      { distance: '5k', targetTimeSec: 900, priority: 1 },
      { distance: '10k', targetTimeSec: 1800, priority: 2 },
    ],
    sustainableWeeklyMinutes: 420,
    maximumWeeklyMinutes: 480,
    longRunToleranceMinutes: 105,
    runningDaysPerWeek: 6,
    maxQualitySessions: 2,
    strengthSessionsPerWeek: 2,
    weekInLoadCycle: 2,
    allowControlledSteadyInBase: true,
    kneeHistory: true,
    achillesHistory: true,
  },
  physiology,
  recentWeeks: [
    { weekStart: '2026-06-29', runningMinutes: 400, distanceKm: 75, stress: 390, hardStress: 30, longRunMinutes: 95, absorbed: true },
    { weekStart: '2026-07-06', runningMinutes: 410, distanceKm: 77, stress: 400, hardStress: 32, longRunMinutes: 100, absorbed: true },
  ],
  recentSessions: [],
  recentFeedback: [],
  sevenDayStress: 400,
  fortyTwoDayStress: 380,
});
assert(plan.currentState === 'green', 'two absorbed weeks without warnings should be green');
assert(plan.longRunMinutes <= 105, 'long run must respect known tolerance');
assert(plan.qualitySessionCount <= 2, 'quality must remain capped at two');
assert(plan.strengthSessionCount === 2, 'durability plan should preserve twice-weekly strength');

const halfMarathonGoalSeconds = 60 * 60;
const goalAwarePlan = buildLydiardWeek({
  weekStart: '2026-07-13',
  profile: {
    currentPhase: 'coordination',
    goals: [{ distance: '5k', targetTimeSec: 900, priority: 1 }],
    goalEvent: { distanceKm: 21.0975, targetTimeSec: halfMarathonGoalSeconds, targetDate: '2026-08-17' },
    sustainableWeeklyMinutes: 420,
    maximumWeeklyMinutes: 480,
    longRunToleranceMinutes: 105,
    runningDaysPerWeek: 6,
    maxQualitySessions: 2,
    strengthSessionsPerWeek: 2,
  },
  physiology,
  recentWeeks: [
    { weekStart: '2026-06-29', runningMinutes: 400, distanceKm: 75, stress: 390, hardStress: 30, longRunMinutes: 95, absorbed: true },
    { weekStart: '2026-07-06', runningMinutes: 410, distanceKm: 77, stress: 400, hardStress: 32, longRunMinutes: 100, absorbed: true },
  ],
  recentSessions: [],
  recentFeedback: [],
  sevenDayStress: 400,
  fortyTwoDayStress: 380,
});
const raceSpecific = goalAwarePlan.days.flatMap((day) => day.sessions).find((session) => session.sessionType === 'race_specific');
assert(raceSpecific?.target.gapPace, 'coordination phase should expose the goal-aware pace range');
assert(raceSpecific.target.gapPace.fastSecPerKm, 'goal-aware range should include a fast pace boundary');
assert(raceSpecific.target.gapPace.slowSecPerKm, 'goal-aware range should include a slow pace boundary');
const prescribedMidpoint = (raceSpecific.target.gapPace.fastSecPerKm + raceSpecific.target.gapPace.slowSecPerKm) / 2;
assert(
  prescribedMidpoint > halfMarathonGoalSeconds / 21.0975,
  'an unsupported goal pace must be capped by current race-equivalent evidence',
);
assert(goalAwarePlan.goalPriority.startsWith('Half marathon in 1:00:00.'), 'arbitrary saved event should steer the generated plan rationale');

const block = buildLydiardBlock({
  weekStart: '2026-07-13',
  weekCount: 3,
  profile: {
    currentPhase: 'aerobic_conditioning',
    goals: [
      { distance: '5k', targetTimeSec: 900, priority: 1 },
      { distance: '10k', targetTimeSec: 1800, priority: 2 },
    ],
    sustainableWeeklyMinutes: 420,
    maximumWeeklyMinutes: 480,
    longRunToleranceMinutes: 105,
    runningDaysPerWeek: 6,
    maxQualitySessions: 2,
    strengthSessionsPerWeek: 2,
    weekInLoadCycle: 1,
    allowControlledSteadyInBase: true,
    kneeHistory: true,
    achillesHistory: true,
  },
  physiology,
  recentWeeks: [
    { weekStart: '2026-06-29', runningMinutes: 400, distanceKm: 75, stress: 390, hardStress: 30, longRunMinutes: 95, absorbed: true },
    { weekStart: '2026-07-06', runningMinutes: 410, distanceKm: 77, stress: 400, hardStress: 32, longRunMinutes: 100, absorbed: true },
  ],
  recentSessions: [],
  recentFeedback: [],
  sevenDayStress: 400,
  fortyTwoDayStress: 380,
});
assert(block.weeks.length === 3, 'future block should contain three sequential weeks');
assert(block.weeks[1].contingent && block.weeks[2].contingent, 'weeks two and three must remain contingent');
assert(block.weeks[2].totalRunningMinutes < block.weeks[1].totalRunningMinutes, 'third load-cycle week should consolidate with lower duration');

const planned = plan.days.flatMap((day) => day.sessions).find((session) => session.sessionType === 'steady')
  ?? plan.days.flatMap((day) => day.sessions).find((session) => session.sessionType === 'aerobic');
assert(planned, 'plan should contain a runnable session');
const feedback: AthleteFeedback = {
  activityId: cpHour.id,
  date: '2026-07-10',
  energy: 'poor',
  legs: 'dead',
  sessionFeel: 'harder',
  perceivedCost: 'extreme',
  painDuring: 2,
  painAfter: 3,
  alteredGait: false,
  rpe: 9,
};
const evaluation = evaluatePlannedVsActual({
  planned,
  actual: stress,
  activity: cpHour,
  feedback,
  futureSessions: plan.days.flatMap((day) => day.sessions).filter((session) => session.id !== planned.id),
});
assert(evaluation.verdict === 'excessive', 'extreme cost plus a major dose/intensity overrun should be excessive');
assert(evaluation.proposedPatches.every((patch) => patch.requiresApproval), 'all adaptations must remain explicit approval-gated proposals');
assert(evaluation.approval.status === 'awaiting_approval', 'evaluation must not silently mutate the week');

console.log(JSON.stringify({
  criticalSpeed: physiology.criticalSpeed.estimate,
  platformCriticalPower: physiology.platformCriticalPower.estimate,
  zones: physiology.zones.map((zone) => zone.name),
  cpHourStress: stress.lydiardPowerStress,
  plan: {
    state: plan.currentState,
    phase: plan.phase,
    runningMinutes: plan.totalRunningMinutes,
    qualitySessions: plan.qualitySessionCount,
    longRunMinutes: plan.longRunMinutes,
  },
  goalAwarePlan: {
    goalPriority: goalAwarePlan.goalPriority,
    prescribedRacePaceSecPerKm: prescribedMidpoint,
    requestedRacePaceSecPerKm: halfMarathonGoalSeconds / 21.0975,
  },
  futureBlock: block.weeks.map((week) => ({
    weekStart: week.weekStart,
    minutes: week.totalRunningMinutes,
    contingent: week.contingent,
  })),
  postRun: {
    verdict: evaluation.verdict,
    proposedPatches: evaluation.proposedPatches.length,
    approval: evaluation.approval.status,
  },
}, null, 2));

function constantRun(
  id: string,
  startDate: string,
  durationSec: number,
  speedMps: number,
  powerWatts: number,
  heartRate: number,
  effortKind: CoachActivitySummary['effortKind'],
): CoachActivitySummary {
  const timeSec = Array.from({ length: durationSec + 1 }, (_, index) => index);
  return {
    id,
    name: id,
    sportType: 'running',
    startDate,
    startDateLocal: startDate,
    distanceKm: speedMps * durationSec / 1000,
    movingTimeSec: durationSec,
    elapsedTimeSec: durationSec,
    averageHeartRate: heartRate,
    maxHeartRate: heartRate + 4,
    averageWatts: powerWatts,
    averageSpeed: speedMps,
    effortKind,
    evidenceQuality: 0.95,
    powerDevice: 'Stryd',
    heartRateDevice: 'Chest strap',
    streams: {
      timeSec,
      distanceM: timeSec.map((time) => speedMps * time),
      velocityMps: timeSec.map(() => speedMps),
      gradeAdjustedSpeedMps: timeSec.map(() => speedMps),
      powerWatts: timeSec.map(() => powerWatts),
      heartRateBpm: timeSec.map(() => heartRate),
      altitudeM: timeSec.map(() => 20),
    },
  };
}

function assert<T>(value: T, message: string): asserts value is NonNullable<T> {
  if (!value) throw new Error(`Coach engine smoke failed: ${message}`);
}
