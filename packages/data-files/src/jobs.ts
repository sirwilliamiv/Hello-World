/**
 * The durable jobs this capability owns, keyed by kind.
 *
 * `ops.queue`'s spec exposes `enqueue`, `schedule`, and `replay`, but no interface
 * for *registering a handler* — so the worker has nothing to dispatch a
 * `data.files:scan` job to. Exported as a map so the worker can wire it in one line
 * once that interface exists; see the report.
 */
import { runRetentionSweep } from './retention.js'
import { runScanJob, RETENTION_JOB_KIND, SCAN_JOB_KIND } from './scanning.js'

export type JobHandler = (payload: Record<string, unknown>) => Promise<unknown>

export const FILE_JOBS: Readonly<Record<string, JobHandler>> = {
  [SCAN_JOB_KIND]: async (payload) => runScanJob({ fileId: String(payload['fileId']) }),
  [RETENTION_JOB_KIND]: async (payload) =>
    runRetentionSweep(
      typeof payload['now'] === 'string' ? { now: payload['now'] } : {},
    ),
}
