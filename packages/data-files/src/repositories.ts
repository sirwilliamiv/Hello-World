import { runtime, type RepositoryLike } from './ports.js'
import {
  FILE_ENTITIES,
  type FileRecord,
  type FileVersionRecord,
  type ThumbnailRecord,
  type UploadSessionRecord,
} from './types.js'

export interface FileRepositories {
  files: RepositoryLike<FileRecord>
  versions: RepositoryLike<FileVersionRecord>
  sessions: RepositoryLike<UploadSessionRecord>
  thumbnails: RepositoryLike<ThumbnailRecord>
  publish(name: string, payload: Record<string, unknown>): Promise<void>
  currentUser(): Promise<{ id: string } | null>
  enqueue(job: {
    kind: string
    payload: Record<string, unknown>
    idempotencyKey?: string
  }): Promise<{ id: string }>
  schedule(
    cron: string,
    job: { kind: string; payload: Record<string, unknown> },
  ): Promise<{ id: string }>
}

/**
 * Every table this capability owns, reached through `kernel.data`'s repository —
 * the only sanctioned data access path, so tenant scoping and append-only
 * enforcement apply to us like everyone else.
 */
export async function repositories(): Promise<FileRepositories> {
  const rt = await runtime()
  return {
    files: rt.repository<FileRecord>(FILE_ENTITIES.file),
    versions: rt.repository<FileVersionRecord>(FILE_ENTITIES.fileVersion),
    sessions: rt.repository<UploadSessionRecord>(FILE_ENTITIES.uploadSession),
    thumbnails: rt.repository<ThumbnailRecord>(FILE_ENTITIES.thumbnail),
    publish: (name, payload) => rt.publish(name, payload),
    currentUser: () => rt.currentUser(),
    enqueue: (job) => rt.enqueue(job),
    schedule: (cron, job) => rt.schedule(cron, job),
  }
}

/**
 * `data.files` declares `deletion_strategy: "delete"` and its mandatory contract test
 * requires the row to be gone. `kernel.data` exposes only `softDelete`, so we use its
 * hard delete when it has one and fall back otherwise (reported as a contract gap).
 */
export async function hardDelete<T extends { id: string }>(
  repo: RepositoryLike<T>,
  id: string,
): Promise<void> {
  if (repo.delete !== undefined) {
    await repo.delete(id)
    return
  }
  await repo.softDelete(id)
}
