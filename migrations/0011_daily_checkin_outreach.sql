-- Make the existing subjective check-in usable as a fast daily pulse and keep
-- an idempotent record of each active outreach attempt.
ALTER TABLE daily_checkins ADD COLUMN pain_level INTEGER
  CHECK (pain_level IS NULL OR pain_level BETWEEN 0 AND 3);
ALTER TABLE daily_checkins ADD COLUMN source TEXT NOT NULL DEFAULT 'platform';

CREATE TABLE IF NOT EXISTS daily_checkin_prompts (
  day          TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  channel      TEXT NOT NULL DEFAULT 'whatsapp',
  status       TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'completed', 'failed')),
  message_id   TEXT,
  last_error   TEXT,
  expires_at   TEXT NOT NULL,
  sent_at      TEXT,
  completed_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  CHECK (length(day) = 10)
);

CREATE INDEX IF NOT EXISTS idx_daily_checkin_prompts_status
  ON daily_checkin_prompts (status, day);
