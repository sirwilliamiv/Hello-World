/**
 * Retrieval. One gate, used by every read path: a file is retrievable if and only if
 * its status is `available`, which it becomes only after a scanner cleared it.
 *
 * Anything else — awaiting upload, scanning, quarantined, deleted — raises the same
 * 404 as a file that never existed.
 */
import { files } from './config.js'
import { FileNotAccessibleError, FileNotFoundError } from './errors.js'
import { repositories } from './repositories.js'
import { fileId, type FileRecord, type FileRef } from './types.js'

export function isAccessible(file: Pick<FileRecord, 'status'>): boolean {
  return file.status === 'available'
}

/** The row, whatever its state. Throws 404 only when there is genuinely no row. */
export async function getFile(ref: FileRef): Promise<FileRecord> {
  const repos = await repositories()
  const id = fileId(ref)
  const file = await repos.files.find(id)
  if (file === null) throw new FileNotFoundError(id)
  return file
}

/** The row, if and only if it cleared scanning. The single access gate. */
export async function requireAccessibleFile(ref: FileRef): Promise<FileRecord> {
  const file = await getFile(ref)
  if (!isAccessible(file)) throw new FileNotAccessibleError(file.id)
  return file
}

/**
 * `signedUrl(file, ttlSeconds?) -> string`. Always expires; there is no way to ask
 * for a URL that does not. A file awaiting scan produces a 404, not a URL.
 */
export async function signedUrl(ref: FileRef, ttlSeconds?: number): Promise<string> {
  const cfg = files()
  const file = await requireAccessibleFile(ref)
  return cfg.storage.signedDownloadUrl(file.storageKey, {
    ttlSeconds: ttlSeconds ?? cfg.signedUrlTtlSeconds,
    filename: file.filename,
  })
}

/** Files attached to one entity — the list a detail page renders. */
export async function filesFor(entity: string, id: string): Promise<FileRecord[]> {
  const repos = await repositories()
  const rows = await repos.files.findMany({ attachedToEntity: entity, attachedToId: id })
  return rows.filter(isAccessible)
}

/** Files a user owns. Used by the browser component and by the privacy export. */
export async function filesOwnedBy(ownerId: string): Promise<FileRecord[]> {
  const repos = await repositories()
  return repos.files.findMany({ ownerId })
}
