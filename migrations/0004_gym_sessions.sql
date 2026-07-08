-- Gym / strength sessions live in their own table. They are intentionally kept
-- OUT of `activities` so they never enter the running load model, weekly
-- derivation, run counts, or averages. They exist only to show when gym work
-- happened over time.
CREATE TABLE IF NOT EXISTS gym_sessions (
  id                TEXT PRIMARY KEY,   -- e.g. garmin-<activity_id>
  name              TEXT,
  sport_type        TEXT,               -- strength_training | fitness_equipment | ...
  start_date        TEXT,               -- UTC ISO 8601
  start_date_local  TEXT,
  duration_s        INTEGER,
  average_heartrate REAL,
  calories          REAL,
  created_at        TEXT,
  updated_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_gym_start ON gym_sessions (start_date);
