import type {
  CreditNoteRow,
  InvoiceLineRow,
  InvoiceRow,
  InvoiceStore,
  InvoiceTx,
  ReceiptRow,
} from './port.js'
import type { InvoiceStatus } from '../types.js'

/**
 * The production `InvoiceStore`, backed by @forge/kernel-data's transaction
 * handle. Statements are parameterised and touch only pay.invoices' own tables.
 */

interface KernelTx {
  execute<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<R[]>
}

interface KernelDataModule {
  transaction<T>(fn: (tx: KernelTx) => Promise<T>): Promise<T>
}

let kernelData: KernelDataModule | null = null

async function loadKernelData(): Promise<KernelDataModule> {
  kernelData ??= (await import('@forge/kernel-data')) as unknown as KernelDataModule
  return kernelData
}

export const SQL = {
  /**
   * THE GAPLESS-NUMBERING STATEMENT.
   *
   * One statement, so there is no window between reading and writing. `ON
   * CONFLICT … DO UPDATE` takes a row-level exclusive lock that is held until the
   * transaction ends, so a second concurrent issue blocks here and resumes with
   * the incremented value — never the same one. Because it is ordinary
   * transactional DML (and not `nextval`), rolling back restores the previous
   * value and the number is returned to the pool rather than burned.
   */
  allocateSequence: `
    INSERT INTO invoice_sequence (legal_entity, period, last_value)
    VALUES ($1, $2, 1)
    ON CONFLICT (legal_entity, period)
    DO UPDATE SET last_value = invoice_sequence.last_value + 1
    RETURNING last_value`,
  peekSequence: 'SELECT last_value FROM invoice_sequence WHERE legal_entity = $1 AND period = $2',

  insertInvoice: `
    INSERT INTO invoice (
      id, legal_entity, period, sequence_value, number, customer_id, currency,
      subtotal_minor, tax_minor, total_minor, paid_minor, credited_minor, status,
      issued_at, due_at, voided_at, document_template, document_template_version, metadata
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
    RETURNING *`,
  insertInvoiceLine: `
    INSERT INTO invoice_line (
      id, invoice_id, position, description, quantity_milli, unit_amount_minor,
      amount_minor, tax_minor, metadata
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
  selectInvoiceById: 'SELECT * FROM invoice WHERE id = $1',
  selectInvoiceByNumber: 'SELECT * FROM invoice WHERE legal_entity = $1 AND number = $2',
  selectInvoiceByChargeId: `
    SELECT i.* FROM invoice i
    JOIN receipt r ON r.invoice_id = i.id
    WHERE r.charge_id = $1
    LIMIT 1`,
  selectInvoiceLines: 'SELECT * FROM invoice_line WHERE invoice_id = $1 ORDER BY position',
  selectInvoicesForCustomer: 'SELECT * FROM invoice WHERE customer_id = $1 ORDER BY issued_at DESC',
  selectOverdueInvoices: `
    SELECT * FROM invoice
     WHERE status IN ('open', 'part_paid')
       AND due_at < $1
     ORDER BY due_at`,
  /**
   * Relative, so two concurrent payments against one invoice cannot lose an
   * update, and the status is derived in the same statement rather than from a
   * value the caller read a moment ago.
   */
  applyInvoiceDelta: `
    UPDATE invoice
       SET paid_minor     = paid_minor + $2,
           credited_minor = credited_minor + $3,
           status = CASE
                      WHEN status = 'void' THEN 'void'
                      WHEN paid_minor + $2 + credited_minor + $3 >= total_minor THEN 'paid'
                      WHEN paid_minor + $2 + credited_minor + $3 > 0 THEN 'part_paid'
                      ELSE 'open'
                    END
     WHERE id = $1
    RETURNING *`,
  markInvoiceVoid: `
    UPDATE invoice
       SET status = 'void', voided_at = $2
     WHERE id = $1
    RETURNING *`,
  setInvoiceDocumentVersion: `
    UPDATE invoice
       SET document_template = $2, document_template_version = $3
     WHERE id = $1`,

  /**
   * THE IDEMPOTENT PAYMENT-APPLICATION STATEMENT.
   *
   * A redelivered `payment.succeeded` produces the same (invoice_id, charge_id),
   * conflicts with the unique index, inserts nothing, and returns no row — so the
   * caller skips the balance update and publishes nothing.
   */
  insertReceipt: `
    INSERT INTO receipt (id, invoice_id, charge_id, amount_minor, currency, issued_at, document_template_version)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (invoice_id, charge_id) DO NOTHING
    RETURNING *`,
  selectReceipts: 'SELECT * FROM receipt WHERE invoice_id = $1 ORDER BY issued_at',

  insertCreditNote: `
    INSERT INTO credit_note (id, invoice_id, amount_minor, currency, reason, refund_id, issued_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (invoice_id, refund_id) DO NOTHING
    RETURNING *`,
  selectCreditNotes: 'SELECT * FROM credit_note WHERE invoice_id = $1 ORDER BY issued_at',

  // Anonymisation, not deletion: the sequence stays gapless and the ledger
  // reconciles. Amounts and numbers are untouched.
  anonymiseCustomer: `
    UPDATE invoice
       SET customer_id = $2, metadata = '{}'::jsonb
     WHERE customer_id = $1`,
} as const

function toInvoiceRow(raw: Record<string, unknown>): InvoiceRow {
  return {
    id: String(raw['id']),
    legalEntity: String(raw['legal_entity']),
    period: String(raw['period']),
    sequenceValue: Number(raw['sequence_value']),
    number: String(raw['number']),
    customerId: String(raw['customer_id']),
    currency: String(raw['currency']),
    subtotalMinor: Number(raw['subtotal_minor']),
    taxMinor: Number(raw['tax_minor']),
    totalMinor: Number(raw['total_minor']),
    paidMinor: Number(raw['paid_minor']),
    creditedMinor: Number(raw['credited_minor']),
    status: String(raw['status']) as InvoiceStatus,
    issuedAt: new Date(String(raw['issued_at'])),
    dueAt: new Date(String(raw['due_at'])),
    voidedAt: raw['voided_at'] === null ? null : new Date(String(raw['voided_at'])),
    documentTemplate: raw['document_template'] === null ? null : String(raw['document_template']),
    documentTemplateVersion:
      raw['document_template_version'] === null ? null : String(raw['document_template_version']),
    metadata: (raw['metadata'] ?? {}) as Record<string, string>,
  }
}

function toLineRow(raw: Record<string, unknown>): InvoiceLineRow {
  return {
    id: String(raw['id']),
    invoiceId: String(raw['invoice_id']),
    position: Number(raw['position']),
    description: String(raw['description']),
    quantityMilli: Number(raw['quantity_milli']),
    unitAmountMinor: Number(raw['unit_amount_minor']),
    amountMinor: Number(raw['amount_minor']),
    taxMinor: Number(raw['tax_minor']),
    metadata: (raw['metadata'] ?? {}) as Record<string, string>,
  }
}

function toReceiptRow(raw: Record<string, unknown>): ReceiptRow {
  return {
    id: String(raw['id']),
    invoiceId: String(raw['invoice_id']),
    chargeId: String(raw['charge_id']),
    amountMinor: Number(raw['amount_minor']),
    currency: String(raw['currency']),
    issuedAt: new Date(String(raw['issued_at'])),
    documentTemplateVersion:
      raw['document_template_version'] === null ? null : String(raw['document_template_version']),
  }
}

function toCreditNoteRow(raw: Record<string, unknown>): CreditNoteRow {
  return {
    id: String(raw['id']),
    invoiceId: String(raw['invoice_id']),
    amountMinor: Number(raw['amount_minor']),
    currency: String(raw['currency']),
    reason: String(raw['reason']),
    refundId: raw['refund_id'] === null ? null : String(raw['refund_id']),
    issuedAt: new Date(String(raw['issued_at'])),
  }
}

function makeTx(tx: KernelTx): InvoiceTx {
  const one = <T>(rows: Record<string, unknown>[], map: (r: Record<string, unknown>) => T): T | null =>
    rows.length === 0 || rows[0] === undefined ? null : map(rows[0])

  return {
    async allocateInvoiceNumber(legalEntity, period) {
      const rows = await tx.execute(SQL.allocateSequence, [legalEntity, period])
      const value = rows[0]?.['last_value']
      if (value === undefined) {
        throw new Error('allocateInvoiceNumber returned no row; the sequence was not allocated')
      }
      return Number(value)
    },
    async peekSequence(legalEntity, period) {
      const rows = await tx.execute(SQL.peekSequence, [legalEntity, period])
      return rows[0] === undefined ? 0 : Number(rows[0]['last_value'])
    },
    async insertInvoice(row) {
      const rows = await tx.execute(SQL.insertInvoice, [
        row.id,
        row.legalEntity,
        row.period,
        row.sequenceValue,
        row.number,
        row.customerId,
        row.currency,
        row.subtotalMinor,
        row.taxMinor,
        row.totalMinor,
        row.paidMinor,
        row.creditedMinor,
        row.status,
        row.issuedAt,
        row.dueAt,
        row.voidedAt,
        row.documentTemplate,
        row.documentTemplateVersion,
        JSON.stringify(row.metadata),
      ])
      const mapped = one(rows, toInvoiceRow)
      if (mapped === null) throw new Error('insertInvoice returned no row')
      return mapped
    },
    async insertInvoiceLines(rows) {
      for (const row of rows) {
        await tx.execute(SQL.insertInvoiceLine, [
          row.id,
          row.invoiceId,
          row.position,
          row.description,
          row.quantityMilli,
          row.unitAmountMinor,
          row.amountMinor,
          row.taxMinor,
          JSON.stringify(row.metadata),
        ])
      }
    },
    async findInvoiceById(id) {
      return one(await tx.execute(SQL.selectInvoiceById, [id]), toInvoiceRow)
    },
    async findInvoiceByNumber(legalEntity, number) {
      return one(await tx.execute(SQL.selectInvoiceByNumber, [legalEntity, number]), toInvoiceRow)
    },
    async findInvoiceByChargeId(chargeId) {
      return one(await tx.execute(SQL.selectInvoiceByChargeId, [chargeId]), toInvoiceRow)
    },
    async listInvoiceLines(invoiceId) {
      return (await tx.execute(SQL.selectInvoiceLines, [invoiceId])).map(toLineRow)
    },
    async listInvoicesForCustomer(customerId) {
      return (await tx.execute(SQL.selectInvoicesForCustomer, [customerId])).map(toInvoiceRow)
    },
    async listOverdueInvoices(asOf) {
      return (await tx.execute(SQL.selectOverdueInvoices, [asOf])).map(toInvoiceRow)
    },
    async applyInvoiceDelta(id, paidDelta, creditedDelta) {
      const rows = await tx.execute(SQL.applyInvoiceDelta, [id, paidDelta, creditedDelta])
      const mapped = one(rows, toInvoiceRow)
      if (mapped === null) throw new Error(`no invoice ${id}`)
      return mapped
    },
    async markInvoiceVoid(id, voidedAt) {
      const rows = await tx.execute(SQL.markInvoiceVoid, [id, voidedAt])
      const mapped = one(rows, toInvoiceRow)
      if (mapped === null) throw new Error(`no invoice ${id}`)
      return mapped
    },
    async setInvoiceDocumentVersion(id, template, version) {
      await tx.execute(SQL.setInvoiceDocumentVersion, [id, template, version])
    },
    async insertReceiptIfAbsent(row) {
      const rows = await tx.execute(SQL.insertReceipt, [
        row.id,
        row.invoiceId,
        row.chargeId,
        row.amountMinor,
        row.currency,
        row.issuedAt,
        row.documentTemplateVersion,
      ])
      return one(rows, toReceiptRow)
    },
    async listReceipts(invoiceId) {
      return (await tx.execute(SQL.selectReceipts, [invoiceId])).map(toReceiptRow)
    },
    async insertCreditNoteIfAbsent(row) {
      const rows = await tx.execute(SQL.insertCreditNote, [
        row.id,
        row.invoiceId,
        row.amountMinor,
        row.currency,
        row.reason,
        row.refundId,
        row.issuedAt,
      ])
      return one(rows, toCreditNoteRow)
    },
    async listCreditNotes(invoiceId) {
      return (await tx.execute(SQL.selectCreditNotes, [invoiceId])).map(toCreditNoteRow)
    },
    async anonymiseCustomer(customerId, anonymousId) {
      const rows = await tx.execute(SQL.anonymiseCustomer, [customerId, anonymousId])
      return rows.length
    },
  }
}

export function createPostgresStore(): InvoiceStore {
  return {
    async transaction<T>(fn: (tx: InvoiceTx) => Promise<T>): Promise<T> {
      const kd = await loadKernelData()
      return kd.transaction((tx) => fn(makeTx(tx)))
    },
  }
}
