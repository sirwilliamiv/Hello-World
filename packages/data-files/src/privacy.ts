/**
 * The privacy handlers `owns[].privacy` names for the `File` entity. `data.privacy`
 * calls these; validation check 10 fails the build if they are missing.
 *
 * `deletion_strategy: "delete"` with the retention note "a retained row pointing at a
 * deleted object is a broken export" — so deletion goes through the same cascade the
 * contract test covers, and the export deliberately carries metadata only. Handing
 * out signed URLs inside an export would hand out credentials with a TTL nobody is
 * watching.
 */
import { filesOwnedBy } from './access.js'
import { deleteFile } from './cascade.js'

export interface ExportedFile {
  readonly id: string
  readonly filename: string
  readonly content_type: string
  readonly size_bytes: number
  readonly checksum: string | null
  readonly status: string
  readonly attached_to: string | null
  readonly created_at: string
}

export async function exportFiles(userId: string): Promise<ExportedFile[]> {
  const owned = await filesOwnedBy(userId)
  return owned
    .map((file) => ({
      id: file.id,
      filename: file.filename,
      content_type: file.contentType,
      size_bytes: file.sizeBytes,
      checksum: file.checksum,
      status: file.status,
      attached_to:
        file.attachedToEntity === null ? null : `${file.attachedToEntity}:${file.attachedToId}`,
      created_at: file.createdAt.toISOString(),
    }))
    // Sorted so two exports of the same data compare equal.
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export async function deleteFilesAndObjects(userId: string): Promise<{ deleted: number }> {
  const owned = await filesOwnedBy(userId)
  for (const file of owned) {
    await deleteFile(file.id, { cascadeSource: `privacy:user:${userId}` })
  }
  return { deleted: owned.length }
}
