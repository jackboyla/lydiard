-- Preserve device-recorded lap boundaries and summary metrics alongside the
-- aligned activity streams. JSON keeps the naturally nested, optional FIT lap
-- fields together and avoids a row explosion on detail reads.
ALTER TABLE activity_streams ADD COLUMN laps TEXT;
