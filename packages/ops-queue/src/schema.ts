import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * The four entities `ops.queue` owns, as Drizzle schema.
 *
 * ARCHITECTURE.md section 14.1: the schema is TypeScript that composes across
 * packages, so each capability owns its own tables in its own npm package;
 * migrations stay hand-written SQL so they are readable in a plan and can
 * express a backfill. This file is the former. `migrations/*.sql` is the
 * latter, and the two are kept in step by review, not by drizzle-kit diffing.
 *
 * No other capability may write these tables — that is what `owns` means, and
 * the repository-layer allowlist in ARCHITECTURE.md section 9.3 enforces it.
 */

export const queuedJobs = pgTable(
  'ops_queue_jobs',
  {
    id: uuid('id').primaryKey(),
    queue: text('queue').notNull().default('default'),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    /** Higher runs first. */
    priority: integer('priority').notNull().default(100),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull(),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    enqueuedAt: timestamp('enqueued_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Held by the worker that leased the row; NULL when nobody holds it. */
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    lastError: text('last_error'),
    idempotencyKey: text('idempotency_key'),
    scheduleId: uuid('schedule_id'),
  },
  (table) => [
    // The lease query's covering index: partial, so it stays small however
    // large the completed-job history grows.
    index('ops_queue_jobs_runnable_idx').on(table.queue, table.priority, table.runAt),
    index('ops_queue_jobs_lease_idx').on(table.lockedAt),
    uniqueIndex('ops_queue_jobs_idempotency_key_idx').on(table.idempotencyKey),
  ],
)

/** Append-only: a flapping job's failure pattern must stay visible. */
export const jobAttempts = pgTable(
  'ops_queue_job_attempts',
  {
    id: uuid('id').primaryKey(),
    jobId: uuid('job_id').notNull(),
    attempt: integer('attempt').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull(),
    outcome: text('outcome').notNull(),
    error: text('error'),
  },
  (table) => [index('ops_queue_job_attempts_job_idx').on(table.jobId, table.attempt)],
)

export const deadLetterEntries = pgTable(
  'ops_queue_dead_letters',
  {
    id: uuid('id').primaryKey(),
    /** Unique: a job dead-letters exactly once. */
    jobId: uuid('job_id').notNull(),
    queue: text('queue').notNull(),
    kind: text('kind').notNull(),
    /** The original payload, kept intact so `replay` is faithful. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    attempts: integer('attempts').notNull(),
    error: text('error').notNull(),
    deadLetteredAt: timestamp('dead_lettered_at', { withTimezone: true }).notNull().defaultNow(),
    replayedAt: timestamp('replayed_at', { withTimezone: true }),
    replayJobId: uuid('replay_job_id'),
  },
  (table) => [uniqueIndex('ops_queue_dead_letters_job_idx').on(table.jobId)],
)

export const scheduledJobs = pgTable(
  'ops_queue_scheduled_jobs',
  {
    id: uuid('id').primaryKey(),
    cron: text('cron').notNull(),
    queue: text('queue').notNull().default('default'),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    priority: integer('priority').notNull().default(100),
    maxAttempts: integer('max_attempts').notNull(),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull(),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    active: boolean('active').notNull().default(true),
  },
  (table) => [index('ops_queue_scheduled_jobs_due_idx').on(table.nextRunAt)],
)

export const opsQueueSchema = {
  queuedJobs,
  jobAttempts,
  deadLetterEntries,
  scheduledJobs,
}
