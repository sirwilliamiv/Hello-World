-- pay.card 1.0.0 — 20260701_create_pay_card (up)
--
-- CARD DATA NEVER TOUCHES THIS DATABASE.
--
-- There is deliberately no column in this migration capable of holding a PAN, a
-- CVC/CVV, a full expiry+PAN pair, or a track/magstripe blob. The only thing we
-- persist is an OPAQUE PROVIDER REFERENCE (`provider_ref`, `external_id`) plus
-- the display-only fragments Stripe hands back (brand, last4). `last4` carries a
-- CHECK constraint that makes it structurally incapable of holding a full card
-- number.
--
-- `charge` and `refund` are APPEND-ONLY (spec `owns[].append_only`). They have no
-- `updated_at` and no soft-delete column; corrections are refunds, never edits.
-- Append-only is enforced by @forge/kernel-data's repository layer. The one
-- sanctioned mutation is the privacy anonymisation handler, which is why there is
-- no database-level immutability trigger here.

CREATE TABLE payment_method (
  id           text        PRIMARY KEY,
  customer_id  text        NOT NULL,
  provider     text        NOT NULL DEFAULT 'stripe',
  -- Opaque provider handle, e.g. 'pm_1NxABC...'. Not derived from the card.
  provider_ref text        NOT NULL,
  brand        text,                    -- 'visa' — display only
  last4        text,                    -- display only, never a PAN
  exp_month    smallint,
  exp_year     smallint,
  is_default   boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  detached_at  timestamptz,

  CONSTRAINT payment_method_provider_ref_key UNIQUE (provider, provider_ref),
  -- Structural guarantee: this column cannot hold a card number.
  CONSTRAINT payment_method_last4_is_not_a_pan CHECK (last4 IS NULL OR last4 ~ '^[0-9]{4}$'),
  CONSTRAINT payment_method_exp_month_range CHECK (exp_month IS NULL OR (exp_month BETWEEN 1 AND 12))
);

CREATE INDEX payment_method_customer_id_idx ON payment_method (customer_id);

CREATE TABLE charge (
  id                   text        PRIMARY KEY,
  customer_id          text        NOT NULL,
  payment_method_id    text        REFERENCES payment_method (id),
  -- Integer minor units. A floating point money column is a defect.
  amount_minor         bigint      NOT NULL CHECK (amount_minor >= 0),
  currency             text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status               text        NOT NULL CHECK (status IN ('succeeded', 'failed', 'requires_capture')),
  provider             text        NOT NULL DEFAULT 'stripe',
  -- Stripe PaymentIntent id. Opaque, and the webhook idempotency key.
  external_id          text        NOT NULL,
  invoice_id           text,
  statement_descriptor text,
  failure_reason       text,
  decline_code         text,
  metadata             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),

  -- Redelivered webhooks and retried charges collapse onto one row.
  CONSTRAINT charge_external_id_key UNIQUE (provider, external_id)
);

CREATE INDEX charge_customer_id_idx ON charge (customer_id);
CREATE INDEX charge_invoice_id_idx  ON charge (invoice_id);

CREATE TABLE refund (
  id           text        PRIMARY KEY,
  charge_id    text        NOT NULL REFERENCES charge (id),
  amount_minor bigint      NOT NULL CHECK (amount_minor > 0),
  currency     text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reason       text,
  provider     text        NOT NULL DEFAULT 'stripe',
  external_id  text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT refund_external_id_key UNIQUE (provider, external_id)
);

CREATE INDEX refund_charge_id_idx ON refund (charge_id);
