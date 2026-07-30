/**
 * The shapes `data.files` owns, in TypeScript.
 *
 * The lifecycle these types encode is the capability's whole point:
 *
 *   awaiting_upload ── bytes land in storage ──▶ scanning ──┬── clean ──▶ available
 *                                                           └── infected / rejected ──▶ quarantined
 *
 * A file is retrievable only in `available`. `file.uploaded` is published on the
 * transition into `available` and nowhere else, so no consumer can ever observe an
 * object that has not cleared scanning.
 */

/** A file is addressed either by id or by the record itself. */
export type FileRef = string | { readonly id: string }

export type FileStatus =
  /** The signed grant has been issued; storage may not hold the bytes yet. */
  | 'awaiting_upload'
  /** Bytes are in storage, the scan job is outstanding. Never retrievable. */
  | 'scanning'
  /** Cleared scanning. The only retrievable state. */
  | 'available'
  /** Failed scanning, or scanning was unavailable under a rejecting policy. */
  | 'quarantined'
  /** Soft-deleted (cascade from a soft entity delete, or retention). */
  | 'deleted'

export type ScanStatus = 'pending' | 'clean' | 'infected' | 'unavailable' | 'skipped'

/** Where a file hangs off the client's data model, for cascade deletion. */
export interface EntityAttachment {
  readonly entity: string
  readonly id: string
}

export interface FileRecord {
  readonly id: string
  filename: string
  contentType: string
  sizeBytes: number
  ownerId: string | null
  /** SHA-256 of the stored bytes, hex. Null until the bytes are observed. */
  checksum: string | null
  storageKey: string
  status: FileStatus
  scanStatus: ScanStatus
  scanner: string | null
  quarantineReason: string | null
  attachedToEntity: string | null
  attachedToId: string | null
  createdAt: Date
  updatedAt: Date
}

export interface FileVersionRecord {
  readonly id: string
  fileId: string
  version: number
  storageKey: string
  sizeBytes: number
  checksum: string | null
  createdAt: Date
}

export interface UploadSessionRecord {
  readonly id: string
  fileId: string
  storageKey: string
  method: 'PUT' | 'POST'
  url: string
  contentType: string
  maxSizeBytes: number
  ownerId: string | null
  expiresAt: Date
  completedAt: Date | null
  createdAt: Date
}

export interface ThumbnailRecord {
  readonly id: string
  fileId: string
  kind: string
  storageKey: string
  width: number | null
  height: number | null
  createdAt: Date
}

/** What a caller asks for when they want to upload something. */
export interface UploadInput {
  filename: string
  contentType: string
  sizeBytes: number
  /** Defaults to `currentUser()`. */
  ownerId?: string
  attachedTo?: EntityAttachment
  /** Seconds the signed upload grant stays valid. Defaults to config. */
  ttlSeconds?: number
}

/**
 * A signed direct-to-storage grant. The caller PUTs the bytes at `url`; they never
 * pass through the application.
 */
export interface UploadSession {
  readonly id: string
  readonly fileId: string
  readonly url: string
  readonly method: 'PUT' | 'POST'
  readonly headers: Readonly<Record<string, string>>
  readonly expiresAt: Date
  readonly maxSizeBytes: number
}

/** Server-side ingest: bytes the application itself produced (a rendered PDF, say). */
export interface ServerFileInput {
  filename: string
  contentType: string
  bytes: Uint8Array
  ownerId?: string
  attachedTo?: EntityAttachment
  /**
   * Storage key to write to. Supplying a stable key makes ingest idempotent, which
   * is what lets `docs.generation` re-store a byte-identical reissue without
   * accumulating objects.
   */
  storageKey?: string
}

export const FILE_ENTITIES = {
  file: 'File',
  fileVersion: 'FileVersion',
  uploadSession: 'UploadSession',
  thumbnail: 'Thumbnail',
} as const

export type FileEntityName = (typeof FILE_ENTITIES)[keyof typeof FILE_ENTITIES]

export function fileId(ref: FileRef): string {
  return typeof ref === 'string' ? ref : ref.id
}
