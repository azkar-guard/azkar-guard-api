-- One row per browser push subscription. No account, no location: only the push
-- endpoint and keys, the language, and the upcoming window times the app uploads.
CREATE TABLE subscriptions (
  -- Random id returned to the app; knowing it is what authorizes updates and deletes.
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  lang TEXT NOT NULL CHECK (lang IN ('en', 'ar')),
  -- JSON array of {key, session, start, end}, epoch ms.
  windows TEXT NOT NULL,
  -- JSON array of window keys completed in the app.
  done TEXT NOT NULL DEFAULT '[]',
  last_sent INTEGER,
  -- When the cron should send the next reminder; NULL when nothing is left to send.
  next_due INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX subscriptions_next_due ON subscriptions (next_due) WHERE next_due IS NOT NULL;
