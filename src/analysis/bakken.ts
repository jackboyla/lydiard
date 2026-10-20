import type { BestEffortDistance, BestEffortEntry } from '../types';

export const BAKKEN_SOURCE = 'https://www.mariusbakken.com/vdot.html';
export const RECENT_EFFORT_WINDOWS = [30, 60, 90] as const;
export interface GoldenZone {
  vdot: number;
  thresholdPaceSecPerKm: number;
  distanceLabel: string;
  effort: BestEffortEntry;
  intervals: { label: string; fastPaceSecPerKm: number; slowPaceSecPerKm: number }[];
}
export interface RecentEffortWindow {
  days: number;
  from: string;
  to: string;
  distances: BestEffortDistance[];
  goldenZone: GoldenZone | null;
}
export interface RecentEffortsResponse {
  asOf: string;
  windows: RecentEffortWindow[];
}

/** Inclusive calendar dates: today and the previous days - 1 dates. */
export function recentEffortRange(days: number, now = new Date()): { from: string; to: string } {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(today);
  from.setUTCDate(from.getUTCDate() - days + 1);
  return { from: from.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10) };
}

/** Daniels equation and Bakken's 88% VO2 threshold, as used on his calculator. */
export function calculateVDOT(distanceMeters: number, seconds: number): number | null {
  if (!Number.isFinite(distanceMeters) || !Number.isFinite(seconds) || distanceMeters <= 0 || seconds <= 0) return null;
  const minutes = seconds / 60;
  const velocity = distanceMeters / minutes;
  const vo2 = -4.60 + 0.182258 * velocity + 0.000104 * velocity ** 2;
  const fraction = 0.8 + 0.1894393 * Math.exp(-0.012778 * minutes) + 0.2989558 * Math.exp(-0.1932605 * minutes);
  const vdot = vo2 / fraction;
  return Number.isFinite(vdot) && vdot > 0 ? vdot : null;
}

export function inferGoldenZone(distances: BestEffortDistance[]): GoldenZone | null {
  let best: { vdot: number; distanceLabel: string; effort: BestEffortEntry } | null = null;
  for (const distance of distances) {
    if (![5, 10, 21.0975, 42.195].includes(distance.distanceKm)) continue;
    for (const effort of distance.efforts) {
      if (effort.source !== 'stream') continue;
      const vdot = calculateVDOT(distance.distanceKm * 1000, effort.seconds);
      if (vdot !== null && (!best || vdot > best.vdot)) best = { vdot, distanceLabel: distance.label, effort };
    }
  }
  if (!best) return null;
  const velocity = (-0.182258 + Math.sqrt(0.182258 ** 2 - 4 * 0.000104 * (-4.60 - best.vdot * 0.88))) / (2 * 0.000104);
  const thresholdPaceSecPerKm = 60000 / velocity;
  const ranges = [
    { label: '45 sec–1 min', fast: 0.99, slow: 1.01 },
    { label: '1–3 min', fast: 1.01, slow: 1.03 },
    { label: '4–5 min', fast: 1.03, slow: 1.06 },
    { label: '8–12 min', fast: 1.06, slow: 1.09 },
  ];
  return {
    ...best, thresholdPaceSecPerKm,
    intervals: ranges.map(({ label, fast, slow }) => ({ label, fastPaceSecPerKm: thresholdPaceSecPerKm * fast, slowPaceSecPerKm: thresholdPaceSecPerKm * slow })),
  };
}
