-- kernel.money@1.0.0 — 20260601_create_kernel_money
create table if not exists currencies (
  code        varchar(3) primary key,
  name        text not null,
  symbol      text,
  -- The exponent, so an amount can be rendered from integer minor units.
  -- Nothing here stores a float: floating point currency is a defect.
  minor_units integer not null,
  enabled     boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists exchange_rates (
  id            uuid primary key default gen_random_uuid(),
  from_currency varchar(3) not null,
  to_currency   varchar(3) not null,
  -- Exact decimal, never a float, so a historical conversion is reproducible.
  rate          numeric(24,12) not null,
  as_of         timestamptz not null,
  source        text,
  created_at    timestamptz not null default now()
);
create unique index if not exists exchange_rates_pair_asof_idx
  on exchange_rates (from_currency, to_currency, as_of);
