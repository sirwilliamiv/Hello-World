/**
 * @forge/pay-invoices — Invoices and Receipts (pay.invoices@1.0.0)
 *
 * Two invariants this package exists to hold:
 *
 *  1. INVOICE NUMBERING IS GAPLESS AND SEQUENTIAL PER LEGAL ENTITY. The counter
 *     is a row incremented by a single atomic statement inside the invoice insert
 *     transaction, so a rolled-back invoice does not burn a number and two
 *     concurrent inserts cannot share one. See `db/postgres.ts` (`SQL.allocateSequence`)
 *     and `invoice.ts` (`allocateAndInsert`).
 *
 *  2. PAYMENT APPLICATION IS IDEMPOTENT. A redelivered `payment.succeeded`
 *     conflicts with the unique index on (invoice_id, charge_id) over `receipt`
 *     and applies nothing. See `payments.ts`.
 */

// exposes: interface issue (agent_callable, external_communication)
export { issue, getInvoice, listInvoices } from './invoice.js'

// exposes: interface void (not agent_callable). Exported under the reserved word
// so the declared name resolves; `voidInvoice` is the callable alias.
export { voidInvoice, voidInvoice as void } from './invoice.js'

// exposes: component InvoiceList
export { InvoiceList, type InvoiceListProps } from './InvoiceList.js'

// Configuration binding called by templates/pay.invoices/config.ts.tmpl
export {
  configureInvoices,
  isInvoicesConfigured,
  __resetInvoicesForTests,
  DEFAULT_NUMBERING_SCHEME,
  INVOICE_TEMPLATE_ID,
  RECEIPT_TEMPLATE_ID,
  CREDIT_NOTE_TEMPLATE_ID,
  type DocumentRenderer,
  type InvoicesConfig,
} from './config.js'

// Slot types, imported by the seeded stubs in src/slots/pay.invoices/
export type {
  InvoiceSlots,
  LineItemFormattingContext,
  LineItemFormattingSlot,
  NumberingSchemeContext,
  NumberingSchemeSlot,
  PaymentTermsContext,
  PaymentTermsSlot,
} from './slots.js'

// consumes: payment.succeeded / payment.refunded / milestone.due / order.placed
export {
  applyPayment,
  applyPaymentToInvoice,
  creditOnRefund,
  invoiceMilestone,
  invoiceOrder,
  type ApplyPaymentInput,
  type CreditOnRefundResult,
} from './payments.js'

// Overdue sweep, bound to overdue_check_cron by the generated wiring
export { checkOverdueInvoices, overdueCheckCron, type OverdueSweepResult } from './overdue.js'

// owns[].privacy handlers
export {
  anonymizeInvoices,
  anonymizeReceipts,
  exportCreditNotes,
  exportInvoices,
  exportReceipts,
} from './privacy.js'

// Numbering, exported so a client's numberingScheme slot can reuse the parser
export {
  InvalidNumberingSchemeError,
  formatInvoiceNumber,
  parseNumberingScheme,
  periodKey,
  type ParsedScheme,
} from './numbering.js'

// Rendering through docs.generation, with the template version pinned at issue time
export { renderCreditNote, renderInvoice, renderReceipt, type RenderedDocument } from './render.js'

// Published event contracts
export {
  PAY_INVOICES_EVENT_CONTRACT_VERSIONS,
  registerPayInvoicesEventSchemas,
  invoiceCreatedPayload,
  invoiceOverduePayload,
  invoicePaidPayload,
  invoiceSentPayload,
  invoiceVoidedPayload,
  type PayInvoicesEventName,
} from './events.js'

// Agent classification, read by ai.agents to enforce the approval rule
export {
  annotateAgent,
  requiresApproval,
  type AgentCallableMetadata,
  type ApprovalPolicy,
  type Consequence,
} from './agent.js'

export {
  CurrencyMismatchError,
  DocumentRenderError,
  InvoiceAlreadyVoidError,
  InvoiceNotEmptyError,
  InvoiceNotFoundError,
} from './errors.js'

// Drizzle schema for the five owned tables
export {
  creditNote as creditNoteTable,
  invoice as invoiceTable,
  invoiceLine as invoiceLineTable,
  invoiceSequence as invoiceSequenceTable,
  receipt as receiptTable,
  tables,
} from './schema.js'

export type {
  CreditNoteRow,
  InvoiceLineRow,
  InvoiceRow,
  InvoiceStore,
  InvoiceTx,
  ReceiptRow,
} from './db/port.js'
export { createPostgresStore } from './db/postgres.js'

export type {
  ApplyPaymentResult,
  CreditNote,
  EventEnvelope,
  Invoice,
  InvoiceInput,
  InvoiceLine,
  InvoiceLineInput,
  InvoiceRef,
  InvoiceStatus,
  Receipt,
} from './types.js'
