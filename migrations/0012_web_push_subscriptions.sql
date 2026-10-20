-- First-party browser/phone push. The endpoint and keys come from the browser's
-- standards-based PushSubscription and let Lydiard send without a phone number
-- or a paid messaging provider.
CREATE TABLE IF NOT EXISTS web_push_subscriptions (
  endpoint_hash   TEXT PRIMARY KEY,
  endpoint        TEXT NOT NULL,
  p256dh           TEXT NOT NULL,
  auth             TEXT NOT NULL,
  user_agent       TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  last_success_at  TEXT,
  last_error       TEXT
);
