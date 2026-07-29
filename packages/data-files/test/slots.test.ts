/**
 * The slot contract: every context exposes `proceed()`, and `proceed()` returns
 * exactly what the capability does with no slot implemented
 * (schemas/capability.schema.json, `$defs.slot.signature`).
 *
 * Each slot is asserted twice: the seeded stub (`(ctx) => ctx.proceed()`) must be
 * indistinguishable from having no slot at all, and a slot that returns something
 * else must actually change the outcome. The first half is what makes Forge's seeded
 * stub safe to ship before a client has written anything; the second is what makes it
 * a slot rather than decoration.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  completeUpload,
  runRetentionSweep,
  serveLocalObject,
  signedUrl,
  upload,
  UploadRejectedError,
  type AllowedTypesSlot,
  type ProcessingPipelineSlot,
  type RetentionRulesSlot,
  type SizeLimitsSlot,
} from '../src/index.js'
import { setupFiles, type Harness } from './harness.js'

let h!: Harness

afterEach(async () => {
  await h?.cleanup()
})

/** Exactly the body Forge seeds into `src/slots/data.files/<name>.ts`. */
const seeded = {
  allowedTypes: (async (ctx) => ctx.proceed()) satisfies AllowedTypesSlot,
  sizeLimits: (async (ctx) => ctx.proceed()) satisfies SizeLimitsSlot,
  processingPipeline: (async (ctx) => ctx.proceed()) satisfies ProcessingPipelineSlot,
  retentionRules: (async (ctx) => ctx.proceed()) satisfies RetentionRulesSlot,
}

async function put(session: { url: string; id: string }, text: string): Promise<void> {
  await serveLocalObject(
    new Request(session.url, {
      method: 'PUT',
      body: new TextEncoder().encode(text) as unknown as BodyInit,
    }),
  )
  await completeUpload(session.id)
}

describe('allowedTypes', () => {
  it('defaults to the configured allowedContentTypes, so the seeded stub changes nothing', async () => {
    h = await setupFiles({ slots: { allowedTypes: seeded.allowedTypes } })

    const session = await upload({ filename: 'a.txt', contentType: 'text/plain', sizeBytes: 5 })
    expect(session.fileId).toBeTruthy()
    await expect(
      upload({ filename: 'a.svg', contentType: 'image/svg+xml', sizeBytes: 5 }),
    ).rejects.toBeInstanceOf(UploadRejectedError)
  })

  it('hands the slot the configured list, not a stub', async () => {
    let seen: readonly string[] = []
    h = await setupFiles({
      allowedContentTypes: ['text/plain', 'application/pdf'],
      slots: {
        allowedTypes: (ctx) => {
          seen = ctx.proceed()
          return ctx.proceed()
        },
      },
    })
    await upload({ filename: 'a.txt', contentType: 'text/plain', sizeBytes: 5 })
    expect(seen).toEqual(['text/plain', 'application/pdf'])
  })

  it('narrows what is accepted when the slot returns a subset', async () => {
    h = await setupFiles({
      slots: {
        allowedTypes: (ctx) =>
          ctx.attachedTo?.entity === 'Receipt'
            ? ctx.proceed().filter((type) => type.startsWith('image/'))
            : ctx.proceed(),
      },
    })

    // Photographs of paper, not scans of books: text is fine in general, not here.
    await expect(
      upload({
        filename: 'receipt.txt',
        contentType: 'text/plain',
        sizeBytes: 5,
        attachedTo: { entity: 'Receipt', id: 'r-1' },
      }),
    ).rejects.toBeInstanceOf(UploadRejectedError)

    const image = await upload({
      filename: 'receipt.png',
      contentType: 'image/png',
      sizeBytes: 5,
      attachedTo: { entity: 'Receipt', id: 'r-1' },
    })
    expect(image.fileId).toBeTruthy()
    // Narrowing applies where the slot says it does and nowhere else.
    expect((await upload({ filename: 'a.txt', contentType: 'text/plain', sizeBytes: 5 })).fileId)
      .toBeTruthy()
  })

  it('cannot let an unscanned file through, however wide the slot opens the door', async () => {
    h = await setupFiles({
      slots: { allowedTypes: (ctx) => [...ctx.proceed(), 'text/csv'] },
    })

    const session = await upload({ filename: 'ledger.csv', contentType: 'text/csv', sizeBytes: 24 })
    await put(session, 'this payload is INFECTED')

    // Admitted by the slot, still quarantined by the scanner.
    await expect(signedUrl(session.fileId)).rejects.toMatchObject({ status: 404 })
    await h.queue.drain()

    expect(h.events.map((e) => e.name)).toEqual(['file.scanned', 'file.quarantined'])
    expect(h.events.some((e) => e.name === 'file.uploaded')).toBe(false)
    await expect(signedUrl(session.fileId)).rejects.toMatchObject({ status: 404 })
  })
})

describe('sizeLimits', () => {
  it('defaults to the configured maxSizeBytes, so the seeded stub changes nothing', async () => {
    h = await setupFiles({ maxSizeBytes: 100, slots: { sizeLimits: seeded.sizeLimits } })

    expect((await upload({ filename: 'ok.txt', contentType: 'text/plain', sizeBytes: 100 })).maxSizeBytes)
      .toBe(100)
    await expect(
      upload({ filename: 'big.txt', contentType: 'text/plain', sizeBytes: 101 }),
    ).rejects.toThrow(/limit for this upload is 100/)
  })

  it('lowers the ceiling — and the signed grant — when the slot says so', async () => {
    h = await setupFiles({
      maxSizeBytes: 1000,
      slots: {
        sizeLimits: (ctx) => (ctx.attachedTo?.entity === 'Receipt' ? 50 : ctx.proceed()),
      },
    })

    await expect(
      upload({
        filename: 'receipt.png',
        contentType: 'image/png',
        sizeBytes: 500,
        attachedTo: { entity: 'Receipt', id: 'r-1' },
      }),
    ).rejects.toThrow(/limit for this upload is 50/)

    // The narrowed ceiling is carried into the grant, so storage enforces it too.
    const grant = await upload({
      filename: 'small.png',
      contentType: 'image/png',
      sizeBytes: 10,
      attachedTo: { entity: 'Receipt', id: 'r-1' },
    })
    expect(grant.maxSizeBytes).toBe(50)
    expect((await upload({ filename: 'a.txt', contentType: 'text/plain', sizeBytes: 900 })).maxSizeBytes)
      .toBe(1000)
  })
})

describe('processingPipeline', () => {
  it('defaults to no derived objects, so the seeded stub publishes no file.processed', async () => {
    h = await setupFiles({ slots: { processingPipeline: seeded.processingPipeline } })

    const session = await upload({ filename: 'a.txt', contentType: 'text/plain', sizeBytes: 5 })
    await put(session, 'clean')
    await h.queue.drain()

    expect(h.repos.thumbnails.all()).toHaveLength(0)
    expect(h.events.map((e) => e.name)).toEqual(['file.scanned', 'file.uploaded'])
  })

  it('records what a real pipeline returns, still after the scan clears', async () => {
    const scanStates: string[] = []
    h = await setupFiles({
      slots: {
        processingPipeline: async (ctx) => {
          scanStates.push(ctx.file.scanStatus)
          const key = await ctx.write('preview', new TextEncoder().encode('p'), 'text/plain')
          return [...ctx.proceed(), { kind: 'preview', storageKey: key }]
        },
      },
    })

    const session = await upload({ filename: 'a.txt', contentType: 'text/plain', sizeBytes: 5 })
    await put(session, 'clean')
    await h.queue.drain()

    expect(scanStates).toEqual(['clean'])
    expect(h.repos.thumbnails.all()).toHaveLength(1)
    expect(h.events.map((e) => e.name)).toEqual(['file.scanned', 'file.processed', 'file.uploaded'])
  })
})

describe('retentionRules', () => {
  it('defaults to keeping every file, so the seeded stub deletes nothing', async () => {
    h = await setupFiles({ slots: { retentionRules: seeded.retentionRules } })

    const session = await upload({ filename: 'old.txt', contentType: 'text/plain', sizeBytes: 5 })
    await put(session, 'keep me')
    await h.queue.drain()

    const inSixWeeks = new Date(Date.now() + 42 * 86_400_000).toISOString()
    const result = await runRetentionSweep({ now: inSixWeeks })
    expect(result.deleted).toBe(0)
    expect(result.examined).toBeGreaterThan(0)
    expect(await h.repos.files.find(session.fileId)).not.toBeNull()
  })

  it('expires a file when the slot returns ctx.expire()', async () => {
    h = await setupFiles({
      slots: {
        retentionRules: (ctx) =>
          ctx.ageDays > 30 ? ctx.expire('older_than_30_days') : ctx.proceed(),
      },
    })

    const session = await upload({ filename: 'old.txt', contentType: 'text/plain', sizeBytes: 5 })
    await put(session, 'delete me eventually')
    await h.queue.drain()

    expect((await runRetentionSweep()).deleted).toBe(0)

    const inSixWeeks = new Date(Date.now() + 42 * 86_400_000).toISOString()
    expect((await runRetentionSweep({ now: inSixWeeks })).deleted).toBe(1)
    expect(await h.storage.list('files/')).toHaveLength(0)
    expect(
      h.events.filter((e) => e.name === 'file.deleted').map((e) => e.payload['cascade_source']),
    ).toEqual(['retention:older_than_30_days'])
  })
})
