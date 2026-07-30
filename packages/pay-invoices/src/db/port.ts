import type { InvoiceStatus } from '../types.js'

/**
 * The narrow persistence port for pay.invoices.
 *
 * Two methods carry the capability's headline guarantees, and both are single
 * atomic statements rather than read-then-write sequences:
 *
 *  - `allocateInvoiceNumber` — `INSERT … ON CONFLICT … DO UPDATE … RETURNING`,
 *    which takes a row lock held to the end of the transaction. Called INSIDE the
 *    invoice insert transaction, so a rollback returns the number.
 *  - `insertReceiptIfAbsent` — `INSERT … ON CONFLICT (invoice_id, charge_id)
 *    DO NOTHING RETURNING *`, which is what makes payment application idempotent
 *    against webhook redelivery.
 */

export interface InvoiceRow {
  id: string
  legalEntity: string
  period: string
  sequenceValue: number
  number: string
  customerId: string
  currency: string
  subtotalMinor: number
  taxMinor: number
  totalMinor: number
  paidMinor: number
  creditedMinor: number
  status: InvoiceStatus
  issuedAt: Date
  dueAt: Date
  voidedAt: Date | null
  documentTemplate: string | null
  documentTemplateVersion: string | null
  metadata: Record<string, string>
}

export interface InvoiceLineRow {
  id: string
  invoiceId: string
  position: number
  description: string
  quantityMilli: number
  unitAmountMinor: number
  amountMinor: number
  taxMinor: number
  metadata: Record<string, string>
}

export interface ReceiptRow {
  id: string
  invoiceId: string
  chargeId: string
  amountMinor: number
  currency: string
  issuedAt: Date
  documentTemplateVersion: string | null
}

export interface CreditNoteRow {
  id: string
  invoiceId: string
  amountMinor: number
  currency: string
  reason: string
  refundId: string | null
  issuedAt: Date
}

export interface InvoiceTx {
  /**
   * Atomically increments and returns the counter for (legalEntity, period).
   *
   * MUST be called inside the same transaction as the invoice insert. The row
   * lock it takes is what serialises concurrent issues; the transaction boundary
   * is what returns the number when the insert fails.
   */
  allocateInvoiceNumber(legalEntity: string, period: string): Promise<number>
  /** Current counter value without allocating. Diagnostics and tests only. */
  peekSequence(legalEntity: string, period: string): Promise<number>

  insertInvoice(row: InvoiceRow): Promise<InvoiceRow>
  insertInvoiceLines(rows: readonly InvoiceLineRow[]): Promise<void>
  findInvoiceById(id: string): Promise<InvoiceRow | null>
  findInvoiceByNumber(legalEntity: string, number: string): Promise<InvoiceRow | null>
  /** The invoice a charge paid, resolved through the receipt that recorded it. */
  findInvoiceByChargeId(chargeId: string): Promise<InvoiceRow | null>
  listInvoiceLines(invoiceId: string): Promise<InvoiceLineRow[]>
  listInvoicesForCustomer(customerId: string): Promise<InvoiceRow[]>
  listOverdueInvoices(asOf: Date): Promise<InvoiceRow[]>

  /**
   * Applies a RELATIVE change to the balance and recomputes the status, in one
   * statement. Relative rather than absolute on purpose: two concurrent payments
   * against one invoice would both read the same `paid_minor` and the second
   * absolute write would silently discard the first.
   *
   * An issued invoice's amounts (subtotal, tax, total, number) are never edited.
   */
  applyInvoiceDelta(id: string, paidDelta: number, creditedDelta: number): Promise<InvoiceRow>
  /** Sets status to `void` and records when. */
  markInvoiceVoid(id: string, voidedAt: Date): Promise<InvoiceRow>
  setInvoiceDocumentVersion(id: string, template: string, version: string): Promise<void>

  /** `ON CONFLICT (invoice_id, charge_id) DO NOTHING RETURNING *`. */
  insertReceiptIfAbsent(row: ReceiptRow): Promise<ReceiptRow | null>
  listReceipts(invoiceId: string): Promise<ReceiptRow[]>

  /** `ON CONFLICT (invoice_id, refund_id) DO NOTHING RETURNING *`. */
  insertCreditNoteIfAbsent(row: CreditNoteRow): Promise<CreditNoteRow | null>
  listCreditNotes(invoiceId: string): Promise<CreditNoteRow[]>

  anonymiseCustomer(customerId: string, anonymousId: string): Promise<number>
}

export interface InvoiceStore {
  transaction<T>(fn: (tx: InvoiceTx) => Promise<T>): Promise<T>
}
