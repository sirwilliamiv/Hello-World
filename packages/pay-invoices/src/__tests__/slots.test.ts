import { describe, expect, it } from 'vitest'
import { publishTemplateVersion } from '@forge/docs-generation'
import { Money } from '@forge/kernel-money'
import { INVOICE_TEMPLATE_ID } from '../config.js'
import { getInvoice, issue } from '../invoice.js'
import { renderInvoice } from '../render.js'
import type { InvoiceSlots } from '../slots.js'
import { LEGAL_ENTITY, setupInvoices } from '../testing/harness.js'

/**
 * The slot contract: every slot context exposes `proceed()`, returning exactly
 * what this capability does with no slot implemented
 * (schemas/capability.schema.json, `$defs.slot.signature`).
 *
 * Each slot is covered three ways:
 *   - the DEFAULT path — the seeded stub, `async (ctx) => ctx.proceed()`, which
 *     must be indistinguishable from having no slot at all;
 *   - the OVERRIDE path — a slot that returns something else, which must be honoured;
 *   - and, for `numberingScheme`, that neither path can touch the sequence.
 */

const line = (minor: number) => ({ description: 'Consulting', unitAmount: Money.of(minor, 'USD') })

/* ------------------------------------------------------------ numberingScheme */

describe('numberingScheme: proceed()', () => {
  it('defaults to the number the configured token scheme produces', async () => {
    // Byte-for-byte the stub Forge seeds into src/slots/pay.invoices/.
    const h = await setupInvoices({ slots: { numberingScheme: async (ctx) => ctx.proceed() } })

    const invoice = await issue({ customerId: 'user_1', lines: [line(100)] })

    // Identical to the no-slot path asserted in numbering.test.ts.
    expect(invoice.number).toBe('INV-2026-00001')
    expect(invoice.sequence).toBe(1)
    expect(h.store.sequenceValue(LEGAL_ENTITY, '2026')).toBe(1)
  })

  it('follows the configured scheme rather than restating it', async () => {
    await setupInvoices({
      numberingScheme: '{YY}{MM}/{SEQ:3}',
      slots: { numberingScheme: async (ctx) => ctx.proceed() },
    })
    const invoice = await issue({ customerId: 'user_1', lines: [line(100)] })
    expect(invoice.number).toBe('2607/001')
  })

  it('is overridden by whatever the slot returns instead', async () => {
    const h = await setupInvoices({
      slots: {
        numberingScheme: (ctx) => `ACME/${ctx.period}/${String(ctx.sequence).padStart(6, '0')}`,
      },
    })

    const invoice = await issue({ customerId: 'user_1', lines: [line(100)] })

    expect(invoice.number).toBe('ACME/2026/000001')
    expect(h.store.state.invoices[0]?.number).toBe('ACME/2026/000001')
  })
})

describe('numberingScheme: proceed() cannot break gaplessness', () => {
  it('allocates nothing, however the slot uses it', async () => {
    const calls: string[][] = []
    const h = await setupInvoices({
      slots: {
        numberingScheme: (ctx) => {
          // A slot doing its worst: calling proceed() repeatedly and then
          // numbering the invoice from a sequence value of its own invention.
          calls.push([ctx.proceed(), ctx.proceed(), ctx.proceed()])
          return `INV-2026-${String(ctx.sequence + 1_000).padStart(5, '0')}`
        },
      },
    })

    const results = await Promise.all(
      Array.from({ length: 30 }, () => issue({ customerId: 'u', lines: [line(100)] })),
    )

    // proceed() is nullary and closes over the value this transaction already
    // allocated, so three calls consumed nothing and returned the same string.
    expect(calls).toHaveLength(30)
    for (const [first, second, third] of calls) {
      expect(second).toBe(first)
      expect(third).toBe(first)
    }
    // …and one distinct default number per invoice: no two slots saw one value.
    expect(new Set(calls.map(([first]) => first)).size).toBe(30)

    // The ledger's sequence is 1..30, gapless, whatever the slot returned.
    const sequences = results.map((r) => r.sequence).sort((a, b) => a - b)
    expect(sequences).toEqual(Array.from({ length: 30 }, (_, i) => i + 1))
    expect(h.store.state.invoices.map((r) => r.sequenceValue).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 30 }, (_, i) => i + 1),
    )
    expect(h.store.sequenceValue(LEGAL_ENTITY, '2026')).toBe(30)
    // The concurrency was real: the allocations queued on the counter's row lock.
    expect(h.store.stats.sequenceLockWaits).toBeGreaterThan(0)
  })

  it('leaves the sequence unburned when the stub path rolls back', async () => {
    // proceed() runs after the allocation, inside the same transaction; a failure
    // downstream of it still takes the allocation back.
    const h = await setupInvoices({
      slots: { numberingScheme: async (ctx) => ctx.proceed() },
    })

    await issue({ customerId: 'u', lines: [line(100)] })
    await expect(issue({ customerId: 'u', lines: [] })).rejects.toThrow()
    const third = await issue({ customerId: 'u', lines: [line(100)] })

    expect(third.number).toBe('INV-2026-00002')
    expect(h.store.sequenceValue(LEGAL_ENTITY, '2026')).toBe(2)
  })
})

/* --------------------------------------------------------------- paymentTerms */

describe('paymentTerms: proceed()', () => {
  it('defaults to the due date the configured payment_terms_days produces', async () => {
    await setupInvoices({
      paymentTermsDays: 10,
      slots: { paymentTerms: async (ctx) => ctx.proceed() },
    })

    const invoice = await issue({ customerId: 'user_1', lines: [line(100)] })

    // Clock is 2026-07-01T09:00:00Z; ten days on, and identical to no slot.
    expect(invoice.dueAt.toISOString()).toBe('2026-07-11T09:00:00.000Z')
  })

  it("defaults to the invoice's own terms when the input carries them", async () => {
    await setupInvoices({
      paymentTermsDays: 30,
      slots: { paymentTerms: async (ctx) => ctx.proceed() },
    })

    const invoice = await issue({ customerId: 'user_1', paymentTermsDays: 3, lines: [line(100)] })

    expect(invoice.dueAt.toISOString()).toBe('2026-07-04T09:00:00.000Z')
  })

  it('is overridden by a date or a number of days the slot returns instead', async () => {
    await setupInvoices({
      slots: {
        // Net 60 for one customer, the configured terms for everyone else.
        paymentTerms: (ctx) => (ctx.customerId === 'user_vip' ? 60 : ctx.proceed()),
      },
    })

    const vip = await issue({ customerId: 'user_vip', lines: [line(100)] })
    const other = await issue({ customerId: 'user_1', lines: [line(100)] })

    expect(vip.dueAt.toISOString()).toBe('2026-08-30T09:00:00.000Z')
    expect(other.dueAt.toISOString()).toBe('2026-07-31T09:00:00.000Z')
  })
})

/* --------------------------------------------------------- lineItemFormatting */

/**
 * The lines only reach a rendering, never the stored row, so the assertion has to
 * be made on the rendered bytes. The template is republished to one that prints
 * them; docs.generation's version table is append-only, so this is an ordinary
 * client template edit rather than a test-only seam.
 */
const LINES_TEMPLATE = '<ul>{{#each lines}}<li>{{ description }}:{{ amountMinor }}</li>{{/each}}</ul>'

async function renderedLines(slots?: InvoiceSlots): Promise<string> {
  const h = await setupInvoices(slots === undefined ? {} : { slots })
  await publishTemplateVersion(h.docs.templateIds[INVOICE_TEMPLATE_ID] as string, LINES_TEMPLATE)

  const issued = await issue({
    customerId: 'user_1',
    lines: [
      { description: 'Consulting', unitAmount: Money.of(100, 'USD') },
      { description: 'Hosting', unitAmount: Money.of(200, 'USD') },
    ],
  })

  const stored = await getInvoice(issued.id)
  const document = await renderInvoice(stored as NonNullable<typeof stored>)
  return Buffer.from(h.docs.files.bytesOf(document.fileId)).toString('utf8')
}

describe('lineItemFormatting: proceed()', () => {
  it('defaults to the stored lines, unchanged and in position order', async () => {
    const withoutSlot = await renderedLines()
    const withStub = await renderedLines({ lineItemFormatting: async (ctx) => ctx.proceed() })

    // The seeded stub is indistinguishable from having no slot at all.
    expect(withStub).toBe(withoutSlot)
    expect(withStub).toContain('<li>Consulting:100</li><li>Hosting:200</li>')
  })

  it('is overridden by the lines the slot returns instead', async () => {
    const rendered = await renderedLines({
      lineItemFormatting: (ctx) =>
        [...ctx.proceed()].reverse().map((l) => ({ ...l, description: l.description.toUpperCase() })),
    })

    expect(rendered).toContain('<li>HOSTING:200</li><li>CONSULTING:100</li>')
  })
})
