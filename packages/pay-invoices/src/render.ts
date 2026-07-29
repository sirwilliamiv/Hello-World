import {
  CREDIT_NOTE_TEMPLATE_ID,
  INVOICE_TEMPLATE_ID,
  RECEIPT_TEMPLATE_ID,
  requireInvoicesRuntime,
} from './config.js'
import { DocumentRenderError } from './errors.js'
import { currencyOf, minorOf } from './money.js'
import type { CreditNote, Invoice, InvoiceLine, Receipt } from './types.js'

/**
 * Rendering through docs.generation, and the reason `document_template_version`
 * exists on the invoice row.
 *
 * The contract test with docs.generation requires that reissuing a historical
 * invoice after its template has been edited produces the same bytes. We get that
 * by PINNING the version: the first render records the version docs.generation
 * used, and every later render of that invoice asks for exactly that version.
 * docs.generation's `TemplateVersion` table is append-only, so the pinned version
 * cannot change underneath us.
 */

export interface RenderedDocument {
  readonly id: string
  readonly templateVersion: string
  readonly contentType: string
  readonly bytes?: Uint8Array
}

interface InvoiceDocumentData {
  readonly number: string
  readonly legalEntity: string
  readonly customerId: string
  readonly issuedAt: string
  readonly dueAt: string
  readonly currency: string
  readonly subtotalMinor: number
  readonly taxMinor: number
  readonly totalMinor: number
  readonly lines: readonly {
    position: number
    description: string
    quantityMilli: number
    unitAmountMinor: number
    amountMinor: number
    taxMinor: number
  }[]
}

/** Applies the `lineItemFormatting` slot. Formatting only — never amounts. */
async function formatLines(invoice: Invoice): Promise<readonly InvoiceLine[]> {
  const rt = requireInvoicesRuntime()
  if (rt.slots.lineItemFormatting === undefined) return invoice.lines

  const formatted = await rt.slots.lineItemFormatting({
    lines: invoice.lines,
    customerId: invoice.customerId,
    legalEntity: invoice.legalEntity,
  })

  const before = invoice.lines.reduce((s, l) => s + minorOf(l.amount) + minorOf(l.tax), 0)
  const after = formatted.reduce((s, l) => s + minorOf(l.amount) + minorOf(l.tax), 0)
  if (before !== after) {
    throw new DocumentRenderError(
      `the lineItemFormatting slot changed the invoice total from ${before} to ${after} minor units. ` +
        'The slot may reorder, group, and relabel lines; it may not change what is owed.',
    )
  }
  return formatted
}

function documentData(invoice: Invoice, lines: readonly InvoiceLine[]): InvoiceDocumentData {
  return {
    number: invoice.number,
    legalEntity: invoice.legalEntity,
    customerId: invoice.customerId,
    issuedAt: invoice.issuedAt.toISOString(),
    dueAt: invoice.dueAt.toISOString(),
    currency: currencyOf(invoice.total),
    subtotalMinor: minorOf(invoice.subtotal),
    taxMinor: minorOf(invoice.tax),
    totalMinor: minorOf(invoice.total),
    lines: lines.map((l) => ({
      position: l.position,
      description: l.description,
      quantityMilli: l.quantityMilli,
      unitAmountMinor: minorOf(l.unitAmount),
      amountMinor: minorOf(l.amount),
      taxMinor: minorOf(l.tax),
    })),
  }
}

export async function renderInvoice(invoice: Invoice): Promise<RenderedDocument> {
  const rt = requireInvoicesRuntime()
  const docs = await rt.documents()
  const lines = await formatLines(invoice)

  const pinned = invoice.documentTemplateVersion
  const rendered = await docs.generate(
    pinned === null || pinned === undefined
      ? { id: INVOICE_TEMPLATE_ID }
      : { id: INVOICE_TEMPLATE_ID, version: pinned },
    documentData(invoice, lines),
  )

  if (pinned === null || pinned === undefined) {
    // First render: pin the version so a reissue is byte-identical.
    await rt.store.transaction((tx) =>
      tx.setInvoiceDocumentVersion(invoice.id, INVOICE_TEMPLATE_ID, rendered.templateVersion),
    )
  } else if (rendered.templateVersion !== pinned) {
    throw new DocumentRenderError(
      `invoice ${invoice.number} is pinned to template version ${pinned} but docs.generation ` +
        `rendered ${rendered.templateVersion}`,
    )
  }

  return rendered
}

export async function renderReceipt(receipt: Receipt, invoice: Invoice): Promise<RenderedDocument> {
  const rt = requireInvoicesRuntime()
  const docs = await rt.documents()
  return docs.generate(
    receipt.documentTemplateVersion === null
      ? { id: RECEIPT_TEMPLATE_ID }
      : { id: RECEIPT_TEMPLATE_ID, version: receipt.documentTemplateVersion },
    {
      receiptId: receipt.id,
      invoiceNumber: invoice.number,
      chargeId: receipt.chargeId,
      amountMinor: minorOf(receipt.amount),
      currency: currencyOf(receipt.amount),
      issuedAt: receipt.issuedAt.toISOString(),
      legalEntity: invoice.legalEntity,
    },
  )
}

export async function renderCreditNote(
  note: CreditNote,
  invoice: Invoice,
): Promise<RenderedDocument> {
  const rt = requireInvoicesRuntime()
  const docs = await rt.documents()
  return docs.generate(
    { id: CREDIT_NOTE_TEMPLATE_ID },
    {
      creditNoteId: note.id,
      invoiceNumber: invoice.number,
      amountMinor: minorOf(note.amount),
      currency: currencyOf(note.amount),
      reason: note.reason,
      issuedAt: note.issuedAt.toISOString(),
      legalEntity: invoice.legalEntity,
    },
  )
}
