/**
 * Mandatory contract test with kernel.data:
 *   "an entity holding attached files is deleted → every attached file row AND its
 *    stored object are removed, leaving no orphaned objects."
 *
 * The orphan check is done by listing the bucket, not by trusting the delete calls.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cascadeDelete, completeUpload, deleteFile, serveLocalObject, upload } from '../src/index.js'
import { setupFiles, type Harness } from './harness.js'

let h!: Harness

beforeEach(async () => {
  h = await setupFiles({
    slots: {
      // A derived object as well, so the cascade has more than the original to find.
      processingPipeline: async (ctx) => {
        const key = await ctx.write('thumb', new TextEncoder().encode('thumb bytes'), 'image/png')
        return [{ kind: 'thumb', storageKey: key, width: 64, height: 64 }]
      },
    },
  })
})
afterEach(async () => {
  await h.cleanup()
})

async function attachedFile(entity: string, id: string, name: string): Promise<string> {
  const bytes = new TextEncoder().encode(`contents of ${name}`)
  const session = await upload({
    filename: name,
    contentType: 'text/plain',
    sizeBytes: bytes.byteLength,
    attachedTo: { entity, id },
  })
  await serveLocalObject(
    new Request(session.url, { method: 'PUT', body: bytes as unknown as BodyInit }),
  )
  await completeUpload(session.id)
  await h.queue.drain()
  return session.fileId
}

describe('cascade delete leaves no orphaned objects', () => {
  it('removes every attached row and object when the owning entity is deleted', async () => {
    const a = await attachedFile('WorkOrder', 'wo-1', 'before.txt')
    const b = await attachedFile('WorkOrder', 'wo-1', 'after.txt')
    const unrelated = await attachedFile('WorkOrder', 'wo-2', 'other.txt')

    expect((await h.storage.list('files/')).length).toBe(6) // 3 originals + 3 thumbs

    await cascadeDelete({
      name: 'entity.deleted',
      payload: { entity: 'WorkOrder', id: 'wo-1', actor: 'user-1', soft: false },
    })

    // Rows are gone — hard delete, not a flag, because a retained row pointing at a
    // deleted object is a broken export.
    expect(await h.repos.files.find(a)).toBeNull()
    expect(await h.repos.files.find(b)).toBeNull()
    expect(h.repos.files.all().map((r) => r['id'])).toEqual([unrelated])
    expect(h.repos.versions.all()).toHaveLength(1)
    expect(h.repos.thumbnails.all()).toHaveLength(1)
    expect(h.repos.sessions.all()).toHaveLength(1)

    // Objects are gone too, and only the untouched entity's objects remain.
    const remaining = await h.storage.list('files/')
    expect(remaining).toHaveLength(2)
    expect(remaining.every((key) => key.includes(unrelated))).toBe(true)

    const deletions = h.events.filter((e) => e.name === 'file.deleted')
    expect(deletions).toHaveLength(2)
    expect(deletions[0]?.payload).toMatchObject({ cascade_source: 'WorkOrder:wo-1' })
  })

  it('keeps objects for a soft delete, because a soft delete is reversible', async () => {
    const id = await attachedFile('WorkOrder', 'wo-3', 'soft.txt')
    await cascadeDelete({
      name: 'entity.deleted',
      payload: { entity: 'WorkOrder', id: 'wo-3', actor: null, soft: true },
    })

    expect(await h.repos.files.find(id)).toBeNull() // hidden from reads
    expect(h.repos.files.all()).toHaveLength(1) // but the row is still there
    expect(await h.storage.list('files/')).toHaveLength(2) // objects retained
  })

  it('is idempotent, so a replayed cascade job is harmless', async () => {
    await attachedFile('WorkOrder', 'wo-4', 'twice.txt')
    const event = {
      name: 'entity.deleted',
      payload: { entity: 'WorkOrder', id: 'wo-4', actor: null, soft: false },
    }
    await cascadeDelete(event)
    await cascadeDelete(event)
    expect(await h.storage.list('files/')).toHaveLength(0)
    expect(h.events.filter((e) => e.name === 'file.deleted')).toHaveLength(1)
  })

  it('ignores entity.deleted for its own File rows so the cascade cannot loop', async () => {
    const id = await attachedFile('WorkOrder', 'wo-5', 'self.txt')
    await cascadeDelete({ name: 'entity.deleted', payload: { entity: 'File', id, soft: false } })
    expect(await h.repos.files.find(id)).not.toBeNull()
  })

  it('removes a file and its objects on a direct delete', async () => {
    const id = await attachedFile('WorkOrder', 'wo-6', 'direct.txt')
    await deleteFile(id, { cascadeSource: 'api' })
    expect(await h.repos.files.find(id)).toBeNull()
    expect(await h.storage.list('files/')).toHaveLength(0)
  })
})
