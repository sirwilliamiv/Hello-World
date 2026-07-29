/**
 * Every call this capability makes into another capability goes through this file,
 * and nowhere else. Two reasons:
 *
 *  1. `requires` is a contract, not an import list. Isolating the four call sites
 *     means a signature drift in `kernel.data` is one file to fix, not thirty.
 *  2. The kernel packages are loaded lazily, so a test can inject an in-memory
 *     runtime and exercise the whole upload → scan → retrieve path without a
 *     database, a queue, or an event bus.
 */
import { files } from './config.js'

/** `kernel.data`: `Repository<T>(entity) -> { find, findMany, create, update, softDelete, restore }`. */
export interface RepositoryLike<T extends { id: string }> {
  find(id: string): Promise<T | null>
  findMany(where?: Partial<T>): Promise<T[]>
  create(value: T): Promise<T>
  update(id: string, patch: Partial<T>): Promise<T>
  softDelete(id: string): Promise<void>
  restore(id: string): Promise<void>
  /**
   * Hard delete. `kernel.data`'s exposed interface does not declare one, but
   * `data.files` declares `deletion_strategy: "delete"` and its mandatory contract
   * test requires the row to be gone, not flagged — see the report note. Optional
   * here so we degrade to `softDelete` rather than fail to compile.
   */
  delete?(id: string): Promise<void>
}

/** `ops.queue`: `enqueue(job: JobSpec)`. Durable — a restart must not lose a scan. */
export interface JobSpecLike {
  kind: string
  payload: Record<string, unknown>
  /** Deduplication key. A replayed scan job must not re-run the pipeline twice. */
  idempotencyKey?: string
  maxAttempts?: number
}

export interface JobRefLike {
  id: string
}

export interface FilesRuntime {
  repository<T extends { id: string }>(entity: string): RepositoryLike<T>
  publish(name: string, payload: Record<string, unknown>): Promise<void>
  currentUser(): Promise<{ id: string } | null>
  enqueue(job: JobSpecLike): Promise<JobRefLike>
  schedule(cron: string, job: JobSpecLike): Promise<JobRefLike>
}

let defaultRuntime: Promise<FilesRuntime> | null = null

async function loadDefaultRuntime(): Promise<FilesRuntime> {
  const [data, events, identity, queue] = await Promise.all([
    import('@forge/kernel-data'),
    import('@forge/kernel-events'),
    import('@forge/kernel-identity'),
    import('@forge/ops-queue'),
  ])

  // One cast per capability, at the boundary, so drift shows up here and is legible.
  const kd = data as unknown as {
    Repository: <T extends { id: string }>(entity: string) => RepositoryLike<T>
  }
  const ke = events as unknown as {
    publish: (name: string, payload: Record<string, unknown>) => Promise<void>
  }
  const ki = identity as unknown as { currentUser: () => Promise<{ id: string } | null> }
  const kq = queue as unknown as {
    enqueue: (job: JobSpecLike) => Promise<JobRefLike>
    schedule: (cron: string, job: JobSpecLike) => Promise<JobRefLike>
  }

  return {
    repository: kd.Repository,
    publish: ke.publish,
    currentUser: ki.currentUser,
    enqueue: kq.enqueue,
    schedule: kq.schedule,
  }
}

export async function runtime(): Promise<FilesRuntime> {
  const injected = files().runtime
  if (injected !== undefined) return injected
  defaultRuntime ??= loadDefaultRuntime()
  return defaultRuntime
}
