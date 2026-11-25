-- Live location sharing tables (Cloudflare D1). The D1 web console joins pasted lines into one,
-- so paste the one-line version from README.md there, not this file.

-- Latest position per phone that shares: what the map shows.
CREATE TABLE IF NOT EXISTS pos (
  id   TEXT PRIMARY KEY,   -- random device id (secret, never sent to other phones)
  pub  TEXT NOT NULL,      -- short public key derived from id (used to tell the dots apart)
  name TEXT NOT NULL,      -- display name chosen by the skier, may be empty
  lat  REAL NOT NULL,
  lon  REAL NOT NULL,
  acc  INTEGER NOT NULL,   -- GPS accuracy in metres
  t    INTEGER NOT NULL    -- time of the position, ms since 1970
);
CREATE INDEX IF NOT EXISTS pos_t ON pos (t);

-- Emergency record: every position for 2 hours, then one per 20 minutes, deleted after 2 days.
CREATE TABLE IF NOT EXISTS track (
  id   TEXT NOT NULL,
  name TEXT NOT NULL,
  lat  REAL NOT NULL,
  lon  REAL NOT NULL,
  acc  INTEGER NOT NULL,
  t    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS track_t ON track (t);
CREATE INDEX IF NOT EXISTS track_id_t ON track (id, t);

-- Small key/value store (time of the last tidy-up).
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
