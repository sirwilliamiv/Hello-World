/**
 * `kernel.work` has no generated configuration template — there is nothing a
 * client can tune about an in-process runner. The one option here exists to
 * resolve a spec inconsistency honestly rather than silently:
 *
 * `kernel.work` declares `requires: [kernel.events]` with the reason "Job
 * lifecycle is published onto the bus", but its specification has no
 * `publishes` block, and `kernel.events` rejects an event whose schema is not
 * registered. Publishing unconditionally would therefore throw in any product
 * where `ops.queue` is absent — which is every product `kernel.work` is used
 * in. So lifecycle publication is off unless asked for, and stays off until
 * `kernel.work.capability.json` declares the `job.*` contracts.
 */
export interface WorkOptions {
  /**
   * Publish `job.enqueued` / `job.started` / `job.succeeded` / `job.failed`.
   * Requires those contracts to be registered with `kernel.events`.
   */
  readonly publishLifecycle: boolean
}

let options: WorkOptions = { publishLifecycle: false }

export function configureWork(next: Partial<WorkOptions>): void {
  options = { ...options, ...next }
}

export function workOptions(): WorkOptions {
  return options
}
