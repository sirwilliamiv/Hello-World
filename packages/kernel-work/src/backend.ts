import { createInProcessBackend } from './inprocess.js'
import type { JobHandler, JobRef, JobSpec } from './types.js'

/**
 * The seam that makes the `ops.queue` upgrade real for package-level callers.
 *
 * ARCHITECTURE.md section 3 says an upgrade takes over the slot: the exposed
 * interface survives, the implementation is replaced. The generated
 * `src/generated/kernel.work/jobs.ts` does that for the *application*, by
 * re-exporting from whichever package is active. But a capability package such
 * as `@forge/kernel-mail` cannot import a generated path — it imports
 * `@forge/kernel-work` directly, and would otherwise keep the in-process
 * implementation after the upgrade, silently losing the durability the client
 * paid for.
 *
 * So `enqueue`/`schedule` here are a thin forward to the installed backend.
 * `@forge/ops-queue`'s `configureQueue()` installs itself; if it is not in the
 * product, the in-process backend is created lazily and nothing changes.
 */
export interface WorkBackend {
  /** Capability id of the implementation, for diagnostics. */
  readonly name: string
  enqueue(job: JobSpec): Promise<JobRef>
  schedule(cron: string, job: JobSpec): Promise<JobRef>
  registerHandler(kind: string, handler: JobHandler): void
  /** Run everything due and settle. Optional; a test and shutdown convenience. */
  drain?(): Promise<void>
  /** Stop timers and workers. Optional. */
  stop?(): void | Promise<void>
}

const handlers = new Map<string, JobHandler>()
let installed: WorkBackend | undefined

function adopt(backend: WorkBackend): void {
  for (const [kind, handler] of handlers) backend.registerHandler(kind, handler)
}

/** The active backend, defaulting to the in-process one. */
export function activeWorkBackend(): WorkBackend {
  if (installed === undefined) {
    installed = createInProcessBackend()
    adopt(installed)
  }
  return installed
}

/**
 * Replace the implementation behind `enqueue`/`schedule`. Called by
 * `@forge/ops-queue`. Handlers registered before the swap are carried over, so
 * import order between the generated config and a capability's registrations
 * does not matter.
 */
export function installWorkBackend(backend: WorkBackend): void {
  installed = backend
  adopt(backend)
}

/** Test seam. Drops the backend and every registration. */
export function resetWorkBackend(): void {
  installed = undefined
  handlers.clear()
}

/**
 * Register the handler for a job kind. Same name and signature in
 * `@forge/ops-queue`, so a capability that enqueues work keeps compiling
 * across the upgrade.
 */
export function registerJobHandler(kind: string, handler: JobHandler): void {
  handlers.set(kind, handler)
  if (installed !== undefined) installed.registerHandler(kind, handler)
}

export function registeredJobKinds(): string[] {
  return [...handlers.keys()].sort()
}
