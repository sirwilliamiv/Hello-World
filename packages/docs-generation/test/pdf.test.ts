/**
 * tests.smoke: "template renders to PDF" —
 * a template plus data produces a non-empty PDF stored as a file.
 *
 * Plus the determinism claim where it is hardest: two Chromium renders of the same
 * document must be byte-identical after normalisation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  closePdfEngine,
  createTemplate,
  documentUrl,
  generate,
  isPdf,
  normalisePdf,
  PdfEngineDisabledError,
  renderHtml,
  renderPdf,
} from '../src/index.js'
import {
  chromiumAvailable,
  INVOICE_DATA,
  INVOICE_TEMPLATE,
  setupDocuments,
  type DocsHarness,
} from './harness.js'

let h!: DocsHarness
const hasChromium = await chromiumAvailable()

beforeEach(() => {
  h = setupDocuments({ defaultFormat: 'pdf' })
})
afterEach(async () => {
  h.cleanup()
  await closePdfEngine()
})

describe('normalisePdf', () => {
  it('replaces the creation date and document id without changing byte length', () => {
    const pdf = Buffer.from(
      `%PDF-1.4\n1 0 obj\n<< /CreationDate (D:20260729180000+00'00') ` +
        `/ModDate (D:20260729180001+00'00') >>\nendobj\n` +
        `trailer\n<< /ID [<0123456789ABCDEF0123456789ABCDEF> <FEDCBA9876543210FEDCBA9876543210>] >>\n%%EOF`,
      'latin1',
    )
    const once = normalisePdf(pdf)
    const twice = normalisePdf(
      Buffer.from(
        pdf
          .toString('latin1')
          .replace("20260729180000", "20270101093000")
          .replace("20260729180001", "20270101093001")
          .replace('0123456789ABCDEF0123456789ABCDEF', 'AAAAAAAABBBBBBBBCCCCCCCCDDDDDDDD')
          .replace('FEDCBA9876543210FEDCBA9876543210', 'AAAAAAAABBBBBBBBCCCCCCCCDDDDDDDD'),
        'latin1',
      ),
    )

    expect(once.byteLength).toBe(pdf.byteLength)
    expect(once.toString('latin1')).toContain("D:19700101000000+00'00'")
    // Two runs, two clocks, two Chromium ids — one set of bytes.
    expect(twice.equals(once)).toBe(true)
  })

  it('leaves a date it does not recognise alone rather than corrupting offsets', () => {
    const pdf = Buffer.from('%PDF-1.4 /CreationDate (D:2026) %%EOF', 'latin1')
    expect(normalisePdf(pdf).toString('latin1')).toContain('(D:2026)')
  })
})

describe('pdf engine disabled', () => {
  it("refuses to render a PDF and says how to get HTML instead", async () => {
    h.cleanup()
    h = setupDocuments({ pdfEngine: 'none', defaultFormat: 'html' })
    await createTemplate({ key: 'invoice', name: 'Invoice', source: INVOICE_TEMPLATE })

    await expect(renderPdf('<p>hi</p>')).rejects.toBeInstanceOf(PdfEngineDisabledError)
    await expect(generate('invoice', INVOICE_DATA, { format: 'pdf' })).rejects.toBeInstanceOf(
      PdfEngineDisabledError,
    )
    // HTML still works, which is the point of the option.
    const html = await generate('invoice', INVOICE_DATA)
    expect(html.format).toBe('html')
  })

  it('refuses a configuration that defaults to PDF with no engine', async () => {
    h.cleanup()
    expect(() => setupDocuments({ pdfEngine: 'none', defaultFormat: 'pdf' })).toThrow(
      /default_format/,
    )
    h = setupDocuments()
  })
})

describe.skipIf(!hasChromium)('rendering to PDF through headless Chromium', () => {
  it('produces a non-empty PDF and stores it as a file', async () => {
    await createTemplate({ key: 'invoice', name: 'Invoice', source: INVOICE_TEMPLATE })

    const document = await generate('invoice', INVOICE_DATA, { subjectRef: 'Invoice:inv-42' })
    expect(document.format).toBe('pdf')
    expect(document.fileId).not.toBeNull()

    const bytes = h.files.bytesOf(document.fileId as string)
    expect(isPdf(bytes)).toBe(true)
    expect(bytes.byteLength).toBeGreaterThan(1000)

    // The rendering is a file like any other, so it is not retrievable until it has
    // cleared scanning — the same rule that applies to an upload.
    await expect(documentUrl(document.id)).rejects.toMatchObject({ status: 404 })
    h.files.clearScans()
    await expect(documentUrl(document.id)).resolves.toContain('https://storage.test/')

    expect(h.events.filter((e) => e.name === 'document.generated')).toHaveLength(1)
  })

  it('renders the same document to the same bytes twice', async () => {
    await createTemplate({ key: 'invoice', name: 'Invoice', source: INVOICE_TEMPLATE })
    const html = await renderHtml('invoice', INVOICE_DATA)

    const first = await renderPdf(html)
    const second = await renderPdf(html)
    expect(second.equals(first)).toBe(true)
  })

  it('reissues a historical PDF byte-identically', async () => {
    const { template } = await createTemplate({
      key: 'invoice',
      name: 'Invoice',
      source: INVOICE_TEMPLATE,
    })
    const issued = await generate('invoice', INVOICE_DATA, { subjectRef: 'Invoice:inv-42' })
    const { publishTemplateVersion, reissue } = await import('../src/index.js')
    await publishTemplateVersion(template.id, '<h1>New look</h1>')

    const again = await reissue(issued.id)
    expect(again.identical).toBe(true)
    expect(Buffer.from(again.bytes).equals(Buffer.from(h.files.bytesOf(issued.fileId as string)))).toBe(
      true,
    )
  })
})
