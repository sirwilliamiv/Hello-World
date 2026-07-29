import { describe, expect, it } from 'vitest'
import { Money } from '@forge/kernel-money'
import { getInvoice, issue, listInvoices, voidInvoice } from '../invoice.js'
import { applyPayment } from '../payments.js'
import { checkOverdueInvoices } from '../overdue.js'
import { anonymizeInvoices, exportInvoices } from '../privacy.js'
import { requiresApproval } from '../agent.js'
import { InvoiceAlreadyVoidError, InvoiceNotEmptyError, InvoiceNotFoundError } from '../errors.js'
import { SQL } from '../db/postgres.js'
import { bus, paymentSucceededEvent, setupInvoices } from '../testing/harness.js'
import { loadCapability, publishedPayloadSchema, validateAgainstSchema } from '../testing/json-schema.js'

const spec = loadCapability('catalog/pay/pay.invoices.capability.json')
const line = (minor: number) => ({ description: 'Consulting', unitAmount: Money.of(minor, 'USD') })

describe('issue', () => {
  it('publishes invoice.created satisfying the declared contract', async () => {
    setupInvoices()
    const invoice = await issue({ customerId: 'user_1', lines: [line(9_900)] })
    const created = bus.published('invoice.created')
    expect(created).toHaveLength(1)
    expect(created[0]?.payload).toMatchObject({
      invoice_id: invoice.id,
      number: 'INV-2026-00001',
      total_minor: 9_900,
      currency: 'USD',
      legal_entity: 'Acme Trading Ltd',
    })
    expect(
      validateAgainstSchema(publishedPayloadSchema(spec, 'invoice.created'), created[0]?.payload),
    ).toEqual([])
  })

  it('rejects an invoice with no lines', async () => {
    setupInvoices()
    await expect(issue({ customerId: 'user_1', lines: [] })).rejects.toBeInstanceOf(
      InvoiceNotEmptyError,
    )
  })

  it('rejects mixed currencies', async () => {
    setupInvoices()
    await expect(
      issue({
        customerId: 'user_1',
        lines: [line(100), { description: 'x', unitAmount: Money.of(100, 'EUR') }],
      }),
    ).rejects.toThrow(/share a currency/)
  })

  it('rejects a fractional quantity that is not expressed in thousandths', async () => {
    setupInvoices()
    await expect(
      issue({
        customerId: 'user_1',
        lines: [{ description: 'x', quantity: 1.5, unitAmount: Money.of(100, 'USD') }],
      }),
    ).rejects.toThrow(/integer/)
  })

  it('keeps every amount an integer number of minor units', async () => {
    const h = setupInvoices()
    await issue({
      customerId: 'user_1',
      lines: [
        { description: 'a', quantityMilli: 333, unitAmount: Money.of(999, 'USD') },
        { description: 'b', quantityMilli: 1, unitAmount: Money.of(1, 'USD') },
      ],
    })
    const row = h.store.state.invoices[0]
    for (const value of [row?.subtotalMinor, row?.taxMinor, row?.totalMinor]) {
      expect(Number.isSafeInteger(value)).toBe(true)
    }
    for (const l of h.store.state.lines) {
      expect(Number.isSafeInteger(l.amountMinor)).toBe(true)
    }
  })

  it('adds tax to the total without touching the subtotal', async () => {
    setupInvoices()
    const invoice = await issue({
      customerId: 'user_1',
      lines: [{ description: 'a', unitAmount: Money.of(10_000, 'USD'), taxAmount: Money.of(2_000, 'USD') }],
    })
    expect(invoice.subtotal.amountMinor).toBe(10_000)
    expect(invoice.tax.amountMinor).toBe(2_000)
    expect(invoice.total.amountMinor).toBe(12_000)
  })
})

describe('paymentTerms slot', () => {
  it('accepts a number of days', async () => {
    setupInvoices({ slots: { paymentTerms: () => 7 } })
    const invoice = await issue({ customerId: 'user_1', lines: [line(100)] })
    expect(invoice.dueAt.toISOString()).toBe('2026-07-08T09:00:00.000Z')
  })

  it('accepts an explicit date and can see the default', async () => {
    let seenDefault: string | null = null
    setupInvoices({
      slots: {
        paymentTerms: (ctx) => {
          seenDefault = ctx.defaultDueAt().toISOString()
          return new Date('2026-12-25T00:00:00.000Z')
        },
      },
    })
    const invoice = await issue({ customerId: 'user_1', lines: [line(100)] })
    expect(seenDefault).toBe('2026-07-31T09:00:00.000Z')
    expect(invoice.dueAt.toISOString()).toBe('2026-12-25T00:00:00.000Z')
  })

  it('is bypassed by an explicit dueAt on the input', async () => {
    setupInvoices({ slots: { paymentTerms: () => 7 } })
    const invoice = await issue({
      customerId: 'user_1',
      dueAt: new Date('2026-08-15T00:00:00.000Z'),
      lines: [line(100)],
    })
    expect(invoice.dueAt.toISOString()).toBe('2026-08-15T00:00:00.000Z')
  })
})

describe('void', () => {
  it('issues a credit note for the outstanding amount and keeps the number', async () => {
    const h = setupInvoices()
    const invoice = await issue({ customerId: 'user_1', lines: [line(40_000)] })

    const note = await voidInvoice({ id: invoice.id }, 'duplicate of INV-2026-00007')

    expect(note.amount.amountMinor).toBe(40_000)
    expect(note.reason).toBe('duplicate of INV-2026-00007')

    const after = await getInvoice(invoice.id)
    expect(after?.status).toBe('void')
    expect(after?.number).toBe('INV-2026-00001')
    expect(after?.total.amountMinor).toBe(40_000) // amounts are never edited
    expect(h.store.state.creditNotes).toHaveLength(1)

    const voided = bus.published('invoice.voided')
    expect(voided).toHaveLength(1)
    expect(
      validateAgainstSchema(publishedPayloadSchema(spec, 'invoice.voided'), voided[0]?.payload),
    ).toEqual([])
  })

  it('does not return the number to the sequence', async () => {
    const h = setupInvoices()
    const first = await issue({ customerId: 'user_1', lines: [line(100)] })
    await voidInvoice({ id: first.id }, 'issued in error')
    const second = await issue({ customerId: 'user_1', lines: [line(100)] })

    expect(second.number).toBe('INV-2026-00002')
    expect(h.store.sequenceValue('Acme Trading Ltd', '2026')).toBe(2)
  })

  it('refuses to void twice, or to void a settled invoice', async () => {
    setupInvoices()
    const invoice = await issue({ customerId: 'user_1', lines: [line(100)] })
    await voidInvoice({ id: invoice.id }, 'first')
    await expect(voidInvoice({ id: invoice.id }, 'second')).rejects.toBeInstanceOf(
      InvoiceAlreadyVoidError,
    )

    const paidInvoice = await issue({ customerId: 'user_1', lines: [line(500)] })
    await applyPayment(
      paymentSucceededEvent({ chargeId: 'chg_1', invoiceId: paidInvoice.id, amountMinor: 500 }),
    )
    await expect(voidInvoice({ id: paidInvoice.id }, 'nope')).rejects.toThrow(/refund the payment/)
  })

  it('refuses an unknown invoice and an empty reason', async () => {
    setupInvoices()
    await expect(voidInvoice({ id: 'nope' }, 'reason')).rejects.toBeInstanceOf(InvoiceNotFoundError)
    const invoice = await issue({ customerId: 'user_1', lines: [line(100)] })
    await expect(voidInvoice({ id: invoice.id }, '  ')).rejects.toThrow(/requires a reason/)
  })
})

describe('overdue sweep', () => {
  it('publishes invoice.overdue for unpaid invoices past their due date', async () => {
    setupInvoices({ paymentTermsDays: 10 })
    const a = await issue({ customerId: 'user_1', lines: [line(1_000)] })
    const b = await issue({ customerId: 'user_2', lines: [line(2_000)] })
    await applyPayment(paymentSucceededEvent({ chargeId: 'c', invoiceId: b.id, amountMinor: 2_000 }))

    const result = await checkOverdueInvoices(new Date('2026-07-20T09:00:00.000Z'))

    expect(result.published).toBe(1)
    const overdue = bus.published('invoice.overdue')
    expect(overdue[0]?.payload).toMatchObject({
      invoice_id: a.id,
      days_overdue: 9,
      outstanding_minor: 1_000,
    })
    expect(
      validateAgainstSchema(publishedPayloadSchema(spec, 'invoice.overdue'), overdue[0]?.payload),
    ).toEqual([])
  })
})

describe('privacy handlers', () => {
  it('anonymises rather than deletes, so the sequence stays gapless', async () => {
    const h = setupInvoices()
    await issue({ customerId: 'user_1', lines: [line(100)] })
    await issue({ customerId: 'user_1', lines: [line(200)] })

    expect(await exportInvoices('user_1')).toHaveLength(2)
    const affected = await anonymizeInvoices('user_1')

    expect(affected).toBe(2)
    expect(h.store.state.invoices).toHaveLength(2)
    expect(h.store.state.invoices.map((i) => i.number)).toEqual([
      'INV-2026-00001',
      'INV-2026-00002',
    ])
    expect(h.store.state.invoices.every((i) => i.customerId.startsWith('anon_'))).toBe(true)
    expect(await listInvoices('user_1')).toHaveLength(0)
  })

  it('uses the strategy the specification declares', () => {
    const owns = spec['owns'] as { name: string; privacy?: { deletion_strategy: string } }[]
    expect(owns.find((o) => o.name === 'Invoice')?.privacy?.deletion_strategy).toBe('anonymize')
    expect(owns.find((o) => o.name === 'Receipt')?.privacy?.deletion_strategy).toBe('anonymize')
  })
})

describe('agent classification', () => {
  it('marks issue as agent-callable with approval, and void as not agent-callable', () => {
    expect(issue.agent).toMatchObject({
      capability: 'pay.invoices',
      name: 'issue',
      agentCallable: true,
      consequence: 'external_communication',
    })
    expect(voidInvoice.agent.agentCallable).toBe(false)
    expect(requiresApproval(voidInvoice)).toBe(false)
  })

  it('matches what the capability specification declares', () => {
    const exposes = spec['exposes'] as { name: string; agent_callable?: boolean; consequence?: string }[]
    expect(exposes.find((e) => e.name === 'issue')?.agent_callable).toBe(true)
    expect(exposes.find((e) => e.name === 'issue')?.consequence).toBe('external_communication')
    expect(exposes.find((e) => e.name === 'void')?.agent_callable).toBe(false)
  })
})

describe('production statements', () => {
  it('changes the balance relatively, so a concurrent payment cannot be lost', () => {
    expect(SQL.applyInvoiceDelta).toMatch(/paid_minor\s+= paid_minor \+ \$2/)
    expect(SQL.applyInvoiceDelta).toMatch(/credited_minor = credited_minor \+ \$3/)
  })

  it('touches only tables pay.invoices owns', () => {
    const owned = new Set(['invoice', 'invoice_line', 'invoice_sequence', 'receipt', 'credit_note'])
    const referenced = new Set<string>()
    for (const statement of Object.values(SQL)) {
      for (const m of statement.matchAll(/\b(?:FROM|INTO|UPDATE|JOIN)\s+(\w+)/g)) {
        referenced.add(m[1] as string)
      }
    }
    for (const table of referenced) {
      expect(owned.has(table), `${table} is not owned by pay.invoices`).toBe(true)
    }
  })

  it('never edits an issued invoice’s amounts or number', () => {
    for (const statement of Object.values(SQL)) {
      if (!/^\s*UPDATE invoice\b/m.test(statement)) continue
      expect(statement).not.toMatch(/SET[\s\S]*\bnumber\s*=/)
      expect(statement).not.toMatch(/\btotal_minor\s*=/)
      expect(statement).not.toMatch(/\bsubtotal_minor\s*=/)
      expect(statement).not.toMatch(/\bsequence_value\s*=/)
    }
  })
})
