/**
 * Filesystem driver for the local workspace provider.
 *
 * It is a real driver, not a stub: objects are files under a root directory, and
 * URLs are HMAC-signed with an expiry that `serveLocalObject` enforces. That
 * enforcement is what makes "signed URLs expire" and "an unscanned file is a 404"
 * testable without a cloud account.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { SignatureExpiredError, SignatureInvalidError } from '../errors.js'
import type {
  DownloadUrlOptions,
  ObjectHead,
  SignedUploadRequest,
  StorageDriver,
  UploadUrlOptions,
} from './driver.js'
import { assertSafeKey, canonicalString, constantTimeEquals, hmacHex } from './signing.js'

export const LOCAL_OBJECT_PATH = '/api/files/_local'

export interface LocalDriverOptions {
  /** Directory objects live under. */
  root: string
  /** Signing secret — the resolved `STORAGE_CREDENTIALS`. Never leaves this process. */
  credentials: string
  /** Origin signed URLs are rooted at. Empty means a same-origin relative URL. */
  publicBaseUrl?: string | undefined
}

export interface VerifiedSignedRequest {
  readonly key: string
  readonly method: 'GET' | 'PUT'
  readonly expiresAt: Date
  readonly maxSizeBytes: number
}

export class LocalStorageDriver implements StorageDriver {
  readonly name = 'local' as const
  private readonly root: string
  private readonly secret: string
  private readonly baseUrl: string

  constructor(opts: LocalDriverOptions) {
    this.root = resolve(opts.root)
    // A weak or empty credential would make the signature decorative. Derive a key
    // so a short development value still produces a full-strength HMAC key.
    this.secret = createHash('sha256')
      .update(`forge:data.files:local:${opts.credentials}`)
      .digest('hex')
    this.baseUrl = (opts.publicBaseUrl ?? '').replace(/\/$/, '')
  }

  // ── signing ───────────────────────────────────────────────────────────────────

  private sign(method: 'GET' | 'PUT', key: string, expires: number, maxSizeBytes: number): string {
    return hmacHex(this.secret, canonicalString([method, key, expires, maxSizeBytes]))
  }

  private url(
    method: 'GET' | 'PUT',
    key: string,
    expires: number,
    maxSizeBytes: number,
    filename?: string,
  ): string {
    const q = new URLSearchParams({
      key,
      method,
      expires: String(expires),
      max: String(maxSizeBytes),
      sig: this.sign(method, key, expires, maxSizeBytes),
    })
    if (filename !== undefined) q.set('filename', filename)
    return `${this.baseUrl}${LOCAL_OBJECT_PATH}?${q.toString()}`
  }

  async signedUploadUrl(key: string, opts: UploadUrlOptions): Promise<SignedUploadRequest> {
    assertSafeKey(key)
    const expires = Math.floor(Date.now() / 1000) + opts.ttlSeconds
    return {
      url: this.url('PUT', key, expires, opts.maxSizeBytes),
      method: 'PUT',
      headers: {
        'content-type': opts.contentType,
        'x-forge-max-bytes': String(opts.maxSizeBytes),
      },
      expiresAt: new Date(expires * 1000),
    }
  }

  async signedDownloadUrl(key: string, opts: DownloadUrlOptions): Promise<string> {
    assertSafeKey(key)
    const expires = Math.floor(Date.now() / 1000) + opts.ttlSeconds
    return this.url('GET', key, expires, 0, opts.filename)
  }

  /**
   * Storage-side enforcement. Called by the local object route before a byte moves.
   * `now` is a parameter rather than a read of the clock so the expiry path is
   * testable without sleeping.
   */
  verify(params: URLSearchParams, now: Date = new Date()): VerifiedSignedRequest {
    const key = params.get('key')
    const method = params.get('method')
    const expires = Number(params.get('expires'))
    const max = Number(params.get('max') ?? '0')
    const sig = params.get('sig')

    if (key === null || sig === null || (method !== 'GET' && method !== 'PUT')) {
      throw new SignatureInvalidError('Malformed signed URL')
    }
    if (!Number.isFinite(expires) || !Number.isFinite(max)) {
      throw new SignatureInvalidError('Malformed signed URL')
    }
    assertSafeKey(key)
    if (!constantTimeEquals(sig, this.sign(method, key, expires, max))) {
      throw new SignatureInvalidError('Signature does not match')
    }
    // Checked after the signature so an attacker cannot use the error to probe.
    if (Math.floor(now.getTime() / 1000) >= expires) {
      throw new SignatureExpiredError()
    }
    return { key, method, expiresAt: new Date(expires * 1000), maxSizeBytes: max }
  }

  // ── objects ───────────────────────────────────────────────────────────────────

  private pathFor(key: string): string {
    assertSafeKey(key)
    const path = resolve(join(this.root, key))
    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new SignatureInvalidError('Key escapes the storage root')
    }
    return path
  }

  async put(key: string, bytes: Uint8Array, _contentType: string): Promise<void> {
    const path = this.pathFor(key)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)))
    } catch {
      return null
    }
  }

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const s = await stat(this.pathFor(key))
      return { sizeBytes: s.size }
    } catch {
      return null
    }
  }

  async delete(key: string): Promise<boolean> {
    const path = this.pathFor(key)
    try {
      await stat(path)
    } catch {
      return false
    }
    await rm(path, { force: true })
    return true
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = []
    const walk = async (relative: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(join(this.root, relative), { withFileTypes: true })
      } catch {
        return
      }
      // Sorted so a listing is stable across filesystems.
      for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const child = relative === '' ? entry.name : `${relative}/${entry.name}`
        if (entry.isDirectory()) await walk(child)
        else if (child.startsWith(prefix)) out.push(child)
      }
    }
    await walk('')
    return out
  }
}
