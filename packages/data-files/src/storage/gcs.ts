/**
 * Google Cloud Storage — the Phase 4 cloud target.
 *
 * A deliberately thin adapter: it signs V4 URLs with the service account key (pure
 * `node:crypto`, no SDK, no network) and performs object operations by issuing the
 * signed request itself. That keeps one code path for "how does a URL get signed"
 * instead of two, and it means the driver has no dependency to install.
 *
 * Not implemented here, and called out in the report: resumable uploads, customer
 * -managed encryption keys, and object versioning. A Phase 4 hardening pass wants
 * `@google-cloud/storage` for those.
 */
import { createSign } from 'node:crypto'
import { FilesConfigError } from '../errors.js'
import type {
  DownloadUrlOptions,
  ObjectHead,
  SignedUploadRequest,
  StorageDriver,
  UploadUrlOptions,
} from './driver.js'
import { assertSafeKey } from './signing.js'

const HOST = 'storage.googleapis.com'

interface ServiceAccount {
  readonly client_email: string
  readonly private_key: string
}

export interface GcsDriverOptions {
  bucket: string
  /** Service account JSON (`STORAGE_CREDENTIALS`). */
  credentials: string
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch | undefined
  /** Injectable for tests; defaults to the wall clock. */
  now?: (() => Date) | undefined
}

function parseServiceAccount(credentials: string): ServiceAccount {
  let parsed: unknown
  try {
    parsed = JSON.parse(credentials)
  } catch {
    throw new FilesConfigError(
      'data.files: the gcs driver needs STORAGE_CREDENTIALS to be service account JSON.',
    )
  }
  const sa = parsed as Partial<ServiceAccount>
  if (typeof sa.client_email !== 'string' || typeof sa.private_key !== 'string') {
    throw new FilesConfigError(
      'data.files: STORAGE_CREDENTIALS is missing client_email or private_key. ' +
        'Point the secret at the full service account key JSON.',
    )
  }
  return { client_email: sa.client_email, private_key: sa.private_key }
}

function hex(bytes: Buffer): string {
  return bytes.toString('hex')
}

async function sha256Hex(input: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/** RFC 3986 encoding, with `/` preserved inside the object path. */
function encodePath(key: string): string {
  return key
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/')
}

function stamps(now: Date): { iso: string; date: string } {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  return { iso, date: iso.slice(0, 8) }
}

export class GcsStorageDriver implements StorageDriver {
  readonly name = 'gcs' as const
  private readonly bucket: string
  private readonly account: ServiceAccount
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date

  constructor(opts: GcsDriverOptions) {
    this.bucket = opts.bucket
    this.account = parseServiceAccount(opts.credentials)
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
    this.now = opts.now ?? (() => new Date())
  }

  /**
   * V4 signing. The whole point of the exercise is `X-Goog-Expires`: GCS refuses the
   * request itself once the TTL passes, so expiry does not depend on our code.
   */
  private async signV4(
    method: 'GET' | 'PUT' | 'DELETE' | 'HEAD',
    key: string,
    ttlSeconds: number,
    extraQuery: Readonly<Record<string, string>> = {},
  ): Promise<string> {
    assertSafeKey(key)
    if (ttlSeconds <= 0 || ttlSeconds > 604800) {
      throw new FilesConfigError('data.files: a signed URL TTL must be 1s..7d.')
    }
    const now = this.now()
    const { iso, date } = stamps(now)
    const scope = `${date}/auto/storage/goog4_request`
    const canonicalPath = `/${this.bucket}/${encodePath(key)}`

    const query: Record<string, string> = {
      ...extraQuery,
      'X-Goog-Algorithm': 'GOOG4-RSA-SHA256',
      'X-Goog-Credential': `${this.account.client_email}/${scope}`,
      'X-Goog-Date': iso,
      'X-Goog-Expires': String(ttlSeconds),
      'X-Goog-SignedHeaders': 'host',
    }
    const canonicalQuery = Object.keys(query)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k] as string)}`)
      .join('&')

    const canonicalRequest = [
      method,
      canonicalPath,
      canonicalQuery,
      `host:${HOST}`,
      '',
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n')

    const stringToSign = [
      'GOOG4-RSA-SHA256',
      iso,
      scope,
      await sha256Hex(canonicalRequest),
    ].join('\n')

    const signer = createSign('RSA-SHA256')
    signer.update(stringToSign)
    const signature = hex(signer.sign(this.account.private_key))

    return `https://${HOST}${canonicalPath}?${canonicalQuery}&X-Goog-Signature=${signature}`
  }

  async signedUploadUrl(key: string, opts: UploadUrlOptions): Promise<SignedUploadRequest> {
    const url = await this.signV4('PUT', key, opts.ttlSeconds)
    return {
      url,
      method: 'PUT',
      headers: {
        'content-type': opts.contentType,
        // Advisory: GCS enforces size through the bucket's policy, the application
        // re-checks the object's real size before the file leaves `awaiting_upload`.
        'x-goog-content-length-range': `0,${opts.maxSizeBytes}`,
      },
      expiresAt: new Date(this.now().getTime() + opts.ttlSeconds * 1000),
    }
  }

  async signedDownloadUrl(key: string, opts: DownloadUrlOptions): Promise<string> {
    const extra: Record<string, string> =
      opts.filename === undefined
        ? {}
        : { 'response-content-disposition': `attachment; filename="${opts.filename}"` }
    return this.signV4('GET', key, opts.ttlSeconds, extra)
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const url = await this.signV4('PUT', key, 300)
    const res = await this.fetchImpl(url, {
      method: 'PUT',
      body: bytes as unknown as BodyInit,
      headers: { 'content-type': contentType },
    })
    if (!res.ok) throw new Error(`GCS put failed for ${key}: ${res.status}`)
  }

  async get(key: string): Promise<Uint8Array | null> {
    const res = await this.fetchImpl(await this.signV4('GET', key, 300))
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`GCS get failed for ${key}: ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  async head(key: string): Promise<ObjectHead | null> {
    const res = await this.fetchImpl(await this.signV4('HEAD', key, 300), { method: 'HEAD' })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`GCS head failed for ${key}: ${res.status}`)
    return { sizeBytes: Number(res.headers.get('content-length') ?? '0') }
  }

  async delete(key: string): Promise<boolean> {
    const res = await this.fetchImpl(await this.signV4('DELETE', key, 300), { method: 'DELETE' })
    if (res.status === 404) return false
    if (!res.ok && res.status !== 204) throw new Error(`GCS delete failed for ${key}: ${res.status}`)
    return true
  }

  async list(prefix: string): Promise<string[]> {
    // Listing needs the JSON API rather than an object-scoped signed URL, which needs
    // an OAuth token. Cascade deletion drives object removal from the File rows, so
    // nothing in the runtime path depends on this; it exists for the orphan audit.
    throw new FilesConfigError(
      `data.files: the gcs driver does not implement list('${prefix}'). ` +
        'Run the orphan audit against the local driver, or add @google-cloud/storage.',
    )
  }
}
