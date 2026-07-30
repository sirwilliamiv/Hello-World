-- ops.queue 1.0.0 — durable job storage, leasing, and scheduling.
--
-- Hand-written rather than diffed out of drizzle-kit, per ARCHITECTURE.md
-- section 14.1: a generated diff cannot express a backfill and cannot be
-- rolled back. src/schema.ts is the Drizzle mirror of these tables.
--
-- gen_random_uuid() is built in from PostgreSQL 13.

CREATE TABLE IF NOT EXISTS ops_queue_jobs (
  id              uuid        PRIMARY KEY,
  queue           text        NOT NULL DEFAULT 'default',
  kind            text        NOT NULL,
  payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- Higher runs first.
  priority        integer     NOT NULL DEFAULT 100,
  status          text        NOT NULL DEFAULT 'pending',
  attempts        integer     NOT NULL DEFAULT 0,
  max_attempts    integer     NOT NULL,
  run_at          timestamptz NOT NULL DEFAULT now(),
  enqueued_at     timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- Held by the worker that leased the row. NULL means nobody holds it.
  locked_at       timestamptz,
  locked_by       text,
  last_error      text,
  idempotency_key text,
  schedule_id     uuid,
  CONSTRAINT ops_queue_jobs_status_check
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed',
                      'dead_lettered', 'cancelled'))
);

-- The lease query's index. Partial, so it stays proportional to the backlog
-- rather than to the completed-job history.
CREATE INDEX IF NOT EXISTS ops_queue_jobs_runnable_idx
  ON ops_queue_jobs (queue, priority DESC, run_at ASC)
  WHERE status = 'pending';

-- Drives reclaim of leases whose worker died.
CREATE INDEX IF NOT EXISTS ops_queue_jobs_lease_idx
  ON ops_queue_jobs (locked_at)
  WHERE status = 'running';

-- NULLs are distinct in Postgres, so jobs without a key are unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS ops_queue_jobs_idempotency_key_idx
  ON ops_queue_jobs (idempotency_key);

-- Append-only: a flapping job's failure pattern stays visible instead of being
-- overwritten by its latest attempt.
CREATE TABLE IF NOT EXISTS ops_queue_job_attempts (
  id          uuid        PRIMARY KEY,
  job_id      uuid        NOT NULL REFERENCES ops_queue_jobs (id) ON DELETE CASCADE,
  attempt     integer     NOT NULL,
  started_at  timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  outcome     text        NOT NULL,
  error       text,
  CONSTRAINT ops_queue_job_attempts_outcome_check
    CHECK (outcome IN ('succeeded', 'failed'))
);

CREATE INDEX IF NOT EXISTS ops_queue_job_attempts_job_idx
  ON ops_queue_job_attempts (job_id, attempt);

CREATE TABLE IF NOT EXISTS ops_queue_dead_letters (
  id               uuid        PRIMARY KEY,
  -- UNIQUE is what makes "dead-letters exactly once" a database guarantee
  -- rather than an application convention.
  job_id           uuid        NOT NULL UNIQUE
                               REFERENCES ops_queue_jobs (id) ON DELETE CASCADE,
  queue            text        NOT NULL,
  kind             text        NOT NULL,
  -- The payload as it was when the job failed, so replay is faithful.
  payload          jsonb       NOT NULL,
  attempts         integer     NOT NULL,
  error            text        NOT NULL,
  dead_lettered_at timestamptz NOT NULL DEFAULT now(),
  replayed_at      timestamptz,
  replay_job_id    uuid
);

CREATE TABLE IF NOT EXISTS ops_queue_scheduled_jobs (
  id           uuid        PRIMARY KEY,
  cron         text        NOT NULL,
  queue        text        NOT NULL DEFAULT 'default',
  kind         text        NOT NULL,
  payload      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  priority     integer     NOT NULL DEFAULT 100,
  max_attempts integer     NOT NULL,
  next_run_at  timestamptz NOT NULL,
  last_run_at  timestamptz,
  active       boolean     NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS ops_queue_scheduled_jobs_due_idx
  ON ops_queue_scheduled_jobs (next_run_at)
  WHERE active;
