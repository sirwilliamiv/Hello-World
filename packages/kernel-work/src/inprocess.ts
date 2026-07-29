import type { WorkBackend } from './backend.js'
import { nextCronOccurrence } from './cron.js'
import { emitJobEvent } from './events.js'
import {
  DEFAULT_PRIORITY,
  DEFAULT_QUEUE,
  toJobRef,
  type JobHandler,
  type JobRecord,
  type JobRef,
  type JobSpec,
} from './types.js'

interface Schedule {
  readonly id: string
  readonly cron: string
  readonly spec: JobSpec
  timer?: ReturnType<typeof setTimeout> | undefined
}

function newId(): string {
  return globalThis.crypto.randomUUID()
}

/**
 * `setTimeout` is typed as returning a number under lib.dom and a Timeout under
 * @types/node. Keeping the pending work from holding the process open is a Node
 * concern only, so ask for it structurally.
 */
function unref(timer: unknown): void {
  ;(timer as { unref?: () => void }).unref?.()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The in-process implementation of `kernel.work`.
 *
 * Everything lives in this process: the `Job` records are a Map, execution is a
 * timer, and a failure is recorded and dropped. There is no retry, no
 * dead-letter, and no cross-process concurrency control, and none of that is an
 * oversight — it is the boundary that makes `ops.queue` a real upgrade rather
 * than a configuration flag. A job enqueued here does not survive a restart.
 */
class InProcessBackend implements WorkBackend {
  readonly name = 'kernel.work'

  /** The `Job` entity this capability owns. */
  private readonly jobs = new Map<string, JobRecord>()
  private readonly handlers = new Map<string, JobHandler>()
  private readonly schedules = new Map<string, Schedule>()
  private readonly byIdempotencyKey = new Map<string, string>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly inflight = new Set<Promise<void>>()
  private readonly aborts = new Map<string, AbortController>()

  registerHandler(kind: string, handler: JobHandler): void {
    this.handlers.set(kind, handler)
  }

  async enqueue(job: JobSpec): Promise<JobRef> {
    if (job.idempotencyKey !== undefined) {
      const existingId = this.byIdempotencyKey.get(job.idempotencyKey)
      const existing = existingId === undefined ? undefined : this.jobs.get(existingId)
      if (existing !== undefined) return toJobRef(existing)
    }

    const now = new Date()
    const record: JobRecord = {
      id: newId(),
      kind: job.kind,
      queue: job.queue ?? DEFAULT_QUEUE,
      payload: job.payload ?? {},
      priority: job.priority ?? DEFAULT_PRIORITY,
      status: 'pending',
      attempts: 0,
      // Recorded so the shape matches ops.queue's, but never acted on: this
      // backend makes exactly one attempt.
      maxAttempts: job.maxAttempts ?? 1,
      runAt: job.runAt ?? now,
      enqueuedAt: now,
    }
    this.jobs.set(record.id, record)
    if (job.idempotencyKey !== undefined) this.byIdempotencyKey.set(job.idempotencyKey, record.id)

    await emitJobEvent('job.enqueued', {
      job_id: record.id,
      kind: record.kind,
      priority: record.priority,
    })
    this.arm(record)
    return toJobRef(record)
  }

  async schedule(cron: string, job: JobSpec): Promise<JobRef> {
    const next = nextCronOccurrence(cron)
    const schedule: Schedule = { id: newId(), cron, spec: job }
    this.schedules.set(schedule.id, schedule)
    this.armSchedule(schedule, next)

    const now = new Date()
    return {
      id: schedule.id,
      kind: job.kind,
      queue: job.queue ?? DEFAULT_QUEUE,
      status: 'scheduled',
      attempts: 0,
      maxAttempts: job.maxAttempts ?? 1,
      runAt: next,
      enqueuedAt: now,
    }
  }

  /** Run everything that is due and wait for the in-flight set to empty. */
  async drain(): Promise<void> {
    for (;;) {
      const now = Date.now()
      const due = [...this.jobs.values()]
        .filter((job) => job.status === 'pending' && job.runAt.getTime() <= now)
        .sort((a, b) => b.priority - a.priority || a.enqueuedAt.getTime() - b.enqueuedAt.getTime())
      for (const job of due) {
        const timer = this.timers.get(job.id)
        if (timer !== undefined) clearTimeout(timer)
        this.timers.delete(job.id)
        this.start(job)
      }
      if (this.inflight.size === 0) return
      await Promise.all([...this.inflight])
    }
  }

  /** Cancel every timer and abort in-flight work. Nothing is persisted. */
  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const schedule of this.schedules.values()) {
      if (schedule.timer !== undefined) clearTimeout(schedule.timer)
    }
    for (const controller of this.aborts.values()) controller.abort()
    this.aborts.clear()
  }

  jobRecords(): JobRecord[] {
    return [...this.jobs.values()]
  }

  private arm(record: JobRecord): void {
    const delay = Math.max(0, record.runAt.getTime() - Date.now())
    const timer = setTimeout(() => {
      this.timers.delete(record.id)
      this.start(record)
    }, delay)
    unref(timer)
    this.timers.set(record.id, timer)
  }

  private armSchedule(schedule: Schedule, next: Date): void {
    const timer = setTimeout(
      () => {
        void this.enqueue({ ...schedule.spec, runAt: new Date() })
        if (this.schedules.has(schedule.id)) {
          this.armSchedule(schedule, nextCronOccurrence(schedule.cron))
        }
      },
      Math.max(0, next.getTime() - Date.now()),
    )
    unref(timer)
    schedule.timer = timer
  }

  private start(record: JobRecord): void {
    if (record.status !== 'pending') return
    record.status = 'running'
    record.attempts += 1
    const run = this.run(record)
    this.inflight.add(run)
    void run.finally(() => this.inflight.delete(run))
  }

  private async run(record: JobRecord): Promise<void> {
    const started = Date.now()
    const controller = new AbortController()
    this.aborts.set(record.id, controller)
    await emitJobEvent('job.started', {
      job_id: record.id,
      kind: record.kind,
      attempt: record.attempts,
    })
    try {
      const handler = this.handlers.get(record.kind)
      if (handler === undefined) {
        throw new Error(
          `no handler registered for job kind ${JSON.stringify(record.kind)}; ` +
            'call registerJobHandler() before enqueueing',
        )
      }
      await handler({
        id: record.id,
        kind: record.kind,
        queue: record.queue,
        payload: record.payload,
        attempt: record.attempts,
        maxAttempts: record.maxAttempts,
        signal: controller.signal,
      })
      record.status = 'succeeded'
      record.finishedAt = new Date()
      await emitJobEvent('job.succeeded', {
        job_id: record.id,
        kind: record.kind,
        duration_ms: Date.now() - started,
      })
    } catch (error) {
      // No retry and no dead-letter: this is the whole point of the boundary.
      record.status = 'failed'
      record.finishedAt = new Date()
      record.lastError = errorMessage(error)
      await emitJobEvent('job.failed', {
        job_id: record.id,
        kind: record.kind,
        attempt: record.attempts,
        error: record.lastError,
        will_retry: false,
      })
    } finally {
      this.aborts.delete(record.id)
    }
  }
}

export type { InProcessBackend }

export function createInProcessBackend(): InProcessBackend {
  return new InProcessBackend()
}
