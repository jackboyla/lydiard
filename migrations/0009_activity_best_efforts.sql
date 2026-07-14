-- Persist stream-derived/whole-run distance efforts once per activity so the
-- public best-efforts panel never has to rescan every historical stream.
CREATE TABLE IF NOT EXISTS activity_best_efforts (
  activity_id          TEXT NOT NULL,
  distance_label       TEXT NOT NULL,
  distance_km          REAL NOT NULL,
  seconds              REAL NOT NULL,
  pace_sec_per_km      REAL NOT NULL,
  source               TEXT NOT NULL CHECK (source IN ('stream', 'whole_run')),
  segment_start_sec    REAL,
  segment_end_sec      REAL,
  computed_at          TEXT NOT NULL,
  PRIMARY KEY (activity_id, distance_label),
  FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_activity_best_efforts_distance_time
  ON activity_best_efforts (distance_label, seconds, activity_id);
