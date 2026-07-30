/**
 * tests.smoke: "signed URLs expire" —
 * a signed URL past its TTL is rejected by storage.
 *
 * "By storage" is the point: the local driver's `verify` stands where GCS's own
 * signature check stands, so expiry is enforced at the object, not by the caller
 * remembering to check.
 */
import { generateKeyPairSync } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  completeUpload,
  GcsStorageDriver,
  serveLocalObject,
  SignatureExpiredError,
  SignatureInvalidError,
  signedUrl,
  upload,
} from '../src/index.js'
import { setupFiles, type Harness } from './harness.js'

let h!: Harness

beforeEach(async () => {
  h = await setupFiles()
})
afterEach(async () => {
  await h.cleanup()
})

async function availableFile(): Promise<string> {
  const bytes = new TextEncoder().encode('retrievable')
  const session = await upload({
    filename: 'ok.txt',
    contentType: 'text/plain',
    sizeBytes: bytes.byteLength,
  })
  await serveLocalObject(
    new Request(session.url, { method: 'PUT', body: bytes as unknown as BodyInit }),
  )
  await completeUpload(session.id)
  await h.queue.drain()
  return session.fileId
}

describe('signed URLs expire', () => {
  it('rejects a download URL once its TTL has passed', async () => {
    const fileId = await availableFile()
    const url = await signedUrl(fileId, 60)

    const params = new URL(url).searchParams
    expect(h.storage.verify(params)).toMatchObject({ method: 'GET' })

    const afterExpiry = new Date(Date.now() + 61_000)
    expect(() => h.storage.verify(params, afterExpiry)).toThrow(SignatureExpiredError)

    const res = await serveLocalObject(new Request(url), afterExpiry)
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('signature_expired')
  })

  it('rejects an upload grant once its TTL has passed', async () => {
    const grant = await h.storage.signedUploadUrl('files/x/original/x.txt', {
      contentType: 'text/plain',
      ttlSeconds: 30,
      maxSizeBytes: 100,
    })
    const params = new URL(grant.url).searchParams
    expect(() => h.storage.verify(params, new Date(Date.now() + 31_000))).toThrow(
      SignatureExpiredError,
    )
  })

  it('rejects a URL whose expiry was edited', async () => {
    const fileId = await availableFile()
    const url = new URL(await signedUrl(fileId, 60))
    url.searchParams.set('expires', String(Math.floor(Date.now() / 1000) + 86_400))
    expect(() => h.storage.verify(url.searchParams)).toThrow(SignatureInvalidError)
  })

  it('rejects a URL whose key was swapped for another object', async () => {
    const fileId = await availableFile()
    const url = new URL(await signedUrl(fileId, 60))
    url.searchParams.set('key', 'files/someone-else/original/secret.pdf')
    expect(() => h.storage.verify(url.searchParams)).toThrow(SignatureInvalidError)
  })

  it('never issues a URL without an expiry (gcs)', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const credentials = JSON.stringify({
      client_email: 'files@acme.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    })
    const gcs = new GcsStorageDriver({ bucket: 'acme-files', credentials })

    const url = new URL(await gcs.signedDownloadUrl('files/a/original/a.pdf', { ttlSeconds: 120 }))
    expect(url.host).toBe('storage.googleapis.com')
    expect(url.pathname).toBe('/acme-files/files/a/original/a.pdf')
    expect(url.searchParams.get('X-Goog-Algorithm')).toBe('GOOG4-RSA-SHA256')
    expect(url.searchParams.get('X-Goog-Expires')).toBe('120')
    expect(url.searchParams.get('X-Goog-Signature')).toMatch(/^[0-9a-f]+$/)

    // Signing is deterministic given the same clock, and changes with the object.
    const other = new URL(await gcs.signedDownloadUrl('files/b/original/b.pdf', { ttlSeconds: 120 }))
    expect(other.searchParams.get('X-Goog-Signature')).not.toBe(
      url.searchParams.get('X-Goog-Signature'),
    )

    await expect(
      gcs.signedDownloadUrl('files/a/original/a.pdf', { ttlSeconds: 60 * 60 * 24 * 8 }),
    ).rejects.toThrow(/1s\.\.7d/)
  })
})
