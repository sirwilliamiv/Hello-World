/**
 * tests.smoke: "unscanned files are inaccessible" —
 * a file awaiting scan returns 404 rather than 200 from a signed URL.
 *
 * The 404 matters as much as the inaccessibility: a 403 would confirm to a caller
 * that the object exists.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  completeUpload,
  FileNotAccessibleError,
  filesRouteHandler,
  serveLocalObject,
  signedUrl,
  upload,
} from '../src/index.js'
import { BASE_URL, setupFiles, type Harness } from './harness.js'

let h!: Harness

beforeEach(async () => {
  h = await setupFiles()
})
afterEach(async () => {
  await h.cleanup()
})

async function uploadPending(content = 'not yet scanned'): Promise<{ fileId: string; key: string }> {
  const bytes = new TextEncoder().encode(content)
  const session = await upload({
    filename: 'pending.txt',
    contentType: 'text/plain',
    sizeBytes: bytes.byteLength,
  })
  await serveLocalObject(
    new Request(session.url, { method: 'PUT', body: bytes as unknown as BodyInit }),
  )
  await completeUpload(session.id)
  const row = await h.repos.files.find(session.fileId)
  return { fileId: session.fileId, key: String(row?.['storageKey']) }
}

describe('unscanned files are inaccessible', () => {
  it('refuses to mint a signed URL for a file awaiting scan', async () => {
    const { fileId } = await uploadPending()
    await expect(signedUrl(fileId)).rejects.toBeInstanceOf(FileNotAccessibleError)
    await expect(signedUrl(fileId)).rejects.toMatchObject({ status: 404, code: 'file_not_found' })
  })

  it('answers 404 — not 403, not 200 — on the file route', async () => {
    const { fileId } = await uploadPending()
    const res = await filesRouteHandler(new Request(`${BASE_URL}/api/files/${fileId}`))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'file_not_found', message: expect.any(String) })
  })

  it('is indistinguishable from a file that never existed', async () => {
    const { fileId } = await uploadPending()
    const pending = await filesRouteHandler(new Request(`${BASE_URL}/api/files/${fileId}`))
    const absent = await filesRouteHandler(
      new Request(`${BASE_URL}/api/files/00000000-0000-4000-8000-000000000000`),
    )
    expect(pending.status).toBe(absent.status)
    expect((await pending.json()).error).toBe((await absent.json()).error)
  })

  it('rejects a validly signed object URL while the file is unscanned', async () => {
    // Storage would happily serve this: the signature is genuine. The scan status is
    // re-checked at serve time, so a URL obtained before quarantine stops working.
    const { key } = await uploadPending()
    const url = await h.storage.signedDownloadUrl(key, { ttlSeconds: 300 })
    const res = await serveLocalObject(new Request(url))
    expect(res.status).toBe(404)
  })

  it('keeps a quarantined file inaccessible after an infected scan', async () => {
    const { fileId } = await uploadPending('this payload is INFECTED')
    await h.queue.drain()

    const row = await h.repos.files.find(fileId)
    expect(row?.['status']).toBe('quarantined')
    expect(row?.['scanStatus']).toBe('infected')

    await expect(signedUrl(fileId)).rejects.toMatchObject({ status: 404 })
    expect(h.events.map((e) => e.name)).toEqual(['file.scanned', 'file.quarantined'])
    // The crucial absence: no consumer was ever told about this file.
    expect(h.events.some((e) => e.name === 'file.uploaded')).toBe(false)
  })

  it('does not list unscanned files', async () => {
    await uploadPending()
    const res = await filesRouteHandler(new Request(`${BASE_URL}/api/files`))
    expect(await res.json()).toEqual([])
  })
})
