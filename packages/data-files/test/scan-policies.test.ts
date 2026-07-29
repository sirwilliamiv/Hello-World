/**
 * Scan policy behaviour, and the ops.queue contract test:
 *   "the process restarts mid-scan → the scan job resumes and the file does not
 *    remain permanently quarantined."
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { completeUpload, serveLocalObject, signedUrl, upload } from '../src/index.js'
import { setupFiles, type Harness } from './harness.js'

let h!: Harness

afterEach(async () => {
  await h?.cleanup()
})

async function pending(content = 'payload'): Promise<string> {
  const bytes = new TextEncoder().encode(content)
  const session = await upload({
    filename: 'doc.txt',
    contentType: 'text/plain',
    sizeBytes: bytes.byteLength,
  })
  await serveLocalObject(
    new Request(session.url, { method: 'PUT', body: bytes as unknown as BodyInit }),
  )
  await completeUpload(session.id)
  return session.fileId
}

describe('scan policies', () => {
  it('require_clean: an unreachable scanner leaves the file quarantined and retries', async () => {
    h = await setupFiles({ scanPolicy: 'require_clean' })
    const id = await pending()
    h.scanner.available = false

    const errors = await h.queue.drainCatching()
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toMatch(/scanner/i)

    // Still not accessible, and nothing was published.
    await expect(signedUrl(id)).rejects.toMatchObject({ status: 404 })
    expect(h.events).toEqual([])

    // The job is still on the queue — this is why scanning needs a durable queue.
    expect(h.queue.jobs).toHaveLength(1)

    // The process restarts, the scanner comes back, the retry completes the work.
    h.scanner.available = true
    await h.queue.drain()

    const row = await h.repos.files.find(id)
    expect(row?.['status']).toBe('available')
    expect(h.events.map((e) => e.name)).toEqual(['file.scanned', 'file.uploaded'])
    await expect(signedUrl(id)).resolves.toContain('/api/files/_local')
  })

  it('reject_when_unavailable: no scanner means the file is rejected, not admitted', async () => {
    h = await setupFiles({ scanPolicy: 'reject_when_unavailable' })
    const id = await pending()
    h.scanner.available = false

    await h.queue.drain() // no throw: the policy is to reject, not to retry

    const row = await h.repos.files.find(id)
    expect(row?.['status']).toBe('quarantined')
    expect(row?.['quarantineReason']).toBe('scanner_unavailable')
    expect(h.events.map((e) => e.name)).toEqual(['file.quarantined'])
    await expect(signedUrl(id)).rejects.toMatchObject({ status: 404 })
  })

  it('skip: permitted on the local driver, and recorded as skipped rather than clean', async () => {
    h = await setupFiles({ scanPolicy: 'skip' })
    const id = await pending()
    await h.queue.drain()

    const row = await h.repos.files.find(id)
    expect(row?.['status']).toBe('available')
    expect(row?.['scanStatus']).toBe('skipped')
    expect(h.scanner.calls).toBe(0)
  })

  it('runs the processing pipeline after the scan clears and before file.uploaded', async () => {
    const seen: string[] = []
    h = await setupFiles({
      slots: {
        processingPipeline: async (ctx) => {
          seen.push(ctx.file.scanStatus)
          const key = await ctx.write('preview', new TextEncoder().encode('preview'), 'text/plain')
          return [{ kind: 'preview', storageKey: key }]
        },
      },
    })
    const id = await pending()
    await h.queue.drain()

    expect(seen).toEqual(['clean'])
    expect(h.events.map((e) => e.name)).toEqual(['file.scanned', 'file.processed', 'file.uploaded'])
    expect(h.repos.thumbnails.all()).toHaveLength(1)
    expect(await h.repos.files.find(id)).toMatchObject({ status: 'available' })
  })
})
