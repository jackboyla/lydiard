import type { BestEffortDistance, BestEffortEntry } from '../types';

export const BEST_EFFORT_TARGETS = [
  { label: '200m', distanceKm: 0.2 },
  { label: '400m', distanceKm: 0.4 },
  { label: '800m', distanceKm: 0.8 },
  { label: '1K', distanceKm: 1 },
  { label: 'Mile', distanceKm: 1.609344 },
  { label: '3K', distanceKm: 3 },
  { label: '5K', distanceKm: 5 },
  { label: '10K', distanceKm: 10 },
  { label: '15K', distanceKm: 15 },
  { label: 'Half', distanceKm: 21.0975 },
  { label: 'Marathon', distanceKm: 42.195 },
] as const;

export interface BestEffortActivityInput {
  id: string;
  name: string;
  startDate: string;
  startDateLocal: string;
  distanceKm: number;
  movingTimeSec: number;
  timeSec?: number[];
  distanceM?: number[];
}

interface StreamPoint {
  time: number;
  distance: number;
}

interface StreamEffort {
  seconds: number;
  startSec: number;
  endSec: number;
}

export function bestEffortForTarget(
  activity: BestEffortActivityInput,
  distanceKm: number,
): Omit<BestEffortEntry, 'rank'> | null {
  return bestEffortForTargetFromPoints(activity, distanceKm, normalizeStreamPoints(activity.timeSec, activity.distanceM));
}

export function bestEffortsForActivity(
  activity: BestEffortActivityInput,
  options: { streamOnly?: boolean } = {},
): BestEffortDistance[] {
  const points = normalizeStreamPoints(activity.timeSec, activity.distanceM);
  return BEST_EFFORT_TARGETS.flatMap((target) => {
    const effort = bestEffortForTargetFromPoints(activity, target.distanceKm, points);
    if (!effort || (options.streamOnly && effort.source !== 'stream')) {
      return [];
    }
    return [{ ...target, efforts: [{ ...effort, rank: 1 }] }];
  });
}

function bestEffortForTargetFromPoints(
  activity: BestEffortActivityInput,
  distanceKm: number,
  points: StreamPoint[] | undefined,
): Omit<BestEffortEntry, 'rank'> | null {
  if (activity.distanceKm < distanceKm * 0.98 || activity.movingTimeSec <= 0) {
    return null;
  }
  const streamEffort = points ? fastestStreamSegmentFromPoints(points, distanceKm * 1000) : null;
  const seconds = streamEffort?.seconds
    ?? (activity.movingTimeSec * distanceKm) / Math.max(activity.distanceKm, 0.001);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return {
    activityId: activity.id,
    activityName: activity.name,
    startDate: activity.startDate,
    startDateLocal: activity.startDateLocal,
    seconds,
    paceSecPerKm: seconds / distanceKm,
    source: streamEffort ? 'stream' : 'whole_run',
    segmentStartSec: streamEffort?.startSec,
    segmentEndSec: streamEffort?.endSec,
  };
}

export function streamBestEffortsForActivity(activity: BestEffortActivityInput): BestEffortDistance[] {
  return bestEffortsForActivity(activity, { streamOnly: true });
}

export function fastestStreamSegment(
  timeValues: number[] | undefined,
  distanceValues: number[] | undefined,
  targetM: number,
): StreamEffort | null {
  const points = normalizeStreamPoints(timeValues, distanceValues);
  return points ? fastestStreamSegmentFromPoints(points, targetM) : null;
}

function normalizeStreamPoints(
  timeValues: number[] | undefined,
  distanceValues: number[] | undefined,
): StreamPoint[] | undefined {
  if (!timeValues || !distanceValues) {
    return undefined;
  }
  const n = Math.min(timeValues.length, distanceValues.length);
  if (n < 2) {
    return undefined;
  }

  const points: StreamPoint[] = [];
  let lastTime = -Infinity;
  let lastDistance = -Infinity;
  for (let index = 0; index < n; index += 1) {
    const time = timeValues[index];
    const distance = distanceValues[index];
    if (!Number.isFinite(time) || !Number.isFinite(distance) || time <= lastTime || distance < lastDistance) {
      continue;
    }
    points.push({ time, distance });
    lastTime = time;
    lastDistance = distance;
  }
  return points.length >= 2 ? points : undefined;
}

function fastestStreamSegmentFromPoints(points: StreamPoint[], targetM: number): StreamEffort | null {
  if (points[points.length - 1].distance - points[0].distance < targetM * 0.98) {
    return null;
  }

  let best: StreamEffort | null = null;
  let end = 1;
  for (let start = 0; start < points.length - 1; start += 1) {
    if (end <= start) {
      end = start + 1;
    }
    const targetDistance = points[start].distance + targetM;
    while (end < points.length && points[end].distance < targetDistance) {
      end += 1;
    }
    if (end >= points.length) {
      break;
    }
    const previous = points[Math.max(start, end - 1)];
    const current = points[end];
    const distanceDelta = current.distance - previous.distance;
    const ratio = distanceDelta > 0 ? (targetDistance - previous.distance) / distanceDelta : 0;
    const endSec = previous.time + Math.max(0, Math.min(1, ratio)) * (current.time - previous.time);
    const seconds = endSec - points[start].time;
    if (seconds > 0 && (!best || seconds < best.seconds)) {
      best = { seconds, startSec: points[start].time, endSec };
    }
  }
  return best;
}
