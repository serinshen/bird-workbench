-- Live store for observations, photos, notes, favorites, and sign-in.
-- Git copies of data/observations.json, data/notes.json, and photos/ stay as backup.

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  scientific_name TEXT NOT NULL,
  datetime TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  detection TEXT NOT NULL CHECK (detection IN ('seen', 'heard')),
  suspicious INTEGER NOT NULL DEFAULT 0 CHECK (suspicious IN (0, 1)),
  sex TEXT,
  place TEXT NOT NULL,
  location_json TEXT NOT NULL,
  notes TEXT,
  habitat TEXT,
  weather_light TEXT,
  source_group TEXT,
  logged_chinese TEXT,
  logged_english TEXT,
  open_question_json TEXT,
  legacy_json TEXT,
  uploaded_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_observations_sci ON observations (scientific_name);
CREATE INDEX IF NOT EXISTS idx_observations_uploaded ON observations (uploaded_at);

CREATE TABLE IF NOT EXISTS photos (
  path TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL,
  sort_index INTEGER NOT NULL,
  watermark TEXT,
  bytes INTEGER
);

CREATE INDEX IF NOT EXISTS idx_photos_observation ON photos (observation_id, sort_index);

CREATE TABLE IF NOT EXISTS favorites (
  observation_id TEXT NOT NULL,
  path TEXT NOT NULL,
  favorited_at TEXT NOT NULL,
  PRIMARY KEY (observation_id, path)
);

CREATE TABLE IF NOT EXISTS notes (
  scientific_name TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_challenges (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  magic_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  request_ip TEXT
);

CREATE INDEX IF NOT EXISTS idx_login_email ON login_challenges (email, created_at);

CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
