// Pure, runtime-agnostic overnight-recovery analysis.
//
// Like ./fatigue and ../data/deriveWeekly, this module has NO browser or Node
// dependencies so it runs unchanged in the Cloudflare Worker and the frontend.
// It turns a series of RAW nightly RecoveryObservations into per-day derived
// state: personal baselines (median + MAD), directional deviations, per-signal
// abnormality, and a latent RecoveryState that respects the "don't panic on one
// bad night" rule from the coaching design.
//
// Everything is normalized to the runner's OWN rolling baseline — never to
// population thresholds — except SpO₂, where an absolute floor is more sensible.

import type { RecoveryObservation, RecoveryState } from '../types';
import { median, robustSpread } from './fatigue';

/** Rolling window of prior nights used to build a personal baseline. */
export const BASELINE_NIGHTS = 28;
/** Minimum prior samples before a metric's deviation is trusted. */
const MIN_BASELINE = 7;
/** Consecutive-abnormal-night window the multi-day escalation looks back over. */
const STREAK_LOOKBACK = 6;

export type RecoveryConfidence = 'low' | 'medium' | 'high';
export type SignalStatus = 'normal' | 'mild' | 'strong' | 'unknown';
export type ReadinessCrossCheck = 'agree' | 'disagree' | 'unknown';

/** The six same-night signals that drive the acute state. */
export interface RecoverySignals {
  hrv: SignalStatus; // lower is worse
  restingHr: SignalStatus; // higher is worse
  skinTemp: SignalStatus; // higher is worse (illness)
  respiration: SignalStatus; // higher is worse (illness)
  spo2: SignalStatus; // lower is worse (absolute floor)
  sleep: SignalStatus; // shorter than baseline is worse
}

export interface RecoveryBaselines {
  hrvMs?: number;
  restingHrBpm?: number;
  skinTempDeltaC?: number;
  respiratoryRate?: number;
  sleepDurationMin?: number;
  /** Number of valid prior HRV nights the baseline was built from. */
  nights: number;
}

export interface RecoveryDeviations {
  hrvVsBaselinePct?: number; // negative = below personal baseline (worse)
  rhrVsBaselineBpm?: number; // positive = elevated (worse)
  skinTempZscore?: number; // positive = warmer than baseline (worse)
  respRateZscore?: number; // positive = faster than baseline (worse)
  sleepDebt7dMin?: number; // rolling 7-night sleep debt vs baseline (>= 0)
}

export interface RecoveryDaily {
  observation: RecoveryObservation;
  day: string;
  baselines: RecoveryBaselines;
  deviations: RecoveryDeviations;
  signals: RecoverySignals;
  abnormalSignalCount: number;
  strongSignalCount: number;
  /** temp↑ + respiration↑ + (RHR↑ or SpO₂ abnormal): a systemic illness pattern. */
  illnessPattern: boolean;
  /** Same-night severity, before multi-day smoothing. */
  acuteState: RecoveryState;
  /** Actionable latent state: single bad nights are held back; persistence escalates. */
  state: RecoveryState;
  /** Consecutive calendar-adjacent days (ending today) at suppressed+ actionable state. */
  suppressedStreak: number;
  confidence: RecoveryConfidence;
  readinessCrossCheck: ReadinessCrossCheck;
  reasons: string[];
  interpretation: string;
}

export interface RecoverySummary {
  asOf: string | null;
  state: RecoveryState | null;
  confidence: RecoveryConfidence | null;
  /** Consecutive days at suppressed+ ending on the latest record. */
  suppressedStreak: number;
  /** Illness pattern on the latest night or the one before it. */
  systemicIllnessSignal: boolean;
  readinessCrossCheck: ReadinessCrossCheck;
  reasons: string[];
  interpretation: string;
  /** Latest-first list of {day, state} for a compact trend. */
  trend: Array<{ day: string; state: RecoveryState }>;
}

const STATE_RANK: Record<RecoveryState, number> = {
  recovered: 0,
  normal: 0,
  slightly_suppressed: 1,
  suppressed: 2,
  high_stress: 3,
};

// ---------------------------------------------------------------------------

export function analyzeRecovery(input: RecoveryObservation[]): RecoveryDaily[] {
  const records = dedupeSortedByDay(input);

  // Pass 1: per-day baseline, deviations, signals, acute state (causal — each
  // day is compared only to its own prior nights).
  const first = records.map((observation, index) => {
    const window = records.slice(Math.max(0, index - BASELINE_NIGHTS), index);
    return computeDay(observation, window);
  });

  // Pass 2: forward walk so persistence (streaks, sleep debt) can look back at
  // already-finalized days.
  const result: RecoveryDaily[] = [];
  for (let index = 0; index < first.length; index += 1) {
    result.push(finalizeDay(first[index], result));
  }
  return result;
}

export function latestRecovery(dailies: RecoveryDaily[]): RecoveryDaily | null {
  return dailies.length > 0 ? dailies[dailies.length - 1] : null;
}

export function summarizeRecovery(dailies: RecoveryDaily[]): RecoverySummary {
  const latest = latestRecovery(dailies);
  if (!latest) {
    return {
      asOf: null,
      state: null,
      confidence: null,
      suppressedStreak: 0,
      systemicIllnessSignal: false,
      readinessCrossCheck: 'unknown',
      reasons: [],
      interpretation: 'No overnight recovery data yet.',
      trend: [],
    };
  }
  const previous = dailies.length >= 2 ? dailies[dailies.length - 2] : null;
  const systemicIllnessSignal =
    latest.illnessPattern || (previous ? previous.illnessPattern && isAdjacent(previous.day, latest.day) : false);
  return {
    asOf: latest.day,
    state: latest.state,
    confidence: latest.confidence,
    suppressedStreak: latest.suppressedStreak,
    systemicIllnessSignal,
    readinessCrossCheck: latest.readinessCrossCheck,
    reasons: latest.reasons,
    interpretation: latest.interpretation,
    trend: dailies
      .slice(-7)
      .reverse()
      .map((daily) => ({ day: daily.day, state: daily.state })),
  };
}

// --- pass 1 -----------------------------------------------------------------

interface PartialDay {
  observation: RecoveryObservation;
  day: string;
  baselines: RecoveryBaselines;
  deviations: Omit<RecoveryDeviations, 'sleepDebt7dMin'>;
  signals: RecoverySignals;
  abnormalSignalCount: number;
  strongSignalCount: number;
  illnessPattern: boolean;
  acuteState: RecoveryState;
  /** Tonight's shortfall vs baseline sleep (>= 0), for the 7-day debt roll-up. */
  sleepShortfallMin?: number;
  hrvBaselineNights: number;
  coreMetricsPresent: number; // of {hrv, rhr, sleep}
  extraMetricsPresent: number; // of {skinTemp, respiration, spo2}
}

function computeDay(observation: RecoveryObservation, window: RecoveryObservation[]): PartialDay {
  const hrvBase = baselineFor(window, (obs) => obs.hrvRmssdMs);
  const rhrBase = baselineFor(window, (obs) => obs.restingHrBpm);
  const tempBase = baselineFor(window, (obs) => obs.skinTempDeltaC);
  const respBase = baselineFor(window, (obs) => obs.respiratoryRate);
  const sleepBase = baselineFor(window, (obs) => obs.sleepDurationMin);

  // Directed z-scores: positive always means "worse than personal baseline".
  const hrvZ = directedZ(observation.hrvRmssdMs, hrvBase, 'lower');
  const rhrZ = directedZ(observation.restingHrBpm, rhrBase, 'higher');
  const tempZ = directedZ(observation.skinTempDeltaC, tempBase, 'higher');
  const respZ = directedZ(observation.respiratoryRate, respBase, 'higher');
  const sleepZ = directedZ(observation.sleepDurationMin, sleepBase, 'lower');

  const signals: RecoverySignals = {
    hrv: statusFromZ(hrvZ),
    restingHr: statusFromZ(rhrZ),
    skinTemp: statusFromZ(tempZ),
    respiration: statusFromZ(respZ),
    spo2: spo2Status(observation.spo2Avg, observation.spo2Low),
    sleep: statusFromZ(sleepZ),
  };

  const statuses = Object.values(signals);
  const abnormalSignalCount = statuses.filter((status) => status === 'mild' || status === 'strong').length;
  const strongSignalCount = statuses.filter((status) => status === 'strong').length;

  const illnessPattern =
    isAbnormal(signals.skinTemp) &&
    isAbnormal(signals.respiration) &&
    (isAbnormal(signals.restingHr) || isAbnormal(signals.spo2));

  const deviations = {
    hrvVsBaselinePct: pct(observation.hrvRmssdMs, hrvBase?.baseline),
    rhrVsBaselineBpm: diff(observation.restingHrBpm, rhrBase?.baseline),
    skinTempZscore: rawZ(observation.skinTempDeltaC, tempBase),
    respRateZscore: rawZ(observation.respiratoryRate, respBase),
  };

  const acuteState = acuteStateFrom(
    { abnormalSignalCount, strongSignalCount, illnessPattern },
    deviations.hrvVsBaselinePct,
    signals.sleep,
  );

  const sleepShortfallMin =
    observation.sleepDurationMin !== undefined && sleepBase !== undefined
      ? Math.max(0, Math.round(sleepBase.baseline - observation.sleepDurationMin))
      : undefined;

  return {
    observation,
    day: observation.day,
    baselines: {
      hrvMs: hrvBase?.baseline,
      restingHrBpm: rhrBase?.baseline,
      skinTempDeltaC: tempBase?.baseline,
      respiratoryRate: respBase?.baseline,
      sleepDurationMin: sleepBase?.baseline,
      nights: hrvBase?.count ?? 0,
    },
    deviations,
    signals,
    abnormalSignalCount,
    strongSignalCount,
    illnessPattern,
    acuteState,
    sleepShortfallMin,
    hrvBaselineNights: hrvBase?.count ?? 0,
    coreMetricsPresent: countPresent([observation.hrvRmssdMs, observation.restingHrBpm, observation.sleepDurationMin]),
    extraMetricsPresent: countPresent([
      observation.skinTempDeltaC,
      observation.respiratoryRate,
      observation.spo2Avg ?? observation.spo2Low,
    ]),
  };
}

// --- pass 2 -----------------------------------------------------------------

function finalizeDay(day: PartialDay, prior: RecoveryDaily[]): RecoveryDaily {
  const previous = prior.length > 0 ? prior[prior.length - 1] : null;

  // Consecutive calendar-adjacent nights that were themselves abnormal.
  const abnormalStreak =
    previous && isAdjacent(previous.day, day.day) && STATE_RANK[previous.acuteState] >= 1
      ? previousAbnormalStreak(prior) + 1
      : STATE_RANK[day.acuteState] >= 1
        ? 1
        : 0;

  const state = actionableState(day.acuteState, day.illnessPattern, abnormalStreak);

  const suppressedStreak =
    STATE_RANK[state] >= 2
      ? previous && isAdjacent(previous.day, day.day) && STATE_RANK[previous.state] >= 2
        ? previous.suppressedStreak + 1
        : 1
      : 0;

  const sleepDebt7dMin = rollingSleepDebt(day, prior);
  const deviations: RecoveryDeviations = { ...day.deviations, sleepDebt7dMin };

  const confidence = confidenceFrom(day);
  const readinessCrossCheck = crossCheckReadiness(state, day.observation.readinessScore);
  const reasons = buildReasons(day, deviations, abnormalStreak);
  const interpretation = interpret(state, day.illnessPattern, abnormalStreak, confidence);

  return {
    observation: day.observation,
    day: day.day,
    baselines: day.baselines,
    deviations,
    signals: day.signals,
    abnormalSignalCount: day.abnormalSignalCount,
    strongSignalCount: day.strongSignalCount,
    illnessPattern: day.illnessPattern,
    acuteState: day.acuteState,
    state,
    suppressedStreak,
    confidence,
    readinessCrossCheck,
    reasons,
    interpretation,
  };
}

/** Walk back over already-finalized days counting the acute-abnormal run. */
function previousAbnormalStreak(prior: RecoveryDaily[]): number {
  let streak = 0;
  for (let index = prior.length - 1; index >= 0; index -= 1) {
    const current = prior[index];
    const next = index + 1 < prior.length ? prior[index + 1] : null;
    if (STATE_RANK[current.acuteState] < 1) break;
    if (next && !isAdjacent(current.day, next.day)) break;
    streak += 1;
    if (streak >= STREAK_LOOKBACK) break;
  }
  return streak;
}

/**
 * The core "don't panic on one HRV number" rule. A single abnormal night is
 * capped at slightly_suppressed; a systemic illness pattern is the one thing
 * acted on immediately; persistence (consecutive abnormal nights) is what earns
 * a suppressed/high_stress call.
 */
function actionableState(acute: RecoveryState, illnessPattern: boolean, abnormalStreak: number): RecoveryState {
  if (illnessPattern) return 'high_stress';
  if (abnormalStreak <= 1) {
    return STATE_RANK[acute] >= 1 ? 'slightly_suppressed' : acute;
  }
  const escalated = STATE_RANK[acute] + Math.min(2, abnormalStreak - 1);
  if (escalated >= 5) return 'high_stress';
  if (escalated >= 3) return 'suppressed';
  if (escalated >= 2) return 'slightly_suppressed';
  return acute;
}

function acuteStateFrom(
  breadth: { abnormalSignalCount: number; strongSignalCount: number; illnessPattern: boolean },
  hrvVsBaselinePct: number | undefined,
  sleepStatus: SignalStatus,
): RecoveryState {
  if (breadth.illnessPattern) return 'high_stress';
  if (breadth.strongSignalCount >= 2 || breadth.abnormalSignalCount >= 3) return 'high_stress';
  if (breadth.strongSignalCount >= 1 || breadth.abnormalSignalCount >= 2) return 'suppressed';
  if (breadth.abnormalSignalCount >= 1) return 'slightly_suppressed';
  // No abnormal signals: distinguish clearly-recovered from merely normal.
  const wellRested = sleepStatus === 'normal';
  if (hrvVsBaselinePct !== undefined && hrvVsBaselinePct >= 5 && wellRested) return 'recovered';
  return 'normal';
}

function rollingSleepDebt(day: PartialDay, prior: RecoveryDaily[]): number | undefined {
  const shortfalls: number[] = [];
  if (day.sleepShortfallMin !== undefined) shortfalls.push(day.sleepShortfallMin);
  let expected = day.day;
  for (let index = prior.length - 1; index >= 0 && shortfalls.length < 7; index -= 1) {
    expected = previousCalendarDay(expected);
    const candidate = prior[index];
    if (candidate.day !== expected) break; // gap in the calendar ends the window
    const shortfall = sleepShortfallOf(candidate);
    if (shortfall !== undefined) shortfalls.push(shortfall);
  }
  if (shortfalls.length === 0) return undefined;
  return Math.round(shortfalls.reduce((total, value) => total + value, 0) / shortfalls.length);
}

function sleepShortfallOf(daily: RecoveryDaily): number | undefined {
  const actual = daily.observation.sleepDurationMin;
  const baseline = daily.baselines.sleepDurationMin;
  if (actual === undefined || baseline === undefined) return undefined;
  return Math.max(0, Math.round(baseline - actual));
}

function confidenceFrom(day: PartialDay): RecoveryConfidence {
  if (day.coreMetricsPresent >= 3 && day.extraMetricsPresent >= 1 && day.hrvBaselineNights >= 14) return 'high';
  if (day.coreMetricsPresent >= 2 && day.hrvBaselineNights >= MIN_BASELINE) return 'medium';
  return 'low';
}

function crossCheckReadiness(state: RecoveryState, readinessScore: number | undefined): ReadinessCrossCheck {
  if (readinessScore === undefined) return 'unknown';
  const actualBucket = readinessScore < 45 ? 0 : readinessScore <= 65 ? 1 : 2;
  const expectedBucket = STATE_RANK[state] >= 2 ? 0 : state === 'recovered' ? 2 : 1;
  return Math.abs(actualBucket - expectedBucket) >= 2 ? 'disagree' : 'agree';
}

function buildReasons(day: PartialDay, deviations: RecoveryDeviations, abnormalStreak: number): string[] {
  const reasons: string[] = [];
  if (isAbnormal(day.signals.hrv) && deviations.hrvVsBaselinePct !== undefined) {
    reasons.push(`HRV ${signPct(deviations.hrvVsBaselinePct)} vs baseline`);
  }
  if (isAbnormal(day.signals.restingHr) && deviations.rhrVsBaselineBpm !== undefined) {
    reasons.push(`resting HR ${signBpm(deviations.rhrVsBaselineBpm)}`);
  }
  if (isAbnormal(day.signals.skinTemp) && deviations.skinTempZscore !== undefined) {
    reasons.push(`skin temp +${deviations.skinTempZscore.toFixed(1)}σ`);
  }
  if (isAbnormal(day.signals.respiration) && deviations.respRateZscore !== undefined) {
    reasons.push(`respiration +${deviations.respRateZscore.toFixed(1)}σ`);
  }
  if (isAbnormal(day.signals.spo2)) {
    const spo2 = day.observation.spo2Avg ?? day.observation.spo2Low;
    reasons.push(spo2 !== undefined ? `SpO₂ ${spo2.toFixed(0)}%` : 'SpO₂ abnormal');
  }
  if (isAbnormal(day.signals.sleep)) reasons.push('slept below baseline');
  if (deviations.sleepDebt7dMin !== undefined && deviations.sleepDebt7dMin >= 45) {
    reasons.push(`${deviations.sleepDebt7dMin} min/night sleep debt (7d)`);
  }
  if (day.illnessPattern) reasons.push('illness pattern: temperature + respiration + autonomic');
  if (abnormalStreak >= 2) reasons.push(`${abnormalStreak} consecutive suppressed nights`);
  return reasons;
}

function interpret(
  state: RecoveryState,
  illnessPattern: boolean,
  abnormalStreak: number,
  confidence: RecoveryConfidence,
): string {
  const hedge = confidence === 'low' ? ' (low confidence — limited data)' : '';
  if (illnessPattern) {
    return `Systemic stress with an illness-pattern signal (skin temperature, respiration, and autonomic markers elevated together)${hedge}.`;
  }
  switch (state) {
    case 'high_stress':
      return `High systemic stress: multiple recovery markers suppressed together${abnormalStreak >= 2 ? ` across ${abnormalStreak} nights` : ''}${hedge}.`;
    case 'suppressed':
      return `Autonomic recovery suppressed for ${Math.max(1, abnormalStreak)} night(s) (HRV/resting-HR below personal baseline)${hedge}.`;
    case 'slightly_suppressed':
      return `Mild overnight suppression — one signal off baseline; watch tomorrow before reacting${hedge}.`;
    case 'recovered':
      return 'Overnight recovery above personal baseline.';
    default:
      return `Overnight recovery near personal baseline${hedge}.`;
  }
}

// --- baseline / stats helpers -----------------------------------------------

interface Baseline {
  baseline: number;
  spread: number;
  count: number;
}

function baselineFor(window: RecoveryObservation[], pick: (obs: RecoveryObservation) => number | undefined): Baseline | undefined {
  const values = window.map(pick).filter(isFiniteNumber);
  if (values.length < MIN_BASELINE) return undefined;
  const baseline = median(values);
  return { baseline, spread: robustSpread(values, baseline), count: values.length };
}

function directedZ(value: number | undefined, baseline: Baseline | undefined, worse: 'higher' | 'lower'): number | undefined {
  if (value === undefined || baseline === undefined) return undefined;
  const z = (value - baseline.baseline) / baseline.spread;
  return worse === 'higher' ? z : -z;
}

function rawZ(value: number | undefined, baseline: Baseline | undefined): number | undefined {
  if (value === undefined || baseline === undefined) return undefined;
  return (value - baseline.baseline) / baseline.spread;
}

function statusFromZ(directed: number | undefined): SignalStatus {
  if (directed === undefined) return 'unknown';
  if (directed >= 2) return 'strong';
  if (directed >= 1) return 'mild';
  return 'normal';
}

function spo2Status(avg: number | undefined, low: number | undefined): SignalStatus {
  if (avg === undefined && low === undefined) return 'unknown';
  if ((avg !== undefined && avg < 90) || (low !== undefined && low < 87)) return 'strong';
  if ((avg !== undefined && avg < 92) || (low !== undefined && low < 90)) return 'mild';
  return 'normal';
}

function isAbnormal(status: SignalStatus): boolean {
  return status === 'mild' || status === 'strong';
}

function pct(value: number | undefined, baseline: number | undefined): number | undefined {
  if (value === undefined || baseline === undefined || baseline === 0) return undefined;
  return Number((((value - baseline) / Math.abs(baseline)) * 100).toFixed(1));
}

function diff(value: number | undefined, baseline: number | undefined): number | undefined {
  if (value === undefined || baseline === undefined) return undefined;
  return Number((value - baseline).toFixed(1));
}

// --- generic helpers --------------------------------------------------------

function dedupeSortedByDay(input: RecoveryObservation[]): RecoveryObservation[] {
  const byDay = new Map<string, RecoveryObservation>();
  for (const observation of input) {
    if (observation && typeof observation.day === 'string') byDay.set(observation.day, observation);
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

function countPresent(values: Array<number | undefined>): number {
  return values.filter(isFiniteNumber).length;
}

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function signPct(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(0)}%`;
}

function signBpm(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(0)} bpm`;
}

function previousCalendarDay(day: string): string {
  const time = Date.parse(`${day}T00:00:00Z`) - 86_400_000;
  return new Date(time).toISOString().slice(0, 10);
}

function isAdjacent(earlier: string, later: string): boolean {
  return previousCalendarDay(later) === earlier;
}
