/**
 * @forge/data-files — Files and Photos (data.files@1.0.0)
 *
 * Two properties this package exists to hold:
 *
 *   1. An unscanned file is never accessible. An upload is quarantined until a
 *      scanner clears it, `file.uploaded` is published only on that transition, and
 *      every read path funnels through one gate (`requireAccessibleFile`) that a
 *      non-`available` file cannot pass. A file awaiting scan is a 404, not a 403.
 *   2. Bytes never pass through the application. Uploads go direct to storage under
 *      a signed grant, downloads come back through a signed URL, and every signed
 *      URL expires.
 */

// The exposed interfaces, in the order the specification lists them.
export { upload, completeUpload, storeServerFile } from './uploads.js'
export { signedUrl, getFile, requireAccessibleFile, isAccessible, filesFor, filesOwnedBy } from './access.js'
export { FileUploader, type FileUploaderProps } from './components/FileUploader.js'
export { FileBrowser, type FileBrowserProps, type BrowsableFile } from './components/FileBrowser.js'
export { filesRouteHandler, serveLocalObject, GET, POST, DELETE } from './routes.js'

// Configuration binding, called by src/generated/data.files/config.ts.
export {
  configureFiles,
  files,
  resetFilesConfig,
  type FilesConfig,
  type FilesConfigInput,
  type DriverName,
  type ScanPolicy,
} from './config.js'

// Declared event handler for `consumes: entity.deleted`.
export { cascadeDelete, deleteFile, type EntityDeletedEvent, type DeleteFileOptions } from './cascade.js'

// Declared privacy handlers for the File entity.
export { exportFiles, deleteFilesAndObjects, type ExportedFile } from './privacy.js'

// Durable work.
export { FILE_JOBS, type JobHandler } from './jobs.js'
export {
  runScanJob,
  resolveScanner,
  HttpVirusScanner,
  SCAN_JOB_KIND,
  RETENTION_JOB_KIND,
  type ScanRequest,
  type ScanResult,
  type VirusScanner,
} from './scanning.js'
export { runRetentionSweep, scheduleRetentionSweep, type RetentionSweepResult } from './retention.js'

// Slot types. A client's slot file imports these; a signature change in a major
// version breaks their compile, which is the intended failure mode.
export type {
  AllowedTypesSlot,
  AllowedTypesContext,
  AllowedTypesDecision,
  AllowedTypesResult,
  SizeLimitsSlot,
  SizeLimitsContext,
  SizeLimitsDecision,
  SizeLimitsResult,
  ProcessingPipelineSlot,
  ProcessingContext,
  ProcessingOutput,
  RetentionRulesSlot,
  RetentionContext,
  RetentionDecision,
  FilesSlots,
  FilesSlotsInput,
} from './slots.js'

// Storage seam and schema, for the migration runner and for tests.
export { createDriver, LocalStorageDriver, GcsStorageDriver, LOCAL_OBJECT_PATH } from './storage/index.js'
export type { StorageDriver, SignedUploadRequest } from './storage/driver.js'
export { originalKey, derivedKey, filePrefix } from './keys.js'
export { dataFilesSchema, filesTable, fileVersionsTable, uploadSessionsTable, thumbnailsTable } from './schema.js'

// Domain types.
export {
  FILE_ENTITIES,
  fileId,
  type FileRecord,
  type FileRef,
  type FileStatus,
  type ScanStatus,
  type FileVersionRecord,
  type UploadSessionRecord,
  type ThumbnailRecord,
  type UploadInput,
  type UploadSession,
  type ServerFileInput,
  type EntityAttachment,
} from './types.js'

export {
  FilesError,
  FileNotFoundError,
  FileNotAccessibleError,
  UploadRejectedError,
  SignatureExpiredError,
  SignatureInvalidError,
  ScannerUnavailableError,
  FilesConfigError,
} from './errors.js'

export type { FilesRuntime, RepositoryLike, JobSpecLike } from './ports.js'
