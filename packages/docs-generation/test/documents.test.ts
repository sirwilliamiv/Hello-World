/**
 * Event handlers, the outputFormats slot, and the privacy handlers.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  anonymizeGeneratedDocuments,
  createTemplate,
  exportGeneratedDocuments,
  generate,
  listDocuments,
  reissue,
  renderHtml,
  renderInvoice,
  renderReport,
} from '../src/index.js'
import { INVOICE_DATA, INVOICE_TEMPLATE, setupDocuments, type DocsHarness } from './harness.js'

let h!: DocsHarness

beforeEach(() => {
  h = setupDocuments()
})
afterEach(() => {
  h.cleanup()
})

const INVOICE_EVENT = {
  name: 'invoice.created',
  payload: {
    invoice_id: 'inv-42',
    number: 'INV-2026-00042',
    customer_id: 'cus-7',
    total_minor: 128_450,
    currency: 'USD',
    due_at: '2026-08-15T00:00:00.000Z',
    legal_entity: 'Acme Services LLC',
  },
}

describe('event handlers', () => {
  it('renders an invoice when one is issued, and only once per event', async () => {
    await createTemplate({
      key: 'invoice',
      name: 'Invoice',
      source: '<h1>{{ invoice.number }}</h1><p>{{ money invoice.total_minor invoice.currency }}</p>',
    })

    const first = await renderInvoice(INVOICE_EVENT)
    const second = await renderInvoice(INVOICE_EVENT) // redelivery
    expect(first?.id).toBe(second?.id)
    expect(first?.subjectRef).toBe('Invoice:inv-42')
    expect(h.repos.documents.rows.size).toBe(1)
    expect(h.events.filter((e) => e.name === 'document.generated')).toHaveLength(1)
  })

  it('does nothing when the client has no template for that document', async () => {
    expect(await renderReport({ name: 'report.scheduled', payload: { report_id: 'r-1' } })).toBeNull()
  })

  it('attaches the rendering to the subject entity so a cascade delete finds it', async () => {
    await createTemplate({ key: 'invoice', name: 'Invoice', source: '<p>{{ invoice.number }}</p>' })
    const document = await renderInvoice(INVOICE_EVENT)
    expect(await listDocuments('Invoice:inv-42')).toHaveLength(1)
    expect(document?.fileId).not.toBeNull()
  })
})

describe('outputFormats slot', () => {
  it('supplies a format the capability does not know about', async () => {
    h.cleanup()
    h = setupDocuments({
      defaultFormat: 'html',
      slots: {
        outputFormats: (ctx) =>
          ctx.format === 'txt'
            ? {
                bytes: new TextEncoder().encode(ctx.html.replace(/<[^>]+>/g, '').trim()),
                contentType: 'text/plain; charset=utf-8',
                extension: 'txt',
              }
            : null,
      },
    })
    await createTemplate({ key: 'invoice', name: 'Invoice', source: '<h1>{{ invoice.number }}</h1>' })

    const document = await generate('invoice', INVOICE_DATA, { format: 'txt' })
    expect(document.format).toBe('txt')
    const stored = h.files.stored.get(document.fileId as string)
    expect(stored?.contentType).toBe('text/plain; charset=utf-8')
    expect(Buffer.from(stored?.bytes as Uint8Array).toString('utf8')).toContain('INV-2026-00042')
  })

  it('rejects a format nobody can render, naming the slot', async () => {
    await createTemplate({ key: 'invoice', name: 'Invoice', source: '<p>x</p>' })
    await expect(generate('invoice', INVOICE_DATA, { format: 'docx' })).rejects.toThrow(
      /outputFormats slot/,
    )
  })
})

describe('templateHelpers slot', () => {
  it('makes a client helper available to every template', async () => {
    h.cleanup()
    h = setupDocuments({
      slots: {
        templateHelpers: () => ({
          reference: (...args) => `REF-${String(args[0]).toUpperCase()}`,
        }),
      },
    })
    await createTemplate({ key: 'invoice', name: 'Invoice', source: '<p>{{ reference id }}</p>' })
    expect(await renderHtml('invoice', { id: 'ab12' })).toContain('REF-AB12')
  })
})

describe('privacy handlers', () => {
  it('exports document metadata in a stable order', async () => {
    await createTemplate({ key: 'invoice', name: 'Invoice', source: INVOICE_TEMPLATE })
    await generate('invoice', INVOICE_DATA, { subjectRef: 'Invoice:inv-42' })
    await generate('invoice', INVOICE_DATA, { subjectRef: 'Invoice:inv-43' })

    const exported = await exportGeneratedDocuments('user-1')
    expect(exported).toHaveLength(2)
    expect(exported.map((d) => d.id)).toEqual([...exported.map((d) => d.id)].sort())
    expect(exported[0]).toMatchObject({ template: 'invoice', template_version: 1 })
  })

  it('anonymises rather than deletes, and says so when a reissue is then impossible', async () => {
    await createTemplate({ key: 'invoice', name: 'Invoice', source: INVOICE_TEMPLATE })
    const document = await generate('invoice', INVOICE_DATA, { subjectRef: 'Invoice:inv-42' })

    expect(await anonymizeGeneratedDocuments('user-1')).toEqual({ anonymised: 1 })

    const row = h.repos.documents.rows.get(document.id)
    expect(row?.['data']).toBeNull()
    expect(row?.['generatedBy']).toBeNull()
    // The proof survives: the pin and the content hash are still there.
    expect(row?.['templateVersion']).toBe(1)
    expect(row?.['contentHash']).toBe(document.contentHash)

    await expect(reissue(document.id)).rejects.toMatchObject({ code: 'document_anonymised' })
  })
})
