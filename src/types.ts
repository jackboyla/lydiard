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
 * Latent overnight-recovery state, ordered from most to least recovered. Derived
 * from agreement across autonomic (HRV/RHR), sleep, and illness signals against
 * the runner's own rolling baseline — never from a single population threshold.
 */
export type RecoveryState =
  | 'recovered'
  | 'normal'
  | 'slightly_suppressed'
  | 'suppressed'
  | 'high_stress';

/**
 * One night's RAW recovery observation, one row per local calendar day. Shaped
 * around Garmin's `sleep` table (a superset that also fits Fitbit Air / Google
 * Health). Every metric is optional because feeds vary by device. Personal
 * baselines, deviations, and the latent RecoveryState are derived at read time
 * (src/analysis/recovery.ts), not stored. `readiness` is kept only as a
 * cross-check and is deliberately never fed back into the derived state.
 */
export interface RecoveryObservation {
  day: string; // YYYY-MM-DD, runner-local calendar date
  source: string; // 'garmin' | 'fitbit' | 'google_health' | ...
  // Sleep
  sleepStart?: string;
  sleepEnd?: string;
  sleepDurationMin?: number;
  timeInBedMin?: number;
  sleepEfficiency?: number; // 0–100
  deepSleepMin?: number;
  remSleepMin?: number;
  lightSleepMin?: number;
  awakeMin?: number;
  sleepScore?: number; // 0–100
  // Autonomic
  hrvRmssdMs?: number; // nightly RMSSD (Garmin avg_overnight_hrv)
  restingHrBpm?: number;
  // Illness / systemic-stress flags
  respiratoryRate?: number; // breaths/min
  skinTempDeltaC?: number; // deviation from personal baseline (may be negative)
  spo2Avg?: number; // 0–100
  spo2Low?: number; // 0–100
  overnightStress?: number; // 0–100 (Garmin avg_sleep_stress)
  // Cross-check only
  readinessScore?: number; // 0–100 (Garmin training_readiness / Fitbit readiness)
  hrvStatus?: string; // device classification, e.g. Garmin 'BALANCED'
  // Source-specific extras preserved verbatim
  raw?: Record<string, unknown>;
}

/**
 * One recorded lap distilled to just what the calendar mini lap-profile needs:
 * pace and distance. Kept tiny so the /api/activities feed can carry it for
 * every run without dragging down the full stream payload. Zones are derived
 * client-side from the runner's threshold pace (see buildLapProfileFromCompact).
 */
export interface LapProfilePoint {
  paceSecPerKm: number;
  distanceKm: number;
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
  lapProfile?: LapProfilePoint[]; // compact recorded-lap pace/distance for the calendar mini-profile
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
  laps?: ActivityLap[];
}

export interface ActivityLap {
  index: number;
  distanceM: number;
  durationSec: number;
  elapsedSec?: number;
  averageHeartRate?: number;
  maxHeartRate?: number;
  averagePower?: number;
  maxPower?: number;
  averageSpeedMps?: number;
}

export interface ActivityDetail extends ActivitySummary {
  streams?: ActivityStreams;
  planDay?: TrainingPlanDay;
}

export interface ActivityWeather {
  observedAt: string;
  condition: string;
  conditionCode: number;
  temperatureC: number;
  feelsLikeC: number;
  relativeHumidityPct: number;
  precipitationMm: number;
  rainMm: number;
  snowfallCm: number;
  windSpeedKph: number;
  windGustKph: number;
  windDirectionDeg: number;
  source: 'open-meteo';
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
