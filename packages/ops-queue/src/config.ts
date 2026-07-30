import { installWorkBackend } from '@forge/kernel-work'
import { z } from 'zod'
import { createMemoryQueueStore } from './drivers/memory.js'
import { createPostgresQueueStore } from './drivers/postgres.js'
import { createRedisQueueStore } from './drivers/redis.js'
import { enqueue, schedule } from './queue.js'
import {
  clearQueueRuntime,
  maybeQueueRuntime,
  registerJobHandler,
  setQueueRuntime,
} from './runtime.js'
import type { QueueSlots } from './slots.js'
import type { QueueStore } from './store.js'
import { DEFAULT_QUEUE, type QueueDriver } from './types.js'
import { stopWorker } from './worker.js'

/**
 * What `src/generated/ops.queue/config.ts` passes. The first five fields are
 * the manifest's `config` block rendered by the template; the rest are runtime
 * details a client never needs to name and a test sometimes does.
 */
export interface QueueConfigInput {
  readonly driver?: QueueDriver | undefined
  /** `QUEUE_URL`. For the Postgres driver this may be the application database URL. */
  readonly url?: string | undefined
  readonly maxAttempts?: number | undefined
  readonly concurrency?: number | undefined
  readonly depthAlertThreshold?: number | undefined
  readonly slots?: QueueSlots | undefined

  /** Queues this product uses. Defaults to the single `default` queue. */
  readonly queues?: readonly string[] | undefined
  readonly pollIntervalMs?: number | undefined
  /** How long a lease may be held before another worker may reclaim the job. */
  readonly visibilityTimeoutMs?: number | undefined
  readonly baseRetryDelayMs?: number | undefined
  readonly maxRetryDelayMs?: number | undefined
  readonly workerId?: string | undefined
  /** Bring your own store — an existing pool, or a fake in a test. */
  readonly store?: QueueStore | undefined
}

export interface ResolvedQueueConfig {
  readonly driver: QueueDriver
  readonly url: string | undefined
  readonly maxAttempts: number
  readonly concurrency: number
  readonly depthAlertThreshold: number
  readonly queues: readonly string[]
  readonly pollIntervalMs: number
  readonly visibilityTimeoutMs: number
  readonly baseRetryDelayMs: number
  readonly maxRetryDelayMs: number
  readonly workerId: string
  readonly slots: QueueSlots
}

/**
 * The manifest half of the config, validated against the same bounds as
 * `ops.queue.capability.json`'s `config` schema. A bad value fails at boot with
 * a message naming the field, rather than at 3am with a queue that never drains.
 */
const configSchema = z.object({
  driver: z.enum(['postgres', 'redis', 'memory']).default('postgres'),
  url: z.string().min(1).optional(),
  maxAttempts: z.number().int().min(1).default(5),
  concurrency: z.number().int().min(1).default(10),
  depthAlertThreshold: z.number().int().min(1).default(1000),
  queues: z.array(z.string().min(1)).min(1).default([DEFAULT_QUEUE]),
  pollIntervalMs: z.number().int().min(1).default(250),
  visibilityTimeoutMs: z.number().int().min(1000).default(60_000),
  baseRetryDelayMs: z.number().int().min(0).default(1_000),
  maxRetryDelayMs: z.number().int().min(0).default(60_000 * 15),
  workerId: z.string().min(1).optional(),
})

function createStore(config: ResolvedQueueConfig): QueueStore {
  switch (config.driver) {
    case 'postgres':
      return createPostgresQueueStore({ url: config.url })
    case 'redis':
      return createRedisQueueStore({ url: config.url })
    case 'memory':
      return createMemoryQueueStore()
  }
}

/**
 * Configure the durable queue and take over `kernel.work`'s slot.
 *
 * Called once at boot by the generated `src/generated/ops.queue/config.ts`.
 * Installing the backend into `@forge/kernel-work` is what makes the upgrade
 * reach capability packages: `@forge/kernel-mail` calls `enqueue` from
 * `@forge/kernel-work`, and after this call that enqueue is this queue.
 * Without it, mail delivery would keep running in-process after a client paid
 * for durability — the exact silent regression the upgrade rule in
 * ARCHITECTURE.md section 3 exists to prevent.
 */
export function configureQueue(input: QueueConfigInput = {}): ResolvedQueueConfig {
  const parsed = configSchema.parse({
    driver: input.driver,
    url: input.url,
    maxAttempts: input.maxAttempts,
    concurrency: input.concurrency,
    depthAlertThreshold: input.depthAlertThreshold,
    queues: input.queues === undefined ? undefined : [...input.queues],
    pollIntervalMs: input.pollIntervalMs,
    visibilityTimeoutMs: input.visibilityTimeoutMs,
    baseRetryDelayMs: input.baseRetryDelayMs,
    maxRetryDelayMs: input.maxRetryDelayMs,
    workerId: input.workerId,
  })

  const config: ResolvedQueueConfig = {
    driver: parsed.driver,
    url: parsed.url,
    maxAttempts: parsed.maxAttempts,
    concurrency: parsed.concurrency,
    depthAlertThreshold: parsed.depthAlertThreshold,
    queues: parsed.queues,
    pollIntervalMs: parsed.pollIntervalMs,
    visibilityTimeoutMs: parsed.visibilityTimeoutMs,
    baseRetryDelayMs: parsed.baseRetryDelayMs,
    maxRetryDelayMs: parsed.maxRetryDelayMs,
    workerId: parsed.workerId ?? `worker-${globalThis.crypto.randomUUID()}`,
    slots: input.slots ?? {},
  }

  setQueueRuntime({
    config,
    store: input.store ?? createStore(config),
    depthAlertActive: false,
    ready: undefined,
  })

  installWorkBackend({
    name: 'ops.queue',
    enqueue,
    schedule,
    registerHandler: registerJobHandler,
  })

  return config
}

export function queueConfig(): ResolvedQueueConfig | undefined {
  return maybeQueueRuntime()?.config
}

/** Stop the worker and close the store. Used at shutdown and between tests. */
export async function shutdownQueue(): Promise<void> {
  await stopWorker()
  const runtime = maybeQueueRuntime()
  if (runtime !== undefined) await runtime.store.close()
  clearQueueRuntime()
}
