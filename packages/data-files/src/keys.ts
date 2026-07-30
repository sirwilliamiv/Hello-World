import { safeFilename } from './storage/signing.js'

/**
 * Object keys are derived from the file id, never from user input alone, so a
 * filename can never determine where an object lands.
 *
 *   <prefix>/<fileId>/original/<safe filename>
 *   <prefix>/<fileId>/derived/<kind>/<safe filename>
 */
export function originalKey(prefix: string, id: string, filename: string): string {
  return `${prefix}/${id}/original/${safeFilename(filename)}`
}

export function derivedKey(prefix: string, id: string, kind: string, filename: string): string {
  return `${prefix}/${id}/derived/${safeFilename(kind)}/${safeFilename(filename)}`
}

/** Everything belonging to one file. Used by the orphan audit in the contract test. */
export function filePrefix(prefix: string, id: string): string {
  return `${prefix}/${id}/`
}
