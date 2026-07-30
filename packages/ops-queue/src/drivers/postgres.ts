import postgres from 'postgres'
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
import { QueueDriverUnavailableError } from '../types.js'

/**
 * The default driver.
 *
 * Postgres rather than Redis is a deliberate Phase 1 choice: a local workspace
 * must boot with one service, and `QUEUE_URL` may simply be the application
 * database URL. The leasing query is `SELECT ... FOR UPDATE SKIP LOCKED`, which
 * is what lets N workers pull from one table without a lock convoy and without
 * ever handing the same row to two of them.
 *
 * Queries are written as SQL rather than through Drizzle's query builder for
 * the same reason ARCHITECTURE.md section 14.1 keeps migrations in SQL: `FOR
 * UPDATE SKIP LOCKED` and data-modifying CTEs are the load-bearing parts, and
 * they should be readable by anyone who reads SQL. Drizzle owns the schema
 * declaration (`schema.ts`), which is what composes across packages.
 */

/**
 * The slice of postgres.js this driver uses. Declaring it structurally keeps
 * the driver testable with a fake and insulated from the client's type details.
 */
export interface PostgresClient {
  <T extends readonly unknown[]>(
    template: TemplateStringsArray,
    ...params: readonly unknown[]
  ): Promise<T>
  end(options?: { timeout?: number }): Promise<void>
}

export interface PostgresQueueStoreOptions {
  readonly url?: string | undefined
  /** Supply a client to share the application's pool, or to test with a fake. */
  readonly client?: PostgresClient | undefined
  readonly poolSize?: number | undefined
}

interface JobRowDb {
  readonly id: string
  readonly queue: string
  readonly kind: string
  readonly payload: JobPayload
  readonly priority: number
  readonly status: string
  readonly attempts: number
  readonly max_attempts: number
  readonly run_at: Date
  readonly enqueued_at: Date
  readonly updated_at: Date
  readonly locked_at: Date | null
  readonly locked_by: string | null
  readonly last_error: string | null
  readonly idempotency_key: string | null
  readonly schedule_id: string | null
}

interface AttemptRowDb {
  readonly id: string
  readonly job_id: string
  readonly attempt: number
  readonly started_at: Date
  readonly finished_at: Date
  readonly outcome: string
  readonly error: string | null
}

interface DeadLetterRowDb {
  readonly id: string | null
  readonly job_id: string
  readonly queue: string
  readonly kind: string
  readonly payload: JobPayload
  readonly attempts: number
  readonly error: string
  readonly dead_lettered_at: Date
  readonly replayed_at: Date | null
  readonly replay_job_id: string | null
}

interface ScheduleRowDb {
  readonly id: string
  readonly cron: string
  readonly queue: string
  readonly kind: string
  readonly payload: JobPayload
  readonly priority: number
  readonly max_attempts: number
  readonly next_run_at: Date
  readonly last_run_at: Date | null
  readonly active: boolean
}

function toJobRow(row: JobRowDb): QueuedJobRow {
  return {
    id: row.id,
    queue: row.queue,
    kind: row.kind,
    payload: row.payload,
    priority: row.priority,
    status: row.status as QueuedJobRow['status'],
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAt: row.run_at,
    enqueuedAt: row.enqueued_at,
    updatedAt: row.updated_at,
    lockedAt: row.locked_at,
    lockedBy: row.locked_by,
    lastError: row.last_error,
    idempotencyKey: row.idempotency_key,
    scheduleId: row.schedule_id,
  }
}

function toDeadLetterRow(row: DeadLetterRowDb & { id: string }): DeadLetterRow {
  return {
    id: row.id,
    jobId: row.job_id,
    queue: row.queue,
    kind: row.kind,
    payload: row.payload,
    attempts: row.attempts,
    error: row.error,
    deadLetteredAt: row.dead_lettered_at,
    replayedAt: row.replayed_at,
    replayJobId: row.replay_job_id,
  }
}

function toScheduleRow(row: ScheduleRowDb): ScheduledJobRow {
  return {
    id: row.id,
    cron: row.cron,
    queue: row.queue,
    kind: row.kind,
    payload: row.payload,
    priority: row.priority,
    maxAttempts: row.max_attempts,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    active: row.active,
  }
}

export class PostgresQueueStore implements QueueStore {
  readonly driver = 'postgres' as const

  private readonly sql: PostgresClient
  private readonly ownsClient: boolean

  constructor(options: PostgresQueueStoreOptions) {
    if (options.client !== undefined) {
      this.sql = options.client
      this.ownsClient = false
      return
    }
    if (options.url === undefined || options.url === '') {
      throw new QueueDriverUnavailableError(
        'postgres',
        'no connection string. Set QUEUE_URL — for this driver it may be the ' +
          'application DATABASE_URL — or pass a client to configureQueue().',
      )
    }
    this.sql = postgres(options.url, {
      max: options.poolSize ?? 10,
    }) as unknown as PostgresClient
    this.ownsClient = true
  }

  async init(): Promise<void> {
    // Fail at boot with a message that names the fix, rather than on the first
    // enqueue with a bare relation-does-not-exist.
    const [row] = await this.sql<{ present: boolean }[]>`
      SELECT to_regclass('ops_queue_jobs') IS NOT NULL AS present
    `
    if (row === undefined || !row.present) {
      throw new QueueDriverUnavailableError(
        'postgres',
        'the ops_queue_jobs table is missing. Run the 20260701_create_ops_queue migration.',
      )
    }
  }

  async close(): Promise<void> {
    if (this.ownsClient) await this.sql.end({ timeout: 5 })
  }

  async insertJob(input: InsertJobInput): Promise<QueuedJobRow> {
    // ON CONFLICT ... DO UPDATE (rather than DO NOTHING) so the existing row is
    // returned: a repeated enqueue of the same idempotency key is a lookup.
    const rows = await this.sql<JobRowDb[]>`
      INSERT INTO ops_queue_jobs
        (id, queue, kind, payload, priority, status, attempts, max_attempts,
         run_at, enqueued_at, updated_at, idempotency_key, schedule_id)
      VALUES
        (${input.id}, ${input.queue}, ${input.kind}, ${JSON.stringify(input.payload)}::jsonb,
         ${input.priority}, 'pending', 0, ${input.maxAttempts},
         ${input.runAt}, now(), now(), ${input.idempotencyKey}, ${input.scheduleId})
      ON CONFLICT (idempotency_key)
        DO UPDATE SET updated_at = ops_queue_jobs.updated_at
      RETURNING *
    `
    const row = rows[0]
    if (row === undefined) throw new Error('insert returned no row')
    return toJobRow(row)
  }

  async findJob(id: string): Promise<QueuedJobRow | null> {
    const rows = await this.sql<JobRowDb[]>`SELECT * FROM ops_queue_jobs WHERE id = ${id}`
    const row = rows[0]
    return row === undefined ? null : toJobRow(row)
  }

  async findJobByIdempotencyKey(key: string): Promise<QueuedJobRow | null> {
    const rows = await this.sql<JobRowDb[]>`
      SELECT * FROM ops_queue_jobs WHERE idempotency_key = ${key}
    `
    const row = rows[0]
    return row === undefined ? null : toJobRow(row)
  }

  async lease(input: LeaseInput): Promise<QueuedJobRow[]> {
    // SKIP LOCKED is the whole trick: a worker steps over rows another worker
    // has claimed instead of queueing behind them.
    const rows = await this.sql<JobRowDb[]>`
      UPDATE ops_queue_jobs AS j
      SET status = 'running',
          attempts = j.attempts + 1,
          locked_at = ${input.now},
          locked_by = ${input.workerId},
          updated_at = now()
      WHERE j.id IN (
        SELECT c.id
        FROM ops_queue_jobs c
        WHERE c.status = 'pending'
          AND c.run_at <= ${input.now}
          AND c.queue = ANY(${input.queues as string[]}::text[])
          AND c.kind <> ALL(${input.excludeKinds as string[]}::text[])
        ORDER BY c.priority DESC, c.run_at ASC, c.enqueued_at ASC
        LIMIT ${input.limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING j.*
    `
    return rows.map(toJobRow)
  }

  async reclaimExpiredLeases(leasedBefore: Date): Promise<number> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE ops_queue_jobs
      SET status = 'pending',
          locked_at = NULL,
          locked_by = NULL,
          last_error = 'lease expired; the worker holding this job did not finish it',
          updated_at = now()
      WHERE status = 'running'
        AND locked_at IS NOT NULL
        AND locked_at < ${leasedBefore}
      RETURNING id
    `
    return rows.length
  }

  async releaseJobs(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return
    await this.sql`
      UPDATE ops_queue_jobs
      SET status = 'pending',
          attempts = GREATEST(attempts - 1, 0),
          locked_at = NULL,
          locked_by = NULL,
          updated_at = now()
      WHERE id = ANY(${ids as string[]}::uuid[]) AND status = 'running'
    `
  }

  async completeJob(input: CompleteJobInput): Promise<void> {
    await this.sql`
      WITH done AS (
        UPDATE ops_queue_jobs
        SET status = 'succeeded', locked_at = NULL, locked_by = NULL, updated_at = now()
        WHERE id = ${input.jobId} AND status = 'running'
        RETURNING id
      )
      INSERT INTO ops_queue_job_attempts
        (id, job_id, attempt, started_at, finished_at, outcome, error)
      SELECT gen_random_uuid(), done.id, ${input.attempt}, ${input.startedAt},
             ${input.finishedAt}, 'succeeded', NULL
      FROM done
    `
  }

  async failJob(input: FailJobInput): Promise<FailOutcome> {
    if (input.nextRunAt !== null) {
      const nextRunAt = input.nextRunAt
      const rows = await this.sql<{ moved: number }[]>`
        WITH moved AS (
          UPDATE ops_queue_jobs
          SET status = 'pending',
              run_at = ${nextRunAt},
              locked_at = NULL,
              locked_by = NULL,
              last_error = ${input.error},
              updated_at = now()
          WHERE id = ${input.jobId} AND status = 'running'
          RETURNING id
        ), attempt AS (
          INSERT INTO ops_queue_job_attempts
            (id, job_id, attempt, started_at, finished_at, outcome, error)
          SELECT gen_random_uuid(), moved.id, ${input.attempt}, ${input.startedAt},
                 ${input.finishedAt}, 'failed', ${input.error}
          FROM moved
          RETURNING job_id
        )
        SELECT count(*)::int AS moved FROM attempt
      `
      const moved = rows[0]?.moved ?? 0
      return moved === 0 ? { outcome: 'ignored' } : { outcome: 'retrying', nextRunAt }
    }

    // Dead-lettering. Three things happen in one statement, guarded on
    // `status = 'running'`, so a race between two workers produces exactly one
    // transition and exactly one DeadLetterEntry (also unique on job_id).
    const rows = await this.sql<(DeadLetterRowDb & { moved_count: number })[]>`
      WITH moved AS (
        UPDATE ops_queue_jobs
        SET status = 'dead_lettered',
            locked_at = NULL,
            locked_by = NULL,
            last_error = ${input.error},
            updated_at = now()
        WHERE id = ${input.jobId} AND status = 'running'
        RETURNING *
      ), attempt AS (
        INSERT INTO ops_queue_job_attempts
          (id, job_id, attempt, started_at, finished_at, outcome, error)
        SELECT gen_random_uuid(), moved.id, ${input.attempt}, ${input.startedAt},
               ${input.finishedAt}, 'failed', ${input.error}
        FROM moved
      ), dead AS (
        INSERT INTO ops_queue_dead_letters
          (id, job_id, queue, kind, payload, attempts, error, dead_lettered_at)
        SELECT gen_random_uuid(), moved.id, moved.queue, moved.kind, moved.payload,
               moved.attempts, ${input.error}, ${input.finishedAt}
        FROM moved
        ON CONFLICT (job_id) DO NOTHING
        RETURNING *
      )
      SELECT counted.moved_count, dead.*
      FROM (SELECT count(*)::int AS moved_count FROM moved) AS counted
      LEFT JOIN dead ON true
    `
    const row = rows[0]
    if (row === undefined || row.moved_count === 0) return { outcome: 'ignored' }
    if (row.id !== null) return { outcome: 'dead_lettered', entry: toDeadLetterRow({ ...row, id: row.id }) }

    // The row moved but the entry already existed: another path dead-lettered
    // it. Report the existing entry and publish nothing new.
    const existing = await this.findDeadLetterByJobId(input.jobId)
    return existing === null
      ? { outcome: 'ignored' }
      : { outcome: 'dead_lettered', entry: existing }
  }

  async depth(queue?: string): Promise<number> {
    const rows = await this.sql<{ depth: number }[]>`
      SELECT count(*)::int AS depth
      FROM ops_queue_jobs
      WHERE status IN ('pending', 'running')
        AND (${queue ?? null}::text IS NULL OR queue = ${queue ?? null})
    `
    return rows[0]?.depth ?? 0
  }

  async listAttempts(jobId: string): Promise<JobAttemptRow[]> {
    const rows = await this.sql<AttemptRowDb[]>`
      SELECT * FROM ops_queue_job_attempts WHERE job_id = ${jobId} ORDER BY attempt ASC
    `
    return rows.map((row) => ({
      id: row.id,
      jobId: row.job_id,
      attempt: row.attempt,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      outcome: row.outcome as JobAttemptRow['outcome'],
      error: row.error,
    }))
  }

  async findDeadLetterByJobId(jobId: string): Promise<DeadLetterRow | null> {
    const rows = await this.sql<(DeadLetterRowDb & { id: string })[]>`
      SELECT * FROM ops_queue_dead_letters WHERE job_id = ${jobId}
    `
    const row = rows[0]
    return row === undefined ? null : toDeadLetterRow(row)
  }

  async listDeadLetters(limit: number): Promise<DeadLetterRow[]> {
    const rows = await this.sql<(DeadLetterRowDb & { id: string })[]>`
      SELECT * FROM ops_queue_dead_letters ORDER BY dead_lettered_at DESC LIMIT ${limit}
    `
    return rows.map(toDeadLetterRow)
  }

  async markDeadLetterReplayed(entryId: string, replayJobId: string, at: Date): Promise<void> {
    await this.sql`
      UPDATE ops_queue_dead_letters
      SET replayed_at = ${at}, replay_job_id = ${replayJobId}
      WHERE id = ${entryId}
    `
  }

  async upsertSchedule(input: UpsertScheduleInput): Promise<ScheduledJobRow> {
    const rows = await this.sql<ScheduleRowDb[]>`
      INSERT INTO ops_queue_scheduled_jobs
        (id, cron, queue, kind, payload, priority, max_attempts, next_run_at, active)
      VALUES
        (${input.id}, ${input.cron}, ${input.queue}, ${input.kind},
         ${JSON.stringify(input.payload)}::jsonb, ${input.priority}, ${input.maxAttempts},
         ${input.nextRunAt}, true)
      ON CONFLICT (id) DO UPDATE SET
        cron = EXCLUDED.cron,
        queue = EXCLUDED.queue,
        kind = EXCLUDED.kind,
        payload = EXCLUDED.payload,
        priority = EXCLUDED.priority,
        max_attempts = EXCLUDED.max_attempts,
        next_run_at = EXCLUDED.next_run_at,
        active = true
      RETURNING *
    `
    const row = rows[0]
    if (row === undefined) throw new Error('schedule upsert returned no row')
    return toScheduleRow(row)
  }

  async dueSchedules(now: Date): Promise<ScheduledJobRow[]> {
    const rows = await this.sql<ScheduleRowDb[]>`
      SELECT * FROM ops_queue_scheduled_jobs
      WHERE active AND next_run_at <= ${now}
      ORDER BY next_run_at ASC
    `
    return rows.map(toScheduleRow)
  }

  async advanceSchedule(id: string, nextRunAt: Date, lastRunAt: Date): Promise<void> {
    await this.sql`
      UPDATE ops_queue_scheduled_jobs
      SET next_run_at = ${nextRunAt}, last_run_at = ${lastRunAt}
      WHERE id = ${id}
    `
  }
}

export function createPostgresQueueStore(
  options: PostgresQueueStoreOptions,
): PostgresQueueStore {
  return new PostgresQueueStore(options)
}
