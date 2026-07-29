import { describe, expect, it } from 'vitest'
import { Money } from '@forge/kernel-money'
import { InvoiceList } from '../InvoiceList.js'
import { walk, type TestElement } from '../testing/doubles/jsx-runtime.js'
import type { Invoice } from '../types.js'

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  const usd = (n: number) => Money.of(n, 'USD')
  return {
    id: 'inv_1',
    legalEntity: 'Acme Trading Ltd',
    period: '2026',
    sequence: 1,
    number: 'INV-2026-00001',
    customerId: 'user_1',
    subtotal: usd(10_000),
    tax: usd(0),
    total: usd(10_000),
    paid: usd(0),
    credited: usd(0),
    outstanding: usd(10_000),
    status: 'open',
    issuedAt: new Date('2026-07-01T09:00:00Z'),
    dueAt: new Date('2026-07-31T09:00:00Z'),
    voidedAt: null,
    documentTemplate: null,
    documentTemplateVersion: null,
    metadata: {},
    lines: [],
    ...overrides,
  }
}

function nodes(element: unknown): TestElement[] {
  const out: TestElement[] = []
  walk(element, (n) => out.push(n))
  return out
}

describe('InvoiceList', () => {
  it('renders a row per invoice with its number and amounts', () => {
    const tree = InvoiceList({ invoices: [invoice(), invoice({ id: 'inv_2', number: 'INV-2026-00002' })] })
    const rows = nodes(tree).filter((n) => n.type === 'tr' && n.props['data-invoice-id'] !== undefined)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.props['data-invoice-id'])).toEqual(['inv_1', 'inv_2'])

    const text = JSON.stringify(nodes(tree).map((n) => n.props))
    expect(text).toContain('INV-2026-00001')
    expect(text).toContain('100.00 USD')
  })

  it('renders an empty state rather than an empty table', () => {
    const tree = InvoiceList({ invoices: [], emptyMessage: 'Nothing billed yet.' })
    const all = nodes(tree)
    expect(all.some((n) => n.type === 'table')).toBe(false)
    expect(JSON.stringify(all.map((n) => n.props))).toContain('Nothing billed yet.')
  })

  it('filters by status', () => {
    const tree = InvoiceList({
      invoices: [invoice(), invoice({ id: 'inv_2', status: 'paid' })],
      statusFilter: ['paid'],
    })
    const rows = nodes(tree).filter((n) => n.props['data-invoice-id'] !== undefined)
    expect(rows.map((r) => r.props['data-invoice-id'])).toEqual(['inv_2'])
  })

  it('formats money through the supplied formatter and never computes it', () => {
    const seen: number[] = []
    InvoiceList({
      invoices: [invoice()],
      formatMoney: (m) => {
        seen.push((m as unknown as { minor: number }).amountMinor)
        return 'formatted'
      },
    })
    expect(seen).toEqual([10_000, 10_000])
  })
})
