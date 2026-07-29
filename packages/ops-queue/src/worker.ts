import { nextCronOccurrence } from '@forge/kernel-work'
import { emitQueueEvent } from './events.js'
import { checkDepthAlert, resolvePriority } from './queue.js'
import { jobHandler, readyRuntime, type QueueRuntime } from './runtime.js'
import type { ConcurrencyLimits, RetryDecision, RetryPolicyContext } from './slots.js'
import { DEFAULT_QUEUE, type QueuedJobRow } from './types.js'

export interface StartWorkerOptions {
  /** Override the configured queues, for a worker dedicated to one of them. */
  readonly queues?: readonly string[] | undefined
  readonly pollIntervalMs?: number | undefined
}

export interface WorkerHandle {
  readonly id: string
  /** Jobs this worker is running right now. */
  readonly running: number
  /** Poll until nothing is runnable. Returns when the queue is quiet. */
  drain(maxRounds?: number): Promise<void>
  stop(options?: { readonly abort?: boolean }): Promise<void>
}

function newId(): string {
  return globalThis.crypto.randomUUID()
}

function unref(timer: unknown): void {
  ;(timer as { unref?: () => void }).unref?.()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    unref(timer)
  })
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

interface RunningJob {
  readonly kind: string
  readonly controller: AbortController
  readonly promise: Promise<void>
}

/**
 * The worker loop.
 *
 * It holds no job state: every decision reads from and writes to the store, so
 * killing the process loses nothing but the leases, and those expire. That is
 * the property `kernel.work` does not have and the reason this upgrade exists.
 */
class Worker implements WorkerHandle {
  readonly id: string
  private readonly queues: readonly string[]
  private readonly pollIntervalMs: number
  private readonly inflight = new Map<string, RunningJob>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false

  constructor(runtime: QueueRuntime, options: StartWorkerOptions) {
    this.id = runtime.config.workerId
    this.queues = options.queues ?? runtime.config.queues
    this.pollIntervalMs = options.pollIntervalMs ?? runtime.config.pollIntervalMs
  }

  get running(): number {
    return this.inflight.size
  }

  start(): void {
    this.stopped = false
    void this.pump()
  }

  async drain(maxRounds = 1000): Promise<void> {
    let quietRounds = 0
    for (let round = 0; round < maxRounds; round += 1) {
      const leased = await this.tick()
      await this.settle()
      if (leased === 0 && this.running === 0) {
        quietRounds += 1
        // Two quiet rounds, because a job that just failed may have been
        // rescheduled a millisecond into the future.
        if (quietRounds >= 2) return
        await sleep(5)
      } else {
        quietRounds = 0
      }
    }
  }

  async stop(options: { readonly abort?: boolean } = {}): Promise<void> {
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    if (options.abort === true) {
      for (const job of this.inflight.values()) job.controller.abort()
    }
    await this.settle()
  }

  private async settle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.all([...this.inflight.values()].map((job) => job.promise))
    }
  }

  private async pump(): Promise<void> {
    if (this.stopped) return
    try {
      await this.tick()
    } catch (error) {
      // A failed tick must not kill the loop; a queue that stops polling
      // because one poll threw is a silent outage.
      console.error(`[ops.queue] worker ${this.id} tick failed:`, asError(error).message)
    }
    if (this.stopped) return
    const timer = setTimeout(() => void this.pump(), this.pollIntervalMs)
    unref(timer)
    this.timer = timer
  }

  /** One poll. Returns how many jobs were leased. */
  private async tick(): Promise<number> {
    const runtime = await readyRuntime()
    const now = new Date()

    // Jobs whose worker died mid-run come back to the pending pool. Without
    // this a crash would strand a job in 'running' forever.
    await runtime.store.reclaimExpiredLeases(
      new Date(now.getTime() - runtime.config.visibilityTimeoutMs),
    )
    await this.runDueSchedules(runtime, now)

    const limits = await this.concurrencyLimits(runtime)
    const capacity = Math.max(0, limits.global - this.running)
    if (capacity === 0) return 0

    const rows = await runtime.store.lease({
      queues: this.queues,
      limit: capacity,
      workerId: this.id,
      now,
      excludeKinds: this.saturatedKinds(limits),
    })
    // The lease query cannot express a per-kind ceiling, so anything the batch
    // over-claimed goes straight back to the pending pool rather than being
    // held in this worker's memory.
    const ordered = await this.order(rows)
    const started: QueuedJobRow[] = []
    const released: string[] = []
    const projected = this.runningByKind()
    for (const row of ordered) {
      const ceiling = limits.perKind[row.kind]
      const running = projected[row.kind] ?? 0
      if (ceiling !== undefined && running >= ceiling) {
        released.push(row.id)
        continue
      }
      projected[row.kind] = running + 1
      started.push(row)
    }
    await runtime.store.releaseJobs(released)
    for (const row of started) this.begin(runtime, row)

    await checkDepthAlert()
    return started.length
  }

  private saturatedKinds(limits: ConcurrencyLimits): string[] {
    const running = this.runningByKind()
    return Object.entries(limits.perKind)
      .filter(([kind, max]) => (running[kind] ?? 0) >= max)
      .map(([kind]) => kind)
  }

  private runningByKind(): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const job of this.inflight.values()) {
      counts[job.kind] = (counts[job.kind] ?? 0) + 1
    }
    return counts
  }

  private async concurrencyLimits(runtime: QueueRuntime): Promise<ConcurrencyLimits> {
    const fallback = (): ConcurrencyLimits => ({
      global: runtime.config.concurrency,
      perKind: {},
    })
    const slot = runtime.config.slots.concurrencyLimits
    if (slot === undefined) return fallback()
    return slot({
      queue: this.queues[0] ?? DEFAULT_QUEUE,
      configured: runtime.config.concurrency,
      running: this.runningByKind(),
      proceed: fallback,
    })
  }

  /**
   * The store already orders by stored priority; asking the slot again here is
   * what makes a client rule hold for a backlog that was enqueued before the
   * rule existed.
   */
  private async order(rows: readonly QueuedJobRow[]): Promise<QueuedJobRow[]> {
    const scored = await Promise.all(
      rows.map(async (row) => ({
        row,
        priority: await resolvePriority({
          kind: row.kind,
          queue: row.queue,
          payload: row.payload,
          requested: row.priority,
        }),
      })),
    )
    return scored.sort((a, b) => b.priority - a.priority).map((entry) => entry.row)
  }

  private async runDueSchedules(runtime: QueueRuntime, now: Date): Promise<void> {
    const due = await runtime.store.dueSchedules(now)
    for (const schedule of due) {
      const row = await runtime.store.insertJob({
        id: newId(),
        queue: schedule.queue,
        kind: schedule.kind,
        payload: schedule.payload,
        priority: schedule.priority,
        maxAttempts: schedule.maxAttempts,
        runAt: now,
        idempotencyKey: null,
        scheduleId: schedule.id,
      })
      await runtime.store.advanceSchedule(schedule.id, nextCronOccurrence(schedule.cron, now), now)
      await emitQueueEvent('job.enqueued', {
        job_id: row.id,
        kind: row.kind,
        priority: row.priority,
      })
    }
  }

  private begin(runtime: QueueRuntime, row: QueuedJobRow): void {
    const controller = new AbortController()
    const promise = this.run(runtime, row, controller).finally(() => {
      this.inflight.delete(row.id)
    })
    this.inflight.set(row.id, { kind: row.kind, controller, promise })
  }

  private async run(
    runtime: QueueRuntime,
    row: QueuedJobRow,
    controller: AbortController,
  ): Promise<void> {
    const startedAt = new Date()
    await emitQueueEvent('job.started', {
      job_id: row.id,
      kind: row.kind,
      attempt: row.attempts,
    })
    try {
      const handler = jobHandler(row.kind)
      if (handler === undefined) {
        throw new Error(
          `no handler registered for job kind ${JSON.stringify(row.kind)}; ` +
            'call registerJobHandler() before enqueueing',
        )
      }
      await handler({
        id: row.id,
        kind: row.kind,
        queue: row.queue,
        payload: row.payload,
        attempt: row.attempts,
        maxAttempts: row.maxAttempts,
        signal: controller.signal,
      })
      const finishedAt = new Date()
      await runtime.store.completeJob({
        jobId: row.id,
        attempt: row.attempts,
        startedAt,
        finishedAt,
      })
      await emitQueueEvent('job.succeeded', {
        job_id: row.id,
        kind: row.kind,
        duration_ms: finishedAt.getTime() - startedAt.getTime(),
      })
    } catch (error) {
      await this.fail(runtime, row, asError(error), startedAt)
    }
  }

  private async fail(
    runtime: QueueRuntime,
    row: QueuedJobRow,
    error: Error,
    startedAt: Date,
  ): Promise<void> {
    const finishedAt = new Date()
    const decision = await this.retryDecision(runtime, row, error)
    const nextRunAt = decision.retry ? new Date(finishedAt.getTime() + decision.delayMs) : null

    const outcome = await runtime.store.failJob({
      jobId: row.id,
      attempt: row.attempts,
      startedAt,
      finishedAt,
      error: error.message,
      nextRunAt,
    })

    // 'ignored' means another worker already resolved this job. Publishing here
    // would double-count the failure, so it does not.
    if (outcome.outcome === 'ignored') return

    await emitQueueEvent('job.failed', {
      job_id: row.id,
      kind: row.kind,
      attempt: row.attempts,
      error: error.message,
      will_retry: outcome.outcome === 'retrying',
    })

    // Exactly once: the store only reports 'dead_lettered' to the caller that
    // moved the row out of 'running', and the entry is unique on job_id.
    if (outcome.outcome === 'dead_lettered') {
      await emitQueueEvent('job.dead_lettered', {
        job_id: row.id,
        kind: row.kind,
        attempts: outcome.entry.attempts,
        error: error.message,
      })
    }
  }

  private async retryDecision(
    runtime: QueueRuntime,
    row: QueuedJobRow,
    error: Error,
  ): Promise<RetryDecision> {
    const { baseRetryDelayMs, maxRetryDelayMs } = runtime.config
    const fallback = (): RetryDecision => {
      if (row.attempts >= row.maxAttempts) return { retry: false }
      const delayMs = Math.min(baseRetryDelayMs * 2 ** (row.attempts - 1), maxRetryDelayMs)
      return { retry: true, delayMs }
    }

    const slot = runtime.config.slots.retryPolicies
    if (slot === undefined) return fallback()

    const ctx: RetryPolicyContext = {
      jobId: row.id,
      kind: row.kind,
      queue: row.queue,
      payload: row.payload,
      attempt: row.attempts,
      maxAttempts: row.maxAttempts,
      error,
      proceed: fallback,
    }
    return slot(ctx)
  }
}

let worker: Worker | undefined

/**
 * Start polling for work.
 *
 * The generated `src/generated/ops.queue/worker.ts` is a three-line file that
 * imports the config, imports the event subscriptions, and calls this. Calling
 * it twice returns the running worker rather than starting a second loop.
 */
export async function startWorker(options: StartWorkerOptions = {}): Promise<WorkerHandle> {
  if (worker !== undefined) return worker
  const runtime = await readyRuntime()
  const next = new Worker(runtime, options)
  worker = next
  next.start()
  return next
}

/** The running worker, if there is one. */
export function activeWorker(): WorkerHandle | undefined {
  return worker
}

export async function stopWorker(options: { readonly abort?: boolean } = {}): Promise<void> {
  const current = worker
  worker = undefined
  if (current !== undefined) await current.stop(options)
}

/**
 * Run the queue until it is quiet, without leaving a loop behind. Intended for
 * tests and for one-shot batch containers.
 */
export async function drainQueue(maxRounds = 1000): Promise<void> {
  const runtime = await readyRuntime()
  const temporary = new Worker(runtime, {})
  await temporary.drain(maxRounds)
}
