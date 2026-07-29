import type { QueueStore } from '../store.js'
import { QueueDriverUnavailableError } from '../types.js'

/**
 * `driver: "redis"` is a declared configuration option in
 * `ops.queue.capability.json`, offered "where throughput justifies the
 * operational cost". It is not implemented.
 *
 * This is a deliberate stub, not an oversight, and it fails at
 * `configureQueue()` rather than at the first enqueue — a queue that silently
 * loses work is worse than one that refuses to start. Phase 1's requirement is
 * that a local workspace needs no second service, which is exactly what the
 * Postgres driver delivers.
 *
 * Implementing it means providing a `QueueStore` over:
 *   - a per-queue sorted set keyed on (priority, run_at) for the pending pool,
 *   - a Lua script for lease-and-increment, since `SKIP LOCKED` has no Redis
 *     equivalent and the claim must be atomic,
 *   - a sorted set of in-flight leases scored by expiry, for `reclaimExpiredLeases`,
 *   - Redis streams or a list for the append-only `JobAttempt` history,
 *   - a hash per dead-letter entry, with `HSETNX` on `job_id` supplying the
 *     exactly-once guarantee the Postgres unique index gives.
 *
 * Everything above the store — retry policy, dead-lettering, slots, events —
 * is driver-independent and needs no change.
 */
export function createRedisQueueStore(_options: {
  readonly url?: string | undefined
}): QueueStore {
  throw new QueueDriverUnavailableError(
    'redis',
    'the Redis driver is not implemented in ops.queue 1.0.0. Use the default ' +
      "driver: 'postgres' — QUEUE_URL may be the application database URL.",
  )
}
