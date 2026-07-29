import { currentUser } from '@forge/kernel-identity'
import type { Money } from '@forge/kernel-money'
import { annotateAgent } from './agent.js'
import { assertNoCardData } from './card-data-guard.js'
import { requirePaymentsRuntime, type PaymentsRuntime } from './config.js'
import type { ChargeRow, PaymentTx, RefundRow } from './db/port.js'
import { publishPayCardEvent } from './events.js'
import {
  ChargeFailedError,
  ChargeRejectedError,
  CurrencyNotAllowedError,
  RefundError,
  UnknownChargeError,
} from './errors.js'
import { assertCurrencyCode, currencyOf, minorOf, money } from './money.js'
import type { BeforeChargeContext, BeforeChargeDecision } from './slots.js'
import type { StripePaymentIntent } from './stripe.js'
import type { Charge, ChargeOptions, ChargeRef, CustomerRef, Refund } from './types.js'

const PROVIDER = 'stripe' as const

export function chargeFromRow(row: ChargeRow): Charge {
  return {
    id: row.id,
    customerId: row.customerId,
    paymentMethodId: row.paymentMethodId,
    amount: money(row.amountMinor, row.currency),
    status: row.status,
    provider: PROVIDER,
    externalId: row.externalId,
    invoiceId: row.invoiceId,
    statementDescriptor: row.statementDescriptor,
    failureReason: row.failureReason,
    declineCode: row.declineCode,
    metadata: row.metadata,
    createdAt: row.createdAt,
  }
}

export function refundFromRow(row: RefundRow): Refund {
  return {
    id: row.id,
    chargeId: row.chargeId,
    amount: money(row.amountMinor, row.currency),
    reason: row.reason,
    provider: PROVIDER,
    externalId: row.externalId,
    createdAt: row.createdAt,
  }
}

async function actorId(): Promise<string | null> {
  const user = await currentUser()
  return user === null ? null : user.id
}

function assertAllowedCurrency(rt: PaymentsRuntime, currency: string): void {
  assertCurrencyCode(currency)
  if (!rt.allowedCurrencies.includes(currency)) {
    throw new CurrencyNotAllowedError(currency, rt.allowedCurrencies)
  }
}

function buildBeforeChargeContext(
  amount: Money,
  customer: CustomerRef,
  options: ChargeOptions,
  actor: string | null,
): BeforeChargeContext {
  return {
    amount,
    customer,
    options,
    actorUserId: actor,
    proceed: (): BeforeChargeDecision => ({ kind: 'proceed' }),
    reject: (reason, declineCode): BeforeChargeDecision =>
      declineCode === undefined
        ? { kind: 'reject', reason }
        : { kind: 'reject', reason, declineCode },
  }
}

/**
 * Persists the charge row. `insertChargeIfAbsent` keys on (provider,
 * external_id), so a retried request that reached Stripe with the same
 * idempotency key resolves to the same PaymentIntent and therefore the same row —
 * we never write a second charge for one movement of money.
 */
async function recordCharge(tx: PaymentTx, row: ChargeRow): Promise<{ row: ChargeRow; fresh: boolean }> {
  assertNoCardData(row as unknown as Record<string, unknown>, 'charge')
  const inserted = await tx.insertChargeIfAbsent(row)
  if (inserted !== null) return { row: inserted, fresh: true }
  const existing = await tx.findChargeByExternalId(row.provider, row.externalId)
  return { row: existing ?? row, fresh: false }
}

/**
 * Takes a payment.
 *
 * Order of operations, and why:
 *  1. validate currency and integer minor units — a float never reaches Stripe;
 *  2. run the `beforeCharge` slot — a rejection prevents the provider call
 *     entirely, so no money moves and no charge row exists;
 *  3. call Stripe with an idempotency key;
 *  4. persist the charge inside a transaction, keyed on the provider reference;
 *  5. run the `afterCharge` slot;
 *  6. publish `payment.succeeded` — after commit, so a consumer can never observe
 *     an event for a charge that is not durable.
 */
async function chargeImpl(
  amount: Money,
  customer: CustomerRef,
  opts: ChargeOptions = {},
): Promise<Charge> {
  const rt = requirePaymentsRuntime()
  const minor = minorOf(amount)
  const currency = currencyOf(amount)
  assertAllowedCurrency(rt, currency)
  if (minor <= 0) throw new RangeError('charge amount must be greater than zero')

  const actor = await actorId()

  if (rt.slots.beforeCharge !== undefined) {
    const decision = await rt.slots.beforeCharge(
      buildBeforeChargeContext(amount, customer, opts, actor),
    )
    if (decision.kind === 'reject') {
      const reason = decision.reason ?? 'rejected by beforeCharge slot'
      await publishPayCardEvent('payment.failed', {
        charge_id: null,
        customer_id: customer.id,
        amount_minor: minor,
        currency,
        reason,
        ...(decision.declineCode === undefined ? {} : { decline_code: decision.declineCode }),
      })
      throw new ChargeRejectedError(reason, decision.declineCode ?? null)
    }
  }

  const captureMethod = opts.captureMethod ?? rt.captureMethod
  const statementDescriptor = opts.statementDescriptor ?? rt.statementDescriptor
  const metadata: Record<string, string> = { ...(opts.metadata ?? {}) }
  if (opts.invoiceId !== undefined) metadata['invoice_id'] = opts.invoiceId
  if (actor !== null) metadata['actor_user_id'] = actor

  const idempotencyKey =
    opts.idempotencyKey ?? `pay.card:charge:${customer.id}:${currency}:${minor}:${opts.invoiceId ?? 'adhoc'}`

  const stripe = await rt.stripe()
  const params: Record<string, unknown> = {
    amount: minor,
    currency: currency.toLowerCase(),
    capture_method: captureMethod,
    confirm: true,
    // Card details are collected client-side by Stripe Elements; we only ever
    // hand Stripe back its own opaque payment method handle.
    off_session: opts.paymentMethodId !== undefined,
    metadata,
  }
  if (statementDescriptor !== null) params['statement_descriptor'] = statementDescriptor
  if (opts.description !== undefined) params['description'] = opts.description
  if (customer.providerCustomerId !== undefined) params['customer'] = customer.providerCustomerId

  let providerRef: string | undefined
  if (opts.paymentMethodId !== undefined) {
    providerRef = await rt.store.transaction(async (tx) => {
      const pm = await tx.findPaymentMethodById(opts.paymentMethodId as string)
      if (pm === null) throw new ChargeFailedError(`unknown payment method ${opts.paymentMethodId}`)
      return pm.providerRef
    })
    params['payment_method'] = providerRef
  }

  let intent: StripePaymentIntent
  try {
    intent = await stripe.paymentIntents.create(params, { idempotencyKey })
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : 'provider error'
    await publishPayCardEvent('payment.failed', {
      charge_id: null,
      customer_id: customer.id,
      amount_minor: minor,
      currency,
      reason,
    })
    throw new ChargeFailedError(reason)
  }

  const succeeded = intent.status === 'succeeded' || intent.status === 'requires_capture'
  const now = rt.clock()
  const row: ChargeRow = {
    id: rt.newId('chg'),
    customerId: customer.id,
    paymentMethodId: opts.paymentMethodId ?? null,
    amountMinor: intent.amount,
    currency: intent.currency.toUpperCase(),
    status: succeeded ? (intent.status === 'requires_capture' ? 'requires_capture' : 'succeeded') : 'failed',
    provider: PROVIDER,
    externalId: intent.id,
    invoiceId: opts.invoiceId ?? null,
    statementDescriptor,
    failureReason: succeeded ? null : (intent.last_payment_error?.message ?? intent.status),
    declineCode: succeeded ? null : (intent.last_payment_error?.decline_code ?? null),
    metadata,
    createdAt: now,
  }

  const { row: stored, fresh } = await rt.store.transaction((tx) => recordCharge(tx, row))
  const result = chargeFromRow(stored)

  if (!succeeded) {
    await publishPayCardEvent('payment.failed', {
      charge_id: result.id,
      customer_id: customer.id,
      amount_minor: minor,
      currency,
      reason: result.failureReason ?? 'declined',
      ...(result.declineCode === null ? {} : { decline_code: result.declineCode }),
    })
    throw new ChargeFailedError(result.failureReason ?? 'declined', result.declineCode, result.id)
  }

  if (rt.slots.afterCharge !== undefined) {
    await rt.slots.afterCharge({
      charge: result,
      customer,
      actorUserId: actor,
      proceed: () => undefined,
    })
  }

  // Only a freshly inserted charge publishes. A duplicate provider reference is
  // the same movement of money and must not produce a second event.
  if (fresh) {
    await publishPayCardEvent('payment.succeeded', {
      charge_id: result.id,
      customer_id: result.customerId,
      amount_minor: minorOf(result.amount),
      currency: currencyOf(result.amount),
      ...(result.paymentMethodId === null ? {} : { payment_method_id: result.paymentMethodId }),
      external_id: result.externalId,
      metadata: result.metadata,
    })
  }

  return result
}

async function refundImpl(chargeRef: ChargeRef, amount?: Money): Promise<Refund> {
  const rt = requirePaymentsRuntime()

  const existing = await rt.store.transaction((tx) => tx.findChargeById(chargeRef.id))
  if (existing === null) throw new UnknownChargeError(chargeRef.id)
  if (existing.status !== 'succeeded') {
    throw new RefundError(`charge ${chargeRef.id} is ${existing.status} and cannot be refunded`)
  }

  const refundMinor = amount === undefined ? existing.amountMinor : minorOf(amount)
  if (refundMinor <= 0) throw new RangeError('refund amount must be greater than zero')
  if (amount !== undefined && currencyOf(amount) !== existing.currency) {
    throw new RefundError(
      `refund currency ${currencyOf(amount)} does not match charge currency ${existing.currency}`,
    )
  }

  const alreadyRefunded = (
    await rt.store.transaction((tx) => tx.listRefundsForCharge(existing.id))
  ).reduce((sum, r) => sum + r.amountMinor, 0)
  if (alreadyRefunded + refundMinor > existing.amountMinor) {
    throw new RefundError(
      `refunding ${refundMinor} would exceed the charge total (${existing.amountMinor} minor units, ` +
        `${alreadyRefunded} already refunded)`,
    )
  }

  const stripe = await rt.stripe()
  const providerRefund = await stripe.refunds.create(
    { payment_intent: existing.externalId, amount: refundMinor },
    { idempotencyKey: `pay.card:refund:${existing.id}:${alreadyRefunded + refundMinor}` },
  )

  const row: RefundRow = {
    id: rt.newId('rfd'),
    chargeId: existing.id,
    amountMinor: providerRefund.amount,
    currency: providerRefund.currency.toUpperCase(),
    reason: providerRefund.reason ?? null,
    provider: PROVIDER,
    externalId: providerRefund.id,
    createdAt: rt.clock(),
  }

  const { stored, fresh } = await rt.store.transaction(async (tx) => {
    const inserted = await tx.insertRefundIfAbsent(row)
    if (inserted !== null) return { stored: inserted, fresh: true }
    const all = await tx.listRefundsForCharge(existing.id)
    const match = all.find((r) => r.externalId === row.externalId)
    return { stored: match ?? row, fresh: false }
  })

  const result = refundFromRow(stored)
  if (fresh) {
    await publishPayCardEvent('payment.refunded', {
      refund_id: result.id,
      charge_id: result.chargeId,
      amount_minor: minorOf(result.amount),
      currency: currencyOf(result.amount),
      ...(result.reason === null ? {} : { reason: result.reason }),
    })
  }
  return result
}

/**
 * `charge` is agent-callable, but its consequence is `moves_money`, so approval
 * is required regardless of the agent's trust level. The classification travels
 * on the function object for `ai.agents` to read.
 */
export const charge = annotateAgent(chargeImpl, {
  capability: 'pay.card',
  name: 'charge',
  agentCallable: true,
  consequence: 'moves_money',
  description: 'Takes a card payment. Always requires approval, regardless of trust level.',
})

export const refund = annotateAgent(refundImpl, {
  capability: 'pay.card',
  name: 'refund',
  agentCallable: true,
  consequence: 'moves_money',
  description: 'Refunds a charge in whole or in part. Always requires approval.',
})
