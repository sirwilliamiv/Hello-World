import type { JSX } from 'react'
import type { Money } from '@forge/kernel-money'

/**
 * The payment form.
 *
 * There is deliberately no input in this component that can receive a card
 * number, an expiry, or a CVC. Card entry happens inside Stripe Elements, which
 * mounts a cross-origin iframe into `#forge-pay-card-element`; the details go
 * straight from the browser to Stripe and come back as an opaque `pm_…` handle.
 * That is the whole reason property 1 holds at the UI layer too, and the reason a
 * test asserts this tree contains no card-shaped input.
 */

export interface PaymentFormProps {
  /** Amount to collect, in integer minor units. */
  readonly amount: Money
  readonly customerId: string
  /**
   * PaymentIntent client secret, obtained server-side from `/api/payments`.
   * Never the secret key.
   */
  readonly clientSecret: string
  readonly publishableKey: string
  readonly submitLabel?: string
  readonly disabled?: boolean
  readonly onSuccess?: (paymentIntentId: string) => void
  readonly onError?: (message: string) => void
  readonly formatAmount?: (amount: Money) => string
}

export const PAYMENT_ELEMENT_MOUNT_ID = 'forge-pay-card-element'

export function PaymentForm(props: PaymentFormProps): JSX.Element {
  const label = props.submitLabel ?? 'Pay'
  const formatted =
    props.formatAmount === undefined
      ? ((props.amount as unknown as { format?: () => string }).format?.() ?? '')
      : props.formatAmount(props.amount)

  return (
    <form
      className="forge-pay-card"
      data-capability="pay.card"
      data-customer-id={props.customerId}
      data-client-secret={props.clientSecret}
      data-publishable-key={props.publishableKey}
      noValidate
    >
      <div className="forge-pay-card__amount" aria-live="polite">
        {formatted}
      </div>

      {/*
        Stripe Elements mounts here. No React-controlled input ever holds card
        data — the iframe is same-origin to Stripe, not to this application.
      */}
      <div id={PAYMENT_ELEMENT_MOUNT_ID} className="forge-pay-card__element" />

      <button
        type="submit"
        className="forge-pay-card__submit"
        disabled={props.disabled ?? false}
        data-on-success={props.onSuccess === undefined ? undefined : 'bound'}
        data-on-error={props.onError === undefined ? undefined : 'bound'}
      >
        {label}
      </button>
    </form>
  )
}

export default PaymentForm
