// Pure stream utilities: downsampling, line simplification, and true
// first-half/second-half HR-pace decoupling. No runtime dependencies.

import type { ActivityStreams } from '../src/types';

export interface RawStreams {
  time?: number[];
  latlng?: Array<[number, number]>;
  heartrate?: number[];
  cadence?: number[];
  velocity_smooth?: number[];
  altitude?: number[];
  distance?: number[];
}

const MAX_STREAM_POINTS = 1200;
const MAX_LATLNG_POINTS = 1000;
const LATLNG_TOLERANCE_DEG = 0.00002; // ~2m

/** Evenly decimate an array to at most `max` points, always keeping the ends. */
export function decimate<T>(values: T[] | undefined, max: number, stride: number): T[] | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }
  if (stride <= 1) {
    return values.slice();
  }
  const out: T[] = [];
  for (let i = 0; i < values.length; i += stride) {
    out.push(values[i]);
  }
  const last = values[values.length - 1];
  if (out[out.length - 1] !== last) {
    out.push(last);
  }
  return out;
}

/** Douglas-Peucker line simplification in lat/lng space, then a hard point cap. */
export function simplifyLatLng(
  points: Array<[number, number]> | undefined,
  tolerance = LATLNG_TOLERANCE_DEG,
  maxPoints = MAX_LATLNG_POINTS,
): Array<[number, number]> | undefined {
  if (!points || points.length <= 2) {
    return points && points.length ? points.slice() : undefined;
  }

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [start, end] = stack.pop() as [number, number];
    let maxDist = 0;
    let index = -1;
    for (let i = start + 1; i < end; i += 1) {
      const dist = perpendicularDistance(points[i], points[start], points[end]);
      if (dist > maxDist) {
        maxDist = dist;
        index = i;
      }
    }
    if (maxDist > tolerance && index !== -1) {
      keep[index] = 1;
      stack.push([start, index], [index, end]);
    }
  }

  let simplified: Array<[number, number]> = [];
  for (let i = 0; i < points.length; i += 1) {
    if (keep[i]) {
      simplified.push(points[i]);
    }
  }

  if (simplified.length > maxPoints) {
    const stride = Math.ceil(simplified.length / maxPoints);
    simplified = decimate(simplified, maxPoints, stride) ?? simplified;
  }

  return simplified;
}

function perpendicularDistance(
  point: [number, number],
  lineStart: [number, number],
  lineEnd: [number, number],
): number {
  const [x, y] = point;
  const [x1, y1] = lineStart;
  const [x2, y2] = lineEnd;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    return Math.hypot(x - x1, y - y1);
  }
  let t = ((x - x1) * dx + (y - y1) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  return Math.hypot(x - projX, y - projY);
}

/** Normalize raw Strava streams into stored (downsampled, aligned) arrays. */
export function normalizeStreams(raw: RawStreams): ActivityStreams {
  const length = Math.max(
    raw.time?.length ?? 0,
    raw.heartrate?.length ?? 0,
    raw.distance?.length ?? 0,
    raw.velocity_smooth?.length ?? 0,
    raw.cadence?.length ?? 0,
    raw.altitude?.length ?? 0,
  );
  const stride = length > MAX_STREAM_POINTS ? Math.ceil(length / MAX_STREAM_POINTS) : 1;

  return {
    latlng: simplifyLatLng(raw.latlng),
    timeSec: decimate(raw.time, MAX_STREAM_POINTS, stride),
    heartrate: decimate(raw.heartrate, MAX_STREAM_POINTS, stride),
    cadence: normalizeCadenceStream(decimate(raw.cadence, MAX_STREAM_POINTS, stride)),
    velocity: decimate(raw.velocity_smooth, MAX_STREAM_POINTS, stride),
    altitude: decimate(raw.altitude, MAX_STREAM_POINTS, stride),
    distanceM: decimate(raw.distance, MAX_STREAM_POINTS, stride),
  };
}

function normalizeCadenceStream(values?: number[]): number[] | undefined {
  if (!values) {
    return undefined;
  }
  // Strava run cadence streams are per-leg (spm/2). Double to full strides/min.
  return values.map((value) => (value > 0 && value < 130 ? value * 2 : value));
}

/**
 * True HR-pace decoupling (%): the drop in aerobic efficiency (speed per bpm)
 * from the first half to the second half. Positive = cardiac drift. Requires
 * time, heart-rate, and distance streams and at least 20 minutes of running.
 */
export function computeDecoupling(streams: ActivityStreams): number | undefined {
  const time = streams.timeSec;
  const hr = streams.heartrate;
  const dist = streams.distanceM;
  if (!time || !hr || !dist) {
    return undefined;
  }
  const n = Math.min(time.length, hr.length, dist.length);
  if (n < 20) {
    return undefined;
  }
  const totalTime = time[n - 1] - time[0];
  if (totalTime < 20 * 60) {
    return undefined;
  }

  const midTime = time[0] + totalTime / 2;
  let mid = 1;
  while (mid < n - 1 && time[mid] < midTime) {
    mid += 1;
  }

  const firstTime = time[mid] - time[0];
  const secondTime = time[n - 1] - time[mid];
  const firstDist = dist[mid] - dist[0];
  const secondDist = dist[n - 1] - dist[mid];
  const firstHr = average(hr, 0, mid);
  const secondHr = average(hr, mid, n);

  if (firstTime <= 0 || secondTime <= 0 || firstDist <= 0 || secondDist <= 0 || firstHr <= 0 || secondHr <= 0) {
    return undefined;
  }

  const efFirst = firstDist / firstTime / firstHr;
  const efSecond = secondDist / secondTime / secondHr;
  if (efFirst <= 0) {
    return undefined;
  }

  return Number((((efFirst - efSecond) / efFirst) * 100).toFixed(1));
}

function average(values: number[], start: number, end: number): number {
  let total = 0;
  let count = 0;
  for (let i = start; i < end; i += 1) {
    if (Number.isFinite(values[i])) {
      total += values[i];
      count += 1;
    }
  }
  return count > 0 ? total / count : 0;
}
