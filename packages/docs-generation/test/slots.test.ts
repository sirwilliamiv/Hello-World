/**
 * The slot contract: every context exposes `proceed()`, and `proceed()` returns
 * exactly what the capability does with no slot implemented
 * (schemas/capability.schema.json, `$defs.slot.signature`).
 *
 * Each slot is asserted twice — the seeded stub must be indistinguishable from having
 * no slot at all, and a slot that returns something else must change the outcome —
 * and once more for the property this capability exists to hold: a slot must not be
 * able to make a reissued document differ from the original.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  createTemplate,
  generate,
  publishTemplateVersion,
  reissue,
  renderHtml,
  type BrandingOverrideSlot,
  type OutputFormatsSlot,
  type TemplateHelpersSlot,
} from '../src/index.js'
import {
  INVOICE_DATA,
  INVOICE_TEMPLATE,
  setupDocuments,
  TOKENS_CSS,
  TOKENS_HREF,
  type DocsHarness,
} from './harness.js'

let h!: DocsHarness

afterEach(() => {
  h?.cleanup()
})

/** Exactly the body Forge seeds into `src/slots/docs.generation/<name>.ts`. */
const seeded = {
  templateHelpers: (async (ctx) => ctx.proceed()) satisfies TemplateHelpersSlot,
  brandingOverride: (async (ctx) => ctx.proceed()) satisfies BrandingOverrideSlot,
  outputFormats: (async (ctx) => ctx.proceed()) satisfies OutputFormatsSlot,
}

describe('templateHelpers', () => {
  it('defaults to the registered helper table, so the seeded stub changes nothing', async () => {
    h = setupDocuments()
    await createTemplate({ key: 'invoice', name: 'Invoice', source: INVOICE_TEMPLATE })
    const withoutSlot = await renderHtml('invoice', INVOICE_DATA)

    h.cleanup()
    h = setupDocuments({ slots: { templateHelpers: seeded.templateHelpers } })
    await createTemplate({ key: 'invoice', name: 'Invoice', source: INVOICE_TEMPLATE })

    expect(await renderHtml('invoice', INVOICE_DATA)).toBe(withoutSlot)
  })

  it('hands the slot the built-ins, so a client adds rather than replaces', async () => {
    let names: string[] = []
    h = setupDocuments({
      slots: {
        templateHelpers: (ctx) => {
          names = Object.keys(ctx.proceed())
          return { ...ctx.proceed(), reference: (...args) => `REF-${String(args[0]).toUpperCase()}` }
        },
      },
    })
    await createTemplate({
      key: 'invoice',
      name: 'Invoice',
      source: '<p>{{ reference invoice.number }} {{ money invoice.total_minor invoice.currency }}</p>',
    })

    const html = await renderHtml('invoice', INVOICE_DATA)
    expect(names).toContain('money')
    expect(html).toContain('REF-INV-2026-00042')
    // The built-in survived the client's contribution.
    expect(html).toContain('$1,284.50')
  })
})

describe('brandingOverride', () => {
  it('defaults to the kernel.ui tokens, so the seeded stub changes nothing', async () => {
    h = setupDocuments()
    await createTemplate({ key: 'invoice', name: 'Invoice', source: INVOICE_TEMPLATE })
    const withoutSlot = await renderHtml('invoice', INVOICE_DATA)

    h.cleanup()
    h = setupDocuments({ slots: { brandingOverride: seeded.brandingOverride } })
    await createTemplate({ key: 'invoice', name: 'Invoice', source: INVOICE_TEMPLATE })

    const withStub = await renderHtml('invoice', INVOICE_DATA)
    expect(withStub).toBe(withoutSlot)
    expect(withStub).toContain(`<link rel="stylesheet" href="${TOKENS_HREF}">`)
    expect(withStub).toContain(TOKENS_CSS)
  })

  it('adds a letterhead to one document type and defers on the rest', async () => {
    h = setupDocuments({
      slots: {
        brandingOverride: (ctx) =>
          ctx.templateKey === 'contract'
            ? { ...ctx.proceed(), headerHtml: '<img alt="" src="/brand/letterhead.png">' }
            : ctx.proceed(),
      },
    })
    await createTemplate({ key: 'contract', name: 'Contract', source: '<p>terms</p>' })
    await createTemplate({ key: 'invoice', name: 'Invoice', source: INVOICE_TEMPLATE })

    expect(await renderHtml('contract', {})).toContain('letterhead.png')
    const invoice = await renderHtml('invoice', INVOICE_DATA)
    expect(invoice).not.toContain('letterhead.png')
    // Deferring still links the tokens: a letterhead cannot detach the rest.
    expect(invoice).toContain(TOKENS_CSS)
  })

  it('is a function of the pinned inputs, so a reissue is still byte-identical', async () => {
    const seen: { key: string; version: number }[] = []
    h = setupDocuments({
      slots: {
        brandingOverride: (ctx) => {
          seen.push({ key: ctx.templateKey, version: ctx.templateVersion })
          return {
            ...ctx.proceed(),
            headerHtml: `${ctx.templateKey} v${ctx.templateVersion}`,
          }
        },
      },
    })
    const { template } = await createTemplate({
      key: 'invoice',
      name: 'Invoice',
      source: INVOICE_TEMPLATE,
    })
    const document = await generate('invoice', INVOICE_DATA, { subjectRef: 'Invoice:inv-42' })

    // The template moves on. The issued document does not.
    await publishTemplateVersion(template.id, '<h1>completely different</h1>')

    const reissued = await reissue(document.id)
    expect(reissued.identical).toBe(true)
    expect(Buffer.from(reissued.bytes).toString('utf8')).toContain('invoice v1')
    // The slot was told the pinned version both times, never the current one.
    expect(seen.map((s) => s.version)).toEqual([1, 1])
  })
})

describe('outputFormats', () => {
  it('defaults to the configured default_format, so the seeded stub changes nothing', async () => {
    h = setupDocuments({ defaultFormat: 'html', slots: { outputFormats: seeded.outputFormats } })
    await createTemplate({ key: 'invoice', name: 'Invoice', source: INVOICE_TEMPLATE })

    const document = await generate('invoice', INVOICE_DATA)
    expect(document.format).toBe('html')
    expect(h.files.stored.get(document.fileId as string)?.contentType).toBe(
      'text/html; charset=utf-8',
    )
  })

  it('is told what was requested and what the configuration defaults to', async () => {
    const seen: { requested: string | undefined; configuredDefault: string }[] = []
    h = setupDocuments({
      defaultFormat: 'html',
      slots: {
        outputFormats: (ctx) => {
          seen.push({ requested: ctx.requested, configuredDefault: ctx.configuredDefault })
          return ctx.proceed()
        },
      },
    })
    await createTemplate({ key: 'invoice', name: 'Invoice', source: INVOICE_TEMPLATE })

    await generate('invoice', INVOICE_DATA)
    await generate('invoice', INVOICE_DATA, { format: 'html', subjectRef: 'Invoice:inv-9' })

    expect(seen).toEqual([
      { requested: undefined, configuredDefault: 'html' },
      { requested: 'html', configuredDefault: 'html' },
    ])
  })

  it('writes a format the capability does not know about', async () => {
    h = setupDocuments({
      defaultFormat: 'html',
      slots: {
        outputFormats: (ctx) =>
          ctx.format === 'txt'
            ? {
                bytes: new TextEncoder().encode(ctx.html.replace(/<[^>]+>/g, ' ').trim()),
                contentType: 'text/plain; charset=utf-8',
                extension: 'txt',
              }
            : ctx.proceed(),
      },
    })
    await createTemplate({ key: 'invoice', name: 'Invoice', source: INVOICE_TEMPLATE })

    const custom = await generate('invoice', INVOICE_DATA, { format: 'txt' })
    expect(custom.format).toBe('txt')
    expect(h.files.stored.get(custom.fileId as string)?.contentType).toBe('text/plain; charset=utf-8')

    // Deferring on everything else leaves the built-in writer in charge.
    const plain = await generate('invoice', INVOICE_DATA, { subjectRef: 'Invoice:inv-43' })
    expect(h.files.stored.get(plain.fileId as string)?.contentType).toBe('text/html; charset=utf-8')
  })

  it('lets a slot choose a different built-in format, and records what was written', async () => {
    h = setupDocuments({
      defaultFormat: 'pdf',
      slots: { outputFormats: (ctx) => (ctx.requested === undefined ? 'html' : ctx.proceed()) },
    })
    await createTemplate({ key: 'invoice', name: 'Invoice', source: INVOICE_TEMPLATE })

    const document = await generate('invoice', INVOICE_DATA)
    expect(document.format).toBe('html')
    expect(h.files.stored.get(document.fileId as string)?.contentType).toBe(
      'text/html; charset=utf-8',
    )
  })
})
