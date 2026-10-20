import type { CoachActivitySummary } from './coachEngine';

export const HEART_RATE_DURATIONS = [1, 5, 10, 30, 60, 120, 300, 600, 1200, 1800, 3600] as const;
export type HeartRatePeriod = 30 | 60 | 90;
export interface HeartRateDurationPoint {
  periodDays: HeartRatePeriod;
  /** A sample uses the 1s chart position, without claiming a held duration. */
  measurement: 'sample' | 'rolling';
  durationSec: number;
  bpm: number;
  activityId: string;
  activityName: string;
  activityDate: string;
  ageDays: number;
  startSec: number;
  endSec: number;
}
export interface HeartRateDurationProfile {
  points: HeartRateDurationPoint[];
  maxObserved?: {
    bpm: number;
    measurement: 'sample';
    durationSec: 0;
    confidence: 'single_run' | 'repeated';
    supportingRuns: HeartRateDurationPoint[];
  };
  rawMaxBpm?: number;
  excludedSamples: number;
  explanation: string;
}

/** Elapsed-time windows, without bridging pauses or missing HR. No summary maxima. */
export function buildHeartRateDurationProfile(
  activities: CoachActivitySummary[],
  asOf: string,
  maxLookbackDays = 90,
): HeartRateDurationProfile {
  const now = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(asOf) ? `${asOf}T23:59:59.999Z` : asOf);
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
  const inPeriod = (date: string, days: number) => Date.parse(date) >= dayStart - (days - 1) * 86_400_000 && Date.parse(date) <= now;
  const records: HeartRateDurationPoint[] = [];
  const peaks: HeartRateDurationPoint[] = [];
  let rawMaxBpm: number | undefined;
  let excludedSamples = 0;
  for (const activity of activities) {
    const ageMs = now - Date.parse(activity.startDate);
    if (!Number.isFinite(ageMs) || ageMs < 0 || !inPeriod(activity.startDate, Math.max(90, maxLookbackDays)) || !/run|treadmill/i.test(activity.sportType)) continue;
    const rawTime = activity.streams?.timeSec;
    const rawHeartRate = activity.streams?.heartRateBpm;
    if (!rawTime || !rawHeartRate) continue;
    // Garmin streams can lose one trailing value while their parallel time
    // stream remains intact. Use their shared prefix instead of discarding an
    // otherwise valid run.
    const sharedLength = Math.min(rawTime.length, rawHeartRate.length);
    if (sharedLength < 2) continue;
    const time = rawTime.slice(0, sharedLength);
    const hr = rawHeartRate.slice(0, sharedLength);
    if (time.some((t, i) => !Number.isFinite(t) || t < 0 || (i > 0 && t <= time[i - 1]))) continue;
    const span = Math.floor(time[time.length - 1] - time[0]);
    if (span < 0 || span > 86_400) continue;
    const clean = hr.map((value, i) => {
      if (Number.isFinite(value) && value > 0) rawMaxBpm = Math.max(rawMaxBpm ?? 0, value);
      if (!Number.isFinite(value) || value < 35 || value > 230) { excludedSamples++; return NaN; }
      // Five-sample median removes brief high artifacts while retaining sustained peaks.
      const nearby = hr.slice(Math.max(0, i - 2), i + 3).filter((v, j) => {
        const index = Math.max(0, i - 2) + j;
        return Number.isFinite(v) && v >= 35 && v <= 230 && Math.abs(time[index] - time[i]) <= 10;
      }).sort((a, b) => a - b);
      const median = nearby[Math.floor(nearby.length / 2)];
      if (nearby.length >= 3 && value > median + 15) { excludedSamples++; return NaN; }
      return value;
    });
    const seconds = new Float64Array(span).fill(NaN);
    for (let i = 0; i < time.length - 1; i++) {
      const gap = time[i + 1] - time[i];
      if (gap > 5 || !Number.isFinite(clean[i]) || !Number.isFinite(clean[i + 1])) continue;
      for (let s = Math.ceil(time[i] - time[0]); s < Math.min(span, time[i + 1] - time[0]); s++) seconds[s] = clean[i];
    }
    const sum = new Float64Array(span + 1);
    const missing = new Uint32Array(span + 1);
    for (let s = 0; s < span; s++) {
      sum[s + 1] = sum[s] + (Number.isFinite(seconds[s]) ? seconds[s] : 0);
      missing[s + 1] = missing[s] + (Number.isFinite(seconds[s]) ? 0 : 1);
    }
    const makePoint = (durationSec: number, start: number, bpm: number): HeartRateDurationPoint => ({
      periodDays: 90, measurement: 'rolling', durationSec, bpm: Math.round(bpm * 10) / 10, activityId: activity.id,
      activityName: activity.name, activityDate: activity.startDate, ageDays: Math.floor(ageMs / 86_400_000),
      startSec: time[0] + start, endSec: time[0] + start + durationSec,
    });
    // A raw peak may last one sample. Require readings within 5 bpm in the
    // surrounding five seconds, rather than averaging the peak away.
    let peakIndex = -1;
    for (let i = 0; i < clean.length; i++) {
      if (!Number.isFinite(clean[i])) continue;
      let before = 0;
      let after = 0;
      for (let j = i - 1; j >= 0 && time[i] - time[j] <= 5; j--) {
        if (Number.isFinite(clean[j]) && Math.abs(clean[j] - clean[i]) <= 5) before++;
      }
      for (let j = i + 1; j < clean.length && time[j] - time[i] <= 5; j++) {
        if (Number.isFinite(clean[j]) && Math.abs(clean[j] - clean[i]) <= 5) after++;
      }
      const supported = (before >= 1 && after >= 1)
        || (i === clean.length - 1 && before >= 2)
        || (i === 0 && after >= 2);
      if (supported && (peakIndex < 0 || clean[i] > clean[peakIndex])) peakIndex = i;
    }
    if (peakIndex >= 0) {
      const streamPeak = clean[peakIndex];
      const summaryPeak = activity.maxHeartRate;
      const supportedSummaryPeak = Number.isFinite(summaryPeak)
        && summaryPeak! >= 35
        && summaryPeak! <= 230
        && summaryPeak! >= streamPeak
        && summaryPeak! - streamPeak <= 5;
      // Garmin's activity summary may retain the full-resolution maximum even
      // when the stored stream has been decimated. Accept it only when nearby
      // stream samples independently support a value within 5 bpm.
      const peakBpm = supportedSummaryPeak ? summaryPeak! : streamPeak;
      if (Number.isFinite(summaryPeak) && summaryPeak! >= 35 && summaryPeak! <= 230) {
        rawMaxBpm = Math.max(rawMaxBpm ?? 0, summaryPeak!);
      }
      const peak = { ...makePoint(1, time[peakIndex] - time[0], peakBpm), measurement: 'sample' as const, endSec: time[peakIndex] };
      records.push(peak);
      if (inPeriod(activity.startDate, maxLookbackDays)) peaks.push(peak);
    }
    for (const duration of HEART_RATE_DURATIONS) {
      if (duration === 1) continue; // This position displays the supported sample, not a held average.
      let best = -Infinity;
      let start = 0;
      for (let end = duration; end <= span; end++) {
        if (missing[end] !== missing[end - duration]) continue;
        const bpm = (sum[end] - sum[end - duration]) / duration;
        if (bpm > best) { best = bpm; start = end - duration; }
      }
      if (Number.isFinite(best)) records.push(makePoint(duration, start, best));
    }
  }
  const points: HeartRateDurationPoint[] = [];
  for (const periodDays of [30, 60, 90] as const) {
    for (const durationSec of HEART_RATE_DURATIONS) {
      const best = records.filter((p) => p.durationSec === durationSec && inPeriod(p.activityDate, periodDays))
        .sort((a, b) => b.bpm - a.bpm || Date.parse(b.activityDate) - Date.parse(a.activityDate))[0];
      if (best) points.push({ ...best, periodDays });
    }
  }
  peaks.sort((a, b) => b.bpm - a.bpm);
  const top = peaks[0];
  const supporting = top ? peaks.filter((p) => p.bpm >= top.bpm - 3) : [];
  return {
    points,
    maxObserved: top ? { bpm: Math.round(top.bpm), measurement: 'sample', durationSec: 0, confidence: new Set(supporting.map((p) => p.activityId)).size >= 2 ? 'repeated' : 'single_run', supportingRuns: supporting.slice(0, 5) } : undefined,
    rawMaxBpm, excludedSamples,
    explanation: `Highest supported HR sample in the last ${maxLookbackDays} UTC calendar days (including today). A peak needs a valid reading within 5 bpm on each side within 5 seconds; a recording endpoint needs two such readings on its available side. A full-resolution activity maximum may be used when the stored stream independently supports a value within 5 bpm. A peak can last just one sample. Invalid readings and isolated high spikes are excluded. Rolling averages do not bridge gaps over 5 seconds; the sample point does not claim a one-second held effort. This is an observed lower bound, not a measured physiological maximum; sustained sensor errors can remain.`,
  };
}
