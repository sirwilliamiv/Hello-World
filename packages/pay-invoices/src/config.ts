import type { InvoiceStore } from './db/port.js'
import { createPostgresStore } from './db/postgres.js'
import { parseNumberingScheme, type ParsedScheme } from './numbering.js'
import type { InvoiceSlots } from './slots.js'

/**
 * Configuration binding for pay.invoices.
 *
 * `templates/pay.invoices/config.ts.tmpl` calls this once at boot. The numbering
 * scheme is validated here rather than at first use: a scheme without `{SEQ:n}`
 * cannot be gapless, and discovering that when the first invoice is issued is
 * discovering it too late.
 */

export interface DocumentRenderer {
  generate(
    template: { id: string; version?: string },
    data: unknown,
    opts?: { version?: string; format?: string },
  ): Promise<{ id: string; templateVersion: string; contentType: string; bytes?: Uint8Array }>
}

export interface InvoicesConfig {
  /** The legal entity invoices are issued under. Numbering is gapless per entity. */
  readonly legalEntity: string
  /** Tokens: {YYYY}, {YY}, {MM}, {SEQ:n}. Must contain {SEQ:n}. */
  readonly numberingScheme?: string
  readonly paymentTermsDays?: number
  readonly overdueCheckCron?: string
  readonly slots?: InvoiceSlots
  /** Injection seams, used by tests. The generated config never passes these. */
  readonly store?: InvoiceStore
  readonly documents?: DocumentRenderer
  readonly clock?: () => Date
  readonly idFactory?: (prefix: string) => string
}

export interface InvoicesRuntime {
  readonly legalEntity: string
  readonly scheme: ParsedScheme
  readonly paymentTermsDays: number
  readonly overdueCheckCron: string
  readonly slots: InvoiceSlots
  readonly store: InvoiceStore
  readonly clock: () => Date
  readonly newId: (prefix: string) => string
  documents(): Promise<DocumentRenderer>
}

let runtime: InvoicesRuntime | null = null

export const DEFAULT_NUMBERING_SCHEME = 'INV-{YYYY}-{SEQ:5}'
export const INVOICE_TEMPLATE_ID = 'pay.invoices/invoice'
export const RECEIPT_TEMPLATE_ID = 'pay.invoices/receipt'
export const CREDIT_NOTE_TEMPLATE_ID = 'pay.invoices/credit-note'

function defaultId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`
}

export function configureInvoices(config: InvoicesConfig): void {
  if (config.legalEntity.trim().length === 0) {
    throw new Error(
      'configureInvoices: legalEntity is required. Invoice numbering is gapless PER LEGAL ENTITY, ' +
        'so there is no sensible default.',
    )
  }
  const scheme = parseNumberingScheme(config.numberingScheme ?? DEFAULT_NUMBERING_SCHEME)

  const paymentTermsDays = config.paymentTermsDays ?? 30
  if (!Number.isInteger(paymentTermsDays) || paymentTermsDays < 0) {
    throw new Error('configureInvoices: paymentTermsDays must be a non-negative integer')
  }

  let documents: DocumentRenderer | null = config.documents ?? null
  let pending: Promise<DocumentRenderer> | null = null

  runtime = {
    legalEntity: config.legalEntity,
    scheme,
    paymentTermsDays,
    overdueCheckCron: config.overdueCheckCron ?? '0 6 * * *',
    slots: config.slots ?? {},
    store: config.store ?? createPostgresStore(),
    clock: config.clock ?? (() => new Date()),
    newId: config.idFactory ?? defaultId,
    documents(): Promise<DocumentRenderer> {
      if (documents !== null) return Promise.resolve(documents)
      pending ??= import('@forge/docs-generation').then((mod) => {
        documents = mod as unknown as DocumentRenderer
        return documents
      })
      return pending
    },
  }
}

export function isInvoicesConfigured(): boolean {
  return runtime !== null
}

export function requireInvoicesRuntime(): InvoicesRuntime {
  if (runtime === null) {
    throw new Error(
      'pay.invoices is not configured. The generated src/generated/pay.invoices/config.ts calls ' +
        'configureInvoices() at boot; import it before using this capability.',
    )
  }
  return runtime
}

/** @internal Test seam. */
export function __resetInvoicesForTests(): void {
  runtime = null
}
