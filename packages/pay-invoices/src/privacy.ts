import { requireInvoicesRuntime } from './config.js'
import { invoiceFromRows } from './invoice.js'
import { money } from './money.js'
import type { CreditNote, Invoice, Receipt } from './types.js'

/**
 * The export and deletion handlers named in the spec's `owns[].privacy` blocks.
 *
 * Every strategy here is `anonymize`, never `delete`, and the retention note in
 * the spec says why: deleting an invoice would put a gap in the sequence, which
 * is the exact failure the capability exists to prevent. Anonymising removes the
 * personal data and leaves the ledger intact.
 */

export async function exportInvoices(customerId: string): Promise<Invoice[]> {
  const rt = requireInvoicesRuntime()
  return rt.store.transaction(async (tx) => {
    const rows = await tx.listInvoicesForCustomer(customerId)
    const out: Invoice[] = []
    for (const row of rows) out.push(invoiceFromRows(row, await tx.listInvoiceLines(row.id)))
    return out
  })
}

export async function exportReceipts(customerId: string): Promise<Receipt[]> {
  const rt = requireInvoicesRuntime()
  return rt.store.transaction(async (tx) => {
    const invoices = await tx.listInvoicesForCustomer(customerId)
    const out: Receipt[] = []
    for (const invoice of invoices) {
      for (const r of await tx.listReceipts(invoice.id)) {
        out.push({
          id: r.id,
          invoiceId: r.invoiceId,
          chargeId: r.chargeId,
          amount: money(r.amountMinor, r.currency),
          issuedAt: r.issuedAt,
          documentTemplateVersion: r.documentTemplateVersion,
        })
      }
    }
    return out
  })
}

export async function exportCreditNotes(customerId: string): Promise<CreditNote[]> {
  const rt = requireInvoicesRuntime()
  return rt.store.transaction(async (tx) => {
    const invoices = await tx.listInvoicesForCustomer(customerId)
    const out: CreditNote[] = []
    for (const invoice of invoices) {
      for (const n of await tx.listCreditNotes(invoice.id)) {
        out.push({
          id: n.id,
          invoiceId: n.invoiceId,
          amount: money(n.amountMinor, n.currency),
          reason: n.reason,
          refundId: n.refundId,
          issuedAt: n.issuedAt,
        })
      }
    }
    return out
  })
}

/**
 * Deletion strategy `anonymize` for Invoice, Receipt, and CreditNote. Numbers,
 * amounts, and sequence positions are untouched.
 */
export async function anonymizeInvoices(customerId: string): Promise<number> {
  const rt = requireInvoicesRuntime()
  const anonymousId = `anon_${rt.newId('sub')}`
  return rt.store.transaction((tx) => tx.anonymiseCustomer(customerId, anonymousId))
}

export async function anonymizeReceipts(customerId: string): Promise<number> {
  return anonymizeInvoices(customerId)
}
