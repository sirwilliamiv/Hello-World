/**
 * The storage seam. Two implementations ship: `local` (filesystem, for the local
 * workspace provider) and `gcs` (the Phase 4 cloud target).
 *
 * Every URL this interface hands out is signed and carries an expiry. There is no
 * method that returns an unsigned, non-expiring URL, because the moment one exists
 * it ends up in an email.
 */
export type DriverName = 'local' | 'gcs'

export interface SignedUploadRequest {
  readonly url: string
  readonly method: 'PUT' | 'POST'
  readonly headers: Readonly<Record<string, string>>
  readonly expiresAt: Date
}

export interface UploadUrlOptions {
  readonly contentType: string
  readonly ttlSeconds: number
  readonly maxSizeBytes: number
}

export interface DownloadUrlOptions {
  readonly ttlSeconds: number
  /** Suggested download filename, sent as a content-disposition. */
  readonly filename?: string
}

export interface ObjectHead {
  readonly sizeBytes: number
}

export interface StorageDriver {
  readonly name: DriverName

  /** A grant the browser PUTs bytes to. File bytes never pass through the app. */
  signedUploadUrl(key: string, opts: UploadUrlOptions): Promise<SignedUploadRequest>

  /** A time-limited read URL. */
  signedDownloadUrl(key: string, opts: DownloadUrlOptions): Promise<string>

  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>
  get(key: string): Promise<Uint8Array | null>
  head(key: string): Promise<ObjectHead | null>

  /** Returns true if an object was removed, false if there was nothing there. */
  delete(key: string): Promise<boolean>

  /** Every object under a prefix — used to prove cascade delete left no orphans. */
  list(prefix: string): Promise<string[]>
}
