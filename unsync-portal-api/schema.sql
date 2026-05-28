-- Reference schema for a future SQLite/Postgres store.
-- The current v1 service uses a zero-dependency JSON file store with the same fields.
CREATE TABLE secure_portal_payloads (
  portal_id TEXT PRIMARY KEY,
  access_token_hash TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  recipient_emails_json TEXT NOT NULL DEFAULT '[]',
  encrypted_payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  idle_timeout_seconds INTEGER NOT NULL,
  one_time_read INTEGER NOT NULL DEFAULT 0,
  is_consumed INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT,
  delete_after TEXT,
  last_access_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_secure_portal_payloads_expires
  ON secure_portal_payloads (expires_at);

CREATE TABLE secure_portal_attachment_chunks (
  portal_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  encrypted_size INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (portal_id, attachment_id, chunk_index)
);
