/**
 * The retention sweep: abandoned grants are reaped, and the client's retention slot
 * decides everything else.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runRetentionSweep, serveLocalObject, upload, completeUpload } from '../src/index.js'
import { setupFiles, type Harness } from './harness.js'

let h!: Harness

beforeEach(async () => {
  h = await setupFiles({ uploadTtlSeconds: 60 })
})
afterEach(async () => {
  await h.cleanup()
})

describe('retention sweep', () => {
  it('reaps an expired grant and anything that was half-uploaded under it', async () => {
    const bytes = new TextEncoder().encode('abandoned')
    const session = await upload({
      filename: 'abandoned.txt',
      contentType: 'text/plain',
      sizeBytes: bytes.byteLength,
    })
    await serveLocalObject(
      new Request(session.url, { method: 'PUT', body: bytes as unknown as BodyInit }),
    )
    // The client never confirms. An hour later:
    const later = new Date(Date.now() + 3_600_000)

    const result = await runRetentionSweep({ now: later.toISOString() })
    expect(result.sessionsReaped).toBe(1)
    expect(await h.repos.files.find(session.fileId)).toBeNull()
    expect(await h.storage.list('files/')).toHaveLength(0)
  })

  it('leaves a confirmed upload alone', async () => {
    const bytes = new TextEncoder().encode('kept')
    const session = await upload({
      filename: 'kept.txt',
      contentType: 'text/plain',
      sizeBytes: bytes.byteLength,
    })
    await serveLocalObject(
      new Request(session.url, { method: 'PUT', body: bytes as unknown as BodyInit }),
    )
    await completeUpload(session.id)
    await h.queue.drain()

    const result = await runRetentionSweep({ now: new Date(Date.now() + 3_600_000).toISOString() })
    expect(result.sessionsReaped).toBe(0)
    expect(await h.repos.files.find(session.fileId)).not.toBeNull()
  })

  it('deletes nothing on its own until the retentionRules slot says so', async () => {
    h.cleanup()
    h = await setupFiles({
      slots: {
        retentionRules: (ctx) =>
          ctx.ageDays > 30 ? { action: 'delete', reason: 'older_than_30_days' } : { action: 'keep' },
      },
    })
    const bytes = new TextEncoder().encode('old')
    const session = await upload({
      filename: 'old.txt',
      contentType: 'text/plain',
      sizeBytes: bytes.byteLength,
    })
    await serveLocalObject(
      new Request(session.url, { method: 'PUT', body: bytes as unknown as BodyInit }),
    )
    await completeUpload(session.id)
    await h.queue.drain()

    expect((await runRetentionSweep()).deleted).toBe(0)

    const inSixWeeks = new Date(Date.now() + 42 * 86_400_000).toISOString()
    expect((await runRetentionSweep({ now: inSixWeeks })).deleted).toBe(1)
    expect(await h.storage.list('files/')).toHaveLength(0)
    expect(h.events.some((e) => e.name === 'file.deleted')).toBe(true)
  })
})
