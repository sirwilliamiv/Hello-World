import * as docsGeneration from '@forge/docs-generation'
import * as kernelEvents from '@forge/kernel-events'
import { __resetInvoicesForTests, configureInvoices, type DocumentRenderer } from '../config.js'
import type { InvoiceSlots } from '../slots.js'
import { MemoryInvoiceStore } from './memory-store.js'

export const LEGAL_ENTITY = 'Acme Trading Ltd'

interface BusHelpers {
  published(name?: string): { name: string; payload: unknown }[]
  resetEvents(): void
  subscribe(pattern: string, handler: (e: { name: string; payload: unknown }) => Promise<void>): void
}
export const bus = kernelEvents as unknown as BusHelpers

interface DocsHelpers extends DocumentRenderer {
  resetDocuments(): void
  publishTemplateVersion(templateId: string, body: string): string
  renderCount(): number
}
export const docs = docsGeneration as unknown as DocsHelpers

export interface Harness {
  readonly store: MemoryInvoiceStore
}

export interface SetupOptions {
  readonly slots?: InvoiceSlots
  readonly numberingScheme?: string
  readonly paymentTermsDays?: number
  readonly legalEntity?: string
  readonly clock?: () => Date
}

let ids = 0

export function setupInvoices(options: SetupOptions = {}): Harness {
  __resetInvoicesForTests()
  bus.resetEvents()
  docs.resetDocuments()
  ids = 0

  const store = new MemoryInvoiceStore()

  configureInvoices({
    legalEntity: options.legalEntity ?? LEGAL_ENTITY,
    numberingScheme: options.numberingScheme ?? 'INV-{YYYY}-{SEQ:5}',
    paymentTermsDays: options.paymentTermsDays ?? 30,
    overdueCheckCron: '0 6 * * *',
    ...(options.slots === undefined ? {} : { slots: options.slots }),
    store,
    documents: docs,
    clock: options.clock ?? (() => new Date('2026-07-01T09:00:00.000Z')),
    idFactory: (prefix) => {
      ids += 1
      return `${prefix}_${String(ids).padStart(5, '0')}`
    },
  })

  return { store }
}

/** A `payment.succeeded` envelope shaped exactly as pay.card publishes it. */
export function paymentSucceededEvent(args: {
  chargeId: string
  invoiceId?: string
  customerId?: string
  amountMinor: number
  currency?: string
}): { name: string; payload: Record<string, unknown>; id: string } {
  const metadata: Record<string, string> = {}
  if (args.invoiceId !== undefined) metadata['invoice_id'] = args.invoiceId
  return {
    name: 'payment.succeeded',
    id: `evt_${args.chargeId}`,
    payload: {
      charge_id: args.chargeId,
      customer_id: args.customerId ?? 'user_1',
      amount_minor: args.amountMinor,
      currency: args.currency ?? 'USD',
      external_id: `pi_${args.chargeId}`,
      metadata,
    },
  }
}

export function paymentRefundedEvent(args: {
  refundId: string
  chargeId: string
  amountMinor: number
  currency?: string
  reason?: string
}): { name: string; payload: Record<string, unknown> } {
  return {
    name: 'payment.refunded',
    payload: {
      refund_id: args.refundId,
      charge_id: args.chargeId,
      amount_minor: args.amountMinor,
      currency: args.currency ?? 'USD',
      ...(args.reason === undefined ? {} : { reason: args.reason }),
    },
  }
}
