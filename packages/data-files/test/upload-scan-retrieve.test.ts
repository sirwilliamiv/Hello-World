/**
 * tests.smoke: "upload, scan, and retrieve" —
 * a signed upload completes, is scanned, and is retrievable via a signed URL.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { completeUpload, serveLocalObject, signedUrl, upload } from '../src/index.js'
import { eventNames, setupFiles, type Harness } from './harness.js'

let h!: Harness

beforeEach(async () => {
  h = await setupFiles()
})
afterEach(async () => {
  await h.cleanup()
})

async function putBytes(url: string, bytes: Uint8Array, contentType: string): Promise<Response> {
  return serveLocalObject(
    new Request(url, {
      method: 'PUT',
      body: bytes as unknown as BodyInit,
      headers: { 'content-type': contentType },
    }),
  )
}

describe('upload, scan, and retrieve', () => {
  it('carries a file from signed grant to signed download', async () => {
    const bytes = new TextEncoder().encode('site photo bytes')

    // 1. The application issues a grant. It never sees the bytes.
    const session = await upload({
      filename: 'site.png',
      contentType: 'image/png',
      sizeBytes: bytes.byteLength,
    })
    expect(session.url).toContain('/api/files/_local')
    expect(session.method).toBe('PUT')
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now())

    // 2. The client PUTs straight to storage.
    expect((await putBytes(session.url, bytes, 'image/png')).status).toBe(200)

    // 3. Confirmation moves the file to `scanning` and queues the durable scan.
    const scanning = await completeUpload(session.id)
    expect(scanning.status).toBe('scanning')
    expect(h.queue.jobs).toHaveLength(1)
    expect(h.queue.jobs[0]?.kind).toBe('data.files:scan')

    // 4. The scan runs and only then does the file become retrievable.
    await h.queue.drain()
    expect(h.scanner.calls).toBe(1)

    const url = await signedUrl(session.fileId)
    const res = await serveLocalObject(new Request(url))
    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })

  it('publishes file.uploaded only after the scan has cleared, never before', async () => {
    const bytes = new TextEncoder().encode('a clean document')
    const session = await upload({
      filename: 'quote.pdf',
      contentType: 'application/pdf',
      sizeBytes: bytes.byteLength,
    })
    await putBytes(session.url, bytes, 'application/pdf')
    await completeUpload(session.id)

    // Bytes are in storage and the row exists — and still nothing is published.
    expect(eventNames(h.events)).toEqual([])

    await h.queue.drain()

    expect(eventNames(h.events)).toEqual(['file.scanned', 'file.uploaded'])
    const uploaded = h.events.find((e) => e.name === 'file.uploaded')
    expect(uploaded?.payload).toMatchObject({
      file_id: session.fileId,
      filename: 'quote.pdf',
      content_type: 'application/pdf',
      size_bytes: bytes.byteLength,
      owner_id: 'user-1',
    })
    // The checksum is of what storage actually holds, not of what was declared.
    expect(String(uploaded?.payload['checksum'])).toMatch(/^[0-9a-f]{64}$/)
  })

  it('records the size storage actually received, not the size the client declared', async () => {
    const bytes = new TextEncoder().encode('twelve bytes and then some more')
    const session = await upload({
      filename: 'notes.txt',
      contentType: 'text/plain',
      sizeBytes: 12, // a lie
    })
    await putBytes(session.url, bytes, 'text/plain')
    const file = await completeUpload(session.id)
    expect(file.sizeBytes).toBe(bytes.byteLength)
  })

  it('is idempotent when the confirmation is replayed', async () => {
    const bytes = new TextEncoder().encode('replayed')
    const session = await upload({
      filename: 'replay.txt',
      contentType: 'text/plain',
      sizeBytes: bytes.byteLength,
    })
    await putBytes(session.url, bytes, 'text/plain')
    await completeUpload(session.id)
    await completeUpload(session.id)
    expect(h.queue.jobs).toHaveLength(1)

    await h.queue.drain()
    // Replaying the scan job itself must not re-publish or re-run the pipeline.
    await h.queue.enqueue({ kind: 'data.files:scan', payload: { fileId: session.fileId } })
    await h.queue.drain()
    expect(eventNames(h.events)).toEqual(['file.scanned', 'file.uploaded'])
  })
})
