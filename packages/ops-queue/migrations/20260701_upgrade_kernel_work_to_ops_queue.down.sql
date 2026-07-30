-- Rollback: hand the still-pending migrated work back to kernel.work.
--
-- A capability major without a rollback script fails publication
-- (ARCHITECTURE.md section 9.2), and a rollback that silently drops jobs is
-- worse than none. Only jobs that have not started under the durable queue move
-- back; anything already running, succeeded or dead-lettered stays here, where
-- its attempt history is.

UPDATE kernel_work_jobs w
SET status = 'pending',
    run_at = q.run_at,
    last_error = NULL
FROM ops_queue_jobs q
WHERE q.id = w.id
  AND q.status = 'pending'
  AND w.status = 'cancelled';

DELETE FROM ops_queue_jobs q
WHERE q.status = 'pending'
  AND EXISTS (SELECT 1 FROM kernel_work_jobs w WHERE w.id = q.id AND w.status = 'pending');
