export type DataSource = 'strava' | 'garmin' | 'csv';

export type Severity = 'steady' | 'watch' | 'high';

export type TrendMetricKey = 'fatigue' | 'stride' | 'easyPace' | 'threshold' | 'acRatio';

export interface WeeklyRunBlock {
  id: string;
  weekStart: string;
  label: string;
  year: number;
  distanceKm: number;
  durationHours: number;
  trainingLoad: number;
  chronicLoad: number;
  acuteLoad: number;
  acRatio: number;
  easyPaceSecPerKm: number;
  easyHeartRate: number;
  thresholdPaceSecPerKm: number;
  strideLengthCm: number;
  cadenceSpm: number;
  hrPaceDecouplingPct: number;
  hrvMs: number;
  sleepHours: number;
  elevationGainM: number;
  qualitySessions: number;
  longRunKm: number;
  source: DataSource;
  sourceDetail?: string;
  activityCount?: number;
  dataCompleteness?: {
    heartRate: boolean;
    cadence: boolean;
    recovery: boolean;
    streams: boolean;
  };
  notes?: string[];
}

export interface RaceResult {
  distance: string;
  time: string;
  date: string;
}

export interface FatigueIndicator {
  id: string;
  label: string;
  unit: string;
  current: number;
  baseline: number;
  deltaPct: number;
  score: number;
  severity: Severity;
  valueLabel: string;
  baselineLabel: string;
  deltaLabel: string;
  detail: string;
  supportingLabel?: string;
}

export interface WeeklyAnalysis {
  week: WeeklyRunBlock;
  baselineWeeks: WeeklyRunBlock[];
  riskScore: number;
  severity: Severity;
  stateLabel: string;
  summary: string;
  recommendation: string;
  indicators: FatigueIndicator[];
}

/**
 * Per-activity record served by the API and drawn on the map. This is the
 * durable, queryable shape stored in D1 (one row per synced activity).
 */
export interface ActivitySummary {
  id: string;
  name: string;
  sportType: string;
  startDate: string; // UTC ISO
  startDateLocal: string;
  distanceKm: number;
  movingTimeSec: number;
  elapsedTimeSec: number;
  averageHeartRate?: number;
  maxHeartRate?: number;
  averageCadenceSpm?: number;
  elevationGainM: number;
  relativeEffort?: number;
  averageWatts?: number;
  averageSpeed?: number; // m/s
  startLat?: number;
  startLng?: number;
  endLat?: number;
  endLng?: number;
  summaryPolyline?: string; // encoded polyline for the overview map
  hasStreams: boolean;
  decouplingPct?: number; // true stream-derived HR-pace decoupling
}

/**
 * A gym / strength session. Deliberately separate from ActivitySummary: gym work
 * is tracked for visibility only and never contributes to the running load model,
 * weekly derivation, run counts, or averages.
 */
export interface GymSession {
  id: string;
  name: string;
  sportType: string;
  startDate: string; // UTC ISO
  startDateLocal: string;
  durationSec: number;
  averageHeartRate?: number;
  calories?: number;
}

export interface ActivityStreams {
  latlng?: Array<[number, number]>;
  timeSec?: number[];
  heartrate?: number[];
  cadence?: number[];
  power?: number[];
  velocity?: number[];
  altitude?: number[];
  distanceM?: number[];
}

export interface ActivityDetail extends ActivitySummary {
  streams?: ActivityStreams;
}

export interface SyncStatus {
  connected: boolean;
  athlete: {
    id: number;
    firstname?: string;
    lastname?: string;
    username?: string;
  } | null;
  activityCount: number;
  streamedCount: number;
  weekCount: number;
  lastSyncAt: string | null;
  lastActivityDate: string | null;
  lastError: string | null;
  source?: string;
  dateRange: { first: string | null; last: string | null };
}
