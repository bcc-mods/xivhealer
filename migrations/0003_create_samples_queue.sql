CREATE TABLE samples_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  encounter_id  INTEGER NOT NULL,
  report_code   TEXT    NOT NULL,
  fight_id      INTEGER NOT NULL,
  duration_ms   INTEGER NOT NULL,
  sampled       INTEGER NOT NULL DEFAULT 0,
  sampled_at    INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (report_code, fight_id)
);

CREATE INDEX idx_samples_queue_pick
  ON samples_queue (encounter_id, sampled, sampled_at);
