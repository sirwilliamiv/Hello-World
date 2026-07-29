/**
 * tests.smoke: "rendering is deterministic" —
 * rendering the same template version with the same data twice produces
 * byte-identical output.
 *
 * And the contract scenario with pay.invoices: "a template is edited after an invoice
 * was issued → reissuing the historical invoice uses the pinned template version and
 * is byte-identical to the original."
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  canonicalJson,
  createTemplate,
  generate,
  publishTemplateVersion,
  reissue,
  renderHtml,
} from '../src/index.js'
import { INVOICE_DATA, INVOICE_TEMPLATE, setupDocuments, type DocsHarness } from './harness.js'

let h!: DocsHarness

beforeEach(() => {
  h = setupDocuments()
})
afterEach(() => {
  h.cleanup()
})

describe('rendering is deterministic', () => {
  it('produces identical bytes for the same version and data, twice', async () => {
    await createTemplate({ key: 'invoice', name: 'Invoice', source: INVOICE_TEMPLATE })

    const first = await renderHtml('invoice', INVOICE_DATA)
    const second = await renderHtml('invoice', INVOICE_DATA)
    expect(second).toBe(first)
    expect(Buffer.from(second)).toEqual(Buffer.from(first))
  })

  it('does not depend on the order the data object was built in', async () => {
    await createTemplate({ key: 'invoice', name: 'Invoice', source: INVOICE_TEMPLATE })

    const reordered = {
      invoice: {
        lines: INVOICE_DATA.invoice.lines,
        due_at: INVOICE_DATA.invoice.due_at,
        total_minor: INVOICE_DATA.invoice.total_minor,
        currency: INVOICE_DATA.invoice.currency,
        customer_name: INVOICE_DATA.invoice.customer_name,
        number: INVOICE_DATA.invoice.number,
      },
    }
    expect(await renderHtml('invoice', reordered)).toBe(await renderHtml('invoice', INVOICE_DATA))
    expect(canonicalJson(reordered)).toBe(canonicalJson(INVOICE_DATA))
  })

  it('contains no timestamp, uuid, or other run-varying token', async () => {
    await createTemplate({ key: 'invoice', name: 'Invoice', source: INVOICE_TEMPLATE })
    const html = await renderHtml('invoice', INVOICE_DATA)

    // The only date in the output is the one the data supplied.
    expect(html.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g)).toBeNull()
    expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
    expect(html).toContain('15 August 2026')
  })

  it('derives the document id from its inputs, so generating twice is idempotent', async () => {
    await createTemplate({ key: 'invoice', name: 'Invoice', source: INVOICE_TEMPLATE })
    const one = await generate('invoice', INVOICE_DATA, { subjectRef: 'Invoice:inv-42' })
    const two = await generate('invoice', INVOICE_DATA, { subjectRef: 'Invoice:inv-42' })

    expect(two.id).toBe(one.id)
    expect(two.contentHash).toBe(one.contentHash)
    expect(h.repos.documents.rows.size).toBe(1)
    expect(h.files.stored.size).toBe(1)
    // The second call short-circuits, so only one document.generated was published.
    expect(h.events.filter((e) => e.name === 'document.generated')).toHaveLength(1)
  })

  it('changes the document when the data changes, and only then', async () => {
    await createTemplate({ key: 'invoice', name: 'Invoice', source: INVOICE_TEMPLATE })
    const original = await generate('invoice', INVOICE_DATA, { subjectRef: 'Invoice:inv-42' })
    const altered = await generate(
      'invoice',
      { invoice: { ...INVOICE_DATA.invoice, total_minor: 128_451 } },
      { subjectRef: 'Invoice:inv-42' },
    )
    expect(altered.id).not.toBe(original.id)
    expect(altered.contentHash).not.toBe(original.contentHash)
  })
})

describe('a template edit cannot reach a document that was already issued', () => {
  it('reissues the pinned version byte-identically after the template changed', async () => {
    const { template } = await createTemplate({
      key: 'invoice',
      name: 'Invoice',
      source: INVOICE_TEMPLATE,
    })

    const issued = await generate('invoice', INVOICE_DATA, { subjectRef: 'Invoice:inv-42' })
    expect(issued.templateVersion).toBe(1)
    const originalBytes = h.files.bytesOf(issued.fileId as string)

    // Somebody redesigns the invoice. Twice.
    await publishTemplateVersion(
      template.id,
      `<h1>Invoice {{ invoice.number }}</h1><p>Redesigned. Total {{ money invoice.total_minor invoice.currency }}</p>`,
    )
    await publishTemplateVersion(template.id, `<h1>Third thoughts</h1>`)

    const reissued = await reissue(issued.id)
    expect(reissued.document.templateVersion).toBe(1)
    expect(reissued.identical).toBe(true)
    expect(reissued.contentHash).toBe(issued.contentHash)
    expect(Buffer.from(reissued.bytes)).toEqual(Buffer.from(originalBytes))

    // A new invoice, by contrast, picks up the current version.
    const fresh = await generate('invoice', INVOICE_DATA, { subjectRef: 'Invoice:inv-43' })
    expect(fresh.templateVersion).toBe(3)
    expect(fresh.contentHash).not.toBe(issued.contentHash)
  })

  it('can still render an old version explicitly, because versions are append-only', async () => {
    const { template } = await createTemplate({
      key: 'invoice',
      name: 'Invoice',
      source: '<p>v1 {{ invoice.number }}</p>',
    })
    await publishTemplateVersion(template.id, '<p>v2 {{ invoice.number }}</p>')

    expect(await renderHtml('invoice', INVOICE_DATA, { templateVersion: 1 })).toContain('v1 INV-')
    expect(await renderHtml('invoice', INVOICE_DATA)).toContain('v2 INV-')
    expect(await renderHtml({ key: 'invoice', version: 1 }, INVOICE_DATA)).toContain('v1 INV-')
  })

  it('never rewrites a published version row', async () => {
    const { template } = await createTemplate({
      key: 'invoice',
      name: 'Invoice',
      source: '<p>v1</p>',
    })
    const v1 = [...h.repos.versions.rows.values()][0]
    await publishTemplateVersion(template.id, '<p>v2</p>')

    const stillV1 = h.repos.versions.rows.get(String(v1?.['id']))
    expect(stillV1?.['source']).toBe('<p>v1</p>')
    expect(h.repos.versions.rows.size).toBe(2)
    expect(h.events.filter((e) => e.name === 'document.template.updated')).toHaveLength(2)
  })
})
