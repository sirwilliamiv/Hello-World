import { resetEventBus, subscribe, type EventEnvelope } from '@forge/kernel-events'
import { __resetInvoicesForTests, configureInvoices } from '../config.js'
import { registerPayInvoicesEventSchemas } from '../events.js'
import type { InvoiceSlots } from '../slots.js'
import { setupDocuments, type DocsHarness } from './docs-runtime.js'
import { MemoryInvoiceStore } from './memory-store.js'

export const LEGAL_ENTITY = 'Acme Trading Ltd'

export interface RecordedEvent {
  readonly name: string
  readonly payload: unknown
  readonly id: string
}

const recorded: RecordedEvent[] = []

/**
 * A recorder over the REAL bus rather than a bus of our own.
 *
 * It subscribes with `**` exactly as audit.history and integrate.webhooks do, so an
 * assertion about "what was published" is an assertion about what a real subscriber
 * would have received — including the fact that kernel.events validates every
 * payload against its registered schema and refuses to deliver one that does not
 * satisfy it.
 *
 * `publish` awaits fan-out, so reading `published()` straight after an awaited call
 * is not a race.
 */
export const bus = {
  published(name?: string): RecordedEvent[] {
    return name === undefined ? [...recorded] : recorded.filter((e) => e.name === name)
  },
  reset(): void {
    resetEventBus()
    recorded.length = 0
    // The schema registry survives `resetEventBus`, and re-registering an
    // identical schema is a no-op; this keeps the suite honest if a test ever
    // clears the registry, because a cleared registry makes every publish throw.
    registerPayInvoicesEventSchemas()
    subscribe(
      '**',
      (event: EventEnvelope) => {
        recorded.push({ name: event.name, payload: event.payload, id: event.id })
      },
      { consumer: 'test-recorder' },
    )
  },
}

export interface Harness {
  readonly store: MemoryInvoiceStore
  readonly docs: DocsHarness
}

export interface SetupOptions {
  readonly slots?: InvoiceSlots
  readonly numberingScheme?: string
  readonly paymentTermsDays?: number
  readonly legalEntity?: string
  readonly clock?: () => Date
}

let ids = 0

export async function setupInvoices(options: SetupOptions = {}): Promise<Harness> {
  __resetInvoicesForTests()
  bus.reset()
  ids = 0

  const docs = await setupDocuments()
  const store = new MemoryInvoiceStore()

  configureInvoices({
    legalEntity: options.legalEntity ?? LEGAL_ENTITY,
    numberingScheme: options.numberingScheme ?? 'INV-{YYYY}-{SEQ:5}',
    paymentTermsDays: options.paymentTermsDays ?? 30,
    overdueCheckCron: '0 6 * * *',
    ...(options.slots === undefined ? {} : { slots: options.slots }),
    store,
    // `documents` is deliberately NOT injected: config.ts resolves
    // @forge/docs-generation itself, so the production wiring is what runs.
    clock: options.clock ?? (() => new Date('2026-07-01T09:00:00.000Z')),
    idFactory: (prefix) => {
      ids += 1
      return `${prefix}_${String(ids).padStart(5, '0')}`
    },
  })

  return { store, docs }
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
