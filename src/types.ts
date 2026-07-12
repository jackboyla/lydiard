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
  activityNote?: string; // runner-authored note attached to this activity
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

/**
 * One row from the runner's day-by-day training plan. Actual runs are not
 * copied into this record: clients join Garmin activities by local date so new
 * syncs appear automatically.
 */
export interface TrainingPlanDay {
  date: string; // YYYY-MM-DD, runner-local calendar date
  plannedText: string; // editable current plan
  legacyPlannedText: string; // immutable original imported plan
  legacyActualText: string; // original sheet Actual cell, retained for audit/fallback
  notes: string;
  source: string;
  sourceFile?: string;
  importedAt?: string;
  createdAt: string;
  updatedAt: string;
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
  planDay?: TrainingPlanDay;
}

export interface BestEffortEntry {
  rank: number;
  activityId: string;
  activityName: string;
  startDate: string;
  startDateLocal: string;
  seconds: number;
  paceSecPerKm: number;
  source: 'stream' | 'whole_run';
  segmentStartSec?: number;
  segmentEndSec?: number;
}

export interface BestEffortDistance {
  label: string;
  distanceKm: number;
  efforts: BestEffortEntry[];
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
