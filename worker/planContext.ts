// Builds a compact, LLM-friendly training bundle for the agent `plan-context`
// endpoint — everything ChatGPT needs to reason about injury risk and propose
// the next 1–3 weeks in a single call. Pure function.

import type { WeeklyAnalysis } from '../src/types';

export interface PlanContext {
  generatedAt: string;
  athlete: { name: string | null };
  range: { from: string | null; to: string | null; weeks: number };
  current: {
    weekStart: string;
    label: string;
    riskScore: number;
    severity: string;
    stateLabel: string;
    summary: string;
    recommendation: string;
    topIndicators: Array<{
      id: string;
      label: string;
      valueLabel: string;
      baselineLabel: string;
      deltaLabel: string;
      score: number;
      severity: string;
      detail: string;
    }>;
  } | null;
  loadStatus: { acuteLoad: number; chronicLoad: number; acRatio: number; interpretation: string } | null;
  summary: {
    totalDistanceKm: number;
    totalDurationHours: number;
    weeks: number;
    avgWeeklyKm: number;
    longestRunKm: number;
    avgTrainingLoad: number;
  };
  weeklyTrend: Array<{
    weekStart: string;
    label: string;
    distanceKm: number;
    durationHours: number;
    trainingLoad: number;
    acRatio: number;
    easyPaceSecPerKm: number;
    thresholdPaceSecPerKm: number;
    hrPaceDecouplingPct: number;
    strideLengthCm: number;
    cadenceSpm: number;
    hrvMs: number;
    sleepHours: number;
    qualitySessions: number;
    longRunKm: number;
    riskScore: number;
    severity: string;
    streamsBacked: boolean;
  }>;
  indicatorGuide: Record<string, string>;
  instructions: string;
}

const INDICATOR_GUIDE: Record<string, string> = {
  stride: 'Ground covered per step (cm), from pace and cadence. A drop vs the runner\'s baseline suggests neuromuscular fatigue.',
  decoupling: 'HR-pace decoupling (%). Higher than the runner\'s norm suggests cardiac drift / aerobic cost rising.',
  easyPace: 'Easy pace at a fixed easy heart rate. Slower than baseline suggests aerobic fatigue.',
  threshold: 'Threshold (LT2) pace estimate. Slower than the personal trend suggests reduced high-end fitness.',
  load: 'Acute/chronic workload ratio. Well above the personal norm (roughly >1.4) is a classic injury-risk spike.',
  recovery: 'HRV and sleep floor — a supporting recovery signal, low-weighted.',
};

const INSTRUCTIONS =
  'You are analyzing ONE runner against their own rolling baselines (not population norms). ' +
  'Use `current` (latest-week risk) and week-over-week deviations in `weeklyTrend` to judge injury risk, ' +
  'paying attention to acute/chronic ratio, stride-length drops, easy-pace and decoupling drift. ' +
  'Then propose a specific plan for the next 1–3 weeks: target weekly volume (km), number of quality sessions, ' +
  'long-run distance, and recovery guidance. Progress conservatively when severity is "watch" or "high", ' +
  'and keep the acute/chronic ratio in a safe range (~0.8–1.3).';

function within(weekStart: string, from: string | null, to: string | null): boolean {
  if (from && weekStart < from) {
    return false;
  }
  if (to && weekStart > to) {
    return false;
  }
  return true;
}

function interpretAcwr(ratio: number): string {
  if (ratio >= 1.5) {
    return 'High spike — acute load well above chronic; elevated injury risk.';
  }
  if (ratio > 1.3) {
    return 'Load rising faster than the chronic base; monitor closely.';
  }
  if (ratio < 0.8) {
    return 'Detraining / taper — acute load below chronic base.';
  }
  return 'Balanced — acute load matched to the chronic base.';
}

export function buildPlanContext(
  analyses: WeeklyAnalysis[],
  athleteName: string | null,
  from: string | null,
  to: string | null,
  generatedAt: string,
): PlanContext {
  // With no range, default to the last 12 weeks (keeps the payload small for
  // agents fetching the whole JSON). A from/to narrows or widens it explicitly.
  const hasRange = Boolean(from || to);
  const inRange = hasRange
    ? analyses.filter((analysis) => within(analysis.week.weekStart, from, to))
    : analyses.slice(-12);
  const scoped = inRange.length > 0 ? inRange : analyses.slice(-12);
  const latest = analyses[analyses.length - 1] ?? null;

  const totalDistanceKm = scoped.reduce((total, a) => total + a.week.distanceKm, 0);
  const totalDurationHours = Number(scoped.reduce((total, a) => total + a.week.durationHours, 0).toFixed(1));
  const longestRunKm = scoped.reduce((max, a) => Math.max(max, a.week.longRunKm), 0);
  const avgTrainingLoad = scoped.length
    ? Math.round(scoped.reduce((total, a) => total + a.week.trainingLoad, 0) / scoped.length)
    : 0;

  return {
    generatedAt,
    athlete: { name: athleteName },
    range: { from, to, weeks: scoped.length },
    current: latest
      ? {
          weekStart: latest.week.weekStart,
          label: latest.week.label,
          riskScore: latest.riskScore,
          severity: latest.severity,
          stateLabel: latest.stateLabel,
          summary: latest.summary,
          recommendation: latest.recommendation,
          topIndicators: [...latest.indicators]
            .sort((a, b) => b.score - a.score)
            .slice(0, 3)
            .map((indicator) => ({
              id: indicator.id,
              label: indicator.label,
              valueLabel: indicator.valueLabel,
              baselineLabel: indicator.baselineLabel,
              deltaLabel: indicator.deltaLabel,
              score: indicator.score,
              severity: indicator.severity,
              detail: indicator.detail,
            })),
        }
      : null,
    loadStatus: latest
      ? {
          acuteLoad: latest.week.acuteLoad,
          chronicLoad: latest.week.chronicLoad,
          acRatio: latest.week.acRatio,
          interpretation: interpretAcwr(latest.week.acRatio),
        }
      : null,
    summary: {
      totalDistanceKm: Math.round(totalDistanceKm),
      totalDurationHours,
      weeks: scoped.length,
      avgWeeklyKm: scoped.length ? Math.round(totalDistanceKm / scoped.length) : 0,
      longestRunKm,
      avgTrainingLoad,
    },
    weeklyTrend: scoped.map((analysis) => ({
      weekStart: analysis.week.weekStart,
      label: analysis.week.label,
      distanceKm: analysis.week.distanceKm,
      durationHours: analysis.week.durationHours,
      trainingLoad: analysis.week.trainingLoad,
      acRatio: analysis.week.acRatio,
      easyPaceSecPerKm: analysis.week.easyPaceSecPerKm,
      thresholdPaceSecPerKm: analysis.week.thresholdPaceSecPerKm,
      hrPaceDecouplingPct: analysis.week.hrPaceDecouplingPct,
      strideLengthCm: analysis.week.strideLengthCm,
      cadenceSpm: analysis.week.cadenceSpm,
      hrvMs: analysis.week.hrvMs,
      sleepHours: analysis.week.sleepHours,
      qualitySessions: analysis.week.qualitySessions,
      longRunKm: analysis.week.longRunKm,
      riskScore: analysis.riskScore,
      severity: analysis.severity,
      streamsBacked: analysis.week.dataCompleteness?.streams ?? false,
    })),
    indicatorGuide: INDICATOR_GUIDE,
    instructions: INSTRUCTIONS,
  };
}
