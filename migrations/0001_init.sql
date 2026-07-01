-- Lydiard training store. Single source of truth for the map, dashboard, and agent API.

CREATE TABLE IF NOT EXISTS athlete (
  id            INTEGER PRIMARY KEY,   -- Strava athlete id
  firstname     TEXT,
  lastname      TEXT,
  username      TEXT,
  access_token  TEXT,
  refresh_token TEXT,
  expires_at    INTEGER,               -- unix seconds
  scope         TEXT,
  updated_at    TEXT
);

CREATE TABLE IF NOT EXISTS activities (
  id                  TEXT PRIMARY KEY,   -- Strava activity id (as text)
  name                TEXT,
  sport_type          TEXT,
  start_date          TEXT,               -- UTC ISO 8601
  start_date_local    TEXT,
  distance_km         REAL,
  moving_time_s       INTEGER,
  elapsed_time_s      INTEGER,
  average_heartrate   REAL,
  max_heartrate       REAL,
  average_cadence_spm REAL,
  elevation_gain_m    REAL,
  relative_effort     REAL,
  average_speed       REAL,               -- m/s
  start_lat           REAL,
  start_lng           REAL,
  end_lat             REAL,
  end_lng             REAL,
  summary_polyline    TEXT,               -- encoded polyline for overview map
  has_streams         INTEGER DEFAULT 0,
  decoupling_pct      REAL,               -- true first/second-half HR-pace decoupling
  created_at          TEXT,
  updated_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_activities_start ON activities (start_date);
CREATE INDEX IF NOT EXISTS idx_activities_has_streams ON activities (has_streams);

CREATE TABLE IF NOT EXISTS activity_streams (
  activity_id TEXT PRIMARY KEY REFERENCES activities (id) ON DELETE CASCADE,
  latlng      TEXT,   -- JSON [[lat,lng],...] (Douglas-Peucker simplified)
  time_s      TEXT,   -- JSON number[] (decimated)
  heartrate   TEXT,   -- JSON number[]
  cadence     TEXT,   -- JSON number[]
  velocity    TEXT,   -- JSON number[] m/s
  altitude    TEXT,   -- JSON number[] m
  distance_m  TEXT,   -- JSON number[] m
  point_count INTEGER,
  fetched_at  TEXT
);

CREATE TABLE IF NOT EXISTS weekly_features (
  week_start  TEXT PRIMARY KEY,   -- YYYY-MM-DD (Monday)
  year        INTEGER,
  data        TEXT,               -- JSON WeeklyRunBlock
  computed_at TEXT
);

CREATE TABLE IF NOT EXISTS sync_state (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  last_sync_at       TEXT,
  last_activity_date TEXT,
  last_result        TEXT,   -- JSON summary of the last sync run
  last_error         TEXT,
  rate_limit         TEXT    -- JSON snapshot of Strava rate-limit headers
);
INSERT OR IGNORE INTO sync_state (id) VALUES (1);
