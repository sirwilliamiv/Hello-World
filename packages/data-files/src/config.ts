/**
 * Configuration binding. `src/generated/data.files/config.ts` calls `configureFiles`
 * once at boot with values the manifest resolved; everything else in the package
 * reads the result through `files()`.
 */
import { z } from 'zod'
import { FilesConfigError } from './errors.js'
import type { FilesSlotsInput } from './slots.js'
import type { DriverName, StorageDriver } from './storage/driver.js'
import { createDriver } from './storage/index.js'
import type { VirusScanner } from './scanning.js'
import type { FilesRuntime } from './ports.js'

export type { DriverName }
export type ScanPolicy = 'require_clean' | 'reject_when_unavailable' | 'skip'

/** Exactly the shape `templates/data.files/config.ts.tmpl` renders, plus test seams. */
export interface FilesConfigInput {
  driver: DriverName
  /** Bucket or container name for this environment (`STORAGE_BUCKET`). */
  bucket: string
  /** Service account JSON or access key (`STORAGE_CREDENTIALS`). Never logged. */
  credentials: string
  maxSizeBytes: number
  allowedContentTypes: readonly string[]
  scanPolicy: ScanPolicy
  slots?: FilesSlotsInput | undefined

  // ── Not rendered by the template; defaults are right for the generated product ──
  /** Filesystem root for the `local` driver. Default `.forge/files`. */
  localRoot?: string | undefined
  /** Origin the `local` driver's signed URLs are rooted at. Default `''` (relative). */
  publicBaseUrl?: string | undefined
  /** Default TTL for download URLs. Default 300s. Signed URLs always expire. */
  signedUrlTtlSeconds?: number | undefined
  /** Default TTL for upload grants. Default 900s. */
  uploadTtlSeconds?: number | undefined
  /** Key prefix inside the bucket. Default `files`. */
  keyPrefix?: string | undefined
  /** Injected scanner. Defaults to an HTTP scanner reading `SCANNER_ENDPOINT`. */
  scanner?: VirusScanner | undefined
  /** Injected storage driver, for tests. Defaults to `driver`. */
  storage?: StorageDriver | undefined
  /** Injected kernel ports, for tests. Defaults to the real `@forge/*` packages. */
  runtime?: FilesRuntime | undefined
}

const inputSchema = z.object({
  driver: z.enum(['local', 'gcs']),
  bucket: z.string().min(1, 'STORAGE_BUCKET must be set'),
  credentials: z.string(),
  maxSizeBytes: z.number().int().positive(),
  allowedContentTypes: z.array(z.string().min(1)).readonly(),
  scanPolicy: z.enum(['require_clean', 'reject_when_unavailable', 'skip']),
})

export interface FilesConfig {
  readonly driverName: DriverName
  readonly bucket: string
  readonly maxSizeBytes: number
  readonly allowedContentTypes: readonly string[]
  readonly scanPolicy: ScanPolicy
  readonly slots: FilesSlotsInput
  readonly signedUrlTtlSeconds: number
  readonly uploadTtlSeconds: number
  readonly keyPrefix: string
  readonly storage: StorageDriver
  readonly scanner: VirusScanner | undefined
  readonly runtime: FilesRuntime | undefined
}

let active: FilesConfig | null = null

export function configureFiles(input: FilesConfigInput): FilesConfig {
  const parsed = inputSchema.safeParse(input)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    throw new FilesConfigError(`Invalid data.files configuration — ${detail}`)
  }

  // The catalog states this as a validation error rather than a warning: skipping the
  // scan is a local-workspace affordance and must never reach a cloud environment.
  if (input.scanPolicy === 'skip' && input.driver !== 'local') {
    throw new FilesConfigError(
      "data.files: scan_policy 'skip' is permitted only with the 'local' driver. " +
        "Set scan_policy to 'require_clean' (or 'reject_when_unavailable' if no " +
        'scanner is deployed) in the capability config.',
    )
  }

  const storage =
    input.storage ??
    createDriver({
      driver: input.driver,
      bucket: input.bucket,
      credentials: input.credentials,
      ...(input.localRoot === undefined ? {} : { localRoot: input.localRoot }),
      ...(input.publicBaseUrl === undefined ? {} : { publicBaseUrl: input.publicBaseUrl }),
    })

  active = {
    driverName: input.driver,
    bucket: input.bucket,
    maxSizeBytes: input.maxSizeBytes,
    allowedContentTypes: [...input.allowedContentTypes],
    scanPolicy: input.scanPolicy,
    slots: input.slots ?? {},
    signedUrlTtlSeconds: input.signedUrlTtlSeconds ?? 300,
    uploadTtlSeconds: input.uploadTtlSeconds ?? 900,
    keyPrefix: input.keyPrefix ?? 'files',
    storage,
    scanner: input.scanner,
    runtime: input.runtime,
  }
  return active
}

/** The active configuration. Throws rather than guessing if boot never ran. */
export function files(): FilesConfig {
  if (active === null) {
    throw new FilesConfigError(
      'data.files is not configured. The generated product imports ' +
        "'@/generated/data.files/config' at boot; a test must call configureFiles() itself.",
    )
  }
  return active
}

/** Test seam. Not part of the capability's exposed interface. */
export function resetFilesConfig(): void {
  active = null
}
