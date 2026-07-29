import { publish, registerEventSchema } from '@forge/kernel-events'
import { z } from 'zod'

/**
 * The five events pay.invoices publishes and the two payment events it consumes,
 * as declared in the catalog. The consumed schemas are `passthrough` rather than
 * `strict`: a publisher is entitled to add a property in a minor version, and a
 * consumer that rejected the addition would turn an additive change into an
 * outage.
 */

export const PAY_INVOICES_EVENT_CONTRACT_VERSIONS = {
  'invoice.created': 1,
  'invoice.sent': 1,
  'invoice.paid': 1,
  'invoice.overdue': 1,
  'invoice.voided': 1,
} as const

export const invoiceCreatedPayload = z
  .object({
    invoice_id: z.string(),
    number: z.string(),
    customer_id: z.string(),
    total_minor: z.number().int(),
    currency: z.string(),
    due_at: z.string(),
    legal_entity: z.string().optional(),
  })
  .strict()

export const invoiceSentPayload = z
  .object({
    invoice_id: z.string(),
    channel: z.string(),
    recipient: z.string().optional(),
  })
  .strict()

export const invoicePaidPayload = z
  .object({
    invoice_id: z.string(),
    paid_minor: z.number().int(),
    currency: z.string(),
    charge_id: z.string().optional(),
  })
  .strict()

export const invoiceOverduePayload = z
  .object({
    invoice_id: z.string(),
    days_overdue: z.number().int(),
    outstanding_minor: z.number().int(),
  })
  .strict()

export const invoiceVoidedPayload = z
  .object({
    invoice_id: z.string(),
    reason: z.string(),
    credit_note_id: z.string().optional(),
  })
  .strict()

const schemas = {
  'invoice.created': invoiceCreatedPayload,
  'invoice.sent': invoiceSentPayload,
  'invoice.paid': invoicePaidPayload,
  'invoice.overdue': invoiceOverduePayload,
  'invoice.voided': invoiceVoidedPayload,
} as const

export type PayInvoicesEventName = keyof typeof schemas
export type PayInvoicesPayload<E extends PayInvoicesEventName> = z.infer<(typeof schemas)[E]>

/**
 * Register the five published schemas with kernel.events.
 *
 * The bus refuses to publish an event whose schema is not registered — a
 * capability may only publish what it declares — so this is not optional
 * bookkeeping: without it every `publishInvoiceEvent` call throws
 * `UnregisteredEventSchemaError`. Called at import time; exported so a test that
 * cleared the registry can put them back.
 */
export function registerPayInvoicesEventSchemas(): void {
  for (const [name, schema] of Object.entries(schemas)) {
    registerEventSchema({
      name,
      contractVersion:
        PAY_INVOICES_EVENT_CONTRACT_VERSIONS[name as PayInvoicesEventName],
      schema,
      publisher: 'pay.invoices',
    })
  }
}

registerPayInvoicesEventSchemas()

export async function publishInvoiceEvent<E extends PayInvoicesEventName>(
  name: E,
  payload: PayInvoicesPayload<E>,
): Promise<void> {
  await publish(name, schemas[name].parse(payload) as never)
}

/** Consumed: pay.card `payment.succeeded` v1. */
export const paymentSucceededPayload = z
  .object({
    charge_id: z.string(),
    customer_id: z.string(),
    amount_minor: z.number().int(),
    currency: z.string(),
    payment_method_id: z.string().optional(),
    external_id: z.string().optional(),
    metadata: z.record(z.string()).optional(),
  })
  .passthrough()

/** Consumed: pay.card `payment.refunded` v1. */
export const paymentRefundedPayload = z
  .object({
    refund_id: z.string(),
    charge_id: z.string(),
    amount_minor: z.number().int(),
    currency: z.string(),
    reason: z.string().optional(),
  })
  .passthrough()

/** Consumed: pay.deposits `milestone.due` v1 (optional in the graph). */
export const milestoneDuePayload = z
  .object({
    milestone_id: z.string(),
    customer_id: z.string(),
    amount_minor: z.number().int(),
    currency: z.string(),
    description: z.string().optional(),
  })
  .passthrough()

/** Consumed: commerce.catalog `order.placed` v1 (optional in the graph). */
export const orderPlacedPayload = z
  .object({
    order_id: z.string(),
    customer_id: z.string(),
    currency: z.string(),
    lines: z.array(
      z.object({
        description: z.string(),
        quantity: z.number().int().optional(),
        unit_amount_minor: z.number().int(),
      }),
    ),
  })
  .passthrough()
