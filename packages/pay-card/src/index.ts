/**
 * @forge/pay-card — Card Payments (pay.card@1.0.0)
 *
 * The public surface is the `exposes` block of
 * catalog/pay/pay.card.capability.json, plus the configuration binding the
 * generated wiring calls and the handler names the generated subscription and
 * privacy files import.
 *
 * Three invariants this package exists to hold:
 *   1. card data never touches our database — see `card-data-guard.ts` and the
 *      migration;
 *   2. a webhook signature is verified before the payload is parsed — see
 *      `webhook.ts`;
 *   3. a redelivered `payment.succeeded` never produces a second charge or a
 *      second event — see `insertChargeIfAbsent` in `db/port.ts`.
 */

// exposes: interface charge / interface refund (agent_callable, moves_money)
export { charge, refund } from './charge.js'

// exposes: component PaymentForm
export { PaymentForm, PAYMENT_ELEMENT_MOUNT_ID, type PaymentFormProps } from './PaymentForm.js'

// exposes: webhook_receiver stripeWebhook at /api/webhooks/stripe
export { stripeWebhookHandler } from './webhook.js'

// Configuration binding called by templates/pay.card/config.ts.tmpl
export {
  configurePayments,
  isPaymentsConfigured,
  __resetPaymentsForTests,
  type PaymentsConfig,
} from './config.js'

// Slot types, imported by the seeded stubs in src/slots/pay.card/
export type {
  AfterChargeContext,
  AfterChargeSlot,
  BeforeChargeContext,
  BeforeChargeDecision,
  BeforeChargeSlot,
  PaymentSlots,
  ReceiptCustomizationContext,
  ReceiptCustomizationSlot,
} from './slots.js'

// consumes: identity.user.deleted -> detachOnUserDeleted
export {
  attachPaymentMethod,
  detachOnUserDeleted,
  detachPaymentMethods,
  listPaymentMethods,
  type AttachPaymentMethodInput,
  type EventEnvelope,
} from './payment-methods.js'

// owns[].privacy handlers
export {
  anonymizeCharges,
  anonymizeRefunds,
  exportCharges,
  exportPaymentMethods,
  exportRefunds,
} from './privacy.js'

// Receipts and the receiptCustomization slot
export { buildChargeReceipt, defaultChargeReceipt, withReceiptLine } from './receipts.js'

// Published event contracts, so a consumer can validate against the same schema
export {
  PAY_CARD_EVENT_CONTRACT_VERSIONS,
  registerPayCardEventSchemas,
  paymentFailedPayload,
  paymentMethodAddedPayload,
  paymentRefundedPayload,
  paymentSucceededPayload,
  type PaymentFailedPayload,
  type PaymentMethodAddedPayload,
  type PaymentRefundedPayload,
  type PaymentSucceededPayload,
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
  CardDataLeakError,
  assertNoCardData,
  isForbiddenFieldName,
  looksLikePan,
} from './card-data-guard.js'

export {
  ChargeFailedError,
  ChargeRejectedError,
  CurrencyNotAllowedError,
  RefundError,
  UnknownChargeError,
} from './errors.js'

// Drizzle schema for the three owned tables
export { charge as chargeTable, paymentMethod as paymentMethodTable, refund as refundTable, tables } from './schema.js'

export type { PaymentStore, PaymentTx, ChargeRow, RefundRow, PaymentMethodRow } from './db/port.js'
export { createPostgresStore } from './db/postgres.js'

export type {
  CaptureMethod,
  Charge,
  ChargeOptions,
  ChargeRef,
  ChargeReceipt,
  ChargeReceiptLine,
  ChargeStatus,
  CustomerRef,
  PaymentMethod,
  Provider,
  Refund,
} from './types.js'

export type { StripeEvent, StripeLike } from './stripe.js'
