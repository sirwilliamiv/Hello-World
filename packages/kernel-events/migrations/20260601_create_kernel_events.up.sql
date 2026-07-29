-- kernel.events@1.0.0 — 20260601_create_kernel_events
create table if not exists events (
  id               uuid primary key default gen_random_uuid(),
  name             varchar(200) not null,
  contract_version integer not null,
  payload          jsonb not null,
  source           varchar(100),
  actor            text,
  tenant_id        uuid,
  correlation_id   uuid,
  causation_id     uuid,
  occurred_at      timestamptz not null default now()
);
create index if not exists events_name_idx on events (name, occurred_at desc);
create index if not exists events_tenant_idx on events (tenant_id, occurred_at desc);

create table if not exists subscriptions (
  id                uuid primary key default gen_random_uuid(),
  pattern           varchar(200) not null,
  consumer          varchar(100) not null,
  handler           varchar(200) not null,
  contract_versions jsonb not null,
  created_at        timestamptz not null default now()
);

create table if not exists dead_letters (
  id               uuid primary key default gen_random_uuid(),
  event_id         uuid not null,
  event_name       varchar(200) not null,
  contract_version integer not null,
  consumer         varchar(100) not null,
  subscription_id  varchar(100) not null,
  payload          jsonb not null,
  error            text not null,
  stack            text,
  attempts         integer not null default 1,
  failed_at        timestamptz not null default now(),
  replayed_at      timestamptz
);
create index if not exists dead_letters_unreplayed_idx on dead_letters (failed_at desc)
  where replayed_at is null;

-- The event log is append-only: replay and audit both read it, and a rewritten
-- history makes both worthless. Enforced by the database so a direct SQL path
-- cannot bypass the repository layer.
create or replace function events_append_only() returns trigger as $$
begin
  raise exception 'events is append-only; the log is the record of what happened';
end;
$$ language plpgsql;

drop trigger if exists events_no_mutate on events;
create trigger events_no_mutate before update or delete on events
  for each row execute function events_append_only();
