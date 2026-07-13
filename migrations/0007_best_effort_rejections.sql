-- Owner-curated exclusions for bad GPS/device-derived personal bests.
-- A rejection is scoped to one activity and one standard distance so a bad
-- short segment does not hide otherwise valid longer efforts from the run.
CREATE TABLE IF NOT EXISTS best_effort_rejections (
  distance_label TEXT NOT NULL,
  activity_id    TEXT NOT NULL,
  reason         TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (distance_label, activity_id)
);

CREATE INDEX IF NOT EXISTS idx_best_effort_rejections_activity
  ON best_effort_rejections (activity_id);
