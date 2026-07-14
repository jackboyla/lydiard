/**
 * Deterministic physiology, load, planning, and post-run decision engine.
 *
 * The module deliberately has no browser, Worker, database, or Node dependency.
 * Power is treated as external work, heart rate as its internal cost, and
 * grade-adjusted pace as the external-load fallback. They are never averaged
 * into one arbitrary mixed score.
 */

export type ConfidenceLevel = 'low' | 'medium' | 'high';
export type EvidenceKind = 'race' | 'time_trial' | 'workout' | 'training' | 'incidental';
export type LydiardPhase = 'aerobic_conditioning' | 'hill_resistance' | 'anaerobic_development' | 'coordination' | 'recovery_regeneration';
export type PracticalZoneName = 'recovery' | 'aerobic' | 'steady' | 'threshold' | 'vo2_anaerobic';

export interface CoachActivityStreams {
  timeSec?: number[];
  distanceM?: number[];
  /** A device- or upstream-computed GAP speed is preferred when available. */
  gradeAdjustedSpeedMps?: number[];
  velocityMps?: number[];
  powerWatts?: number[];
  heartRateBpm?: number[];
  altitudeM?: number[];
  cadenceSpm?: number[];
}

/** Structurally compatible with the application's activity summary. */
export interface CoachActivitySummary {
  id: string;
  name: string;
  sportType: string;
  startDate: string;
  startDateLocal?: string;
  distanceKm: number;
  movingTimeSec: number;
  elapsedTimeSec?: number;
  averageHeartRate?: number;
  maxHeartRate?: number;
  averageWatts?: number;
  averageSpeed?: number;
  elevationGainM?: number;
  decouplingPct?: number;
  temperatureC?: number;
  powerDevice?: string;
  heartRateDevice?: string;
  effortKind?: EvidenceKind;
  /** 0..1: quality/maximality of this activity as physiology evidence. */
  evidenceQuality?: number;
  streams?: CoachActivityStreams;
}

export interface CriticalPowerHistoryRecord {
  effectiveFrom: string;
  criticalPowerWatts: number;
  source: 'stryd_auto' | 'stryd_test' | 'stryd_manual' | 'platform_estimate' | 'manual' | 'imported';
  confidence: number;
  supportingActivityIds?: string[];
  device?: string;
}

export interface ModelEvidence {
  activityId: string;
  activityName: string;
  date: string;
  durationSec: number;
  value: number;
  kind: EvidenceKind;
  weight: number;
  note: string;
}

export interface EstimateBand {
  estimate: number;
  low: number;
  high: number;
  confidence: ConfidenceLevel;
  confidenceScore: number;
  evidence: ModelEvidence[];
  explanation: string;
}

export interface LinearCapacityEstimate extends EstimateBand {
  /** Critical speed in m/s or critical power in W. */
  estimate: number;
  low: number;
  high: number;
  finiteCapacity: number;
  finiteCapacityUnit: 'm' | 'J';
  fitRmse: number;
  durationBucketsCovered: number;
  distinctActivities: number;
}

export interface RaceEquivalent {
  label: '5K' | '10K';
  distanceM: number;
  predictedSec: number;
  paceSecPerKm: number;
  confidence: ConfidenceLevel;
  caveat: string;
}

export interface ZoneRange {
  low?: number;
  high?: number;
}

export interface PaceRange {
  /** Faster edge of the range. */
  fastSecPerKm?: number;
  /** Slower edge of the range. */
  slowSecPerKm?: number;
}

export interface PracticalZone {
  name: PracticalZoneName;
  label: string;
  domain: 'moderate' | 'heavy' | 'severe';
  powerPctCp: ZoneRange;
  speedPctCs: ZoneRange;
  powerWatts?: ZoneRange;
  pace?: PaceRange;
  heartRateBpm?: ZoneRange;
  primaryUse: string;
  control: string;
}

export interface PhysiologyEstimate {
  asOf: string;
  criticalSpeed?: LinearCapacityEstimate;
  platformCriticalPower?: LinearCapacityEstimate;
  canonicalCriticalPower?: {
    watts: number;
    source: CriticalPowerHistoryRecord['source'];
    effectiveFrom: string;
    confidence: ConfidenceLevel;
    confidenceScore: number;
    device?: string;
    explanation: string;
  };
  lt1HeartRate?: EstimateBand;
  lt2HeartRate?: EstimateBand;
  maxObservedHeartRate?: number;
  raceEquivalents: RaceEquivalent[];
  zones: PracticalZone[];
  limitations: string[];
}

export interface PhysiologyInput {
  activities: CoachActivitySummary[];
  criticalPowerHistory?: CriticalPowerHistoryRecord[];
  asOf?: string;
  lookbackDays?: number;
}

export interface HrCostBin {
  lowPctCp: number;
  highPctCp: number;
  expectedHeartRate: number;
  typicalSpreadBpm: number;
  medianElapsedHours: number;
  sampleCount: number;
}

export interface HrCostBaseline {
  asOf: string;
  bins: HrCostBin[];
  typicalDriftBpmPerHour: number;
  confidence: ConfidenceLevel;
  confidenceScore: number;
  activityIds: string[];
  explanation: string;
}

export interface HrCostBaselineInput {
  activities: CoachActivitySummary[];
  criticalPowerHistory: CriticalPowerHistoryRecord[];
  asOf?: string;
  lookbackDays?: number;
  excludeActivityId?: string;
}

export interface PowerPeak {
  durationSec: 10 | 30 | 60 | 180 | 600 | 1200;
  watts?: number;
  pctCp?: number;
}

export interface ZoneTime {
  zone: PracticalZoneName;
  seconds: number;
  percent: number;
}

export interface ExternalStressResult {
  source: 'power' | 'gap' | 'pace' | 'unavailable';
  totalStress?: number;
  hardStress?: number;
  intensityFactor?: number;
  reliability: ConfidenceLevel;
  explanation: string;
}

export interface HrCostResult {
  observedHeartRate?: number;
  expectedHeartRate?: number;
  residualBpm?: number;
  status: 'lower_than_normal' | 'normal' | 'elevated' | 'very_elevated' | 'inconclusive';
  confidence: ConfidenceLevel;
  explanation: string;
}

export interface SessionStressAssessment {
  activityId: string;
  activityDate: string;
  durationSec: number;
  effectiveCriticalPower?: CriticalPowerHistoryRecord;
  externalStress: ExternalStressResult;
  lydiardPowerStress?: number;
  hardPowerStress?: number;
  averagePowerWatts?: number;
  averagePctCp?: number;
  weightedPowerWatts?: number;
  weightedPctCp?: number;
  powerZoneTime: ZoneTime[];
  peaks: PowerPeak[];
  latePowerChangePct?: number;
  powerHrDecouplingPct?: number;
  heartRateCost: HrCostResult;
  dataCoverage: {
    power: number;
    heartRate: number;
    speed: number;
  };
  warnings: string[];
}

export interface SessionScoringInput {
  activity: CoachActivitySummary;
  criticalPowerHistory: CriticalPowerHistoryRecord[];
  physiology?: PhysiologyEstimate;
  hrCostBaseline?: HrCostBaseline;
}

export type PlannedSessionType =
  | 'rest'
  | 'strength'
  | 'recovery'
  | 'aerobic'
  | 'medium_long'
  | 'long_aerobic'
  | 'steady'
  | 'strides'
  | 'hill_sprints'
  | 'hill_circuit'
  | 'threshold'
  | 'vo2'
  | 'race_specific'
  | 'coordination';

export interface WorkoutComponent {
  kind: 'warmup' | 'continuous' | 'repetitions' | 'recovery' | 'strides' | 'cooldown';
  durationMin?: number;
  count?: number;
  repetitionDurationSec?: number;
  recoveryDurationSec?: number;
  distanceM?: number;
  targetPowerPctCp?: ZoneRange;
  targetPaceSecPerKm?: PaceRange;
  note?: string;
}

export interface IntensityTarget {
  primaryControl: 'feel_hr' | 'power' | 'pace_power' | 'form_power' | 'recovery';
  powerPctCp?: ZoneRange;
  powerWatts?: ZoneRange;
  heartRateBpm?: ZoneRange;
  heartRateCeiling?: number;
  gapPace?: PaceRange;
  rpe?: ZoneRange;
  guidance: string;
}

export interface PlannedSession {
  id: string;
  plannedDate: string;
  title: string;
  sessionType: PlannedSessionType;
  phase: LydiardPhase;
  priority: 'key' | 'supporting' | 'optional';
  targetDurationMin: number;
  approximateDistanceKm?: ZoneRange;
  target: IntensityTarget;
  structure: WorkoutComponent[];
  purpose: string;
  fallbackPlan: string;
  coachReasoning: string;
  status: 'proposed' | 'accepted' | 'planned' | 'completed' | 'partial' | 'skipped' | 'cancelled' | 'superseded';
}

export interface AthleteFeedback {
  activityId?: string;
  date: string;
  energy?: 'good' | 'okay' | 'poor';
  legs?: 'fresh' | 'normal' | 'heavy' | 'dead';
  sessionFeel?: 'easier' | 'as_expected' | 'harder';
  perceivedCost?: 'low' | 'expected' | 'high' | 'extreme';
  rpe?: number;
  breathing?: 'controlled' | 'labored' | 'abnormal';
  painDuring?: number;
  painAfter?: number;
  painLocation?: string;
  alteredGait?: boolean;
  illnessSuspected?: boolean;
  sleepQuality?: number;
  motivation?: number;
  note?: string;
}

export interface CoachGoal {
  distance: '5k' | '10k';
  targetTimeSec: number;
  priority: number;
  targetDate?: string;
}

export interface CoachProfile {
  athleteName?: string;
  currentPhase: LydiardPhase;
  goals: CoachGoal[];
  goalEvent?: {
    distanceKm: number;
    targetTimeSec: number;
    targetDate?: string;
  };
  sustainableWeeklyMinutes: number;
  maximumWeeklyMinutes?: number;
  longRunToleranceMinutes: number;
  runningDaysPerWeek: number;
  maxQualitySessions?: number;
  strengthSessionsPerWeek: number;
  recentEasyPaceSecPerKm?: number;
  weekInLoadCycle?: 1 | 2 | 3;
  allowControlledSteadyInBase?: boolean;
  kneeHistory?: boolean;
  achillesHistory?: boolean;
}

export interface RecentTrainingWeek {
  weekStart: string;
  runningMinutes: number;
  distanceKm: number;
  stress: number;
  hardStress: number;
  longRunMinutes: number;
  absorbed: boolean;
  emergencyReduction?: boolean;
}

export interface PlanningStateInput {
  weekStart: string;
  profile: CoachProfile;
  physiology?: PhysiologyEstimate;
  recentWeeks: RecentTrainingWeek[];
  recentSessions: SessionStressAssessment[];
  recentFeedback: AthleteFeedback[];
  sevenDayStress?: number;
  fortyTwoDayStress?: number;
}

export interface AdaptationTriggers {
  green: string[];
  amber: string[];
  red: string[];
}

export interface PlannedDay {
  date: string;
  sessions: PlannedSession[];
}

export interface LydiardWeekPlan {
  weekStart: string;
  status: 'proposed';
  currentState: 'green' | 'amber' | 'red';
  currentStateExplanation: string;
  phase: LydiardPhase;
  phaseOverrideReason?: string;
  goalPriority: string;
  objective: string;
  days: PlannedDay[];
  totalRunningMinutes: number;
  approximateDistanceKm?: ZoneRange;
  qualitySessionCount: number;
  longRunMinutes: number;
  strengthSessionCount: number;
  intensityGuidance: string[];
  deliberatelyAbsent: string[];
  adaptationTriggers: AdaptationTriggers;
  nextDecisionPoint: string;
  decisions: string[];
}

export interface LydiardBlockPlan {
  startWeek: string;
  weekCount: 1 | 2 | 3;
  status: 'proposed';
  phase: LydiardPhase;
  weeks: Array<
    LydiardWeekPlan & {
      blockWeek: number;
      contingent: boolean;
      continuationConditions: string[];
    }
  >;
  totalRunningMinutes: number;
  approximateDistanceKm?: ZoneRange;
  nextDecisionPoint: string;
  explanation: string;
}

export interface BlockPlanningInput extends PlanningStateInput {
  weekCount: 1 | 2 | 3;
}

export type PostRunVerdict = 'absorbed' | 'productive_but_costly' | 'excessive' | 'inconclusive' | 'pain_injury_concern';

export interface ProposedSessionChange {
  field: 'sessionType' | 'title' | 'targetDurationMin' | 'target' | 'structure' | 'fallbackPlan' | 'status';
  before: unknown;
  after: unknown;
}

export interface ProposedSessionPatch {
  sessionId: string;
  plannedDate: string;
  changes: ProposedSessionChange[];
  reason: string;
  requiresApproval: true;
}

export interface PostRunEvaluationInput {
  planned: PlannedSession;
  actual: SessionStressAssessment;
  activity: CoachActivitySummary;
  feedback?: AthleteFeedback;
  futureSessions: PlannedSession[];
  recentEvaluations?: Array<{ verdict: PostRunVerdict; date: string }>;
}

export interface PostRunEvaluation {
  plannedSessionId: string;
  activityId: string;
  intendedStimulus: string;
  actualStimulus: string;
  externalVsInternalCost: string;
  mechanicalObservations: string[];
  verdict: PostRunVerdict;
  evidence: string[];
  remainingWeekEffect: string;
  proposedPatches: ProposedSessionPatch[];
  approval: {
    required: true;
    status: 'awaiting_approval';
    prompt: string;
  };
  zoneConfidenceUpdate: 'none' | 'positive_evidence_only' | 'review_after_repeat';
}

interface EffortPoint {
  activity: CoachActivitySummary;
  durationSec: number;
  distanceM?: number;
  averagePower?: number;
  averageHeartRate?: number;
  startSec: number;
  endSec: number;
  recencyWeight: number;
  sourceWeight: number;
  quality: number;
}

interface WeightedPoint {
  x: number;
  y: number;
  weight: number;
  evidence: ModelEvidence;
}

const DAY_MS = 86_400_000;
const EFFORT_DURATIONS = [180, 300, 480, 600, 900, 1200, 1800, 2400] as const;
const POWER_PEAK_DURATIONS = [10, 30, 60, 180, 600, 1200] as const;
const POWER_ZONE_BOUNDS = [0.7, 0.8, 0.9, 1] as const;

/** Return the CP record that was actually in force on the activity date. */
export function effectiveCriticalPower(
  history: CriticalPowerHistoryRecord[],
  at: string,
): CriticalPowerHistoryRecord | undefined {
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) return undefined;
  return [...history]
    .filter(validCriticalPowerRecord)
    .filter((record) => Date.parse(record.effectiveFrom) <= atMs)
    .sort((a, b) => Date.parse(b.effectiveFrom) - Date.parse(a.effectiveFrom))[0];
}

export function estimatePhysiology(input: PhysiologyInput): PhysiologyEstimate {
  const activities = input.activities
    .filter(isRunLike)
    .filter((activity) => validDate(activity.startDate) && activity.movingTimeSec > 0)
    .sort((a, b) => Date.parse(a.startDate) - Date.parse(b.startDate));
  const asOf = input.asOf ?? activities[activities.length - 1]?.startDate ?? new Date(0).toISOString();
  const asOfMs = Date.parse(asOf);
  const lookbackDays = clamp(input.lookbackDays ?? 365, 60, 1095);
  const eligible = activities.filter((activity) => {
    const ageDays = (asOfMs - Date.parse(activity.startDate)) / DAY_MS;
    return ageDays >= -1 && ageDays <= lookbackDays;
  });
  const limitations: string[] = [];
  const efforts = eligible.flatMap((activity) => extractEffortPoints(activity, asOfMs, lookbackDays));

  const speedPoints = curvePoints(efforts, 'speed');
  const powerPoints = curvePoints(efforts, 'power');
  const criticalSpeed = fitCapacityModel(speedPoints, 'speed');
  const platformCriticalPower = fitCapacityModel(powerPoints, 'power');

  if (!criticalSpeed) limitations.push('Critical speed needs credible efforts across at least two duration ranges.');
  if (!platformCriticalPower) limitations.push('Platform critical power needs reliable power efforts across at least two duration ranges.');

  const cpHistory = input.criticalPowerHistory ?? [];
  const currentCp = effectiveCriticalPower(cpHistory, asOf);
  const canonicalCriticalPower = selectCanonicalCriticalPower(currentCp, platformCriticalPower, asOf);
  const maxObservedHeartRate = credibleMaxHeartRate(eligible);
  const lt2HeartRate = estimateLt2HeartRate(efforts, criticalSpeed, canonicalCriticalPower?.watts);
  const lt1HeartRate = estimateLt1HeartRate(
    eligible,
    cpHistory,
    criticalSpeed,
    lt2HeartRate,
    asOfMs,
    lookbackDays,
  );

  if (!lt2HeartRate) limitations.push('LT2 heart rate is withheld until sustained near-threshold HR evidence exists.');
  if (!lt1HeartRate) limitations.push('LT1 heart rate is withheld until stable sub-threshold runs exist.');

  const raceEquivalents = criticalSpeed ? buildRaceEquivalents(criticalSpeed) : [];
  const zones = buildPracticalZones(
    criticalSpeed?.estimate,
    canonicalCriticalPower?.watts,
    lt1HeartRate,
    lt2HeartRate,
    maxObservedHeartRate,
  );

  return {
    asOf,
    criticalSpeed,
    platformCriticalPower,
    canonicalCriticalPower,
    lt1HeartRate,
    lt2HeartRate,
    maxObservedHeartRate,
    raceEquivalents,
    zones,
    limitations,
  };
}

function extractEffortPoints(
  activity: CoachActivitySummary,
  asOfMs: number,
  lookbackDays: number,
): EffortPoint[] {
  const streams = activity.streams;
  const time = sanitizeTime(streams?.timeSec);
  if (!time || time.length < 3) return [];

  const distance = buildCumulativeDistance(streams, time);
  const power = alignedSeries(streams?.powerWatts, time.length, usefulPower);
  const heartRate = alignedSeries(streams?.heartRateBpm, time.length, usefulHeartRate);
  const powerIntegral = power ? buildIntegral(time, power, usefulPower) : undefined;
  const hrIntegral = heartRate ? buildIntegral(time, heartRate, usefulHeartRate) : undefined;
  const totalDuration = time[time.length - 1] - time[0];
  const ageDays = Math.max(0, (asOfMs - Date.parse(activity.startDate)) / DAY_MS);
  const recencyWeight = Math.max(0.08, Math.exp(-ageDays / Math.max(45, lookbackDays * 0.32)));
  const sourceWeight = evidenceKindWeight(activity.effortKind ?? 'training');
  const quality = clamp(activity.evidenceQuality ?? inferredEvidenceQuality(activity), 0.25, 1);
  const out: EffortPoint[] = [];

  for (const targetDuration of EFFORT_DURATIONS) {
    if (totalDuration < targetDuration * 0.98) continue;
    const step = Math.max(1, Math.floor(time.length / 450));
    let bestSpeed: EffortPoint | undefined;
    let bestPower: EffortPoint | undefined;

    for (let start = 0; start < time.length - 1; start += step) {
      const end = lowerBound(time, time[start] + targetDuration);
      if (end >= time.length) break;
      const durationSec = time[end] - time[start];
      if (durationSec < targetDuration * 0.98 || durationSec > targetDuration * 1.12) continue;
      const averageHeartRate = hrIntegral
        ? windowAverage(hrIntegral, start, end, durationSec, 0.75)
        : undefined;

      if (distance) {
        const distanceM = distance[end] - distance[start];
        const speed = distanceM / durationSec;
        if (speed >= 1.7 && speed <= 8.5 && (!bestSpeed || speed > (bestSpeed.distanceM ?? 0) / bestSpeed.durationSec)) {
          bestSpeed = {
            activity,
            durationSec,
            distanceM,
            averageHeartRate,
            startSec: time[start],
            endSec: time[end],
            recencyWeight,
            sourceWeight,
            quality,
          };
        }
      }

      if (powerIntegral) {
        const averagePower = windowAverage(powerIntegral, start, end, durationSec, 0.75);
        if (averagePower && (!bestPower || averagePower > (bestPower.averagePower ?? 0))) {
          bestPower = {
            activity,
            durationSec,
            averagePower,
            averageHeartRate,
            startSec: time[start],
            endSec: time[end],
            recencyWeight,
            sourceWeight,
            quality,
          };
        }
      }
    }

    if (bestSpeed) out.push(bestSpeed);
    if (bestPower) out.push(bestPower);
  }
  return out;
}

function curvePoints(efforts: EffortPoint[], kind: 'speed' | 'power'): WeightedPoint[] {
  const byDuration = new Map<number, EffortPoint[]>();
  for (const effort of efforts) {
    if (kind === 'speed' ? !effort.distanceM : !effort.averagePower) continue;
    const key = nearestEffortDuration(effort.durationSec);
    const group = byDuration.get(key) ?? [];
    group.push(effort);
    byDuration.set(key, group);
  }

  const selected: WeightedPoint[] = [];
  for (const [duration, group] of byDuration) {
    const sorted = [...group].sort((a, b) => {
      const av = kind === 'speed' ? (a.distanceM ?? 0) / a.durationSec : a.averagePower ?? 0;
      const bv = kind === 'speed' ? (b.distanceM ?? 0) / b.durationSec : b.averagePower ?? 0;
      // Recency only nudges selection; it must not turn an easy run into a best effort.
      return bv * Math.pow(b.recencyWeight, 0.08) - av * Math.pow(a.recencyWeight, 0.08);
    });
    const bestValue = kind === 'speed'
      ? (sorted[0]?.distanceM ?? 0) / Math.max(1, sorted[0]?.durationSec ?? 1)
      : sorted[0]?.averagePower ?? 0;

    for (const effort of sorted.slice(0, 3)) {
      const value = kind === 'speed'
        ? (effort.distanceM ?? 0) / effort.durationSec
        : effort.averagePower ?? 0;
      if (value < bestValue * 0.93) continue;
      const weight = effort.recencyWeight * effort.sourceWeight * effort.quality;
      selected.push({
        x: effort.durationSec,
        y: kind === 'speed' ? effort.distanceM ?? 0 : (effort.averagePower ?? 0) * effort.durationSec,
        weight,
        evidence: {
          activityId: effort.activity.id,
          activityName: effort.activity.name,
          date: effort.activity.startDate,
          durationSec: duration,
          value: round(kind === 'speed' ? value : effort.averagePower ?? 0, kind === 'speed' ? 3 : 0),
          kind: effort.activity.effortKind ?? 'training',
          weight: round(weight, 3),
          note: kind === 'speed'
            ? `${formatDurationShort(duration)} best segment at ${formatPaceFromSpeed(value)}`
            : `${formatDurationShort(duration)} best segment at ${Math.round(value)} W`,
        },
      });
    }
  }
  return selected;
}

function fitCapacityModel(
  points: WeightedPoint[],
  kind: 'speed' | 'power',
): LinearCapacityEstimate | undefined {
  const buckets = new Set(points.map((point) => durationBucket(point.x)));
  const activities = new Set(points.map((point) => point.evidence.activityId));
  if (points.length < 3 || buckets.size < 2 || activities.size < 2) return undefined;

  let robustWeights = points.map((point) => point.weight);
  let fit = weightedLinearFit(points, robustWeights);
  if (!fit) return undefined;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const residuals = points.map((point) => point.y - (fit!.intercept + fit!.slope * point.x));
    const scale = Math.max(1e-6, median(residuals.map(Math.abs)) * 1.4826);
    robustWeights = points.map((point, index) => {
      const standardized = Math.abs(residuals[index]) / scale;
      const huber = standardized <= 1.5 ? 1 : 1.5 / standardized;
      return point.weight * huber;
    });
    fit = weightedLinearFit(points, robustWeights);
    if (!fit) return undefined;
  }

  const validSlope = kind === 'speed'
    ? fit.slope >= 2 && fit.slope <= 7.5
    : fit.slope >= 80 && fit.slope <= 800;
  const validIntercept = kind === 'speed'
    ? fit.intercept >= 10 && fit.intercept <= 1200
    : fit.intercept >= 500 && fit.intercept <= 80_000;
  if (!validSlope || !validIntercept) return undefined;

  const residuals = points.map((point) => point.y - (fit!.intercept + fit!.slope * point.x));
  const rmse = Math.sqrt(weightedMean(residuals.map((value) => value ** 2), robustWeights) ?? 0);
  const typicalY = median(points.map((point) => point.y));
  const relativeError = typicalY > 0 ? rmse / typicalY : 1;
  const sourceQuality = clamp(weightedMean(points.map((point) => point.weight), points.map(() => 1)) ?? 0, 0, 1);
  const recentEvidence = clamp(weightedMean(points.map((point) => point.weight), points.map(() => 1)) ?? 0, 0, 1);
  const confidenceScore = clamp(
    0.08 + buckets.size * 0.17 + Math.min(activities.size, 5) * 0.055 + sourceQuality * 0.14 + recentEvidence * 0.08 - relativeError * 1.2,
    0.08,
    0.95,
  );
  const uncertainty = clamp(0.025 + relativeError * 1.5 + (3 - Math.min(3, buckets.size)) * 0.04, 0.025, 0.18);
  const label = kind === 'speed' ? 'Critical speed' : 'Platform critical power';

  return {
    estimate: round(fit.slope, kind === 'speed' ? 3 : 0),
    low: round(fit.slope * (1 - uncertainty), kind === 'speed' ? 3 : 0),
    high: round(fit.slope * (1 + uncertainty), kind === 'speed' ? 3 : 0),
    finiteCapacity: round(fit.intercept, kind === 'speed' ? 0 : 0),
    finiteCapacityUnit: kind === 'speed' ? 'm' : 'J',
    fitRmse: round(rmse, kind === 'speed' ? 1 : 0),
    durationBucketsCovered: buckets.size,
    distinctActivities: activities.size,
    confidence: confidenceLevel(confidenceScore),
    confidenceScore: round(confidenceScore, 2),
    evidence: dedupeEvidence(points.map((point) => point.evidence)).slice(0, 12),
    explanation: `${label} uses the transparent ${kind === 'speed' ? "distance = CS × time + D′" : "work = CP × time + W′"} model, robust recency weighting, ${buckets.size}/3 duration ranges, and ${activities.size} distinct activities.`,
  };
}

function selectCanonicalCriticalPower(
  current: CriticalPowerHistoryRecord | undefined,
  platform: LinearCapacityEstimate | undefined,
  asOf: string,
): PhysiologyEstimate['canonicalCriticalPower'] {
  if (current && current.confidence >= 0.45) {
    return {
      watts: current.criticalPowerWatts,
      source: current.source,
      effectiveFrom: current.effectiveFrom,
      confidence: confidenceLevel(current.confidence),
      confidenceScore: round(clamp(current.confidence, 0, 1), 2),
      device: current.device,
      explanation: `The dated ${current.source.replaceAll('_', ' ')} value is canonical; the platform curve remains independent validation.`,
    };
  }
  if (!platform) return undefined;
  return {
    watts: platform.estimate,
    source: 'platform_estimate',
    effectiveFrom: asOf,
    confidence: platform.confidence,
    confidenceScore: platform.confidenceScore,
    explanation: 'No adequately trusted dated device CP was available, so the platform work-duration estimate is used prospectively only.',
  };
}

function estimateLt2HeartRate(
  efforts: EffortPoint[],
  criticalSpeed: LinearCapacityEstimate | undefined,
  criticalPower: number | undefined,
): EstimateBand | undefined {
  const candidates = efforts
    .filter((effort) => effort.durationSec >= 480 && effort.durationSec <= 2400 && usefulHeartRate(effort.averageHeartRate))
    .map((effort) => {
      const speedRatio = criticalSpeed && effort.distanceM
        ? effort.distanceM / effort.durationSec / criticalSpeed.estimate
        : undefined;
      const powerRatio = criticalPower && effort.averagePower ? effort.averagePower / criticalPower : undefined;
      const ratio = powerRatio ?? speedRatio;
      return { effort, ratio };
    })
    .filter((item): item is { effort: EffortPoint; ratio: number } => item.ratio !== undefined && item.ratio >= 0.92 && item.ratio <= 1.06);
  const distinct = new Set(candidates.map(({ effort }) => effort.activity.id));
  if (candidates.length < 2 || distinct.size < 2) return undefined;

  const values = candidates.map(({ effort }) => effort.averageHeartRate as number);
  const weights = candidates.map(({ effort, ratio }) => effort.recencyWeight * effort.sourceWeight * effort.quality * (1 - Math.abs(1 - ratio) * 2));
  const estimate = weightedMedian(values, weights);
  if (!estimate) return undefined;
  const spread = Math.max(2, weightedQuantile(values, weights, 0.75) - weightedQuantile(values, weights, 0.25));
  const confidenceScore = clamp(0.18 + Math.min(distinct.size, 5) * 0.1 + Math.min(candidates.length, 8) * 0.045 + (criticalPower || criticalSpeed ? 0.14 : 0), 0.15, 0.86);
  return {
    estimate: Math.round(estimate),
    low: Math.round(estimate - Math.max(2, spread * 0.6)),
    high: Math.round(estimate + Math.max(2, spread * 0.6)),
    confidence: confidenceLevel(confidenceScore),
    confidenceScore: round(confidenceScore, 2),
    evidence: candidates.slice(0, 10).map(({ effort, ratio }) => ({
      activityId: effort.activity.id,
      activityName: effort.activity.name,
      date: effort.activity.startDate,
      durationSec: effort.durationSec,
      value: Math.round(effort.averageHeartRate as number),
      kind: effort.activity.effortKind ?? 'training',
      weight: round(effort.recencyWeight * effort.sourceWeight * effort.quality, 3),
      note: `${formatDurationShort(effort.durationSec)} sustained at ${Math.round(ratio * 100)}% of the external threshold`,
    })),
    explanation: 'LT2 HR is the robust centre of sustained 8–40 minute sections near CP or critical speed; short peaks and whole-run warm-up averages are excluded.',
  };
}

function estimateLt1HeartRate(
  activities: CoachActivitySummary[],
  cpHistory: CriticalPowerHistoryRecord[],
  criticalSpeed: LinearCapacityEstimate | undefined,
  lt2: EstimateBand | undefined,
  asOfMs: number,
  lookbackDays: number,
): EstimateBand | undefined {
  const samples: Array<{ activity: CoachActivitySummary; hr: number; ratio: number; decoupling: number; weight: number }> = [];
  for (const activity of activities) {
    if (activity.movingTimeSec < 30 * 60) continue;
    const series = sessionSeries(activity);
    const hr = timeWeightedMean(series?.time, series?.heartRate, usefulHeartRate) ?? activity.averageHeartRate;
    if (!usefulHeartRate(hr)) continue;
    const cp = effectiveCriticalPower(cpHistory, activity.startDate)?.criticalPowerWatts;
    const averagePower = timeWeightedMean(series?.time, series?.power, usefulPower) ?? activity.averageWatts;
    const averageSpeed = timeWeightedMean(series?.time, series?.gapSpeed, usefulSpeed)
      ?? activity.averageSpeed
      ?? (activity.distanceKm > 0 ? activity.distanceKm * 1000 / activity.movingTimeSec : undefined);
    const ratio = cp && usefulPower(averagePower)
      ? averagePower / cp
      : criticalSpeed && usefulSpeed(averageSpeed)
        ? averageSpeed / criticalSpeed.estimate
        : undefined;
    if (ratio === undefined || ratio < 0.62 || ratio > 0.9) continue;
    const decoupling = series ? externalHrDecoupling(series.time, series.power ?? series.gapSpeed, series.heartRate) : activity.decouplingPct;
    if (decoupling === undefined || decoupling > 6 || decoupling < -6) continue;
    const ageDays = Math.max(0, (asOfMs - Date.parse(activity.startDate)) / DAY_MS);
    const weight = Math.max(0.08, Math.exp(-ageDays / Math.max(45, lookbackDays * 0.32))) * evidenceKindWeight(activity.effortKind ?? 'training');
    samples.push({ activity, hr, ratio, decoupling, weight });
  }

  if (samples.length >= 3 && new Set(samples.map((sample) => sample.activity.id)).size >= 3) {
    // The upper stable observations inform a boundary; easy-run averages do not define it.
    const boundaryCandidates = [...samples].sort((a, b) => b.ratio - a.ratio).slice(0, Math.max(3, Math.ceil(samples.length * 0.5)));
    const values = boundaryCandidates.map((sample) => sample.hr);
    const weights = boundaryCandidates.map((sample) => sample.weight * clamp(sample.ratio / 0.8, 0.7, 1.1));
    let estimate = weightedQuantile(values, weights, 0.65);
    if (lt2) estimate = Math.min(estimate, lt2.low - 3);
    const spread = Math.max(3, (weightedQuantile(values, weights, 0.8) - weightedQuantile(values, weights, 0.2)) / 2);
    const confidenceScore = clamp(0.18 + Math.min(samples.length, 10) * 0.045 + Math.min(new Set(samples.map((sample) => sample.activity.id)).size, 6) * 0.06, 0.2, 0.78);
    return {
      estimate: Math.round(estimate),
      low: Math.round(estimate - spread),
      high: Math.round(estimate + spread),
      confidence: confidenceLevel(confidenceScore),
      confidenceScore: round(confidenceScore, 2),
      evidence: boundaryCandidates.slice(0, 10).map((sample) => ({
        activityId: sample.activity.id,
        activityName: sample.activity.name,
        date: sample.activity.startDate,
        durationSec: sample.activity.movingTimeSec,
        value: Math.round(sample.hr),
        kind: sample.activity.effortKind ?? 'training',
        weight: round(sample.weight, 3),
        note: `${Math.round(sample.ratio * 100)}% external threshold with ${round(sample.decoupling, 1)}% decoupling`,
      })),
      explanation: 'LT1 HR is inferred from the upper edge of repeated 30+ minute sub-threshold runs with stable external-output-to-HR coupling.',
    };
  }

  if (lt2) {
    const estimate = lt2.estimate * 0.87;
    return {
      estimate: Math.round(estimate),
      low: Math.round(estimate - 5),
      high: Math.round(estimate + 5),
      confidence: 'low',
      confidenceScore: 0.22,
      evidence: [],
      explanation: 'Low-confidence LT1 prior from the LT2 band; it must be replaced by repeated stable aerobic-run evidence and subjective talk-test feedback.',
    };
  }
  return undefined;
}

function buildRaceEquivalents(criticalSpeed: LinearCapacityEstimate): RaceEquivalent[] {
  return ([['5K', 5000], ['10K', 10_000]] as const).flatMap(([label, distanceM]) => {
    const seconds = (distanceM - criticalSpeed.finiteCapacity) / criticalSpeed.estimate;
    if (!Number.isFinite(seconds) || seconds <= 0) return [];
    return [{
      label,
      distanceM,
      predictedSec: Math.round(seconds),
      paceSecPerKm: round(seconds / (distanceM / 1000), 1),
      confidence: criticalSpeed.confidence,
      caveat: 'Mathematical current-capability estimate, not a race prediction; terrain, economy, taper, and maximality still matter.',
    }];
  });
}

function buildPracticalZones(
  criticalSpeed: number | undefined,
  criticalPower: number | undefined,
  lt1: EstimateBand | undefined,
  lt2: EstimateBand | undefined,
  maxHeartRate: number | undefined,
): PracticalZone[] {
  const definitions: Array<{
    name: PracticalZoneName;
    label: string;
    domain: PracticalZone['domain'];
    power: ZoneRange;
    speed: ZoneRange;
    use: string;
    control: string;
  }> = [
    { name: 'recovery', label: 'Recovery', domain: 'moderate', power: { high: 0.7 }, speed: { high: 0.75 }, use: 'Recovery and very easy running', control: 'Breathing/RPE and HR ceiling; allow pace to float.' },
    { name: 'aerobic', label: 'Aerobic', domain: 'moderate', power: { low: 0.7, high: 0.8 }, speed: { low: 0.75, high: 0.85 }, use: 'Aerobic conditioning and long runs', control: 'Aerobic feel and HR/power stability.' },
    { name: 'steady', label: 'Steady', domain: 'heavy', power: { low: 0.8, high: 0.9 }, speed: { low: 0.85, high: 0.92 }, use: 'Controlled steady aerobic development', control: 'Power or GAP first; prevent drift into threshold.' },
    { name: 'threshold', label: 'Threshold', domain: 'heavy', power: { low: 0.9, high: 1 }, speed: { low: 0.92, high: 1 }, use: 'Controlled LT2 work', control: 'Power/pace per repetition; late HR validates, not dictates.' },
    { name: 'vo2_anaerobic', label: 'VO2 / anaerobic', domain: 'severe', power: { low: 1 }, speed: { low: 1 }, use: 'Short VO2, 5K, and anaerobic work', control: 'Power, pace, consistency, and mechanics; do not chase HR.' },
  ];

  return definitions.map((definition, index) => {
    const heartRateBpm = heartRateZone(index, lt1, lt2, maxHeartRate);
    return {
      name: definition.name,
      label: definition.label,
      domain: definition.domain,
      powerPctCp: definition.power,
      speedPctCs: definition.speed,
      powerWatts: criticalPower ? scaleRange(definition.power, criticalPower, 0) : undefined,
      pace: criticalSpeed ? paceRange(definition.speed, criticalSpeed) : undefined,
      heartRateBpm,
      primaryUse: definition.use,
      control: definition.control,
    };
  });
}

function heartRateZone(
  index: number,
  lt1: EstimateBand | undefined,
  lt2: EstimateBand | undefined,
  maxHeartRate: number | undefined,
): ZoneRange | undefined {
  if (!lt1 || !lt2) return undefined;
  if (index === 0) return { high: Math.round(lt1.low - 7) };
  if (index === 1) return { low: Math.round(lt1.low - 7), high: Math.round(lt1.high) };
  if (index === 2) return { low: Math.round(lt1.high), high: Math.round(lt2.low) };
  if (index === 3) return { low: Math.round(lt2.low), high: Math.round(lt2.high) };
  return { low: Math.round(lt2.high), high: maxHeartRate ? Math.round(maxHeartRate) : undefined };
}

export function buildHrCostBaseline(input: HrCostBaselineInput): HrCostBaseline {
  const ordered = input.activities
    .filter(isRunLike)
    .filter((activity) => activity.id !== input.excludeActivityId && validDate(activity.startDate))
    .sort((a, b) => Date.parse(a.startDate) - Date.parse(b.startDate));
  const asOf = input.asOf ?? ordered[ordered.length - 1]?.startDate ?? new Date(0).toISOString();
  const asOfMs = Date.parse(asOf);
  const lookbackDays = clamp(input.lookbackDays ?? 240, 45, 730);
  const samples: Array<{
    activityId: string;
    pctCp: number;
    heartRate: number;
    elapsedHours: number;
    driftBpmPerHour?: number;
    weight: number;
  }> = [];

  for (const activity of ordered) {
    const ageDays = (asOfMs - Date.parse(activity.startDate)) / DAY_MS;
    if (ageDays < 0 || ageDays > lookbackDays || activity.movingTimeSec < 20 * 60) continue;
    const cp = effectiveCriticalPower(input.criticalPowerHistory, activity.startDate);
    if (!cp) continue;
    const series = sessionSeries(activity);
    const power = timeWeightedMean(series?.time, series?.power, usefulPower) ?? activity.averageWatts;
    const heartRate = timeWeightedMean(series?.time, series?.heartRate, usefulHeartRate) ?? activity.averageHeartRate;
    if (!usefulPower(power) || !usefulHeartRate(heartRate)) continue;
    const pctCp = power / cp.criticalPowerWatts;
    if (pctCp < 0.52 || pctCp > 1.08) continue;
    const durationHours = activity.movingTimeSec / 3600;
    const drift = series ? heartRateDriftBpmPerHour(series.time, series.heartRate, series.power) : undefined;
    samples.push({
      activityId: activity.id,
      pctCp,
      heartRate,
      elapsedHours: durationHours / 2,
      driftBpmPerHour: drift,
      weight: Math.max(0.08, Math.exp(-ageDays / Math.max(45, lookbackDays * 0.36)))
        * clamp(cp.confidence, 0.25, 1)
        * evidenceKindWeight(activity.effortKind ?? 'training'),
    });
  }

  const binSamples = new Map<number, typeof samples>();
  for (const sample of samples) {
    const key = Math.round(sample.pctCp * 20) / 20;
    const group = binSamples.get(key) ?? [];
    group.push(sample);
    binSamples.set(key, group);
  }
  const bins: HrCostBin[] = [...binSamples.entries()]
    .filter(([, group]) => group.length >= 2)
    .sort(([a], [b]) => a - b)
    .map(([centre, group]) => {
      const values = group.map((sample) => sample.heartRate);
      const weights = group.map((sample) => sample.weight);
      const q25 = weightedQuantile(values, weights, 0.25);
      const q75 = weightedQuantile(values, weights, 0.75);
      return {
        lowPctCp: round(centre - 0.025, 3),
        highPctCp: round(centre + 0.025, 3),
        expectedHeartRate: round(weightedMedian(values, weights) ?? median(values), 1),
        typicalSpreadBpm: round(Math.max(3, q75 - q25), 1),
        medianElapsedHours: round(weightedMedian(group.map((sample) => sample.elapsedHours), weights) ?? median(group.map((sample) => sample.elapsedHours)), 2),
        sampleCount: group.length,
      };
    });
  const driftSamples = samples.filter((sample) => sample.driftBpmPerHour !== undefined);
  const typicalDriftBpmPerHour = weightedMedian(
    driftSamples.map((sample) => sample.driftBpmPerHour as number),
    driftSamples.map((sample) => sample.weight),
  ) ?? 0;
  const confidenceScore = clamp(0.08 + Math.min(samples.length, 20) * 0.025 + Math.min(bins.length, 6) * 0.075, 0.08, 0.9);

  return {
    asOf,
    bins,
    typicalDriftBpmPerHour: round(typicalDriftBpmPerHour, 1),
    confidence: confidenceLevel(confidenceScore),
    confidenceScore: round(confidenceScore, 2),
    activityIds: [...new Set(samples.map((sample) => sample.activityId))],
    explanation: bins.length
      ? 'Expected chest-strap HR is learned in 5%-of-CP bins from prior runs, with elapsed-time drift adjustment. It is an internal-cost baseline, not a second load score.'
      : 'Insufficient dated CP plus chest-strap power/HR pairs to establish a personal HR-cost baseline.',
  };
}

export function scoreLydiardSession(input: SessionScoringInput): SessionStressAssessment {
  const { activity } = input;
  const warnings: string[] = [];
  const series = sessionSeries(activity);
  const durationSec = series && series.time.length > 1
    ? series.time[series.time.length - 1] - series.time[0]
    : activity.movingTimeSec;
  const cp = effectiveCriticalPower(input.criticalPowerHistory, activity.startDate);
  const powerCoverage = series ? seriesCoverage(series.time, series.power, usefulPower) : 0;
  const hrCoverage = series ? seriesCoverage(series.time, series.heartRate, usefulHeartRate) : 0;
  const speedCoverage = series ? seriesCoverage(series.time, series.gapSpeed ?? series.paceSpeed, usefulSpeed) : 0;
  let lydiardPowerStress: number | undefined;
  let hardPowerStress: number | undefined;
  let averagePowerWatts: number | undefined;
  let averagePctCp: number | undefined;
  let weightedPowerWatts: number | undefined;
  let weightedPctCp: number | undefined;
  let powerZoneTime: ZoneTime[] = [];
  let peaks: PowerPeak[] = POWER_PEAK_DURATIONS.map((duration) => ({ durationSec: duration }));
  let latePowerChangePct: number | undefined;
  let powerHrDecouplingPct: number | undefined;
  let externalStress: ExternalStressResult;

  if (series?.power && cp && powerCoverage >= 0.6) {
    const powerStress = scorePowerSeries(series.time, series.power, cp.criticalPowerWatts);
    lydiardPowerStress = powerStress.total;
    hardPowerStress = powerStress.hard;
    averagePowerWatts = powerStress.averagePower;
    averagePctCp = powerStress.averagePower / cp.criticalPowerWatts;
    weightedPowerWatts = weightedPower(series.time, series.power);
    weightedPctCp = weightedPowerWatts ? weightedPowerWatts / cp.criticalPowerWatts : undefined;
    powerZoneTime = powerStress.zoneTime;
    peaks = POWER_PEAK_DURATIONS.map((peakDuration) => {
      const watts = bestRollingAverage(series.time, series.power as number[], peakDuration, usefulPower);
      return {
        durationSec: peakDuration,
        watts: watts ? Math.round(watts) : undefined,
        pctCp: watts ? round(watts / cp.criticalPowerWatts, 3) : undefined,
      };
    });
    latePowerChangePct = lateChangePercent(series.time, series.power, usefulPower);
    powerHrDecouplingPct = externalHrDecoupling(series.time, series.power, series.heartRate);
    externalStress = {
      source: 'power',
      totalStress: round(powerStress.total, 1),
      hardStress: round(powerStress.hard, 1),
      intensityFactor: round(weightedPctCp ?? averagePctCp, 3),
      reliability: powerCoverage >= 0.9 ? 'high' : 'medium',
      explanation: `External load is exclusively Lydiard Power Stress using the ${cp.source.replaceAll('_', ' ')} CP effective on ${cp.effectiveFrom.slice(0, 10)}. GAP is validation, not an added load.`,
    };
  } else {
    if (!cp && powerCoverage >= 0.6) warnings.push('Power stream exists, but no CP record was effective on the activity date; historical power was not rescored against a newer CP.');
    if (cp && powerCoverage > 0 && powerCoverage < 0.6) warnings.push('Power coverage was below 60%, so power was rejected as the load anchor.');
    externalStress = scorePaceFallback(activity, series, input.physiology);
  }

  if (series?.power && powerCoverage > 0 && !averagePowerWatts) {
    averagePowerWatts = timeWeightedMean(series.time, series.power, usefulPower);
    averagePctCp = averagePowerWatts && cp ? averagePowerWatts / cp.criticalPowerWatts : undefined;
  }
  const observedHeartRate = series
    ? timeWeightedMean(series.time, series.heartRate, usefulHeartRate)
    : activity.averageHeartRate;
  const heartRateCost = evaluateHeartRateCost(
    observedHeartRate,
    averagePctCp,
    durationSec,
    input.hrCostBaseline,
  );
  if (heartRateCost.status === 'very_elevated') warnings.push('Chest-strap HR cost was very elevated for the external power.');
  if (latePowerChangePct !== undefined && latePowerChangePct <= -6) warnings.push('Late-run power deteriorated by at least 6%.');
  if (powerHrDecouplingPct !== undefined && powerHrDecouplingPct >= 7) warnings.push('Power-to-HR coupling deteriorated by at least 7%.');

  return {
    activityId: activity.id,
    activityDate: activity.startDate,
    durationSec: Math.round(durationSec),
    effectiveCriticalPower: cp,
    externalStress,
    lydiardPowerStress: roundOptional(lydiardPowerStress, 1),
    hardPowerStress: roundOptional(hardPowerStress, 1),
    averagePowerWatts: roundOptional(averagePowerWatts, 0),
    averagePctCp: roundOptional(averagePctCp, 3),
    weightedPowerWatts: roundOptional(weightedPowerWatts, 0),
    weightedPctCp: roundOptional(weightedPctCp, 3),
    powerZoneTime,
    peaks,
    latePowerChangePct: roundOptional(latePowerChangePct, 1),
    powerHrDecouplingPct: roundOptional(powerHrDecouplingPct, 1),
    heartRateCost,
    dataCoverage: {
      power: round(powerCoverage, 2),
      heartRate: round(hrCoverage, 2),
      speed: round(speedCoverage, 2),
    },
    warnings,
  };
}

function scorePowerSeries(time: number[], power: number[], cp: number): {
  total: number;
  hard: number;
  averagePower: number;
  zoneTime: ZoneTime[];
} {
  let stress = 0;
  let hard = 0;
  let energy = 0;
  let validSec = 0;
  const zoneSeconds = [0, 0, 0, 0, 0];
  for (let index = 0; index < time.length - 1; index += 1) {
    const dt = intervalDuration(time[index], time[index + 1]);
    const watts = power[index];
    if (!dt || !usefulPower(watts)) continue;
    const ratio = watts / cp;
    const secondStress = 100 / 3600 * ratio ** 2 * dt;
    stress += secondStress;
    if (ratio >= 0.9) hard += secondStress;
    energy += watts * dt;
    validSec += dt;
    zoneSeconds[powerZoneIndex(ratio)] += dt;
  }
  const names: PracticalZoneName[] = ['recovery', 'aerobic', 'steady', 'threshold', 'vo2_anaerobic'];
  return {
    total: stress,
    hard,
    averagePower: validSec > 0 ? energy / validSec : 0,
    zoneTime: names.map((zone, index) => ({
      zone,
      seconds: Math.round(zoneSeconds[index]),
      percent: round(validSec > 0 ? zoneSeconds[index] / validSec * 100 : 0, 1),
    })),
  };
}

function scorePaceFallback(
  activity: CoachActivitySummary,
  series: ReturnType<typeof sessionSeries>,
  physiology: PhysiologyEstimate | undefined,
): ExternalStressResult {
  const criticalSpeed = physiology?.criticalSpeed?.estimate;
  if (!criticalSpeed) {
    return {
      source: 'unavailable',
      reliability: 'low',
      explanation: 'Neither a valid dated CP/power stream nor a critical-speed fallback was available.',
    };
  }
  if (series) {
    const speed = series.gapSpeed ?? series.paceSpeed;
    const coverage = seriesCoverage(series.time, speed, usefulSpeed);
    if (speed && coverage >= 0.6) {
      let stress = 0;
      let hardStress = 0;
      let ratioTime = 0;
      let validSec = 0;
      for (let index = 0; index < series.time.length - 1; index += 1) {
        const dt = intervalDuration(series.time[index], series.time[index + 1]);
        const value = speed[index];
        if (!dt || !usefulSpeed(value)) continue;
        const ratio = value / criticalSpeed;
        const secondStress = 100 / 3600 * ratio ** 2 * dt;
        stress += secondStress;
        if (ratio >= 0.92) hardStress += secondStress;
        ratioTime += ratio * dt;
        validSec += dt;
      }
      return {
        source: series.gapSpeed ? 'gap' : 'pace',
        totalStress: round(stress, 1),
        hardStress: round(hardStress, 1),
        intensityFactor: round(validSec > 0 ? ratioTime / validSec : 0, 3),
        reliability: series.gapSpeed && coverage >= 0.85 ? 'medium' : 'low',
        explanation: `${series.gapSpeed ? 'Grade-adjusted pace' : 'Raw pace'} is the sole external-load fallback because valid Stryd power plus dated CP was unavailable; it is not blended with HR.`,
      };
    }
  }
  const speed = activity.averageSpeed
    ?? (activity.distanceKm > 0 && activity.movingTimeSec > 0 ? activity.distanceKm * 1000 / activity.movingTimeSec : undefined);
  if (!usefulSpeed(speed)) {
    return { source: 'unavailable', reliability: 'low', explanation: 'No usable external-output stream or summary speed was available.' };
  }
  const ratio = speed / criticalSpeed;
  const stress = 100 * activity.movingTimeSec / 3600 * ratio ** 2;
  return {
    source: 'pace',
    totalStress: round(stress, 1),
    hardStress: ratio >= 0.92 ? round(stress, 1) : 0,
    intensityFactor: round(ratio, 3),
    reliability: 'low',
    explanation: 'Whole-run average pace is the sole low-confidence fallback; elevation and variable work cannot be resolved without streams.',
  };
}

function evaluateHeartRateCost(
  observed: number | undefined,
  pctCp: number | undefined,
  durationSec: number,
  baseline: HrCostBaseline | undefined,
): HrCostResult {
  if (!usefulHeartRate(observed) || pctCp === undefined || !baseline || baseline.bins.length === 0 || durationSec < 8 * 60) {
    return {
      observedHeartRate: usefulHeartRate(observed) ? round(observed, 1) : undefined,
      status: 'inconclusive',
      confidence: 'low',
      explanation: durationSec < 8 * 60
        ? 'The session is too short for HR to stabilise; power/pace should control it.'
        : 'A valid observed HR, %CP, and personal HR-cost baseline are all required.',
    };
  }
  const neighbours = [...baseline.bins].sort((a, b) => {
    const ac = (a.lowPctCp + a.highPctCp) / 2;
    const bc = (b.lowPctCp + b.highPctCp) / 2;
    return Math.abs(ac - pctCp) - Math.abs(bc - pctCp);
  }).slice(0, 2);
  const expectedBase = interpolateBins(neighbours, pctCp, (bin) => bin.expectedHeartRate);
  const baselineElapsed = interpolateBins(neighbours, pctCp, (bin) => bin.medianElapsedHours);
  const spread = Math.max(3, interpolateBins(neighbours, pctCp, (bin) => bin.typicalSpreadBpm));
  const expected = expectedBase + baseline.typicalDriftBpmPerHour * (durationSec / 7200 - baselineElapsed);
  const residual = observed - expected;
  const status: HrCostResult['status'] = residual >= Math.max(7, spread * 1.5)
    ? 'very_elevated'
    : residual >= Math.max(4, spread * 0.8)
      ? 'elevated'
      : residual <= -Math.max(4, spread)
        ? 'lower_than_normal'
        : 'normal';
  return {
    observedHeartRate: round(observed, 1),
    expectedHeartRate: round(expected, 1),
    residualBpm: round(residual, 1),
    status,
    confidence: baseline.confidence,
    explanation: `Observed chest-strap HR is ${round(Math.abs(residual), 1)} bpm ${residual >= 0 ? 'above' : 'below'} the personal expectation for ${Math.round(pctCp * 100)}% CP and elapsed time. This changes cost interpretation, not external load.`,
  };
}

interface PlanningReadiness {
  state: LydiardWeekPlan['currentState'];
  explanation: string;
  reasons: string[];
  painConcern: boolean;
  absorbedWeeks: number;
  stressRatio?: number;
}

interface DayTemplate {
  dayIndex: number;
  type: PlannedSessionType;
  title: string;
  weight: number;
  priority: PlannedSession['priority'];
}

export function buildLydiardWeek(input: PlanningStateInput): LydiardWeekPlan {
  const weekStart = normalizeWeekStart(input.weekStart);
  const readiness = assessPlanningReadiness(input);
  const phase = readiness.state === 'red' ? 'recovery_regeneration' : input.profile.currentPhase;
  const phaseOverrideReason = readiness.state === 'red' && input.profile.currentPhase !== 'recovery_regeneration'
    ? 'Red symptoms or response evidence override performance progression until normal gait, health, and energy return.'
    : undefined;
  const targetMinutes = targetWeeklyMinutes(input, readiness, phase);
  const qualityCap = readiness.state === 'red'
    ? 0
    : readiness.state === 'amber'
      ? Math.min(1, input.profile.maxQualitySessions ?? 2)
      : Math.min(2, input.profile.maxQualitySessions ?? 2);
  const canUseSteady = input.profile.allowControlledSteadyInBase === true && readiness.absorbedWeeks >= 2 && readiness.state === 'green';
  const templates = weeklyTemplates(phase, qualityCap, canUseSteady);
  const selectedTemplates = selectRunDays(templates, clamp(Math.round(input.profile.runningDaysPerWeek), 3, 7));
  const durations = allocateRunDurations(selectedTemplates, targetMinutes, input.profile.longRunToleranceMinutes);
  const days: PlannedDay[] = Array.from({ length: 7 }, (_, dayIndex) => ({
    date: addDays(weekStart, dayIndex),
    sessions: [],
  }));
  const physiology = input.physiology;

  for (const template of selectedTemplates) {
    const duration = durations.get(template.dayIndex) ?? 0;
    const session = makePlannedRun(
      `${weekStart}-${template.dayIndex}-run`,
      days[template.dayIndex].date,
      template,
      duration,
      phase,
      physiology,
      input.profile,
      readiness,
    );
    days[template.dayIndex].sessions.push(session);
  }

  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    if (!days[dayIndex].sessions.some((session) => session.targetDurationMin > 0)) {
      days[dayIndex].sessions.push(makeRestSession(`${weekStart}-${dayIndex}-rest`, days[dayIndex].date, phase, readiness));
    }
  }

  const strengthCount = readiness.state === 'red'
    ? 0
    : readiness.painConcern
      ? Math.min(1, input.profile.strengthSessionsPerWeek)
      : clamp(Math.round(input.profile.strengthSessionsPerWeek), 0, 2);
  const strengthDays = strengthCount === 1 ? [1] : strengthCount === 2 ? [1, 4] : [];
  for (const dayIndex of strengthDays) {
    days[dayIndex].sessions.push(makeStrengthSession(`${weekStart}-${dayIndex}-strength`, days[dayIndex].date, phase, readiness));
  }

  const runSessions = days.flatMap((day) => day.sessions).filter(isRunningPlanSession);
  const totalRunningMinutes = runSessions.reduce((total, session) => total + session.targetDurationMin, 0);
  const longRunMinutes = runSessions.find((session) => session.sessionType === 'long_aerobic')?.targetDurationMin ?? 0;
  const approximateDistanceKm = approximateWeeklyDistance(totalRunningMinutes, input.profile, physiology);
  const qualitySessionCount = runSessions.filter(isConsequentialQuality).length;
  const decisions = buildPlanDecisions(input, readiness, phase, targetMinutes, qualitySessionCount);

  return {
    weekStart,
    status: 'proposed',
    currentState: readiness.state,
    currentStateExplanation: readiness.explanation,
    phase,
    phaseOverrideReason,
    goalPriority: goalPriority(input.profile, physiology),
    objective: phaseObjective(phase, readiness.state),
    days,
    totalRunningMinutes,
    approximateDistanceKm,
    qualitySessionCount,
    longRunMinutes,
    strengthSessionCount: strengthCount,
    intensityGuidance: weeklyIntensityGuidance(physiology),
    deliberatelyAbsent: deliberatelyAbsent(phase, readiness),
    adaptationTriggers: defaultAdaptationTriggers(),
    nextDecisionPoint: `Review after the long run or immediately after any red trigger; otherwise reassess on ${addDays(weekStart, 7)} before progressing.`,
    decisions,
  };
}

/**
 * Build a coherent one-to-three-week horizon. Later weeks carry forward the
 * preceding proposal's duration, stress shape, long run, and load-cycle
 * position, but they are explicitly contingent: an uncompleted proposed week
 * is never treated as absorbed evidence.
 */
export function buildLydiardBlock(input: BlockPlanningInput): LydiardBlockPlan {
  const startWeek = normalizeWeekStart(input.weekStart);
  const weekCount = clamp(Math.round(input.weekCount), 1, 3) as 1 | 2 | 3;
  const baseCycle = input.profile.weekInLoadCycle ?? 1;
  const recentWeeks = [...input.recentWeeks];
  const weeks: LydiardBlockPlan['weeks'] = [];
  const recentStressPerMinute = mean(
    input.recentWeeks
      .filter((week) => week.runningMinutes > 0 && week.stress > 0)
      .slice(-4)
      .map((week) => week.stress / week.runningMinutes),
  ) || 1;
  const recentHardShare = mean(
    input.recentWeeks
      .filter((week) => week.stress > 0)
      .slice(-4)
      .map((week) => week.hardStress / week.stress),
  ) || 0;

  for (let index = 0; index < weekCount; index += 1) {
    const weekStart = addDays(startWeek, index * 7);
    const weekInLoadCycle = (((baseCycle - 1 + index) % 3) + 1) as 1 | 2 | 3;
    const plan = buildLydiardWeek({
      ...input,
      weekStart,
      recentWeeks,
      profile: { ...input.profile, weekInLoadCycle },
    });
    const contingent = index > 0;
    const continuationConditions = contingent
      ? [
          'Proceed only if the preceding week is absorbed without escalating pain or altered gait.',
          'Keep the planned intensity only if HR cost and late-run durability return to the personal normal range.',
          'If an amber or red trigger appears, use the accepted post-run patch instead of making up missed work.',
        ]
      : ['This week is based on currently observed evidence and still changes if a red trigger appears.'];
    weeks.push({ ...plan, blockWeek: index + 1, contingent, continuationConditions });

    // Carry the proposed dose forward so later weeks are structurally coherent,
    // but mark it unabsorbed. This prevents an uncompleted future week from
    // manufacturing evidence for another progression.
    recentWeeks.push({
      weekStart,
      runningMinutes: plan.totalRunningMinutes,
      distanceKm: midpoint(plan.approximateDistanceKm) ?? 0,
      stress: round(plan.totalRunningMinutes * recentStressPerMinute, 1),
      hardStress: round(
        plan.totalRunningMinutes * recentStressPerMinute *
          (plan.qualitySessionCount > 0 ? Math.max(recentHardShare, 0.08) : 0),
        1,
      ),
      longRunMinutes: plan.longRunMinutes,
      absorbed: false,
    });
  }

  const distanceLows = weeks.map((week) => week.approximateDistanceKm?.low).filter(isFiniteNumber);
  const distanceHighs = weeks.map((week) => week.approximateDistanceKm?.high).filter(isFiniteNumber);
  return {
    startWeek,
    weekCount,
    status: 'proposed',
    phase: weeks[0]?.phase ?? input.profile.currentPhase,
    weeks,
    totalRunningMinutes: sum(weeks.map((week) => week.totalRunningMinutes)),
    approximateDistanceKm:
      distanceLows.length && distanceHighs.length
        ? { low: round(sum(distanceLows), 1), high: round(sum(distanceHighs), 1) }
        : undefined,
    nextDecisionPoint: weeks[0]?.nextDecisionPoint ?? `Review before ${addDays(startWeek, 7)}.`,
    explanation:
      'Later weeks are provisional continuations, not promises. Each carries the prior proposed dose forward without treating it as absorbed, and post-run decisions patch only affected future sessions.',
  };
}

function assessPlanningReadiness(input: PlanningStateInput): PlanningReadiness {
  const feedback = [...input.recentFeedback].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, 7);
  const maxPain = feedback.reduce((maximum, item) => Math.max(maximum, item.painDuring ?? 0, item.painAfter ?? 0), 0);
  const alteredGait = feedback.some((item) => item.alteredGait);
  const illness = feedback.some((item) => item.illnessSuspected);
  const deadLegs = feedback.some((item) => item.legs === 'dead');
  const poorEnergy = feedback.filter((item) => item.energy === 'poor').length;
  const elevatedHrRuns = input.recentSessions.slice(-4).filter((session) =>
    session.heartRateCost.status === 'elevated' || session.heartRateCost.status === 'very_elevated',
  ).length;
  const deterioratingRuns = input.recentSessions.slice(-4).filter((session) =>
    (session.latePowerChangePct ?? 0) <= -6 || (session.powerHrDecouplingPct ?? 0) >= 7,
  ).length;
  const stressRatio = input.sevenDayStress !== undefined && input.fortyTwoDayStress && input.fortyTwoDayStress > 0
    ? input.sevenDayStress / input.fortyTwoDayStress
    : undefined;
  const absorbedWeeks = [...input.recentWeeks].reverse().findIndex((week) => !week.absorbed);
  const consecutiveAbsorbed = absorbedWeeks === -1 ? input.recentWeeks.length : absorbedWeeks;
  const recentExcessive = input.recentSessions.slice(-3).filter((session) =>
    session.heartRateCost.status === 'very_elevated' && ((session.latePowerChangePct ?? 0) <= -6),
  ).length;

  const redReasons: string[] = [];
  if (alteredGait) redReasons.push('pain altered gait');
  if (maxPain >= 5) redReasons.push(`pain reached ${maxPain}/10`);
  if (illness) redReasons.push('illness is suspected');
  if (recentExcessive >= 2) redReasons.push('two recent runs combined very high HR cost with late deterioration');
  if (redReasons.length > 0) {
    return {
      state: 'red',
      explanation: `Recovery takes priority because ${redReasons.join(', ')}. No fitness target overrides these signals.`,
      reasons: redReasons,
      painConcern: maxPain > 0 || alteredGait,
      absorbedWeeks: consecutiveAbsorbed,
      stressRatio,
    };
  }

  const amberReasons: string[] = [];
  if (maxPain >= 3) amberReasons.push(`pain reached ${maxPain}/10`);
  if (deadLegs || poorEnergy >= 2) amberReasons.push('subjective recovery is poor');
  if (elevatedHrRuns >= 2) amberReasons.push('HR cost was elevated on multiple recent runs');
  if (deterioratingRuns >= 2) amberReasons.push('late-run durability deteriorated repeatedly');
  if (stressRatio !== undefined && stressRatio > 1.3) amberReasons.push(`7-day/42-day stress ratio is ${round(stressRatio, 2)}`);
  if (input.recentWeeks.slice(-2).some((week) => week.emergencyReduction)) amberReasons.push('a recent week needed emergency reduction');
  if (amberReasons.length > 0) {
    return {
      state: 'amber',
      explanation: `Training can continue conservatively, but ${amberReasons.join(', ')}. Intensity and duration are constrained.`,
      reasons: amberReasons,
      painConcern: maxPain > 0,
      absorbedWeeks: consecutiveAbsorbed,
      stressRatio,
    };
  }
  return {
    state: 'green',
    explanation: consecutiveAbsorbed >= 2
      ? 'Recent work is being absorbed with no red or amber response signal; only one training dimension may progress.'
      : 'No acute warning is present, but repeated absorption has not yet been demonstrated, so load is held rather than increased.',
    reasons: [],
    painConcern: maxPain > 0,
    absorbedWeeks: consecutiveAbsorbed,
    stressRatio,
  };
}

function targetWeeklyMinutes(
  input: PlanningStateInput,
  readiness: PlanningReadiness,
  phase: LydiardPhase,
): number {
  const recent = input.recentWeeks.slice(-4).filter((week) => week.runningMinutes > 0);
  const recentAverage = recent.length ? mean(recent.map((week) => week.runningMinutes)) : input.profile.sustainableWeeklyMinutes;
  const latest = recent[recent.length - 1]?.runningMinutes ?? recentAverage;
  const stableBase = Math.min(Math.max(latest, recentAverage * 0.9), Math.max(input.profile.sustainableWeeklyMinutes, latest));
  const maximum = input.profile.maximumWeeklyMinutes ?? input.profile.sustainableWeeklyMinutes * 1.15;
  let factor = 1;
  if (readiness.state === 'red') factor = 0.58;
  else if (readiness.state === 'amber') factor = 0.86;
  else if (input.profile.weekInLoadCycle === 3) factor = 0.85;
  else if (readiness.absorbedWeeks >= 2) factor = 1.04;
  if (phase === 'coordination') factor = Math.min(factor, 0.82);
  if (phase === 'recovery_regeneration') factor = Math.min(factor, 0.65);
  return Math.max(90, roundToFive(Math.min(maximum, stableBase * factor)));
}

function weeklyTemplates(
  phase: LydiardPhase,
  qualityCap: number,
  canUseSteady: boolean,
): DayTemplate[] {
  const base: DayTemplate[] = [
    { dayIndex: 0, type: 'recovery', title: 'Recovery run', weight: 0.1, priority: 'optional' },
    { dayIndex: 1, type: 'aerobic', title: 'Aerobic run + relaxed strides', weight: 0.15, priority: 'supporting' },
    { dayIndex: 2, type: 'medium_long', title: 'Medium-long aerobic run', weight: 0.18, priority: 'supporting' },
    { dayIndex: 3, type: 'recovery', title: 'Short recovery run', weight: 0.09, priority: 'optional' },
    { dayIndex: 4, type: 'aerobic', title: 'Aerobic run + relaxed strides', weight: 0.14, priority: 'supporting' },
    { dayIndex: 5, type: 'aerobic', title: 'Easy aerobic run', weight: 0.12, priority: 'supporting' },
    { dayIndex: 6, type: 'long_aerobic', title: 'Long aerobic run', weight: 0.22, priority: 'key' },
  ];
  if (phase === 'recovery_regeneration') {
    return base.map((template) => ({
      ...template,
      type: template.type === 'long_aerobic' ? 'aerobic' : 'recovery',
      title: template.type === 'long_aerobic' ? 'Short aerobic run' : 'Recovery run',
      priority: template.type === 'long_aerobic' ? 'supporting' : 'optional',
    }));
  }
  if (phase === 'aerobic_conditioning' && canUseSteady && qualityCap >= 1) {
    base[4] = { ...base[4], type: 'steady', title: 'Controlled steady aerobic run', priority: 'key' };
  }
  if (phase === 'hill_resistance' && qualityCap >= 1) {
    base[1] = { ...base[1], type: 'hill_circuit', title: 'Lydiard hill resistance circuit', priority: 'key' };
  }
  if (phase === 'anaerobic_development' && qualityCap >= 1) {
    base[1] = { ...base[1], type: 'threshold', title: 'Controlled threshold intervals', priority: 'key' };
    if (qualityCap >= 2) base[4] = { ...base[4], type: 'vo2', title: '5K-specific repetitions', priority: 'key' };
  }
  if (phase === 'coordination' && qualityCap >= 1) {
    base[1] = { ...base[1], type: 'race_specific', title: 'Race-pace coordination', priority: 'key' };
    if (qualityCap >= 2) base[4] = { ...base[4], type: 'coordination', title: 'Sharpening repetitions', priority: 'key' };
  }
  return base;
}

function selectRunDays(templates: DayTemplate[], requestedDays: number): DayTemplate[] {
  const removeOrder = [0, 3, 5, 2];
  const removed = new Set<number>();
  for (const day of removeOrder) {
    if (templates.length - removed.size <= requestedDays) break;
    removed.add(day);
  }
  return templates.filter((template) => !removed.has(template.dayIndex));
}

function allocateRunDurations(
  templates: DayTemplate[],
  targetMinutes: number,
  longRunTolerance: number,
): Map<number, number> {
  const weights = sum(templates.map((template) => template.weight));
  const result = new Map<number, number>();
  for (const template of templates) {
    let duration = targetMinutes * template.weight / weights;
    if (template.type === 'long_aerobic') duration = Math.min(duration, longRunTolerance, targetMinutes * 0.3);
    result.set(template.dayIndex, roundToFive(Math.max(20, duration)));
  }
  let difference = targetMinutes - sum([...result.values()]);
  const adjustable = templates.filter((template) => template.type !== 'long_aerobic').sort((a, b) => b.weight - a.weight);
  let cursor = 0;
  while (Math.abs(difference) >= 5 && adjustable.length > 0 && cursor < 100) {
    const template = adjustable[cursor % adjustable.length];
    const current = result.get(template.dayIndex) ?? 20;
    const change = difference > 0 ? 5 : current > 25 ? -5 : 0;
    if (change !== 0) {
      result.set(template.dayIndex, current + change);
      difference -= change;
    }
    cursor += 1;
  }
  return result;
}

function makePlannedRun(
  id: string,
  date: string,
  template: DayTemplate,
  durationMin: number,
  phase: LydiardPhase,
  physiology: PhysiologyEstimate | undefined,
  profile: CoachProfile,
  readiness: PlanningReadiness,
): PlannedSession {
  const baseTarget = intensityTargetFor(template.type, physiology);
  const goalPace = template.type === 'race_specific' || template.type === 'coordination'
    ? guardedGoalPace(profile, physiology)
    : undefined;
  const target: IntensityTarget = goalPace
    ? {
        ...baseTarget,
        gapPace: { fastSecPerKm: goalPace * 0.99, slowSecPerKm: goalPace * 1.01 },
        guidance: 'Use the goal-event rhythm only inside the prescribed repetitions; current race-equivalent evidence caps the target when needed.',
      }
    : baseTarget;
  const paceForDistance = representativePace(baseTarget.gapPace, profile.recentEasyPaceSecPerKm);
  const distance = paceForDistance ? durationMin * 60 / paceForDistance : undefined;
  return {
    id,
    plannedDate: date,
    title: template.title,
    sessionType: template.type,
    phase,
    priority: template.priority,
    targetDurationMin: durationMin,
    approximateDistanceKm: distance ? { low: round(distance * 0.92, 1), high: round(distance * 1.08, 1) } : undefined,
    target,
    structure: structureFor(template.type, durationMin, target, physiology, profile),
    purpose: purposeFor(template.type),
    fallbackPlan: fallbackFor(template.type, durationMin, readiness),
    coachReasoning: reasoningFor(template.type, phase, readiness),
    status: 'proposed',
  };
}

function makeRestSession(id: string, date: string, phase: LydiardPhase, readiness: PlanningReadiness): PlannedSession {
  return {
    id,
    plannedDate: date,
    title: readiness.state === 'red' ? 'Recovery / symptom check' : 'Rest or gentle mobility',
    sessionType: 'rest',
    phase,
    priority: 'supporting',
    targetDurationMin: 0,
    target: { primaryControl: 'recovery', guidance: 'No compensatory mileage. Resume only if normal walking and daily movement are comfortable.' },
    structure: [],
    purpose: 'Absorb training and restore normal mechanics and energy.',
    fallbackPlan: 'Rest fully.',
    coachReasoning: 'Recovery is a planned part of the training stimulus.',
    status: 'proposed',
  };
}

function makeStrengthSession(id: string, date: string, phase: LydiardPhase, readiness: PlanningReadiness): PlannedSession {
  return {
    id,
    plannedDate: date,
    title: 'Strength and durability',
    sessionType: 'strength',
    phase,
    priority: 'supporting',
    targetDurationMin: 35,
    target: { primaryControl: 'form_power', rpe: { low: 6, high: 8 }, guidance: 'Keep 2–3 reps in reserve; no grinding and no pain-altered movement.' },
    structure: [{ kind: 'continuous', durationMin: 35, note: 'Posterior chain, single-leg control, calf/soleus, and trunk. Preserve original set notes separately.' }],
    purpose: 'Build mechanical tolerance without counting gym work as running stress.',
    fallbackPlan: readiness.painConcern ? 'Use pain-free rehab/isometric work only and seek assessment if symptoms worsen.' : 'Reduce load and sets before compromising movement quality.',
    coachReasoning: 'Strength is consolidated with a training day so recovery days remain genuinely easy.',
    status: 'proposed',
  };
}

function intensityTargetFor(type: PlannedSessionType, physiology: PhysiologyEstimate | undefined): IntensityTarget {
  const ranges: Partial<Record<PlannedSessionType, ZoneRange>> = {
    recovery: { low: 0.58, high: 0.7 }, aerobic: { low: 0.7, high: 0.8 }, medium_long: { low: 0.72, high: 0.81 },
    long_aerobic: { low: 0.7, high: 0.8 }, steady: { low: 0.8, high: 0.89 }, hill_sprints: { low: 1.05, high: 1.25 },
    hill_circuit: { low: 0.88, high: 1.02 }, threshold: { low: 0.92, high: 1 }, vo2: { low: 1.03, high: 1.14 },
    race_specific: { low: 0.98, high: 1.08 }, coordination: { low: 1, high: 1.12 }, strides: { low: 1.05, high: 1.25 },
  };
  const pct = ranges[type];
  const cp = physiology?.canonicalCriticalPower?.watts;
  const cs = physiology?.criticalSpeed?.estimate;
  const zone = zoneForSessionType(type, physiology?.zones ?? []);
  const primaryControl: IntensityTarget['primaryControl'] =
    type === 'recovery' || type === 'aerobic' || type === 'medium_long' || type === 'long_aerobic'
      ? 'feel_hr'
      : type === 'hill_circuit' || type === 'hill_sprints'
        ? 'form_power'
        : type === 'rest'
          ? 'recovery'
          : 'pace_power';
  return {
    primaryControl,
    powerPctCp: pct,
    powerWatts: cp && pct ? scaleRange(pct, cp, 0) : undefined,
    heartRateBpm: zone?.heartRateBpm,
    heartRateCeiling: primaryControl === 'feel_hr' ? zone?.heartRateBpm?.high : undefined,
    gapPace: cs && pct ? paceRange(powerToSpeedRange(type, pct), cs) : zone?.pace,
    rpe: rpeFor(type),
    guidance: controlGuidance(type),
  };
}

function structureFor(
  type: PlannedSessionType,
  durationMin: number,
  target: IntensityTarget,
  physiology: PhysiologyEstimate | undefined,
  profile: CoachProfile,
): WorkoutComponent[] {
  if (type === 'threshold') {
    return [
      { kind: 'warmup', durationMin: 18, note: 'Easy plus drills and 4 relaxed strides.' },
      { kind: 'repetitions', count: 4, repetitionDurationSec: 6 * 60, recoveryDurationSec: 90, targetPowerPctCp: target.powerPctCp, targetPaceSecPerKm: target.gapPace, note: 'Repeatable and controlled; stop before mechanics deteriorate.' },
      { kind: 'cooldown', durationMin: Math.max(10, durationMin - 18 - 24 - 5), note: 'Very easy.' },
    ];
  }
  if (type === 'vo2') {
    const current5k = physiology?.raceEquivalents.find((race) => race.label === '5K')?.paceSecPerKm;
    return [
      { kind: 'warmup', durationMin: 20, note: 'Easy plus drills and strides.' },
      { kind: 'repetitions', count: 6, repetitionDurationSec: 3 * 60, recoveryDurationSec: 2 * 60, targetPowerPctCp: target.powerPctCp, targetPaceSecPerKm: current5k ? { fastSecPerKm: current5k * 0.98, slowSecPerKm: current5k * 1.02 } : target.gapPace, note: 'Even repetitions; HR is not a target.' },
      { kind: 'cooldown', durationMin: Math.max(10, durationMin - 20 - 18 - 10), note: 'Easy.' },
    ];
  }
  if (type === 'race_specific' || type === 'coordination') {
    const racePace = guardedGoalPace(profile, physiology);
    const repSec = type === 'race_specific' ? 4 * 60 : 90;
    const count = type === 'race_specific' ? 4 : 8;
    return [
      { kind: 'warmup', durationMin: 20, note: 'Easy plus drills and strides.' },
      { kind: 'repetitions', count, repetitionDurationSec: repSec, recoveryDurationSec: type === 'race_specific' ? 3 * 60 : 2 * 60, targetPowerPctCp: target.powerPctCp, targetPaceSecPerKm: racePace ? { fastSecPerKm: racePace * 0.99, slowSecPerKm: racePace * 1.01 } : target.gapPace, note: 'Goal-specific rhythm, capped by current demonstrated evidence when the goal is not yet supported.' },
      { kind: 'cooldown', durationMin: Math.max(10, durationMin - 20 - count * repSec / 60), note: 'Easy.' },
    ];
  }
  if (type === 'hill_circuit') {
    return [
      { kind: 'warmup', durationMin: 20, note: 'Easy on flat ground.' },
      { kind: 'repetitions', count: 6, repetitionDurationSec: 90, recoveryDurationSec: 150, targetPowerPctCp: target.powerPctCp, note: 'Strong elastic form, never straining; walk/jog down.' },
      { kind: 'cooldown', durationMin: Math.max(12, durationMin - 35), note: 'Easy flat running.' },
    ];
  }
  const components: WorkoutComponent[] = [{ kind: 'continuous', durationMin, targetPowerPctCp: target.powerPctCp, targetPaceSecPerKm: target.gapPace }];
  if (type === 'aerobic' && durationMin >= 40) {
    components.push({ kind: 'strides', count: 6, repetitionDurationSec: 15, recoveryDurationSec: 60, note: 'Relaxed, fast mechanics; full recovery and no acidosis.' });
  }
  return components;
}

function purposeFor(type: PlannedSessionType): string {
  const purposes: Record<PlannedSessionType, string> = {
    rest: 'Absorb prior training.', strength: 'Build mechanical durability.', recovery: 'Maintain rhythm while restoring normal cost and mechanics.',
    aerobic: 'Build aerobic density at absorbable cost.', medium_long: 'Extend aerobic durability without long-run concentration.',
    long_aerobic: 'Extend time-on-feet and preserve output/HR efficiency late.', steady: 'Raise controlled aerobic support below LT2.',
    strides: 'Maintain relaxed speed and coordination.', hill_sprints: 'Develop alactic force and elasticity.',
    hill_circuit: 'Develop running-specific strength before faster work.', threshold: 'Accumulate repeatable work near the upper threshold.',
    vo2: 'Develop 5K-supporting severe-domain power without excessive volume.', race_specific: 'Coordinate current race-specific pace and power.',
    coordination: 'Sharpen mechanics and race execution with full recovery.',
  };
  return purposes[type];
}

function fallbackFor(type: PlannedSessionType, durationMin: number, readiness: PlanningReadiness): string {
  if (readiness.state === 'red') return 'Do not start if walking gait, illness, or pain is abnormal; rest and seek appropriate assessment.';
  if (isConsequentialQualityType(type)) return `If warm-up response is abnormal, replace the work with ${Math.max(25, roundToFive(durationMin * 0.65))} minutes easy; do not move the session later to cram it in.`;
  if (type === 'long_aerobic' || type === 'medium_long') return `Stop at ${Math.max(30, roundToFive(durationMin * 0.7))} minutes if HR cost, form, knee, or Achilles response deteriorates.`;
  return `Shorten to ${Math.max(20, roundToFive(durationMin * 0.7))} minutes and keep below the HR ceiling if recovery is not normal.`;
}

function reasoningFor(type: PlannedSessionType, phase: LydiardPhase, readiness: PlanningReadiness): string {
  if (readiness.state === 'amber') return 'The stimulus is retained at reduced dose; no second training variable is progressed while response signals are amber.';
  if (type === 'long_aerobic') return 'The long run remains within known tolerance and below 30% of weekly duration to avoid one-run dominance.';
  if (isConsequentialQualityType(type)) return `This is phase-specific ${phase.replaceAll('_', ' ')} work, separated from the other consequential stimulus and supported by aerobic running.`;
  return 'This supports the phase objective while preserving continuity and an aerobic majority.';
}

function zoneForSessionType(type: PlannedSessionType, zones: PracticalZone[]): PracticalZone | undefined {
  const name: PracticalZoneName = type === 'recovery'
    ? 'recovery'
    : type === 'aerobic' || type === 'medium_long' || type === 'long_aerobic'
      ? 'aerobic'
      : type === 'steady'
        ? 'steady'
        : type === 'threshold'
          ? 'threshold'
          : 'vo2_anaerobic';
  return zones.find((zone) => zone.name === name);
}

function powerToSpeedRange(type: PlannedSessionType, powerRange: ZoneRange): ZoneRange {
  if (type === 'recovery') return { low: 0.6, high: 0.75 };
  if (type === 'aerobic' || type === 'medium_long' || type === 'long_aerobic') return { low: 0.75, high: 0.85 };
  if (type === 'steady') return { low: 0.85, high: 0.92 };
  if (type === 'threshold') return { low: 0.92, high: 1 };
  return { low: Math.max(1, powerRange.low ?? 1), high: powerRange.high };
}

function rpeFor(type: PlannedSessionType): ZoneRange {
  if (type === 'recovery') return { low: 1, high: 3 };
  if (type === 'aerobic' || type === 'medium_long' || type === 'long_aerobic') return { low: 2, high: 4 };
  if (type === 'steady') return { low: 4, high: 6 };
  if (type === 'threshold') return { low: 6, high: 7 };
  if (type === 'strength') return { low: 6, high: 8 };
  return { low: 7, high: 9 };
}

function controlGuidance(type: PlannedSessionType): string {
  if (type === 'recovery' || type === 'aerobic') return 'Breathing/RPE and HR ceiling are primary; power is a guardrail and pace is an outcome.';
  if (type === 'medium_long' || type === 'long_aerobic') return 'Aerobic feel and HR/power stability are primary; protect late-run form and coupling.';
  if (type === 'steady') return 'Power or GAP controls the run; HR validates that it remains below threshold.';
  if (type === 'threshold') return 'Control each work interval by power/pace; use late-interval HR and RPE only as validation.';
  if (type === 'hill_circuit' || type === 'hill_sprints') return 'Control by time, elastic form, power, and RPE; uphill pace is not comparable to flat pace.';
  if (type === 'vo2' || type === 'race_specific' || type === 'coordination' || type === 'strides') return 'Control by repeatable power, pace, and mechanics; HR lag makes it a poor real-time target.';
  return 'Use recovery quality and pain-free movement as the control.';
}

function buildPlanDecisions(
  input: PlanningStateInput,
  readiness: PlanningReadiness,
  phase: LydiardPhase,
  targetMinutes: number,
  qualityCount: number,
): string[] {
  const decisions = [
    `${targetMinutes} running minutes were chosen from recent absorbed volume, sustainable-duration state, phase, and current response.`,
    `${qualityCount} consequential session${qualityCount === 1 ? '' : 's'} fit the ${phase.replaceAll('_', ' ')} phase and current ${readiness.state} state.`,
    'Power defines external stress when valid; HR is interpreted as cost, and GAP/pace is used only as the external fallback.',
  ];
  if (readiness.absorbedWeeks < 2) decisions.push('Volume was not progressed because two consecutive absorbed weeks were not demonstrated.');
  if (input.profile.weekInLoadCycle === 3) decisions.push('A consolidation week was selected using the two-up/one-down prior.');
  if (readiness.reasons.length) decisions.push(`Conservative constraints: ${readiness.reasons.join('; ')}.`);
  return decisions;
}

function goalPriority(profile: CoachProfile, physiology: PhysiologyEstimate | undefined): string {
  if (profile.goalEvent) {
    const goalPace = profile.goalEvent.targetTimeSec / profile.goalEvent.distanceKm;
    const currentPace = equivalentPaceForDistance(physiology, profile.goalEvent.distanceKm);
    const gap = currentPace ? currentPace - goalPace : undefined;
    const evidence = gap === undefined
      ? 'Current race-equivalent evidence is limited, so progression remains conservative.'
      : gap <= 0
        ? 'Current race-equivalent evidence supports the target; durability and execution are now the priority.'
        : `Current evidence is about ${Math.round(gap)} sec/km from target pace, so the plan builds the missing systems before specific rehearsal.`;
    return `${formatDistance(profile.goalEvent.distanceKm)} in ${formatRaceTime(profile.goalEvent.targetTimeSec)}. ${evidence}`;
  }
  const fiveK = physiology?.raceEquivalents.find((race) => race.label === '5K')?.predictedSec;
  const tenK = physiology?.raceEquivalents.find((race) => race.label === '10K')?.predictedSec;
  if (!fiveK || fiveK > 900) return 'First milestone: durable healthy training toward sub-15:00 5K. Sub-30:00 10K remains a later, materially harder goal.';
  if (!tenK || tenK > 1875) return 'Sub-15:00 5K capability is indicated; next bridge is approximately sub-31:15 10K durability before targeting sub-30.';
  return 'Current model supports the sub-31 10K bridge; build threshold durability toward sub-30 without sacrificing health or aerobic continuity.';
}

function guardedGoalPace(profile: CoachProfile, physiology: PhysiologyEstimate | undefined): number | undefined {
  const goal = profile.goalEvent;
  if (!goal) return physiology?.raceEquivalents.find((race) => race.label === '5K')?.paceSecPerKm;
  const goalPace = goal.targetTimeSec / goal.distanceKm;
  const currentPace = equivalentPaceForDistance(physiology, goal.distanceKm);
  if (!currentPace) return undefined;
  // Specific work can approach the goal, but never jump more than 3% beyond
  // the athlete's current equivalent in a single generated prescription.
  return Math.max(goalPace, currentPace * 0.97);
}

function equivalentPaceForDistance(physiology: PhysiologyEstimate | undefined, distanceKm: number): number | undefined {
  const available = physiology?.raceEquivalents
    .map((race) => ({ ...race, distanceKm: raceDistanceKm(race.label) }))
    .filter((race): race is typeof race & { distanceKm: number } => race.distanceKm !== undefined && race.predictedSec > 0)
    .sort((a, b) => Math.abs(a.distanceKm - distanceKm) - Math.abs(b.distanceKm - distanceKm));
  const nearest = available?.[0];
  if (!nearest) return undefined;
  const equivalentSeconds = nearest.predictedSec * Math.pow(distanceKm / nearest.distanceKm, 1.06);
  return equivalentSeconds / distanceKm;
}

function raceDistanceKm(label: string): number | undefined {
  if (label === '5K') return 5;
  if (label === '10K') return 10;
  if (label.toLowerCase().includes('half')) return 21.0975;
  if (label.toLowerCase().includes('marathon')) return 42.195;
  return undefined;
}

function formatDistance(distanceKm: number): string {
  if (Math.abs(distanceKm - 21.0975) < 0.05) return 'Half marathon';
  if (Math.abs(distanceKm - 42.195) < 0.05) return 'Marathon';
  return `${Number(distanceKm.toFixed(2))} km`;
}

function formatRaceTime(seconds: number): string {
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
    : `${minutes}:${String(remaining).padStart(2, '0')}`;
}

function phaseObjective(phase: LydiardPhase, state: LydiardWeekPlan['currentState']): string {
  if (state === 'red') return 'Restore normal health, gait, energy, and pain response; fitness progression is paused.';
  const objectives: Record<LydiardPhase, string> = {
    aerobic_conditioning: 'Build the largest aerobic and mechanical foundation that can be repeatedly absorbed, while retaining relaxed speed.',
    hill_resistance: 'Add running-specific strength, elasticity, and force production while maintaining the aerobic base.',
    anaerobic_development: 'Layer limited 5K/10K-specific development onto the aerobic and hill foundation.',
    coordination: 'Reduce total load, rehearse current race-specific output, and sharpen with full recovery.',
    recovery_regeneration: 'Consolidate the previous block and restore normal energy, mechanics, and motivation.',
  };
  return objectives[phase];
}

function weeklyIntensityGuidance(physiology: PhysiologyEstimate | undefined): string[] {
  const aerobic = physiology?.zones.find((zone) => zone.name === 'aerobic');
  const threshold = physiology?.zones.find((zone) => zone.name === 'threshold');
  return [
    `Easy/aerobic: ${formatTargetZone(aerobic)}. Breathing and HR ceiling control; do not force pace.`,
    `Threshold: ${formatTargetZone(threshold)}. Power/pace control work intervals; late HR validates the response.`,
    'Short repetitions and hills: power, time, consistency, and mechanics control. Do not chase an HR target.',
  ];
}

function deliberatelyAbsent(phase: LydiardPhase, readiness: PlanningReadiness): string[] {
  if (readiness.state === 'red') return ['All consequential intensity', 'Long-run extension', 'Heavy lower-body strength', 'Any attempt to make up missed work'];
  if (readiness.state === 'amber') return ['A second consequential quality session', 'Volume progression', 'Extra work after a successful session'];
  const absent: Record<LydiardPhase, string[]> = {
    aerobic_conditioning: ['Substantial glycolytic sessions', 'Goal-pace proving workouts', 'Simultaneous volume and intensity progression'],
    hill_resistance: ['High-volume track intervals', 'Abrupt Achilles-loading increases', 'Loss of the aerobic majority'],
    anaerobic_development: ['More than two consequential stimuli', 'Exhaustive repetitions', 'Removal of the maintenance long run'],
    coordination: ['High background mileage', 'Sessions requiring prolonged recovery', 'New fitness-building experiments'],
    recovery_regeneration: ['Consequential intensity', 'Volume progression', 'Compensatory mileage'],
  };
  return absent[phase];
}

function defaultAdaptationTriggers(): AdaptationTriggers {
  return {
    green: ['Normal HR-to-power response', 'Stable late-run power/GAP and mechanics', 'Pain 0–2/10 without escalation', 'Normal energy by the next planned session'],
    amber: ['Easy run HR cost ≥4 bpm above normal', 'Pain 3–4/10 without gait change', 'Heavy legs or poor energy on repeated days', 'Late power decline ≥6% or coupling drift ≥7%'],
    red: ['Pain ≥5/10 or any pain-altered gait', 'Symptoms that escalate during running', 'Suspected illness', 'Severe unexplained performance collapse or inability to control planned intensity'],
  };
}

function approximateWeeklyDistance(
  minutes: number,
  profile: CoachProfile,
  physiology: PhysiologyEstimate | undefined,
): ZoneRange | undefined {
  const aerobic = physiology?.zones.find((zone) => zone.name === 'aerobic')?.pace;
  const pace = representativePace(aerobic, profile.recentEasyPaceSecPerKm);
  if (!pace) return undefined;
  const distance = minutes * 60 / pace;
  return { low: round(distance * 0.92, 1), high: round(distance * 1.08, 1) };
}

function representativePace(range: PaceRange | undefined, fallback?: number): number | undefined {
  if (range?.fastSecPerKm && range.slowSecPerKm) return (range.fastSecPerKm + range.slowSecPerKm) / 2;
  return fallback;
}

function formatTargetZone(zone: PracticalZone | undefined): string {
  if (!zone) return 'zones currently low-confidence; use feel and prescribed domain';
  const parts: string[] = [];
  if (zone.powerWatts?.low !== undefined || zone.powerWatts?.high !== undefined) parts.push(`${formatRange(zone.powerWatts, 'W')}`);
  if (zone.heartRateBpm?.low !== undefined || zone.heartRateBpm?.high !== undefined) parts.push(`${formatRange(zone.heartRateBpm, 'bpm')}`);
  if (zone.pace?.fastSecPerKm || zone.pace?.slowSecPerKm) parts.push(formatPaceRange(zone.pace));
  return parts.join(' · ') || 'use feel and the prescribed physiological domain';
}

function isRunningPlanSession(session: PlannedSession): boolean {
  return session.sessionType !== 'rest' && session.sessionType !== 'strength';
}

function isConsequentialQuality(session: PlannedSession): boolean {
  return isConsequentialQualityType(session.sessionType);
}

function isConsequentialQualityType(type: PlannedSessionType): boolean {
  return type === 'steady' || type === 'hill_circuit' || type === 'threshold' || type === 'vo2' || type === 'race_specific' || type === 'coordination';
}

export function evaluatePlannedVsActual(input: PostRunEvaluationInput): PostRunEvaluation {
  const plannedDurationSec = input.planned.targetDurationMin * 60;
  const actualDurationSec = input.actual.durationSec;
  const durationDeltaPct = plannedDurationSec > 0 ? (actualDurationSec - plannedDurationSec) / plannedDurationSec * 100 : undefined;
  const targetPower = input.planned.target.powerPctCp;
  const actualIntensity = input.actual.weightedPctCp ?? input.actual.averagePctCp ?? input.actual.externalStress.intensityFactor;
  const intensityAbove = actualIntensity !== undefined && targetPower?.high !== undefined
    ? actualIntensity - targetPower.high
    : undefined;
  const intensityBelow = actualIntensity !== undefined && targetPower?.low !== undefined
    ? targetPower.low - actualIntensity
    : undefined;
  const feedback = input.feedback;
  const pain = Math.max(feedback?.painDuring ?? 0, feedback?.painAfter ?? 0);
  const gaitConcern = feedback?.alteredGait === true;
  const illness = feedback?.illnessSuspected === true;
  const veryHighHr = input.actual.heartRateCost.status === 'very_elevated';
  const elevatedHr = input.actual.heartRateCost.status === 'elevated';
  const lateDrop = (input.actual.latePowerChangePct ?? 0) <= -6;
  const highDecoupling = (input.actual.powerHrDecouplingPct ?? input.activity.decouplingPct ?? 0) >= 7;
  const subjectivelyExtreme = feedback?.perceivedCost === 'extreme' || feedback?.legs === 'dead' || (feedback?.rpe ?? 0) >= 9;
  const subjectivelyHigh = feedback?.perceivedCost === 'high' || feedback?.sessionFeel === 'harder' || feedback?.legs === 'heavy';
  const majorDoseOverrun = (durationDeltaPct ?? 0) > 25 || (intensityAbove ?? 0) > 0.08;
  const moderateDoseOverrun = (durationDeltaPct ?? 0) > 12 || (intensityAbove ?? 0) > 0.04;
  const essentialData = input.actual.externalStress.source !== 'unavailable';

  let verdict: PostRunVerdict;
  if (gaitConcern || pain >= 5 || illness) verdict = 'pain_injury_concern';
  else if ((majorDoseOverrun && (veryHighHr || lateDrop || subjectivelyHigh)) || subjectivelyExtreme || (veryHighHr && lateDrop)) verdict = 'excessive';
  else if (moderateDoseOverrun || elevatedHr || veryHighHr || lateDrop || highDecoupling || subjectivelyHigh) verdict = 'productive_but_costly';
  else if (!essentialData && !feedback) verdict = 'inconclusive';
  else verdict = 'absorbed';

  const evidence: string[] = [];
  if (durationDeltaPct !== undefined) evidence.push(`Duration was ${signed(round(durationDeltaPct, 0))}% versus plan.`);
  if (actualIntensity !== undefined && targetPower) {
    evidence.push(`Weighted/average intensity was ${Math.round(actualIntensity * 100)}% CP versus target ${formatPercentRange(targetPower)}.`);
  }
  if (input.actual.heartRateCost.residualBpm !== undefined) {
    evidence.push(`HR cost residual was ${signed(input.actual.heartRateCost.residualBpm)} bpm (${input.actual.heartRateCost.status.replaceAll('_', ' ')}).`);
  } else {
    evidence.push('HR cost was inconclusive; it was not invented from an arbitrary max-HR percentage.');
  }
  if (input.actual.latePowerChangePct !== undefined) evidence.push(`Late power change was ${signed(input.actual.latePowerChangePct)}%.`);
  if (input.actual.powerHrDecouplingPct !== undefined) evidence.push(`Power-to-HR decoupling was ${signed(input.actual.powerHrDecouplingPct)}%.`);
  if (feedback) evidence.push(`Athlete response: ${feedback.sessionFeel ?? 'not rated'}, legs ${feedback.legs ?? 'not rated'}, pain ${pain}/10${gaitConcern ? ', altered gait' : ''}.`);

  const mechanicalObservations: string[] = [];
  if (lateDrop) mechanicalObservations.push('External output deteriorated materially late in the run.');
  if (highDecoupling) mechanicalObservations.push('External-output-to-HR efficiency deteriorated beyond the initial 7% review threshold.');
  if (gaitConcern) mechanicalObservations.push('Pain altered gait; mechanical safety overrides the performance goal.');
  if (pain > 0 && !gaitConcern) mechanicalObservations.push(`${feedback?.painLocation ?? 'Reported'} pain reached ${pain}/10 without a reported gait change.`);
  if (mechanicalObservations.length === 0) mechanicalObservations.push('No stream or feedback evidence of material mechanical deterioration was reported.');

  const proposedPatches = proposeFuturePatches(input, verdict);
  const remainingWeekEffect = patchEffect(verdict, proposedPatches);
  const intendedStimulus = `${input.planned.title}: ${input.planned.purpose} Planned ${input.planned.targetDurationMin} min; ${input.planned.target.guidance}`;
  const actualStimulus = `${Math.round(actualDurationSec / 60)} min, ${input.actual.externalStress.source} stress ${formatOptional(input.actual.externalStress.totalStress)}, intensity ${actualIntensity === undefined ? 'unknown' : `${Math.round(actualIntensity * 100)}% threshold`}.`;
  const externalVsInternalCost = input.actual.heartRateCost.residualBpm === undefined
    ? `External dose was measured from ${input.actual.externalStress.source}; internal HR cost is inconclusive and was not blended into load.`
    : `External dose came from ${input.actual.externalStress.source}; chest-strap HR was ${signed(input.actual.heartRateCost.residualBpm)} bpm versus personal expectation and changes the cost verdict, not the load score.`;

  return {
    plannedSessionId: input.planned.id,
    activityId: input.activity.id,
    intendedStimulus,
    actualStimulus,
    externalVsInternalCost,
    mechanicalObservations,
    verdict,
    evidence,
    remainingWeekEffect,
    proposedPatches,
    approval: {
      required: true,
      status: 'awaiting_approval',
      prompt: proposedPatches.length
        ? `Review and explicitly approve or reject ${proposedPatches.length} proposed future-session patch${proposedPatches.length === 1 ? '' : 'es'}; no plan row has been changed.`
        : 'No future-session change is proposed. Confirm the verdict when recording the coaching decision.',
    },
    zoneConfidenceUpdate: verdict === 'absorbed' && isConsequentialQuality(input.planned)
      ? 'positive_evidence_only'
      : (intensityAbove ?? 0) > 0.04 || (intensityBelow ?? 0) > 0.06
        ? 'review_after_repeat'
        : 'none',
  };
}

function proposeFuturePatches(input: PostRunEvaluationInput, verdict: PostRunVerdict): ProposedSessionPatch[] {
  const activityDay = (input.activity.startDateLocal ?? input.activity.startDate).slice(0, 10);
  const future = input.futureSessions
    .filter((session) => session.plannedDate > activityDay)
    .filter((session) => session.status !== 'completed' && session.status !== 'cancelled' && session.status !== 'superseded')
    .sort((a, b) => a.plannedDate.localeCompare(b.plannedDate));
  const nextRun = future.find(isRunningPlanSession);
  const nextQuality = future.find(isConsequentialQuality);
  const patches: ProposedSessionPatch[] = [];

  if (verdict === 'pain_injury_concern') {
    if (nextRun) patches.push(replaceWithRecoveryPatch(nextRun, true, 'Pain/illness concern requires normal gait and daily function before running resumes.'));
    if (nextQuality && nextQuality.id !== nextRun?.id) patches.push(downgradeQualityPatch(nextQuality, 0.55, 'Consequential intensity is removed while pain, gait, or illness is unresolved.'));
    return dedupePatches(patches);
  }
  if (verdict === 'excessive') {
    if (nextRun) patches.push(replaceWithRecoveryPatch(nextRun, false, 'The completed dose was excessive; preserve frequency only through a shorter recovery run.'));
    if (nextQuality && daysBetween(activityDay, nextQuality.plannedDate) <= 4 && nextQuality.id !== nextRun?.id) {
      patches.push(downgradeQualityPatch(nextQuality, 0.65, 'The next quality stimulus is downgraded unless normal HR cost, legs, and mechanics return.'));
    }
    return dedupePatches(patches);
  }
  if (verdict === 'productive_but_costly') {
    if (nextRun) patches.push(shortenRecoveryPatch(nextRun, 0.75, 'Keep the benefit from the completed run and increase subsequent recovery; do not add work.'));
    if (nextQuality && daysBetween(activityDay, nextQuality.plannedDate) <= 2 && nextQuality.id !== nextRun?.id) {
      patches.push(downgradeQualityPatch(nextQuality, 0.75, 'Quality within 48 hours is downgraded unless the next check-in confirms normality.'));
    }
  }
  const priorCostly = input.recentEvaluations?.filter((evaluation) =>
    evaluation.verdict === 'productive_but_costly' || evaluation.verdict === 'excessive',
  ).length ?? 0;
  if (priorCostly >= 2 && nextQuality && !patches.some((patch) => patch.sessionId === nextQuality.id)) {
    patches.push(downgradeQualityPatch(nextQuality, 0.65, 'Several runs are accumulating cost; remove intensity before removing all running.'));
  }
  return dedupePatches(patches);
}

function replaceWithRecoveryPatch(session: PlannedSession, rest: boolean, reason: string): ProposedSessionPatch {
  const duration = rest ? 0 : Math.max(20, roundToFive(session.targetDurationMin * 0.55));
  const changes: ProposedSessionChange[] = [
    { field: 'sessionType', before: session.sessionType, after: rest ? 'rest' : 'recovery' },
    { field: 'title', before: session.title, after: rest ? 'Rest and symptom review' : 'Short recovery run' },
    { field: 'targetDurationMin', before: session.targetDurationMin, after: duration },
    { field: 'target', before: session.target, after: rest
      ? { primaryControl: 'recovery', guidance: 'No running until normal walking gait and daily function return.' }
      : { ...session.target, primaryControl: 'feel_hr', powerPctCp: { low: 0.58, high: 0.68 }, guidance: 'Very easy; stop if response is not normal.' } },
    { field: 'structure', before: session.structure, after: rest ? [] : [{ kind: 'continuous', durationMin: duration, note: 'Very easy only.' }] },
  ];
  return { sessionId: session.id, plannedDate: session.plannedDate, changes, reason, requiresApproval: true };
}

function shortenRecoveryPatch(session: PlannedSession, factor: number, reason: string): ProposedSessionPatch {
  const duration = Math.max(20, roundToFive(session.targetDurationMin * factor));
  return {
    sessionId: session.id,
    plannedDate: session.plannedDate,
    changes: [
      { field: 'sessionType', before: session.sessionType, after: 'recovery' },
      { field: 'title', before: session.title, after: 'Recovery run' },
      { field: 'targetDurationMin', before: session.targetDurationMin, after: duration },
      { field: 'target', before: session.target, after: { ...session.target, primaryControl: 'feel_hr', powerPctCp: { low: 0.58, high: 0.7 }, guidance: 'Breathing and HR ceiling control; pace is unrestricted.' } },
      { field: 'structure', before: session.structure, after: [{ kind: 'continuous', durationMin: duration, note: 'Very easy only.' }] },
    ],
    reason,
    requiresApproval: true,
  };
}

function downgradeQualityPatch(session: PlannedSession, factor: number, reason: string): ProposedSessionPatch {
  const duration = Math.max(25, roundToFive(session.targetDurationMin * factor));
  return {
    sessionId: session.id,
    plannedDate: session.plannedDate,
    changes: [
      { field: 'sessionType', before: session.sessionType, after: 'aerobic' },
      { field: 'title', before: session.title, after: 'Aerobic replacement' },
      { field: 'targetDurationMin', before: session.targetDurationMin, after: duration },
      { field: 'target', before: session.target, after: { primaryControl: 'feel_hr', powerPctCp: { low: 0.68, high: 0.76 }, guidance: 'Controlled aerobic effort; no quality work unless a later approved decision restores it.' } },
      { field: 'structure', before: session.structure, after: [{ kind: 'continuous', durationMin: duration, targetPowerPctCp: { low: 0.68, high: 0.76 } }] },
    ],
    reason,
    requiresApproval: true,
  };
}

function dedupePatches(patches: ProposedSessionPatch[]): ProposedSessionPatch[] {
  const bySession = new Map<string, ProposedSessionPatch>();
  for (const patch of patches) {
    if (!bySession.has(patch.sessionId)) bySession.set(patch.sessionId, patch);
  }
  return [...bySession.values()];
}

function patchEffect(verdict: PostRunVerdict, patches: ProposedSessionPatch[]): string {
  if (verdict === 'absorbed') return 'The remaining week stays unchanged. Positive evidence is recorded, but neither volume nor zones increase from one run.';
  if (verdict === 'inconclusive') return 'The remaining week stays unchanged pending feedback or better data; uncertainty is not treated as failure.';
  if (verdict === 'pain_injury_concern') return `${patches.length} conservative change(s) are proposed. They remain unapplied until explicit approval; professional assessment is appropriate if symptoms persist or gait is altered.`;
  if (verdict === 'excessive') return `${patches.length} recovery/downgrade change(s) are proposed so the benefit is not followed by compounding load.`;
  return `${patches.length} targeted recovery change(s) are proposed; the entire week is not regenerated.`;
}

interface IntegralSeries {
  sum: number[];
  validSec: number[];
}

interface SessionSeries {
  time: number[];
  power?: number[];
  heartRate?: number[];
  paceSpeed?: number[];
  gapSpeed?: number[];
}

function sessionSeries(activity: CoachActivitySummary): SessionSeries | undefined {
  const streams = activity.streams;
  const time = sanitizeTime(streams?.timeSec);
  if (!time || time.length < 2) return undefined;
  const power = alignedSeries(streams?.powerWatts, time.length, usefulPower);
  const heartRate = alignedSeries(streams?.heartRateBpm, time.length, usefulHeartRate);
  let paceSpeed = alignedSeries(streams?.velocityMps, time.length, usefulSpeed);
  if (!paceSpeed) {
    const distance = alignedSeries(streams?.distanceM, time.length, finiteNumber);
    if (distance) {
      paceSpeed = new Array(time.length).fill(Number.NaN);
      for (let index = 0; index < time.length - 1; index += 1) {
        const dt = intervalDuration(time[index], time[index + 1]);
        const delta = distance[index + 1] - distance[index];
        if (dt && delta >= 0 && delta / dt <= 9) paceSpeed[index] = delta / dt;
      }
      paceSpeed[paceSpeed.length - 1] = paceSpeed[paceSpeed.length - 2];
    }
  }
  let gapSpeed = alignedSeries(streams?.gradeAdjustedSpeedMps, time.length, usefulSpeed);
  if (!gapSpeed && paceSpeed) {
    const altitude = alignedSeries(streams?.altitudeM, time.length, finiteNumber);
    const distance = alignedSeries(streams?.distanceM, time.length, finiteNumber);
    if (altitude && distance) {
      gapSpeed = paceSpeed.map((speed, index) => {
        if (!usefulSpeed(speed) || index >= time.length - 1) return speed;
        const deltaDistance = distance[index + 1] - distance[index];
        const deltaAltitude = altitude[index + 1] - altitude[index];
        if (deltaDistance < 2 || !Number.isFinite(deltaAltitude)) return speed;
        const grade = clamp(deltaAltitude / deltaDistance, -0.25, 0.25);
        const energyFactor = clamp(1 + (grade >= 0 ? 3.6 : 1.8) * grade, 0.72, 1.65);
        return speed * energyFactor;
      });
    }
  }
  return { time, power, heartRate, paceSpeed, gapSpeed };
}

function sanitizeTime(values: number[] | undefined): number[] | undefined {
  if (!values || values.length < 2 || values.some((value) => !Number.isFinite(value))) return undefined;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] <= values[index - 1]) return undefined;
  }
  return values;
}

function alignedSeries(
  values: number[] | undefined,
  length: number,
  validator: (value: unknown) => boolean,
): number[] | undefined {
  if (!values || values.length !== length) return undefined;
  const valid = values.filter((value) => validator(value)).length;
  if (valid < Math.max(2, length * 0.35)) return undefined;
  return values.map((value) => validator(value) ? value : Number.NaN);
}

function buildCumulativeDistance(streams: CoachActivityStreams | undefined, time: number[]): number[] | undefined {
  const gapSpeed = alignedSeries(streams?.gradeAdjustedSpeedMps, time.length, usefulSpeed);
  if (gapSpeed) return integrateSpeed(time, gapSpeed);
  const distance = alignedSeries(streams?.distanceM, time.length, finiteNumber);
  if (distance) {
    const out = new Array<number>(distance.length).fill(0);
    let validDeltas = 0;
    for (let index = 1; index < distance.length; index += 1) {
      const rawDelta = distance[index] - distance[index - 1];
      const dt = intervalDuration(time[index - 1], time[index]);
      const delta = dt && rawDelta >= 0 && rawDelta / dt <= 9 ? rawDelta : 0;
      if (delta > 0) validDeltas += 1;
      out[index] = out[index - 1] + delta;
    }
    if (validDeltas >= 2 && out[out.length - 1] > 100) return out;
  }
  const velocity = alignedSeries(streams?.velocityMps, time.length, usefulSpeed);
  return velocity ? integrateSpeed(time, velocity) : undefined;
}

function integrateSpeed(time: number[], speed: number[]): number[] {
  const cumulative = new Array<number>(time.length).fill(0);
  for (let index = 1; index < time.length; index += 1) {
    const dt = intervalDuration(time[index - 1], time[index]);
    const value = speed[index - 1];
    cumulative[index] = cumulative[index - 1] + (dt && usefulSpeed(value) ? value * dt : 0);
  }
  return cumulative;
}

function buildIntegral(
  time: number[],
  values: number[],
  validator: (value: unknown) => boolean,
): IntegralSeries {
  const sumValues = new Array<number>(time.length).fill(0);
  const validSec = new Array<number>(time.length).fill(0);
  for (let index = 1; index < time.length; index += 1) {
    const dt = intervalDuration(time[index - 1], time[index]);
    const value = values[index - 1];
    sumValues[index] = sumValues[index - 1];
    validSec[index] = validSec[index - 1];
    if (dt && validator(value)) {
      sumValues[index] += value * dt;
      validSec[index] += dt;
    }
  }
  return { sum: sumValues, validSec };
}

function windowAverage(
  integral: IntegralSeries,
  start: number,
  end: number,
  durationSec: number,
  minimumCoverage: number,
): number | undefined {
  const valid = integral.validSec[end] - integral.validSec[start];
  if (valid < durationSec * minimumCoverage || valid <= 0) return undefined;
  return (integral.sum[end] - integral.sum[start]) / valid;
}

function seriesCoverage(
  time: number[],
  values: number[] | undefined,
  validator: (value: unknown) => boolean,
): number {
  if (!values || values.length !== time.length) return 0;
  let valid = 0;
  let total = 0;
  for (let index = 0; index < time.length - 1; index += 1) {
    const dt = intervalDuration(time[index], time[index + 1]);
    if (!dt) continue;
    total += dt;
    if (validator(values[index])) valid += dt;
  }
  return total > 0 ? valid / total : 0;
}

function timeWeightedMean(
  time: number[] | undefined,
  values: number[] | undefined,
  validator: (value: unknown) => boolean,
): number | undefined {
  if (!time || !values || time.length !== values.length) return undefined;
  let weighted = 0;
  let valid = 0;
  for (let index = 0; index < time.length - 1; index += 1) {
    const dt = intervalDuration(time[index], time[index + 1]);
    if (dt && validator(values[index])) {
      weighted += values[index] * dt;
      valid += dt;
    }
  }
  return valid > 0 ? weighted / valid : undefined;
}

function weightedPower(time: number[], power: number[]): number | undefined {
  const integral = buildIntegral(time, power, usefulPower);
  let fourthPowerSum = 0;
  let valid = 0;
  for (let index = 1; index < time.length; index += 1) {
    const startTime = time[index] - 30;
    const startIndex = Math.max(0, lowerBound(time, startTime) - 1);
    const windowSec = time[index] - time[startIndex];
    const rolling = windowAverage(integral, startIndex, index, windowSec, 0.7);
    const dt = intervalDuration(time[index - 1], time[index]);
    if (rolling && dt) {
      fourthPowerSum += rolling ** 4 * dt;
      valid += dt;
    }
  }
  return valid > 0 ? (fourthPowerSum / valid) ** 0.25 : undefined;
}

function bestRollingAverage(
  time: number[],
  values: number[],
  durationSec: number,
  validator: (value: unknown) => boolean,
): number | undefined {
  if (time[time.length - 1] - time[0] < durationSec * 0.98) return undefined;
  const integral = buildIntegral(time, values, validator);
  let best: number | undefined;
  const step = Math.max(1, Math.floor(time.length / 800));
  for (let start = 0; start < time.length - 1; start += step) {
    const end = lowerBound(time, time[start] + durationSec);
    if (end >= time.length) break;
    const actualDuration = time[end] - time[start];
    const average = windowAverage(integral, start, end, actualDuration, 0.75);
    if (average !== undefined && (best === undefined || average > best)) best = average;
  }
  return best;
}

function lateChangePercent(
  time: number[],
  values: number[] | undefined,
  validator: (value: unknown) => boolean,
): number | undefined {
  if (!values || time.length !== values.length) return undefined;
  const duration = time[time.length - 1] - time[0];
  if (duration < 15 * 60) return undefined;
  const integral = buildIntegral(time, values, validator);
  const firstStart = lowerBound(time, time[0] + duration * 0.15);
  const firstEnd = lowerBound(time, time[0] + duration * 0.4);
  const lateStart = lowerBound(time, time[0] + duration * 0.7);
  const lateEnd = time.length - 1;
  const first = windowAverage(integral, firstStart, firstEnd, time[firstEnd] - time[firstStart], 0.7);
  const late = windowAverage(integral, lateStart, lateEnd, time[lateEnd] - time[lateStart], 0.7);
  return first && late ? (late / first - 1) * 100 : undefined;
}

function externalHrDecoupling(
  time: number[],
  external: number[] | undefined,
  heartRate: number[] | undefined,
): number | undefined {
  if (!external || !heartRate || time.length !== external.length || time.length !== heartRate.length) return undefined;
  const duration = time[time.length - 1] - time[0];
  if (duration < 20 * 60) return undefined;
  const externalIntegral = buildIntegral(time, external, finitePositive);
  const hrIntegral = buildIntegral(time, heartRate, usefulHeartRate);
  const start = lowerBound(time, time[0] + duration * 0.1);
  const middle = lowerBound(time, time[0] + duration * 0.5);
  const end = lowerBound(time, time[0] + duration * 0.9);
  const firstDuration = time[middle] - time[start];
  const secondDuration = time[end] - time[middle];
  const externalFirst = windowAverage(externalIntegral, start, middle, firstDuration, 0.7);
  const externalSecond = windowAverage(externalIntegral, middle, end, secondDuration, 0.7);
  const hrFirst = windowAverage(hrIntegral, start, middle, firstDuration, 0.7);
  const hrSecond = windowAverage(hrIntegral, middle, end, secondDuration, 0.7);
  if (!externalFirst || !externalSecond || !hrFirst || !hrSecond) return undefined;
  const efficiencyFirst = externalFirst / hrFirst;
  const efficiencySecond = externalSecond / hrSecond;
  return (efficiencyFirst / efficiencySecond - 1) * 100;
}

function heartRateDriftBpmPerHour(
  time: number[],
  heartRate: number[] | undefined,
  external: number[] | undefined,
): number | undefined {
  if (!heartRate || !external || time.length !== heartRate.length || time.length !== external.length) return undefined;
  const duration = time[time.length - 1] - time[0];
  if (duration < 30 * 60) return undefined;
  const hrIntegral = buildIntegral(time, heartRate, usefulHeartRate);
  const extIntegral = buildIntegral(time, external, finitePositive);
  const start = lowerBound(time, time[0] + duration * 0.1);
  const middle = lowerBound(time, time[0] + duration * 0.5);
  const end = lowerBound(time, time[0] + duration * 0.9);
  const firstDuration = time[middle] - time[start];
  const secondDuration = time[end] - time[middle];
  const hrFirst = windowAverage(hrIntegral, start, middle, firstDuration, 0.7);
  const hrSecond = windowAverage(hrIntegral, middle, end, secondDuration, 0.7);
  const extFirst = windowAverage(extIntegral, start, middle, firstDuration, 0.7);
  const extSecond = windowAverage(extIntegral, middle, end, secondDuration, 0.7);
  if (!hrFirst || !hrSecond || !extFirst || !extSecond || Math.abs(extSecond / extFirst - 1) > 0.08) return undefined;
  return (hrSecond - hrFirst) / Math.max(0.25, duration / 7200);
}

function interpolateBins(
  bins: HrCostBin[],
  pctCp: number,
  selector: (bin: HrCostBin) => number,
): number {
  if (bins.length === 1) return selector(bins[0]);
  const [a, b] = bins;
  const ac = (a.lowPctCp + a.highPctCp) / 2;
  const bc = (b.lowPctCp + b.highPctCp) / 2;
  if (Math.abs(bc - ac) < 1e-9) return (selector(a) + selector(b)) / 2;
  const fraction = clamp((pctCp - ac) / (bc - ac), 0, 1);
  return selector(a) + (selector(b) - selector(a)) * fraction;
}

function weightedLinearFit(
  points: WeightedPoint[],
  weights: number[],
): { slope: number; intercept: number } | undefined {
  let sw = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let index = 0; index < points.length; index += 1) {
    const weight = Math.max(0, weights[index] ?? 0);
    const { x, y } = points[index];
    sw += weight;
    sx += weight * x;
    sy += weight * y;
    sxx += weight * x * x;
    sxy += weight * x * y;
  }
  const denominator = sw * sxx - sx * sx;
  if (sw <= 0 || Math.abs(denominator) < 1e-9) return undefined;
  const slope = (sw * sxy - sx * sy) / denominator;
  const intercept = (sy - slope * sx) / sw;
  return Number.isFinite(slope) && Number.isFinite(intercept) ? { slope, intercept } : undefined;
}

function weightedMean(values: number[], weights: number[]): number | undefined {
  let total = 0;
  let totalWeight = 0;
  for (let index = 0; index < values.length; index += 1) {
    if (!Number.isFinite(values[index]) || !Number.isFinite(weights[index]) || weights[index] <= 0) continue;
    total += values[index] * weights[index];
    totalWeight += weights[index];
  }
  return totalWeight > 0 ? total / totalWeight : undefined;
}

function weightedMedian(values: number[], weights: number[]): number | undefined {
  return values.length ? weightedQuantile(values, weights, 0.5) : undefined;
}

function weightedQuantile(values: number[], weights: number[], quantile: number): number {
  const pairs = values
    .map((value, index) => ({ value, weight: Math.max(0, weights[index] ?? 0) }))
    .filter((pair) => Number.isFinite(pair.value) && pair.weight > 0)
    .sort((a, b) => a.value - b.value);
  if (pairs.length === 0) return 0;
  const total = sum(pairs.map((pair) => pair.weight));
  const target = clamp(quantile, 0, 1) * total;
  let cumulative = 0;
  for (const pair of pairs) {
    cumulative += pair.weight;
    if (cumulative >= target) return pair.value;
  }
  return pairs[pairs.length - 1].value;
}

function median(values: number[]): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values: number[]): number {
  return values.length ? sum(values) / values.length : 0;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

function credibleMaxHeartRate(activities: CoachActivitySummary[]): number | undefined {
  const observations: number[] = [];
  for (const activity of activities) {
    if (usefulHeartRate(activity.maxHeartRate)) observations.push(activity.maxHeartRate);
    const stream = activity.streams?.heartRateBpm?.filter(usefulHeartRate) ?? [];
    if (stream.length >= 30) observations.push(weightedQuantile(stream, stream.map(() => 1), 0.995));
  }
  if (!observations.length) return undefined;
  observations.sort((a, b) => a - b);
  const top = observations[observations.length - 1];
  const supporting = observations.filter((value) => value >= top - 4);
  return supporting.length >= 2 ? Math.round(weightedQuantile(supporting, supporting.map(() => 1), 0.75)) : Math.round(top);
}

function durationBucket(durationSec: number): 1 | 2 | 3 {
  if (durationSec <= 360) return 1;
  if (durationSec <= 900) return 2;
  return 3;
}

function nearestEffortDuration(duration: number): number {
  return EFFORT_DURATIONS.reduce((best, candidate) => Math.abs(candidate - duration) < Math.abs(best - duration) ? candidate : best, EFFORT_DURATIONS[0]);
}

function lowerBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function powerZoneIndex(ratio: number): number {
  if (ratio < POWER_ZONE_BOUNDS[0]) return 0;
  if (ratio < POWER_ZONE_BOUNDS[1]) return 1;
  if (ratio < POWER_ZONE_BOUNDS[2]) return 2;
  if (ratio < POWER_ZONE_BOUNDS[3]) return 3;
  return 4;
}

function intervalDuration(start: number, end: number): number | undefined {
  const dt = end - start;
  return Number.isFinite(dt) && dt > 0 && dt <= 30 ? dt : undefined;
}

function scaleRange(range: ZoneRange, scale: number, decimals: number): ZoneRange {
  return {
    low: range.low === undefined ? undefined : round(range.low * scale, decimals),
    high: range.high === undefined ? undefined : round(range.high * scale, decimals),
  };
}

function paceRange(speedRange: ZoneRange, criticalSpeed: number): PaceRange {
  return {
    fastSecPerKm: speedRange.high ? round(1000 / (speedRange.high * criticalSpeed), 0) : undefined,
    slowSecPerKm: speedRange.low ? round(1000 / (speedRange.low * criticalSpeed), 0) : undefined,
  };
}

function normalizeWeekStart(value: string): string {
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid week start: ${value}`);
  const day = date.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + mondayOffset);
  return date.toISOString().slice(0, 10);
}

function addDays(day: string, count: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / DAY_MS);
}

function validCriticalPowerRecord(record: CriticalPowerHistoryRecord): boolean {
  return validDate(record.effectiveFrom)
    && Number.isFinite(record.criticalPowerWatts)
    && record.criticalPowerWatts >= 80
    && record.criticalPowerWatts <= 800
    && record.confidence >= 0
    && record.confidence <= 1;
}

function validDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function isRunLike(activity: CoachActivitySummary): boolean {
  const text = `${activity.sportType} ${activity.name}`.toLowerCase();
  return text.includes('run') && !text.includes('strength');
}

function inferredEvidenceQuality(activity: CoachActivitySummary): number {
  const stream = activity.streams;
  let quality = activity.effortKind === 'race' || activity.effortKind === 'time_trial' ? 0.9 : 0.62;
  if (stream?.timeSec && stream.distanceM && stream.timeSec.length === stream.distanceM.length) quality += 0.12;
  if (stream?.powerWatts && stream.timeSec && stream.powerWatts.length === stream.timeSec.length) quality += 0.08;
  if (activity.movingTimeSec / Math.max(activity.elapsedTimeSec ?? activity.movingTimeSec, 1) < 0.85) quality -= 0.15;
  return clamp(quality, 0.3, 1);
}

function evidenceKindWeight(kind: EvidenceKind): number {
  return { race: 1.5, time_trial: 1.35, workout: 1.12, training: 0.78, incidental: 0.5 }[kind];
}

function dedupeEvidence(evidence: ModelEvidence[]): ModelEvidence[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = `${item.activityId}:${item.durationSec}:${item.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => b.weight - a.weight);
}

function confidenceLevel(score: number): ConfidenceLevel {
  return score >= 0.75 ? 'high' : score >= 0.45 ? 'medium' : 'low';
}

function usefulPower(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 40 && value <= 1200;
}

function usefulHeartRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 70 && value <= 225;
}

function usefulSpeed(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0.8 && value <= 9;
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function finiteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function midpoint(range: ZoneRange | undefined): number | undefined {
  if (!range) return undefined;
  if (isFiniteNumber(range.low) && isFiniteNumber(range.high)) return (range.low + range.high) / 2;
  return range.low ?? range.high;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function round(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function roundOptional(value: number | undefined, decimals: number): number | undefined {
  return value === undefined || !Number.isFinite(value) ? undefined : round(value, decimals);
}

function roundToFive(value: number): number {
  return Math.round(value / 5) * 5;
}

function formatDurationShort(seconds: number): string {
  return seconds >= 3600 ? `${round(seconds / 3600, 1)}h` : `${Math.round(seconds / 60)}m`;
}

function formatPaceFromSpeed(speed: number): string {
  if (!usefulSpeed(speed)) return '-';
  const total = Math.round(1000 / speed);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}/km`;
}

function formatRange(range: ZoneRange, suffix: string): string {
  if (range.low !== undefined && range.high !== undefined) return `${Math.round(range.low)}–${Math.round(range.high)} ${suffix}`;
  if (range.low !== undefined) return `≥${Math.round(range.low)} ${suffix}`;
  if (range.high !== undefined) return `≤${Math.round(range.high)} ${suffix}`;
  return '-';
}

function formatPaceRange(range: PaceRange): string {
  if (range.fastSecPerKm && range.slowSecPerKm) return `${formatPaceSeconds(range.fastSecPerKm)}–${formatPaceSeconds(range.slowSecPerKm)}/km`;
  if (range.fastSecPerKm) return `≤${formatPaceSeconds(range.fastSecPerKm)}/km`;
  if (range.slowSecPerKm) return `≥${formatPaceSeconds(range.slowSecPerKm)}/km`;
  return '-';
}

function formatPaceSeconds(seconds: number): string {
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
}

function formatPercentRange(range: ZoneRange): string {
  if (range.low !== undefined && range.high !== undefined) return `${Math.round(range.low * 100)}–${Math.round(range.high * 100)}% CP`;
  if (range.low !== undefined) return `≥${Math.round(range.low * 100)}% CP`;
  if (range.high !== undefined) return `≤${Math.round(range.high * 100)}% CP`;
  return 'unspecified';
}

function formatOptional(value: number | undefined): string {
  return value === undefined ? 'unknown' : String(round(value, 1));
}

function signed(value: number): string {
  return `${value > 0 ? '+' : ''}${round(value, 1)}`;
}
