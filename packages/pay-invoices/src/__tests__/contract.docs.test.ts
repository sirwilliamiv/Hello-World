import { describe, expect, it } from 'vitest'
import { Money } from '@forge/kernel-money'
import { getInvoice, issue } from '../invoice.js'
import { renderInvoice } from '../render.js'
import { INVOICE_TEMPLATE_ID } from '../config.js'
import { docs, setupInvoices } from '../testing/harness.js'
import { loadCapability } from '../testing/json-schema.js'

/**
 * Contract test with docs.generation:
 * "an invoice is rendered after its template is updated → the rendering uses the
 *  template version pinned at issue time, so a reissued historical invoice is
 *  byte-identical".
 */

const line = (minor: number) => ({ description: 'Consulting', unitAmount: Money.of(minor, 'USD') })

describe('contract: pay.invoices × docs.generation', () => {
  it('renders a document at issue time and pins the version it used', async () => {
    const h = setupInvoices()
    const invoice = await issue({ customerId: 'user_1', lines: [line(12_345)] })

    expect(docs.renderCount()).toBe(1)
    expect(invoice.documentTemplate).toBe(INVOICE_TEMPLATE_ID)
    expect(invoice.documentTemplateVersion).toBe('v1')
    expect(h.store.state.invoices[0]?.documentTemplateVersion).toBe('v1')
  })

  it('reissues byte-identically after the template has been edited', async () => {
    setupInvoices()
    const issued = await issue({ customerId: 'user_1', lines: [line(12_345)] })
    const atIssue = await renderInvoice(issued)

    // The client edits the invoice template. docs.generation's TemplateVersion
    // table is append-only, so this publishes v2 and leaves v1 intact.
    const v2 = docs.publishTemplateVersion(INVOICE_TEMPLATE_ID, 'a completely different layout')
    expect(v2).toBe('v2')

    const stored = await getInvoice(issued.id)
    const reissued = await renderInvoice(stored as NonNullable<typeof stored>)

    expect(reissued.templateVersion).toBe('v1')
    expect(reissued.id).toBe(atIssue.id)
    expect(Buffer.from(reissued.bytes ?? new Uint8Array())).toEqual(
      Buffer.from(atIssue.bytes ?? new Uint8Array()),
    )
  })

  it('a NEW invoice issued after the edit picks up the new version', async () => {
    setupInvoices()
    const before = await issue({ customerId: 'user_1', lines: [line(100)] })
    docs.publishTemplateVersion(INVOICE_TEMPLATE_ID, 'a completely different layout')
    const after = await issue({ customerId: 'user_1', lines: [line(100)] })

    expect(before.documentTemplateVersion).toBe('v1')
    expect(after.documentTemplateVersion).toBe('v2')
  })

  it('declares docs.generation as a requirement, which is why the pin is possible', () => {
    const spec = loadCapability('catalog/pay/pay.invoices.capability.json')
    const requires = spec['requires'] as { id: string }[]
    expect(requires.map((r) => r.id)).toContain('docs.generation')
  })
})

describe('lineItemFormatting slot', () => {
  it('may reorder and relabel lines', async () => {
    setupInvoices({
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
    expect(docs.renderCount()).toBe(1)
  })

  it('may not change what is owed', async () => {
    setupInvoices({
      slots: {
        lineItemFormatting: (ctx) =>
          ctx.lines.map((l) => ({ ...l, amount: Money.of(1, 'USD') })),
      },
    })
    await expect(issue({ customerId: 'user_1', lines: [line(100_00)] })).rejects.toThrow(
      /may not change what is owed/,
    )
  })
})
