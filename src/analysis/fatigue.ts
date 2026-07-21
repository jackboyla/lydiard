import type { FatigueIndicator, Severity, WeeklyAnalysis, WeeklyRunBlock } from '../types';

type Direction = 'higherIsWorse' | 'lowerIsWorse';

interface IndicatorSpec {
  id: string;
  label: string;
  unit: string;
  direction: Direction;
  values: number[];
  current: number;
  formatter: (value: number) => string;
  detail: (args: { deltaPct: number; baseline: number; current: number; score: number }) => string;
  supportingLabel?: string;
}

const WINDOW_SIZE = 8;

export function analyzeWeeks(weeks: WeeklyRunBlock[]): WeeklyAnalysis[] {
  return weeks.map((week, index) => analyzeWeek(weeks, index));
}

export function formatPace(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return '-/km';
  }
  const roundedSeconds = Math.round(totalSeconds);
  const minutes = Math.floor(roundedSeconds / 60);
  const seconds = (roundedSeconds % 60)
    .toString()
    .padStart(2, '0');

  return `${minutes}:${seconds}/km`;
}

export function formatSignedPct(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

function analyzeWeek(weeks: WeeklyRunBlock[], index: number): WeeklyAnalysis {
  const week = weeks[index];
  const baselineWeeks = getBaselineWeeks(weeks, index);
  const hasHeartRate = week.dataCompleteness?.heartRate ?? true;
  const hasCadence = week.dataCompleteness?.cadence ?? true;
  const hasRecovery = week.dataCompleteness?.recovery ?? true;
  const hasStreams = week.dataCompleteness?.streams ?? true;

  const indicators = [
    makeIndicator({
      id: 'stride',
      label: 'Stride length',
      unit: 'cm',
      direction: 'lowerIsWorse',
      values: baselineWeeks.map((item) => item.strideLengthCm),
      current: week.strideLengthCm,
      formatter: (value) => `${Math.round(value)} cm`,
      detail: ({ deltaPct }) =>
        hasCadence
          ? `Stride is ${Math.abs(deltaPct).toFixed(1)}% ${deltaPct < 0 ? 'shorter' : 'longer'} than your current baseline while cadence is ${week.cadenceSpm} spm. That points to ground covered per step, not a generic form rule.`
          : `Cadence was not available in the import, so stride is estimated from pace using a neutral cadence. Treat this as a weak movement-economy proxy until cadence or FIT/stream data is added.`,
      supportingLabel: hasCadence ? `${week.cadenceSpm} spm cadence` : 'cadence unavailable',
    }),
    makeIndicator({
      id: 'decoupling',
      label: hasStreams ? 'HR-pace decoupling' : 'Aerobic cost proxy',
      unit: '%',
      direction: 'higherIsWorse',
      values: baselineWeeks.map((item) => item.hrPaceDecouplingPct),
      current: week.hrPaceDecouplingPct,
      formatter: (value) => `${value.toFixed(1)}%`,
      detail: ({ deltaPct }) =>
        hasStreams
          ? `Cardiac drift is ${Math.abs(deltaPct).toFixed(1)}% ${deltaPct > 0 ? 'above' : 'below'} your rolling pattern after grade correction. This is only weighted heavily when it is unusual for you.`
          : hasHeartRate
            ? `Summary data does not include first-half and second-half streams, so this uses pace per heartbeat as a personal aerobic-cost proxy. It is ${Math.abs(deltaPct).toFixed(1)}% ${deltaPct > 0 ? 'above' : 'below'} your rolling pattern.`
            : `Heart-rate streams were not available, so this signal is pace-derived only. Use it as a broad trend check, not true decoupling.`,
      supportingLabel: hasHeartRate ? `${week.easyHeartRate} bpm easy HR` : 'heart-rate unavailable',
    }),
    makeIndicator({
      id: 'easyPace',
      label: 'Easy pace at fixed HR',
      unit: 'sec/km',
      direction: 'higherIsWorse',
      values: baselineWeeks.map((item) => item.easyPaceSecPerKm),
      current: week.easyPaceSecPerKm,
      formatter: formatPace,
      detail: ({ deltaPct }) =>
        hasHeartRate
          ? `At a familiar easy heart-rate band, pace is ${Math.abs(deltaPct).toFixed(1)}% ${deltaPct > 0 ? 'slower' : 'faster'} than your baseline. This separates fatigue from a hard workout that simply raised HR.`
          : `Heart rate was not available in the import, so easy pace is estimated from your slower aerobic-looking runs. It is ${Math.abs(deltaPct).toFixed(1)}% ${deltaPct > 0 ? 'slower' : 'faster'} than your rolling pace baseline.`,
      supportingLabel: hasHeartRate ? `${week.easyHeartRate} bpm anchor` : 'pace-only anchor',
    }),
    makeIndicator({
      id: 'threshold',
      label: 'LT2 pace estimate',
      unit: 'sec/km',
      direction: 'higherIsWorse',
      values: baselineWeeks.map((item) => item.thresholdPaceSecPerKm),
      current: week.thresholdPaceSecPerKm,
      formatter: formatPace,
      detail: ({ deltaPct }) =>
        `Threshold estimate is ${Math.abs(deltaPct).toFixed(1)}% ${deltaPct > 0 ? 'slower' : 'faster'} than your personal trend. The score stays contextual, so a slow week after a planned downshift is not automatically bad.`,
      supportingLabel: 'modeled from steady efforts',
    }),
    makeIndicator({
      id: 'load',
      label: 'Acute/chronic load',
      unit: 'ratio',
      direction: 'higherIsWorse',
      values: baselineWeeks.map((item) => item.acRatio),
      current: week.acRatio,
      formatter: (value) => value.toFixed(2),
      detail: ({ deltaPct }) =>
        `Recent load pressure is ${Math.abs(deltaPct).toFixed(1)}% ${deltaPct > 0 ? 'above' : 'below'} your rolling norm. This matters most when movement economy and easy pace are also displaced.`,
      supportingLabel: `${Math.round(week.acuteLoad)} acute / ${Math.round(week.chronicLoad)} chronic`,
    }),
    makeIndicator({
      id: 'recovery',
      label: 'Recovery floor',
      unit: 'ms',
      direction: 'lowerIsWorse',
      values: baselineWeeks.map((item) => item.hrvMs),
      current: week.hrvMs,
      formatter: (value) => `${Math.round(value)} ms`,
      detail: ({ deltaPct }) =>
        hasRecovery
          ? `HRV is ${Math.abs(deltaPct).toFixed(1)}% ${deltaPct < 0 ? 'below' : 'above'} your rolling baseline, with average sleep at ${week.sleepHours.toFixed(1)} hours. It is used as a supporting signal, not a diagnosis.`
          : `The imported activity file did not include HRV or sleep, so this recovery signal is held neutral. Add Garmin health data or a recovery CSV later to activate it.`,
      supportingLabel: hasRecovery ? `${week.sleepHours.toFixed(1)} h sleep` : 'not imported',
    }),
  ];

  const riskScore = Math.round(
    indicators.reduce((total, indicator) => {
      const weight =
        indicator.id === 'stride'
          ? 0.24
          : indicator.id === 'decoupling'
            ? 0.2
            : indicator.id === 'easyPace'
              ? 0.2
              : indicator.id === 'threshold'
                ? 0.14
                : indicator.id === 'load'
                  ? 0.14
                  : 0.08;

      return total + indicator.score * weight;
    }, 0),
  );

  const severity = severityFromScore(riskScore);
  const sortedIndicators = [...indicators].sort((a, b) => b.score - a.score);
  const stateLabel =
    severity === 'high' ? 'Fatigue trap likely' : severity === 'watch' ? 'Fatigue pressure building' : 'Stable adaptation';

  const summary =
    severity === 'high'
      ? `${sortedIndicators[0].label} and ${sortedIndicators[1].label} are the clearest deviations from your own recent baseline. The pattern looks like load is being absorbed poorly rather than normal hard training.`
      : severity === 'watch'
        ? `${sortedIndicators[0].label} is drifting from your baseline, but the signal is not yet broad enough to call a trap. Keep the next week honest.`
        : `Most signals are near your current baseline. The load you are carrying looks matched to your recent response.`;

  const recommendation =
    severity === 'high'
      ? 'Bias the next block toward low-strain aerobic volume until stride length and easy-HR pace move back toward baseline.'
      : severity === 'watch'
        ? 'Hold intensity steady and look for a rebound in movement economy before adding another load step.'
        : 'Continue the current build and keep comparing new work against the same rolling baseline.';

  return {
    week,
    baselineWeeks,
    riskScore,
    severity,
    stateLabel,
    summary,
    recommendation,
    indicators,
  };
}

function getBaselineWeeks(weeks: WeeklyRunBlock[], index: number): WeeklyRunBlock[] {
  const previousWeeks = weeks.slice(Math.max(0, index - WINDOW_SIZE), index);

  if (previousWeeks.length >= 4) {
    return previousWeeks;
  }

  return weeks.slice(0, Math.min(WINDOW_SIZE, weeks.length)).filter((item) => item.id !== weeks[index].id);
}

function makeIndicator(spec: IndicatorSpec): FatigueIndicator {
  const baseline = median(spec.values);
  const spread = robustSpread(spec.values, baseline);
  const signedBadDelta = spec.direction === 'higherIsWorse' ? spec.current - baseline : baseline - spec.current;
  const badDeltaPct = baseline === 0 ? 0 : (signedBadDelta / Math.abs(baseline)) * 100;
  const zScore = signedBadDelta / spread;
  const score = clamp(Math.round(Math.max(0, zScore) * 32 + Math.max(0, badDeltaPct - 1) * 2.2), 0, 100);
  const rawDeltaPct = baseline === 0 ? 0 : ((spec.current - baseline) / Math.abs(baseline)) * 100;

  return {
    id: spec.id,
    label: spec.label,
    unit: spec.unit,
    current: spec.current,
    baseline,
    deltaPct: rawDeltaPct,
    score,
    severity: severityFromScore(score),
    valueLabel: spec.formatter(spec.current),
    baselineLabel: spec.formatter(baseline),
    deltaLabel: `${formatSignedPct(rawDeltaPct)} vs baseline`,
    detail: spec.detail({
      deltaPct: rawDeltaPct,
      baseline,
      current: spec.current,
      score,
    }),
    supportingLabel: spec.supportingLabel,
  };
}

function severityFromScore(score: number): Severity {
  if (score >= 60) {
    return 'high';
  }

  if (score >= 35) {
    return 'watch';
  }

  return 'steady';
}

export function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[midpoint - 1] + sorted[midpoint]) / 2;
  }

  return sorted[midpoint];
}

export function robustSpread(values: number[], baseline: number): number {
  if (values.length < 2) {
    return Math.max(Math.abs(baseline) * 0.02, 1);
  }

  const deviations = values.map((value) => Math.abs(value - baseline));
  const mad = median(deviations) * 1.4826;
  const minimumUsefulSpread = Math.max(Math.abs(baseline) * 0.015, 0.2);

  return Math.max(mad, minimumUsefulSpread);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
