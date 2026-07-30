-- kernel.access@1.0.0 — 20260601_create_kernel_access
--
-- Role and RoleAssignment are declared tenant_scoped. No organization column
-- appears here: org.teams adds one to every tenant-scoped entity, and the
-- tenant predicate is bound by kernel.data's Repository rather than by SQL
-- (ARCHITECTURE.md §14.2). `scope` below is a role's own scope, not a tenant.

CREATE TABLE access_roles (
  id          TEXT        PRIMARY KEY,
  name        TEXT        NOT NULL,
  description TEXT,
  grants      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  inherits    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  rank        INTEGER     NOT NULL DEFAULT 0,
  built_in    BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

CREATE UNIQUE INDEX access_roles_name_key ON access_roles (name);

CREATE TABLE access_role_assignments (
  id         TEXT        PRIMARY KEY,
  user_id    TEXT        NOT NULL REFERENCES identity_users (id),
  role       TEXT        NOT NULL,
  scope      TEXT,
  granted_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX access_role_assignments_user_id_idx ON access_role_assignments (user_id);

-- NULLS NOT DISTINCT so a second *global* grant of the same role collides
-- rather than silently duplicating. Without it, scope IS NULL rows would each
-- be considered distinct and the uniqueness would only hold for scoped grants.
CREATE UNIQUE INDEX access_role_assignments_unique
  ON access_role_assignments (user_id, role, scope) NULLS NOT DISTINCT;

-- The four roles this capability ships. Only owner carries a blanket grant;
-- everything below it is granted by a permission's declared default_roles or by
-- the client's roleDefinitions slot.
INSERT INTO access_roles (id, name, description, grants, inherits, rank, built_in) VALUES
  ('role_owner',  'owner',  'Full control, including destructive and financial actions.',
   '["*"]'::jsonb, '[]'::jsonb,         400, true),
  ('role_admin',  'admin',  'Day-to-day administration. Inherits everything a member can do.',
   '[]'::jsonb,    '["member"]'::jsonb, 300, true),
  ('role_member', 'member', 'The default role. Inherits everything a viewer can do.',
   '[]'::jsonb,    '["viewer"]'::jsonb, 200, true),
  ('role_viewer', 'viewer', 'Read-only participation.',
   '[]'::jsonb,    '[]'::jsonb,         100, true);
