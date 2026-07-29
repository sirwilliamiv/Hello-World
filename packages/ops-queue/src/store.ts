/**
 * The durability port.
 *
 * Everything that makes `ops.queue` an upgrade rather than a rewrite lives
 * behind this interface: leasing, the attempt ledger, the dead-letter table and
 * the schedule table. The worker holds no job state of its own, which is what
 * makes "a job enqueued before a restart still runs after it" true by
 * construction rather than by care.
 *
 * Two guarantees the implementations owe:
 *
 * 1. `lease` hands a row to exactly one worker. The Postgres driver does this
 *    with `SELECT ... FOR UPDATE SKIP LOCKED`.
 * 2. `failJob` is a single atomic transition guarded on `status = 'running'`.
 *    A job therefore dead-letters exactly once even if two workers race, and
 *    the `DeadLetterEntry` insert is additionally unique on `job_id`.
 */

import type {
  DeadLetterRow,
  FailOutcome,
  JobAttemptRow,
  JobPayload,
  QueueDriver,
  QueuedJobRow,
  ScheduledJobRow,
} from './types.js'

export interface InsertJobInput {
  readonly id: string
  readonly queue: string
  readonly kind: string
  readonly payload: JobPayload
  readonly priority: number
  readonly maxAttempts: number
  readonly runAt: Date
  readonly idempotencyKey: string | null
  readonly scheduleId: string | null
}

export interface LeaseInput {
  readonly queues: readonly string[]
  readonly limit: number
  readonly workerId: string
  readonly now: Date
  /** Kinds already at their concurrency ceiling on this worker. */
  readonly excludeKinds: readonly string[]
}

export interface CompleteJobInput {
  readonly jobId: string
  readonly attempt: number
  readonly startedAt: Date
  readonly finishedAt: Date
}

export interface FailJobInput {
  readonly jobId: string
  readonly attempt: number
  readonly startedAt: Date
  readonly finishedAt: Date
  readonly error: string
  /** `null` means give up: dead-letter it. */
  readonly nextRunAt: Date | null
}

export interface UpsertScheduleInput {
  readonly id: string
  readonly cron: string
  readonly queue: string
  readonly kind: string
  readonly payload: JobPayload
  readonly priority: number
  readonly maxAttempts: number
  readonly nextRunAt: Date
}

export interface QueueStore {
  readonly driver: QueueDriver

  /** Open connections and verify the schema is present. */
  init(): Promise<void>
  close(): Promise<void>

  insertJob(input: InsertJobInput): Promise<QueuedJobRow>
  findJob(id: string): Promise<QueuedJobRow | null>
  findJobByIdempotencyKey(key: string): Promise<QueuedJobRow | null>

  /** Atomically claim up to `limit` runnable jobs for this worker. */
  lease(input: LeaseInput): Promise<QueuedJobRow[]>

  /**
   * Return jobs whose worker died mid-run to the pending pool. This is what
   * makes an interrupted job survive a restart rather than staying `running`
   * forever.
   */
  reclaimExpiredLeases(leasedBefore: Date): Promise<number>

  /**
   * Hand leased-but-not-started jobs straight back, undoing the attempt the
   * lease counted. Used when a per-kind concurrency limit means a worker
   * claimed more than it may run — releasing is honest, whereas holding the
   * rows in memory would put them back where `kernel.work` had them.
   */
  releaseJobs(ids: readonly string[]): Promise<void>

  completeJob(input: CompleteJobInput): Promise<void>

  /** Retry, dead-letter, or ignore — decided atomically. */
  failJob(input: FailJobInput): Promise<FailOutcome>

  /** Pending + running jobs, for the depth alert and the monitor. */
  depth(queue?: string): Promise<number>

  listAttempts(jobId: string): Promise<JobAttemptRow[]>
  findDeadLetterByJobId(jobId: string): Promise<DeadLetterRow | null>
  listDeadLetters(limit: number): Promise<DeadLetterRow[]>
  markDeadLetterReplayed(entryId: string, replayJobId: string, at: Date): Promise<void>

  upsertSchedule(input: UpsertScheduleInput): Promise<ScheduledJobRow>
  dueSchedules(now: Date): Promise<ScheduledJobRow[]>
  advanceSchedule(id: string, nextRunAt: Date, lastRunAt: Date): Promise<void>
}
