-- Objective overnight-recovery observations, one row per local calendar day.
-- This is the fourth coaching layer alongside training load (weekly_features /
-- backgroundLoad), performance response (activity_coach_metrics), and subjective
-- symptoms (daily_checkins). Only RAW observations are stored here: personal
-- baselines, deviations, and the latent recovery state are derived at read time
-- (see src/analysis/recovery.ts) so baselines self-correct as history grows.
--
-- Primary source is Fitbit via the Google Health API (see
-- scripts/fitbit-recovery-import.ts); the column set is a superset that also
-- fits Garmin and others. `source` tags the feeder so devices can coexist.
CREATE TABLE IF NOT EXISTS daily_recovery (
  day                   TEXT PRIMARY KEY,
  source                TEXT NOT NULL DEFAULT 'fitbit',

  -- Sleep
  sleep_start           TEXT,   -- ISO 8601 (local or UTC as provided)
  sleep_end             TEXT,   -- ISO 8601
  sleep_duration_min    INTEGER CHECK (sleep_duration_min IS NULL OR sleep_duration_min >= 0),
  time_in_bed_min       INTEGER CHECK (time_in_bed_min IS NULL OR time_in_bed_min >= 0),
  sleep_efficiency      REAL    CHECK (sleep_efficiency IS NULL OR (sleep_efficiency >= 0 AND sleep_efficiency <= 100)),
  deep_sleep_min        INTEGER CHECK (deep_sleep_min IS NULL OR deep_sleep_min >= 0),
  rem_sleep_min         INTEGER CHECK (rem_sleep_min IS NULL OR rem_sleep_min >= 0),
  light_sleep_min       INTEGER CHECK (light_sleep_min IS NULL OR light_sleep_min >= 0),
  awake_min             INTEGER CHECK (awake_min IS NULL OR awake_min >= 0),
  sleep_score           INTEGER CHECK (sleep_score IS NULL OR (sleep_score BETWEEN 0 AND 100)),

  -- Autonomic
  hrv_rmssd_ms          REAL    CHECK (hrv_rmssd_ms IS NULL OR hrv_rmssd_ms > 0),  -- Garmin avg_overnight_hrv
  resting_hr_bpm        INTEGER CHECK (resting_hr_bpm IS NULL OR resting_hr_bpm > 0),

  -- Illness / systemic-stress flags
  respiratory_rate      REAL    CHECK (respiratory_rate IS NULL OR respiratory_rate > 0),  -- breaths/min
  skin_temp_delta_c     REAL    CHECK (skin_temp_delta_c IS NULL OR (skin_temp_delta_c BETWEEN -10 AND 10)),
  spo2_avg              REAL    CHECK (spo2_avg IS NULL OR (spo2_avg BETWEEN 0 AND 100)),
  spo2_low              REAL    CHECK (spo2_low IS NULL OR (spo2_low BETWEEN 0 AND 100)),
  overnight_stress      REAL    CHECK (overnight_stress IS NULL OR (overnight_stress BETWEEN 0 AND 100)),  -- Garmin avg_sleep_stress

  -- Cross-check only (a function of HRV+RHR+sleep; never fed into the derived state)
  readiness_score       INTEGER CHECK (readiness_score IS NULL OR (readiness_score BETWEEN 0 AND 100)),
  hrv_status            TEXT,   -- device classification, e.g. Garmin 'BALANCED' | 'UNBALANCED' | 'LOW'

  raw_json              TEXT NOT NULL DEFAULT '{}',  -- source-specific extras
  version               INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  CHECK (json_valid(raw_json)),
  CHECK (
    length(day) = 10
    AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  )
);

CREATE INDEX IF NOT EXISTS idx_daily_recovery_source
  ON daily_recovery (source, day);
