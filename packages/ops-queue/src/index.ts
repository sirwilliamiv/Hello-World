/**
 * `@forge/ops-queue` — durable background processing.
 *
 * This capability *upgrades* `kernel.work`. Per ARCHITECTURE.md section 3 an
 * upgrade takes over the slot: the upgraded capability's exposed interface
 * survives and only the implementation is replaced. So `enqueue` and `schedule`
 * are exported here with `kernel.work`'s exact signatures — the compile-time
 * assertions at the bottom of this file prove it, and validation check FORGE006
 * proves it again at the specification level — and every existing caller keeps
 * working while gaining durability, retry, dead-lettering, concurrency limits
 * and replay.
 */

import type * as KernelWork from '@forge/kernel-work'
import { enqueue, schedule } from './queue.js'

export { configureQueue, queueConfig, shutdownQueue } from './config.js'
export type { QueueConfigInput, ResolvedQueueConfig } from './config.js'

export {
  deadLetters,
  enqueue,
  findJob,
  jobAttempts,
  queueDepth,
  replay,
  schedule,
  toJobRef,
} from './queue.js'

export {
  activeWorker,
  drainQueue,
  startWorker,
  stopWorker,
  type StartWorkerOptions,
  type WorkerHandle,
} from './worker.js'

export {
  clearJobHandlers,
  jobHandler,
  registerJobHandler,
  registeredJobKinds,
} from './runtime.js'

export type {
  ConcurrencyContext,
  ConcurrencyLimits,
  ConcurrencyLimitsSlot,
  PriorityContext,
  PrioritySlot,
  PriorityRulesSlot,
  QueueSlots,
  RetryDecision,
  RetryPoliciesSlot,
  RetryPolicyContext,
} from './slots.js'

export type {
  DeadLetterRow,
  FailOutcome,
  JobAttemptRow,
  JobContext,
  JobHandler,
  JobPayload,
  JobRef,
  JobSpec,
  JobStatus,
  QueueDriver,
  QueuedJobRow,
  ScheduledJobRow,
} from './types.js'
export {
  DEFAULT_PRIORITY,
  DEFAULT_QUEUE,
  QueueDriverUnavailableError,
  QueueNotConfiguredError,
} from './types.js'

export type {
  CompleteJobInput,
  FailJobInput,
  InsertJobInput,
  LeaseInput,
  QueueStore,
  UpsertScheduleInput,
} from './store.js'

export { createMemoryQueueStore, MemoryQueueStore } from './drivers/memory.js'
export type { MemoryQueueSnapshot } from './drivers/memory.js'
export { createPostgresQueueStore, PostgresQueueStore } from './drivers/postgres.js'
export type { PostgresClient, PostgresQueueStoreOptions } from './drivers/postgres.js'
export { createRedisQueueStore } from './drivers/redis.js'

export {
  deadLetterEntries,
  jobAttempts as jobAttemptsTable,
  opsQueueSchema,
  queuedJobs,
  scheduledJobs,
} from './schema.js'

export { QueueMonitor, queueMonitorSnapshot } from './monitor.js'
export type { QueueMonitorProps, QueueMonitorSnapshot } from './monitor.js'

/* -------------------------------------------------------------------------- */
/* The upgrade contract, checked by the compiler.                             */
/*                                                                            */
/* If either assertion stops holding, `ops.queue` no longer satisfies the      */
/* interface it took over, and every consumer of `enqueue`/`schedule` in every */
/* client that enabled Background Processing would break at runtime. Here it   */
/* breaks at build time instead, which is the whole point of the rule.         */
/* -------------------------------------------------------------------------- */

type Satisfies<Required, Provided extends Required> = Provided

type _EnqueueSatisfiesKernelWork = Satisfies<typeof KernelWork.enqueue, typeof enqueue>
type _ScheduleSatisfiesKernelWork = Satisfies<typeof KernelWork.schedule, typeof schedule>
