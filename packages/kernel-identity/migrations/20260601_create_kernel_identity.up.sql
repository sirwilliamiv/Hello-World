-- kernel.identity@1.0.0 — 20260601_create_kernel_identity
--
-- Hand-written and reviewed, not a drizzle-kit diff (ARCHITECTURE.md §14.1).
-- None of these entities is tenant-scoped, so no organization column appears
-- here; org.teams adds one to tenant-scoped entities only, and the tenant
-- predicate is bound by kernel.data's Repository rather than by SQL (§14.2).

CREATE TABLE identity_users (
  id                TEXT        PRIMARY KEY,
  email             TEXT        NOT NULL,
  name              TEXT,
  email_verified_at TIMESTAMPTZ,
  disabled_at       TIMESTAMPTZ,
  anonymized_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);

CREATE UNIQUE INDEX identity_users_email_key ON identity_users (email);

CREATE TABLE identity_sessions (
  id             TEXT        PRIMARY KEY,
  user_id        TEXT        NOT NULL REFERENCES identity_users (id),
  token_hash     TEXT        NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ,
  revoked_reason TEXT,
  ip             TEXT,
  user_agent     TEXT,
  last_seen_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);

-- Authentication is one indexed equality lookup on the digest, on every
-- request, which is what makes revocation take effect immediately.
CREATE UNIQUE INDEX identity_sessions_token_hash_key ON identity_sessions (token_hash);
CREATE INDEX identity_sessions_user_id_idx ON identity_sessions (user_id);

CREATE TABLE identity_credentials (
  id         TEXT        PRIMARY KEY,
  user_id    TEXT        NOT NULL REFERENCES identity_users (id),
  kind       TEXT        NOT NULL,
  secret     TEXT        NOT NULL,
  rotated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX identity_credentials_user_kind_key
  ON identity_credentials (user_id, kind);

CREATE TABLE identity_email_verifications (
  id          TEXT        PRIMARY KEY,
  user_id     TEXT        NOT NULL REFERENCES identity_users (id),
  email       TEXT        NOT NULL,
  token_hash  TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

CREATE UNIQUE INDEX identity_email_verifications_token_hash_key
  ON identity_email_verifications (token_hash);

CREATE TABLE identity_password_resets (
  id           TEXT        PRIMARY KEY,
  user_id      TEXT        NOT NULL REFERENCES identity_users (id),
  token_hash   TEXT        NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,
  requested_ip TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);

CREATE UNIQUE INDEX identity_password_resets_token_hash_key
  ON identity_password_resets (token_hash);
