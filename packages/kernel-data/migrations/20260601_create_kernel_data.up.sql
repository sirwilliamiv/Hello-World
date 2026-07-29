-- kernel.data@1.0.0 — 20260601_create_kernel_data
-- Runs first in every product: it is the only capability nothing depends upon.

-- gen_random_uuid() is core from PG13, but the extension keeps the schema
-- portable to older servers rather than failing at the first insert.
create extension if not exists pgcrypto;

-- The migration ledger. The runner also ensures this exists before applying
-- anything, so it is idempotent by necessity, not just by convention.
create table if not exists forge_migrations (
  id                 text primary key,
  capability         text not null,
  checksum           text not null,
  rollback_available boolean not null default true,
  applied_serial     integer not null,
  applied_at         timestamptz not null default now()
);
create index if not exists forge_migrations_capability_idx on forge_migrations (capability);
