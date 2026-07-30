import type { ResolvedQueueConfig } from './config.js'
import type { QueueStore } from './store.js'
import type { JobHandler } from './types.js'
import { QueueNotConfiguredError } from './types.js'

/**
 * The configured queue: the resolved config and the store behind it.
 *
 * The handler registry deliberately lives *outside* the runtime, at module
 * scope. Capability packages register their handlers when they are imported,
 * which may be before or after the generated `config.ts` runs; making
 * registration independent of configuration means import order is not a thing
 * anyone has to reason about.
 */
export interface QueueRuntime {
  readonly config: ResolvedQueueConfig
  readonly store: QueueStore
  /** Set while the depth alert is firing, so it fires on the crossing, not per job. */
  depthAlertActive: boolean
  /** Memoised `store.init()`, so the first caller pays and the rest await. */
  ready: Promise<void> | undefined
}

const handlers = new Map<string, JobHandler>()
let runtime: QueueRuntime | undefined

export function setQueueRuntime(next: QueueRuntime): void {
  runtime = next
}

export function queueRuntime(): QueueRuntime {
  if (runtime === undefined) throw new QueueNotConfiguredError()
  return runtime
}

export function maybeQueueRuntime(): QueueRuntime | undefined {
  return runtime
}

export function clearQueueRuntime(): void {
  runtime = undefined
}

/** Open the store once, and let every caller await the same promise. */
export async function readyRuntime(): Promise<QueueRuntime> {
  const current = queueRuntime()
  current.ready ??= current.store.init()
  await current.ready
  return current
}

/**
 * Register the handler for a job kind. Same name and signature as
 * `@forge/kernel-work`'s, so a capability that registers work keeps compiling
 * across the upgrade.
 */
export function registerJobHandler(kind: string, handler: JobHandler): void {
  handlers.set(kind, handler)
}

export function jobHandler(kind: string): JobHandler | undefined {
  return handlers.get(kind)
}

export function registeredJobKinds(): string[] {
  return [...handlers.keys()].sort()
}

/** Test seam. */
export function clearJobHandlers(): void {
  handlers.clear()
}
