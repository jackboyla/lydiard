import type { ActivityDetail, ActivityLap } from '../types';

export type ActivityLapZoneKey = 'recovery' | 'easy' | 'steady' | 'threshold' | 'high-intensity' | 'strides';

export interface ActivityLapView {
  index: number;
  label: string;
  source: 'recorded' | 'derived';
  distanceKm: number;
  durationSec: number;
  paceSecPerKm: number;
  averageHeartRate?: number;
  maxHeartRate?: number;
  averagePower?: number;
  maxPower?: number;
  elevationChangeM?: number;
  zone: {
    key: ActivityLapZoneKey;
    label: string;
  };
}

export function buildActivityLaps(detail: ActivityDetail, thresholdPaceSecPerKm: number): ActivityLapView[] {
  const activityAveragePace = detail.distanceKm > 0 && detail.movingTimeSec > 0
    ? detail.movingTimeSec / detail.distanceKm
    : undefined;
  let distanceCursorM = 0;
  const recorded = detail.streams?.laps
    ?.map((lap, index) => {
      const distanceM = positive(lap.distanceM);
      const startDistanceM = distanceCursorM;
      if (distanceM) distanceCursorM += distanceM;
      return recordedLapView(
        lap,
        index,
        thresholdPaceSecPerKm,
        activityAveragePace,
        elevationChangeForRange(detail, startDistanceM, distanceCursorM),
      );
    })
    .filter((lap): lap is ActivityLapView => Boolean(lap));
  if (recorded?.length) return recorded;
  return buildDerivedKilometreLaps(detail, thresholdPaceSecPerKm);
}

export function classifyActivityLapZone(
  distanceM: number,
  paceSecPerKm: number,
  thresholdPaceSecPerKm: number,
  source: ActivityLapView['source'],
  activityAveragePace?: number,
): ActivityLapView['zone'] {
  const intensityFactor = thresholdPaceSecPerKm > 0 && paceSecPerKm > 0
    ? thresholdPaceSecPerKm / paceSecPerKm
    : 0;
  const distinctlyFasterThanRun = activityAveragePace !== undefined && paceSecPerKm <= activityAveragePace * 0.88;
  if (source === 'recorded' && distanceM < 200 && (intensityFactor >= 1.02 || distinctlyFasterThanRun)) {
    return { key: 'strides', label: 'Strides' };
  }
  if (intensityFactor < 0.68) return { key: 'recovery', label: 'Recovery' };
  if (intensityFactor < 0.78) return { key: 'easy', label: 'Easy aerobic' };
  if (intensityFactor < 0.88) return { key: 'steady', label: 'Steady / LT1' };
  if (intensityFactor < 1.02) return { key: 'threshold', label: 'Threshold / LT2' };
  return { key: 'high-intensity', label: 'VO2 / high intensity' };
}

function recordedLapView(
  lap: ActivityLap,
  fallbackIndex: number,
  thresholdPaceSecPerKm: number,
  activityAveragePace: number | undefined,
  elevationChangeM: number | undefined,
): ActivityLapView | undefined {
  const distanceM = positive(lap.distanceM);
  const durationSec = positive(lap.durationSec);
  if (!distanceM || !durationSec) return undefined;
  const speedPace = positive(lap.averageSpeedMps) ? 1000 / lap.averageSpeedMps! : undefined;
  const paceSecPerKm = validPace(speedPace) ? speedPace : durationSec / (distanceM / 1000);
  if (!validPace(paceSecPerKm)) return undefined;
  const index = Number.isInteger(lap.index) && lap.index > 0 ? lap.index : fallbackIndex + 1;
  return {
    index,
    label: String(index),
    source: 'recorded',
    distanceKm: distanceM / 1000,
    durationSec,
    paceSecPerKm,
    averageHeartRate: usefulHeartRate(lap.averageHeartRate),
    maxHeartRate: usefulHeartRate(lap.maxHeartRate),
    averagePower: usefulPower(lap.averagePower),
    maxPower: usefulPower(lap.maxPower),
    elevationChangeM,
    zone: classifyActivityLapZone(distanceM, paceSecPerKm, thresholdPaceSecPerKm, 'recorded', activityAveragePace),
  };
}

export function buildDerivedKilometreLaps(detail: ActivityDetail, thresholdPaceSecPerKm: number): ActivityLapView[] {
  const time = detail.streams?.timeSec;
  const distance = detail.streams?.distanceM;
  if (!time || !distance || Math.min(time.length, distance.length) < 3) return [];
  const startDistance = firstFinite(distance);
  const endDistance = lastFinite(distance);
  if (startDistance === undefined || endDistance === undefined || endDistance - startDistance < 200) return [];

  const totalDistanceM = endDistance - startDistance;
  const boundaries = [0];
  for (let marker = 1000; marker < totalDistanceM - 50; marker += 1000) boundaries.push(marker);
  boundaries.push(totalDistanceM);

  const laps: ActivityLapView[] = [];
  for (let index = 1; index < boundaries.length; index += 1) {
    const startM = boundaries[index - 1];
    const endM = boundaries[index];
    const startTime = timeAtDistance(time, distance, startDistance + startM);
    const endTime = timeAtDistance(time, distance, startDistance + endM);
    if (startTime === undefined || endTime === undefined || endTime <= startTime) continue;
    const distanceM = endM - startM;
    const distanceKm = distanceM / 1000;
    const durationSec = endTime - startTime;
    const paceSecPerKm = durationSec / distanceKm;
    if (!validPace(paceSecPerKm)) continue;
    laps.push({
      index,
      label: String(index),
      source: 'derived',
      distanceKm,
      durationSec,
      paceSecPerKm,
      averageHeartRate: weightedAverageStream(time, detail.streams?.heartrate, startTime, endTime, usefulHeartRate),
      maxHeartRate: maxStream(time, detail.streams?.heartrate, startTime, endTime, usefulHeartRate),
      averagePower: weightedAverageStream(time, detail.streams?.power, startTime, endTime, usefulPower),
      maxPower: maxStream(time, detail.streams?.power, startTime, endTime, usefulPower),
      elevationChangeM: elevationChangeForRange(detail, startM, endM),
      zone: classifyActivityLapZone(distanceM, paceSecPerKm, thresholdPaceSecPerKm, 'derived'),
    });
  }
  return laps;
}

function elevationChangeForRange(
  detail: ActivityDetail,
  startOffsetM: number,
  endOffsetM: number,
): number | undefined {
  const distance = detail.streams?.distanceM;
  const altitude = detail.streams?.altitude;
  if (!distance || !altitude || Math.min(distance.length, altitude.length) < 2) return undefined;
  const firstDistance = firstFinite(distance);
  if (firstDistance === undefined) return undefined;
  const startAltitude = valueAtDistance(distance, altitude, firstDistance + startOffsetM);
  const endAltitude = valueAtDistance(distance, altitude, firstDistance + endOffsetM);
  if (startAltitude === undefined || endAltitude === undefined) return undefined;
  const change = endAltitude - startAltitude;
  return Math.abs(change) < 0.05 ? 0 : change;
}

function valueAtDistance(distance: number[], values: number[], targetM: number): number | undefined {
  const count = Math.min(distance.length, values.length);
  let previousIndex = -1;
  for (let index = 0; index < count; index += 1) {
    if (!Number.isFinite(distance[index]) || !Number.isFinite(values[index])) continue;
    if (previousIndex < 0) {
      if (targetM <= distance[index]) return values[index];
      previousIndex = index;
      continue;
    }
    if (distance[index] >= targetM) {
      const distanceDelta = distance[index] - distance[previousIndex];
      if (distanceDelta <= 0) return values[index];
      const ratio = Math.min(1, Math.max(0, (targetM - distance[previousIndex]) / distanceDelta));
      return values[previousIndex] + (values[index] - values[previousIndex]) * ratio;
    }
    previousIndex = index;
  }
  return previousIndex >= 0 ? values[previousIndex] : undefined;
}

function timeAtDistance(time: number[], distance: number[], targetM: number): number | undefined {
  const count = Math.min(time.length, distance.length);
  if (count === 0) return undefined;
  if (targetM <= distance[0]) return time[0];
  for (let index = 1; index < count; index += 1) {
    const previousDistance = distance[index - 1];
    const nextDistance = distance[index];
    const previousTime = time[index - 1];
    const nextTime = time[index];
    if (![previousDistance, nextDistance, previousTime, nextTime].every(Number.isFinite)) continue;
    if (nextDistance >= targetM) {
      const ratio = nextDistance === previousDistance ? 0 : (targetM - previousDistance) / (nextDistance - previousDistance);
      return previousTime + (nextTime - previousTime) * Math.min(1, Math.max(0, ratio));
    }
  }
  return time[count - 1];
}

function weightedAverageStream(
  time: number[],
  values: number[] | undefined,
  startTime: number,
  endTime: number,
  sanitize: (value: unknown) => number | undefined,
): number | undefined {
  if (!values) return undefined;
  const count = Math.min(time.length, values.length);
  let weighted = 0;
  let duration = 0;
  for (let index = 1; index < count; index += 1) {
    const segmentStart = Math.max(startTime, time[index - 1]);
    const segmentEnd = Math.min(endTime, time[index]);
    const seconds = segmentEnd - segmentStart;
    const value = sanitize(values[index - 1]);
    if (!value || !Number.isFinite(seconds) || seconds <= 0) continue;
    weighted += value * seconds;
    duration += seconds;
  }
  return duration > 0 ? weighted / duration : undefined;
}

function maxStream(
  time: number[],
  values: number[] | undefined,
  startTime: number,
  endTime: number,
  sanitize: (value: unknown) => number | undefined,
): number | undefined {
  if (!values) return undefined;
  const count = Math.min(time.length, values.length);
  let maximum: number | undefined;
  for (let index = 0; index < count; index += 1) {
    if (time[index] < startTime || time[index] > endTime) continue;
    const value = sanitize(values[index]);
    if (value !== undefined) maximum = maximum === undefined ? value : Math.max(maximum, value);
  }
  return maximum;
}

function validPace(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 60 && value <= 1800;
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function usefulHeartRate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 40 && value <= 240 ? value : undefined;
}

function usefulPower(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 2000 ? value : undefined;
}

function firstFinite(values: number[]): number | undefined {
  return values.find(Number.isFinite);
}

function lastFinite(values: number[]): number | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (Number.isFinite(values[index])) return values[index];
  }
  return undefined;
}
