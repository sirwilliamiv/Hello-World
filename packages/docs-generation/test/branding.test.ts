/**
 * tests.smoke: "branding tokens are applied" —
 * a rendered document carries the manifest's brand tokens without a separate
 * stylesheet.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTemplate, renderHtml } from '../src/index.js'
import {
  INVOICE_DATA,
  INVOICE_TEMPLATE,
  setupDocuments,
  TOKENS_CSS,
  TOKENS_HREF,
  type DocsHarness,
} from './harness.js'

let h!: DocsHarness

beforeEach(() => {
  h = setupDocuments()
})
afterEach(() => {
  h.cleanup()
})

describe('branding tokens are applied', () => {
  it('links the kernel.ui token stylesheet and inlines it for the print path', async () => {
    await createTemplate({ key: 'invoice', name: 'Invoice', source: INVOICE_TEMPLATE })
    const html = await renderHtml('invoice', INVOICE_DATA)

    expect(html).toContain(`<link rel="stylesheet" href="${TOKENS_HREF}">`)
    expect(html).toContain(TOKENS_CSS)
    expect(html).toContain('--color-accent: #1d4ed8')
  })

  it('styles the document only through tokens, with fallbacks and nothing else', async () => {
    await createTemplate({ key: 'invoice', name: 'Invoice', source: INVOICE_TEMPLATE })
    const html = await renderHtml('invoice', INVOICE_DATA)
    const base = html.slice(html.indexOf('data-forge="document base"'))
    const baseCss = base.slice(0, base.indexOf('</style>'))

    // Every colour and font in the capability's own CSS reads a token first.
    for (const declaration of baseCss.matchAll(/(color|background|font-family|font-size)\s*:\s*([^;]+);/g)) {
      expect(declaration[2]).toMatch(/var\(--/)
    }
  })

  it('carries a changed token through to the document without touching a template', async () => {
    h.cleanup()
    h = setupDocuments({ tokensCss: ':root { --color-accent: #b91c1c; }' })
    await createTemplate({ key: 'invoice', name: 'Invoice', source: INVOICE_TEMPLATE })

    const html = await renderHtml('invoice', INVOICE_DATA)
    expect(html).toContain('--color-accent: #b91c1c')
    expect(html).not.toContain('#1d4ed8')
  })

  it('lets the brandingOverride slot add a letterhead without detaching from the tokens', async () => {
    h.cleanup()
    h = setupDocuments({
      slots: {
        brandingOverride: (ctx) => ({
          css: `.document-header { border-bottom: 2px solid var(--color-accent, #000); }`,
          headerHtml: `<img alt="" src="/brand/letterhead.png"> ${ctx.templateKey} v${ctx.templateVersion}`,
        }),
      },
    })
    await createTemplate({ key: 'invoice', name: 'Invoice', source: INVOICE_TEMPLATE })

    const html = await renderHtml('invoice', INVOICE_DATA)
    expect(html).toContain('class="document-header"')
    expect(html).toContain('invoice v1')
    // The override is appended after the tokens, not instead of them.
    expect(html.indexOf('brandingOverride')).toBeGreaterThan(html.indexOf('kernel.ui tokens'))
    expect(html).toContain(TOKENS_CSS)
  })

  it('applies the page size from configuration', async () => {
    h.cleanup()
    h = setupDocuments({ pageSize: 'a4' })
    await createTemplate({ key: 'invoice', name: 'Invoice', source: INVOICE_TEMPLATE })
    expect(await renderHtml('invoice', INVOICE_DATA)).toContain('@page { size: A4;')
  })

  it('escapes data into the document rather than trusting it', async () => {
    await createTemplate({ key: 'invoice', name: 'Invoice', source: INVOICE_TEMPLATE })
    const html = await renderHtml('invoice', INVOICE_DATA)
    expect(html).toContain('Acme &amp; Sons &lt;Holdings&gt;')
  })

  it('formats money through kernel.money, never in the template', async () => {
    await createTemplate({ key: 'invoice', name: 'Invoice', source: INVOICE_TEMPLATE })
    const html = await renderHtml('invoice', INVOICE_DATA)
    expect(html).toContain('$1,284.50')
    expect(html).toContain('$950.00')
  })
})
