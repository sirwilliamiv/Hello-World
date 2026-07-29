-- pay.invoices 1.0.0 — 20260701_create_pay_invoices (up)
--
-- INVOICE NUMBERING IS GAPLESS AND SEQUENTIAL PER LEGAL ENTITY.
--
-- `invoice_sequence` is deliberately NOT a Postgres SEQUENCE. `nextval()` is
-- non-transactional by design: it does not roll back, so a failed invoice insert
-- would burn a number and leave a gap — the classic audit finding this table
-- exists to prevent.
--
-- Instead the counter is a row, and it is incremented INSIDE the invoice insert
-- transaction with
--
--   INSERT INTO invoice_sequence (legal_entity, period, last_value)
--   VALUES ($1, $2, 1)
--   ON CONFLICT (legal_entity, period)
--   DO UPDATE SET last_value = invoice_sequence.last_value + 1
--   RETURNING last_value;
--
-- which is a single atomic statement that takes a row lock held until the
-- transaction ends. Two concurrent issues therefore serialise on that row: the
-- second blocks until the first commits and then reads the incremented value, so
-- they can never share a number. A rollback releases the lock and restores the
-- previous value, so the number is returned rather than burned.
--
-- `period` is derived from the tokens in the configured numbering scheme
-- (`{MM}` -> 'YYYY-MM', `{YYYY}`/`{YY}` -> 'YYYY', otherwise 'ALL'), because a
-- scheme that embeds the year restarts at 1 each year and "gapless" then means
-- gapless within the period.

CREATE TABLE invoice_sequence (
  legal_entity text   NOT NULL,
  period       text   NOT NULL,
  last_value   bigint NOT NULL DEFAULT 0 CHECK (last_value >= 0),
  PRIMARY KEY (legal_entity, period)
);

CREATE TABLE invoice (
  id                        text        PRIMARY KEY,
  legal_entity              text        NOT NULL,
  period                    text        NOT NULL,
  sequence_value            bigint      NOT NULL CHECK (sequence_value > 0),
  number                    text        NOT NULL,
  customer_id               text        NOT NULL,
  currency                  text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- Integer minor units throughout. A floating point money column is a defect.
  subtotal_minor            bigint      NOT NULL,
  tax_minor                 bigint      NOT NULL DEFAULT 0,
  total_minor               bigint      NOT NULL,
  paid_minor                bigint      NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  credited_minor            bigint      NOT NULL DEFAULT 0 CHECK (credited_minor >= 0),
  status                    text        NOT NULL CHECK (status IN ('open', 'part_paid', 'paid', 'void')),
  issued_at                 timestamptz NOT NULL DEFAULT now(),
  due_at                    timestamptz NOT NULL,
  voided_at                 timestamptz,
  -- The template version is pinned at issue time so reissuing a historical
  -- invoice renders byte-identically after the template has been edited.
  document_template         text,
  document_template_version text,
  metadata                  jsonb       NOT NULL DEFAULT '{}'::jsonb,

  -- The audit-facing guarantees, as constraints rather than as intentions:
  -- no two invoices for one legal entity share a number, and no two share a
  -- position in the sequence.
  CONSTRAINT invoice_number_key   UNIQUE (legal_entity, number),
  CONSTRAINT invoice_sequence_key UNIQUE (legal_entity, period, sequence_value)
);

CREATE INDEX invoice_customer_id_idx ON invoice (customer_id);
CREATE INDEX invoice_status_due_at_idx ON invoice (status, due_at);

CREATE TABLE invoice_line (
  id                text   PRIMARY KEY,
  invoice_id        text   NOT NULL REFERENCES invoice (id) ON DELETE CASCADE,
  position          integer NOT NULL,
  description       text   NOT NULL,
  -- Quantity in integer thousandths, so 2.5 hours is 2500 and no float exists.
  quantity_milli    bigint NOT NULL DEFAULT 1000 CHECK (quantity_milli > 0),
  unit_amount_minor bigint NOT NULL,
  amount_minor      bigint NOT NULL,
  tax_minor         bigint NOT NULL DEFAULT 0,
  metadata          jsonb  NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT invoice_line_position_key UNIQUE (invoice_id, position)
);

-- Append-only. A receipt records that a payment was applied to an invoice.
CREATE TABLE receipt (
  id                        text        PRIMARY KEY,
  invoice_id                text        NOT NULL REFERENCES invoice (id),
  -- The charge this receipt acknowledges. THE UNIQUE CONSTRAINT BELOW IS THE
  -- IDEMPOTENCY KEY FOR PAYMENT APPLICATION: `payment.succeeded` can be
  -- redelivered, and the second delivery loses the race to this index instead of
  -- crediting the invoice twice.
  charge_id                 text        NOT NULL,
  amount_minor              bigint      NOT NULL CHECK (amount_minor > 0),
  currency                  text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  issued_at                 timestamptz NOT NULL DEFAULT now(),
  document_template_version text,

  CONSTRAINT receipt_payment_applied_once UNIQUE (invoice_id, charge_id)
);

CREATE INDEX receipt_invoice_id_idx ON receipt (invoice_id);

-- Append-only. Corrections are credit notes, never edits to an issued invoice.
CREATE TABLE credit_note (
  id           text        PRIMARY KEY,
  invoice_id   text        NOT NULL REFERENCES invoice (id),
  amount_minor bigint      NOT NULL CHECK (amount_minor > 0),
  currency     text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reason       text        NOT NULL,
  -- Set when the credit note answers a refund. NULLs are distinct in Postgres,
  -- so manual credit notes are unconstrained while a redelivered
  -- `payment.refunded` collapses onto the existing row.
  refund_id    text,
  issued_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT credit_note_refund_applied_once UNIQUE (invoice_id, refund_id)
);

CREATE INDEX credit_note_invoice_id_idx ON credit_note (invoice_id);
