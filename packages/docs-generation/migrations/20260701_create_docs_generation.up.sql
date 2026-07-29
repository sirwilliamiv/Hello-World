-- docs.generation 1.0.0 — 20260701_create_docs_generation

CREATE TABLE docs_generation_template (
  id               TEXT PRIMARY KEY,
  key              TEXT        NOT NULL,
  name             TEXT        NOT NULL,
  description      TEXT,
  current_version  INTEGER     NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX docs_generation_template_key_idx ON docs_generation_template (key);

-- Append-only. A rendering references the version it used, so editing a template can
-- never retroactively change an issued document. The trigger below makes that true of
-- the database and not only of the application.
CREATE TABLE docs_generation_template_version (
  id           TEXT PRIMARY KEY,
  template_id  TEXT        NOT NULL REFERENCES docs_generation_template (id) ON DELETE RESTRICT,
  version      INTEGER     NOT NULL CHECK (version >= 1),
  source       TEXT        NOT NULL,
  source_hash  TEXT        NOT NULL,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX docs_generation_template_version_idx
  ON docs_generation_template_version (template_id, version);

CREATE OR REPLACE FUNCTION docs_generation_template_version_is_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'docs_generation_template_version is append-only: publish a new version instead of editing version % of template %',
    OLD.version, OLD.template_id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER docs_generation_template_version_no_update
  BEFORE UPDATE OR DELETE ON docs_generation_template_version
  FOR EACH ROW EXECUTE FUNCTION docs_generation_template_version_is_append_only();

CREATE TABLE docs_generation_document (
  id                TEXT PRIMARY KEY,
  template_id       TEXT        NOT NULL REFERENCES docs_generation_template (id) ON DELETE RESTRICT,
  template_key      TEXT        NOT NULL,
  -- The pin. Deliberately not a foreign key to "the current version".
  template_version  INTEGER     NOT NULL CHECK (template_version >= 1),
  format            TEXT        NOT NULL,
  file_id           TEXT,
  content_hash      TEXT        NOT NULL,
  data_hash         TEXT        NOT NULL,
  data              JSONB,
  subject_ref       TEXT,
  generated_by      TEXT,
  anonymised_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT docs_generation_document_version_exists
    FOREIGN KEY (template_id, template_version)
    REFERENCES docs_generation_template_version (template_id, version)
    ON DELETE RESTRICT,

  -- Anonymisation clears the render data; a document that still has data must not
  -- claim to be anonymised.
  CONSTRAINT docs_generation_document_anonymised_has_no_data
    CHECK (anonymised_at IS NULL OR data IS NULL)
);

CREATE INDEX docs_generation_document_subject_idx ON docs_generation_document (subject_ref);
CREATE INDEX docs_generation_document_template_idx
  ON docs_generation_document (template_id, template_version);
CREATE INDEX docs_generation_document_content_idx ON docs_generation_document (content_hash);
