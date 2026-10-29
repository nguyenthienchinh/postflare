-- One-time upload links: let a phone browser or an AI sandbox upload media without a session or API key.
CREATE TABLE upload_links (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  note TEXT,
  media TEXT NOT NULL DEFAULT '[]', -- JSON array of media ids uploaded through the link
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
