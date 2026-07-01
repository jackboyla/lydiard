// Pure helpers to turn stored activities into colored GeoJSON routes for the map.

import polyline from '@mapbox/polyline';
import type { Feature, FeatureCollection, LineString } from 'geojson';
import type { ActivitySummary, Severity } from '../types';

export type ColorBy = 'severity' | 'pace' | 'recency';

export interface RouteProps {
  id: string;
  name: string;
  color: string;
  distanceKm: number;
}

export type RouteCollection = FeatureCollection<LineString, RouteProps>;

const SEVERITY_COLORS: Record<Severity, string> = {
  steady: '#22b982',
  watch: '#f2c94c',
  high: '#ff5a66',
};

const FAST = '#38d996'; // fast pace / recent
const SLOW = '#ff5a66'; // slow pace
const OLD = '#3b4a5a'; // muted, older run

/** Decode a Strava summary polyline to GeoJSON [lng, lat] coordinates. */
export function decodePolyline(encoded: string): Array<[number, number]> {
  try {
    return polyline.decode(encoded).map(([lat, lng]) => [lng, lat] as [number, number]);
  } catch {
    return [];
  }
}

export function activityPaceSecPerKm(activity: ActivitySummary): number {
  return activity.distanceKm > 0 ? activity.movingTimeSec / activity.distanceKm : 0;
}

/** Compute the Monday week id in UTC to match the Worker's weekly grouping. */
export function toWeekIdUtc(startDateIso: string): string {
  const date = new Date(startDateIso);
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const mondayOffset = (monday.getUTCDay() + 6) % 7;
  monday.setUTCDate(monday.getUTCDate() - mondayOffset);
  return `${monday.getUTCFullYear()}-${String(monday.getUTCMonth() + 1).padStart(2, '0')}-${String(
    monday.getUTCDate(),
  ).padStart(2, '0')}`;
}

export function buildRouteCollection(
  activities: ActivitySummary[],
  colorBy: ColorBy,
  severityByWeek: Map<string, Severity>,
): RouteCollection {
  const withRoutes = activities.filter((activity) => activity.summaryPolyline);
  const paces = withRoutes.map(activityPaceSecPerKm).filter((pace) => pace > 0);
  const minPace = paces.length ? Math.min(...paces) : 0;
  const maxPace = paces.length ? Math.max(...paces) : 1;
  const times = withRoutes.map((activity) => new Date(activity.startDate).getTime());
  const minTime = times.length ? Math.min(...times) : 0;
  const maxTime = times.length ? Math.max(...times) : 1;

  const features: Array<Feature<LineString, RouteProps>> = [];
  for (const activity of withRoutes) {
    const coordinates = decodePolyline(activity.summaryPolyline as string);
    if (coordinates.length < 2) {
      continue;
    }
    features.push({
      type: 'Feature',
      properties: {
        id: activity.id,
        name: activity.name,
        distanceKm: activity.distanceKm,
        color: colorForActivity(activity, colorBy, {
          severityByWeek,
          minPace,
          maxPace,
          minTime,
          maxTime,
        }),
      },
      geometry: { type: 'LineString', coordinates },
    });
  }

  return { type: 'FeatureCollection', features };
}

function colorForActivity(
  activity: ActivitySummary,
  colorBy: ColorBy,
  ctx: { severityByWeek: Map<string, Severity>; minPace: number; maxPace: number; minTime: number; maxTime: number },
): string {
  if (colorBy === 'severity') {
    const severity = ctx.severityByWeek.get(toWeekIdUtc(activity.startDate)) ?? 'steady';
    return SEVERITY_COLORS[severity];
  }
  if (colorBy === 'pace') {
    const pace = activityPaceSecPerKm(activity);
    const t = ctx.maxPace > ctx.minPace ? (pace - ctx.minPace) / (ctx.maxPace - ctx.minPace) : 0;
    return lerpHex(FAST, SLOW, clamp01(t));
  }
  const time = new Date(activity.startDate).getTime();
  const t = ctx.maxTime > ctx.minTime ? (time - ctx.minTime) / (ctx.maxTime - ctx.minTime) : 1;
  return lerpHex(OLD, FAST, clamp01(t));
}

/** Bounding box [west, south, east, north] over all route coordinates. */
export function routeBounds(collection: RouteCollection): [number, number, number, number] | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const feature of collection.features) {
    for (const [lng, lat] of feature.geometry.coordinates) {
      west = Math.min(west, lng);
      east = Math.max(east, lng);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
  }
  return Number.isFinite(west) ? [west, south, east, north] : null;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function lerpHex(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const r = Math.round(ca[0] + (cb[0] - ca[0]) * t);
  const g = Math.round(ca[1] + (cb[1] - ca[1]) * t);
  const bl = Math.round(ca[2] + (cb[2] - ca[2]) * t);
  return `#${[r, g, bl].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}
