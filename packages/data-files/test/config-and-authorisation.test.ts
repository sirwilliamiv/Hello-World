/**
 * Configuration validation and upload authorisation, including the two slots that
 * run before a grant is issued.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  configureFiles,
  exportFiles,
  FilesConfigError,
  resetFilesConfig,
  UploadRejectedError,
  upload,
} from '../src/index.js'
import { setupFiles, type Harness } from './harness.js'

let h!: Harness

afterEach(async () => {
  await h?.cleanup()
  resetFilesConfig()
})

describe('configuration', () => {
  it("refuses scan_policy 'skip' on a cloud driver, and says how to fix it", () => {
    expect(() =>
      configureFiles({
        driver: 'gcs',
        bucket: 'acme-files',
        credentials: '{}',
        maxSizeBytes: 1024,
        allowedContentTypes: ['application/pdf'],
        scanPolicy: 'skip',
      }),
    ).toThrow(FilesConfigError)
  })

  it('refuses an empty bucket rather than writing objects somewhere surprising', () => {
    expect(() =>
      configureFiles({
        driver: 'local',
        bucket: '',
        credentials: 'x',
        maxSizeBytes: 1024,
        allowedContentTypes: ['application/pdf'],
        scanPolicy: 'skip',
      }),
    ).toThrow(/STORAGE_BUCKET/)
  })
})

describe('upload authorisation', () => {
  it('rejects a content type outside the configured list', async () => {
    h = await setupFiles()
    await expect(
      upload({ filename: 'x.exe', contentType: 'application/x-msdownload', sizeBytes: 10 }),
    ).rejects.toBeInstanceOf(UploadRejectedError)
  })

  it('rejects a file over the configured size', async () => {
    h = await setupFiles({ maxSizeBytes: 100 })
    await expect(
      upload({ filename: 'big.txt', contentType: 'text/plain', sizeBytes: 101 }),
    ).rejects.toThrow(/limit for this upload is 100/)
  })

  it('lets the allowedTypes slot admit a type configuration does not list', async () => {
    h = await setupFiles({
      slots: {
        allowedTypes: (ctx) => ({
          allow: ctx.allowedByConfig || ctx.contentType === 'image/svg+xml',
        }),
      },
    })
    const session = await upload({
      filename: 'logo.svg',
      contentType: 'image/svg+xml',
      sizeBytes: 20,
    })
    expect(session.fileId).toBeTruthy()
  })

  it('lets the sizeLimits slot narrow the ceiling per entity', async () => {
    h = await setupFiles({
      slots: {
        sizeLimits: (ctx) => ({
          maxSizeBytes: ctx.attachedTo?.entity === 'Receipt' ? 50 : ctx.configuredMaxBytes,
          reason: 'Receipts are photographs of paper, not scans of books.',
        }),
      },
    })
    await expect(
      upload({
        filename: 'receipt.png',
        contentType: 'image/png',
        sizeBytes: 500,
        attachedTo: { entity: 'Receipt', id: 'r-1' },
      }),
    ).rejects.toThrow(/photographs of paper/)
  })

  it('exports file metadata for a user, in a stable order, without signed URLs', async () => {
    h = await setupFiles()
    await upload({ filename: 'a.txt', contentType: 'text/plain', sizeBytes: 5 })
    await upload({ filename: 'b.txt', contentType: 'text/plain', sizeBytes: 5 })
    const exported = await exportFiles('user-1')
    expect(exported).toHaveLength(2)
    expect(exported.map((e) => e.id)).toEqual([...exported.map((e) => e.id)].sort())
    expect(JSON.stringify(exported)).not.toContain('sig=')
  })
})
