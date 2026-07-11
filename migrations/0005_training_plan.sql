-- One editable plan row per local calendar day. Actual runs remain sourced from
-- `activities` and are joined by local date at read time, so Garmin refreshes
-- automatically populate the plan without duplicating activity data here.
CREATE TABLE IF NOT EXISTS training_plan_days (
  plan_date            TEXT PRIMARY KEY,
  planned_text         TEXT NOT NULL DEFAULT '',
  legacy_planned_text  TEXT NOT NULL DEFAULT '',
  legacy_actual_text   TEXT NOT NULL DEFAULT '',
  notes                TEXT NOT NULL DEFAULT '',
  source               TEXT NOT NULL DEFAULT 'manual',
  source_file          TEXT,
  imported_at          TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  CHECK (
    length(plan_date) = 10
    AND plan_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  )
);

CREATE INDEX IF NOT EXISTS idx_training_plan_source
  ON training_plan_days (source, plan_date);

-- The original sheet plan is provenance. User edits go to `planned_text` and
-- must never rewrite the imported original.
CREATE TRIGGER IF NOT EXISTS training_plan_legacy_planned_immutable
BEFORE UPDATE OF legacy_planned_text ON training_plan_days
WHEN NEW.legacy_planned_text != OLD.legacy_planned_text
BEGIN
  SELECT RAISE(ABORT, 'legacy_planned_text is immutable');
END;
