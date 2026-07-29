/**
 * `@forge/kernel-work` — in-process background work.
 *
 * Deliberately minimal: adequate for sending an email or doing light async
 * work, and nothing more. There is no durability, no retry, no dead-letter and
 * no concurrency control. A client with meaningful volume, long-running work,
 * or a need for retry guarantees takes the `ops.queue` upgrade, which keeps
 * every signature in this file and replaces the implementation behind it.
 */

import { activeWorkBackend } from './backend.js'
import type { JobRecord, JobRef, JobSpec } from './types.js'

export type {
  JobContext,
  JobHandler,
  JobPayload,
  JobRecord,
  JobRef,
  JobSpec,
  JobStatus,
} from './types.js'
export { DEFAULT_PRIORITY, DEFAULT_QUEUE, toJobRef } from './types.js'
export type { WorkBackend } from './backend.js'
export {
  activeWorkBackend,
  installWorkBackend,
  registerJobHandler,
  registeredJobKinds,
  resetWorkBackend,
} from './backend.js'
export { configureWork, workOptions, type WorkOptions } from './config.js'
export { CronParseError, nextCronOccurrence, parseCron, type CronFields } from './cron.js'

/**
 * Run `job` in the background.
 *
 * This is the signature `ops.queue` must satisfy to upgrade this capability
 * (validation check FORGE006). Consumers call it and never learn which
 * implementation answered.
 */
export function enqueue(job: JobSpec): Promise<JobRef> {
  return activeWorkBackend().enqueue(job)
}

/** Run `job` on a recurring five-field cron schedule, in UTC. */
export function schedule(cron: string, job: JobSpec): Promise<JobRef> {
  return activeWorkBackend().schedule(cron, job)
}

/**
 * Run everything that is due and wait for it to settle. Intended for tests and
 * for a clean shutdown; a production caller should not need it.
 */
export async function drainWork(): Promise<void> {
  const backend = activeWorkBackend()
  if (backend.drain !== undefined) await backend.drain()
}

/** Cancel pending timers and abort in-flight work. Nothing is persisted. */
export async function stopWork(): Promise<void> {
  const backend = activeWorkBackend()
  if (backend.stop !== undefined) await backend.stop()
}

/**
 * The `Job` records this capability owns, for the in-process backend. Returns
 * an empty list once a durable backend has taken over — its jobs live in its
 * own tables and are read through `ops.queue`.
 */
export function listJobs(): JobRecord[] {
  const backend = activeWorkBackend()
  const records = (backend as { jobRecords?: () => JobRecord[] }).jobRecords
  return records === undefined ? [] : records.call(backend)
}
