/**
 * `ops.queue` upgrades `kernel.work`, and ARCHITECTURE.md section 3 is precise
 * about what that means: the exposed interface survives, the implementation is
 * replaced. So the job vocabulary is not redefined here — it is imported from
 * `@forge/kernel-work` and re-exported, which makes "same signature" a fact the
 * compiler checks rather than a comment two files apart.
 *
 * The import is type-only apart from the two default constants, so nothing
 * about the in-process implementation is pulled into a durable product.
 */

export type {
  JobContext,
  JobHandler,
  JobPayload,
  JobRef,
  JobSpec,
  JobStatus,
} from '@forge/kernel-work'
export { DEFAULT_PRIORITY, DEFAULT_QUEUE } from '@forge/kernel-work'

import type { JobPayload, JobStatus } from '@forge/kernel-work'

/** Which backing store the queue runs on. `postgres` is the default. */
export type QueueDriver = 'postgres' | 'redis' | 'memory'

/** A row of the `QueuedJob` entity. */
export interface QueuedJobRow {
  readonly id: string
  readonly queue: string
  readonly kind: string
  readonly payload: JobPayload
  readonly priority: number
  readonly status: JobStatus
  readonly attempts: number
  readonly maxAttempts: number
  readonly runAt: Date
  readonly enqueuedAt: Date
  readonly updatedAt: Date
  readonly lockedAt: Date | null
  readonly lockedBy: string | null
  readonly lastError: string | null
  readonly idempotencyKey: string | null
  readonly scheduleId: string | null
}

/** A row of the append-only `JobAttempt` entity. */
export interface JobAttemptRow {
  readonly id: string
  readonly jobId: string
  readonly attempt: number
  readonly startedAt: Date
  readonly finishedAt: Date
  readonly outcome: 'succeeded' | 'failed'
  readonly error: string | null
}

/** A row of the `DeadLetterEntry` entity. */
export interface DeadLetterRow {
  readonly id: string
  readonly jobId: string
  readonly queue: string
  readonly kind: string
  /** The original payload, kept intact so `replay` is faithful. */
  readonly payload: JobPayload
  readonly attempts: number
  readonly error: string
  readonly deadLetteredAt: Date
  readonly replayedAt: Date | null
  readonly replayJobId: string | null
}

/** A row of the `ScheduledJob` entity. */
export interface ScheduledJobRow {
  readonly id: string
  readonly cron: string
  readonly queue: string
  readonly kind: string
  readonly payload: JobPayload
  readonly priority: number
  readonly maxAttempts: number
  readonly nextRunAt: Date
  readonly lastRunAt: Date | null
  readonly active: boolean
}

/** What `failJob` decided, and the reason `job.dead_lettered` fires once. */
export type FailOutcome =
  | { readonly outcome: 'retrying'; readonly nextRunAt: Date }
  | { readonly outcome: 'dead_lettered'; readonly entry: DeadLetterRow }
  /** Another worker already resolved this job; do nothing and publish nothing. */
  | { readonly outcome: 'ignored' }

export class QueueNotConfiguredError extends Error {
  constructor() {
    super(
      'ops.queue has not been configured. The generated ' +
        'src/generated/ops.queue/config.ts calls configureQueue() at boot; import it ' +
        'before enqueueing, or call configureQueue() yourself in a test.',
    )
    this.name = 'QueueNotConfiguredError'
  }
}

export class QueueDriverUnavailableError extends Error {
  constructor(driver: QueueDriver, detail: string) {
    super(`queue driver ${JSON.stringify(driver)} is unavailable: ${detail}`)
    this.name = 'QueueDriverUnavailableError'
  }
}
