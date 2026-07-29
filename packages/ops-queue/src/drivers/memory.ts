import type {
  CompleteJobInput,
  FailJobInput,
  InsertJobInput,
  LeaseInput,
  QueueStore,
  UpsertScheduleInput,
} from '../store.js'
import type {
  DeadLetterRow,
  FailOutcome,
  JobAttemptRow,
  JobPayload,
  QueuedJobRow,
  ScheduledJobRow,
} from '../types.js'

/**
 * The whole durable state, in the shape it has on disk. Exported so a test can
 * hold it across a simulated process restart, and so the Postgres driver has a
 * written-down target.
 */
export interface MemoryQueueSnapshot {
  readonly jobs: readonly QueuedJobRow[]
  readonly attempts: readonly JobAttemptRow[]
  readonly deadLetters: readonly DeadLetterRow[]
  readonly schedules: readonly ScheduledJobRow[]
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Rows go through JSON exactly as they would through jsonb. */
function clonePayload(payload: JobPayload): JobPayload {
  return clone(payload)
}

function newId(): string {
  return globalThis.crypto.randomUUID()
}

// A snapshot round-trips through JSON, so every timestamp comes back as a
// string. Rehydrating is the same work a driver does when reading a row.
function date(value: Date): Date {
  return new Date(value)
}

function nullableDate(value: Date | null): Date | null {
  return value === null ? null : new Date(value)
}

function reviveJob(row: QueuedJobRow): QueuedJobRow {
  return {
    ...row,
    runAt: date(row.runAt),
    enqueuedAt: date(row.enqueuedAt),
    updatedAt: date(row.updatedAt),
    lockedAt: nullableDate(row.lockedAt),
  }
}

function reviveAttempt(row: JobAttemptRow): JobAttemptRow {
  return { ...row, startedAt: date(row.startedAt), finishedAt: date(row.finishedAt) }
}

function reviveDeadLetter(row: DeadLetterRow): DeadLetterRow {
  return {
    ...row,
    deadLetteredAt: date(row.deadLetteredAt),
    replayedAt: nullableDate(row.replayedAt),
  }
}

function reviveSchedule(row: ScheduledJobRow): ScheduledJobRow {
  return { ...row, nextRunAt: date(row.nextRunAt), lastRunAt: nullableDate(row.lastRunAt) }
}

/**
 * An in-memory `QueueStore`.
 *
 * This is not a second implementation of the queue — the semantics live in the
 * worker, and this only has to store rows and honour the two atomicity rules in
 * `store.ts`, which single-threaded JavaScript gives for free. It exists so the
 * behavioural tests (restart, retry-then-dead-letter, replay) can run without a
 * database, and it is `serialise()`/`fromSnapshot()` that make the restart test
 * honest: the runtime is thrown away and rebuilt from bytes.
 *
 * It is not offered as a production driver. `driver: 'postgres'` is the default
 * for a reason.
 */
export class MemoryQueueStore implements QueueStore {
  readonly driver = 'memory' as const

  private jobs: QueuedJobRow[]
  private attempts: JobAttemptRow[]
  private deadLetters: DeadLetterRow[]
  private schedules: ScheduledJobRow[]

  constructor(snapshot?: MemoryQueueSnapshot) {
    this.jobs = snapshot === undefined ? [] : snapshot.jobs.map(reviveJob)
    this.attempts = snapshot === undefined ? [] : snapshot.attempts.map(reviveAttempt)
    this.deadLetters = snapshot === undefined ? [] : snapshot.deadLetters.map(reviveDeadLetter)
    this.schedules = snapshot === undefined ? [] : snapshot.schedules.map(reviveSchedule)
  }

  /** Everything that would be on disk, as JSON-safe data. */
  serialise(): MemoryQueueSnapshot {
    return clone({
      jobs: this.jobs,
      attempts: this.attempts,
      deadLetters: this.deadLetters,
      schedules: this.schedules,
    })
  }

  static fromSnapshot(snapshot: MemoryQueueSnapshot): MemoryQueueStore {
    return new MemoryQueueStore(clone(snapshot))
  }

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  async insertJob(input: InsertJobInput): Promise<QueuedJobRow> {
    const now = new Date()
    const row: QueuedJobRow = {
      id: input.id,
      queue: input.queue,
      kind: input.kind,
      payload: clonePayload(input.payload),
      priority: input.priority,
      status: 'pending',
      attempts: 0,
      maxAttempts: input.maxAttempts,
      runAt: input.runAt,
      enqueuedAt: now,
      updatedAt: now,
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      idempotencyKey: input.idempotencyKey,
      scheduleId: input.scheduleId,
    }
    this.jobs.push(row)
    return row
  }

  async findJob(id: string): Promise<QueuedJobRow | null> {
    return this.jobs.find((job) => job.id === id) ?? null
  }

  async findJobByIdempotencyKey(key: string): Promise<QueuedJobRow | null> {
    return this.jobs.find((job) => job.idempotencyKey === key) ?? null
  }

  async lease(input: LeaseInput): Promise<QueuedJobRow[]> {
    const excluded = new Set(input.excludeKinds)
    const runnable = this.jobs
      .filter(
        (job) =>
          job.status === 'pending' &&
          job.runAt.getTime() <= input.now.getTime() &&
          input.queues.includes(job.queue) &&
          !excluded.has(job.kind),
      )
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          a.runAt.getTime() - b.runAt.getTime() ||
          a.enqueuedAt.getTime() - b.enqueuedAt.getTime(),
      )
      .slice(0, input.limit)

    return runnable.map((job) =>
      this.patch(job.id, {
        status: 'running',
        attempts: job.attempts + 1,
        lockedAt: input.now,
        lockedBy: input.workerId,
      }),
    )
  }

  async reclaimExpiredLeases(leasedBefore: Date): Promise<number> {
    const stale = this.jobs.filter(
      (job) =>
        job.status === 'running' &&
        job.lockedAt !== null &&
        job.lockedAt.getTime() < leasedBefore.getTime(),
    )
    for (const job of stale) {
      this.patch(job.id, {
        status: 'pending',
        lockedAt: null,
        lockedBy: null,
        lastError: 'lease expired; the worker holding this job did not finish it',
      })
    }
    return stale.length
  }

  async releaseJobs(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const job = await this.findJob(id)
      if (job === null || job.status !== 'running') continue
      this.patch(id, {
        status: 'pending',
        attempts: Math.max(0, job.attempts - 1),
        lockedAt: null,
        lockedBy: null,
      })
    }
  }

  async completeJob(input: CompleteJobInput): Promise<void> {
    const job = await this.findJob(input.jobId)
    if (job === null || job.status !== 'running') return
    this.patch(job.id, { status: 'succeeded', lockedAt: null, lockedBy: null })
    this.appendAttempt(input, 'succeeded', null)
  }

  async failJob(input: FailJobInput): Promise<FailOutcome> {
    const job = await this.findJob(input.jobId)
    // The status guard is the whole concurrency story: whoever moves the row
    // out of 'running' first is the one that gets to act on it.
    if (job === null || job.status !== 'running') return { outcome: 'ignored' }

    if (input.nextRunAt !== null) {
      this.patch(job.id, {
        status: 'pending',
        runAt: input.nextRunAt,
        lockedAt: null,
        lockedBy: null,
        lastError: input.error,
      })
      this.appendAttempt(input, 'failed', input.error)
      return { outcome: 'retrying', nextRunAt: input.nextRunAt }
    }

    this.patch(job.id, {
      status: 'dead_lettered',
      lockedAt: null,
      lockedBy: null,
      lastError: input.error,
    })
    this.appendAttempt(input, 'failed', input.error)

    // Unique on job_id, mirroring the Postgres constraint: exactly one entry.
    const existing = this.deadLetters.find((entry) => entry.jobId === job.id)
    if (existing !== undefined) return { outcome: 'dead_lettered', entry: existing }

    const entry: DeadLetterRow = {
      id: newId(),
      jobId: job.id,
      queue: job.queue,
      kind: job.kind,
      payload: clonePayload(job.payload),
      attempts: job.attempts,
      error: input.error,
      deadLetteredAt: input.finishedAt,
      replayedAt: null,
      replayJobId: null,
    }
    this.deadLetters.push(entry)
    return { outcome: 'dead_lettered', entry }
  }

  async depth(queue?: string): Promise<number> {
    return this.jobs.filter(
      (job) =>
        (job.status === 'pending' || job.status === 'running') &&
        (queue === undefined || job.queue === queue),
    ).length
  }

  async listAttempts(jobId: string): Promise<JobAttemptRow[]> {
    return this.attempts
      .filter((attempt) => attempt.jobId === jobId)
      .sort((a, b) => a.attempt - b.attempt)
  }

  async findDeadLetterByJobId(jobId: string): Promise<DeadLetterRow | null> {
    return this.deadLetters.find((entry) => entry.jobId === jobId) ?? null
  }

  async listDeadLetters(limit: number): Promise<DeadLetterRow[]> {
    return [...this.deadLetters]
      .sort((a, b) => b.deadLetteredAt.getTime() - a.deadLetteredAt.getTime())
      .slice(0, limit)
  }

  async markDeadLetterReplayed(entryId: string, replayJobId: string, at: Date): Promise<void> {
    const index = this.deadLetters.findIndex((entry) => entry.id === entryId)
    const entry = this.deadLetters[index]
    if (entry === undefined) return
    this.deadLetters[index] = { ...entry, replayedAt: at, replayJobId }
  }

  async upsertSchedule(input: UpsertScheduleInput): Promise<ScheduledJobRow> {
    const row: ScheduledJobRow = {
      id: input.id,
      cron: input.cron,
      queue: input.queue,
      kind: input.kind,
      payload: clonePayload(input.payload),
      priority: input.priority,
      maxAttempts: input.maxAttempts,
      nextRunAt: input.nextRunAt,
      lastRunAt: null,
      active: true,
    }
    const index = this.schedules.findIndex((schedule) => schedule.id === input.id)
    if (index >= 0) this.schedules[index] = row
    else this.schedules.push(row)
    return row
  }

  async dueSchedules(now: Date): Promise<ScheduledJobRow[]> {
    return this.schedules.filter(
      (schedule) => schedule.active && schedule.nextRunAt.getTime() <= now.getTime(),
    )
  }

  async advanceSchedule(id: string, nextRunAt: Date, lastRunAt: Date): Promise<void> {
    const index = this.schedules.findIndex((schedule) => schedule.id === id)
    const schedule = this.schedules[index]
    if (schedule === undefined) return
    this.schedules[index] = { ...schedule, nextRunAt, lastRunAt }
  }

  private patch(id: string, changes: Partial<QueuedJobRow>): QueuedJobRow {
    const index = this.jobs.findIndex((job) => job.id === id)
    const job = this.jobs[index]
    if (job === undefined) throw new Error(`no queued job ${id}`)
    const next: QueuedJobRow = { ...job, ...changes, updatedAt: new Date() }
    this.jobs[index] = next
    return next
  }

  private appendAttempt(
    input: CompleteJobInput | FailJobInput,
    outcome: 'succeeded' | 'failed',
    error: string | null,
  ): void {
    // Append-only, per the specification: a flapping job's failure pattern
    // stays visible instead of being overwritten by its latest attempt.
    this.attempts.push({
      id: newId(),
      jobId: input.jobId,
      attempt: input.attempt,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      outcome,
      error,
    })
  }
}

export function createMemoryQueueStore(snapshot?: MemoryQueueSnapshot): MemoryQueueStore {
  return new MemoryQueueStore(snapshot)
}
