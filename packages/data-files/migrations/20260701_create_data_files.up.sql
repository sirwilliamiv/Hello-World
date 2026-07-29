-- data.files 1.0.0 — 20260701_create_data_files
--
-- A file row is created before its bytes exist and is not retrievable until
-- `status = 'available'`, which only the scan job may set. The CHECK constraints
-- keep that lifecycle enforceable in the database rather than only in code.

CREATE TABLE data_files_file (
  id                  TEXT PRIMARY KEY,
  filename            TEXT        NOT NULL,
  content_type        TEXT        NOT NULL,
  size_bytes          INTEGER     NOT NULL CHECK (size_bytes >= 0),
  owner_id            TEXT,
  checksum            TEXT,
  storage_key         TEXT        NOT NULL,
  status              TEXT        NOT NULL DEFAULT 'awaiting_upload'
                      CHECK (status IN ('awaiting_upload','scanning','available','quarantined','deleted')),
  scan_status         TEXT        NOT NULL DEFAULT 'pending'
                      CHECK (scan_status IN ('pending','clean','infected','unavailable','skipped')),
  scanner             TEXT,
  quarantine_reason   TEXT,
  attached_to_entity  TEXT,
  attached_to_id      TEXT,
  deleted_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- An available file must have been scanned. This is the invariant the whole
  -- capability exists to hold, so it is a constraint and not a convention.
  CONSTRAINT data_files_file_scanned_before_available
    CHECK (status <> 'available' OR scan_status IN ('clean','skipped'))
);

CREATE UNIQUE INDEX data_files_file_storage_key_idx ON data_files_file (storage_key);
CREATE INDEX data_files_file_attachment_idx ON data_files_file (attached_to_entity, attached_to_id);
CREATE INDEX data_files_file_owner_idx ON data_files_file (owner_id);
CREATE INDEX data_files_file_status_idx ON data_files_file (status);

-- Append-only: versions are inserted, never rewritten.
CREATE TABLE data_files_file_version (
  id           TEXT PRIMARY KEY,
  file_id      TEXT        NOT NULL REFERENCES data_files_file (id) ON DELETE CASCADE,
  version      INTEGER     NOT NULL CHECK (version >= 1),
  storage_key  TEXT        NOT NULL,
  size_bytes   INTEGER     NOT NULL CHECK (size_bytes >= 0),
  checksum     TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX data_files_file_version_idx ON data_files_file_version (file_id, version);

CREATE TABLE data_files_upload_session (
  id             TEXT PRIMARY KEY,
  file_id        TEXT        NOT NULL REFERENCES data_files_file (id) ON DELETE CASCADE,
  storage_key    TEXT        NOT NULL,
  method         TEXT        NOT NULL CHECK (method IN ('PUT','POST')),
  url            TEXT        NOT NULL,
  content_type   TEXT        NOT NULL,
  max_size_bytes INTEGER     NOT NULL CHECK (max_size_bytes > 0),
  owner_id       TEXT,
  expires_at     TIMESTAMPTZ NOT NULL,
  completed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX data_files_upload_session_expiry_idx ON data_files_upload_session (expires_at);

CREATE TABLE data_files_thumbnail (
  id           TEXT PRIMARY KEY,
  file_id      TEXT        NOT NULL REFERENCES data_files_file (id) ON DELETE CASCADE,
  kind         TEXT        NOT NULL,
  storage_key  TEXT        NOT NULL,
  width        INTEGER,
  height       INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX data_files_thumbnail_kind_idx ON data_files_thumbnail (file_id, kind);
