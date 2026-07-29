-- kernel.mail 1.0.0 — the OutboundMessage delivery record.
--
-- `body` is deliberately absent as a retained column: the message text lives in
-- `body_pending` only between enqueue and delivery, and is cleared on send. A
-- verification link kept forever is a live credential kept forever.
--
-- personal_data: true. The privacy handlers are exportMessages and
-- deleteMessages, and the declared deletion strategy is a hard delete.

CREATE TABLE IF NOT EXISTS kernel_mail_outbound_messages (
  id              uuid        PRIMARY KEY,
  to_address      text        NOT NULL,
  from_address    text        NOT NULL,
  subject         text        NOT NULL,
  kind            text        NOT NULL DEFAULT 'system',
  subject_user_id uuid,
  status          text        NOT NULL DEFAULT 'queued',
  body_pending    text,
  idempotency_key text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  last_error      text,
  CONSTRAINT kernel_mail_outbound_messages_status_check
    CHECK (status IN ('queued', 'sent', 'failed')),
  CONSTRAINT kernel_mail_outbound_messages_kind_check
    CHECK (kind IN ('verification', 'password_reset', 'system'))
);

-- Privacy export and deletion both look messages up by data subject.
CREATE INDEX IF NOT EXISTS kernel_mail_outbound_messages_subject_idx
  ON kernel_mail_outbound_messages (subject_user_id);

CREATE UNIQUE INDEX IF NOT EXISTS kernel_mail_outbound_messages_idempotency_idx
  ON kernel_mail_outbound_messages (idempotency_key);
