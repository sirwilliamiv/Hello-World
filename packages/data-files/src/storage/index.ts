import type { DriverName, StorageDriver } from './driver.js'
import { GcsStorageDriver } from './gcs.js'
import { LocalStorageDriver } from './local.js'

export interface CreateDriverOptions {
  driver: DriverName
  bucket: string
  credentials: string
  localRoot?: string | undefined
  publicBaseUrl?: string | undefined
}

export function createDriver(opts: CreateDriverOptions): StorageDriver {
  if (opts.driver === 'local') {
    return new LocalStorageDriver({
      // The bucket name doubles as the directory for the local driver, so two
      // workspaces on one machine do not share objects.
      root: opts.localRoot ?? `.forge/files/${opts.bucket}`,
      credentials: opts.credentials,
      publicBaseUrl: opts.publicBaseUrl,
    })
  }
  return new GcsStorageDriver({ bucket: opts.bucket, credentials: opts.credentials })
}

export { GcsStorageDriver, LocalStorageDriver }
export * from './driver.js'
export { LOCAL_OBJECT_PATH } from './local.js'
