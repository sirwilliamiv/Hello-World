-- ops.queue 1.0.0 — the upgrade migration named by `upgrades.migration`.
--
-- An upgrade with no migration path cannot be applied to a live client: at the
-- moment ops.queue takes over kernel.work's slot there may be jobs sitting in
-- kernel_work_jobs that nobody will ever run again, because the in-process
-- runner that was going to run them is being replaced. Moving them is the
-- difference between an upgrade and a data-loss incident.
--
-- Only pending work moves. Succeeded, failed and cancelled rows are history and
-- stay where they are, so the migration is safe to run against a large table
-- and the old record remains inspectable.

-- An upgrade migration must be safe on a FRESH product, not only on one being
-- upgraded in place.
--
-- ops.queue supersedes kernel.work, and a superseded capability's migrations
-- never run — so when a client selects Background Processing from day one,
-- kernel_work_jobs does not exist and never will. Carrying pending work across
-- is meaningful only when there was a kernel.work to carry it from.
--
-- This applies to every upgrade in the catalog: access.rebac over kernel.access,
-- comms.email over kernel.mail, audit.history over kernel.audit.
DO $upgrade$
BEGIN
  IF to_regclass('public.kernel_work_jobs') IS NULL THEN
    RAISE NOTICE 'kernel_work_jobs absent: fresh install, no in-flight work to carry across';
    RETURN;
  END IF;

    INSERT INTO ops_queue_jobs
      (id, queue, kind, payload, priority, status, attempts, max_attempts,
       run_at, enqueued_at, updated_at, last_error, idempotency_key, schedule_id)
    SELECT
      w.id,
      w.queue,
      w.kind,
      w.payload,
      w.priority,
      'pending',
      w.attempts,
      -- kernel.work records max_attempts as 1 because it never retries. Give the
      -- migrated work the durable default so it gains the retry the client just
      -- paid for; a per-job override can be set again by the caller.
      GREATEST(w.max_attempts, 5),
      w.run_at,
      w.enqueued_at,
      now(),
      w.last_error,
      NULL,
      NULL
    FROM kernel_work_jobs w
    WHERE w.status = 'pending'
    ON CONFLICT (id) DO NOTHING;

    -- Mark what moved, so re-running the migration is a no-op and so an operator
    -- can see afterwards which rows were carried across.
    UPDATE kernel_work_jobs
    SET status = 'cancelled',
        last_error = 'migrated to ops_queue_jobs by 20260701_upgrade_kernel_work_to_ops_queue'
    WHERE status = 'pending'
      AND id IN (SELECT id FROM ops_queue_jobs);
END
$upgrade$;
