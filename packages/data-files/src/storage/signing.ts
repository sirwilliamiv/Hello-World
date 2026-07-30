import { createHmac, createHash, timingSafeEqual } from 'node:crypto'

/** Deterministic canonical string for a signed request. Order is fixed on purpose. */
export function canonicalString(parts: readonly (string | number)[]): string {
  return parts.map((p) => String(p)).join('\n')
}

export function hmacHex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex')
}

export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Object keys come from user-supplied filenames. Anything that could escape the
 * bucket prefix is rejected rather than sanitised — a silently rewritten key is a
 * file the delete path will later fail to find.
 */
export function assertSafeKey(key: string): void {
  if (key.length === 0 || key.length > 1024) {
    throw new Error(`Unusable storage key of length ${key.length}`)
  }
  if (key.startsWith('/') || key.includes('..') || key.includes('\\') || key.includes('\0')) {
    throw new Error(`Unsafe storage key: ${JSON.stringify(key)}`)
  }
}

/** Filenames are for humans; keys are derived, never trusted. */
export function safeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? 'file'
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '')
  return cleaned.length === 0 ? 'file' : cleaned.slice(0, 128)
}
