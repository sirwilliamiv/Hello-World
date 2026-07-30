/**
 * Cascade deletion — the capability's mandatory contract test with `kernel.data`.
 *
 * The invariant is that a delete leaves **no orphaned objects**: a File row and its
 * stored object go together, always, in that order. Objects are removed first and
 * the row last, so a failure halfway leaves a row pointing at a missing object (a
 * visible, repairable inconsistency the retry fixes) rather than an object nobody
 * has a record of (an invisible, unrecoverable one).
 */
import { files } from './config.js'
import { repositories, hardDelete } from './repositories.js'
import { fileId, type FileRecord, type FileRef } from './types.js'

/** `kernel.data` emits this for every entity, ours included. */
export interface EntityDeletedEvent {
  readonly name?: string
  readonly payload: {
    readonly entity: string
    readonly id: string
    readonly actor?: string | null
    /** A soft delete is reversible, so the objects must survive it. */
    readonly soft?: boolean
  }
}

export interface DeleteFileOptions {
  /** Recorded on `file.deleted` so an audit can see what triggered the removal. */
  cascadeSource?: string
  /** Soft: keep the object, make the row unretrievable, allow restore. */
  soft?: boolean
}

/**
 * Remove one file: every derived object, every version's object, the original, then
 * the rows. Idempotent — deleting a file twice is a no-op, which matters because the
 * queue may replay the cascade job.
 */
export async function deleteFile(ref: FileRef, opts: DeleteFileOptions = {}): Promise<void> {
  const cfg = files()
  const repos = await repositories()
  const id = fileId(ref)

  const file = await repos.files.find(id)
  if (file === null) return

  if (opts.soft === true) {
    await repos.files.update(id, { status: 'deleted', updatedAt: new Date() })
    await repos.files.softDelete(id)
    await repos.publish('file.deleted', {
      file_id: id,
      ...(opts.cascadeSource === undefined ? {} : { cascade_source: opts.cascadeSource }),
    })
    return
  }

  const thumbnails = await repos.thumbnails.findMany({ fileId: id })
  const versions = await repos.versions.findMany({ fileId: id })

  // A key may appear on several rows (a version that never diverged from the
  // original). Delete each object once; deleting a missing object is not an error.
  const keys = new Set<string>([
    ...thumbnails.map((t) => t.storageKey),
    ...versions.map((v) => v.storageKey),
    file.storageKey,
  ])
  for (const key of keys) {
    await cfg.storage.delete(key)
  }

  for (const thumbnail of thumbnails) await hardDelete(repos.thumbnails, thumbnail.id)
  for (const version of versions) await hardDelete(repos.versions, version.id)
  for (const session of await repos.sessions.findMany({ fileId: id })) {
    await hardDelete(repos.sessions, session.id)
  }
  await hardDelete(repos.files, id)

  await repos.publish('file.deleted', {
    file_id: id,
    ...(opts.cascadeSource === undefined ? {} : { cascade_source: opts.cascadeSource }),
  })
}

/**
 * `consumes: entity.deleted` — the declared handler. Wired by
 * `src/generated/kernel.events/subscriptions.ts`.
 *
 * A hard delete of the owning entity removes rows and objects. A soft delete is
 * reversible, so the files are hidden and the objects kept.
 */
export async function cascadeDelete(event: EntityDeletedEvent): Promise<void> {
  const { entity, id, soft } = event.payload
  const repos = await repositories()

  // Our own rows are deleted by `deleteFile`; re-entering here would loop.
  if (entity === 'File') return

  const attached: FileRecord[] = await repos.files.findMany({
    attachedToEntity: entity,
    attachedToId: id,
  })

  for (const file of attached) {
    await deleteFile(file.id, {
      cascadeSource: `${entity}:${id}`,
      ...(soft === true ? { soft: true } : {}),
    })
  }
}
