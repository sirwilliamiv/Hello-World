import {
  CREDIT_NOTE_TEMPLATE_ID,
  INVOICE_TEMPLATE_ID,
  RECEIPT_TEMPLATE_ID,
  requireInvoicesRuntime,
} from './config.js'
import type { GeneratedDocument } from '@forge/docs-generation'
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
 *
 * A pinned version is an INTEGER — docs.generation numbers versions 1, 2, 3 — while
 * `invoice.document_template_version` is a text column. The two conversions live
 * here and nowhere else, in `pinOf` and `pinFrom`.
 */

export type RenderedDocument = GeneratedDocument

/** The stored (text) form of a pin. */
function pinOf(version: number): string {
  return String(version)
}

/** The docs.generation (integer) form of a stored pin, or null when unpinned. */
function pinFrom(stored: string | null | undefined): number | null {
  if (stored === null || stored === undefined) return null
  const version = Number(stored)
  if (!Number.isInteger(version) || version < 1) {
    throw new DocumentRenderError(
      `document_template_version '${stored}' is not a docs.generation template version`,
    )
  }
  return version
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

  const pinned = pinFrom(invoice.documentTemplateVersion)
  const rendered = await docs.generate({ key: INVOICE_TEMPLATE_ID }, documentData(invoice, lines), {
    subjectRef: `Invoice:${invoice.id}`,
    ...(pinned === null ? {} : { templateVersion: pinned }),
  })

  if (pinned === null) {
    // First render: pin the version so a reissue is byte-identical.
    await rt.store.transaction((tx) =>
      tx.setInvoiceDocumentVersion(
        invoice.id,
        INVOICE_TEMPLATE_ID,
        pinOf(rendered.templateVersion),
      ),
    )
  } else if (rendered.templateVersion !== pinned) {
    throw new DocumentRenderError(
      `invoice ${invoice.number} is pinned to template version ${String(pinned)} but ` +
        `docs.generation rendered ${String(rendered.templateVersion)}`,
    )
  }

  return rendered
}

export async function renderReceipt(receipt: Receipt, invoice: Invoice): Promise<RenderedDocument> {
  const rt = requireInvoicesRuntime()
  const docs = await rt.documents()
  const pinned = pinFrom(receipt.documentTemplateVersion)
  return docs.generate(
    { key: RECEIPT_TEMPLATE_ID },
    {
      receiptId: receipt.id,
      invoiceNumber: invoice.number,
      chargeId: receipt.chargeId,
      amountMinor: minorOf(receipt.amount),
      currency: currencyOf(receipt.amount),
      issuedAt: receipt.issuedAt.toISOString(),
      legalEntity: invoice.legalEntity,
    },
    {
      subjectRef: `Receipt:${receipt.id}`,
      ...(pinned === null ? {} : { templateVersion: pinned }),
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
    { key: CREDIT_NOTE_TEMPLATE_ID },
    {
      creditNoteId: note.id,
      invoiceNumber: invoice.number,
      amountMinor: minorOf(note.amount),
      currency: currencyOf(note.amount),
      reason: note.reason,
      issuedAt: note.issuedAt.toISOString(),
      legalEntity: invoice.legalEntity,
    },
    { subjectRef: `CreditNote:${note.id}` },
  )
}
