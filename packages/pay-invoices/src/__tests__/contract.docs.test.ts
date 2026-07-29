import { describe, expect, it } from 'vitest'
import { publishTemplateVersion, reissue, renderHtml } from '@forge/docs-generation'
import { Money } from '@forge/kernel-money'
import { getInvoice, issue } from '../invoice.js'
import { renderInvoice } from '../render.js'
import { INVOICE_TEMPLATE_ID } from '../config.js'
import { setupInvoices } from '../testing/harness.js'
import { loadCapability } from '../testing/json-schema.js'

/**
 * Contract test with docs.generation:
 * "an invoice is rendered after its template is updated → the rendering uses the
 *  template version pinned at issue time, so a reissued historical invoice is
 *  byte-identical".
 *
 * This runs against the real @forge/docs-generation. Its versions are INTEGERS
 * (1, 2, …) rather than the 'v1'/'v2' strings the retired double invented, and
 * `generate` returns a rendering's derived id and content hash rather than its
 * bytes — so byte-identity is asserted on the stored file and, additionally,
 * through docs.generation's own `reissue`, which re-renders the pinned version
 * from the stored data and reports whether the bytes still match.
 */

const line = (minor: number) => ({ description: 'Consulting', unitAmount: Money.of(minor, 'USD') })

const DIFFERENT_LAYOUT = '<section><em>a completely different layout</em>: {{ number }}</section>'

describe('contract: pay.invoices × docs.generation', () => {
  it('renders a document at issue time and pins the version it used', async () => {
    const h = await setupInvoices()
    const invoice = await issue({ customerId: 'user_1', lines: [line(12_345)] })

    expect(h.docs.renderCount()).toBe(1)
    expect(invoice.documentTemplate).toBe(INVOICE_TEMPLATE_ID)
    expect(invoice.documentTemplateVersion).toBe('1')
    expect(h.store.state.invoices[0]?.documentTemplateVersion).toBe('1')
  })

  it('reissues byte-identically after the template has been edited', async () => {
    const h = await setupInvoices()
    const issued = await issue({ customerId: 'user_1', lines: [line(12_345)] })
    const atIssue = await renderInvoice(issued)
    const bytesAtIssue = Buffer.from(h.docs.files.bytesOf(atIssue.fileId))

    // The client edits the invoice template. docs.generation's TemplateVersion
    // table is append-only, so this publishes version 2 and leaves 1 intact.
    const v2 = await publishTemplateVersion(
      h.docs.templateIds[INVOICE_TEMPLATE_ID] as string,
      DIFFERENT_LAYOUT,
    )
    expect(v2.version).toBe(2)

    const stored = await getInvoice(issued.id)
    const reissued = await renderInvoice(stored as NonNullable<typeof stored>)

    expect(reissued.templateVersion).toBe(1)
    expect(reissued.id).toBe(atIssue.id)
    expect(reissued.contentHash).toBe(atIssue.contentHash)
    expect(Buffer.from(h.docs.files.bytesOf(reissued.fileId))).toEqual(bytesAtIssue)

    // docs.generation re-renders the pinned version from the stored data and
    // compares against the hash it recorded when the document was first issued.
    const proof = await reissue(atIssue.id)
    expect(proof.identical).toBe(true)
    expect(Buffer.from(proof.bytes)).toEqual(bytesAtIssue)

    // …and the edit was not a no-op: rendering the CURRENT version of the same
    // template produces something else, so the identity above is not vacuous.
    const current = await renderHtml({ key: INVOICE_TEMPLATE_ID }, { number: issued.number })
    expect(current).toContain('a completely different layout')
    expect(Buffer.from(current, 'utf8')).not.toEqual(bytesAtIssue)
  })

  it('a NEW invoice issued after the edit picks up the new version', async () => {
    const h = await setupInvoices()
    const before = await issue({ customerId: 'user_1', lines: [line(100)] })
    await publishTemplateVersion(
      h.docs.templateIds[INVOICE_TEMPLATE_ID] as string,
      DIFFERENT_LAYOUT,
    )
    const after = await issue({ customerId: 'user_1', lines: [line(100)] })

    expect(before.documentTemplateVersion).toBe('1')
    expect(after.documentTemplateVersion).toBe('2')
  })

  it('declares docs.generation as a requirement, which is why the pin is possible', () => {
    const spec = loadCapability('catalog/pay/pay.invoices.capability.json')
    const requires = spec['requires'] as { id: string }[]
    expect(requires.map((r) => r.id)).toContain('docs.generation')
  })
})

describe('lineItemFormatting slot', () => {
  it('may reorder and relabel lines', async () => {
    const h = await setupInvoices({
      slots: {
        lineItemFormatting: (ctx) =>
          [...ctx.lines].reverse().map((l) => ({ ...l, description: l.description.toUpperCase() })),
      },
    })
    const invoice = await issue({
      customerId: 'user_1',
      lines: [line(100), { description: 'Hosting', unitAmount: Money.of(200, 'USD') }],
    })
    // The stored lines are unchanged; only the rendering is affected.
    expect(invoice.lines.map((l) => l.description)).toEqual(['Consulting', 'Hosting'])
    expect(h.docs.renderCount()).toBe(1)
  })

  it('may not change what is owed', async () => {
    await setupInvoices({
      slots: {
        lineItemFormatting: (ctx) => ctx.lines.map((l) => ({ ...l, amount: Money.of(1, 'USD') })),
      },
    })
    await expect(issue({ customerId: 'user_1', lines: [line(100_00)] })).rejects.toThrow(
      /may not change what is owed/,
    )
  })
})
