-- kernel.work 1.0.0 — the Job record.
--
-- The runtime is in-process: this table is a record of what ran, not a queue.
-- There is no lease column, no attempt history and no dead-letter table,
-- because there is no retry. ops.queue's 20260701_upgrade_kernel_work_to_ops_queue
-- reads the pending rows here so an upgrade does not drop in-flight work.

CREATE TABLE IF NOT EXISTS kernel_work_jobs (
  id            uuid        PRIMARY KEY,
  kind          text        NOT NULL,
  queue         text        NOT NULL DEFAULT 'default',
  payload       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  priority      integer     NOT NULL DEFAULT 100,
  status        text        NOT NULL DEFAULT 'pending',
  attempts      integer     NOT NULL DEFAULT 0,
  max_attempts  integer     NOT NULL DEFAULT 1,
  run_at        timestamptz NOT NULL DEFAULT now(),
  enqueued_at   timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  last_error    text,
  CONSTRAINT kernel_work_jobs_status_check
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS kernel_work_jobs_pending_idx
  ON kernel_work_jobs (run_at)
  WHERE status = 'pending';
