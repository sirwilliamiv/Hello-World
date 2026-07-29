/**
 * The job vocabulary for the whole system.
 *
 * These types are defined here, in `kernel.work`, and re-used verbatim by
 * `ops.queue` (which upgrades this capability). Defining them once is what
 * makes the upgrade substitution in ARCHITECTURE.md section 3 a compile-time
 * fact rather than a convention: `ops.queue`'s `enqueue`/`schedule` are the
 * *same* signature, so no consumer changes.
 */

/** Job payloads are round-tripped through JSON by any durable driver. */
export type JobPayload = Record<string, unknown>

export type JobStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'dead_lettered'
  | 'cancelled'
  /** A recurring registration produced by `schedule()`, not a single run. */
  | 'scheduled'

/** The queue a job lands on when the caller does not name one. */
export const DEFAULT_QUEUE = 'default'

/** The priority a job gets when neither the caller nor a slot sets one. */
export const DEFAULT_PRIORITY = 100

/**
 * What a caller hands to `enqueue`. Every field except `kind` is optional so
 * that the minimal call — `enqueue({ kind: 'mail.deliver' })` — stays minimal.
 */
export interface JobSpec {
  /** Handler key. Must have been registered with `registerJobHandler`. */
  readonly kind: string
  readonly payload?: JobPayload | undefined
  readonly queue?: string | undefined
  /** Higher runs first. Defaults to {@link DEFAULT_PRIORITY}. */
  readonly priority?: number | undefined
  /** Earliest execution time. Defaults to now. */
  readonly runAt?: Date | undefined
  /**
   * Per-job override of the configured attempt ceiling. `kernel.work` records
   * it but never retries; `ops.queue` honours it.
   */
  readonly maxAttempts?: number | undefined
  /**
   * De-duplication key. A second enqueue with the same key returns the
   * existing job rather than creating a new one.
   */
  readonly idempotencyKey?: string | undefined
}

/** The handle returned by `enqueue`, `schedule`, and `replay`. */
export interface JobRef {
  readonly id: string
  readonly kind: string
  readonly queue: string
  readonly status: JobStatus
  readonly attempts: number
  readonly maxAttempts: number
  readonly runAt: Date
  readonly enqueuedAt: Date
}

/** What a handler is given when its job runs. */
export interface JobContext {
  readonly id: string
  readonly kind: string
  readonly queue: string
  readonly payload: JobPayload
  /** 1 on the first run. */
  readonly attempt: number
  readonly maxAttempts: number
  /** Aborted when the worker is shutting down. */
  readonly signal: AbortSignal
}

export type JobHandler = (ctx: JobContext) => Promise<void> | void

/**
 * The `Job` entity this capability owns. In-process only: there is no durable
 * retry, no dead-letter, and no cross-process concurrency control. That is
 * exactly what `ops.queue` adds.
 */
export interface JobRecord {
  readonly id: string
  readonly kind: string
  readonly queue: string
  readonly payload: JobPayload
  readonly priority: number
  status: JobStatus
  attempts: number
  readonly maxAttempts: number
  runAt: Date
  readonly enqueuedAt: Date
  finishedAt?: Date | undefined
  lastError?: string | undefined
}

export function toJobRef(record: JobRecord): JobRef {
  return {
    id: record.id,
    kind: record.kind,
    queue: record.queue,
    status: record.status,
    attempts: record.attempts,
    maxAttempts: record.maxAttempts,
    runAt: record.runAt,
    enqueuedAt: record.enqueuedAt,
  }
}
