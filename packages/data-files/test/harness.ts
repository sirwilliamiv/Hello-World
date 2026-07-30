/**
 * Test harness: an in-memory stand-in for the three kernel capabilities this package
 * calls into, plus a real `local` storage driver on a temp directory.
 *
 * The queue is deliberately *manual*. Jobs sit in a list until `drain()` runs them,
 * which is what lets a test observe the window in which a file exists, has bytes in
 * storage, and must still be inaccessible.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  configureFiles,
  resetFilesConfig,
  FILE_JOBS,
  LocalStorageDriver,
  type FilesConfigInput,
  type FilesRuntime,
  type JobSpecLike,
  type RepositoryLike,
  type ScanRequest,
  type ScanResult,
  type VirusScanner,
} from '../src/index.js'

type Row = { id: string } & Record<string, unknown>

/** A `kernel.data` Repository that keeps rows in a Map. */
export class InMemoryRepository<T extends { id: string }> implements RepositoryLike<T> {
  readonly rows = new Map<string, T>()
  private readonly softDeleted = new Set<string>()

  async find(id: string): Promise<T | null> {
    if (this.softDeleted.has(id)) return null
    return this.rows.get(id) ?? null
  }

  async findMany(where?: Partial<T>): Promise<T[]> {
    const all = [...this.rows.values()].filter((row) => !this.softDeleted.has(row.id))
    if (where === undefined) return all
    const criteria = Object.entries(where) as [keyof T, unknown][]
    return all.filter((row) => criteria.every(([key, value]) => row[key] === value))
  }

  async create(value: T): Promise<T> {
    this.rows.set(value.id, { ...value })
    return { ...value }
  }

  async update(id: string, patch: Partial<T>): Promise<T> {
    const existing = this.rows.get(id)
    if (existing === undefined) throw new Error(`No row ${id}`)
    const next = { ...existing, ...patch }
    this.rows.set(id, next)
    return { ...next }
  }

  async softDelete(id: string): Promise<void> {
    this.softDeleted.add(id)
  }

  async restore(id: string): Promise<void> {
    this.softDeleted.delete(id)
  }

  async delete(id: string): Promise<void> {
    this.rows.delete(id)
    this.softDeleted.delete(id)
  }

  /** Rows regardless of soft-deletion — used to prove a hard delete really happened. */
  all(): T[] {
    return [...this.rows.values()]
  }
}

export interface PublishedEvent {
  name: string
  payload: Record<string, unknown>
}

export class ManualQueue {
  readonly jobs: JobSpecLike[] = []
  readonly seen = new Set<string>()

  enqueue(job: JobSpecLike): { id: string } {
    // The durable queue deduplicates on the idempotency key; so does this one, so a
    // replayed enqueue does not silently double the work in tests either.
    if (job.idempotencyKey !== undefined) {
      if (this.seen.has(job.idempotencyKey)) return { id: job.idempotencyKey }
      this.seen.add(job.idempotencyKey)
    }
    this.jobs.push(job)
    return { id: `job-${this.jobs.length}` }
  }

  /** Run every queued job. Throws whatever a handler throws, like a real worker. */
  async drain(): Promise<void> {
    while (this.jobs.length > 0) {
      const job = this.jobs.shift() as JobSpecLike
      const handler = FILE_JOBS[job.kind]
      if (handler === undefined) throw new Error(`No handler registered for ${job.kind}`)
      await handler(job.payload)
    }
  }

  /** Run every job, collecting failures the way a retrying queue would. */
  async drainCatching(): Promise<Error[]> {
    const errors: Error[] = []
    const pending = [...this.jobs]
    this.jobs.length = 0
    for (const job of pending) {
      const handler = FILE_JOBS[job.kind]
      if (handler === undefined) throw new Error(`No handler registered for ${job.kind}`)
      try {
        await handler(job.payload)
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)))
        // A failed durable job goes back on the queue for another attempt.
        this.jobs.push(job)
      }
    }
    return errors
  }
}

/** A scanner that treats the EICAR-style marker as an infection. */
export class FakeScanner implements VirusScanner {
  readonly name = 'fake'
  calls = 0
  available = true

  async scan(request: ScanRequest): Promise<ScanResult> {
    this.calls += 1
    if (!this.available) {
      const { ScannerUnavailableError } = await import('../src/errors.js')
      throw new ScannerUnavailableError('fake scanner is down')
    }
    const text = Buffer.from(request.bytes).toString('utf8')
    return text.includes('INFECTED')
      ? { clean: false, scanner: this.name, threat: 'Test.Virus' }
      : { clean: true, scanner: this.name }
  }
}

export interface Harness {
  root: string
  storage: LocalStorageDriver
  runtime: FilesRuntime
  queue: ManualQueue
  scanner: FakeScanner
  events: PublishedEvent[]
  repos: {
    files: InMemoryRepository<Row & { id: string }>
    versions: InMemoryRepository<Row & { id: string }>
    sessions: InMemoryRepository<Row & { id: string }>
    thumbnails: InMemoryRepository<Row & { id: string }>
  }
  user: { id: string } | null
  cleanup(): Promise<void>
}

export const BASE_URL = 'http://app.test'

export async function setupFiles(overrides: Partial<FilesConfigInput> = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'forge-files-'))
  const storage = new LocalStorageDriver({
    root,
    credentials: 'test-storage-credentials',
    publicBaseUrl: BASE_URL,
  })

  const repos = {
    files: new InMemoryRepository<Row>(),
    versions: new InMemoryRepository<Row>(),
    sessions: new InMemoryRepository<Row>(),
    thumbnails: new InMemoryRepository<Row>(),
  }
  const byEntity: Record<string, InMemoryRepository<Row>> = {
    File: repos.files,
    FileVersion: repos.versions,
    UploadSession: repos.sessions,
    Thumbnail: repos.thumbnails,
  }

  const events: PublishedEvent[] = []
  const queue = new ManualQueue()
  const scanner = new FakeScanner()
  const harness: Partial<Harness> = { user: { id: 'user-1' } }

  const runtime: FilesRuntime = {
    repository: <T extends { id: string }>(entity: string) => {
      const repo = byEntity[entity]
      if (repo === undefined) throw new Error(`Unregistered entity ${entity}`)
      return repo as unknown as RepositoryLike<T>
    },
    publish: async (name, payload) => {
      events.push({ name, payload })
    },
    currentUser: async () => harness.user ?? null,
    enqueue: async (job) => queue.enqueue(job),
    schedule: async (_cron, job) => queue.enqueue(job),
  }

  resetFilesConfig()
  configureFiles({
    driver: 'local',
    bucket: 'test-bucket',
    credentials: 'test-storage-credentials',
    maxSizeBytes: 1_048_576,
    allowedContentTypes: ['text/plain', 'image/png', 'application/pdf'],
    scanPolicy: 'require_clean',
    storage,
    runtime,
    scanner,
    publicBaseUrl: BASE_URL,
    ...overrides,
  })

  Object.assign(harness, {
    root,
    storage,
    runtime,
    queue,
    scanner,
    events,
    repos,
    cleanup: async () => {
      resetFilesConfig()
      await rm(root, { recursive: true, force: true })
    },
  })
  return harness as Harness
}

export function eventNames(events: PublishedEvent[]): string[] {
  return events.map((e) => e.name)
}
