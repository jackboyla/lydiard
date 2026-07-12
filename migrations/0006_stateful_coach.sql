-- Stateful coaching records. Garmin/Stryd remain authoritative for completed
-- activities; these additive tables make Lydiard authoritative for physiology
-- snapshots, plans, feedback, and explainable coaching decisions.

CREATE TABLE IF NOT EXISTS coach_profile (
  id                              INTEGER PRIMARY KEY CHECK (id = 1),
  primary_goal                    TEXT NOT NULL DEFAULT 'sub15_5k',
  secondary_goal                  TEXT NOT NULL DEFAULT 'sub30_10k',
  goal_5k_seconds                 INTEGER NOT NULL DEFAULT 900 CHECK (goal_5k_seconds > 0),
  goal_10k_seconds                INTEGER NOT NULL DEFAULT 1800 CHECK (goal_10k_seconds > 0),
  current_phase                   TEXT NOT NULL DEFAULT 'aerobic_conditioning'
    CHECK (current_phase IN (
      'aerobic_conditioning', 'hill_resistance', 'anaerobic_development',
      'coordination', 'recovery_regeneration'
    )),
  phase_started_on                TEXT,
  target_race_date                TEXT,
  sustainable_weekly_duration_min INTEGER CHECK (sustainable_weekly_duration_min IS NULL OR sustainable_weekly_duration_min >= 0),
  target_weekly_duration_min      INTEGER CHECK (target_weekly_duration_min IS NULL OR target_weekly_duration_min >= 0),
  long_run_tolerance_min          INTEGER CHECK (long_run_tolerance_min IS NULL OR long_run_tolerance_min >= 0),
  max_quality_sessions            INTEGER NOT NULL DEFAULT 2 CHECK (max_quality_sessions BETWEEN 0 AND 7),
  strength_sessions_target        INTEGER NOT NULL DEFAULT 2 CHECK (strength_sessions_target BETWEEN 0 AND 7),
  constraints_json                TEXT NOT NULL DEFAULT '{}',
  learned_response_json           TEXT NOT NULL DEFAULT '{}',
  policy_version                  TEXT NOT NULL DEFAULT 'lydiard-coach-v1',
  next_decision_at                TEXT,
  version                         INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at                      TEXT NOT NULL,
  updated_at                      TEXT NOT NULL,
  CHECK (json_valid(constraints_json)),
  CHECK (json_valid(learned_response_json))
);

INSERT OR IGNORE INTO coach_profile (id, created_at, updated_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE IF NOT EXISTS critical_power_history (
  id                       TEXT PRIMARY KEY,
  effective_from           TEXT NOT NULL,
  critical_power_watts     REAL NOT NULL CHECK (critical_power_watts > 0),
  source                   TEXT NOT NULL
    CHECK (source IN ('stryd_auto', 'stryd_test', 'stryd_manual', 'platform_estimate', 'manual', 'imported')),
  device                   TEXT NOT NULL DEFAULT 'Stryd',
  algorithm                TEXT,
  confidence               REAL NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  supporting_activity_ids  TEXT NOT NULL DEFAULT '[]',
  notes                    TEXT NOT NULL DEFAULT '',
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  CHECK (json_valid(supporting_activity_ids)),
  UNIQUE (device, effective_from)
);
CREATE INDEX IF NOT EXISTS idx_critical_power_effective
  ON critical_power_history (effective_from DESC);

-- Appendable physiology estimates keep ranges, confidence, evidence, and the
-- model version that produced them. A CP record may be referenced, but no FK is
-- used because historical coaching evidence must survive raw-data replacement.
CREATE TABLE IF NOT EXISTS physiology_estimates (
  id                         TEXT PRIMARY KEY,
  effective_from             TEXT NOT NULL,
  critical_power_id          TEXT,
  critical_speed_mps         REAL CHECK (critical_speed_mps IS NULL OR critical_speed_mps > 0),
  critical_speed_low_mps     REAL CHECK (critical_speed_low_mps IS NULL OR critical_speed_low_mps > 0),
  critical_speed_high_mps    REAL CHECK (critical_speed_high_mps IS NULL OR critical_speed_high_mps > 0),
  d_prime_m                  REAL CHECK (d_prime_m IS NULL OR d_prime_m >= 0),
  lt1_hr_low                 REAL CHECK (lt1_hr_low IS NULL OR lt1_hr_low > 0),
  lt1_hr_high                REAL CHECK (lt1_hr_high IS NULL OR lt1_hr_high > 0),
  lt2_hr_low                 REAL CHECK (lt2_hr_low IS NULL OR lt2_hr_low > 0),
  lt2_hr_high                REAL CHECK (lt2_hr_high IS NULL OR lt2_hr_high > 0),
  confidence                 REAL NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
  confidence_json            TEXT NOT NULL DEFAULT '{}',
  evidence_json              TEXT NOT NULL DEFAULT '{}',
  source                     TEXT NOT NULL DEFAULT 'platform_estimate',
  model_version              TEXT NOT NULL,
  created_at                 TEXT NOT NULL,
  CHECK (json_valid(confidence_json)),
  CHECK (json_valid(evidence_json))
);
CREATE INDEX IF NOT EXISTS idx_physiology_effective
  ON physiology_estimates (effective_from DESC, created_at DESC);

-- Structured sessions are canonical for new coach plans. The existing
-- training_plan_days table remains untouched as verbatim legacy provenance and
-- a free-form fallback during migration.
CREATE TABLE IF NOT EXISTS planned_sessions (
  id                         TEXT PRIMARY KEY,
  planned_date               TEXT NOT NULL,
  sequence                   INTEGER NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  title                      TEXT NOT NULL,
  session_type               TEXT NOT NULL,
  training_phase             TEXT NOT NULL,
  priority                   TEXT NOT NULL DEFAULT 'normal',
  planned_duration_s         INTEGER CHECK (planned_duration_s IS NULL OR planned_duration_s >= 0),
  planned_distance_km        REAL CHECK (planned_distance_km IS NULL OR planned_distance_km >= 0),
  planned_power_stress       REAL CHECK (planned_power_stress IS NULL OR planned_power_stress >= 0),
  target_cp_history_id       TEXT,
  target_power_low_w         REAL,
  target_power_high_w        REAL,
  target_power_low_pct_cp    REAL,
  target_power_high_pct_cp   REAL,
  target_hr_low              REAL,
  target_hr_high             REAL,
  target_hr_ceiling          REAL,
  target_gap_low_sec_km      REAL,
  target_gap_high_sec_km     REAL,
  workout_structure_json     TEXT NOT NULL DEFAULT '{}',
  purpose                    TEXT NOT NULL DEFAULT '',
  fallback_plan              TEXT NOT NULL DEFAULT '',
  coach_reasoning            TEXT NOT NULL DEFAULT '',
  status                     TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN (
      'proposed', 'accepted', 'planned', 'completed', 'partial',
      'skipped', 'cancelled', 'superseded'
    )),
  source                     TEXT NOT NULL DEFAULT 'coach',
  source_plan_date           TEXT,
  coach_decision_id          TEXT,
  revision                   INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL,
  CHECK (json_valid(workout_structure_json)),
  CHECK (length(planned_date) = 10),
  UNIQUE (planned_date, sequence, coach_decision_id)
);
CREATE INDEX IF NOT EXISTS idx_planned_sessions_date
  ON planned_sessions (planned_date, sequence);
CREATE INDEX IF NOT EXISTS idx_planned_sessions_status
  ON planned_sessions (status, planned_date);

-- `activity_id` deliberately has no FK: Garmin replace imports delete/reinsert
-- raw activity rows, while coaching links and feedback must survive that cycle.
CREATE TABLE IF NOT EXISTS planned_activity_links (
  planned_session_id TEXT NOT NULL REFERENCES planned_sessions (id) ON DELETE CASCADE,
  activity_id        TEXT NOT NULL,
  match_method       TEXT NOT NULL DEFAULT 'manual',
  match_confidence   REAL NOT NULL DEFAULT 1 CHECK (match_confidence BETWEEN 0 AND 1),
  completion_status  TEXT NOT NULL DEFAULT 'completed',
  linked_at          TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (planned_session_id, activity_id)
);
CREATE INDEX IF NOT EXISTS idx_planned_activity_links_activity
  ON planned_activity_links (activity_id);

CREATE TABLE IF NOT EXISTS daily_checkins (
  day                    TEXT PRIMARY KEY,
  energy                 INTEGER CHECK (energy IS NULL OR energy BETWEEN 1 AND 5),
  leg_freshness          INTEGER CHECK (leg_freshness IS NULL OR leg_freshness BETWEEN 1 AND 5),
  motivation             INTEGER CHECK (motivation IS NULL OR motivation BETWEEN 1 AND 5),
  general_fatigue        INTEGER CHECK (general_fatigue IS NULL OR general_fatigue BETWEEN 1 AND 5),
  life_stress            INTEGER CHECK (life_stress IS NULL OR life_stress BETWEEN 1 AND 5),
  left_knee_pain         INTEGER CHECK (left_knee_pain IS NULL OR left_knee_pain BETWEEN 0 AND 10),
  right_knee_pain        INTEGER CHECK (right_knee_pain IS NULL OR right_knee_pain BETWEEN 0 AND 10),
  left_achilles_pain     INTEGER CHECK (left_achilles_pain IS NULL OR left_achilles_pain BETWEEN 0 AND 10),
  right_achilles_pain    INTEGER CHECK (right_achilles_pain IS NULL OR right_achilles_pain BETWEEN 0 AND 10),
  pain_altered_gait      INTEGER NOT NULL DEFAULT 0 CHECK (pain_altered_gait IN (0, 1)),
  illness_suspected      INTEGER NOT NULL DEFAULT 0 CHECK (illness_suspected IN (0, 1)),
  sleep_quality          INTEGER CHECK (sleep_quality IS NULL OR sleep_quality BETWEEN 1 AND 5),
  bodyweight_kg          REAL CHECK (bodyweight_kg IS NULL OR bodyweight_kg > 0),
  note                   TEXT NOT NULL DEFAULT '',
  version                INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  CHECK (length(day) = 10)
);

CREATE TABLE IF NOT EXISTS activity_feedback (
  activity_id             TEXT PRIMARY KEY,
  planned_session_id      TEXT,
  perceived_effort        INTEGER CHECK (perceived_effort IS NULL OR perceived_effort BETWEEN 1 AND 10),
  perceived_cost          TEXT,
  session_feel            TEXT CHECK (session_feel IS NULL OR session_feel IN ('easier', 'as_expected', 'harder')),
  energy                  INTEGER CHECK (energy IS NULL OR energy BETWEEN 1 AND 5),
  leg_condition           TEXT,
  breathing_condition     TEXT,
  pain_during             INTEGER CHECK (pain_during IS NULL OR pain_during BETWEEN 0 AND 10),
  pain_after              INTEGER CHECK (pain_after IS NULL OR pain_after BETWEEN 0 AND 10),
  pain_location           TEXT,
  altered_gait            INTEGER NOT NULL DEFAULT 0 CHECK (altered_gait IN (0, 1)),
  session_verdict         TEXT,
  note                    TEXT NOT NULL DEFAULT '',
  version                 INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_feedback_planned
  ON activity_feedback (planned_session_id);

-- Derived activity metrics are cached with the CP and model version used. This
-- avoids rescanning multi-year stream JSON during every coach-context request.
CREATE TABLE IF NOT EXISTS activity_coach_metrics (
  activity_id                 TEXT NOT NULL,
  model_version               TEXT NOT NULL,
  effective_cp_id             TEXT,
  cp_watts_used               REAL,
  power_source                TEXT,
  heart_rate_source           TEXT,
  power_stress                REAL,
  average_pct_cp              REAL,
  weighted_pct_cp             REAL,
  hard_power_stress           REAL,
  power_zone_seconds_json     TEXT NOT NULL DEFAULT '{}',
  peak_power_json             TEXT NOT NULL DEFAULT '{}',
  expected_hr                 REAL,
  observed_hr                 REAL,
  hr_cost_residual            REAL,
  hr_power_decoupling_pct     REAL,
  gap_sec_per_km              REAL,
  late_power_drop_pct         REAL,
  late_gap_drop_pct           REAL,
  sensor_quality_json         TEXT NOT NULL DEFAULT '{}',
  confidence                  REAL NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
  computed_at                 TEXT NOT NULL,
  CHECK (json_valid(power_zone_seconds_json)),
  CHECK (json_valid(peak_power_json)),
  CHECK (json_valid(sensor_quality_json)),
  PRIMARY KEY (activity_id, model_version)
);
CREATE INDEX IF NOT EXISTS idx_activity_coach_metrics_computed
  ON activity_coach_metrics (computed_at DESC);

-- Decisions are the appendable audit trail for generated weeks, post-run
-- verdicts, adaptations, phase changes, and zone updates. `status` may advance,
-- while the evidence/reasoning/patch payload remains attributable to a model and
-- policy version.
CREATE TABLE IF NOT EXISTS coach_decisions (
  id                     TEXT PRIMARY KEY,
  decision_type          TEXT NOT NULL,
  as_of                  TEXT NOT NULL,
  trigger_activity_id    TEXT,
  week_start             TEXT,
  status                 TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'applied', 'rejected', 'superseded')),
  request_id             TEXT UNIQUE,
  state_version_before   INTEGER,
  state_version_after    INTEGER,
  policy_version         TEXT NOT NULL,
  model_version          TEXT NOT NULL,
  summary                TEXT NOT NULL,
  reasoning              TEXT NOT NULL,
  evidence_json          TEXT NOT NULL DEFAULT '{}',
  plan_patch_json        TEXT NOT NULL DEFAULT '{}',
  state_before_json      TEXT NOT NULL DEFAULT '{}',
  state_after_json       TEXT NOT NULL DEFAULT '{}',
  created_at             TEXT NOT NULL,
  applied_at             TEXT,
  updated_at             TEXT NOT NULL,
  CHECK (json_valid(evidence_json)),
  CHECK (json_valid(plan_patch_json)),
  CHECK (json_valid(state_before_json)),
  CHECK (json_valid(state_after_json))
);
CREATE INDEX IF NOT EXISTS idx_coach_decisions_as_of
  ON coach_decisions (as_of DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coach_decisions_trigger
  ON coach_decisions (trigger_activity_id, created_at DESC);

-- Detailed strength work stays separate from running load. No FK is used for
-- gym_session_id because scheduled/full gym replacement must not erase manual
-- set notes.
CREATE TABLE IF NOT EXISTS strength_sets (
  id              TEXT PRIMARY KEY,
  gym_session_id  TEXT NOT NULL,
  exercise        TEXT NOT NULL,
  set_number      INTEGER CHECK (set_number IS NULL OR set_number > 0),
  weight_kg       REAL CHECK (weight_kg IS NULL OR weight_kg >= 0),
  reps            INTEGER CHECK (reps IS NULL OR reps >= 0),
  distance_m      REAL CHECK (distance_m IS NULL OR distance_m >= 0),
  duration_s      INTEGER CHECK (duration_s IS NULL OR duration_s >= 0),
  rir             REAL,
  raw_text        TEXT NOT NULL DEFAULT '',
  note            TEXT NOT NULL DEFAULT '',
  source          TEXT NOT NULL DEFAULT 'manual',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_strength_sets_session
  ON strength_sets (gym_session_id, set_number, created_at);
