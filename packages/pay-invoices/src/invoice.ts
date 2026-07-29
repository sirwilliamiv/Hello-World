import { annotateAgent } from './agent.js'
import { INVOICE_TEMPLATE_ID, requireInvoicesRuntime, type InvoicesRuntime } from './config.js'
import type { InvoiceLineRow, InvoiceRow, InvoiceTx } from './db/port.js'
import { publishInvoiceEvent } from './events.js'
import {
  CurrencyMismatchError,
  InvoiceAlreadyVoidError,
  InvoiceNotEmptyError,
  InvoiceNotFoundError,
} from './errors.js'
import { assertCurrencyCode, assertIntegerMinor, currencyOf, minorOf, money } from './money.js'
import { formatInvoiceNumber, periodKey } from './numbering.js'
import { renderInvoice } from './render.js'
import type { NumberingSchemeContext, PaymentTermsContext } from './slots.js'
import type {
  CreditNote,
  Invoice,
  InvoiceInput,
  InvoiceLine,
  InvoiceLineInput,
  InvoiceRef,
} from './types.js'

const MILLI = 1000

export function invoiceFromRows(row: InvoiceRow, lines: readonly InvoiceLineRow[]): Invoice {
  return {
    id: row.id,
    legalEntity: row.legalEntity,
    period: row.period,
    sequence: row.sequenceValue,
    number: row.number,
    customerId: row.customerId,
    subtotal: money(row.subtotalMinor, row.currency),
    tax: money(row.taxMinor, row.currency),
    total: money(row.totalMinor, row.currency),
    paid: money(row.paidMinor, row.currency),
    credited: money(row.creditedMinor, row.currency),
    outstanding: money(row.totalMinor - row.paidMinor - row.creditedMinor, row.currency),
    status: row.status,
    issuedAt: row.issuedAt,
    dueAt: row.dueAt,
    voidedAt: row.voidedAt,
    documentTemplate: row.documentTemplate,
    documentTemplateVersion: row.documentTemplateVersion,
    metadata: row.metadata,
    lines: lines.map((l) => lineFromRow(l, row.currency)),
  }
}

export function lineFromRow(row: InvoiceLineRow, currency: string): InvoiceLine {
  return {
    id: row.id,
    invoiceId: row.invoiceId,
    position: row.position,
    description: row.description,
    quantityMilli: row.quantityMilli,
    unitAmount: money(row.unitAmountMinor, currency),
    amount: money(row.amountMinor, currency),
    tax: money(row.taxMinor, currency),
    metadata: row.metadata,
  }
}

function quantityMilliOf(line: InvoiceLineInput): number {
  if (line.quantityMilli !== undefined) {
    assertIntegerMinor(line.quantityMilli, 'quantityMilli')
    return line.quantityMilli
  }
  if (line.quantity !== undefined) {
    assertIntegerMinor(line.quantity, 'quantity')
    return line.quantity * MILLI
  }
  return MILLI
}

/**
 * Line amount = unit amount x quantity, in integer minor units.
 *
 * The multiplication is done in thousandths and rounded half-up to the nearest
 * minor unit, so a quantity of 2.5 hours at 3333 minor units yields 8333 (not
 * 8332.5, and never a float).
 */
function lineAmountMinor(unitMinor: number, quantityMilli: number): number {
  const product = unitMinor * quantityMilli
  return Math.trunc((product + (product < 0 ? -MILLI / 2 : MILLI / 2)) / MILLI)
}

interface PreparedLine {
  readonly description: string
  readonly quantityMilli: number
  readonly unitAmountMinor: number
  readonly amountMinor: number
  readonly taxMinor: number
  readonly metadata: Record<string, string>
}

function prepareLines(input: InvoiceInput): { currency: string; lines: PreparedLine[] } {
  if (input.lines.length === 0) throw new InvoiceNotEmptyError()

  const first = input.lines[0] as InvoiceLineInput
  const currency = input.currency ?? currencyOf(first.unitAmount)
  assertCurrencyCode(currency)

  const lines = input.lines.map((line) => {
    const lineCurrency = currencyOf(line.unitAmount)
    if (lineCurrency !== currency) throw new CurrencyMismatchError(currency, lineCurrency)
    if (line.taxAmount !== undefined && currencyOf(line.taxAmount) !== currency) {
      throw new CurrencyMismatchError(currency, currencyOf(line.taxAmount))
    }
    const quantityMilli = quantityMilliOf(line)
    const unitAmountMinor = minorOf(line.unitAmount)
    return {
      description: line.description,
      quantityMilli,
      unitAmountMinor,
      amountMinor: lineAmountMinor(unitAmountMinor, quantityMilli),
      taxMinor: line.taxAmount === undefined ? 0 : minorOf(line.taxAmount),
      metadata: { ...(line.metadata ?? {}) },
    }
  })

  return { currency, lines }
}

async function resolveDueAt(
  rt: InvoicesRuntime,
  input: InvoiceInput,
  issuedAt: Date,
  totalMinor: number,
  currency: string,
): Promise<Date> {
  if (input.dueAt !== undefined) return input.dueAt

  const defaultDays = input.paymentTermsDays ?? rt.paymentTermsDays
  const addDays = (days: number): Date => new Date(issuedAt.getTime() + days * 86_400_000)

  if (rt.slots.paymentTerms === undefined) return addDays(defaultDays)

  const ctx: PaymentTermsContext = {
    customerId: input.customerId,
    issuedAt,
    total: money(totalMinor, currency),
    input,
    defaultDays,
    defaultDueAt: () => addDays(defaultDays),
  }
  const decided = await rt.slots.paymentTerms(ctx)
  if (typeof decided === 'number') {
    if (!Number.isInteger(decided) || decided < 0) {
      throw new RangeError('the paymentTerms slot must return a non-negative integer of days')
    }
    return addDays(decided)
  }
  return decided
}

/**
 * Allocates the number and inserts the invoice, in ONE transaction.
 *
 * This function is the gaplessness guarantee. The allocation is the first
 * statement of the transaction that also carries the insert, so:
 *  - two concurrent issues serialise on the counter's row lock and cannot share
 *    a value;
 *  - if anything after the allocation throws, the transaction rolls back and the
 *    counter goes back with it — the number is not burned.
 *
 * The `numberingScheme` slot runs inside the transaction too, but it only gets to
 * FORMAT the allocated value; it cannot choose, skip, or reuse one.
 */
async function allocateAndInsert(
  rt: InvoicesRuntime,
  tx: InvoiceTx,
  args: {
    legalEntity: string
    issuedAt: Date
    dueAt: Date
    currency: string
    customerId: string
    subtotalMinor: number
    taxMinor: number
    totalMinor: number
    metadata: Record<string, string>
    lines: readonly PreparedLine[]
  },
): Promise<{ invoice: InvoiceRow; lines: InvoiceLineRow[] }> {
  const period = periodKey(rt.scheme, args.issuedAt)

  // ── the allocation, inside the same transaction as the insert ──
  const sequence = await tx.allocateInvoiceNumber(args.legalEntity, period)

  const defaultNumber = (): string => formatInvoiceNumber(rt.scheme, sequence, args.issuedAt)
  let number = defaultNumber()
  if (rt.slots.numberingScheme !== undefined) {
    const ctx: NumberingSchemeContext = {
      legalEntity: args.legalEntity,
      sequence,
      period,
      issuedAt: args.issuedAt,
      scheme: rt.scheme.scheme,
      customerId: args.customerId,
      defaultNumber,
    }
    number = await rt.slots.numberingScheme(ctx)
    if (typeof number !== 'string' || number.trim().length === 0) {
      throw new TypeError('the numberingScheme slot must return a non-empty string')
    }
  }

  const invoiceId = rt.newId('inv')
  const invoice = await tx.insertInvoice({
    id: invoiceId,
    legalEntity: args.legalEntity,
    period,
    sequenceValue: sequence,
    number,
    customerId: args.customerId,
    currency: args.currency,
    subtotalMinor: args.subtotalMinor,
    taxMinor: args.taxMinor,
    totalMinor: args.totalMinor,
    paidMinor: 0,
    creditedMinor: 0,
    status: 'open',
    issuedAt: args.issuedAt,
    dueAt: args.dueAt,
    voidedAt: null,
    documentTemplate: null,
    documentTemplateVersion: null,
    metadata: args.metadata,
  })

  const lineRows: InvoiceLineRow[] = args.lines.map((line, index) => ({
    id: rt.newId('inl'),
    invoiceId,
    position: index + 1,
    description: line.description,
    quantityMilli: line.quantityMilli,
    unitAmountMinor: line.unitAmountMinor,
    amountMinor: line.amountMinor,
    taxMinor: line.taxMinor,
    metadata: line.metadata,
  }))
  await tx.insertInvoiceLines(lineRows)

  return { invoice, lines: lineRows }
}

async function issueImpl(input: InvoiceInput): Promise<Invoice> {
  const rt = requireInvoicesRuntime()
  const { currency, lines } = prepareLines(input)

  const subtotalMinor = lines.reduce((sum, l) => sum + l.amountMinor, 0)
  const taxMinor = lines.reduce((sum, l) => sum + l.taxMinor, 0)
  const totalMinor = subtotalMinor + taxMinor
  assertIntegerMinor(totalMinor, 'invoice total')

  const issuedAt = input.issuedAt ?? rt.clock()
  const dueAt = await resolveDueAt(rt, input, issuedAt, totalMinor, currency)
  const legalEntity = input.legalEntity ?? rt.legalEntity

  const { invoice, lines: lineRows } = await rt.store.transaction((tx) =>
    allocateAndInsert(rt, tx, {
      legalEntity,
      issuedAt,
      dueAt,
      currency,
      customerId: input.customerId,
      subtotalMinor,
      taxMinor,
      totalMinor,
      metadata: { ...(input.metadata ?? {}) },
      lines,
    }),
  )

  const result = invoiceFromRows(invoice, lineRows)

  // Published after commit: a consumer must never see an event for an invoice
  // that is not durable.
  await publishInvoiceEvent('invoice.created', {
    invoice_id: result.id,
    number: result.number,
    customer_id: result.customerId,
    total_minor: minorOf(result.total),
    currency: currencyOf(result.total),
    due_at: result.dueAt.toISOString(),
    legal_entity: result.legalEntity,
  })

  // Rendering is outside the transaction on purpose: it calls docs.generation,
  // which is slow and external, and holding the counter's row lock across a PDF
  // render would serialise every issue in the system behind it.
  const rendered = await renderInvoice(result)
  return {
    ...result,
    documentTemplate: INVOICE_TEMPLATE_ID,
    documentTemplateVersion: rendered.templateVersion,
  }
}

async function voidImpl(ref: InvoiceRef, reason: string): Promise<CreditNote> {
  const rt = requireInvoicesRuntime()
  if (reason.trim().length === 0) throw new Error('void requires a reason')

  const outcome = await rt.store.transaction(async (tx) => {
    const row = await tx.findInvoiceById(ref.id)
    if (row === null) throw new InvoiceNotFoundError(ref.id)
    if (row.status === 'void') throw new InvoiceAlreadyVoidError(ref.id)

    const outstanding = row.totalMinor - row.paidMinor - row.creditedMinor
    if (outstanding <= 0) {
      throw new Error(
        `invoice ${ref.id} has nothing outstanding to credit; refund the payment instead of voiding`,
      )
    }

    // A credit note, never an edit: the invoice keeps its number and its amounts,
    // which is what keeps the sequence gapless and the ledger reconcilable.
    const note = await tx.insertCreditNoteIfAbsent({
      id: rt.newId('cn'),
      invoiceId: row.id,
      amountMinor: outstanding,
      currency: row.currency,
      reason,
      refundId: null,
      issuedAt: rt.clock(),
    })
    if (note === null) throw new Error(`credit note for invoice ${ref.id} could not be inserted`)

    await tx.applyInvoiceDelta(row.id, 0, outstanding)
    await tx.markInvoiceVoid(row.id, rt.clock())

    return note
  })

  await publishInvoiceEvent('invoice.voided', {
    invoice_id: outcome.invoiceId,
    reason,
    credit_note_id: outcome.id,
  })

  return {
    id: outcome.id,
    invoiceId: outcome.invoiceId,
    amount: money(outcome.amountMinor, outcome.currency),
    reason: outcome.reason,
    refundId: outcome.refundId,
    issuedAt: outcome.issuedAt,
  }
}

export async function getInvoice(id: string): Promise<Invoice | null> {
  const rt = requireInvoicesRuntime()
  return rt.store.transaction(async (tx) => {
    const row = await tx.findInvoiceById(id)
    if (row === null) return null
    return invoiceFromRows(row, await tx.listInvoiceLines(id))
  })
}

export async function listInvoices(customerId: string): Promise<Invoice[]> {
  const rt = requireInvoicesRuntime()
  return rt.store.transaction(async (tx) => {
    const rows = await tx.listInvoicesForCustomer(customerId)
    const out: Invoice[] = []
    for (const row of rows) {
      out.push(invoiceFromRows(row, await tx.listInvoiceLines(row.id)))
    }
    return out
  })
}

/**
 * `issue` is agent-callable with approval: issuing an invoice is an outbound
 * communication with financial meaning.
 */
export const issue = annotateAgent(issueImpl, {
  capability: 'pay.invoices',
  name: 'issue',
  agentCallable: true,
  consequence: 'external_communication',
  approval: 'by_trust_level',
  description: 'Issues a numbered invoice and renders it through docs.generation.',
})

/**
 * `void` is not agent-callable: voiding an issued financial document is a human
 * decision. Exported under the reserved word to match the spec's `exposes`.
 */
const voidInvoice = annotateAgent(voidImpl, {
  capability: 'pay.invoices',
  name: 'void',
  agentCallable: false,
  consequence: 'write',
  approval: 'never',
})

export { voidInvoice }
